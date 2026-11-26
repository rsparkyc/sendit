/**
 * Test-only helpers for comparing a propagated flyby with a reference
 * trajectory (test/voyager2-jupiter.test.ts): capture of the propagated state
 * at given times, Hermite interpolation of sampled states, closest approach,
 * osculating hyperbola, and an Ephemeris wrapper that switches effects on and
 * off for attribution. Not under src/, so any Math function is allowed.
 */
import { propagate, type BodyOblateness, type Burn, type Ephemeris } from '../../src/physics/spacecraft';

export type State = Float64Array; // [x y z vx vy vz]

/** An impulsive velocity change at time t (models a short burn in the reference). */
export interface Impulse {
  t: number;
  dv: readonly [number, number, number];
}

/**
 * Propagate a massless spacecraft from y0 at t0 and capture its state at every
 * time in `times` (ascending, within [t0, tEnd]) with the propagator's own
 * dense output. Impulses are applied between integration segments.
 */
export function capture(
  eph: Ephemeris,
  y0: ArrayLike<number>,
  t0: number,
  times: readonly number[],
  impulses: readonly Impulse[] = [],
  /**
   * Optional constant inertial acceleration (m/s^2) over the whole run, e.g. a
   * solar-radiation-pressure estimate; applied as a burn of negligible mass flow
   * through the public burn API.
   */
  accel?: readonly [number, number, number],
  rtol = 1e-12,
): Map<number, State> {
  const out = new Map<number, State>();
  const tEnd = times[times.length - 1];
  const imps = impulses.filter((i) => i.t > t0 && i.t < tEnd).sort((a, b) => a.t - b.t);
  const stops = [...imps.map((i) => i.t), tEnd];
  let y = Float64Array.from([y0[0], y0[1], y0[2], y0[3], y0[4], y0[5], 1000]);
  let t = t0;
  let next = 0;
  while (next < times.length && times[next] <= t0) out.set(times[next++], y.slice(0, 6));
  const tmp = new Float64Array(7);
  for (let s = 0; s < stops.length; s++) {
    const t1 = stops[s];
    const an = accel ? Math.hypot(accel[0], accel[1], accel[2]) : 0;
    const burns: Burn[] = an > 0 ? [{ tStart: t, duration: t1 - t, thrust: an * y[6], isp: 1e15, direction: [accel![0], accel![1], accel![2]], frame: { kind: 'inertial' } }] : [];
    const res = propagate(eph, y, t, t1, burns, {
      rtol,
      onStep: (tt, _y, interp) => {
        while (next < times.length && times[next] <= tt && times[next] <= t1) {
          interp(times[next], tmp);
          out.set(times[next++], tmp.slice(0, 6));
        }
      },
    });
    y = Float64Array.from(res.y);
    t = t1;
    if (s < imps.length) for (let k = 0; k < 3; k++) y[3 + k] += imps[s].dv[k];
  }
  return out;
}

/** Cubic Hermite interpolation of position and velocity between two states h apart. */
export function hermite(a: ArrayLike<number>, b: ArrayLike<number>, h: number, s: number): State {
  const out = new Float64Array(6);
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const d00 = (6 * s2 - 6 * s) / h, d10 = 3 * s2 - 4 * s + 1, d01 = (-6 * s2 + 6 * s) / h, d11 = 3 * s2 - 2 * s;
  for (let k = 0; k < 3; k++) {
    out[k] = h00 * a[k] + h10 * h * a[3 + k] + h01 * b[k] + h11 * h * b[3 + k];
    out[3 + k] = d00 * a[k] + d10 * a[3 + k] + d01 * b[k] + d11 * b[3 + k];
  }
  return out;
}

/** A sampled relative trajectory: times ascending, states [x y z vx vy vz]. */
export interface Track {
  t: readonly number[];
  s: readonly ArrayLike<number>[];
}

export function at(track: Track, t: number): State {
  let k = track.t.findIndex((x) => x > t) - 1;
  if (k < 0) k = t <= track.t[0] ? 0 : track.t.length - 2;
  const h = track.t[k + 1] - track.t[k];
  return hermite(track.s[k], track.s[k + 1], h, (t - track.t[k]) / h);
}

/** Closest approach of a relative track: sample minimum, then golden-section on the Hermite interpolant. */
export function closestApproach(track: Track): { t: number; d: number; v: number } {
  let best = 0;
  const r = (s: ArrayLike<number>) => Math.hypot(s[0], s[1], s[2]);
  for (let k = 1; k < track.t.length; k++) if (r(track.s[k]) < r(track.s[best])) best = k;
  let a = track.t[Math.max(0, best - 1)];
  let b = track.t[Math.min(track.t.length - 1, best + 1)];
  const f = (t: number) => r(at(track, t));
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 100 && b - a > 1e-4; i++) {
    const c = b - g * (b - a);
    const d = a + g * (b - a);
    if (f(c) < f(d)) b = d;
    else a = c;
  }
  const t = (a + b) / 2;
  const s = at(track, t);
  return { t, d: r(s), v: Math.hypot(s[3], s[4], s[5]) };
}

