/**
 * Fixed-step, time-reversible, 8th-order N-body integrator for the massive
 * bodies. Units are SI; time is seconds TDB from the J2000 epoch.
 *
 * PHYSICS: Newtonian point masses, plus (optional, see NBodyPhysics)
 *  - zonal J2 of selected bodies acting on selected others, with the equal and
 *    opposite reaction (positions only: the scheme stays symplectic);
 *  - the Sun's first post-Newtonian (Schwarzschild, PPN beta=gamma=1) term on
 *    every other body, with the reaction on the Sun (velocity dependent: see
 *    "RELATIVITY" below).
 *
 * SCHEME: Kahan & Li (1997) 8th-order symmetric composition of the Störmer-Verlet
 * leapfrog, 17 stages ("s17odr8a"). W. Kahan, R.-C. Li, "Composition constants
 * for raising the orders of unconventional schemes for ordinary differential
 * equations", Math. Comp. 66 (1997) 1089-1099; also listed in Hairer, Lubich &
 * Wanner, Geometric Numerical Integration, 2nd ed., sec. V.3.2. Coefficients
 * cross-checked against SciML OrdinaryDiffEq.jl (symplectic_tableaus.jl,
 * KahanLi8). The order is proven by test/nbody-convergence.test.ts.
 *
 * Why this scheme:
 *  - symplectic and symmetric, so it is time-reversible: stepping with -h undoes
 *    a step with +h up to roundoff, and energy error stays bounded (no drift);
 *  - self-starting one-step method: any stored state can be resumed in either
 *    direction with no history. Principia's symmetric multistep needs a startup
 *    history and is reversible only with that history, which complicates
 *    "start at any date, extend on demand in a worker";
 *  - order 8 lets the Moon (27 d period) be integrated with a step of hours.
 *    17 force evaluations per step (first-same-as-last).
 *
 * ROUNDOFF: positions and velocities are carried with Kahan compensated
 * summation (a second array holds the lost low-order bits), so the ~10^6 tiny
 * increments of a century-long run do not accumulate rounding error.
 *
 * RELATIVITY: the 1PN force depends on velocity, so it cannot go into a plain
 * kick (doing so measured first-order, 4e5 km error on Mercury per century).
 * Instead the same Kahan-Li composition is applied to the symmetric
 * second-order generalized Stormer-Verlet base method (Hairer, Lubich & Wanner,
 * GNI, sec. VI.3, eq. 3.4, for a velocity-dependent force a(q, v)):
 *   v' = v + tau/2 a(q, v')        (implicit in v')
 *   q1 = q + tau v'
 *   v1 = v' + tau/2 a(q1, v')      (explicit)
 * Running it with -tau from (q1, v1) returns (q, v) exactly, so the base method
 * is symmetric, and composition with symmetric weights gives a symmetric,
 * time-reversible 8th-order method (composition theory needs only a symmetric
 * base). It is no longer symplectic: the 1PN system is not canonical in these
 * variables. The implicit step is a fixed-point iteration with a FIXED count
 * (PN_ITERATIONS): the contraction factor is tau*|da_PN/dv| ~ 1e-9, so two
 * iterations converge far below roundoff and the result is bit-reproducible.
 * With no relativity configured, the original merged-kick code path runs and
 * results are unchanged bit for bit.
 *
 * DETERMINISM: exactly-defined operations only (+ - * /, Math.sqrt, abs,
 * min/max, floor, comparisons). No transcendental functions (pow, exp, log,
 * trig): their results differ between JS engines.
 */

/** Speed of light, m/s (exact, SI definition). */
export const C_LIGHT = 299792458;
const C2 = C_LIGHT * C_LIGHT;
/** Fixed-point iterations for the implicit half-kick. Fixed for reproducibility. */
export const PN_ITERATIONS = 2;

/** Zonal J2 of `body`, acting on each body in `targets` (and the reaction on `body`). */
export interface ZonalHarmonic {
  body: number;
  /** Unnormalized J2 (dimensionless), referred to `radius`. */
  j2: number;
  /** Reference (equatorial) radius, m. */
  radius: number;
  /** Unit vector along the body's spin axis, in the integration frame (ICRF). */
  pole: readonly [number, number, number];
  targets: readonly number[];
}

