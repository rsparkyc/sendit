/**
 * Number formatting for every panel, in one place: one precision per quantity,
 * chosen for what the number means, not what the float holds. Pure.
 *
 *  Δv (budgets, limits, totals, reserves): whole m/s. Nothing in a mission
 *    budget is meaningful below 1 m/s, and limits are whole by definition.
 *  Δv of a single burn (requested, flown): 0.1 m/s, the editor's finest step.
 *  Speed (state at an instant): 0.1 m/s; km/s with 0.001 above 10 km/s.
 *  Mass: whole kg; tonnes with 0.1 at and above 100 t.
 *  Angle: inclination / azimuth 0.01°, other orbital angles 0.1° (fmtAngle's `places`).
 *  Distances: units.ts (the distance convention); times: timefmt.ts.
 *  Durations in days: 0.1 d (limits and references); 0.01 d for a score's time.
 */

const n0 = (v: number) => (Math.round(v) + 0).toLocaleString('en-US');
const nf = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Δv of a budget, limit, total or reserve: "12,490 m/s". */
export function fmtDv(v: number): string {
  return Number.isFinite(v) ? `${n0(v)} m/s` : '—';
}

/** Δv of one burn, to the editor's finest step: "3,167.2 m/s". */
export function fmtDvFine(v: number): string {
  return Number.isFinite(v) ? `${nf(v, 1)} m/s` : '—';
}

/** Signed Δv difference: "+142 m/s", "−35 m/s", "±0 m/s". */
export function fmtDvDelta(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const r = Math.round(v);
  return r === 0 ? '±0 m/s' : `${r > 0 ? '+' : '−'}${n0(Math.abs(r))} m/s`;
}

/** Speed at an instant: "7,784.3 m/s", "11.203 km/s". */
export function fmtSpeed(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return Math.abs(v) < 1e4 ? `${nf(v, 1)} m/s` : `${(v / 1000).toFixed(3)} km/s`;
}

/** Mass: "8,450 kg", "549.1 t". */
export function fmtMass(kg: number): string {
  if (!Number.isFinite(kg)) return '—';
  return Math.abs(kg) >= 1e5 ? `${nf(kg / 1000, 1)} t` : `${n0(kg)} kg`;
}

/** Angle in degrees: `places` 2 for inclinations and azimuths (default), 1 for coarse angles. */
export function fmtAngle(d: number, places = 2): string {
  return Number.isFinite(d) ? `${d.toFixed(places).replace(/^-(0\.?0*)$/, '$1')}°` : '—';
}

/** Days: "7.0 d" (`places` 1) or "2.94 d". */
export function fmtDays(s: number, places = 1): string {
  return Number.isFinite(s) ? `${(s / 86400).toFixed(places)} d` : '—';
}

/** A launch site's name without its parenthetical or region: "Cape Canaveral SFS SLC-40", "Equatorial reference site". */
export function siteName(full: string): string {
  return full.replace(/\s*\([^)]*\)\s*$/, '').split(',')[0].trim();
}

/** The shortest form for a map label: "Cape Canaveral", "Equatorial reference site". */
export function siteShort(full: string): string {
  return siteName(full).replace(/ (SFS|SFB|Space|Cosmodrome|Launch|LC|SLC|Site)\b.*$/, '');
}

/**
 * Tidy a mission-layer detail string for display: "used 12143.0 of 12490 m/s (ascent 8975.8 + flight 3167.2)"
 * becomes "used 12,143 of 12,490 m/s (ascent 8,976 + flight 3,167)". Numbers of 100 or more lose their decimals
 * and gain thousands separators; smaller ones (days, degrees) are left as they are.
 */
export function tidyDetail(text: string): string {
  // Not inside a date or time (2027-01-10, 12:09), not already grouped (339,070).
  return text.replace(/(?<![\d.,:\-])\d{3,}(?:\.\d+)?(?![\d,:\-])/g, (m) => n0(Number(m)));
}
