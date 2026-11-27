/**
 * A short smoke run of the built site that every engine gets, Firefox included
 * (the full UI suites run in Chromium and WebKit only, to bound the run time).
 *
 *  1. Load: the map starts; or, where the engine has no WebGL at all (headless
 *     Firefox on Linux, as in CI), the page says so instead of staying blank.
 *  2. Mission, launch typed by keyboard, replay in the worker, share link opened
 *     in a fresh context gives the same plan.
 *  3. The planner computes a porkchop in its worker and a click selects a cell.
 *
 * Without WebGL only test 1 can run; 2 and 3 are skipped with the reason shown.
 * REQUIRE_WEBGL=1 (CI's Firefox job) turns a missing WebGL into a failure instead, so a broken Xvfb cannot go green.
 */
import { expect, test, type Page } from '@playwright/test';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/smoke';

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

const REQUIRE_WEBGL = process.env.REQUIRE_WEBGL === '1';
const hasWebGL = async (page: Page) => {
  // Asked a few times: under Xvfb the first context of a fresh Firefox sometimes fails while its GPU process
  // is still starting (seen on CI: one page without WebGL, the next two with it).
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) {
    ok = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
    if (!ok) await page.waitForTimeout(1000);
  }
  if (!ok && REQUIRE_WEBGL) throw new Error('REQUIRE_WEBGL=1 but this engine has no WebGL here (headed Firefox under Xvfb should have it)');
  return ok;
};

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}

/** Fresh state, one navigation (a reload mid-load makes WebKit log the aborted worker fetches). */
async function open(page: Page, url = `${BASE}/`): Promise<string[]> {
  const errors = watch(page);
  await page.addInitScript(() => localStorage.clear());
  await page.goto(url);
  test.skip(!(await hasWebGL(page)), 'this engine has no WebGL here (headless Firefox on Linux): only the load test runs');
  await settled(page);
  return errors;
}

test.use({ viewport: { width: 1280, height: 800 } });

test('load: the map starts, or without WebGL the page says why', async ({ page }) => {
  const errors = watch(page);
  await page.goto(`${BASE}/`);
  if (!(await hasWebGL(page))) {
    test.info().annotations.push({ type: 'no-webgl', description: 'checked the WebGL-unavailable message only' });
    await expect(page.getByRole('alert')).toContainText('could not create a WebGL context');
    expect(await page.evaluate(() => document.documentElement.dataset.appError)).toContain('WebGL');
    return;
  }
  await settled(page);
  expect(await page.evaluate(() => document.documentElement.dataset.appError)).toBeUndefined();
  expect(await page.evaluate(() => (window as any).sendit.renders())).toBeGreaterThan(0);
  await expect(page.locator('#hud')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-load.png` });
  expect(errors).toEqual([]);
});

test('mission, launch typed, replay, share link in a fresh context', async ({ page, browser }) => {
  const errors = await open(page);
  await page.locator('select.mission-select').selectOption('lunar-flyby', { force: true });
  await settled(page);
  const start = page.getByRole('tab', { name: 'Start' });
  if (await start.isVisible()) await start.click();
  const az = page.locator('input[title^="Inertial launch azimuth"]');
  await az.fill('62,7669'); // decimal comma accepted
  await az.press('Enter');
  await settled(page);
  expect(await page.evaluate(() => JSON.stringify((window as any).sendit.store.get().plan.start))).toContain('62.7669');
  const url: string = await page.evaluate(() => (window as any).sendit.shareUrl());
  const outcome = await page.evaluate(() => (window as any).sendit.store.get().replay.result.outcome);
  expect(outcome).toBeTruthy();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p2 = await ctx.newPage();
  const e2 = watch(p2);
  await p2.goto(url);
  await settled(p2);
  // The link is the plan's canonical encoding: the opened page must encode back to the same link, with the same outcome.
  expect(await p2.evaluate(() => (window as any).sendit.shareUrl())).toBe(url);
  expect(await p2.evaluate(() => (window as any).sendit.store.get().replay.result.outcome)).toBe(outcome);
  await ctx.close();
  expect(errors).toEqual([]);
  expect(e2).toEqual([]);
});

test('planner: porkchop computed in its worker, a click selects a transfer', async ({ page }) => {
  const errors = await open(page);
  await page.evaluate(() => (window as any).sendit.planner.open('transfer'));
  const pl = page.locator('.planner');
  await pl.getByRole('button', { name: 'Compute porkchop' }).click();
  await expect(pl.locator('.pl-status')).toContainText('transfers in', { timeout: 60_000 });
  const c = pl.locator('.pl-canvas');
  await c.scrollIntoViewIfNeeded();
  const b = (await c.boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await expect(pl.locator('.pl-readout')).toContainText(/Selected transfer|No transfer/);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-planner.png` });
  expect(errors).toEqual([]);
});