export interface NBodyPhysics {
  zonal?: readonly ZonalHarmonic[];
  /** Index of the Sun: apply its 1PN (Schwarzschild) term to every other body. */
  relativity?: { sun: number };
}

/** Drift weights a_1..a_17 (each a full leapfrog sub-step of size a_i*h). */
const A_HALF = [
  0.13020248308889008087881763, 0.56116298177510838456196441, -0.3894749626448472864080786,
  0.15884190655515560089621075, -0.39590389413323757733623154, 0.18453964097831570709183254,
  0.25837438768632204729397911, 0.29501172360931029887096624, -0.60550853383003451169892108,
];

function buildCoefficients(): { a: Float64Array; b: Float64Array } {
  const w: number[] = [];
  for (let i = 0; i < 9; i++) w.push(A_HALF[i]);
  for (let i = 7; i >= 0; i--) w.push(A_HALF[i]);
  const n = w.length; // 17
  const a = Float64Array.from(w);
  // Kick weights: b_1 = w_1/2, b_i = (w_{i-1} + w_i)/2, b_{n+1} = w_n/2.
  const b = new Float64Array(n + 1);
  b[0] = w[0] / 2;
  for (let i = 1; i < n; i++) b[i] = (w[i - 1] + w[i]) / 2;
  b[n] = w[n - 1] / 2;
  return { a, b };
}

const COEF = buildCoefficients();
export const KAHAN_LI_8_DRIFT: Readonly<Float64Array> = COEF.a;
export const KAHAN_LI_8_KICK: Readonly<Float64Array> = COEF.b;

/** A symplectic splitting given as drift weights a[0..s-1] and kick weights b[0..s]. */
export interface SplittingScheme {
  readonly a: ArrayLike<number>;
  readonly b: ArrayLike<number>;
}

export const KAHAN_LI_8: SplittingScheme = { a: COEF.a, b: COEF.b };
/** Plain kick-drift-kick leapfrog, order 2. For tests. */
export const LEAPFROG: SplittingScheme = { a: [1], b: [0.5, 0.5] };

/** Pairwise Newtonian accelerations. out[3i..3i+2] = acceleration of body i. */
export function accelerations(n: number, gm: ArrayLike<number>, q: ArrayLike<number>, out: Float64Array): void {
  for (let k = 0; k < 3 * n; k++) out[k] = 0;
  for (let i = 0; i < n; i++) {
    const xi = q[3 * i];
    const yi = q[3 * i + 1];
    const zi = q[3 * i + 2];
    let axi = 0;
    let ayi = 0;
    let azi = 0;
    for (let j = i + 1; j < n; j++) {
      const dx = q[3 * j] - xi;
      const dy = q[3 * j + 1] - yi;
      const dz = q[3 * j + 2] - zi;
      const d2 = dx * dx + dy * dy + dz * dz;
      const inv3 = 1 / (d2 * Math.sqrt(d2));
      const fi = gm[j] * inv3;
      const fj = gm[i] * inv3;
      axi += fi * dx;
      ayi += fi * dy;
      azi += fi * dz;
      out[3 * j] -= fj * dx;
      out[3 * j + 1] -= fj * dy;
      out[3 * j + 2] -= fj * dz;
    }
    out[3 * i] += axi;
    out[3 * i + 1] += ayi;
    out[3 * i + 2] += azi;
  }
}

/**
 * Add zonal J2 accelerations. For target o of body e, r = q_o - q_e, s = r.pole:
 *   a_o = -(3/2) J2 GM_e R^2 / r^5 [ (1 - 5 s^2/r^2) r + 2 s pole ]
 * and the reaction a_e = -(GM_o/GM_e) a_o. This is minus the gradient of the
 * pair potential GM_e GM_o J2 R^2 (3 s^2/r^2 - 1) / (2 r^3) (see conservedEnergy).
 */
