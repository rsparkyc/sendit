/**
 * Default porkchop dates from the mission profile and the current time: which
 * bodies the transfer is between (the plan's start and the mission's first
 * target), and departure / arrival ranges around the next transfer window
 * (least departure C3) from `earliest` on, kept inside the mission's time limit.
 *
 * Advisory and pure: two-body (Sun-centred) Kepler orbits from the J2000
 * states and a coarse Lambert scan, which put a window within days of the real one;
 * the chart itself is computed on the real ephemeris, and the ranges are wide
 * enough to contain the minimum.
 */
import type { CompleteMission, MissionPlan, Objective } from './mission-layer';
import { dot, keplerPropagate, norm, sub, type Vec3 } from '../planning/kepler';
import { solveLambert } from '../planning/lambert';
import { DAY, tdbToCalendar } from './time';

export interface DateBody {
  readonly id: string;
  readonly parentId: string | null;
  readonly gm: number;
  readonly state0: readonly number[];
}

/** [depart from, depart to, arrive from, arrive to], TDB s. */
export type DateRange = [number, number, number, number];

export interface DateSuggestion {
  range: DateRange;
  /** Departure of least C3 (two-body) the ranges are built around (null: no transfer arrives by the deadline; ranges start at `earliest`). */
  window: number | null;
  /** Flight time of that least-C3 transfer, s. */
  tof: number;
}

/** The planet (Sun-orbiting body) a body belongs to: a moon's parent, else itself; null for the Sun. */
export function planetOf(bodies: readonly DateBody[], id: string): string | null {
  const b = bodies.find((x) => x.id === id);
  if (!b || b.id === 'sun') return null;
  return b.parentId ?? b.id;
}

function bodyTargets(objs: readonly Objective[], out: string[]): string[] {
  for (const o of objs) {
    if (o.kind === 'sequence') bodyTargets(o.steps, out);
    else if (o.kind === 'flyby' || o.kind === 'visit' || o.kind === 'orbit') out.push(o.body);
  }
  return out;
}

/**
 * Departure and arrival planets for a plan's mission. Departure: Earth for a
 * launch, the start centre's planet for a free start. Arrival: the planet of
 * the first flyby / visit / orbit goal that is not the departure planet.
 * Null fields: the mission says nothing (keep the current choice).
 */
export function transferBodies(bodies: readonly DateBody[], def: CompleteMission | null, plan: MissionPlan): { departure: string | null; arrival: string | null } {
  const departure = plan.start.kind === 'launch' ? 'earth' : planetOf(bodies, plan.start.center);
  let arrival: string | null = null;
  for (const id of bodyTargets(def?.objectives ?? [], [])) {
    const p = planetOf(bodies, id);
    if (p && p !== departure) {
      arrival = p;
      break;
    }
  }
  return { departure, arrival };
}

/** Latest arrival a mission allows: liftoff + the shorter of its duration limit and its max-time goal. Infinity for sandbox. */
export function missionDeadline(def: CompleteMission | null, epoch: number): number {
  if (!def) return Infinity;
  let lim = def.maxDuration;
  for (const o of def.objectives) if (o.kind === 'max-time') lim = Math.min(lim, o.max);
  return epoch + lim;
}

/**
 * Earliest departure to suggest: liftoff, or the view time when it falls on a
 * later calendar date than liftoff and is still inside the mission. The date
 * inputs hold whole days, so a view time on liftoff's date would give the same
 * dates; counting it as "the current time" would only mislabel them.
 */
export function earliestDeparture(epoch: number, viewT: number, deadline: number): { t: number; fromView: boolean } {
  const date = (t: number) => {
    const c = tdbToCalendar(t);
    return c.year * 10000 + c.month * 100 + c.day;
  };
  const fromView = viewT < deadline && date(viewT) > date(epoch);
  return { t: fromView ? viewT : epoch, fromView };
}

