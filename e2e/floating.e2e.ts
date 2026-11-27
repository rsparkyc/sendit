/**
 * Panel order and floating windows (Chromium): the tab strip and the scrolling
 * column follow one order; a tab undocks into a floating window (the same
 * panel nodes) that drags, resizes, changes opacity, collapses, survives a
 * reload and docks back; pointer and wheel input over a window never reaches
 * the map; windows stay in the viewport when the browser window shrinks;
 * phones offer no undock; selecting a node brings a floating Nodes window to
 * front. Screenshots go to test-results/floating/.
 */
import { devices, expect, test, type Page } from '@playwright/test';
import { clickableTrajectoryPoint } from './view';

const BASE = 'http://localhost:4173';
const SHOTS = 'test-results/floating';

test.skip(({ browserName }) => browserName !== 'chromium', 'layout checks run in Chromium');

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

async function fresh(page: Page): Promise<void> {
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/`);
  await settled(page);
}

const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;
const win = (page: Page, tab: string) => page.locator(`.float-win[data-tab="${tab}"]`);

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('tab order equals the order of the panels in the scrolling column', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    const tabs = await page.locator('.dock.right [role="tab"] .tab-label').allTextContents();
    expect(tabs).toEqual(['Nodes', 'Mission', 'Start', 'Vehicle', 'Events', 'Results', 'Orbit', 'View']);
    // Every panel in the column, top to bottom, mapped to its tab: each tab's panels are contiguous, in tab order.
    const column = await page.evaluate(() => {
      const L = (window as any).sendit.layout;
      const byEl = new Map<Element, string>(L.entries.map((e: any) => [e.el, e.tab]));
      const body = document.querySelector('.dock.right .dock-body')!;
      return [...body.children].map((c) => byEl.get(c) ?? '?');
    });
    expect(column).not.toContain('?');
    const runs = column.filter((t, i) => t !== column[i - 1]);
    const ids = await page.evaluate(() => [...document.querySelectorAll('.dock.right [role="tab"]')].map((b) => b.id.replace('tab-', '')));
    expect(runs).toEqual(ids);
    // Each tab scrolls its first panel to the top of the column, in turn.
    for (const id of ids) {
      await page.locator(`#tab-${id}`).click();
      await page.waitForTimeout(250);
      const top = await page.evaluate((t) => {
        const L = (window as any).sendit.layout;
        const first = L.entries.filter((e: any) => e.tab === t).sort((a: any, b: any) => a.order - b.order)[0].el as HTMLElement;
        return first.getBoundingClientRect().top - document.querySelector('.dock.right .dock-body')!.getBoundingClientRect().top;
      }, id);
      // The last tabs cannot scroll fully to the top: at least, they are not above it.
      expect(top, id).toBeGreaterThanOrEqual(-2);
    }
    expect(errors).toEqual([]);
  });

  test('undock, drag, resize, opacity, collapse, reload, dock back', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    // Type into an Orbit-tab-independent input first: undocking keeps the panel's state (same nodes).
    const orbitPanel = page.locator('.panel.orbit');
    const orbitEl = await orbitPanel.elementHandle();
    await page.getByRole('button', { name: 'Pop out Orbit into a floating window' }).click();
    const w = win(page, 'orbit');
    await expect(w).toBeVisible();
    await expect(w).toHaveAttribute('role', 'region');
    await expect(w).toHaveAccessibleName('Orbit');
    expect(await w.locator('.panel.orbit').evaluate((e, h) => e === h, orbitEl)).toBe(true);
    await expect(page.locator('#tab-orbit')).toHaveClass(/floating/);
    expect(await page.locator('.dock.right .dock-body .panel.orbit').count()).toBe(0);
    // Opens over the map, clear of the dock and the timeline.
    const b0 = await box(page, '.float-win[data-tab="orbit"]');
    const dock = await box(page, '.dock.right');
    const tl = await box(page, '.panel.scrubber');
    expect(b0.x + b0.width).toBeLessThanOrEqual(dock.x);
    expect(b0.y + b0.height).toBeLessThanOrEqual(tl.y);

    // Drag by the title bar.
    const title = w.locator('.fw-title');
    const tb = (await title.boundingBox())!;
    await page.mouse.move(tb.x + 20, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + 140, tb.y + 90, { steps: 6 });
    await page.mouse.up();
    const b1 = await box(page, '.float-win[data-tab="orbit"]');
    expect(b1.x - b0.x).toBeCloseTo(120, -1);
    expect(b1.y - b0.y).toBeCloseTo(90 - tb.height / 2, -1);
    // Resize by the corner.
    const se = (await w.locator('.fw-rz.se').boundingBox())!;
    await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
    await page.mouse.down();
    await page.mouse.move(se.x + 60, se.y - 40, { steps: 5 });
    await page.mouse.up();
    const b2 = await box(page, '.float-win[data-tab="orbit"]');
    expect(b2.width - b1.width).toBeCloseTo(52, -1);
    expect(b1.height - b2.height).toBeCloseTo(48, -1);
    // Keyboard: the move grip and the resize corner take arrow keys.
    await w.getByRole('button', { name: 'Move the Orbit window (arrow keys)' }).press('ArrowLeft');
    expect((await box(page, '.float-win[data-tab="orbit"]')).x).toBeCloseTo(b2.x - 10, 0);
    await w.getByRole('button', { name: 'Resize the Orbit window (arrow keys)' }).press('ArrowDown');
    expect((await box(page, '.float-win[data-tab="orbit"]')).height).toBeCloseTo(b2.height + 10, 0);
    // Opacity: the background, not the text.
    await w.getByRole('slider', { name: 'Orbit window background opacity' }).fill('40');
    expect(await w.evaluate((e) => getComputedStyle(e).backgroundColor)).toMatch(/0\.4\)$/);
    expect(await w.locator('.fw-body').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    // A second window, opaque, to look at.
    await page.getByRole('button', { name: 'Pop out Nodes into a floating window' }).click();
    await win(page, 'nodes').getByRole('slider').fill('100');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/desktop-two-windows.png` });
    // Collapse Nodes to its title bar.
    await win(page, 'nodes').getByRole('button', { name: 'Collapse the Nodes window' }).click();
    await expect(win(page, 'nodes').locator('.fw-body')).toBeHidden();
    const before = await box(page, '.float-win[data-tab="orbit"]');

    // Reload: both windows back, same place, size, opacity, collapse.
    await page.reload();
    await settled(page);
    await expect(win(page, 'orbit')).toBeVisible();
    const after = await box(page, '.float-win[data-tab="orbit"]');
    expect(after).toEqual(before);
    expect(await win(page, 'orbit').evaluate((e) => getComputedStyle(e).backgroundColor)).toMatch(/0\.4\)$/);
    await expect(win(page, 'nodes').locator('.fw-body')).toBeHidden();
    await expect(page.locator('#tab-nodes')).toHaveClass(/floating/);

    // Clicking a floating tab brings it to front and expands it.
    await page.locator('#tab-nodes').click();
    await expect(win(page, 'nodes').locator('.fw-body')).toBeVisible();
    const z = async (t: string) => Number(await win(page, t).evaluate((e) => (e as HTMLElement).style.zIndex));
    expect(await z('nodes')).toBeGreaterThan(await z('orbit'));
    await win(page, 'orbit').locator('.fw-move').focus(); // (its title bar may lie under the Nodes window)
    expect(await z('orbit')).toBeGreaterThan(await z('nodes'));

    // Dock back: the panel returns to its place in the column.
    await win(page, 'orbit').getByRole('button', { name: 'Dock the Orbit window back' }).click();
    await expect(win(page, 'orbit')).toHaveCount(0);
    await expect(page.locator('#tab-orbit')).not.toHaveClass(/floating/);
    await expect(page.locator('.dock.right .dock-body .panel.orbit')).toHaveCount(1);
    await page.locator('#tab-nodes').dblclick();
    await expect(page.locator('.float-win')).toHaveCount(0);
    const tabsOrder = await page.evaluate(() => [...document.querySelectorAll('.dock.right .dock-body > .panel')].map((p) => p.className));
    expect(tabsOrder[0]).toContain('nodes');
    expect(errors).toEqual([]);
  });

  test('every tab undocked: the dock folds to its rail and the map takes the space', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    const freeBefore = await page.evaluate(() => (window as any).sendit.layout.freeRect().right);
    for (const name of ['Nodes', 'Mission', 'Start', 'Vehicle', 'Events', 'Results', 'Orbit', 'View']) {
      await page.getByRole('button', { name: `Pop out ${name} into a floating window` }).click();
    }
    await expect(page.locator('.float-win')).toHaveCount(8);
    expect((await box(page, '.dock.right')).width).toBeLessThan(80);
    expect(await page.evaluate(() => (window as any).sendit.layout.freeRect().right)).toBeLessThan(freeBefore);
    for (const w of await page.locator('.float-win').all()) {
      const b = (await w.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(1440);
      expect(b.y + b.height).toBeLessThanOrEqual(900);
    }
    expect(errors).toEqual([]);
  });

  test('a click, drag or wheel on a floating window never reaches the map', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    await page.evaluate(() => { const w = (window as any).sendit; w.camera.setDistance(4e7, true); w.store.set({ paused: true }); });
    const dur = await page.evaluate(() => (window as any).sendit.store.get().plan.duration as number);
    const p = await clickableTrajectoryPoint(page, [0.05, 0.03, 0.08, 0.12, 0.2].map((f) => dur * f));
    await page.getByRole('button', { name: 'Pop out Nodes into a floating window' }).click();
    // Put the window's body over that trajectory point and make it short, so its content scrolls.
    await page.evaluate(({ x, y }) => {
      const L = (window as any).sendit.layout;
      const w = [...L.windows.values()][0];
      Object.assign(w.state, { x: x - 150, y: y - 60, w: 300, h: 160 });
      w.clamp();
    }, p);
    const body = (await win(page, 'nodes').locator('.fw-body').boundingBox())!;
    expect(p!.x).toBeGreaterThan(body.x);
    expect(p!.y).toBeGreaterThan(body.y);
    expect(p!.x).toBeLessThan(body.x + body.width);
    expect(p!.y).toBeLessThan(body.y + body.height);
    const nodes0 = await page.evaluate(() => (window as any).sendit.nodesOf().length);
    const cam = () => page.evaluate(() => { const c = (window as any).sendit.camera; return { az: c.azimuth, el: c.elevation, d: c.targetDistance }; });
    const cam0 = await cam();
    // Click and double-click on the window over the trajectory: no pick, no node, no focus change.
    const hint = win(page, 'nodes').locator('.hint').first();
    const hb = (await hint.boundingBox())!;
    await page.mouse.click(hb.x + 4, hb.y + hb.height / 2);
    await page.mouse.dblclick(hb.x + 4, hb.y + hb.height / 2);
    await page.waitForTimeout(300);
    await expect(page.locator('.tap-pop')).toBeHidden();
    // Drag across the window body.
    await page.mouse.move(body.x + 20, body.y + 40);
    await page.mouse.down();
    await page.mouse.move(body.x + 200, body.y + 100, { steps: 8 });
    await page.mouse.up();
    // Wheel over the window: the window scrolls, the camera does not zoom.
    const sc0 = await win(page, 'nodes').locator('.fw-body').evaluate((e) => e.scrollTop);
    await page.mouse.move(body.x + 100, body.y + 80);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(400);
    const sc1 = await win(page, 'nodes').locator('.fw-body').evaluate((e) => e.scrollTop);
    expect(sc1).toBeGreaterThan(sc0);
    expect(await page.evaluate(() => (window as any).sendit.nodesOf().length)).toBe(nodes0);
    const cam1 = await cam();
    expect(cam1.az).toBeCloseTo(cam0.az, 6);
    expect(cam1.el).toBeCloseTo(cam0.el, 6);
    expect(cam1.d / cam0.d).toBeCloseTo(1, 6);
    // Control: the same wheel on the open map does zoom (so the check above can fail).
    await page.mouse.move(60, 450);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(400);
    expect((await cam()).d / cam0.d).not.toBeCloseTo(1, 3);
    expect(errors).toEqual([]);
  });

  test('windows stay in the viewport when the browser window shrinks', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    await page.getByRole('button', { name: 'Pop out Events into a floating window' }).click();
    await page.evaluate(() => {
      const w = [...(window as any).sendit.layout.windows.values()][0];
      Object.assign(w.state, { x: 1000, y: 500, w: 400, h: 380 });
      w.clamp();
    });
    await page.setViewportSize({ width: 1240, height: 640 });
    await page.waitForTimeout(300);
    const b = await box(page, '.float-win[data-tab="events"]');
    expect(b.x + b.width).toBeLessThanOrEqual(1240);
    expect(b.y + b.height).toBeLessThanOrEqual(640);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    // Phone size: everything docks back (no windows); the desktop arrangement is kept for later.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await expect(page.locator('.float-win')).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await expect(win(page, 'events')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('selecting a node brings a floating Nodes window to front', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    await page.evaluate(() => (window as any).sendit.editor.addNode(3000, { kind: 'orbital', body: 'earth' }, [100, 0, 0]));
    await settled(page);
    await page.evaluate(() => (window as any).sendit.store.set({ selectedNode: null }));
    await page.getByRole('button', { name: 'Pop out Nodes into a floating window' }).click();
    await win(page, 'nodes').getByRole('button', { name: 'Collapse the Nodes window' }).click();
    await page.getByRole('button', { name: 'Pop out Orbit into a floating window' }).click();
    const z = async (t: string) => Number(await win(page, t).evaluate((e) => (e as HTMLElement).style.zIndex));
    expect(await z('orbit')).toBeGreaterThan(await z('nodes'));
    const scroll0 = await page.locator('.dock.right .dock-body').evaluate((e) => e.scrollTop);
    await page.evaluate(() => (window as any).sendit.store.set({ selectedNode: 0 }));
    await page.waitForTimeout(200);
    expect(await z('nodes')).toBeGreaterThan(await z('orbit'));
    await expect(win(page, 'nodes').locator('.fw-body')).toBeVisible();
    expect(await page.locator('.dock.right .dock-body').evaluate((e) => e.scrollTop)).toBe(scroll0);
    // The at-cursor strip's Details opens Orbit: its window comes to front.
    const details = page.locator('.map-strip').getByRole('button', { name: 'Details' });
    await page.evaluate(() => { const s = (window as any).sendit.store; s.set({ t: s.get().plan.epoch + 3600, paused: true }); });
    await expect(details).toBeVisible();
    {
      await details.click();
      expect(await z('orbit')).toBeGreaterThan(await z('nodes'));
    }
    expect(errors).toEqual([]);
  });
});

test.describe('tablet landscape', () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: devices['iPad Mini'].userAgent });
  test('side column: undock a tab, the column shows the next one; tab order follows the same list', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    const tabs = await page.locator('.sheet [role="tab"] .tab-label').allTextContents();
    expect(tabs).toEqual(['Nodes', 'Mission', 'Start', 'Vehicle', 'Events', 'Results', 'Orbit', 'View']);
    await page.getByRole('tab', { name: 'Orbit' }).tap();
    await page.getByRole('button', { name: 'Pop out Orbit into a floating window' }).tap();
    await expect(win(page, 'orbit')).toBeVisible();
    await expect(page.locator('.sheet-body .panel.orbit')).toHaveCount(0);
    // Touch drag by the title bar.
    const tb = (await win(page, 'orbit').locator('.fw-title').boundingBox())!;
    const b0 = await box(page, '.float-win[data-tab="orbit"]');
    const cdp = await page.context().newCDPSession(page);
    const pt = (x: number, y: number) => [{ x, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(tb.x + 10, tb.y + 10) });
    for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(tb.x + 10 + k * 15, tb.y + 10 + k * 10) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const b1 = await box(page, '.float-win[data-tab="orbit"]');
    expect(b1.x - b0.x).toBeCloseTo(90, -1);
    expect(b1.y - b0.y).toBeCloseTo(60, -1);
    // Pop out Nodes: show its tab, bring the button into view, check that the button itself is the top element at its
    // centre (on other font metrics it can sit under the floating Orbit window or a sticky header), tap, and expect
    // the window at once; a failure prints what the layout looked like.
    // Tapping the tab that is already shown collapses the column, so tap Nodes only if it is not the shown tab,
    // and reopen the column if it is collapsed.
    const nodesTab = page.getByRole('tab', { name: 'Nodes', exact: true });
    if ((await nodesTab.getAttribute('aria-selected')) !== 'true') await nodesTab.tap();
    const showPanels = page.getByRole('button', { name: 'Show panels' });
    if (await showPanels.isVisible()) await showPanels.tap();
    const pop = page.getByRole('button', { name: 'Pop out Nodes into a floating window' });
    await pop.scrollIntoViewIfNeeded();
    const diag = () => page.evaluate(() => {
      const L = (window as any).sendit.layout;
      const b = document.querySelector('.panel.nodes .undock') as HTMLElement | null;
      const r = b?.getBoundingClientRect();
      const top = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
      return JSON.stringify({
        viewport: [innerWidth, innerHeight], mode: L.mode, floatMode: L.floatMode?.(),
        tabs: [...document.querySelectorAll('.sheet [role="tab"]')].map((t) => `${t.textContent}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`),
        floats: [...document.querySelectorAll('.float-win')].map((w) => (w as HTMLElement).dataset.tab),
        button: r ? { x: r.x, y: r.y, w: r.width, h: r.height, hidden: b!.hidden } : null,
        topAtButton: top ? `${top.tagName}.${top.className}` : null,
        undockLog: L.undockLog,
        buttonEvents: (window as any).__undockEvents ?? [],
      });
    });
    const onTop = await page.evaluate(() => {
      const b = document.querySelector('.panel.nodes .undock') as HTMLElement | null;
      if (!b) return false;
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!top && b.contains(top);
    });
    expect(onTop, `pop-out button reachable: ${await diag()}`).toBe(true);
    // Probe: every pointer / touch / click event on the button, and whether it is still the same node at click time.
    await page.evaluate(() => {
      const log: string[] = ((window as any).__undockEvents = []);
      const b0 = document.querySelector('.panel.nodes .undock');
      for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'click']) {
        document.addEventListener(t, (e) => {
          const el = e.target as Element;
          if (!el.closest?.('.undock')) return;
          log.push(`${Math.round(performance.now())} ${t} ${(e as PointerEvent).pointerType ?? ''} same node: ${el.closest('.undock') === b0}`);
        }, true);
      }
    });
    await pop.tap();
    try {
      await expect(win(page, 'nodes')).toBeVisible({ timeout: 10_000 });
    } catch (e) {
      throw new Error(`no Nodes window after the tap: ${await diag()}\npage errors: ${JSON.stringify(errors)}\n${e}`);
    }
    await win(page, 'nodes').getByRole('slider').fill('55');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/tablet-landscape.png` });
    expect(errors).toEqual([]);
  });
});