export function addZonalAccelerations(gm: ArrayLike<number>, q: ArrayLike<number>, zonal: readonly ZonalHarmonic[], out: Float64Array): void {
  for (let z = 0; z < zonal.length; z++) {
    const Z = zonal[z];
    const e = Z.body;
    const px = Z.pole[0];
    const py = Z.pole[1];
    const pz = Z.pole[2];
    const k = 1.5 * Z.j2 * Z.radius * Z.radius;
    for (let t = 0; t < Z.targets.length; t++) {
      const o = Z.targets[t];
      const x = q[3 * o] - q[3 * e];
      const y = q[3 * o + 1] - q[3 * e + 1];
      const zz = q[3 * o + 2] - q[3 * e + 2];
      const r2 = x * x + y * y + zz * zz;
      const sp = x * px + y * py + zz * pz;
      const f = -k / (r2 * r2 * Math.sqrt(r2));
      const c1 = 1 - (5 * sp * sp) / r2;
      const gx = c1 * x + 2 * sp * px;
      const gy = c1 * y + 2 * sp * py;
      const gz = c1 * zz + 2 * sp * pz;
      const fo = f * gm[e];
      const fe = f * gm[o];
      out[3 * o] += fo * gx;
      out[3 * o + 1] += fo * gy;
      out[3 * o + 2] += fo * gz;
      out[3 * e] -= fe * gx;
      out[3 * e + 1] -= fe * gy;
      out[3 * e + 2] -= fe * gz;
    }
  }
}

/**
 * Sun 1PN acceleration (IERS Conventions 2010 eq. 10.12, beta = gamma = 1) on
 * every body i != sun, with r, v relative to the Sun:
 *   a_i = mu/(c^2 r^3) [ (4 mu/r - v^2) r + 4 (r.v) v ],
 * and the reaction -(GM_i/mu) a_i on the Sun so linear momentum is conserved.
 * Overwrites `out`.
 */
export function relativisticAccelerations(n: number, gm: ArrayLike<number>, sun: number, q: ArrayLike<number>, v: ArrayLike<number>, out: Float64Array): void {
  for (let k = 0; k < 3 * n; k++) out[k] = 0;
  const mu = gm[sun];
  const sx = q[3 * sun];
  const sy = q[3 * sun + 1];
  const sz = q[3 * sun + 2];
  const svx = v[3 * sun];
  const svy = v[3 * sun + 1];
  const svz = v[3 * sun + 2];
  let ax = 0;
  let ay = 0;
  let az = 0;
  for (let i = 0; i < n; i++) {
    if (i === sun) continue;
    const rx = q[3 * i] - sx;
    const ry = q[3 * i + 1] - sy;
    const rz = q[3 * i + 2] - sz;
    const vx = v[3 * i] - svx;
    const vy = v[3 * i + 1] - svy;
    const vz = v[3 * i + 2] - svz;
    const r2 = rx * rx + ry * ry + rz * rz;
    const r = Math.sqrt(r2);
    const f = mu / (C2 * r2 * r);
    const cr = f * ((4 * mu) / r - (vx * vx + vy * vy + vz * vz));
    const cv = f * 4 * (rx * vx + ry * vy + rz * vz);
    const gx = cr * rx + cv * vx;
    const gy = cr * ry + cv * vy;
    const gz = cr * rz + cv * vz;
    out[3 * i] = gx;
    out[3 * i + 1] = gy;
    out[3 * i + 2] = gz;
    const back = gm[i] / mu;
    ax -= back * gx;
    ay -= back * gy;
    az -= back * gz;
  }
  out[3 * sun] = ax;
  out[3 * sun + 1] = ay;
  out[3 * sun + 2] = az;
}

/**
 * Fixed-step integrator state. Holds positions q, velocities v (each with a
 * compensation array) and the acceleration at the current positions.
 *
 * Time is tracked as t0 + steps*h, never by repeated addition, so the time of
 * step N is exact and the same in both directions.
 */
export class NBodyIntegrator {
  readonly n: number;
  readonly gm: Float64Array;
  readonly q: Float64Array;
  readonly v: Float64Array;
  /** Acceleration at the current q. */
  readonly acc: Float64Array;
  private readonly qc: Float64Array;
  private readonly vc: Float64Array;
  readonly t0: number;
  readonly h: number;
  steps = 0;
  private readonly scheme: SplittingScheme;
  readonly physics: NBodyPhysics;
  private readonly zonal: readonly ZonalHarmonic[];
  private readonly sun: number;
  private readonly apn: Float64Array;
  private readonly vt: Float64Array;

