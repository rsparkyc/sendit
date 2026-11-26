/**
 * Declarative mission objectives, evaluated against a replay result, and the
 * score.
 *
 * LANGUAGE. A mission lists objectives; all must hold. Each goal objective is
 * satisfied at some time (the earliest that works), and `sequence` requires
 * its steps to be satisfied in order, each strictly after the previous one.
 * Constraints (`max-delta-v`, `max-time`) do not have a time.
 *
 *   { kind: 'flyby', body, minAltitude?, maxAltitude?, maxSpeed? }
 *       a periapsis (closest approach) of body with altitude in the band
 *       (and speed relative to the body at most maxSpeed).
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
 * k the body's pole at that time, as the physics orients its field, or the
 * frame z axis) compared with dmath cos of the band
 * limits. The period for counting revolutions is 2 pi sqrt(a^3/mu) with
 * a = (rp + ra)/2 from the first extrema of the run (sqrt only). Everything is
 * exactly defined, so evaluation is as deterministic as the replay.
 */
import type { TrajectoryEvent } from './events';
import { cos, DEG, PI } from '../physics/dmath';
import { DEFAULT_ASCENT_TIME_S, DEFAULT_DOWNRANGE_DEG, launchToParams } from './launch';
import { isVehicleLaunch, makePlan, type MissionPlan, type Spacecraft, type Stage } from './plan';
import type { ReplayOptions, ReplayResult } from './replay';
import { bodyIndexOf, bodyPoleAt, type MissionWorld } from './world';

export type Band = readonly [number, number];

export type Objective =
  | { readonly kind: 'flyby'; readonly body: string; readonly minAltitude?: number; readonly maxAltitude?: number; readonly maxSpeed?: number }
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
  /** Par delta-v, m/s: the reference solution's (see `score`). */
  readonly deltaVRef: number;
  /** Relative weight of delta-v in the combined score (weights are normalised by their sum). */
  readonly deltaVWeight: number;
  /** Par mission time, s. */
  readonly timeRef: number;
  readonly timeWeight: number;
}

/** Where a mission starts by default. */
export type MissionStart =
  /** Parking-orbit launch (launch.ts) from `site`; liftoff at the mission epoch. */
  | { readonly kind: 'launch'; readonly site: string; readonly azimuthDeg: number; readonly altitudeM: number }
  /** State [x, y, z, vx, vy, vz] (m, m/s) relative to `center` at the mission epoch. */
  | { readonly kind: 'state'; readonly center: string; readonly state: readonly number[] };

/**
 * A launch site's standing in a mission (campaign.ts `launchSites`): offered,
 * with that site's own reference solution and limits, or not offered, with
 * the reason. The reference values come from per-site solutions kept only in
 * tests (test/mission-campaign-sites.test.ts).
 */
export type SiteOption =
  | {
      readonly site: string;
      readonly offered: true;
      /** Reference solution from this site: delta-v (total: ascent + flight), m/s, and mission time, s. */
      readonly deltaV: number;
      /** Of the reference's delta-v, the ascent's (vehicle launch), m/s, to 0.1. */
      readonly ascentDeltaV?: number;
      readonly time: number;
      /** This site's limits (the mission's max-delta-v / max-time objectives when flown from here). */
      readonly maxDeltaV: number;
      readonly maxTime: number;
    }
  | { readonly site: string; readonly offered: false; readonly reason: string };

/**
 * What a mission fixes about the abstracted launch (rules.launch). The launch
 * itself is not charged for, so a free parking altitude would be free
 * delta-v: a mission fixes it, with the ascent time, downrange angle and
 * circularisation; the player chooses site, liftoff time and azimuth. Rule
 * data, so a later launch-vehicle performance model can replace the 'fixed'
 * kind with its own without touching the check's callers.
 */
export interface FixedLaunchRule {
  readonly kind: 'fixed';
  /** Parking-orbit altitude above Earth's reference radius, m. */
  readonly altitudeM: number;
  readonly ascentTimeS: number;
  readonly downrangeDeg: number;
  readonly circularization: 'j2-mean' | 'two-body';
}
export type LaunchRule = FixedLaunchRule;

