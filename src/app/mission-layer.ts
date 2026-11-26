/**
 * The app's single adapter to src/mission (as physics.ts is to src/physics).
 * Nothing else in src/app imports the mission modules.
 *
 * TRAJECTORY SAMPLES FROM THE SCORING REPLAY. The drawn trajectory must be the
 * one `replay` flies, so samples are taken from inside `replay` itself, through
 * its `onStart` / `onStep` observers (dense output of each accepted step,
 * evaluated at a few times per step; observing does not change a bit of the
 * result, the digest test checks it). Cancellation uses `shouldStop`, polled
 * once per step; the replay then ends with outcome 'aborted'.
 */
import { DEFAULT_ASCENT_TIME_S, LAUNCH_SITES, asymptotePlaneNormals, azimuthAllowed, stellarDay, azimuthForInclination, geocentricLatitudeDeg, groundRelativeAzimuthDeg, launchFromParams, launchPlane, launchSite, launchToParams, orbitNormalOf, planeCrossings } from '../mission/launch';
import { allowedSites, briefingText, missionForSite, siteOption, checkPlanConformance, evaluate, initialMissionPlan, missionReplayOptions, PAR_SCORE, type BriefingDistance, type CompleteMission, type ConformanceIssue, type Evaluation, type LeaderboardKeys, type MissionDefinition, type Objective, type ObjectiveResult, type SiteOption } from '../mission/objectives';
import { LIMITS, PLAN_FORMAT, PlanError, decodePlan, isVehicleLaunch, vehicleStages, type PlanSeparation, encodePlan, makePlan, simulationStartOffset, validatePlan, validatePlanIssues, type Engine, type MissionPlan, type PlanBurn, type PlanFrame, type PlanStart, type Spacecraft } from '../mission/plan';
import { ASCENT_BODIES, computeAscent, type AscentResult } from '../mission/ascent';
import { launchGeometry } from '../mission/launch';
import { replay, type BurnReport, type LaunchInsertion, type Outcome, type ReplayOptions, type ReplayResult } from '../mission/replay';
import { SAMPLE_MISSIONS } from '../mission/samples';
import { CAMPAIGN } from '../mission/campaign';
import type { EventKind, TrajectoryEvent } from '../mission/events';
import { PHYSICS_MODEL, worldFromBodyData, type MissionWorld } from '../mission/world';
import type { BodyData } from './physics';
import { EARTH_ROTATION, bodyToIcrf as earthModelToIcrf, spinRate as earthSpinRate } from '../mission/earth-orientation';

/** Earth body-fixed -> ICRF at TDB t with the launch code's own rotation model (UT1-based); returns the spin rate, rad/s. */
export function earthOrientation(t: number, out: Float64Array): number {
  earthModelToIcrf(EARTH_ROTATION, t, out);
  return earthSpinRate(EARTH_ROTATION);
}

export {
  allowedSites, briefingText, missionForSite, siteOption,
  CAMPAIGN, DEFAULT_ASCENT_TIME_S, LAUNCH_SITES, LIMITS, PAR_SCORE, initialMissionPlan, missionReplayOptions, validatePlanIssues, PHYSICS_MODEL, PLAN_FORMAT, PlanError, SAMPLE_MISSIONS,
  asymptotePlaneNormals, azimuthAllowed, azimuthForInclination, checkPlanConformance, stellarDay, decodePlan, encodePlan, evaluate, geocentricLatitudeDeg, groundRelativeAzimuthDeg,
  launchFromParams, launchPlane, launchSite, launchToParams, makePlan, orbitNormalOf, planeCrossings, replay, simulationStartOffset, validatePlan, isVehicleLaunch, vehicleStages,
};
export type {
  BriefingDistance, BurnReport, CompleteMission, ConformanceIssue, LaunchInsertion, LeaderboardKeys, Engine, Evaluation, EventKind, MissionDefinition, MissionPlan, MissionWorld, Objective, ObjectiveResult, Outcome,
  AscentResult, PlanBurn, PlanFrame, PlanSeparation, PlanStart, ReplayOptions, ReplayResult, SiteOption, Spacecraft, TrajectoryEvent,
};
export type { LaunchSite } from '../mission/launch';

const ascentCache = new Map<string, AscentResult | null>();
/**
 * The ascent a vehicle-launch plan flies (the replay's own model and inputs),
 * or null for any other start; memoised on its inputs (about 1 ms each).
 */
export function planAscent(plan: MissionPlan, data: readonly BodyData[]): AscentResult | null {
  const st = plan.start;
  if (!isVehicleLaunch(st)) return null;
  const stages = vehicleStages(plan);
  const key = JSON.stringify([st.site, st.params[0], st.params[1], st.params[2], stages]);
  let a = ascentCache.get(key);
  if (a === undefined) {
    const earth = data.find((b) => b.id === 'earth');
    a = earth ? computeAscent(stages, { gm: earth.gm, radius: earth.referenceRadius, altitudeM: st.params[2] }, launchGeometry(launchSite(st.site), st.params[0], st.params[1]), ASCENT_BODIES.earth) : null;
    if (ascentCache.size > 64) ascentCache.clear();
    ascentCache.set(key, a);
  }
  return a;
}

/** Mission world over a physics ephemeris built from `data`. */
export function makeWorld(ephemeris: Parameters<typeof worldFromBodyData>[0], data: readonly BodyData[]): MissionWorld {
  return worldFromBodyData(ephemeris, data);
}

/** Sample layout: t, x, y, z, vx, vy, vz, mass (ICRF barycentric, s, m, m/s, kg). */
export const REPLAY_SAMPLE_STRIDE = 8;

function push(out: number[], last: { t: number }, t: number, y: ArrayLike<number>): void {
  if (!(t > last.t)) return;
  last.t = t;
  out.push(t, y[0], y[1], y[2], y[3], y[4], y[5], y[6]);
}

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
  const out: number[] = [];
  const tmp = new Float64Array(7);
  const last = { t: -Infinity };
  const t0 = performance.now();
  const result = replay(plan, world, {
    ...opts,
    shouldStop: cancel,
    onStart: (t, y) => push(out, last, t, y),
    onStep: (t, tPrev, interp) => {
      for (let i = 1; i <= perStep; i++) {
        const ti = i === perStep ? t : tPrev + ((t - tPrev) * i) / perStep;
        interp(ti, tmp);
        push(out, last, ti, tmp);
      }
    },
  });
  const cancelled = result.outcome === 'aborted';
  // Drop samples past the end of the flight (the step containing a terminal event).
  const end = result.finalT;
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
export function evaluateMission(mission: MissionDefinition | null, result: ReplayResult, world: MissionWorld, epoch: number, plan?: MissionPlan): Evaluation | null {
  return mission ? evaluate(mission, result, world, epoch, plan) : null;
}

/**
 * Validation errors grouped by the burn they belong to (validatePlanIssues'
 * `burn` field); anything else is a plan-level error.
 */
export function planErrors(plan: MissionPlan): { plan: string[]; burns: Map<number, string[]> } {
  const out = { plan: [] as string[], burns: new Map<number, string[]>() };
  for (const e of validatePlanIssues(plan)) {
    if (e.burn !== undefined) out.burns.set(e.burn, [...(out.burns.get(e.burn) ?? []), e.message]);
    else out.plan.push(e.message);
  }
  return out;
}
