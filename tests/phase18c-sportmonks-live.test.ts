import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../audit/memory.js";
import { loadConfig } from "../config/load.js";
import { DEV_V1_RULESET, DEV_V1_WEIGHTS } from "../domain/scoring/dev-v1.js";
import { LIVE_V1_RULESET, LIVE_V1_WEIGHTS, assertLiveV1Complete } from "../domain/scoring/live-v1.js";
import { calculatePlayerPoints } from "../domain/scoring/engine.js";
import { InMemoryFootballStore } from "../football/store.js";
import { LiveScoreCache } from "../live/cache.js";
import { LiveScoreHub } from "../live/hub.js";
import { createIngestWorker } from "../live/ingest.js";
import { LiveMetrics } from "../live/metrics.js";
import { LiveScoringPipeline } from "../live/pipeline.js";
import { InMemoryRedis } from "../redis/client.js";
import { normalizeAppMode, resolveAppMode, AppModeError } from "../sports/app-mode.js";
import { buildDemoSingleMatchCatalog, createDemoSingleMatchProvider } from "../sports/demo-provider.js";
import { InMemoryProviderIdMap, seedProviderIdMapFromCatalog } from "../sports/id-map.js";
import { bootstrapLiveFixture, assertExactlyOneMatch, deterministicUuid } from "../sports/live-bootstrap.js";
import {
  normalizeSportmonksEvent,
  normalizeSportmonksFixtureEvents,
  sortRawEventsByProviderOrder,
  sportmonksFixtureToRawEvents,
} from "../sports/normalize.js";
import { mapSportmonksPosition, UnsupportedPositionError } from "../sports/positions.js";
import {
  pollIntervalMsForStateId,
  pollClassForStateId,
  POLL_INTERVAL_MS,
} from "../sports/poll-schedule.js";
import {
  createSportmonksClient,
  SportmonksNotConfiguredError,
  SportmonksRequestError,
} from "../sports/sportmonks-provider.js";
import {
  extractShotOnTargetTotals,
  InMemoryPlayerStatObservationStore,
  shotOnTargetOrdinalHash,
  shotOnTargetProviderEventId,
  synthesizeShotOnTargetEvents,
  SHOT_ON_TARGET_STAT,
} from "../sports/shot-synthesis.js";
import type { RequestContext } from "../auth/types.js";
import { ConfigError } from "../shared/errors.js";

const ctx = (): RequestContext => ({
  now: new Date("2026-10-07T12:00:00.000Z"),
  correlationId: "phase18c",
});

const fixturePayload = JSON.parse(
  readFileSync(path.resolve("tests/fixtures/sportmonks-fixture-19146701.json"), "utf8"),
) as { fixture: Record<string, unknown> };

const baseEnv = {
  DATABASE_URL: "postgres://kickr:supersecretpassword@localhost:5432/kickr",
  REDIS_URL: "redis://:redis-secret-password@localhost:6379/0",
  AUTH_DOMAIN: "localhost",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
};

function setupLivePipeline(catalog = bootstrapLiveFixture(fixturePayload.fixture).catalog) {
  const store = new InMemoryFootballStore(catalog);
  const idMap = new InMemoryProviderIdMap();
  seedProviderIdMapFromCatalog(idMap, "sportmonks", catalog);
  const redis = new InMemoryRedis();
  const cache = new LiveScoreCache(redis, "test");
  const hub = new LiveScoreHub();
  const metrics = new LiveMetrics();
  const audit = new InMemoryAuditStore();
  const observations = new InMemoryPlayerStatObservationStore();
  const pipeline = new LiveScoringPipeline(
    store,
    idMap,
    cache,
    hub,
    metrics,
    audit,
    "sportmonks",
    null,
    LIVE_V1_RULESET,
  );
  return { store, idMap, redis, cache, hub, metrics, audit, observations, pipeline, catalog };
}

