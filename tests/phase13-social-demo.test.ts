/**
 * Phase 13: private FREE leagues, profile, share, freshness UNKNOWN, money isolation.
 */
import { describe, expect, it } from "vitest";
import { computeFreshness, freshnessLabel } from "../live/freshness.js";
import { rejectLeagueMoneyPath } from "../leagues/money-guard.js";
import { generateInviteCode, normalizeInviteCode } from "../leagues/invite.js";
import { sanitizeDisplayName, sanitizeLeagueName } from "../leagues/sanitize.js";
import { buildShareCard } from "../profile/share.js";
import { AppError } from "../shared/errors.js";
import { createLocalDevProvider, LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");

async function loginOn(built: ReturnType<typeof buildTestApp>) {
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
    wallet,
    accountId: session.account.id,
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
  };
}

async function saveXi(
  app: ReturnType<typeof buildTestApp>["app"],
  headers: Record<string, string>,
  matchId = LOCAL_DEV_MATCH_UPCOMING,
) {
  const poolRes = await app.request(`/matches/${matchId}/players`, { headers });
  expect(poolRes.status).toBe(200);
  const pool = (await poolRes.json()) as {
    players: Array<{ playerId: string; position: string; clubId: string; credit: number }>;
  };
  const home = pool.players[0]?.clubId ?? "";
  const away = pool.players.find((p) => p.clubId !== home)?.clubId ?? "";
  const pick = (pos: string, clubId: string, nth: number) => {
    const found = pool.players.filter((p) => p.position === pos && p.clubId === clubId);
    return found[nth]!.playerId;
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
  const teamRes = await app.request("/teams", {
    method: "POST",
    headers,
    body: JSON.stringify({ matchId }),
  });
  expect(teamRes.status).toBe(201);
  const team = (await teamRes.json()) as { team: { id: string } };
  const saveRes = await app.request(`/teams/${team.team.id}/versions`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": `xi-${Math.random()}` },
    body: JSON.stringify({ playerIds, captainId: playerIds[0], viceId: playerIds[5] }),
  });
  expect(saveRes.status).toBe(201);
  const saved = (await saveRes.json()) as { version: { id: string } };
  return saved.version.id;
}

describe("Phase 13 freshness semantics", () => {
  it("distinguishes LIVE, STALE, and UNKNOWN", () => {
    const now = new Date("2026-10-06T12:00:00.000Z");
    expect(
      computeFreshness({
        matchStatus: "LIVE",
        now,
        lastSuccessfulPollAt: "2026-10-06T11:59:30.000Z",
        ingestionLagMs: 100,
      }),
    ).toBe("LIVE");
    expect(
      computeFreshness({
        matchStatus: "LIVE",
        now,
        lastSuccessfulPollAt: "2026-10-06T11:50:00.000Z",
        ingestionLagMs: 100,
      }),
    ).toBe("STALE");
    expect(
      computeFreshness({
        matchStatus: "LIVE",
        now,
        lastSuccessfulPollAt: null,
        ingestionLagMs: null,
      }),
    ).toBe("UNKNOWN");
    expect(freshnessLabel("UNKNOWN")).toBe("FRESHNESS UNKNOWN");
    expect(freshnessLabel("STALE")).toBe("STALE");
  });
});

