/**
 * Spacecraft dynamics: a test particle under the gravity of every massive body,
 * plus finite-thrust burns. Units are SI (m, s, kg); time is seconds from epoch.
 *
 * State vector: [x, y, z, vx, vy, vz, mass] in the ephemeris' inertial frame.
 *
 * FORCES: every body as a point mass; each body's gravity field beyond the
 * point mass (zonal J_n about its time-dependent IAU pole, and for Earth and
 * the Moon also the sectoral and tesseral C_nm, S_nm in the rotating
 * body-fixed frame; see gravity-field.ts and the data in solar-system.ts);
 * the Sun's 1PN term; finite thrust. J2 acts at any distance; a body's terms
 * above J2 are multiplied by its taper (BodyOblateness.taper: exactly 1
 * inside, a C2 quintic step, exactly 0 and skipped outside; radii in
 * solar-system.ts), so the force stays a smooth function of position and time
 * and a craft in LEO does not pay for Jupiter's J6 or the Moon's C44.
 *
 * Same determinism rule as dop853.ts: only exactly-defined operations (+ - * /,
 * Math.sqrt, Math.abs, Math.min/max, comparisons); no Math transcendental
 * functions (the time-dependent pole and the prime meridian use dmath, via
 * PoleTable and BodyFrame).
 */
import { Dop853, type ScaleFn } from './dop853';
import { earthPrimeMeridianDeg } from './earth-rotation';
import { HarmonicField, ZonalSeries, type TesseralTerm } from './gravity-field';
import { BodyFrame, PoleTable, polesAt, type IauRotation } from './orientation';

export const G0 = 9.80665; // standard gravity, m/s^2 (defines Isp)
export const STATE_SIZE = 7;

export interface Ephemeris {
  readonly count: number;
  /** Gravitational parameters GM, m^3/s^2. */
  readonly gm: ArrayLike<number>;
  /** Write x,y,z of every body at time t into out[3*i ..]. */
  positions(t: number, out: Float64Array): void;
  /** Write position and velocity of one body into out[0..5]. */
  bodyState(body: number, t: number, out: Float64Array): void;
  /**
   * Optional gravity field per body beyond the point mass (null where none):
   * zonal J2 (J4, J_n) and, where given, sectoral and tesseral terms. When
   * present, every body's field acts on the spacecraft. Absent: point masses
   * (FixedBodies).
   */
  readonly oblateness?: ArrayLike<BodyOblateness | null>;
  /** Optional: apply this body's (the Sun's) 1PN Schwarzschild term to the spacecraft. */
  readonly relativity?: { readonly body: number };
}

export interface BodyOblateness {
  /** Unnormalized J2. */
  readonly j2: number;
  /** Optional unnormalized J4 (same reference radius). Requires j2 != 0. Ignored when `jn` is given. */
  readonly j4?: number;
  /**
   * Optional unnormalized zonal series J_n for n = 2, 3, ... (jn[0] = J2,
   * jn[1] = J3, ...), same reference radius. When given it replaces j2/j4
   * (which must then equal jn[0] and jn[2]). Odd J_n depend on the sense of
   * the pole: `rotation` must be a prograde body's IAU model (IAU north =
   * rotational north, the +z axis the coefficients are defined about).
   */
  readonly jn?: readonly number[];
  /**
   * Optional sectoral and tesseral terms (n, m >= 1, C_nm, S_nm), unnormalized,
   * same reference radius, in the body-fixed frame of `rotation` (x through
   * the prime meridian). Requires `rotation`.
   */
  readonly tesseral?: readonly TesseralTerm[];
  /**
   * Prime meridian of the body-fixed frame: 'iau' (default) the IAU W of
   * `rotation`; 'earth-rotation-angle' Earth's ERA with Delta-T
   * (earth-rotation.ts), the launch code's Earth.
   */
  readonly primeMeridian?: 'iau' | 'earth-rotation-angle';
  /**
   * Optional taper [inner, outer] (units of `radius`) of the terms above J2
   * (J3.., J4 and the tesserals; J2 itself is never tapered). They are
   * multiplied by w(r): exactly 1 for r <= inner, exactly 0 for r >= outer
   * (and then not evaluated), and in between the C2 quintic step
   * w = 1 - s^3 (10 - 15 s + 6 s^2), s = (r - inner)/(outer - inner). The
   * force stays a smooth, path-independent function of position and time.
   * Absent: no taper (w = 1 everywhere).
   */
  readonly taper?: readonly [number, number];
  /** Reference radius, m. */
  readonly radius: number;
  /** Spin-axis unit vector in the ephemeris frame. Used when `rotation` is absent. */
  readonly pole: ArrayLike<number>;
  /**
   * IAU rotation model: the field is oriented by the pole at the current time
   * (orientation.ts PoleTable, a pure function of t), the same pole the
   * massive-body integrator uses.
   */
  readonly rotation?: IauRotation;
}

