/**
 * Declarative mission objectives, evaluated against a replay result, and the
 * score.
 *
 * LANGUAGE. A mission lists objectives; all must hold. Each goal objective is
 * satisfied at some time (the earliest that works), and `sequence` requires
 * its steps to be satisfied in order, each strictly after the previous one.
 * Constraints (`max-delta-v`, `max-time`) do not have a time.
 *
 *   { kind: 'flyby', body, minAltitude?, maxAltitude? }
 *       a periapsis (closest approach) of body with altitude in the band.
 *   { kind: 'visit', body, within }
 *       a closest approach within `within` metres of the centre.
 *   { kind: 'orbit', body, periapsis: [lo, hi], apoapsis: [lo, hi],
 *     inclination?: [loDeg, hiDeg], reference?: 'equator' | 'frame', revolutions }
 *       distance extrema to body stay inside the bands (and the orbit plane
 *       inside the inclination band) for `revolutions` orbital periods.
 *   { kind: 'reentry', body, maxSpeed? }
 *       the flight ends by entering body's atmosphere (speed relative to it).
 *   { kind: 'return', body, maxAltitude }
 *       a closest approach with altitude <= maxAltitude, or atmospheric entry.
 *   { kind: 'escape', body, minSpeed }
 *       at the end, hyperbolic excess speed w.r.t. body >= minSpeed.
 *   { kind: 'sequence', steps: Objective[] }
 *   { kind: 'max-delta-v', max }   { kind: 'max-time', max }
 *
 * Mission time for scoring and `max-time` is the time the last goal was met
 * (seconds after the epoch), not the length of the replay.
 *
 * ORBIT CHECK WITHOUT ORBITAL ELEMENTS. Periapsis and apoapsis are the
 * observed distance extrema (periapsis / apoapsis events). Inclination is
 * checked with dot products: cos i = h.k / |h| (h = r x v at each extremum,
 * k the body's pole or the frame z axis) compared with dmath cos of the band
 * limits. The period for counting revolutions is 2 pi sqrt(a^3/mu) with
 * a = (rp + ra)/2 from the first extrema of the run (sqrt only). Everything is
 * exactly defined, so evaluation is as deterministic as the replay.
 */
import type { TrajectoryEvent } from './events';
import { cos, DEG, PI } from '../physics/dmath';
import type { ReplayResult } from './replay';
import { bodyIndexOf, type MissionWorld } from './world';

export type Band = readonly [number, number];

export type Objective =
  | { readonly kind: 'flyby'; readonly body: string; readonly minAltitude?: number; readonly maxAltitude?: number }
  | { readonly kind: 'visit'; readonly body: string; readonly within: number }
  | {
      readonly kind: 'orbit';
      readonly body: string;
      readonly periapsis: Band;
      readonly apoapsis: Band;
      readonly inclination?: Band;
      readonly reference?: 'equator' | 'frame';
      readonly revolutions: number;
    }
  | { readonly kind: 'reentry'; readonly body: string; readonly maxSpeed?: number }
  | { readonly kind: 'return'; readonly body: string; readonly maxAltitude: number }
  | { readonly kind: 'escape'; readonly body: string; readonly minSpeed: number }
  | { readonly kind: 'sequence'; readonly steps: readonly Objective[] }
  | { readonly kind: 'max-delta-v'; readonly max: number }
  | { readonly kind: 'max-time'; readonly max: number };

export interface ScoreWeights {
  /** Reference delta-v, m/s: using this much costs `deltaVWeight`. */
  readonly deltaVRef: number;
  readonly deltaVWeight: number;
  /** Reference mission time, s. */
  readonly timeRef: number;
  readonly timeWeight: number;
}

export interface MissionDefinition {
  readonly id: string;
  readonly title: string;
  readonly objectives: readonly Objective[];
  readonly scoring: ScoreWeights;
  /** Spheres the replay should report (enter / exit). */
  readonly spheres?: readonly { body: string; radius: number }[];
}

export interface ObjectiveResult {
  readonly objective: Objective;
  readonly ok: boolean;
  /** Ephemeris time it was met (goals only). */
  readonly at?: number;
  readonly detail: string;
}

export interface Evaluation {
  readonly success: boolean;
  readonly objectives: readonly ObjectiveResult[];
  readonly deltaV: number;
  /** Time the last goal was met, s after epoch (replay elapsed if none). */
  readonly missionTime: number;
  readonly score: number;
}

/**
 * Combined score: 0 on failure, else 1e6 / (1 + wDv dv/dvRef + wT t/tRef),
 * floored. One small pure function, to be tuned.
 */
