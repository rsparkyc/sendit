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

test.skip(({ browserName }) => browserName === 'firefox', 'Firefox: these flows run in Chromium and WebKit; Firefox has the smaller smoke.e2e.ts (and CI Linux Firefox has no WebGL)');
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
  await settled(page); // WebKit reports the outgoing page's in-flight worker fetches as errors if it is reloaded mid-load
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


/** Chart facts from the page: selection (dates, C3), cell spacing, and a screen box around a date pair. */
async function chartState(page: Page, padDays = 0) {
  return page.evaluate((padDays) => {
    const ch = (window as any).sendit.planner.chart;
    const g = ch.data;
    const k = ch.selected;
    const i = k % g.nDep;
    const j = (k - i) / g.nDep;
    const G = ch.geom();
    const r = ch.canvas.getBoundingClientRect();
    const dep = g.depTimes[i];
    const arr = g.arrTimes[j];
    const d = padDays * 86400;
    return {
      dep, arr, c3: g.c3[k] / 1e6,
      depStep: (g.depTimes[g.nDep - 1] - g.depTimes[0]) / (g.nDep - 1) / 86400,
      at: { x: r.left + G.xOf(dep), y: r.top + G.yOf(arr) },
      box: { x0: r.left + G.xOf(Math.max(G.t0x, dep - d)), y0: r.top + G.yOf(Math.min(G.t1y, arr + d)), x1: r.left + G.xOf(Math.min(G.t1x, dep + d)), y1: r.top + G.yOf(Math.max(G.t0y, arr - d)) },
      inputs: [...document.querySelectorAll('.planner input[type="date"]')].map((e) => (e as HTMLInputElement).value),
    };
  }, padDays);
}

/**
 * Scroll the planner so the chart sits just below its sticky header, then return the client point of a
 * chart cell ('min': the minimum-C3 cell) and check nothing covers it there.
 */
