import { serve } from "@hono/node-server";
import { AuthService } from "../auth/service.js";
import { loadConfig } from "../config/load.js";
import { createPgAuditStore, createPgAccountRepository, createPgGrantRepository, createPgNonceRepository, createPgSessionRepository } from "../db/repositories.js";
import { asQueryable, createPool } from "../db/pool.js";
import { createPgFootballStore } from "../db/football-repository.js";
import { createPgContestStore } from "../db/contest-repository.js";
import { FootballService } from "../football/service.js";
import { ContestDiscoveryCache } from "../contests/discovery.js";
import { ContestService } from "../contests/service.js";
import { createPgFreeResultStore } from "../contests/free/pg-store.js";
import { resolveSportsRuntime } from "../sports/factory.js";
import { LIVE_V1_RULESET } from "../domain/scoring/live-v1.js";
import { DEV_V1_RULESET } from "../domain/scoring/dev-v1.js";
import { bootstrapLiveFixture, assertExactlyOneMatch } from "../sports/live-bootstrap.js";
import { FREE_TEMPLATES } from "../contests/free/catalog.js";
import { buildDemoSingleMatchCatalog } from "../sports/demo-provider.js";
import { createPgPlayerStatObservationStore } from "../db/player-stat-observations.js";

import { InMemoryProviderIdMap, loadProviderIdMap, seedProviderIdMapFromCatalog } from "../sports/id-map.js";
import { createPgProviderIdMapRepository } from "../db/provider-id-map.js";
import { createCombinedScoringSource } from "../live/combined-scoring-source.js";
import { LiveScoringService } from "../live/service.js";
import { createIngestWorker } from "../live/ingest.js";
import path from "node:path";
import { createIoredisClient } from "../redis/ioredis-client.js";
import { createLogger } from "../shared/logger.js";
import { InMemoryRateLimiter } from "../shared/rate-limit.js";
import { ReliabilityCounters } from "../shared/reliability.js";
import { systemClock } from "../shared/clock.js";
import { ConfigError } from "../shared/errors.js";
import { createApp } from "./server.js";
import { createPgIdempotencyStore } from "../db/idempotency-repository.js";
import { createPgSettlementStore } from "../db/settlement-repository.js";
import { SettlementService } from "../settlement/service.js";
import { SettlementOrchestrator } from "../settlement/orchestrator.js";
import { InMemorySnapshotStore } from "../live/snapshot.js";
import { createPgAttestationStore } from "../db/attestation-repository.js";
import { createAttestorRegistry, parseApprovedAttestors } from "../attestation/registry.js";
import { createAttestorVerifier } from "../attestation/verify.js";
import { createSettlementAttestationGate } from "../attestation/gate.js";
import { LocalDevScoringActorRegistry } from "../contests/free/local-dev-scoring-actor.js";
import { LeagueService, createPgLeagueStore } from "../leagues/index.js";
import { ProfileService, OnboardingService } from "../profile/index.js";

/**
 * API process entrypoint.
 * Phase 8 wires rate limits, idempotency, counters, and dependency probes.
 * Phase 5 starts the live ingest worker only when LIVE_PROVIDER_CONFIGURED.
 * Settlement, review, and payout workers remain contracts-only.
 */

async function ensureFreeContestsForMatch(
  contests: ContestService,
  matchId: string,
  label: string,
): Promise<void> {
  const ctx = { now: systemClock(), correlationId: `free-ensure-${label}-${matchId}` };
  for (const template of FREE_TEMPLATES) {
    const contest = await contests.ensureOpenContest(matchId, template.id, ctx);
    if (contest.contestKind !== "FREE" || contest.entryFeeBaseUnits !== 0) {
      throw new Error(`Refused non-FREE contest while ensuring ${label} free contests`);
    }
  }
}

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (error) {
  const message = error instanceof ConfigError ? error.message : "Invalid configuration";
  console.error(message);
  process.exit(1);
}

const logger = createLogger({ level: config.server.logLevel });
const pool = createPool(config.secrets.databaseUrl);
const db = asQueryable(pool);
const redis = createIoredisClient(config.secrets.redisUrl);
const auth = new AuthService(
  createPgAccountRepository(db),
  createPgNonceRepository(db),
  createPgSessionRepository(db),
  createPgAuditStore(db),
  config.server.auth,
);

const footballStore = createPgFootballStore(db);
const sportsRuntime = resolveSportsRuntime({
  sportsProvider: config.server.sportsData.liveProvider,
  dataProvider: config.server.sportsData.provider,
  apiKey: config.secrets.sportsApiKey,
  apiUrl: config.secrets.sportsApiUrl,
  pollIntervalMs: config.server.sportsData.pollIntervalSeconds * 1000,
  requestTimeoutMs: config.server.sportsData.requestTimeoutMs,
  logger,
  appMode: config.server.sportsData.appMode,
  liveFixtureId: config.server.sportsData.liveFixtureId,
});
const activeRuleset =
  config.server.sportsData.scoringRuleset === "LIVE_V1" ? LIVE_V1_RULESET : DEV_V1_RULESET;
