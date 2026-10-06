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
import {
  computeScoreSnapshotId,
  eventLogFingerprint,
  isScoreSnapshotFresh,
} from "../live/score-snapshot.js";
import { newId } from "../shared/ids.js";
import type { RequestContext } from "../auth/types.js";
import type { NormalizedEventDraft } from "../sports/normalize.js";

const ctx = (): RequestContext => ({
  now: new Date("2026-10-02T16:30:00.000Z"),
  correlationId: "lb-freshness",
});

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

describe("score snapshot helpers", () => {
  it("computes a stable etag and rejects stale ids", () => {
    const id = computeScoreSnapshotId({
      eventCount: 2,
      lastEventAt: "2026-10-02T16:00:00.000Z",
      lastEventId: "e2",
      entryIds: ["b", "a"],
    });
    const same = computeScoreSnapshotId({
      eventCount: 2,
      lastEventAt: "2026-10-02T16:00:00.000Z",
      lastEventId: "e2",
      entryIds: ["a", "b"],
    });
    expect(id).toBe(same);
    expect(isScoreSnapshotFresh(id, same)).toBe(true);
    expect(
      isScoreSnapshotFresh(
        id,
        computeScoreSnapshotId({
          eventCount: 3,
          lastEventAt: "2026-10-02T16:05:00.000Z",
          lastEventId: "e3",
          entryIds: ["a", "b"],
        }),
      ),
    ).toBe(false);
    expect(isScoreSnapshotFresh(null, id)).toBe(false);
  });

  it("fingerprints the latest event by timestamp then id", () => {
    const fp = eventLogFingerprint([
      { eventId: "a", timestamp: "2026-10-02T16:00:00.000Z" },
      { eventId: "c", timestamp: "2026-10-02T16:05:00.000Z" },
      { eventId: "b", timestamp: "2026-10-02T16:05:00.000Z" },
    ]);
    expect(fp.eventCount).toBe(3);
    expect(fp.lastEventAt).toBe("2026-10-02T16:05:00.000Z");
    expect(fp.lastEventId).toBe("c");
  });
});

describe("leaderboard cache freshness", () => {
  async function setupTwoEntryWorld() {
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

    const makeEntry = async (wallet: string, captainId: string, viceId: string) => {
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
      return { entryId: newId(), contestId: "contest-fresh", wallet, teamVersionId: versionId };
    };

    // A captains AF1; B captains AM1 so a goal on AF1 separates ranks.
    const entryA = await makeEntry("WalletAAA1111111111111111111111111111", goalPlayer.id, assistPlayer.id);
    const entryB = await makeEntry("WalletBBB1111111111111111111111111111", assistPlayer.id, goalPlayer.id);

    const entries = [entryA, entryB];
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
    return { store, live, entries, goalPlayer };
  }

  it("invalidates a stale Redis leaderboard when a newer scoring wave lands in Postgres", async () => {
    const { store, live, goalPlayer } = await setupTwoEntryWorld();

    await live.pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "wave1-goal",
        eventType: "GOAL",
        sequence: 1,
        primaryExternalPlayerId: goalPlayer.providerId!,
        timestamp: "2026-10-02T16:01:00.000Z",
      }),
      { ctx: ctx() },
    );

    const first = await live.getLeaderboard(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(first?.leaderboard.length).toBe(2);
    expect(first?.scoreSnapshotId).toBeTruthy();
    const firstSnap = first!.scoreSnapshotId;
    const firstScores = new Map(first!.leaderboard.map((r) => [r.entryId, r.milliPoints]));

    // Simulate out-of-band event insert (Postgres advances; Redis still holds wave-1).
    await store.insertEvent({
      eventId: newId(),
      matchId: LOCAL_DEV_REPLAY_MATCH,
      provider: "local-dev",
      providerEventId: "wave2-goal-direct",
      sequence: 2,
      timestamp: "2026-10-02T16:10:00.000Z",
      matchMinute: 20,
      period: "FIRST_HALF",
      eventType: "GOAL",
      primaryPlayerId: goalPlayer.id,
      secondaryPlayerId: null,
      teamId: goalPlayer.clubId,
      metadata: { injected: true },
      supersedesEventId: null,
      createdAt: "2026-10-02T16:10:00.000Z",
    });

    // Cache still has wave-1 snapshot id — must not survive getLeaderboard.
    const cachedBefore = await live.cache.readLeaderboard(LOCAL_DEV_REPLAY_MATCH);
    expect(cachedBefore?.scoreSnapshotId).toBe(firstSnap);

    const second = await live.getLeaderboard(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(second?.scoreSnapshotId).not.toBe(firstSnap);
    expect(second?.eventCount).toBeGreaterThan(first!.eventCount ?? 0);

    // Ranking / scores must reflect the new wave (captain goal again ⇒ higher totals).
    for (const row of second!.leaderboard) {
      const prev = firstScores.get(row.entryId) ?? 0;
      expect(row.milliPoints).toBeGreaterThan(prev);
    }
  });

  it("records rank movement and score delta after a new scoring wave via the pipeline", async () => {
    const { live, goalPlayer, entries } = await setupTwoEntryWorld();

    await live.pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "move-goal-1",
        eventType: "GOAL",
        sequence: 1,
        primaryExternalPlayerId: goalPlayer.providerId!,
        timestamp: "2026-10-02T16:01:00.000Z",
      }),
      { ctx: ctx() },
    );
    const wave1 = await live.getLeaderboard(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(wave1?.leaderboard).toHaveLength(2);

    await live.pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "move-goal-2",
        eventType: "GOAL",
        sequence: 2,
        primaryExternalPlayerId: goalPlayer.providerId!,
        timestamp: "2026-10-02T16:12:00.000Z",
        matchMinute: 22,
      }),
      { ctx: ctx() },
    );

    const wave2 = await live.getLeaderboard(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(wave2?.scoreSnapshotId).not.toBe(wave1?.scoreSnapshotId);
    const row = wave2!.leaderboard.find((r) => r.entryId === entries[0]!.entryId);
    expect(row).toBeTruthy();
    expect(row!.priorRank).toBe(1);
    expect(row!.scoreDelta).toBeGreaterThan(0);
  });

  it("keeps teamVersionId on cache-served leaderboard rows", async () => {
    const { live, goalPlayer, entries } = await setupTwoEntryWorld();
    await live.pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "tv-goal",
        eventType: "GOAL",
        sequence: 1,
        primaryExternalPlayerId: goalPlayer.providerId!,
      }),
      { ctx: ctx() },
    );
    // First read rebuilds; second read must hit fresh cache with full row fields.
    await live.getLeaderboard(LOCAL_DEV_REPLAY_MATCH, ctx());
    const cached = await live.getLeaderboard(LOCAL_DEV_REPLAY_MATCH, ctx());
    const row = cached!.leaderboard.find((r) => r.entryId === entries[0]!.entryId);
    expect(row?.teamVersionId).toBe(entries[0]!.teamVersionId);
    expect(row?.contestId).toBe("contest-fresh");
    expect(row?.wallet).toBe(entries[0]!.wallet);
  });
});
