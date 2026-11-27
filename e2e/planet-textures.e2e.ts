/**
 * Planet textures in the built site (Chromium): orientation views for a human
 * to check, download accounting, console errors, and frame time with and
 * without the textured bodies. Screenshots go to test-results/planets/.
 *
 * Views (camera placed from real ephemeris positions in the page):
 *  - Earth at J2000.0 (2000-01-01 11:58:56 UTC) seen from the Sun: day side
 *    centred near 1 deg E, 23 deg S, so Africa and Europe face the camera.
 *  - Earth at 2024-06-20 20:51 UTC (June solstice) from the Sun: Pacific near
 *    132 deg W in daylight, northern hemisphere tilted toward the Sun.
 *  - The Moon seen from Earth: the near side (maria of Imbrium/Serenitatis/
 *    Tranquillitatis, Procellarum to the west).
 *  - Jupiter with the Galilean moons; Saturn with its rings; Uranus on its side.
 *  - A phone-sized viewport of Earth.
 */
import { expect, test, type Page } from '@playwright/test';

const BASE = 'http://localhost:4173';
const SHOTS = process.env.PLANET_SHOTS ?? 'test-results/planets';

test.skip(({ browserName }) => browserName === 'firefox', 'Firefox: these flows run in Chromium and WebKit; Firefox has the smaller smoke.e2e.ts (and CI Linux Firefox has no WebGL)');
test.describe.configure({ mode: 'serial' });

const errors: string[] = [];
function watch(page: Page): void {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
}

/** Open the viewer at a view and wait until it is drawing. */
async function open(page: Page, hash: string): Promise<void> {
  watch(page);
  await page.goto(`${BASE}/#${hash}`);
  await page.waitForFunction(() => {
    const s = (window as any).sendit;
    return s && s.store.get().loadingTarget === null && s.metrics.frameIntervalMs > 0;
  }, null, { timeout: 120_000 });
}

/** Point the orbit camera from body `focus` toward body `toward` (in the current frame's axes). */
async function lookFrom(page: Page, focus: string, toward: string, dist: number): Promise<void> {
  await page.evaluate(([focus, toward, dist]) => {
    const s = (window as any).sendit;
    const ids: string[] = s.bodies;
    const pos = new Float64Array(3 * ids.length);
    s.eph.evaluate(s.store.get().t, pos, null);
    const a = ids.indexOf(focus as string), b = ids.indexOf(toward as string);
    const d = [pos[3 * b] - pos[3 * a], pos[3 * b + 1] - pos[3 * a + 1], pos[3 * b + 2] - pos[3 * a + 2]];
    const m: number[] = s.frameAxes();
    const [x, y, z] = [0, 1, 2].map((r) => m[3 * r] * d[0] + m[3 * r + 1] * d[1] + m[3 * r + 2] * d[2]);
    s.camera.azimuth = Math.atan2(y, x);
    s.camera.elevation = Math.atan2(z, Math.hypot(x, y));
    s.camera.setDistance(dist as number, true);
  }, [focus, toward, dist] as const);
}

/** Wait until a texture of `id` (tier) has been fetched, then a few frames. */
async function textured(page: Page, id: string, tier = 'lo'): Promise<void> {
  await page.waitForFunction(
    ([id, tier]) => performance.getEntriesByType('resource').some((r) => r.name.includes(`/${id}-${tier}`)),
    [id, tier],
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1500);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('Earth at J2000 from the Sun: Africa/Europe in daylight', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 't=0&frame=in:earth&focus=earth&dist=4e7');
  await lookFrom(page, 'earth', 'sun', 4e7);
  await textured(page, 'earth', 'hi');
  await shot(page, 'earth-j2000-from-sun');
  await lookFrom(page, 'earth', 'sun', 4e7);
  await page.evaluate(() => ((window as any).sendit.camera.azimuth += Math.PI * 0.6));
  await page.waitForTimeout(1500);
  await shot(page, 'earth-j2000-terminator');
});

test('Earth at the June 2024 solstice from the Sun', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 't=2024-06-20T20:52:09&frame=in:earth&focus=earth&dist=4e7');
  await lookFrom(page, 'earth', 'sun', 4e7);
  await textured(page, 'earth', 'hi');
  await shot(page, 'earth-2024-solstice-from-sun');
});

test('Moon seen from Earth shows its near side', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 't=2024-06-22T01:08:00&frame=in:moon&focus=moon&dist=1.2e7');
  await lookFrom(page, 'moon', 'earth', 1.2e7);
  await textured(page, 'moon', 'hi');
  await shot(page, 'moon-from-earth-fullmoon');
  // A week later (last quarter): still the near side, half lit.
  await page.evaluate(() => (window as any).sendit.store.set({ t: (window as any).sendit.store.get().t + 6.5 * 86400 }));
  await page.waitForTimeout(3000);
  await lookFrom(page, 'moon', 'earth', 1.2e7);
  await page.waitForTimeout(1500);
  await shot(page, 'moon-from-earth-quarter');
});