const sports = sportsRuntime.catalogProvider;
// Seed fictional catalog for LOCAL_DEV (dev) and DEMO (production-demo safe).
if (sports && (sports.developmentOnly || sports.name === "demo")) {
  const catalog = sports.catalog();
  if (config.server.sportsData.appMode === "DEMO") {
    assertExactlyOneMatch(catalog, "APP_MODE=DEMO");
  }
  await footballStore.upsertCatalog(catalog);
}
const football = new FootballService(footballStore, createPgAuditStore(db), config.server.fantasy);
const contestStore = createPgContestStore(pool);
const freeResults = createPgFreeResultStore(pool);
const leagueStore = createPgLeagueStore(pool);
const contests = new ContestService(
  contestStore,
  football,
  createPgAuditStore(db),
  new ContestDiscoveryCache(redis, config.public.environment),
  config.server.contests,
  {
    programId: config.server.solana.escrowProgramId,
    usdcMint: config.server.solana.usdcMint,
    usdcDecimals: config.server.solana.usdcDecimals,
    cluster: config.server.solana.cluster,
  },
  config.server.nodeEnv !== "production",
  freeResults,
);
const idMap = new InMemoryProviderIdMap();
// Authoritative production mappings from Postgres. Never invents domain rows.
const providerIdMapRepo = createPgProviderIdMapRepository(db);
loadProviderIdMap(idMap, await providerIdMapRepo.listAll());
if (sports && (sports.developmentOnly || sports.name === "demo")) {
  seedProviderIdMapFromCatalog(idMap, sports.name, sports.catalog());
}

// Phase 18C LIVE bootstrap: fetch configured fixture once, persist clubs/players/squad.
if (
  (config.server.sportsData.appMode === "LIVE" || config.server.sportsData.appMode === "DUAL") &&
  sportsRuntime.liveConfigured &&
  sportsRuntime.liveAdapter?.client &&
  config.server.sportsData.liveFixtureId
) {
  const fixtureId = config.server.sportsData.liveFixtureId;
  try {
    const payload = await sportsRuntime.liveAdapter.client.getConfiguredFixture(fixtureId);
    const data =
      payload && typeof payload === "object" && "data" in payload
        ? (payload as { data: Record<string, unknown> }).data
        : null;
    if (!data || typeof data !== "object") {
      throw new Error(`LIVE_FIXTURE_ID ${fixtureId} returned no fixture data`);
    }
    const boot = bootstrapLiveFixture(data, { nowIso: systemClock().toISOString() });
    assertExactlyOneMatch(boot.catalog, config.server.sportsData.appMode === "DUAL" ? "APP_MODE=DUAL LIVE" : "APP_MODE=LIVE");
    if (boot.unsupportedPositions.length > 0) {
      logger.warn(
        {
          count: boot.unsupportedPositions.length,
          sample: boot.unsupportedPositions.slice(0, 5),
        },
        "LIVE bootstrap skipped players with unsupported position mappings",
      );
    }
    await footballStore.upsertCatalog(boot.catalog);
    seedProviderIdMapFromCatalog(idMap, "sportmonks", boot.catalog);
    for (const mapping of [
      ...boot.catalog.clubs.map((c) => ({
        provider: "sportmonks" as const,
        entityKind: "club" as const,
        externalId: c.providerId,
        kickrId: c.id,
      })),
      ...boot.catalog.players.map((p) => ({
        provider: "sportmonks" as const,
        entityKind: "player" as const,
        externalId: p.providerId,
        kickrId: p.id,
      })),
      ...boot.catalog.matches.map((m) => ({
        provider: "sportmonks" as const,
        entityKind: "fixture" as const,
        externalId: m.externalFixtureId,
        kickrId: m.id,
      })),
    ]) {
      await providerIdMapRepo.upsertMapping(mapping);
    }
    logger.info(
      {
        fixtureId: boot.fixtureId,
        matchId: boot.matchId,
        home: boot.homeClubName,
        away: boot.awayClubName,
        players: boot.playerCount,
        clubs: boot.clubCount,
        ruleset: activeRuleset.name,
      },
      "LIVE Sportmonks fixture bootstrapped",
    );
  } catch (error) {
    logger.error(
      {
        fixtureId,
        message: error instanceof Error ? error.message : "bootstrap failed",
      },
      "LIVE fixture bootstrap failed — refusing silent DEMO fallback",
    );
    throw error;
  }
}