describe("Phase 13 private FREE leagues", () => {
  it("creates a league with invite code and joins by invite", async () => {
    const built = buildTestApp(() => NOW);
    const owner = await loginOn(built);
    const member = await loginOn(built);
    const create = await built.app.request("/leagues", {
      method: "POST",
      headers: { ...owner.headers, "idempotency-key": "lg-create-0001" },
      body: JSON.stringify({ name: "Friday Five", matchId: LOCAL_DEV_MATCH_UPCOMING, capacity: 3 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      league: { id: string; inviteCode: string; memberCount: number; free: boolean; monetary: boolean };
    };
    expect(created.league.free).toBe(true);
    expect(created.league.monetary).toBe(false);
    expect(created.league.memberCount).toBe(0);
    expect(created.league.inviteCode.length).toBeGreaterThanOrEqual(6);

    const xi = await saveXi(built.app, member.headers);
    const join = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...member.headers, "idempotency-key": "lg-join-000001" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: xi }),
    });
    expect(join.status).toBe(201);
    const joined = (await join.json()) as { league: { memberCount: number; youJoined: boolean } };
    expect(joined.league.memberCount).toBe(1);
    expect(joined.league.youJoined).toBe(true);

    const detail = await built.app.request(`/leagues/${created.league.id}`, { headers: member.headers });
    expect(detail.status).toBe(200);
  });

  it("rejects invalid invite, capacity overflow, and duplicate join", async () => {
    const built = buildTestApp(() => NOW);
    const owner = await loginOn(built);
    const a = await loginOn(built);
    const b = await loginOn(built);
    const c = await loginOn(built);
    const create = await built.app.request("/leagues", {
      method: "POST",
      headers: { ...owner.headers, "idempotency-key": "lg-capacity-01" },
      body: JSON.stringify({ name: "Tiny League", matchId: LOCAL_DEV_MATCH_UPCOMING, capacity: 2 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { league: { inviteCode: string; id: string } };

    const xiBad = await saveXi(built.app, a.headers);
    const bad = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...a.headers, "idempotency-key": "lg-bad-invite1" },
      body: JSON.stringify({ inviteCode: "ZZZZZZZZ", teamVersionId: xiBad }),
    });
    expect(bad.status).toBe(404);

    const j1 = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...a.headers, "idempotency-key": "lg-join-slot-1" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: xiBad }),
    });
    expect(j1.status).toBe(201);

    const dup = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...a.headers, "idempotency-key": "lg-dup-join-01" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: xiBad }),
    });
    expect(dup.status).toBe(409);

    const xiB = await saveXi(built.app, b.headers);
    const j2 = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...b.headers, "idempotency-key": "lg-join-slot-2" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: xiB }),
    });
    expect(j2.status).toBe(201);

    const xiC = await saveXi(built.app, c.headers);
    const full = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...c.headers, "idempotency-key": "lg-full-join01" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: xiC }),
    });
    expect(full.status).toBe(409);
  });

  it("blocks money-path aliases on leagues", async () => {
    const built = buildTestApp(() => NOW);
    const ctx = await loginOn(built);
    const create = await built.app.request("/leagues", {
      method: "POST",
      headers: { ...ctx.headers, "idempotency-key": "lg-money-path1" },
      body: JSON.stringify({ name: "No Money", matchId: LOCAL_DEV_MATCH_UPCOMING, capacity: 4 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { league: { id: string } };
    for (const path of ["deposit", "claim", "settlement", "reservation"]) {
      const res = await built.app.request(`/leagues/${created.league.id}/${path}`, {
        method: "POST",
        headers: ctx.headers,
        body: "{}",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("LEAGUE_MONEY_FORBIDDEN");
    }
    expect(() => rejectLeagueMoneyPath("settlement-prepare")).toThrow(AppError);
  });

  it("exposes lifecycle bucket on league views", async () => {
    const built = buildTestApp(() => NOW);
    const ctx = await loginOn(built);
    const create = await built.app.request("/leagues", {
      method: "POST",
      headers: { ...ctx.headers, "idempotency-key": "lg-lifecycle01" },
      body: JSON.stringify({ name: "Lifecycle", matchId: LOCAL_DEV_MATCH_UPCOMING, capacity: 4 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { league: { lifecycleBucket: string } };
    expect(created.league.lifecycleBucket).toBe("upcoming");
  });
});

describe("Phase 13 profile + share", () => {
  it("updates display name and returns free-only profile stats", async () => {
    const built = buildTestApp(() => NOW);
    const ctx = await loginOn(built);
    const patch = await built.app.request("/v1/me/profile", {
      method: "PATCH",
      headers: { ...ctx.headers, "idempotency-key": "profile-upd-01" },
      body: JSON.stringify({ displayName: "Indu Demo" }),
    });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as {
      profile: { displayName: string; monetaryStats: boolean; freeOnly: boolean; contestsPlayed: number };
    };
    expect(body.profile.displayName).toBe("Indu Demo");
    expect(body.profile.monetaryStats).toBe(false);
    expect(body.profile.freeOnly).toBe(true);

    const get = await built.app.request(`/v1/profile/${ctx.wallet.publicKey}`, { headers: ctx.headers });
    expect(get.status).toBe(200);
  });

  it("builds share card data without monetary claims", async () => {
    const card = buildShareCard({
      kind: "FREE_CONTEST",
      label: "FREE FREE-H2H",
      matchLabel: "Northbridge FC vs Riverdale United",
      rank: 1,
      scoreMilliPoints: 18500,
      captain: "Rafael Costa",
      path: "#/contests/x/result",
    });
    expect(card.free).toBe(true);
    expect(card.monetary).toBe(false);
    expect(card.note).toMatch(/No monetary prize/i);
    expect(card.text).toContain("KICKR FREE result");
    expect(card.text).not.toMatch(/USDC|claim prize|won \$/i);
  });

  it("returns share payload for a FREE contest", async () => {
    const built = buildTestApp(() => NOW);
    const ctx = await loginOn(built);
    const listed = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/contests`, { headers: ctx.headers });
    const body = (await listed.json()) as { contests: Array<{ contestId: string; contestKind: string }> };
    const free = body.contests.find((c) => c.contestKind === "FREE");
    expect(free).toBeTruthy();
    const share = await built.app.request(`/contests/${free!.contestId}/share`, { headers: ctx.headers });
    expect(share.status).toBe(200);
    const payload = (await share.json()) as { share: { free: boolean; monetary: boolean; app: string } };
    expect(payload.share.app).toBe("KICKR");
    expect(payload.share.free).toBe(true);
    expect(payload.share.monetary).toBe(false);
  });
});

describe("Phase 13 demo data + sanitizers", () => {
  it("labels LOCAL_DEV catalog as DEMO and uses fictional club names", () => {
    const catalog = createLocalDevProvider().catalog();
    expect(catalog.clubs[0]?.name).toBe("Northbridge FC");
    expect(catalog.clubs[1]?.name).toBe("Riverdale United");
    expect(catalog.matches[0]?.competition).toMatch(/DEMO|LOCAL_DEV/);
    expect(catalog.matches[0]?.dataSource.label).toMatch(/DEMO|LOCAL_DEV/i);
    expect(catalog.matches[0]?.dataSource.label.toLowerCase()).toContain("not sportmonks");
    expect(catalog.players.some((p) => p.displayName === "Rafael Costa")).toBe(true);
    expect(catalog.players.some((p) => p.shortName === "AF1")).toBe(true);
  });

  it("sanitizes league and display names", () => {
    expect(sanitizeLeagueName("  Friday Five  ")).toBe("Friday Five");
    expect(() => sanitizeLeagueName("ab")).toThrow(AppError);
    expect(sanitizeDisplayName("Indu")).toBe("Indu");
    expect(sanitizeDisplayName("Indu Demo")).toBe("Indu Demo");
    expect(() => sanitizeDisplayName("claim USDC now")).toThrow(AppError);
    expect(normalizeInviteCode(" ab-cd12 ")).toBe("ABCD12");
    expect(generateInviteCode().length).toBeGreaterThanOrEqual(6);
  });
});
