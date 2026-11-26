/**
 * Fixed-step, time-reversible, 8th-order N-body integrator for the massive
 * bodies. Units are SI; time is seconds TDB from the J2000 epoch.
 *
 * PHYSICS: Newtonian point masses, plus (optional, see NBodyPhysics)
 *  - zonal J2 (and J4) of selected bodies acting on selected others, with the
 *    equal and opposite reaction, about a fixed pole or about the body's IAU
 *    pole at the current time (see "TIME-DEPENDENT FORCES"); optionally
 *    higher zonals J_n (ZonalHarmonic.jn) and sectoral/tesseral terms in the
 *    body-fixed frame (ZonalHarmonic.tesseral, orientation.ts BodyFrame),
 *    evaluated by gravity-field.ts, also with the reaction. The production
 *    selection (solar-system.ts MASSIVE_BODY_FIELDS): Saturn J3..J8 and
 *    Jupiter J3..J6 on their moons; no tesserals (the Moon's C22 is left out
 *    on purpose, see there);
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
 * STEP AND MOONS: the step is global. With the giant planets' moons (Io:
 * 1.77 d) the default step is 1/32 d (solar-system.ts, DEFAULT_STEP). A
 * multiple-time-stepping alternative was implemented and measured (r-RESPA:
 * cross-system forces as impulses every tau, each satellite system advanced
 * inside by m leapfrog sub-steps; symmetric, so the Kahan-Li composition makes
 * it order 8 in tau). Errors after one year against this integrator at 1/64 d:
 *   tau 0.5 d:  m = 8, 16, 32 -> Io 25 km, 2.0 km, 350 m (converges ~m^-3,
 *               not m^-8: tau*omega_Io = 1.8 is outside the asymptotic range)
 *   tau 0.25 d: m = 16 -> Io 5 m;  tau 0.125 d: m = 4, 8 -> Io 13 m, 2 m
 *   single rate (this scheme): 1/24 d -> 14 m, 1/32 d -> 3 m
 * In Node the r-RESPA run at Io ~5 m/yr cost 0.96 ms per day against 1.47 ms
 * for 1/32 d single rate: a 1.3-2x saving (with tuning), bought with an order
 * that holds only once tau*omega < 1 and impulses that can resonate with the
 * moons. Moving the Sun-system pairs into the fast part changed nothing (the
 * error is the moons' own intra-system dynamics). Not adopted.
 *
 * TIME-DEPENDENT FORCES: a zonal field oriented by the IAU pole model
 * (ZonalHarmonic.rotation, src/physics/orientation.ts) is an explicitly
 * time-dependent force. Time is treated as one more position coordinate with
 * velocity 1 (the extended phase space): every drift of a_i*h also advances
 * time by a_i*h, so the force after drift i is evaluated at the stage time
 *   t_n + c_i h,   c_i = a_1 + ... + a_i,
 * and the composition keeps its order 8 and its symmetry (the stage times of a
 * step run backward from t_{n+1} are the same set, c_{s-i} = 1 - c_i). The
 * stage time is computed as (t0 + n h) + c_i h with c_s set to exactly 1 and
 * the last stage at t0 + (n+1) h, so the force at the end of a step is
 * evaluated at bit for bit the time a resumed integrator (importState) uses,
 * and the stage times depend only on (t0, h, step count): any chunk build or
 * checkpoint resume sees the same times. The pole itself is a pure function of
 * time (PoleTable). Tested in test/nbody-pole.test.ts (order with a fast
 * precessing pole, reversibility, resume).
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
 * min/max, floor, comparisons), plus the deterministic sin/cos of dmath.ts
 * inside the pole model. No Math transcendental functions (pow, exp, log,
 * trig): their results differ between JS engines.
 */

import { earthPrimeMeridianDeg } from './earth-rotation';
import { HarmonicField, ZonalSeries, type TesseralTerm } from './gravity-field';
import { BodyFrame, PoleTable, type IauRotation } from './orientation';

/** Speed of light, m/s (exact, SI definition). */
export const C_LIGHT = 299792458;
const C2 = C_LIGHT * C_LIGHT;
/** Fixed-point iterations for the implicit half-kick. Fixed for reproducibility. */
export const PN_ITERATIONS = 2;