  /**
   * @param state    [x,y,z,vx,vy,vz] per body (6n numbers), at time t0.
   * @param h        step, s. Negative to integrate backward.
   * @param physics  forces beyond Newtonian point masses. Default none.
   */
  constructor(
    gm: ArrayLike<number>,
    state: ArrayLike<number>,
    t0: number,
    h: number,
    scheme: SplittingScheme = KAHAN_LI_8,
    physics: NBodyPhysics = {},
  ) {
    const n = gm.length;
    if (state.length !== 6 * n) throw new Error('state must hold 6 numbers per body');
    this.n = n;
    this.gm = Float64Array.from(gm);
    this.q = new Float64Array(3 * n);
    this.v = new Float64Array(3 * n);
    this.qc = new Float64Array(3 * n);
    this.vc = new Float64Array(3 * n);
    this.acc = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        this.q[3 * i + k] = state[6 * i + k];
        this.v[3 * i + k] = state[6 * i + 3 + k];
      }
    }
    this.t0 = t0;
    this.h = h;
    this.scheme = scheme;
    this.physics = physics;
    this.zonal = physics.zonal ?? [];
    this.sun = physics.relativity ? physics.relativity.sun : -1;
    this.apn = new Float64Array(3 * n);
    this.vt = new Float64Array(3 * n);
    this.forces();
  }

  /** Position-dependent accelerations (Newtonian + zonal) at the current q, into acc. */
  private forces(): void {
    accelerations(this.n, this.gm, this.q, this.acc);
    if (this.zonal.length > 0) addZonalAccelerations(this.gm, this.q, this.zonal, this.acc);
  }

  /** Total acceleration at the current (q, v), including the velocity-dependent part. */
  totalAcceleration(out: Float64Array): void {
    out.set(this.acc);
    if (this.sun >= 0) {
      relativisticAccelerations(this.n, this.gm, this.sun, this.q, this.v, this.apn);
      for (let k = 0; k < 3 * this.n; k++) out[k] += this.apn[k];
    }
  }

  get t(): number {
    return this.t0 + this.steps * this.h;
  }

  /** Advance one step of size h. */
  step(): void {
    if (this.sun >= 0) {
      this.stepRelativistic();
      return;
    }
    const { n, q, v, qc, vc, acc, h } = this;
    const a = this.scheme.a;
    const b = this.scheme.b;
    const m = 3 * n;
    const s = a.length;
    for (let st = 0; st <= s; st++) {
      // kick (acc is current)
      const kb = b[st] * h;
      if (kb !== 0) {
        for (let k = 0; k < m; k++) {
          const y = kb * acc[k] - vc[k];
          const tmp = v[k] + y;
          vc[k] = tmp - v[k] - y;
          v[k] = tmp;
        }
      }
      if (st === s) break;
      // drift
      const ka = a[st] * h;
      for (let k = 0; k < m; k++) {
        const y = ka * v[k] - qc[k];
        const tmp = q[k] + y;
        qc[k] = tmp - q[k] - y;
        q[k] = tmp;
      }
      this.forces();
    }
    this.steps++;
  }

  /** Compensated v += c * (acc + apn). */
  private kick(c: number): void {
    const { v, vc, acc, apn } = this;
    for (let k = 0; k < v.length; k++) {
      const y = c * (acc[k] + apn[k]) - vc[k];
      const tmp = v[k] + y;
      vc[k] = tmp - v[k] - y;
      v[k] = tmp;
    }
  }

  /** Composition of the generalized Stormer-Verlet base method (see header). */
  private stepRelativistic(): void {
    const { n, q, v, qc, acc, apn, vt, gm, h, sun } = this;
    const w = this.scheme.a;
    const m = 3 * n;
    for (let st = 0; st < w.length; st++) {
      const tau = w[st] * h;
      const half = 0.5 * tau;
      // Implicit half-kick: v' = v + half * a(q, v'), fixed-point from v' = v.
      relativisticAccelerations(n, gm, sun, q, v, apn);
      for (let it = 0; it < PN_ITERATIONS; it++) {
        for (let k = 0; k < m; k++) vt[k] = v[k] + half * (acc[k] + apn[k]);
        relativisticAccelerations(n, gm, sun, q, vt, apn);
      }
      this.kick(half);
      // Drift.
      for (let k = 0; k < m; k++) {
        const y = tau * v[k] - qc[k];
        const tmp = q[k] + y;
        qc[k] = tmp - q[k] - y;
        q[k] = tmp;
      }
      // Explicit half-kick at the new position with v'.
      this.forces();
      relativisticAccelerations(n, gm, sun, q, v, apn);
      this.kick(half);
    }
    this.steps++;
  }

  /** Write the current state as [x,y,z,vx,vy,vz] per body. */
  getState(out: Float64Array): void {
    for (let i = 0; i < this.n; i++) {
      for (let k = 0; k < 3; k++) {
        out[6 * i + k] = this.q[3 * i + k];
        out[6 * i + 3 + k] = this.v[3 * i + k];
      }
    }
  }
}