/** The fixed-launch rule with the launch model's defaults (launch.ts) at a given parking altitude. */
export function fixedLaunch(altitudeM: number): FixedLaunchRule {
  return { kind: 'fixed', altitudeM, ascentTimeS: DEFAULT_ASCENT_TIME_S, downrangeDeg: DEFAULT_DOWNRANGE_DEG, circularization: 'j2-mean' };
}

/**
 * A vehicle launch (plan start 'launch' with ascent: 'vehicle'): the mission
 * fixes the launch vehicle below the spacecraft (bit for bit, like the
 * spacecraft) and the ascent time, downrange angle and circularisation; the
 * player chooses the parking altitude inside `altitude`, the site, liftoff
 * time and azimuth, and pays for them in the upper stage's propellant
 * (ascent.ts). Every campaign mission uses this rule; `rules.launch`
 * (FixedLaunchRule, a free delivery) is kept for definitions that want one.
 */
export interface VehicleLaunchRule {
  readonly kind: 'vehicle';
  /** The stages below the mission spacecraft, firing order. */
  readonly lowerStages: readonly Stage[];
  /** Allowed parking-orbit altitudes [lo, hi], m. */
  readonly altitude: Band;
  readonly ascentTimeS: number;
  readonly downrangeDeg: number;
  readonly circularization: 'j2-mean' | 'two-body';
}

/** The vehicle-launch rule with the launch model's default ascent time, downrange and circularisation. */
export function vehicleLaunch(lowerStages: readonly Stage[], altitude: Band): VehicleLaunchRule {
  return { kind: 'vehicle', lowerStages, altitude, ascentTimeS: DEFAULT_ASCENT_TIME_S, downrangeDeg: DEFAULT_DOWNRANGE_DEG, circularization: 'j2-mean' };
}

/** Restrictions on the start a player may choose. Absent fields: unrestricted. */
export interface StartRules {
  /** Launch sites the player may use (with `launchSites`, exactly the offered ones). */
  readonly sites?: readonly string[];
  /** Liftoff (or start) time window [earliest, latest], TDB s from J2000. */
  readonly window?: readonly [number, number];
  /** Parking-orbit altitude band, m. */
  readonly altitude?: Band;
  /** True: the plan must launch (a free 'state' start is not allowed). */
  readonly launchOnly?: boolean;
  /** Launch parameters the mission fixes (see FixedLaunchRule): a free delivery to the parking orbit. */
  readonly launch?: LaunchRule;
  /**
   * The mission is flown with this launch vehicle (VehicleLaunchRule); the
   * plan must be a vehicle launch. Not combined with `launch`. (A separate
   * field so that code reading the fixed rule's fields keeps compiling.)
   */
  readonly vehicle?: VehicleLaunchRule;
}

export interface MissionDefinition {
  /** Stable id (a leaderboard keys on id + version). */
  readonly id: string;
  readonly title: string;
  readonly objectives: readonly Objective[];
  readonly scoring: ScoreWeights;
  /** Spheres the replay should report (enter / exit). */
  readonly spheres?: readonly { body: string; radius: number }[];
  // --- Complete definitions (campaign.ts) also carry everything below. ---
  /** Bumped whenever anything that changes results or limits changes; scores of different versions are not comparable. */
  readonly version?: number;
  /**
   * A few sentences for the player: the goal and the concept it teaches.
   * Distances are placeholders `{key}` resolved from `briefingDistances`, so
   * the UI can state them in the player's convention (altitude or radius);
   * use briefingText to render.
   */
  readonly briefing?: string;
  /** Structured distances the briefing mentions, by placeholder key. */
  readonly briefingDistances?: Readonly<Record<string, BriefingDistance>>;
  /** Default liftoff / start time, TDB s from J2000. */
  readonly epoch?: number;
  readonly start?: MissionStart;
  readonly rules?: StartRules;
  /** The spacecraft every plan must fly (no substitutions). */
  readonly spacecraft?: Spacecraft;
  /** Longest plan duration allowed (and the default duration), s. */
  readonly maxDuration?: number;
  /**
   * True (the default): entering an atmosphere fails the mission unless a
   * reentry / return objective accepts it. False: entry just ends the flight.
   */
  readonly atmosphereIsFailure?: boolean;
  /**
   * Every launch site of the site table with its standing in this mission
   * (see SiteOption). An offered site's limits replace the mission's
   * max-delta-v / max-time objectives for plans launched from it (the
   * objectives themselves carry the loosest offered limits); scoring
   * references are shared by all sites.
   */
  readonly launchSites?: readonly SiteOption[];
}

