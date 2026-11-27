/**
 * The Orbit panel and the time-display setting, in Chromium at desktop and
 * phone sizes:
 *  - geostationary: after the transfer burn the osculating apoapsis is near
 *    geostationary altitude, and it changes when the cursor crosses the burn;
 *  - lunar flyby: inside the Moon's sphere of influence the reference body
 *    switches to the Moon, the periapsis agrees with the closest-approach
 *    event, and the hyperbolic quantities appear;
 *  - toggling MET / UTC changes the timeline, a node row, an event row and
 *    the Orbit panel together; a node time can be typed in either mode.
 * Screenshots go to test-results/orbit/.
 */
import { expect, test, type Page } from '@playwright/test';
import { referenceOf, solveGeo } from './geo';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/orbit';
test.skip(({ browserName }) => browserName === 'firefox', 'Firefox: these flows run in Chromium and WebKit; Firefox has the smaller smoke.e2e.ts (and CI Linux Firefox has no WebGL)');
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  return errors;
}
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}
async function fresh(page: Page, mission: string): Promise<void> {
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await settled(page); // WebKit reports the outgoing page's in-flight worker fetches as errors if it is reloaded mid-load
  await page.goto(`${BASE}/`);
  await settled(page);
  await page.evaluate((m) => (window as any).sendit.editor.selectMission(m), mission);
  await settled(page);
}
const setT = async (page: Page, tm: number) => {
  await page.evaluate((x) => { const w = (window as any).sendit; w.store.set({ t: w.store.get().plan.epoch + x, paused: true, loadingTarget: w.store.get().plan.epoch + x }); }, tm);
  await page.waitForFunction(() => (window as any).sendit.store.get().loadingTarget === null);
  await page.waitForTimeout(150);
};
const orbit = (page: Page) => page.evaluate(() => (window as any).sendit.orbit());
async function openTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name });
  if (await tab.count()) await tab.first().click();
}

