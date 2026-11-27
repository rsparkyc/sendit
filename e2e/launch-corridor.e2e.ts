/**
 * The launch charts keep the plan inside what is allowed, and update live while dragged (Chromium):
 *  - dragging the azimuth marker far into the red stops it on the corridor limit (exactly), with the
 *    plan, cost line and replay following during the drag, and one undo step after release;
 *  - a press inside the red snaps to the nearest limit; a touch drag does the same;
 *  - typing an azimuth outside the corridor keeps the nearest limit.
 * Mission "plane-change" launches from Cape Canaveral, corridor 35°–120°; the chart spans 18°–137°.
 */
import { expect, test, type Page } from '@playwright/test';

const BASE = 'http://localhost:4173';
test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');

const AZ0 = 18, AZ1 = 137; // drawn azimuth range: corridor ± max(10, 20 %)
const W = 320, ML = 44, MR = 18;

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}

async function setup(page: Page): Promise<void> {
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/`);
  await settled(page);
  await page.evaluate(() => (window as any).sendit.editor.selectMission('plane-change'));
  await settled(page);
  const tab = page.getByRole('tab', { name: 'Start' });
  if (await tab.count()) await tab.first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('.chart')].every((c) => (c as HTMLElement).dataset.complete === 'true'), null, { timeout: 30_000 });
  await page.locator('.az-chart svg').scrollIntoViewIfNeeded();
}

const az = (page: Page) => page.evaluate(() => (window as any).sendit.store.get().plan.start.params[1] as number);
const undoDepth = (page: Page) => page.evaluate(() => (window as any).sendit.editor.history.past.length as number);
async function xOf(page: Page, deg: number): Promise<{ x: number; y: number }> {
  const b = (await page.locator('.az-chart svg').boundingBox())!;
  return { x: b.x + (b.width * (ML + ((deg - AZ0) / (AZ1 - AZ0)) * (W - ML - MR))) / W, y: b.y + b.height * 0.5 };
}
/** Marker x and the right-hand red region's left edge, in SVG units. */
const markerAndEdge = (page: Page) => page.evaluate(() => {
  const cur = Number(document.querySelector('.az-chart line.cur')!.getAttribute('x1'));
  const outs = [...document.querySelectorAll('.az-chart rect.out')].map((r) => Number(r.getAttribute('x')));
  return { cur, right: Math.max(...outs) };
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('mouse drag into the red stops at the limit, updates live, one undo step', async ({ page }) => {
    await setup(page);
    const title = await page.locator('.az-chart rect.out title').first().textContent();
    expect(title).toContain('launch corridor (35°–120°)');
    expect(await page.locator('.az-chart rect.out').first().evaluate((r) => getComputedStyle(r).cursor)).toBe('not-allowed');
    const cost0 = await page.locator('.launch-cost .lc-main').textContent();
    const depth0 = await undoDepth(page);
    const runs0 = await page.evaluate(() => (window as any).sendit.replayStats.runs);
    const start = await xOf(page, 60);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const t0 = Date.now();
    const costs = new Set<string>();
    for (let i = 1; i <= 40; i++) { // 60° → 110° over ~0.7 s, then far into the red
      const p = await xOf(page, 60 + (50 * i) / 40);
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(16);
      costs.add((await page.locator('.launch-cost .lc-main').textContent())!);
    }
    const mid = await page.evaluate(() => { const s = (window as any).sendit.store.get(); return { plan: s.plan.start.params[1], replay: s.replay?.plan.start.params[1] }; });
    const far = await xOf(page, 136);
    await page.mouse.move(far.x, far.y, { steps: 10 });
    await expect.poll(() => az(page)).toBe(120); // live, before release
    const dragMs = Date.now() - t0;
    await expect.poll(() => page.evaluate(() => (window as any).sendit.store.get().replay?.plan.start.params[1])).toBe(120);
    const runs = (await page.evaluate(() => (window as any).sendit.replayStats.runs)) - runs0;
    console.log(`drag ${dragMs} ms: ${runs} replays (${((runs * 1000) / dragMs).toFixed(1)}/s), ${costs.size} distinct cost lines over 40 moves; mid-drag plan ${mid.plan}°, replay ${mid.replay}°`);
    expect(mid.plan).toBeGreaterThan(100);
    expect(mid.replay).not.toBe(60);
    expect(costs.size).toBeGreaterThan(1);
    expect(await page.locator('.launch-cost .lc-main').textContent()).not.toBe(cost0);
    await page.mouse.up();
    expect(await az(page)).toBe(120);
    const m = await markerAndEdge(page);
    expect(Math.abs(m.cur - m.right)).toBeLessThan(0.11);
    expect(await undoDepth(page)).toBe(depth0 + 1);
    await settled(page);
    await page.evaluate(() => (window as any).sendit.editor.undo());
    expect(await az(page)).not.toBe(120);

    // A press inside the left red region snaps to the nearest limit.
    const red = await xOf(page, 25);
    await page.mouse.click(red.x, red.y);
    expect(await az(page)).toBe(35);

    // Typing outside the corridor keeps the nearest limit.
    const field = page.locator('input[title^="Inertial launch azimuth"]');
    await field.fill('200');
    await field.press('Enter');
    expect(await az(page)).toBe(120);
    await expect(field).toHaveValue('120');
  });
});

test.describe('touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test('touch drag into the red stops at the limit', async ({ page }) => {
    await setup(page);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, p?: { x: number; y: number }) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
    // Positions measured before the touch, as a finger would move (the chart re-renders while dragged).
    const pts = [];
    for (let i = 0; i <= 20; i++) pts.push(await xOf(page, 100 + (36 * i) / 20));
    await touch('touchStart', pts[0]);
    for (let i = 1; i <= 20; i++) {
      await touch('touchMove', pts[i]);
      await page.waitForTimeout(16);
    }
    await expect.poll(() => az(page)).toBe(120);
    await touch('touchEnd');
    expect(await az(page)).toBe(120);
    const m = await markerAndEdge(page);
    expect(Math.abs(m.cur - m.right)).toBeLessThan(0.11);
  });
});
