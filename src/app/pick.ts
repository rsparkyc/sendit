/**
 * What a click or a double-click on the 3D map means when several things are
 * under or near the pointer (pure). Precedence, highest first:
 *
 *   1. the spacecraft
 *   2. maneuver nodes and burn ignition / cutoff markers
 *   3. event markers and ascending / descending node markers
 *   4. launch-site markers
 *   5. bodies (only when the pointer is on the disc, or near a tiny one); among
 *      several, the one nearest the camera first, so a moon in front of its
 *      planet wins over the planet
 *   6. a point on the trajectory (never one hidden behind a body)
 *   7. nothing
 *
 * Within one class (other than bodies) the candidate nearest the pointer on
 * screen wins. Candidates must already be within their hit radius and not
 * occluded; the caller decides that.
 */
export type PickKind = 'spacecraft' | 'node' | 'event' | 'site' | 'body' | 'trajectory';

export const PICK_ORDER: readonly PickKind[] = ['spacecraft', 'node', 'event', 'site', 'body', 'trajectory'];

export interface PickCandidate {
  kind: PickKind;
  /** Label key, body index, or mission time; whatever the caller needs. */
  key: string;
  /** Distance from the pointer on screen, px. */
  screenDist: number;
  /** Distance from the camera, m (bodies: to the nearest point of the surface). */
  depth: number;
}

export function pickTarget(cands: readonly PickCandidate[]): PickCandidate | null {
  let best: PickCandidate | null = null;
  let bestRank = Infinity;
  for (const c of cands) {
    const r = PICK_ORDER.indexOf(c.kind);
    if (r < 0) continue;
    if (r < bestRank) {
      best = c;
      bestRank = r;
      continue;
    }
    if (r > bestRank || !best) continue;
    const better = c.kind === 'body' ? c.depth < best.depth || (c.depth === best.depth && c.screenDist < best.screenDist) : c.screenDist < best.screenDist;
    if (better) best = c;
  }
  return best;
}

/** Kind of a map label key: 'sc', 'node:i', 'burn:i:s|e', 'sep:j', 'ev:i', 'pn:i', 'site:id', a body index; null for others (axis ends). */
export function kindOfLabel(key: string): PickKind | null {
  if (key === 'sc') return 'spacecraft';
  if (key.startsWith('node:') || key.startsWith('burn:') || key.startsWith('sep:')) return 'node';
  if (key.startsWith('ev:') || key.startsWith('pn:')) return 'event';
  if (key.startsWith('site:')) return 'site';
  if (/^\d+$/.test(key)) return 'body';
  return null;
}

/** Two taps form a double tap if close in time and place. */
export const DOUBLE_MS = 350;
export const DOUBLE_PX = 36;
export function isDoubleTap(prev: { t: number; x: number; y: number } | null, t: number, x: number, y: number): boolean {
  return !!prev && t - prev.t < DOUBLE_MS && t - prev.t >= 0 && Math.hypot(x - prev.x, y - prev.y) < DOUBLE_PX;
}

/**
 * A label's text can lie over another marker's dot (the text boxes are laid out around dots, and on touch they
 * carry padding for a finger). A dot must always take a tap at its centre, so a tap on label text first looks for
 * a marker dot within `radius` px of the tap: the nearest one wins (its own label's dot included), and only
 * where there is none does the text take the tap. The radius is the dot's own hit disc (small: text taps a little
 * away from any dot still go to the text). Nothing moves, so the labels do not jitter.
 */
export const DOT_TAP_RADIUS = { mouse: 7, touch: 16 } as const;
export function dotUnderTap(dots: readonly { key: string; x: number; y: number }[], x: number, y: number, radius: number): string | null {
  let best: string | null = null;
  let bd = radius;
  for (const d of dots) {
    const r = Math.hypot(d.x - x, d.y - y);
    if (r <= bd) {
      bd = r;
      best = d.key;
    }
  }
  return best;
}