// Phase 18D: ensure FREE contests for seeded DEMO + LIVE matches (public LIVE stays FREE).
if (config.server.sportsData.appMode === "DUAL" || config.server.sportsData.appMode === "DEMO") {
  const demoCatalog = buildDemoSingleMatchCatalog();
  // Re-upsert guarantees exactly one DEMO fixture even if factory catalog path differed.
  if (config.server.sportsData.appMode === "DUAL") {
    assertExactlyOneMatch(demoCatalog, "APP_MODE=DUAL DEMO");
    await footballStore.upsertCatalog(demoCatalog);
    seedProviderIdMapFromCatalog(idMap, "demo", demoCatalog);
  }
  for (const match of demoCatalog.matches) {
    await ensureFreeContestsForMatch(contests, match.id, "DEMO");
  }
}
if (
  (config.server.sportsData.appMode === "LIVE" || config.server.sportsData.appMode === "DUAL") &&
  config.server.sportsData.liveFixtureId
) {
  const liveMatches = (await footballStore.listMatches()).filter(
    (m) => m.dataSource.provider === "sportmonks" && m.externalFixtureId === config.server.sportsData.liveFixtureId,
  );
  for (const match of liveMatches) {
    await ensureFreeContestsForMatch(contests, match.id, "LIVE");
  }
}

const live = new LiveScoringService(
  footballStore,
  football,
  idMap,
  redis,
  config.public.environment,
  createPgAuditStore(db),
  sportsRuntime.liveConfigured
    ? (sportsRuntime.liveProviderName ?? "sportmonks")
    : sports?.name ?? "none",
  createCombinedScoringSource(contestStore, leagueStore),
  activeRuleset,
);
live.metrics.setProvider(
  sportsRuntime.liveProviderName,
  sportsRuntime.liveConfigured,
);
const observationStore = createPgPlayerStatObservationStore(db);
const ingest = createIngestWorker(
  sportsRuntime.liveAdapter?.client ?? null,
  live.pipeline,
  footballStore,
  idMap,
  live.metrics,
  {
    pollIntervalMs: sportsRuntime.pollIntervalMs,
    maxRetries: 3,
    backoffMs: 500,
    logger,
    clock: () => systemClock(),
    liveFixtureId: sportsRuntime.liveFixtureId,
    observationStore,
  },
);
if (sportsRuntime.liveConfigured) {
  ingest.start();
} else if (sportsRuntime.liveProviderName === "sportmonks") {
  logger.warn(
    { LIVE_PROVIDER_CONFIGURED: false, missing: "SPORTS_API_KEY" },
    "sportmonks selected but unconfigured; live ingest will not start",
  );
}

const snapshots = new InMemorySnapshotStore();
const attestations = createPgAttestationStore(db);
const attestorRegistry = createAttestorRegistry(
  parseApprovedAttestors(config.server.attestation.approvedAttestorsRaw, config.server.nodeEnv),
);
const attestorVerifier = createAttestorVerifier(attestorRegistry, config.server.nodeEnv);
const auditStore = createPgAuditStore(db);
const scoringActors = new LocalDevScoringActorRegistry(
  {
    nodeEnv: config.server.nodeEnv,
    sportsDataProvider: config.public.sportsDataProvider,
  },
  auditStore,
);
const attestationGate = createSettlementAttestationGate({
  store: attestations,
  snapshots,
  verifier: attestorVerifier,
  registry: attestorRegistry,
  audit: auditStore,
  nodeEnv: config.server.nodeEnv,
});
const settlement = new SettlementService(createPgSettlementStore(db), attestationGate);
const settlementOrchestrator = new SettlementOrchestrator(settlement, contestStore, snapshots);
const leagues = new LeagueService(leagueStore, football, auditStore, live);
const accountRepo = createPgAccountRepository(db);
const profiles = new ProfileService(
  accountRepo,
  auditStore,
  freeResults,
  contestStore,
  leagueStore,
);
const onboarding = new OnboardingService(
  accountRepo,
  auditStore,
  football,
  contestStore,
  leagues,
);
const counters = new ReliabilityCounters();
const app = createApp({
  config,
  auth,
  grants: createPgGrantRepository(db),
  audit: auditStore,
  football,
  footballStore,
  contests,
  leagues,
  profiles,
  onboarding,
  scoringActors,
  live,
  settlement,
  settlementOrchestrator,
  snapshots,
  attestations,
  attestationGate,
  clientDir: path.resolve(process.cwd(), "dist/client"),
  redis,
  logger,
  clock: systemClock,
  rateLimiter: new InMemoryRateLimiter(
    config.server.rateLimit.authMax,
    config.server.rateLimit.authWindowSeconds * 1000,
  ),
  counters,
  idempotency: createPgIdempotencyStore(db),
  probes: {
    database: async () => {
      const result = await pool.query("SELECT 1 AS ok");
      return (result.rowCount ?? 0) === 1;
    },
    solana: async () => {
      const response = await fetch(config.secrets.solanaRpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        return false;
      }
      const body = (await response.json()) as { result?: unknown; error?: unknown };
      return body.error === undefined;
    },
    sports: async () => ({
      configured: config.public.liveProviderConfigured,
      reachable: null,
    }),
  },
});

const server = serve({ fetch: app.fetch, port: config.server.port }, (info) => {
  logger.info({ port: info.port }, "kickr api listening");
});

async function shutdown(): Promise<void> {
  ingest.stop();
  server.close();
  await redis.close();
  await pool.end();
}

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
