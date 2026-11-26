/**
 * Fixed-step symplectic N-body integrator for the massive bodies (Newtonian
 * point masses). Units are SI; time is seconds TDB from the J2000 epoch.
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
 * DETERMINISM: only + - * / and Math.sqrt. Do not add Math.pow, trig, etc.
 */

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

  /**
   * @param state  [x,y,z,vx,vy,vz] per body (6n numbers), at time t0.
   * @param h      step, s. Negative to integrate backward.
   */
  constructor(gm: ArrayLike<number>, state: ArrayLike<number>, t0: number, h: number, scheme: SplittingScheme = KAHAN_LI_8) {
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
    accelerations(n, this.gm, this.q, this.acc);
  }

  get t(): number {
    return this.t0 + this.steps * this.h;
  }

  /** Advance one step of size h. */
  step(): void {
    const { n, q, v, qc, vc, acc, gm, h } = this;
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
      accelerations(n, gm, q, acc);
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
