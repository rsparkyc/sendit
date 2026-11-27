/**
 * One convention for every POINT in time the UI shows (as units.ts is for
 * distances): mission elapsed time (T+ from liftoff, or from the plan epoch
 * for a free-orbit start; negative before it), or an absolute calendar time
 * in UTC (derived from TDB with the leap-second table; marked predicted
 * beyond it; not defined before 1972, where TDB is shown) or in TDB (what
 * the simulation uses). Chosen in View or by tapping the status-bar clock,
 * persisted with the view settings. Durations (burn length, periods, time to
 * an event, limits) are not points in time and never go through here.
 *
 * Times are mission seconds (s after the plan epoch). The epoch is the
 * current plan's, registered by main.ts.
 */
import { formatMet, parseDuration } from './dom';
import { calendarToTdb, formatCalendar, parseCalendar, tdbToCalendar, tdbToUtc, utcIsPredicted, utcMsToTdb } from './time';

export type TimeMode = 'met' | 'utc' | 'tdb';
let mode: TimeMode = 'met';
let epoch = 0;
const listeners = new Set<() => void>();

export const timeMode = (): TimeMode => mode;
export function setTimeMode(m: TimeMode): void {
  if (m === mode) return;
  mode = m;
  for (const l of listeners) l();
}
export function onTimeMode(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
/** The plan epoch (TDB s from J2000) mission times are measured from. */
export function setTimeEpoch(e: number): void {
  epoch = e;
}
export const timeEpoch = (): number => epoch;

/** Next mode in the one-tap cycle. */
export const nextTimeMode = (m: TimeMode): TimeMode => (m === 'met' ? 'utc' : m === 'utc' ? 'tdb' : 'met');
export const TIME_MODE_LABEL: Record<TimeMode, string> = { met: 'MET', utc: 'UTC', tdb: 'TDB' };

function absolute(tMission: number, m: 'utc' | 'tdb', seconds: boolean, ep: number, decimals = 0): string {
  // Round to the shown precision first (so 59.96 s does not show as :59 of the previous minute).
  const q = 10 ** decimals;
  const t = Math.round((ep + tMission) * q) / q;
  const frac = (c: { second: number }) => (decimals > 0 ? (c.second - Math.floor(c.second)).toFixed(decimals).slice(1) : '');
  if (m === 'utc') {
    const u = tdbToUtc(t);
    if (u) return `${formatCalendar(u, seconds)}${frac(u)} UTC${utcIsPredicted(t) ? '*' : ''}`;
  }
  const c = tdbToCalendar(t);
  return `${formatCalendar(c, seconds)}${frac(c)} TDB`;
}

/** A point in time (mission seconds) in the current mode. `decimals` applies to MET. */
export function fmtTime(tMission: number, decimals = 0, m: TimeMode = mode, ep = epoch): string {
  if (!Number.isFinite(tMission)) return '—';
  return m === 'met' ? formatMet(tMission, decimals) : absolute(tMission, m, true, ep, decimals);
}

/** The same point in the other form (MET when absolute is shown, UTC (or TDB) when MET is shown): for a tooltip or a second line. */
export function otherTime(tMission: number, m: TimeMode = mode, ep = epoch): string {
  if (!Number.isFinite(tMission)) return '';
  return m === 'met' ? absolute(tMission, 'utc', true, ep) : `${formatMet(tMission, 0)} MET`;
}

/**
 * A planner date (absolute time, TDB s from J2000): the transfer planner works
 * in calendar dates, so it stays absolute in every mode (UTC, or TDB in TDB
 * mode; minute precision), with the mission elapsed time alongside when a
 * plan epoch is set: "2027-01-10 12:34 UTC · T+3d 04:05:06".
 */
export function plannerDate(tAbs: number, withMet = true, m: TimeMode = mode, ep = epoch): string {
  if (!Number.isFinite(tAbs)) return '—';
  const abs = absolute(tAbs - ep, m === 'tdb' ? 'tdb' : 'utc', false, ep);
  return withMet && ep !== 0 ? `${abs} · ${formatMet(tAbs - ep, 0)}` : abs;
}

/** Both, for a title: "T+00:34:00 · 2027-01-10 12:34:00 UTC". */
export function bothTimes(tMission: number, ep = epoch): string {
  return `${formatMet(tMission, 0)} · ${absolute(tMission, 'utc', true, ep)}`;
}

/** A time typed by the player, in either form: a calendar date (UTC or TDB as the mode, or as suffixed) or a MET / duration. Returns mission seconds or null. */
export function parseTime(text: string, m: TimeMode = mode, ep = epoch): number | null {
  const s = text.trim().replace(/\*$/, '');
  const utc = /\bUTC\s*$/i.test(s);
  const tdb = /\bTDB\s*$/i.test(s);
  const c = parseCalendar(s.replace(/\s*(UTC|TDB)\s*$/i, ''));
  if (c) {
    if (tdb || (!utc && m !== 'utc')) return calendarToTdb(c) - ep;
    const ms = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, 0) + c.second * 1000;
    return utcMsToTdb(ms) - ep;
  }
  return parseDuration(s);
}

/** A timeline axis label at mission time t for a tick step (s): MET as before, absolute as a short clock or date. */
export function axisTime(tMission: number, step: number, metLabel: (t: number, step: number) => string, m: TimeMode = mode, ep = epoch): string {
  if (m === 'met') return metLabel(tMission, step);
  const full = fmtTime(tMission, 0, m, ep);
  // "YYYY-MM-DD HH:MM:SS UTC": a date for day steps, the clock otherwise.
  return step >= 86400 ? full.slice(5, 10) : step >= 60 ? full.slice(11, 16) : full.slice(11, 19);
}