describe("Phase 18C LIVE_V1 ruleset", () => {
  it("keeps DEV_V1 historically unchanged including CORNER_WON +1", () => {
    expect(DEV_V1_RULESET.name).toBe("DEV_V1");
    expect(DEV_V1_WEIGHTS.CORNER_WON).toBe(1000);
    expect(DEV_V1_WEIGHTS.GOAL).toBe(5000);
  });

  it("LIVE_V1 removes CORNER_WON and keeps goal/assist/sot/yellow", () => {
    assertLiveV1Complete();
    expect(LIVE_V1_RULESET.name).toBe("LIVE_V1");
    expect(LIVE_V1_RULESET.version).toBe(2);
    expect(LIVE_V1_WEIGHTS.CORNER_WON).toBe(0);
    expect(LIVE_V1_WEIGHTS.GOAL).toBe(5000);
    expect(LIVE_V1_WEIGHTS.ASSIST).toBe(3000);
    expect(LIVE_V1_WEIGHTS.SHOT_ON_TARGET).toBe(1000);
    expect(LIVE_V1_WEIGHTS.YELLOW_CARD).toBe(-1000);
    expect(LIVE_V1_RULESET.captainMultiplier).toEqual({ numerator: 2, denominator: 1 });
    expect(LIVE_V1_RULESET.viceMultiplier).toEqual({ numerator: 3, denominator: 2 });
  });
});

describe("Phase 18C APP_MODE", () => {
  it("LIVE requires fixture id + api key and never falls back to DEMO", () => {
    expect(() => normalizeAppMode("LIVE")).not.toThrow();
    expect(() =>
      resolveAppMode({
        appMode: "LIVE",
        liveFixtureId: null,
        sportsProvider: "sportmonks",
        sportsApiKey: "x".repeat(60),
      }),
    ).toThrow(AppModeError);
    expect(() =>
      resolveAppMode({
        appMode: "LIVE",
        liveFixtureId: "19146701",
        sportsProvider: "demo",
        sportsApiKey: "x".repeat(60),
      }),
    ).toThrow(/refuses SPORTS_PROVIDER=demo/);
    const live = resolveAppMode({
      appMode: "LIVE",
      liveFixtureId: "19146701",
      sportsProvider: "sportmonks",
      sportsApiKey: "x".repeat(60),
    });
    expect(live.dataLabel).toBe("LIVE DATA");
    expect(live.effectiveSportsProvider).toBe("sportmonks");
  });

  it("DEMO refuses LIVE_FIXTURE_ID and sportmonks", () => {
    expect(() =>
      resolveAppMode({
        appMode: "DEMO",
        liveFixtureId: "19146701",
        sportsProvider: "demo",
        sportsApiKey: null,
      }),
    ).toThrow(/refuses LIVE_FIXTURE_ID/);
    expect(() =>
      resolveAppMode({
        appMode: "DEMO",
        liveFixtureId: null,
        sportsProvider: "sportmonks",
        sportsApiKey: "x".repeat(60),
      }),
    ).toThrow(/refuses SPORTS_PROVIDER=sportmonks/);
    const demo = resolveAppMode({
      appMode: "DEMO",
      liveFixtureId: null,
      sportsProvider: "demo",
      sportsApiKey: null,
    });
    expect(demo.dataLabel).toBe("DEMO DATA");
  });

  it("loadConfig APP_MODE=LIVE wires public liveData and LIVE_V1", () => {
    const config = loadConfig({
      ...baseEnv,
      APP_MODE: "LIVE",
      LIVE_FIXTURE_ID: "19146701",
      SPORTS_API_KEY: "k".repeat(60),
      SPORTS_PROVIDER: "sportmonks",
    });
    expect(config.public.appMode).toBe("LIVE");
    expect(config.public.liveData).toBe(true);
    expect(config.public.demoData).toBe(false);
    expect(config.public.liveFixtureId).toBe("19146701");
    expect(config.server.sportsData.scoringRuleset).toBe("LIVE_V1");
    expect(JSON.stringify(config.public)).not.toContain("k".repeat(10));
  });

  it("loadConfig APP_MODE=DEMO exposes DEMO and refuses silent live", () => {
    const config = loadConfig({
      ...baseEnv,
      APP_MODE: "DEMO",
      SPORTS_PROVIDER: "demo",
    });
    expect(config.public.appMode).toBe("DEMO");
    expect(config.public.demoData).toBe(true);
    expect(config.public.liveData).toBe(false);
    expect(() =>
      loadConfig({
        ...baseEnv,
        APP_MODE: "LIVE",
        LIVE_FIXTURE_ID: "19146701",
        SPORTS_PROVIDER: "demo",
        SPORTS_API_KEY: "k".repeat(60),
      }),
    ).toThrow(ConfigError);
  });
});

