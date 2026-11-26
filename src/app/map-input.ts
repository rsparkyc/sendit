/**
 * Pointer input on the 3D map, for mouse, pen and touch alike (Pointer Events):
 *
 *  - one-finger / left-button drag orbits the camera, with modest inertia
 *    after a fling (none under prefers-reduced-motion);
 *  - two-finger pinch zooms; two-finger drag tilts (vertical) and turns
 *    (horizontal) — the camera orbits a focus, so there is nothing to pan;
 *  - wheel and trackpad pinch (wheel + ctrlKey) zoom;
 *  - a tap or click that did not move reports `tap`; two quick taps at the
 *    same spot report `doubleTap` as well.
 *
 * The canvas has `touch-action: none`, so the browser neither scrolls nor
 * zooms the page while a finger is on the map; pinch-zoom of the page stays
 * available everywhere else (the viewport is not locked).
 */

export interface MapInputHandlers {
  rotate(dAz: number, dEl: number): void;
  zoom(factor: number): void;
  fling(vAz: number, vEl: number): void;
  stop(): void;
  tap(x: number, y: number, pointerType: string): void;
  doubleTap(x: number, y: number, pointerType: string): void;
  /** Any interaction (redraw needed). */
  changed(): void;
}

const ROT = 0.005; // rad per px
const TAP_SLOP = { mouse: 4, pen: 8, touch: 12 } as Record<string, number>;
const DOUBLE_MS = 350;
const DOUBLE_PX = 36;

interface Pt {
  x: number;
  y: number;
  type: string;
}

export class MapInput {
  private readonly pts = new Map<number, Pt>();
  private drag: { x0: number; y0: number; t0: number; moved: boolean; type: string } | null = null;
  private pinch: { dist: number; mx: number; my: number } | null = null;
  private samples: { t: number; dAz: number; dEl: number }[] = [];
  private lastTap: { t: number; x: number; y: number } | null = null;

  constructor(private readonly el: HTMLElement, private readonly h: MapInputHandlers) {
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.cancel(e));
    el.addEventListener('lostpointercapture', (e) => this.cancel(e));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      h.zoom(Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015)));
      h.changed();
    }, { passive: false });
    // Safari's own pinch gesture events: keep them off the map.
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) el.addEventListener(t, (e) => e.preventDefault());
    el.addEventListener('contextmenu', (e) => {
      if (this.pts.size > 0 || this.drag) e.preventDefault();
    });
  }

  private down(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers may not be capturable */
    }
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    this.h.stop();
    this.samples = [];
    if (this.pts.size === 1) {
      this.drag = { x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, type: e.pointerType };
      this.pinch = null;
    } else if (this.pts.size === 2) {
      if (this.drag) this.drag.moved = true; // a second finger is never a tap
      this.pinch = this.pinchState();
    }
  }

  private pinchState(): { dist: number; mx: number; my: number } {
    const [a, b] = [...this.pts.values()];
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private move(e: PointerEvent): void {
    const p = this.pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pts.size === 1 && this.drag) {
      if (!this.drag.moved && Math.hypot(e.clientX - this.drag.x0, e.clientY - this.drag.y0) > (TAP_SLOP[this.drag.type] ?? 8)) this.drag.moved = true;
      if (!this.drag.moved) return;
      const dAz = -dx * ROT;
      const dEl = dy * ROT;
      this.h.rotate(dAz, dEl);
      const now = performance.now();
      this.samples.push({ t: now, dAz, dEl });
      while (this.samples.length && now - this.samples[0].t > 80) this.samples.shift();
      this.h.changed();
    } else if (this.pts.size === 2 && this.pinch) {
      const q = this.pinchState();
      this.h.zoom(this.pinch.dist / q.dist);
      // Two-finger drag: vertical tilts, horizontal turns.
      this.h.rotate(-(q.mx - this.pinch.mx) * ROT, (q.my - this.pinch.my) * ROT);
      this.pinch = q;
      this.h.changed();
    }
  }

  private up(e: PointerEvent): void {
    if (!this.pts.has(e.pointerId)) return;
    this.pts.delete(e.pointerId);
    if (this.pts.size === 1) {
      // Pinch ended with one finger still down: continue as a drag from here, never a tap.
      const [rest] = [...this.pts.values()];
      this.drag = { x0: rest.x, y0: rest.y, t0: performance.now(), moved: true, type: rest.type };
      this.pinch = null;
      return;
    }
    if (this.pts.size > 0) return;
    const d = this.drag;
    this.drag = null;
    this.pinch = null;
    if (!d) return;
    if (!d.moved) {
      const now = performance.now();
      if (now - d.t0 < 600) {
        this.h.tap(e.clientX, e.clientY, e.pointerType);
        const lt = this.lastTap;
        if (lt && now - lt.t < DOUBLE_MS && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < DOUBLE_PX) {
          this.lastTap = null;
          this.h.doubleTap(e.clientX, e.clientY, e.pointerType);
        } else this.lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
      return;
    }
    // Fling: mean angular velocity over the last 80 ms of the drag.
    const s = this.samples;
    if (s.length >= 2) {
      const span = (s[s.length - 1].t - s[0].t) / 1000;
      if (span > 0.008 && performance.now() - s[s.length - 1].t < 60) {
        const az = s.slice(1).reduce((a, x) => a + x.dAz, 0) / span;
        const el = s.slice(1).reduce((a, x) => a + x.dEl, 0) / span;
        this.h.fling(az * 0.6, el * 0.6);
      }
    }
    this.samples = [];
    this.h.changed();
  }

  private cancel(e: PointerEvent): void {
    if (!this.pts.has(e.pointerId)) return;
    this.pts.delete(e.pointerId);
    if (this.pts.size === 0) {
      this.drag = null;
      this.pinch = null;
    }
  }
}

/**
 * Index of the point nearest (x, y) within `radius` px, or -1. `at(i, out)`
 * projects point i to the screen and returns false if it is not visible.
 */
export function nearestOnScreen(count: number, at: (i: number, out: { x: number; y: number }) => boolean, x: number, y: number, radius: number): number {
  let best = radius * radius;
  let bi = -1;
  const p = { x: 0, y: 0 };
  for (let i = 0; i < count; i++) {
    if (!at(i, p)) continue;
    const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d2 < best) {
      best = d2;
      bi = i;
    }
  }
  return bi;
}
