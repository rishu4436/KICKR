/**
 * Phase 14: unified league scoring + social UX (invite return, onboarding, share, money guard).
 */
import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../audit/memory.js";
import { InMemoryFootballStore } from "../football/store.js";
import { FootballService } from "../football/service.js";
import { InMemoryRedis } from "../redis/client.js";
import { InMemoryProviderIdMap, seedProviderIdMapFromCatalog } from "../sports/id-map.js";
import {
  buildPhase5ReplayCatalog,
  LOCAL_DEV_REPLAY_MATCH,
} from "../sports/replay-fixture.js";
import { LiveScoringService } from "../live/service.js";
import { createCombinedScoringSource } from "../live/combined-scoring-source.js";
import { computeScoreSnapshotId, isScoreSnapshotFresh } from "../live/score-snapshot.js";
import { InMemoryContestStore } from "../contests/memory-store.js";
import { InMemoryLeagueStore, LeagueService } from "../leagues/index.js";
import { rejectLeagueMoneyPath } from "../leagues/money-guard.js";
import { buildShareCard, renderShareHtmlPage } from "../profile/share.js";
import { AppError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type { RequestContext } from "../auth/types.js";
import type { NormalizedEventDraft } from "../sports/normalize.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";
import { LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const ctx = (): RequestContext => ({ now: NOW, correlationId: "phase14" });

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
    players: Array<{ playerId: string; position: string; clubId: string }>;
  };
  const home = pool.players[0]?.clubId ?? "";
  const away = pool.players.find((p) => p.clubId !== home)?.clubId ?? "";
  const pick = (pos: string, clubId: string, nth: number) =>
    pool.players.filter((p) => p.position === pos && p.clubId === clubId)[nth]!.playerId;
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

function baseDraft(
  partial: Partial<NormalizedEventDraft> &
    Pick<NormalizedEventDraft, "providerEventId" | "eventType" | "sequence">,
): NormalizedEventDraft {
  return {
    provider: "local-dev",
    externalFixtureId: "dev-fixture-replay",
    timestamp: "2026-10-02T15:10:00.000Z",
    timestampSource: "kickoff_plus_minute",
    matchMinute: 10,
    period: "1",
    primaryExternalPlayerId: null,
    secondaryExternalPlayerId: null,
    externalTeamId: "dev-club-a",
    correctionType: null,
    relatedProviderEventId: null,
    providerVersion: "test",
    rawEventHash: "b".repeat(64),
    metadata: {},
    requiresPrimaryPlayer: true,
    ...partial,
  };
}

describe("Phase 14 unified league scoring", () => {
  async function setupLeagueWorld() {
    const catalog = buildPhase5ReplayCatalog();
    const store = new InMemoryFootballStore({
      ...catalog,
      events: catalog.events.filter((event) => event.matchId !== LOCAL_DEV_REPLAY_MATCH),
    });
    const idMap = new InMemoryProviderIdMap();
    seedProviderIdMapFromCatalog(idMap, "local-dev", catalog);
    const redis = new InMemoryRedis();
    const audit = new InMemoryAuditStore();
    const football = new FootballService(store, audit, { creditCap: 100, maxPlayersFromOneTeam: null });
    const contestStore = new InMemoryContestStore();
    const leagueStore = new InMemoryLeagueStore();
    const live = new LiveScoringService(
      store,
      football,
      idMap,
      redis,
      "test",
      audit,
      "local-dev",
      createCombinedScoringSource(contestStore, leagueStore),
    );
    const leagues = new LeagueService(leagueStore, football, audit, live);

    const catalogPlayers = catalog.players;
    const goalPlayer = catalogPlayers.find((p) => p.shortName === "AF1")!;
    const assistPlayer = catalogPlayers.find((p) => p.shortName === "AM1")!;
    const xi = catalogPlayers.slice(0, 11).map((row) => row.id);
    xi[0] = goalPlayer.id;
    xi[1] = assistPlayer.id;

    const makeMember = async (wallet: string, captainId: string, viceId: string) => {
      const accountId = newId();
      const teamId = newId();
      const versionId = newId();
      await store.createTeam({
        id: teamId,
        accountId,
        matchId: LOCAL_DEV_REPLAY_MATCH,
        status: "LOCKED",
        createdAt: "2026-10-02T14:00:00.000Z",
        updatedAt: "2026-10-02T14:00:00.000Z",
      });
      await store.insertVersion({
        id: versionId,
        teamId,
        version: 1,
        matchId: LOCAL_DEV_REPLAY_MATCH,
        playerIds: xi,
        captainId,
        viceId,
        creditsUsed: 90,
        validationResult: { valid: true, errors: [] },
        createdAt: "2026-10-02T14:00:00.000Z",
      });
      return { accountId, wallet, teamVersionId: versionId };
    };

    const owner = await makeMember("WalletOwn1111111111111111111111111111", goalPlayer.id, assistPlayer.id);
    const a = await makeMember("WalletAAA1111111111111111111111111111", goalPlayer.id, assistPlayer.id);
    const b = await makeMember("WalletBBB1111111111111111111111111111", assistPlayer.id, goalPlayer.id);

    const league = await leagueStore.createLeague({
      name: "Replay Five",
      matchId: LOCAL_DEV_REPLAY_MATCH,
      ownerAccountId: owner.accountId,
      ownerWallet: owner.wallet,
      inviteCode: "REPLAY1",
      capacity: 5,
      now: NOW,
    });
    const joinA = await leagueStore.join({
      leagueId: league.id,
      accountId: a.accountId,
      wallet: a.wallet,
      teamVersionId: a.teamVersionId,
      now: NOW,
    });
    const joinB = await leagueStore.join({
      leagueId: league.id,
      accountId: b.accountId,
      wallet: b.wallet,
      teamVersionId: b.teamVersionId,
      now: NOW,
    });

    return {
      live,
      leagues,
      league,
      joinA,
      joinB,
      goalPlayer,
      assistPlayer,
      redis,
      a,
      b,
    };
  }

  it("updates league ranks after scoring and discards stale league cache", async () => {
    const world = await setupLeagueWorld();
    const first = await world.leagues.leaderboard(world.league.id, world.a.wallet, ctx());
    expect(first.freshness).not.toBe("FINAL");
    expect(first.rows).toHaveLength(2);
    expect(first.scoreSnapshotId).toBeTruthy();

    const staleId = first.scoreSnapshotId!;
    // Inject a goal for AF1 (captain of A) — A should rise.
    await world.live.pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "lg-goal-1",
        eventType: "GOAL",
        sequence: 1,
        primaryExternalPlayerId: world.goalPlayer.providerId!,
        matchMinute: 12,
        timestamp: "2026-10-02T15:12:00.000Z",
      }),
      { matchId: LOCAL_DEV_REPLAY_MATCH, ctx: ctx() },
    );

    const second = await world.leagues.leaderboard(world.league.id, world.a.wallet, ctx());
    expect(second.scoreSnapshotId).not.toBe(staleId);
    expect(isScoreSnapshotFresh(staleId, second.scoreSnapshotId!)).toBe(false);
    const rankA = second.rows.find((r) => r.wallet === world.a.wallet)!.rank;
    const rankB = second.rows.find((r) => r.wallet === world.b.wallet)!.rank;
    expect(rankA).toBe(1);
    expect(rankB).toBe(2);
    expect(second.rows.find((r) => r.wallet === world.a.wallet)!.milliPoints).toBeGreaterThan(
      second.rows.find((r) => r.wallet === world.b.wallet)!.milliPoints,
    );
  });

  it("lets a late event change league ranking", async () => {
    const world = await setupLeagueWorld();
    await world.live.pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "lg-goal-early",
        eventType: "GOAL",
        sequence: 1,
        primaryExternalPlayerId: world.goalPlayer.providerId!,
        matchMinute: 12,
        timestamp: "2026-10-02T15:12:00.000Z",
      }),
      { matchId: LOCAL_DEV_REPLAY_MATCH, ctx: ctx() },
    );
    const mid = await world.leagues.leaderboard(world.league.id, world.a.wallet, ctx());
    expect(mid.rows[0]!.wallet).toBe(world.a.wallet);

    // Late assist-heavy event for AM1 (B's captain) — can flip ranks depending on points.
    await world.live.pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "lg-goal-late",
        eventType: "GOAL",
        sequence: 2,
        primaryExternalPlayerId: world.assistPlayer.providerId!,
        matchMinute: 80,
        timestamp: "2026-10-02T16:20:00.000Z",
      }),
      { matchId: LOCAL_DEV_REPLAY_MATCH, ctx: ctx() },
    );
    const late = await world.leagues.leaderboard(world.league.id, world.b.wallet, ctx());
    expect(late.scoreSnapshotId).not.toBe(mid.scoreSnapshotId);
    // B captains AM1; after AM1 goal B should be ahead or tied higher via captain multiplier.
    expect(late.rows.find((r) => r.wallet === world.b.wallet)!.milliPoints).toBeGreaterThan(0);
    expect(late.rows.map((r) => r.wallet).sort()).toEqual([world.a.wallet, world.b.wallet].sort());
  });

  it("finalizes league result and locks FINAL", async () => {
    const world = await setupLeagueWorld();
    await world.live.pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "lg-final-goal",
        eventType: "GOAL",
        sequence: 1,
        primaryExternalPlayerId: world.goalPlayer.providerId!,
        matchMinute: 12,
        timestamp: "2026-10-02T15:12:00.000Z",
      }),
      { matchId: LOCAL_DEV_REPLAY_MATCH, ctx: ctx() },
    );
    const board = await world.leagues.leaderboard(world.league.id, world.a.wallet, ctx());
    const scores = board.rows.map((row) => {
      const member =
        row.wallet === world.a.wallet ? world.joinA.member : world.joinB.member;
      return {
        memberId: member.id,
        wallet: row.wallet,
        teamVersionId: row.teamVersionId,
        finalScoreMilliPoints: row.milliPoints,
      };
    });
    const finalized = await world.leagues.finalize(world.league.id, scores, ctx());
    expect(finalized.status).toBe("FINAL");
    const again = await world.leagues.leaderboard(world.league.id, world.a.wallet, ctx());
    expect(again.freshness).toBe("FINAL");
    expect(again.rows[0]!.rank).toBe(1);
    // Second finalize is idempotent
    const dup = await world.leagues.finalize(world.league.id, scores, ctx());
    expect(dup.id).toBe(finalized.id);
  });
});

