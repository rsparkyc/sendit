/**
 * Porkchop plots: departure/arrival-date grids of Lambert transfers between two
 * bodies, with body states from the game's real ephemeris.
 *
 * Model: heliocentric (or about any `central` body) two-body conic between the
 * centres of the two bodies; departure v-infinity = transfer velocity minus the
 * departure body's velocity, both relative to the central body. The planet's
 * own gravity, finite burns and third bodies are ignored here; the result is a
 * first guess to refine against the N-body simulation (see departure.ts).
 *
 * Output: one Float64Array per quantity, row-major with the DEPARTURE index
 * fastest: cell (i, j) = departure i, arrival (or flight-time) j is at
 * j*nDep + i, i.e. x = departure, y = arrival as usually drawn. Cells with no
 * solution (arrival before departure, solver failure) hold NaN.
 *
 * Work is split into rows so a Web Worker can report progress and cancel:
 * `PorkchopJob.step(cells)` computes up to that many more cells.
 */
import type { BodyData } from '../physics/solar-system';
import type { Ephemeris } from '../physics/spacecraft';
import { findBody } from './bodies';
import { captureDv, departureDv, ECLIPTIC_POLE_ICRF } from './kepler';
import { lambertInto } from './lambert';

export interface TimeRange {
  /** First sample, s TDB from J2000. */
  start: number;
  /** Last sample (inclusive). */
  end: number;
  count: number;
}

export type ArrivalOrbit =
  /** Capture burn at periapsis altitude into an orbit of eccentricity e (0 circular). */
  | { kind: 'capture'; altitude: number; eccentricity?: number }
  /** Flyby / atmospheric entry: no arrival burn. */
  | { kind: 'flyby' };

export interface PorkchopSpec {
  /** Body id or name. */
  departure: string;
  arrival: string;
  /** Central body for the conic. Default 'sun'. */
  central?: string;
  departureTimes: TimeRange;
  /** Absolute arrival dates ... */
  arrivalTimes?: TimeRange;
  /** ... or flight times (s); exactly one of the two. */
  flightTimes?: TimeRange;
  /** Circular parking orbit altitude at departure, m. Default 200 km. */
  parkingAltitude?: number;
  /** Default: capture into a circular orbit at 300 km. */
  arrivalOrbit?: ArrivalOrbit;
  /** Largest revolution count; the cheapest solution (by total delta-v) is kept. Default 0. */
  maxRevs?: number;
  retrograde?: boolean;
}

export interface PorkchopGrid {
  nDep: number;
  nArr: number;
  /** Departure times, s TDB (length nDep). */
  depTimes: Float64Array;
  /** Arrival times (arrival-date mode) or flight times (flight-time mode), length nArr. */
  yValues: Float64Array;
  yMode: 'arrival' | 'flightTime';
  /** Characteristic energy at departure, m^2/s^2 (= vInfDep^2). */
  c3: Float64Array;
  /** Hyperbolic excess speeds, m/s. */
  vInfDep: Float64Array;
  vInfArr: Float64Array;
  /** Delta-v estimates, m/s: parking-orbit escape, arrival capture (0 for flyby), and their sum. */
  dvDep: Float64Array;
  dvArr: Float64Array;
  dvTotal: Float64Array;
  /** Departure asymptote declination and right ascension in ICRF (Earth-equatorial J2000), rad. */
  dla: Float64Array;
  rla: Float64Array;
  /** Flight time, s. */
  tof: Float64Array;
  /** Revolutions of the chosen solution. */
  revs: Int8Array;
  /** Heliocentric transfer angle in [0, 2pi), prograde sense: < pi is Type I, > pi Type II. */
  theta: Float64Array;
}

/** One fully evaluated cell (used for picking a point). */
export interface PorkchopPoint {
  tDep: number;
  tArr: number;
  /** Departure and arrival body states relative to the central body. */
  rDep: [number, number, number];
  vDepBody: [number, number, number];
  rArr: [number, number, number];
  vArrBody: [number, number, number];
  /** Transfer velocities relative to the central body. */
  v1: [number, number, number];
  v2: [number, number, number];
  vInfDepVec: [number, number, number];
  vInfArrVec: [number, number, number];
  c3: number;
  dvDep: number;
  dvArr: number;
  dla: number;
  rla: number;
  revs: number;
}

