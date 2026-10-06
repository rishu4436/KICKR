/**
 * Headless Playwright smoke against production-demo URL.
 * Signs in via API + sessionStorage (no Phantom in headless).
 */
import { chromium } from "playwright";
import nacl from "tweetnacl";
import bs58 from "bs58";

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

async function loginToken() {
  const pair = nacl.sign.keyPair();
  const walletAddress = bs58.encode(pair.publicKey);
  const nonceRes = await fetch(`${BASE}/v1/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress }),
  });
  const nonce = await nonceRes.json();
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(nonce.message), pair.secretKey),
  );
  const loginRes = await fetch(`${BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress, message: nonce.message, signature }),
  });
  const session = await loginRes.json();
  return { token: session.token, walletAddress };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const steps = [];
try {
  const ready = await (await page.request.get(`${BASE}/ready/demo`)).json();
  steps.push({ step: "ready/demo", ok: ready.ok === true });

  await page.goto(`${BASE}/`);
  await page.waitForSelector(".brand");
  const demoBanner = await page.locator(".demo-banner").count();
  steps.push({ step: "DEMO DATA banner", ok: demoBanner > 0, count: demoBanner });

  const { token, walletAddress } = await loginToken();
  // Seed session before app module reads sessionStorage on load.
  await page.goto("about:blank");
  await page.goto(`${BASE}/`);
  await page.evaluate(
    ({ token, walletAddress }) => {
      sessionStorage.setItem("kickr.session.token", token);
      sessionStorage.setItem("kickr.auth.mode", "wallet");
      sessionStorage.setItem("kickr.auth.wallet", walletAddress);
    },
    { token, walletAddress },
  );
  await page.reload();
  await page.waitForSelector(".brand");
  await page.waitForFunction(() => {
    const label = document.querySelector("[data-auth-label]")?.textContent ?? "";
    return /Wallet|Signed in/i.test(label);
  }, null, { timeout: 15000 });
  const authLabel = await page.locator("[data-auth-label]").innerText();
  steps.push({
    step: "signed-in label (no Dev signer)",
    ok: !/Dev signer/i.test(authLabel) && /Wallet|Signed in/i.test(authLabel),
    authLabel,
  });

  await page.waitForSelector("a[href*='#/matches/'], .empty, .card", { timeout: 15000 });
  const matches = await page.locator("a[href*='#/matches/']").count();
  const pageText = await page.locator(".shell").innerText();
  steps.push({
    step: "matches listed",
    ok: matches > 0 || /DEMO|Northbridge|Riverdale|match/i.test(pageText),
    matches,
    snippet: pageText.slice(0, 240),
  });

  if (matches > 0) {
    await page.locator("a[href*='#/matches/']").first().click();
    await page.waitForTimeout(800);
    steps.push({ step: "match detail loads", ok: /matches\//.test(page.url()), url: page.url() });
  }

  const og = await page.request.get(
    `${BASE}/share/contest/be7892b3-023e-488a-83a7-0505e5101f07/og.png`,
  );
  steps.push({
    step: "OG image",
    ok: og.status() === 200,
    contentType: og.headers()["content-type"],
  });

  const failed = steps.filter((s) => !s.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, base: BASE, steps }, null, 2));
  if (failed.length) process.exit(1);
} finally {
  await browser.close();
}
