/**
 * Dev-only FREE UX seed. Gated off in production.
 *
 * Uses real HTTP API joins (no SQL seat inserts). Temporarily opens LIVE/FINAL
 * matches via SQL only so XI can be saved (match state machine has no reverse
 * edges). Then restores LIVE/FINAL, locks contests, and finalizes FREE results
 * with varied scores.
 *
 * Usage (API already running on :3000):
 *   npm run dev:seed-free-ux
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import nacl from "tweetnacl";
import bs58 from "bs58";
import pg from "pg";
import { loadConfig } from "../config/load.js";
import {
  LOCAL_DEV_MATCH_FINAL,
  LOCAL_DEV_MATCH_LIVE,
  LOCAL_DEV_MATCH_UPCOMING,
} from "../sports/local-dev-provider.js";

const BASE = process.env.KICKR_BASE_URL ?? "http://127.0.0.1:3000";
const OUT = process.env.KICKR_SEED_OUT ?? "/workspace/scratch/seed-free-ux-state.json";

function assertNotProduction(): void {
  const env = process.env.NODE_ENV ?? "development";
  if (env === "production") {
    throw new Error("dev:seed-free-ux is blocked in production");
  }
}

async function api(path: string, opts: {
  method?: string;
  token?: string;
  body?: unknown;
  idempotency?: string;
} = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idempotency) headers["idempotency-key"] = opts.idempotency;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${opts.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return json as Record<string, unknown>;
}

function keypair() {
  const pair = nacl.sign.keyPair();
  return { publicKey: bs58.encode(pair.publicKey), secretKey: pair.secretKey };
}

async function login() {
  const wallet = keypair();
  const nonce = await api("/v1/auth/nonce", {
    method: "POST",
    body: { walletAddress: wallet.publicKey },
  });
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(String(nonce.message)), wallet.secretKey),
  );
  const session = await api("/v1/auth/login", {
    method: "POST",
    body: { walletAddress: wallet.publicKey, message: nonce.message, signature },
  });
  const account = session.account as { id: string; walletAddress: string };
  return { token: String(session.token), accountId: account.id, walletAddress: account.walletAddress };
}

function pickXi(
  players: Array<{ playerId: string; position: string; clubId: string }>,
  variant = 0,
) {
  const byPosClub = (pos: string, clubId: string) =>
    players.filter((p) => p.position === pos && p.clubId === clubId);
  const home = players[0]?.clubId ?? "";
  const away = players.find((p) => p.clubId !== home)?.clubId ?? "";
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
    take("FWD", away, Math.min(1 + (variant % 2), 2)),
    take("MID", away, 1 - off),
  ];
  const captainId = playerIds[5 + (variant % 2)]!;
  const viceId = playerIds[6 - (variant % 2)]!;
  return { playerIds, captainId, viceId };
}

async function saveXi(token: string, matchId: string, variant = 0) {
  const pool = await api(`/matches/${matchId}/players`, { token });
  const players = (pool.players ?? pool) as Array<{ playerId: string; position: string; clubId: string }>;
  const draft = pickXi(players, variant);
  const created = await api("/teams", { method: "POST", token, body: { matchId } });
  const team = created.team as { id: string };
  const saved = await api(`/teams/${team.id}/versions`, { method: "POST", token, body: draft });
  const version = saved.version as { id: string };
  return { teamId: team.id, versionId: version.id, draft };
}

async function freeContestId(token: string, matchId: string, templateCode: string) {
  const listed = await api(`/matches/${matchId}/contests`, { token });
  const contests = listed.contests as Array<{
    contestId: string;
    contestKind: string;
    templateCode: string;
    remaining?: number;
  }>;
  const free =
    contests.find(
      (c) => c.contestKind === "FREE" && c.templateCode === templateCode && (c.remaining ?? 1) > 0,
    ) ?? contests.find((c) => c.contestKind === "FREE" && c.templateCode === templateCode);
  if (!free) throw new Error(`No ${templateCode} on ${matchId}`);
  return free.contestId;
}

async function freeJoin(token: string, contestId: string, teamVersionId: string, key: string) {
  return api(`/contests/${contestId}/free-join`, {
    method: "POST",
    token,
    idempotency: key,
    body: { teamVersionId },
  });
}

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const config = loadConfig(process.env);
  const client = new pg.Client({ connectionString: config.secrets.databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function openForXi(client: pg.Client, matchId: string) {
  const prev = await client.query<{ status: string }>(`SELECT status FROM matches WHERE id = $1`, [matchId]);
  const status = prev.rows[0]?.status ?? "LINEUPS_AVAILABLE";
  await client.query(`UPDATE matches SET status = 'LINEUPS_AVAILABLE', updated_at = now() WHERE id = $1`, [
    matchId,
  ]);
  return status;
}

async function restoreMatch(client: pg.Client, matchId: string, status: string) {
  await client.query(`UPDATE matches SET status = $2, updated_at = now() WHERE id = $1`, [matchId, status]);
}



async function freeGrandIdFromDb(client: pg.Client, matchId: string): Promise<string> {
  const res = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM contests
     WHERE match_id = $1 AND contest_kind = 'FREE' AND contest_type = 'GRAND_LEAGUE'
     ORDER BY created_at DESC LIMIT 1`,
    [matchId],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error(`No FREE-GRAND row for ${matchId}`);
  return id;
}

async function reopenFreeForJoin(client: pg.Client, matchId: string) {
  // Dev-only: prior seeds left FREE-GRAND LOCKED. Reopen GRAND only (H2H unique joinable index).
  await client.query(
    `UPDATE contests
     SET status = CASE
           WHEN filled_count >= capacity THEN 'FULL'
           WHEN filled_count > 0 THEN 'PARTIALLY_FILLED'
           ELSE 'OPEN'
         END,
         locked_at = NULL,
         updated_at = now()
     WHERE match_id = $1
       AND contest_kind = 'FREE'
       AND contest_type = 'GRAND_LEAGUE'
       AND status IN ('LOCKED', 'IN_PROGRESS', 'IN_REVIEW')`,
    [matchId],
  );
}

async function lockFree(client: pg.Client, matchId: string) {
  const now = new Date().toISOString();
  const res = await client.query(
    `UPDATE contests
     SET status = 'LOCKED', locked_at = $2, updated_at = $2
     WHERE match_id = $1 AND status IN ('OPEN', 'PARTIALLY_FILLED', 'FULL')
       AND contest_kind = 'FREE'
     RETURNING id`,
    [matchId, now],
  );
  return res.rows.map((r) => r.id as string);
}

async function main() {
  assertNotProduction();
  console.log(`Seeding FREE UX against ${BASE} (local-dev only)`);
  const out: Record<string, unknown> = { main: null, extras: [], upcoming: {}, live: {}, final: {} };

  const mainUser = await login();
  out.main = {
    accountId: mainUser.accountId,
    walletAddress: mainUser.walletAddress,
    token: mainUser.token,
  };

  console.log("Upcoming FREE joins…");
  const upXi = await saveXi(mainUser.token, LOCAL_DEV_MATCH_UPCOMING, 0);
  const upH2h = await freeContestId(mainUser.token, LOCAL_DEV_MATCH_UPCOMING, "FREE-H2H");
  const upGrand = await freeContestId(mainUser.token, LOCAL_DEV_MATCH_UPCOMING, "FREE-GRAND");
  await freeJoin(mainUser.token, upH2h, upXi.versionId, `seed-up-h2h-${mainUser.accountId}`);
  await freeJoin(mainUser.token, upGrand, upXi.versionId, `seed-up-grand-${mainUser.accountId}`);
  (out.upcoming as Record<string, unknown>).h2hContestId = upH2h;
  (out.upcoming as Record<string, unknown>).grandContestId = upGrand;
  (out.upcoming as Record<string, unknown>).teamVersionId = upXi.versionId;

  console.log("LIVE FREE joins (API) + varied XIs…");
  const liveScores: Array<{
    entryId: string;
    wallet: string;
    teamVersionId: string;
    finalScoreMilliPoints: number;
  }> = [];
  await withClient(async (client) => {
    const prev = await openForXi(client, LOCAL_DEV_MATCH_LIVE);
    try {
      await reopenFreeForJoin(client, LOCAL_DEV_MATCH_LIVE);
      const liveGrand = await freeGrandIdFromDb(client, LOCAL_DEV_MATCH_LIVE);
      // Touch discovery so Redis cache refreshes after SQL status reopen.
      await api(`/matches/${LOCAL_DEV_MATCH_LIVE}/contests`, { token: mainUser.token }).catch(() => null);
      const liveXi = await saveXi(mainUser.token, LOCAL_DEV_MATCH_LIVE, 0);
      const j0 = await freeJoin(
        mainUser.token,
        liveGrand,
        liveXi.versionId,
        `seed-live-grand-${mainUser.accountId}`,
      );
      const entry0 = j0.entry as { id: string };
      liveScores.push({
        entryId: entry0.id,
        wallet: mainUser.walletAddress,
        teamVersionId: liveXi.versionId,
        finalScoreMilliPoints: 18500,
      });
      for (let i = 0; i < 4; i += 1) {
        const extra = await login();
        (out.extras as unknown[]).push({
          accountId: extra.accountId,
          walletAddress: extra.walletAddress,
        });
        const xi = await saveXi(extra.token, LOCAL_DEV_MATCH_LIVE, i + 1);
        const joined = await freeJoin(
          extra.token,
          liveGrand,
          xi.versionId,
          `seed-live-grand-${extra.accountId}`,
        );
        const entry = joined.entry as { id: string };
        liveScores.push({
          entryId: entry.id,
          wallet: extra.walletAddress,
          teamVersionId: xi.versionId,
          finalScoreMilliPoints: 22000 - i * 2500 - (i % 2) * 500,
        });
      }
      (out.live as Record<string, unknown>).contestId = liveGrand;
      (out.live as Record<string, unknown>).teamVersionId = liveXi.versionId;
      (out.live as Record<string, unknown>).scores = liveScores;
      (out.live as Record<string, unknown>).locked = await lockFree(client, LOCAL_DEV_MATCH_LIVE);
    } finally {
      await restoreMatch(client, LOCAL_DEV_MATCH_LIVE, prev === "LINEUPS_AVAILABLE" ? "LIVE" : prev);
    }
  });

  console.log("FINAL FREE join + finalize…");
  await withClient(async (client) => {
    const prev = await openForXi(client, LOCAL_DEV_MATCH_FINAL);
    try {
      await reopenFreeForJoin(client, LOCAL_DEV_MATCH_FINAL);
      const finalGrand = await freeGrandIdFromDb(client, LOCAL_DEV_MATCH_FINAL);
      await api(`/matches/${LOCAL_DEV_MATCH_FINAL}/contests`, { token: mainUser.token }).catch(() => null);
      const finalXi = await saveXi(mainUser.token, LOCAL_DEV_MATCH_FINAL, 0);
      const j = await freeJoin(
        mainUser.token,
        finalGrand,
        finalXi.versionId,
        `seed-final-grand-${mainUser.accountId}`,
      );
      const entry = j.entry as { id: string };
      const extras = [];
      const scores = [
        {
          entryId: entry.id,
          wallet: mainUser.walletAddress,
          teamVersionId: finalXi.versionId,
          finalScoreMilliPoints: 15200,
        },
      ];
      for (let i = 0; i < 3; i += 1) {
        const extra = await login();
        extras.push(extra);
        const xi = await saveXi(extra.token, LOCAL_DEV_MATCH_FINAL, i + 1);
        const joined = await freeJoin(
          extra.token,
          finalGrand,
          xi.versionId,
          `seed-final-grand-${extra.accountId}`,
        );
        const e = joined.entry as { id: string };
        scores.push({
          entryId: e.id,
          wallet: extra.walletAddress,
          teamVersionId: xi.versionId,
          finalScoreMilliPoints: 18000 - i * 3100,
        });
      }
      await lockFree(client, LOCAL_DEV_MATCH_FINAL);
      await restoreMatch(client, LOCAL_DEV_MATCH_FINAL, "FINAL");

      // Finalize via scoring permission is ops-only; write free result through SQL-safe store API path.
      // Prefer HTTP finalize if the session has RUN_SCORING; otherwise insert ranked rows directly.
      try {
        await api(`/contests/${finalGrand}/free-result/finalize`, {
          method: "POST",
          token: mainUser.token,
          idempotency: `seed-final-${finalGrand}`,
          body: { scores },
        });
        (out.final as Record<string, unknown>).finalizeVia = "api";
      } catch {
        const ranked = [...scores]
          .sort((a, b) => b.finalScoreMilliPoints - a.finalScoreMilliPoints || a.entryId.localeCompare(b.entryId))
          .map((row, index) => ({ ...row, rank: index + 1 }));
        await client.query(
          `INSERT INTO free_contest_results (id, contest_id, match_id, status, rows, finalized_at, created_at)
           VALUES ($1,$2,$3,'FINAL',$4::jsonb, now(), now())
           ON CONFLICT (contest_id) DO NOTHING`,
          [randomUUID(), finalGrand, LOCAL_DEV_MATCH_FINAL, JSON.stringify(ranked)],
        );
        (out.final as Record<string, unknown>).finalizeVia = "sql-free-result";
      }
      (out.final as Record<string, unknown>).contestId = finalGrand;
      (out.final as Record<string, unknown>).scores = scores;
      (out.final as Record<string, unknown>).prevStatus = prev;
    } finally {
      await restoreMatch(client, LOCAL_DEV_MATCH_FINAL, "FINAL");
    }
  });

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
