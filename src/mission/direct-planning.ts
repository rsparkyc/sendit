/**
 * Planning aids for direct injection: ADVISORY, ordinary Math allowed (not
 * part of a replay). The direct-injection analogue of launch.ts
 * planeCrossings / asymptotePlaneNormals.
 *
 * GEOMETRY. A direct ascent leaves the site direction u (at liftoff) and
 * travels in the launch plane: burnout is `downrange` rad along the plane,
 * and the departure conic's apsides and asymptote are fixed angles further
 * on (departureGeometry). So the direction the flight departs in is the site
 * direction rotated by a fixed in-plane angle phi. For it to point at a
 * target direction s, the angle between u(t) and s must equal phi (folded
 * into [0, pi]); the azimuth then follows. The site direction sweeps a
 * circle of constant declination once per sidereal day, so this happens at
 * (at most) two instants a day: the launch window is INSTANTANEOUS, and its
 * width is how fast the angle error grows (directAimError) against what the
 * flight can absorb. A parking orbit removes the constraint: the departure
 * burn can be placed anywhere around the orbit, so only the plane must
 * contain s, which any liftoff time allows given an azimuth (bounded by the
 * range corridor; parkingWindow).
 */
import { ASCENT_BODIES, computeDirectAscent, type DirectAscentOk, type DirectBurnout } from './ascent';
import { DEG } from '../physics/dmath';
import { bodyIndex, type BodyData } from '../physics/solar-system';
import type { Ephemeris } from '../physics/spacecraft';
import { azimuthAllowed, launchGeometry, siteFrame, type LaunchSite } from './launch';
import type { Stage } from './plan';

type V3 = [number, number, number];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: readonly number[]): V3 => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };
const angleBetween = (a: readonly number[], b: readonly number[]) => Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));

export interface DepartureGeometry {
  readonly eccentricity: number;
  /** True anomaly of burnout, rad (> 0: burnout after perigee, climbing). */
  readonly burnoutTrueAnomaly: number;
  /** In-plane angles from the liftoff site direction, rad. */
  readonly perigeeAngle: number;
  /** Ellipse: the apoapsis; NaN for a hyperbola. */
  readonly apoapsisAngle: number;
  /** Hyperbola: the outgoing asymptote; NaN for an ellipse. */
  readonly asymptoteAngle: number;
  /** Ellipse: apoapsis radius, m. */
  readonly apoapsisRadius: number;
  /** Ellipse: time from burnout to apoapsis, s. */
  readonly timeToApoapsis: number;
  /** Hyperbola: v_inf, m/s. */
  readonly vInfinity: number;
  readonly perigeeRadius: number;
}

/** Conic of a direct-injection burnout about a body (gm, radius altitudes are measured from). */
export function departureGeometry(b: DirectBurnout, gm: number, radius: number): DepartureGeometry {
  const r = radius + b.altitudeM;
  const h = r * b.horizontalSpeed;
  const p = (h * h) / gm;
  const ec = p / r - 1;
  const es = (h * b.radialSpeed) / gm;
  const e = Math.hypot(ec, es);
  const nu = Math.atan2(es, ec);
  const perigeeAngle = b.downrange - nu;
  const v2 = b.horizontalSpeed ** 2 + b.radialSpeed ** 2;
  const energy = v2 / 2 - gm / r;
  if (e < 1) {
    const a = -gm / (2 * energy);
    const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2));
    const M = E - e * Math.sin(E);
    const n = Math.sqrt(gm / (a * a * a));
    return { eccentricity: e, burnoutTrueAnomaly: nu, perigeeAngle, apoapsisAngle: perigeeAngle + Math.PI, asymptoteAngle: NaN, apoapsisRadius: a * (1 + e), timeToApoapsis: (Math.PI - M) / n, vInfinity: NaN, perigeeRadius: p / (1 + e) };
  }
  return { eccentricity: e, burnoutTrueAnomaly: nu, perigeeAngle, apoapsisAngle: NaN, asymptoteAngle: perigeeAngle + Math.acos(-1 / e), apoapsisRadius: Infinity, timeToApoapsis: NaN, vInfinity: Math.sqrt(2 * energy), perigeeRadius: p / (1 + e) };
}

/** C3 of an ellipse with perigee radius rp and apoapsis radius ra about gm, m^2/s^2 (e.g. ra at lunar distance: about -2 km^2/s^2). */
export function c3ForApoapsis(gm: number, rp: number, ra: number): number {
  return -(2 * gm) / (rp + ra);
}

