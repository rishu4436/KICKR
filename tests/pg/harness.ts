/**
 * Postgres-backed Phase 11.1 harness.
 * Uses a dedicated database (default kickr_test). Never touches the in-memory store.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { AuthService } from "../../auth/service.js";
import { ContestDiscoveryCache } from "../../contests/discovery.js";
import { createPgFreeResultStore } from "../../contests/free/pg-store.js";
import { ContestService } from "../../contests/service.js";
import { createPgContestStore } from "../../db/contest-repository.js";
import { createPgFootballStore } from "../../db/football-repository.js";
import { applyMigrations, loadMigrationFiles } from "../../db/migrate.js";
import { asMigrationRunner, asQueryable, createPool } from "../../db/pool.js";
import {
  createPgAccountRepository,
  createPgAuditStore,
  createPgGrantRepository,
  createPgNonceRepository,
  createPgSessionRepository,
} from "../../db/repositories.js";
import { FootballService } from "../../football/service.js";
import { InMemoryRedis } from "../../redis/client.js";
import { createLocalDevProvider } from "../../sports/local-dev-provider.js";
import { InMemoryProviderIdMap, seedProviderIdMapFromCatalog } from "../../sports/id-map.js";
import { createCombinedScoringSource } from "../../live/combined-scoring-source.js";
import { LiveScoringService } from "../../live/service.js";
import { LocalDevScoringActorRegistry } from "../../contests/free/local-dev-scoring-actor.js";
import { LeagueService, createPgLeagueStore } from "../../leagues/index.js";
import { ProfileService } from "../../profile/index.js";
import { createApp, type AppDeps } from "../../api/server.js";
import { silentLogger } from "../../shared/logger.js";
import { generateWallet, signMessage, testConfig } from "../helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

export function resolveTestDatabaseUrl(): string {
  const explicit = process.env.KICKR_TEST_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) {
    // Prefer a dedicated DB so we never wipe local-dev kickr rows.
    return fromEnv.replace(/\/[^/?]+(\?|$)/, "/kickr_test$1");
  }
  return "";
}

export function requireTestDatabaseUrl(): string {
  const url = resolveTestDatabaseUrl();
  if (!url) {
    const msg =
      "[test:pg] SKIPPED/FAIL: no database configured. Set KICKR_TEST_DATABASE_URL " +
      "(recommended) or DATABASE_URL. Example: postgres://kickr:kickr@127.0.0.1:5432/kickr_test";
    console.error(`\n${"!".repeat(72)}\n${msg}\n${"!".repeat(72)}\n`);
    throw new Error(msg);
  }
  if (/\/kickr(\?|$)/.test(url) && !url.includes("kickr_test")) {
    const msg =
      "[test:pg] Refusing to run against the primary kickr database. Use kickr_test (or another dedicated DB).";
    console.error(`\n${"!".repeat(72)}\n${msg}\n${"!".repeat(72)}\n`);
    throw new Error(msg);
  }
  return url;
}

const TRUNCATE_SQL = `
TRUNCATE TABLE
  private_league_results,
  private_league_members,
  private_leagues,
  free_contest_results,
  settlement_result_rows,
  settlement_reconciliations,
  contest_settlements,
  deposit_reconciliations,
  contest_entries,
  contest_reservations,
  contest_outbox,
  contests,
  fantasy_team_versions,
  fantasy_teams,
  match_score_snapshots,
  match_events,
  match_squad,
  unresolved_lineup_players,
  unresolved_provider_events,
  matches,
  players,
  clubs,
  sessions,
  login_nonces,
  account_roles,
  account_capability_grants,
  audit_events,
  idempotency_records,
  result_attestations,
  accounts
RESTART IDENTITY CASCADE
`;

export async function migrateTestDatabase(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    const files = await loadMigrationFiles(path.join(REPO_ROOT, "migrations"));
    await applyMigrations(asMigrationRunner(pool), files);
  } finally {
    await pool.end();
  }
}

export async function resetTestDatabase(pool: Pool): Promise<void> {
  await pool.query(TRUNCATE_SQL);
}

export async function buildPgApp(clock: () => Date = () => new Date("2026-10-06T12:00:00.000Z")): Promise<{
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  pool: Pool;
  footballStore: ReturnType<typeof createPgFootballStore>;
  databaseUrl: string;
  close: () => Promise<void>;
}> {
  const databaseUrl = requireTestDatabaseUrl();
  await migrateTestDatabase(databaseUrl);
  const pool = createPool(databaseUrl);
  await resetTestDatabase(pool);
  const db = asQueryable(pool);
  const config = testConfig({ databaseUrl, nodeEnv: "test" });
  const audit = createPgAuditStore(db);
  const accountRepo = createPgAccountRepository(db);
  const auth = new AuthService(
    accountRepo,
    createPgNonceRepository(db),
    createPgSessionRepository(db),
    audit,
    config.server.auth,
  );
  const footballStore = createPgFootballStore(db);
  const catalog = createLocalDevProvider().catalog();
  await footballStore.upsertCatalog(catalog);
  const football = new FootballService(footballStore, audit, config.server.fantasy);
  const redis = new InMemoryRedis();
  const contestStore = createPgContestStore(pool);
  const freeResults = createPgFreeResultStore(pool);
  const leagueStore = createPgLeagueStore(pool);
  const contests = new ContestService(
    contestStore,
    football,
    audit,
    new ContestDiscoveryCache(redis, config.public.environment),
    config.server.contests,
    undefined,
    true,
    freeResults,
  );
  const scoringActors = new LocalDevScoringActorRegistry(
    { nodeEnv: config.server.nodeEnv, sportsDataProvider: config.public.sportsDataProvider },
    audit,
  );
  const idMap = new InMemoryProviderIdMap();
  seedProviderIdMapFromCatalog(idMap, "local-dev", catalog);
  const live = new LiveScoringService(
    footballStore,
    football,
    idMap,
    redis,
    config.public.environment,
    audit,
    "local-dev",
    createCombinedScoringSource(contestStore, leagueStore),
  );
  const leagues = new LeagueService(leagueStore, football, audit, live);
  const profiles = new ProfileService(accountRepo, audit, freeResults, contestStore, leagueStore);
  const deps: AppDeps = {
    config,
    auth,
    grants: createPgGrantRepository(db),
    audit,
    football,
    footballStore,
    contests,
    leagues,
    profiles,
    scoringActors,
    live,
    redis,
    logger: silentLogger(),
    clock,
  };
  return {
    app: createApp(deps),
    deps,
    pool,
    footballStore,
    databaseUrl,
    close: async () => {
      await pool.end();
    },
  };
}

export async function loginPg(app: ReturnType<typeof createApp>, now = new Date("2026-10-06T12:00:00.000Z")) {
  const wallet = generateWallet();
  const nonceRes = await app.request("/v1/auth/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress: wallet.publicKey }),
  });
  if (!nonceRes.ok) throw new Error(`nonce failed: ${nonceRes.status}`);
  const nonce = (await nonceRes.json()) as { message: string };
  const loginRes = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      walletAddress: wallet.publicKey,
      message: nonce.message,
      signature: signMessage(nonce.message, wallet.secretKey),
    }),
  });
  if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
  const session = (await loginRes.json()) as { token: string; account: { id: string; walletAddress: string } };
  return {
    wallet,
    token: session.token,
    accountId: session.account.id,
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    } as Record<string, string>,
    now,
  };
}

export async function saveXiViaApi(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  matchId: string,
  variant = 0,
) {
  const poolRes = await app.request(`/matches/${matchId}/players`, { headers });
  if (!poolRes.ok) throw new Error(`players ${poolRes.status}`);
  const poolBody = (await poolRes.json()) as {
    players: Array<{ playerId: string; position: string; clubId: string }>;
  };
  const players = poolBody.players;
  const home = players[0]?.clubId ?? "";
  const away = players.find((p) => p.clubId !== home)?.clubId ?? "";
  const byPosClub = (pos: string, clubId: string) =>
    players.filter((p) => p.position === pos && p.clubId === clubId);
  const take = (pos: string, clubId: string, nth: number) => {
    const row = byPosClub(pos, clubId)[nth];
    if (!row) throw new Error(`missing ${pos}`);
    return row.playerId;
  };
  const off = variant % 2;
  const playerIds = [
    take("GK", home, 0),
    take("DEF", home, 0),
    take("DEF", home, 1),
    take("DEF", home, 2),
    take("DEF", home, 3),
    take("MID", home, 0),
    take("MID", home, 1),
    take("MID", away, off),
    take("DEF", away, off),
    take("FWD", away, 1),
    take("MID", away, 1 - off),
  ];
  const captainId = playerIds[5 + (variant % 2)]!;
  const viceId = playerIds[5 + ((variant + 1) % 2)]!;
  const teamRes = await app.request("/teams", {
    method: "POST",
    headers,
    body: JSON.stringify({ matchId }),
  });
  if (!teamRes.ok) throw new Error(`create team ${teamRes.status} ${await teamRes.text()}`);
  const teamBody = (await teamRes.json()) as { team: { id: string } };
  const verRes = await app.request(`/teams/${teamBody.team.id}/versions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ playerIds, captainId, viceId }),
  });
  if (!verRes.ok) throw new Error(`save xi ${verRes.status} ${await verRes.text()}`);
  const verBody = (await verRes.json()) as { version: { id: string } };
  return { teamId: teamBody.team.id, versionId: verBody.version.id, playerIds, captainId, viceId };
}
