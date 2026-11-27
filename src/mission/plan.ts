/**
 * Mission plan: everything needed to replay a flight, with a compact binary
 * encoding to a URL-safe string.
 *
 * Plans arrive from untrusted sources (shared links, a leaderboard), so
 * `decodePlan` checks every byte, rejects anything malformed with a clear
 * error, and `validatePlan` bounds the work a plan can demand (burns,
 * duration, tolerance). Floats are stored as raw IEEE-754 binary64, so every
 * value round-trips exactly.
 *
 * BINARY LAYOUT (little-endian), format 1 (one stage, the spacecraft):
 *   'S' u8 format  u16 model  u32 data-fingerprint
 *   f64 epoch  f64 duration  f64 rtol
 *   start: u8 tag; 0 = state: str center, 6 x f64 (relative to center at epoch)
 *                  1 = launch: str site, u8 n, n x f64 params
 *   f64 wetMass  f64 dryMass  u8 nEngines, nEngines x (f64 thrust, f64 isp)
 *   u16 nBurns, per burn: f64 start  f64 duration  u8 engine  3 x f64 direction
 *                         u8 frame (0 inertial, 1 orbital + str body)
 *   str = u8 length + ASCII [a-z0-9_-]
 * then base64url without padding.
 *
 * FORMAT 2 (staged vehicle): same header and start, with start tag 2 = vehicle
 * launch (str site, u8 n, n x f64 params, as tag 1; in memory a 'launch'
 * start with ascent: 'vehicle'), then
 *   u8 nStages, per stage in firing order (the last is the spacecraft):
 *       f64 wetMass  f64 dryMass  u8 nEngines, nEngines x (f64 thrust, f64 isp)
 *   u16 nActions, time-ordered, per action u8 kind:
 *       0 = burn: f64 start  f64 duration  u8 stage  u8 engine  3 x f64 direction
 *                 u8 frame (0 inertial, 1 orbital + str body)
 *       1 = separation: f64 time
 * Actions are ordered by time (burn start, separation time); at equal times a
 * separation precedes a burn. The decoder refuses any other order, so the
 * string of a plan is unique. In memory, a format-2 plan keeps the
 * spacecraft (last stage) in `spacecraft`, the stages below it in
 * `lowerStages`, burns (each with `stage`) in `burns` and separations in
 * `separations`: every format-1 reader keeps working on the fields it knows.
 *
 * FORMAT 3 (propulsion flags, direct injection): format 2's layout with
 *   - per engine one more byte after (thrust, isp): u8 flags, bit 0 = not
 *     restartable, bit 1 = not throttleable (other bits refused); in memory
 *     a flag field is present only when false (Engine.restartable /
 *     throttleable), so decode(encode(p)) gives the canonical plan;
 *   - start tag 3 = direct-injection launch (str site, u8 n, n x f64 params,
 *     n = DIRECT_PARAMS; in memory ascent: 'direct'). Tags 0-2 as before.
 * requiredFormat gives 3 only to plans with a false flag or a direct launch,
 * so no earlier plan changes format or string.
 *
 * WHICH FORMAT IS WRITTEN. A plan is written in the format it carries
 * (`plan.format`), and makePlan gives the lowest format that can hold the
 * plan (requiredFormat): a one-stage plan with no staged fields is format 1,
 * byte for byte the string it always was. So every shared link and every plan
 * stored on the leaderboard keeps its exact string (and any key or hash made
 * from it), and an older build that only reads format 1 still opens every
 * plan that does not use stages.
 *
 * TIME RULES (one clock for everything):
 *  - `epoch` is mission time zero, TDB seconds from J2000. For a launch start
 *    it is the LIFTOFF time and must equal params[0] (the launch time).
 *  - Burn `start` and the mission `duration` are seconds after the epoch, so
 *    burns sit at absolute times epoch + start; mission elapsed time (and so
 *    scoring) counts from the epoch, i.e. from liftoff for a launch.
 *  - A 'state' start begins simulating at the epoch. A launch start begins at
 *    orbit insertion, epoch + ascent time (params[3], default
 *    DEFAULT_ASCENT_TIME_S): a burn starting before insertion, or a duration
 *    not reaching past insertion, is a validation error.
 */
import { DEFAULT_ASCENT_TIME_S, LAUNCH_SITES, azimuthAllowed } from './launch';
import { PHYSICS_MODEL } from './world';

/** The base format (one stage). Plans that need nothing newer are written in it. */
export const PLAN_FORMAT = 1;
/** Staged vehicles, separations, vehicle-launch starts (vehicle.ts, ascent.ts). */
export const PLAN_FORMAT_STAGED = 2;
/** Propulsion flags per engine (restartable, throttleable) and the direct-injection launch. */
export const PLAN_FORMAT_DIRECT = 3;
/** Formats this build reads and writes. */
export const PLAN_FORMATS: readonly number[] = [PLAN_FORMAT, PLAN_FORMAT_STAGED, PLAN_FORMAT_DIRECT];

/**
 * Direct-injection launch parameters (start.params of ascent: 'direct'),
 * exactly five, no defaults:
 *   [launchTime, azimuthDeg, c3, injectionAltitudeM, flightStartS]
 * c3 the target C3 (m^2/s^2), injectionAltitudeM where powered flight ends,
 * flightStartS (s after liftoff) the declared start of the free flight: the
 * earliest time of any burn or separation, and the bound on the mission
 * duration; replay refuses a plan whose computed burnout comes later. (The
 * flight itself is simulated from the computed burnout, which is earlier.)
 */
export const DIRECT_PARAMS = 5;
/** C3 range a direct-injection start accepts, m^2/s^2 (-60 km^2/s^2 is about circular at 250 km). */
export const DIRECT_C3_RANGE: readonly [number, number] = [-60e6, 400e6];
/** Injection-altitude range a direct-injection start accepts, m. */
export const DIRECT_ALTITUDE_RANGE: readonly [number, number] = [150e3, 2_000e3];

