/**
 * Lambert's problem: the conic arc from r1 to r2 in time tof about a body of
 * gravitational parameter mu.
 *
 * Algorithm: D. Izzo, "Revisiting Lambert's problem", Celestial Mechanics and
 * Dynamical Astronomy 121 (2015) 1-15, as in ESA's pykep (lambert_problem.cpp):
 * one universal non-dimensional variable x, Lancaster-Blanchard time of flight
 * with Battin's hypergeometric series near x = 1 and Lagrange's form close to
 * it, Householder (third-order) iterations from Izzo's initial guesses, and
 * Halley's method for the minimum-time point that decides whether an N-rev
 * solution exists. Differences from pykep:
 *  - tighter convergence (|dx| < 1e-13 instead of 1e-5 / 1e-8) and a guard
 *    keeping x inside its domain;
 *  - "prograde" is decided against a caller-supplied reference normal instead
 *    of the frame's +z (default: the ecliptic pole in ICRF axes, so planetary
 *    transfers in the ICRF frame are prograde in the usual sense);
 *  - an exactly 0/180 degree transfer (r1 parallel to r2), where the plane is
 *    undefined, is solved in the plane containing r1 and the reference normal.
 *
 * Solutions are written to a caller buffer (6 numbers each: v1, v2), in the
 * order N = 0, then for N = 1..Nmax the two branches ("left" x_l, then "right"
 * x_r, Izzo's naming). Advisory planning code: Math transcendental functions
 * are allowed.
 */
import { ECLIPTIC_POLE_ICRF, type ReadVec3, type Vec3 } from './kepler';

export interface LambertOptions {
  /** Retrograde (clockwise about refNormal) instead of prograde. */
  retrograde?: boolean;
  /** Largest number of complete revolutions to consider. Default 0. */
  maxRevs?: number;
  /** Normal defining "prograde". Default: ecliptic pole in ICRF axes. */
  refNormal?: ReadVec3;
}

export interface LambertSolution {
  v1: Vec3;
  v2: Vec3;
  /** Complete revolutions. */
  revs: number;
  /** 'zero' for N = 0; 'left' / 'right' are Izzo's two N-rev branches. */
  branch: 'zero' | 'left' | 'right';
  /** Izzo's x (x < 1 elliptic, x = 1 parabolic, x > 1 hyperbolic). */
  x: number;
  iterations: number;
}

const PI = Math.PI;
const TOL = 1e-13;
const MAX_IT = 40;

/** Solver state shared by the helpers (one solve at a time; not re-entrant). */
let lambda = 0;
let lambda2 = 0;
let lambda3 = 0;
let lastIterations = 0;

function hypergeometricF(z: number): number {
  let Sj = 1;
  let Cj = 1;
  for (let j = 0; j < 200; j++) {
    const Cj1 = (Cj * (3 + j) * (1 + j)) / (2.5 + j) * (z / (j + 1));
    Sj += Cj1;
    Cj = Cj1;
    if (Math.abs(Cj1) < 1e-15) break;
  }
  return Sj;
}

function x2tofLagrange(x: number, N: number): number {
  const a = 1 / (1 - x * x);
  if (a > 0) {
    const alfa = 2 * Math.acos(x);
    let beta = 2 * Math.asin(Math.sqrt(lambda2 / a));
    if (lambda < 0) beta = -beta;
    return (a * Math.sqrt(a) * (alfa - Math.sin(alfa) - (beta - Math.sin(beta)) + 2 * PI * N)) / 2;
  }
  const alfa = 2 * Math.acosh(x);
  let beta = 2 * Math.asinh(Math.sqrt(-lambda2 / a));
  if (lambda < 0) beta = -beta;
  return (-a * Math.sqrt(-a) * (beta - Math.sinh(beta) - (alfa - Math.sinh(alfa)))) / 2;
}

