/**
 * Abstracted launch: place the spacecraft in a parking orbit from a launch
 * site, time and azimuth, with no atmospheric ascent simulation.
 *
 * REPLAY PATH (launchState): deterministic. Only exactly-defined arithmetic and
 * src/physics/dmath.ts; the same LaunchSpec gives the same bits everywhere.
 * PLANNING HELPERS (bottom of the file): advisory, use ordinary Math.*.
 *
 * MODEL
 *  - At liftoff time tL the site's geocentric ICRF position r (earth-orientation.ts)
 *    and the launch azimuth define the orbit plane: it contains Earth's center,
 *    r, and the horizontal direction d at azimuth A, measured clockwise from
 *    north in the plane perpendicular to r (the geocentric horizon; it differs
 *    from the geodetic horizon by < 0.2 deg of tilt and changes no azimuth by
 *    more than ~0.1 deg). The orbit normal is h = u x d (u = r/|r|), so
 *      cos i = h . pole = cos(geocentric latitude) * sin(A)
 *    exactly; |cos i| <= cos(latitude): inclinations below the site latitude
 *    cannot be produced, by construction.
 *  - A is the INERTIAL azimuth (direction of the inertial velocity at
 *    insertion projected back to the site). A real vehicle steers at a slightly
 *    different ground-relative azimuth because the pad moves east at up to
 *    465 m/s; the planning UI can show both.
 *  - Insertion happens ascentTimeS after liftoff, downrangeDeg along the plane
 *    from r, on a circular orbit of radius R + altitude, R = Earth's
 *    reference radius (BodyData.referenceRadius: the equatorial radius its
 *    gravity field is referred to, 6378.1366 km), the one radius every
 *    altitude in the game is measured from (geodetic height above the oblate
 *    surface differs by up to 21 km).
 *  - Earth's barycentric state at the insertion time comes from the caller's
 *    ephemeris; Earth is found by id, never by index.
 *
 * ASCENT PARAMETERS (defaults, overridable per launch): orbit insertion
 * ~8.5-9.5 min after liftoff and ~1,400-2,000 km downrange is typical of
 * two-stage-to-LEO ascents: Space Shuttle MECO at ~T+8:30 about 1,400-1,500 km
 * downrange (NASA STS press-kit ascent timelines), Falcon 9 SECO-1 at
 * ~T+8:30-9:00 for LEO missions (SpaceX mission timelines). Defaults: 540 s
 * and 13.5 deg (~1,500 km of ground arc). Approximate, labelled as such.
 *
 * "CIRCULAR": two options.
 *  - 'two-body': v = sqrt(GM/r), horizontal. Under Earth's J2 this is not a
 *    circular orbit: J2 strengthens radial gravity by a factor
 *    1 + 1.5 J2 (R/r)^2 (1 - 3 sin^2 phi), so the vehicle starts slightly
 *    too slow, at apoapsis of a ~7-11 km-high oscillation.
 *  - 'j2-mean' (default): the first-order J2 solution for a circular orbit
 *    (linearised radial and angular-momentum equations, forced at twice the
 *    argument of latitude u): radius r0 (1 + k cos 2u), a matching radial and
 *    along-track velocity, k = (eps/6) sin^2 i, eps = 1.5 J2 (Re/r0)^2, and
 *    mean motion n^2 = (GM/r0^3)(1 + eps (1 - 1.5 sin^2 i)). The free radial
 *    oscillation is zero to first order, so the orbit's mean radius is the
 *    requested one and the remaining wobble is the forced ~1-2 km term that
 *    every real "circular" LEO shows. Real vehicles target osculating
 *    elements; this choice gives the player the altitude asked for, which is
 *    what a planner expects. Measured numbers: test/launch.test.ts.
 *
 * DIRECT INJECTION (later): LaunchSpec is a tagged union on `mode`; a
 * 'direct' mode will share the site/plane geometry here (launchPlane) and
 * replace the circular-insertion step.
 */
import { DEG, atan2, sincos } from '../physics/dmath';
import { J2000_BODIES, bodyIndex, type BodyData } from '../physics/solar-system';
import type { Ephemeris } from '../physics/spacecraft';
import sitesData from './data/launch-sites.json';
import { EARTH_ROTATION, WGS84, geodeticToBodyFixed, poleAt, siteIcrf } from './earth-orientation';

