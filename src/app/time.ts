/**
 * Time scales and calendar conversion for display. Pure; no DOM.
 *
 * Internal time is seconds of TDB from J2000 (2000-01-01 12:00:00 TDB), the
 * ephemeris' independent variable. Calendar dates are shown in TDB. We also
 * show UTC, derived as UTC = TT - 32.184 s - (TAI - UTC), with TDB taken as TT
 * (they differ by < 2 ms, periodically) and TAI - UTC from the leap-second
 * table below. Before 1972 UTC is not shown (it used rubber seconds). After
 * LEAP_TABLE_VALID_UNTIL the last value is extrapolated and the UTC is marked
 * as a prediction, since future leap seconds are unknown.
 */

export const DAY = 86400;
export const JULIAN_YEAR = 365.25 * DAY;

/** Unix-epoch milliseconds of the J2000 calendar label 2000-01-01T12:00:00. */
const J2000_LABEL_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/** TAI - UTC (s) effective from each UTC date (IERS Bulletin C). */
const LEAP_SECONDS: readonly (readonly [number, number, number, number])[] = [
  [1972, 1, 1, 10], [1972, 7, 1, 11], [1973, 1, 1, 12], [1974, 1, 1, 13], [1975, 1, 1, 14],
  [1976, 1, 1, 15], [1977, 1, 1, 16], [1978, 1, 1, 17], [1979, 1, 1, 18], [1980, 1, 1, 19],
  [1981, 7, 1, 20], [1982, 7, 1, 21], [1983, 7, 1, 22], [1985, 7, 1, 23], [1988, 1, 1, 24],
  [1990, 1, 1, 25], [1991, 1, 1, 26], [1992, 7, 1, 27], [1993, 7, 1, 28], [1994, 7, 1, 29],
  [1996, 1, 1, 30], [1997, 7, 1, 31], [1999, 1, 1, 32], [2006, 1, 1, 33], [2009, 1, 1, 34],
  [2012, 7, 1, 35], [2015, 7, 1, 36], [2017, 1, 1, 37],
];
/** End of the span for which the table is known complete (no leap second announced through 2026-06-30). Update from IERS Bulletin C. */
export const LEAP_TABLE_VALID_UNTIL_MS = Date.UTC(2026, 6, 1);
const LEAP_MS = LEAP_SECONDS.map(([y, m, d, s]) => [Date.UTC(y, m - 1, d), s] as const);
const TT_MINUS_TAI = 32.184;

export interface Calendar {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number; // may be fractional
}

/** TDB seconds from J2000 -> TDB calendar label. */
export function tdbToCalendar(t: number): Calendar {
  return msToCalendar(J2000_LABEL_MS + t * 1000);
}

/** TDB calendar label -> TDB seconds from J2000. */
export function calendarToTdb(c: Calendar): number {
  return (calendarToMs(c) - J2000_LABEL_MS) / 1000;
}

function calendarToMs(c: Calendar): number {
  const d = new Date(0);
  d.setUTCFullYear(c.year, c.month - 1, c.day); // setUTCFullYear handles years 0-99 correctly; Date.UTC does not
  d.setUTCHours(c.hour, c.minute, 0, 0);
  return d.getTime() + c.second * 1000;
}

function msToCalendar(ms: number): Calendar {
  const whole = Math.floor(ms);
  const d = new Date(whole);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds() + (d.getUTCMilliseconds() + (ms - whole)) / 1000,
  };
}

/** TAI - UTC at a UTC instant given as Unix ms (extrapolated after the table), or null before 1972. */
export function taiMinusUtc(utcMs: number): number | null {
  if (utcMs < LEAP_MS[0][0]) return null;
  let v = LEAP_MS[0][1];
  for (const [ms, s] of LEAP_MS) if (utcMs >= ms) v = s;
  return v;
}

/**
 * TDB seconds from J2000 -> UTC calendar, or null where UTC is not defined by
 * our table. Within a positive leap second the label repeats 23:59:59 (Date
 * cannot express :60); this affects one second per leap and is display-only.
 */
export function tdbToUtc(t: number): Calendar | null {
  const ttMs = J2000_LABEL_MS + t * 1000;
  const approx = ttMs - (TT_MINUS_TAI + 37) * 1000;
  let dat = taiMinusUtc(approx);
  if (dat === null) return null;
  // Re-evaluate once at the corrected instant, for times near a step.
  dat = taiMinusUtc(ttMs - (TT_MINUS_TAI + dat) * 1000) ?? dat;
  return msToCalendar(ttMs - (TT_MINUS_TAI + dat) * 1000);
}

/** True if UTC at this TDB time relies on extrapolating the leap-second table. */
export function utcIsPredicted(t: number): boolean {
  return J2000_LABEL_MS + t * 1000 - 69184 >= LEAP_TABLE_VALID_UNTIL_MS;
}

/**
 * A UTC instant (Unix ms, as from Date.now()) -> TDB seconds from J2000. Outside
 * the leap-second table, uses the nearest table value (37 s after 2017).
 */
export function utcMsToTdb(utcMs: number): number {
  const dat = taiMinusUtc(utcMs) ?? LEAP_MS[0][1];
  return (utcMs - J2000_LABEL_MS) / 1000 + TT_MINUS_TAI + dat;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatCalendar(c: Calendar, withSeconds = true): string {
  const y = c.year < 0 ? `-${pad(-c.year, 4)}` : pad(c.year, 4);
  const s = Math.floor(c.second);
  return `${y}-${pad(c.month)}-${pad(c.day)} ${pad(c.hour)}:${pad(c.minute)}${withSeconds ? `:${pad(s)}` : ''}`;
}

/**
 * Parse "YYYY-MM-DD", "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM:SS" as a TDB
 * calendar label. Returns null if malformed or out of range.
 */
export function parseCalendar(text: string): Calendar | null {
  const m = /^\s*(-?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?\s*(?:TDB)?\s*$/i.exec(text);
  if (!m) return null;
  const c: Calendar = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] ? Number(m[4]) : 0,
    minute: m[5] ? Number(m[5]) : 0,
    second: m[6] ? Number(m[6]) : 0,
  };
  if (c.month < 1 || c.month > 12 || c.day < 1 || c.hour > 23 || c.minute > 59 || c.second >= 60) return null;
  // Reject day overflow (e.g. Feb 30) by round-tripping.
  const back = msToCalendar(calendarToMs(c));
  if (back.year !== c.year || back.month !== c.month || back.day !== c.day) return null;
  return c;
}

/** Human-readable duration for warp rates and readouts. */
export function formatRate(secondsPerSecond: number): string {
  const r = secondsPerSecond;
  if (r < 60) return `${fmt(r)} s/s`;
  if (r < 3600) return `${fmt(r / 60)} min/s`;
  if (r < DAY) return `${fmt(r / 3600)} h/s`;
  if (r < JULIAN_YEAR / 2) return `${fmt(r / DAY)} d/s`;
  return `${fmt(r / JULIAN_YEAR)} yr/s`;
}

function fmt(x: number): string {
  return x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1).replace(/\.0$/, '') : x.toPrecision(2).replace(/\.?0+$/, '');
}
