/**
 * Replay a mission plan: propagate it with the real physics, find events, and
 * report the outcome, delta-v, propellant, time and a digest of the result.
 *
 * Deterministic: exactly-defined operations only (delta-v uses exactLn), and
 * the digest hashes the bits of every number in the result, so two browsers
 * that agree on the digest agree on the whole result.
 *
 * Stopping early: on a terminal event (or a work limit, or an abort) onStep
 * throws a private sentinel that is caught here. propagate's own try/finally
 * keeps its state consistent; nothing else needs changing.
 *
 * OBSERVING A REPLAY (for drawing): `onStart` and `onStep` see the initial
 * state and every accepted integrator step with the same dense-output
 * interpolant the event finder uses. Evaluating the interpolant is a pure
 * function of the step's stored coefficients, so observing changes nothing:
 * the result and digest are bit-identical with or without the hooks
 * (test/mission-replay-api.test.ts). `onStep` runs before the step's events
 * are searched, so the step that ends the flight is also reported; samples
 * past `result.finalT` belong to that step and should be dropped.
 *
 * ABORTING: `signal` (an AbortSignal or anything with `aborted`) or
 * `shouldStop()` is polled once per accepted step; when set, the replay ends
 * with outcome 'aborted' (never a success, never scored).
 */
import { G0, propagate, STATE_SIZE, type Burn } from '../physics/spacecraft';
import { EventFinder, type SphereSpec, type TrajectoryEvent } from './events';
import { exactLn, Hasher } from './exact-math';
import { launchFromParams, launchState } from './launch';
import { simulationStartOffset, validatePlan, type MissionPlan, type PlanStart } from './plan';
import { bodyIndexOf, PHYSICS_MODEL, type MissionWorld } from './world';

export type Outcome =
  /** Flew the whole duration. */
  | 'completed'
  /** Hit a surface. Always a failure. */
  | 'impact'
  /** Entered an atmosphere; whether that is a failure is the mission's call (reentry objective). */
  | 'atmosphere'
  | 'invalid-plan'
  | 'version-mismatch'
  | 'unsupported-start'
  | 'step-limit'
  | 'event-limit'
  /** The physics threw (e.g. a degenerate orbital-frame burn). */
  | 'physics-error'
  /** Stopped by the caller (ReplayOptions.signal / shouldStop). */
  | 'aborted';

export interface BurnReport {
  /** Actual burn time, s (shorter than planned if the tanks ran dry or the flight ended). */
  readonly burnTime: number;
  readonly propellant: number;
  /** Rocket-equation delta-v from the real mass change, m/s. */
  readonly deltaV: number;
}

/** Where a launch start put the spacecraft (launch-kind plans only). */
export interface LaunchInsertion {
  /** Orbit insertion time, ephemeris time (epoch + ascent time). */
  readonly t: number;
  /** Barycentric [x, y, z, vx, vy, vz] at insertion, ephemeris frame. */
  readonly state: readonly number[];
  /** Earth-relative [x, y, z, vx, vy, vz] at insertion. Absent for a custom resolveLaunch. */
  readonly geocentric?: readonly number[];
  /** Parking-orbit inclination to Earth's equator of date, deg. Absent for a custom resolveLaunch. */
  readonly inclinationDeg?: number;
}

export interface ReplayResult {
  /** outcome === 'completed'. */
  readonly ok: boolean;
  readonly outcome: Outcome;
  readonly reason: string;
  readonly events: readonly TrajectoryEvent[];
  readonly burns: readonly BurnReport[];
  readonly deltaV: number;
  readonly propellantUsed: number;
  /** Seconds from the epoch to the end of the flight. */
  readonly elapsed: number;
  /** Ephemeris time at the end. */
  readonly finalT: number;
  /** [x, y, z, vx, vy, vz, mass], ephemeris frame. Empty if the flight never started. */
  readonly finalState: readonly number[];
  readonly steps: number;
  /** 16 hex digits over every number above (not over `launch`, which the plan determines). */
  readonly digest: string;
  /** Launch-kind plans that got as far as insertion: where the launch put the spacecraft. */
  readonly launch?: LaunchInsertion;
}