/** Non-dimensional time of flight T(x) for N revolutions. */
function x2tof(x: number, N: number): number {
  const battin = 0.01;
  const lagrange = 0.2;
  const dist = Math.abs(x - 1);
  if (dist < lagrange && dist > battin) return x2tofLagrange(x, N);
  const E = x * x - 1;
  const rho = Math.abs(E);
  const z = Math.sqrt(1 + lambda2 * E);
  if (dist < battin) {
    const eta = z - lambda * x;
    const S1 = 0.5 * (1 - lambda - x * eta);
    const Q = (4 / 3) * hypergeometricF(S1);
    return (eta * eta * eta * Q + 4 * lambda * eta) / 2 + (N * PI) / Math.pow(rho, 1.5);
  }
  const y = Math.sqrt(rho);
  const g = x * z - lambda * E;
  let d: number;
  if (E < 0) {
    d = N * PI + Math.acos(Math.max(-1, Math.min(1, g)));
  } else {
    const f = y * (z - lambda * x);
    d = Math.log(f + g);
  }
  return (x - lambda * z - d / y) / E;
}

/** dT/dx, d2T/dx2, d3T/dx3 at x where T = T(x). */
function dTdx(x: number, T: number, out: Float64Array): void {
  const umx2 = 1 - x * x;
  const y = Math.sqrt(1 - lambda2 * umx2);
  const y2 = y * y;
  const y3 = y2 * y;
  const d1 = (3 * T * x - 2 + (2 * lambda3 * x) / y) / umx2;
  const d2 = (3 * T + 5 * x * d1 + (2 * (1 - lambda2) * lambda3) / y3) / umx2;
  const d3 = (7 * x * d2 + 8 * d1 - (6 * (1 - lambda2) * lambda2 * lambda3 * x) / y3 / y2) / umx2;
  out[0] = d1;
  out[1] = d2;
  out[2] = d3;
}

const dbuf = new Float64Array(3);

/** Householder iterations for T(x) = T. Returns x, or NaN on failure. */
function householder(T: number, x0: number, N: number): number {
  let x = x0;
  for (let it = 1; it <= MAX_IT; it++) {
    const tof = x2tof(x, N);
    dTdx(x, tof, dbuf);
    const [d1, d2, d3] = dbuf;
    const delta = tof - T;
    const d12 = d1 * d1;
    let xn = x - (delta * (d12 - (delta * d2) / 2)) / (d1 * (d12 - delta * d2) + (d3 * delta * delta) / 6);
    // Keep x in its domain: (-1, 1) for N > 0, (-1, inf) for N = 0.
    if (!(xn > -1)) xn = (x - 1) / 2;
    if (N > 0 && !(xn < 1)) xn = (x + 1) / 2;
    if (!Number.isFinite(xn)) return NaN;
    const err = Math.abs(x - xn);
    x = xn;
    if (err < TOL * Math.max(1, Math.abs(x))) {
      lastIterations = it;
      return x;
    }
  }
  lastIterations = MAX_IT;
  // Accept if the residual is tiny even though steps kept dithering at roundoff.
  return Math.abs(x2tof(x, N) - T) < 1e-10 * Math.max(1, T) ? x : NaN;
}

/**
 * Solve Lambert's problem into `out` (6 numbers per solution: v1 then v2; it
 * needs 6*(1 + 2*maxRevs) entries). Writes x per solution to `xs` if given.
 * Returns the number of solutions written; solution 0 is the zero-revolution
 * one, then pairs (left, right) for N = 1, 2, ... Returns 0 when the inputs
 * are invalid or the zero-rev iteration fails.
 */
