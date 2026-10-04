import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../audit/memory.js";
import { InMemoryFootballStore } from "../football/store.js";
import { InMemoryRedis } from "../redis/client.js";
import { InMemoryProviderIdMap, loadProviderIdMap, seedProviderIdMapFromCatalog } from "../sports/id-map.js";
import { InMemoryProviderIdMapRepository } from "../db/provider-id-map.js";
import { buildPhase5ReplayCatalog, LOCAL_DEV_REPLAY_MATCH } from "../sports/replay-fixture.js";
import { LOCAL_DEV_CLUB_A } from "../sports/local-dev-provider.js";
import { LiveScoringPipeline, type ContestScoringSource } from "../live/pipeline.js";
import { LiveScoreCache } from "../live/cache.js";
import { LiveScoreHub } from "../live/hub.js";
import { LiveMetrics } from "../live/metrics.js";
import { explainEventContribution } from "../live/contribution.js";
import { computeFreshness, occurrenceFromKickoffMinute } from "../live/freshness.js";
import { extractSportmonksLineups, syncProviderLineups } from "../live/lineup-sync.js";
import { derivePitchStates } from "../live/lineup.js";
import {
  buildDraftSnapshot,
  InMemorySnapshotStore,
  updateApprovedSnapshot,
} from "../live/snapshot.js";
import { createIngestWorker } from "../live/ingest.js";
import { normalizeSportmonksEvent } from "../sports/normalize.js";
import { DEV_V1_RULESET } from "../domain/scoring/dev-v1.js";
import { newId } from "../shared/ids.js";
import type { RequestContext } from "../auth/types.js";
import type { NormalizedEventDraft } from "../sports/normalize.js";
import type { ScoringEventInput } from "../domain/scoring/engine.js";

const ctx = (): RequestContext => ({
  now: new Date("2026-10-02T16:30:00.000Z"),
  correlationId: "phase5.1",
});