describe("Phase 18C bootstrap + positions", () => {
  it("bootstraps recorded fixture into exactly one match with real clubs/players", () => {
    const boot = bootstrapLiveFixture(fixturePayload.fixture, {
      nowIso: "2026-10-07T12:00:00.000Z",
    });
    assertExactlyOneMatch(boot.catalog, "LIVE bootstrap");
    expect(boot.fixtureId).toBe("19146701");
    expect(boot.clubCount).toBe(2);
    expect(boot.homeClubName).toBe("Celtic");
    expect(boot.awayClubName).toBe("Kilmarnock");
    expect(boot.playerCount).toBeGreaterThan(20);
    expect(boot.catalog.players.some((p) => p.displayName.includes("Schmeichel"))).toBe(true);
    expect(boot.catalog.players.every((p) => ["GK", "DEF", "MID", "FWD"].includes(p.position))).toBe(
      true,
    );
    expect(boot.catalog.matches[0]!.dataSource.label).toContain("LIVE DATA");
  });

  it("maps Sportmonks positions and fails visibly on unsupported", () => {
    expect(mapSportmonksPosition(24)).toBe("GK");
    expect(mapSportmonksPosition(25)).toBe("DEF");
    expect(mapSportmonksPosition(26)).toBe("MID");
    expect(mapSportmonksPosition(27)).toBe("FWD");
    expect(() => mapSportmonksPosition(99)).toThrow(UnsupportedPositionError);
  });

  it("DEMO single-match catalog exposes exactly one match", () => {
    const catalog = buildDemoSingleMatchCatalog();
    assertExactlyOneMatch(catalog, "DEMO");
    expect(createDemoSingleMatchProvider().catalog().matches).toHaveLength(1);
    expect(catalog.matches[0]!.dataSource.label).toMatch(/DEMO DATA|SIMULATED|Tutorial|fictional/i);
  });
});

describe("Phase 18C polling schedule", () => {
  it("uses 10s inplay, 30s HT/break, 60s prematch, null FINAL", () => {
    expect(pollClassForStateId(2)).toBe("INPLAY");
    expect(pollIntervalMsForStateId(2)).toBe(POLL_INTERVAL_MS.INPLAY);
    expect(pollIntervalMsForStateId(22)).toBe(10_000);
    expect(pollIntervalMsForStateId(3)).toBe(30_000);
    expect(pollIntervalMsForStateId(1)).toBe(60_000);
    expect(pollIntervalMsForStateId(5)).toBeNull();
  });
});

describe("Phase 18C event ordering + mappings", () => {
  it("processes events strictly by sort_order", () => {
    const fixture = fixturePayload.fixture;
    const raw = sportmonksFixtureToRawEvents({
      id: fixture.id as number,
      events: fixture.events as Array<Record<string, unknown>>,
      starting_at: fixture.starting_at as string,
    });
    const shuffled = [...raw].reverse();
    const ordered = sortRawEventsByProviderOrder(shuffled);
    const orders = ordered.map((r) => r.sortOrder ?? 0);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    const drafts = normalizeSportmonksFixtureEvents({
      id: fixture.id as number,
      events: fixture.events as Array<Record<string, unknown>>,
      starting_at: fixture.starting_at as string,
    });
    expect(drafts[0]!.eventType).toBe("GOAL");
    expect(drafts.some((d) => d.eventType === "YELLOW_CARD")).toBe(true);
    expect(drafts.some((d) => d.eventType === "SUBSTITUTION")).toBe(true);
    expect(drafts.some((d) => d.derivedAssist)).toBe(true);
  });

  it("dedupes identical provider events on second poll", async () => {
    const { pipeline, catalog } = setupLivePipeline();
    const matchId = catalog.matches[0]!.id;
    const drafts = normalizeSportmonksFixtureEvents({
      id: fixturePayload.fixture.id as number,
      events: (fixturePayload.fixture.events as Array<Record<string, unknown>>).slice(0, 2),
      starting_at: fixturePayload.fixture.starting_at as string,
    });
    const first = await pipeline.acceptNormalized(drafts[0]!, { matchId, ctx: ctx() });
    expect(first.status).toBe("accepted");
    const second = await pipeline.acceptNormalized(drafts[0]!, { matchId, ctx: ctx() });
    expect(second.status).toBe("duplicate");
  });
});

