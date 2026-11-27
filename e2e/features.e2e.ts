/**
 * Features of the second UI pass, driven through the built site in Chromium:
 * ascending / descending nodes (equator and the Moon's plane), reference
 * overlays, launch-site markers in the surface frame, the drawn span (picture
 * changes, digest does not), burn arcs, far-side occlusion, the three-level
 * node step buttons, dock resize / collapse / persistence with re-centring,
 * the zoomable timeline, and the faint low-orbit trace. Screenshots go to
 * test-results/features/ for a human to look at.
 */
import { expect, test, type Page } from '@playwright/test';
import { solveGeo } from './geo';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/features';

test.skip(({ browserName }) => browserName !== 'chromium', 'feature flows run in Chromium');

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

const errors: string[] = [];
function watch(page: Page): void {
  page.on('console', (m) => {
    if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
}

async function settled(page: Page): Promise<string> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
  return page.evaluate(() => (window as any).sendit.store.get().replay.result.digest);
}

async function fresh(page: Page, mission?: string): Promise<void> {
  watch(page);
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/`);
  await settled(page);
  if (mission) {
    await page.locator('select.mission-select').selectOption(mission, { force: true });
    await settled(page);
  }
}

async function enter(page: Page, selector: string, value: string): Promise<void> {
  const i = page.locator(selector);
  await i.fill(value);
  await i.press('Enter');
}

/** Angle (deg) between the craft's orbit normal about Earth at mission time tm and a reference normal, computed independently in the page. */
async function relInclination(page: Page, tm: number, plane: 'equator' | 'moon'): Promise<number> {
  return page.evaluate(([tm, plane]) => {
    const w = window as any;
    const s = w.sendit.store.get();
    const smp: Float64Array = s.replay.samples;
    const t = s.plan.epoch + (tm as number);
    let k = 0;
    while (k + 8 < smp.length && smp[k + 8] <= t) k += 8;
    const ids: string[] = w.sendit.bodies;
    const n = ids.length;
    const pos = new Float64Array(3 * n), vel = new Float64Array(3 * n);
    w.sendit.eph.evaluate(smp[k], pos, vel);
    const e = ids.indexOf('earth');
    const r = [smp[k + 1] - pos[3 * e], smp[k + 2] - pos[3 * e + 1], smp[k + 3] - pos[3 * e + 2]];
    const v = [smp[k + 4] - vel[3 * e], smp[k + 5] - vel[3 * e + 1], smp[k + 6] - vel[3 * e + 2]];
    const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const h = cross(r, v);
    let nrm: number[];
    if (plane === 'moon') {
      const m = ids.indexOf('moon');
      nrm = cross([pos[3 * m] - pos[3 * e], pos[3 * m + 1] - pos[3 * e + 1], pos[3 * m + 2] - pos[3 * e + 2]], [vel[3 * m] - vel[3 * e], vel[3 * m + 1] - vel[3 * e + 1], vel[3 * m + 2] - vel[3 * e + 2]]);
    } else nrm = w.sendit.earthPole(smp[k]);
    const dot = h[0] * nrm[0] + h[1] * nrm[1] + h[2] * nrm[2];
    return (Math.acos(dot / Math.hypot(...h) / Math.hypot(...nrm)) * 180) / Math.PI;
  }, [tm, plane] as const);
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('AN / DN on an inclined parking orbit: equator and the Moon\'s plane; overlays', async ({ page }) => {
    await fresh(page, 'geo-from-leo');
    // The mission now opens at its par site (the equator, no inclination to show): launch from Kourou, as before.
    await page.selectOption('select[title="Launch site"]', 'kourou');
    await settled(page);
    const launchInc = await page.evaluate(() => (window as any).sendit.store.get().replay.result.launch.inclinationDeg);
    const eq = await page.evaluate(() => (window as any).sendit.crossings().map((c: any) => ({ t: c.t, a: c.ascending, i: c.inclinationDeg })));
    expect(eq.length).toBeGreaterThan(4);
    const epoch = await page.evaluate(() => (window as any).sendit.store.get().plan.epoch);
    const indep = await relInclination(page, eq[1].t - epoch, 'equator');
    console.log(`equator: launch inclination ${launchInc.toFixed(3)}°, node marker ${eq[1].i.toFixed(3)}°, independent ${indep.toFixed(3)}°, ${eq.length} crossings`);
    expect(Math.abs(eq[1].i - indep)).toBeLessThan(0.05);
    expect(Math.abs(eq[1].i - launchInc)).toBeLessThan(0.2);
    expect(eq.filter((c: any) => c.a).length).toBeGreaterThan(1);
    // Markers near the cursor only, with the time to the next one.
    await page.evaluate(() => (window as any).sendit.camera.setDistance(4e7, true));
    await page.waitForTimeout(500);
    const pn = page.locator('.label.pnode');
    expect(await pn.count()).toBeGreaterThan(0);
    expect(await pn.count()).toBeLessThanOrEqual(3);
    await expect(page.locator('.label.pnode .text').filter({ hasText: /in \d/ }).first()).toBeAttached();
    // Events tab lists them, collapsed.
    await expect(page.locator('.plane-list')).toContainText("Nodes on Earth's equator");
    // Overlays on: equator disc and axis; the nodes lie on the disc.
    await page.locator('#show-equator').check();
    await page.locator('#show-axis').check();
    await page.evaluate(() => {
      const w = (window as any).sendit;
      w.store.set({ focus: w.bodies.indexOf('earth') });
    });
    await page.evaluate(() => { const c = (window as any).sendit.camera; c.elevation = 0.25; c.setDistance(6.5e7, true); });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/1-nodes-equator-overlays.png` });
    // Selecting a node marker moves the cursor there and offers "add node here".
    const first = page.locator('.label.pnode:not(.occluded) .text').first();
    await first.click({ force: true });
    await expect(page.locator('.tap-pop')).toBeVisible();
    await expect(page.locator('.tap-pop').getByRole('button', { name: 'Add node here' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/1b-node-selected.png` });
    // Relative to the Moon's orbital plane.
    await page.selectOption('.plane-sel', 'moon');
    await page.locator('#show-target-plane').check();
    await page.waitForFunction(() => (window as any).sendit.crossingLabel().includes('Moon'));
    await page.waitForTimeout(300);
    const mo = await page.evaluate(() => (window as any).sendit.crossings().map((c: any) => ({ t: c.t, i: c.inclinationDeg })));
    expect(mo.length).toBeGreaterThan(2);
    const indepM = await relInclination(page, mo[1].t - epoch, 'moon');
    console.log(`Moon plane: node marker ${mo[1].i.toFixed(3)}°, independent ${indepM.toFixed(3)}°`);
    expect(Math.abs(mo[1].i - indepM)).toBeLessThan(0.05);
    expect(Math.abs(mo[1].i - eq[1].i)).toBeGreaterThan(1); // a different plane
    await page.locator('.tap-pop button[aria-label="Dismiss"]').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/1c-nodes-moon-plane.png` });
    expect(errors).toEqual([]);
  });

  test('geostationary solved in the surface frame: still craft, sites on the right coast, drawn span vs digest, burn arcs, occlusion', async ({ page }) => {
    await fresh(page, 'geo-from-leo');
    await solveGeo(page);
    const digest = await settled(page);
    expect(await page.evaluate(() => (window as any).sendit.store.get().replay.evaluation.success)).toBe(true);
    expect(await page.evaluate(() => (window as any).sendit.store.get().frame.kind)).toBe('surface');
    // Still over one longitude.
    await page.evaluate(() => (window as any).sendit.camera.setDistance(2.2e8, true));
    await page.waitForTimeout(600);
    const pts = await page.evaluate(() => [1.5, 3, 4.5].map((d) => (window as any).sendit.screenAt(d * 86400)));
    const spread = Math.max(...pts.map((p: any) => Math.hypot(p.x - pts[0].x, p.y - pts[0].y)));
    expect(spread).toBeLessThan(6);
    await page.screenshot({ path: `${SHOTS}/2-geo-surface.png` });
    // Drawn span: four settings, four pictures, one digest (seen in Earth's inertial frame, cursor after the burns).
    await page.selectOption('select.frame-kind', 'inertial');
    await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ t: w.store.get().plan.epoch + 6 * 3600, paused: true }); w.camera.elevation = 0.9; w.camera.setDistance(1.4e8, true); });
    await page.waitForTimeout(800);
    const ends: number[] = [];
    for (const v of ['rev1', 'time', 'all', 'auto']) {
      await page.selectOption('.span-sel', v);
      if (v === 'time') await enter(page, 'input[title="Days drawn after the last burn"]', '0.25');
      await page.waitForTimeout(400);
      ends.push(await page.evaluate(() => (window as any).sendit.drawn().t));
      await page.screenshot({ path: `${SHOTS}/3-span-${v}.png` });
      expect(await page.evaluate(() => (window as any).sendit.store.get().replay.result.digest)).toBe(digest);
      expect(await page.evaluate(() => (window as any).sendit.store.get().replayStatus)).toBe('idle');
    }
    expect(new Set(ends.map((t) => Math.round(t))).size).toBeGreaterThan(1);
    // Launch sites on the texture: Cape Canaveral (Florida's east coast) and Kourou (north coast of South America).
    await page.selectOption('select.frame-kind', 'surface');
    await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ focus: w.bodies.indexOf('earth') }); });
    for (const [id, lat, lon] of [['cape-canaveral', 28.5619, -80.5772], ['kourou', 5.239, -52.7686]] as const) {
      await page.evaluate(([la, lo]) => { const c = (window as any).sendit.camera; c.azimuth = (lo * Math.PI) / 180; c.elevation = (la * Math.PI) / 180; c.setDistance(9.5e6, true); }, [lat, lon]);
      await page.waitForTimeout(2500); // high-tier texture
      await expect(page.locator(`.label[data-key="site:${id}"] .dot`)).toBeVisible();
      expect(await page.locator(`.label[data-key="site:${id}"]`).getAttribute('class')).not.toContain('occluded');
      await page.screenshot({ path: `${SHOTS}/4-site-${id}.png` });
    }
    await expect(page.locator('.label.site.selected')).toHaveCount(1);
    // Burn arcs and far-side occlusion: the transfer orbit seen past the Earth.
    await page.selectOption('select.frame-kind', 'inertial');
    await page.evaluate(() => { const c = (window as any).sendit.camera; c.elevation = 0.05; c.setDistance(4.5e7, true); const w = (window as any).sendit; w.store.set({ t: w.store.get().plan.epoch + 1700, paused: true }); });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/5-burn-arcs.png` });
    let occluded = 0;
    for (let k = 0; k < 12 && occluded === 0; k++) {
      await page.evaluate((a) => { const c = (window as any).sendit.camera; c.azimuth = a; c.elevation = 0.02; c.setDistance(1.6e7, true); }, (k * Math.PI) / 6);
      await page.waitForTimeout(400);
      occluded = await page.locator('.label.occluded').count();
    }
    console.log(`occluded markers in view: ${occluded}`);
    expect(occluded).toBeGreaterThan(0);
    await page.screenshot({ path: `${SHOTS}/6-far-side-occluded.png` });
    expect(errors).toEqual([]);
  });

  test('one distance convention: objective, events and status agree; switching to radius changes all', async ({ page }) => {
    await fresh(page, 'geo-from-leo');
    await solveGeo(page);
    await settled(page);
    const obj = page.locator('.obj').first();
    await expect(obj).toContainText('35,686–35,886 km alt'); // 42,064–42,264 km radius less Earth's reference radius 6,378.1366 km (was the mean radius 6,371 km)
    const status = async () => (await page.locator('.tb-status').textContent()) ?? '';
    const lastPe = async () => (await page.locator('.event-row.k-periapsis').filter({ hasText: 'Periapsis Earth' }).last().locator('.eval').textContent()) ?? '';
    // The groups may be collapsed: open them so the last periapsis row is listed.
    for (let k = 0; k < 10 && (await page.locator('.apsis-group[aria-expanded="false"]').count()) > 0; k++) await page.locator('.apsis-group[aria-expanded="false"]').first().click();
    const num = (t: string, word: string) => new RegExp(`([\\d,]+) km ${word}`).exec(t)?.[1];
    // The status line shows the osculating orbit at the time cursor: put the cursor on the last periapsis, where it
    // and the replay's periapsis row are the same point.
    await page.evaluate(() => {
      const w = (window as any).sendit;
      const s = w.store.get();
      const pe = [...s.replay.result.events].reverse().find((e: any) => e.kind === 'periapsis' && e.body === 'earth');
      w.store.set({ t: pe.t, paused: true, loadingTarget: pe.t });
    });
    await settled(page);
    await page.waitForTimeout(300);
    const st = await status();
    const pe = await lastPe();
    console.log(`status: ${st} | last periapsis row: ${pe}`);
    expect(num(st, 'alt')).toBe(num(pe, 'alt'));
    await page.screenshot({ path: `${SHOTS}/12a-distances-alt.png` });
    await page.selectOption('.dist-sel', 'radius');
    await expect(obj).toContainText('42,064–42,264 km radius');
    await expect(page.locator('.tb-status')).toContainText('km radius');
    for (let k = 0; k < 10 && (await page.locator('.apsis-group[aria-expanded="false"]').count()) > 0; k++) await page.locator('.apsis-group[aria-expanded="false"]').first().click();
    const st2 = await status();
    const pe2 = await lastPe();
    expect(num(st2, 'radius')).toBe(num(pe2, 'radius'));
    expect(Number(num(st2, 'radius')!.replace(/,/g, '')) - Number(num(st, 'alt')!.replace(/,/g, ''))).toBeCloseTo(6378, -1); // Earth's reference (equatorial) radius, 6378.1366 km: the altitude reference of every layer
    await page.screenshot({ path: `${SHOTS}/12b-distances-radius.png` });
  });

  test('Saturn overlays: axis and ring-plane disc', async ({ page }) => {
    await fresh(page);
    await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ focus: w.bodies.indexOf('saturn'), frame: { kind: 'inertial', center: w.bodies.indexOf('saturn') } }); });
    await page.locator('#show-equator').check();
    await page.locator('#show-axis').check();
    await page.evaluate(() => { const c = (window as any).sendit.camera; c.elevation = 0.35; c.setDistance(4e8, true); });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${SHOTS}/7-saturn-overlays.png` });
    // Persisted with the view state.
    await page.reload();
    await settled(page);
    expect(await page.locator('#show-equator').isChecked()).toBe(true);
  });

  test('node step buttons: three levels each way and zero', async ({ page }) => {
    await fresh(page, 'geo-from-leo');
    await page.getByRole('button', { name: '+ Node at cursor' }).click();
    await settled(page);
    await enter(page, 'input[title="Prograde delta-v, m/s"]', '0');
    const pro = page.locator('.tuner', { has: page.locator('input[title="Prograde delta-v, m/s"]') });
    const step = (n: string) => pro.getByRole('button', { name: `Prograde: ${n}`, exact: true });
    await step('+10 m/s').click();
    await step('+10 m/s').click();
    await step('+1 m/s').click();
    await step('+0.1 m/s').click();
    await step('−1 m/s').click();
    const dv = () => page.evaluate(() => (window as any).sendit.nodesOf()[0].node.dv[0]);
    expect(await dv()).toBeCloseTo(20.1, 9);
    await pro.getByRole('button', { name: 'Prograde: set to zero' }).click();
    expect(await dv()).toBe(0);
    const t0 = await page.evaluate(() => (window as any).sendit.nodesOf()[0].node.t);
    const time = page.locator('.tuner', { has: page.locator('input.met-input') });
    await time.getByRole('button', { name: 'Time: +1 min', exact: true }).click();
    await time.getByRole('button', { name: 'Time: −1 s', exact: true }).click();
    expect(await page.evaluate(() => (window as any).sendit.nodesOf()[0].node.t)).toBeCloseTo(t0 + 59, 6);
    await expect(pro.locator('.tn-sub').first()).toBeVisible();
    await page.locator('.panel.nodes').screenshot({ path: `${SHOTS}/8-node-buttons-desktop.png` });
  });

  test('docks: resize, collapse, persist, reset; the focus re-centres in the free area', async ({ page }) => {
    await fresh(page);
    const focusX = () => page.evaluate(() => {
      const w = (window as any).sendit;
      const e = document.querySelector(`.label[data-key="${w.store.get().focus}"]`) as HTMLElement;
      return Number(/translate\(([-\d.]+)px/.exec(e.style.transform)![1]);
    });
    const freeCx = () => page.evaluate(() => { const f = (window as any).sendit.layout.freeRect(); return (f.left + innerWidth - f.right) / 2; });
    await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ focus: w.bodies.indexOf('earth') }); });
    await page.waitForTimeout(800);
    const before = await page.locator('.dock.right').boundingBox();
    expect(Math.abs((await focusX()) - (await freeCx()))).toBeLessThan(4);
    const h = page.locator('.dock.right .dock-resize');
    const hb = (await h.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 - 100, hb.y + hb.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const after = await page.locator('.dock.right').boundingBox();
    expect(after!.width).toBeGreaterThan(before!.width + 80);
    expect(Math.abs((await focusX()) - (await freeCx()))).toBeLessThan(4);
    // Keyboard.
    await h.focus();
    await page.keyboard.press('ArrowRight');
    expect((await page.locator('.dock.right').boundingBox())!.width).toBeLessThan(after!.width);
    // Collapse a panel by its header and the left dock by its toggle; reload keeps all of it.
    await page.locator('.panel.events .sec-title').click();
    await page.locator('.dock.left .dock-toggle').click();
    const w1 = (await page.locator('.dock.right').boundingBox())!.width;
    await page.reload();
    await settled(page);
    expect((await page.locator('.dock.right').boundingBox())!.width).toBeCloseTo(w1, 0);
    await expect(page.locator('.panel.events')).toHaveClass(/collapsed/);
    await expect(page.locator('#hud')).toHaveAttribute('data-left-collapsed', 'true');
    await page.screenshot({ path: `${SHOTS}/9-docks-resized.png` });
    await page.locator('.dock.right .dock-resize').dblclick();
    expect(Math.abs((await page.locator('.dock.right').boundingBox())!.width - before!.width)).toBeLessThan(2);
    await page.locator('.dock.left .dock-toggle').click();
    await page.screenshot({ path: `${SHOTS}/9b-docks-default.png` });
  });

  test('timeline: zoom into a burn inside a 10-day flight, scrub to a second, fit all', async ({ page }) => {
    await fresh(page, 'geo-from-leo');
    await solveGeo(page);
    await enter(page, 'input[title^="Flight duration"]', '10');
    await settled(page);
    await page.evaluate(() => (window as any).sendit.store.set({ selectedNode: 0 }));
    await page.selectOption('.tl-presets', 'burn');
    const fitBurn = await page.evaluate(() => (window as any).sendit.timeline.window());
    const burn = await page.evaluate(() => { const s = (window as any).sendit.store.get(); return s.replay.result.burns[0].burnTime; });
    console.log(`burn 1 (the upper stage's transfer burn) lasts ${burn.toFixed(0)} s; window ${(fitBurn[1] - fitBurn[0]).toFixed(0)} s`);
    expect(fitBurn[1] - fitBurn[0]).toBeLessThan(burn * 2 + 61);
    // The upper stage's burn is ~13 minutes: zoom in once more, about the middle of the burn, for a second per pixel.
    await page.evaluate(() => { const w = (window as any).sendit; const s = w.store.get(); const b = s.plan.burns[0]; w.store.set({ t: s.plan.epoch + b.start + b.duration / 2, paused: true }); });
    await page.getByRole('button', { name: 'Zoom the timeline in (about the cursor)' }).click();
    const win = await page.evaluate(() => (window as any).sendit.timeline.window());
    const b0 = await page.evaluate(() => { const s = (window as any).sendit.store.get(); return [s.plan.epoch + s.plan.burns[0].start, s.plan.epoch + s.plan.burns[0].start + s.plan.burns[0].duration]; });
    expect(win[0]).toBeGreaterThan(b0[0]);
    expect(win[1]).toBeLessThan(b0[1]);
    const rw = (await page.locator('input.scrub').boundingBox())!.width;
    expect((win[1] - win[0]) / rw).toBeLessThan(2); // about a second per pixel
    // Scrub within the burn by dragging the handle.
    const rb = (await page.locator('input.scrub').boundingBox())!;
    await page.mouse.click(rb.x + rb.width * 0.5, rb.y + rb.height / 2);
    const t1 = await page.evaluate(() => (window as any).sendit.store.get().t);
    // Drag the handle by 3 px.
    await page.mouse.down();
    await page.mouse.move(rb.x + rb.width * 0.5 + 3, rb.y + rb.height / 2, { steps: 3 });
    await page.mouse.up();
    const t2 = await page.evaluate(() => (window as any).sendit.store.get().t);
    console.log(`three pixels of scrub = ${(t2 - t1).toFixed(2)} s`);
    expect(Math.abs(t2 - t1)).toBeGreaterThan(0.5);
    expect(Math.abs(t2 - t1)).toBeLessThan(6);
    expect(t1).toBeGreaterThan(win[0]);
    await expect(page.locator('.scrub-overview')).toBeVisible();
    await page.locator('.scrubber').screenshot({ path: `${SHOTS}/10-timeline-zoomed.png` });
    // Wheel zoom out, then fit all.
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.wheel(0, 400);
    const w2 = await page.evaluate(() => (window as any).sendit.timeline.window());
    expect(w2[1] - w2[0]).toBeGreaterThan(win[1] - win[0]);
    await page.getByRole('button', { name: 'Fit the whole flight' }).click();
    const w3 = await page.evaluate(() => (window as any).sendit.timeline.window());
    const span = await page.evaluate(() => { const s = (window as any).sendit.store.get(); return [s.plan.epoch, s.replay.result.finalT]; });
    expect(w3[0]).toBeCloseTo(span[0], 0);
    expect(w3[1]).toBeCloseTo(span[1], 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('low Earth orbit: faint revolutions do not hide the planet (before / after)', async ({ page }) => {
    await fresh(page);
    await enter(page, 'input[title^="Flight duration"]', '10');
    await settled(page);
    await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ focus: w.bodies.indexOf('earth'), t: w.store.get().plan.epoch + 5 * 86400, paused: true }); w.camera.elevation = 0.5; w.camera.setDistance(2.6e7, true); });
    await page.waitForTimeout(3000);
    await page.evaluate(() => (window as any).sendit.scene.setFaintAccumulate(true));
    await page.evaluate(() => (window as any).sendit.camera.setDistance(2.6e7 * 1.0001, true));
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/11a-leo-before-accumulating.png` });
    await page.evaluate(() => (window as any).sendit.scene.setFaintAccumulate(false));
    await page.evaluate(() => (window as any).sendit.camera.setDistance(2.6e7, true));
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/11b-leo-after-stencil.png` });
  });
});