export const LIMITS = {
  /** Longest encoded string accepted, characters. */
  maxEncodedLength: 16384,
  maxBurns: 200,
  /** Engines per stage. */
  maxEngines: 8,
  /** Stages of a vehicle, the spacecraft included. */
  maxStages: 6,
  /** Separations (at most maxStages - 1 can ever happen). */
  maxSeparations: 5,
  maxLaunchParams: 16,
  /** Mission duration, s (40 Julian years). */
  maxDuration: 40 * 365.25 * 86400,
  /** |epoch| from J2000, s (200 Julian years). */
  maxEpoch: 200 * 365.25 * 86400,
  minRtol: 1e-13,
  maxRtol: 1e-5,
  maxMass: 1e9,
  maxThrust: 1e9,
  maxIsp: 1e5,
  maxPosition: 1e14,
  maxVelocity: 1e6,
  maxIdLength: 32,
} as const;

export interface Engine {
  /** N. */
  readonly thrust: number;
  /** s. */
  readonly isp: number;
  /**
   * Format 3. false: cannot be relit once shut down (it fires at most once in
   * the whole flight, the ascent included). Absent: restartable.
   */
  readonly restartable?: boolean;
  /**
   * Format 3. false: cannot be throttled or shut down once lit; it burns at
   * full thrust to depletion (a solid motor). Absent: throttleable.
   */
  readonly throttleable?: boolean;
}

/** A solid motor's flags: lit once, burns to depletion. */
export const SOLID: { readonly restartable: false; readonly throttleable: false } = { restartable: false, throttleable: false };

export interface Spacecraft {
  /** Initial (fuelled) mass, kg. */
  readonly wetMass: number;
  /** Mass with empty tanks, kg. */
  readonly dryMass: number;
  readonly engines: readonly Engine[];
}

export type PlanFrame = { readonly kind: 'inertial' } | { readonly kind: 'orbital'; readonly body: string };

export interface PlanBurn {
  /** Ignition, seconds after the epoch. */
  readonly start: number;
  /** Requested duration, s; cut short if the tanks run dry. */
  readonly duration: number;
  /** Index into the engines of the burn's stage (format 1: spacecraft.engines). */
  readonly engine: number;
  /**
   * Format 2: index of the stage that fires, into the whole stack
   * (vehicleStages: lower stages, then the spacecraft); it must be the
   * active stage when the burn fires. Absent: the spacecraft (format 1).
   */
  readonly stage?: number;
  readonly direction: readonly [number, number, number];
  readonly frame: PlanFrame;
}

export type PlanStart =
  /** State [x, y, z, vx, vy, vz] (m, m/s) relative to body `center` at the epoch. */
  | { readonly kind: 'state'; readonly center: string; readonly state: readonly number[] }
  /**
   * Seam for launch descriptions (built elsewhere): an id and numeric
   * parameters. Replay needs a `resolveLaunch` option to turn it into a state.
   */
  | {
      readonly kind: 'launch';
      readonly site: string;
      readonly params: readonly number[];
      /**
       * How the craft reaches the parking orbit; together with `kind` this is
       * the start kind:
       *  - absent ('delivered'): the spacecraft is put in the parking orbit at
       *    no charge (format 1; the campaign's start until part three);
       *  - 'vehicle' (format 2): the plan's own vehicle flies the ascent
       *    analytically (ascent.ts); the lower stages burn out and separate,
       *    the stage that reaches orbit keeps what propellant it has left, and
       *    the flight starts at insertion with that mass.
       *  - 'direct' (format 3): the vehicle flies a direct injection, no
       *    parking orbit (ascent.ts computeDirectAscent; params:
       *    DIRECT_PARAMS); the flight starts at the computed burnout.
       * A field rather than a new `kind` so every caller that handles
       * `kind === 'launch'` (site, params, insertion time) keeps working.
       */
      readonly ascent?: 'vehicle' | 'direct';
    };

/** One stage of a vehicle: same fields as the one-stage Spacecraft. */
export type Stage = Spacecraft;

/** Format 2: drop the active stage (whatever propellant it holds) at this time. */
export interface PlanSeparation {
  /** Seconds after the epoch. */
  readonly time: number;
}

export type LaunchStart = Extract<PlanStart, { kind: 'launch' }>;

/** True for a launch flown by the plan's vehicle (paid for), false for a free delivery or a state start. */
export function isVehicleLaunch(start: PlanStart): start is LaunchStart & { ascent: 'vehicle' } {
  return start?.kind === 'launch' && start.ascent === 'vehicle';
}

/** True for a direct-injection launch (format 3). */
export function isDirectLaunch(start: PlanStart): start is LaunchStart & { ascent: 'direct' } {
  return start?.kind === 'launch' && start.ascent === 'direct';
}

/** True for any launch the plan's own vehicle flies (parking orbit or direct injection). */
export function isFlownLaunch(start: PlanStart): start is LaunchStart & { ascent: 'vehicle' | 'direct' } {
  return isVehicleLaunch(start) || isDirectLaunch(start);
}

/** True if any engine of the plan sets a propulsion flag to false (format 3). */
export function usesPropulsionFlags(p: Pick<MissionPlan, 'spacecraft' | 'lowerStages'>): boolean {
  const st: readonly (Stage | undefined)[] = [...(Array.isArray(p.lowerStages) ? p.lowerStages : []), p.spacecraft];
  return st.some((s) => Array.isArray(s?.engines) && s.engines.some((e: Engine | undefined) => e?.restartable === false || e?.throttleable === false));
}

export interface MissionPlan {
  readonly format: number;
  /** PHYSICS_MODEL the plan was made with. */
  readonly model: number;
  /** World fingerprint (8 hex digits) the plan was made against. */
  readonly data: string;
  /** Start time, TDB seconds from J2000 (the ephemeris time). */
  readonly epoch: number;
  /** Mission length, s. */
  readonly duration: number;
  /** Integrator relative tolerance. */
  readonly rtol: number;
  readonly start: PlanStart;
  /** The spacecraft: the top (last) stage of the vehicle, the only one in format 1. */
  readonly spacecraft: Spacecraft;
  /** Sorted, non-overlapping. */
  readonly burns: readonly PlanBurn[];
  /** Format 2: the stages below the spacecraft, in firing order (bottom first). */
  readonly lowerStages?: readonly Stage[];
  /** Format 2: separations, sorted by time. */
  readonly separations?: readonly PlanSeparation[];
}

