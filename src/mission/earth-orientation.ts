/**
 * Body orientation: the rotation from a body-fixed frame to ICRF at a given
 * time, and the inertial position of a point on the surface.
 *
 * Deterministic (replay path): uses only src/physics/dmath.ts and exactly
 * defined arithmetic. Time t is seconds of TDB from J2000.
 *
 * MODEL: the IAU WGCCRE rotation model (Archinal et al. 2018, Celest. Mech.
 * Dyn. Astron. 130:22; constants as distributed in NAIF pck00011.tpc):
 *   alpha0 = a0 + a1 T,  delta0 = d0 + d1 T,  W = w0 + wDot d
 * with T Julian centuries and d days of TDB from J2000. The body-fixed frame
 * (x through the prime meridian, z along the pole) maps to ICRF by
 *   R = Rz(90 deg + alpha0) * Rx(90 deg - delta0) * Rz(W).
 * The same form serves every body in pck00011 (periodic nutation/libration
 * terms, needed for the Moon and some satellites, are not modelled; adding
 * them means extra sin terms in alpha0, delta0, W and nothing structural).
 *
 * EARTH uses that form with the prime meridian taken from the IERS Earth
 * Rotation Angle in UT1 (EARTH_ROTATION below); the plain IAU W (linear in
 * TDB, EARTH_ROTATION_IAU) is 11 s of rotation off at J2000 and 19-33 s off
 * at +-50 y (5-15 km at the surface), too coarse for launch windows.
 *
 * APPROXIMATIONS in EARTH_ROTATION, each as a ground-site position error:
 *  - UT1 from a 5-year Delta-T table, linearly interpolated: the table
 *    interpolation error is <~0.5 s (<~0.25 km at the equator); after 2025
 *    Delta-T is held constant, so the real future error is unknown (Delta-T
 *    can wander by several seconds per decade: ~1-2 km per decade possible).
 *  - TDB used for TT (difference < 2 ms): < 1 m.
 *  - Mean pole, linear IAU precession; nutation ignored (18.6 y, up to ~17"
 *    in longitude, ~9" in obliquity): <= ~0.3-0.5 km. This dominates the
 *    measured residual.
 *  - Polar motion (~0.3") ignored: ~10 m.
 *  - Quadratic precession terms ignored: < 0.01" over +-50 y.
 * MEASURED against JPL Horizons topocentric sites (full IERS model), 7 sites
 * x 7 epochs from 1950 to 2050: worst residual 0.28 km, at J2000 <= 0.24 km,
 * at +-50 y <= 0.28 km (test/earth-orientation.test.ts). Horizons also holds
 * future UT1 at a prediction, so agreement after 2025 is with its assumption,
 * not with the real Earth.
 */
import { DEG, sincos } from '../physics/dmath';

export const SECONDS_PER_DAY = 86400;
export const DAYS_PER_CENTURY = 36525;

/** IAU-style rotation constants (degrees, degrees per century, degrees per day). */
export interface RotationModel {
  readonly ra0: number;
  readonly ra1: number;
  readonly dec0: number;
  readonly dec1: number;
  readonly w0: number;
  /** deg/day, applied to the rotation time scale (UT1 for Earth, TDB otherwise). */
  readonly wDot: number;
  /** Optional deg/century in TDB (Earth: compensates the pole's RA drift so W tracks ERA). */
  readonly w1?: number;
  /**
   * Optional rotation time-scale offset in seconds, (TDB - rotation time) at
   * TDB t: Earth's Delta-T = TT - UT1. Must be deterministic (tables, +-*\/).
   */
  readonly timeOffset?: (t: number) => number;
}

/** Reference ellipsoid for geodetic coordinates. Sphere: flattening 0. */
export interface Ellipsoid {
  /** Equatorial radius, m. */
  readonly a: number;
  /** Flattening. */
  readonly f: number;
}

/**
 * Earth, pure IAU WGCCRE 2015 / pck00011.tpc (BODY399_POLE_RA, _POLE_DEC, _PM),
 * W linear in TDB. Kept for comparison: 11 s of rotation off at J2000 and
 * drifting (its W0 and rate are only quoted to ~1e-3 deg and ~1e-7 deg/day).
 */
export const EARTH_ROTATION_IAU: RotationModel = { ra0: 0, ra1: -0.641, dec0: 90, dec1: -0.557, w0: 190.147, wDot: 360.9856235 };

/**
 * TT - UT1 (Delta-T), seconds, at 1 January of each year. 1950-2020: IERS /
 * USNO historical values (rounded to 0.01 s; e.g. the Astronomical Almanac
 * table K8 and https://maia.usno.navy.mil/ser7/deltat.data). 2025: ~69.1 s.
 * The future is unpredictable (decadal fluctuations of +-several s); the table
 * holds the 2025 value constant afterwards, which is also what JPL Horizons
 * assumes for future dates (see the fixture residuals).
 */
export const DELTA_T_TABLE: readonly (readonly [number, number])[] = [
  [1950, 29.15], [1955, 31.07], [1960, 33.15], [1965, 35.73], [1970, 40.18], [1975, 45.48],
  [1980, 50.54], [1985, 54.34], [1990, 56.86], [1995, 60.78], [2000, 63.83], [2005, 64.69],
  [2010, 66.07], [2015, 67.64], [2020, 69.36], [2025, 69.1],
];