test.describe('tablet landscape: a pop-out tap is never lost', () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: devices['iPad Mini'].userAgent });
  const button = (page: Page, tab: string) => page.getByRole('button', { name: `Pop out ${tab} into a floating window` });
  const log = (page: Page) => page.evaluate(() => JSON.stringify((window as any).sendit.layout.undockLog));

  const cdpTap = async (page: Page, x: number, y: number) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  };
  const centre = async (page: Page, tab: string) => { const b = (await button(page, tab).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

  test('a touch tap whose click the browser drops still pops out, exactly once', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    await page.getByRole('tab', { name: 'Events' }).tap();
    // Simulate the browser not sending the click (as seen on CI): a capture listener on window, ahead of the app's.
    await page.evaluate(() => {
      (window as any).__dropped = 0;
      window.addEventListener('click', (e) => { (window as any).__dropped++; e.stopImmediatePropagation(); e.preventDefault(); }, true);
    });
    const c = await centre(page, 'Events');
    await cdpTap(page, c.x, c.y);
    await expect(win(page, 'events'), await log(page)).toBeVisible({ timeout: 3000 });
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as any).sendit.layout.undockLog.filter((l: string) => / events via .*: floated/.test(l)).length)).toBe(1);
    await expect(page.locator('.float-win')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('a late click after a pop-out tap lands on the next button under the finger and does nothing', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    await page.getByRole('tab', { name: 'Events' }).tap();
    // Hold the tap's own click back, as a slow browser would, then deliver a click where the finger was.
    await page.evaluate(() => {
      window.addEventListener('click', (e) => { if (e.isTrusted) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    });
    const c = await centre(page, 'Events');
    await cdpTap(page, c.x, c.y);
    await expect(win(page, 'events')).toBeVisible({ timeout: 3000 });
    const under = await page.evaluate(({ x, y }) => {
      const e = document.elementFromPoint(x, y) as HTMLElement;
      const u = e.closest('.undock') as HTMLElement | null;
      if (u) u.click(); // the late click, synthesised (not trusted, so the holding listener lets it through)
      return u?.getAttribute('aria-label') ?? e.className;
    }, c);
    await page.waitForTimeout(600);
    expect(await page.locator('.float-win').evaluateAll((ws) => ws.map((w) => (w as HTMLElement).dataset.tab)), `late click on ${under}; ${await log(page)}`).toEqual(['events']);
    expect(errors).toEqual([]);
  });

  test('popping out one tab does not pop out the next one, whose button lands under the finger', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    await page.getByRole('tab', { name: 'Events' }).tap();
    await button(page, 'Events').tap();
    await expect(win(page, 'events')).toBeVisible();
    // The column now shows another tab, whose pop-out button sits where the finger was: it must not fire.
    await page.waitForTimeout(800);
    expect(await page.locator('.float-win').evaluateAll((ws) => ws.map((w) => (w as HTMLElement).dataset.tab)), await log(page)).toEqual(['events']);
    expect(errors).toEqual([]);
  });

  test('re-renders between touchstart and touchend, and a tap right after a drag, under CPU throttling', async ({ page }) => {
    const errors = watch(page);
    await fresh(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const touch = (type: string, x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type: type as any, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    for (const name of ['Orbit', 'Events', 'Nodes']) {
      const tab = page.getByRole('tab', { name, exact: true });
      if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.tap();
      const b = (await button(page, name).boundingBox())!;
      const x = b.x + b.width / 2, y = b.y + b.height / 2;
      await touch('touchStart', x, y);
      // Store updates, a layout pass (resize) and a replay-style refresh while the finger is down.
      await page.evaluate(() => {
        const w = (window as any).sendit;
        w.store.set({ paused: !w.store.get().paused });
        window.dispatchEvent(new Event('resize'));
        w.store.set({ paused: !w.store.get().paused });
      });
      await page.waitForTimeout(120);
      await touch('touchEnd');
      await expect(win(page, name.toLowerCase()), await log(page)).toBeVisible({ timeout: 5000 });
      // Drag the new window by its title bar, then go straight on to the next tap.
      const t = (await win(page, name.toLowerCase()).locator('.fw-title').boundingBox())!;
      await touch('touchStart', t.x + 10, t.y + 10);
      for (let k = 1; k <= 4; k++) await touch('touchMove', t.x + 10 + k * 12, t.y + 10 + k * 8);
      await touch('touchEnd');
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await expect(page.locator('.float-win')).toHaveCount(3);
    expect(errors).toEqual([]);
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, userAgent: devices['iPhone 13'].userAgent });
  test('no undock control; saved windows stay docked; tabs in the same order', async ({ page }) => {
    const errors = watch(page);
    await page.goto(`${BASE}/`);
    await page.evaluate(() => localStorage.setItem('sendit.layout.v1', JSON.stringify({ floats: { wide: { nodes: { x: 100, y: 100, w: 300, h: 300, collapsed: false, opacity: 0.6, z: 1 } } } })));
    await page.goto(`${BASE}/`);
    await settled(page);
    const tabs = await page.locator('.sheet [role="tab"] .tab-label').allTextContents();
    expect(tabs).toEqual(['Nodes', 'Mission', 'Start', 'Vehicle', 'Events', 'Results', 'Orbit', 'View']);
    for (const t of ['Nodes', 'Vehicle', 'Orbit']) {
      await page.getByRole('tab', { name: t }).tap();
      await page.waitForTimeout(150);
      await expect(page.locator('.undock:visible')).toHaveCount(0);
    }
    await expect(page.locator('.float-win')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/phone.png` });
    expect(errors).toEqual([]);
  });
});
