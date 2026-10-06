/**
 * Clean FREE contest E2E against a running local API + Postgres.
 * Zero manual DB edits. Forward-only match lifecycle. Real scoring + finalize.
 *
 * Usage (API already on :3000):
 *   npm run dev:e2e-free
 *
 * Blocked when NODE_ENV=production.
 */
import { writeFileSync } from "node:fs";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { loadConfig } from "../config/load.js";
import { assertFreeDevHarnessAllowed } from "../contests/free/dev-gate.js";
import { pickDiverseLocalDevXi } from "../sports/local-dev-provider.js";

const BASE = process.env.KICKR_BASE_URL ?? "http://127.0.0.1:3000";
const OUT = process.env.KICKR_E2E_OUT ?? "/workspace/scratch/e2e-free-state.json";

function assertCliAllowed(): void {
  const env = process.env.NODE_ENV ?? "development";
  if (env === "production") {
    throw new Error("dev:e2e-free is blocked in production");
  }
  // Also enforce via config (SPORTS_DATA_PROVIDER).
  const config = loadConfig(process.env);
  assertFreeDevHarnessAllowed({
    nodeEnv: config.server.nodeEnv,
    sportsDataProvider: config.public.sportsDataProvider,
  });
}

async function api(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; idempotency?: string } = {},
) {
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
  return {
    token: String(session.token),
    accountId: account.id,
    walletAddress: account.walletAddress,
    // Keep secret in memory only — never write to disk.
    _secret: wallet.secretKey,
  };
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
  const version = saved.version as { id: string; version: number; creditsUsed: number };
  return { teamId: team.id, versionId: version.id, draft, creditsUsed: version.creditsUsed };
}

