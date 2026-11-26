/**
 * Body orientation for the physics: the IAU WGCCRE rotation model (pole right
 * ascension alpha0, declination delta0 and prime meridian W, with every
 * periodic term NAIF pck00011.tpc lists) evaluated deterministically, and the
 * time-dependent spin pole that orients each body's zonal (J2, J4) field.
 *
 * ONE SOURCE: the constants are src/physics/data/iau-rotation.json, generated
 * from pck00011.tpc by scripts/gen-iau-rotation.py. The display
 * (src/app/body-rotation.ts: textures, drawn axes and equators) reads the same
 * file, and test/orientation.test.ts checks that display, launch code
 * (src/mission/earth-orientation.ts) and physics agree for every body.
 *
 * MODEL (degrees; T Julian centuries and d days of TDB from J2000):
 *   alpha0 = ra[0] + ra[1] T + ra[2] T^2 + sum_k ra_k sin A_k
 *   delta0 = dec[0] + dec[1] T + dec[2] T^2 + sum_k dec_k cos A_k
 *   W      = pm[0] + pm[1] d + pm[2] d^2 + sum_k pm_k sin A_k
 *   A_k    = angle[0] + angle[1] T (+ angle[2] T^2)
 *   pole = (cos delta0 cos alpha0, cos delta0 sin alpha0, sin delta0) in ICRF,
 *   body-fixed -> ICRF: R = Rz(90 deg + alpha0) Rx(90 deg - delta0) Rz(W).
 * `bodyToIcrf` gives the full rotation (prime meridian included) for
 * body-fixed field terms such as C22; the zonal field needs only the pole.
 *
 * POLE EVALUATION IN THE DYNAMICS (`PoleTable`): a pole moves slowly (Earth
 * 0.56 deg/century, Mars 0.12 deg/century plus 0.4-1.6 deg terms of ~70 000 yr
 * period, the Moon 1.5 deg about the ecliptic pole every 18.6 yr plus
 * 0.007-0.07 deg monthly terms), but the force is evaluated 17 times per
 * integrator step, and the full series costs ~40 deterministic sin/cos per
 * evaluation (~+25% on a step). So the pole is tabulated: at nodes t_k = k *
 * POLE_NODE_SPACING (fixed in absolute time, J2000 + k days) the exact pole and
 * its time derivative are computed from the series, and between nodes the
 * pole is the cubic Hermite interpolant of those, renormalised to unit
 * length. That makes the pole a PURE FUNCTION OF t: the node values depend
 * only on k, the interpolation only on t, so the result is the same bits
 * whatever sequence of times asks for it (forward or backward integration,
 * any chunk build order, the spacecraft's adaptive steps), and every caller
 * may keep its own small cache. The interpolant is C1 in time; its error
 * against the exact series is < 1e-6 deg for the Moon's 13.6 d term and far
 * smaller for everything else (test/orientation.test.ts). A body whose pole has
 * no time dependence (Sun, Uranus, ...) gets its constant pole once.
 *
 * DETERMINISM: dmath sin/cos and exactly rounded + - * / sqrt floor only.
 */
import data from './data/iau-rotation.json';
import { DEG, sincos } from './dmath';

/** One periodic term: A = angle[0] + angle[1] T (+ angle[2] T^2) degrees; amplitudes in degrees. */
export interface IauNutationTerm {
  readonly angle: readonly number[];
  readonly ra: number;
  readonly dec: number;
  readonly pm: number;
}

/** IAU rotation constants of one body (see header). */
export interface IauRotation {
  readonly naifId: number;
  /** alpha0: degrees, deg/century, deg/century^2. */
  readonly ra: readonly number[];
  /** delta0: degrees, deg/century, deg/century^2. */
  readonly dec: readonly number[];
  /** W: degrees, deg/day, deg/day^2. */
  readonly pm: readonly number[];
  readonly nut?: readonly IauNutationTerm[];
}

/** The generated constants, by body id (src/physics/data/iau-rotation.json). */
export const IAU_ROTATION: Readonly<Record<string, IauRotation>> = data.bodies as Record<string, IauRotation>;
/** Provenance of IAU_ROTATION. */
export const IAU_ROTATION_SOURCE: string = data.source;

export const SECONDS_PER_DAY = 86400;
export const SECONDS_PER_CENTURY = 36525 * SECONDS_PER_DAY;

/** Spacing of the pole table's nodes, s (one day, nodes at J2000 + k days). */
export const POLE_NODE_SPACING = SECONDS_PER_DAY;

/** x - 360 floor(x / 360): an angle in degrees reduced to [0, 360). */
function reduceDeg(x: number): number {
  return x - 360 * Math.floor(x / 360);
}

/** Does the pole of this model change with time? */
export function poleIsTimeDependent(m: IauRotation): boolean {
  if ((m.ra[1] ?? 0) !== 0 || (m.ra[2] ?? 0) !== 0 || (m.dec[1] ?? 0) !== 0 || (m.dec[2] ?? 0) !== 0) return true;
  for (const n of m.nut ?? []) if (n.ra !== 0 || n.dec !== 0) return true;
  return false;
}