describe("Phase 18C shot-on-target synthesis", () => {
  it("emits deterministic SHA ordinals on increase and no-ops identical poll", () => {
    const fixtureId = "19146701";
    const playerId = "123659";
    const h1 = shotOnTargetOrdinalHash(fixtureId, playerId, 1);
    expect(h1).toBe(
      createHash("sha256")
        .update(`${fixtureId}${playerId}SHOT_ON_TARGET1`, "utf8")
        .digest("hex"),
    );
    const up = synthesizeShotOnTargetEvents({
      fixtureId,
      playerId,
      teamId: "53",
      observedTotal: 3,
      previousTotal: 1,
      kickoffAt: null,
      nowIso: "2026-10-07T12:00:00.000Z",
      sequenceBase: 0,
    });
    expect(up.drafts).toHaveLength(2);
    expect(up.drafts.map((d) => d.metadata.ordinal)).toEqual([2, 3]);
    expect(up.drafts[0]!.providerEventId).toBe(shotOnTargetProviderEventId(fixtureId, playerId, 2));
    const same = synthesizeShotOnTargetEvents({
      fixtureId,
      playerId,
      teamId: "53",
      observedTotal: 3,
      previousTotal: 3,
      kickoffAt: null,
      nowIso: "2026-10-07T12:00:00.000Z",
      sequenceBase: 0,
    });
    expect(same.drafts).toHaveLength(0);
  });

  it("correction 3→2 appends reversal for ordinal 3 without deleting history", () => {
    const result = synthesizeShotOnTargetEvents({
      fixtureId: "19146701",
      playerId: "99",
      teamId: "53",
      observedTotal: 2,
      previousTotal: 3,
      kickoffAt: null,
      nowIso: "2026-10-07T12:00:00.000Z",
      sequenceBase: 10,
    });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.correctionType).toBe("PROVIDER_CORRECTION");
    expect(result.drafts[0]!.relatedProviderEventId).toBe(
      shotOnTargetProviderEventId("19146701", "99", 3),
    );
    expect(result.drafts[0]!.metadata.ordinal).toBe(3);
  });

  it("extracts cumulative SOT from lineup details and persists via ingest path", async () => {
    const totals = extractShotOnTargetTotals(fixturePayload.fixture);
    expect(totals.some((t) => t.total >= 2)).toBe(true);
    const { pipeline, store, idMap, metrics, observations, catalog } = setupLivePipeline();
    const worker = createIngestWorker(null, pipeline, store, idMap, metrics, {
      pollIntervalMs: 15_000,
      maxRetries: 1,
      backoffMs: 10,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      clock: () => new Date("2026-10-07T12:00:00.000Z"),
      liveFixtureId: "19146701",
      observationStore: observations,
    });
    // Simulate two polls: 0→1 then 1→3 then identical 3 then 3→2
    const playerExt = totals[0]!.playerId;
    const teamId = totals[0]!.teamId;
    for (const [prev, next] of [
      [0, 1],
      [1, 3],
      [3, 3],
      [3, 2],
    ] as const) {
      await observations.upsertObservation({
        fixtureId: "19146701",
        playerId: playerExt,
        statType: SHOT_ON_TARGET_STAT,
        observedTotal: prev,
        updatedAt: "2026-10-07T12:00:00.000Z",
      });
      const synth = synthesizeShotOnTargetEvents({
        fixtureId: "19146701",
        playerId: playerExt,
        teamId,
        observedTotal: next,
        previousTotal: prev,
        kickoffAt: null,
        nowIso: "2026-10-07T12:00:00.000Z",
        sequenceBase: (await store.listEvents(catalog.matches[0]!.id)).length,
      });
      await worker.ingestNormalizedDrafts(synth.drafts, catalog.matches[0]!.id, ctx());
      await observations.upsertObservation({
        fixtureId: "19146701",
        playerId: playerExt,
        statType: SHOT_ON_TARGET_STAT,
        observedTotal: next,
        updatedAt: "2026-10-07T12:00:00.000Z",
      });
    }
    const events = await store.listEvents(catalog.matches[0]!.id);
    const sot = events.filter((e) => e.eventType === "SHOT_ON_TARGET");
    expect(sot.length).toBeGreaterThanOrEqual(3); // ordinals 1,2,3
    const corrections = events.filter((e) => e.correctionType === "PROVIDER_CORRECTION");
    expect(corrections.length).toBeGreaterThanOrEqual(1);
    const obs = await observations.getObservation("19146701", playerExt, SHOT_ON_TARGET_STAT);
    expect(obs?.observedTotal).toBe(2);
  });
});