test('Jupiter with its moons, Saturn with rings, Uranus on its side', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 't=2024-06-20T12:00:00&frame=in:jupiter&focus=jupiter&dist=3.5e9');
  await lookFrom(page, 'jupiter', 'sun', 3.5e9);
  await page.evaluate(() => ((window as any).sendit.camera.elevation += 0.15));
  await page.waitForTimeout(4000);
  await shot(page, 'jupiter-system');
  await lookFrom(page, 'jupiter', 'sun', 3.2e8);
  await page.evaluate(() => ((window as any).sendit.camera.azimuth += 0.5));
  await textured(page, 'jupiter', 'hi');
  await shot(page, 'jupiter-close');
  await page.evaluate(() => {
    const s = (window as any).sendit;
    s.store.set({ focus: s.bodies.indexOf('saturn'), frame: { kind: 'inertial', center: s.bodies.indexOf('saturn') } });
  });
  await page.waitForTimeout(2000);
  await lookFrom(page, 'saturn', 'sun', 6e8);
  await page.evaluate(() => {
    const c = (window as any).sendit.camera;
    c.azimuth += 0.5;
    c.elevation = 0.6; // above the ring plane: the north face is the sunlit one from 2009 to 2025
  });
  await page.waitForTimeout(3000);
  await shot(page, 'saturn-rings');
  await lookFrom(page, 'saturn', 'earth', 6e8);
  await page.waitForTimeout(2000);
  await shot(page, 'saturn-from-earth');
  await page.evaluate(() => {
    const s = (window as any).sendit;
    s.store.set({ focus: s.bodies.indexOf('uranus'), frame: { kind: 'inertial', center: s.bodies.indexOf('uranus') } });
  });
  await page.waitForTimeout(2000);
  await lookFrom(page, 'uranus', 'sun', 1.5e9);
  await page.evaluate(() => ((window as any).sendit.camera.azimuth += 0.6));
  await page.waitForTimeout(3000);
  await shot(page, 'uranus-system');
});

test('phone viewport, download accounting and frame time', async ({ page, browser }) => {
  // Five page loads and two 10-second frame-time samples: on a 2-core Linux runner with software WebGL this
  // ran past the default 180 s once (it timed out in a screenshot). Nothing here is a timing assertion.
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  // First visit, default view: what is downloaded before any interaction.
  await open(page, '');
  await page.waitForTimeout(5000);
  const first = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((r) => ({ name: r.name.split('/').pop(), bytes: (r as PerformanceResourceTiming).encodedBodySize || (r as PerformanceResourceTiming).transferSize }))
      .filter((r) => /\.webp/.test(r.name ?? '')),
  );
  console.log('first visit texture downloads:', JSON.stringify(first), 'total', first.reduce((a, r) => a + r.bytes, 0));
  await shot(page, 'phone-default-view');
  expect(await page.locator('#image-credits').getAttribute('href')).toBe('credits.html');
  const credits = await page.request.get(`${BASE}/credits.html`);
  expect(credits.ok()).toBe(true);
  expect(await credits.text()).toContain('USGS Astrogeology');
  await page.goto('about:blank'); // a hash-only change would not reload the app
  await page.goto(`${BASE}/#t=0&frame=in:earth&focus=earth&dist=2.5e7`);
  await page.waitForFunction(() => (window as any).sendit?.store.get().loadingTarget === null, null, { timeout: 120_000 });
  await lookFrom(page, 'earth', 'sun', 2.5e7);
  await textured(page, 'earth', 'hi');
  await shot(page, 'phone-earth');

  // Frame time on the heaviest view (Saturn with rings filling the screen, Earth textures resident),
  // with textures and with `#textures=0` (the original flat spheres).
  const measure = async (hash: string): Promise<{ cpu: number; interval: number }> => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    watch(p);
    await p.goto(`${BASE}/#${hash}`);
    await p.waitForFunction(() => (window as any).sendit?.store.get().loadingTarget === null, null, { timeout: 120_000 });
    await lookFrom(p, 'saturn', 'sun', 4e8);
    await p.evaluate(() => {
      const c = (window as any).sendit.camera;
      c.azimuth += 0.5;
      c.elevation = 0.6;
    });
    await p.waitForTimeout(4000);
    const cpu: number[] = [];
    const interval: number[] = [];
    for (let i = 0; i < 12; i++) {
      await p.waitForTimeout(500);
      const m = await p.evaluate(() => (window as any).sendit.metrics);
      cpu.push(m.frameCpuMs);
      interval.push(m.frameIntervalMs);
    }
    const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
    const r = { cpu: med(cpu), interval: med(interval) };
    // Stop time warp first: a screenshot of a page redrawing every frame under software WebGL can take minutes.
    await p.evaluate(() => (window as any).sendit.store.set({ paused: true }));
    await p.screenshot({ path: `${SHOTS}/frametime-${hash.includes('textures=0') ? 'flat' : 'textured'}.png` });
    await p.close();
    return r;
  };
  const view = 't=2024-06-20T12:00:00&frame=in:saturn&focus=saturn&dist=4e8&paused=0&warp=4';
  for (let round = 0; round < 2; round++) {
    const flat = await measure(`${view}&textures=0`);
    const tex = await measure(view);
    console.log(`frame time, Saturn close-up (median): flat cpu ${flat.cpu.toFixed(2)} ms interval ${flat.interval.toFixed(1)} ms; textured cpu ${tex.cpu.toFixed(2)} ms interval ${tex.interval.toFixed(1)} ms`);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
