/**
 * The phone experience, touch only, in WebKit (the engine of every iOS browser) and
 * Chromium, at 390 x 844 with an iPhone user agent. Gestures beyond a single tap go
 * through e2e/touch.ts (synthetic Pointer Events), not Chromium's CDP, so they run in
 * WebKit too.
 *
 *  1. The shell: viewport meta, safe-area variables, touch-action on the map,
 *     16 px text in every field (iOS zooms the page on focus otherwise), keyboards
 *     (inputmode) that can type what each field needs, the pixel-ratio cap.
 *  2. Map gestures: one finger orbits and never scrolls the page; pinch zooms the
 *     camera; the page itself stays at scale 1.
 *  3. The bottom sheet: tap the grip to cycle, drag it to any height.
 *  4. The planner: compute, tap a cell, drag across the chart.
 *  5. End to end: lunar flyby chosen, launch typed, a node added by tapping the
 *     trajectory, tuned by the drag strip, the step buttons and a decimal comma,
 *     submitted to the in-process leaderboard (never the real one).
 *
 * Not covered here, by design: Firefox (Playwright's Firefox has no mobile emulation,
 * `isMobile` is unsupported, and Firefox for Android is not a target). What
 * emulation cannot show at all is in docs/mobile-testing.md.
 */
import { devices, expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { drag, gesture, line, pinch } from './touch';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/mobile';
const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(import.meta.dirname, '.dist-node/leaderboard-mobile');

test.skip(({ browserName }) => browserName === 'firefox', 'Playwright Firefox cannot emulate a phone (isMobile unsupported); Firefox for Android is not a target');
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, userAgent: devices['iPhone 13'].userAgent, screen: { width: 390, height: 844 } }); // screen too: the app sizes its pixel-ratio cap from it

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}

async function fresh(page: Page): Promise<string[]> {
  const errors = watch(page);
  // One navigation: a reload while the first load is still fetching makes WebKit log the aborted worker fetches.
  await page.addInitScript(() => localStorage.clear());
  await page.goto(`${BASE}/`);
  await settled(page);
  return errors;
}

const noPageScroll = (page: Page) => page.evaluate(() => ({ sx: scrollX, sy: scrollY, scale: visualViewport?.scale ?? 1, wide: document.documentElement.scrollWidth > innerWidth }));

test('shell: viewport, safe areas, touch-action, 16 px fields, keyboards, pixel-ratio cap', async ({ page }) => {
  const errors = await fresh(page);
  const r = await page.evaluate(() => {
    const view = document.getElementById('view') as HTMLCanvasElement;
    const css = getComputedStyle(document.documentElement);
    // Every text field and picker the app can show, including closed panels and the planner.
    (window as any).sendit.planner.open('transfer');
    const fields = [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea')] as HTMLElement[];
    const small = fields.filter((f) => parseFloat(getComputedStyle(f).fontSize) < 16).map((f) => `${f.tagName.toLowerCase()}.${f.className} "${f.title}" ${getComputedStyle(f).fontSize}`);
    // A field that takes dates or signed values must not get a digits-only pad (iOS "numeric" has no '-', ':', '.').
    const numericPad = fields.filter((f) => f.getAttribute('inputmode') === 'numeric').map((f) => f.title);
    (window as any).sendit.planner.close();
    return {
      viewport: document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? '',
      saVars: ['--sa-t', '--sa-r', '--sa-b', '--sa-l'].map((v) => css.getPropertyValue(v).trim()),
      touchAction: getComputedStyle(view).touchAction,
      userSelect: getComputedStyle(view).webkitUserSelect || getComputedStyle(view).userSelect,
      bodyOverflow: getComputedStyle(document.body).overflow,
      touchClass: document.documentElement.classList.contains('touch'),
      dpr: (window as any).sendit.scene.renderer.getPixelRatio(),
      canvasPx: view.width,
      small,
      numericPad,
      fieldCount: fields.length,
    };
  });
  console.log(`shell: ${JSON.stringify({ ...r, small: r.small.length })}`);
  expect(r.viewport).toContain('viewport-fit=cover'); // safe-area insets are only non-zero with this
  expect(r.viewport).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\D|$)/); // page zoom stays available off the map
  for (const v of r.saVars) expect(v).not.toBe(''); // env(safe-area-inset-*) resolved
  expect(r.touchAction).toBe('none');
  expect(r.userSelect).toBe('none');
  expect(r.bodyOverflow).toBe('hidden');
  expect(r.touchClass).toBe(true);
  expect(r.fieldCount).toBeGreaterThan(10);
  expect(r.small, 'fields under 16 px make iOS Safari zoom the page on focus').toEqual([]);
  expect(r.numericPad, 'inputmode=numeric fields').toEqual([]);
  expect(r.dpr).toBeLessThanOrEqual(1.5); // phone cap: 3x would be 4x the fragments
  expect(r.canvasPx).toBeLessThanOrEqual(Math.ceil(390 * 1.5));
  expect(errors).toEqual([]);
});