/**
 * A distance a briefing mentions: an altitude above the body's reference
 * radius, a band of such altitudes, or a distance from the body's centre
 * (m). Altitude and radius differ only by BodyData.referenceRadius.
 */
export type BriefingDistance =
  | { readonly kind: 'altitude'; readonly body: string; readonly value: number }
  | { readonly kind: 'altitude-band'; readonly body: string; readonly lo: number; readonly hi: number }
  | { readonly kind: 'radius'; readonly body: string; readonly value: number };

const kmText = (m: number) => `${Math.round(m / 1000).toLocaleString('en-US')} km`;

/** Default rendering of a briefing distance (altitudes as "N km altitude", radii as "N km from the centre"). */
export function defaultBriefingDistance(d: BriefingDistance): string {
  if (d.kind === 'altitude') return `${kmText(d.value)} altitude`;
  if (d.kind === 'altitude-band') return `${Math.round(d.lo / 1000).toLocaleString('en-US')}–${kmText(d.hi)} altitude`;
  return `${kmText(d.value)} from ${d.body === 'sun' ? 'the Sun' : d.body[0].toUpperCase() + d.body.slice(1)}’s centre`;
}

/** The briefing with its `{key}` distances rendered by `fmt` (default: defaultBriefingDistance). Unknown keys are left as they are. */
export function briefingText(m: Pick<MissionDefinition, 'briefing' | 'briefingDistances'>, fmt: (d: BriefingDistance) => string = defaultBriefingDistance): string {
  const ds = m.briefingDistances ?? {};
  return (m.briefing ?? '').replace(/\{([a-zA-Z0-9_-]+)\}/g, (all, k: string) => (Object.prototype.hasOwnProperty.call(ds, k) ? fmt(ds[k]) : all));
}

/** A mission definition with every optional setup field present. */
export type CompleteMission = MissionDefinition &
  Required<Pick<MissionDefinition, 'version' | 'briefing' | 'epoch' | 'start' | 'rules' | 'spacecraft' | 'maxDuration' | 'atmosphereIsFailure'>>;

export interface ObjectiveResult {
  readonly objective: Objective;
  readonly ok: boolean;
  /** Ephemeris time it was met (goals only). */
  readonly at?: number;
  readonly detail: string;
}

/**
 * The three leaderboard keys of a result. Integers, computed only from the
 * replay (exactly defined operations), so every browser gets the same keys.
 * Ordering (ties beyond these are broken by the storage, e.g. earliest entry):
 *   combined board:  score desc, then deltaV asc, then time asc
 *   delta-v board:   deltaV asc, then time asc
 *   time board:      time asc, then deltaV asc
 * Failed missions have no keys.
 */
export interface LeaderboardKeys {
  /** Combined score (higher is better); PAR_SCORE at par. */
  readonly score: number;
  /** Delta-v in tenths of m/s, rounded up (lower is better). */
  readonly deltaV: number;
  /** Mission time in whole seconds, rounded up (lower is better). */
  readonly time: number;
}

export interface Evaluation {
  readonly success: boolean;
  readonly objectives: readonly ObjectiveResult[];
  /**
   * The scored delta-v, m/s: ReplayResult.totalDeltaV, i.e. the ascent's
   * delta-v (vehicle launch) plus everything flown after insertion. Equal to
   * the flown delta-v for every plan without a vehicle launch.
   */
  readonly deltaV: number;
  /** Of which the ascent (vehicle launch; 0 otherwise), m/s. */
  readonly ascentDeltaV: number;
  /** Of which flown after orbit insertion (ReplayResult.deltaV), m/s. */
  readonly flightDeltaV: number;
  /** Time the last goal was met, s after epoch (replay elapsed if none). */
  readonly missionTime: number;
  readonly score: number;
  /** Present when success. */
  readonly keys?: LeaderboardKeys;
  /** Mission rules the plan broke (only checked when evaluate is given the plan). */
  readonly ruleViolations?: readonly string[];
  /** Launch site of the plan (when evaluate is given a launch plan); its limits were applied. */
  readonly site?: string;
}

