import { serve } from "@hono/node-server";
import { AuthService } from "../auth/service.js";
import { loadConfig } from "../config/load.js";
import { createPgAuditStore, createPgAccountRepository, createPgGrantRepository, createPgNonceRepository, createPgSessionRepository } from "../db/repositories.js";
import { asQueryable, createPool } from "../db/pool.js";
import { createPgFootballStore } from "../db/football-repository.js";
import { FootballService } from "../football/service.js";
import { createSportsProvider } from "../sports/local-dev-provider.js";
import path from "node:path";
import { createIoredisClient } from "../redis/ioredis-client.js";
import { createLogger } from "../shared/logger.js";
import { InMemoryRateLimiter } from "../shared/rate-limit.js";
import { systemClock } from "../shared/clock.js";
import { ConfigError } from "../shared/errors.js";
import { createApp } from "./server.js";

/**
 * API process entrypoint.
 * Future services (indexer, scheduler, scoring, review, settlement, support,
 * monitoring) are not started here. See workers/contracts.ts.
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
const sports = createSportsProvider(config.server.sportsData.provider);
if (sports?.developmentOnly) {
  await footballStore.upsertCatalog(sports.catalog());
}
const football = new FootballService(footballStore, createPgAuditStore(db), config.server.fantasy);

const app = createApp({
  config,
  auth,
  grants: createPgGrantRepository(db),
  audit: createPgAuditStore(db),
  football,
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
