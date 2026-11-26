/**
 * Earth's rotation: THE ONE DEFINITION used by the physics (the body-fixed
 * frame of Earth's tesseral gravity field, gravity-field.ts / BodyFrame in
 * orientation.ts), the launch code (src/mission/earth-orientation.ts, which
 * re-exports everything here) and, through the launch code, the drawn Earth
 * texture (src/app/orientation.ts). test/orientation.test.ts checks that the
 * physics frame and the launch code's frame agree.
 *
 * MODEL: the IAU pole of src/physics/data/iau-rotation.json (pck00011, linear
 * precession of the mean pole) with the prime meridian from the IERS Earth
 * Rotation Angle in UT1 (IERS Conventions 2010, eq. 5.15), UT1 from a Delta-T
 * table. The accuracy of this model as ground-site positions is documented in
 * src/mission/earth-orientation.ts (worst 0.28 km against Horizons, 1950-2050).
 *
 * DETERMINISM: + - * / floor and a table lookup only: a pure function of t.
 */
import data from './data/iau-rotation.json';

/**
 * Earth's IAU constants, from the one generated source the physics and the
 * display also read (src/physics/data/iau-rotation.json, pck00011): pole
 * alpha0 = 0 - 0.641 T, delta0 = 90 - 0.557 T; W = 190.147 + 360.9856235 d.
 */
// Read from the JSON directly (not through orientation.ts, which imports this module).
const IAU_EARTH: { ra: number[]; dec: number[]; pm: number[] } = data.bodies.earth;

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

/**
 * Earth, pure IAU WGCCRE 2015 / pck00011.tpc (BODY399_POLE_RA, _POLE_DEC, _PM),
 * W linear in TDB. Kept for comparison: 11 s of rotation off at J2000 and
 * drifting (its W0 and rate are only quoted to ~1e-3 deg and ~1e-7 deg/day).
 */
export const EARTH_ROTATION_IAU: RotationModel = {
  ra0: IAU_EARTH.ra[0],
  ra1: IAU_EARTH.ra[1],
  dec0: IAU_EARTH.dec[0],
  dec1: IAU_EARTH.dec[1],
  w0: IAU_EARTH.pm[0],
  wDot: IAU_EARTH.pm[1],
};

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

/**
 * Delta-T = TT - UT1 in seconds at TDB t (piecewise linear in the table, flat
 * outside it). Continuous in t; its rate jumps at the table years by at most
 * ~1e-8 s/s, a ~1e-8 relative change of Earth's rotation rate.
 */
export function deltaT(t: number): number {
  // Year as a fraction; Jan 1 of year Y is ~ (Y - 2000) Julian years from J2000 minus half a day.
  const y = 2000 + (t + 43200) / (365.25 * SECONDS_PER_DAY);
  if (y <= DT_Y[0]) return DT_V[0];
  const n = DT_Y.length;
  if (y >= DT_Y[n - 1]) return DT_V[n - 1];
  // The interval [i, i+1] with DT_Y[i] <= y < DT_Y[i+1]: a direct guess on the
  // uniform grid, then the exact comparisons (the same i as a linear search).
  let i = Math.floor((y - DT_Y[0]) / DT_STEP);
  if (i > n - 2) i = n - 2;
  while (i > 0 && DT_Y[i] > y) i--;
  while (DT_Y[i + 1] <= y) i++;
  const y0 = DT_Y[i];
  const v0 = DT_V[i];
  return v0 + ((DT_V[i + 1] - v0) * (y - y0)) / (DT_Y[i + 1] - y0);
}
const DT_Y = Float64Array.from(DELTA_T_TABLE, (r) => r[0]);
const DT_V = Float64Array.from(DELTA_T_TABLE, (r) => r[1]);
const DT_STEP = DT_Y[1] - DT_Y[0];
if (tableNotUniform()) throw new Error('DELTA_T_TABLE must be on a uniform grid');
function tableNotUniform(): boolean {
  for (let i = 1; i < DT_Y.length; i++) if (DT_Y[i] - DT_Y[i - 1] !== DT_STEP) return true;
  return false;
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
  ra0: IAU_EARTH.ra[0],
  ra1: IAU_EARTH.ra[1],
  dec0: IAU_EARTH.dec[0],
  dec1: IAU_EARTH.dec[1],
  w0: 190.46061837504,
  wDot: 360.9856122880876, // 360 * 1.00273781191135448
  w1: -IAU_EARTH.ra[1],
  timeOffset: deltaT,
};

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

/** Earth's prime meridian W (degrees, [0, 360)) at TDB t: the ERA model above. The physics' Earth frame uses exactly this. */
export function earthPrimeMeridianDeg(t: number): number {
  return primeMeridianDeg(EARTH_ROTATION, t);
}

/** Numbers of EARTH_ROTATION that a replay depends on, for the world fingerprint. */
export function earthRotationConstants(): number[] {
  const m = EARTH_ROTATION;
  const out = [m.w0, m.wDot, m.w1 ?? 0];
  for (const [y, v] of DELTA_T_TABLE) out.push(y, v);
  return out;
}