/** Total energy, linear momentum and angular momentum (per unit G), for diagnostics. */
export function invariants(gm: ArrayLike<number>, state: ArrayLike<number>): { energy: number; p: number[]; L: number[] } {
  const n = gm.length;
  let kin = 0;
  let pot = 0;
  const p = [0, 0, 0];
  const L = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const m = gm[i];
    const x = state[6 * i];
    const y = state[6 * i + 1];
    const z = state[6 * i + 2];
    const vx = state[6 * i + 3];
    const vy = state[6 * i + 4];
    const vz = state[6 * i + 5];
    kin += 0.5 * m * (vx * vx + vy * vy + vz * vz);
    p[0] += m * vx;
    p[1] += m * vy;
    p[2] += m * vz;
    L[0] += m * (y * vz - z * vy);
    L[1] += m * (z * vx - x * vz);
    L[2] += m * (x * vy - y * vx);
    for (let j = i + 1; j < n; j++) {
      const dx = state[6 * j] - x;
      const dy = state[6 * j + 1] - y;
      const dz = state[6 * j + 2] - z;
      pot -= (m * gm[j]) / Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  return { energy: kin + pot, p, L };
}

/**
 * The quantity the full model conserves (per unit G, like `invariants`):
 * Newtonian N-body energy, plus the J2 pair potentials, plus the 1PN
 * test-particle energy of each body in the Sun's field,
 *   GM_i/c^2 [ 3/8 v^4 + 3/2 mu v^2/r + 1/2 mu^2/r^2 ]   (r, v relative to the Sun).
 * With J2 alone it is exactly conserved by the dynamics. With the Sun-only 1PN
 * term it is conserved only to O(GM_planet/GM_sun) times the 1PN terms, because
 * the Sun's reaction makes the relative motion differ from the test-particle
 * problem; the exact invariant needs the full EIH equations.
 */
export function conservedEnergy(gm: ArrayLike<number>, state: ArrayLike<number>, physics: NBodyPhysics = {}): number {
  let e = invariants(gm, state).energy;
  for (const Z of physics.zonal ?? []) {
    const k = 0.5 * Z.j2 * Z.radius * Z.radius;
    for (const o of Z.targets) {
      const x = state[6 * o] - state[6 * Z.body];
      const y = state[6 * o + 1] - state[6 * Z.body + 1];
      const z = state[6 * o + 2] - state[6 * Z.body + 2];
      const r2 = x * x + y * y + z * z;
      const sp = x * Z.pole[0] + y * Z.pole[1] + z * Z.pole[2];
      e += (gm[Z.body] * gm[o] * k * ((3 * sp * sp) / r2 - 1)) / (r2 * Math.sqrt(r2));
    }
  }
  if (physics.relativity) {
    const s = physics.relativity.sun;
    const mu = gm[s];
    for (let i = 0; i < gm.length; i++) {
      if (i === s) continue;
      let r2 = 0;
      let v2 = 0;
      for (let k = 0; k < 3; k++) {
        const d = state[6 * i + k] - state[6 * s + k];
        const u = state[6 * i + 3 + k] - state[6 * s + 3 + k];
        r2 += d * d;
        v2 += u * u;
      }
      const r = Math.sqrt(r2);
      e += (gm[i] / C2) * (0.375 * v2 * v2 + (1.5 * mu * v2) / r + (0.5 * mu * mu) / r2);
    }
  }
  return e;
}
