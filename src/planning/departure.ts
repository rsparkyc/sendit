/**
 * From a porkchop point to a first-guess finite burn for the game's propagator,
 * and tools to fly it in the real N-body simulation and measure the result.
 *
 * Departure model: the escape hyperbola's periapsis is placed on the parking
 * orbit where the radius vector makes the hyperbola's asymptote angle with the
 * desired v-infinity direction s: r.s = cos(theta_inf) = -1/e, e = 1 + rp vinf^2/mu.
 * The hyperbola's plane is the one containing that radius and s, so an
 * asymptote out of the parking plane is reached with a small normal component
 * in the burn (the parking plane should contain s, as a launch at the right
 * time and azimuth arranges; see `parkingNormalForAsymptote`). The impulsive
 * time is found on the real (N-body) parking orbit, then a finite burn of the
 * same delta-v is centred on it, its direction fixed in the (prograde, normal,
 * radial-out) frame of the departure body.
 */
import type { BodyData } from '../physics/solar-system';
import { G0, propagate, type BodyOblateness, type Burn, type Ephemeris, type PropagateOptions } from '../physics/spacecraft';
import { findBody } from './bodies';
import { cross, dot, ECLIPTIC_POLE_ICRF, norm, scale, sub, unit, type ReadVec3, type Vec3 } from './kepler';

/**
 * Unit normal of a prograde parking plane of inclination `incl` (to the ICRF
 * equator) that contains direction s; null when |declination of s| > incl.
 * Of the two such planes this returns the one whose ascending node is east of
 * the other's (`which` = 0) or the other (1).
 */
export function parkingNormalForAsymptote(s: ReadVec3, incl: number, which: 0 | 1 = 0): Vec3 | null {
  const u = unit(s);
  const rho = Math.hypot(u[0], u[1]);
  const si = Math.sin(incl);
  const ci = Math.cos(incl);
  if (rho < 1e-12 || si < 1e-12) return null;
  const c = (-ci * u[2]) / (si * rho);
  if (Math.abs(c) > 1) return null;
  const alpha = Math.atan2(u[1], u[0]);
  const beta = alpha + (which === 0 ? 1 : -1) * Math.acos(c);
  return [si * Math.cos(beta), si * Math.sin(beta), ci];
}

/**
 * Barycentric state [x y z vx vy vz mass] of a circular orbit of radius r
 * about `body` at time t, in the plane with unit normal n, at in-plane angle
 * phase measured from the line n x z (ascending node; any fixed line if n is
 * along z).
 */
export function circularParkingState(ephem: Ephemeris, body: number, t: number, n: ReadVec3, r: number, phase: number, mass: number): Float64Array {
  const bs = new Float64Array(6);
  ephem.bodyState(body, t, bs);
  const nn = unit(n);
  let a = cross([0, 0, 1], nn);
  if (norm(a) < 1e-9) a = [1, 0, 0];
  a = unit(a);
  const b = cross(nn, a);
  const v = Math.sqrt(ephem.gm[body] / r);
  const c = Math.cos(phase);
  const s = Math.sin(phase);
  const out = new Float64Array(7);
  for (let k = 0; k < 3; k++) {
    out[k] = bs[k] + r * (c * a[k] + s * b[k]);
    out[3 + k] = bs[3 + k] + v * (-s * a[k] + c * b[k]);
  }
  out[6] = mass;
  return out;
}

export interface Engine {
  /** N. */
  thrust: number;
  /** s. */
  isp: number;
}

export interface DeparturePlanInput {
  departure: string;
  /** Desired departure v-infinity vector (ICRF, m/s), e.g. PorkchopPoint.vInfDepVec. */
  vInf: ReadVec3;
  /** Nominal departure time (porkchop departure date), s TDB. */
  tDep: number;
  /** Spacecraft barycentric state [x y z vx vy vz mass] in its parking orbit at t0. */
  parking: ArrayLike<number>;
  t0: number;
  engine: Engine;
  /** Options for the parking-orbit propagation used to locate the burn. */
  propagateOptions?: PropagateOptions;
}

export interface DeparturePlan {
  burn: Burn;
  /** Impulsive burn time, s TDB (centre of the finite burn). */
  tImpulse: number;
  /** Impulsive delta-v vector (ICRF, m/s) and its magnitude. */
  dv: Vec3;
  dvMag: number;
  /** Angle between the asymptote the impulsive hyperbola actually has and the requested one, rad (0 when reachable). */
  asymptoteError: number;
  /** Spacecraft barycentric state at tImpulse before the burn (on the real parking orbit). */
  stateAtImpulse: Float64Array;
}

