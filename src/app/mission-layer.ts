/**
 * The app's single adapter to src/mission (as physics.ts is to src/physics).
 * Nothing else in src/app imports the mission modules.
 *
 * TRAJECTORY SAMPLES FROM THE SCORING REPLAY. The drawn trajectory must be the
 * one `replay` flies, so samples are taken from inside `replay` itself:
 * `replay` exposes no per-step hook, but it hands every accepted integrator
 * step (time, dense-output interpolant) to `EventFinder.step`. We wrap that
 * method once, at module load, and while `replayWithSamples` is running the
 * wrapper also evaluates the same interpolant at a few times per step. The
 * interpolant is a pure function of the step's stored coefficients, so this
 * does not change a single bit of the result (the digest test checks it).
 * The same wrapper is the cancellation point: throwing from it ends the
 * propagation (replay reports 'physics-error', which we discard).
 * This is a workaround for a missing API (see the task report): replay should
 * accept an `onStep`/`onSample` option and an abort signal.
 */
import { EventFinder } from '../mission/events';
import { DEFAULT_ASCENT_TIME_S, LAUNCH_SITES, azimuthAllowed, azimuthForInclination, geocentricLatitudeDeg, groundRelativeAzimuthDeg, launchFromParams, launchPlane, launchSite, launchToParams, orbitNormalOf, planeCrossings } from '../mission/launch';
import { evaluate, type Evaluation, type MissionDefinition, type Objective, type ObjectiveResult } from '../mission/objectives';
import { LIMITS, PLAN_FORMAT, PlanError, decodePlan, encodePlan, makePlan, simulationStartOffset, validatePlan, type Engine, type MissionPlan, type PlanBurn, type PlanFrame, type PlanStart, type Spacecraft } from '../mission/plan';
import { replay, type BurnReport, type Outcome, type ReplayOptions, type ReplayResult } from '../mission/replay';
import { SAMPLE_MISSIONS } from '../mission/samples';
import type { EventKind, TrajectoryEvent } from '../mission/events';
import { PHYSICS_MODEL, worldFromBodyData, type MissionWorld } from '../mission/world';
import type { BodyData } from './physics';

export {
  DEFAULT_ASCENT_TIME_S, LAUNCH_SITES, LIMITS, PHYSICS_MODEL, PLAN_FORMAT, PlanError, SAMPLE_MISSIONS,
  azimuthAllowed, azimuthForInclination, decodePlan, encodePlan, evaluate, geocentricLatitudeDeg, groundRelativeAzimuthDeg,
  launchFromParams, launchPlane, launchSite, launchToParams, makePlan, orbitNormalOf, planeCrossings, replay, simulationStartOffset, validatePlan,
};
export type {
  BurnReport, Engine, Evaluation, EventKind, MissionDefinition, MissionPlan, MissionWorld, Objective, ObjectiveResult, Outcome,
  PlanBurn, PlanFrame, PlanStart, ReplayOptions, ReplayResult, Spacecraft, TrajectoryEvent,
};
export type { LaunchSite } from '../mission/launch';

/** Mission world over a physics ephemeris built from `data`. */
export function makeWorld(ephemeris: Parameters<typeof worldFromBodyData>[0], data: readonly BodyData[]): MissionWorld {
  return worldFromBodyData(ephemeris, data);
}

/** Sample layout: t, x, y, z, vx, vy, vz, mass (ICRF barycentric, s, m, m/s, kg). */
export const REPLAY_SAMPLE_STRIDE = 8;

type Interp = (t: number, out: Float64Array) => void;
interface Recorder {
  perStep: number;
  out: number[];
  tmp: Float64Array;
  lastT: number;
  /** Return true to cancel the replay. */
  cancel?: () => boolean;
}

class Cancelled extends Error {}

let recorder: Recorder | null = null;

function push(r: Recorder, t: number, y: ArrayLike<number>): void {
  if (!(t > r.lastT)) return;
  r.lastT = t;
  r.out.push(t, y[0], y[1], y[2], y[3], y[4], y[5], y[6]);
}

(() => {
  const proto = EventFinder.prototype as unknown as {
    start(t: number, y: ArrayLike<number>): unknown;
    step(t: number, interp: Interp, tPrev: number): unknown;
  };
  const start = proto.start;
  const step = proto.step;
  proto.start = function (this: unknown, t: number, y: ArrayLike<number>) {
    if (recorder) push(recorder, t, y);
    return start.call(this, t, y);
  };
  proto.step = function (this: unknown, t: number, interp: Interp, tPrev: number) {
    const r = recorder;
    if (r) {
      if (r.cancel?.()) throw new Cancelled('cancelled');
      for (let i = 1; i <= r.perStep; i++) {
        const ti = i === r.perStep ? t : tPrev + ((t - tPrev) * i) / r.perStep;
        interp(ti, r.tmp);
        push(r, ti, r.tmp);
      }
    }
    return step.call(this, t, interp, tPrev);
  };
})();

export interface SampledReplay {
  result: ReplayResult;
  /** REPLAY_SAMPLE_STRIDE numbers per sample, strictly increasing t, ending at result.finalT. */
  samples: Float64Array;
  cancelled: boolean;
  ms: number;
}

/**
 * Run `replay` (the scoring path) and also collect `perStep` dense-output
 * samples per accepted step. `cancel` is polled once per step.
 */
export function replayWithSamples(plan: MissionPlan, world: MissionWorld, opts: ReplayOptions = {}, perStep = 12, cancel?: () => boolean): SampledReplay {
  const r: Recorder = { perStep, out: [], tmp: new Float64Array(7), lastT: -Infinity, cancel };
  const t0 = performance.now();
  recorder = r;
  let result: ReplayResult;
  let cancelled = false;
  try {
    result = replay(plan, world, opts);
    // A cancel throws through propagate; replay reports it as a physics error.
    cancelled = result.outcome === 'physics-error' && /^cancelled$/.test(result.reason);
  } finally {
    recorder = null;
  }
  // Drop samples past the end of the flight (the step containing a terminal event).
  const end = result.finalT;
  const out = r.out;
  let n = out.length / REPLAY_SAMPLE_STRIDE;
  if (Number.isFinite(end)) {
    while (n > 0 && out[(n - 1) * REPLAY_SAMPLE_STRIDE] > end) n--;
    if (result.finalState.length === 7 && (n === 0 || out[(n - 1) * REPLAY_SAMPLE_STRIDE] < end)) {
      out.length = n * REPLAY_SAMPLE_STRIDE;
      out.push(end, ...result.finalState);
      n++;
    }
  }
  return { result, samples: Float64Array.from(out.slice(0, n * REPLAY_SAMPLE_STRIDE)), cancelled, ms: performance.now() - t0 };
}

/** Evaluate a mission's objectives (null mission: sandbox). */
export function evaluateMission(mission: MissionDefinition | null, result: ReplayResult, world: MissionWorld, epoch: number): Evaluation | null {
  return mission ? evaluate(mission, result, world, epoch) : null;
}

/**
 * Validation errors grouped by burn index (the plan layer reports errors as
 * strings naming `burns[i]`; anything else is a plan-level error).
 */
export function planErrors(plan: MissionPlan): { plan: string[]; burns: Map<number, string[]> } {
  const out = { plan: [] as string[], burns: new Map<number, string[]>() };
  for (const e of validatePlan(plan)) {
    const m = /burns\[(\d+)\]/.exec(e);
    if (m) {
      const i = Number(m[1]);
      out.burns.set(i, [...(out.burns.get(i) ?? []), e]);
    } else out.plan.push(e);
  }
  return out;
}