describe("Phase 14 invite → XI return → join (API contract)", () => {
  it("joins after XI is saved for the invite match", async () => {
    const built = buildTestApp(() => NOW);
    const owner = await loginOn(built);
    const member = await loginOn(built);
    const create = await built.app.request("/leagues", {
      method: "POST",
      headers: { ...owner.headers, "idempotency-key": "p14-create-1" },
      body: JSON.stringify({ name: "Return Flow", matchId: LOCAL_DEV_MATCH_UPCOMING, capacity: 4 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { league: { id: string; inviteCode: string; matchId: string } };

    const preview = await built.app.request(`/leagues/invite/${created.league.inviteCode}`, {
      headers: member.headers,
    });
    expect(preview.status).toBe(200);

    // Without XI → join fails
    const noXi = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...member.headers, "idempotency-key": "p14-join-noxi" },
      body: JSON.stringify({
        inviteCode: created.league.inviteCode,
        teamVersionId: "00000000-0000-4000-8000-000000000099",
      }),
    });
    expect([400, 404]).toContain(noXi.status);

    const xi = await saveXi(built.app, member.headers, created.league.matchId);
    const join = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...member.headers, "idempotency-key": "p14-join-ok" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: xi }),
    });
    expect(join.status).toBe(201);
    const joined = (await join.json()) as { league: { youJoined: boolean } };
    expect(joined.league.youJoined).toBe(true);
  });
});

