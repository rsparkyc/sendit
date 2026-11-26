/**
 * Flyby chaining aid: for a body sequence and encounter dates, solve the
 * zero-revolution Lambert legs (planet centre to planet centre, from the real
 * ephemeris) and judge each intermediate flyby.
 *
 * At each flyby body:
 *  - vInfIn / vInfOut: incoming and outgoing hyperbolic excess vectors;
 *  - mismatch = |vInfOut| - |vInfIn| (a ballistic flyby cannot change it);
 *  - turn angle between them;
 *  - rpBallistic: periapsis radius a ballistic flyby with |vInfIn| needs for
 *    that turn, sin(delta/2) = 1/(1 + rp vinf^2/mu);
 *  - rpPowered / periapsisDv: the standard powered-flyby model (turn =
 *    asin(1/e_in) + asin(1/e_out), impulse at periapsis to change the speed),
 *    which is what the mismatch would actually cost;
 *  - flags when a radius is below the surface or the minimum flyby altitude
 *    (top of atmosphere, MIN_FLYBY_ALTITUDE).
 *
 * `optimizeChain` searches encounter dates (deterministic; see its comment for
 * how good it is).
 */
import type { BodyData } from '../physics/solar-system';
import type { Ephemeris } from '../physics/spacecraft';
import { findBody, minFlybyAltitude } from './bodies';
import { captureDv, departureDv, ECLIPTIC_POLE_ICRF, type Vec3 } from './kepler';
import { lambertInto } from './lambert';
import type { ArrivalOrbit } from './porkchop';

export interface ChainOptions {
  central?: string;
  /** Departure parking orbit altitude, m. Default 200 km. */
  parkingAltitude?: number;
  /** Final arrival. Default flyby (no burn). */
  arrivalOrbit?: ArrivalOrbit;
}

export interface FlybyReport {
  body: string;
  t: number;
  vInfIn: Vec3;
  vInfOut: Vec3;
  vInfInMag: number;
  vInfOutMag: number;
  /** |vInfOut| - |vInfIn|, m/s. */
  mismatch: number;
  /** Required turn, rad. */
  turnAngle: number;
  /** Periapsis radius for a ballistic flyby at |vInfIn|, m (0 if the turn is >= 180 deg). */
  rpBallistic: number;
  /** Periapsis radius in the powered-flyby model, m. */
  rpPowered: number;
  /** Periapsis burn in the powered-flyby model, m/s. */
  periapsisDv: number;
  /** Body radius and the minimum safe radius (radius + atmosphere), m. */
  radius: number;
  minRadius: number;
  ballisticBelowSurface: boolean;
  ballisticBelowMin: boolean;
  poweredBelowSurface: boolean;
  poweredBelowMin: boolean;
}

export interface ChainResult {
  ok: boolean;
  legs: { from: string; to: string; t0: number; t1: number; v1: Vec3; v2: Vec3 }[];
  departureVInf: Vec3;
  c3: number;
  departureDv: number;
  flybys: FlybyReport[];
  arrivalVInf: number;
  arrivalDv: number;
  /** departureDv + sum |mismatch| + arrivalDv, m/s. */
  totalDv: number;
  /** totalDv + altitude penalty (see `chainCost`), m/s. */
  cost: number;
}

/** Penalty per unit fraction of the minimum radius that a powered flyby dips below it, m/s. */
export const ALTITUDE_PENALTY = 10e3;