export function score(success: boolean, deltaV: number, missionTime: number, w: ScoreWeights): number {
  if (!success) return 0;
  const cost = 1 + (w.deltaVWeight * deltaV) / w.deltaVRef + (w.timeWeight * missionTime) / w.timeRef;
  return Math.floor(1e6 / cost);
}

interface Ctx {
  readonly result: ReplayResult;
  readonly world: MissionWorld;
  readonly epoch: number;
}

const NONE = { t: null as number | null, detail: '' };
type Met = { t: number | null; detail: string };

function eventsOf(ctx: Ctx, body: string, after: number, kinds: readonly string[]): TrajectoryEvent[] {
  return ctx.result.events.filter((e) => e.body === body && e.t > after && kinds.includes(e.kind));
}

function cross(r: readonly number[]): [number, number, number] {
  return [r[1] * r[5] - r[2] * r[4], r[2] * r[3] - r[0] * r[5], r[0] * r[4] - r[1] * r[3]];
}

/** Earliest time > after at which the goal is met. */
function goal(o: Objective, ctx: Ctx, after: number): Met {
  const fmtKm = (m: number) => `${(m / 1000).toFixed(1)} km`;
  switch (o.kind) {
    case 'flyby': {
      const lo = o.minAltitude ?? -Infinity;
      const hi = o.maxAltitude ?? Infinity;
      const ps = eventsOf(ctx, o.body, after, ['periapsis']);
      const hit = ps.find((e) => e.altitude >= lo && e.altitude <= hi);
      if (hit) return { t: hit.t, detail: `closest approach ${fmtKm(hit.altitude)} altitude` };
      const best = ps.reduce<TrajectoryEvent | null>((b, e) => (b === null || e.altitude < b.altitude ? e : b), null);
      return { t: null, detail: best ? `closest approach ${fmtKm(best.altitude)} altitude, outside the band` : `no close approach to ${o.body}` };
    }
    case 'visit': {
      const hit = eventsOf(ctx, o.body, after, ['periapsis']).find((e) => e.distance <= o.within);
      return hit ? { t: hit.t, detail: `passed within ${fmtKm(hit.distance)}` } : { t: null, detail: `never within ${fmtKm(o.within)} of ${o.body}` };
    }
    case 'return': {
      const hit = eventsOf(ctx, o.body, after, ['periapsis', 'atmosphere-entry']).find((e) => e.kind === 'atmosphere-entry' || e.altitude <= o.maxAltitude);
      return hit ? { t: hit.t, detail: `returned to ${o.body} (${hit.kind}, ${fmtKm(hit.altitude)})` } : { t: null, detail: `no return to ${o.body}` };
    }
    case 'reentry': {
      const r = ctx.result;
      const last = r.events[r.events.length - 1];
      if (r.outcome !== 'atmosphere' || !last || last.body !== o.body || !(last.t > after)) return { t: null, detail: `flight did not end in ${o.body}'s atmosphere` };
      if (o.maxSpeed !== undefined && last.speed > o.maxSpeed) return { t: null, detail: `entry at ${last.speed.toFixed(0)} m/s exceeds ${o.maxSpeed} m/s` };
      return { t: last.t, detail: `entered at ${last.speed.toFixed(0)} m/s` };
    }
    case 'escape': {
      const r = ctx.result;
      if (r.outcome !== 'completed' || !(r.finalT > after)) return { t: null, detail: 'flight did not complete' };
      const k = bodyIndexOf(ctx.world, o.body);
      const bs = new Float64Array(6);
      ctx.world.ephemeris.bodyState(k, r.finalT, bs);
      const y = r.finalState;
      let r2 = 0;
      let v2 = 0;
      for (let j = 0; j < 3; j++) {
        r2 += (y[j] - bs[j]) * (y[j] - bs[j]);
        v2 += (y[j + 3] - bs[j + 3]) * (y[j + 3] - bs[j + 3]);
      }
      const vinf2 = v2 - (2 * ctx.world.ephemeris.gm[k]) / Math.sqrt(r2);
      const ok = vinf2 >= o.minSpeed * o.minSpeed;
      const shown = vinf2 > 0 ? `${Math.sqrt(vinf2).toFixed(0)} m/s` : 'bound';
      return { t: ok ? r.finalT : null, detail: `excess speed ${shown}` };
    }
    case 'orbit':
      return orbitGoal(o, ctx, after);
    case 'sequence': {
      let t = after;
      const parts: string[] = [];
      for (let i = 0; i < o.steps.length; i++) {
        const m = goal(o.steps[i], ctx, t);
        if (m.t === null) return { t: null, detail: `step ${i + 1} (${o.steps[i].kind}) not met after step ${i}: ${m.detail}` };
        parts.push(m.detail);
        t = m.t;
      }
      return { t, detail: parts.join('; then ') };
    }
    case 'max-delta-v':
    case 'max-time':
      return NONE;
  }
}

