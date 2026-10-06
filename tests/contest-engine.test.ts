import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { updateAuditEvent } from "../audit/guard.js";
import { InMemoryAuditStore } from "../audit/memory.js";
import type { RedisClient } from "../redis/client.js";
import { InMemoryRedis } from "../redis/client.js";
import { DEV_TEMPLATES } from "../contests/dev-catalog.js";
import { contestAcceptsNewEntry } from "../contests/types.js";
import type { ContestRecord } from "../contests/types.js";
import { ContestDiscoveryCache } from "../contests/discovery.js";
import { LocalContestLockScheduler } from "../contests/lock-scheduler.js";
import { InMemoryContestStore } from "../contests/memory-store.js";
import { ContestService } from "../contests/service.js";
import { AppError } from "../shared/errors.js";
import { transition } from "../domain/state-machine.js";
import { FootballService } from "../football/service.js";
import { InMemoryFootballStore } from "../football/store.js";
import { createLocalDevProvider, LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";

const H2H5 = "53000000-0000-4000-8000-000000000001";
const GRAND = "53000000-0000-4000-8000-000000000005";
const WTA = "53000000-0000-4000-8000-000000000006";

function stack(options?: { redis?: RedisClient; ttlSeconds?: number }) {
  const audit = new InMemoryAuditStore();
  const football = new FootballService(
    new InMemoryFootballStore(createLocalDevProvider().catalog()),
    audit,
    { creditCap: 100, maxPlayersFromOneTeam: null },
  );
  const redis = options?.redis ?? new InMemoryRedis();
  const store = new InMemoryContestStore();
  const contests = new ContestService(store, football, audit, new ContestDiscoveryCache(redis, "test"), {
    reservationTtlSeconds: options?.ttlSeconds ?? 600,
    maxEntriesPerMatch: null,
    maxEntriesPerContest: null,
    maxExposurePerMatch: null,
  });
  return { audit, football, store, contests, redis };
}

async function xi(football: FootballService, accountId: string, now: Date) {
  const players = await football.getPlayerPool(LOCAL_DEV_MATCH_UPCOMING);
  if (!players) {
    throw new Error("missing pool");
  }
  const home = players[0]?.clubId ?? "";
  const away = players.find((player) => player.clubId !== home)?.clubId ?? "";
  const pick = (position: string, clubId: string, nth: number) => {
    const found = players.filter((player) => player.position === position && player.clubId === clubId);
    const player = found[nth];
    if (!player) {
      throw new Error(`missing ${position}`);
    }
    return player.playerId;
  };
  const playerIds = [
    pick("GK", home, 0),
    pick("DEF", home, 0),
    pick("DEF", home, 1),
    pick("DEF", home, 2),
    pick("DEF", home, 3),
    pick("MID", home, 0),
    pick("MID", home, 1),
    pick("MID", away, 0),
    pick("DEF", away, 0),
    pick("FWD", away, 1),
    pick("MID", away, 1),
  ];
  const team = await football.createTeam(accountId, LOCAL_DEV_MATCH_UPCOMING, { now, correlationId: null });
  const version = await football.saveVersion(
    team.id,
    accountId,
    { playerIds, captainId: playerIds[0] ?? "", viceId: playerIds[5] ?? "" },
    { now, correlationId: null },
  );
  return { team, version, playerIds };
}

describe("contest engine", () => {
  it("keeps the phase 3 contest path on the shared guard", () => {
    const states = ["OPEN", "PARTIALLY_FILLED", "FULL", "LOCKED", "IN_PROGRESS", "IN_REVIEW", "READY_FOR_SETTLEMENT", "SETTLED"];
    let current = "OPEN";
    for (const next of states.slice(1)) {
      current = transition("CONTEST", current, next);
    }
    expect(current).toBe("SETTLED");
    expect(() => transition("CONTEST", "OPEN", "REFUNDED")).toThrow(AppError);
    expect(transition("ENTRY", "PENDING", "CONFIRMED")).toBe("CONFIRMED");
    expect(() => transition("ENTRY", "DRAFT", "CONFIRMED")).toThrow(AppError);
  });

  it("rotates an H2H room when the last seat is reserved", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const ctx = { now, correlationId: "rotate" };
    const { contests, football } = stack();
    const template = DEV_TEMPLATES.find((row) => row.templateCode === "H2H-5");
    expect(template?.entryFeeBaseUnits).toBe(5_000_000);
    expect(template?.capacity).toBe(2);
    const first = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, ctx);
    expect(first.status).toBe("OPEN");
    expect(first.filledCount).toBe(0);
    expect(first.capacity).toBe(2);

    const teamA = await xi(football, crypto.randomUUID(), now);
    const reservedA = await contests.reserve(first.id, teamA.team.accountId, "A".repeat(32), teamA.version.id, ctx);
    expect(reservedA.contest.filledCount).toBe(1);
    expect(reservedA.contest.status).toBe("PARTIALLY_FILLED");
    expect(reservedA.entry.status).toBe("PENDING");
    expect(reservedA.reservation.status).toBe("PENDING");
    expect(reservedA.payment).toBe("PAYMENT COMING IN PHASE 4");

    const teamB = await xi(football, crypto.randomUUID(), now);
    const reservedB = await contests.reserve(first.id, teamB.team.accountId, "B".repeat(32), teamB.version.id, ctx);
    expect(reservedB.contest.filledCount).toBe(2);
    expect(reservedB.contest.status).toBe("FULL");
    expect(reservedB.entry.seatNumber).toBe(2);

    const open = await contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, ctx);
    const rooms = open.filter((row) => row.templateId === H2H5);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.contestId).not.toBe(first.id);
    expect(rooms[0]?.filledCount).toBe(0);
    expect(rooms[0]?.capacity).toBe(2);
    expect(rooms[0]?.estimated).toBe(true);
    expect(rooms[0]?.funded).toBe(false);

    const teamC = await xi(football, crypto.randomUUID(), now);
    await expect(
      contests.reserve(first.id, teamC.team.accountId, "C".repeat(32), teamC.version.id, ctx),
    ).rejects.toMatchObject({ code: "CONTEST_FULL" });
  });

  it("gives exactly two seats to fifty overlapping reservations", async () => {
    // The in-memory driver queues transactions. Each attempt awaits the same
    // atomic conditional update (filled_count < capacity). This is one Node
    // process, not multi-connection Postgres. PGlite cannot overlap two
    // connections either. The Postgres store uses BEGIN and FOR UPDATE for
    // the same conditional update when a database is attached.
    const now = new Date("2026-10-03T12:00:00.000Z");
    const ctx = { now, correlationId: "race" };
    const { contests, football, store } = stack();
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, ctx);
    const attempts = await Promise.all(
      Array.from({ length: 50 }, async (_unused, index) => {
        const accountId = crypto.randomUUID();
        const team = await xi(football, accountId, now);
        const wallet = `W${String(index).padStart(31, "0")}`;
        try {
          const reserved = await contests.reserve(contest.id, accountId, wallet, team.version.id, ctx);
          return { ok: true as const, seat: reserved.entry.seatNumber, wallet, status: reserved.entry.status };
        } catch (error) {
          return { ok: false as const, code: error instanceof AppError ? error.code : "UNKNOWN" };
        }
      }),
    );
    const wins = attempts.filter((row) => row.ok);
    expect(wins).toHaveLength(2);
    expect(new Set(wins.map((row) => row.seat)).size).toBe(2);
    expect(new Set(wins.map((row) => row.wallet)).size).toBe(2);
    expect(wins.every((row) => row.status === "PENDING")).toBe(true);
    expect(attempts.filter((row) => !row.ok).every((row) => row.code === "CONTEST_FULL")).toBe(true);
    const stored = await store.getContest(contest.id);
    expect(stored?.filledCount).toBe(2);
    expect(stored?.filledCount).toBeLessThanOrEqual(stored?.capacity ?? 0);
    const entries = await store.listEntries(contest.id);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.seatNumber))).toEqual(new Set([1, 2]));
    expect(new Set(entries.map((entry) => entry.wallet)).size).toBe(2);
    expect(entries.some((entry) => entry.status === "CONFIRMED")).toBe(false);
  });

  it("lets concurrent factory calls create one open H2H contest", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const ctx = { now, correlationId: "factory" };
    const { contests, store } = stack();
    const created = await Promise.all(
      Array.from({ length: 20 }, () => contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, ctx)),
    );
    expect(new Set(created.map((contest) => contest.id)).size).toBe(1);
    const rows = await store.listByMatch(LOCAL_DEV_MATCH_UPCOMING);
    const joinable = rows.filter(
      (row) => row.templateId === H2H5 && (row.status === "OPEN" || row.status === "PARTIALLY_FILLED"),
    );
    expect(joinable).toHaveLength(1);
  });

  it("discovers contests from Postgres when Redis is down", async () => {
    const down: RedisClient = {
      async get() {
        throw new Error("redis down");
      },
      async set() {
        throw new Error("redis down");
      },
      async del() {
        throw new Error("redis down");
      },
      async ping() {
        throw new Error("redis down");
      },
    };
    const now = new Date("2026-10-03T12:00:00.000Z");
    const { contests } = stack({ redis: down });
    const rows = await contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, { now, correlationId: "redis" });
    expect(rows.map((row) => row.templateCode).sort()).toEqual(["FREE-GRAND", "FREE-H2H", "GRAND-5", "H2H-10", "H2H-20", "H2H-5", "H2H-50", "WTA-20"]);
    expect(rows.find((row) => row.templateCode === "H2H-50")?.entryFeeBaseUnits).toBe(50_000_000);
    expect(rows.find((row) => row.templateCode === "GRAND-5")?.capacity).toBe(1000);
    expect(rows.find((row) => row.templateCode === "WTA-20")?.capacity).toBe(10);
    expect(rows.every((row) => row.funded === false && row.estimated === true)).toBe(true);
  });

  it("rejects reservations after the match lock and freezes the team", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const ctx = { now, correlationId: "lock" };
    const { contests, football } = stack();
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, ctx);
    const team = await xi(football, crypto.randomUUID(), now);
    const other = await xi(football, crypto.randomUUID(), now);
    await contests.reserve(contest.id, team.team.accountId, "L".repeat(32), team.version.id, ctx);
    await football.applyMatchTransition(LOCAL_DEV_MATCH_UPCOMING, "LOCKED", ctx);
    await contests.lockContestsForMatch(LOCAL_DEV_MATCH_UPCOMING, ctx);
    const late = await contests.reserve(contest.id, other.team.accountId, "M".repeat(32), other.version.id, ctx).catch((error: unknown) => error);
    expect(late).toBeInstanceOf(AppError);
    expect((late as AppError).code).toBe("CONTEST_NOT_JOINABLE");
    const lockedTeam = await football.getTeamForAccount(team.team.id, team.team.accountId);
    expect(lockedTeam?.team.status).toBe("LOCKED");
    await expect(
      football.saveVersion(team.team.id, team.team.accountId, {
        playerIds: team.playerIds,
        captainId: team.playerIds[1] ?? "",
        viceId: team.playerIds[6] ?? "",
      }, ctx),
    ).rejects.toMatchObject({ code: "TEAM_LOCKED" });
  });

  it("rejects a locked team before the match locks", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const ctx = { now, correlationId: "team-lock" };
    const { contests, football } = stack();
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, ctx);
    const team = await xi(football, crypto.randomUUID(), now);
    await football.lockTeam(team.team.id, team.team.accountId, ctx);
    await expect(
      contests.reserve(contest.id, team.team.accountId, "N".repeat(32), team.version.id, ctx),
    ).rejects.toMatchObject({ code: "TEAM_LOCKED" });
  });

  it("keeps the reserved team version after a newer draft", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const ctx = { now, correlationId: "version" };
    const { contests, football, store } = stack();
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, ctx);
    const team = await xi(football, crypto.randomUUID(), now);
    const reserved = await contests.reserve(contest.id, team.team.accountId, "V".repeat(32), team.version.id, ctx);
    const newer = await football.saveVersion(team.team.id, team.team.accountId, {
      playerIds: team.playerIds,
      captainId: team.playerIds[1] ?? "",
      viceId: team.playerIds[6] ?? "",
    }, ctx);
    expect(newer.version).toBe(2);
    expect(newer.id).not.toBe(team.version.id);
    const entry = await store.getEntry(reserved.entry.id);
    expect(entry?.teamVersionId).toBe(team.version.id);
    expect(entry?.status).toBe("PENDING");
  });

  it("does not change an existing snapshot when the template changes", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const ctx = { now, correlationId: "snapshot" };
    const { contests, store } = stack();
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, ctx);
    const before = contest.rulesSnapshot.entryFeeBaseUnits;
    expect(before).toBe(5_000_000);
    await contests.updateTemplateFee(H2H5, 7_000_000, ctx);
    const again = await store.getContest(contest.id);
    expect(again?.rulesSnapshot.entryFeeBaseUnits).toBe(5_000_000);
    expect(again?.rulesSnapshot.templateVersion).toBe(1);
    expect(again?.entryFeeBaseUnits).toBe(5_000_000);
    const template = await store.getTemplate(H2H5);
    expect(template?.version).toBe(2);
    expect(template?.entryFeeBaseUnits).toBe(7_000_000);
    await expect(store.replaceSnapshot(contest.id, again!.rulesSnapshot)).rejects.toThrow(/immutable/);
    const sql = readFileSync(path.resolve(process.cwd(), "migrations/003_phase3_contests.sql"), "utf8");
    expect(sql).toContain("contest rules_snapshot is immutable");
    expect(sql).toContain("contests_h2h_one_joinable_uidx");
    expect(sql).toContain("filled_count <= capacity");
  });

  it("does not let an expired reservation become valid", async () => {
    let now = new Date("2026-10-03T12:00:00.000Z");
    const { contests, football, store } = stack({ ttlSeconds: 30 });
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, { now, correlationId: "exp" });
    const team = await xi(football, crypto.randomUUID(), now);
    const reserved = await contests.reserve(contest.id, team.team.accountId, "E".repeat(32), team.version.id, {
      now,
      correlationId: "exp",
    });
    now = new Date(now.getTime() + 31_000);
    const viewed = await contests.getReservation(reserved.reservation.id, "E".repeat(32), { now, correlationId: "exp" });
    expect(viewed.reservation.status).toBe("EXPIRED");
    expect(viewed.entry.status).toBe("PENDING");
    await expect(contests.rejectConfirmation(reserved.reservation.id, { now, correlationId: "exp" })).rejects.toMatchObject({
      code: "RESERVATION_EXPIRED",
    });
    const entry = await store.getEntry(reserved.entry.id);
    expect(entry?.status).toBe("PENDING");
    const reservation = await store.getReservation(reserved.reservation.id, now);
    expect(reservation?.status).not.toBe("CONFIRMED");
  });

  it("appends create, fill, lock, and join quote without confirming", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const ctx = { now, correlationId: "audit" };
    const { contests, football, audit } = stack();
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, ctx);
    const teamA = await xi(football, crypto.randomUUID(), now);
    const teamB = await xi(football, crypto.randomUUID(), now);
    await contests.reserve(contest.id, teamA.team.accountId, "P".repeat(32), teamA.version.id, ctx);
    await contests.reserve(contest.id, teamB.team.accountId, "Q".repeat(32), teamB.version.id, ctx);
    await football.applyMatchTransition(LOCAL_DEV_MATCH_UPCOMING, "LOCKED", ctx);
    await new LocalContestLockScheduler(contests).lockDue(now, ctx);
    const actions = (await audit.list(50)).map((event) => event.action);
    expect(actions).toContain("CONTEST_CREATED");
    expect(actions).toContain("CONTEST_FILLED");
    expect(actions).toContain("CONTEST_LOCKED");
    expect(actions).toContain("JOIN_QUOTED");
    expect(actions).toContain("ENTRY_RESERVED");
    expect(actions).not.toContain("ENTRY_CONFIRMED");
    expect(() => updateAuditEvent()).toThrow(/UPDATE of audit_events is forbidden/);
    const source = readFileSync(path.resolve(process.cwd(), "contests/service.ts"), "utf8");
    expect(source).toMatch(/async joinFree/);
    // Paid reserve path must not emit ENTRY_CONFIRMED; FREE joinFree may.
    const reserveBlock = source.slice(source.indexOf("async reserve("), source.indexOf("async joinFree("));
    expect(reserveBlock).not.toMatch(/action:\s*"ENTRY_CONFIRMED"/);
  });

  it("keeps one grand league and does not calculate a WTA payout", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const ctx = { now, correlationId: "formats" };
    const { contests, football, store } = stack();
    const first = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, GRAND, ctx);
    const second = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, GRAND, ctx);
    expect(second.id).toBe(first.id);
    expect(first.capacity).toBe(1000);
    const team = await xi(football, crypto.randomUUID(), now);
    const reserved = await contests.reserve(first.id, team.team.accountId, "G".repeat(32), team.version.id, ctx);
    expect(reserved.contest.status).toBe("PARTIALLY_FILLED");
    expect(reserved.contest.filledCount).toBe(1);
    const rows = await store.listByMatch(LOCAL_DEV_MATCH_UPCOMING);
    expect(rows.filter((row) => row.templateId === GRAND)).toHaveLength(1);
    const wta = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, WTA, ctx);
    expect(wta.capacity).toBe(10);
    expect(wta.rulesSnapshot.payoutPolicyType).toBe("WINNER_TAKES_ALL");
    expect(JSON.stringify(wta.rulesSnapshot.payoutConfiguration)).not.toMatch(/winnerAmount|payoutAmount/i);
  });
});