/**
 * Pole right ascension and declination (degrees) and their rates (degrees per
 * second) at TDB t (s from J2000), from the full series.
 */
export function poleAngles(m: IauRotation, t: number): { ra: number; dec: number; raRate: number; decRate: number } {
  const T = t / SECONDS_PER_CENTURY;
  const ra2 = m.ra[2] ?? 0;
  const dec2 = m.dec[2] ?? 0;
  let ra = m.ra[0] + m.ra[1] * T + ra2 * T * T;
  let dec = m.dec[0] + m.dec[1] * T + dec2 * T * T;
  // Rates in degrees per century first, converted once at the end.
  let raRate = m.ra[1] + 2 * ra2 * T;
  let decRate = m.dec[1] + 2 * dec2 * T;
  const nut = m.nut;
  if (nut !== undefined) {
    for (let k = 0; k < nut.length; k++) {
      const n = nut[k];
      if (n.ra === 0 && n.dec === 0) continue;
      const a2 = n.angle[2] ?? 0;
      const A = reduceDeg(n.angle[0] + n.angle[1] * T + a2 * T * T);
      const rate = (n.angle[1] + 2 * a2 * T) * DEG; // rad per century
      const [s, c] = sincos(A * DEG);
      ra += n.ra * s;
      dec += n.dec * c;
      raRate += n.ra * c * rate;
      decRate -= n.dec * s * rate;
    }
  }
  return { ra, dec, raRate: raRate / SECONDS_PER_CENTURY, decRate: decRate / SECONDS_PER_CENTURY };
}

/** Exact pole (ICRF unit vector) at t into out[o..o+2]; with `rate`, also d(pole)/dt (1/s) into rate[ro..ro+2]. */
export function poleAt(m: IauRotation, t: number, out: Float64Array | number[], o = 0, rate?: Float64Array | number[], ro = 0): void {
  const p = poleAngles(m, t);
  const [sa, ca] = sincos(reduceDeg(p.ra) * DEG);
  const [sd, cd] = sincos(p.dec * DEG);
  out[o] = cd * ca;
  out[o + 1] = cd * sa;
  out[o + 2] = sd;
  if (rate !== undefined) {
    const da = p.raRate * DEG;
    const dd = p.decRate * DEG;
    rate[ro] = -sd * ca * dd - cd * sa * da;
    rate[ro + 1] = -sd * sa * dd + cd * ca * da;
    rate[ro + 2] = cd * dd;
  }
}

/** Prime meridian W (degrees, in [0, 360)) at TDB t, from the full series. */
export function primeMeridian(m: IauRotation, t: number): number {
  const d = t / SECONDS_PER_DAY;
  const T = t / SECONDS_PER_CENTURY;
  // pm[1] d reaches ~1e7 deg over a century: split off whole turns per day first.
  const turns = Math.floor(m.pm[1] / 360);
  const rem = m.pm[1] - 360 * turns;
  const nd = turns * d;
  let w = m.pm[0] + rem * d + 360 * (nd - Math.floor(nd)) + (m.pm[2] ?? 0) * d * d;
  const nut = m.nut;
  if (nut !== undefined) {
    for (let k = 0; k < nut.length; k++) {
      const n = nut[k];
      if (n.pm === 0) continue;
      const A = reduceDeg(n.angle[0] + n.angle[1] * T + (n.angle[2] ?? 0) * T * T);
      const [s] = sincos(A * DEG);
      w += n.pm * s;
    }
  }
  return reduceDeg(w);
}

/** Rotation body-fixed -> ICRF at t (row-major 3x3): R = Rz(90 + alpha0) Rx(90 - delta0) Rz(W). */
export function bodyToIcrf(m: IauRotation, t: number, out: Float64Array = new Float64Array(9)): Float64Array {
  const p = poleAngles(m, t);
  const [sa, ca] = sincos(reduceDeg(p.ra + 90) * DEG);
  const [sd, cd] = sincos((90 - p.dec) * DEG);
  const [sw, cw] = sincos(primeMeridian(m, t) * DEG);
  const a00 = ca, a01 = -sa * cd, a02 = sa * sd;
  const a10 = sa, a11 = ca * cd, a12 = -ca * sd;
  const a21 = sd, a22 = cd;
  out[0] = a00 * cw + a01 * sw;
  out[1] = -a00 * sw + a01 * cw;
  out[2] = a02;
  out[3] = a10 * cw + a11 * sw;
  out[4] = -a10 * sw + a11 * cw;
  out[5] = a12;
  out[6] = a21 * sw;
  out[7] = a21 * cw;
  out[8] = a22;
  return out;
}

/**
 * The pole of one body as a pure function of time, tabulated (see header,
 * POLE EVALUATION). Holds a cache of one node interval; node values are
 * recomputed on demand, and are a function of the node index alone.
 * spacing 0: no table, the exact series at every call (for tests).
 */