for (const [size, opts] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['phone', PHONE]] as const) {
  test.describe(size, () => {
    test.use(opts as any);

    test('status line and Orbit panel show the same orbit (one computation) at several times in a flight', async ({ page }) => {
      test.setTimeout(300_000);
      await fresh(page, 'geo-from-leo');
      await solveGeo(page);
      await openTab(page, 'Orbit');
      const p = await page.evaluate(() => { const s = (window as any).sendit.store.get(); return { burns: s.plan.burns, duration: s.plan.duration }; });
      const times = [p.burns[0].start - 300, p.burns[0].start + p.burns[0].duration + 900, p.burns[1].start - 600, p.duration - 3600];
      const n = (x: string) => Number(x.replace(/,/g, ''));
      for (const tm of times) {
        await setT(page, tm);
        await page.waitForFunction(() => (window as any).sendit.orbit() !== null);
        const status = (await page.locator('.tb-status').textContent()) ?? '';
        const m = /At cursor · Earth orbit: Pe ([\d,]+) km alt · Ap ([\d,]+) km alt · i ([\d.]+)°/.exec(status);
        expect(m, `status at T+${tm}: ${status}`).not.toBeNull();
        const grid = (await page.locator('.orbit-grid').innerText()).replace(/\s+/g, ' ');
        const pe = /Periapsis ([\d,]+) km alt/.exec(grid), ap = /Apoapsis ([\d,]+) km alt/.exec(grid), inc = /Inclination ([\d.]+)°/.exec(grid);
        expect(pe && ap && inc, grid).toBeTruthy();
        // Same numbers to the displayed precision (status: 2 decimals of inclination, the panel 3).
        expect(n(m![1])).toBe(n(pe![1]));
        expect(n(m![2])).toBe(n(ap![1]));
        expect(m![3]).toBe(Number(inc![1]).toFixed(2));
      }
    });

    test('geostationary: transfer-orbit apoapsis near GEO after the burn, parking orbit before it; MET / UTC toggle everywhere', async ({ page }) => {
      test.setTimeout(300_000);
      const errors = watch(page);
      await fresh(page, 'geo-from-leo');
      await solveGeo(page);
      const b0 = await page.evaluate(() => (window as any).sendit.store.get().plan.burns[0]);
      await openTab(page, 'Orbit');
      await setT(page, b0.start - 300);
      const before = await orbit(page);
      expect(before.body).toBe('earth');
      expect((before.o.ra - 6378136.6) / 1000).toBeLessThan(400);
      await setT(page, b0.start + b0.duration + 900);
      const after = await orbit(page);
      const apoKm = (after.o.ra - 6378136.6) / 1000;
      console.log(`${size}: apoapsis ${((before.o.ra - 6378136.6) / 1000).toFixed(0)} km before the burn, ${apoKm.toFixed(0)} km after`);
      expect(Math.abs(apoKm - 35786)).toBeLessThan(1500);
      await expect(page.locator('.orbit-grid')).toContainText('Apoapsis');
      await expect(page.locator('.orbit-grid')).toContainText('Altitude above Earth');
      await expect(page.locator('.orbit-grid')).toContainText('SC Spacecraft'); // S3 separated after the transfer burn
      await page.screenshot({ path: `${SHOTS}/${size}-1-geo-transfer-orbit.png` });
      // Time display: MET -> UTC changes the timeline, node rows, event rows and the Orbit panel together.
      const grab = async () => ({
        tl: await page.locator('.scrub-met').textContent(),
        orbitNext: await page.locator('.orbit-grid').textContent(),
        node: await page.evaluate(() => document.querySelector('.node-row .nmet')?.textContent ?? ''),
        ev: await page.evaluate(() => document.querySelector('.event-row .emet')?.textContent ?? ''),
      });
      const met = await grab();
      expect(met.node).toMatch(/^T\+/);
      await page.locator('.scrub-met').click();
      await expect(page.locator('.scrub-met')).toContainText('UTC');
      const utc = await grab();
      expect(utc.node).toMatch(/UTC/);
      expect(utc.ev).toMatch(/UTC/);
      expect(utc.orbitNext).toMatch(/UTC/);
      expect(utc.tl).not.toBe(met.tl);
      await page.screenshot({ path: `${SHOTS}/${size}-2-utc.png` });
      // Type a node time in UTC: one minute later than shown.
      await page.evaluate(() => (window as any).sendit.store.set({ selectedNode: 1, selectedSeparation: null }));
      await openTab(page, 'Nodes');
      const t1 = await page.evaluate(() => (window as any).sendit.nodesOf()[1].node.t);
      const typed = await page.evaluate((x) => (window as any).sendit.fmtTime(x + 60, 1), t1);
      expect(typed).toMatch(/UTC/);
      await page.locator('input.met-input').fill(typed);
      await page.locator('input.met-input').press('Enter');
      await expect.poll(() => page.evaluate(() => (window as any).sendit.nodesOf()[1].node.t)).toBeCloseTo(t1 + 60, 0);
      // And in MET.
      await page.locator('.scrub-met').click(); // TDB
      await page.locator('.scrub-met').click(); // MET
      await page.locator('input.met-input').fill(`T+${new Date(t1 * 1000).toISOString().slice(11, 19)}`);
      await page.locator('input.met-input').press('Enter');
      await expect.poll(() => page.evaluate(() => (window as any).sendit.nodesOf()[1].node.t)).toBeCloseTo(Math.floor(t1), 0);
      expect(errors).toEqual([]);
    });

    test('lunar flyby: the Moon becomes the reference body inside its sphere; periapsis matches the closest approach; hyperbolic quantities', async ({ page }) => {
      test.setTimeout(300_000);
      const errors = watch(page);
      await fresh(page, 'lunar-flyby');
      const site = await page.evaluate(() => (window as any).sendit.store.get().plan.start.site);
      const ref = referenceOf('lunar-flyby', site);
      await page.evaluate(([p, d]) => {
        const w = (window as any).sendit;
        w.editor.setLaunch({ site: w.store.get().plan.start.site, time: p[0], azimuthDeg: p[1], altitudeM: p[2] });
        w.editor.setDuration(d);
      }, [ref.params, ref.duration] as const);
      const nodes = await page.evaluate(([b]) => (window as any).sendit.nodesOfBurns(b), [ref.burns] as const);
      await page.evaluate((n) => (window as any).sendit.editor.addNode(n.t, { kind: 'orbital', body: 'earth' }, n.dv), nodes[0]);
      await settled(page);
      const ca = await page.evaluate(() => { const s = (window as any).sendit.store.get(); return s.replay.result.events.find((e: any) => e.body === 'moon' && e.kind === 'periapsis'); });
      expect(ca).toBeTruthy();
      await openTab(page, 'Orbit');
      const ep = await page.evaluate(() => (window as any).sendit.store.get().plan.epoch);
      await setT(page, ca.t - ep - 1800);
      const o = await orbit(page);
      expect(o.body).toBe('moon');
      console.log(`${size}: osculating periselene ${(o.o.rp / 1000).toFixed(1)} km from the centre vs closest approach ${(ca.distance / 1000).toFixed(1)} km`);
      expect(Math.abs(o.o.rp - ca.distance) / ca.distance).toBeLessThan(0.03);
      await expect(page.locator('.orbit-title')).toContainText('Moon');
      await expect(page.locator('.orbit-grid')).toContainText('Hyperbolic excess speed');
      await expect(page.locator('.orbit-grid')).toContainText('C3');
      await expect(page.locator('.orbit-grid')).toContainText('none (escape)');
      await expect(page.locator('.orbit-grid .real')).toContainText(['Periapsis (replay)']);
      await page.screenshot({ path: `${SHOTS}/${size}-3-lunar-flyby-moon.png` });
      expect(errors).toEqual([]);
    });
  });
}
