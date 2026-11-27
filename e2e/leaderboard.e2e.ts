/**
 * The leaderboard UI against the REAL handler, in-process (e2e/leaderboard-harness.ts:
 * real HTTP layer, service, store over the in-memory DynamoDB fake, real engine
 * replaying plans), served to the page through Playwright request routing.
 *
 *  1. The phone flow, touch only, at 390 x 844: pick the lunar flyby, set the
 *     launch, pinch the map, tap the trajectory, "Add node here", tune the
 *     node with the drag strip and the step buttons, see the objectives
 *     complete, submit, and find the entry on the board (paging past 25
 *     earlier players). Timed.
 *  2. Desktop: the API absent (no route): nothing fetched on load, a short
 *     note on demand; every API refusal the UI can meet (mission updated, rule
 *     violation with reasons, objectives not met, rate limited, unreachable);
 *     "View flight" only when the server publishes plans; identity export.
 * Screenshots go to test-results/leaderboard/.
 */
import { devices, expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/leaderboard';
const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(import.meta.dirname, '.dist-node/leaderboard');

test.skip(({ browserName }) => browserName === 'firefox', 'Firefox: these flows run in Chromium and WebKit; Firefox has the smaller smoke.e2e.ts (and CI Linux Firefox has no WebGL)');
test.describe.configure({ mode: 'serial' });

type Handler = (method: string, url: string, headers: Record<string, string>, body: string | undefined) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
let harness: { makeLeaderboard(c: Uint8Array, o?: { variant?: string; config?: Record<string, unknown> }): Handler };
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

async function serve(page: Page, h: Handler): Promise<string[]> {
  const seen: string[] = [];
  await page.route('**/api/leaderboard/**', async (route: Route) => {
    const r = route.request();
    seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
    const res = await h(r.method(), r.url(), await r.allHeaders(), r.postData() ?? undefined);
    await route.fulfill({ status: res.status, headers: res.headers, body: res.body });
  });
  return seen;
}

function watch(page: Page, allow: RegExp | null = null): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text()) && !(allow && allow.test(m.text()))) errors.push(m.text());
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

/** Lunar flyby solved through the editor API (desktop tests that are about the leaderboard, not the editing). */
async function solvedLunarFlyby(page: Page): Promise<void> {
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await settled(page); // WebKit reports the outgoing page's in-flight worker fetches as errors if it is reloaded mid-load
  await page.goto(`${BASE}/`);
  await settled(page);
  await page.evaluate(() => {
    const w = (window as any).sendit;
    w.editor.selectMission('lunar-flyby');
    const t = Date.UTC(2027, 0, 10, 20, 23, 4) / 1000 - Date.UTC(2000, 0, 1, 12) / 1000;
    w.editor.setLaunch({ site: 'kourou', time: t, azimuthDeg: 62.7669, altitudeM: 200e3 });
    w.editor.addNode(3019.5, { kind: 'orbital', body: 'earth' }, [3155.2, 0, 0]);
  });
  await settled(page);
  expect(await page.evaluate(() => (window as any).sendit.store.get().replay.evaluation.success)).toBe(true);
}

/** The mission's current version, as the server lists it (never hard-coded: missions get new versions). */
async function currentVersion(h: Handler, id: string): Promise<string> {
  const r = await h('GET', 'http://x/api/leaderboard/missions', {}, undefined);
  expect(r.status, r.body).toBe(200);
  return String(JSON.parse(r.body).missions.find((m: { id: string }) => m.id === id).version);
}