describe("entered contests stay visible after they close", () => {
  it("lists a confirmed entrant's FULL, LOCKED, and settled contest without opening it to others", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const ctx = { now, correlationId: "entrant-list" };
    const { contests, football, store } = stack();
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, ctx);
    const walletA = "A".repeat(32);
    const walletB = "B".repeat(32);
    const stranger = "S".repeat(32);
    const teamA = await xi(football, crypto.randomUUID(), now);
    const teamB = await xi(football, crypto.randomUUID(), now);
    const late = await xi(football, crypto.randomUUID(), now);
    const reservedA = await contests.reserve(contest.id, teamA.team.accountId, walletA, teamA.version.id, ctx);
    await contests.reserve(contest.id, teamB.team.accountId, walletB, teamB.version.id, ctx);
    await store.confirmVerifiedDeposit({
      reservationId: reservedA.reservation.id,
      signature: "sig".padEnd(88, "x"),
      slot: 9,
      blockTime: Math.floor(now.getTime() / 1000),
      amountBaseUnits: 5_000_000,
      mint: "mint",
      vault: "vault",
      depositReceipt: "receipt",
      contestPda: "pda",
      teamVersionId: teamA.version.id,
      now,
    });

    const discoverable = await contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, ctx);
    expect(discoverable.some((row) => row.contestId === contest.id)).toBe(false);
    const forA = await contests.listMatchContests(LOCAL_DEV_MATCH_UPCOMING, walletA, ctx);
    const full = forA.find((row) => row.contestId === contest.id);
    expect(full?.status).toBe("FULL");
    expect(forA.filter((row) => row.contestId === contest.id)).toHaveLength(1);
    const pendingOnly = await contests.listMatchContests(LOCAL_DEV_MATCH_UPCOMING, walletB, ctx);
    expect(pendingOnly.some((row) => row.contestId === contest.id)).toBe(false);

    await football.applyMatchTransition(LOCAL_DEV_MATCH_UPCOMING, "LOCKED", ctx);
    await contests.lockContestsForMatch(LOCAL_DEV_MATCH_UPCOMING, ctx);
    const locked = (await contests.listMatchContests(LOCAL_DEV_MATCH_UPCOMING, walletA, ctx)).find(
      (row) => row.contestId === contest.id,
    );
    expect(locked?.status).toBe("LOCKED");
    expect(contestAcceptsNewEntry(locked?.status ?? "")).toBe(false);

    const hidden = (store as unknown as { contests: ContestRecord[] }).contests;
    const row = hidden.find((item) => item.id === contest.id);
    if (!row) {
      throw new Error("missing contest");
    }
    row.status = "SETTLED";
    const settled = (await contests.listMatchContests(LOCAL_DEV_MATCH_UPCOMING, walletA, ctx)).find(
      (item) => item.contestId === contest.id,
    );
    expect(settled?.status).toBe("SETTLED");
    expect(contestAcceptsNewEntry("SETTLED")).toBe(false);
    expect(contestAcceptsNewEntry("OPEN")).toBe(true);
    expect(contestAcceptsNewEntry("PARTIALLY_FILLED")).toBe(true);
    const others = await contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, ctx);
    expect(others.some((item) => item.contestId === contest.id)).toBe(false);
    const strangerView = await contests.listMatchContests(LOCAL_DEV_MATCH_UPCOMING, stranger, ctx);
    expect(strangerView.some((item) => item.contestId === contest.id)).toBe(false);
    expect(strangerView.every((item) => contestAcceptsNewEntry(item.status))).toBe(true);
    await expect(
      contests.reserve(contest.id, late.team.accountId, stranger, late.version.id, ctx),
    ).rejects.toMatchObject({ code: "CONTEST_NOT_JOINABLE" });
  });

  it("only renders Join when the contest still accepts entries", () => {
    const source = readFileSync(path.resolve(process.cwd(), "app/src/main.ts"), "utf8");
    const start = source.indexOf("async function renderContests");
    const end = source.indexOf("async function joinContest");
    const render = source.slice(start, end);
    expect(render).toContain("contestAcceptsNewEntry(contest.status)");
    expect(render).toContain('data-join="${contest.contestId}"');
    expect(render).toContain("Closed to new entries");
    expect(render).toContain("Join FREE");
    expect(source).toContain("badge-free");
    expect(source).toContain("contestKind === \"FREE\"");
  });
});