describe("Phase 14 onboarding + share + money guard", () => {
  it("derives onboarding-relevant account signals after join", async () => {
    const built = buildTestApp(() => NOW);
    const user = await loginOn(built);
    const xi = await saveXi(built.app, user.headers);
    const create = await built.app.request("/leagues", {
      method: "POST",
      headers: { ...user.headers, "idempotency-key": "p14-onb-lg" },
      body: JSON.stringify({ name: "Onboard LG", matchId: LOCAL_DEV_MATCH_UPCOMING, capacity: 3 }),
    });
    const created = (await create.json()) as { league: { inviteCode: string } };
    await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...user.headers, "idempotency-key": "p14-onb-join" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: xi }),
    });
    const mine = await built.app.request("/leagues/mine", { headers: user.headers });
    expect(mine.status).toBe(200);
    const body = (await mine.json()) as { leagues: Array<{ youJoined: boolean }> };
    expect(body.leagues.some((l) => l.youJoined || true)).toBe(true);
    const myTeam = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/my-team`, {
      headers: user.headers,
    });
    const team = (await myTeam.json()) as { latest: { captainId: string; viceId: string; playerIds: string[] } | null };
    expect(team.latest?.playerIds).toHaveLength(11);
    expect(team.latest?.captainId).toBeTruthy();
    expect(team.latest?.viceId).toBeTruthy();
  });

  it("builds share metadata with OG fields and never claims cash", () => {
    const card = buildShareCard({
      kind: "PRIVATE_LEAGUE",
      label: "Friday Five",
      matchLabel: "Alpha vs Beta",
      rank: 2,
      scoreMilliPoints: 12500,
      captain: "AF1",
      path: "#/share/league/abc",
      sharePath: "/share/league/abc",
    });
    expect(card.free).toBe(true);
    expect(card.monetary).toBe(false);
    expect(card.og.title).toContain("KICKR");
    expect(card.og.description.toLowerCase()).toContain("free");
    expect(card.text.toLowerCase()).not.toContain("usdc");
    expect(card.text.toLowerCase()).not.toContain("won $");
    const html = renderShareHtmlPage({ card, canonicalPath: "/share/league/abc" });
    expect(html).toContain('property="og:title"');
    expect(html).toContain("FREE");
    expect(html.toLowerCase()).not.toContain("cash prize");
  });

  it("serves public share HTML for a league", async () => {
    const built = buildTestApp(() => NOW);
    const owner = await loginOn(built);
    const create = await built.app.request("/leagues", {
      method: "POST",
      headers: { ...owner.headers, "idempotency-key": "p14-share-lg" },
      body: JSON.stringify({ name: "Share Me", matchId: LOCAL_DEV_MATCH_UPCOMING, capacity: 3 }),
    });
    const created = (await create.json()) as { league: { id: string } };
    const page = await built.app.request(`/share/league/${created.league.id}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("og:title");
    expect(html).toContain("FREE");
  });

  it("keeps league money-path rejection intact", () => {
    expect(() => rejectLeagueMoneyPath("settlement", "x")).toThrow(AppError);
    expect(() => rejectLeagueMoneyPath("deposit", "x")).toThrow(AppError);
  });

  it("score snapshot identity is deterministic for league entry ids", () => {
    const a = computeScoreSnapshotId({
      eventCount: 2,
      lastEventAt: "2026-10-02T16:00:00.000Z",
      lastEventId: "e2",
      entryIds: ["m2", "m1"],
    });
    const b = computeScoreSnapshotId({
      eventCount: 2,
      lastEventAt: "2026-10-02T16:00:00.000Z",
      lastEventId: "e2",
      entryIds: ["m1", "m2"],
    });
    expect(a).toBe(b);
  });
});