/** Departure-body-relative position and velocity of a barycentric state. */
function relative(ephem: Ephemeris, body: number, t: number, y: ArrayLike<number>): { r: Vec3; v: Vec3 } {
  const bs = new Float64Array(6);
  ephem.bodyState(body, t, bs);
  return { r: [y[0] - bs[0], y[1] - bs[1], y[2] - bs[2]], v: [y[3] - bs[3], y[4] - bs[4], y[5] - bs[5]] };
}

/** Periapsis direction on the parking plane (normal h) for asymptote s and eccentricity e. */
function periapsisDirection(h: Vec3, ref: Vec3, s: Vec3, e: number): { p: Vec3; reachable: boolean } {
  const a = unit(ref);
  const b = cross(unit(h), a);
  const sa = dot(s, a);
  const sb = dot(s, b);
  const m = Math.hypot(sa, sb);
  const phiS = Math.atan2(sb, sa);
  const c = -1 / (e * m);
  const reachable = Math.abs(c) <= 1;
  // Periapsis lies theta_inf behind the asymptote's in-plane projection, in the direction of motion.
  const phi = phiS - (reachable ? Math.acos(c) : Math.PI);
  return { p: [Math.cos(phi) * a[0] + Math.sin(phi) * b[0], Math.cos(phi) * a[1] + Math.sin(phi) * b[1], Math.cos(phi) * a[2] + Math.sin(phi) * b[2]], reachable };
}

/** Plan the departure burn. See the module comment for the model. */
export function planDeparture(ephem: Ephemeris, bodies: readonly BodyData[], input: DeparturePlanInput): DeparturePlan {
  const body = findBody(bodies, input.departure);
  const mu = ephem.gm[body];
  const vinf = norm(input.vInf);
  const s = unit(input.vInf);
  const popts = { rtol: 1e-11, ...input.propagateOptions };

  // Phase on the parking orbit (real dynamics) at time t.
  let y: Float64Array = Float64Array.from(input.parking);
  let tY = input.t0;
  // `propagate` integrates forward only: restart from the given state when stepping back.
  const stateAt = (t: number): Float64Array => {
    if (t < input.t0) throw new Error('planDeparture: burn would fall before the parking state epoch t0; give an earlier t0');
    if (t < tY) {
      y = Float64Array.from(input.parking);
      tY = input.t0;
    }
    if (t > tY) {
      y = propagate(ephem, y, tY, t, [], popts).y;
      tY = t;
    }
    return y;
  };

  // Start from the parking pass nearest tDep: first locate the periapsis
  // direction at the parking state nearest tDep, then iterate on time.
  let t = input.tDep;
  let rel = relative(ephem, body, t, stateAt(t));
  for (let it = 0; it < 6; it++) {
    const h = cross(rel.r, rel.v);
    const rp = norm(rel.r);
    const e = 1 + (rp * vinf * vinf) / mu;
    const { p } = periapsisDirection(h, rel.r, s, e);
    // Signed angle from the current radius to p, in the direction of motion, in (-pi, pi].
    const rhat = unit(rel.r);
    const ang = Math.atan2(dot(cross(rhat, p), unit(h)), dot(rhat, p));
    const nMean = norm(rel.v) / rp; // angular rate on a near-circular orbit
    const dt = ang / nMean;
    if (Math.abs(dt) < 1e-3) break;
    t += dt;
    rel = relative(ephem, body, t, stateAt(t));
  }

  // Impulsive delta-v at t on the hyperbola through r containing s.
  const rp = norm(rel.r);
  const rhat = unit(rel.r);
  const e = 1 + (rp * vinf * vinf) / mu;
  let vdir = sub(s, scale(rhat, dot(s, rhat)));
  vdir = unit(vdir);
  const vp = Math.sqrt(vinf * vinf + (2 * mu) / rp);
  const vNew = scale(vdir, vp);
  const dv = sub(vNew, rel.v);
  const dvMag = norm(dv);
  // Asymptote actually produced: cos(th) r + sin(th) v-direction.
  const th = Math.acos(-1 / e);
  const sAct: Vec3 = [Math.cos(th) * rhat[0] + Math.sin(th) * vdir[0], Math.cos(th) * rhat[1] + Math.sin(th) * vdir[1], Math.cos(th) * rhat[2] + Math.sin(th) * vdir[2]];
  const asymptoteError = Math.acos(Math.max(-1, Math.min(1, dot(sAct, s))));

  // Finite burn via the rocket equation, centred on the impulsive time.
  const m0 = y[6];
  const ve = input.engine.isp * G0;
  const duration = ((m0 * ve) / input.engine.thrust) * (1 - Math.exp(-dvMag / ve));
  // Direction in the (prograde, normal, radial-out) frame at the impulsive point.
  const pg = unit(rel.v);
  const nm = unit(cross(rel.r, rel.v));
  const ro = cross(pg, nm);
  const burn: Burn = {
    tStart: t - duration / 2,
    duration,
    thrust: input.engine.thrust,
    isp: input.engine.isp,
    direction: [dot(dv, pg), dot(dv, nm), dot(dv, ro)],
    frame: { kind: 'orbital', body },
  };
  return { burn, tImpulse: t, dv, dvMag, asymptoteError, stateAtImpulse: Float64Array.from(y) };
}