test('map: one finger orbits without scrolling the page; pinch zooms the camera, not the page', async ({ page }) => {
  const errors = await fresh(page);
  await page.getByRole('tab', { name: 'Start' }).tap();
  await page.getByRole('tab', { name: 'Start' }).tap(); // second tap lowers the sheet to its peek height
  await expect(page.locator('#hud')).toHaveAttribute('data-sheet', 'peek');
  const cam = () => page.evaluate(() => { const c = (window as any).sendit.camera; return { az: c.azimuth as number, el: c.elevation as number, d: c.targetDistance as number }; });
  const c0 = await cam();
  await drag(page, 120, 380, 280, 330);
  const c1 = await cam();
  expect(Math.abs(c1.az - c0.az)).toBeGreaterThan(0.3);
  expect(await noPageScroll(page)).toEqual({ sx: 0, sy: 0, scale: 1, wide: false });
  await page.evaluate(() => (window as any).sendit.camera.stop());
  await pinch(page, 195, 380, 80, 200);
  const c2 = await cam();
  expect(c2.d).toBeLessThan(c1.d * 0.6);
  await pinch(page, 195, 380, 200, 80);
  expect((await cam()).d).toBeGreaterThan(c2.d * 1.5);
  // Two-finger vertical drag tilts.
  const e0 = (await cam()).el;
  await gesture(page, [line(155, 300, 155, 420), line(235, 300, 235, 420)]);
  expect(Math.abs((await cam()).el - e0)).toBeGreaterThan(0.1);
  expect(await noPageScroll(page)).toEqual({ sx: 0, sy: 0, scale: 1, wide: false });
  // A gesture that starts on a map label still reaches the map (labels.ts forwards it).
  const lab = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.label .text')].find((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.top > 120 && b.bottom < 600 && b.left > 20 && b.right < 370; });
    if (!t) return null;
    const b = t.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  if (lab) {
    const a0 = (await cam()).az;
    await drag(page, lab.x, lab.y, lab.x + 120, lab.y);
    expect(Math.abs((await cam()).az - a0)).toBeGreaterThan(0.2);
  }
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-map-gestures.png` });
  expect(errors).toEqual([]);
});

test('sheet: the grip cycles peek / half / full on tap and holds a dragged height; its body scrolls inside', async ({ page }) => {
  const errors = await fresh(page);
  const hud = page.locator('#hud');
  await expect(hud).toHaveAttribute('data-mode', 'sheet');
  const grip = page.locator('.sheet-grip');
  const start = await hud.getAttribute('data-sheet');
  const order = ['peek', 'half', 'full'];
  await grip.tap();
  await expect(hud).toHaveAttribute('data-sheet', order[(order.indexOf(start!) + 1) % 3]);
  // Drag to about two thirds of the height, between the snap points: it stays there.
  const g = (await grip.boundingBox())!;
  const y0 = g.y + g.height / 2;
  await drag(page, 195, y0, 195, 844 - 844 * 0.66, 10);
  await page.waitForTimeout(400);
  const sh = (await page.locator('.sheet').boundingBox())!.height;
  expect(Math.abs(sh - 844 * 0.66)).toBeLessThan(60);
  // The sheet body is its own scroller (momentum and overscroll contained), the page is not.
  const s = await page.evaluate(() => {
    const b = document.querySelector('.sheet-body') as HTMLElement;
    const cs = getComputedStyle(b);
    return { oy: cs.overflowY, ob: cs.overscrollBehaviorY || (cs as any).overscrollBehavior };
  });
  expect(s.oy).toBe('auto');
  expect(s.ob).toBe('contain');
  expect(await noPageScroll(page)).toEqual({ sx: 0, sy: 0, scale: 1, wide: false });
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-sheet.png` });
  expect(errors).toEqual([]);
});