/**
 * Departure / arrival ranges for a transfer between two planets, departing no
 * earlier than `earliest` and arriving no later than `deadline`. Null when the
 * two are the same planet (or either is the Sun): a heliocentric porkchop has
 * nothing to show there.
 */
export function suggestDates(bodies: readonly DateBody[], depId: string, arrId: string, earliest: number, deadline = Infinity): DateSuggestion | null {
  const sun = bodies.find((b) => b.id === 'sun');
  const p1 = planetOf(bodies, depId);
  const p2 = planetOf(bodies, arrId);
  if (!sun || !p1 || !p2 || p1 === p2) return null;
  const b1 = bodies.find((b) => b.id === p1)!;
  const b2 = bodies.find((b) => b.id === p2)!;
  const mu = sun.gm;
  const helio = (b: DateBody): { r: Vec3; v: Vec3 } => ({ r: sub(b.state0.slice(0, 3), sun.state0.slice(0, 3)), v: sub(b.state0.slice(3, 6), sun.state0.slice(3, 6)) });
  const s1 = helio(b1);
  const s2 = helio(b2);
  const sma = (s: { r: Vec3; v: Vec3 }) => 1 / (2 / norm(s.r) - dot(s.v, s.v) / mu);
  const a1 = sma(s1);
  const a2 = sma(s2);
  const n1 = Math.sqrt(mu / a1 ** 3);
  const n2 = Math.sqrt(mu / a2 ** 3);
  const tH = Math.PI * Math.sqrt(((a1 + a2) / 2) ** 3 / mu);
  const synodic = (2 * Math.PI) / Math.abs(n1 - n2);
  // Half-width of the departure range: a tenth of the synodic period, 20 to 120 days.
  const half = Math.min(120 * DAY, Math.max(20 * DAY, 0.1 * synodic));

  // Coarse two-body scan: the departure (and flight time) of least C3 among departures from
  // `earliest` to a synodic period later and arrivals by the deadline. An open window counts
  // from `earliest`; one that closed has a higher C3 than the next, which wins.
  const first = Number.isFinite(earliest) ? earliest : 0;
  const span = Math.min(1.05 * synodic, 3 * 365.25 * DAY);
  const step = Math.max(DAY, Math.min(5 * DAY, span / 150));
  const nTof = 16;
  let best = Infinity;
  let window: number | null = null;
  let bestTof = tH;
  for (let td = first; td <= first + span; td += step) {
    const d = keplerPropagate(s1.r, s1.v, td, mu);
    for (let k = 0; k < nTof; k++) {
      const tof = tH * (0.45 + (1.1 * k) / (nTof - 1));
      if (td + tof > deadline) break;
      const r2 = keplerPropagate(s2.r, s2.v, td + tof, mu).r;
      for (const sol of solveLambert(d.r, r2, tof, mu)) {
        const vi = sub(sol.v1, d.v);
        const c3 = dot(vi, vi);
        if (c3 < best) { best = c3; window = td; bestTof = tof; }
      }
    }
  }

  let d0: number, d1: number;
  if (window !== null) {
    d0 = Math.max(earliest, window - half);
    d1 = Math.max(window + half, d0 + half);
  } else {
    d0 = earliest;
    d1 = earliest + 2 * half;
  }
  let a0 = d0 + 0.65 * bestTof;
  let a1x = d1 + 1.35 * bestTof;
  if (Number.isFinite(deadline)) {
    a1x = Math.min(a1x, deadline);
    d1 = Math.max(d0 + 10 * DAY, Math.min(d1, deadline - 0.65 * bestTof));
    if (!(a1x > a0 + 10 * DAY)) a0 = Math.max(d0 + 10 * DAY, a1x - 0.8 * bestTof);
    if (!(a1x > a0 + 10 * DAY)) a1x = a0 + 10 * DAY;
  }
  return { range: [d0, d1, a0, a1x], window, tof: bestTof };
}
