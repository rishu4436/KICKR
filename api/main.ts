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
import { resolveSportsRuntime } from "../sports/factory.js";
import { InMemoryProviderIdMap, loadProviderIdMap, seedProviderIdMapFromCatalog } from "../sports/id-map.js";
import { createPgProviderIdMapRepository } from "../db/provider-id-map.js";
import { createContestScoringSource } from "../live/contest-scoring-source.js";
import { LiveScoringService } from "../live/service.js";
import { createIngestWorker } from "../live/ingest.js";
import path from "node:path";
import { createIoredisClient } from "../redis/ioredis-client.js";
import { createLogger } from "../shared/logger.js";
import { InMemoryRateLimiter } from "../shared/rate-limit.js";
import { systemClock } from "../shared/clock.js";
import { ConfigError } from "../shared/errors.js";
import { createApp } from "./server.js";

/**
 * API process entrypoint.
 * Phase 5 starts the live ingest worker only when LIVE_PROVIDER_CONFIGURED.
 * Settlement, review, and payout workers remain contracts-only.
 */
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
  dataProvider: config.server.sportsData.provider,
  liveProvider: config.server.sportsData.liveProvider,
  apiKey: config.secrets.sportsApiKey,
  apiUrl: config.secrets.sportsApiUrl,
  pollIntervalMs: config.server.sportsData.pollIntervalSeconds * 1000,
  requestTimeoutMs: config.server.sportsData.requestTimeoutMs,
  logger,
});
const sports = sportsRuntime.catalogProvider;
if (sports?.developmentOnly) {
  await footballStore.upsertCatalog(sports.catalog());
}
const football = new FootballService(footballStore, createPgAuditStore(db), config.server.fantasy);
const contestStore = createPgContestStore(pool);
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
);
const idMap = new InMemoryProviderIdMap();
// Authoritative production mappings from Postgres. Never invents domain rows.
const providerIdMapRepo = createPgProviderIdMapRepository(db);
loadProviderIdMap(idMap, await providerIdMapRepo.listAll());
if (sports?.developmentOnly) {
  // local-dev catalog seed remains an explicit development overlay.
  seedProviderIdMapFromCatalog(idMap, "local-dev", sports.catalog());
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
  createContestScoringSource(contestStore),
);
live.metrics.setProvider(
  sportsRuntime.liveProviderName,
  sportsRuntime.liveConfigured,
);
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

const app = createApp({
  config,
  auth,
  grants: createPgGrantRepository(db),
  audit: createPgAuditStore(db),
  football,
  contests,
  live,
  clientDir: path.resolve(process.cwd(), "dist/client"),
  redis,
  logger,
  clock: systemClock,
  rateLimiter: new InMemoryRateLimiter(
    config.server.rateLimit.authMax,
    config.server.rateLimit.authWindowSeconds * 1000,
  ),
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