test('planner by touch: compute, tap a cell, drag across the chart, nothing wider than the screen', async ({ page }) => {
  const errors = await fresh(page);
  await page.evaluate(() => (window as any).sendit.planner.open('transfer'));
  const pl = page.locator('.planner');
  await pl.getByRole('button', { name: 'Compute porkchop' }).tap();
  await expect(pl.locator('.pl-status')).toContainText('transfers in', { timeout: 60_000 });
  const canvas = pl.locator('.pl-canvas');
  // The drag path comes from where the chart actually is on screen, not from fixed fractions of its box: with
  // Linux fonts the planner lays out taller and its sticky header or the sheet's edge covered the old points.
  // Centre the chart in its scroll container, clip its rect to every scrolling ancestor and the viewport, then take
  // the first horizontal line (from the middle outwards) on which every point hits the chart itself.
  await canvas.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await page.waitForTimeout(100);
  const path = await page.evaluate(() => {
    const c = document.querySelector('.planner .pl-canvas') as HTMLElement;
    const r = c.getBoundingClientRect();
    let x0 = Math.max(r.left, 0), x1 = Math.min(r.right, innerWidth), y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, innerHeight);
    const clips: string[] = [];
    for (let e = c.parentElement; e; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (!/(auto|scroll|hidden|clip)/.test(st.overflow + st.overflowX + st.overflowY)) continue;
      const q = e.getBoundingClientRect();
      x0 = Math.max(x0, q.left); x1 = Math.min(x1, q.right); y0 = Math.max(y0, q.top); y1 = Math.min(y1, q.bottom);
      clips.push(`${e.className || e.tagName} ${Math.round(q.top)}..${Math.round(q.bottom)}`);
    }
    const fr = [0.3, 0.4, 0.5, 0.6];
    const line = (y: number) => fr.map((f) => ({ x: x0 + (x1 - x0) * f, y }));
    const onChart = (ps: { x: number; y: number }[]) => ps.every((p) => document.elementFromPoint(p.x, p.y) === c);
    const mid = (y0 + y1) / 2;
    for (let d = 0; d <= (y1 - y0) / 2 - 4; d += 6) {
      for (const y of [mid + d, mid - d]) if (onChart(line(y))) return { pts: line(y), info: '' };
    }
    const hits = line(mid).map((p) => { const h = document.elementFromPoint(p.x, p.y); return h ? `${h.tagName}.${h.className}` : 'null'; });
    return { pts: null, info: `canvas ${JSON.stringify(r)}; visible x ${Math.round(x0)}..${Math.round(x1)} y ${Math.round(y0)}..${Math.round(y1)}; clips [${clips.join('; ')}]; viewport ${innerWidth}x${innerHeight}; at the middle line: ${hits.join(', ')}` };
  });
  expect(path.pts, `drag path on the chart: ${path.info}`).not.toBeNull();
  const pts = path.pts!;
  await page.touchscreen.tap(pts[1].x, pts[1].y);
  await expect(pl.locator('.pl-readout')).toContainText(/Selected transfer|No transfer/);
  await gesture(page, [pts]);
  await expect(pl.locator('.pl-readout')).toContainText(/Under pointer|Selected transfer/);
  const d = await page.evaluate(() => { const p = document.querySelector('.planner') as HTMLElement; return { sw: p.scrollWidth, cw: p.clientWidth, docW: document.documentElement.scrollWidth }; });
  expect(d.sw).toBeLessThanOrEqual(d.cw);
  expect(d.docW).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-planner.png` });
  expect(errors).toEqual([]);
});

test.describe('end to end', () => {
  type Handler = (method: string, url: string, headers: Record<string, string>, body: string | undefined) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
  let harness: { makeLeaderboard(c: Uint8Array): Handler };
  let checkpoints: Uint8Array;

  test.beforeAll(async () => {
    const { build } = await import('vite');
    await build({
      configFile: false,
      root: ROOT,
      logLevel: 'warn',
      publicDir: false,
      build: { ssr: resolve(import.meta.dirname, 'leaderboard-harness.ts'), outDir: OUT, emptyOutDir: true, target: 'node22', minify: false, rollupOptions: { output: { format: 'es', entryFileNames: '[name].mjs' } } },
      ssr: { noExternal: true, target: 'node' },
    });
    harness = await import(pathToFileURL(resolve(OUT, 'leaderboard-harness.mjs')).href);
    checkpoints = new Uint8Array(readFileSync(resolve(ROOT, 'src/physics/data/checkpoints-1950-2100.bin')));
  });

  test('touch only: lunar flyby planned, node added by tap and tuned (drag strip, steps, decimal comma), submitted to the in-process board', async ({ page }) => {
    const h = harness.makeLeaderboard(checkpoints);
    // Every API call goes to the in-process handler; nothing leaves the machine.
    await page.route('**/api/leaderboard/**', async (route: Route) => {
      const r = route.request();
      const res = await h(r.method(), r.url(), await r.allHeaders(), r.postData() ?? undefined);
      await route.fulfill({ status: res.status, headers: res.headers, body: res.body });
    });
    const errors = await fresh(page);
    const shot = (n: string) => page.screenshot({ path: `${SHOTS}/${test.info().project.name}-e2e-${n}.png` });
    const typeInto = async (sel: string, text: string) => {
      const i = page.locator(sel);
      await i.tap();
      await i.selectText();
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    };

    await page.getByRole('tab', { name: 'Mission' }).tap();
    await page.locator('select.mission-select').tap();
    await page.locator('select.mission-select').selectOption('lunar-flyby');
    await settled(page);
    await page.getByRole('tab', { name: 'Start' }).tap();
    await page.locator('select[title="Launch site"]').tap();
    await page.locator('select[title="Launch site"]').selectOption('kourou');
    await settled(page);
    await typeInto('input[title^="Liftoff"]', '2027-01-10 20:23:04');
    await settled(page);
    await typeInto('input[title^="Inertial launch azimuth"]', '62,7669'); // decimal comma, as a German or French iPhone's pad types it
    await settled(page);
    expect(await page.evaluate(() => JSON.stringify((window as any).sendit.store.get().plan.start))).toContain('62.7669');
    await shot('1-start');

    // Lower the sheet, then tap a few px off the trajectory and "Add node here".
    await page.getByRole('tab', { name: 'Start' }).tap();
    await expect(page.locator('#hud')).toHaveAttribute('data-sheet', 'peek');
    await pinch(page, 195, 380, 80, 176);
    await page.waitForTimeout(600);
    const p = await page.evaluate(() => {
      const w = (window as any).sendit;
      const top = (document.querySelector('.bottom') as HTMLElement).getBoundingClientRect().top;
      for (let t = 2900; t < 8000; t += 30) {
        const q = w.screenAt(t);
        if (q && q.x > 30 && q.x < innerWidth - 30 && q.y > 140 && q.y < top - 30 && document.elementFromPoint(q.x + 9, q.y + 9)?.id === 'view') return q;
      }
      return null;
    });
    expect(p, 'a trajectory point on screen').not.toBeNull();
    await page.touchscreen.tap(p.x + 9, p.y + 9);
    await expect(page.locator('.tap-pop')).toBeVisible();
    await page.locator('.tap-pop').getByRole('button', { name: 'Add node here' }).tap();
    await expect(page.getByRole('tab', { name: 'Nodes' })).toHaveAttribute('aria-selected', 'true');
    await settled(page);

    // Tune: typed time and value, the drag strip, the step buttons, then a decimal comma.
    await page.locator('.sheet-grip').tap();
    await typeInto('input.met-input', '3019.5');
    await settled(page);
    await typeInto('input[title="Prograde delta-v, m/s"]', '3088');
    await settled(page);
    const prograde = page.locator('.tuner', { has: page.locator('input[title="Prograde delta-v, m/s"]') });
    const pad = prograde.locator('.tn-pad');
    await pad.scrollIntoViewIfNeeded();
    const b = (await pad.boundingBox())!;
    await drag(page, b.x + 20, b.y + b.height / 2, b.x + 95, b.y + b.height / 2, 15);
    await settled(page);
    const dv = () => page.evaluate(() => (window as any).sendit.nodesOf()[0].node.dv[0]);
    expect(await dv()).toBeCloseTo(3094, 6); // 75 px = 6 medium steps of 1 m/s
    const bump = (n: string) => prograde.getByRole('button', { name: `Prograde: +${n} m/s`, exact: true });
    for (let k = 0; k < 6; k++) await bump('10').tap();
    await bump('1').tap();
    await settled(page);
    expect(await dv()).toBeCloseTo(3155, 6);
    await typeInto('input[title="Prograde delta-v, m/s"]', '3155,2');
    await settled(page);
    expect(await dv()).toBeCloseTo(3155.2, 6);
    await expect(page.locator('.chip')).toContainText('Mission complete');
    await shot('2-tuned');

    // Submit; the in-process server re-flies the plan.
    await page.getByRole('tab', { name: 'Results' }).tap();
    await page.getByRole('button', { name: 'Submit to leaderboard' }).tap();
    const dlg = page.locator('dialog.lb');
    await dlg.locator('#lb-name').tap();
    await page.keyboard.type('Test Pilot');
    await dlg.getByRole('button', { name: 'Submit flight' }).tap();
    await expect(dlg.locator('.ok-line')).toContainText('Accepted as Test Pilot', { timeout: 60_000 });
    await expect(dlg.locator('.lb-result')).toContainText('matches your flight bit for bit');
    await dlg.getByRole('button', { name: 'View leaderboard' }).tap();
    await expect(dlg.locator('tr.me')).toContainText('Test Pilot');
    await shot('3-board');
    expect(await noPageScroll(page)).toEqual({ sx: 0, sy: 0, scale: 1, wide: false });
    expect(errors).toEqual([]);
  });
});