/** Dense-output interpolant of one accepted step: writes [x,y,z,vx,vy,vz,mass] at t in [tPrev, t]. */
export type StepInterpolant = (t: number, out: Float64Array) => void;

export interface ReplayOptions {
  readonly spheres?: readonly SphereSpec[];
  /** Watch only these bodies for events (default all). Impact checks apply only to watched bodies. */
  readonly bodies?: readonly string[];
  readonly stopOnAtmosphere?: boolean;
  /** Integrator step budget. Default 2 000 000. */
  readonly maxSteps?: number;
  /** Event budget. Default 200 000. */
  readonly maxEvents?: number;
  /** Replay even if the plan's model / data fingerprint differs from this world. */
  readonly allowVersionMismatch?: boolean;
  /**
   * Override for turning a launch start into a barycentric state
   * [x,y,z,vx,vy,vz] at insertion (epoch + ascent time). Default: launch.ts
   * (launchFromParams + launchState), which needs world.bodyData.
   */
  readonly resolveLaunch?: (start: Extract<PlanStart, { kind: 'launch' }>, world: MissionWorld, epoch: number) => ArrayLike<number>;
  /** Called once with the initial state (simulation start time, [x,y,z,vx,vy,vz,mass]). Observes only. */
  readonly onStart?: (t: number, y: ArrayLike<number>) => void;
  /**
   * Called for every accepted integrator step, before its events are found,
   * with the step's interpolant (valid only during the call; out needs 7
   * elements). Observes only: the result and digest do not change.
   */
  readonly onStep?: (t: number, tPrev: number, interpolate: StepInterpolant) => void;
  /** Abort: polled once per step (an AbortSignal works). */
  readonly signal?: { readonly aborted: boolean };
  /** Abort: return true to stop. Polled once per step. */
  readonly shouldStop?: () => boolean;
}

/** State at the start of the current step (where an abort leaves the flight). */
function prevState(interpolate: StepInterpolant, tPrev: number): Float64Array {
  const y = new Float64Array(STATE_SIZE);
  interpolate(tPrev, y);
  return y;
}

class Stop {
  constructor(readonly outcome: Outcome, readonly reason: string, readonly t: number, readonly y: Float64Array) {}
}

function fail(outcome: Outcome, reason: string): ReplayResult {
  return finish({ outcome, reason, events: [], burns: [], elapsed: 0, finalT: NaN, finalState: [], steps: 0 });
}

function finish(r: Omit<ReplayResult, 'ok' | 'digest' | 'deltaV' | 'propellantUsed' | 'launch'>, launch?: LaunchInsertion): ReplayResult {
  let deltaV = 0;
  let propellantUsed = 0;
  for (const b of r.burns) {
    deltaV += b.deltaV;
    propellantUsed += b.propellant;
  }
  const h = new Hasher().str(r.outcome).f64(r.elapsed).f64(r.finalT).f64(deltaV).f64(propellantUsed).u32(r.steps);
  for (const v of r.finalState) h.f64(v);
  for (const b of r.burns) h.f64(b.burnTime).f64(b.propellant).f64(b.deltaV);
  h.u32(r.events.length);
  for (const e of r.events) {
    h.str(e.kind).str(e.body).f64(e.t).f64(e.mass);
    for (const v of e.rel) h.f64(v);
  }
  const out: ReplayResult = { ...r, ok: r.outcome === 'completed', deltaV, propellantUsed, digest: h.hex() };
  return launch ? { ...out, launch } : out;
}

