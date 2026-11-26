/**
 * Ascending and descending nodes of the spacecraft's orbit relative to a
 * reference plane (a body's equator, or another body's orbital plane). Pure.
 *
 * Crossings are found on the replayed trajectory itself: the sign change of
 * the out-of-plane coordinate z = n . r between consecutive samples, refined
 * by cubic Hermite interpolation (positions and velocities at both ends)
 * followed by a few bisection steps on that cubic. Ascending: z goes from
 * negative to positive. The relative inclination at a crossing is the angle
 * between the orbit normal r x v and the plane normal.
 */

/** Relative position and velocity of the craft about the plane's centre body at one sample. */
export interface RelSample {
  t: number;
  /** x y z vx vy vz relative to the reference body, m and m/s (any inertial axes). */
  s: ArrayLike<number>;
  /** Unit normal of the reference plane at t (same axes). */
  n: ArrayLike<number>;
}

export interface PlaneCrossing {
  t: number;
  ascending: boolean;
  /** Angle between the orbit's plane and the reference plane, degrees (0..180). */
  inclinationDeg: number;
  /** Relative position at the crossing (interpolated), same axes as the samples. */
  r: [number, number, number];
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>, ao = 0) => a[ao] * b[0] + a[ao + 1] * b[1] + a[ao + 2] * b[2];

/** Cubic Hermite of scalar f on [0, h] with values f0, f1 and derivatives d0, d1; u in [0, 1]. */
function hermite(f0: number, d0: number, f1: number, d1: number, h: number, u: number): number {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * f0 + (u3 - 2 * u2 + u) * h * d0 + (-2 * u3 + 3 * u2) * f1 + (u3 - u2) * h * d1;
}

export function planeCrossings(samples: readonly RelSample[]): PlaneCrossing[] {
  const out: PlaneCrossing[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    // Use the plane at the later sample for both ends (it turns very slowly against a step).
    const n = b.n;
    const za = dot(a.s, n), zb = dot(b.s, n);
    if (!(za < 0 && zb >= 0) && !(za > 0 && zb <= 0)) continue;
    if (za === 0) continue; // counted at the previous step
    const h = b.t - a.t;
    if (!(h > 0)) continue;
    const da = dot(a.s, n, 3), db = dot(b.s, n, 3);
    // Bisection on the Hermite cubic (which matches z and dz/dt at both ends); a linear guess bounds nothing better.
    let lo = 0, hi = 1;
    const flo = za;
    for (let k = 0; k < 50; k++) {
      const m = 0.5 * (lo + hi);
      const fm = hermite(za, da, zb, db, h, m);
      if (fm === 0) { lo = hi = m; break; }
      if ((fm < 0) === (flo < 0)) lo = m;
      else hi = m;
    }
    const u = 0.5 * (lo + hi);
    const r: [number, number, number] = [0, 0, 0];
    const v: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      r[k] = hermite(a.s[k], a.s[k + 3], b.s[k], b.s[k + 3], h, u);
      v[k] = a.s[k + 3] + (b.s[k + 3] - a.s[k + 3]) * u;
    }
    const hx = r[1] * v[2] - r[2] * v[1], hy = r[2] * v[0] - r[0] * v[2], hz = r[0] * v[1] - r[1] * v[0];
    const hm = Math.hypot(hx, hy, hz);
    const c = hm > 0 ? (hx * n[0] + hy * n[1] + hz * n[2]) / hm : 1;
    out.push({ t: a.t + u * h, ascending: za < 0, inclinationDeg: (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI, r });
  }
  return out;
}

/**
 * Which crossings to mark in the view: the next ascending and next descending
 * one after the cursor (the last two when the cursor is past them all), or
 * every crossing when there are at most `max`. On a repeating orbit the
 * previous crossings sit on the same spots, so they are left out.
 * Returns indices into `crossings` (sorted by time).
 */
export function crossingsNear(crossings: readonly PlaneCrossing[], t: number, max = 6): number[] {
  if (crossings.length <= max) return crossings.map((_, i) => i);
  let k = 0;
  while (k < crossings.length && crossings[k].t < t) k++;
  const from = Math.min(k, crossings.length - 2);
  return [from, from + 1];
}

/**
 * Collapse runs of crossings for the events list: runs of 4 or more crossings
 * whose relative inclination stays within `tolDeg` become one group (like
 * the near-circular apsides). Returns groups of indices.
 */
export function groupCrossings(crossings: readonly PlaneCrossing[], tolDeg = 0.5): number[][] {
  const out: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 4) out.push(run);
    else for (const i of run) out.push([i]);
    run = [];
  };
  crossings.forEach((c, i) => {
    if (run.length) {
      const incs = [...run.map((j) => crossings[j].inclinationDeg), c.inclinationDeg];
      if (Math.max(...incs) - Math.min(...incs) > tolDeg) flush();
    }
    run.push(i);
  });
  flush();
  return out;
}