test.describe('phone', () => {
  test.use(PHONE);

  test('phone: node buttons fit at 360-390 px, timeline zoom, sheet drag to any height, panel collapse', async ({ page }) => {
    await fresh(page, 'geo-from-leo');
    await solveGeo(page);
    await settled(page);
    await page.evaluate(() => (window as any).sendit.store.set({ selectedNode: 0 }));
    await page.getByRole('tab', { name: 'Nodes' }).tap();
    await page.locator('.sheet-grip').tap();
    const steps = page.locator('.tn-steps').first();
    await steps.scrollIntoViewIfNeeded();
    for (const b of await steps.locator('button').all()) {
      const r = (await b.boundingBox())!;
      expect(r.height).toBeGreaterThanOrEqual(43);
      expect(r.width).toBeGreaterThanOrEqual(40);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/p1-node-buttons-phone.png` });
    // Timeline: fit burn, then fit all.
    await page.locator('.tl-presets').selectOption('burn');
    const win = await page.evaluate(() => (window as any).sendit.timeline.window());
    expect(win[1] - win[0]).toBeLessThan(1200);
    await expect(page.locator('.scrub-overview')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/p2-timeline-zoomed-phone.png` });
    await page.getByRole('button', { name: 'Fit the whole flight' }).tap();
    await expect(page.locator('.scrub-overview')).toBeHidden();
    // Sheet: drag the grip to a height between the snap points; it stays there.
    const g = (await page.locator('.sheet-grip').boundingBox())!;
    const H = 844;
    const cdp = await page.context().newCDPSession(page);
    const y0 = g.y + g.height / 2;
    const target = H - H * 0.66;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: y0 }] });
    for (let k = 1; k <= 10; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: y0 + ((target - y0) * k) / 10 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
    const sh = (await page.locator('.sheet').boundingBox())!.height;
    console.log(`sheet dragged to ${sh.toFixed(0)} px of ${H}`);
    expect(Math.abs(sh - H * 0.66)).toBeLessThan(60);
    // Panels collapse by their header in the sheet.
    await page.getByRole('tab', { name: 'View' }).tap();
    await page.locator('.panel.traj-view .sec-title').tap();
    await expect(page.locator('.panel.traj-view')).toHaveClass(/collapsed/);
    await page.screenshot({ path: `${SHOTS}/p3-sheet-custom-height.png` });
    expect(errors).toEqual([]);
  });
});
