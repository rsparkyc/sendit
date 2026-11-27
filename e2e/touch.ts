/**
 * Touch gestures that work in every engine.
 *
 * Playwright has real touch input only for single taps (`page.touchscreen.tap`);
 * drags and multi-finger gestures exist only through Chromium's CDP
 * (`Input.dispatchTouchEvent`), which is why the older phone tests are
 * Chromium-only. Here a gesture is replayed as synthetic PointerEvents
 * (pointerType "touch") dispatched in the page: each finger goes to the element
 * under its first point and keeps going there (as pointer capture would). The
 * app reads only Pointer Events, so this drives the same code paths.
 *
 * What it does NOT prove: the browser's own gesture handling (touch-action,
 * page pinch-zoom, scrolling, iOS callouts). Those need a real device; see the
 * manual script in docs/mobile-testing.md.
 */
import type { Page } from '@playwright/test';

export type Finger = { x: number; y: number }[];

/** Replay fingers moving together: finger i follows path[i]; all paths have the same number of points. */
export async function gesture(page: Page, paths: Finger[], stepMs = 16): Promise<void> {
  await page.evaluate(async ({ paths, stepMs }) => {
    const ids = paths.map((_, i) => 9000 + i);
    const targets = paths.map((p) => document.elementFromPoint(p[0].x, p[0].y) ?? document.body);
    const fire = (type: string, i: number, pt: { x: number; y: number }, buttons: number) =>
      targets[i].dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: ids[i], pointerType: 'touch', isPrimary: i === 0, clientX: pt.x, clientY: pt.y, button: type === 'pointermove' ? -1 : 0, buttons, pressure: buttons ? 0.5 : 0, width: 20, height: 20 }));
    const wait = () => new Promise((r) => setTimeout(r, stepMs));
    // Synthetic pointers are not known to the browser, so capturing them throws; capture is emulated by the fixed targets.
    const proto = Element.prototype;
    const [set, rel] = [proto.setPointerCapture, proto.releasePointerCapture];
    const mine = (id: number) => ids.includes(id);
    proto.setPointerCapture = function (id: number) { if (!mine(id)) set.call(this, id); };
    proto.releasePointerCapture = function (id: number) { if (!mine(id)) rel.call(this, id); };
    try {
    for (let i = 0; i < paths.length; i++) {
      fire('pointerdown', i, paths[i][0], 1);
      await wait();
    }
    for (let k = 1; k < paths[0].length; k++) {
      for (let i = 0; i < paths.length; i++) fire('pointermove', i, paths[i][k], 1);
      await wait();
    }
    for (let i = paths.length - 1; i >= 0; i--) fire('pointerup', i, paths[i][paths[i].length - 1], 0);
    } finally {
      proto.setPointerCapture = set;
      proto.releasePointerCapture = rel;
    }
  }, { paths, stepMs });
}

/** A straight one-finger drag in `steps` moves. */
export function line(x0: number, y0: number, x1: number, y1: number, steps = 12): Finger {
  return Array.from({ length: steps + 1 }, (_, k) => ({ x: x0 + ((x1 - x0) * k) / steps, y: y0 + ((y1 - y0) * k) / steps }));
}

export const drag = (page: Page, x0: number, y0: number, x1: number, y1: number, steps = 12) => gesture(page, [line(x0, y0, x1, y1, steps)]);

/** Two fingers on a horizontal line through (cx, cy), from `d0` apart to `d1` apart. */
export const pinch = (page: Page, cx: number, cy: number, d0: number, d1: number, steps = 8) =>
  gesture(page, [line(cx - d0 / 2, cy, cx - d1 / 2, cy, steps), line(cx + d0 / 2, cy, cx + d1 / 2, cy, steps)]);