/**
 * One PoleTable per rotation model, shared by every propagation: a table's
 * answer is a pure function of t (node values depend only on the node index),
 * so sharing changes no bit, and it saves re-evaluating the IAU series at the
 * nodes for each of the many short propagations a corrector or planner runs.
 */
const POLE_TABLES = new WeakMap<IauRotation, PoleTable>();
/** Exported so the mission layer measures inclinations against exactly the pole the physics uses. */
export function sharedPoleTable(m: IauRotation): PoleTable {
  let t = POLE_TABLES.get(m);
  if (t === undefined) {
    t = new PoleTable(m);
    POLE_TABLES.set(m, t);
  }
  return t;
}

/** Likewise one BodyFrame per (rotation model, prime-meridian model): its W table is a pure function of t. */
const FRAMES = new WeakMap<IauRotation, Map<string, BodyFrame>>();
export function sharedBodyFrame(m: IauRotation, primeMeridian: 'iau' | 'earth-rotation-angle' = 'iau'): BodyFrame {
  let byKind = FRAMES.get(m);
  if (byKind === undefined) {
    byKind = new Map();
    FRAMES.set(m, byKind);
  }
  let f = byKind.get(primeMeridian);
  if (f === undefined) {
    f = new BodyFrame(m, { poleTable: sharedPoleTable(m), primeMeridianDeg: primeMeridian === 'earth-rotation-angle' ? earthPrimeMeridianDeg : undefined });
    byKind.set(primeMeridian, f);
  }
  return f;
}

/** J_n series of a body's field (jn, or j2/j4). */
export function zonalCoefficients(ob: BodyOblateness): number[] {
  if (ob.jn !== undefined) return [...ob.jn];
  return ob.j4 !== undefined && ob.j4 !== 0 ? [ob.j2, 0, ob.j4] : [ob.j2];
}

/**
 * Check that a field's odd zonal and body-fixed terms are oriented by a pole
 * of the right sense: the coefficients (DE440, EGM2008, the JPL satellite
 * ephemerides) are defined about the rotational north pole, which is the IAU
 * north pole only for a prograde rotator (W increasing). Even zonals are blind
 * to the sense (Uranus: IAU north is its rotational south).
 */
export function checkFieldOrientation(id: string, ob: BodyOblateness): void {
  const jn = zonalCoefficients(ob);
  const odd = jn.some((j, i) => i % 2 === 1 && j !== 0);
  const tess = (ob.tesseral ?? []).some((r) => r[2] !== 0 || r[3] !== 0);
  if (tess && ob.rotation === undefined) throw new Error(`${id}: tesseral terms need a rotation model`);
  if ((odd || tess) && ob.rotation !== undefined && !(ob.rotation.pm[1] > 0)) {
    throw new Error(`${id}: odd or body-fixed field terms with a retrograde IAU frame (IAU north is not rotational north)`);
  }
}

/** Speed of light, m/s. */
const C_LIGHT = 299792458;
const C2 = C_LIGHT * C_LIGHT;

export type BurnFrame =
  /** Direction is a fixed vector in the inertial frame. */
  | { kind: 'inertial' }
  /**
   * Direction is (prograde, normal, radial-out) relative to `body`, and the
   * thrust vector tracks that frame for the whole burn.
   */
  | { kind: 'orbital'; body: number };

