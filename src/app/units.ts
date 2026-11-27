/**
 * One distance convention for every distance to a body the UI shows: altitude
 * above the surface (default, what the map and KSP use) or radius from the
 * body's centre, chosen in View and persisted. Every number carries its word
 * ("alt" or "radius") so it cannot be misread. The Sun is always a distance
 * from its centre (km, or AU when large): its "surface" is no useful reference.
 *
 * Altitudes are above each body's reference radius (physics.ts BODIES
 * refRadius = BodyData.referenceRadius, the equatorial radius of its gravity
 * field), the one radius the mission layer, launch, events and objectives
 * use, so a converted value agrees exactly with the events. Mission limits stay radii in the mission
 * definitions; this is display only.
 */
import { BODIES, bodyIndex } from './physics';

export type DistanceMode = 'alt' | 'radius';
let mode: DistanceMode = 'alt';
const listeners = new Set<() => void>();

export function distanceMode(): DistanceMode {
  return mode;
}

export function setDistanceMode(m: DistanceMode): void {
  if (m === mode) return;
  mode = m;
  for (const l of listeners) l();
}

export function onDistanceMode(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function bodyRadius(id: string): number {
  const i = bodyIndex(id);
  return i >= 0 ? BODIES[i].refRadius : 0;
}

const AU = 149_597_870_700;
// `+ 0` turns a rounded -0 into 0 (no "-0 km" at a surface impact).
const km = (m: number) => `${(Math.round(m / 1000) + 0).toLocaleString('en-US')} km`;

/**
 * A labelled distance row for a readout: the distance (m) from the centre of
 * `body` (a body id, or null for a barycentre), as [label, value]. Bodies
 * follow the setting ("Altitude above Earth" / "Radius from Earth’s centre");
 * the Sun and barycentres are always from the centre (km, or AU when large).
 */
export function distanceRow(d: number, body: string | null, name: string): [string, string] {
  const big = (m: number) => (!Number.isFinite(m) ? '—' : Math.abs(m) >= 0.01 * AU ? `${(m / AU).toFixed(4)} AU` : km(m));
  if (body === null) return ['Distance from barycentre', big(d)];
  if (body === 'sun') return ['Distance from Sun’s centre', big(d)];
  if (!Number.isFinite(d)) return [mode === 'radius' ? `Radius from ${name}’s centre` : `Altitude above ${name}`, '—'];
  return mode === 'radius' ? [`Radius from ${name}’s centre`, km(d)] : [`Altitude above ${name}`, km(d - bodyRadius(body))];
}

/** A distance from a body's centre (m), shown in the chosen convention with its word. */
export function fromCentre(d: number, body: string): string {
  if (!Number.isFinite(d)) return '∞';
  if (body === 'sun') return d > 0.05 * AU ? `${(d / AU).toFixed(3)} AU from the Sun` : `${km(d)} from the Sun's centre`;
  return mode === 'radius' ? `${km(d)} radius` : `${km(d - bodyRadius(body))} alt`;
}

/** An altitude above a body's surface (m), shown in the chosen convention. */
export function fromSurface(alt: number, body: string): string {
  return fromCentre(alt + bodyRadius(body), body);
}

/** Same, for a band [lo, hi] given as radii, e.g. "35,686–35,886 km alt". */
export function bandFromCentre(lo: number, hi: number, body: string): string {
  if (body === 'sun') return `${fromCentre(lo, body)} to ${fromCentre(hi, body)}`;
  const sub = mode === 'radius' ? 0 : bodyRadius(body);
  const f = (d: number) => (Number.isFinite(d) ? (Math.round((d - sub) / 1000) + 0).toLocaleString('en-US') : '∞');
  return `${f(lo)}–${f(hi)} km ${mode === 'radius' ? 'radius' : 'alt'}`;
}

/**
 * Rewrite the distances in a mission-layer text (objective details, briefings)
 * into the chosen convention, for a body. Recognised forms:
 * "rp N km" / "ra N km" / "periapsis N km" / "apoapsis N km" (radii),
 * "N km from <Body>’s centre" (radius), "passed within N km" (radius),
 * "closest approach N km altitude" and "N km altitude" (altitudes).
 */
export function convertText(text: string, body: string | null): string {
  // Mission time limits are stated in days: say the time used in days too.
  text = text.replace(/took (\d+(?:\.\d+)?) of (\d+(?:\.\d+)?) s\b/g, (_, a: string, b: string) => `took ${(Number(a) / 86400).toFixed(2)} of ${(Number(b) / 86400).toFixed(1)} days`);
  if (!body) return text;
  const num = (s: string) => Number(s.replace(/,/g, '')) * 1000;
  let out = text.replace(/\b(rp|ra|periapsis|apoapsis) ([\d,]+(?:\.\d+)?) km\b/g, (_, k: string, n: string) => `${k} ${fromCentre(num(n), body)}`);
  out = out.replace(/([\d,]+(?:\.\d+)?) km from ([A-Z][a-z]+)(’|')s centre/g, (_, n: string, b: string) => fromCentre(num(n), b.toLowerCase()));
  out = out.replace(/passed within ([\d,]+(?:\.\d+)?) km/g, (_, n: string) => `passed within ${fromCentre(num(n), body)}`);
  out = out.replace(/([\d,]+(?:\.\d+)?) km altitude/g, (_, n: string) => fromSurface(num(n), body));
  return out;
}
