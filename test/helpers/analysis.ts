/**
 * Test-only analysis helpers: an RK4 integrator with optional Sun-only first-order
 * post-Newtonian force (diagnostic, to attribute errors to GR) and osculating elements.
 * Not under src/physics, so it may use any Math function.
 */
import { accelerations } from '../../src/physics/nbody';

export const C_LIGHT = 299792458;

/**
 * Integrate with Newtonian N-body + Sun-only 1PN (Schwarzschild field, PPN
 * beta=gamma=1, IERS Conventions 2010 eq. 10.12) on every other body:
 *   a = mu/(c^2 r^3) [ (4 mu/r - v^2) r + 4 (r.v) v ],
 * with the reaction applied to the Sun so momentum is conserved to O(m/M).
 * The force is velocity dependent, so a splitting method would lose its order;
 * this diagnostic uses classical RK4 with a small step instead (h = 0.05 d gives
 * < 1 km Moon error per century, far below the effects being diagnosed).
 * Set `pn` false to run the same RK4 Newtonian, as a control.
 */
export function integrateRK4(
  gm: ArrayLike<number>,
  state: ArrayLike<number>,
  h: number,
  steps: number,
  pn = true,
  sun = 0,
  /** Optional zonal J2 of one body acting on another (pole along ICRF z). */
  j2?: { body: number; on: number; j2: number; radius: number },
): Float64Array {
  const n = gm.length;
  const m = 3 * n;
  const mu = gm[sun];
  const c2 = C_LIGHT * C_LIGHT;
  const acc = new Float64Array(m);
  const deriv = (y: Float64Array, out: Float64Array) => {
    const q = y.subarray(0, m);
    const v = y.subarray(m);
    accelerations(n, gm, q, acc);
    if (pn) {
      for (let i = 0; i < n; i++) {
        if (i === sun) continue;
        const rx = q[3 * i] - q[3 * sun], ry = q[3 * i + 1] - q[3 * sun + 1], rz = q[3 * i + 2] - q[3 * sun + 2];
        const vx = v[3 * i] - v[3 * sun], vy = v[3 * i + 1] - v[3 * sun + 1], vz = v[3 * i + 2] - v[3 * sun + 2];
        const r = Math.hypot(rx, ry, rz);
        const v2 = vx * vx + vy * vy + vz * vz;
        const rv = rx * vx + ry * vy + rz * vz;
        const f = mu / (c2 * r * r * r);
        const c1 = f * (4 * mu / r - v2);
        const cv = f * 4 * rv;
        const ax = c1 * rx + cv * vx, ay = c1 * ry + cv * vy, az = c1 * rz + cv * vz;
        acc[3 * i] += ax; acc[3 * i + 1] += ay; acc[3 * i + 2] += az;
        const back = gm[i] / mu;
        acc[3 * sun] -= back * ax; acc[3 * sun + 1] -= back * ay; acc[3 * sun + 2] -= back * az;
      }
    }
    if (j2) {
      const { body: e, on: o } = j2;
      const x = q[3 * o] - q[3 * e], yy = q[3 * o + 1] - q[3 * e + 1], z = q[3 * o + 2] - q[3 * e + 2];
      const r2 = x * x + yy * yy + z * z;
      const r = Math.sqrt(r2);
      const k = (-1.5 * j2.j2 * gm[e] * j2.radius * j2.radius) / (r2 * r2 * r);
      const zz = (5 * z * z) / r2;
      const ax = k * (1 - zz) * x, ay = k * (1 - zz) * yy, az = k * (3 - zz) * z;
      acc[3 * o] += ax; acc[3 * o + 1] += ay; acc[3 * o + 2] += az;
      const back = gm[o] / gm[e];
      acc[3 * e] -= back * ax; acc[3 * e + 1] -= back * ay; acc[3 * e + 2] -= back * az;
    }
    out.set(v, 0);
    out.set(acc, m);
  };
  const y = new Float64Array(2 * m);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      y[3 * i + k] = state[6 * i + k];
      y[m + 3 * i + k] = state[6 * i + 3 + k];
    }
  const k1 = new Float64Array(2 * m), k2 = new Float64Array(2 * m), k3 = new Float64Array(2 * m), k4 = new Float64Array(2 * m);
  const tmp = new Float64Array(2 * m);
  for (let s = 0; s < steps; s++) {
    deriv(y, k1);
    for (let k = 0; k < 2 * m; k++) tmp[k] = y[k] + 0.5 * h * k1[k];
    deriv(tmp, k2);
    for (let k = 0; k < 2 * m; k++) tmp[k] = y[k] + 0.5 * h * k2[k];
    deriv(tmp, k3);
    for (let k = 0; k < 2 * m; k++) tmp[k] = y[k] + h * k3[k];
    deriv(tmp, k4);
    for (let k = 0; k < 2 * m; k++) y[k] += (h / 6) * (k1[k] + 2 * k2[k] + 2 * k3[k] + k4[k]);
  }
  const out = new Float64Array(6 * n);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      out[6 * i + k] = y[3 * i + k];
      out[6 * i + 3 + k] = y[m + 3 * i + k];
    }
  return out;
}

export type Vec3 = [number, number, number];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** Relative position/velocity of body i w.r.t. body j. */
export function relative(state: ArrayLike<number>, i: number, j: number): { r: Vec3; v: Vec3 } {
  const r: Vec3 = [0, 0, 0];
  const v: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    r[k] = state[6 * i + k] - state[6 * j + k];
    v[k] = state[6 * i + 3 + k] - state[6 * j + 3 + k];
  }
  return { r, v };
}

/**
 * Eccentricity vector and angular-momentum unit vector for a two-body orbit.
 * The angle between two eccentricity vectors (projected onto the orbit plane)
 * is the perihelion rotation.
 */
export function eccVector(r: Vec3, v: Vec3, mu: number): { e: Vec3; hHat: Vec3 } {
  const hv = cross(r, v);
  const vxh = cross(v, hv);
  const rn = norm(r);
  const e: Vec3 = [vxh[0] / mu - r[0] / rn, vxh[1] / mu - r[1] / rn, vxh[2] / mu - r[2] / rn];
  const hn = norm(hv);
  return { e, hHat: [hv[0] / hn, hv[1] / hn, hv[2] / hn] };
}

/** Signed angle from a to b about axis n, radians. */
export function signedAngle(a: Vec3, b: Vec3, n: Vec3): number {
  return Math.atan2(dot(cross(a, b), n), dot(a, b));
}

/** Decompose error vector d at (r, v) into radial, along-track, cross-track components. */
export function rtn(d: Vec3, r: Vec3, v: Vec3): { radial: number; along: number; cross: number } {
  const rh = r.map((x) => x / norm(r)) as Vec3;
  const nh0 = cross(r, v);
  const nh = nh0.map((x) => x / norm(nh0)) as Vec3;
  const th = cross(nh, rh);
  return { radial: dot(d, rh), along: dot(d, th), cross: dot(d, nh) };
}

export const RAD_TO_ARCSEC = (180 / Math.PI) * 3600;