function powered(vin: number, vout: number, mu: number, delta: number): number {
  // f(rp) = asin(1/e_in) + asin(1/e_out) decreases from pi (rp -> 0) to 0.
  if (delta >= Math.PI) return 0;
  if (delta <= 0) return Infinity;
  const f = (rp: number) => Math.asin(1 / (1 + (rp * vin * vin) / mu)) + Math.asin(1 / (1 + (rp * vout * vout) / mu));
  let lo = 1e-6 * mu / Math.max(vin * vin, vout * vout);
  let hi = lo;
  while (f(hi) > delta && hi < 1e30) hi *= 4;
  for (let i = 0; i < 200 && hi / lo > 1 + 1e-13; i++) {
    const mid = Math.sqrt(lo * hi);
    if (f(mid) > delta) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

/** Evaluate a chain at fixed encounter times. */
export function evaluateChain(ephem: Ephemeris, bodies: readonly BodyData[], seq: readonly string[], times: readonly number[], opts: ChainOptions = {}): ChainResult {
  if (seq.length < 2 || seq.length !== times.length) throw new Error('need >= 2 bodies and one time per body');
  const idx = seq.map((s) => findBody(bodies, s));
  const cen = findBody(bodies, opts.central ?? 'sun');
  const mu = ephem.gm[cen];
  const st: Float64Array[] = [];
  const tmp = new Float64Array(6);
  for (let i = 0; i < seq.length; i++) {
    const s = new Float64Array(6);
    ephem.bodyState(idx[i], times[i], s);
    ephem.bodyState(cen, times[i], tmp);
    for (let k = 0; k < 6; k++) s[k] -= tmp[k];
    st.push(s);
  }
  const buf = new Float64Array(6);
  const legs: ChainResult['legs'] = [];
  let ok = true;
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = st[i];
    const b = st[i + 1];
    const n = times[i + 1] > times[i] ? lambertInto(a[0], a[1], a[2], b[0], b[1], b[2], times[i + 1] - times[i], mu, buf, false, 0, ECLIPTIC_POLE_ICRF) : 0;
    if (n === 0) {
      ok = false;
      buf.fill(NaN);
    }
    legs.push({ from: bodies[idx[i]].id, to: bodies[idx[i + 1]].id, t0: times[i], t1: times[i + 1], v1: [buf[0], buf[1], buf[2]], v2: [buf[3], buf[4], buf[5]] });
  }
  const vinf = (v: Vec3, s: Float64Array): Vec3 => [v[0] - s[3], v[1] - s[4], v[2] - s[5]];
  const mag = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
  const dep = idx[0];
  const depV = vinf(legs[0].v1, st[0]);
  const depVm = mag(depV);
  const dvDep = departureDv(depVm, ephem.gm[dep], bodies[dep].radius + (opts.parkingAltitude ?? 200e3));
  const flybys: FlybyReport[] = [];
  let mismatchSum = 0;
  let penalty = 0;
  for (let i = 1; i + 1 < seq.length; i++) {
    const b = idx[i];
    const muB = ephem.gm[b];
    const vin = vinf(legs[i - 1].v2, st[i]);
    const vout = vinf(legs[i].v1, st[i]);
    const a = mag(vin);
    const c = mag(vout);
    const turn = Math.acos(Math.max(-1, Math.min(1, (vin[0] * vout[0] + vin[1] * vout[1] + vin[2] * vout[2]) / (a * c))));
    const s2 = Math.sin(turn / 2);
    const rpB = s2 > 0 ? (muB / (a * a)) * (1 / s2 - 1) : Infinity;
    const rpP = powered(a, c, muB, turn);
    const pdv = Number.isFinite(rpP) ? Math.abs(Math.sqrt(c * c + (2 * muB) / rpP) - Math.sqrt(a * a + (2 * muB) / rpP)) : Math.abs(c - a);
    const R = bodies[b].radius;
    const Rmin = R + minFlybyAltitude(bodies[b]);
    mismatchSum += Math.abs(c - a);
    if (!(rpP >= Rmin)) penalty += (ALTITUDE_PENALTY * (Rmin - (Number.isFinite(rpP) ? rpP : 0))) / Rmin;
    flybys.push({
      body: bodies[b].id, t: times[i], vInfIn: vin, vInfOut: vout, vInfInMag: a, vInfOutMag: c,
      mismatch: c - a, turnAngle: turn, rpBallistic: rpB, rpPowered: rpP, periapsisDv: pdv,
      radius: R, minRadius: Rmin,
      ballisticBelowSurface: rpB < R, ballisticBelowMin: rpB < Rmin,
      poweredBelowSurface: rpP < R, poweredBelowMin: rpP < Rmin,
    });
  }
  const last = seq.length - 1;
  const arrV = mag(vinf(legs[last - 1].v2, st[last]));
  const ao = opts.arrivalOrbit ?? { kind: 'flyby' };
  const arrB = idx[last];
  const dvArr = ao.kind === 'flyby' ? 0 : captureDv(arrV, ephem.gm[arrB], bodies[arrB].radius + ao.altitude, ao.eccentricity ?? 0);
  const totalDv = dvDep + mismatchSum + dvArr;
  return {
    ok, legs, departureVInf: depV, c3: depVm * depVm, departureDv: dvDep, flybys,
    arrivalVInf: arrV, arrivalDv: dvArr, totalDv,
    cost: ok && Number.isFinite(totalDv) ? totalDv + penalty : Infinity,
  };
}

export interface ChainSearch {
  /** Window for each encounter time (s TDB), same length as the sequence. */
  windows: readonly { start: number; end: number }[];
  /** Quasi-random samples for the global stage. Default 4000. */
  samples?: number;
  /** Local refinements started from the best distinct samples. Default 8. */
  starts?: number;
  /** Nelder-Mead iterations per start. Default 400. */
  iterations?: number;
}

export interface ChainSearchResult {
  times: number[];
  result: ChainResult;
  evaluations: number;
}

/** Radical inverse in base b (Halton sequence). */
function halton(i: number, b: number): number {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}
const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37];