function baseDraft(partial: Partial<NormalizedEventDraft> & Pick<NormalizedEventDraft, "providerEventId" | "eventType" | "sequence">): NormalizedEventDraft {
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

describe("Phase 5.1 production correctness", () => {
  it("loads provider_id_map rows into runtime without inventing domain ids", async () => {
    const catalog = buildPhase5ReplayCatalog();
    const map = new InMemoryProviderIdMap();
    const known = new Set(catalog.players.map((player) => player.id));
    known.add(catalog.clubs[0]!.id);
    known.add(LOCAL_DEV_REPLAY_MATCH);
    const repo = new InMemoryProviderIdMapRepository((kind, id) => {
      void kind;
      return known.has(id);
    });
    const player = catalog.players[0]!;
    const club = catalog.clubs[0]!;
    await repo.upsertMapping({
      provider: "sportmonks",
      entityKind: "player",
      externalId: "sm-player-1",
      kickrId: player.id,
    });
    await repo.upsertMapping({
      provider: "sportmonks",
      entityKind: "club",
      externalId: "sm-club-1",
      kickrId: club.id,
    });
    await repo.upsertMapping({
      provider: "sportmonks",
      entityKind: "fixture",
      externalId: "sm-fixture-1",
      kickrId: LOCAL_DEV_REPLAY_MATCH,
    });
    const rejected = await repo.upsertMapping({
      provider: "sportmonks",
      entityKind: "player",
      externalId: "sm-missing",
      kickrId: newId(),
    });
    expect(rejected).toBe("rejected_missing_kickr");
    loadProviderIdMap(map, await repo.listAll());
    expect(map.get("sportmonks", "player", "sm-player-1")).toBe(player.id);
    expect(map.get("sportmonks", "club", "sm-club-1")).toBe(club.id);
    expect(map.get("sportmonks", "fixture", "sm-fixture-1")).toBe(LOCAL_DEV_REPLAY_MATCH);
    expect(map.get("sportmonks", "player", "sm-missing")).toBeNull();
  });

  it("unresolved provider ids never create KICKR players", async () => {
    const catalog = buildPhase5ReplayCatalog();
    const store = new InMemoryFootballStore({
      ...catalog,
      events: catalog.events.filter((event) => event.matchId !== LOCAL_DEV_REPLAY_MATCH),
    });
    const idMap = new InMemoryProviderIdMap();
    seedProviderIdMapFromCatalog(idMap, "local-dev", catalog);
    const pipeline = new LiveScoringPipeline(
      store,
      idMap,
      new LiveScoreCache(new InMemoryRedis(), "test"),
      new LiveScoreHub(),
      new LiveMetrics(),
      new InMemoryAuditStore(),
      "local-dev",
    );
    const before = await store.listPlayers();
    const result = await pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "no-map",
        eventType: "GOAL",
        sequence: 1,
        primaryExternalPlayerId: "unknown-ext",
      }),
      { ctx: ctx() },
    );
    expect(result.status).toBe("unresolved_player");
    expect(await store.listPlayers()).toHaveLength(before.length);
  });

  it("contest scoring uses entry team_version_id exactly after a newer version exists", async () => {
    const catalog = buildPhase5ReplayCatalog();
    const store = new InMemoryFootballStore({
      ...catalog,
      events: catalog.events.filter((event) => event.matchId !== LOCAL_DEV_REPLAY_MATCH),
    });
    const idMap = new InMemoryProviderIdMap();
    seedProviderIdMapFromCatalog(idMap, "local-dev", catalog);
    const goal = catalog.players.find((row) => row.shortName === "AF1")!;
    const assist = catalog.players.find((row) => row.shortName === "AM1")!;
    const xiA = catalog.players.slice(0, 11).map((row) => row.id);
    // ensure goal/assist in XI
    xiA[0] = goal.id;
    xiA[1] = assist.id;
    const teamId = newId();
    const accountId = newId();
    await store.createTeam({
      id: teamId,
      accountId,
      matchId: LOCAL_DEV_REPLAY_MATCH,
      status: "LOCKED",
      createdAt: "2026-10-02T14:00:00.000Z",
      updatedAt: "2026-10-02T14:00:00.000Z",
    });
    const versionAId = newId();
    await store.insertVersion({
      id: versionAId,
      teamId,
      version: 1,
      matchId: LOCAL_DEV_REPLAY_MATCH,
      playerIds: xiA,
      captainId: goal.id,
      viceId: assist.id,
      creditsUsed: 90,
      validationResult: { valid: true, errors: [] },
      createdAt: "2026-10-02T14:00:00.000Z",
    });
    const versionBId = newId();
    const xiB = [...xiA];
    // Swap captain/vice in B — contest must ignore this.
    await store.insertVersion({
      id: versionBId,
      teamId,
      version: 2,
      matchId: LOCAL_DEV_REPLAY_MATCH,
      playerIds: xiB,
      captainId: assist.id,
      viceId: goal.id,
      creditsUsed: 90,
      validationResult: { valid: true, errors: [] },
      createdAt: "2026-10-02T14:05:00.000Z",
    });
    const entryId = newId();
    const contestId = newId();
    const contestSource: ContestScoringSource = {
      async listEntriesForMatch() {
        return [
          {
            entryId,
            contestId,
            wallet: "Wallet1111111111111111111111111111111",
            teamVersionId: versionAId,
            status: "CONFIRMED",
          },
        ];
      },
    };
    const pipeline = new LiveScoringPipeline(
      store,
      idMap,
      new LiveScoreCache(new InMemoryRedis(), "test"),
      new LiveScoreHub(),
      new LiveMetrics(),
      new InMemoryAuditStore(),
      "local-dev",
      contestSource,
    );
    await pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "entry-goal",
        eventType: "GOAL",
        sequence: 1,
        primaryExternalPlayerId: goal.providerId,
      }),
      { ctx: ctx() },
    );
    const score = await pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(score.contestEntryScores).toHaveLength(1);
    expect(score.contestEntryScores[0]?.teamVersionId).toBe(versionAId);
    const captainRow = score.contestEntryScores[0]?.players.find((row) => row.playerId === goal.id);
    const viceRow = score.contestEntryScores[0]?.players.find((row) => row.playerId === assist.id);
    expect(captainRow?.role).toBe("captain");
    expect(captainRow?.milliPoints).toBe(10000);
    expect(viceRow?.role).toBe("vice");
    expect(score.leaderboard[0]?.teamVersionId).toBe(versionAId);
    expect(score.leaderboard[0]?.entryId).toBe(entryId);
    // Personal latest would treat assist as captain — contest must not.
    expect(score.personalTeamScores[0]?.players.find((row) => row.playerId === assist.id)?.role).toBe(
      "captain",
    );
  });

  it("event contribution is base × multiplier, not accumulated player total", () => {
    const goal1: ScoringEventInput = {
      eventId: "g1",
      eventType: "GOAL",
      primaryPlayerId: "p1",
      secondaryPlayerId: null,
      supersedesEventId: null,
      sequence: 1,
    };
    const goal2: ScoringEventInput = {
      eventId: "g2",
      eventType: "GOAL",
      primaryPlayerId: "p1",
      secondaryPlayerId: null,
      supersedesEventId: null,
      sequence: 2,
    };
    const matchContext = { matchId: "m", homeClubId: "h", awayClubId: "a" };
    const second = explainEventContribution({
      eventsBefore: [goal1],
      eventsAfter: [goal1, goal2],
      trigger: goal2,
      playerIds: ["p1"],
      captainId: "p1",
      viceId: "p2",
      matchContext,
    });
    expect(second.basePoints).toBe(5);
    expect(second.multiplierLabel).toBe("captain 2/1");
    expect(second.contribution).toBe(10);
    expect(second.previousPlayerTotal).toBe(10);
    expect(second.newPlayerTotal).toBe(20);
    expect(second.contribution).not.toBe(second.newPlayerTotal);

    const yellow: ScoringEventInput = {
      eventId: "y1",
      eventType: "YELLOW_CARD",
      primaryPlayerId: "p2",
      secondaryPlayerId: null,
      supersedesEventId: null,
      sequence: 3,
    };
    const neg = explainEventContribution({
      eventsBefore: [goal1, goal2],
      eventsAfter: [goal1, goal2, yellow],
      trigger: yellow,
      playerIds: ["p1", "p2"],
      captainId: "p1",
      viceId: "p2",
      matchContext,
    });
    expect(neg.basePoints).toBe(-1);
    expect(neg.multiplierLabel).toBe("vice 3/2");
    expect(neg.contribution).toBe(-1.5);

    const reversal: ScoringEventInput = {
      eventId: "v1",
      eventType: "VAR_REVERSAL",
      primaryPlayerId: "p1",
      secondaryPlayerId: null,
      supersedesEventId: "g2",
      sequence: 4,
    };
    const corrected = explainEventContribution({
      eventsBefore: [goal1, goal2],
      eventsAfter: [goal1, goal2, reversal],
      trigger: reversal,
      playerIds: ["p1"],
      captainId: "p1",
      viceId: "p2",
      matchContext,
    });
    expect(corrected.contribution).toBe(0);
    expect(corrected.newPlayerTotal).toBe(10);
  });

  it("pipeline SSE update uses event contribution not player total", async () => {
    const catalog = buildPhase5ReplayCatalog();
    const store = new InMemoryFootballStore({
      ...catalog,
      events: catalog.events.filter((event) => event.matchId !== LOCAL_DEV_REPLAY_MATCH),
    });
    const idMap = new InMemoryProviderIdMap();
    seedProviderIdMapFromCatalog(idMap, "local-dev", catalog);
    const goal = catalog.players.find((row) => row.shortName === "AF1")!;
    const xi = catalog.players.slice(0, 11).map((row) => row.id);
    xi[0] = goal.id;
    const teamId = newId();
    await store.createTeam({
      id: teamId,
      accountId: newId(),
      matchId: LOCAL_DEV_REPLAY_MATCH,
      status: "LOCKED",
      createdAt: "2026-10-02T14:00:00.000Z",
      updatedAt: "2026-10-02T14:00:00.000Z",
    });
    const versionId = newId();
    await store.insertVersion({
      id: versionId,
      teamId,
      version: 1,
      matchId: LOCAL_DEV_REPLAY_MATCH,
      playerIds: xi,
      captainId: goal.id,
      viceId: xi[1]!,
      creditsUsed: 90,
      validationResult: { valid: true, errors: [] },
      createdAt: "2026-10-02T14:00:00.000Z",
    });
    const hub = new LiveScoreHub();
    const updates: Array<{ contribution: number; newPlayerTotal: number }> = [];
    hub.subscribe(LOCAL_DEV_REPLAY_MATCH, (message) => {
      if (message.type === "score_update") {
        updates.push({
          contribution: message.explanation.contribution,
          newPlayerTotal: message.explanation.newPlayerTotal,
        });
      }
    });
    const contestSource: ContestScoringSource = {
      async listEntriesForMatch() {
        return [
          {
            entryId: newId(),
            contestId: newId(),
            wallet: "Wallet2222222222222222222222222222222",
            teamVersionId: versionId,
            status: "CONFIRMED",
          },
        ];
      },
    };
    const pipeline = new LiveScoringPipeline(
      store,
      idMap,
      new LiveScoreCache(new InMemoryRedis(), "test"),
      hub,
      new LiveMetrics(),
      new InMemoryAuditStore(),
      "local-dev",
      contestSource,
    );
    await pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "c1",
        eventType: "GOAL",
        sequence: 1,
        primaryExternalPlayerId: goal.providerId,
      }),
      { ctx: ctx() },
    );
    await pipeline.acceptNormalized(
      baseDraft({
        providerEventId: "c2",
        eventType: "GOAL",
        sequence: 2,
        matchMinute: 20,
        primaryExternalPlayerId: goal.providerId,
      }),
      { ctx: ctx() },
    );
    expect(updates.length).toBeGreaterThanOrEqual(2);
    const second = updates[1]!;
    expect(second.contribution).toBe(10);
    expect(second.newPlayerTotal).toBe(20);
    expect(second.contribution).not.toBe(second.newPlayerTotal);
  });

  it("syncs lineups into squad without inventing players", async () => {
    const catalog = buildPhase5ReplayCatalog();
    const store = new InMemoryFootballStore(catalog);
    const idMap = new InMemoryProviderIdMap();
    seedProviderIdMapFromCatalog(idMap, "sportmonks", {
      clubs: catalog.clubs.map((club) => ({ ...club, providerId: club.providerId })),
      players: catalog.players.map((player) => ({ ...player })),
      matches: catalog.matches.map((match) => ({
        id: match.id,
        externalFixtureId: match.externalFixtureId,
      })),
    });
    // Map a couple players under sportmonks external ids for the sync test.
    const starter = catalog.players.find((row) => row.shortName === "AF1")!;
    const bench = catalog.players.find((row) => row.shortName === "AM4")!;
    idMap.set({ provider: "sportmonks", entityKind: "player", externalId: "9001", kickrId: starter.id });
    idMap.set({ provider: "sportmonks", entityKind: "player", externalId: "9002", kickrId: bench.id });
    idMap.set({
      provider: "sportmonks",
      entityKind: "club",
      externalId: "53",
      kickrId: LOCAL_DEV_CLUB_A,
    });
    const fixture = {
      id: 1,
      lineups: [
        { player_id: 9001, team_id: 53, type_id: 11, jersey_number: 9 },
        { player_id: 9002, team_id: 53, type_id: 12, jersey_number: 14 },
        { player_id: 9999, team_id: 53, type_id: 11, jersey_number: 99 },
      ],
    };
    const rows = extractSportmonksLineups(fixture);
    const synced = syncProviderLineups({
      provider: "sportmonks",
      matchId: LOCAL_DEV_REPLAY_MATCH,
      externalFixtureId: "1",
      rows,
      idMap,
      existingSquad: await store.listSquad(LOCAL_DEV_REPLAY_MATCH),
      players: await store.listPlayers(),
      nowIso: "2026-10-02T14:30:00.000Z",
    });
    expect(synced.upserts).toHaveLength(2);
    expect(synced.unresolved).toHaveLength(1);
    for (const row of synced.upserts) {
      await store.upsertSquadRow(row);
    }
    const squad = await store.listSquad(LOCAL_DEV_REPLAY_MATCH);
    expect(squad.find((row) => row.playerId === starter.id)?.startingStatus).toBe("STARTER");
    expect(squad.find((row) => row.playerId === bench.id)?.startingStatus).toBe("BENCH");
    const beforePlayers = (await store.listPlayers()).length;
    expect((await store.listPlayers()).length).toBe(beforePlayers);

    const pitch = derivePitchStates(
      squad.map((row) => ({
        playerId: row.playerId,
        clubId: row.clubId,
        position: catalog.players.find((player) => player.id === row.playerId)!.position,
        startingStatus: row.startingStatus,
        availability: row.availability,
        squadStatus: row.squadStatus,
      })),
      [
        {
          eventType: "SUBSTITUTION",
          primaryPlayerId: starter.id,
          secondaryPlayerId: bench.id,
          sequence: 1,
          matchMinute: 60,
        },
      ],
    );
    expect(pitch.get(starter.id)?.derivedStatus).toBe("SUBSTITUTED_OFF");
    expect(pitch.get(bench.id)?.derivedStatus).toBe("SUBSTITUTED_ON");
  });

  it("freshness uses poll health, not kickoff age", () => {
    const now = new Date("2026-10-02T17:00:00.000Z");
    const live = computeFreshness({
      matchStatus: "LIVE",
      now,
      lastSuccessfulPollAt: "2026-10-02T16:59:30.000Z",
      ingestionLagMs: 200,
    });
    expect(live).toBe("LIVE");
    const stale = computeFreshness({
      matchStatus: "LIVE",
      now,
      lastSuccessfulPollAt: "2026-10-02T16:50:00.000Z",
      ingestionLagMs: 200,
    });
    expect(stale).toBe("STALE");
    const fallback = occurrenceFromKickoffMinute("2026-10-02T15:00:00.000Z", 12, 0);
    expect(fallback.timestampSource).toBe("kickoff_plus_minute");
    expect(fallback.timestamp).toBe("2026-10-02T15:12:00.000Z");
    const normalized = normalizeSportmonksEvent(
      {
        provider: "sportmonks",
        providerEventId: "1",
        externalFixtureId: "1",
        typeCode: 14,
        minute: 12,
        raw: { id: 1, type_id: 14 },
      },
      1,
      "v3",
      "2026-10-02T15:00:00.000Z",
    );
    expect(normalized.timestampSource).toBe("kickoff_plus_minute");
    expect(normalized.timestamp).toBe("2026-10-02T15:12:00.000Z");
  });

  it("correction without explicit related event id does not reverse an arbitrary goal", async () => {
    const catalog = buildPhase5ReplayCatalog();
    const store = new InMemoryFootballStore({
      ...catalog,
      events: catalog.events.filter((event) => event.matchId !== LOCAL_DEV_REPLAY_MATCH),
    });
    const idMap = new InMemoryProviderIdMap();
    seedProviderIdMapFromCatalog(idMap, "local-dev", catalog);
    const player = catalog.players.find((row) => row.shortName === "AF1")!;
    const metrics = new LiveMetrics();
    const pipeline = new LiveScoringPipeline(
      store,
      idMap,
      new LiveScoreCache(new InMemoryRedis(), "test"),
      new LiveScoreHub(),
      metrics,
      new InMemoryAuditStore(),
      "local-dev",
    );
    const worker = createIngestWorker(null, pipeline, store, idMap, metrics, {
      pollIntervalMs: 1000,
      maxRetries: 1,
      backoffMs: 1,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      clock: () => new Date("2026-10-02T16:30:00.000Z"),
    });
    await worker.ingestNormalizedDrafts(
      [
        baseDraft({
          providerEventId: "goal-1",
          eventType: "GOAL",
          sequence: 1,
          matchMinute: 10,
          primaryExternalPlayerId: player.providerId,
        }),
        baseDraft({
          providerEventId: "goal-2",
          eventType: "GOAL",
          sequence: 2,
          matchMinute: 20,
          primaryExternalPlayerId: player.providerId,
        }),
        baseDraft({
          providerEventId: "var-1",
          eventType: "VAR_REVERSAL",
          sequence: 3,
          matchMinute: 25,
          primaryExternalPlayerId: player.providerId,
          correctionType: "VAR_REVERSAL",
          relatedProviderEventId: null,
        }),
      ],
      LOCAL_DEV_REPLAY_MATCH,
      ctx(),
    );
    const events = await store.listEvents(LOCAL_DEV_REPLAY_MATCH);
    const varRow = events.find((event) => event.providerEventId === "var-1");
    expect(varRow).toBeTruthy();
    expect(varRow?.supersedesEventId).toBeNull();
    const score = await pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(score.playerScores.find((row) => row.playerId === player.id)?.baseMilliPoints).toBe(10000);

    // Explicit related id targets the first goal.
    await worker.ingestNormalizedDrafts(
      [
        baseDraft({
          providerEventId: "var-2",
          eventType: "VAR_REVERSAL",
          sequence: 4,
          matchMinute: 30,
          primaryExternalPlayerId: player.providerId,
          correctionType: "VAR_REVERSAL",
          relatedProviderEventId: "goal-1",
        }),
      ],
      LOCAL_DEV_REPLAY_MATCH,
      ctx(),
    );
    const after = await store.listEvents(LOCAL_DEV_REPLAY_MATCH);
    const linked = after.find((event) => event.providerEventId === "var-2");
    const firstGoal = after.find((event) => event.providerEventId === "goal-1");
    expect(linked?.supersedesEventId).toBe(firstGoal?.eventId);
    const rescored = await pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(rescored.playerScores.find((row) => row.playerId === player.id)?.baseMilliPoints).toBe(5000);
  });

  it("approved snapshots are immutable and are not settlement", async () => {
    const store = new InMemorySnapshotStore();
    const version = {
      id: newId(),
      teamId: newId(),
      version: 1,
      matchId: LOCAL_DEV_REPLAY_MATCH,
      playerIds: Array.from({ length: 11 }, () => newId()),
      captainId: newId(),
      viceId: newId(),
      creditsUsed: 90,
      validationResult: { valid: true as const, errors: [] as [] },
      createdAt: "2026-10-02T14:00:00.000Z",
    };
    version.playerIds[0] = version.captainId;
    version.playerIds[1] = version.viceId;
    const draft = buildDraftSnapshot({
      matchId: LOCAL_DEV_REPLAY_MATCH,
      contestId: newId(),
      entryId: newId(),
      version,
      finalScoreMilliPoints: 10000,
      ranking: 1,
      playerScores: [
        {
          playerId: version.captainId,
          baseMilliPoints: 5000,
          milliPoints: 10000,
          role: "captain",
        },
      ],
      dataFinalizationState: "DATA_FINALIZING",
      nowIso: "2026-10-02T17:00:00.000Z",
    });
    await store.insertDraft(draft);
    const approved = await store.approve(draft.id, "2026-10-02T17:05:00.000Z");
    expect(approved.status).toBe("APPROVED");
    expect(approved.snapshot.teamVersionId).toBe(version.id);
    expect(approved.snapshot.rulesetName).toBe(DEV_V1_RULESET.name);
    await expect(store.approve(draft.id, "2026-10-02T17:06:00.000Z")).rejects.toThrow(/immutable|regenerated/i);
    expect(() => updateApprovedSnapshot()).toThrow(/immutable/);
  });
});
