/**
 * Display settings of the 3D view that are not part of the plan and never
 * reach the replay: how much of the flight is drawn after the last burn, the
 * reference plane for ascending / descending nodes, and the reference-geometry
 * overlays (rotation axis, equatorial plane disc). Persisted in local storage
 * with the layout. Pure apart from storage access.
 */

/** Drawn span after the last burn. 'auto': to the end on an escape or transfer, three revolutions on a closed orbit with the rest faint. */
export type DrawSpan = 'auto' | 'rev1' | 'rev3' | 'time' | 'all';

export interface ViewSettings {
  span: DrawSpan;
  /** For span 'time': days drawn after the last burn. */
  spanDays: number;
  /** Bright part: only the revolution at the cursor (rest faint), or everything drawn. */
  brightAll: boolean;
  /** Node reference plane: 'equator' (of the craft's reference body) or a target body id (its orbital plane). */
  nodePlane: string;
  showNodes: boolean;
  /** Overlays: body id or '' for the focused body. */
  overlayBody: string;
  showAxis: boolean;
  showEquator: boolean;
  /** Also draw the node reference plane disc when it is a target's orbital plane. */
  showTargetPlane: boolean;
  /** Disc radius in body radii (0: default for the body) and opacity 0..1. */
  discRadius: number;
  discOpacity: number;
  /** Distances to bodies: altitude above the surface or radius from the centre (units.ts). */
  distances: 'alt' | 'radius';
}

export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  span: 'auto',
  spanDays: 1,
  brightAll: false,
  nodePlane: 'equator',
  showNodes: true,
  overlayBody: '',
  showAxis: false,
  showEquator: false,
  showTargetPlane: false,
  discRadius: 0,
  discOpacity: 0.25,
  distances: 'alt',
};

const KEY = 'sendit.view.v1';

export function loadViewSettings(): ViewSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v === 'object') {
      const out = { ...DEFAULT_VIEW_SETTINGS };
      for (const k of Object.keys(out) as (keyof ViewSettings)[]) if (typeof v[k] === typeof out[k]) (out as Record<string, unknown>)[k] = v[k];
      if (out.distances !== 'alt' && out.distances !== 'radius') out.distances = 'alt';
      return out;
    }
  } catch {
    /* defaults */
  }
  return { ...DEFAULT_VIEW_SETTINGS };
}

export function saveViewSettings(s: ViewSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* not persistent */
  }
}

/**
 * Mission time (absolute, s) up to which the trajectory is drawn, and whether
 * the rest is drawn as a faint trace (true) or hidden.
 *  - lastBurnEnd: end of the last flown burn (or the flight start);
 *  - period: orbital period at that time about the dominant body, NaN if unbound;
 *  - end: end of the flight.
 */
export function drawnEnd(s: Pick<ViewSettings, 'span' | 'spanDays'>, lastBurnEnd: number, period: number, end: number): { t: number; faintRest: boolean } {
  const bound = Number.isFinite(period) && period > 0;
  switch (s.span) {
    case 'all':
      return { t: end, faintRest: false };
    case 'auto':
      return bound ? { t: Math.min(end, lastBurnEnd + 3 * period), faintRest: true } : { t: end, faintRest: false };
    case 'rev1':
    case 'rev3':
      return bound ? { t: Math.min(end, lastBurnEnd + (s.span === 'rev1' ? 1 : 3) * period), faintRest: false } : { t: end, faintRest: false };
    case 'time':
      return { t: Math.min(end, lastBurnEnd + Math.max(0, s.spanDays) * 86400), faintRest: false };
  }
}

/** Default equatorial disc radius in body radii: past geostationary for Earth, past the rings for Saturn. */
export function defaultDiscRadius(bodyId: string): number {
  switch (bodyId) {
    case 'earth': return 8;
    case 'saturn': return 3;
    case 'uranus': return 4;
    case 'jupiter': return 4;
    case 'moon': return 4;
    case 'sun': return 3;
    default: return 4;
  }
}