/**
 * Gravity field of `body` beyond the point mass, acting on each body in
 * `targets` (and the reaction on `body`): zonal J2 (and J4), or a zonal series
 * `jn`, and optionally sectoral/tesseral terms in the rotating body-fixed frame.
 */
export interface ZonalHarmonic {
  body: number;
  /** Unnormalized J2 (dimensionless), referred to `radius`. Must be nonzero if j4 is given. */
  j2: number;
  /** Unnormalized J4, referred to `radius`. Omitted or 0: no J4 term. Ignored when `jn` is given. */
  j4?: number;
  /**
   * Unnormalized zonal series J_n for n = 2, 3, ... (jn[0] = J2), replacing
   * j2/j4 when given. Odd J_n are odd in the pole (see gravity-field.ts).
   */
  jn?: readonly number[];
  /** Sectoral/tesseral terms (n, m >= 1, C, S), body-fixed frame of `rotation` (required). */
  tesseral?: readonly TesseralTerm[];
  /** Prime meridian for `tesseral`: the IAU W of `rotation` (default) or Earth's ERA. */
  primeMeridian?: 'iau' | 'earth-rotation-angle';
  /** Reference (equatorial) radius, m. */
  radius: number;
  /** Unit vector along the body's spin axis, in the integration frame (ICRF). Used when `rotation` is absent. */
  pole: readonly [number, number, number];
  /**
   * IAU rotation model of the body: the field is then oriented by its pole at
   * the current time (PoleTable of this model), and `pole` is unused by the
   * dynamics (it stays as the J2000 value, e.g. for conservedEnergy).
   */
  rotation?: IauRotation;
  /** Node spacing of the pole table, s (default POLE_NODE_SPACING, one day); 0: the exact series at every force evaluation (tests). */
  poleSpacing?: number;
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

/** Evaluators of a term's field (zonal series or full field), built once per term object. */
const FIELD_CACHE = new WeakMap<ZonalHarmonic, { zonal: ZonalSeries | null; full: HarmonicField | null }>();
function fieldOf(Z: ZonalHarmonic): { zonal: ZonalSeries | null; full: HarmonicField | null } {
  let f = FIELD_CACHE.get(Z);
  if (f === undefined) {
    const tess = (Z.tesseral ?? []).filter((r) => r[2] !== 0 || r[3] !== 0);
    const jn = Z.jn ?? [Z.j2];
    if (tess.length > 0) {
      if (Z.rotation === undefined) throw new Error('zonal term: tesseral terms need a rotation model');
      f = { zonal: null, full: new HarmonicField(jn, tess, Z.radius) };
    } else {
      f = { zonal: Z.jn !== undefined ? new ZonalSeries(jn, Z.radius) : null, full: null };
    }
    FIELD_CACHE.set(Z, f);
  }
  return f;
}

/** Does this term need the body-fixed frame (sectoral/tesseral terms)? */
export function needsBodyFrame(Z: ZonalHarmonic): boolean {
  return fieldOf(Z).full !== null;
}

/**
 * Add the field accelerations. For target o of body e, r = q_o - q_e, s = r.pole:
 *   a_o = -(3/2) J2 GM_e R^2 / r^5 [ (1 - 5 s^2/r^2) r + 2 s pole ]
 * and the reaction a_e = -(GM_o/GM_e) a_o. This is minus the gradient of the
 * pair potential GM_e GM_o J2 R^2 (3 s^2/r^2 - 1) / (2 r^3) (see conservedEnergy).
 * With J4, u = s/r, the pair potential adds GM_e GM_o J4 R^4 (35 u^4 - 30 u^2 + 3) / (8 r^5),
 * whose (minus) gradient on o is
 *   a_o += (J4 GM_e R^4 / (8 r^7)) [ (315 u^4 - 210 u^2 + 15) r - (140 u^3 - 60 u) r pole ].
 * A term with a zonal series `jn` uses the general zonal formula of
 * gravity-field.ts (ZonalSeries); one with sectoral/tesseral terms the full
 * field in the body-fixed frame (HarmonicField), whose body-fixed -> ICRF
 * matrix is frames[9z..9z+8] (required for such terms). The reaction is
 * always -(GM_o/GM_e) a_o (the torque on the body is not modelled: its
 * orientation is prescribed by the IAU model).
 * `poles`, if given, holds the pole of term z at poles[3z..3z+2] (overriding Z.pole).
 * The J2/J4 form is even in the pole (s pole, s^2, u pole, u^2): a pole and
 * its opposite give bit-identical accelerations. Odd J_n are not.
 */
export function addZonalAccelerations(
  gm: ArrayLike<number>,
  q: ArrayLike<number>,
  zonal: readonly ZonalHarmonic[],
  out: Float64Array,
  poles?: ArrayLike<number>,
  frames?: Float64Array,
): void {
  const acc = ZONAL_TMP;
  for (let z = 0; z < zonal.length; z++) {
    const Z = zonal[z];
    const e = Z.body;
    const px = poles !== undefined ? poles[3 * z] : Z.pole[0];
    const py = poles !== undefined ? poles[3 * z + 1] : Z.pole[1];
    const pz = poles !== undefined ? poles[3 * z + 2] : Z.pole[2];
    if (Z.jn !== undefined || Z.tesseral !== undefined) {
      const f = fieldOf(Z);
      for (let t = 0; t < Z.targets.length; t++) {
        const o = Z.targets[t];
        const x = q[3 * o] - q[3 * e];
        const y = q[3 * o + 1] - q[3 * e + 1];
        const zz = q[3 * o + 2] - q[3 * e + 2];
        acc[0] = 0;
        acc[1] = 0;
        acc[2] = 0;
        if (f.full !== null) {
          if (frames === undefined) throw new Error('addZonalAccelerations: a tesseral term needs its body frame');
          f.full.addIcrf(1, x, y, zz, frames, 9 * z, acc, 0);
        } else {
          f.zonal!.add(1, x, y, zz, px, py, pz, acc, 0);
        }
        const ge = gm[e];
        const go = gm[o];
        out[3 * o] += ge * acc[0];
        out[3 * o + 1] += ge * acc[1];
        out[3 * o + 2] += ge * acc[2];
        out[3 * e] -= go * acc[0];
        out[3 * e + 1] -= go * acc[1];
        out[3 * e + 2] -= go * acc[2];
      }
      continue;
    }
    const R2 = Z.radius * Z.radius;
    const k = 1.5 * Z.j2 * R2;
    const j4 = Z.j4 ?? 0;
    const k4 = 0.125 * j4 * R2 * R2;
    for (let t = 0; t < Z.targets.length; t++) {
      const o = Z.targets[t];
      const x = q[3 * o] - q[3 * e];
      const y = q[3 * o + 1] - q[3 * e + 1];
      const zz = q[3 * o + 2] - q[3 * e + 2];
      const r2 = x * x + y * y + zz * zz;
      const sp = x * px + y * py + zz * pz;
      const f = -k / (r2 * r2 * Math.sqrt(r2));
      const c1 = 1 - (5 * sp * sp) / r2;
      let gx = c1 * x + 2 * sp * px;
      let gy = c1 * y + 2 * sp * py;
      let gz = c1 * zz + 2 * sp * pz;
      if (j4 !== 0) {
        // In units of f = -k/r^5 (so j2 != 0): add -(k4/(k r^2)) [ (315u^4 - 210u^2 + 15) r - (140u^3 - 60u) r pole ].
        const u2 = (sp * sp) / r2;
        const r = Math.sqrt(r2);
        const u = sp / r;
        const g = -k4 / (k * r2);
        const cr = g * (315 * u2 * u2 - 210 * u2 + 15);
        const cp = g * r * u * (140 * u2 - 60);
        gx += cr * x - cp * px;
        gy += cr * y - cp * py;
        gz += cr * zz - cp * pz;
      }
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
const ZONAL_TMP = new Float64Array(3);

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
  /** Per zonal term: its pole table (time-dependent poles), or null (fixed pole). */
  private readonly poleTables: (PoleTable | null)[];
  /** Current pole of every zonal term (3 per term), or undefined if all are fixed. */
  private readonly poles: Float64Array | undefined;
  /** Per zonal term: its body frame (terms with sectoral/tesseral parts), or null. */
  private readonly bodyFrames: (BodyFrame | null)[];
  /** Body-fixed -> ICRF matrix of every term (9 per term), or undefined if no term needs one. */
  private readonly frames: Float64Array | undefined;
  /** Stage times: c[i] = a_1 + ... + a_{i+1} as a fraction of h, the last exactly 1. */
  private readonly stageC: Float64Array;

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
    this.poleTables = this.zonal.map((Z) => (Z.rotation !== undefined ? new PoleTable(Z.rotation, Z.poleSpacing) : null));
    this.poles = this.poleTables.some((p) => p !== null) ? new Float64Array(3 * this.zonal.length) : undefined;
    this.bodyFrames = this.zonal.map((Z, z) =>
      needsBodyFrame(Z)
        ? new BodyFrame(Z.rotation!, {
            poleTable: this.poleTables[z]!,
            primeMeridianDeg: Z.primeMeridian === 'earth-rotation-angle' ? earthPrimeMeridianDeg : undefined,
          })
        : null,
    );
    this.frames = this.bodyFrames.some((f) => f !== null) ? new Float64Array(9 * this.zonal.length) : undefined;
    if (this.poles !== undefined) {
      this.zonal.forEach((Z, z) => {
        if (this.poleTables[z] === null) this.poles!.set(Z.pole, 3 * z);
      });
    }
    const sa = scheme.a;
    this.stageC = new Float64Array(sa.length);
    let c = 0;
    for (let i = 0; i < sa.length; i++) {
      c += sa[i];
      this.stageC[i] = c;
    }
    this.stageC[sa.length - 1] = 1;
    this.forces(this.t);
  }

  /** Position-dependent accelerations (Newtonian + zonal) at the current q and time `time`, into acc. */
  private forces(time: number): void {
    accelerations(this.n, this.gm, this.q, this.acc);
    if (this.zonal.length > 0) {
      const poles = this.poles;
      if (poles !== undefined) {
        const tabs = this.poleTables;
        for (let z = 0; z < tabs.length; z++) {
          const tab = tabs[z];
          if (tab !== null) tab.at(time, poles, 3 * z);
        }
      }
      const frames = this.frames;
      if (frames !== undefined) {
        const fr = this.bodyFrames;
        for (let z = 0; z < fr.length; z++) {
          const f = fr[z];
          if (f !== null) f.matrixWithPole(time, poles![3 * z], poles![3 * z + 1], poles![3 * z + 2], frames, 9 * z);
        }
      }
      addZonalAccelerations(this.gm, this.q, this.zonal, this.acc, poles, frames);
    }
  }

  /** Time of the force evaluation after drift `st` of the current step (see TIME-DEPENDENT FORCES). */
  private stageTime(st: number): number {
    if (st === this.stageC.length - 1) return this.t0 + (this.steps + 1) * this.h;
    return this.t0 + this.steps * this.h + this.stageC[st] * this.h;
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
      this.forces(this.stageTime(st));
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
      this.forces(this.stageTime(st));
      relativisticAccelerations(n, gm, sun, q, v, apn);
      this.kick(half);
    }
    this.steps++;
  }

  /**
   * Full-precision state for exact resumption: q, v and their Kahan
   * compensation terms, 12n numbers laid out [q(3n), v(3n), qc(3n), vc(3n)].
   * `importState` of this array, with the same step count, continues the
   * integration bit for bit; the integrator importing it may run in either
   * direction (it is a one-step method, so nothing else is needed).
   */
  exportState(out: Float64Array = new Float64Array(12 * this.n)): Float64Array {
    const m = 3 * this.n;
    if (out.length !== 4 * m) throw new Error(`exportState: need ${4 * m} numbers`);
    out.set(this.q, 0);
    out.set(this.v, m);
    out.set(this.qc, 2 * m);
    out.set(this.vc, 3 * m);
    return out;
  }

  /** Restore a state written by `exportState` and set the step count (default: unchanged). */
  importState(data: ArrayLike<number>, steps: number = this.steps): void {
    const m = 3 * this.n;
    if (data.length !== 4 * m) throw new Error(`importState: need ${4 * m} numbers`);
    for (let k = 0; k < m; k++) {
      this.q[k] = data[k];
      this.v[k] = data[m + k];
      this.qc[k] = data[2 * m + k];
      this.vc[k] = data[3 * m + k];
    }
    this.steps = steps;
    this.forces(this.t);
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
      if (Z.j4) {
        const u2 = (sp * sp) / r2;
        const R4 = Z.radius * Z.radius * Z.radius * Z.radius;
        e += (gm[Z.body] * gm[o] * Z.j4 * R4 * (35 * u2 * u2 - 30 * u2 + 3)) / (8 * r2 * r2 * Math.sqrt(r2));
      }
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
