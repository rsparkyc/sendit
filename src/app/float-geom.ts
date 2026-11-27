/**
 * Floating panel windows: the pure parts (geometry and persistence). The DOM
 * side is float-window.ts; layout.ts owns which tabs float.
 *
 * A window is kept wholly inside the viewport (`clampRect`), on drag, resize,
 * restore and when the browser window shrinks; its size is clamped first, so
 * a window larger than the viewport is shrunk rather than pushed off-screen.
 * New windows open in the part of the map no dock, status bar or timeline
 * covers, cascaded by 28 px (`defaultRect`).
 */

export interface FloatState {
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
  /** Background opacity, OPACITY_MIN..1 (the text stays opaque). */
  opacity: number;
  /** Stacking order: higher is in front. */
  z: number;
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const FLOAT_MIN_W = 240;
export const FLOAT_MIN_H = 140;
export const OPACITY_MIN = 0.3;
export const DEFAULT_OPACITY = 0.85;
/** Gap kept between a window and the viewport edge, px. */
export const EDGE = 4;
const CASCADE = 28;

/** Preferred size per tab (px), before clamping to the free area. */
const PREFERRED: Record<string, [number, number]> = {
  nodes: [380, 520],
  mission: [360, 380],
  start: [380, 480],
  vehicle: [400, 480],
  events: [360, 400],
  results: [360, 440],
  orbit: [340, 380],
  view: [320, 460],
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Keep a window inside the viewport: size first (at least the minimum, at most
 * the viewport less the edge gaps), then position. `visibleH` is the height
 * on screen (the title bar alone when collapsed); the stored height is kept.
 */
export function clampRect<T extends { x: number; y: number; w: number; h: number }>(r: T, vw: number, vh: number, visibleH?: number): T {
  const maxW = Math.max(120, vw - 2 * EDGE);
  const maxH = Math.max(60, vh - 2 * EDGE);
  const w = Math.round(clamp(r.w, Math.min(FLOAT_MIN_W, maxW), maxW));
  const h = Math.round(clamp(r.h, Math.min(FLOAT_MIN_H, maxH), maxH));
  const shown = visibleH === undefined ? h : Math.min(visibleH, maxH);
  const x = Math.round(clamp(r.x, EDGE, Math.max(EDGE, vw - EDGE - w)));
  const y = Math.round(clamp(r.y, EDGE, Math.max(EDGE, vh - EDGE - shown)));
  return { ...r, x, y, w, h };
}

/** Where a newly undocked window opens: the free map area, the k-th window cascaded. */
export function defaultRect(tab: string, k: number, free: Bounds): { x: number; y: number; w: number; h: number } {
  const [pw, ph] = PREFERRED[tab] ?? [360, 420];
  const areaW = Math.max(FLOAT_MIN_W, free.right - free.left - 24);
  const areaH = Math.max(FLOAT_MIN_H, free.bottom - free.top - 24);
  const w = Math.min(pw, areaW);
  const h = Math.min(ph, areaH);
  // Cascade inside the free area; wrap back to the corner when the next step would leave it.
  const steps = Math.max(1, Math.floor(Math.min(areaW - w, areaH - h) / CASCADE) + 1);
  const off = (k % steps) * CASCADE;
  return { x: free.left + 12 + off, y: free.top + 12 + off, w, h };
}

/** Floating windows per layout mode that may float, per tab. */
export type FloatModes = Record<'wide' | 'side', Record<string, FloatState>>;

export const emptyFloats = (): FloatModes => ({ wide: {}, side: {} });

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Read saved floating windows, dropping anything malformed or for an unknown tab (pure). */
export function parseFloats(v: unknown, tabs: readonly string[]): FloatModes {
  const out = emptyFloats();
  if (!v || typeof v !== 'object') return out;
  for (const mode of ['wide', 'side'] as const) {
    const m = (v as Record<string, unknown>)[mode];
    if (!m || typeof m !== 'object') continue;
    for (const [tab, s] of Object.entries(m as Record<string, unknown>)) {
      if (!tabs.includes(tab) || !s || typeof s !== 'object') continue;
      const o = s as Record<string, unknown>;
      if (!num(o.x) || !num(o.y) || !num(o.w) || !num(o.h)) continue;
      out[mode][tab] = {
        x: o.x, y: o.y, w: o.w, h: o.h,
        collapsed: o.collapsed === true,
        opacity: num(o.opacity) ? clamp(o.opacity, OPACITY_MIN, 1) : DEFAULT_OPACITY,
        z: num(o.z) ? Math.round(o.z) : 0,
      };
    }
  }
  return out;
}

/** Floating windows are offered on desktops and tablets in landscape, not on phone-sized screens. */
export function floatAllowed(mode: 'wide' | 'side' | 'sheet', w: number, h: number): mode is 'wide' | 'side' {
  return mode !== 'sheet' && w >= 900 && h >= 520;
}