function samples(r: TimeRange): Float64Array {
  if (!(r.count >= 1)) throw new Error('time range count must be >= 1');
  const out = new Float64Array(r.count);
  for (let i = 0; i < r.count; i++) out[i] = r.count === 1 ? r.start : r.start + ((r.end - r.start) * i) / (r.count - 1);
  return out;
}

/** State of `body` relative to `central` at t, into out[0..5]. */
function relState(ephem: Ephemeris, body: number, central: number, t: number, tmp: Float64Array, out: Float64Array, o: number): void {
  ephem.bodyState(body, t, tmp);
  for (let k = 0; k < 6; k++) out[o + k] = tmp[k];
  ephem.bodyState(central, t, tmp);
  for (let k = 0; k < 6; k++) out[o + k] -= tmp[k];
}

export class PorkchopJob {
  readonly grid: PorkchopGrid;
  readonly total: number;
  private done = 0;
  private readonly depIdx: number;
  private readonly arrIdx: number;
  private readonly cenIdx: number;
  private readonly mu: number;
  private readonly muDep: number;
  private readonly muArr: number;
  private readonly rPark: number;
  private readonly rCap: number;
  private readonly eCap: number;
  private readonly flyby: boolean;
  private readonly maxRevs: number;
  private readonly retro: boolean;
  /** Departure body states (6 per departure time). */
  private readonly depStates: Float64Array;
  /** Arrival body states per arrival time (arrival-date mode only). */
  private readonly arrStates: Float64Array | null;
  private readonly tmp = new Float64Array(6);
  private readonly arrState = new Float64Array(6);
  private readonly sol: Float64Array;

  constructor(private readonly ephem: Ephemeris, bodies: readonly BodyData[], spec: PorkchopSpec) {
    if ((spec.arrivalTimes === undefined) === (spec.flightTimes === undefined)) {
      throw new Error('give exactly one of arrivalTimes or flightTimes');
    }
    this.depIdx = findBody(bodies, spec.departure);
    this.arrIdx = findBody(bodies, spec.arrival);
    this.cenIdx = findBody(bodies, spec.central ?? 'sun');
    this.mu = ephem.gm[this.cenIdx];
    this.muDep = ephem.gm[this.depIdx];
    this.muArr = ephem.gm[this.arrIdx];
    this.rPark = bodies[this.depIdx].radius + (spec.parkingAltitude ?? 200e3);
    const ao = spec.arrivalOrbit ?? { kind: 'capture', altitude: 300e3 };
    this.flyby = ao.kind === 'flyby';
    this.rCap = bodies[this.arrIdx].radius + (ao.kind === 'capture' ? ao.altitude : 0);
    this.eCap = ao.kind === 'capture' ? (ao.eccentricity ?? 0) : 0;
    this.maxRevs = Math.max(0, Math.floor(spec.maxRevs ?? 0));
    this.retro = spec.retrograde ?? false;
    this.sol = new Float64Array(6 * (1 + 2 * this.maxRevs));

    const depTimes = samples(spec.departureTimes);
    const yMode = spec.arrivalTimes ? 'arrival' : 'flightTime';
    const yValues = samples((spec.arrivalTimes ?? spec.flightTimes)!);
    const nDep = depTimes.length;
    const nArr = yValues.length;
    const n = nDep * nArr;
    const f = () => new Float64Array(n).fill(NaN);
    this.grid = {
      nDep, nArr, depTimes, yValues, yMode,
      c3: f(), vInfDep: f(), vInfArr: f(), dvDep: f(), dvArr: f(), dvTotal: f(), dla: f(), rla: f(), tof: f(), theta: f(),
      revs: new Int8Array(n),
    };
    this.total = n;
    this.depStates = new Float64Array(6 * nDep);
    for (let i = 0; i < nDep; i++) relState(ephem, this.depIdx, this.cenIdx, depTimes[i], this.tmp, this.depStates, 6 * i);
    if (yMode === 'arrival') {
      this.arrStates = new Float64Array(6 * nArr);
      for (let j = 0; j < nArr; j++) relState(ephem, this.arrIdx, this.cenIdx, yValues[j], this.tmp, this.arrStates, 6 * j);
    } else {
      this.arrStates = null;
    }
  }