export function lambertInto(
  r1x: number, r1y: number, r1z: number,
  r2x: number, r2y: number, r2z: number,
  tof: number, mu: number,
  out: Float64Array,
  retrograde = false,
  maxRevs = 0,
  refNormal: ReadVec3 = ECLIPTIC_POLE_ICRF,
  xs?: Float64Array,
): number {
  if (!(tof > 0) || !(mu > 0)) return 0;
  if (meta.length < 3 * (1 + 2 * maxRevs)) meta = new Float64Array(3 * (1 + 2 * maxRevs));
  const cx = r2x - r1x;
  const cy = r2y - r1y;
  const cz = r2z - r1z;
  const c = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const r1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z);
  const r2 = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z);
  if (!(r1 > 0) || !(r2 > 0)) return 0;
  const s = (r1 + r2 + c) / 2;
  const i1x = r1x / r1, i1y = r1y / r1, i1z = r1z / r1;
  const i2x = r2x / r2, i2y = r2y / r2, i2z = r2z / r2;
  let hx = i1y * i2z - i1z * i2y;
  let hy = i1z * i2x - i1x * i2z;
  let hz = i1x * i2y - i1y * i2x;
  let hn = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const nx = refNormal[0], ny = refNormal[1], nz = refNormal[2];
  if (hn < 1e-12) {
    // r1 parallel to r2: use the plane containing r1 and the reference normal.
    const k = nx * i1x + ny * i1y + nz * i1z;
    hx = nx - k * i1x; hy = ny - k * i1y; hz = nz - k * i1z;
    hn = Math.sqrt(hx * hx + hy * hy + hz * hz);
    if (hn < 1e-12) {
      // Reference normal along r1 too: any perpendicular.
      const ax = Math.abs(i1x) < 0.9 ? 1 : 0;
      const ay = 1 - ax;
      hx = ay * i1z; hy = -ax * i1z; hz = ax * i1y - ay * i1x;
      hn = Math.sqrt(hx * hx + hy * hy + hz * hz);
    }
  }
  hx /= hn; hy /= hn; hz /= hn;
  // lambda = sqrt(1 - c/s) = sqrt(r1 r2) cos(theta/2) / s. The second form, with
  // cos(theta/2) = |i1 + i2| / 2, keeps full absolute precision near 180 deg,
  // where 1 - c/s cancels catastrophically.
  const ux = i1x + i2x, uy = i1y + i2y, uz = i1z + i2z;
  let lam = Math.min(1, (Math.sqrt(r1 * r2) * 0.5 * Math.sqrt(ux * ux + uy * uy + uz * uz)) / s);
  let t1x: number, t1y: number, t1z: number, t2x: number, t2y: number, t2z: number;
  if (hx * nx + hy * ny + hz * nz < 0) {
    // Short-way plane normal points against the reference: transfer > 180 deg.
    lam = -lam;
    t1x = i1y * hz - i1z * hy; t1y = i1z * hx - i1x * hz; t1z = i1x * hy - i1y * hx;
    t2x = i2y * hz - i2z * hy; t2y = i2z * hx - i2x * hz; t2z = i2x * hy - i2y * hx;
  } else {
    t1x = hy * i1z - hz * i1y; t1y = hz * i1x - hx * i1z; t1z = hx * i1y - hy * i1x;
    t2x = hy * i2z - hz * i2y; t2y = hz * i2x - hx * i2z; t2z = hx * i2y - hy * i2x;
  }
  if (retrograde) {
    lam = -lam;
    t1x = -t1x; t1y = -t1y; t1z = -t1z;
    t2x = -t2x; t2y = -t2y; t2z = -t2z;
  }
  lambda = lam;
  lambda2 = lam * lam;
  lambda3 = lambda2 * lam;
  const T = Math.sqrt((2 * mu) / (s * s * s)) * tof;

  // Largest N with a solution.
  let Nmax = Math.min(Math.floor(T / PI), Math.max(0, Math.floor(maxRevs)));
  const T00 = Math.acos(lam) + lam * Math.sqrt(1 - lambda2);
  const T0 = T00 + Nmax * PI;
  const T1 = (2 / 3) * (1 - lambda3);
  if (Nmax > 0 && T < T0) {
    // Halley iterations for the minimum T of the Nmax-rev curve.
    let xOld = 0;
    let Tmin = T0;
    for (let it = 0; it < 30; it++) {
      dTdx(xOld, Tmin, dbuf);
      const [d1, d2, d3] = dbuf;
      if (d1 === 0) break;
      const xNew = xOld - (d1 * d2) / (d2 * d2 - (d1 * d3) / 2);
      if (!(xNew > -1 && xNew < 1)) break;
      const err = Math.abs(xOld - xNew);
      Tmin = x2tof(xNew, Nmax);
      xOld = xNew;
      if (err < 1e-13) break;
    }
    if (Tmin > T) Nmax -= 1;
  }

  // Zero-rev initial guess (Izzo 2015, as in pykep).
  let x0: number;
  if (T >= T00) x0 = -(T - T00) / (T - T00 + 4);
  else if (T <= T1) x0 = (T1 * (T1 - T)) / ((2 / 5) * (1 - lambda2 * lambda3) * T) + 1;
  else x0 = Math.pow(T / T00, 0.6931471805599453 / Math.log(T1 / T00)) - 1;
  const xsol: number[] = [householder(T, x0, 0)];
  const its: number[] = [lastIterations];
  if (!Number.isFinite(xsol[0])) return 0;
  for (let i = 1; i <= Nmax; i++) {
    let tmp = Math.pow((i * PI + PI) / (8 * T), 2 / 3);
    xsol.push(householder(T, (tmp - 1) / (tmp + 1), i));
    its.push(lastIterations);
    tmp = Math.pow((8 * T) / (i * PI), 2 / 3);
    xsol.push(householder(T, (tmp - 1) / (tmp + 1), i));
    its.push(lastIterations);
  }

  // Velocities.
  const gamma = Math.sqrt((mu * s) / 2);
  const rho = (r1 - r2) / c;
  const sigma = Math.sqrt(Math.max(0, 1 - rho * rho));
  let n = 0;
  for (let k = 0; k < xsol.length; k++) {
    const x = xsol[k];
    if (!Number.isFinite(x)) {
      lambertStats.branchFailures++; // a failed N-rev branch is skipped
      continue;
    }
    const y = Math.sqrt(1 - lambda2 + lambda2 * x * x);
    const ly = lam * y;
    const vr1 = (gamma * (ly - x - rho * (ly + x))) / r1;
    const vr2 = (-gamma * (ly - x + rho * (ly + x))) / r2;
    const vt = gamma * sigma * (y + lam * x);
    const vt1 = vt / r1;
    const vt2 = vt / r2;
    const o = 6 * n;
    out[o] = vr1 * i1x + vt1 * t1x;
    out[o + 1] = vr1 * i1y + vt1 * t1y;
    out[o + 2] = vr1 * i1z + vt1 * t1z;
    out[o + 3] = vr2 * i2x + vt2 * t2x;
    out[o + 4] = vr2 * i2y + vt2 * t2y;
    out[o + 5] = vr2 * i2z + vt2 * t2z;
    if (xs) xs[n] = x;
    // Encode (revs, branch, iterations) for the object wrapper.
    meta[3 * n] = k === 0 ? 0 : Math.ceil(k / 2);
    meta[3 * n + 1] = k === 0 ? 0 : k % 2 === 1 ? 1 : 2;
    meta[3 * n + 2] = its[k];
    n++;
  }
  return n;
}