/**
 * Aim error at liftoff t: |angle(u(t), s) - phi| (phi folded into [0, pi]),
 * rad: how far from the target direction s the departure points with the
 * best azimuth, for a direct injection whose departure is phi rad along the
 * plane from the site direction. Zero at the window instants.
 */
export function directAimError(site: LaunchSite, t: number, phi: number, s: readonly number[]): number {
  return Math.abs(angleBetween(siteFrame(site, t).up, s) - foldAngle(phi));
}

function foldAngle(phi: number): number {
  let a = phi % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a > Math.PI ? 2 * Math.PI - a : a;
}

/** Inertial azimuth at liftoff t that launches toward s reaching it phi rad along the plane. */
export function directAzimuthDeg(site: LaunchSite, t: number, phi: number, s: readonly number[]): number {
  const f = siteFrame(site, t);
  const su = unit(s);
  const c = dot(su, f.up);
  let d: V3 = [su[0] - c * f.up[0], su[1] - c * f.up[1], su[2] - c * f.up[2]];
  let a = phi % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  if (a > Math.PI) d = [-d[0], -d[1], -d[2]];
  let az = Math.atan2(dot(d, f.east), dot(d, f.north)) / DEG;
  if (az < 0) az += 360;
  return az;
}

export type DirectTargetSpec =
  /** A fixed geocentric direction (e.g. a departure asymptote from a Lambert solution) for the hyperbola's asymptote, or the ellipse's apoapsis. */
  | { readonly kind: 'direction'; readonly direction: readonly number[] }
  /** A body (by id) to meet at the apoapsis of a high ellipse (e.g. the Moon): aims the apoapsis at where the body will be then. */
  | { readonly kind: 'body'; readonly id: string; readonly ephem: Ephemeris; readonly bodies: readonly BodyData[] };

export interface DirectWindow {
  /** Liftoff, s TDB. */
  readonly t: number;
  readonly azimuthDeg: number;
  readonly azimuthAllowed: boolean;
  /** The ascent at that liftoff and azimuth (as replay computes it). */
  readonly ascent: DirectAscentOk;
  readonly geometry: DepartureGeometry;
  /** Target direction used (unit, geocentric). */
  readonly direction: V3;
  /** Body target: arrival time at apoapsis, s TDB. */
  readonly arrival?: number;
  /** Growth of the aim error away from t, deg per minute of liftoff delay. */
  readonly errorRateDegPerMin: number;
  /**
   * False when re-running the ascent at the window's azimuth moved the
   * departure off the target (the ascent then reported is the first
   * estimate's): typical of an all-solid vehicle whose energy depends on the
   * azimuth, near a nearly-antipodal aim where the azimuth is ill defined.
   * Fly it (replay) or adjust the payload before trusting it.
   */
  readonly converged: boolean;
}

export interface DirectWindowOptions {
  readonly site: LaunchSite;
  /** Whole stack, firing order, spacecraft last. */
  readonly stages: readonly Stage[];
  readonly c3: number;
  readonly injectionAltitudeM: number;
  readonly target: DirectTargetSpec;
  readonly tStart: number;
  readonly tEnd: number;
  /** Azimuth for the first ascent estimate, deg (default 90). */
  readonly azimuthGuessDeg?: number;
  /** Earth GM and reference radius (default: J2000 Earth values). */
  readonly earth?: { readonly gm: number; readonly radius: number };
  /** Scan step, s (default 300). */
  readonly step?: number;
}

const EARTH_DEFAULT = { gm: 3.986004418e14, radius: 6378136.6 };

/**
 * Liftoff times in [tStart, tEnd] (and azimuths) at which a direct
 * injection from `site` departs toward the target. Each found by scanning
 * the aim error's signed form for roots, then refined by re-running the
 * ascent at the found azimuth (the downrange angle depends on it) three
 * times. Windows whose ascent fails are dropped.
 */