export interface Encounter {
  /** Time and distance (m) of closest approach to the target within the searched span. */
  tClosest: number;
  closest: number;
  /** Distance to the target at the reference time, m. */
  distanceAtRef: number;
  /** Spacecraft minus target at the reference time (ICRF, m). */
  offsetAtRef: Vec3;
  /** B-plane (ecliptic reference) from the osculating hyperbola at `bPlaneTime`, m. NaN if not hyperbolic. */
  bt: number;
  br: number;
  /** Final barycentric state. */
  y: Float64Array;
}

/**
 * B-plane coordinates of a target-relative state (r, v) with T in the plane of
 * the reference pole (default: ecliptic pole), R = S x T. NaN if not hyperbolic.
 */
export function bPlane(r: ReadVec3, v: ReadVec3, mu: number, pole: ReadVec3 = ECLIPTIC_POLE_ICRF): { bt: number; br: number; vinf: number; dtPeri: number } {
  const h = cross(r, v);
  const rn = norm(r);
  const v2 = dot(v, v);
  const energy = v2 / 2 - mu / rn;
  if (!(energy > 0)) return { bt: NaN, br: NaN, vinf: NaN, dtPeri: NaN };
  const ev = sub(scale(r, v2 / mu - 1 / rn), scale(v, dot(r, v) / mu));
  const e = norm(ev);
  const hh = unit(h);
  // Time to periapsis on the osculating hyperbola (negative once past it).
  const aAbs = mu / (2 * energy);
  const coshF = (1 + rn / aAbs) / e;
  const F = Math.sign(dot(r, v)) * Math.acosh(Math.max(1, coshF));
  const dtPeri = -(e * Math.sinh(F) - F) / Math.sqrt(mu / (aAbs * aAbs * aAbs));
  const eh = scale(ev, 1 / e);
  const S = [...Array(3)].map((_, i) => eh[i] / e + (Math.sqrt(e * e - 1) / e) * cross(hh, eh)[i]) as Vec3;
  const a = -mu / (2 * energy);
  const bMag = -a * Math.sqrt(e * e - 1);
  const B = scale(cross(S, hh), bMag);
  const T = unit(cross(S, pole));
  const R = cross(S, T);
  return { bt: dot(B, T), br: dot(B, R), vinf: Math.sqrt(2 * energy), dtPeri };
}

export interface FlyOptions extends PropagateOptions {
  /** Look for closest approach only after this time. Default t0. */
  searchFrom?: number;
  /** Epoch for the osculating B-plane. Default: tRef - 3 days. */
  bPlaneTime?: number;
}

/**
 * Fly a state through burns in the real N-body model from t0 to tEnd and
 * measure the encounter with `target`: closest approach (dense-output search
 * inside every step), distance at tRef, and the osculating B-plane.
 */
