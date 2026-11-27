/**
 * The flight-plan editor, driven through the built site in Chromium: launch
 * and inclination, tuning a trans-lunar burn into a flyby, a lunar impact,
 * solving a mission, and a share link reproducing the replay digest.
 * Screenshots go to test-results/editor/ for a human to look at.
 * Edit-to-redraw latency is measured for a 10-day lunar flight and a 2-year
 * interplanetary coast and printed.
 */
import { expect, test, type Page } from '@playwright/test';
import { solveGeo } from './geo';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/editor';

test.skip(({ browserName }) => browserName === 'firefox', 'Firefox: these flows run in Chromium and WebKit; Firefox has the smaller smoke.e2e.ts (and CI Linux Firefox has no WebGL)');
test.describe.configure({ mode: 'serial' });

interface Snapshot {
  outcome: string;
  digest: string;
  latency: number;
  replayMs: number;
  events: { kind: string; body: string; alt: number; speed: number }[];
  objectives: boolean[] | null;
  success: boolean | null;
  score: number | null;
}

const errors: string[] = [];
function watch(page: Page): void {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
}

/** Wait until the replay shown is of the current plan, and return it. */
async function settled(page: Page): Promise<Snapshot> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle';
  }, null, { timeout: 60_000 });
  return page.evaluate(() => {
    const s = (window as any).sendit.store.get();
    const r = s.replay;
    return {
      outcome: r.result.outcome,
      digest: r.result.digest,
      latency: r.latencyMs,
      replayMs: r.replayMs,
      events: r.result.events.filter((e: any) => e.kind !== 'apoapsis').map((e: any) => ({ kind: e.kind, body: e.body, alt: e.altitude, speed: e.speed })),
      objectives: r.evaluation ? r.evaluation.objectives.map((o: any) => o.ok) : null,
      success: r.evaluation ? r.evaluation.success : null,
      score: r.evaluation ? r.evaluation.score : null,
    };
  });
}

async function fresh(page: Page): Promise<void> {
  watch(page);
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await settled(page); // WebKit reports the outgoing page's in-flight worker fetches as errors if it is reloaded mid-load
  await page.goto(`${BASE}/`);
  await settled(page);
}

async function enter(page: Page, selector: string, value: string): Promise<void> {
  const i = page.locator(selector);
  await i.fill(value);
  await i.press('Enter');
}

function moonCa(s: Snapshot): number {
  const ps = s.events.filter((e) => e.body === 'moon' && (e.kind === 'periapsis' || e.kind === 'impact'));
  return ps.length ? Math.min(...ps.map((e) => e.alt)) : Infinity;
}

async function lunarSetup(page: Page): Promise<void> {
  // Launch from Kourou into the Moon's plane (liftoff and azimuth from the launch-window helpers, entered by hand).
  await page.selectOption('select[title="Launch site"]', 'kourou');
  await settled(page);
  await enter(page, 'input[title^="Liftoff"]', '2027-01-10 20:23:04');
  await settled(page);
  await enter(page, 'input[title^="Inertial launch azimuth"]', '62.7669');
  await settled(page);
}

/** Wait until the app has drawn `k` more frames (screen positions read after this match the camera). */
async function frames(page: Page, k = 2): Promise<void> {
  const n0 = await page.evaluate(() => (window as any).sendit.renders());
  await page.waitForFunction(([n, kk]) => (window as any).sendit.renders() >= n + kk, [n0, k] as const);
}

async function addNodeByClick(page: Page, tMission: number): Promise<void> {
  // Look at the parking orbit from above so the click lands on it.
  await page.evaluate(() => { const w = (window as any).sendit; w.camera.setDistance(4e7, true); w.store.set({ paused: true }); });
  await frames(page);
  const p = await page.evaluate((t) => (window as any).sendit.screenAt(t, true), tMission);
  expect(p, 'trajectory point on screen').not.toBeNull();
  const before = await page.evaluate(() => (window as any).sendit.nodesOf().length);
  // A click picks the point (no node yet); "Add node here" adds it.
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('.tap-pop')).toBeVisible();
  expect(await page.evaluate(() => (window as any).sendit.nodesOf().length)).toBe(before);
  await page.locator('.tap-pop').getByRole('button', { name: 'Add node here' }).click();
  await page.waitForFunction(() => (window as any).sendit.store.get().selectedNode !== null);
}

