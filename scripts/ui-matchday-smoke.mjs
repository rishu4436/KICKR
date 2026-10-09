/* global process, document, innerWidth, scrollTo, location, sessionStorage, fetch, console */
/** Browser regression for the fictional FREE demo. Creates a demo account and entry.
 * Run against a local demo API: BASE_URL=http://127.0.0.1:4173 node scripts/ui-matchday-smoke.mjs
 * Screenshots are written to the ignored dist/ui-check directory.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
await mkdir('dist/ui-check', { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
try {
  await page.goto(base);
  await page.locator('.hero-title').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'dist/ui-check/landing-desktop.png', fullPage: true });
  assert(!await overflow(), 'Desktop landing overflow');
  await page.locator('[data-scroll="how"]').click();
  assert(await page.locator('.hero-title').count() === 1, 'Anchor navigation replaced landing');
  for (const width of [390, 320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    assert(!await overflow(), `Landing overflow at ${width}`);
    await page.screenshot({ path: `dist/ui-check/landing-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.locator('#play-free').click();
  const matchCta = page.locator('[data-build], [data-tutorial]').first();
  await matchCta.waitFor();
  await page.screenshot({ path: 'dist/ui-check/matches-desktop.png', fullPage: true });
  await matchCta.click();
  await page.locator('#tut-build, #q').first().waitFor();
  if (await page.locator('#tut-build').isVisible()) await page.locator('#tut-build').click();
  await page.locator('#q').waitFor();
  let requests = 0;
  page.on('request', request => { if (/\/matches/.test(request.url()) && request.resourceType() === 'fetch') requests++; });
  await page.locator('#q').pressSequentially('Jonah', { delay: 80 });
  assert(await page.locator('#q').inputValue() === 'Jonah', 'Search lost characters');
  assert(await page.locator('#q').evaluate(el => el === document.activeElement), 'Search lost focus');
  assert(await page.locator('.player').count() === 1, 'Search did not filter');
  assert(requests === 0, 'Search refetched builder data');
  await page.locator('#q').fill('');
  const selection = await page.evaluate(async () => {
    const matchId = location.hash.split('/')[2];
    const headers = { authorization: `Bearer ${sessionStorage.getItem('kickr.session.token')}` };
    const { players } = await (await fetch(`/matches/${matchId}/players`, { headers })).json();
    const selected = [];
    for (const [position, count] of [['GK', 1], ['DEF', 4], ['MID', 3], ['FWD', 3]]) {
      selected.push(...players.filter(p => p.position === position).sort((a, b) => a.credit - b.credit).slice(0, count));
    }
    if (new Set(selected.map(p => p.clubId)).size < 2) {
      const replacement = players.find(p => p.position === 'FWD' && p.clubId !== selected[0].clubId);
      selected[selected.length - 1] = replacement;
    }
    return selected.map(p => p.playerId);
  });
  requests = 0;
  for (const id of selection) await page.locator(`[data-toggle="${id}"]`).click();
  await page.locator(`[data-cap="${selection[0]}"]`).click();
  await page.locator(`[data-vice="${selection[1]}"]`).click();
  assert(requests === 0, 'Picking players refetched data');
  assert(await page.locator('#save-xi').isEnabled(), 'Valid XI not saveable');
  await page.screenshot({ path: 'dist/ui-check/builder-desktop.png', fullPage: true });
  for (const width of [390, 320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    assert(!await overflow(), `Builder overflow at ${width}`);
    assert(await page.locator('.pitch .chip.selected-slot').count() === 11, 'Missing pitch players');
    await page.screenshot({ path: `dist/ui-check/builder-${width}.png`, fullPage: true });
  }
  await page.locator('#save-xi').click();
  await page.waitForFunction(() => document.querySelector('#saved')?.textContent?.includes('Saved version'));
  await page.locator('#to-contests').click();
  const contestId = await page.locator('[data-join]').first().getAttribute('data-join');
  await page.locator(`[data-join="${contestId}"]`).click();
  await page.waitForFunction(() => document.querySelector('#join-note')?.textContent?.includes('Entry confirmed'));
  await page.locator(`[data-board="${contestId}"]`).click();
  await page.locator('#live-board .lb-row').first().waitFor();
  await page.waitForFunction(() => document.querySelector('#board-status')?.dataset.connected === 'true');
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.screenshot({ path: 'dist/ui-check/leaderboard-desktop.png', fullPage: true });
  assert(errors.length === 0, `Browser errors: ${errors.join(', ')}`);
  console.log(JSON.stringify({ ok: true, searchPreservesFocus: true, localSelection: true, savedAndJoined: true, liveConnected: true, widths: [320, 390, 768, 1440], errors }));
} catch (error) { console.log(await page.locator('body').innerText()); await page.screenshot({ path: 'dist/ui-check/failure.png', fullPage: true }); throw error; } finally { await browser.close(); }
