/**
 * Marker clusters with real input: a mouse click at desktop size and a touch
 * tap at phone size (hasTouch, mobile) on a cluster's dot on the map expands
 * it (the pointer goes through the map's own picking, not a test hook); a
 * second tap on one of the fanned-out members picks that member. The phone
 * run also checks that the label layout is in touch mode (the larger cluster
 * radius, 22 px against 7 px with a mouse) and screenshots it with clusters
 * on screen. Screenshots go to test-results/label-tap/.
 */
import { devices, expect, test, type Page } from '@playwright/test';
import { frames, settleCamera } from './view';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/label-tap';

test.skip(({ browserName }) => browserName !== 'chromium', 'touch emulation runs in Chromium');

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}


type Cluster = { key: string; x: number; y: number; size: number };

/** Lunar flyby with its departure burn; zoom out from Earth until co-located markers cluster on open map. */
async function setUp(page: Page): Promise<Cluster> {
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/`);
  await settled(page);
  await page.evaluate(() => (window as any).sendit.editor.selectMission('lunar-flyby'));
  await settled(page);
  await page.evaluate(() => {
    const w = (window as any).sendit;
    const t = Date.UTC(2027, 0, 10, 20, 23, 4) / 1000 - Date.UTC(2000, 0, 1, 12) / 1000;
    w.editor.setLaunch({ site: 'kourou', time: t, azimuthDeg: 62.7669, altitudeM: 200e3 });
  });
  await settled(page);
  await page.evaluate(() => (window as any).sendit.editor.addNode(3019.5, { kind: 'orbital', body: 'earth' }, [3155.2, 0, 0]));
  await settled(page);
  // Close the phone's sheet so the map is open; then look from above the orbit plane.
  await page.evaluate(() => {
    const w = (window as any).sendit;
    w.store.set({ selectedNode: null, focus: w.bodies.indexOf('earth') });
    if (w.layout.mode === 'sheet') w.layout.setSheet('peek');
    w.camera.elevation = 1.2;
  });
  // Search camera directions and distances (body frames are pole-up, so no one fixed direction suits every
  // launch) for a cluster on open map whose dot really takes a tap: the map or the cluster's own label is the top
  // element there (another label's text over the dot would take the tap instead), and the map's picking at the dot
  // chooses the cluster itself.
  const free = await page.evaluate(() => (window as any).sendit.layout.freeRect());
  const vp = page.viewportSize()!;
  const seen: string[] = [];
  for (const [az, el] of [[null, 1.2], [0, 1.2], [Math.PI / 2, 1.2], [Math.PI, 1.2], [(3 * Math.PI) / 2, 1.2], [0, -1.2], [Math.PI, -1.2], [0, 0.7], [Math.PI, 0.7]] as const) {
    await page.evaluate(([a, e]) => { const c = (window as any).sendit.camera; if (a !== null) c.azimuth = a; c.elevation = e; }, [az, el] as const);
    for (const d of [3e7, 5e7, 8e7, 1.2e8, 2e8, 3e8, 5e8]) {
      await page.evaluate((dd) => (window as any).sendit.camera.setDistance(dd, true), d);
      await settleCamera(page);
      await frames(page, 6);
      const st = await page.evaluate(() => (window as any).sendit.labelState());
      const open = (st.clusters as Cluster[]).filter((c) => c.x > free.left + 30 && c.x < vp.width - free.right - 30 && c.y > free.top + 30 && c.y < vp.height - free.bottom - 30);
      for (const c of open) {
        const r = await page.evaluate(([x, y, key, touch]) => {
          const e = document.elementFromPoint(x, y);
          const own = !!e && (e.id === 'view' || e.closest('.label')?.getAttribute('data-key') === key);
          const win = (window as any).sendit.pickAt(x, y, touch, false).winner;
          return { own, top: e ? `${(e.closest('.label') as HTMLElement | null)?.dataset.key ?? e.id ?? e.tagName}` : 'null', win: win?.key ?? null };
        }, [c.x, c.y, c.key, vp.width < 600] as const);
        if (r.own && r.win === c.key) return c;
        seen.push(`az ${az ?? 'current'} el ${el} d ${d}: ${c.key} under ${r.top}, pick ${r.win}`);
      }
    }
  }
  throw new Error(`no tappable cluster on the open map; seen:\n  ${seen.join('\n  ')}`);
}

/** The element under a client point is the map or a map label (nothing of the HUD covers it). */
async function onMap(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(([px, py]) => { const e = document.elementFromPoint(px, py); return !!e && (e.id === 'view' || !!e.closest('#labels')); }, [x, y] as const);
}

for (const [size, use] of [
  ['desktop', { viewport: { width: 1280, height: 720 } }],
  ['phone', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, userAgent: devices['iPhone 13'].userAgent }],
] as const) {
  test.describe(size, () => {
    test.use(use as any);
    test(`${size}: ${size === 'phone' ? 'a touch tap' : 'a mouse click'} on a marker cluster expands it; a second one picks a member`, async ({ page }) => {
      const touch = size === 'phone';
      const c = await setUp(page);
      const st0 = await page.evaluate(() => (window as any).sendit.labelState());
      // The layout is in the input's mode: the larger cluster radius on touch.
      expect(await page.evaluate(() => document.documentElement.classList.contains('touch'))).toBe(touch);
      expect(st0.clusterRadius).toBe(touch ? 22 : 7);
      await page.screenshot({ path: `${SHOTS}/${size}-1-clusters${touch ? '-touch-mode' : ''}.png` });
      expect(await onMap(page, c.x, c.y), 'the cluster is on open map').toBe(true);
      // Real input at the cluster's dot.
      if (touch) await page.touchscreen.tap(c.x, c.y);
      else await page.mouse.click(c.x, c.y);
      await frames(page, 4);
      const st1 = await page.evaluate(() => (window as any).sendit.labelState());
      expect(st1.expanded, 'the tap expanded the cluster').toBe(c.key);
      await expect(page.locator(`.label[data-key="${c.key}"]`)).not.toHaveClass(/\bcluster\b/);
      await page.screenshot({ path: `${SHOTS}/${size}-2-expanded.png` });
      // A fanned-out member: tap its text (wait out the double-tap window first).
      const member = page.locator('#labels .label.marker:not(.occluded) .text').filter({ hasText: /\S/ });
      const boxes = await member.evaluateAll((es) => es.map((e) => { const r = e.getBoundingClientRect(); return { key: e.closest<HTMLElement>('.label')!.dataset.key!, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; }).filter((b) => b.w > 0));
      const pick = boxes.find((b) => b.key.startsWith('node:') || b.key.startsWith('ev:') || b.key.startsWith('burn:'));
      expect(pick, 'a member is shown after expanding').toBeTruthy();
      await page.waitForTimeout(450);
      if (touch) await page.touchscreen.tap(pick!.x, pick!.y);
      else await page.mouse.click(pick!.x, pick!.y);
      await frames(page, 4);
      const s = await page.evaluate(() => { const st = (window as any).sendit.store.get(); return { node: st.selectedNode, ev: st.selectedEvent }; });
      if (pick!.key.startsWith('ev:')) expect(s.ev).toBe(Number(pick!.key.slice(3)));
      else expect(s.node).toBe(Number(pick!.key.split(':')[1]));
      await page.screenshot({ path: `${SHOTS}/${size}-3-member-picked.png` });
    });
  });
}
