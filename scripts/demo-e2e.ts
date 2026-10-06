/**
 * Clean public DEMO E2E against a production-demo API.
 * Uses token-gated /v1/demo/control/* for match progression.
 * Zero direct DB edits. FREE only. Never RUN_SETTLEMENT / paid / Solana txs.
 *
 *   DEMO_CONTROL_TOKEN=... BASE_URL=http://127.0.0.1:3000 npm run demo:e2e
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { pickDiverseLocalDevXi } from "../sports/local-dev-provider.js";

const BASE = (process.env.BASE_URL ?? process.env.KICKR_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = (process.env.DEMO_CONTROL_TOKEN ?? "").trim();
const OUT = process.env.KICKR_DEMO_E2E_OUT ?? "/workspace/scratch/demo-e2e-report.json";

if (TOKEN.length < 16) {
  throw new Error("demo:e2e requires DEMO_CONTROL_TOKEN (>=16 chars)");
}

async function api(
  path: string,
  opts: {
    method?: string;
    token?: string;
    body?: unknown;
    idempotency?: string;
    control?: boolean;
  } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.control) headers["x-demo-control-token"] = TOKEN;
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
    throw new Error(`${opts.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 800)}`);
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

async function saveXi(token: string, matchId: string, variant: number) {
  const pool = await api(`/matches/${matchId}/players`, { token });
  const players = (pool.players ?? []) as Array<{
    playerId: string;
    position: string;
    clubId: string;
    shortName?: string;
  }>;
  const draft = pickDiverseLocalDevXi(players, variant);
  const created = await api("/teams", { method: "POST", token, body: { matchId } });
  const team = created.team as { id: string };
  const saved = await api(`/teams/${team.id}/versions`, {
    method: "POST",
    token,
    body: draft,
  });
  const version = saved.version as { id: string };
  return { teamId: team.id, versionId: version.id, draft };
}

async function main() {
  const report: Record<string, unknown> = { base: BASE, steps: [] };
  const step = (name: string, data: unknown) => {
    console.log(`✓ ${name}`, typeof data === "object" ? JSON.stringify(data).slice(0, 240) : data);
    (report.steps as unknown[]).push({ name, data });
  };

  const ready = await api("/ready/demo");
  if (!ready.ok) throw new Error(`demo ready failed: ${JSON.stringify(ready)}`);
  step("ready/demo", { ok: ready.ok, mode: ready.mode });

  const publicCfg = await api("/v1/config/public");
  if (publicCfg.demoData !== true || publicCfg.sportsProvider !== "demo") {
    throw new Error("public config is not DEMO");
  }
  step("public config DEMO", {
    demoData: publicCfg.demoData,
    sportsProvider: publicCfg.sportsProvider,
    environment: publicCfg.environment,
  });

  const controlStatus = await api("/v1/demo/control/status");
  if (!controlStatus.enabled) throw new Error("demo control not enabled");
  step("demo control enabled", controlStatus);

  const user1 = await login();
  step("sign in user1", { accountId: user1.accountId, wallet: user1.walletAddress });
  const user2 = await login();
  step("sign in user2", { accountId: user2.accountId, wallet: user2.walletAddress });

  const seeded = await api("/v1/demo/control/matches", {
    method: "POST",
    control: true,
    body: { seed: Date.now() },
  });
  const matchId = String(seeded.matchId);
  step("choose demo match (fresh)", { matchId, status: seeded.status, label: seeded.label });

  const contests = await api(`/matches/${matchId}/contests`, { token: user1.token });
  const list = (contests.contests ?? []) as Array<{ contestId: string; contestKind: string; templateCode: string }>;
  const grand =
    list.find((c) => c.contestKind === "FREE" && String(c.templateCode).includes("GRAND")) ??
    list.find((c) => c.contestKind === "FREE");
  if (!grand) throw new Error("no FREE contest on demo match — control seed should ensure FREE contests");
  step("FREE contest", grand);

  const xi1 = await saveXi(user1.token, matchId, 0);
  step("user1 save XI", { versionId: xi1.versionId });
  const join1 = await api(`/contests/${grand.contestId}/free-join`, {
    method: "POST",
    token: user1.token,
    idempotency: `demo-e2e-join-${user1.accountId}`,
    body: { teamVersionId: xi1.versionId },
  });
  step("user1 join FREE", { entryId: (join1.entry as { id: string }).id, confirmed: join1.confirmed });

  const league = await api("/leagues", {
    method: "POST",
    token: user1.token,
    body: { name: "Demo E2E League", matchId, capacity: 8 },
  });
  const leagueBody = league.league as { id: string; inviteCode: string };
  step("create private league", { leagueId: leagueBody.id, inviteCode: leagueBody.inviteCode });

  const xi2 = await saveXi(user2.token, matchId, 1);
  const joinedLeague = await api("/leagues/join", {
    method: "POST",
    token: user2.token,
    body: { inviteCode: leagueBody.inviteCode, teamVersionId: xi2.versionId },
  });
  step("user2 join league via invite", {
    leagueId: (joinedLeague.league as { id?: string })?.id ?? leagueBody.id,
    member: true,
  });

  const join2 = await api(`/contests/${grand.contestId}/free-join`, {
    method: "POST",
    token: user2.token,
    idempotency: `demo-e2e-join-${user2.accountId}`,
    body: { teamVersionId: xi2.versionId },
  });
  step("user2 join FREE contest", { entryId: (join2.entry as { id: string }).id });

  const toLive = await api(`/v1/demo/control/matches/${matchId}/advance`, {
    method: "POST",
    control: true,
    body: { until: "LIVE" },
  });
  step("advance → LIVE", toLive);

  const wave1 = await api(`/v1/demo/control/matches/${matchId}/score`, {
    method: "POST",
    control: true,
  });
  const board1 = ((wave1.leaderboard as Array<{ contestId: string; rank: number; milliPoints: number; entryId: string }>) ?? [])
    .filter((r) => r.contestId === grand.contestId)
    .sort((a, b) => a.rank - b.rank);
  step("scoring wave 1", board1.map((r) => ({ rank: r.rank, pts: r.milliPoints, entry: r.entryId.slice(0, 8) })));

  const wave2 = await api(`/v1/demo/control/matches/${matchId}/scoring-wave`, {
    method: "POST",
    control: true,
  });
  const board2 = ((wave2.leaderboard as Array<{ contestId: string; rank: number; milliPoints: number; entryId: string }>) ?? [])
    .filter((r) => r.contestId === grand.contestId)
    .sort((a, b) => a.rank - b.rank);
  step("scoring wave 2 (rank changes)", {
    inserted: wave2.inserted,
    board: board2.map((r) => ({ rank: r.rank, pts: r.milliPoints, entry: r.entryId.slice(0, 8) })),
  });

  const liveLb = await api(`/matches/${matchId}/leaderboard`, { token: user1.token });
  const liveRows = ((liveLb.leaderboard as Array<{ contestId?: string }>) ?? []).filter(
    (r) => !r.contestId || r.contestId === grand.contestId,
  );
  step("view leaderboard", { rows: liveRows.length, sample: liveRows.slice(0, 3) });

  const toFinal = await api(`/v1/demo/control/matches/${matchId}/advance`, {
    method: "POST",
    control: true,
    body: { until: "FINAL" },
  });
  step("advance → FINAL", toFinal);

  const finalized = await api(`/v1/demo/control/matches/${matchId}/finalize-free`, {
    method: "POST",
    control: true,
  });
  step("finalize FREE results", finalized);

  const freeResult = await api(`/contests/${grand.contestId}/free-result`, { token: user1.token });
  step("final result loads", {
    status: (freeResult.result as { status?: string })?.status ?? freeResult.status,
    rows: ((freeResult.result as { rows?: unknown[] })?.rows ?? []).length,
  });

  const profile = await api("/v1/me/profile", { token: user1.token });
  step("profile stats", {
    keys: Object.keys(profile).slice(0, 12),
  });

  const share = await fetch(`${BASE}/share/contest/${grand.contestId}`);
  const shareOk = share.ok || share.status === 200;
  const og = await fetch(`${BASE}/share/contest/${grand.contestId}/og.png`).catch(() =>
    fetch(`${BASE}/og/contest/${grand.contestId}`),
  );
  step("share page + OG", {
    shareStatus: share.status,
    shareOk,
    ogStatus: og.status,
    ogType: og.headers.get("content-type"),
  });

  report.ok = true;
  report.matchId = matchId;
  report.contestId = grand.contestId;
  report.leagueId = leagueBody.id;
  report.inviteCode = leagueBody.inviteCode;
  report.boardWave1 = board1;
  report.boardWave2 = board2;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nDemo E2E OK → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