const encodedPlan = (page: Page) => page.evaluate(() => new URLSearchParams(new URL((window as any).sendit.shareUrl()).hash.slice(1)).get('p')!);

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, userAgent: devices['iPhone 13'].userAgent });

  test('touch only: lunar flyby planned, tuned, completed, submitted and found on the board', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'drives touch through CDP Input.dispatchTouchEvent (Chromium only); the WebKit touch flow is mobile.e2e.ts');

    const errors = watch(page);
    const h = harness.makeLeaderboard(checkpoints);
    await serve(page, h);
    await page.goto(`${BASE}/`);
    await page.evaluate(() => localStorage.clear());
    await settled(page); // WebKit reports the outgoing page's in-flight worker fetches as errors if it is reloaded mid-load
    await page.goto(`${BASE}/`);
    await settled(page);
    const t0 = Date.now();
    const step: string[] = [];
    const mark = (s: string) => step.push(`${((Date.now() - t0) / 1000).toFixed(1)} s ${s}`);

    // Mission.
    await page.getByRole('tab', { name: 'Mission' }).tap();
    await page.locator('select.mission-select').tap();
    await page.locator('select.mission-select').selectOption('lunar-flyby'); // the native picker's choice
    await settled(page);
    await page.screenshot({ path: `${SHOTS}/phone-1-mission.png` });
    mark('mission chosen');

    // Launch into the Moon's plane: liftoff and azimuth typed on the on-screen keyboard.
    await page.getByRole('tab', { name: 'Start' }).tap();
    const typeInto = async (sel: string, text: string) => {
      const i = page.locator(sel);
      await i.tap();
      await i.selectText();
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    };
    // The mission opens at its par site; this plan launches from Kourou (the native picker's choice).
    await page.locator('select[title="Launch site"]').tap();
    await page.locator('select[title="Launch site"]').selectOption('kourou');
    await settled(page);
    await typeInto('input[title^="Liftoff"]', '2027-01-10 20:23:04');
    await settled(page);
    await typeInto('input[title^="Inertial launch azimuth"]', '62.7669');
    await settled(page);
    await page.screenshot({ path: `${SHOTS}/phone-2-start.png` });
    mark('launch set');

    // Lower the sheet to see the map; pinch out to enlarge the parking orbit.
    await page.getByRole('tab', { name: 'Start' }).tap();
    await expect(page.locator('#hud')).toHaveAttribute('data-sheet', 'peek');
    const cdp = await page.context().newCDPSession(page);
    const c = { x: 195, y: 380 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x - 40, y: c.y, id: 1 }, { x: c.x + 40, y: c.y, id: 2 }] });
    for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x - 40 - 8 * k, y: c.y, id: 1 }, { x: c.x + 40 + 8 * k, y: c.y, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const dist = await page.evaluate(() => (window as any).sendit.camera.targetDistance);
    expect(dist).toBeLessThan(6e7 * 0.75);
    await page.waitForTimeout(600);

    // Tap near the trajectory (a few px off the line), then "Add node here".
    // A point of the parking orbit that is on screen above the sheet (the exact time is typed below).
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
    await page.screenshot({ path: `${SHOTS}/phone-3-tap-trajectory.png` });
    await page.locator('.tap-pop').getByRole('button', { name: 'Add node here' }).tap();
    await expect(page.locator('#hud')).toHaveAttribute('data-sheet', 'half');
    await expect(page.getByRole('tab', { name: 'Nodes' })).toHaveAttribute('aria-selected', 'true');
    await settled(page);
    mark('node added by tapping the trajectory');

    // Tune: exact time and a first prograde value typed, then the drag strip (medium steps) and the step buttons.
    await page.locator('.sheet-grip').tap(); // half -> full
    await typeInto('input.met-input', '3019.5');
    await settled(page);
    await typeInto('input[title="Prograde delta-v, m/s"]', '3088');
    await settled(page);
    const prograde = page.locator('.tuner', { has: page.locator('input[title="Prograde delta-v, m/s"]') });
    const pad = prograde.locator('.tn-pad');
    await pad.scrollIntoViewIfNeeded();
    const b = (await pad.boundingBox())!;
    const y = b.y + b.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + 20, y }] });
    for (let k = 1; k <= 15; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: b.x + 20 + 5 * k, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settled(page);
    const dv = () => page.evaluate(() => (window as any).sendit.nodesOf()[0].node.dv[0]);
    expect(await dv()).toBeCloseTo(3094, 6); // 75 px = 6 medium steps of 1 m/s
    const bump = (n: string) => prograde.getByRole('button', { name: `Prograde: +${n} m/s`, exact: true });
    for (let k = 0; k < 6; k++) await bump('10').tap();
    await bump('1').tap();
    await bump('0.1').tap();
    await bump('0.1').tap();
    await settled(page);
    expect(await dv()).toBeCloseTo(3155.2, 6);
    mark('node tuned');
    await page.screenshot({ path: `${SHOTS}/phone-4-tuned.png` });

    // Objectives complete.
    await expect(page.locator('.chip')).toContainText('Mission complete');
    await page.getByRole('tab', { name: 'Mission' }).tap();
    await expect(page.locator('.obj.ok')).toHaveCount(3);
    await page.screenshot({ path: `${SHOTS}/phone-5-complete.png` });
    mark('objectives complete');

    // 25 earlier players flew the same plan (so the player's entry is beyond the first page).
    const plan = await encodedPlan(page);
    const missionVersion = await currentVersion(h, 'lunar-flyby');
    for (let i = 0; i < 25; i++) {
      const body = JSON.stringify({ missionId: 'lunar-flyby', missionVersion, plan, name: `Pilot ${i + 1}`, secret: `seed${i}`.padEnd(43, 'x') });
      const r = await h('POST', 'http://x/api/leaderboard/submit', { 'cloudfront-viewer-address': `203.0.113.${i + 1}:443`, 'content-length': String(body.length) }, body);
      expect(r.status, r.body).toBe(200);
    }

    // Submit.
    await page.getByRole('tab', { name: 'Results' }).tap();
    await page.getByRole('button', { name: 'Submit to leaderboard' }).tap();
    const dlg = page.locator('dialog.lb');
    await dlg.locator('#lb-name').tap();
    await page.keyboard.type('Ada Touch');
    await dlg.getByRole('button', { name: 'Submit flight' }).tap();
    await expect(dlg.locator('.ok-line')).toContainText('Accepted as Ada Touch', { timeout: 60_000 });
    await expect(dlg.locator('.lb-result')).toContainText('matches your flight bit for bit');
    await page.screenshot({ path: `${SHOTS}/phone-6-submitted.png` });
    mark('submitted (server re-flew the plan)');

    // The board: own rank shown though outside the first page, then paging reaches the highlighted row.
    await dlg.getByRole('button', { name: 'View leaderboard' }).tap();
    await expect(dlg.locator('.lb-table tbody tr')).toHaveCount(20);
    await expect(dlg.locator('.lb-you')).toContainText('#26');
    await page.screenshot({ path: `${SHOTS}/phone-7-board.png` });
    await dlg.getByRole('button', { name: 'Show more' }).tap();
    await expect(dlg.locator('tr.me')).toContainText('Ada Touch');
    await dlg.locator('tr.me').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/phone-8-board-me.png` });
    mark('entry found on the board');
    // No view-flight affordance: plans are private by default.
    expect(await dlg.getByRole('button', { name: 'View flight' }).count()).toBe(0);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(sw).toBe(true);
    console.log(`phone end-to-end, touch only (${((Date.now() - t0) / 1000).toFixed(1)} s driven):\n  ${step.join('\n  ')}`);
    expect(errors).toEqual([]);
  });
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('API absent: nothing fetched on load, a short note on demand, no error dialog', async ({ page }) => {
    const errors = watch(page, /Failed to load resource.*404/);
    const api: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/')) api.push(r.url());
    });
    await solvedLunarFlyby(page);
    expect(api).toEqual([]);
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some((r) => /\/client-[\w-]+\.js$/.test(r.name)))).toBe(false); // lazy chunk not loaded
    await page.getByRole('button', { name: 'Submit to leaderboard' }).click();
    const dlg = page.locator('dialog.lb');
    await expect(dlg).toContainText('not online on this site yet');
    await page.screenshot({ path: `${SHOTS}/desktop-1-absent.png` });
    await dlg.getByRole('button', { name: 'Close leaderboard' }).click();
    await expect(page.getByRole('button', { name: 'Submit to leaderboard' })).toBeDisabled();
    await expect(page.locator('.lb-note')).toContainText('not online yet');
    expect(errors).toEqual([]);
  });

  for (const [name, variant, config, expectText, items] of [
    ['mission updated on the server', 'mission-updated', {}, 'This mission has changed', null],
    ['rule violation with reasons', 'stricter-rules', {}, 'The plan breaks the mission rules', /site/i],
    ['objectives not met on the server', 'stricter-objectives', {}, 'Objectives not met on the server', /flyby/],
  ] as const) {
    test(`refusal: ${name}`, async ({ page }) => {
      const errors = watch(page, /Failed to load resource.*(409|422)/);
      await serve(page, harness.makeLeaderboard(checkpoints, { variant, config }));
      await solvedLunarFlyby(page);
      await page.getByRole('button', { name: 'Submit to leaderboard' }).click();
      const dlg = page.locator('dialog.lb');
      await dlg.locator('#lb-name').fill('Grace');
      await dlg.getByRole('button', { name: 'Submit flight' }).click();
      await expect(dlg.locator('.lb-error')).toContainText(expectText, { timeout: 60_000 });
      if (items) await expect(dlg.locator('.lb-error li').first()).toContainText(items);
      if (variant === 'mission-updated') await expect(dlg.getByRole('button', { name: 'Reload page' })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/desktop-2-${variant}.png` });
      expect(errors).toEqual([]);
    });
  }

  test('refusal: rate limited, then unreachable', async ({ page }) => {
    const errors = watch(page, /Failed to load resource.*429|net::ERR_FAILED/);
    await serve(page, harness.makeLeaderboard(checkpoints, { config: { playerLimits: [[1, 600]] } }));
    await solvedLunarFlyby(page);
    await page.getByRole('button', { name: 'Submit to leaderboard' }).click();
    const dlg = page.locator('dialog.lb');
    await dlg.locator('#lb-name').fill('Grace');
    await dlg.getByRole('button', { name: 'Submit flight' }).click();
    await expect(dlg.locator('.ok-line')).toBeVisible({ timeout: 60_000 });
    await dlg.getByRole('button', { name: 'Submit flight' }).click();
    await expect(dlg.locator('.lb-error')).toContainText('Too many submissions');
    await expect(dlg.locator('.lb-error')).toContainText('Please wait');
    await page.screenshot({ path: `${SHOTS}/desktop-3-rate-limited.png` });
    // The server goes away.
    await page.unroute('**/api/leaderboard/**');
    await page.route('**/api/leaderboard/**', (r) => r.abort('failed'));
    await dlg.getByRole('button', { name: 'Submit flight' }).click();
    await expect(dlg.locator('.lb-error')).toContainText('Leaderboard unreachable', { timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/desktop-4-unreachable.png` });
    expect(errors).toEqual([]);
  });

  test('boards: tabs, own row, "View flight" only when plans are public; identity export', async ({ page }) => {
    const errors = watch(page);
    const h = harness.makeLeaderboard(checkpoints, { config: { exposePlans: true } });
    await serve(page, h);
    await solvedLunarFlyby(page);
    await page.getByRole('button', { name: 'Submit to leaderboard' }).click();
    const dlg = page.locator('dialog.lb');
    await dlg.locator('#lb-name').fill('Grace');
    await dlg.getByRole('button', { name: 'Submit flight' }).click();
    await expect(dlg.locator('.ok-line')).toBeVisible({ timeout: 60_000 });
    await dlg.getByRole('button', { name: 'View leaderboard' }).click();
    await expect(dlg.locator('tr.me')).toContainText('Grace');
    for (const tab of ['Δv', 'Time', 'Score']) {
      await dlg.getByRole('tab', { name: tab }).click();
      await expect(dlg.locator('tr.me')).toBeVisible();
    }
    await expect(dlg.getByRole('button', { name: 'View flight' })).toHaveCount(1);
    await dlg.locator('summary', { hasText: 'identity key' }).click();
    await expect(dlg).toContainText('Losing it means losing ownership of your entries');
    await dlg.getByRole('button', { name: 'Show key' }).click();
    expect(await dlg.locator('.lb-secret').inputValue()).toMatch(/^[A-Za-z0-9_-]{43,64}$/);
    await page.screenshot({ path: `${SHOTS}/desktop-5-board-public.png` });
    page.on('dialog', (d) => void d.accept());
    await dlg.getByRole('button', { name: 'View flight' }).click();
    await expect(dlg).not.toBeVisible();
    expect(errors).toEqual([]);
  });

  test('launch sites: a Kourou flight is judged by Kourou\'s limits, ranked on the Kourou and all-sites boards; site filter', async ({ page }) => {
    const errors = watch(page);
    const h = harness.makeLeaderboard(checkpoints);
    await serve(page, h);
    await solvedLunarFlyby(page); // launched from Kourou, not the mission's default site
    const def = JSON.parse((await h('GET', 'http://x/api/leaderboard/missions', {}, undefined)).body).missions.find((m: any) => m.id === 'lunar-flyby');
    const kourou = def.sites.find((x: any) => x.id === 'kourou');
    const others = def.sites.filter((x: any) => x.offered && x.id !== 'kourou');
    expect(kourou.offered).toBe(true);
    const kName = String(kourou.name).split(',')[0];
    // The objectives shown are Kourou's limits (the ones evaluate applies), not another site's.
    const fmt = (v: number) => `${v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m/s`;
    await expect(page.locator('.objectives')).toContainText(`Use at most ${fmt(kourou.maxDeltaV)}`);
    for (const o of others.filter((x: any) => x.maxDeltaV !== kourou.maxDeltaV)) await expect(page.locator('.objectives')).not.toContainText(`Use at most ${fmt(o.maxDeltaV)}`);
    expect(await page.evaluate(() => (window as any).sendit.store.get().replay.evaluation.site)).toBe('kourou');
    const other = others[0].id;
    await page.getByRole('button', { name: 'Submit to leaderboard' }).click();
    const dlg = page.locator('dialog.lb');
    await dlg.locator('#lb-name').fill('Kira');
    await dlg.getByRole('button', { name: 'Submit flight' }).click();
    await expect(dlg.locator('.ok-line')).toBeVisible({ timeout: 60_000 });
    // Both rank sets: all sites and the site flown.
    await expect(dlg.locator('.lb-result thead')).toContainText('All sites');
    await expect(dlg.locator('.lb-result thead')).toContainText(kName);
    await expect(dlg.locator('.lb-site-rank').first()).toContainText('#1');
    await page.screenshot({ path: `${SHOTS}/desktop-6-site-ranks.png` });
    await dlg.getByRole('button', { name: 'View leaderboard' }).click();
    // Filter defaults to the plan's site; All sites is first.
    const sel = dlg.locator('select.lb-site');
    await expect(sel).toHaveValue('kourou');
    expect(await sel.locator('option').first().textContent()).toBe('All sites');
    await expect(dlg.locator('tr.me')).toContainText('Kira');
    await expect(dlg.locator('tr.me .lb-site-cell')).toContainText(kName);
    await sel.selectOption('all');
    await expect(dlg.locator('tr.me')).toContainText('Kira');
    await expect(dlg.locator('tr.me .lb-site-cell')).toContainText(kName);
    await page.screenshot({ path: `${SHOTS}/desktop-7-all-sites.png` });
    await sel.selectOption(other);
    await expect(dlg.locator('tr.me')).toHaveCount(0);
    await expect(dlg.locator('.lb-mine')).toContainText('no entry from');
    expect(errors).toEqual([]);
  });
});