/** Score of a run that exactly matches the mission's par (deltaVRef, timeRef). */
export const PAR_SCORE = 10_000;

/** Quantise delta-v (m/s) to the leaderboard unit: tenths of m/s, rounded up. */
export function deltaVKey(deltaV: number): number {
  return Math.ceil(deltaV * 10);
}

/** Quantise mission time (s) to the leaderboard unit: whole seconds, rounded up. */
export function timeKey(missionTime: number): number {
  return Math.ceil(missionTime);
}

/**
 * Combined score: 0 on failure, else
 *
 *   floor(PAR_SCORE / cost),   cost = (wDv dv/dvRef + wT t/tRef) / (wDv + wT)
 *
 * with dv and t the quantised leaderboard values (keys / 10 m/s and whole s),
 * so the score is a function of the two numbers the player sees. A run at
 * par scores PAR_SCORE (10 000) on every mission; using 10% less of both
 * scores ~11 111; strictly decreasing in each of dv and t. See the report /
 * campaign.ts for the reasoning.
 */
export function score(success: boolean, deltaV: number, missionTime: number, w: ScoreWeights): number {
  if (!success) return 0;
  const dv = deltaVKey(deltaV) / 10;
  const t = timeKey(missionTime);
  const cost = ((w.deltaVWeight * dv) / w.deltaVRef + (w.timeWeight * t) / w.timeRef) / (w.deltaVWeight + w.timeWeight);
  if (!(cost > 0)) return 0;
  return Math.floor(PAR_SCORE / cost);
}

/** Leaderboard keys of a successful run (null for a failure). */
export function leaderboardKeys(success: boolean, deltaV: number, missionTime: number, w: ScoreWeights): LeaderboardKeys | null {
  if (!success) return null;
  return { score: score(true, deltaV, missionTime, w), deltaV: deltaVKey(deltaV), time: timeKey(missionTime) };
}

export type Board = 'combined' | 'delta-v' | 'time';

