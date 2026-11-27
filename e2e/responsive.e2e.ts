/**
 * The editor at four sizes (Chromium): phone portrait and landscape (touch,
 * mobile UA), tablet portrait, desktop. For each: the map keeps most of the
 * screen, no horizontal scroll, no console errors, every visible control on
 * touch layouts is at least ~44 px, and screenshots of the main states go to
 * test-results/responsive/ for a human to look at. Also: burn ignition /
 * cutoff markers for a long low-thrust burn and a short one, the shortcut
 * reference, render-on-demand, and frame time on a throttled phone profile.
 */
import { devices, expect, test, type Page } from '@playwright/test';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/responsive';

test.skip(({ browserName }) => browserName !== 'chromium', 'layout checks run in Chromium');

const PHONE_UA = devices['iPhone 13'].userAgent;
const SIZES = {
  'phone-portrait': { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, userAgent: PHONE_UA },
  'phone-landscape': { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, userAgent: PHONE_UA },
  tablet: { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: devices['iPad Mini'].userAgent },
  desktop: { viewport: { width: 1280, height: 720 } },
} as const;

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
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}

/** Facts about the page a designer would check. */
async function audit(page: Page) {
  return page.evaluate(() => {
    const W = innerWidth;
    const H = innerHeight;
    const vis = (e: Element) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(e as HTMLElement);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && (e as HTMLElement).offsetParent !== null && r.bottom > 0 && r.top < H && r.right > 0 && r.left < W;
    };
    const touch = document.documentElement.classList.contains('touch');
    const controls = [...document.querySelectorAll('#hud button, #hud select, #hud input, #hud [role="slider"], #hud [role="button"]')].filter(vis);
    const small = touch ? controls.filter((e) => {
      // A checkbox inside its label: the whole label is the tap target.
      const r = (e.matches('label > input[type="checkbox"]') ? e.parentElement! : e).getBoundingClientRect();
      return Math.min(r.height, r.width) < 40 && !(e as HTMLInputElement).type?.match(/range/);
    }).map((e) => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className} "${((e as HTMLElement).textContent || (e as HTMLElement).title || '').slice(0, 30)}" ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`) : [];
    // Map area no panel covers: sample a grid of points and see which hit the canvas.
    let free = 0;
    let total = 0;
    for (let x = 5; x < W; x += 20) for (let y = 5; y < H; y += 20) {
      total++;
      const e = document.elementFromPoint(x, y);
      if (e && (e.id === 'view' || e.closest('#labels'))) free++;
    }
    const fonts = [...document.querySelectorAll('#hud *')].filter((e) => vis(e) && e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())).map((e) => ({ px: parseFloat(getComputedStyle(e).fontSize), what: `${e.tagName.toLowerCase()}.${(e as HTMLElement).className}` }));
    const smallest = fonts.reduce((a, b) => (b.px < a.px ? b : a), { px: 99, what: '' });
    // Overlap check between the status bar, sheet/docks and timeline.
    const boxes = ['.topbar', '.bottom', '.sheet', '.dock.left', '.dock.right'].map((s) => document.querySelector(s) as HTMLElement).filter((e) => e && vis(e)).map((e) => ({ s: e.className, r: e.getBoundingClientRect() }));
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, b = boxes[j].r;
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${boxes[i].s} / ${boxes[j].s}`);
    }
    return {
      mode: document.documentElement.dataset.mode,
      docW: document.documentElement.scrollWidth,
      bodyW: document.body.scrollWidth,
      W,
      freeMap: free / total,
      small,
      minFont: smallest.px,
      minFontAt: smallest.what,
      overlaps,
    };
  });
}