  get completed(): number {
    return this.done;
  }

  get finished(): boolean {
    return this.done >= this.total;
  }

  /** Compute up to `maxCells` more cells. Returns true when the grid is complete. */
  step(maxCells: number): boolean {
    const g = this.grid;
    const end = Math.min(this.total, this.done + Math.max(1, Math.floor(maxCells)));
    const sol = this.sol;
    const ds = this.depStates;
    for (let c = this.done; c < end; c++) {
      const i = c % g.nDep;
      const j = (c - i) / g.nDep;
      const tDep = g.depTimes[i];
      let tArr: number;
      let as: Float64Array;
      let ao: number;
      if (this.arrStates !== null) {
        tArr = g.yValues[j];
        as = this.arrStates;
        ao = 6 * j;
      } else {
        tArr = tDep + g.yValues[j];
        relState(this.ephem, this.arrIdx, this.cenIdx, tArr, this.tmp, this.arrState, 0);
        as = this.arrState;
        ao = 0;
      }
      const tof = tArr - tDep;
      if (!(tof > 0)) continue;
      const d = 6 * i;
      const ns = lambertInto(ds[d], ds[d + 1], ds[d + 2], as[ao], as[ao + 1], as[ao + 2], tof, this.mu, sol, this.retro, this.maxRevs, ECLIPTIC_POLE_ICRF);
      if (ns > 0) {
        const r1x = ds[d], r1y = ds[d + 1], r1z = ds[d + 2];
        const r2x = as[ao], r2y = as[ao + 1], r2z = as[ao + 2];
        const cx = r1y * r2z - r1z * r2y, cy = r1z * r2x - r1x * r2z, cz = r1x * r2y - r1y * r2x;
        const sinT = Math.sqrt(cx * cx + cy * cy + cz * cz);
        const cosT = r1x * r2x + r1y * r2y + r1z * r2z;
        let th = Math.atan2(sinT, cosT);
        const up = cx * ECLIPTIC_POLE_ICRF[0] + cy * ECLIPTIC_POLE_ICRF[1] + cz * ECLIPTIC_POLE_ICRF[2];
        if ((up < 0) !== this.retro) th = 2 * Math.PI - th;
        g.theta[c] = th;
      }
      let best = Infinity;
      for (let k = 0; k < ns; k++) {
        const o = 6 * k;
        const ex = sol[o] - ds[d + 3], ey = sol[o + 1] - ds[d + 4], ez = sol[o + 2] - ds[d + 5];
        const ax = sol[o + 3] - as[ao + 3], ay = sol[o + 4] - as[ao + 4], az = sol[o + 5] - as[ao + 5];
        const c3 = ex * ex + ey * ey + ez * ez;
        const vd = Math.sqrt(c3);
        const va = Math.sqrt(ax * ax + ay * ay + az * az);
        const dvD = departureDv(vd, this.muDep, this.rPark);
        const dvA = this.flyby ? 0 : captureDv(va, this.muArr, this.rCap, this.eCap);
        if (dvD + dvA < best) {
          best = dvD + dvA;
          g.c3[c] = c3;
          g.vInfDep[c] = vd;
          g.vInfArr[c] = va;
          g.dvDep[c] = dvD;
          g.dvArr[c] = dvA;
          g.dvTotal[c] = dvD + dvA;
          g.dla[c] = vd > 0 ? Math.asin(ez / vd) : NaN;
          let ra = Math.atan2(ey, ex);
          if (ra < 0) ra += 2 * Math.PI;
          g.rla[c] = ra;
          g.tof[c] = tof;
          g.revs[c] = k === 0 ? 0 : Math.ceil(k / 2);
        }
      }
    }
    this.done = end;
    return this.finished;
  }

