/**
 * Phase 15: contest-scoped ranking, join intent UX, onboarding view event, share OG PNG.
 */
import { readFileSync } from "node:fs";
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
import { type ContestScoringSource } from "../live/pipeline.js";
import { LiveScoringService } from "../live/service.js";
import { filterAndRerankContestRows, rankWithinContestScope } from "../live/contest-rank.js";
import { rankFreeEntries } from "../contests/free/results.js";
import { buildShareCard, renderShareHtmlPage } from "../profile/share.js";
import { renderSharePreviewPng } from "../profile/share-image.js";
import { newId } from "../shared/ids.js";
import type { RequestContext } from "../auth/types.js";
import type { NormalizedEventDraft } from "../sports/normalize.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";
import { LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const ctx = (): RequestContext => ({ now: NOW, correlationId: "phase15" });

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

describe("Phase 15 contest-scoped ranking helpers", () => {
  it("re-ranks within a contest and ignores global ranks from a mixed board", () => {
    const mixed = [
      { entryId: "e-high", contestId: "c1", milliPoints: 5000 },
      { entryId: "e-mid", contestId: "c2", milliPoints: 4000 },
      { entryId: "e-low", contestId: "c1", milliPoints: 1000 },
    ].map((row, i) => ({ ...row, rank: i + 1 })); // global ranks 1,2,3

    const scoped = filterAndRerankContestRows(mixed, "c1");
    expect(scoped).toHaveLength(2);
    expect(scoped[0]!.entryId).toBe("e-high");
    expect(scoped[0]!.rank).toBe(1);
    expect(scoped[1]!.entryId).toBe("e-low");
    expect(scoped[1]!.rank).toBe(2); // was global 3 — must become contest 2
  });

  it("breaks ties with entry_id_asc (same as FREE finalization)", () => {
    const tied = [
      { entryId: "bbbb", milliPoints: 3000 },
      { entryId: "aaaa", milliPoints: 3000 },
      { entryId: "cccc", milliPoints: 2000 },
    ];
    const live = rankWithinContestScope(tied);
    expect(live.map((r) => r.entryId)).toEqual(["aaaa", "bbbb", "cccc"]);
    expect(live.map((r) => r.rank)).toEqual([1, 2, 3]);

    const finalRows = rankFreeEntries(
      tied.map((row) => ({
        entryId: row.entryId,
        wallet: `w-${row.entryId}`,
        teamVersionId: `tv-${row.entryId}`,
        finalScoreMilliPoints: row.milliPoints,
      })),
    );
    expect(finalRows.map((r) => r.entryId)).toEqual(["aaaa", "bbbb", "cccc"]);
    expect(finalRows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });
});

describe("Phase 15 live contest leaderboard vs global match board", () => {
  async function setupTwoContestWorld() {
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
    const catalogPlayers = catalog.players;
    const goalPlayer = catalogPlayers.find((p) => p.shortName === "AF1")!;
    const assistPlayer = catalogPlayers.find((p) => p.shortName === "AM1")!;
    const xi = catalogPlayers.slice(0, 11).map((row) => row.id);
    xi[0] = goalPlayer.id;
    xi[1] = assistPlayer.id;

    const contestA = "contest-aaa-1111-4111-8111-111111111111";
    const contestB = "contest-bbb-2222-4222-8222-222222222222";

    const makeEntry = async (
      contestId: string,
      wallet: string,
      captainId: string,
      viceId: string,
      entryId: string,
    ) => {
      const teamId = newId();
      const versionId = newId();
      await store.createTeam({
        id: teamId,
        accountId: newId(),
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
      return { entryId, contestId, wallet, teamVersionId: versionId };
    };

    // Contest A: only mid scorer (assist captain) — would be global rank 2 if mixed.
    // Contest B: high + low scorers so A looks "global rank 2" without re-rank.
    const aOnly = await makeEntry(
      contestA,
      "WalletOnlyA11111111111111111111111111",
      assistPlayer.id,
      goalPlayer.id,
      "entry-a-only-0000-4000-8000-000000000001",
    );
    const bHigh = await makeEntry(
      contestB,
      "WalletHighB11111111111111111111111111",
      goalPlayer.id,
      assistPlayer.id,
      "entry-b-high-0000-4000-8000-000000000002",
    );
    const bLow = await makeEntry(
      contestB,
      "WalletLowB111111111111111111111111111",
      assistPlayer.id,
      goalPlayer.id,
      "entry-b-low-0000-4000-8000-000000000003",
    );

    const entries = [aOnly, bHigh, bLow];
    const contestSource: ContestScoringSource = {
      async listEntriesForMatch() {
        return entries.map((e) => ({
          entryId: e.entryId,
          contestId: e.contestId,
          wallet: e.wallet,
          teamVersionId: e.teamVersionId,
          status: "CONFIRMED",
        }));
      },
    };

    const live = new LiveScoringService(
      store,
      football,
      idMap,
      redis,
      "test",
      audit,
      "local-dev",
      contestSource,
    );
    return { live, entries, goalPlayer, contestA, contestB, aOnly, bHigh, bLow };
  }

  it("assigns contest-local ranks (no global-rank leakage) and matches final ordering", async () => {
    const world = await setupTwoContestWorld();
    await world.live.pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "p15-goal",
        eventType: "GOAL",
        sequence: 1,
        primaryExternalPlayerId: world.goalPlayer.providerId!,
        timestamp: "2026-10-02T16:01:00.000Z",
      }),
      { ctx: ctx() },
    );

    const global = await world.live.getLeaderboard(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(global?.leaderboard.length).toBe(3);
    const globalOnlyA = global!.leaderboard.find((r) => r.entryId === world.aOnly.entryId)!;
    // With mixed board, A is not necessarily rank 1.
    expect(globalOnlyA.rank).toBeGreaterThan(1);

    const contestBoard = await world.live.getContestLeaderboard(
      { contestId: world.contestA, matchId: LOCAL_DEV_REPLAY_MATCH },
      ctx(),
    );
    expect(contestBoard?.leaderboard).toHaveLength(1);
    expect(contestBoard!.leaderboard[0]!.entryId).toBe(world.aOnly.entryId);
    expect(contestBoard!.leaderboard[0]!.rank).toBe(1); // contest-local #1

    const contestBBoard = await world.live.getContestLeaderboard(
      { contestId: world.contestB, matchId: LOCAL_DEV_REPLAY_MATCH },
      ctx(),
    );
    expect(contestBBoard?.leaderboard).toHaveLength(2);
    expect(contestBBoard!.leaderboard[0]!.entryId).toBe(world.bHigh.entryId);
    expect(contestBBoard!.leaderboard[0]!.rank).toBe(1);
    expect(contestBBoard!.leaderboard[1]!.rank).toBe(2);

    // Live vs final: same ordering logic
    const finalB = rankFreeEntries(
      contestBBoard!.leaderboard.map((row) => ({
        entryId: row.entryId,
        wallet: row.wallet,
        teamVersionId: row.teamVersionId,
        finalScoreMilliPoints: row.milliPoints,
      })),
    );
    expect(finalB.map((r) => r.entryId)).toEqual(contestBBoard!.leaderboard.map((r) => r.entryId));
    expect(finalB.map((r) => r.rank)).toEqual(contestBBoard!.leaderboard.map((r) => r.rank));
  });

  it("keeps user row rank equal to contest result rank after finalize path", async () => {
    const world = await setupTwoContestWorld();
    await world.live.pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "p15-goal-2",
        eventType: "GOAL",
        sequence: 1,
        primaryExternalPlayerId: world.goalPlayer.providerId!,
        timestamp: "2026-10-02T16:01:00.000Z",
      }),
      { ctx: ctx() },
    );
    const liveBoard = await world.live.getContestLeaderboard(
      { contestId: world.contestB, matchId: LOCAL_DEV_REPLAY_MATCH },
      ctx(),
    );
    const userRow = liveBoard!.leaderboard.find((r) => r.wallet === world.bLow.wallet)!;
    const finalized = rankFreeEntries(
      liveBoard!.leaderboard.map((row) => ({
        entryId: row.entryId,
        wallet: row.wallet,
        teamVersionId: row.teamVersionId,
        finalScoreMilliPoints: row.milliPoints,
      })),
    );
    const finalUser = finalized.find((r) => r.wallet === world.bLow.wallet)!;
    expect(userRow.rank).toBe(finalUser.rank);
  });
});