/** Replay a plan in a world. Never throws for a bad plan: the result says what went wrong. */
export function replay(plan: MissionPlan, world: MissionWorld, opts: ReplayOptions = {}): ReplayResult {
  // Format first; launch semantics below (a custom resolveLaunch has its own sites).
  const errs = validatePlan(plan, { launch: 'structural' });
  if (errs.length > 0) return fail('invalid-plan', errs.join('; '));
  if (!opts.allowVersionMismatch && (plan.model !== PHYSICS_MODEL || plan.data !== world.fingerprint)) {
    return fail('version-mismatch', `plan made for model ${plan.model} / data ${plan.data}; this build is model ${PHYSICS_MODEL} / data ${world.fingerprint}`);
  }
  const eph = world.ephemeris;
  const epoch = plan.epoch;
  // Simulation starts at the epoch, or at orbit insertion for a launch (see plan.ts TIME RULES).
  const t0 = epoch + simulationStartOffset(plan.start);
  const t1 = epoch + plan.duration;

  // Initial state.
  const y0 = new Float64Array(STATE_SIZE);
  const st = plan.start;
  let launch: LaunchInsertion | undefined;
  if (st.kind === 'state') {
    const c = bodyIndexOf(world, st.center);
    if (c < 0) return fail('invalid-plan', `start.center: unknown body ${st.center}`);
    const bs = new Float64Array(6);
    eph.bodyState(c, t0, bs);
    for (let j = 0; j < 6; j++) y0[j] = bs[j] + st.state[j];
  } else {
    let s: ArrayLike<number>;
    try {
      if (opts.resolveLaunch) {
        s = opts.resolveLaunch(st, world, t0);
        launch = { t: t0, state: Array.from(s).slice(0, 6) };
      } else if (world.bodyData) {
        const full = validatePlan(plan);
        if (full.length > 0) return fail('invalid-plan', full.join('; '));
        const res = launchState(launchFromParams(st.site, st.params), eph, world.bodyData);
        if (res.t !== t0) return fail('invalid-plan', `launch insertion time ${res.t} differs from epoch + ascent ${t0}`);
        s = res.state;
        launch = { t: res.t, state: res.state.slice(), geocentric: res.geocentric.slice(), inclinationDeg: res.inclinationDeg };
      } else return fail('unsupported-start', `launch start (site ${st.site}) needs a world built from body data or a resolveLaunch option`);
    } catch (e) {
      return fail('invalid-plan', `launch: ${(e as Error).message}`);
    }
    for (let j = 0; j < 6; j++) y0[j] = s[j];
  }
  y0[6] = plan.spacecraft.wetMass;
  const dryMass = plan.spacecraft.dryMass;

  // Burns in physics form.
  const burns: Burn[] = [];
  for (let i = 0; i < plan.burns.length; i++) {
    const b = plan.burns[i];
    const e = plan.spacecraft.engines[b.engine];
    let frame: Burn['frame'];
    if (b.frame.kind === 'orbital') {
      const k = bodyIndexOf(world, b.frame.body);
      if (k < 0) return fail('invalid-plan', `burns[${i}].frame.body: unknown body ${b.frame.body}`);
      frame = { kind: 'orbital', body: k };
    } else frame = { kind: 'inertial' };
    burns.push({ tStart: epoch + b.start, duration: b.duration, thrust: e.thrust, isp: e.isp, direction: [b.direction[0], b.direction[1], b.direction[2]], frame });
  }

  let finder: EventFinder;
  try {
    finder = new EventFinder(world, { bodies: opts.bodies, spheres: opts.spheres, stopOnAtmosphere: opts.stopOnAtmosphere });
  } catch (e) {
    return fail('invalid-plan', (e as Error).message);
  }
  const maxSteps = opts.maxSteps ?? 2_000_000;
  const maxEvents = opts.maxEvents ?? 200_000;

  // Per-burn mass at ignition and at the latest point inside the burn.
  const mStart = new Float64Array(burns.length).fill(NaN);
  const mEnd = new Float64Array(burns.length).fill(NaN);
  const tFirst = new Float64Array(burns.length).fill(NaN);
  const tLast = new Float64Array(burns.length).fill(NaN);
  let bi = 0;
  let prevMass = y0[6];
  const account = (tPrev: number, t: number, mPrev: number, m: number) => {
    // Steps never straddle ignition or cutoff (propagate stops on both).
    while (bi < burns.length && burns[bi].tStart + burns[bi].duration <= tPrev) bi++;
    if (bi < burns.length && burns[bi].tStart <= tPrev && t <= burns[bi].tStart + burns[bi].duration && m !== mPrev) {
      if (Number.isNaN(mStart[bi])) { mStart[bi] = mPrev; tFirst[bi] = tPrev; }
      mEnd[bi] = m;
      tLast[bi] = t;
    }
  };

  let steps = 0;
  let outcome: Outcome = 'completed';
  let reason = '';
  let finalT = t1;
  let finalY: Float64Array;

  const aborted = (): boolean => opts.signal?.aborted === true || (opts.shouldStop !== undefined && opts.shouldStop());
  const done = (r: Omit<ReplayResult, 'ok' | 'digest' | 'deltaV' | 'propellantUsed' | 'launch'>) => finish(r, launch);

  opts.onStart?.(t0, y0);
  const first = finder.start(t0, y0);
  if (first !== null) {
    outcome = first.kind === 'impact' ? 'impact' : 'atmosphere';
    reason = `starts inside ${first.body} (${first.kind})`;
    finalT = t0;
    finalY = y0;
  } else {
    try {
      const res = propagate(eph, y0, t0, t1, burns, {
        rtol: plan.rtol,
        dryMass,
        onStep: (t, y, interpolate, tPrev) => {
          steps++;
          if (aborted()) throw new Stop('aborted', 'stopped by the caller', tPrev, prevState(interpolate, tPrev));
          opts.onStep?.(t, tPrev, interpolate);
          const term = finder.step(t, interpolate, tPrev);
          if (term !== null) {
            const yi = new Float64Array(STATE_SIZE);
            interpolate(term.t, yi);
            account(tPrev, term.t, prevMass, yi[6]);
            const why = term.kind === 'impact' ? 'impact' : 'atmosphere';
            throw new Stop(why, `${term.kind} at ${term.body}, speed ${term.speed.toFixed(1)} m/s`, term.t, yi);
          }
          account(tPrev, t, prevMass, y[6]);
          prevMass = y[6];
          if (steps >= maxSteps && t < t1) throw new Stop('step-limit', `more than ${maxSteps} integrator steps`, t, Float64Array.from(y));
          if (finder.events.length > maxEvents) throw new Stop('event-limit', `more than ${maxEvents} events`, t, Float64Array.from(y));
        },
      });
      finalY = res.y;
      finalT = res.t;
    } catch (e) {
      if (e instanceof Stop) {
        outcome = e.outcome;
        reason = e.reason;
        finalT = e.t;
        finalY = e.y;
      } else {
        return done({ outcome: 'physics-error', reason: (e as Error).message, events: finder.events.slice(), burns: [], elapsed: 0, finalT: NaN, finalState: [], steps });
      }
    }
  }

  const reports: BurnReport[] = [];
  for (let i = 0; i < burns.length; i++) {
    if (Number.isNaN(mStart[i])) { reports.push({ burnTime: 0, propellant: 0, deltaV: 0 }); continue; }
    const ve = burns[i].isp * G0;
    reports.push({ burnTime: tLast[i] - tFirst[i], propellant: mStart[i] - mEnd[i], deltaV: ve * exactLn(mStart[i] / mEnd[i]) });
  }
  return done({
    outcome,
    reason,
    events: finder.events.slice(),
    burns: reports,
    elapsed: outcome === 'completed' ? plan.duration : finalT - epoch,
    finalT,
    finalState: Array.from(finalY),
    steps,
  });
}
