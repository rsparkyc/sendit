/**
 * Plan editing and map interaction in the built site (Chromium): the rearranged
 * node value controls (desktop and phone), delete / disable / enable from the
 * node list and the editor, undo and redo (buttons and keys, with coalescing),
 * the select-then-confirm add-node model (a click never adds, a double click
 * never adds), double-click focus with its precedence (a body, a node marker,
 * an ambiguous spot, a trajectory point), and the far-side hit test.
 * Screenshots go to test-results/interaction/ for a human to look at.
 */
import { expect, test, type Page } from '@playwright/test';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/interaction';

test.skip(({ browserName }) => browserName === 'firefox', 'Firefox: these flows run in Chromium and WebKit; Firefox has the smaller smoke.e2e.ts (and CI Linux Firefox has no WebGL)');

const errors: string[] = [];
function watch(page: Page): void {
  page.on('console', (m) => {
    if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
}

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).sendit?.store.get();
    return s && s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle' && s.replay.preview === null && s.loadingTarget === null;
  }, null, { timeout: 120_000 });
}

/** Wait until the app has drawn `k` more frames, so screen positions read next match the camera. */
async function frames(page: Page, k = 2): Promise<void> {
  const n0 = await page.evaluate(() => (window as any).sendit.renders());
  await page.waitForFunction(([n, kk]) => (window as any).sendit.renders() >= n + kk, [n0, k] as const, { timeout: 10_000 });
}