export function directInjectionWindows(o: DirectWindowOptions): DirectWindow[] {
  const E = o.earth ?? EARTH_DEFAULT;
  const step = o.step ?? 300;
  const asc = (t: number, az: number): DirectAscentOk | null => {
    const a = computeDirectAscent(o.stages, { gm: E.gm, radius: E.radius, c3: o.c3, injectionAltitudeM: o.injectionAltitudeM }, launchGeometry(o.site, t, az), ASCENT_BODIES.earth);
    return a.ok ? a : null;
  };
  const aimOf = (a: DirectAscentOk, g: DepartureGeometry, t: number): { phi: number; s: V3; arrival?: number } => {
    const T = o.target;
    const phi = Number.isNaN(g.asymptoteAngle) ? g.apoapsisAngle : g.asymptoteAngle;
    if (T.kind === 'direction') return { phi, s: unit(T.direction) };
    const arrival = t + a.burnout.time + g.timeToApoapsis;
    const b = new Float64Array(6);
    const e = new Float64Array(6);
    T.ephem.bodyState(bodyIndex(T.id, T.bodies), arrival, b);
    T.ephem.bodyState(bodyIndex('earth', T.bodies), arrival, e);
    return { phi, s: unit([b[0] - e[0], b[1] - e[1], b[2] - e[2]]), arrival };
  };
  const signed = (t: number, a: DirectAscentOk, g: DepartureGeometry) => {
    const { phi, s } = aimOf(a, g, t);
    return angleBetween(siteFrame(o.site, t).up, s) - foldAngle(phi);
  };
  const root = (ta: number, tb: number, a: DirectAscentOk, g: DepartureGeometry): number | null => {
    let fa = signed(ta, a, g);
    const fb = signed(tb, a, g);
    if (fa * fb > 0) return null;
    let lo = ta, hi = tb;
    for (let i = 0; i < 50 && hi - lo > 1e-3; i++) {
      const mid = 0.5 * (lo + hi);
      const fm = signed(mid, a, g);
      if (fa * fm <= 0) hi = mid;
      else { lo = mid; fa = fm; }
    }
    return 0.5 * (lo + hi);
  };
  const a0 = asc(o.tStart, o.azimuthGuessDeg ?? 90);
  if (!a0) return [];
  const g0 = departureGeometry(a0.burnout, E.gm, E.radius);
  const out: DirectWindow[] = [];
  for (let ta = o.tStart; ta < o.tEnd; ta += step) {
    const tb = Math.min(ta + step, o.tEnd);
    let t = root(ta, tb, a0, g0);
    if (t === null) continue;
    // Refine: the ascent (so phi) depends on the azimuth, the azimuth on the liftoff time.
    let a: DirectAscentOk = a0;
    let g = g0;
    let az = directAzimuthDeg(o.site, t, aimOf(a, g, t).phi, aimOf(a, g, t).s);
    let ok = false;
    for (let it = 0; it < 4; it++) {
      const a2 = asc(t, az);
      if (!a2) break;
      const g2 = departureGeometry(a2.burnout, E.gm, E.radius);
      let t2: number | null = null;
      for (let s = t - 3 * 3600; s < t + 3 * 3600; s += step) {
        const x = root(s, s + step, a2, g2);
        if (x !== null && (t2 === null || Math.abs(x - t) < Math.abs(t2 - t))) t2 = x;
      }
      if (t2 === null) break;
      a = a2; g = g2; t = t2; ok = true;
      const aim = aimOf(a, g, t);
      az = directAzimuthDeg(o.site, t, aim.phi, aim.s);
    }
    const aim = aimOf(a, g, t);
    const rate = Math.abs(signed(t + 60, a, g) - signed(t - 60, a, g)) / 2 / DEG;
    out.push({ t, azimuthDeg: az, azimuthAllowed: azimuthAllowed(o.site, az), ascent: a, geometry: g, direction: aim.s, ...(aim.arrival !== undefined ? { arrival: aim.arrival } : {}), errorRateDegPerMin: rate, converged: ok });
  }
  return out;
}

/**
 * Width of the launch window around liftoff t0, s: the contiguous span of
 * liftoff times around t0 in which ok(t) holds, scanned in steps of `step`
 * up to `maxSpan` each way. Advisory.
 */
export function windowSpan(ok: (t: number) => boolean, t0: number, step = 30, maxSpan = 86400): { start: number; end: number; width: number } {
  let a = t0;
  while (a - step >= t0 - maxSpan && ok(a - step)) a -= step;
  let b = t0;
  while (b + step <= t0 + maxSpan && ok(b + step)) b += step;
  return { start: a, end: b, width: b - a };
}

/**
 * Parking-orbit route: can a launch at t reach a plane containing direction
 * s (in either sense around the orbit) with an azimuth inside the site's
 * corridor? (The departure burn can then be placed where it points the right
 * way.) Returns the best allowed azimuth or null.
 */
export function parkingAzimuthToward(site: LaunchSite, t: number, s: readonly number[]): number | null {
  for (const phi of [Math.PI / 2, (3 * Math.PI) / 2]) {
    const az = directAzimuthDeg(site, t, phi, s);
    if (azimuthAllowed(site, az)) return az;
  }
  return null;
}