describe("Phase 18C VAR goal disallowed", () => {
  it("invalidates goal + derived assist via supersede model", async () => {
    const { pipeline, store, catalog } = setupLivePipeline();
    const matchId = catalog.matches[0]!.id;
    const scorer = catalog.players.find((p) => p.position === "FWD")!;
    const assister = catalog.players.find((p) => p.position === "MID" && p.id !== scorer.id)!;
    const goalDraft = normalizeSportmonksEvent(
      {
        provider: "sportmonks",
        providerEventId: "goal-1",
        externalFixtureId: "19146701",
        typeCode: 14,
        sortOrder: 1,
        minute: 10,
        primaryExternalPlayerId: scorer.providerId,
        secondaryExternalPlayerId: assister.providerId,
        externalTeamId: catalog.clubs[0]!.providerId,
        raw: { id: "goal-1", type_id: 14 },
      },
      1,
      "v3",
      "2024-08-04T15:30:00.000Z",
    );
    const accepted = await pipeline.acceptNormalized(goalDraft, { matchId, ctx: ctx() });
    expect(accepted.status).toBe("accepted");
    const afterGoal = await store.listEvents(matchId);
    expect(afterGoal.some((e) => e.eventType === "GOAL")).toBe(true);
    expect(afterGoal.some((e) => e.eventType === "ASSIST")).toBe(true);

    const varDraft = normalizeSportmonksEvent(
      {
        provider: "sportmonks",
        providerEventId: "var-1",
        externalFixtureId: "19146701",
        typeCode: 10,
        subTypeCode: 1512,
        sortOrder: 2,
        minute: 12,
        primaryExternalPlayerId: scorer.providerId,
        externalTeamId: catalog.clubs[0]!.providerId,
        raw: { id: "var-1", type_id: 10, sub_type_id: 1512, related_event_id: "goal-1" },
      },
      2,
      "v3",
      "2024-08-04T15:30:00.000Z",
    );
    const idMap = new InMemoryProviderIdMap();
    seedProviderIdMapFromCatalog(idMap, "sportmonks", catalog);
    const metrics = new LiveMetrics();
    const ingest = createIngestWorker(null, pipeline, store, idMap, metrics, {
      pollIntervalMs: 1000,
      maxRetries: 1,
      backoffMs: 1,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      clock: () => new Date("2026-10-07T12:00:00.000Z"),
    });
    await ingest.ingestNormalizedDrafts([varDraft], matchId, ctx());
    const events = await store.listEvents(matchId);
    const goal = events.find((e) => e.providerEventId === "goal-1")!;
    const assist = events.find((e) => e.providerEventId === "goal-1:assist")!;
    expect(events.some((e) => e.supersedesEventId === goal.eventId)).toBe(true);
    expect(events.some((e) => e.supersedesEventId === assist.eventId)).toBe(true);
    const score = await pipeline.recomputeMatch(matchId, ctx());
    const scorerPts = score.playerScores.find((p) => p.playerId === scorer.id)?.baseMilliPoints ?? 0;
    expect(scorerPts).toBe(0);
  });
});