describe("contest API", () => {
  it("quotes a pending seat and does not say the entry is confirmed", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const built = buildTestApp(() => now);
    const wallet = generateWallet();
    const nonce = await built.app.request("/v1/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet.publicKey }),
    });
    const issued = (await nonce.json()) as { message: string };
    const login = await built.app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: wallet.publicKey,
        message: issued.message,
        signature: signMessage(issued.message, wallet.secretKey),
      }),
    });
    const session = (await login.json()) as { token: string; account: { id: string } };
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
    const listed = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/contests`, { headers });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { contests: Array<{ contestId: string; templateCode: string; entryFeeBaseUnits: number; funded: boolean }> };
    const room = body.contests.find((row) => row.templateCode === "H2H-5");
    expect(room?.entryFeeBaseUnits).toBe(5_000_000);
    expect(room?.funded).toBe(false);
    const team = await xi(built.deps.football, session.account.id, now);
    const reserved = await built.app.request(`/contests/${room?.contestId}/reservations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ teamVersionId: team.version.id }),
    });
    expect(reserved.status).toBe(201);
    const quote = (await reserved.json()) as {
      payment: string;
      entry: { status: string; teamVersionId: string };
      reservation: { status: string; id: string };
    };
    expect(quote.payment).toBe("PAYMENT COMING IN PHASE 4");
    expect(quote.entry.status).toBe("PENDING");
    expect(quote.reservation.status).toBe("PENDING");
    expect(quote.entry.teamVersionId).toBe(team.version.id);
    expect(JSON.stringify(quote)).not.toMatch(/"CONFIRMED"|Joined/);
    const fetched = await built.app.request(`/reservations/${quote.reservation.id}`, { headers });
    expect(fetched.status).toBe(200);
  });

  it("returns a settled confirmed entry to its wallet only, with join still refused", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const built = buildTestApp(() => now);
    const ctx = { now, correlationId: "api-entrant" };
    async function sessionFor(wallet = generateWallet()) {
      const nonce = await built.app.request("/v1/auth/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet.publicKey }),
      });
      const issued = (await nonce.json()) as { message: string };
      const login = await built.app.request("/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          walletAddress: wallet.publicKey,
          message: issued.message,
          signature: signMessage(issued.message, wallet.secretKey),
        }),
      });
      const body = (await login.json()) as { token: string; account: { id: string } };
      return { token: body.token, accountId: body.account.id, wallet: wallet.publicKey };
    }
    const owner = await sessionFor();
    const other = await sessionFor();
    const stranger = await sessionFor();
    const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
    const listed = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/contests`, { headers: headers(owner.token) });
    const openBody = (await listed.json()) as { contests: Array<{ contestId: string; templateCode: string; status: string }> };
    const room = openBody.contests.find((row) => row.templateCode === "H2H-5");
    if (!room) {
      throw new Error("missing room");
    }
    const teamA = await xi(built.deps.football, owner.accountId, now);
    const teamB = await xi(built.deps.football, other.accountId, now);
    const teamC = await xi(built.deps.football, stranger.accountId, now);
    const reserved = await built.app.request(`/contests/${room.contestId}/reservations`, {
      method: "POST",
      headers: headers(owner.token),
      body: JSON.stringify({ teamVersionId: teamA.version.id }),
    });
    expect(reserved.status).toBe(201);
    const quote = (await reserved.json()) as { reservation: { id: string } };
    const otherReserve = await built.app.request(`/contests/${room.contestId}/reservations`, {
      method: "POST",
      headers: headers(other.token),
      body: JSON.stringify({ teamVersionId: teamB.version.id }),
    });
    expect(otherReserve.status).toBe(201);
    const store = (built.deps.contests as unknown as { store: InMemoryContestStore }).store;
    await store.confirmVerifiedDeposit({
      reservationId: quote.reservation.id,
      signature: "sig".padEnd(88, "y"),
      slot: 11,
      blockTime: Math.floor(now.getTime() / 1000),
      amountBaseUnits: 5_000_000,
      mint: "mint",
      vault: "vault",
      depositReceipt: "receipt",
      contestPda: "pda",
      teamVersionId: teamA.version.id,
      now,
    });
    await built.deps.football.applyMatchTransition(LOCAL_DEV_MATCH_UPCOMING, "LOCKED", ctx);
    await built.deps.contests.lockContestsForMatch(LOCAL_DEV_MATCH_UPCOMING, ctx);
    const hidden = (store as unknown as { contests: ContestRecord[] }).contests;
    const stored = hidden.find((row) => row.id === room.contestId);
    if (!stored) {
      throw new Error("missing stored contest");
    }
    stored.status = "SETTLED";

    const ownerList = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/contests`, { headers: headers(owner.token) });
    expect(ownerList.status).toBe(200);
    const ownerBody = (await ownerList.json()) as { contests: Array<{ contestId: string; status: string }> };
    const mine = ownerBody.contests.filter((row) => row.contestId === room.contestId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.status).toBe("SETTLED");
    const otherList = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/contests`, { headers: headers(other.token) });
    const otherBody = (await otherList.json()) as { contests: Array<{ contestId: string; status: string }> };
    expect(otherBody.contests.some((row) => row.contestId === room.contestId)).toBe(false);
    expect(otherBody.contests.every((row) => row.status === "OPEN" || row.status === "PARTIALLY_FILLED")).toBe(true);
    const join = await built.app.request(`/contests/${room.contestId}/reservations`, {
      method: "POST",
      headers: headers(stranger.token),
      body: JSON.stringify({ teamVersionId: teamC.version.id }),
    });
    expect(join.status).toBe(409);
    const denied = (await join.json()) as { error: { code: string } };
    expect(denied.error.code).toBe("CONTEST_NOT_JOINABLE");
  });
});