export const sub = (a: ArrayLike<number>, b: ArrayLike<number>): State => Float64Array.from({ length: 6 }, (_, k) => a[k] - b[k]);
export const norm3 = (a: ArrayLike<number>, o = 0) => Math.hypot(a[o], a[o + 1], a[o + 2]);
export const angle = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (norm3(a) * norm3(b));
  return Math.acos(Math.min(1, Math.max(-1, c)));
};

/**
 * Osculating hyperbola of a relative state about a center of parameter mu:
 * hyperbolic excess speed and the incoming / outgoing asymptote directions.
 */
export function hyperbola(rel: ArrayLike<number>, mu: number): { vinf: number; e: number; vIn: number[]; vOut: number[]; turn: number } {
  const r = [rel[0], rel[1], rel[2]];
  const v = [rel[3], rel[4], rel[5]];
  const rn = norm3(r);
  const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  const ev = [0, 1, 2].map((k) => ((v2 - mu / rn) * r[k] - rv * v[k]) / mu);
  const e = norm3(ev);
  const h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
  const hn = norm3(h);
  const p = ev.map((x) => x / e);
  const q = [(h[1] * p[2] - h[2] * p[1]) / hn, (h[2] * p[0] - h[0] * p[2]) / hn, (h[0] * p[1] - h[1] * p[0]) / hn];
  const c = -1 / e;
  const s = Math.sqrt(1 - c * c);
  // Outgoing velocity is parallel to the position direction at nu -> +nu_inf;
  // incoming velocity is minus the position direction at nu -> -nu_inf.
  const vOut = [0, 1, 2].map((k) => c * p[k] + s * q[k]);
  const vIn = [0, 1, 2].map((k) => -(c * p[k] - s * q[k]));
  return { vinf: Math.sqrt(v2 - (2 * mu) / rn), e, vIn, vOut, turn: 2 * Math.asin(1 / e) };
}

export interface Overrides {
  /** Replace GM per body index (e.g. 0 to drop a body, or lump it into another). */
  gm?: ReadonlyMap<number, number>;
  /** Replace the zonal field of these bodies (null: point mass). */
  oblateness?: ReadonlyMap<number, BodyOblateness | null>;
  /** Drop the Sun's relativistic term. */
  noRelativity?: boolean;
  /**
   * Replace body i's position by base(i) + (alt(i) - alt(base)) taken from another
   * ephemeris (e.g. a moon's planet-relative position from a better ephemeris).
   */
  relativeFrom?: { eph: Ephemeris; base: number; bodies: readonly number[] };
}

/** An Ephemeris that forwards to `eph` with some effects switched (for attribution only). */
export function withOverrides(eph: Ephemeris, o: Overrides): Ephemeris {
  const gm = Float64Array.from(eph.gm as ArrayLike<number>);
  o.gm?.forEach((v, i) => (gm[i] = v));
  const ob = eph.oblateness ? Array.from(eph.oblateness as ArrayLike<BodyOblateness | null>) : undefined;
  if (ob) o.oblateness?.forEach((v, i) => (ob[i] = v));
  const alt = o.relativeFrom;
  const tmp = new Float64Array(3 * eph.count);
  const tmpS = new Float64Array(6);
  const tmpB = new Float64Array(6);
  const fix = (t: number, out: Float64Array) => {
    if (!alt) return;
    alt.eph.positions(t, tmp);
    for (const i of alt.bodies) for (let k = 0; k < 3; k++) out[3 * i + k] = out[3 * alt.base + k] + tmp[3 * i + k] - tmp[3 * alt.base + k];
  };
  return {
    count: eph.count,
    gm,
    oblateness: ob,
    relativity: o.noRelativity ? undefined : eph.relativity,
    positions(t, out) {
      eph.positions(t, out);
      fix(t, out);
    },
    bodyState(i, t, out) {
      eph.bodyState(i, t, out);
      if (alt && alt.bodies.includes(i)) {
        alt.eph.bodyState(i, t, tmpS);
        alt.eph.bodyState(alt.base, t, tmpB);
        eph.bodyState(alt.base, t, tmp);
        for (let k = 0; k < 6; k++) out[k] = tmp[k] + tmpS[k] - tmpB[k];
      }
    },
  };
}