export function flyToTarget(ephem: Ephemeris, target: number, y0: ArrayLike<number>, t0: number, tEnd: number, tRef: number, burns: readonly Burn[], opts: FlyOptions = {}): Encounter {
  const tb = new Float64Array(6);
  const tmp = new Float64Array(7);
  const searchFrom = opts.searchFrom ?? t0;
  const tB = opts.bPlaneTime ?? tRef - 3 * 86400;
  let best = Infinity;
  let tBest = NaN;
  let offset: Vec3 = [NaN, NaN, NaN];
  let bAt: { bt: number; br: number } = { bt: NaN, br: NaN };
  const dist = (t: number, interp: (t: number, o: Float64Array) => void): number => {
    interp(t, tmp);
    ephem.bodyState(target, t, tb);
    return Math.hypot(tmp[0] - tb[0], tmp[1] - tb[1], tmp[2] - tb[2]);
  };
  const res = propagate(ephem, y0, t0, tEnd, burns, {
    rtol: opts.rtol ?? 1e-11,
    dryMass: opts.dryMass,
    onStep: (t, _y, interp, tPrev) => {
      opts.onStep?.(t, _y, interp, tPrev);
      for (const tq of [tRef, tB]) {
        if (tq > tPrev && tq <= t) {
          interp(tq, tmp);
          ephem.bodyState(target, tq, tb);
          const r: Vec3 = [tmp[0] - tb[0], tmp[1] - tb[1], tmp[2] - tb[2]];
          if (tq === tRef) offset = r;
          if (tq === tB) bAt = bPlane(r, [tmp[3] - tb[3], tmp[4] - tb[4], tmp[5] - tb[5]], ephem.gm[target]);
        }
      }
      if (t < searchFrom) return;
      const a = Math.max(tPrev, searchFrom);
      // Sample, then golden-section refine around the best sample.
      const N = 8;
      let kBest = 0;
      let dBest = Infinity;
      for (let k = 0; k <= N; k++) {
        const d = dist(a + ((t - a) * k) / N, interp);
        if (d < dBest) { dBest = d; kBest = k; }
      }
      let lo = a + ((t - a) * Math.max(0, kBest - 1)) / N;
      let hi = a + ((t - a) * Math.min(N, kBest + 1)) / N;
      const g = (Math.sqrt(5) - 1) / 2;
      for (let i = 0; i < 40 && hi - lo > 1e-3; i++) {
        const m1 = hi - g * (hi - lo);
        const m2 = lo + g * (hi - lo);
        if (dist(m1, interp) < dist(m2, interp)) hi = m2; else lo = m1;
      }
      const tm = (lo + hi) / 2;
      const dm = Math.min(dist(tm, interp), dBest);
      if (dm < best) { best = dm; tBest = dm === dBest ? a + ((t - a) * kBest) / N : tm; }
    },
  });
  return { tClosest: tBest, closest: best, distanceAtRef: norm(offset), offsetAtRef: offset, bt: bAt.bt, br: bAt.br, y: res.y };
}

/**
 * An ephemeris identical to `base` except that the listed bodies exert no
 * gravity on the spacecraft (GM 0, no J2), optionally without the Sun's GR term.
 * Planning diagnostics only: used to split a miss distance into its causes.
 */
export class MaskedEphemeris implements Ephemeris {
  readonly count: number;
  readonly gm: Float64Array;
  readonly oblateness?: readonly (BodyOblateness | null)[];
  readonly relativity?: { readonly body: number };
  constructor(private readonly base: Ephemeris, silent: readonly number[], keepRelativity = true, keepOblateness = true) {
    this.count = base.count;
    this.gm = Float64Array.from(base.gm as ArrayLike<number>);
    for (const i of silent) this.gm[i] = 0;
    if (base.oblateness && keepOblateness) this.oblateness = Array.from(base.oblateness, (o, i) => (silent.includes(i) ? null : o));
    if (base.relativity && keepRelativity && !silent.includes(base.relativity.body)) this.relativity = base.relativity;
  }
  positions(t: number, out: Float64Array): void {
    this.base.positions(t, out);
  }
  bodyState(body: number, t: number, out: Float64Array): void {
    this.base.bodyState(body, t, out);
  }
}

/**
 * Osculating hyperbolic excess velocity of a barycentric state relative to
 * `body` (two-body about that body): magnitude and outgoing asymptote direction.
 * NaN if not hyperbolic.
 */
export function osculatingVInf(ephem: Ephemeris, body: number, t: number, y: ArrayLike<number>): { vinf: number; dir: Vec3 } {
  const { r, v } = relative(ephem, body, t, y);
  const mu = ephem.gm[body];
  const rn = norm(r);
  const v2 = dot(v, v);
  const energy = v2 / 2 - mu / rn;
  if (!(energy > 0)) return { vinf: NaN, dir: [NaN, NaN, NaN] };
  const ev = sub(scale(r, v2 / mu - 1 / rn), scale(v, dot(r, v) / mu));
  const e = norm(ev);
  const eh = scale(ev, 1 / e);
  const hh = unit(cross(r, v));
  const q = cross(hh, eh);
  // Outgoing asymptote: true anomaly +theta_inf, cos = -1/e.
  const c = -1 / e;
  const sn = Math.sqrt(1 - c * c);
  return { vinf: Math.sqrt(2 * energy), dir: [c * eh[0] + sn * q[0], c * eh[1] + sn * q[1], c * eh[2] + sn * q[2]] };
}
