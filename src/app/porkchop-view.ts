/**
 * Porkchop chart maths, pure (no DOM): the request for a date grid, the
 * plotted quantity per cell, a perceptually uniform sequential colour scale
 * (viridis: dark violet = low = good, bright yellow = high, legible on the dark
 * UI), contour lines by marching squares, date ticks, and cell lookup.
 */
import type { PorkchopRequest } from './protocol';
import { tdbToCalendar } from './time';

export type Quantity = 'c3' | 'vInfArr' | 'dvTotal';

export const QUANTITIES: readonly { id: Quantity; label: string; unit: string; scale: number }[] = [
  { id: 'c3', label: 'Departure C3', unit: 'km²/s²', scale: 1e-6 },
  { id: 'vInfArr', label: 'Arrival v∞', unit: 'km/s', scale: 1e-3 },
  { id: 'dvTotal', label: 'Total Δv (escape from 200 km alt)', unit: 'km/s', scale: 1e-3 },
];

export interface Grid {
  nDep: number;
  nArr: number;
  depTimes: Float64Array;
  arrTimes: Float64Array;
  c3: Float64Array;
  vInfArr: Float64Array;
  dvTotal: Float64Array;
  dla: Float64Array;
  rla: Float64Array;
  theta: Float64Array;
  vInfDep: Float64Array;
}

export function porkchopRequest(departure: string, arrival: string, depStart: number, depEnd: number, arrStart: number, arrEnd: number, nDep = 160, nArr = 160): PorkchopRequest {
  return { departure, arrival, depStart, depEnd, nDep, arrStart, arrEnd, nArr };
}

/** Values of a quantity in display units. */
export function field(g: Grid, q: Quantity): Float64Array {
  const s = QUANTITIES.find((x) => x.id === q)!.scale;
  return g[q].map((v) => v * s);
}

/**
 * Colour range: from the minimum to a cap that keeps the interesting region
 * spread over the scale (min + 4 x (median - min), at most the max).
 */
export function colourRange(f: ArrayLike<number>): [number, number] {
  const v: number[] = [];
  for (let i = 0; i < f.length; i++) if (Number.isFinite(f[i])) v.push(f[i]);
  if (v.length === 0) return [0, 1];
  v.sort((a, b) => a - b);
  const lo = v[0];
  const med = v[Math.floor(v.length / 2)];
  const hi = Math.min(v[v.length - 1], lo + 4 * (med - lo));
  return [lo, hi > lo ? hi : lo + 1];
}

// Viridis, 9 stops (matplotlib), interpolated linearly in sRGB.
const VIRIDIS = [
  [68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141], [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37],
];

/** RGB of viridis at u in [0, 1]. */
export function viridis(u: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, u)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const f = x - i;
  const a = VIRIDIS[i];
  const b = VIRIDIS[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

/** "Nice" contour levels between lo and hi (about `count` of them). */
export function contourLevels(lo: number, hi: number, count = 8): number[] {
  if (!(hi > lo)) return [];
  const raw = (hi - lo) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(10));
  return out;
}

/**
 * Contour segments of `level` on an nx-by-ny field (x fastest), in cell
 * coordinates (x = i, y = j at sample centres). Marching squares; cells with
 * a NaN corner are skipped. Returns [x1, y1, x2, y2] per segment.
 */
export function contour(f: ArrayLike<number>, nx: number, ny: number, level: number): number[] {
  const out: number[] = [];
  const at = (i: number, j: number) => f[j * nx + i];
  const lerp = (a: number, b: number) => (level - a) / (b - a);
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) continue;
      const pts: number[] = [];
      // Edges: bottom (a-b), right (b-c), top (d-c), left (a-d).
      if ((a < level) !== (b < level)) pts.push(i + lerp(a, b), j);
      if ((b < level) !== (c < level)) pts.push(i + 1, j + lerp(b, c));
      if ((d < level) !== (c < level)) pts.push(i + lerp(d, c), j + 1);
      if ((a < level) !== (d < level)) pts.push(i, j + lerp(a, d));
      if (pts.length === 4) out.push(...pts);
      else if (pts.length === 8) out.push(pts[0], pts[1], pts[2], pts[3], pts[4], pts[5], pts[6], pts[7]);
    }
  }
  return out;
}

/** Month ticks between t0 and t1 (s TDB): time and label ("Nov 2026" in January, else "Nov"). */
export function monthTicks(t0: number, t1: number): { t: number; label: string; major: boolean }[] {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const c = tdbToCalendar(t0);
  let y = c.year;
  let m = c.month;
  const out: { t: number; label: string; major: boolean }[] = [];
  const span = (t1 - t0) / 86400;
  const every = span > 1500 ? 6 : span > 700 ? 3 : span > 300 ? 2 : 1;
  for (let guard = 0; guard < 400; guard++) {
    m++;
    if (m > 12) { m = 1; y++; }
    const t = (Date.UTC(y, m - 1, 1) - Date.UTC(2000, 0, 1, 12)) / 1000;
    if (t > t1) break;
    if ((m - 1) % every !== 0) continue;
    out.push({ t, label: m === 1 || out.length === 0 ? `${M[m - 1]} ${y}` : M[m - 1], major: m === 1 });
  }
  return out;
}

/** Grid cell under a point given as fractions (0..1) of the plot area (y up), or null outside. */
export function cellAt(g: Pick<Grid, 'nDep' | 'nArr'>, fx: number, fy: number): { i: number; j: number } | null {
  if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return null;
  return { i: Math.min(g.nDep - 1, Math.round(fx * (g.nDep - 1))), j: Math.min(g.nArr - 1, Math.round(fy * (g.nArr - 1))) };
}

/** Transfer type of a cell from its transfer angle: I (< 180 deg) or II (> 180 deg). */
export function transferType(theta: number): 'I' | 'II' | null {
  if (!Number.isFinite(theta)) return null;
  return theta < Math.PI ? 'I' : 'II';
}

/** Index of the smallest finite value, or -1. */
export function argMin(f: ArrayLike<number>): number {
  let k = -1;
  for (let q = 0; q < f.length; q++) if (Number.isFinite(f[q]) && (k < 0 || f[q] < f[k])) k = q;
  return k;
}

/** Departure v-infinity vector (ICRF, m/s) of a cell from its magnitude, declination and right ascension. */
export function vInfVector(g: Grid, k: number): [number, number, number] {
  const v = g.vInfDep[k], d = g.dla[k], r = g.rla[k];
  return [v * Math.cos(d) * Math.cos(r), v * Math.cos(d) * Math.sin(r), v * Math.sin(d)];
}