let meta = new Float64Array(3 * 64);

/** Diagnostic counters (tests): N-rev branches whose iteration did not converge. */
export const lambertStats = { branchFailures: 0 };

/** Allocating convenience wrapper around `lambertInto`. */
export function solveLambert(r1: ReadVec3, r2: ReadVec3, tof: number, mu: number, opts: LambertOptions = {}): LambertSolution[] {
  const maxRevs = Math.max(0, Math.floor(opts.maxRevs ?? 0));
  const cap = 1 + 2 * maxRevs;
  const buf = new Float64Array(6 * cap);
  const xs = new Float64Array(cap);
  if (meta.length < 3 * cap) meta = new Float64Array(3 * cap);
  const n = lambertInto(r1[0], r1[1], r1[2], r2[0], r2[1], r2[2], tof, mu, buf, opts.retrograde ?? false, maxRevs, opts.refNormal ?? ECLIPTIC_POLE_ICRF, xs);
  const sols: LambertSolution[] = [];
  for (let i = 0; i < n; i++) {
    const o = 6 * i;
    const b = meta[3 * i + 1];
    sols.push({
      v1: [buf[o], buf[o + 1], buf[o + 2]],
      v2: [buf[o + 3], buf[o + 4], buf[o + 5]],
      revs: meta[3 * i],
      branch: b === 0 ? 'zero' : b === 1 ? 'left' : 'right',
      x: xs[i],
      iterations: meta[3 * i + 2],
    });
  }
  return sols;
}