/** Delta-T = TT - UT1 in seconds at TDB t (piecewise linear in the table, flat outside it). */
export function deltaT(t: number): number {
  const tab = DELTA_T_TABLE;
  // Year as a fraction; Jan 1 of year Y is ~ (Y - 2000) Julian years from J2000 minus half a day.
  const y = 2000 + (t + 43200) / (365.25 * SECONDS_PER_DAY);
  if (y <= tab[0][0]) return tab[0][1];
  const last = tab[tab.length - 1];
  if (y >= last[0]) return last[1];
  let i = 0;
  while (tab[i + 1][0] <= y) i++;
  const [y0, v0] = tab[i];
  const [y1, v1] = tab[i + 1];
  return v0 + ((v1 - v0) * (y - y0)) / (y1 - y0);
}

/**
 * Earth: IAU pole (linear precession of the mean pole) with the prime
 * meridian from the IERS Earth Rotation Angle (IERS Conventions 2010, eq. 5.15):
 *   ERA = 360 deg * (0.7790572732640 + 1.00273781191135448 Du),
 * Du = UT1 days from JD 2451545.0 UT1. In the IAU parametrisation, where W is
 * counted from the node of the equator on the ICRF equator (RA alpha0 + 90),
 * W = ERA - 90 deg - alpha0, hence w0 = 280.46061837504 - 90 and
 * w1 = -ra1 = +0.641 deg/century. Twist difference between this and the
 * CIO-based (non-rotating origin) construction is second order in the pole
 * offset: < 1e-5 rad (<~0.1 km) over +-50 y.
 */
export const EARTH_ROTATION: RotationModel = {
  ra0: 0,
  ra1: -0.641,
  dec0: 90,
  dec1: -0.557,
  w0: 190.46061837504,
  wDot: 360.9856122880876, // 360 * 1.00273781191135448
  w1: 0.641,
  timeOffset: deltaT,
};

/** WGS84 (NIMA TR8350.2). */
export const WGS84: Ellipsoid = { a: 6378137, f: 1 / 298.257223563 };

export type Mat3 = Float64Array; // row-major 3x3

/** Prime-meridian angle W in degrees, reduced to [0, 360). */
export function primeMeridianDeg(m: RotationModel, t: number): number {
  const tr = m.timeOffset ? t - m.timeOffset(t) : t;
  const d = tr / SECONDS_PER_DAY;
  // wDot*d is huge (~6e6 deg at 50 y); split off whole turns per day first so
  // the reduction is done on exact quantities and W keeps ~1e-10 deg.
  const n = Math.floor(m.wDot / 360);
  const rem = m.wDot - 360 * n; // exact for the pck rates
  const nd = n * d;
  let w = m.w0 + rem * d + 360 * (nd - Math.floor(nd));
  if (m.w1 !== undefined) w += (m.w1 * t) / (SECONDS_PER_DAY * DAYS_PER_CENTURY);
  w = w - 360 * Math.floor(w / 360);
  return w;
}

/** Rotation body-fixed -> ICRF at time t (row-major). */
export function bodyToIcrf(m: RotationModel, t: number, out: Mat3 = new Float64Array(9)): Mat3 {
  const T = t / (SECONDS_PER_DAY * DAYS_PER_CENTURY);
  const ra = m.ra0 + m.ra1 * T;
  const dec = m.dec0 + m.dec1 * T;
  const [sa, ca] = sincos((ra + 90) * DEG); // Rz(90 + alpha)
  const [sd, cd] = sincos((90 - dec) * DEG); // Rx(90 - delta)
  const [sw, cw] = sincos(primeMeridianDeg(m, t) * DEG); // Rz(W)
  // A = Rz(a) * Rx(b)
  const a00 = ca, a01 = -sa * cd, a02 = sa * sd;
  const a10 = sa, a11 = ca * cd, a12 = -ca * sd;
  const a20 = 0, a21 = sd, a22 = cd;
  // R = A * Rz(W), Rz(W) = [[cw,-sw,0],[sw,cw,0],[0,0,1]]
  out[0] = a00 * cw + a01 * sw;
  out[1] = -a00 * sw + a01 * cw;
  out[2] = a02;
  out[3] = a10 * cw + a11 * sw;
  out[4] = -a10 * sw + a11 * cw;
  out[5] = a12;
  out[6] = a20 * cw + a21 * sw;
  out[7] = -a20 * sw + a21 * cw;
  out[8] = a22;
  return out;
}

/** The body's spin axis (ICRF unit vector) at t: third column of bodyToIcrf. */
export function poleAt(m: RotationModel, t: number): [number, number, number] {
  const r = bodyToIcrf(m, t);
  return [r[2], r[5], r[8]];
}

/** Spin rate, rad/s (W rate; the pole's drift is negligible for this purpose). */
export function spinRate(m: RotationModel): number {
  return (m.wDot * DEG) / SECONDS_PER_DAY;
}

/** Body-fixed Cartesian position of a geodetic point, m. */
export function geodeticToBodyFixed(e: Ellipsoid, latDeg: number, lonDeg: number, heightM: number): [number, number, number] {
  const [sp, cp] = sincos(latDeg * DEG);
  const [sl, cl] = sincos(lonDeg * DEG);
  const e2 = e.f * (2 - e.f);
  const n = e.a / Math.sqrt(1 - e2 * sp * sp);
  const rc = (n + heightM) * cp;
  return [rc * cl, rc * sl, (n * (1 - e2) + heightM) * sp];
}

export function applyMat3(r: Mat3, v: ArrayLike<number>): [number, number, number] {
  return [
    r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
    r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
    r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
  ];
}

/** ICRF position of a surface point relative to the body's center at time t, m. */
export function siteIcrf(
  m: RotationModel,
  e: Ellipsoid,
  latDeg: number,
  lonDeg: number,
  heightM: number,
  t: number,
): [number, number, number] {
  return applyMat3(bodyToIcrf(m, t), geodeticToBodyFixed(e, latDeg, lonDeg, heightM));
}
