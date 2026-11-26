/**
 * Two-body helpers for the planning aids: vector utilities, universal-variable
 * Kepler propagation (used to verify the Lambert solver and to coast a parking
 * orbit), and a few conversions.
 *
 * Planning code is advisory and not part of deterministic replay, so it uses
 * Math.* transcendental functions freely. Units: SI.
 */

export type Vec3 = [number, number, number];
export type ReadVec3 = ArrayLike<number>;

export const dot = (a: ReadVec3, b: ReadVec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a: ReadVec3): number => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
export const cross = (a: ReadVec3, b: ReadVec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const sub = (a: ReadVec3, b: ReadVec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: ReadVec3, b: ReadVec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: ReadVec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const unit = (a: ReadVec3): Vec3 => scale(a, 1 / norm(a));

/** Mean obliquity of the ecliptic at J2000 (IAU 2006), rad. */
export const OBLIQUITY_J2000 = (84381.406 / 3600) * (Math.PI / 180);
/** Ecliptic north pole expressed in ICRF axes: the reference normal for "prograde" heliocentric transfers. */
export const ECLIPTIC_POLE_ICRF: Vec3 = [0, -Math.sin(OBLIQUITY_J2000), Math.cos(OBLIQUITY_J2000)];

/** Stumpff functions C(z), S(z). */
export function stumpff(z: number): [number, number] {
  if (z > 1e-3) {
    const s = Math.sqrt(z);
    return [(1 - Math.cos(s)) / z, (s - Math.sin(s)) / (s * z)];
  }
  if (z < -1e-3) {
    const s = Math.sqrt(-z);
    return [(Math.cosh(s) - 1) / -z, (Math.sinh(s) - s) / (s * -z)];
  }
  // Series: C = 1/2 - z/24 + z^2/720 - z^3/40320, S = 1/6 - z/120 + z^2/5040 - z^3/362880.
  return [0.5 - z / 24 + (z * z) / 720 - (z * z * z) / 40320, 1 / 6 - z / 120 + (z * z) / 5040 - (z * z * z) / 362880];
}

/**
 * Propagate a two-body state by dt (any sign) with universal variables.
 * The time-of-flight function of chi is monotonic, so a bracketed Newton
 * iteration always converges.
 */
export function keplerPropagate(r0: ReadVec3, v0: ReadVec3, dt: number, mu: number): { r: Vec3; v: Vec3 } {
  if (dt === 0) return { r: [r0[0], r0[1], r0[2]], v: [v0[0], v0[1], v0[2]] };
  const sqmu = Math.sqrt(mu);
  const r0n = norm(r0);
  const vr0 = dot(r0, v0) / r0n;
  const alpha = 2 / r0n - dot(v0, v0) / mu;
  const sigma0 = r0n * vr0 / sqmu;
  const target = sqmu * dt;
  // F(chi) = sqrt(mu) * t(chi); dF/dchi = r(chi) > 0. Overflow (huge |chi| on a
  // hyperbola) is mapped to +-Infinity, which keeps the bracket logic valid.
  const F = (chi: number): [number, number] => {
    const z = alpha * chi * chi;
    const [C, S] = stumpff(z);
    let t = sigma0 * chi * chi * C + (1 - alpha * r0n) * chi * chi * chi * S + r0n * chi;
    const r = chi * chi * C + sigma0 * chi * (1 - z * S) + r0n * (1 - z * C);
    if (!Number.isFinite(t)) t = chi > 0 ? Infinity : -Infinity;
    return [t, r];
  };
  // Initial guess (Vallado, Algorithm 8).
  let chi: number;
  if (alpha > 1e-12 / r0n) {
    chi = sqmu * dt * alpha;
  } else if (alpha < -1e-12 / r0n) {
    const a = 1 / alpha;
    const sgn = Math.sign(dt);
    const arg = (-2 * mu * alpha * dt) / (dot(r0, v0) + sgn * Math.sqrt(-mu * a) * (1 - r0n * alpha));
    chi = arg > 0 ? sgn * Math.sqrt(-a) * Math.log(arg) : sgn * Math.sqrt(r0n);
  } else {
    chi = Math.sign(dt) * Math.sqrt(r0n);
  }
  if (!(Math.abs(chi) > 0) || !Number.isFinite(chi)) chi = Math.sign(dt) * 1e-3 * Math.sqrt(r0n);
  // Bracket [lo, hi] around the root, growing geometrically.
  let lo = Math.min(0, chi);
  let hi = Math.max(0, chi);
  let step = Math.abs(chi);
  for (let i = 0; i < 2000 && F(hi)[0] < target; i++) { lo = Math.max(lo, hi); hi += step; step *= 1.5; }
  step = Math.abs(chi);
  for (let i = 0; i < 2000 && F(lo)[0] > target; i++) { hi = Math.min(hi, lo); lo -= step; step *= 1.5; }
  chi = Math.min(Math.max(chi, lo), hi);
  for (let it = 0; it < 300; it++) {
    const [t, r] = F(chi);
    const f = t - target;
    if (f === 0) break;
    if (f > 0) hi = chi; else lo = chi;
    let next = chi - f / r;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    const done = Math.abs(next - chi) <= 4e-16 * Math.max(1e-300, Math.abs(chi));
    chi = next;
    if (done || hi - lo <= 4e-16 * Math.abs(chi)) break;
  }
  const z = alpha * chi * chi;
  const [C, S] = stumpff(z);
  const f = 1 - (chi * chi / r0n) * C;
  // g = dt - chi^3 S / sqrt(mu), rewritten without the cancellation that ruins
  // it on fast hyperbolas: sqrt(mu) g = sigma0 chi^2 C + r0 chi (1 - z S).
  const g = (sigma0 * chi * chi * C + r0n * chi * (1 - z * S)) / sqmu;
  const r: Vec3 = [f * r0[0] + g * v0[0], f * r0[1] + g * v0[1], f * r0[2] + g * v0[2]];
  const rn = norm(r);
  const fd = (sqmu / (rn * r0n)) * (alpha * chi * chi * chi * S - chi);
  const gd = 1 - (chi * chi / rn) * C;
  const v: Vec3 = [fd * r0[0] + gd * v0[0], fd * r0[1] + gd * v0[1], fd * r0[2] + gd * v0[2]];
  return { r, v };
}

/** Right ascension and declination (rad) of a direction in ICRF axes. RA in [0, 2pi). */
export function raDec(v: ReadVec3): { ra: number; dec: number } {
  let ra = Math.atan2(v[1], v[0]);
  if (ra < 0) ra += 2 * Math.PI;
  return { ra, dec: Math.asin(Math.max(-1, Math.min(1, v[2] / norm(v)))) };
}

/** Speed change to go from a circular orbit of radius rp to a hyperbola with excess speed vinf (periapsis burn). */
export function departureDv(vinf: number, mu: number, rp: number): number {
  return Math.sqrt(vinf * vinf + (2 * mu) / rp) - Math.sqrt(mu / rp);
}

/** Speed change at periapsis rp to capture from excess speed vinf into an orbit of eccentricity e (0 = circular). */
export function captureDv(vinf: number, mu: number, rp: number, e = 0): number {
  return Math.sqrt(vinf * vinf + (2 * mu) / rp) - Math.sqrt((mu * (1 + e)) / rp);
}