async function main() {
  assertCliAllowed();
  console.log(`Clean FREE E2E against ${BASE}`);
  const report: Record<string, unknown> = { steps: [] };
  const step = (name: string, data: unknown) => {
    console.log(`✓ ${name}`, typeof data === "object" ? JSON.stringify(data).slice(0, 200) : data);
    (report.steps as unknown[]).push({ name, data });
  };

  // 1. Main user + scoring actor
  const mainUser = await login();
  step("sign-in main", { accountId: mainUser.accountId, wallet: mainUser.walletAddress });
  await api("/v1/dev/e2e/scoring-actor", { method: "POST", token: mainUser.token });
  step("register LOCAL_DEV scoring actor", { accountId: mainUser.accountId });

  // 2. Fresh match at LINEUPS_AVAILABLE
  const seeded = await api("/v1/dev/e2e/matches", {
    method: "POST",
    token: mainUser.token,
    body: { seed: Date.now() },
  });
  const matchId = String(seeded.matchId);
  step("create/reset local-dev match", seeded);

  // 3. Ensure FREE contests + save XIs + join
  const listed0 = await api(`/matches/${matchId}/contests`, { token: mainUser.token });
  const contests0 = listed0.contests as Array<{ contestId: string; templateCode: string; contestKind: string }>;
  const grand = contests0.find((c) => c.contestKind === "FREE" && c.templateCode === "FREE-GRAND");
  if (!grand) throw new Error("FREE-GRAND missing");
  step("FREE contests created", { grand: grand.contestId, count: contests0.length });

  const users = [mainUser];
  const joins: Array<{
    accountId: string;
    wallet: string;
    versionId: string;
    entryId: string;
    variant: number;
  }> = [];

  for (let i = 0; i < 4; i += 1) {
    const user = i === 0 ? mainUser : await login();
    if (i > 0) users.push(user);
    const xi = await saveXi(user.token, matchId, i);
    // Verify reload endpoint
    const reloaded = await api(`/matches/${matchId}/my-team`, { token: user.token });
    const latest = reloaded.latest as { id: string; captainId: string; viceId: string } | null;
    if (!latest || latest.id !== xi.versionId) {
      throw new Error("saved XI did not reload");
    }
    if (latest.captainId !== xi.draft.captainId || latest.viceId !== xi.draft.viceId) {
      throw new Error("captain/vice did not restore");
    }
    const joined = await api(`/contests/${grand.contestId}/free-join`, {
      method: "POST",
      token: user.token,
      idempotency: `e2e-join-${user.accountId}`,
      body: { teamVersionId: xi.versionId },
    });
    const entry = joined.entry as { id: string };
    joins.push({
      accountId: user.accountId,
      wallet: user.walletAddress,
      versionId: xi.versionId,
      entryId: entry.id,
      variant: i,
    });
  }
  step("build/save XIs + join FREE", { joins: joins.length, contestId: grand.contestId });

  // 4. Upcoming lifecycle
  const mineUp = await api("/me/contests", { token: mainUser.token });
  const upCard = (mineUp.contests as Array<{ contestId: string; lifecycleBucket: string }>).find(
    (c) => c.contestId === grand.contestId,
  );
  if (upCard?.lifecycleBucket !== "upcoming") {
    throw new Error(`expected upcoming, got ${upCard?.lifecycleBucket}`);
  }
  step("verify Upcoming", upCard);

  // 5. Advance to LIVE (forward only)
  const toLive = await api(`/v1/dev/e2e/matches/${matchId}/advance`, {
    method: "POST",
    token: mainUser.token,
    body: { until: "LIVE" },
  });
  step("advance to LIVE", toLive);

  // 6. Score (real path) — first wave
  const score1 = await api(`/v1/dev/e2e/matches/${matchId}/score`, {
    method: "POST",
    token: mainUser.token,
  });
  const board1 = (score1.leaderboard as Array<{ entryId: string; milliPoints: number; rank: number; contestId: string }>)
    .filter((r) => r.contestId === grand.contestId)
    .sort((a, b) => a.rank - b.rank);
  step("live scoring wave 1", board1.map((r) => ({ rank: r.rank, pts: r.milliPoints, entryId: r.entryId.slice(0, 8) })));

  // 7. Append late events → rank change
  const late = await api(`/v1/dev/e2e/matches/${matchId}/append-late-events`, {
    method: "POST",
    token: mainUser.token,
  });
  const score2 = await api(`/v1/dev/e2e/matches/${matchId}/score`, {
    method: "POST",
    token: mainUser.token,
  });
  const board2 = (score2.leaderboard as Array<{ entryId: string; milliPoints: number; rank: number; contestId: string }>)
    .filter((r) => r.contestId === grand.contestId)
    .sort((a, b) => a.rank - b.rank);
  step("live scoring wave 2 (after late events)", {
    inserted: late.inserted,
    board: board2.map((r) => ({ rank: r.rank, pts: r.milliPoints, entryId: r.entryId.slice(0, 8) })),
  });
  const ranksChanged =
    board1.length > 1 &&
    board2.length > 1 &&
    (board1[0]!.entryId !== board2[0]!.entryId ||
      board1.some((r, i) => board2[i] && r.milliPoints !== board2[i]!.milliPoints));
  if (!ranksChanged) {
    console.warn("! rank/score change between waves was not detected — check fixture diversity");
  } else {
    step("visible rank/score change", true);
  }

  const mineLive = await api("/me/contests", { token: mainUser.token });
  const liveCard = (mineLive.contests as Array<{ contestId: string; lifecycleBucket: string }>).find(
    (c) => c.contestId === grand.contestId,
  );
  if (liveCard?.lifecycleBucket !== "live") {
    throw new Error(`expected live, got ${liveCard?.lifecycleBucket}`);
  }
  step("verify Live", liveCard);

  // Distinct scores check
  const pts = board2.map((r) => r.milliPoints);
  if (new Set(pts).size < Math.min(3, pts.length)) {
    console.warn("! leaderboard scores not sufficiently distinct", pts);
  } else {
    step("distinct leaderboard scores", pts);
  }

  // 8. Advance to FINAL
  const toFinal = await api(`/v1/dev/e2e/matches/${matchId}/advance`, {
    method: "POST",
    token: mainUser.token,
    body: { until: "FINAL" },
  });
  step("advance to FINAL", toFinal);

  // 9. Finalize via application path (LOCAL_DEV scoring actor)
  await api(`/v1/dev/e2e/matches/${matchId}/score`, { method: "POST", token: mainUser.token });
  const finalized = await api(`/v1/dev/e2e/contests/${grand.contestId}/finalize`, {
    method: "POST",
    token: mainUser.token,
  });
  const freeResult = finalized.result as {
    rows: Array<{ entryId: string; rank: number; finalScoreMilliPoints: number; wallet: string }>;
  };
  step(
    "finalize free results",
    freeResult.rows.map((r) => ({
      rank: r.rank,
      pts: r.finalScoreMilliPoints,
      wallet: r.wallet.slice(0, 6),
    })),
  );

  // 10. Verify Completed + Final Result
  const mineDone = await api("/me/contests", { token: mainUser.token });
  const doneCard = (mineDone.contests as Array<{
    contestId: string;
    lifecycleBucket: string;
    primaryCta: string;
    hasFinalResult?: boolean;
  }>).find((c) => c.contestId === grand.contestId);
  if (doneCard?.lifecycleBucket !== "completed") {
    throw new Error(`expected completed, got ${doneCard?.lifecycleBucket}`);
  }
  step("verify Completed", doneCard);

  const myResult = await api(`/contests/${grand.contestId}/my-result`, { token: mainUser.token });
  if (myResult.contestKind !== "FREE" || myResult.claimable !== false) {
    throw new Error("Final result is not a clean FREE payload");
  }
  if (!myResult.xiSummary || !Array.isArray(myResult.xiSummary) || (myResult.xiSummary as unknown[]).length !== 11) {
    throw new Error("Final result missing XI summary");
  }
  step("open Final Result", {
    rank: myResult.rank,
    score: myResult.finalScoreMilliPoints,
    captainId: myResult.captainId,
    viceId: myResult.viceId,
    totalEntries: myResult.totalEntries,
    contestName: myResult.contestName,
    monetaryPrize: myResult.monetaryPrize,
  });

  // Strip secrets before write
  const safeUsers = users.map((u) => ({
    accountId: u.accountId,
    walletAddress: u.walletAddress,
    token: u.token,
  }));
  const out = {
    main: safeUsers[0],
    users: safeUsers,
    matchId,
    contestId: grand.contestId,
    joins,
    leaderboardFinal: freeResult.rows,
    myResult: {
      rank: myResult.rank,
      finalScoreMilliPoints: myResult.finalScoreMilliPoints,
      captainId: myResult.captainId,
      viceId: myResult.viceId,
    },
    report,
    dbEdits: "none",
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT}`);
  console.log("E2E OK — no manual DB edits");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