describe("Phase 18C provider failures", () => {
  it("missing API key fails closed", async () => {
    const client = createSportmonksClient({
      apiKey: null,
      apiUrl: "https://api.sportmonks.com/v3",
      requestTimeoutMs: 1000,
    });
    await expect(client.getConfiguredFixture(19146701)).rejects.toBeInstanceOf(
      SportmonksNotConfiguredError,
    );
  });

  it("API outage / wrong fixture does not corrupt events", async () => {
    const { pipeline, store, idMap, metrics, catalog, observations } = setupLivePipeline();
    const matchId = catalog.matches[0]!.id;
    const before = await store.listEvents(matchId);
    const fetchImpl = async () => {
      throw new SportmonksRequestError("Sportmonks HTTP 500", 500);
    };
    const client = createSportmonksClient({
      apiKey: "k".repeat(60),
      apiUrl: "https://api.sportmonks.com/v3",
      requestTimeoutMs: 500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const worker = createIngestWorker(client, pipeline, store, idMap, metrics, {
      pollIntervalMs: 1000,
      maxRetries: 1,
      backoffMs: 1,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      clock: () => new Date(),
      liveFixtureId: "19146701",
      observationStore: observations,
    });
    await worker.pollOnce();
    expect(metrics.snapshot().providerErrors).toBeGreaterThan(0);
    expect(await store.listEvents(matchId)).toEqual(before);
  });

  it("rate limit 429 is recorded without wiping state", async () => {
    const { pipeline, store, idMap, metrics, observations, catalog } = setupLivePipeline();
    const client = createSportmonksClient({
      apiKey: "k".repeat(60),
      apiUrl: "https://api.sportmonks.com/v3",
      requestTimeoutMs: 500,
      fetchImpl: (async () =>
        new Response("{}", { status: 429 })) as unknown as typeof fetch,
    });
    const worker = createIngestWorker(client, pipeline, store, idMap, metrics, {
      pollIntervalMs: 1000,
      maxRetries: 1,
      backoffMs: 1,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      clock: () => new Date(),
      liveFixtureId: "99999999",
      observationStore: observations,
    });
    await worker.pollOnce();
    expect(metrics.snapshot().providerErrors).toBeGreaterThan(0);
    expect(catalog.matches).toHaveLength(1);
  });
});

describe("Phase 18C Redis rebuild + LIVE_V1 scoring", () => {
  it("rebuilds identical scores from Postgres/event log after Redis loss", async () => {
    const { pipeline, store, catalog } = setupLivePipeline();
    const matchId = catalog.matches[0]!.id;
    const player = catalog.players.find((p) => p.position === "FWD")!;
    const draft = normalizeSportmonksEvent(
      {
        provider: "sportmonks",
        providerEventId: "g-rebuild",
        externalFixtureId: "19146701",
        typeCode: 14,
        minute: 5,
        sortOrder: 1,
        primaryExternalPlayerId: player.providerId,
        externalTeamId: catalog.clubs.find((c) => c.id === player.clubId)!.providerId,
        raw: { id: "g-rebuild" },
      },
      1,
    );
    await pipeline.acceptNormalized(draft, { matchId, ctx: ctx() });
    const first = await pipeline.recomputeMatch(matchId, ctx());
    const second = await pipeline.rebuildFromEvents(matchId, ctx());
    expect(second.playerScores).toEqual(first.playerScores);
    const pts = calculatePlayerPoints(
      (await store.listEvents(matchId)).map((e) => ({
        eventId: e.eventId,
        eventType: e.eventType,
        primaryPlayerId: e.primaryPlayerId,
        secondaryPlayerId: e.secondaryPlayerId,
        supersedesEventId: e.supersedesEventId,
        sequence: e.sequence,
      })),
      player.id,
      LIVE_V1_RULESET,
      {
        matchId,
        homeClubId: catalog.matches[0]!.homeClubId,
        awayClubId: catalog.matches[0]!.awayClubId,
      },
    );
    expect(pts).toBe(5000);
  });

  it("CORNER_WON does not score under LIVE_V1", async () => {
    const { pipeline, catalog } = setupLivePipeline();
    const matchId = catalog.matches[0]!.id;
    const player = catalog.players[0]!;
    const draft = normalizeSportmonksEvent(
      {
        provider: "sportmonks",
        providerEventId: "corner-1",
        externalFixtureId: "19146701",
        typeCode: 126,
        minute: 8,
        sortOrder: 1,
        primaryExternalPlayerId: player.providerId,
        externalTeamId: catalog.clubs[0]!.providerId,
        raw: { id: "corner-1", type_id: 126 },
      },
      1,
    );
    await pipeline.acceptNormalized(draft, { matchId, ctx: ctx() });
    const score = await pipeline.recomputeMatch(matchId, ctx());
    const pts = score.playerScores.find((p) => p.playerId === player.id)?.baseMilliPoints ?? 0;
    expect(pts).toBe(0);
  });
});

describe("Phase 18C DEVNET / Solana boundary unchanged", () => {
  it("loadConfig still refuses mainnet cluster", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        SOLANA_CLUSTER: "mainnet-beta",
      }),
    ).toThrow(/mainnet|cluster|Invalid configuration/i);
  });

  it("deterministic ids are stable", () => {
    expect(deterministicUuid("fixture", "19146701")).toBe(deterministicUuid("fixture", "19146701"));
    expect(deterministicUuid("player", "1")).not.toBe(deterministicUuid("club", "1"));
  });
});