  /**
   * Re-solve one (departure, arrival) pair at full detail, e.g. for a clicked
   * point. Times need not be on the grid. Picks the cheapest solution as the grid does.
   */
  point(tDep: number, tArr: number): PorkchopPoint | null {
    const a = new Float64Array(6);
    const b = new Float64Array(6);
    relState(this.ephem, this.depIdx, this.cenIdx, tDep, this.tmp, a, 0);
    relState(this.ephem, this.arrIdx, this.cenIdx, tArr, this.tmp, b, 0);
    const ns = tArr > tDep ? lambertInto(a[0], a[1], a[2], b[0], b[1], b[2], tArr - tDep, this.mu, this.sol, this.retro, this.maxRevs, ECLIPTIC_POLE_ICRF) : 0;
    let best: PorkchopPoint | null = null;
    for (let k = 0; k < ns; k++) {
      const o = 6 * k;
      const v1: [number, number, number] = [this.sol[o], this.sol[o + 1], this.sol[o + 2]];
      const v2: [number, number, number] = [this.sol[o + 3], this.sol[o + 4], this.sol[o + 5]];
      const e: [number, number, number] = [v1[0] - a[3], v1[1] - a[4], v1[2] - a[5]];
      const f: [number, number, number] = [v2[0] - b[3], v2[1] - b[4], v2[2] - b[5]];
      const c3 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
      const vd = Math.sqrt(c3);
      const va = Math.sqrt(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]);
      const dvDep = departureDv(vd, this.muDep, this.rPark);
      const dvArr = this.flyby ? 0 : captureDv(va, this.muArr, this.rCap, this.eCap);
      if (best !== null && dvDep + dvArr >= best.dvDep + best.dvArr) continue;
      let rla = Math.atan2(e[1], e[0]);
      if (rla < 0) rla += 2 * Math.PI;
      best = {
        tDep, tArr,
        rDep: [a[0], a[1], a[2]], vDepBody: [a[3], a[4], a[5]],
        rArr: [b[0], b[1], b[2]], vArrBody: [b[3], b[4], b[5]],
        v1, v2, vInfDepVec: e, vInfArrVec: f, c3, dvDep, dvArr,
        dla: Math.asin(e[2] / vd), rla, revs: k === 0 ? 0 : Math.ceil(k / 2),
      };
    }
    return best;
  }
}

/** Compute a whole grid synchronously. */
export function computePorkchop(ephem: Ephemeris, bodies: readonly BodyData[], spec: PorkchopSpec): PorkchopGrid {
  const job = new PorkchopJob(ephem, bodies, spec);
  job.step(job.total);
  return job.grid;
}

export interface AsyncOptions {
  /** Cells per chunk between yields. Default 2000 (~1-2 ms). */
  chunk?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Compute a grid in chunks, yielding to the event loop between them so a Web
 * Worker can process a cancel message (abort the signal) and post progress.
 * Rejects with the signal's reason when aborted.
 */
export async function computePorkchopAsync(ephem: Ephemeris, bodies: readonly BodyData[], spec: PorkchopSpec, opts: AsyncOptions = {}): Promise<PorkchopGrid> {
  const job = new PorkchopJob(ephem, bodies, spec);
  const chunk = opts.chunk ?? 2000;
  for (;;) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    const fin = job.step(chunk);
    opts.onProgress?.(job.completed, job.total);
    if (fin) return job.grid;
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

/** Index and value of the smallest finite entry of `field`. */
export function gridMinimum(field: ArrayLike<number>): { index: number; value: number } {
  let index = -1;
  let value = Infinity;
  for (let k = 0; k < field.length; k++) {
    if (field[k] < value) {
      value = field[k];
      index = k;
    }
  }
  return { index, value };
}