for (const [name, opts] of Object.entries(SIZES)) {
  test.describe(name, () => {
    test.use(opts as any);
    test(`${name}: layout, map dominance, tap targets, no horizontal scroll`, async ({ page }) => {
      const errors = watch(page);
      await page.goto(`${BASE}/`);
      await page.evaluate(() => localStorage.clear());
      await page.goto(`${BASE}/`);
      await settled(page);
      // A mission with a node, so the node editor has something to show.
      await page.evaluate(() => {
        const w = (window as any).sendit;
        w.editor.selectMission('lunar-flyby');
      });
      await settled(page);
      await page.evaluate(() => {
        const w = (window as any).sendit;
        const t = Date.UTC(2027, 0, 10, 20, 23, 4) / 1000 - Date.UTC(2000, 0, 1, 12) / 1000;
        w.editor.setLaunch({ site: 'kourou', time: t, azimuthDeg: 62.7669, altitudeM: 200e3 });
      });
      await settled(page);
      await page.waitForTimeout(500);
      const a0 = await audit(page);
      await page.screenshot({ path: `${SHOTS}/${name}-1-map.png` });
      console.log(`${name}: ${JSON.stringify(a0)}`);
      expect(a0.docW).toBeLessThanOrEqual(a0.W);
      expect(a0.bodyW).toBeLessThanOrEqual(a0.W);
      // Wide: one dock at 1280 x 720 leaves ~59% uncovered (two docks left ~51%); elsewhere the map has the majority.
      expect(a0.freeMap, 'map keeps most of the screen').toBeGreaterThan(a0.mode === 'wide' ? 0.55 : 0.5);
      expect(a0.minFont).toBeGreaterThanOrEqual(10.5);
      expect(a0.overlaps).toEqual([]);
      expect(a0.small).toEqual([]);

      // Node editor open.
      await page.evaluate(() => (window as any).sendit.editor.addNode(3019.5, { kind: 'orbital', body: 'earth' }, [3167.2, 0, 0]));
      await settled(page);
      await page.waitForTimeout(400);
      const a1 = await audit(page);
      await page.screenshot({ path: `${SHOTS}/${name}-2-node.png` });
      console.log(`${name} node: ${JSON.stringify(a1)}`);
      expect(a1.docW).toBeLessThanOrEqual(a1.W);
      expect(a1.small).toEqual([]);
      // With the node editor open: half sheet on portrait, open side column on landscape.
      expect(a1.freeMap).toBeGreaterThan(a1.mode === 'sheet' ? 0.3 : 0.45);

      // Each tab (tabbed modes) or the docks (wide): no overflow, no small targets.
      if (a1.mode !== 'wide') {
        for (const tab of ['Mission', 'Start', 'Events', 'Results', 'View']) {
          await page.getByRole('tab', { name: tab }).click();
          await page.waitForTimeout(150);
          const a = await audit(page);
          expect(a.docW, tab).toBeLessThanOrEqual(a.W);
          expect(a.small, tab).toEqual([]);
          await page.screenshot({ path: `${SHOTS}/${name}-3-${tab.toLowerCase()}.png` });
        }
      }
      // Shortcut / gesture reference.
      await page.getByRole('button', { name: 'Shortcuts and gestures' }).click();
      await expect(page.locator('dialog.keys')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/${name}-4-keys.png` });
      await page.locator('dialog.keys').getByRole('button', { name: 'Close' }).click();
      expect(errors).toEqual([]);
    });
  });
}

test.describe('burn markers', () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  test('long low-thrust burn (Earth escape) and a short one: ignition, cutoff, scrubber span', async ({ page }) => {
    const errors = watch(page);
    await page.goto(`${BASE}/`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/`);
    await settled(page);
    await page.evaluate(() => (window as any).sendit.editor.selectMission('earth-escape'));
    await settled(page);
    // The upper stage reaches orbit with propellant to spare and burns quickly; drop it first, so the
    // 5 kN spacecraft (T/W 0.10) flies 600 m/s itself: a burn of about nine minutes.
    expect(await page.evaluate(() => (window as any).sendit.editor.addSeparation(1000))).toBe(0);
    await page.evaluate(() => (window as any).sendit.editor.addNode(4000, { kind: 'orbital', body: 'earth' }, [600, 0, 0]));
    await settled(page);
    expect(await page.evaluate(() => (window as any).sendit.nodesOf()[0].stage)).toBe(await page.evaluate(() => (window as any).sendit.store.get().plan.lowerStages.length));
    expect(await page.evaluate(() => (window as any).sendit.store.get().replay.result.burns[0].burnTime)).toBeGreaterThan(500);
    // Look from the side the burn is on (markers behind the planet are dimmed and not tappable).
    await page.evaluate(() => (window as any).sendit.camera.setDistance(3.5e7, true));
    for (let k = 0; k < 8; k++) {
      await page.waitForTimeout(800);
      if (await page.locator('.label.marker.burn-end.end:not(.occluded) .text').count()) break;
      await page.evaluate(() => { const c = (window as any).sendit.camera; c.azimuth += Math.PI / 4; c.setDistance(3.5e7 * 1.0001, true); });
    }
    await expect(page.locator('.label.marker.burn-end.end:not(.occluded) .text').first()).toBeVisible();
    await expect(page.locator('.label.marker.burn-end.start .text').first()).toBeVisible();
    await expect(page.locator('.label.marker.burn-end.end .text').first()).toContainText('min');
    await expect(page.locator('.span.burn.selected')).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/burn-1-long.png` });
    // Tapping/clicking a burn end selects its node.
    await page.evaluate(() => (window as any).sendit.store.set({ selectedNode: null }));
    await page.locator('.label.marker.burn-end.end .text').first().click();
    expect(await page.evaluate(() => (window as any).sendit.store.get().selectedNode)).toBe(0);
    // Short burn far away: the two ends collapse into the single marker.
    await page.evaluate(() => (window as any).sendit.editor.addNode(30000, { kind: 'orbital', body: 'earth' }, [5, 0, 0]));
    await settled(page);
    await page.evaluate(() => (window as any).sendit.camera.setDistance(2e8, true));
    await page.waitForTimeout(800);
    const keys = await page.locator('.label.marker.burn-end').evaluateAll((es) => es.filter((e) => (e as HTMLElement).style.display !== 'none').map((e) => (e as HTMLElement).dataset.key));
    expect(keys.filter((k) => k?.startsWith('burn:1'))).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/burn-2-short-collapsed.png` });
    // Run out of propellant: the cutoff marker says so.
    await page.evaluate(() => (window as any).sendit.editor.updateNode(0, { dv: [9000, 0, 0] }));
    await settled(page);
    await page.evaluate(() => (window as any).sendit.camera.setDistance(6e7, true));
    await page.waitForTimeout(800);
    await expect(page.locator('.label.marker.burn-end.short .text').first()).toContainText('out of propellant');
    expect(await page.locator('.span.burn.short').count()).toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: `${SHOTS}/burn-3-cut-short.png` });
    // Lunar orbit injection (17 min) on its own.
    await page.evaluate(() => (window as any).sendit.editor.selectMission('lunar-orbit'));
    await settled(page);
    await page.evaluate(() => (window as any).sendit.editor.addNode(3500, { kind: 'orbital', body: 'earth' }, [3150, 0, 0]));
    await settled(page);
    await page.evaluate(() => (window as any).sendit.camera.setDistance(3e7, true));
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/burn-4-lunar-orbit-injection.png` });
    expect(errors).toEqual([]);
  });
});

test.describe('phone performance', () => {
  test.use(SIZES['phone-portrait'] as any);
  test('frame time at 390 x 844 with 4x CPU throttling; idle when still', async ({ page }) => {
    const errors = watch(page);
    await page.goto(`${BASE}/#paused=0&warp=4`);
    await page.waitForFunction(() => (window as any).sendit?.store.get().loadingTarget === null, null, { timeout: 120_000 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.waitForTimeout(2000);
    const sample = () => page.evaluate(() => new Promise<{ fps: number; p50: number; p95: number; cpu: number }>((res) => {
      const ts: number[] = [];
      const f = (t: number) => {
        ts.push(t);
        if (ts.length < 120) requestAnimationFrame(f);
        else {
          const d = ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b);
          res({ fps: 1000 / (d.reduce((a, b) => a + b, 0) / d.length), p50: d[d.length >> 1], p95: d[Math.floor(d.length * 0.95)], cpu: (window as any).sendit.metrics.frameCpuMs });
        }
      };
      requestAnimationFrame(f);
    }));
    const running = await sample();
    // Paused and still: the loop should skip rendering (cheap frames, low CPU).
    await page.evaluate(() => (window as any).sendit.store.set({ paused: true }));
    await page.waitForTimeout(1500);
    const renders0 = await page.evaluate(() => (window as any).sendit.renders());
    await page.waitForTimeout(2000);
    const renders1 = await page.evaluate(() => (window as any).sendit.renders());
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    console.log(`phone 4x throttled, time running: rAF interval p50 ${running.p50.toFixed(1)} ms, p95 ${running.p95.toFixed(1)} ms (${running.fps.toFixed(0)} fps), frame CPU ${running.cpu.toFixed(2)} ms; paused and still: ${renders1 - renders0} renders in 2 s`);
    expect(renders1 - renders0).toBeLessThanOrEqual(4);
    expect(errors).toEqual([]);
  });
});
