/* global process, fetch, TextEncoder, sessionStorage, console */
/**
 * Capture Match Ops screenshots with a CEO_HEAD staff session.
 */
import nacl from "tweetnacl";
import bs58 from "bs58";
import { chromium } from "playwright";
import pg from "pg";
import { mkdirSync } from "fs";
import { resolve } from "path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3018";
const OUT = resolve("/workspace/scratch/p18d2-ops");
mkdirSync(OUT, { recursive: true });

async function login() {
  const pair = nacl.sign.keyPair();
  const walletAddress = bs58.encode(pair.publicKey);
  const nonceRes = await fetch(`${BASE}/v1/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress }),
  });
  const nonce = await nonceRes.json();
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(String(nonce.message)), pair.secretKey),
  );
  const loginRes = await fetch(`${BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress, message: nonce.message, signature }),
  });
  const session = await loginRes.json();
  if (!loginRes.ok) throw new Error(JSON.stringify(session));
  return { token: session.token, accountId: session.account.id, walletAddress };
}

async function grantCeo(accountId) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required to grant CEO_HEAD");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(
    `INSERT INTO account_roles (account_id, role_code, created_at, updated_at, granted_by_account_id)
     VALUES ($1, 'CEO_HEAD', now(), now(), NULL)
     ON CONFLICT (account_id, role_code) DO NOTHING`,
    [accountId],
  );
  await client.end();
}

async function seedFixture(token) {
  const positions = ["GK", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "FWD", "FWD", "FWD"];
  const players = [];
  for (const side of ["home", "away"]) {
    for (let i = 0; i < positions.length; i++) {
      players.push({
        displayName: `${side === "home" ? "Ops" : "Man"} ${positions[i]}${i}`,
        shortName: `${side[0]}${positions[i]}${i}`,
        position: positions[i],
        clubSide: side,
        creditValue: positions[i] === "FWD" ? 12 : 9,
        startingStatus: "STARTER",
        availability: "AVAILABLE",
      });
    }
  }
  const res = await fetch(`${BASE}/v1/ops/match-ops/matches`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      competition: "Operator Cup",
      venue: "Ops Arena",
      kickoffAt: new Date(Date.now() + 86400000).toISOString(),
      homeClub: { name: "Ops United", shortName: "OPS" },
      awayClub: { name: "Manual City", shortName: "MAN" },
      players,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  const matchId = body.match.id;
  const playerId = body.players[0].id;
  await fetch(`${BASE}/v1/ops/match-ops/matches/${matchId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "LOCKED", reason: "screenshot prep" }),
  });
  await fetch(`${BASE}/v1/ops/match-ops/matches/${matchId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "LIVE", reason: "screenshot prep" }),
  });
  const prop = await fetch(`${BASE}/v1/ops/match-ops/proposals`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      matchId,
      eventType: "GOAL",
      primaryPlayerId: playerId,
      matchMinute: 37,
      note: "GOAL — Player X — 37'",
      source: "MANUAL_OPERATOR",
    }),
  });
  const proposal = (await prop.json()).proposal;
  await fetch(`${BASE}/v1/ops/match-ops/proposals/${proposal.id}/review`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  await fetch(`${BASE}/v1/ops/match-ops/proposals/${proposal.id}/confirm`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  await fetch(`${BASE}/v1/ops/match-ops/matches/${matchId}/credits`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ playerId, creditValue: 14, reason: "screenshot credit bump" }),
  });
  return matchId;
}

async function main() {
  const session = await login();
  await grantCeo(session.accountId);
  const matchId = await seedFixture(session.token);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(
    ([token, wallet]) => {
      sessionStorage.setItem("kickr_match_ops_token", token);
      sessionStorage.setItem("kickr_match_ops_wallet", wallet);
    },
    [session.token, session.walletAddress],
  );
  await page.goto(`${BASE}/ops/matches#/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/01-match-list.png`, fullPage: true });

  await page.goto(`${BASE}/ops/matches#/match/${matchId}/overview`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/02-match-detail.png`, fullPage: true });

  await page.goto(`${BASE}/ops/matches#/match/${matchId}/events`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/03-live-events.png`, fullPage: true });

  await page.goto(`${BASE}/ops/matches#/match/${matchId}/credits`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/04-credits.png`, fullPage: true });

  await page.goto(`${BASE}/ops/matches#/match/${matchId}/lineup`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/05-lineup.png`, fullPage: true });

  await page.goto(`${BASE}/ops/matches#/match/${matchId}/audit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/06-audit.png`, fullPage: true });

  await browser.close();
  console.log(JSON.stringify({ matchId, out: OUT, files: [
    "01-match-list.png", "02-match-detail.png", "03-live-events.png", "04-credits.png", "05-lineup.png", "06-audit.png"
  ] }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