async function chartPoint(page: Page, which: 'min'): Promise<{ x: number; y: number; k: number }> {
  await page.locator('.planner').evaluate((e) => {
    const head = (e.querySelector('.pl-head') as HTMLElement).getBoundingClientRect().bottom;
    e.scrollBy(0, (e.querySelector('.pl-canvas') as HTMLElement).getBoundingClientRect().top - head - 8);
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const p = await page.evaluate((w) => {
    const ch = (window as any).sendit.planner.chart;
    const g = ch.data;
    let k = -1;
    for (let q = 0; q < g.c3.length; q++) if (Number.isFinite(g.c3[q]) && (k < 0 || g.c3[q] < g.c3[k])) k = q;
    void w;
    const i = k % g.nDep;
    const j = (k - i) / g.nDep;
    const G = ch.geom();
    const r = ch.canvas.getBoundingClientRect();
    const x = r.left + G.xOf(g.depTimes[i]);
    const y = r.top + G.yOf(g.arrTimes[j]);
    return { x, y, k, onCanvas: document.elementFromPoint(x, y) === ch.canvas, inView: y > 0 && y < innerHeight };
  }, which);
  expect(p.onCanvas && p.inView, `chart cell ${p.k} reachable at ${p.x.toFixed(0)}, ${p.y.toFixed(0)}`).toBe(true);
  return p;
}

async function computed(page: Page, before: string): Promise<void> {
  await page.waitForFunction((b) => {
    const t = document.querySelector('.planner .pl-status')?.textContent ?? '';
    return t !== b && /transfers in/.test(t);
  }, before, { timeout: 60_000 });
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


test('porkchop zoom: two box zooms into the Earth to Mars 2026 minimum, back and reset', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: 'Transfer planner…' }).click();
  const pl = page.locator('.planner');
  // Sandbox suggests the next window after its 2027 liftoff; this test is about the 2026 one.
  for (const [title, v] of [['Earliest departure', '2026-09-01'], ['Latest departure', '2026-12-31'], ['Earliest arrival', '2027-06-01'], ['Latest arrival', '2027-11-01']]) await pl.locator(`input[title="${title}"]`).fill(v);
  await pl.getByRole('button', { name: 'Compute porkchop' }).click();
  await expect(pl.locator('.pl-status')).toContainText('transfers in', { timeout: 60_000 });
  await pl.getByRole('button', { name: 'Select minimum' }).click();
  const s0 = await chartState(page, 15);
  for (const pad of [15, 4]) {
    const st = await chartState(page, pad);
    const before = (await pl.locator('.pl-status').textContent())!;
    await page.mouse.move(st.box.x0, st.box.y0);
    await page.mouse.down();
    await page.mouse.move((st.box.x0 + st.box.x1) / 2, (st.box.y0 + st.box.y1) / 2, { steps: 4 });
    await page.mouse.move(st.box.x1, st.box.y1, { steps: 4 });
    await page.mouse.up();
    await computed(page, before);
    await page.screenshot({ path: `${SHOTS}/7-zoom-${pad}.png` });
  }
  // The kept selection is marked; now pick the finer minimum by clicking it.
  await pl.getByRole('button', { name: 'Select minimum' }).click();
  const s2 = await chartState(page);
  await page.mouse.click(s2.at.x, s2.at.y);
  const s3 = await chartState(page);
  console.log(`zoom: unzoomed min dep ${new Date((s0.dep + 946728000) * 1000).toISOString()} C3 ${s0.c3.toFixed(3)} (cells ${s0.depStep.toFixed(2)} d); zoomed x2 dep ${new Date((s3.dep + 946728000) * 1000).toISOString()} C3 ${s3.c3.toFixed(3)} (cells ${s3.depStep.toFixed(3)} d); inputs ${s3.inputs.join(' ')}`);
  expect(s3.depStep).toBeLessThan(s0.depStep / 5);
  expect(Math.abs(s3.dep - s0.dep) / 86400).toBeLessThan(2 * s0.depStep);
  expect(Math.abs(s3.arr - s0.arr) / 86400).toBeLessThan(4 * s0.depStep);
  expect(s3.c3).toBeLessThanOrEqual(s0.c3 + 1e-6);
  expect(s3.c3).toBeGreaterThan(s0.c3 - 0.2);
  // Inputs follow the zoomed range.
  expect(s3.inputs[0] <= new Date((s3.dep + 946728000) * 1000).toISOString().slice(0, 10)).toBe(true);
  expect(s3.inputs[0]).not.toBe('2026-09-01');
  // Back, then reset to the original range.
  let before = (await pl.locator('.pl-status').textContent())!;
  await pl.getByRole('button', { name: 'Zoom out' }).click();
  await computed(page, before);
  before = (await pl.locator('.pl-status').textContent())!;
  await pl.getByRole('button', { name: 'Reset zoom' }).click();
  await computed(page, before);
  expect((await chartState(page)).inputs).toEqual(['2026-09-01', '2026-12-31', '2027-06-01', '2027-11-01']);
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
    test.skip(test.info().project.name !== 'chromium', 'drives touch through CDP Input.dispatchTouchEvent (Chromium only); the WebKit touch flow is mobile.e2e.ts');

    await fresh(page);
    await page.evaluate(() => (window as any).sendit.planner.open('transfer'));
    const pl = page.locator('.planner');
    await pl.getByRole('button', { name: 'Compute porkchop' }).tap();
    await expect(pl.locator('.pl-status')).toContainText('transfers in', { timeout: 60_000 });
    // Tap selects a cell. The point is computed from the chart's own geometry (the minimum-C3 cell, always a
    // solution) after scrolling the chart clear of the sticky header, and checked to be on the canvas: a fixed
    // fraction of the canvas box depended on font metrics (Linux fonts wrap the header onto more lines, so it
    // covered the old tap point and the tap never reached the chart).
    const target = await chartPoint(page, 'min');
    await page.touchscreen.tap(target.x, target.y);
    await expect(pl.locator('.pl-readout')).toContainText('Selected transfer');
    expect(await page.evaluate(() => (window as any).sendit.planner.chart.selected)).toBe(target.k);
    // Finger drag across the chart updates the readout (pointer events).
    const box = (await pl.locator('.pl-canvas').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const pts = [0.3, 0.4, 0.5, 0.6].map((f) => ({ x: box.x + box.width * f, y: box.y + box.height * 0.45 }));
    expect(await page.evaluate((ps) => ps.every((p) => document.elementFromPoint(p.x, p.y)?.classList.contains('pl-canvas')), pts), 'drag path on the chart').toBe(true);
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

  test('porkchop zoom by touch at 390 x 844: zoom box toggle, two zooms, tap a cell', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'drives touch through CDP Input.dispatchTouchEvent (Chromium only); the WebKit touch flow is mobile.e2e.ts');

    await fresh(page);
    await page.evaluate(() => (window as any).sendit.planner.open('transfer'));
    const pl = page.locator('.planner');
    await pl.getByRole('button', { name: 'Compute porkchop' }).tap();
    await expect(pl.locator('.pl-status')).toContainText('transfers in', { timeout: 60_000 });
    await pl.getByRole('button', { name: 'Select minimum' }).tap();
    const s0 = await chartState(page);
    await pl.getByRole('button', { name: 'Zoom box' }).tap();
    const cdp = await page.context().newCDPSession(page);
    for (const pad of [15, 4]) {
      // Bring the chart below the sticky planner header.
      await pl.evaluate((e) => e.scrollBy(0, (e.querySelector('.pl-canvas') as HTMLElement).getBoundingClientRect().top - 200));
      const st = await chartState(page, pad);
      const before = (await pl.locator('.pl-status').textContent())!;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: st.box.x0, y: st.box.y0 }] });
      for (let f = 0.25; f <= 1; f += 0.25) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: st.box.x0 + (st.box.x1 - st.box.x0) * f, y: st.box.y0 + (st.box.y1 - st.box.y0) * f }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await computed(page, before);
    }
    await pl.getByRole('button', { name: 'Zoom box' }).tap(); // back to reading values
    await pl.getByRole('button', { name: 'Select minimum' }).tap();
    const s2 = await chartState(page);
    await page.touchscreen.tap(s2.at.x, s2.at.y);
    const s3 = await chartState(page);
    await page.screenshot({ path: `${SHOTS}/8-phone-zoomed.png` });
    console.log(`phone zoom: C3 ${s0.c3.toFixed(3)} -> ${s3.c3.toFixed(3)}, cells ${s0.depStep.toFixed(2)} d -> ${s3.depStep.toFixed(3)} d`);
    expect(s3.depStep).toBeLessThan(s0.depStep / 5);
    expect(Math.abs(s3.dep - s0.dep) / 86400).toBeLessThan(2 * s0.depStep);
    expect(s3.c3).toBeLessThanOrEqual(s0.c3 + 1e-6);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(sw).toBe(true);
    expect(errors).toEqual([]);
  });
});

