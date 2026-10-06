/**
 * Phase 11: FREE-to-play contests. Money-path isolation + free join flow.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../audit/memory.js";
import { ContestDiscoveryCache } from "../contests/discovery.js";
import { DEV_FEE_POLICY, DEV_TEMPLATES, FREE_TEMPLATES } from "../contests/dev-catalog.js";
import { FREE_TEMPLATE_IDS } from "../contests/free/catalog.js";
import { InMemoryFreeResultStore } from "../contests/free/results.js";
import { isFreeContest, rejectFreeMoneyPath } from "../contests/kind.js";
import { InMemoryContestStore } from "../contests/memory-store.js";
import { ContestService } from "../contests/service.js";
import { FootballService } from "../football/service.js";
import { InMemoryFootballStore } from "../football/store.js";
import { ROLE_PERMISSIONS } from "../rbac/matrix.js";
import { InMemoryRedis } from "../redis/client.js";
import { AppError } from "../shared/errors.js";
import { DepositIndexer } from "../solana/indexer.js";
import { createLocalDevProvider, LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const H2H5 = "53000000-0000-4000-8000-000000000001";

function stack() {
  const audit = new InMemoryAuditStore();
  const football = new FootballService(
    new InMemoryFootballStore(createLocalDevProvider().catalog()),
    audit,
    { creditCap: 100, maxPlayersFromOneTeam: null },
  );
  const store = new InMemoryContestStore();
  const freeResults = new InMemoryFreeResultStore();
  const contests = new ContestService(
    store,
    football,
    audit,
    new ContestDiscoveryCache(new InMemoryRedis(), "test"),
    {
      reservationTtlSeconds: 600,
      maxEntriesPerMatch: null,
      maxEntriesPerContest: null,
      maxExposurePerMatch: null,
    },
    undefined,
    true,
    freeResults,
  );
  return { audit, football, store, contests, freeResults };
}

async function xi(football: FootballService, accountId: string, now: Date) {
  const players = await football.getPlayerPool(LOCAL_DEV_MATCH_UPCOMING);
  if (!players) throw new Error("missing pool");
  const home = players[0]?.clubId ?? "";
  const away = players.find((player) => player.clubId !== home)?.clubId ?? "";
  const pick = (position: string, clubId: string, nth: number) => {
    const found = players.filter((player) => player.position === position && player.clubId === clubId);
    const player = found[nth];
    if (!player) throw new Error(`missing ${position}`);
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
  return { team, version };
}

async function login() {
  const built = buildTestApp(() => NOW);
  const wallet = generateWallet();
  const issued = await built.deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: null });
  const session = await built.deps.auth.login(
    {
      walletAddress: wallet.publicKey,
      message: issued.message,
      signature: signMessage(issued.message, wallet.secretKey),
    },
    { now: NOW, correlationId: null },
  );
  return {
    ...built,
    wallet,
    token: session.token,
    accountId: session.account.id,
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
  };
}

describe("Phase 11 FREE contests", () => {
  it("seeds FREE templates with fee 0 and prize 0", () => {
    expect(FREE_TEMPLATES.every((t) => t.contestKind === "FREE")).toBe(true);
    expect(FREE_TEMPLATES.every((t) => t.entryFeeBaseUnits === 0 && t.prizePoolBaseUnits === 0)).toBe(true);
    expect(FREE_TEMPLATES.some((t) => t.contestType === "HEAD_TO_HEAD")).toBe(true);
    expect(FREE_TEMPLATES.some((t) => t.contestType === "GRAND_LEAGUE")).toBe(true);
    expect(DEV_FEE_POLICY.rateBps).toBe(1000);
  });

  it("DB migration 012 rejects nonzero FREE economics via constraint text", () => {
    const sql = readFileSync(path.join(process.cwd(), "migrations/012_phase11_free_contests.sql"), "utf8");
    expect(sql).toContain("contest_templates_free_economics");
    expect(sql).toContain("contests_free_economics");
    expect(sql).toContain("entry_fee_base_units = 0 AND prize_pool_base_units = 0");
    expect(sql).toContain("FREE-H2H");
    expect(sql).toContain("FREE-GRAND");
  });

  it("rejects FREE contests on every money path helper", () => {
    const free = {
      id: "c-free",
      contestKind: "FREE" as const,
      entryFeeBaseUnits: 0,
      rulesSnapshot: { contestKind: "FREE" as const },
    };
    expect(() => rejectFreeMoneyPath(free, "reservation-with-deposit")).toThrow(AppError);
    expect(() => rejectFreeMoneyPath(free, "deposit-submission")).toThrow(AppError);
    expect(() => rejectFreeMoneyPath(free, "deposit-indexer")).toThrow(AppError);
    expect(() => rejectFreeMoneyPath(free, "settlement-calculate")).toThrow(AppError);
    expect(() => rejectFreeMoneyPath(free, "settlement-prepare")).toThrow(AppError);
    expect(() => rejectFreeMoneyPath(free, "settlement-commit")).toThrow(AppError);
    expect(() => rejectFreeMoneyPath(free, "attestation-for-settlement")).toThrow(AppError);
    expect(() => rejectFreeMoneyPath(free, "claim")).toThrow(AppError);
    expect(isFreeContest(free)).toBe(true);
  });

  it("API rejects deposit/claim/settlement endpoints for a FREE contest id", async () => {
    const ctx = await login();
    const listed = await ctx.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/contests`, { headers: ctx.headers });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { contests: Array<{ contestId: string; contestKind: string; templateCode: string }> };
    const free = body.contests.find((c) => c.contestKind === "FREE" && c.templateCode === "FREE-H2H");
    expect(free).toBeTruthy();
    const contestId = free!.contestId;

    const reserve = await ctx.app.request(`/contests/${contestId}/reservations`, {
      method: "POST",
      headers: { ...ctx.headers, "idempotency-key": "p11-reserve-1" },
      body: JSON.stringify({ teamVersionId: "00000000-0000-4000-8000-000000000099" }),
    });
    expect(reserve.status).toBeGreaterThanOrEqual(400);

    const calc = await ctx.app.request(`/contests/${contestId}/settlement/calculate`, {
      method: "POST",
      headers: ctx.headers,
    });
    expect([403, 409, 401]).toContain(calc.status);

    const claim = await ctx.app.request(`/entries/00000000-0000-4000-8000-000000000001/claim?contestId=${contestId}`, {
      headers: ctx.headers,
    });
    expect(claim.status).toBeGreaterThanOrEqual(400);
  });

  it("indexer rejects deposits naming a FREE contest", async () => {
    const { store, football, contests, audit } = stack();
    const wallet = generateWallet();
    const account = await (async () => {
      // create account via football path needs account id — use a fake uuid account through team create after auth-less store
      return "a0000000-0000-4000-8000-0000000000aa";
    })();
    await contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, { now: NOW, correlationId: null });
    const freeContest = (await store.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING)).find((c) => c.contestKind === "FREE");
    expect(freeContest).toBeTruthy();
    const built = await xi(football, account, NOW);
    const joined = await contests.joinFree(freeContest!.id, account, wallet.publicKey, built.version.id, {
      now: NOW,
      correlationId: null,
    });
    expect(joined.entry.status).toBe("CONFIRMED");

    const indexer = new DepositIndexer(
      store,
      audit,
      { programId: "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN", usdcMint: "Mint111", usdcDecimals: 6, cluster: "devnet" },
      async () => ({
        labelledFixture: true,
        signature: "SigFree1111111111111111111111111111111111111111111111111111",
        commitment: "finalized",
        slot: 1,
        succeeded: true,
        programId: "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN",
        sender: wallet.publicKey,
        mint: "Mint111",
        vault: "Vault111",
        amountBaseUnits: 0,
        reservationNonceHash: joined.reservation.nonceHash,
        contestPda: "ContestPda111",
        depositReceipt: "Receipt111",
        teamVersionId: built.version.id,
        blockTime: Math.floor(NOW.getTime() / 1000),
        tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        vaultBalanceIncrease: 0,
      }),
    );
    const outcome = await indexer.process("SigFree1111111111111111111111111111111111111111111111111111", NOW);
    expect(outcome.outcome).toBe("REJECTED");
    if (outcome.outcome === "REJECTED") {
      expect(outcome.reason).toBe("FREE_CONTEST_MONEY_FORBIDDEN");
    }
  });

  it("full free join → lock → score → final rank flow works for H2H and Grand League", async () => {
    for (const templateId of [FREE_TEMPLATE_IDS.H2H, FREE_TEMPLATE_IDS.GRAND]) {
      const { football, contests, store } = stack();
      await contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, { now: NOW, correlationId: null });
      const contest = (await store.listByMatch(LOCAL_DEV_MATCH_UPCOMING)).find((c) => c.templateId === templateId);
      expect(contest?.contestKind).toBe("FREE");
      expect(contest?.entryFeeBaseUnits).toBe(0);
      expect(contest?.prizePoolBaseUnits).toBe(0);

      const w1 = generateWallet();
      const w2 = generateWallet();
      const a1 = "a0000000-0000-4000-8000-0000000000b1";
      const a2 = "a0000000-0000-4000-8000-0000000000b2";
      const xi1 = await xi(football, a1, NOW);
      const xi2 = await xi(football, a2, NOW);
      const j1 = await contests.joinFree(contest!.id, a1, w1.publicKey, xi1.version.id, { now: NOW, correlationId: null });
      const j2 = await contests.joinFree(contest!.id, a2, w2.publicKey, xi2.version.id, { now: NOW, correlationId: null });
      expect(j1.confirmed).toBe(true);
      expect(j2.entry.status).toBe("CONFIRMED");

      const locked = await contests.lockContestsForMatch(LOCAL_DEV_MATCH_UPCOMING, { now: NOW, correlationId: null });
      expect(locked.some((c) => c.id === contest!.id)).toBe(true);

      const final = await contests.finalizeFreeResult(
        contest!.id,
        [
          {
            entryId: j1.entry.id,
            wallet: w1.publicKey,
            teamVersionId: xi1.version.id,
            finalScoreMilliPoints: 12000,
          },
          {
            entryId: j2.entry.id,
            wallet: w2.publicKey,
            teamVersionId: xi2.version.id,
            finalScoreMilliPoints: 8000,
          },
        ],
        { now: NOW, correlationId: null },
      );
      expect(final.merkleRoot).toBeNull();
      expect(final.claimable).toBe(false);
      expect(final.rows[0]?.rank).toBe(1);
      expect(final.rows[0]?.finalScoreMilliPoints).toBe(12000);
      expect(final.rows[1]?.rank).toBe(2);
    }
  });

  it("free join is idempotent and enforces capacity + lock", async () => {
    const { football, contests, store } = stack();
    await contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, { now: NOW, correlationId: null });
    const contest = (await store.listByMatch(LOCAL_DEV_MATCH_UPCOMING)).find((c) => c.templateId === FREE_TEMPLATE_IDS.H2H)!;
    const w1 = generateWallet();
    const a1 = "a0000000-0000-4000-8000-0000000000c1";
    const xi1 = await xi(football, a1, NOW);
    const first = await contests.joinFree(contest.id, a1, w1.publicKey, xi1.version.id, { now: NOW, correlationId: null });
    const second = await contests.joinFree(contest.id, a1, w1.publicKey, xi1.version.id, { now: NOW, correlationId: null });
    expect(second.entry.id).toBe(first.entry.id);

    const w2 = generateWallet();
    const a2 = "a0000000-0000-4000-8000-0000000000c2";
    const xi2 = await xi(football, a2, NOW);
    await contests.joinFree(contest.id, a2, w2.publicKey, xi2.version.id, { now: NOW, correlationId: null });

    const w3 = generateWallet();
    const a3 = "a0000000-0000-4000-8000-0000000000c3";
    const xi3 = await xi(football, a3, NOW);
    // H2H capacity 2 — after fill, room rotates; join original contest id should be full
    await expect(
      contests.joinFree(contest.id, a3, w3.publicKey, xi3.version.id, { now: NOW, correlationId: null }),
    ).rejects.toMatchObject({ code: "CONTEST_FULL" });

    const open = (await store.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING)).find(
      (c) => c.templateId === FREE_TEMPLATE_IDS.H2H && c.id !== contest.id,
    );
    expect(open).toBeTruthy();
    await contests.lockContestsForMatch(LOCAL_DEV_MATCH_UPCOMING, { now: NOW, correlationId: null });
    await expect(
      contests.joinFree(open!.id, a3, w3.publicKey, xi3.version.id, { now: NOW, correlationId: null }),
    ).rejects.toMatchObject({ code: "CONTEST_NOT_JOINABLE" });
  });

  it("my-result for FREE never returns a claimable state", async () => {
    const ctx = await login();
    const { version } = await xi(ctx.deps.football, ctx.accountId, NOW);
    const listed = await ctx.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/contests`, { headers: ctx.headers });
    const body = (await listed.json()) as { contests: Array<{ contestId: string; contestKind: string }> };
    const free = body.contests.find((c) => c.contestKind === "FREE")!;
    const joined = await ctx.app.request(`/contests/${free.contestId}/free-join`, {
      method: "POST",
      headers: { ...ctx.headers, "idempotency-key": "p11-join-1" },
      body: JSON.stringify({ teamVersionId: version.id }),
    });
    expect(joined.status).toBe(201);
    const joinBody = (await joined.json()) as {
      confirmed: boolean;
      depositPlan: null;
      payment: string;
      entry: { id: string };
    };
    expect(joinBody.confirmed).toBe(true);
    expect(joinBody.depositPlan).toBeNull();
    expect(joinBody.payment).toBe("FREE_NO_PAYMENT");

    await ctx.deps.contests.finalizeFreeResult(
      free.contestId,
      [
        {
          entryId: joinBody.entry.id,
          wallet: ctx.wallet.publicKey,
          teamVersionId: version.id,
          finalScoreMilliPoints: 5000,
        },
      ],
      { now: NOW, correlationId: null },
    );

    const mineResult = await ctx.app.request(`/contests/${free.contestId}/my-result`, { headers: ctx.headers });
    expect(mineResult.status).toBe(200);
    const result = (await mineResult.json()) as {
      claimUiState: string;
      claimPlan: unknown;
      prizeBaseUnits: number;
      contestKind: string;
      claimable?: boolean;
    };
    expect(result.contestKind).toBe("FREE");
    expect(result.claimUiState).not.toBe("claimable");
    expect(result.claimPlan).toBeNull();
    expect(result.prizeBaseUnits).toBe(0);
    expect(result.claimable).toBe(false);
  });

  it("paid Devnet behavior is unchanged (reserve still works on PAID_DEVNET)", async () => {
    const { football, contests, store } = stack();
    await contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, { now: NOW, correlationId: null });
    const paid = (await store.listByMatch(LOCAL_DEV_MATCH_UPCOMING)).find((c) => c.templateId === H2H5);
    expect(paid?.contestKind).toBe("PAID_DEVNET");
    expect(paid?.entryFeeBaseUnits).toBe(5_000_000);
    const wallet = generateWallet();
    const account = "a0000000-0000-4000-8000-0000000000d1";
    const built = await xi(football, account, NOW);
    const reserved = await contests.reserve(paid!.id, account, wallet.publicKey, built.version.id, {
      now: NOW,
      correlationId: null,
    });
    expect(reserved.entry.status).toBe("PENDING");
    expect(reserved.reservation.status).toBe("PENDING");
    expect(reserved.reservation.amountBaseUnits).toBe(5_000_000);
  });

  it("RUN_SETTLEMENT remains granted to nobody and escrow untouched", () => {
    const granted = new Set(Object.values(ROLE_PERMISSIONS).flat());
    expect(granted.has("RUN_SETTLEMENT")).toBe(false);
    expect(DEV_TEMPLATES.some((t) => t.contestKind === "FREE")).toBe(true);
    expect(DEV_FEE_POLICY.rateBps).toBe(1000);
  });
});
