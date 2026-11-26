/**
 * Which replay events to list and mark. Pure.
 *
 * The replay reports a periapsis and apoapsis of EVERY body on every orbit,
 * which for a flight in low Earth orbit includes Jupiter's. The list keeps:
 *  - every terminal / crossing event (impact, atmosphere, sphere enter / exit);
 *  - periapsis and apoapsis of a body while the craft is inside that body's
 *    sphere of influence; for the Sun (no SOI) only while the craft is in no
 *    other body's SOI (`dominant`, when given, decides that);
 *  - one "closest approach" per other body, if the craft came within
 *    `nearFactor` sphere-of-influence radii of it.
 */
import type { EventKind, TrajectoryEvent } from './mission-layer';

export interface ListedEvent {
  /** Index into result.events. */
  index: number;
  ev: TrajectoryEvent;
  /** 'closest' marks a per-body closest approach outside that body's SOI. */
  role: 'event' | 'closest';
  failure: boolean;
}

export const FAILURE_KINDS: readonly EventKind[] = ['impact', 'atmosphere-entry'];

export function listEvents(
  events: readonly TrajectoryEvent[],
  soi: ReadonlyMap<string, number>,
  opts: { nearFactor?: number; max?: number; failureKinds?: readonly EventKind[]; dominant?: (t: number) => string } = {},
): ListedEvent[] {
  const near = opts.nearFactor ?? 10;
  const max = opts.max ?? 400;
  const failures = opts.failureKinds ?? FAILURE_KINDS;
  const out: ListedEvent[] = [];
  const closest = new Map<string, number>();
  events.forEach((ev, index) => {
    const r = soi.get(ev.body);
    if (ev.kind !== 'periapsis' && ev.kind !== 'apoapsis') {
      out.push({ index, ev, role: 'event', failure: failures.includes(ev.kind) });
      return;
    }
    const inside = r === undefined ? (opts.dominant ? opts.dominant(ev.t) === ev.body : true) : ev.distance < r;
    if (inside) {
      out.push({ index, ev, role: 'event', failure: false });
      return;
    }
    if (ev.kind === 'periapsis' && r !== undefined && ev.distance < near * r) {
      const c = closest.get(ev.body);
      if (c === undefined || ev.distance < events[c].distance) closest.set(ev.body, index);
    }
  });
  for (const index of closest.values()) out.push({ index, ev: events[index], role: 'closest', failure: false });
  out.sort((a, b) => a.ev.t - b.ev.t || a.index - b.index);
  if (out.length > max) {
    // Keep failures, crossings and closest approaches; thin the rest evenly.
    const keep = out.filter((x) => x.role === 'closest' || x.failure || (x.ev.kind !== 'periapsis' && x.ev.kind !== 'apoapsis'));
    const rest = out.filter((x) => !keep.includes(x));
    const room = Math.max(0, max - keep.length);
    const stride = rest.length / Math.max(1, room);
    const thinned = rest.filter((_, i) => Math.floor(i / stride) !== Math.floor((i - 1) / stride));
    return [...keep, ...thinned.slice(0, room)].sort((a, b) => a.ev.t - b.ev.t || a.index - b.index);
  }
  return out;
}

const LABEL: Record<EventKind, string> = {
  periapsis: 'Periapsis',
  apoapsis: 'Apoapsis',
  impact: 'IMPACT',
  'atmosphere-entry': 'Atmosphere entry',
  'atmosphere-exit': 'Atmosphere exit',
  enter: 'Enters SOI',
  exit: 'Leaves SOI',
};

export function eventLabel(x: ListedEvent, bodyName: (id: string) => string): string {
  if (x.role === 'closest') return `Closest approach ${bodyName(x.ev.body)}`;
  return `${LABEL[x.ev.kind]} ${bodyName(x.ev.body)}`;
}

/** Short marker text for the 3D view. */
export function eventMarker(x: ListedEvent, bodyName: (id: string) => string): string {
  const km = (m: number) => `${Math.round(m / 1000).toLocaleString('en-US')} km`;
  const b = bodyName(x.ev.body);
  switch (x.role === 'closest' ? 'closest' : x.ev.kind) {
    case 'closest': return `CA ${b} ${km(x.ev.altitude)}`;
    case 'periapsis': return `Pe ${km(x.ev.altitude)}`;
    case 'apoapsis': return `Ap ${km(x.ev.altitude)}`;
    case 'impact': return `IMPACT ${b}`;
    case 'atmosphere-entry': return `ENTRY ${b} ${(x.ev.speed / 1000).toFixed(2)} km/s`;
    case 'atmosphere-exit': return `exit atm ${b}`;
    case 'enter': return `→ ${b} SOI`;
    case 'exit': return `← ${b} SOI`;
  }
  return b;
}