test('launch from a site: inclination follows azimuth, range safety is enforced', async ({ page }) => {
  await fresh(page);
  const inc = page.locator('.inc-value');
  await enter(page, 'input[title^="Inertial launch azimuth"]', '90');
  const at90 = await inc.textContent();
  await enter(page, 'input[title^="Inertial launch azimuth"]', '45');
  const at45 = await inc.textContent();
  await settled(page);
  expect(parseFloat(at90!)).toBeCloseTo(28.4, 0);
  expect(parseFloat(at45!)).toBeGreaterThan(50);
  // Target inclination helper.
  await enter(page, 'input[title^="Target inclination"]', '51.6');
  await page.getByRole('button', { name: /Northerly/ }).click();
  await settled(page);
  expect(parseFloat((await inc.textContent())!)).toBeCloseTo(51.6, 1);
  await page.screenshot({ path: `${SHOTS}/1-launch-inclination.png` });
  // Outside the corridor: plan validation (mission layer) refuses the launch, the editor says so and does not fly it.
  await enter(page, 'input[title^="Inertial launch azimuth"]', '200');
  await expect(page.locator('.launch-box .error')).toContainText('outside');
  const flown = await page.evaluate(() => {
    const s = (window as any).sendit.store.get();
    return { replayIsCurrent: s.replay?.plan === s.plan, status: s.replayStatus };
  });
  expect(flown).toEqual({ replayIsCurrent: false, status: 'idle' });
  await page.screenshot({ path: `${SHOTS}/1b-range-safety.png` });
});

test('trans-lunar burn tuned into a flyby, then a lunar impact flagged as failure; latency of a 10-day flight', async ({ page }) => {
  await fresh(page);
  await lunarSetup(page);
  await addNodeByClick(page, 3019.5);
  // Precise numeric entry: node time and prograde delta-v.
  await enter(page, 'input.met-input', '3019.5');
  await enter(page, 'input[title="Prograde delta-v, m/s"]', '3100');
  let s = await settled(page);
  const ca: number[] = [moonCa(s)];
  // Coarse nudges from the keyboard: Shift is the large step (10 m/s).
  await page.locator('canvas#view').focus();
  for (let k = 0; k < 6; k++) {
    await page.keyboard.press('Shift+KeyW');
    s = await settled(page);
    ca.push(moonCa(s));
  }
  await enter(page, 'input[title="Prograde delta-v, m/s"]', '3167.2');
  s = await settled(page);
  ca.push(moonCa(s));
  console.log('closest lunar approach altitude while tuning (km):', ca.map((x) => (Number.isFinite(x) ? Math.round(x / 1000) : 'none')).join(' -> '));
  expect(moonCa(s)).toBeGreaterThan(100e3);
  expect(moonCa(s)).toBeLessThan(10_000e3);
  await expect(page.locator('.event-row.closest, .event-row.k-periapsis').filter({ hasText: 'Moon' }).first()).toBeVisible();
  await page.selectOption('select.frame-kind', 'rotating');
  await page.evaluate(() => (window as any).sendit.camera.setDistance(1.2e9, true));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/2-lunar-flyby.png` });

  // Latency: ten fine nudges (Alt: small step, 0.1 m/s) on the 10-day flight.
  const lat: number[] = [];
  const rep: number[] = [];
  for (let k = 0; k < 10; k++) {
    await page.keyboard.press(k % 2 ? 'Alt+KeyS' : 'Alt+KeyW');
    s = await settled(page);
    await page.waitForTimeout(50);
    lat.push(await page.evaluate(() => (window as any).sendit.metrics.redrawLatencyMs));
    rep.push(s.replayMs);
  }
  console.log(`10-day lunar flight: replay ${median(rep).toFixed(0)} ms median, edit->redraw ${median(lat).toFixed(0)} ms median (max ${Math.max(...lat).toFixed(0)} ms)`);

  // Impact: ignite 30 s later.
  await page.selectOption('select.frame-kind', 'inertial');
  await enter(page, 'input.met-input', '3049.5');
  s = await settled(page);
  expect(s.outcome).toBe('impact');
  await expect(page.locator('.outcome.fail')).toContainText('IMPACT');
  await expect(page.locator('.event-row.failure').first()).toContainText('IMPACT');
  await page.locator('.event-row.failure').first().click();
  await page.locator('.event-row.failure button').first().click();
  await page.evaluate(() => (window as any).sendit.camera.setDistance(2e7, true));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/3-lunar-impact.png` });
  await expect(page.locator('.label.marker.failure .text')).toBeVisible();
});

test('solve the geostationary mission by numeric entry; objectives turn complete', async ({ page }) => {
  await fresh(page);
  await page.selectOption('select.mission-select', 'geo-from-leo');
  await settled(page);
  // The reference approach: the upper stage flies the transfer, a separation drops it, the satellite circularises.
  const stages = await solveGeo(page);
  const L = await page.evaluate(() => (window as any).sendit.store.get().plan.lowerStages.length);
  expect(stages).toEqual([L - 1, L]);
  await expect(page.locator('.node-row .nstage')).toHaveText(['S3', 'SC']);
  const s = await settled(page);
  expect(s.success).toBe(true);
  expect(s.objectives!.every(Boolean)).toBe(true);
  await expect(page.locator('.score.success')).toContainText('MISSION COMPLETE');
  await expect(page.locator('.obj.ok')).toHaveCount(3);
  await page.evaluate(() => (window as any).sendit.camera.setDistance(1.6e8, true));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/4-geo-solved.png` });
  // The mission opens in Earth's surface frame: on geostationary orbit the craft holds still over one longitude.
  expect(await page.evaluate(() => (window as any).sendit.store.get().frame.kind)).toBe('surface');
  await expect(page.locator('.frame-note')).toContainText("Rotating with Earth's surface");
  await page.evaluate(() => (window as any).sendit.camera.setDistance(2.2e8, true));
  await page.waitForTimeout(600);
  const pts = await page.evaluate(() => [1.5, 2.25, 3, 3.75, 4.5].map((d) => (window as any).sendit.screenAt(d * 86400)));
  const spread = Math.max(...pts.map((p: { x: number; y: number }) => Math.hypot(p.x - pts[0].x, p.y - pts[0].y)));
  console.log(`geo in surface frame: on-screen spread over 3 days ${spread.toFixed(1)} px`);
  expect(spread).toBeLessThan(6);
  await page.evaluate(() => (window as any).sendit.store.set({ t: (window as any).sendit.store.get().plan.epoch + 2 * 86400, paused: true }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/4b-geo-surface-frame.png` });
});