/** Every stage of the plan's vehicle in firing order; the last is the spacecraft. */
export function vehicleStages(plan: Pick<MissionPlan, 'spacecraft' | 'lowerStages'>): readonly Stage[] {
  return plan.lowerStages && plan.lowerStages.length > 0 ? [...plan.lowerStages, plan.spacecraft] : [plan.spacecraft];
}

/** Stage index a burn fires (absent stage: the spacecraft, the last). */
export function burnStage(plan: Pick<MissionPlan, 'spacecraft' | 'lowerStages'>, b: Pick<PlanBurn, 'stage'>): number {
  return b.stage ?? (plan.lowerStages?.length ?? 0);
}

/** The lowest plan format that can hold this plan. */
export function requiredFormat(p: Pick<MissionPlan, 'start' | 'burns' | 'lowerStages' | 'separations' | 'spacecraft'>): number {
  if (isDirectLaunch(p.start) || usesPropulsionFlags(p)) return PLAN_FORMAT_DIRECT;
  const staged = p.lowerStages !== undefined || p.separations !== undefined || isVehicleLaunch(p.start) || (Array.isArray(p.burns) && p.burns.some((b) => b?.stage !== undefined));
  return staged ? PLAN_FORMAT_STAGED : PLAN_FORMAT;
}

/** One flight action in time order: a burn (index into plan.burns) or a separation (index into plan.separations). */
export type FlightAction =
  | { readonly kind: 'burn'; readonly t: number; readonly index: number; readonly burn: PlanBurn }
  | { readonly kind: 'separation'; readonly t: number; readonly index: number };

/**
 * The plan's burns and separations merged into one time-ordered sequence
 * (the encoded order): by time, a separation before a burn at the same time.
 * Assumes each list is sorted (validatePlan checks it).
 */
