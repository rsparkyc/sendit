/**
 * Body lookup and per-body planning constants. Bodies are always found by id or
 * name, never by a fixed index (the body list grows as moons are added).
 */
import type { BodyData } from '../physics/solar-system';

/** Index of the body whose id or name matches `key` (case-insensitive). Throws if none. */
export function findBody(bodies: readonly BodyData[], key: string): number {
  const k = key.toLowerCase();
  let i = bodies.findIndex((b) => b.id.toLowerCase() === k);
  if (i < 0) i = bodies.findIndex((b) => b.name.toLowerCase() === k);
  if (i < 0) throw new Error(`unknown body "${key}"`);
  return i;
}

/**
 * Lowest altitude a flyby should use, m above the mean radius: the top of the
 * sensible atmosphere (drag / heating) where there is one. Planning numbers,
 * rounded generously; bodies not listed get 0 (surface only). Jupiter's value
 * ignores radiation, which is a separate, much larger constraint in practice.
 */
export const MIN_FLYBY_ALTITUDE: Readonly<Record<string, number>> = {
  venus: 250e3,
  earth: 200e3,
  mars: 150e3,
  jupiter: 1000e3,
  saturn: 1000e3,
  uranus: 1000e3,
  neptune: 1000e3,
  titan: 1000e3,
  pluto: 100e3,
  triton: 50e3,
};

export function minFlybyAltitude(b: BodyData): number {
  return MIN_FLYBY_ALTITUDE[b.id] ?? 0;
}

const J2000_UNIX_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
/** TT - UTC from 2017 on (32.184 s + 37 leap seconds). TDB - TT (< 2 ms) is ignored. */
const TT_MINUS_UTC = 69.184;

/**
 * Seconds of TDB from J2000 for a UTC calendar date (month 1-12, day may be
 * fractional). Uses the current TT-UTC for all dates; good to ~a minute back
 * to 1972, which is plenty for planning.
 */
export function utcToTdb(year: number, month: number, day: number): number {
  return (Date.UTC(year, month - 1, 1) - J2000_UNIX_MS) / 1000 + (day - 1) * 86400 + TT_MINUS_UTC;
}

/** ISO-like UTC date string (to the minute) for a TDB time. */
export function tdbToIso(t: number): string {
  return new Date(J2000_UNIX_MS + (t - TT_MINUS_UTC) * 1000).toISOString().slice(0, 16) + 'Z';
}