const NODE_CACHE = 1024; // power of two; 1024 days of nodes, 48 KiB per body

export class PoleTable {
  readonly model: IauRotation;
  readonly spacing: number;
  readonly timeDependent: boolean;
  private k = NaN;
  /** p0 (3), m0 = spacing * p0' (3), p1 (3), m1 (3) of interval k. */
  private readonly c = new Float64Array(12);
  private readonly tmp = new Float64Array(3);
  /** Direct-mapped cache of node values (6 each) by node index: pure functions of k, so reuse is exact. */
  private readonly nodeKey = new Float64Array(NODE_CACHE).fill(NaN);
  private readonly nodeVal = new Float64Array(6 * NODE_CACHE);

  constructor(model: IauRotation, spacing: number = POLE_NODE_SPACING) {
    this.model = model;
    this.spacing = spacing;
    this.timeDependent = poleIsTimeDependent(model);
    if (!this.timeDependent) {
      poleAt(model, 0, this.c, 0);
      this.k = 0;
    }
  }

  private node(k: number, o: number): void {
    const slot = k & (NODE_CACHE - 1);
    const v = this.nodeVal;
    const c = this.c;
    if (this.nodeKey[slot] !== k) {
      const t = k * this.spacing;
      poleAt(this.model, t, v, 6 * slot, this.tmp);
      v[6 * slot + 3] = this.spacing * this.tmp[0];
      v[6 * slot + 4] = this.spacing * this.tmp[1];
      v[6 * slot + 5] = this.spacing * this.tmp[2];
      this.nodeKey[slot] = k;
    }
    for (let i = 0; i < 6; i++) c[o + i] = v[6 * slot + i];
  }

  /** Unit pole at TDB t (s from J2000) into out[o..o+2]. */
  at(t: number, out: Float64Array | number[], o = 0): void {
    const c = this.c;
    if (!this.timeDependent) {
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      return;
    }
    if (this.spacing === 0) {
      poleAt(this.model, t, out, o);
      return;
    }
    const k = Math.floor(t / this.spacing);
    this.load(k);
    const s = (t - k * this.spacing) / this.spacing;
    const s1 = 1 - s;
    this.combine((1 + 2 * s) * s1 * s1, s * s1 * s1, s * s * (3 - 2 * s), -s * s * s1, out, o);
  }

  /** Make interval k current (node values from the cache or the series). */
  private load(k: number): void {
    const c = this.c;
    if (k !== this.k) {
      if (k === this.k + 1) {
        for (let i = 0; i < 6; i++) c[i] = c[6 + i];
        this.node(k + 1, 6);
      } else if (k === this.k - 1) {
        for (let i = 0; i < 6; i++) c[6 + i] = c[i];
        this.node(k, 0);
      } else {
        this.node(k, 0);
        this.node(k + 1, 6);
      }
      this.k = k;
    }
  }

  /** Hermite combination of the current interval, normalised. */
  private combine(h00: number, h10: number, h01: number, h11: number, out: Float64Array | number[], o: number): void {
    const c = this.c;
    const x = h00 * c[0] + h10 * c[3] + h01 * c[6] + h11 * c[9];
    const y = h00 * c[1] + h10 * c[4] + h01 * c[7] + h11 * c[10];
    const z = h00 * c[2] + h10 * c[5] + h01 * c[8] + h11 * c[11];
    const inv = 1 / Math.sqrt(x * x + y * y + z * z);
    out[o] = x * inv;
    out[o + 1] = y * inv;
    out[o + 2] = z * inv;
  }
}

/**
 * Poles of several tables with the same spacing at one time t, into
 * out[offsets[i]..+2]: the same arithmetic as PoleTable.at (bit-identical),
 * with the interval and the Hermite basis computed once for all tables.
 * Tables with spacing 0 or a constant pole are handled as by at().
 */
export function polesAt(tables: readonly PoleTable[], t: number, out: Float64Array, offsets: ArrayLike<number>): void {
  let k = NaN;
  let h00 = 0;
  let h10 = 0;
  let h01 = 0;
  let h11 = 0;
  let sp = NaN;
  for (let i = 0; i < tables.length; i++) {
    const tab = tables[i] as unknown as PoleTableInternals;
    if (!tab.timeDependent || tab.spacing === 0) {
      tables[i].at(t, out, offsets[i]);
      continue;
    }
    if (tab.spacing !== sp) {
      sp = tab.spacing;
      k = Math.floor(t / sp);
      const s = (t - k * sp) / sp;
      const s1 = 1 - s;
      h00 = (1 + 2 * s) * s1 * s1;
      h10 = s * s1 * s1;
      h01 = s * s * (3 - 2 * s);
      h11 = -s * s * s1;
    }
    tab.load(k);
    tab.combine(h00, h10, h01, h11, out, offsets[i]);
  }
}
interface PoleTableInternals {
  readonly timeDependent: boolean;
  readonly spacing: number;
  load(k: number): void;
  combine(h00: number, h10: number, h01: number, h11: number, out: Float64Array, o: number): void;
}