test('porkchop dates follow the mission and its liftoff', async ({ page }) => {
  await fresh(page);
  await page.selectOption('select.mission-select', 'mars-flyby');
  await settled(page);
  await page.getByRole('button', { name: 'Transfer planner…' }).click();
  const pl = page.locator('.planner');
  await expect(pl.locator('select[title="Departure body"]')).toHaveValue('earth');
  await expect(pl.locator('select[title="Arrival body"]')).toHaveValue('mars');
  const v = async (t: string) => pl.locator(`input[title="${t}"]`).inputValue();
  // Liftoff 2028-11-20, 400-day limit: departures from liftoff around the late-2028 window, arrivals by the limit.
  expect(await v('Earliest departure')).toBe('2028-11-20');
  expect(await v('Latest departure') > '2028-12-31').toBe(true);
  expect(await v('Latest arrival') <= '2029-12-25').toBe(true);
  await expect(pl.locator('.pl-status')).toContainText('window departs around');
  expect(errors).toEqual([]);
});

test('check.html still reports PASS', async ({ page }) => {
  await page.goto(`${BASE}/check.html`);
  await expect(page.locator('body')).toContainText('PASS', { timeout: 120_000 });
});

test('split across a separation: a departure the upper stage cannot complete, split so the kick stage finishes it', async ({ page }) => {
  test.setTimeout(300_000);
  await fresh(page);
  await page.selectOption('select.mission-select', 'jupiter-saturn');
  await settled(page);
  await page.getByRole('button', { name: 'Transfer planner…' }).click();
  const pl = page.locator('.planner');
  await pl.locator('select[title="Arrival body"]').selectOption('jupiter');
  await pl.locator('input[title="Earliest departure"]').fill('2034-05-15');
  await pl.locator('input[title="Latest departure"]').fill('2034-08-15');
  await pl.locator('input[title="Earliest arrival"]').fill('2035-09-01');
  await pl.locator('input[title="Latest arrival"]').fill('2037-03-01');
  await pl.getByRole('button', { name: 'Compute porkchop' }).click();
  await expect(pl.locator('.pl-status')).toContainText('transfers in', { timeout: 60_000 });
  await pl.getByRole('button', { name: 'Select minimum' }).click();
  // Liftoff: the proposed opportunity (the last allowed one before departure) is chosen by default.
  await pl.getByRole('button', { name: 'Insert departure burn' }).click();
  await expect(pl.locator('.pl-use .pl-result')).toContainText('Inserted burn', { timeout: 60_000 });
  await settled(page);
  // The plain message: the active stage cannot complete it; the split is offered.
  const msg = await pl.locator('.pl-use .pl-result').innerText();
  console.log(`departure: ${msg.replace(/\s*\n\s*/g, ' | ')}`);
  expect(msg).toMatch(/cannot complete this departure: it has about \d+ of the \d+ m\/s\. Split it across a separation/);
  const intent = await page.evaluate(() => { const w = (window as any).sendit; const n = w.nodesOf(); const last = n[n.length - 1]; return { dv: Math.hypot(...last.node.dv), stage: last.stage, count: n.length, seps: (w.store.get().plan.separations ?? []).length }; });
  await page.screenshot({ path: `${SHOTS}/7-split-offered.png` });
  await pl.locator('.split-btn').click();
  await expect(pl.locator('.pl-use .pl-result')).toContainText('Split: the stage burns what it has');
  await settled(page);
  const after = await page.evaluate(() => {
    const w = (window as any).sendit;
    const s = w.store.get();
    const n = w.nodesOf();
    return {
      nodes: n.map((x: any) => ({ stage: x.stage, dv: Math.hypot(...x.node.dv), start: x.burn.start, duration: x.burn.duration, short: x.short })),
      seps: (s.plan.separations ?? []).map((x: any) => x.time),
      flown: s.replay.result.burns.map((b: any) => ({ burnTime: b.burnTime, deltaV: b.deltaV })),
      planned: s.plan.burns.map((b: any) => ({ start: b.start, duration: b.duration })),
      outcome: s.replay.result.outcome,
      leavesEarth: s.replay.result.events.some((e: any) => e.kind === 'soi-exit' && e.body === 'earth') || s.replay.result.events.some((e: any) => e.body === 'jupiter'),
      errors: document.querySelectorAll('.node-row .err, .plan-errors li').length,
    };
  });
  console.log(`after split: ${JSON.stringify(after)}`);
  await page.screenshot({ path: `${SHOTS}/7-split-applied.png` });
  expect(after.nodes).toHaveLength(intent.count + 1);
  expect(after.seps).toHaveLength(intent.seps + 1);
  const [a, b] = after.nodes.slice(-2);
  // The upper stage burns out, the separation follows its cutoff, the next stage finishes in the same direction.
  expect(a.stage).toBe(intent.stage);
  expect(b.stage).toBe(intent.stage + 1);
  expect(a.short).toBe(false);
  expect(b.short).toBe(false);
  const sep = after.seps[after.seps.length - 1];
  expect(sep).toBeGreaterThan(a.start + a.duration);
  expect(b.start).toBeGreaterThan(sep);
  // The replay flies both burns (the first one to its planned length) and the total is the unsplit intent.
  const fa = after.flown[after.flown.length - 2], fb = after.flown[after.flown.length - 1];
  expect(fa.burnTime).toBeGreaterThan(a.duration * 0.99);
  expect(fb.burnTime).toBeGreaterThan(b.duration * 0.99);
  expect(Math.abs(a.dv + b.dv - intent.dv) / intent.dv).toBeLessThan(1e-6);
  expect(Math.abs(fa.deltaV + fb.deltaV - intent.dv) / intent.dv).toBeLessThan(0.02);
  expect(after.errors).toBe(0);
  expect(errors).toEqual([]);
});
