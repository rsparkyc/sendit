/**
 * Ephemeris scheduling in the viewer, measured in the built site (Chromium):
 *  - jump 40 years ahead (2027 -> 2067) and time until the view shows that date;
 *  - warp at one year per second for 8 s: simulated time actually covered, and
 *    the share of frames spent waiting for chunks;
 *  - jump back to 1955 (near the start of the checkpoint asset).
 * Numbers are printed; screenshots go to test-results/scheduling/.
 */
import { expect, test, type Page } from '@playwright/test';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/scheduling';
const YEAR = 365.25 * 86400;

test.skip(({ browserName }) => browserName !== 'chromium', 'timing flows run in Chromium');
test.describe.configure({ mode: 'serial' });

const errors: string[] = [];

async function open(page: Page): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.loadingTarget === null && s.replay !== null;
  }, null, { timeout: 120_000 });
}

async function jump(page: Page, years: number): Promise<number> {
  return page.evaluate(async (dy) => {
    const w = window as any;
    const s = w.sendit.store.get();
    const target = s.t + dy * 365.25 * 86400;
    const t0 = performance.now();
    w.sendit.store.set({ loadingTarget: target, paused: true });
    await new Promise<void>((res) => {
      const f = () => (w.sendit.store.get().loadingTarget === null ? res() : requestAnimationFrame(f));
      f();
    });
    return performance.now() - t0;
  }, years);
}

test('jump 40 years and warp at one year per second', async ({ page }) => {
  await open(page);
  const jumpMs = await jump(page, 40);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/1-after-jump-40y.png` });
  const warp = await page.evaluate(async (YEAR) => {
    const w = window as any;
    const st = w.sendit.store;
    const idx = [1, 10, 100, 1e3, 1e4, 86400 / 4, 86400, 7 * 86400, 30 * 86400, 0.25 * YEAR, YEAR, 3 * YEAR].indexOf(YEAR);
    const tStart = st.get().t;
    let frames = 0;
    let waiting = 0;
    st.set({ warpIndex: idx, paused: false });
    const t0 = performance.now();
    await new Promise<void>((res) => {
      const f = () => {
        frames++;
        if (st.get().loadingTarget !== null) waiting++;
        if (performance.now() - t0 > 8000) res();
        else requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    });
    const wall = (performance.now() - t0) / 1000;
    st.set({ paused: true });
    return { simYears: (st.get().t - tStart) / YEAR, wall, frames, waiting, chunks: w.sendit.eph.chunks().length };
  }, YEAR);
  await page.screenshot({ path: `${SHOTS}/2-after-warp.png` });
  const backMs = await jump(page, 1955 - 2067 - 0.5);
  const chunks = await page.evaluate(() => (window as any).sendit.eph.chunks().length);
  console.log(
    `jump +40 y: ${jumpMs.toFixed(0)} ms; warp 1 y/s for ${warp.wall.toFixed(1)} s: covered ${warp.simYears.toFixed(2)} y ` +
      `(${(warp.simYears / warp.wall).toFixed(2)} y/s), ${warp.waiting}/${warp.frames} frames waiting, ${warp.chunks} chunks held; ` +
      `jump to 1955: ${backMs.toFixed(0)} ms, ${chunks} chunks held`,
  );
  expect(errors).toEqual([]);
});
