/**
 * npm run demo:ready — production-demo readiness check (fail loud).
 * Also probes GET /ready/demo when BASE_URL is set.
 */
import { loadConfig } from "../config/load.js";
import { createPool } from "../db/pool.js";
import { createIoredisClient } from "../redis/ioredis-client.js";
import { checkRedisHealth } from "../redis/client.js";
import {
  detectForbiddenSignerEnv,
  evaluateDemoReady,
} from "../ops/demo-ready.js";
import { ConfigError } from "../shared/errors.js";

async function probeDb(url: string): Promise<boolean> {
  const pool = createPool(url);
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : "Invalid configuration";
    console.error(`demo:ready FAILED: ${message}`);
    process.exit(1);
  }

  const forbidden = detectForbiddenSignerEnv(process.env);
  const databaseOk = await probeDb(config.secrets.databaseUrl);
  const redis = createIoredisClient(config.secrets.redisUrl);
  let redisOk: boolean;
  try {
    redisOk = (await checkRedisHealth(redis)).ok;
  } catch {
    redisOk = false;
  } finally {
    await redis.close().catch(() => undefined);
  }

  // Public demo readiness always treats paid production as disabled.
  // Production API wires allowPaidDevnet=false in api/main.ts.
  const paidProductionEnabled = false;

  const report = evaluateDemoReady({
    config,
    databaseOk,
    redisOk,
    hasDevSignerEnv: forbidden.length > 0,
    hasBackendUsdcCustody: forbidden.some((k) => k.includes("USDC") || k.includes("ESCROW")),
    paidProductionEnabled,
  });

  for (const check of report.checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.id}: ${check.message}`);
  }
  if (forbidden.length > 0) {
    console.log(`FAIL  forbidden_env: ${forbidden.join(", ")}`);
    report.ok = false;
  }

  const base = process.env.BASE_URL?.replace(/\/$/, "");
  if (base) {
    try {
      const res = await fetch(`${base}/ready/demo`);
      const body = (await res.json()) as { ok?: boolean };
      console.log(`${res.ok && body.ok ? "PASS" : "FAIL"}  http:/ready/demo status=${res.status}`);
      if (!res.ok || !body.ok) report.ok = false;
    } catch (error) {
      console.log(`FAIL  http:/ready/demo: ${error instanceof Error ? error.message : String(error)}`);
      report.ok = false;
    }
  }

  if (!report.ok) {
    console.error("demo:ready FAILED — see checks above");
    process.exit(1);
  }
  console.log(`demo:ready OK (mode=${report.mode})`);
}

await main();
