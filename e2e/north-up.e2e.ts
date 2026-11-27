/**
 * Body-centred inertial views put the centre body's north pole straight up on
 * screen (Chromium): the projected north end of the rotation axis sits directly
 * above the body's screen centre, from any turntable azimuth and elevation.
 */
import { expect, test, type Page } from '@playwright/test';

const BASE = 'http://localhost:4173';
const SHOTS = process.env.NORTH_UP_SHOTS ?? 'test-results/north-up';

test.skip(({ browserName }) => browserName !== 'chromium', 'rendering checks run in Chromium');

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`${BASE}/#${hash}`);
  await page.waitForFunction(() => {
    const s = (window as any).sendit;
    return s && s.store.get().loadingTarget === null && s.metrics.frameIntervalMs > 0;
  }, null, { timeout: 120_000 });
}

async function expectNorthUp(page: Page, body: string): Promise<void> {
  for (const [az, el] of [[-Math.PI / 2, 0.45], [0.3, 0.05], [2.4, -0.6], [4.0, 1.1]]) {
    await page.evaluate(([az, el]) => { const c = (window as any).sendit.camera; c.stop(); c.azimuth = az; c.elevation = el; }, [az, el]);
    await page.waitForTimeout(300);
    const p = await page.evaluate((b) => (window as any).sendit.poleOnScreen(b), body);
    expect(p, `${body} pole on screen at az ${az}`).not.toBeNull();
    expect(Math.abs(p.nx - p.cx), `${body} pole x vs centre x at az ${az}, el ${el}`).toBeLessThan(1.5);
    expect(p.ny, `${body} pole above centre at az ${az}, el ${el}`).toBeLessThan(p.cy - 10);
  }
}

test('Earth- and Mars-centred inertial views have north up', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 't=2024-06-20T12:00:00&frame=in:earth&focus=earth&dist=4e7');
  await page.evaluate(() => { (window as any).sendit.viewSettings.showAxis = true; (window as any).sendit.viewSettings.showEquator = true; });
  await expectNorthUp(page, 'earth');
  await page.evaluate(() => { const c = (window as any).sendit.camera; c.azimuth = -Math.PI / 2; c.elevation = 0.25; });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/earth-centred.png` });
  await page.evaluate(() => {
    const s = (window as any).sendit;
    const m = s.bodies.indexOf('mars');
    s.store.set({ focus: m, frame: { kind: 'inertial', center: m } });
    s.camera.setDistance(2.2e7, true);
  });
  await page.waitForTimeout(1500);
  await expectNorthUp(page, 'mars');
  await page.screenshot({ path: `${SHOTS}/mars-centred.png` });
});