export interface Burn {
  /** Ignition time, s. */
  tStart: number;
  /** Requested burn time, s. Cut short if propellant runs out. */
  duration: number;
  /** Thrust, N. */
  thrust: number;
  /** Specific impulse, s. */
  isp: number;
  /** Thrust direction in `frame`. Need not be normalised. */
  direction: readonly [number, number, number];
  frame: BurnFrame;
}

export interface PropagateOptions {
  /** Relative tolerance per step. Default 1e-12. */
  rtol?: number;
  /** Mass at which the tanks are empty, kg. Default 0. */
  dryMass?: number;
  /**
   * Called after every accepted step. `y` is reused; copy it to keep it.
   * `interpolate(t, out)` gives the state at any t in [tPrev, t] of the step just
   * taken, using the right-hand side that step was integrated with. It is valid
   * only during this callback and throws if kept and called later.
   * Returning `false` stops the propagation after this step (cancellation,
   * progress-driven slicing): `propagate` then returns that step's state with
   * `stopped: true`. Any other return value continues.
   */
  onStep?: (t: number, y: Float64Array, interpolate: Interpolator, tPrev: number) => unknown;
}

export type Interpolator = (t: number, out: Float64Array) => void;

export interface PropagateResult {
  t: number;
  y: Float64Array;
  accepted: number;
  rejected: number;
  /** True if onStep returned false and the propagation ended early, at `t`. */
  stopped?: boolean;
}

/** Thrown through Dop853.integrateTo to stop early; never escapes `propagate`. */
class StopSignal {}

/** Error scale by vector magnitude, so a coordinate passing through zero doesn't stall the step. */
function spacecraftScale(rtol: number): ScaleFn {
  const ATOL_R = 1e-3; // m
  const ATOL_V = 1e-9; // m/s
  const ATOL_M = 1e-9; // kg
  return (y, yNew, scale) => {
    const r0 = Math.sqrt(y[0] * y[0] + y[1] * y[1] + y[2] * y[2]);
    const r1 = Math.sqrt(yNew[0] * yNew[0] + yNew[1] * yNew[1] + yNew[2] * yNew[2]);
    const v0 = Math.sqrt(y[3] * y[3] + y[4] * y[4] + y[5] * y[5]);
    const v1 = Math.sqrt(yNew[3] * yNew[3] + yNew[4] * yNew[4] + yNew[5] * yNew[5]);
    const sr = ATOL_R + rtol * (r0 > r1 ? r0 : r1);
    const sv = ATOL_V + rtol * (v0 > v1 ? v0 : v1);
    scale[0] = scale[1] = scale[2] = sr;
    scale[3] = scale[4] = scale[5] = sv;
    scale[6] = ATOL_M + rtol * (y[6] > yNew[6] ? y[6] : yNew[6]);
  };
}

function validateBurns(burns: readonly Burn[]): void {
  for (let i = 0; i < burns.length; i++) {
    const b = burns[i];
    if (!(b.duration > 0) || !(b.thrust > 0) || !(b.isp > 0)) {
      throw new Error(`burn ${i}: duration, thrust and isp must be positive`);
    }
    const [dx, dy, dz] = b.direction;
    if (dx * dx + dy * dy + dz * dz === 0) throw new Error(`burn ${i}: zero direction`);
    if (i > 0 && b.tStart < burns[i - 1].tStart + burns[i - 1].duration) {
      throw new Error(`burn ${i}: burns must be sorted and must not overlap`);
    }
  }
}

/**
 * Propagate a spacecraft from t0 to t1 through a list of burns.
 *
 * The integrator stops exactly on every ignition and cutoff, so the right-hand
 * side is smooth inside each integration segment.
 */