/**
 * Minimise `cost` (= departure delta-v + sum of flyby v-infinity mismatches +
 * arrival delta-v + altitude penalty) over the encounter dates of a fixed
 * sequence.
 *
 * Method: a Halton low-discrepancy sample of the date box (global stage), then
 * bounded Nelder-Mead from the `starts` best samples that are at least 5% of
 * the box apart. Fully deterministic for given inputs (no random numbers).
 *
 * How good it is: a heuristic multi-start, not a global optimiser with any
 * guarantee. Gravity-assist landscapes are strongly multimodal; with 4 dates
 * and 4000 samples the sample spacing is ~1/8 of each window, so basins
 * narrower than that can be missed, and Nelder-Mead stalls on the Lambert
 * cost's ridges (near-180 deg legs). Only zero-revolution legs are considered,
 * so resonant returns (e.g. Earth-Earth after exactly 1 or 2 years) and
 * deep-space manoeuvres are out of reach. Use it to tell plausible sequences
 * from implausible ones and to seed refinement, not as the final answer.
 */
export function optimizeChain(ephem: Ephemeris, bodies: readonly BodyData[], seq: readonly string[], search: ChainSearch, opts: ChainOptions = {}): ChainSearchResult {
  const n = seq.length;
  if (search.windows.length !== n) throw new Error('one window per encounter');
  const lo = search.windows.map((w) => w.start);
  const span = search.windows.map((w) => w.end - w.start);
  let evaluations = 0;
  const toTimes = (u: readonly number[]) => u.map((x, i) => lo[i] + Math.min(1, Math.max(0, x)) * span[i]);
  const f = (u: readonly number[]): number => {
    evaluations++;
    const t = toTimes(u);
    for (let i = 1; i < n; i++) if (!(t[i] > t[i - 1])) return Infinity;
    return evaluateChain(ephem, bodies, seq, t, opts).cost;
  };

  // Global stage.
  const N = search.samples ?? 4000;
  const pool: { u: number[]; c: number }[] = [];
  for (let k = 1; k <= N; k++) {
    const u = Array.from({ length: n }, (_, i) => (span[i] > 0 ? halton(k, PRIMES[i % PRIMES.length]) : 0));
    const c = f(u);
    if (Number.isFinite(c)) pool.push({ u, c });
  }
  pool.sort((a, b) => a.c - b.c);
  const starts: number[][] = [];
  for (const p of pool) {
    if (starts.length >= (search.starts ?? 8)) break;
    if (starts.every((s) => Math.max(...s.map((x, i) => Math.abs(x - p.u[i]))) > 0.05)) starts.push(p.u);
  }

  // Local stage: bounded Nelder-Mead in the unit box.
  let best: { u: number[]; c: number } = pool[0] ?? { u: Array(n).fill(0.5), c: Infinity };
  const iters = search.iterations ?? 400;
  for (const s of starts) {
    const r = nelderMead(f, s, 0.03, iters);
    if (r.c < best.c) best = r;
  }
  const times = toTimes(best.u);
  return { times, result: evaluateChain(ephem, bodies, seq, times, opts), evaluations };
}

function nelderMead(f: (u: number[]) => number, x0: number[], step: number, iters: number): { u: number[]; c: number } {
  const n = x0.length;
  const clamp = (u: number[]) => u.map((x) => Math.min(1, Math.max(0, x)));
  let simplex: { u: number[]; c: number }[] = [{ u: x0, c: f(x0) }];
  for (let i = 0; i < n; i++) {
    const u = x0.slice();
    u[i] += u[i] + step <= 1 ? step : -step;
    simplex.push({ u, c: f(u) });
  }
  for (let it = 0; it < iters; it++) {
    simplex.sort((a, b) => a.c - b.c);
    const bestC = simplex[0].c;
    const worst = simplex[n];
    if (Math.abs(worst.c - bestC) < 1e-3 && simplex.every((p) => p.u.every((x, i) => Math.abs(x - simplex[0].u[i]) < 1e-7))) break;
    const cen = Array(n).fill(0);
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) cen[i] += simplex[k].u[i] / n;
    const pt = (a: number) => clamp(cen.map((c, i) => c + a * (worst.u[i] - c)));
    const r = pt(-1);
    const fr = f(r);
    if (fr < simplex[0].c) {
      const e = pt(-2);
      const fe = f(e);
      simplex[n] = fe < fr ? { u: e, c: fe } : { u: r, c: fr };
    } else if (fr < simplex[n - 1].c) {
      simplex[n] = { u: r, c: fr };
    } else {
      const k = pt(fr < worst.c ? -0.5 : 0.5);
      const fk = f(k);
      if (fk < Math.min(fr, worst.c)) {
        simplex[n] = { u: k, c: fk };
      } else {
        const b = simplex[0].u;
        simplex = simplex.map((p, idx) => {
          if (idx === 0) return p;
          const u = b.map((x, i) => x + 0.5 * (p.u[i] - x));
          return { u, c: f(u) };
        });
      }
    }
  }
  simplex.sort((a, b) => a.c - b.c);
  return simplex[0];
}