describe("Phase 15 invite return without auto-join + onboarding view event", () => {
  it("client source requires Join League confirmation and does not auto-join", () => {
    const src = readFileSync(new URL("../app/src/main.ts", import.meta.url), "utf8");
    expect(src).toContain("Join League");
    expect(src).toContain("XI saved. Press Join League to confirm.");
    expect(src).not.toContain("lgj-auto");
    expect(src).not.toContain("XI ready — joining");
    expect(src).toContain("Returning to confirm join");
  });

  it("tracks leaderboard viewed via explicit session event, not contest lifecycle", () => {
    const src = readFileSync(new URL("../app/src/main.ts", import.meta.url), "utf8");
    expect(src).toContain("kickr.onboarding.leaderboardViewed");
    expect(src).toContain("markLeaderboardViewed");
    expect(src).toContain("leaderboardReady = leaderboardViewed()");
    expect(src).not.toMatch(/leaderboardReady\s*=\s*[\s\S]*lifecycleBucket === "live"/);
  });

  it("API join still requires explicit POST after XI (no server auto-join)", async () => {
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
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
    const create = await built.app.request("/leagues", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "p15-create" },
      body: JSON.stringify({ name: "Intent League", matchId: LOCAL_DEV_MATCH_UPCOMING, capacity: 4 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { league: { inviteCode: string; id: string; memberCount: number } };
    // Preview invite does not join
    const preview = await built.app.request(`/leagues/invite/${created.league.inviteCode}`, { headers });
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as { league: { youJoined: boolean; memberCount: number } };
    expect(previewBody.league.youJoined).toBe(false);
    expect(previewBody.league.memberCount).toBe(created.league.memberCount);
  });
});

describe("Phase 15 share preview PNG", () => {
  it("generates a deterministic PNG and HTML references og:image", () => {
    const png = renderSharePreviewPng({
      kind: "FREE_CONTEST",
      matchLabel: "Alpha vs Beta",
      label: "FREE GRAND",
      rank: 2,
      score: 12.5,
    });
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    expect(png.length).toBeGreaterThan(200);
    expect(png.length).toBeLessThan(80_000);

    const again = renderSharePreviewPng({
      kind: "FREE_CONTEST",
      matchLabel: "Alpha vs Beta",
      label: "FREE GRAND",
      rank: 2,
      score: 12.5,
    });
    expect(Buffer.compare(png, again)).toBe(0);

    const card = buildShareCard({
      kind: "FREE_CONTEST",
      label: "FREE GRAND",
      matchLabel: "Alpha vs Beta",
      rank: 2,
      scoreMilliPoints: 12500,
      captain: null,
      path: "#/share/contest/abc",
      sharePath: "/share/contest/abc",
    });
    expect(card.og.image).toBe("/share/contest/abc/og.png");
    const html = renderShareHtmlPage({ card, canonicalPath: "/share/contest/abc" });
    expect(html).toContain('property="og:image"');
    expect(html).toContain("/share/contest/abc/og.png");
    expect(html.toLowerCase()).not.toContain("cash prize");
    expect(html.toLowerCase()).not.toContain("usdc");
  });

  it("serves PNG at stable share OG URL", async () => {
    const built = buildTestApp(() => NOW);
    const ownerWallet = generateWallet();
    const issued = await built.deps.auth.issueNonce(ownerWallet.publicKey, {
      now: NOW,
      correlationId: null,
    });
    const session = await built.deps.auth.login(
      {
        walletAddress: ownerWallet.publicKey,
        message: issued.message,
        signature: signMessage(issued.message, ownerWallet.secretKey),
      },
      { now: NOW, correlationId: null },
    );
    const headers = {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    };
    const create = await built.app.request("/leagues", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "p15-share-png" },
      body: JSON.stringify({ name: "PNG League", matchId: LOCAL_DEV_MATCH_UPCOMING, capacity: 3 }),
    });
    const created = (await create.json()) as { league: { id: string } };
    const res = await built.app.request(`/share/league/${created.league.id}/og.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);

    const page = await built.app.request(`/share/league/${created.league.id}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`/share/league/${created.league.id}/og.png`);
  });
});

describe("Phase 15 contest leaderboard API", () => {
  it("exposes /contests/:id/leaderboard with contest-scoped ranks", async () => {
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
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
    const listed = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/contests`, { headers });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      contests: Array<{ contestId: string; contestKind: string }>;
    };
    const free = body.contests.find((c) => c.contestKind === "FREE");
    expect(free).toBeTruthy();
    const board = await built.app.request(`/contests/${free!.contestId}/leaderboard`, { headers });
    expect(board.status).toBe(200);
    const json = (await board.json()) as {
      contestId: string;
      leaderboard: Array<{ contestId: string; rank: number }>;
      note?: string;
    };
    expect(json.contestId).toBe(free!.contestId);
    for (const row of json.leaderboard) {
      expect(row.contestId).toBe(free!.contestId);
    }
  });
});
