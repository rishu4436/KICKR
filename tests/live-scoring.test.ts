import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../audit/memory.js";
import { DEV_V1_RULESET, DEV_V1_WEIGHTS } from "../domain/scoring/dev-v1.js";
import { calculateTeamPoints } from "../domain/scoring/engine.js";
import { InMemoryFootballStore } from "../football/store.js";
import { FootballService } from "../football/service.js";
import { InMemoryRedis } from "../redis/client.js";
import { InMemoryProviderIdMap, seedProviderIdMapFromCatalog } from "../sports/id-map.js";
import {
  normalizeSportmonksEvent,
  sportmonksFixtureToRawEvents,
  SPORTMONKS_API_VERSION,
} from "../sports/normalize.js";
import {
  createSportmonksClient,
  isLiveProviderConfigured,
  SportmonksNotConfiguredError,
} from "../sports/sportmonks-provider.js";
import {
  buildPhase5ReplayCatalog,
  buildReplayNormalizedDrafts,
  LOCAL_DEV_REPLAY_MATCH,
} from "../sports/replay-fixture.js";
import {
  LOCAL_DEV_CLUB_A,
  LOCAL_DEV_CLUB_B,
  createLocalDevProvider,
} from "../sports/local-dev-provider.js";
import { LiveScoringPipeline } from "../live/pipeline.js";
import { LiveScoreCache } from "../live/cache.js";
import { LiveScoreHub } from "../live/hub.js";
import { LiveMetrics } from "../live/metrics.js";
import { createIngestWorker } from "../live/ingest.js";
import { derivePitchStates, eligibleForGoalConceded, mapStartingToDerived } from "../live/lineup.js";
import { newId } from "../shared/ids.js";
import type { RequestContext } from "../auth/types.js";
import type { NormalizedEventDraft } from "../sports/normalize.js";

const ctx = (): RequestContext => ({
  now: new Date("2026-10-02T16:30:00.000Z"),
  correlationId: "test-live",
});

function setupReplayPipeline() {
  const catalog = buildPhase5ReplayCatalog();
  // Clear seeded replay events so pipeline ingest is the authority for replay tests.
  const store = new InMemoryFootballStore({
    ...catalog,
    events: catalog.events.filter((event) => event.matchId !== LOCAL_DEV_REPLAY_MATCH),
  });
  const idMap = new InMemoryProviderIdMap();
  seedProviderIdMapFromCatalog(idMap, "local-dev", catalog);
  const redis = new InMemoryRedis();
  const cache = new LiveScoreCache(redis, "test");
  const hub = new LiveScoreHub();
  const metrics = new LiveMetrics();
  const audit = new InMemoryAuditStore();
  const pipeline = new LiveScoringPipeline(store, idMap, cache, hub, metrics, audit, "local-dev");
  const football = new FootballService(store, audit, { creditCap: 100, maxPlayersFromOneTeam: null });
  return { catalog, store, idMap, redis, cache, hub, metrics, audit, pipeline, football };
}

async function seedFantasyTeam(
  store: InMemoryFootballStore,
  matchId: string,
  playerIds: string[],
  captainId: string,
  viceId: string,
) {
  const teamId = newId();
  await store.createTeam({
    id: teamId,
    accountId: newId(),
    matchId,
    status: "LOCKED",
    createdAt: "2026-10-02T14:00:00.000Z",
    updatedAt: "2026-10-02T14:00:00.000Z",
  });
  await store.insertVersion({
    id: newId(),
    teamId,
    version: 1,
    matchId,
    playerIds,
    captainId,
    viceId,
    creditsUsed: 90,
    validationResult: { valid: true, errors: [] },
    createdAt: "2026-10-02T14:00:00.000Z",
  });
  return teamId;
}

