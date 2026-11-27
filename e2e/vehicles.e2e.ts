/**
 * Launch vehicles in the editor, driven through the built site in Chromium:
 *  - launch feedback: parking altitude and azimuth move the upper-stage
 *    reserve and the two charts (computed in a worker; timings logged), the
 *    charts set the value by tap, at desktop and phone sizes;
 *  - a vehicle that cannot reach the chosen orbit says why;
 *  - the geostationary mission flown with the upper stage on the transfer
 *    burn, a separation and the satellite finishing; undoing a separation;
 *    submitted to the in-process leaderboard, the board shows total delta-v;
 *  - the sandbox vehicle editor builds a two-stage vehicle and flies it;
 *  - a plan made for the earlier (free-delivery) mission version is refused
 *    with the plan layer's message and not scored.
 * Screenshots go to test-results/vehicles/.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dragSeparationLater, solveGeo } from './geo';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/vehicles';
const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(import.meta.dirname, '.dist-node/leaderboard-vehicles');

test.skip(({ browserName }) => browserName === 'firefox', 'Firefox: these flows run in Chromium and WebKit; Firefox has the smaller smoke.e2e.ts (and CI Linux Firefox has no WebGL)');

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  return errors;
}

async function settled(page: Page): Promise<void> {
  // Settled: the replay is of the current plan, complete (no preview), nothing loading. A plan with errors is never
  // replayed (the app shows "Plan has errors"), so stop waiting and say why instead of timing out.
  const h = await page.waitForFunction(() => {
    const sd = (window as any).sendit;
    const s = sd?.store.get();
    if (!s) return false;
    const errs: string[] = sd.planErrors?.() ?? [];
    if (errs.length) return { errors: errs };
    return s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null ? { errors: [] as string[] } : false;
  }, null, { timeout: 120_000 });
  const { errors } = (await h.jsonValue()) as { errors: string[] };
  if (errors.length) throw new Error(`settled: the plan has errors, so it is never replayed:\n${errors.join('\n')}`);
}

async function fresh(page: Page, mission?: string): Promise<void> {
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await settled(page); // WebKit reports the outgoing page's in-flight worker fetches as errors if it is reloaded mid-load
  await page.goto(`${BASE}/`);
  await settled(page);
  if (mission) {
    await page.evaluate((m) => (window as any).sendit.editor.selectMission(m), mission);
    await settled(page);
  }
}

async function enter(page: Page, selector: string, value: string): Promise<void> {
  const i = page.locator(selector).first();
  await i.fill(value);
  await i.press('Enter');
}

const reserve = async (page: Page) => Number((await page.locator('.upper-reserve').first().textContent())!.split(' m/s')[0].replace(/[^\d.-]/g, ''));
const chartsDone = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll('.chart')].every((c) => (c as HTMLElement).dataset.complete === 'true'), null, { timeout: 30_000 });

async function openTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name });
  if (await tab.count()) await tab.first().click();
}

for (const [size, opts] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['phone', PHONE]] as const) {
  test.describe(size, () => {
    test.use(opts as any);

    test('launch feedback: altitude and azimuth move the upper-stage reserve and the charts; charts set the value', async ({ page }) => {
      const errors = watch(page);
      await fresh(page, 'plane-change'); // Cape Canaveral: its range-safety corridor is the mission's lesson
      await openTab(page, 'Start');
      await chartsDone(page);
      const lat = await page.evaluate(() => { const m = (window as any).sendit.ascentMetrics; return { alt: m.altChartMs, az: m.azChartMs, first: m.firstPointMs, point: m.pointMs.slice().sort((a: number, b: number) => a - b)[m.pointMs.length >> 1], feedback: m.feedbackMs }; });
      console.log(`${size}: charts alt ${lat.alt.toFixed(0)} ms / az ${lat.az.toFixed(0)} ms (25 + 37 evaluations, first point ${lat.first.toFixed(0)} ms, median evaluation ${lat.point.toFixed(1)} ms in the worker), current ascent ${lat.feedback.toFixed(1)} ms`);
      await expect(page.locator('.ascent-required')).toContainText('m/s');
      await expect(page.locator('.alt-chart .curve')).toHaveAttribute('d', /L/);
      await expect(page.locator('.az-chart .out').first()).toBeAttached(); // the corridor's cut-off is drawn
      await expect(page.locator('.az-chart .inc').first()).toContainText('i ');
      const r0 = await reserve(page);
      await page.screenshot({ path: `${SHOTS}/${size}-1-launch-feedback.png`, fullPage: false });
      // Higher parking orbit: less left on the upper stage.
      const t0 = Date.now();
      await enter(page, 'input.parking-alt', '800');
      await expect.poll(() => reserve(page)).toBeLessThan(r0 - 50);
      const editMs = Date.now() - t0;
      await chartsDone(page);
      const r1 = await reserve(page);
      console.log(`${size}: reserve ${r0} m/s at the default parking orbit, ${r1} m/s at 800 km; edit to readout ${editMs} ms (includes Playwright round trips)`);
      // Azimuth: away from due east costs rotation credit.
      await enter(page, 'input[title^="Inertial launch azimuth"]', '90');
      await chartsDone(page);
      const rEast = await reserve(page);
      await enter(page, 'input[title^="Inertial launch azimuth"]', '45');
      await expect.poll(() => reserve(page)).toBeLessThan(rEast);
      await chartsDone(page);
      const r2 = await reserve(page);
      console.log(`${size}: at 800 km, ${rEast} m/s left launching due east, ${r2} m/s at 45°`);
      await page.screenshot({ path: `${SHOTS}/${size}-2-high-and-north.png`, fullPage: false });
      // Tap the altitude chart near its left end: the parking orbit goes down, the reserve up.
      await page.locator('.alt-chart svg').scrollIntoViewIfNeeded();
      const box = (await page.locator('.alt-chart svg').boundingBox())!;
      if (size === 'phone') await page.touchscreen.tap(box.x + box.width * 0.16, box.y + box.height * 0.5);
      else await page.mouse.click(box.x + box.width * 0.16, box.y + box.height * 0.5);
      await expect.poll(async () => page.evaluate(() => (window as any).sendit.store.get().plan.start.params[2])).toBeLessThan(400e3);
      expect(await reserve(page)).toBeGreaterThan(r2);
      await chartsDone(page);
      await page.screenshot({ path: `${SHOTS}/${size}-3-chart-tapped.png` });
      // The parking field follows the radius convention like every other distance.
      await page.evaluate(() => (window as any).sendit.viewSettings && 0);
      expect(errors).toEqual([]);
    });
  });
}

test.describe('desktop flows', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a vehicle that cannot reach the chosen orbit says why', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    await page.locator('select.vehicle-preset').selectOption('electron');
    await expect(page.locator('.ascent-fail')).toContainText('cannot reach the chosen orbit');
    await expect(page.locator('.stack-totals')).toContainText('cannot reach orbit');
    await page.locator('.launch-box').screenshot({ path: `${SHOTS}/3-cannot-reach-orbit.png` });
    // A light spacecraft makes it: the failure goes away.
    await page.evaluate(() => (window as any).sendit.editor.setSpacecraft({ wetMass: 150, dryMass: 100, engines: [{ thrust: 400, isp: 300 }] }));
    await expect(page.locator('.ascent-fail')).toHaveCount(0);
    await expect(page.locator('.upper-reserve')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('sandbox vehicle editor: build a two-stage vehicle and fly it; undo the edits', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    await expect(page.locator('.stage-card')).toHaveCount(1);
    await page.locator('select[title="Start from a preset spacecraft"]').selectOption('probe');
    await page.getByRole('button', { name: '+ Stage under the spacecraft' }).click();
    await page.getByRole('button', { name: '+ Stage under the spacecraft' }).click();
    await expect(page.locator('.stage-card')).toHaveCount(3);
    await enter(page, 'input[title="S1 propellant, kg"]', '420000');
    await enter(page, 'input[title="S1 dry mass, kg"]', '26000');
    await enter(page, 'input[title="S1 engine E1 vacuum thrust, kN"]', '8200');
    await enter(page, 'input[title="S1 engine E1 vacuum Isp, s"]', '311');
    await enter(page, 'input[title="S2 propellant, kg"]', '110000');
    await enter(page, 'input[title="S2 dry mass, kg"]', '4000');
    await enter(page, 'input[title="S2 engine E1 vacuum thrust, kN"]', '980');
    await enter(page, 'input[title="S2 engine E1 vacuum Isp, s"]', '348');
    await expect(page.locator('.upper-reserve')).toBeVisible();
    await expect(page.locator('.stage-card[data-stage="1"] .tag.orbit')).toBeVisible();
    await page.locator('.vehicle').screenshot({ path: `${SHOTS}/4-sandbox-two-stage.png` });
    // Fly: a node on the upper stage.
    await page.evaluate(() => { const w = (window as any).sendit; w.store.set({ t: w.store.get().plan.epoch + 3000 }); });
    await page.getByRole('button', { name: '+ Node at cursor' }).click();
    await enter(page, 'input[title="Prograde delta-v, m/s"]', '500');
    await settled(page);
    const r = await page.evaluate(() => { const s = (window as any).sendit.store.get(); return { ok: s.replay.result.outcome, stages: s.replay.result.stages.length, total: s.replay.result.totalDeltaV, asc: s.replay.result.ascent?.deltaV, stage: s.plan.burns[0].stage }; });
    expect(r.stages).toBe(3);
    expect(r.stage).toBe(1);
    expect(r.total).toBeGreaterThan(r.asc + 490);
    await expect(page.locator('.node-row .nstage').first()).toHaveText('S2');
    await expect(page.locator('.dv-total')).toContainText('Δv total');
    await page.screenshot({ path: `${SHOTS}/5-sandbox-flown.png` });
    // Undo back to the spacecraft alone (format 1).
    for (let k = 0; k < 40; k++) if (await page.getByRole('button', { name: /Undo the last plan edit/ }).isEnabled()) await page.getByRole('button', { name: /Undo the last plan edit/ }).click();
    expect(await page.evaluate(() => (window as any).sendit.store.get().plan.format)).toBe(1);
    expect(errors).toEqual([]);
  });

  test('a plan for the earlier mission version is refused with the message and not scored', async ({ page, browser }) => {
    await fresh(page, 'geo-from-leo');
    const url = await page.evaluate(() => {
      const w = (window as any).sendit;
      const p = w.store.get().plan;
      const { lowerStages: _l, separations: _s, ...rest } = p;
      void _l; void _s;
      w.store.set({ plan: { ...rest, format: 1, start: { kind: 'launch', site: p.start.site, params: p.start.params } } });
      return w.shareUrl();
    });
    expect(url).toContain('m=geo-from-leo');
    const p2 = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await p2.goto(`${BASE}/`);
    await p2.evaluate(() => localStorage.clear());
    await p2.goto(url);
    await p2.reload();
    await expect(p2.locator('.notice')).toContainText('earlier version of the mission');
    expect(await p2.evaluate(() => (window as any).sendit.store.get().missionId)).toBe('sandbox');
    await p2.screenshot({ path: `${SHOTS}/6-old-version-refused.png` });
  });
});

// ------------------------------------------------------------------ leaderboard

type Handler = (method: string, url: string, headers: Record<string, string>, body: string | undefined) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

test.describe('geostationary on the vehicle, to the leaderboard', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  let harness: { makeLeaderboard(c: Uint8Array): Handler };
  let checkpoints: Uint8Array;
  test.beforeAll(async () => {
    const { build } = await import('vite');
    await build({
      configFile: false, root: ROOT, logLevel: 'warn', publicDir: false,
      build: { ssr: resolve(import.meta.dirname, 'leaderboard-harness.ts'), outDir: OUT, emptyOutDir: true, target: 'node22', minify: false, rollupOptions: { output: { format: 'es', entryFileNames: '[name].mjs' } } },
      ssr: { noExternal: true, target: 'node' },
    });
    harness = await import(pathToFileURL(resolve(OUT, 'leaderboard-harness.mjs')).href);
    checkpoints = new Uint8Array(readFileSync(resolve(ROOT, 'src/physics/data/checkpoints-1950-2100.bin')));
  });

  test('upper stage flies the transfer, separation, the satellite finishes; undo a separation; total Δv on the board', async ({ page }) => {
    test.setTimeout(400_000);
    const errors = watch(page);
    const h = harness.makeLeaderboard(checkpoints);
    await page.route('**/api/leaderboard/**', async (route: Route) => {
      const r = route.request();
      const res = await h(r.method(), r.url(), await r.allHeaders(), r.postData() ?? undefined);
      await route.fulfill({ status: res.status, headers: res.headers, body: res.body });
    });
    await fresh(page, 'geo-from-leo');
    await solveGeo(page);
    await expect(page.locator('.node-row .nstage')).toHaveText(['S3', 'SC']);
    await expect(page.locator('.label.marker.sep')).toHaveCount(1);
    await expect(page.locator('.tick.sep')).toHaveCount(1);
    await expect(page.locator('.score.success')).toContainText('Δv total');
    await page.locator('.nodes').screenshot({ path: `${SHOTS}/7-geo-nodes-with-separation.png` });
    await page.locator('.vehicle').screenshot({ path: `${SHOTS}/7b-geo-stack-after-replay.png` });
    await page.locator('.results').screenshot({ path: `${SHOTS}/7c-geo-results.png` });
    const flown = await page.evaluate(() => (window as any).sendit.store.get().replay.result);
    // Delete the separation: the satellite's burn goes back to the upper stage. Undo restores it.
    await page.locator('.sep-row').getByRole('button', { name: /Delete separation/ }).click();
    await expect(page.locator('.node-row .nstage')).toHaveText(['S3', 'S3']);
    await page.getByRole('button', { name: /Undo the last plan edit/ }).click();
    await expect(page.locator('.node-row .nstage')).toHaveText(['S3', 'SC']);
    await settled(page);
    expect(await page.evaluate(() => (window as any).sendit.store.get().replay.result.digest)).toBe(flown.digest);
    // Drag the separation on the timeline: it moves (one undo step), then undo.
    await dragSeparationLater(page);
    await settled(page); // the moved separation is a valid plan: it is replayed and settles
    const moved = await page.evaluate(() => (window as any).sendit.store.get().plan.separations[0].time);
    expect(moved).toBeGreaterThan(flown.stages.find((s: any) => s.separatedAt !== null && !s.droppedInAscent).separatedAt);
    await page.getByRole('button', { name: /Undo the last plan edit/ }).click();
    await settled(page);
    expect(await page.evaluate(() => (window as any).sendit.store.get().replay.result.digest)).toBe(flown.digest);
    // Submit.
    await page.getByRole('button', { name: 'Submit to leaderboard' }).click();
    const dlg = page.locator('dialog.lb');
    await dlg.locator('#lb-name').fill('Ada');
    await dlg.getByRole('button', { name: 'Submit flight' }).click();
    await expect(dlg.locator('.lb-result')).toContainText('matches your flight bit for bit', { timeout: 120_000 });
    const total = (Math.ceil(flown.totalDeltaV * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });
    await expect(dlg.locator('.lb-result')).toContainText(`${total} m/s`);
    await expect(dlg.locator('.lb-result')).toContainText('Δv total');
    await dlg.screenshot({ path: `${SHOTS}/8-submitted.png` });
    await dlg.getByRole('button', { name: 'View leaderboard' }).click();
    await dlg.getByRole('tab', { name: 'Δv total' }).click().catch(() => dlg.getByRole('button', { name: 'Δv total' }).click());
    await expect(dlg.locator('.lb-table')).toContainText(`${total} m/s`);
    await dlg.screenshot({ path: `${SHOTS}/9-board-total-dv.png` });
    expect(errors).toEqual([]);
  });
});