export function flightActions(plan: Pick<MissionPlan, 'burns' | 'separations'>): FlightAction[] {
  const out: FlightAction[] = [];
  const seps = plan.separations ?? [];
  let j = 0;
  plan.burns.forEach((b, i) => {
    while (j < seps.length && seps[j].time <= b.start) { out.push({ kind: 'separation', t: seps[j].time, index: j }); j++; }
    out.push({ kind: 'burn', t: b.start, index: i, burn: b });
  });
  for (; j < seps.length; j++) out.push({ kind: 'separation', t: seps[j].time, index: j });
  return out;
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

/** Convenience constructor that fills format and model. */
export function makePlan(p: Omit<MissionPlan, 'format' | 'model'>): MissionPlan {
  return { format: requiredFormat(p), model: PHYSICS_MODEL, ...p };
}

const ID_RE = /^[a-z0-9_-]+$/;

function finite(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Seconds from the epoch at which simulation starts (orbit insertion for a launch). */
export function simulationStartOffset(start: PlanStart): number {
  // Direct injection: the declared flight start (params[4]); the simulation itself begins at the computed burnout, no later.
  if (isDirectLaunch(start)) return start.params[4];
  return start.kind === 'launch' ? (start.params[3] ?? DEFAULT_ASCENT_TIME_S) : 0;
}

/** Stable machine-readable codes for plan problems (never renamed; new ones may be added). */
export type PlanIssueCode =
  | 'format'
  | 'model'
  | 'data'
  | 'range'
  | 'id'
  | 'start-kind'
  | 'start-state'
  | 'launch-params'
  | 'launch-epoch'
  | 'launch-ascent'
  | 'launch-duration'
  | 'launch-site'
  | 'launch-azimuth'
  | 'launch-altitude'
  | 'launch-mode'
  | 'burn-before-insertion'
  | 'mass-order'
  | 'engines'
  | 'burns'
  | 'burn-engine'
  | 'burn-direction'
  | 'burn-frame'
  | 'burn-overlap'
  // Format 2 (staged vehicles):
  /** Too many or too few stages, or a vehicle launch without a stage below the spacecraft. */
  | 'stages'
  /** A burn names a stage that is not the active one when it fires (or no such stage). */
  | 'burn-stage'
  /** A burn is still firing at a separation. */
  | 'burn-spans-separation'
  /** A separation would drop the last stage (the spacecraft). */
  | 'separation-last'
  /** A separation before the flight starts (orbit insertion for a launch, the epoch otherwise). */
  | 'separation-before-insertion'
  /** Separations not sorted by time, or (decoder) actions not in time order. */
  | 'action-order'
  /** The vehicle cannot reach the parking orbit (vehicle launch, ascent.ts). */
  | 'ascent'
  // Format 3 (propulsion flags, direct injection):
  /** An engine's restartable / throttleable is not a boolean. */
  | 'engine-flags'
  /** A non-restartable engine fires twice, or fires in flight after being lit in the ascent. */
  | 'engine-restart'
  /** A non-throttleable engine's burn is shorter than its stage's burn to depletion. */
  | 'engine-throttle'
  /** Direct injection: target C3 outside DIRECT_C3_RANGE. */
  | 'launch-c3'
  /** Direct injection: the computed burnout comes after the declared flight start (params[4]). */
  | 'launch-burnout';

/** One problem with a plan. */
export interface PlanIssue {
  readonly code: PlanIssueCode;
  /** Field path, e.g. 'epoch', 'start.params[1]', 'burns[2].direction', 'spacecraft.dryMass'. */
  readonly path: string;
  /** Index of the burn the problem belongs to, when it belongs to one. */
  readonly burn?: number;
  /** Human-readable message (the same text validatePlan returns). */
  readonly message: string;
}

export interface ValidateOptions {
  /**
   * How much of a launch start to check:
   *  - 'full' (default): also that the site exists, the parameters decode
   *    (launch.ts launchFromParams), the azimuth is inside the site's
   *    range-safety corridor and the altitude is positive, so a plan that
   *    launch.ts would refuse fails here, not inside replay.
   *  - 'structural': only the plan format (what encode / decode need). Used
   *    for plans flown with a custom `resolveLaunch` (their own site ids).
   */
  readonly launch?: 'full' | 'structural';
  /**
   * Vehicle launch: the stage the ascent reaches orbit in (ascent.ts), so the
   * stage sequence can be checked; replay supplies it. Absent: the sequence of
   * a vehicle-launch plan is not checked here.
   */
  readonly ascentFirstStage?: number;
}

/**
 * All problems with a plan, structured (empty if valid). Checks structure,
 * ranges and the work bounds, and (by default) the launch semantics.
 */
export function validatePlanIssues(plan: MissionPlan, opts: ValidateOptions = {}): PlanIssue[] {
  const errs: PlanIssue[] = [];
  const L = LIMITS;
  const add = (code: PlanIssueCode, path: string, message: string, burn?: number) => {
    errs.push(burn === undefined ? { code, path, message } : { code, path, burn, message });
  };
  const burnOf = (path: string): number | undefined => {
    const m = /^burns\[(\d+)\]/.exec(path);
    return m ? Number(m[1]) : undefined;
  };
  const range = (name: string, v: unknown, lo: number, hi: number, loOpen = false) => {
    if (!finite(v) || (loOpen ? !(v > lo) : !(v >= lo)) || !(v <= hi)) add('range', name, `${name} must be a finite number in ${loOpen ? '(' : '['}${lo}, ${hi}], got ${String(v)}`, burnOf(name));
  };
  const id = (name: string, v: unknown) => {
    if (typeof v !== 'string' || v.length === 0 || v.length > L.maxIdLength || !ID_RE.test(v)) add('id', name, `${name} must be an id of 1-${L.maxIdLength} characters [a-z0-9_-], got ${JSON.stringify(v)}`, burnOf(name));
  };
  if (!PLAN_FORMATS.includes(plan.format)) add('format', 'format', `unsupported plan format ${plan.format} (this build reads ${PLAN_FORMATS.join(', ')})`);
  else if (plan.format < requiredFormat(plan)) {
    const need = requiredFormat(plan);
    add('format', 'format', need === PLAN_FORMAT_DIRECT
      ? `plan format ${plan.format} cannot hold engine propulsion flags or a direct-injection launch (needs format ${PLAN_FORMAT_DIRECT})`
      : `plan format ${plan.format} cannot hold stages, separations, burn stages or a vehicle launch (needs format ${PLAN_FORMAT_STAGED})`);
  }
  if (!Number.isInteger(plan.model) || plan.model < 0 || plan.model > 0xffff) add('model', 'model', `model must be an integer 0-65535`);
  if (typeof plan.data !== 'string' || !/^[0-9a-f]{8}$/.test(plan.data)) add('data', 'data', `data fingerprint must be 8 hex digits`);
  range('epoch', plan.epoch, -L.maxEpoch, L.maxEpoch);
  range('duration', plan.duration, 0, L.maxDuration, true);
  range('rtol', plan.rtol, L.minRtol, L.maxRtol);

  const st = plan.start;
  if (st?.kind === 'state') {
    id('start.center', st.center);
    if (!Array.isArray(st.state) || st.state.length !== 6) add('start-state', 'start.state', 'start.state must have 6 numbers');
    else {
      for (let i = 0; i < 3; i++) range(`start.state[${i}]`, st.state[i], -L.maxPosition, L.maxPosition);
      for (let i = 3; i < 6; i++) range(`start.state[${i}]`, st.state[i], -L.maxVelocity, L.maxVelocity);
    }
  } else if (st?.kind === 'launch') {
    id('start.site', st.site);
    if (!Array.isArray(st.params) || st.params.length > L.maxLaunchParams) add('launch-params', 'start.params', `start.params must be at most ${L.maxLaunchParams} numbers`);
    else {
      let allFinite = true;
      st.params.forEach((v, i) => { if (!finite(v)) { allFinite = false; add('launch-params', `start.params[${i}]`, `start.params[${i}] must be finite`); } });
      if (st.params.length < 1 || st.params[0] !== plan.epoch) add('launch-epoch', 'start.params[0]', 'start.params[0] (launch time) must equal epoch: the epoch of a launch plan is liftoff');
      const ascent = simulationStartOffset(st);
      if (!(ascent >= 0 && ascent <= 86400)) add('launch-ascent', 'start.params[3]', `launch ascent time must be in [0, 86400] s, got ${ascent}`);
      else {
        if (!(plan.duration > ascent)) add('launch-duration', 'duration', `duration must extend past orbit insertion (${ascent} s after liftoff)`);
        if (Array.isArray(plan.burns)) plan.burns.forEach((b, i) => { if (finite(b?.start) && b.start < ascent) add('burn-before-insertion', `burns[${i}].start`, `burns[${i}] starts at ${b.start} s, before orbit insertion at ${ascent} s after liftoff`, i); });
      }
      if (st.ascent !== undefined && st.ascent !== 'vehicle' && st.ascent !== 'direct') add('start-kind', 'start.ascent', 'start.ascent must be absent, "vehicle" or "direct"');
      if (isDirectLaunch(st)) {
        // Structural: the parameter count is part of the format (it fixes what params[4] means).
        if (st.params.length !== DIRECT_PARAMS) add('launch-params', 'start.params', `start.params: a direct-injection launch takes exactly ${DIRECT_PARAMS} parameters [time, azimuth, c3, injectionAltitude, flightStart], got ${st.params.length}`);
        else if ((opts.launch ?? 'full') === 'full' && allFinite && typeof st.site === 'string') directLaunchIssues(st.site, st.params, add);
      } else if ((opts.launch ?? 'full') === 'full' && allFinite && typeof st.site === 'string') launchIssues(st.site, st.params, add);
    }
  } else add('start-kind', 'start.kind', 'start.kind must be "state" or "launch"');

  const stageOk = (st: Stage | undefined, name: string, engPath: (i: number) => string) => {
    range(`${name}.wetMass`, st?.wetMass, 0, L.maxMass, true);
    range(`${name}.dryMass`, st?.dryMass, 0, L.maxMass, true);
    if (finite(st?.wetMass) && finite(st?.dryMass) && st.dryMass > st.wetMass) add('mass-order', `${name}.dryMass`, `${name}.dryMass must not exceed wetMass`);
    const engines = st?.engines;
    if (!Array.isArray(engines) || engines.length < 1 || engines.length > L.maxEngines) add('engines', `${name}.engines`, `${name} needs 1-${L.maxEngines} engines`);
    else engines.forEach((e, i) => {
      range(`${engPath(i)}.thrust`, e?.thrust, 0, L.maxThrust, true);
      range(`${engPath(i)}.isp`, e?.isp, 0, L.maxIsp, true);
      for (const f of ['restartable', 'throttleable'] as const) {
        const v = e?.[f];
        if (v !== undefined && typeof v !== 'boolean') add('engine-flags', `${engPath(i)}.${f}`, `${engPath(i)}.${f} must be true, false or absent`);
      }
    });
  };
  stageOk(plan.spacecraft, 'spacecraft', (i) => `engines[${i}]`);
  const lower = plan.lowerStages;
  if (lower !== undefined) {
    if (!Array.isArray(lower) || lower.length > L.maxStages - 1) add('stages', 'lowerStages', `a vehicle has at most ${L.maxStages} stages (the spacecraft included)`);
    else lower.forEach((st, k) => stageOk(st, `lowerStages[${k}]`, (i) => `lowerStages[${k}].engines[${i}]`));
  }
  const stages: readonly (Stage | undefined)[] = Array.isArray(lower) && lower.length <= L.maxStages - 1 ? [...lower, plan.spacecraft] : [plan.spacecraft];
  if (isFlownLaunch(st) && !(Array.isArray(lower) && lower.length >= 1)) add('stages', 'lowerStages', 'a vehicle launch needs at least one stage below the spacecraft (the spacecraft never flies the ascent)');

  const burns = plan.burns;
  if (!Array.isArray(burns) || burns.length > L.maxBurns) add('burns', 'burns', `at most ${L.maxBurns} burns`);
  else {
    let prevEnd = -Infinity;
    burns.forEach((b, i) => {
      const n = `burns[${i}]`;
      range(`${n}.start`, b?.start, 0, L.maxDuration);
      range(`${n}.duration`, b?.duration, 0, L.maxDuration, true);
      const k = b?.stage ?? stages.length - 1;
      const se = Number.isInteger(k) && k >= 0 && k < stages.length ? stages[k]?.engines : undefined;
      if (b?.stage !== undefined && se === undefined) add('burn-stage', `${n}.stage`, `${n}.stage must index the vehicle's ${stages.length} stage(s)`, i);
      else if (!Number.isInteger(b?.engine) || b.engine < 0 || !Array.isArray(se) || b.engine >= se.length) add('burn-engine', `${n}.engine`, b?.stage === undefined ? `${n}.engine must index spacecraft.engines` : `${n}.engine must index the engines of stage ${k}`, i);
      const d = b?.direction;
      if (!Array.isArray(d) || d.length !== 3 || !d.every((x) => finite(x) && Math.abs(x) <= 1e6)) add('burn-direction', `${n}.direction`, `${n}.direction must be 3 finite numbers with |x| <= 1e6`, i);
      else if (!(d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > 1e-24)) add('burn-direction', `${n}.direction`, `${n}.direction must not be zero`, i);
      if (b?.frame?.kind === 'orbital') id(`${n}.frame.body`, b.frame.body);
      else if (b?.frame?.kind !== 'inertial') add('burn-frame', `${n}.frame.kind`, `${n}.frame.kind must be "inertial" or "orbital"`, i);
      if (finite(b?.start) && finite(b?.duration)) {
        if (b.start < prevEnd) add('burn-overlap', `${n}.start`, `${n} starts before the previous burn ends (burns must be sorted and not overlap)`, i);
        prevEnd = b.start + b.duration;
      }
    });
  }

  const seps = plan.separations;
  if (seps !== undefined) {
    if (!Array.isArray(seps) || seps.length > L.maxSeparations) add('action-order', 'separations', `at most ${L.maxSeparations} separations`);
    else {
      seps.forEach((x, j) => range(`separations[${j}].time`, x?.time, 0, L.maxDuration));
      for (let j = 1; j < seps.length; j++) if (finite(seps[j]?.time) && finite(seps[j - 1]?.time) && seps[j].time < seps[j - 1].time) add('action-order', `separations[${j}].time`, `separations must be sorted by time`);
    }
  }
  // Which stage is active when: needs the stage that starts the flight. A
  // vehicle launch starts in the stage the ascent ends in, known only once the
  // ascent is computed (validateStaging, run by replay and by 'full').
  if (errs.length === 0 && !isFlownLaunch(st)) errs.push(...stagingIssues(plan, 0));
  else if (errs.length === 0 && (opts.launch ?? 'full') === 'full' && opts.ascentFirstStage !== undefined) errs.push(...stagingIssues(plan, opts.ascentFirstStage), ...ascentRestartIssues(plan, opts.ascentFirstStage));
  if (errs.length === 0) errs.push(...propulsionIssues(plan));
  return errs;
}

/**
 * Propulsion flags against the burns (static part): a non-restartable engine
 * fires in at most one burn; a non-throttleable engine's burn must last at
 * least its stage's full propellant at that engine's flow (so it burns to
 * depletion: the integrator ends it when the tanks run dry). Burns never
 * overlap, so one engine draws on the stage at a time. Plans without flags
 * have no such issues.
 */
export function propulsionIssues(plan: MissionPlan): PlanIssue[] {
  const out: PlanIssue[] = [];
  if (!usesPropulsionFlags(plan)) return out;
  const stages = vehicleStages(plan);
  const seen = new Set<string>();
  plan.burns.forEach((b, i) => {
    const k = burnStage(plan, b);
    const st = stages[k];
    const e = st.engines[b.engine];
    const key = `${k}:${b.engine}`;
    if (e.restartable === false) {
      if (seen.has(key)) out.push({ code: 'engine-restart', path: `burns[${i}].engine`, burn: i, message: `burns[${i}]: engine ${b.engine} of stage ${k} cannot restart (it already fired in an earlier burn)` });
      seen.add(key);
    }
    if (e.throttleable === false) {
      const full = (st.wetMass - st.dryMass) / (e.thrust / (e.isp * G0_PLAN));
      if (!(b.duration >= full)) out.push({ code: 'engine-throttle', path: `burns[${i}].duration`, burn: i, message: `burns[${i}]: engine ${b.engine} of stage ${k} cannot be shut down (non-throttleable): its burn must last until depletion, at least ${full} s, got ${b.duration}` });
    }
  });
  return out;
}

/** The stage that ends the ascent was lit during it: a non-restartable engine of it cannot fire again in flight. */
export function ascentRestartIssues(plan: MissionPlan, upperStage: number): PlanIssue[] {
  const out: PlanIssue[] = [];
  const stages = vehicleStages(plan);
  plan.burns.forEach((b, i) => {
    const k = burnStage(plan, b);
    if (k === upperStage && stages[k]?.engines[b.engine]?.restartable === false) out.push({ code: 'engine-restart', path: `burns[${i}].engine`, burn: i, message: `burns[${i}]: stage ${k} was lit during the ascent and engine ${b.engine} cannot restart` });
  });
  return out;
}

/** Standard gravity (as physics/spacecraft.ts G0), for burn-time bounds. */
const G0_PLAN = 9.80665;

/**
 * Stage sequence of a structurally valid plan whose flight starts with stage
 * `first` active (0, or the stage a vehicle launch reaches orbit in): every
 * burn names the active stage, no burn spans a separation, no separation
 * drops the spacecraft or comes before the flight starts.
 */
export function stagingIssues(plan: MissionPlan, first: number): PlanIssue[] {
  const out: PlanIssue[] = [];
  const n = vehicleStages(plan).length;
  const t0 = simulationStartOffset(plan.start);
  let active = first;
  const seps = plan.separations ?? [];
  for (const a of flightActions(plan)) {
    if (a.kind === 'separation') {
      const path = `separations[${a.index}].time`;
      if (a.t < t0) out.push({ code: 'separation-before-insertion', path, message: `separations[${a.index}] at ${a.t} s is before the flight starts (${t0} s after the epoch${plan.start.kind === 'launch' ? ', orbit insertion' : ''})` });
      if (active >= n - 1) out.push({ code: 'separation-last', path, message: `separations[${a.index}] would drop the spacecraft (the last stage)` });
      else active++;
    } else {
      const b = a.burn;
      const k = burnStage(plan, b);
      if (k !== active) out.push({ code: 'burn-stage', path: `burns[${a.index}].stage`, burn: a.index, message: `burns[${a.index}] fires stage ${k}, but stage ${active} is the active stage at ${b.start} s` });
      const end = b.start + b.duration;
      for (let j = 0; j < seps.length; j++) {
        if (seps[j].time > b.start && seps[j].time < end) out.push({ code: 'burn-spans-separation', path: `burns[${a.index}].duration`, burn: a.index, message: `burns[${a.index}] (${b.start}..${end} s) is still firing at separations[${j}] (${seps[j].time} s)` });
      }
    }
  }
  return out;
}

/** Launch semantics, mirroring what launch.ts launchFromParams / launchState would refuse. */
function launchIssues(siteId: string, params: readonly number[], add: (code: PlanIssueCode, path: string, message: string) => void): void {
  const site = LAUNCH_SITES.find((s) => s.id === siteId);
  if (!site) {
    add('launch-site', 'start.site', `start.site: unknown launch site ${siteId} (known: ${LAUNCH_SITES.map((s) => s.id).join(', ')})`);
    return;
  }
  if (params.length < 3 || params.length > 6) {
    add('launch-params', 'start.params', `start.params: a parking-orbit launch takes 3 to 6 parameters [time, azimuth, altitude, ascent?, downrange?, circularization?], got ${params.length}`);
    return;
  }
  const c = params[5] ?? 0;
  if (c !== 0 && c !== 1) add('launch-mode', 'start.params[5]', `start.params[5] (circularization) must be 0 (j2-mean) or 1 (two-body), got ${c}`);
  if (!azimuthAllowed(site, params[1])) add('launch-azimuth', 'start.params[1]', `start.params[1]: azimuth ${params[1]} deg is outside ${site.id}'s range-safety corridor ${site.azimuthMinDeg}..${site.azimuthMaxDeg} deg`);
  if (!(params[2] > 0 && params[2] <= MAX_PARKING_ALTITUDE)) add('launch-altitude', 'start.params[2]', `start.params[2]: parking-orbit altitude must be in (0, ${MAX_PARKING_ALTITUDE}] m, got ${params[2]}`);
}

/** Direct-injection semantics (params count already checked), mirroring launch.ts directFromParams. */
function directLaunchIssues(siteId: string, params: readonly number[], add: (code: PlanIssueCode, path: string, message: string) => void): void {
  const site = LAUNCH_SITES.find((s) => s.id === siteId);
  if (!site) {
    add('launch-site', 'start.site', `start.site: unknown launch site ${siteId} (known: ${LAUNCH_SITES.map((s) => s.id).join(', ')})`);
    return;
  }
  if (!azimuthAllowed(site, params[1])) add('launch-azimuth', 'start.params[1]', `start.params[1]: azimuth ${params[1]} deg is outside ${site.id}'s range-safety corridor ${site.azimuthMinDeg}..${site.azimuthMaxDeg} deg`);
  const [c0, c1] = DIRECT_C3_RANGE;
  if (!(params[2] >= c0 && params[2] <= c1)) add('launch-c3', 'start.params[2]', `start.params[2]: target C3 must be in [${c0}, ${c1}] m^2/s^2, got ${params[2]}`);
  const [h0, h1] = DIRECT_ALTITUDE_RANGE;
  if (!(params[3] >= h0 && params[3] <= h1)) add('launch-altitude', 'start.params[3]', `start.params[3]: injection altitude must be in [${h0}, ${h1}] m, got ${params[3]}`);
}

/** Highest parking-orbit altitude a launch start accepts, m. */
export const MAX_PARKING_ALTITUDE = 2_000e3;

/**
 * All problems with a plan as messages (empty if valid). Same checks as
 * validatePlanIssues, which also gives the field, burn and a stable code.
 */
export function validatePlan(plan: MissionPlan, opts: ValidateOptions = {}): string[] {
  return validatePlanIssues(plan, opts).map((e) => e.message);
}

export function assertValidPlan(plan: MissionPlan, opts: ValidateOptions = {}): void {
  const errs = validatePlan(plan, opts);
  if (errs.length > 0) throw new PlanError(`invalid plan: ${errs.join('; ')}`);
}

// ---------------------------------------------------------------- encoding

class Writer {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  length = 0;
  private need(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    nb.set(this.buf);
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v: number): void { this.need(1); this.view.setUint8(this.length, v); this.length += 1; }
  u16(v: number): void { this.need(2); this.view.setUint16(this.length, v, true); this.length += 2; }
  u32(v: number): void { this.need(4); this.view.setUint32(this.length, v, true); this.length += 4; }
  f64(v: number): void { this.need(8); this.view.setFloat64(this.length, v, true); this.length += 8; }
  str(s: string): void { this.u8(s.length); for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  bytes(): Uint8Array { return this.buf.slice(0, this.length); }
}

class Reader {
  private pos = 0;
  private readonly view: DataView;
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number, what: string): void {
    if (this.pos + n > this.buf.length) throw new PlanError(`plan is truncated (reading ${what} at byte ${this.pos})`);
  }
  u8(what: string): number { this.need(1, what); return this.view.getUint8(this.pos++); }
  u16(what: string): number { this.need(2, what); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  u32(what: string): number { this.need(4, what); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  f64(what: string): number { this.need(8, what); const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
  str(what: string): string {
    const n = this.u8(what);
    if (n === 0 || n > LIMITS.maxIdLength) throw new PlanError(`${what}: bad id length ${n}`);
    this.need(n, what);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.buf[this.pos++]);
    if (!ID_RE.test(s)) throw new PlanError(`${what}: id has invalid characters`);
    return s;
  }
  done(): void {
    if (this.pos !== this.buf.length) throw new PlanError(`plan has ${this.buf.length - this.pos} unexpected trailing bytes`);
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let c = 0; c < chars; c++) s += B64[(n >>> (18 - 6 * c)) & 63];
  }
  return s;
}

export function fromBase64Url(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new PlanError('plan string has an impossible length');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    const chars = Math.min(4, s.length - i);
    for (let c = 0; c < 4; c++) {
      let v = 0;
      if (c < chars) {
        const code = s.charCodeAt(i + c);
        v = code < 128 ? B64_INV[code] : -1;
        if (v < 0) throw new PlanError(`plan string has an invalid character at position ${i + c}`);
      }
      n = (n << 6) | v;
    }
    out[o++] = (n >>> 16) & 255;
    if (chars > 2) out[o++] = (n >>> 8) & 255;
    if (chars > 3) out[o++] = n & 255;
  }
  // Reject non-canonical encodings (stray bits in the last character).
  if (toBase64Url(out) !== s) throw new PlanError('plan string is not canonical base64url');
  return out;
}

/** Format-3 engine flag bits (a set bit means the capability is absent). */
const ENGINE_NO_RESTART = 1;
const ENGINE_NO_THROTTLE = 2;

/** Encode a (valid) plan to a URL-safe string. */
export function encodePlan(plan: MissionPlan): string {
  // Format-level checks only: an unknown launch site still encodes (replay refuses it).
  assertValidPlan(plan, { launch: 'structural' });
  const w = new Writer();
  w.u8(0x53);
  w.u8(plan.format);
  w.u16(plan.model);
  w.u32(parseInt(plan.data, 16));
  w.f64(plan.epoch);
  w.f64(plan.duration);
  w.f64(plan.rtol);
  const st = plan.start;
  if (st.kind === 'state') {
    w.u8(0);
    w.str(st.center);
    for (let i = 0; i < 6; i++) w.f64(st.state[i]);
  } else {
    w.u8(isDirectLaunch(st) ? 3 : isVehicleLaunch(st) ? 2 : 1);
    w.str(st.site);
    w.u8(st.params.length);
    for (const p of st.params) w.f64(p);
  }
  const stage = (sc: Stage) => {
    w.f64(sc.wetMass);
    w.f64(sc.dryMass);
    w.u8(sc.engines.length);
    for (const e of sc.engines) {
      w.f64(e.thrust);
      w.f64(e.isp);
      if (plan.format === PLAN_FORMAT_DIRECT) w.u8((e.restartable === false ? ENGINE_NO_RESTART : 0) | (e.throttleable === false ? ENGINE_NO_THROTTLE : 0));
    }
  };
  const burn = (b: PlanBurn, withStage: boolean) => {
    w.f64(b.start);
    w.f64(b.duration);
    if (withStage) w.u8(burnStage(plan, b));
    w.u8(b.engine);
    for (let i = 0; i < 3; i++) w.f64(b.direction[i]);
    if (b.frame.kind === 'inertial') w.u8(0);
    else { w.u8(1); w.str(b.frame.body); }
  };
  if (plan.format === PLAN_FORMAT) {
    stage(plan.spacecraft);
    w.u16(plan.burns.length);
    for (const b of plan.burns) burn(b, false);
  } else {
    const stages = vehicleStages(plan);
    w.u8(stages.length);
    for (const sc of stages) stage(sc);
    const acts = flightActions(plan);
    w.u16(acts.length);
    for (const a of acts) {
      if (a.kind === 'burn') { w.u8(0); burn(a.burn, true); }
      else { w.u8(1); w.f64(a.t); }
    }
  }
  return toBase64Url(w.bytes());
}

/** Decode and validate. Throws PlanError with a clear message on any problem. */
export function decodePlan(s: string): MissionPlan {
  if (typeof s !== 'string') throw new PlanError('plan must be a string');
  if (s.length > LIMITS.maxEncodedLength) throw new PlanError(`plan string is too long (${s.length} > ${LIMITS.maxEncodedLength})`);
  const r = new Reader(fromBase64Url(s));
  if (r.u8('magic') !== 0x53) throw new PlanError('not a mission plan (bad magic byte)');
  const format = r.u8('format');
  if (!PLAN_FORMATS.includes(format)) throw new PlanError(`unsupported plan format ${format} (this build reads ${PLAN_FORMATS.join(', ')})`);
  const model = r.u16('model');
  const data = r.u32('data').toString(16).padStart(8, '0');
  const epoch = r.f64('epoch');
  const duration = r.f64('duration');
  const rtol = r.f64('rtol');
  const tag = r.u8('start kind');
  let start: PlanStart;
  if (tag === 0) {
    const center = r.str('start.center');
    const state: number[] = [];
    for (let i = 0; i < 6; i++) state.push(r.f64('start.state'));
    start = { kind: 'state', center, state };
  } else if (tag === 1 || (tag === 2 && format >= PLAN_FORMAT_STAGED) || (tag === 3 && format === PLAN_FORMAT_DIRECT)) {
    const site = r.str('start.site');
    const n = r.u8('start.params count');
    if (n > LIMITS.maxLaunchParams) throw new PlanError(`too many launch parameters (${n})`);
    const params: number[] = [];
    for (let i = 0; i < n; i++) params.push(r.f64('start.params'));
    start = tag === 3 ? { kind: 'launch', site, params, ascent: 'direct' } : tag === 2 ? { kind: 'launch', site, params, ascent: 'vehicle' } : { kind: 'launch', site, params };
  } else throw new PlanError(`unknown start kind ${tag}`);
  const readStage = (what: string): Stage => {
    const wetMass = r.f64(`${what}.wetMass`);
    const dryMass = r.f64(`${what}.dryMass`);
    const ne = r.u8(`${what} engine count`);
    if (ne > LIMITS.maxEngines) throw new PlanError(`too many engines (${ne})`);
    const engines: Engine[] = [];
    for (let i = 0; i < ne; i++) {
      const thrust = r.f64('engine thrust');
      const isp = r.f64('engine isp');
      if (format !== PLAN_FORMAT_DIRECT) { engines.push({ thrust, isp }); continue; }
      const fl = r.u8('engine flags');
      if (fl & ~(ENGINE_NO_RESTART | ENGINE_NO_THROTTLE)) throw new PlanError(`${what}: unknown engine flag bits ${fl}`);
      // Canonical in memory: a flag appears only when false.
      engines.push({ thrust, isp, ...(fl & ENGINE_NO_RESTART ? { restartable: false } : {}), ...(fl & ENGINE_NO_THROTTLE ? { throttleable: false } : {}) });
    }
    return { wetMass, dryMass, engines };
  };
  const readBurn = (i: number, withStage: boolean): PlanBurn => {
    const bs = r.f64(`burns[${i}].start`);
    const bd = r.f64(`burns[${i}].duration`);
    const stage = withStage ? r.u8(`burns[${i}].stage`) : undefined;
    const engine = r.u8(`burns[${i}].engine`);
    const direction: [number, number, number] = [r.f64('direction'), r.f64('direction'), r.f64('direction')];
    const fk = r.u8(`burns[${i}].frame`);
    let frame: PlanFrame;
    if (fk === 0) frame = { kind: 'inertial' };
    else if (fk === 1) frame = { kind: 'orbital', body: r.str(`burns[${i}].frame.body`) };
    else throw new PlanError(`burns[${i}]: unknown frame kind ${fk}`);
    return stage === undefined ? { start: bs, duration: bd, engine, direction, frame } : { start: bs, duration: bd, stage, engine, direction, frame };
  };
  let plan: MissionPlan;
  if (format === PLAN_FORMAT) {
    const spacecraft = readStage('spacecraft');
    const nb = r.u16('burn count');
    if (nb > LIMITS.maxBurns) throw new PlanError(`too many burns (${nb} > ${LIMITS.maxBurns})`);
    const burns: PlanBurn[] = [];
    for (let i = 0; i < nb; i++) burns.push(readBurn(i, false));
    r.done();
    plan = { format, model, data, epoch, duration, rtol, start, spacecraft, burns };
  } else {
    const ns = r.u8('stage count');
    if (ns < 1 || ns > LIMITS.maxStages) throw new PlanError(`a vehicle needs 1-${LIMITS.maxStages} stages, got ${ns}`);
    const stages: Stage[] = [];
    for (let k = 0; k < ns; k++) stages.push(readStage(`stages[${k}]`));
    const na = r.u16('action count');
    if (na > LIMITS.maxBurns + LIMITS.maxSeparations) throw new PlanError(`too many actions (${na})`);
    const burns: PlanBurn[] = [];
    const separations: PlanSeparation[] = [];
    let prevT = -Infinity;
    let prevKind = -1;
    for (let i = 0; i < na; i++) {
      const kind = r.u8(`actions[${i}] kind`);
      let t: number;
      if (kind === 0) {
        if (burns.length >= LIMITS.maxBurns) throw new PlanError(`too many burns (> ${LIMITS.maxBurns})`);
        const b = readBurn(burns.length, true);
        burns.push(b);
        t = b.start;
      } else if (kind === 1) {
        if (separations.length >= LIMITS.maxSeparations) throw new PlanError(`too many separations (> ${LIMITS.maxSeparations})`);
        t = r.f64(`separations[${separations.length}].time`);
        separations.push({ time: t });
      } else throw new PlanError(`actions[${i}]: unknown action kind ${kind}`);
      // Canonical order: by time, a separation before a burn at the same time (NaN is refused by validation).
      if (t < prevT || (t === prevT && kind === 1 && prevKind === 0)) throw new PlanError(`actions[${i}]: actions are not in time order (action-order)`);
      prevT = t;
      prevKind = kind;
    }
    r.done();
    plan = { format, model, data, epoch, duration, rtol, start, spacecraft: stages[ns - 1], burns, lowerStages: stages.slice(0, ns - 1), separations };
  }
  assertValidPlan(plan, { launch: 'structural' });
  return plan;
}