function orbitGoal(o: Extract<Objective, { kind: 'orbit' }>, ctx: Ctx, after: number): Met {
  const k = bodyIndexOf(ctx.world, o.body);
  if (k < 0) return { t: null, detail: `unknown body ${o.body}` };
  const mu = ctx.world.ephemeris.gm[k];
  const pole = o.reference === 'frame' ? null : ctx.world.bodies[k].pole;
  const axis: readonly number[] = pole ?? [0, 0, 1];
  const inc = o.inclination;
  const cosHi = inc ? cos(inc[1] * DEG) : -1; // cos i >= cosHi  <=>  i <= hi
  const cosLo = inc ? cos(inc[0] * DEG) : 1; //  cos i <= cosLo  <=>  i >= lo
  const ext = eventsOf(ctx, o.body, after, ['periapsis', 'apoapsis']);
  const inBand = (e: TrajectoryEvent): boolean => {
    const band = e.kind === 'periapsis' ? o.periapsis : o.apoapsis;
    if (!(e.distance >= band[0] && e.distance <= band[1])) return false;
    if (!inc) return true;
    const h = cross(e.rel);
    const hn = Math.sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
    const hk = h[0] * axis[0] + h[1] * axis[1] + h[2] * axis[2];
    return hk >= cosHi * hn && hk <= cosLo * hn;
  };
  let best = 0;
  for (let s = 0; s < ext.length; s++) {
    if (!inBand(ext[s])) continue;
    // Run of in-band extrema starting at s; needs one of each kind for a period.
    let rp = NaN;
    let ra = NaN;
    let need = Infinity;
    let j = s;
    for (; j < ext.length && inBand(ext[j]); j++) {
      const e = ext[j];
      if (e.kind === 'periapsis' && Number.isNaN(rp)) rp = e.distance;
      if (e.kind === 'apoapsis' && Number.isNaN(ra)) ra = e.distance;
      if (need === Infinity && !Number.isNaN(rp) && !Number.isNaN(ra)) {
        const a = 0.5 * (rp + ra);
        need = ext[s].t + o.revolutions * 2 * PI * Math.sqrt((a * a * a) / mu);
      }
      if (e.t >= need) return { t: e.t, detail: `held ${o.revolutions} revolutions (rp ${(rp / 1000).toFixed(0)} km, ra ${(ra / 1000).toFixed(0)} km)` };
      if (need !== Infinity) best = Math.max(best, ((e.t - ext[s].t) / (need - ext[s].t)) * o.revolutions);
    }
    s = j; // Later starts inside the same run cannot finish earlier: skip it (keeps this linear).
  }
  const ext0 = ext.length > 0 ? `; first extrema ${ext.slice(0, 2).map((e) => `${e.kind} ${(e.distance / 1000).toFixed(0)} km`).join(', ')}` : '';
  return { t: null, detail: `orbit held for at most ${best.toFixed(2)} of ${o.revolutions} revolutions${ext0}` };
}

/** Evaluate a mission's objectives against a replay. */
export function evaluate(mission: MissionDefinition, result: ReplayResult, world: MissionWorld, epoch: number): Evaluation {
  const ctx: Ctx = { result, world, epoch };
  const out: ObjectiveResult[] = [];
  let last = -Infinity;
  for (const o of mission.objectives) {
    if (o.kind === 'max-delta-v' || o.kind === 'max-time') continue;
    const m = goal(o, ctx, -Infinity);
    out.push({ objective: o, ok: m.t !== null, at: m.t ?? undefined, detail: m.detail });
    if (m.t !== null && m.t > last) last = m.t;
  }
  const goalsOk = out.every((r) => r.ok);
  const missionTime = last === -Infinity ? result.elapsed : last - epoch;
  for (const o of mission.objectives) {
    if (o.kind === 'max-delta-v') out.push({ objective: o, ok: result.deltaV <= o.max, detail: `used ${result.deltaV.toFixed(1)} of ${o.max} m/s` });
    else if (o.kind === 'max-time') out.push({ objective: o, ok: goalsOk && missionTime <= o.max, detail: `took ${missionTime.toFixed(0)} of ${o.max} s` });
  }
  // Impact always fails; atmospheric entry only counts if a reentry objective accepted it.
  const ended = result.outcome === 'completed' || (result.outcome === 'atmosphere' && out.some((r) => r.ok && usesReentry(r.objective)));
  const success = ended && out.every((r) => r.ok);
  return { success, objectives: out, deltaV: result.deltaV, missionTime, score: score(success, result.deltaV, missionTime, mission.scoring) };
}

function usesReentry(o: Objective): boolean {
  return o.kind === 'reentry' || o.kind === 'return' || (o.kind === 'sequence' && o.steps.some(usesReentry));
}