test('share link reproduces the flight; bad and mismatched links are reported', async ({ page, browser }) => {
  await fresh(page);
  await lunarSetup(page);
  await page.getByRole('button', { name: '+ Node at cursor' }).click();
  await enter(page, 'input.met-input', '3069.5');
  await enter(page, 'input[title="Prograde delta-v, m/s"]', '3170.25');
  const a = await settled(page);
  const url = await page.evaluate(() => (window as any).sendit.shareUrl());
  expect(url).toContain('#m=sandbox&p=');
  const other = await browser.newContext();
  const p2 = await other.newPage();
  watch(p2);
  await p2.goto(url);
  const b = await settled(p2);
  expect(b.digest).toBe(a.digest);
  await expect(p2.locator('.digest')).toContainText(a.digest);
  await p2.screenshot({ path: `${SHOTS}/5-shared-link.png` });
  // Reload keeps work (local storage).
  await page.reload();
  expect((await settled(page)).digest).toBe(a.digest);
  // A corrupted link.
  const p3 = await other.newPage();
  watch(p3);
  await p3.goto(`${BASE}/#m=sandbox&p=Uxyz@@`);
  await expect(p3.locator('.notice')).toContainText('Could not load the shared plan');
  // A link from another data set: version mismatch, refused until adopted.
  const mismatched = await page.evaluate(() => {
    const sd = (window as any).sendit;
    const s = sd.store.get();
    const enc = new URL(sd.shareUrl()).hash;
    return { enc, data: s.plan.data };
  });
  const p4 = await other.newPage();
  watch(p4);
  const tampered = await p4.evaluate(({ enc }) => {
    // Flip the data fingerprint bytes (offset 4..7) in the encoded plan.
    const p = new URLSearchParams(enc.slice(1)).get('p')!;
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (p.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    bytes[4] ^= 0xff;
    const out = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `#m=sandbox&p=${out}`;
  }, mismatched);
  await p4.goto(`${BASE}/${tampered}`);
  await expect(p4.locator('.notice')).toContainText('version mismatch');
  const c = await settled(p4);
  expect(c.outcome).toBe('version-mismatch');
  await p4.screenshot({ path: `${SHOTS}/6-version-mismatch.png` });
  await other.close();
});

test('2-year interplanetary coast: edit-to-redraw latency', async ({ page }) => {
  await fresh(page);
  await page.selectOption('select[title="How the flight starts"]', 'state');
  await settled(page);
  await page.selectOption('select[title="Body the orbit is about"]', 'sun');
  await enter(page, 'input[title="Periapsis altitude, km"]', '148900000');
  await enter(page, 'input[title="Apoapsis altitude, km"]', '228000000');
  await enter(page, 'input[title^="Flight duration"]', '730');
  let s = await settled(page);
  await page.getByRole('button', { name: '+ Node at cursor' }).click();
  await enter(page, 'input.met-input', '20d');
  s = await settled(page);
  await page.locator('canvas#view').focus(); // plain W / S: the medium step, 1 m/s
  const lat: number[] = [];
  const rep: number[] = [];
  for (let k = 0; k < 10; k++) {
    await page.keyboard.press(k % 2 ? 'KeyS' : 'KeyW');
    s = await settled(page);
    await page.waitForTimeout(50);
    lat.push(await page.evaluate(() => (window as any).sendit.metrics.redrawLatencyMs));
    rep.push(s.replayMs);
  }
  console.log(`2-year coast: replay ${median(rep).toFixed(0)} ms median, edit->redraw ${median(lat).toFixed(0)} ms median (max ${Math.max(...lat).toFixed(0)} ms), outcome ${s.outcome}`);
  await page.selectOption('select.frame-kind', 'barycentric');
  await page.evaluate(() => (window as any).sendit.camera.setDistance(8e11, true));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/7-two-year-coast.png` });
});

test('no console errors in the editor flows', () => {
  const real = errors.filter((e) => !/GL Driver Message|GPU stall/.test(e));
  expect(real, real.join('\n')).toEqual([]);
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
