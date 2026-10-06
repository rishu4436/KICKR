/**
 * npm run demo:seed — initialize public DEMO matches, players, FREE contests.
 * Gated: SPORTS_PROVIDER=DEMO; production also needs DEMO_SEED_ENABLED=true.
 */
import { loadConfig } from "../config/load.js";
import { asQueryable, createPool } from "../db/pool.js";
import { createPgFootballStore } from "../db/football-repository.js";
import { createPgContestStore } from "../db/contest-repository.js";
import { createPgAuditStore } from "../db/repositories.js";
import { FootballService } from "../football/service.js";
import { ContestDiscoveryCache } from "../contests/discovery.js";
import { ContestService } from "../contests/service.js";
import { createPgFreeResultStore } from "../contests/free/pg-store.js";
import { createIoredisClient } from "../redis/ioredis-client.js";
import { systemClock } from "../shared/clock.js";
import { seedPublicDemo } from "../sports/demo-seed.js";
import { ConfigError } from "../shared/errors.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : "Invalid configuration";
    console.error(`demo:seed failed: ${message}`);
    process.exit(1);
  }

  const pool = createPool(config.secrets.databaseUrl);
  const db = asQueryable(pool);
  const redis = createIoredisClient(config.secrets.redisUrl);
  const footballStore = createPgFootballStore(db);
  const football = new FootballService(footballStore, createPgAuditStore(db), config.server.fantasy);
  const contestStore = createPgContestStore(pool);
  const freeResults = createPgFreeResultStore(pool);
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
    // Never open paid paths from demo seed.
    false,
    freeResults,
  );

  try {
    const result = await seedPublicDemo(
      { footballStore, contests, clock: () => systemClock() },
      {
        nodeEnv: config.server.nodeEnv,
        sportsProvider: config.server.sportsData.liveProvider,
        demoSeedEnabled: config.server.sportsData.demoSeedEnabled,
      },
    );
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(`demo:seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
    await redis.close().catch(() => undefined);
  }
}

await main();