export function propagate(
  ephem: Ephemeris,
  y0: ArrayLike<number>,
  t0: number,
  t1: number,
  burns: readonly Burn[] = [],
  opts: PropagateOptions = {},
): PropagateResult {
  validateBurns(burns);
  const rtol = opts.rtol ?? 1e-12;
  const dryMass = opts.dryMass ?? 0;
  const nBodies = ephem.count;
  // GM copied into a Float64Array (same values) for a monomorphic hot loop.
  const gm = Float64Array.from(ephem.gm as ArrayLike<number>);
  const bodyPos = new Float64Array(3 * nBodies);
  const ref = new Float64Array(6);
  const oblateness = ephem.oblateness;
  const relBody = ephem.relativity ? ephem.relativity.body : -1;
  const sunState = new Float64Array(6);

  // Bodies with a field, ascending (the order the terms are summed in): J2 in
  // closed form everywhere, plus the terms above J2 (hi kind) times the taper
  // w(r) of BodyOblateness.taper: 3 closed J4 only, 1 zonal series about the
  // pole, 2 full field in the body-fixed frame (rotation evaluated at most
  // once per time and body, and only while the craft is inside the taper).
  const zBody: number[] = [];
  const zPole: number[] = [];
  const zTable: (PoleTable | null)[] = [];
  const zSeries: (ZonalSeries | null)[] = [];
  const zF2: number[] = []; // -1.5 j2 gm R^2
  const zF4: number[] = []; // 0.125 j4 gm R^4 (hi kind 3)
  const zField: (HarmonicField | null)[] = [];
  const zFrame: (BodyFrame | null)[] = [];
  const zKindL: number[] = [];
  const zTi: number[] = []; // taper inner radius, m (Infinity: none)
  const zTo: number[] = [];
  if (oblateness !== undefined) {
    for (let i = 0; i < nBodies; i++) {
      const ob = oblateness[i];
      if (ob === null || ob === undefined) continue;
      checkFieldOrientation(`body ${i}`, ob);
      zBody.push(i);
      zPole.push(ob.pole[0], ob.pole[1], ob.pole[2]);
      zTable.push(ob.rotation !== undefined ? sharedPoleTable(ob.rotation) : null);
      const jn = zonalCoefficients(ob);
      const tess = (ob.tesseral ?? []).filter((r) => r[2] !== 0 || r[3] !== 0);
      const R2 = ob.radius * ob.radius;
      zF2.push(-1.5 * jn[0] * gm[i] * R2);
      const hi = jn.slice();
      hi[0] = 0;
      const onlyJ4 = tess.length === 0 && hi.every((j, n) => n === 2 || j === 0);
      zF4.push(onlyJ4 && hi.length > 2 ? 0.125 * hi[2] * gm[i] * R2 * R2 : 0);
      const tp = ob.taper;
      if (tp !== undefined && !(tp[0] >= 0 && tp[1] > tp[0])) throw new Error(`body ${i}: taper needs 0 <= inner < outer`);
      zTi.push(tp !== undefined ? tp[0] * ob.radius : Infinity);
      zTo.push(tp !== undefined ? tp[1] * ob.radius : Infinity);
      if (tess.length > 0) {
        zKindL.push(2);
        zSeries.push(null);
        zField.push(new HarmonicField(hi, tess, ob.radius));
        zFrame.push(sharedBodyFrame(ob.rotation!, ob.primeMeridian));
      } else {
        const none = hi.every((j) => j === 0);
        zKindL.push(none ? 0 : onlyJ4 ? 3 : 1);
        zSeries.push(none || onlyJ4 ? null : new ZonalSeries(hi, ob.radius));
        zField.push(null);
        zFrame.push(null);
      }
    }
  }
  const anyTable = zTable.some((p) => p !== null);
  const zTabs = zTable.filter((p): p is PoleTable => p !== null);
  const zTabOff = Int32Array.from(zTable.flatMap((p, q) => (p !== null ? [3 * q] : [])));
  const nZonal = zBody.length;
  const zBodyA = Int32Array.from(zBody);
  const zPoleA = Float64Array.from(zPole);
  const zF2A = Float64Array.from(zF2);
  const zF4A = Float64Array.from(zF4);
  const zKind = Uint8Array.from(zKindL);
  const zTi2 = Float64Array.from(zTi, (r) => r * r);
  const zTo2 = Float64Array.from(zTo, (r) => r * r);
  const zTiA = Float64Array.from(zTi);
  const zTw = Float64Array.from(zTo, (r, q) => 1 / (r - zTi[q])); // 1/(outer - inner); 0 without a taper
  const zMat = new Float64Array(9 * nZonal);
  const zMatT = new Float64Array(nZonal).fill(NaN);
  const fieldAcc = new Float64Array(3);

  // Ephemeris answers are functions of t alone, and the integrator asks for
  // the same t twice per step (stage 11 at t + 1.0*h and the FSAL stage at
  // t + h), after every refresh() and for every rejected step's first stage:
  // reuse the last answer. Keys compare with Object.is so that -0 and 0 stay
  // distinct calls, as before.
  let posT = NaN;
  let poleT = NaN;
  let sunT = NaN;
  let refT = NaN;
  let refBody = -1;

  // Burn currently firing, with its direction pre-normalised.
  let active: Burn | null = null;
  let activeIndex = -1;
  let ux = 0;
  let uy = 0;
  let uz = 0;

  const deriv = (t: number, y: Float64Array, out: Float64Array): void => {
    const x = y[0];
    const yy = y[1];
    const z = y[2];
    let ax = 0;
    let ay = 0;
    let az = 0;

    if (!Object.is(t, posT)) {
      ephem.positions(t, bodyPos);
      posT = t;
    }
    for (let i = 0; i < nBodies; i++) {
      const dx = bodyPos[3 * i] - x;
      const dy = bodyPos[3 * i + 1] - yy;
      const dz = bodyPos[3 * i + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const k = gm[i] / (d2 * Math.sqrt(d2));
      ax += k * dx;
      ay += k * dy;
      az += k * dz;
    }

    // Field of every body that has one (gravity-field.ts), r = spacecraft - body.
    if (anyTable && !Object.is(t, poleT)) {
      polesAt(zTabs, t, zPoleA, zTabOff);
      poleT = t;
    }
    fieldAcc[0] = 0;
    fieldAcc[1] = 0;
    fieldAcc[2] = 0;
    for (let q = 0; q < nZonal; q++) {
      const i = zBodyA[q];
      const rx = x - bodyPos[3 * i];
      const ry = yy - bodyPos[3 * i + 1];
      const rz = z - bodyPos[3 * i + 2];
      const px = zPoleA[3 * q];
      const py = zPoleA[3 * q + 1];
      const pz = zPoleA[3 * q + 2];
      // J2: a = -(3/2) J2 GM R^2 / r^5 [ (1 - 5 s^2/r^2) r + 2 s pole ], s = r.pole.
      const r2 = rx * rx + ry * ry + rz * rz;
      const sp = rx * px + ry * py + rz * pz;
      const f = zF2A[q] / (r2 * r2 * Math.sqrt(r2));
      const c1 = 1 - (5 * sp * sp) / r2;
      ax += f * (c1 * rx + 2 * sp * px);
      ay += f * (c1 * ry + 2 * sp * py);
      az += f * (c1 * rz + 2 * sp * pz);
      const kind = zKind[q];
      if (kind === 0 || r2 >= zTo2[q]) continue;
      // Taper w(r) (BodyOblateness.taper): 1 inside, quintic C2 step, 0 outside.
      let w = 1;
      if (r2 > zTi2[q]) {
        const sx = (Math.sqrt(r2) - zTiA[q]) * zTw[q];
        w = 1 - sx * sx * sx * (10 - sx * (15 - 6 * sx));
      }
      if (kind === 3) {
        // J4, u = s/r: J4 GM R^4/(8 r^7) [ (315u^4 - 210u^2 + 15) r - (140u^3 - 60u) r pole ].
        const r = Math.sqrt(r2);
        const u = sp / r;
        const u2 = u * u;
        const f4 = (w * zF4A[q]) / (r2 * r2 * r2 * r);
        const cr = f4 * (315 * u2 * u2 - 210 * u2 + 15);
        const cp = f4 * r * u * (140 * u2 - 60);
        ax += cr * rx - cp * px;
        ay += cr * ry - cp * py;
        az += cr * rz - cp * pz;
      } else if (kind === 1) {
        zSeries[q]!.add(gm[i], rx, ry, rz, px, py, pz, fieldAcc, 0, w);
      } else {
        if (!Object.is(t, zMatT[q])) {
          zFrame[q]!.matrixWithPole(t, px, py, pz, zMat, 9 * q);
          zMatT[q] = t;
        }
        zField[q]!.addIcrf(gm[i], rx, ry, rz, zMat, 9 * q, fieldAcc, 0, w);
      }
    }
    ax += fieldAcc[0];
    ay += fieldAcc[1];
    az += fieldAcc[2];

    // Sun 1PN (IERS 2010 eq. 10.12, beta = gamma = 1), relative to the Sun:
    // a = mu/(c^2 r^3) [ (4 mu/r - v^2) r + 4 (r.v) v ]. DOP853 handles the
    // velocity dependence directly.
    if (relBody >= 0) {
      if (!Object.is(t, sunT)) {
        ephem.bodyState(relBody, t, sunState);
        sunT = t;
      }
      const rx = x - sunState[0];
      const ry = yy - sunState[1];
      const rz = z - sunState[2];
      const vx = y[3] - sunState[3];
      const vy = y[4] - sunState[4];
      const vz = y[5] - sunState[5];
      const mu = gm[relBody];
      const r2 = rx * rx + ry * ry + rz * rz;
      const r = Math.sqrt(r2);
      const f = mu / (C2 * r2 * r);
      const cr = f * ((4 * mu) / r - (vx * vx + vy * vy + vz * vz));
      const cv = f * 4 * (rx * vx + ry * vy + rz * vz);
      ax += cr * rx + cv * vx;
      ay += cr * ry + cv * vy;
      az += cr * rz + cv * vz;
    }

    let mdot = 0;
    if (active !== null) {
      let tx = ux;
      let ty = uy;
      let tz = uz;
      if (active.frame.kind === 'orbital') {
        if (!Object.is(t, refT) || refBody !== active.frame.body) {
          ephem.bodyState(active.frame.body, t, ref);
          refT = t;
          refBody = active.frame.body;
        }
        const rx = x - ref[0];
        const ry = yy - ref[1];
        const rz = z - ref[2];
        const vx = y[3] - ref[3];
        const vy = y[4] - ref[4];
        const vz = y[5] - ref[5];
        // prograde
        const v2 = vx * vx + vy * vy + vz * vz;
        if (!(v2 > 0)) {
          throw new Error(`burn ${activeIndex}: orbital frame undefined (zero velocity relative to body ${active.frame.body})`);
        }
        const vInv = 1 / Math.sqrt(v2);
        const px = vx * vInv;
        const py = vy * vInv;
        const pz = vz * vInv;
        // normal = r x v
        let nx = ry * vz - rz * vy;
        let ny = rz * vx - rx * vz;
        let nz = rx * vy - ry * vx;
        const n2 = nx * nx + ny * ny + nz * nz;
        if (!(n2 > 0)) {
          throw new Error(`burn ${activeIndex}: orbital frame undefined (velocity parallel to radius from body ${active.frame.body})`);
        }
        const nInv = 1 / Math.sqrt(n2);
        nx *= nInv;
        ny *= nInv;
        nz *= nInv;
        // radial-out = prograde x normal
        const ox = py * nz - pz * ny;
        const oy = pz * nx - px * nz;
        const oz = px * ny - py * nx;
        tx = ux * px + uy * nx + uz * ox;
        ty = ux * py + uy * ny + uz * oy;
        tz = ux * pz + uy * nz + uz * oz;
      }
      const aThrust = active.thrust / y[6];
      ax += aThrust * tx;
      ay += aThrust * ty;
      az += aThrust * tz;
      mdot = -active.thrust / (active.isp * G0);
    }

    out[0] = y[3];
    out[1] = y[4];
    out[2] = y[5];
    out[3] = ax;
    out[4] = ay;
    out[5] = az;
    out[6] = mdot;
  };

  const integ = new Dop853(STATE_SIZE, deriv, spacecraftScale(rtol));
  integ.reset(t0, y0);
  let coastStep = integ.h;

  // Dense output is exposed only inside onStep, i.e. before `active` can change.
  let inCallback = false;
  const interpolate: Interpolator = (t, out) => {
    if (!inCallback) throw new Error('interpolate is only valid during onStep');
    integ.interpolate(t, out);
  };
  const userOnStep = opts.onStep;
  const onStep = userOnStep
    ? (t: number, y: Float64Array, it: Dop853) => {
        inCallback = true;
        let r: unknown;
        try {
          r = userOnStep(t, y, interpolate, it.tPrevious);
        } finally {
          inCallback = false;
        }
        if (r === false) throw new StopSignal();
      }
    : undefined;

  let i = 0;
  while (integ.t < t1) {
    const t = integ.t;
    while (i < burns.length && burns[i].tStart + burns[i].duration <= t) i++;
    const next = i < burns.length ? burns[i] : null;

    let segEnd = t1;
    let burning: Burn | null = null;
    let runsDry = false;
    if (next !== null && next.tStart <= t) {
      // Inside a burn. Propellant flow is constant, so depletion time is exact.
      const propellant = integ.y[6] - dryMass;
      if (propellant <= 0) {
        i++;
        continue;
      }
      const mdot = next.thrust / (next.isp * G0);
      const requestedEnd = next.tStart + next.duration;
      const dryTime = t + propellant / mdot;
      burning = next;
      if (dryTime < requestedEnd) {
        if (dryTime <= segEnd) {
          segEnd = dryTime;
          runsDry = true;
        }
      } else if (requestedEnd < segEnd) {
        segEnd = requestedEnd;
      }
    } else if (next !== null && next.tStart < segEnd) {
      segEnd = next.tStart;
    }

    if (burning !== active) {
      active = burning;
      activeIndex = burning !== null ? i : -1;
      if (active !== null) {
        const [dx, dy, dz] = active.direction;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        ux = dx * inv;
        uy = dy * inv;
        uz = dz * inv;
        coastStep = integ.h;
        integ.refresh();
        // Burns are short next to a coast step; let the controller find the new scale.
        const span = segEnd - t;
        if (integ.h > span / 8) integ.h = span / 8;
      } else {
        integ.refresh();
        integ.h = coastStep;
      }
    }

    try {
      integ.integrateTo(segEnd, onStep);
    } catch (e) {
      if (!(e instanceof StopSignal)) throw e;
      return { t: integ.t, y: Float64Array.from(integ.y), accepted: integ.accepted, rejected: integ.rejected, stopped: true };
    }
    // Tanks empty: snap to exactly dryMass so no roundoff residue can restart the engine.
    if (runsDry) integ.y[6] = dryMass;
    if (burning !== null && integ.t >= burning.tStart + burning.duration) i++;
    else if (runsDry) i++;
  }

  return {
    t: integ.t,
    y: Float64Array.from(integ.y),
    accepted: integ.accepted,
    rejected: integ.rejected,
  };
}

/** Bodies that never move. For tests and two-body sanity checks. */
export class FixedBodies implements Ephemeris {
  readonly count: number;
  readonly gm: Float64Array;
  private readonly pos: Float64Array;

  constructor(bodies: readonly { gm: number; position: readonly [number, number, number] }[]) {
    this.count = bodies.length;
    this.gm = Float64Array.from(bodies.map((b) => b.gm));
    this.pos = new Float64Array(3 * bodies.length);
    bodies.forEach((b, i) => this.pos.set(b.position, 3 * i));
  }

  positions(_t: number, out: Float64Array): void {
    out.set(this.pos);
  }

  bodyState(body: number, _t: number, out: Float64Array): void {
    out[0] = this.pos[3 * body];
    out[1] = this.pos[3 * body + 1];
    out[2] = this.pos[3 * body + 2];
    out[3] = out[4] = out[5] = 0;
  }
}
