/**
 * Planner flows in the built site (Chromium): Earth->Mars and Earth->Venus
 * porkchops for the 2026 windows, pick the minimum, insert the departure burn
 * (with the proposed launch), refine to a flyby and confirm the closest
 * approach in the real replay; "target this flyby" on a lunar transfer; the
 * flyby-chain check; the planner at a phone viewport with touch; check.html.
 * Timings are printed; screenshots go to test-results/planner/.
 */
import { expect, test, type Page } from '@playwright/test';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/planner';

test.skip(({ browserName }) => browserName !== 'chromium', 'planner flows run in Chromium');
test.describe.configure({ mode: 'serial' });

const errors: string[] = [];
function watch(page: Page): void {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
}

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null;
  }, null, { timeout: 120_000 });
}

async function fresh(page: Page): Promise<void> {
  watch(page);
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/`);
  await settled(page);
}

/** Closest approach (altitude, m) to `body` in the replay currently in the store. */
async function replayClosest(page: Page, body: string): Promise<number> {
  await settled(page);
  return page.evaluate((b) => {
    const r = (window as any).sendit.store.get().replay.result;
    const alts = r.events.filter((e: any) => e.body === b && (e.kind === 'periapsis' || e.kind === 'impact' || e.kind === 'atmosphere-entry')).map((e: any) => e.altitude);
    return alts.length ? Math.min(...alts) : Infinity;
  }, body);
}

async function timed<T>(label: string, log: string[], f: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const r = await f();
  log.push(`${label} ${Date.now() - t0} ms`);
  return r;
}

async function transferFlow(page: Page, arrival: string, dates: [string, string, string, string], altKm: number, shot: string): Promise<{ log: string[]; status: string; ca: number }> {
  const log: string[] = [];
  await page.getByRole('button', { name: 'Transfer planner…' }).click();
  const pl = page.locator('.planner');
  await pl.locator('select[title="Arrival body"]').selectOption(arrival);
  const [a, b, c, d] = dates;
  await pl.locator('input[title="Earliest departure"]').fill(a);
  await pl.locator('input[title="Latest departure"]').fill(b);
  await pl.locator('input[title="Earliest arrival"]').fill(c);
  await pl.locator('input[title="Latest arrival"]').fill(d);
  await timed('porkchop (click to drawn)', log, async () => {
    await pl.getByRole('button', { name: 'Compute porkchop' }).click();
    await expect(pl.locator('.pl-status')).toContainText('transfers in', { timeout: 60_000 });
  });
  const status = (await pl.locator('.pl-status').textContent())!;
  await pl.getByRole('button', { name: 'Select minimum' }).click();
  await page.screenshot({ path: `${SHOTS}/${shot}-porkchop.png` });
  await timed('insert departure burn', log, async () => {
    await pl.getByRole('button', { name: 'Insert departure burn' }).click();
    await expect(pl.locator('.pl-use .pl-result')).toContainText('Inserted burn', { timeout: 60_000 });
  });
  await pl.locator('input[title="Closest-approach altitude, km"]').first().fill(String(altKm));
  await timed('refine (corrector + replay in worker)', log, async () => {
    await pl.getByRole('button', { name: 'Refine' }).click();
    await page.waitForFunction(() => document.querySelector('.pl-use .pl-result')?.getAttribute('data-ok') !== null, null, { timeout: 120_000 });
  });
  const ok = await pl.locator('.pl-use .pl-result').getAttribute('data-ok');
  log.push(`result: ${(await pl.locator('.pl-use .pl-result').innerText()).replace(/\s*\n\s*/g, ' | ')}`);
  expect(ok).toBe('true');
  await page.screenshot({ path: `${SHOTS}/${shot}-refined.png` });
  const ca = await timed('scoring replay redrawn', log, () => replayClosest(page, arrival));
  await pl.getByRole('button', { name: 'Close planner' }).click();
  await page.screenshot({ path: `${SHOTS}/${shot}-map.png` });
  return { log, status, ca };
}

test('Earth to Mars 2026: porkchop minimum, departure, refine to 500 km, confirmed by the replay', async ({ page }) => {
  await fresh(page);
  const r = await transferFlow(page, 'mars', ['2026-09-01', '2026-12-31', '2027-06-01', '2027-11-01'], 500, '1-mars');
  console.log(`Mars: ${r.status}\n  ${r.log.join('\n  ')}\n  replay closest approach ${(r.ca / 1e3).toFixed(1)} km`);
  const c3 = Number(/Minimum C3 ([\d.]+)/.exec(r.status)![1]);
  const dep = /departing (\d{4}-\d{2}-\d{2})/.exec(r.status)![1];
  expect(c3).toBeGreaterThan(8.5);
  expect(c3).toBeLessThan(11.5);
  expect(dep >= '2026-10-20' && dep <= '2026-11-20').toBe(true);
  expect(Math.abs(r.ca - 500e3)).toBeLessThan(50e3);
  expect(errors).toEqual([]);
});

test('Earth to Venus 2026: refine to 1000 km, confirmed by the replay', async ({ page }) => {
  await fresh(page);
  const r = await transferFlow(page, 'venus', ['2026-03-01', '2026-08-31', '2026-06-01', '2027-02-01'], 1000, '2-venus');
  console.log(`Venus: ${r.status}\n  ${r.log.join('\n  ')}\n  replay closest approach ${(r.ca / 1e3).toFixed(1)} km`);
  expect(Math.abs(r.ca - 1000e3)).toBeLessThan(50e3);
  expect(errors).toEqual([]);
});

test('target this flyby: a lunar transfer burn retargeted to 300 km', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => {
    const w = (window as any).sendit;
    const t = Date.UTC(2027, 0, 10, 20, 23, 4) / 1000 - Date.UTC(2000, 0, 1, 12) / 1000;
    w.editor.setLaunch({ site: 'kourou', time: t, azimuthDeg: 62.7669, altitudeM: 200e3 });
    w.editor.addNode(3019.5, { kind: 'orbital', body: 'earth' }, [3100, 0, 0]);
  });
  const before = await replayClosest(page, 'moon');
  await page.locator('.node-row').first().click();
  await page.getByRole('button', { name: 'Target flyby…' }).click();
  const pl = page.locator('.planner');
  await pl.locator('select[title="Flyby body"]').selectOption('moon');
  await pl.locator('.pl-target input[title="Closest-approach altitude, km"]').fill('300');
  const t0 = Date.now();
  await pl.getByRole('button', { name: 'Target this flyby' }).click();
  await page.waitForFunction(() => document.querySelector('.pl-target .pl-result')?.getAttribute('data-ok') !== null, null, { timeout: 120_000 });
  const ms = Date.now() - t0;
  expect(await pl.locator('.pl-target .pl-result').getAttribute('data-ok')).toBe('true');
  await page.screenshot({ path: `${SHOTS}/3-moon-target.png` });
  const ca = await replayClosest(page, 'moon');
  console.log(`Moon: before ${(before / 1e3).toFixed(0)} km, after ${(ca / 1e3).toFixed(1)} km (requested 300), ${ms} ms click to result`);
  await pl.getByRole('button', { name: 'Close planner' }).click();
  await page.evaluate(() => (window as any).sendit.store.set({ frame: { kind: 'inertial', center: 3 } }));
  await page.screenshot({ path: `${SHOTS}/3-moon-map.png` });
  expect(Math.abs(ca - 300e3)).toBeLessThan(30e3);
  expect(errors).toEqual([]);
});

test('campaign: Mars flyby solved through the planner UI', async ({ page }) => {
  await fresh(page);
  await page.selectOption('select.mission-select', 'mars-flyby');
  await settled(page);
  const r = await transferFlow(page, 'mars', ['2028-09-01', '2029-03-01', '2029-05-01', '2030-03-01'], 2000, '6-campaign-mars');
  const ev = await page.evaluate(() => {
    const s = (window as any).sendit.store.get();
    const e = s.replay.evaluation;
    return { missionId: s.missionId, success: e?.success, keys: e?.keys, objectives: e?.objectives.map((o: any) => `${o.ok ? 'ok' : 'NO'} ${o.detail}`), rules: e?.ruleViolations };
  });
  console.log(`Campaign Mars flyby: ${r.status}\n  ${r.log.join('\n  ')}\n  replay closest ${(r.ca / 1e3).toFixed(1)} km; evaluation ${JSON.stringify(ev)}`);
  await page.screenshot({ path: `${SHOTS}/6-campaign-mars-result.png` });
  expect(ev.missionId).toBe('mars-flyby');
  expect(ev.success).toBe(true);
  expect(errors).toEqual([]);
});

test('flyby chain plausibility check and date search', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: 'Transfer planner…' }).click();
  const pl = page.locator('.planner');
  await pl.getByRole('tab', { name: 'Flyby chain' }).click();
  await pl.getByRole('button', { name: 'Check these dates' }).click();
  await expect(pl.locator('.pl-chain .pl-table')).toBeVisible({ timeout: 60_000 });
  const t0 = Date.now();
  await pl.getByRole('button', { name: 'Search dates' }).click();
  await expect(pl.locator('.pl-chain .pl-result')).toContainText('evaluations', { timeout: 120_000 });
  console.log(`chain search ${Date.now() - t0} ms: ${(await pl.locator('.pl-chain .pl-result .pl-ok, .pl-chain .pl-result .pl-fail').first().textContent())?.slice(0, 200)}`);
  await page.screenshot({ path: `${SHOTS}/4-chain.png` });
  expect(errors).toEqual([]);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  test('planner at 390 x 844 with touch: compute, tap and drag the chart, no horizontal scroll', async ({ page }) => {
    await fresh(page);
    await page.evaluate(() => (window as any).sendit.planner.open('transfer'));
    const pl = page.locator('.planner');
    await pl.getByRole('button', { name: 'Compute porkchop' }).tap();
    await expect(pl.locator('.pl-status')).toContainText('transfers in', { timeout: 60_000 });
    const box = (await pl.locator('.pl-canvas').boundingBox())!;
    // Tap selects a cell.
    await page.touchscreen.tap(box.x + box.width * 0.45, box.y + box.height * 0.5);
    await expect(pl.locator('.pl-readout')).toContainText('Selected transfer');
    // Finger drag across the chart updates the readout (pointer events).
    const cdp = await page.context().newCDPSession(page);
    const pts = [0.3, 0.4, 0.5, 0.6].map((f) => ({ x: box.x + box.width * f, y: box.y + box.height * 0.45 }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pts[0]] });
    for (const p of pts.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
    await expect(pl.locator('.pl-readout')).toContainText('Under pointer');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const dims = await page.evaluate(() => {
      const p = document.querySelector('.planner') as HTMLElement;
      const c = document.querySelector('.pl-canvas') as HTMLCanvasElement;
      const small = [...p.querySelectorAll('button, select, input')].filter((e) => (e as HTMLElement).offsetParent && (e as HTMLElement).getBoundingClientRect().height < 43).map((e) => (e as HTMLElement).textContent || (e as HTMLElement).title);
      return { sw: p.scrollWidth, cw: p.clientWidth, docW: document.documentElement.scrollWidth, vw: innerWidth, canvasPx: c.width, canvasCss: c.getBoundingClientRect().width, small };
    });
    console.log(`phone: ${JSON.stringify(dims)}`);
    await page.screenshot({ path: `${SHOTS}/5-phone-chart.png` });
    await pl.evaluate((e) => e.scrollTo(0, e.scrollHeight));
    await page.screenshot({ path: `${SHOTS}/5-phone-bottom.png` });
    expect(dims.sw).toBeLessThanOrEqual(dims.cw);
    expect(dims.docW).toBeLessThanOrEqual(dims.vw);
    expect(dims.canvasPx).toBeGreaterThanOrEqual(dims.canvasCss * 2.9);
    expect(dims.small).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('check.html still reports PASS', async ({ page }) => {
  await page.goto(`${BASE}/check.html`);
  await expect(page.locator('body')).toContainText('PASS', { timeout: 120_000 });
});
