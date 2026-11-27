/**
 * Osculating orbital elements of a state about a body (pure; display maths,
 * ordinary Math). The simulation is N-body: there is no single conic. These
 * are the two-body orbit that matches the instantaneous position and velocity
 * relative to the chosen body; they drift as other bodies and the body's
 * oblateness act.
 *
 * Angles are measured in a reference plane given by its basis: `z` the plane
 * normal (a body's pole, the ecliptic pole, a target's orbit normal), `x` the
 * reference direction in the plane (the node of that plane on the ICRF
 * equator, or ICRF x when the plane is the ICRF equator). Ill-defined angles
 * are null with a reason instead of a jittering number:
 *  - near-circular (e < 1e-5): no periapsis direction, so no argument of
 *    periapsis (true anomaly is then measured from the node: argument of
 *    latitude, or the true longitude for an equatorial one);
 *  - near-equatorial (i < 0.001° or > 179.999°): no node, so no longitude of
 *    the ascending node and no node passage times.
 */

export type V3 = [number, number, number];

export interface PlaneBasis { x: V3; y: V3; z: V3 }

export interface OrbitState {
  /** Distance from the body's centre, m; radial and total speed relative to it, m/s. */
  r: number;
  speed: number;
  vr: number;
  /** Flight-path angle above the local horizontal, deg. */
  fpaDeg: number;
  /** Specific orbital energy, J/kg; a < 0 for a hyperbola. */
  energy: number;
  a: number;
  e: number;
  /** Periapsis and apoapsis distance from the centre, m (apoapsis Infinity when unbound). */
  rp: number;
  ra: number;
  incDeg: number;
  /** Null when ill-defined (see header), with `degenerate` saying why. */
  raanDeg: number | null;
  argPeDeg: number | null;
  /** True anomaly (or the argument of latitude / true longitude when argPe is undefined), deg 0..360. */
  trueAnomalyDeg: number;
  anomalyKind: 'true anomaly' | 'argument of latitude' | 'true longitude';
  degenerate: string[];
  bound: boolean;
  /** Bound: period, s; time to the next periapsis and apoapsis, s. */
  period: number;
  toPeriapsis: number;
  toApoapsis: number;
  /** Time to the next ascending / descending node (two-body), s; NaN when undefined or never. */
  toAscending: number;
  toDescending: number;
  /** Unbound: hyperbolic excess speed (m/s), C3 (km²/s²), outgoing asymptote (right ascension and declination in the plane basis, deg). */
  vInf: number;
  c3: number;
  asymptote: { lonDeg: number; latDeg: number } | null;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const DEG = 180 / Math.PI;
const wrap360 = (d: number) => ((d % 360) + 360) % 360;

/** Basis of the plane with normal `n` (unit), reference direction its node on the ICRF equator. */
export function planeBasis(n: readonly number[]): PlaneBasis {
  const z: V3 = [n[0], n[1], n[2]];
  const zn = norm(z);
  z[0] /= zn; z[1] /= zn; z[2] /= zn;
  let x = cross([0, 0, 1], z);
  if (norm(x) < 1e-9) x = [1, 0, 0];
  else { const k = norm(x); x = [x[0] / k, x[1] / k, x[2] / k]; }
  return { x, y: cross(z, x), z };
}

/** Ecliptic pole (J2000 obliquity) in ICRF. */
export const ECLIPTIC_POLE: V3 = [0, -Math.sin(23.4392911 / DEG), Math.cos(23.4392911 / DEG)];

/** Time from true anomaly nu0 to nu1 (forward, the next passage) on a bound orbit. */
function timeBetween(nu0: number, nu1: number, e: number, n: number): number {
  const M = (nu: number) => {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    return E - e * Math.sin(E);
  };
  let dM = M(nu1) - M(nu0);
  dM = ((dM % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return dM / n;
}

/** Time from nu0 to nu1 on a hyperbola (NaN if nu1 is behind or outside the asymptotes). */
function hypTime(nu0: number, nu1: number, e: number, a: number, mu: number): number {
  const lim = Math.acos(-1 / e);
  const w = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
  const n0 = w(nu0), n1 = w(nu1);
  if (Math.abs(n1) >= lim) return NaN;
  const N = (nu: number) => {
    const F = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
    return e * Math.sinh(F) - F;
  };
  const dt = (N(n1) - N(n0)) * Math.sqrt((-a) ** 3 / mu);
  return dt > 0 ? dt : NaN;
}

/** Osculating elements of `s` = [x y z vx vy vz] relative to a body of GM `mu`, angles in `basis`. */
export function osculating(mu: number, s: readonly number[], basis: PlaneBasis): OrbitState {
  const rv: V3 = [s[0], s[1], s[2]];
  const vv: V3 = [s[3], s[4], s[5]];
  const r = norm(rv);
  const v = norm(vv);
  const vr = dot(rv, vv) / r;
  const h = cross(rv, vv);
  const hn = norm(h);
  const energy = (v * v) / 2 - mu / r;
  const ev: V3 = [0, 1, 2].map((k) => ((v * v - mu / r) * rv[k] - r * vr * vv[k]) / mu) as V3;
  const e = norm(ev);
  const a = -mu / (2 * energy);
  const p = (hn * hn) / mu;
  const rp = p / (1 + e);
  const bound = energy < 0 && e < 1;
  const ra = bound ? p / (1 - e) : Infinity;
  // Plane components.
  const hz = dot(h, basis.z) / hn;
  const incDeg = Math.acos(Math.max(-1, Math.min(1, hz))) * DEG;
  const degenerate: string[] = [];
  const equatorial = incDeg < 1e-3 || incDeg > 180 - 1e-3;
  const circular = e < 1e-5;
  // Node vector in the plane: z × h.
  const nodeV = cross(basis.z, h);
  const nx = dot(nodeV, basis.x), ny = dot(nodeV, basis.y);
  const raanDeg = equatorial ? null : wrap360(Math.atan2(ny, nx) * DEG);
  if (equatorial) degenerate.push('equatorial: the ascending node is undefined');
  if (circular) degenerate.push('circular: the periapsis direction is undefined');
  const ref: V3 = equatorial ? basis.x : (() => { const k = norm(nodeV); return [nodeV[0] / k, nodeV[1] / k, nodeV[2] / k] as V3; })();
  const hu: V3 = [h[0] / hn, h[1] / hn, h[2] / hn];
  const ang = (from: V3, to: V3) => wrap360(Math.atan2(dot(cross(from, to), hu), dot(from, to)) * DEG);
  const ru: V3 = [rv[0] / r, rv[1] / r, rv[2] / r];
  let argPeDeg: number | null = null;
  let trueAnomalyDeg: number;
  let anomalyKind: OrbitState['anomalyKind'] = 'true anomaly';
  if (circular) {
    trueAnomalyDeg = ang(ref, ru);
    anomalyKind = equatorial ? 'true longitude' : 'argument of latitude';
  } else {
    const eu: V3 = [ev[0] / e, ev[1] / e, ev[2] / e];
    argPeDeg = ang(ref, eu);
    trueAnomalyDeg = ang(eu, ru);
  }
  const nu = trueAnomalyDeg / DEG;
  let period = NaN, toPeriapsis = NaN, toApoapsis = NaN, toAscending = NaN, toDescending = NaN;
  // True anomaly of the nodes (argument of latitude 0 / 180 minus argPe).
  const uNow = circular ? nu : nu + (argPeDeg ?? 0) / DEG;
  const nuAt = (u: number) => nu + (u - uNow);
  if (bound) {
    const n = Math.sqrt(mu / a ** 3);
    period = (2 * Math.PI) / n;
    if (circular) {
      if (!equatorial) { toAscending = (((0 - uNow) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / n; toDescending = (((Math.PI - uNow) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / n; }
    } else {
      toPeriapsis = timeBetween(nu, 2 * Math.PI, e, n) || period;
      toApoapsis = timeBetween(nu, Math.PI, e, n);
      if (!equatorial) { toAscending = timeBetween(nu, nuAt(2 * Math.PI), e, n); toDescending = timeBetween(nu, nuAt(Math.PI), e, n); }
    }
  } else if (!circular) {
    toPeriapsis = vr < 0 ? hypTime(nu, 0, e, a, mu) : NaN;
    if (!equatorial) { toAscending = hypTime(nu, nuAt(2 * Math.PI), e, a, mu); toDescending = hypTime(nu, nuAt(Math.PI), e, a, mu); }
  }
  // Hyperbolic excess and the outgoing asymptote.
  let vInf = NaN, c3 = NaN;
  let asymptote: OrbitState['asymptote'] = null;
  if (!bound) {
    c3 = (2 * energy) / 1e6;
    vInf = energy > 0 ? Math.sqrt(2 * energy) : 0;
    if (e > 1) {
      const lim = Math.acos(-1 / e);
      const eu: V3 = [ev[0] / e, ev[1] / e, ev[2] / e];
      const q = cross(hu, eu);
      const d: V3 = [0, 1, 2].map((k) => Math.cos(lim) * eu[k] + Math.sin(lim) * q[k]) as V3;
      asymptote = { lonDeg: wrap360(Math.atan2(dot(d, basis.y), dot(d, basis.x)) * DEG), latDeg: Math.asin(Math.max(-1, Math.min(1, dot(d, basis.z)))) * DEG };
    }
  }
  const fpaDeg = Math.atan2(vr, hn / r) * DEG;
  return { r, speed: v, vr, fpaDeg, energy, a, e, rp, ra, incDeg, raanDeg, argPeDeg, trueAnomalyDeg, anomalyKind, degenerate, bound, period, toPeriapsis, toApoapsis, toAscending, toDescending, vInf, c3, asymptote };
}

/** Latitude and longitude (deg, east positive) of a body-relative ICRF position given the body-fixed -> ICRF matrix (row-major 3x3). */
export function latLon(rel: readonly number[], m: ArrayLike<number>): { latDeg: number; lonDeg: number } {
  // ICRF -> body-fixed: transpose.
  const x = m[0] * rel[0] + m[3] * rel[1] + m[6] * rel[2];
  const y = m[1] * rel[0] + m[4] * rel[1] + m[7] * rel[2];
  const z = m[2] * rel[0] + m[5] * rel[1] + m[8] * rel[2];
  const lon = Math.atan2(y, x) * DEG;
  return { latDeg: Math.atan2(z, Math.hypot(x, y)) * DEG, lonDeg: lon > 180 ? lon - 360 : lon };
}
