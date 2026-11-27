/** Panel order (one list for tabs and column) and the floating windows' pure geometry and persistence. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPACITY, EDGE, FLOAT_MIN_H, FLOAT_MIN_W, OPACITY_MIN, clampRect, defaultRect, floatAllowed, parseFloats } from './float-geom';
import { TABS, orderEntries, type TabId } from './layout';

describe('panel order', () => {
  it('tabs: Nodes first, then the set-once tabs, then the rest', () => {
    expect(TABS.map((t) => t.label)).toEqual(['Nodes', 'Mission', 'Start', 'Vehicle', 'Events', 'Results', 'Orbit', 'View']);
  });
  it('the column follows the tab list, panels of one tab in the order they were added', () => {
    // Registration order of main.ts (left dock first), which used to differ from the tab order.
    const added: TabId[] = ['view', 'mission', 'results', 'results', 'start', 'vehicle', 'vehicle', 'view', 'view', 'nodes', 'events', 'orbit', 'view'];
    const out = orderEntries(added.map((tab, order) => ({ tab, order })));
    const tabsSeen = out.map((e) => e.tab).filter((t, i, a) => a.indexOf(t) === i);
    expect(tabsSeen).toEqual(TABS.map((t) => t.id));
    expect(out.filter((e) => e.tab === 'view').map((e) => e.order)).toEqual([0, 7, 8, 12]);
  });
});

describe('floating window geometry', () => {
  it('keeps a window wholly inside the viewport', () => {
    const r = clampRect({ x: 1500, y: -50, w: 400, h: 300 }, 1280, 720);
    expect(r).toEqual({ x: 1280 - EDGE - 400, y: EDGE, w: 400, h: 300 });
    const l = clampRect({ x: -900, y: 9000, w: 400, h: 300 }, 1280, 720);
    expect(l.x).toBe(EDGE);
    expect(l.y + l.h).toBe(720 - EDGE);
  });
  it('shrinks a window larger than the viewport rather than pushing it off-screen', () => {
    const r = clampRect({ x: 100, y: 100, w: 2000, h: 1500 }, 1000, 600);
    expect(r).toEqual({ x: EDGE, y: EDGE, w: 1000 - 2 * EDGE, h: 600 - 2 * EDGE });
  });
  it('never below the minimum size (when the viewport allows it)', () => {
    const r = clampRect({ x: 10, y: 10, w: 20, h: 20 }, 1280, 720);
    expect(r.w).toBe(FLOAT_MIN_W);
    expect(r.h).toBe(FLOAT_MIN_H);
  });
  it('a collapsed window may sit lower: only its title bar must fit', () => {
    const r = clampRect({ x: 10, y: 700, w: 300, h: 400 }, 1280, 720, 34);
    expect(r.y).toBe(720 - EDGE - 34);
    expect(r.h).toBe(400);
  });
  it('opens in the free map area and cascades', () => {
    const free = { left: 0, top: 60, right: 900, bottom: 600 };
    const a = defaultRect('nodes', 0, free);
    const b = defaultRect('orbit', 1, free);
    expect(a.x).toBeGreaterThanOrEqual(free.left);
    expect(a.y).toBeGreaterThanOrEqual(free.top);
    expect(a.y + a.h).toBeLessThanOrEqual(free.bottom);
    expect(b.x - a.x).toBe(28);
    expect(b.y - a.y).toBe(28);
    for (let k = 0; k < 30; k++) {
      const c = defaultRect('view', k, free);
      expect(c.x + c.w).toBeLessThanOrEqual(free.right);
      expect(c.y + c.h).toBeLessThanOrEqual(free.bottom);
    }
  });
  it('offered on desktops and landscape tablets, not on phones', () => {
    expect(floatAllowed('wide', 1440, 900)).toBe(true);
    expect(floatAllowed('side', 1024, 768)).toBe(true);
    expect(floatAllowed('side', 844, 390)).toBe(false);
    expect(floatAllowed('sheet', 820, 1180)).toBe(false);
    expect(floatAllowed('sheet', 390, 844)).toBe(false);
  });
});

describe('floating window persistence', () => {
  const tabs = TABS.map((t) => t.id);
  it('round-trips through JSON per mode', () => {
    const v = { wide: { nodes: { x: 10, y: 20, w: 300, h: 400, collapsed: true, opacity: 0.5, z: 3 } }, side: { orbit: { x: 1, y: 2, w: 250, h: 200, collapsed: false, opacity: 1, z: 1 } } };
    expect(parseFloats(JSON.parse(JSON.stringify(v)), tabs)).toEqual(v);
  });
  it('drops malformed entries and unknown tabs; clamps opacity', () => {
    const p = parseFloats({ wide: { nodes: { x: 'a', y: 0, w: 1, h: 1 }, bogus: { x: 0, y: 0, w: 300, h: 300 }, view: { x: 0, y: 0, w: 300, h: 300, opacity: 0.01 } }, sheet: { nodes: {} } }, tabs);
    expect(Object.keys(p.wide)).toEqual(['view']);
    expect(p.wide.view.opacity).toBe(OPACITY_MIN);
    expect(p.wide.view.collapsed).toBe(false);
    expect(Object.keys(p)).toEqual(['wide', 'side']);
    expect(parseFloats(null, tabs)).toEqual({ wide: {}, side: {} });
    expect(parseFloats({ wide: { view: { x: 0, y: 0, w: 300, h: 300 } } }, tabs).wide.view.opacity).toBe(DEFAULT_OPACITY);
  });
});