/** Sort order of two entries on a board (negative: a ranks first). Ties left to the storage. */
export function compareKeys(board: Board, a: LeaderboardKeys, b: LeaderboardKeys): number {
  if (board === 'combined') return b.score - a.score || a.deltaV - b.deltaV || a.time - b.time;
  if (board === 'delta-v') return a.deltaV - b.deltaV || a.time - b.time;
  return a.time - b.time || a.deltaV - b.deltaV;
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
      const vmax = o.maxSpeed ?? Infinity;
      const hit = ps.find((e) => e.altitude >= lo && e.altitude <= hi && e.speed <= vmax);
      if (hit) return { t: hit.t, detail: `closest approach ${fmtKm(hit.altitude)} altitude${o.maxSpeed !== undefined ? ` at ${(hit.speed / 1000).toFixed(2)} km/s` : ''}` };
      const fast = ps.find((e) => e.altitude >= lo && e.altitude <= hi);
      if (fast) return { t: null, detail: `closest approach ${fmtKm(fast.altitude)} altitude at ${(fast.speed / 1000).toFixed(2)} km/s, faster than ${(vmax / 1000).toFixed(2)} km/s` };
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
  // Equator: the body's pole at the time of each extremum (the time-dependent
  // pole the physics uses, bodyPoleAt); 'frame' or no pole known: the frame z axis.
  const axis = [0, 0, 1];
  const useEquator = o.reference !== 'frame';
  const inc = o.inclination;
  const cosHi = inc ? cos(inc[1] * DEG) : -1; // cos i >= cosHi  <=>  i <= hi
  const cosLo = inc ? cos(inc[0] * DEG) : 1; //  cos i <= cosLo  <=>  i >= lo
  const ext = eventsOf(ctx, o.body, after, ['periapsis', 'apoapsis']);
  const inBand = (e: TrajectoryEvent): boolean => {
    const band = e.kind === 'periapsis' ? o.periapsis : o.apoapsis;
    if (!(e.distance >= band[0] && e.distance <= band[1])) return false;
    if (!inc) return true;
    if (!useEquator || !bodyPoleAt(ctx.world, k, e.t, axis)) {
      axis[0] = 0;
      axis[1] = 0;
      axis[2] = 1;
    }
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

/**
 * Evaluate a mission's objectives against a replay. With `plan`, also check
 * the mission's rules (start, spacecraft, duration; see missionRuleViolations):
 * a plan that breaks them fails. Leaderboard submissions must pass the plan.
 */
export function evaluate(mission0: MissionDefinition, result: ReplayResult, world: MissionWorld, epoch: number, plan?: MissionPlan): Evaluation {
  const site = plan ? planLaunchSite(plan) : null;
  const mission = site === null ? mission0 : missionForSite(mission0, site);
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
  // The scored delta-v includes the ascent (vehicle launch): totalDeltaV.
  const dv = result.totalDeltaV;
  const ascentDv = result.ascent ? result.ascent.deltaV : 0;
  for (const o of mission.objectives) {
    if (o.kind === 'max-delta-v') out.push({ objective: o, ok: dv <= o.max, detail: ascentDv > 0 ? `used ${dv.toFixed(1)} of ${o.max} m/s (ascent ${ascentDv.toFixed(1)} + flight ${result.deltaV.toFixed(1)})` : `used ${dv.toFixed(1)} of ${o.max} m/s` });
    else if (o.kind === 'max-time') out.push({ objective: o, ok: goalsOk && missionTime <= o.max, detail: `took ${missionTime.toFixed(0)} of ${o.max} s` });
  }
  // Impact always fails; atmospheric entry only counts if a reentry objective accepted it
  // (or the mission says entry is not a failure).
  const atmOk = mission.atmosphereIsFailure === false || out.some((r) => r.ok && usesReentry(r.objective));
  const ended = result.outcome === 'completed' || (result.outcome === 'atmosphere' && atmOk);
  const ruleViolations = plan ? missionRuleViolations(mission, plan) : undefined;
  const success = ended && out.every((r) => r.ok) && (ruleViolations === undefined || ruleViolations.length === 0);
  const keys = leaderboardKeys(success, dv, missionTime, mission.scoring);
  const ev: Evaluation = { success, objectives: out, deltaV: dv, ascentDeltaV: ascentDv, flightDeltaV: result.deltaV, missionTime, score: keys?.score ?? 0 };
  return { ...ev, ...(keys ? { keys } : {}), ...(ruleViolations ? { ruleViolations } : {}), ...(site !== null ? { site } : {}) };
}

/** Launch site id of a plan, or null for a free 'state' start. */
export function planLaunchSite(plan: MissionPlan): string | null {
  return plan.start.kind === 'launch' ? plan.start.site : null;
}

/** The site's entry in `launchSites`, if the mission lists it. */
export function siteOption(mission: MissionDefinition, site: string): SiteOption | undefined {
  return mission.launchSites?.find((s) => s.site === site);
}

/** Sites a player may launch from: the offered `launchSites` that `rules.sites` also allows (either list alone when only one is given); undefined: any site. */
export function allowedSites(mission: MissionDefinition): readonly string[] | undefined {
  const offered = mission.launchSites?.filter((s) => s.offered).map((s) => s.site);
  const r = mission.rules?.sites;
  return offered && r ? offered.filter((x) => r.includes(x)) : (offered ?? r);
}

/**
 * The mission as flown from `site`: the max-delta-v and max-time objectives
 * take that site's limits when the site is offered with its own; otherwise
 * the mission is returned unchanged (checkPlanConformance reports a site that
 * is not offered). Use it to show a site's limits; evaluate applies it itself
 * when given the plan.
 */
export function missionForSite<M extends MissionDefinition>(mission: M, site: string): M {
  const o = siteOption(mission, site);
  if (!o || !o.offered) return mission;
  const objectives = mission.objectives.map((x): Objective => (x.kind === 'max-delta-v' ? { kind: 'max-delta-v', max: o.maxDeltaV } : x.kind === 'max-time' ? { kind: 'max-time', max: o.maxTime } : x));
  return { ...mission, objectives };
}

/** Stable codes for ways a plan fails to conform to a mission. */
export type ConformanceCode =
  | 'spacecraft'
  | 'duration'
  | 'start-kind'
  | 'start-state'
  | 'launch-site'
  | 'launch-window'
  | 'launch-altitude'
  /** Ascent time, downrange angle or circularisation differ from the mission's fixed launch. */
  | 'launch-ascent'
  /** The stages below the spacecraft differ from the mission's vehicle (or a mission without one gets stages). */
  | 'vehicle';

export interface ConformanceIssue {
  readonly code: ConformanceCode;
  /** Plan field path, e.g. 'spacecraft.engines[0].isp', 'start.site', 'epoch'. */
  readonly path: string;
  readonly message: string;
}

/** Bit-for-bit equality of two numbers (distinguishes 0 and -0; NaN equals NaN). */
const sameBits = (a: number, b: number): boolean => Object.is(a, b);

/**
 * Does `plan` conform to `mission`? Empty array: yes. The single check used
 * to lock the editor and to reject leaderboard submissions. Checks what the
 * definition specifies: the spacecraft bit-for-bit (wet and dry mass, every
 * engine's thrust and Isp, engine count), the duration limit, the start kind
 * (launch-only, or the mission's own start kind), the launch site, the start
 * window, the parking altitude band and the fixed launch parameters
 * (rules.launch). Sandbox has no mission, so no check.
 */
/** Conformance message for a plan made before its mission launched on a vehicle (shown by the editor and returned by the leaderboard). */
export const OLD_VERSION_MESSAGE = 'this plan was made for an earlier version of the mission, whose launch delivered the spacecraft to its parking orbit free of charge; this version launches on its vehicle and charges the ascent, so the plan must be rebuilt';

export function checkPlanConformance(mission: MissionDefinition, plan: MissionPlan): ConformanceIssue[] {
  const out: ConformanceIssue[] = [];
  const add = (code: ConformanceCode, path: string, message: string) => out.push({ code, path, message });
  const V = mission.rules?.vehicle;
  const pl = plan.lowerStages ?? [];
  // A plan from before the mission had its vehicle (a free delivery, no stages) gets one reason, the real one,
  // not also every spacecraft or limit that changed with the new version.
  if (V && plan.start.kind === 'launch' && !isVehicleLaunch(plan.start) && pl.length === 0) {
    add('start-kind', 'start.ascent', OLD_VERSION_MESSAGE);
    return out;
  }
  const sc = mission.spacecraft;
  if (sc) {
    const p = plan.spacecraft;
    if (!sameBits(p.wetMass, sc.wetMass)) add('spacecraft', 'spacecraft.wetMass', `wet mass must be ${sc.wetMass} kg (mission spacecraft), got ${p.wetMass}`);
    if (!sameBits(p.dryMass, sc.dryMass)) add('spacecraft', 'spacecraft.dryMass', `dry mass must be ${sc.dryMass} kg (mission spacecraft), got ${p.dryMass}`);
    if (p.engines.length !== sc.engines.length) add('spacecraft', 'spacecraft.engines', `the mission spacecraft has ${sc.engines.length} engine(s), plan has ${p.engines.length}`);
    else sc.engines.forEach((e, i) => {
      if (!sameBits(p.engines[i].thrust, e.thrust)) add('spacecraft', `spacecraft.engines[${i}].thrust`, `engine ${i} thrust must be ${e.thrust} N, got ${p.engines[i].thrust}`);
      if (!sameBits(p.engines[i].isp, e.isp)) add('spacecraft', `spacecraft.engines[${i}].isp`, `engine ${i} Isp must be ${e.isp} s, got ${p.engines[i].isp}`);
    });
  }
  if (V) {
    const stageSame = (a: Stage, b: Stage) => sameBits(a.wetMass, b.wetMass) && sameBits(a.dryMass, b.dryMass) && a.engines.length === b.engines.length && a.engines.every((e, i) => sameBits(e.thrust, b.engines[i].thrust) && sameBits(e.isp, b.engines[i].isp));
    if (pl.length !== V.lowerStages.length) add('vehicle', 'lowerStages', `the mission vehicle has ${V.lowerStages.length} stage(s) below the spacecraft, the plan has ${pl.length}`);
    else V.lowerStages.forEach((st, k) => { if (!stageSame(pl[k], st)) add('vehicle', `lowerStages[${k}]`, `stage ${k} must be the mission vehicle's (wet ${st.wetMass} kg, dry ${st.dryMass} kg, ${st.engines.length} engine(s)), bit for bit`); });
    if (plan.start.kind === 'launch' && !isVehicleLaunch(plan.start)) {
      add('start-kind', 'start.ascent', 'this mission launches on its vehicle (a vehicle launch)');
    }
  } else if (sc && pl.length > 0) add('vehicle', 'lowerStages', 'this mission has no launch vehicle: the plan may not add stages');
  if (!V && isVehicleLaunch(plan.start) && (mission.rules?.launch || mission.start?.kind === 'launch')) add('start-kind', 'start.ascent', 'this mission delivers the spacecraft to its parking orbit (not a vehicle launch)');
  if (mission.maxDuration !== undefined && !(plan.duration <= mission.maxDuration)) add('duration', 'duration', `duration ${plan.duration} s exceeds the mission limit ${mission.maxDuration} s`);
  const st = plan.start;
  const r = mission.rules;
  const mustLaunch = r?.launchOnly === true || mission.start?.kind === 'launch';
  if (mustLaunch && st.kind !== 'launch') add('start-kind', 'start.kind', 'this mission starts with a launch');
  if (mission.start?.kind === 'state') {
    const ms = mission.start;
    if (st.kind !== 'state') add('start-kind', 'start.kind', 'this mission starts from a given orbit, not a launch');
    else if (st.center !== ms.center || st.state.length !== ms.state.length || !st.state.every((v, i) => sameBits(v, ms.state[i]))) add('start-state', 'start.state', 'the start state must be the mission\'s');
    if (mission.epoch !== undefined && !sameBits(plan.epoch, mission.epoch) && !r?.window) add('launch-window', 'epoch', `start time must be ${mission.epoch}`);
  }
  if (st.kind === 'launch' && (r?.sites || mission.launchSites)) {
    // Both lists apply: rules.sites (when given) and the offered launchSites (when given).
    const o = siteOption(mission, st.site);
    const allowed = allowedSites(mission) ?? [];
    if (o && !o.offered) add('launch-site', 'start.site', `launch site ${st.site} not offered for this mission: ${o.reason} (allowed: ${allowed.join(', ')})`);
    else if (!allowed.includes(st.site)) add('launch-site', 'start.site', `launch site ${st.site} not allowed (allowed: ${allowed.join(', ')})`);
  }
  if (r) {
    if (r.window && !(plan.epoch >= r.window[0] && plan.epoch <= r.window[1])) add('launch-window', 'epoch', `start time ${plan.epoch} outside the window ${r.window[0]}..${r.window[1]}`);
    if (r.altitude && st.kind === 'launch' && !(st.params[2] >= r.altitude[0] && st.params[2] <= r.altitude[1])) add('launch-altitude', 'start.params[2]', `parking altitude ${st.params[2]} m outside ${r.altitude[0]}..${r.altitude[1]} m`);
    const L = r.launch;
    if (L && st.kind === 'launch') {
      // Absent trailing params take the launch model's defaults (launchFromParams).
      const p = st.params;
      const ascent = p[3] ?? DEFAULT_ASCENT_TIME_S;
      const downrange = p[4] ?? DEFAULT_DOWNRANGE_DEG;
      const circ = (p[5] ?? 0) === 1 ? 'two-body' : 'j2-mean';
      if (!sameBits(p[2], L.altitudeM)) add('launch-altitude', 'start.params[2]', `this mission fixes the parking orbit at ${L.altitudeM / 1000} km altitude, got ${p[2] / 1000} km`);
      if (!sameBits(ascent, L.ascentTimeS)) add('launch-ascent', 'start.params[3]', `this mission fixes the ascent time at ${L.ascentTimeS} s, got ${ascent}`);
      if (!sameBits(downrange, L.downrangeDeg)) add('launch-ascent', 'start.params[4]', `this mission fixes the downrange angle at ${L.downrangeDeg}°, got ${downrange}`);
      if (circ !== L.circularization) add('launch-ascent', 'start.params[5]', `this mission fixes the circularisation at ${L.circularization}, got ${circ}`);
    }
    if (V && st.kind === 'launch') {
      const p = st.params;
      const ascent = p[3] ?? DEFAULT_ASCENT_TIME_S;
      const downrange = p[4] ?? DEFAULT_DOWNRANGE_DEG;
      const circ = (p[5] ?? 0) === 1 ? 'two-body' : 'j2-mean';
      if (!(p[2] >= V.altitude[0] && p[2] <= V.altitude[1])) add('launch-altitude', 'start.params[2]', `parking altitude ${p[2] / 1000} km outside this mission's ${V.altitude[0] / 1000}..${V.altitude[1] / 1000} km`);
      if (!sameBits(ascent, V.ascentTimeS)) add('launch-ascent', 'start.params[3]', `this mission fixes the ascent time at ${V.ascentTimeS} s, got ${ascent}`);
      if (!sameBits(downrange, V.downrangeDeg)) add('launch-ascent', 'start.params[4]', `this mission fixes the downrange angle at ${V.downrangeDeg}°, got ${downrange}`);
      if (circ !== V.circularization) add('launch-ascent', 'start.params[5]', `this mission fixes the circularisation at ${V.circularization}, got ${circ}`);
    }
  }
  return out;
}

/** Messages of checkPlanConformance (kept for simple callers). */
export function missionRuleViolations(mission: MissionDefinition, plan: MissionPlan): string[] {
  return checkPlanConformance(mission, plan).map((i) => i.message);
}

/** Replay options a mission is scored with (use the same for drawing, so digests match). */
export function missionReplayOptions(mission: MissionDefinition): ReplayOptions {
  return { spheres: mission.spheres, stopOnAtmosphere: true };
}

/** Default integrator tolerance of a fresh mission plan. */
export const DEFAULT_MISSION_RTOL = 1e-10;

/**
 * Altitude and ascent fields of a mission's launch: the fixed rule's
 * altitude, or the given altitude clamped into the vehicle rule's band, with
 * the rule's (else the default) ascent time, downrange and circularisation.
 */
export function launchFields(mission: MissionDefinition, altitudeM: number): { altitudeM: number; ascentTimeS: number; downrangeDeg: number; circularization: 'j2-mean' | 'two-body' } {
  const L = mission.rules?.launch;
  if (L) return { altitudeM: L.altitudeM, ascentTimeS: L.ascentTimeS, downrangeDeg: L.downrangeDeg, circularization: L.circularization };
  const V = mission.rules?.vehicle;
  if (V) return { altitudeM: Math.min(V.altitude[1], Math.max(V.altitude[0], altitudeM)), ascentTimeS: V.ascentTimeS, downrangeDeg: V.downrangeDeg, circularization: V.circularization };
  return { altitudeM, ascentTimeS: DEFAULT_ASCENT_TIME_S, downrangeDeg: DEFAULT_DOWNRANGE_DEG, circularization: 'j2-mean' };
}

/**
 * A fresh plan for a complete mission: its default start, vehicle
 * (rules.vehicle: the lower stages and a vehicle launch), spacecraft and
 * duration, no burns.
 */
export function initialMissionPlan(mission: CompleteMission, fingerprint: string): MissionPlan {
  const st = mission.start;
  const V = mission.rules.vehicle;
  const start: MissionPlan['start'] = st.kind === 'launch'
    ? { kind: 'launch', site: st.site, params: launchToParams({ mode: 'parking-orbit', siteId: st.site, launchTime: mission.epoch, azimuthDeg: st.azimuthDeg, ...launchFields(mission, st.altitudeM) }), ...(V ? { ascent: 'vehicle' as const } : {}) }
    : { kind: 'state', center: st.center, state: st.state.slice() };
  return makePlan({ data: fingerprint, epoch: mission.epoch, duration: mission.maxDuration, rtol: DEFAULT_MISSION_RTOL, start, spacecraft: mission.spacecraft, burns: [], ...(V ? { lowerStages: V.lowerStages.map((x) => ({ ...x, engines: x.engines.map((e) => ({ ...e })) })) } : {}) });
}

function usesReentry(o: Objective): boolean {
  return o.kind === 'reentry' || o.kind === 'return' || (o.kind === 'sequence' && o.steps.some(usesReentry));
}