/** Wait until the camera has stopped moving (focus glides and zoom smoothing are time-based, seconds long) and that view
 * is on screen. A spot found on screen while the view still drifts is stale by the time of the click. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).sendit.camera.settled(), undefined, { timeout: 30_000 });
  await frames(page);
}

async function fresh(page: Page, mission = 'geo-from-leo'): Promise<void> {
  errors.length = 0;
  watch(page);
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await settled(page); // WebKit reports the outgoing page's in-flight worker fetches as errors if it is reloaded mid-load
  await page.goto(`${BASE}/`);
  await settled(page);
  await page.locator('select.mission-select').selectOption(mission, { force: true });
  await settled(page);
}

const nodeCount = (page: Page) => page.evaluate(() => (window as any).sendit.nodesOf().length as number);
const state = (page: Page) => page.evaluate(() => {
  const s = (window as any).sendit.store.get();
  return { t: s.t as number, epoch: s.plan.epoch as number, focus: s.focus as number, selectedNode: s.selectedNode as number | null };
});

/** One node in a low orbit, selected, its editor on screen. */
async function oneNode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = (window as any).sendit;
    w.editor.addNode(4000, { kind: 'orbital', body: 'earth' }, [600, 0, 0]);
    w.store.set({ paused: true });
  });
  await settled(page);
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('node controls: ‹‹‹ ‹‹ ‹ [drag] › ›› ››› with 0 and ± by the value; delete, disable, enable, undo, redo', async ({ page }) => {
    await fresh(page);
    await oneNode(page);
    const pro = page.locator('.tuner', { has: page.locator('input[title="Prograde delta-v, m/s"]') });
    // Order of the step row: three decrease buttons, the drag strip, three increase buttons.
    const order = await pro.locator('.tn-steps > *').evaluateAll((es) => es.map((e) => (e.classList.contains('tn-pad') ? 'drag' : (e.querySelector('.tn-arrows')?.textContent ?? '?'))));
    expect(order).toEqual(['‹‹‹', '‹‹', '‹', 'drag', '›', '››', '›››']);
    const ctl = await pro.locator('.tn-ctl > *').evaluateAll((es) => es.map((e) => e.tagName === 'INPUT' ? 'input' : e.textContent));
    expect(ctl).toEqual(['input', '0', '±']);
    const time = page.locator('.tuner', { has: page.locator('input.met-input') });
    expect(await time.locator('.tn-ctl > *').count()).toBe(1);
    expect(await time.locator('.tn-steps > .tn-pad').count()).toBe(1);
    await expect(pro.locator('.tn-pad')).toContainText('drag');
    // No native tooltips on the step buttons and strip (they covered the neighbours).
    expect(await pro.locator('.tn-steps [title]').count()).toBe(0);
    await page.locator('.panel.nodes').screenshot({ path: `${SHOTS}/1-node-controls-1280.png` });

    // ± flips the sign; a burst of step clicks is one undo step.
    const dv = () => page.evaluate(() => (window as any).sendit.nodesOf()[0].node.dv[0] as number);
    await pro.getByRole('button', { name: 'Prograde: flip sign' }).click();
    expect(await dv()).toBeCloseTo(-600, 6);
    // The burst is grouped by interaction (the pointer stays on the button), not by wall-clock time: a pause
    // longer than the 1.5 s idle window in the middle (what a loaded machine produces) still gives one step.
    for (let k = 0; k < 5; k++) {
      if (k === 2) await page.waitForTimeout(2000);
      await pro.getByRole('button', { name: 'Prograde: +10 m/s', exact: true }).click();
    }
    expect(await dv()).toBeCloseTo(-550, 9);
    await page.getByRole('button', { name: /^Undo/ }).click();
    expect(await dv()).toBeCloseTo(-600, 6);
    await page.getByRole('button', { name: /^Undo/ }).click();
    expect(await dv()).toBeCloseTo(600, 6);
    await page.getByRole('button', { name: /^Redo/ }).click();
    expect(await dv()).toBeCloseTo(-600, 6);

    // Delete from the list row, then undo with Ctrl+Z (the canvas has focus, not a text field).
    const plan0 = await page.evaluate(() => JSON.stringify((window as any).sendit.store.get().plan));
    await expect(page.getByRole('button', { name: 'Delete burn 1' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete burn 1' }).click();
    expect(await nodeCount(page)).toBe(0);
    await page.screenshot({ path: `${SHOTS}/2-deleted-1280.png` });
    await page.locator('#view').focus().catch(() => undefined);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('ControlOrMeta+z');
    expect(await nodeCount(page)).toBe(1);
    expect(await page.evaluate(() => JSON.stringify((window as any).sendit.store.get().plan))).toBe(plan0);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect(await nodeCount(page)).toBe(0);
    await page.keyboard.press('ControlOrMeta+z');
    await settled(page);
    await page.screenshot({ path: `${SHOTS}/3-undo-delete-1280.png` });

    // Delete from the selected node's editor; Delete key; both undoable.
    await page.evaluate(() => (window as any).sendit.store.set({ selectedNode: 0 }));
    await page.getByRole('button', { name: /^Delete this node/ }).click();
    expect(await nodeCount(page)).toBe(0);
    await page.getByRole('button', { name: /^Undo/ }).click();
    await page.evaluate(() => (window as any).sendit.store.set({ selectedNode: 0 }));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Delete');
    expect(await nodeCount(page)).toBe(0);
    await page.getByRole('button', { name: /^Undo/ }).click();
    expect(await nodeCount(page)).toBe(1);

    // Disable and Enable look alike and sit in the same place on the row.
    await page.getByRole('button', { name: 'Disable burn 1' }).click();
    expect(await nodeCount(page)).toBe(0);
    const en = page.getByRole('button', { name: /^Enable the disabled node/ });
    await expect(en).toBeVisible();
    const [cDis, cEn] = [await page.evaluate(() => 'nact-btn toggle'), await en.getAttribute('class')];
    expect(cEn).toContain(cDis);
    await page.locator('.panel.nodes').screenshot({ path: `${SHOTS}/4-disabled-1280.png` });
    await en.click();
    expect(await nodeCount(page)).toBe(1);
    await page.getByRole('button', { name: /^Undo/ }).click(); // undo enable
    expect(await nodeCount(page)).toBe(0);
    await page.getByRole('button', { name: /^Undo/ }).click(); // undo disable
    expect(await nodeCount(page)).toBe(1);
    expect(await page.evaluate(() => (window as any).sendit.store.get().parked.length)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a click picks a trajectory point and never adds a node; a double click focuses and never adds', async ({ page }) => {
    await fresh(page);
    await oneNode(page);
    await page.evaluate(() => { const w = (window as any).sendit; w.camera.elevation = 1.2; w.camera.setDistance(4e7, true); w.store.set({ focus: w.bodies.indexOf('earth') }); });
    await settle(page);
    // Single click on the trajectory, away from the node: point picked, time cursor there, no node.
    const p = await page.evaluate(() => {
      const w = (window as any).sendit;
      for (let t = 6000; t < 9000; t += 60) {
        const q = w.screenAt(t, true);
        if (!q) continue;
        const pick = w.pickAt(q.x, q.y, false, false);
        // The map itself must take the click: a label's text over the point would take it instead (labels are clickable).
        if (pick.winner?.kind === 'trajectory' && document.elementFromPoint(q.x, q.y)?.id === 'view') return { ...q, t };
      }
      return null;
    });
    expect(p, 'a clear trajectory point').not.toBeNull();
    await page.mouse.click(p!.x, p!.y);
    await expect(page.locator('.tap-pop')).toBeVisible();
    expect(await nodeCount(page)).toBe(1);
    const s1 = await state(page);
    expect(Math.abs(s1.t - s1.epoch - p!.t)).toBeLessThan(120);
    await page.screenshot({ path: `${SHOTS}/5-point-picked-1280.png` });
    // N adds there.
    await page.keyboard.press('n');
    expect(await nodeCount(page)).toBe(2);
    await page.getByRole('button', { name: /^Undo/ }).click();
    expect(await nodeCount(page)).toBe(1);

    // Double click on another trajectory point: the spacecraft is focused at that time, still no new node.
    // (The first click of the pair already moves the time cursor there, so the spacecraft itself is under the
    // pointer for the second: by the precedence that is a spacecraft pick; either way the same point.)
    await expect(page.locator('.tap-pop')).toBeHidden(); // N added the node and closed it
    await settle(page);
    const q = await page.evaluate((t0) => {
      const w = (window as any).sendit;
      for (let t = t0 + 900; t < t0 + 3000; t += 60) {
        const r = w.screenAt(t, true);
        // A spot where only the trajectory is under the pointer (on the planet's disc the planet would win).
        if (r && w.pickAt(r.x, r.y, false, true).winner?.kind === 'trajectory' && document.elementFromPoint(r.x, r.y)?.id === 'view') return { ...r, t };
      }
      return null;
    }, p!.t);
    expect(q).not.toBeNull();
    await page.mouse.dblclick(q!.x, q!.y);
    await frames(page);
    expect(await nodeCount(page)).toBe(1);
    const s2 = await state(page);
    expect(s2.focus).toBe(-1);
    expect(Math.abs(s2.t - s2.epoch - q!.t)).toBeLessThan(120);
    expect(['spacecraft', 'trajectory']).toContain(await page.evaluate(() => (window as any).sendit.lastFocusPick()?.kind));

    // A click that ends a camera drag selects nothing.
    if (await page.locator('.tap-pop').isVisible()) await page.locator('.tap-pop button[aria-label="Dismiss"]').click();
    const t0 = (await state(page)).t;
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(700, 430, { steps: 5 });
    await page.mouse.up();
    expect(await nodeCount(page)).toBe(1);
    expect((await state(page)).t).toBe(t0);
    await expect(page.locator('.tap-pop')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('double click: a body, a node marker, an ambiguous spot (node over the planet) focus the right thing', async ({ page }) => {
    await fresh(page);
    await oneNode(page);
    const moon = await page.evaluate(() => (window as any).sendit.bodies.indexOf('moon'));
    const earth = await page.evaluate(() => (window as any).sendit.bodies.indexOf('earth'));
    // The Moon, seen from a distance where it is a small disc.
    await page.evaluate((m) => { const w = (window as any).sendit; w.store.set({ focus: m }); w.camera.setDistance(3e7, true); }, moon);
    await settle(page);
    await page.evaluate((e) => (window as any).sendit.store.set({ focus: e }), earth);
    await page.evaluate(() => { const w = (window as any).sendit; w.camera.setDistance(1.2e9, true); });
    await settle(page);
    const mp = await page.evaluate((m) => (window as any).sendit.labelAt(String(m)), moon);
    expect(mp, 'the Moon on screen').not.toBeNull();
    await page.mouse.dblclick(mp.x, mp.y);
    await frames(page);
    expect((await state(page)).focus).toBe(moon);
    expect(await nodeCount(page)).toBe(1);
    await page.waitForTimeout(400); // camera glide (screenshot only)
    await page.screenshot({ path: `${SHOTS}/6-dblclick-moon-1280.png` });

    // Back to Earth, looking down so the node marker sits over the planet's disc: ambiguous spot.
    await page.evaluate((e) => { const w = (window as any).sendit; w.store.set({ focus: e, selectedNode: null }); w.camera.elevation = 0.25; w.camera.setDistance(2.4e7, true); }, earth);
    await settle(page); // the double click on the Moon started a glide; the spot must be found in the final view
    let amb: { x: number; y: number; kinds: string[] } | null = null;
    for (let k = 0; k < 24 && !amb; k++) {
      await page.evaluate((a) => { (window as any).sendit.camera.azimuth = a; }, (k * Math.PI) / 12);
      await settle(page);
      amb = await page.evaluate(() => {
        const w = (window as any).sendit;
        const n = w.labelAt('node:0');
        if (!n || n.occluded) return null;
        const kinds = w.pickAt(n.x, n.y, false, true).candidates.map((c: any) => c.kind);
        return kinds.includes('body') && kinds.includes('trajectory') ? { x: n.x, y: n.y, kinds } : null;
      });
    }
    expect(amb, 'node marker over the Earth disc').not.toBeNull();
    console.log(`ambiguous spot candidates: ${amb!.kinds.join(', ')}`);
    await page.screenshot({ path: `${SHOTS}/7-ambiguous-before-1280.png` });
    await page.mouse.dblclick(amb!.x, amb!.y);
    await frames(page);
    expect(await page.evaluate(() => (window as any).sendit.lastFocusPick()?.kind)).toBe('node');
    const s = await state(page);
    expect(s.focus).toBe(-1);
    expect(s.selectedNode).toBe(0);
    const nodeT = await page.evaluate(() => (window as any).sendit.nodesOf()[0].node.t);
    expect(Math.abs(s.t - s.epoch - nodeT)).toBeLessThan(1);
    expect(await nodeCount(page)).toBe(1);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/8-dblclick-node-1280.png` });
    expect(errors).toEqual([]);
  });

  test('far side: trajectory points behind the planet are not hit-testable', async ({ page }) => {
    await fresh(page);
    await oneNode(page);
    const earth = await page.evaluate(() => (window as any).sendit.bodies.indexOf('earth'));
    await page.evaluate((e) => { const w = (window as any).sendit; w.store.set({ focus: e }); w.camera.elevation = 0.02; w.camera.setDistance(2.2e7, true); }, earth);
    let hidden: { x: number; y: number; t: number } | null = null;
    for (let k = 0; k < 12 && !hidden; k++) {
      await page.evaluate((a) => { (window as any).sendit.camera.azimuth = a; }, (k * Math.PI) / 6);
      await frames(page);
      hidden = await page.evaluate(() => {
        const w = (window as any).sendit;
        for (let t = 100; t < 3900; t += 20) {
          if (!w.occludedAt(t)) continue;
          const q = w.screenAt(t);
          if (q && !w.screenAt(t, true)) return { ...q, t };
        }
        return null;
      });
    }
    expect(hidden, 'a far-side point behind the Earth').not.toBeNull();
    // Whatever the click picks there, it is never a hidden point.
    const pick = await page.evaluate(([x, y]) => (window as any).sendit.pickAt(x, y, false, false), [hidden!.x, hidden!.y]);
    for (const c of pick.candidates.filter((c: any) => c.kind === 'trajectory')) expect(await page.evaluate((t) => (window as any).sendit.occludedAt(t), Number(c.key))).toBe(false);
    const t0 = (await state(page)).t;
    await page.mouse.click(hidden!.x, hidden!.y);
    if (await page.locator('.tap-pop').isVisible()) {
      const s = await state(page);
      expect(await page.evaluate((t) => (window as any).sendit.occludedAt(t), s.t - s.epoch)).toBe(false);
    } else expect((await state(page)).t).toBe(t0);
    await page.mouse.move(hidden!.x, hidden!.y);
    await page.screenshot({ path: `${SHOTS}/9-far-side-1280.png` });
    console.log(`far-side point T+${hidden!.t} s at ${hidden!.x.toFixed(0)}, ${hidden!.y.toFixed(0)}: candidates ${pick.candidates.map((c: any) => c.kind).join(', ') || 'none'}`);
    expect(errors).toEqual([]);
  });

  test('plane discs: procedural, smooth up close and far', async ({ page }) => {
    await fresh(page);
    await page.evaluate(() => {
      const w = (window as any).sendit;
      w.viewSettings.showEquator = true;
      w.store.set({ focus: w.bodies.indexOf('earth') });
      w.camera.elevation = 0.35;
      w.camera.setDistance(6e7, true);
    });
    await page.locator('#show-equator').check({ force: true }).catch(() => undefined);
    await frames(page, 3);
    await page.screenshot({ path: `${SHOTS}/10-disc-far-1280.png` });
    // Close to the limb, grazing the plane.
    await page.evaluate(() => { const w = (window as any).sendit; w.camera.elevation = 0.12; w.camera.setDistance(9e6, true); });
    await frames(page, 3);
    await page.screenshot({ path: `${SHOTS}/11-disc-limb-1280.png` });
    // Large disc radius.
    await page.evaluate(() => { const w = (window as any).sendit; w.viewSettings.discRadius = 40; w.camera.elevation = 0.5; w.camera.setDistance(4e8, true); });
    await frames(page, 3);
    await page.screenshot({ path: `${SHOTS}/12-disc-large-1280.png` });
    expect(errors).toEqual([]);
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test('node controls fit at 390 px; delete by tap and undo; double tap focuses without adding', async ({ page }) => {
    await fresh(page);
    await oneNode(page);
    await page.evaluate(() => (window as any).sendit.store.set({ selectedNode: 0 }));
    await page.getByRole('tab', { name: 'Nodes' }).tap();
    await page.locator('.sheet-grip').tap();
    const pro = page.locator('.tuner', { has: page.locator('input[title="Prograde delta-v, m/s"]') });
    await pro.scrollIntoViewIfNeeded();
    for (const b of await pro.locator('.tn-steps > *, .tn-ctl button').all()) {
      const r = (await b.boundingBox())!;
      expect(r.height).toBeGreaterThanOrEqual(43);
      expect(r.width).toBeGreaterThanOrEqual(40);
    }
    await expect(pro.locator('.tn-pad')).toContainText('drag');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/p1-node-controls-390.png` });
    // Delete from the row, Undo by tap.
    const del = page.getByRole('button', { name: 'Delete burn 1' });
    await del.scrollIntoViewIfNeeded();
    const db = (await del.boundingBox())!;
    expect(db.height).toBeGreaterThanOrEqual(43);
    await del.tap();
    expect(await nodeCount(page)).toBe(0);
    await page.screenshot({ path: `${SHOTS}/p2-deleted-390.png` });
    const undo = page.getByRole('button', { name: /^Undo/ });
    await undo.scrollIntoViewIfNeeded();
    await undo.tap();
    expect(await nodeCount(page)).toBe(1);
    await page.screenshot({ path: `${SHOTS}/p3-undone-390.png` });
    expect(errors).toEqual([]);
  });

  test('double tap on the Moon focuses it, adds nothing', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'drives touch through CDP Input.dispatchTouchEvent (Chromium only); the WebKit touch flow is mobile.e2e.ts');

    await fresh(page);
    await oneNode(page);
    const [moon, earth] = await page.evaluate(() => ['moon', 'earth'].map((b) => (window as any).sendit.bodies.indexOf(b)));
    await page.evaluate((e) => { const w = (window as any).sendit; w.store.set({ focus: e }); w.camera.setDistance(1.2e9, true); }, earth);
    // Turn until the Moon is on the open map (not under the sheet or the top bar).
    let mp: { x: number; y: number } | null = null;
    for (let k = 0; k < 24 && !mp; k++) {
      await page.evaluate((a) => { (window as any).sendit.camera.azimuth = a; }, (k * Math.PI) / 12);
      await frames(page);
      mp = await page.evaluate((m) => {
        const p = (window as any).sendit.labelAt(String(m));
        if (!p || p.occluded) return null;
        const hit = document.elementFromPoint(p.x, p.y);
        return hit && (hit.id === 'view' || hit.closest('.label')) ? p : null;
      }, moon);
    }
    expect(mp, 'the Moon on the open map').not.toBeNull();
    const cdp = await page.context().newCDPSession(page);
    for (let k = 0; k < 2; k++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mp!.x, y: mp!.y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await frames(page);
    expect((await state(page)).focus).toBe(moon);
    expect(await nodeCount(page)).toBe(1);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/p4-doubletap-moon-390.png` });
    expect(errors).toEqual([]);
  });
});