export interface LaunchSite {
  readonly id: string;
  readonly name: string;
  /** Geodetic latitude (WGS84), deg. */
  readonly latDeg: number;
  /** East longitude, deg. */
  readonly lonDeg: number;
  readonly heightM: number;
  /** Allowed inertial azimuths: clockwise from azimuthMinDeg to azimuthMaxDeg. */
  readonly azimuthMinDeg: number;
  readonly azimuthMaxDeg: number;
  /** True where the azimuth corridor is inferred, not taken from range documentation. */
  readonly azimuthApproximate: boolean;
}

export const LAUNCH_SITES: readonly LaunchSite[] = sitesData.sites;

export function launchSite(id: string): LaunchSite {
  const s = LAUNCH_SITES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown launch site ${id}`);
  return s;
}

export const DEFAULT_ASCENT_TIME_S = 540;
export const DEFAULT_DOWNRANGE_DEG = 13.5;

/** Plain, serialisable launch description (numbers, a site id, string tags). */
export interface ParkingOrbitLaunch {
  readonly mode: 'parking-orbit';
  readonly siteId: string;
  /** Liftoff, seconds TDB from J2000. */
  readonly launchTime: number;
  /** Inertial launch azimuth, deg clockwise from north. */
  readonly azimuthDeg: number;
  /** Circular parking-orbit altitude above Earth's reference radius (BodyData.referenceRadius), m. */
  readonly altitudeM: number;
  readonly ascentTimeS?: number;
  readonly downrangeDeg?: number;
  readonly circularization?: 'two-body' | 'j2-mean';
}

/** Room for later modes (e.g. 'direct' injection) as further union members. */
export type LaunchSpec = ParkingOrbitLaunch;

export interface LaunchResult {
  /** Insertion time, s TDB from J2000. */
  readonly t: number;
  /** Barycentric ICRF [x,y,z,vx,vy,vz] at insertion, m and m/s. */
  readonly state: [number, number, number, number, number, number];
  /** Geocentric ICRF state at insertion. */
  readonly geocentric: [number, number, number, number, number, number];
  /** Unit orbit normal (ICRF). */
  readonly normal: [number, number, number];
  /** Inclination to Earth's (mean, date) equator, deg. Informational (uses atan2). */
  readonly inclinationDeg: number;
}

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): number => Math.sqrt(dot(a, a));
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

/** True if azimuth (deg) lies in the site's clockwise corridor. */
export function azimuthAllowed(site: LaunchSite, azimuthDeg: number): boolean {
  const span = site.azimuthMaxDeg - site.azimuthMinDeg;
  if (span >= 360) return true;
  let d = azimuthDeg - site.azimuthMinDeg;
  d = d - 360 * Math.floor(d / 360);
  return d <= span;
}

/** Local geocentric horizon frame of a site at t: up, east, north (ICRF unit vectors) and the pole. */
export function siteFrame(site: LaunchSite, t: number): { r: V3; up: V3; east: V3; north: V3; pole: V3 } {
  const r = siteIcrf(EARTH_ROTATION, WGS84, site.latDeg, site.lonDeg, site.heightM, t);
  const up = scale(r, 1 / norm(r));
  const pole = poleAt(EARTH_ROTATION, t);
  const e = cross(pole, up);
  const east = scale(e, 1 / norm(e));
  const north = cross(up, east);
  return { r, up, east, north, pole };
}

/** Orbit plane at liftoff: site direction u, in-plane downrange direction d, normal h = u x d. */
export function launchPlane(site: LaunchSite, t: number, azimuthDeg: number): { up: V3; downrange: V3; normal: V3; pole: V3 } {
  const f = siteFrame(site, t);
  const [sa, ca] = sincos(azimuthDeg * DEG);
  const d: V3 = [ca * f.north[0] + sa * f.east[0], ca * f.north[1] + sa * f.east[1], ca * f.north[2] + sa * f.east[2]];
  return { up: f.up, downrange: d, normal: cross(f.up, d), pole: f.pole };
}

function earthData(bodies: readonly BodyData[]): BodyData {
  return bodies[bodyIndex('earth', bodies)];
}

/**
 * Spacecraft state at parking-orbit insertion. Deterministic.
 * `bodies` must be the body list `ephem` was built from (Earth is looked up by id).
 */
export function launchState(spec: LaunchSpec, ephem: Ephemeris, bodies: readonly BodyData[] = J2000_BODIES): LaunchResult {
  if (spec.mode !== 'parking-orbit') throw new Error(`unsupported launch mode ${(spec as { mode: string }).mode}`);
  const site = launchSite(spec.siteId);
  if (!azimuthAllowed(site, spec.azimuthDeg)) {
    throw new Error(`azimuth ${spec.azimuthDeg} deg outside ${site.id} range-safety corridor ${site.azimuthMinDeg}..${site.azimuthMaxDeg}`);
  }
  if (!(spec.altitudeM > 0)) throw new Error('parking orbit altitude must be positive');
  const ascent = spec.ascentTimeS ?? DEFAULT_ASCENT_TIME_S;
  const downrange = spec.downrangeDeg ?? DEFAULT_DOWNRANGE_DEG;
  const mode = spec.circularization ?? 'j2-mean';

  const earth = earthData(bodies);
  const plane = launchPlane(site, spec.launchTime, spec.azimuthDeg);
  const [st, ct] = sincos(downrange * DEG);
  const u = plane.up;
  const d = plane.downrange;
  const rHat: V3 = [ct * u[0] + st * d[0], ct * u[1] + st * d[1], ct * u[2] + st * d[2]];
  const vHat: V3 = [ct * d[0] - st * u[0], ct * d[1] - st * u[1], ct * d[2] - st * u[2]];
  const r0 = earth.referenceRadius + spec.altitudeM;
  const cosI = dot(plane.normal, plane.pole);
  let geo: [number, number, number, number, number, number];
  if (mode === 'two-body') {
    const v = Math.sqrt(earth.gm / r0);
    geo = [rHat[0] * r0, rHat[1] * r0, rHat[2] * r0, vHat[0] * v, vHat[1] * v, vHat[2] * v];
  } else if (mode === 'j2-mean') {
    // First-order J2 circular orbit with mean radius r0 (see header):
    //   r = r0 (1 + k cos 2u),  dr/dt = -2 k n r0 sin 2u,  r dtheta/dt = n r0 (1 + 2k cos 2u),
    //   k = eps sin^2 i / 6,  eps = 1.5 J2 (Re/r0)^2,  n^2 = GM/r0^3 (1 + eps (1 - 1.5 sin^2 i)),
    // u = argument of latitude. With N = pole x h (|N| = sin i):
    //   sin^2 i cos 2u = (r.N)^2 - (r.(h x N))^2,  sin^2 i sin 2u = 2 (r.N)(r.(h x N)).
    const j2 = earth.j2 ?? 0;
    const re = earth.j2Radius ?? earth.referenceRadius;
    const eps = 1.5 * j2 * (re / r0) * (re / r0);
    const sin2i = 1 - cosI * cosI;
    const n = Math.sqrt((earth.gm / (r0 * r0 * r0)) * (1 + eps * (1 - 1.5 * sin2i)));
    const N = cross(plane.pole, plane.normal);
    const a = dot(rHat, N);
    const b = dot(rHat, cross(plane.normal, N));
    const s2c2u = a * a - b * b;
    const s2s2u = 2 * a * b;
    const rr = r0 * (1 + (eps / 6) * s2c2u);
    const vr = -(eps / 3) * n * r0 * s2s2u;
    const vt = n * r0 * (1 + (eps / 3) * s2c2u);
    geo = [
      rHat[0] * rr, rHat[1] * rr, rHat[2] * rr,
      vHat[0] * vt + rHat[0] * vr, vHat[1] * vt + rHat[1] * vr, vHat[2] * vt + rHat[2] * vr,
    ];
  } else {
    throw new Error(`unknown circularization ${mode as string}`);
  }
  const t = spec.launchTime + ascent;
  const e = new Float64Array(6);
  ephem.bodyState(bodyIndex('earth', bodies), t, e);
  const state: [number, number, number, number, number, number] = [
    e[0] + geo[0], e[1] + geo[1], e[2] + geo[2], e[3] + geo[3], e[4] + geo[4], e[5] + geo[5],
  ];
  const sinI = norm(cross(plane.normal, plane.pole));
  return { t, state, geocentric: geo, normal: plane.normal, inclinationDeg: atan2(sinI, cosI) / DEG };
}

/**
 * Numeric encoding for a plan's launch seam ({ site, params: number[] }):
 * params = [launchTime, azimuthDeg, altitudeM, ascentTimeS?, downrangeDeg?, circularization?]
 * with circularization 0 = 'j2-mean', 1 = 'two-body'. Mode 'parking-orbit' is
 * implied; a future direct-injection mode would use its own seam kind or a
 * leading mode code.
 */
export function launchToParams(spec: ParkingOrbitLaunch): number[] {
  return [
    spec.launchTime,
    spec.azimuthDeg,
    spec.altitudeM,
    spec.ascentTimeS ?? DEFAULT_ASCENT_TIME_S,
    spec.downrangeDeg ?? DEFAULT_DOWNRANGE_DEG,
    spec.circularization === 'two-body' ? 1 : 0,
  ];
}

export function launchFromParams(siteId: string, params: readonly number[]): ParkingOrbitLaunch {
  if (params.length < 3 || params.length > 6) throw new Error(`launch expects 3..6 parameters, got ${params.length}`);
  const c = params[5] ?? 0;
  if (c !== 0 && c !== 1) throw new Error(`bad circularization code ${c}`);
  return {
    mode: 'parking-orbit',
    siteId,
    launchTime: params[0],
    azimuthDeg: params[1],
    altitudeM: params[2],
    ascentTimeS: params[3] ?? DEFAULT_ASCENT_TIME_S,
    downrangeDeg: params[4] ?? DEFAULT_DOWNRANGE_DEG,
    circularization: c === 1 ? 'two-body' : 'j2-mean',
  };
}

// ---------------------------------------------------------------------------
// Planning helpers: advisory only, may use Math.* (not part of a replay).
// ---------------------------------------------------------------------------

/** Geocentric latitude of a site, deg. */
export function geocentricLatitudeDeg(site: LaunchSite): number {
  const p = geodeticToBodyFixed(WGS84, site.latDeg, site.lonDeg, site.heightM);
  return Math.atan2(p[2], Math.hypot(p[0], p[1])) / DEG;
}

/**
 * Inertial launch azimuths that give inclination incDeg from this site:
 * `northerly` (ascending pass, 0..180 through east for prograde) and
 * `southerly` = 180 - northerly. Null if incDeg is unreachable
 * (|cos i| > cos latitude). Each is flagged against the range corridor.
 */
export function azimuthForInclination(
  site: LaunchSite,
  incDeg: number,
): { northerly: number; southerly: number; northerlyAllowed: boolean; southerlyAllowed: boolean } | null {
  const lat = geocentricLatitudeDeg(site) * DEG;
  const s = Math.cos(incDeg * DEG) / Math.cos(lat);
  if (Math.abs(s) > 1) return null;
  let north = Math.asin(s) / DEG; // -90..90
  if (north < 0) north += 360;
  let south = 180 - Math.asin(s) / DEG;
  south = ((south % 360) + 360) % 360;
  return { northerly: north, southerly: south, northerlyAllowed: azimuthAllowed(site, north), southerlyAllowed: azimuthAllowed(site, south) };
}

/**
 * Ground-relative (steering) azimuth for an inertial azimuth: the direction of
 * v_inertial - v_pad for an orbital speed vOrbit (m/s). Advisory.
 */
export function groundRelativeAzimuthDeg(site: LaunchSite, inertialAzDeg: number, vOrbit = 7800): number {
  const lat = geocentricLatitudeDeg(site) * DEG;
  const vPad = ((EARTH_ROTATION.wDot * DEG) / 86400) * WGS84.a * Math.cos(lat);
  const a = inertialAzDeg * DEG;
  const az = Math.atan2(vOrbit * Math.sin(a) - vPad, vOrbit * Math.cos(a)) / DEG;
  return (az + 360) % 360;
}

export interface PlaneCrossing {
  /** Liftoff time at which the site lies in the target plane, s TDB. */
  readonly t: number;
  /** Inertial azimuth that launches into that plane (with its normal, i.e. its sense of motion). */
  readonly azimuthDeg: number;
  readonly azimuthAllowed: boolean;
}

/**
 * Liftoff times in [tStart, tEnd] at which the site passes through the plane
 * with unit normal `normal` (ICRF, through Earth's center), with the azimuth
 * that launches into it moving in the sense given by the normal. Two per
 * day unless the plane's inclination is below the site latitude (then none).
 */
export function planeCrossings(site: LaunchSite, normal: readonly number[], tStart: number, tEnd: number, step = 600): PlaneCrossing[] {
  const n: V3 = [normal[0], normal[1], normal[2]];
  const k = 1 / norm(n);
  const h = scale(n, k);
  const f = (t: number): number => dot(siteFrame(site, t).up, h);
  const out: PlaneCrossing[] = [];
  let ta = tStart;
  let fa = f(ta);
  while (ta < tEnd) {
    const tb = Math.min(ta + step, tEnd);
    const fb = f(tb);
    if (fa === 0 || fa * fb < 0) {
      let lo = ta;
      let hi = tb;
      let flo = fa;
      for (let i = 0; i < 60 && hi - lo > 1e-6; i++) {
        const mid = 0.5 * (lo + hi);
        const fm = f(mid);
        if (flo * fm <= 0) hi = mid;
        else {
          lo = mid;
          flo = fm;
        }
      }
      const t = fa === 0 ? ta : 0.5 * (lo + hi);
      const fr = siteFrame(site, t);
      const d = cross(h, fr.up); // direction of motion in the plane
      let az = Math.atan2(dot(d, fr.east), dot(d, fr.north)) / DEG;
      if (az < 0) az += 360;
      out.push({ t, azimuthDeg: az, azimuthAllowed: azimuthAllowed(site, az) });
    }
    ta = tb;
    fa = fb;
  }
  return out;
}

/** Unit normal of the plane through Earth's center containing a and b (e.g. Moon position and velocity). */
export function planeNormal(a: readonly number[], b: readonly number[]): [number, number, number] {
  const c = cross([a[0], a[1], a[2]], [b[0], b[1], b[2]]);
  return scale(c, 1 / norm(c));
}

/** Geocentric orbit normal of a body (by id), e.g. the Moon, at t. */
export function orbitNormalOf(ephem: Ephemeris, bodies: readonly BodyData[], id: string, t: number): [number, number, number] {
  const a = new Float64Array(6);
  const e = new Float64Array(6);
  ephem.bodyState(bodyIndex(id, bodies), t, a);
  ephem.bodyState(bodyIndex('earth', bodies), t, e);
  return planeNormal([a[0] - e[0], a[1] - e[1], a[2] - e[2]], [a[3] - e[3], a[4] - e[4], a[5] - e[5]]);
}

/**
 * Normals of the parking-orbit planes that contain a departure asymptote
 * direction s and have inclination incDeg to Earth's equator at t. Zero or two
 * solutions: none if incDeg is below the asymptote's declination.
 */
export function asymptotePlaneNormals(asymptote: readonly number[], incDeg: number, t: number): [number, number, number][] {
  const s0: V3 = [asymptote[0], asymptote[1], asymptote[2]];
  const s = scale(s0, 1 / norm(s0));
  const p = poleAt(EARTH_ROTATION, t);
  const pPerp: V3 = [p[0] - dot(p, s) * s[0], p[1] - dot(p, s) * s[1], p[2] - dot(p, s) * s[2]];
  const m = norm(pPerp);
  const q = scale(pPerp, 1 / m);
  const w = cross(s, q);
  const c = Math.cos(incDeg * DEG) / m;
  if (Math.abs(c) > 1) return [];
  const sb = Math.sqrt(1 - c * c);
  return [
    [c * q[0] + sb * w[0], c * q[1] + sb * w[1], c * q[2] + sb * w[2]],
    [c * q[0] - sb * w[0], c * q[1] - sb * w[1], c * q[2] - sb * w[2]],
  ];
}

/** Rotation period of the Earth model relative to inertial space (one stellar day), s. Advisory. */
export function stellarDay(): number {
  const degPerDay = EARTH_ROTATION.wDot + (EARTH_ROTATION.w1 ?? 0) / 36525;
  return (360 / degPerDay) * 86400;
}