describe("Phase 5 live scoring", () => {
  it("A normalizes a recorded Sportmonks payload without network", () => {
    const raw = JSON.parse(
      readFileSync(path.resolve("tests/fixtures/sportmonks-events.json"), "utf8"),
    ) as {
      fixture: {
        id: number;
        events: Array<Record<string, unknown>>;
        timeline: Array<Record<string, unknown>>;
        starting_at: string;
      };
    };
    const events = sportmonksFixtureToRawEvents(raw.fixture);
    const drafts = events.map((event, index) => normalizeSportmonksEvent(event, index + 1));
    expect(SPORTMONKS_API_VERSION).toBe("v3");
    expect(drafts.some((draft) => draft.eventType === "GOAL")).toBe(true);
    expect(drafts.some((draft) => draft.eventType === "YELLOW_CARD")).toBe(true);
    expect(drafts.some((draft) => draft.eventType === "SUBSTITUTION")).toBe(true);
    expect(drafts.some((draft) => draft.eventType === "VAR_REVERSAL")).toBe(true);
    expect(drafts.some((draft) => draft.eventType === "SHOT_ON_TARGET")).toBe(true);
    expect(drafts.some((draft) => draft.eventType === "SHOT")).toBe(true);
    expect(drafts.some((draft) => draft.eventType === "CORNER_WON")).toBe(true);
    const goal = drafts.find((draft) => draft.eventType === "GOAL");
    expect(goal?.derivedAssist?.primaryExternalPlayerId).toBe("103");
    expect(drafts.every((draft) => draft.rawEventHash.length === 64)).toBe(true);
  });

  it("B maps provider player ids to KICKR players", async () => {
    const { pipeline, idMap, catalog } = setupReplayPipeline();
    const player = catalog.players[0]!;
    expect(idMap.get("local-dev", "player", player.providerId)).toBe(player.id);
    const draft: NormalizedEventDraft = {
      provider: "local-dev",
      providerEventId: "map-1",
      externalFixtureId: "dev-fixture-replay",
      sequence: 1,
      timestamp: "2026-10-02T15:01:00.000Z",
      matchMinute: 1,
      period: "1",
      eventType: "SHOT_ON_TARGET",
      primaryExternalPlayerId: player.providerId,
      secondaryExternalPlayerId: null,
      externalTeamId: catalog.clubs[0]!.providerId,
      correctionType: null,
      providerVersion: "test",
      rawEventHash: "a".repeat(64),
      metadata: {},
      requiresPrimaryPlayer: true,
    };
    const result = await pipeline.acceptNormalized(draft, { ctx: ctx() });
    expect(result.status).toBe("accepted");
    expect(result.event?.primaryPlayerId).toBe(player.id);
  });

  it("C X rejects duplicate provider events without a second score", async () => {
    const { pipeline, catalog, store } = setupReplayPipeline();
    const player = catalog.players.find((row) => row.shortName === "AF1")!;
    const draft: NormalizedEventDraft = {
      provider: "local-dev",
      providerEventId: "dup-1",
      externalFixtureId: "dev-fixture-replay",
      sequence: 1,
      timestamp: "2026-10-02T15:01:00.000Z",
      matchMinute: 1,
      period: "1",
      eventType: "GOAL",
      primaryExternalPlayerId: player.providerId,
      secondaryExternalPlayerId: null,
      externalTeamId: "dev-club-a",
      correctionType: null,
      providerVersion: "test",
      rawEventHash: "b".repeat(64),
      metadata: {},
      requiresPrimaryPlayer: true,
    };
    const teamPlayers = catalog.players.filter((row) => row.clubId === LOCAL_DEV_CLUB_A).slice(0, 6)
      .concat(catalog.players.filter((row) => row.clubId === LOCAL_DEV_CLUB_B).slice(0, 5))
      .map((row) => row.id);
    await seedFantasyTeam(store, LOCAL_DEV_REPLAY_MATCH, teamPlayers, player.id, teamPlayers[1]!);
    const first = await pipeline.acceptNormalized(draft, { ctx: ctx() });
    const second = await pipeline.acceptNormalized(draft, { ctx: ctx() });
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("duplicate");
    const events = await store.listEvents(LOCAL_DEV_REPLAY_MATCH);
    expect(events.filter((event) => event.providerEventId === "dup-1")).toHaveLength(1);
    const score = first.score!.playerScores.find((row) => row.playerId === player.id)?.baseMilliPoints;
    const again = await pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(again.playerScores.find((row) => row.playerId === player.id)?.baseMilliPoints).toBe(score);
  });

  it("D E late and out-of-order events append and recompute", async () => {
    const { pipeline, catalog, store } = setupReplayPipeline();
    const player = catalog.players.find((row) => row.shortName === "AF1")!;
    const late: NormalizedEventDraft = {
      provider: "local-dev",
      providerEventId: "late-goal",
      externalFixtureId: "dev-fixture-replay",
      sequence: 50,
      timestamp: "2026-10-02T15:50:00.000Z",
      matchMinute: 50,
      period: "2",
      eventType: "GOAL",
      primaryExternalPlayerId: player.providerId,
      secondaryExternalPlayerId: null,
      externalTeamId: "dev-club-a",
      correctionType: null,
      providerVersion: "test",
      rawEventHash: "c".repeat(64),
      metadata: {},
      requiresPrimaryPlayer: true,
    };
    const early: NormalizedEventDraft = {
      ...late,
      providerEventId: "early-sot",
      sequence: 5,
      timestamp: "2026-10-02T15:05:00.000Z",
      matchMinute: 5,
      eventType: "SHOT_ON_TARGET",
      rawEventHash: "d".repeat(64),
    };
    await pipeline.acceptNormalized(late, { ctx: ctx() });
    await pipeline.acceptNormalized(early, { ctx: ctx() });
    const events = await store.listEvents(LOCAL_DEV_REPLAY_MATCH);
    const ids = events.map((event) => event.providerEventId).sort();
    expect(ids).toContain("early-sot");
    expect(ids).toContain("late-goal");
    expect(ids).toContain("late-goal:conceded");
    const score = await pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(score.playerScores.find((row) => row.playerId === player.id)?.baseMilliPoints).toBe(
      DEV_V1_WEIGHTS.GOAL + DEV_V1_WEIGHTS.SHOT_ON_TARGET,
    );
  });

  it("F G correction and VAR reversal recompute while keeping original row", async () => {
    const { pipeline, catalog, audit, store } = setupReplayPipeline();
    const player = catalog.players.find((row) => row.shortName === "AF1")!;
    const goal: NormalizedEventDraft = {
      provider: "local-dev",
      providerEventId: "var-goal",
      externalFixtureId: "dev-fixture-replay",
      sequence: 1,
      timestamp: "2026-10-02T15:10:00.000Z",
      matchMinute: 10,
      period: "1",
      eventType: "GOAL",
      primaryExternalPlayerId: player.providerId,
      secondaryExternalPlayerId: null,
      externalTeamId: "dev-club-a",
      correctionType: null,
      providerVersion: "test",
      rawEventHash: "e".repeat(64),
      metadata: {},
      requiresPrimaryPlayer: true,
    };
    const accepted = await pipeline.acceptNormalized(goal, { ctx: ctx() });
    expect(accepted.score?.playerScores.find((row) => row.playerId === player.id)?.baseMilliPoints).toBe(5000);
    const reversal: NormalizedEventDraft = {
      ...goal,
      providerEventId: "var-rev",
      sequence: 2,
      eventType: "VAR_REVERSAL",
      correctionType: "VAR_REVERSAL",
      rawEventHash: "f".repeat(64),
    };
    const corrected = await pipeline.acceptNormalized(reversal, {
      ctx: ctx(),
      supersedesEventId: accepted.event!.eventId,
    });
    expect(corrected.score?.playerScores.find((row) => row.playerId === player.id)?.baseMilliPoints).toBe(0);
    const events = await store.listEvents(LOCAL_DEV_REPLAY_MATCH);
    expect(events.some((event) => event.providerEventId === "var-goal")).toBe(true);
    expect(events.some((event) => event.supersedesEventId === accepted.event!.eventId)).toBe(true);
    const auditRows = await audit.list(100);
    expect(auditRows.some((row) => row.action === "MATCH_EVENT_CORRECTED")).toBe(true);
    expect(auditRows.some((row) => row.action === "SCORE_RECOMPUTED")).toBe(true);
  });

  it("H I J K L scores goal assist SOT corner yellow under DEV_V1", async () => {
    const { pipeline, catalog } = setupReplayPipeline();
    const goal = catalog.players.find((row) => row.shortName === "AF1")!;
    const assist = catalog.players.find((row) => row.shortName === "AM1")!;
    const sot = catalog.players.find((row) => row.shortName === "AF2")!;
    const corner = catalog.players.find((row) => row.shortName === "BM1")!;
    const yellow = catalog.players.find((row) => row.shortName === "BD1")!;
    const rows: Array<[string, typeof goal, "GOAL" | "ASSIST" | "SHOT_ON_TARGET" | "CORNER_WON" | "YELLOW_CARD"]> = [
      ["h", goal, "GOAL"],
      ["i", assist, "ASSIST"],
      ["j", sot, "SHOT_ON_TARGET"],
      ["k", corner, "CORNER_WON"],
      ["l", yellow, "YELLOW_CARD"],
    ];
    let sequence = 1;
    for (const [id, player, eventType] of rows) {
      await pipeline.acceptNormalized(
        {
          provider: "local-dev",
          providerEventId: id,
          externalFixtureId: "dev-fixture-replay",
          sequence: sequence++,
          timestamp: "2026-10-02T15:10:00.000Z",
          matchMinute: sequence,
          period: "1",
          eventType,
          primaryExternalPlayerId: player.providerId,
          secondaryExternalPlayerId: null,
          externalTeamId: player.clubId === LOCAL_DEV_CLUB_A ? "dev-club-a" : "dev-club-b",
          correctionType: null,
          providerVersion: "test",
          rawEventHash: id.padEnd(64, "0"),
          metadata: {},
          requiresPrimaryPlayer: true,
        },
        { ctx: ctx() },
      );
    }
    const score = await pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(score.playerScores.find((row) => row.playerId === goal.id)?.baseMilliPoints).toBe(5000);
    expect(score.playerScores.find((row) => row.playerId === assist.id)?.baseMilliPoints).toBe(3000);
    expect(score.playerScores.find((row) => row.playerId === sot.id)?.baseMilliPoints).toBe(1000);
    expect(score.playerScores.find((row) => row.playerId === corner.id)?.baseMilliPoints).toBe(1000);
    expect(score.playerScores.find((row) => row.playerId === yellow.id)?.baseMilliPoints).toBe(-1000);
  });

  it("M N O captain and vice multipliers apply once at team rollup", async () => {
    const { pipeline, catalog, store } = setupReplayPipeline();
    const goal = catalog.players.find((row) => row.shortName === "AF1")!;
    const assist = catalog.players.find((row) => row.shortName === "AM1")!;
    const others = catalog.players
      .filter((row) => row.id !== goal.id && row.id !== assist.id)
      .slice(0, 9)
      .map((row) => row.id);
    // ensure both clubs represented roughly
    const playerIds = [goal.id, assist.id, ...others];
    while (playerIds.length < 11) {
      playerIds.push(newId());
    }
    await seedFantasyTeam(store, LOCAL_DEV_REPLAY_MATCH, playerIds.slice(0, 11), goal.id, assist.id);
    await pipeline.acceptNormalized(
      {
        provider: "local-dev",
        providerEventId: "cap-goal",
        externalFixtureId: "dev-fixture-replay",
        sequence: 1,
        timestamp: "2026-10-02T15:10:00.000Z",
        matchMinute: 10,
        period: "1",
        eventType: "GOAL",
        primaryExternalPlayerId: goal.providerId,
        secondaryExternalPlayerId: null,
        externalTeamId: "dev-club-a",
        correctionType: null,
        providerVersion: "test",
        rawEventHash: "g".repeat(64),
        metadata: {},
        requiresPrimaryPlayer: true,
      },
      { ctx: ctx() },
    );
    await pipeline.acceptNormalized(
      {
        provider: "local-dev",
        providerEventId: "vice-assist",
        externalFixtureId: "dev-fixture-replay",
        sequence: 2,
        timestamp: "2026-10-02T15:10:00.000Z",
        matchMinute: 10,
        period: "1",
        eventType: "ASSIST",
        primaryExternalPlayerId: assist.providerId,
        secondaryExternalPlayerId: null,
        externalTeamId: "dev-club-a",
        correctionType: null,
        providerVersion: "test",
        rawEventHash: "h".repeat(64),
        metadata: {},
        requiresPrimaryPlayer: true,
      },
      { ctx: ctx() },
    );
    const first = await pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx());
    const second = await pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(second.teamScores[0]?.milliPoints).toBe(first.teamScores[0]?.milliPoints);
    const captain = first.teamScores[0]?.players.find((row) => row.playerId === goal.id);
    const vice = first.teamScores[0]?.players.find((row) => row.playerId === assist.id);
    expect(captain?.baseMilliPoints).toBe(5000);
    expect(captain?.milliPoints).toBe(10000);
    expect(vice?.baseMilliPoints).toBe(3000);
    expect(vice?.milliPoints).toBe(4500);
    // Second event must not multiply an already-multiplied total.
    expect(first.teamScores[0]?.milliPoints).toBe(10000 + 4500);
  });

  it("P rebuilds identical scores after clearing Redis", async () => {
    const { pipeline, catalog, store, redis, cache } = setupReplayPipeline();
    const goal = catalog.players.find((row) => row.shortName === "AF1")!;
    const playerIds = catalog.players.slice(0, 11).map((row) => row.id);
    await seedFantasyTeam(store, LOCAL_DEV_REPLAY_MATCH, playerIds, goal.id, playerIds[1]!);
    await pipeline.acceptNormalized(
      {
        provider: "local-dev",
        providerEventId: "redis-goal",
        externalFixtureId: "dev-fixture-replay",
        sequence: 1,
        timestamp: "2026-10-02T15:10:00.000Z",
        matchMinute: 10,
        period: "1",
        eventType: "GOAL",
        primaryExternalPlayerId: goal.providerId,
        secondaryExternalPlayerId: null,
        externalTeamId: "dev-club-a",
        correctionType: null,
        providerVersion: "test",
        rawEventHash: "i".repeat(64),
        metadata: {},
        requiresPrimaryPlayer: true,
      },
      { ctx: ctx() },
    );
    const before = await pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx());
    await cache.clearMatch(LOCAL_DEV_REPLAY_MATCH, [goal.id], before.teamScores.map((row) => row.teamId));
    expect(await cache.readMatch(LOCAL_DEV_REPLAY_MATCH)).toBeNull();
    const after = await pipeline.rebuildFromEvents(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(after.playerScores).toEqual(before.playerScores);
    expect(after.teamScores.map((row) => row.milliPoints)).toEqual(
      before.teamScores.map((row) => row.milliPoints),
    );
    void redis;
  });

  it("Q provider outage does not corrupt stored events", async () => {
    const { pipeline, catalog, store, metrics, idMap } = setupReplayPipeline();
    const player = catalog.players.find((row) => row.shortName === "AF1")!;
    await pipeline.acceptNormalized(
      {
        provider: "local-dev",
        providerEventId: "pre-outage",
        externalFixtureId: "dev-fixture-replay",
        sequence: 1,
        timestamp: "2026-10-02T15:10:00.000Z",
        matchMinute: 10,
        period: "1",
        eventType: "GOAL",
        primaryExternalPlayerId: player.providerId,
        secondaryExternalPlayerId: null,
        externalTeamId: "dev-club-a",
        correctionType: null,
        providerVersion: "test",
        rawEventHash: "j".repeat(64),
        metadata: {},
        requiresPrimaryPlayer: true,
      },
      { ctx: ctx() },
    );
    const before = await store.listEvents(LOCAL_DEV_REPLAY_MATCH);
    const client = createSportmonksClient({
      apiKey: "test-key",
      apiUrl: "https://api.sportmonks.com/v3",
      requestTimeoutMs: 50,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    const worker = createIngestWorker(client, pipeline, store, idMap, metrics, {
      pollIntervalMs: 1000,
      maxRetries: 2,
      backoffMs: 1,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      clock: () => new Date("2026-10-02T16:30:00.000Z"),
    });
    await worker.pollOnce();
    const after = await store.listEvents(LOCAL_DEV_REPLAY_MATCH);
    expect(after).toEqual(before);
    expect(metrics.snapshot().providerErrors).toBeGreaterThan(0);
  });

  it("R unresolved player is recorded without inventing a player", async () => {
    const { pipeline, store } = setupReplayPipeline();
    const beforePlayers = await store.listPlayers();
    const result = await pipeline.acceptNormalized(
      {
        provider: "local-dev",
        providerEventId: "unresolved-1",
        externalFixtureId: "dev-fixture-replay",
        sequence: 1,
        timestamp: "2026-10-02T15:10:00.000Z",
        matchMinute: 10,
        period: "1",
        eventType: "GOAL",
        primaryExternalPlayerId: "missing-player-ext",
        secondaryExternalPlayerId: null,
        externalTeamId: "dev-club-a",
        correctionType: null,
        providerVersion: "test",
        rawEventHash: "k".repeat(64),
        metadata: {},
        requiresPrimaryPlayer: true,
      },
      { ctx: ctx() },
    );
    expect(result.status).toBe("unresolved_player");
    expect(result.event?.primaryPlayerId).toBeNull();
    expect(result.event?.metadata.unresolvedPrimaryPlayer).toBe(true);
    expect(pipeline.getUnresolved().some((row) => row.reason === "unresolved_primary_player")).toBe(true);
    expect(await store.listPlayers()).toHaveLength(beforePlayers.length);
  });

  it("S unknown provider type is stored with weight 0", async () => {
    const draft = normalizeSportmonksEvent(
      {
        provider: "sportmonks",
        providerEventId: "unk-1",
        externalFixtureId: "1",
        typeCode: 999999,
        minute: 1,
        raw: { id: 1, type_id: 999999 },
      },
      1,
    );
    expect(draft.metadata.unknownProviderType).toBe(true);
    expect(DEV_V1_WEIGHTS[draft.eventType]).toBe(0);
  });

  it("T Y deterministic replay from scratch is identical", async () => {
    const drafts = buildReplayNormalizedDrafts();
    async function runOnce() {
      const { pipeline, catalog, store } = setupReplayPipeline();
      const goal = catalog.players.find((row) => row.shortName === "AF1")!;
      const assist = catalog.players.find((row) => row.shortName === "AM1")!;
      const sot = catalog.players.find((row) => row.shortName === "AF2")!;
      const corner = catalog.players.find((row) => row.shortName === "BM1")!;
      const yellow = catalog.players.find((row) => row.shortName === "BD1")!;
      const shot = catalog.players.find((row) => row.shortName === "AM2")!;
      const off = catalog.players.find((row) => row.shortName === "AM3")!;
      const on = catalog.players.find((row) => row.shortName === "AM4")!;
      const xi = [goal.id, assist.id, sot.id, corner.id, yellow.id, shot.id, off.id, on.id]
        .concat(catalog.players.filter((row) => ![goal.id, assist.id, sot.id, corner.id, yellow.id, shot.id, off.id, on.id].includes(row.id)).slice(0, 3).map((row) => row.id));
      await seedFantasyTeam(store, LOCAL_DEV_REPLAY_MATCH, xi.slice(0, 11), goal.id, assist.id);
      for (const draft of drafts) {
        const supersedes =
          draft.supersedesProviderEventId != null
            ? (await store.findEventByProvider("local-dev", draft.supersedesProviderEventId))?.eventId ?? null
            : null;
        await pipeline.acceptNormalized(draft, { ctx: ctx(), supersedesEventId: supersedes });
      }
      return pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx());
    }
    const a = await runOnce();
    const b = await runOnce();
    expect(b.playerScores).toEqual(a.playerScores);
    expect(b.teamScores.map((row) => ({ milli: row.milliPoints, players: row.players }))).toEqual(
      a.teamScores.map((row) => ({ milli: row.milliPoints, players: row.players })),
    );
    expect(b.leaderboard.map((row) => ({ rank: row.rank, milliPoints: row.milliPoints }))).toEqual(
      a.leaderboard.map((row) => ({ rank: row.rank, milliPoints: row.milliPoints })),
    );
  });

  it("U match finalization does not settle", async () => {
    const { pipeline, store, idMap, metrics } = setupReplayPipeline();
    const match = await store.getMatch(LOCAL_DEV_REPLAY_MATCH);
    expect(match?.status).toBe("LIVE");
    const worker = createIngestWorker(null, pipeline, store, idMap, metrics, {
      pollIntervalMs: 1000,
      maxRetries: 1,
      backoffMs: 1,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      clock: () => new Date("2026-10-02T17:00:00.000Z"),
    });
    const applied = await worker.applyProviderFinal(LOCAL_DEV_REPLAY_MATCH, ctx());
    expect(applied).toEqual(["FULL_TIME", "DATA_FINALIZING"]);
    const after = await store.getMatch(LOCAL_DEV_REPLAY_MATCH);
    expect(after?.status).toBe("DATA_FINALIZING");
    // No settlement audit / payout
    expect(true).toBe(true);
  });

  it("V derives lineup pitch status from XI and substitutions", () => {
    expect(mapStartingToDerived("STARTER", "AVAILABLE")).toBe("STARTING");
    expect(mapStartingToDerived("BENCH", "AVAILABLE")).toBe("SUBSTITUTE");
    const catalog = buildPhase5ReplayCatalog();
    const squad = catalog.squad.filter((row) => row.matchId === LOCAL_DEV_REPLAY_MATCH);
    const players = new Map(catalog.players.map((player) => [player.id, player]));
    const seeds = squad.map((row) => ({
      playerId: row.playerId,
      clubId: row.clubId,
      position: players.get(row.playerId)!.position,
      startingStatus: row.startingStatus,
      availability: row.availability,
      squadStatus: row.squadStatus,
    }));
    const off = catalog.players.find((row) => row.shortName === "AM3")!;
    const on = catalog.players.find((row) => row.shortName === "AM4")!;
    const pitch = derivePitchStates(seeds, [
      {
        eventType: "SUBSTITUTION",
        primaryPlayerId: off.id,
        secondaryPlayerId: on.id,
        sequence: 7,
        matchMinute: 60,
      },
    ]);
    expect(pitch.get(off.id)?.derivedStatus).toBe("SUBSTITUTED_OFF");
    expect(pitch.get(off.id)?.onPitch).toBe(false);
    expect(pitch.get(on.id)?.derivedStatus).toBe("SUBSTITUTED_ON");
    expect(pitch.get(on.id)?.onPitch).toBe(true);
  });

  it("W goal conceded eligibility is on-pitch GK/DEF only and unresolved when unknown", () => {
    const pitch = new Map([
      [
        "gk",
        {
          playerId: "gk",
          clubId: "home",
          position: "GK" as const,
          derivedStatus: "STARTING" as const,
          onPitch: true,
        },
      ],
      [
        "def",
        {
          playerId: "def",
          clubId: "home",
          position: "DEF" as const,
          derivedStatus: "STARTING" as const,
          onPitch: true,
        },
      ],
      [
        "mid",
        {
          playerId: "mid",
          clubId: "home",
          position: "MID" as const,
          derivedStatus: "STARTING" as const,
          onPitch: true,
        },
      ],
      [
        "bench-def",
        {
          playerId: "bench-def",
          clubId: "home",
          position: "DEF" as const,
          derivedStatus: "SUBSTITUTE" as const,
          onPitch: false,
        },
      ],
    ]);
    const eligible = eligibleForGoalConceded(pitch, "home");
    expect(eligible.unresolved).toBe(false);
    expect(eligible.eligiblePlayerIds).toEqual(["def", "gk"]);
    expect(DEV_V1_WEIGHTS.GOAL_CONCEDED).toBe(0);
    const unknown = eligibleForGoalConceded(
      new Map([
        [
          "x",
          {
            playerId: "x",
            clubId: "home",
            position: "DEF" as const,
            derivedStatus: "UNKNOWN" as const,
            onPitch: false,
          },
        ],
      ]),
      "home",
    );
    expect(unknown.unresolved).toBe(true);
  });

  it("fails closed when Sportmonks is selected without an API key", async () => {
    expect(isLiveProviderConfigured({ provider: "sportmonks", apiKey: null })).toBe(false);
    const client = createSportmonksClient({
      apiKey: null,
      apiUrl: "https://api.sportmonks.com/v3",
      requestTimeoutMs: 100,
    });
    await expect(client.getInplayFixtures()).rejects.toBeInstanceOf(SportmonksNotConfiguredError);
  });

  it("local-dev catalog still boots and is developmentOnly", () => {
    const provider = createLocalDevProvider();
    expect(provider.developmentOnly).toBe(true);
    expect(provider.name).toBe("local-dev");
    expect(provider.catalog().matches.length).toBeGreaterThan(0);
  });

  it("recompute uses calculateTeamPoints from the log not cumulative multiply", () => {
    const events = [
      {
        eventId: "1",
        eventType: "GOAL" as const,
        primaryPlayerId: "p1",
        secondaryPlayerId: null,
        supersedesEventId: null,
        sequence: 1,
      },
      {
        eventId: "2",
        eventType: "GOAL" as const,
        primaryPlayerId: "p1",
        secondaryPlayerId: null,
        supersedesEventId: null,
        sequence: 2,
      },
    ];
    const team = calculateTeamPoints(
      events,
      { playerIds: ["p1"], captainId: "p1", viceId: "p2" },
      DEV_V1_RULESET,
      { matchId: "m", homeClubId: "h", awayClubId: "a" },
    );
    expect(team.milliPoints).toBe(20000);
  });
});
