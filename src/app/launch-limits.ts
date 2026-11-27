/**
 * Clamping of launch choices to what the site allows (pure, UI side).
 *
 * A site's range-safety corridor is one clockwise sweep of inertial azimuth from
 * azimuthMinDeg to azimuthMaxDeg (min may be negative, i.e. the corridor wraps
 * through north; a sweep of 360° or more allows everything). The forbidden part
 * is the single gap from max clockwise round to min.
 *
 * Rules: a value inside the allowed set is kept as is. A move that starts from an
 * allowed value and enters the gap stops at the boundary on the side it came
 * from; any other value outside (a typed number, a click) goes to the nearest
 * allowed value. Boundaries are returned exactly (no rounding).
 */

export interface Corridor {
  readonly azimuthMinDeg: number;
  readonly azimuthMaxDeg: number;
}

export type Interval = readonly [number, number];

const norm360 = (a: number): number => ((a % 360) + 360) % 360;

/**
 * Clamp x to a union of closed intervals on a line. With `from` inside one of the
 * intervals the result stays in that interval (the side the move came from);
 * otherwise it is the nearest allowed point. No intervals: x unchanged.
 */
export function clampToIntervals(x: number, ivs: readonly Interval[], from?: number): number {
  if (!ivs.length) return x;
  for (const [a, b] of ivs) if (x >= a && x <= b) return x;
  if (from !== undefined) {
    const home = ivs.find(([a, b]) => from >= a && from <= b);
    if (home) return Math.max(home[0], Math.min(home[1], x));
  }
  let best = x;
  let bd = Infinity;
  for (const [a, b] of ivs) {
    for (const e of [a, b]) {
      const d = Math.abs(e - x);
      if (d < bd) { bd = d; best = e; }
    }
  }
  return best;
}

/** True if the corridor sweeps the whole circle. */
export function corridorIsFull(c: Corridor): boolean {
  return c.azimuthMaxDeg - c.azimuthMinDeg >= 360;
}

/** Allowed azimuth (deg, [0, 360)) test; same rule as the mission's azimuthAllowed. */
export function inCorridor(c: Corridor, az: number): boolean {
  const span = c.azimuthMaxDeg - c.azimuthMinDeg;
  if (span >= 360) return true;
  return norm360(az - c.azimuthMinDeg) <= span;
}

/**
 * Clamp an azimuth (deg) into the corridor, result in [0, 360). `fromDeg`: the
 * value the move started from; if it is allowed, a move into the gap stops at the
 * boundary on its side (direction by the shortest signed turn from it).
 */
export function clampAzimuth(c: Corridor, az: number, fromDeg?: number): number {
  const a = norm360(az);
  if (inCorridor(c, a)) return a;
  const lo = norm360(c.azimuthMinDeg);
  const hi = norm360(c.azimuthMaxDeg);
  if (fromDeg !== undefined && inCorridor(c, fromDeg)) {
    const turn = norm360(a - fromDeg + 180) - 180;
    return turn >= 0 ? hi : lo;
  }
  return norm360(a - c.azimuthMaxDeg) <= norm360(c.azimuthMinDeg - a) ? hi : lo;
}

/** Allowed intervals on an unwrapped azimuth axis (the launch chart's x), covering [x0, x1]. */
export function corridorIntervals(c: Corridor, x0: number, x1: number): Interval[] {
  if (corridorIsFull(c)) return [];
  const lo = c.azimuthMinDeg;
  let hi = c.azimuthMaxDeg;
  while (hi < lo) hi += 360;
  const out: Interval[] = [];
  for (let k = Math.floor((x0 - hi) / 360); lo + 360 * k <= x1; k++) {
    const a = lo + 360 * k, b = hi + 360 * k;
    if (b >= x0) out.push([a, b]);
  }
  return out;
}

/** "38°–120°" style label of the corridor's limits (as the site states them, wrapped to [0, 360)). */
export function corridorLabel(c: Corridor): string {
  const f = (v: number) => `${+norm360(v).toFixed(2)}°`;
  return `${f(c.azimuthMinDeg)}–${f(c.azimuthMaxDeg)}`;
}
