/**
 * Real plans for tests and the benchmark, built with the mission layer's
 * launch helpers against the real ephemeris: a lunar free return (the
 * campaign's reference solution from Kourou, test/fixtures/campaign-solutions.json:
 * a vehicle launch on the mission's Falcon 9, one upper-stage burn), the
 * same mission's previous-version plan (a free delivery to the parking orbit,
 * format 1), and worst-case plans at the plan layer's limits (spacecraft-only
 * and staged).
 */
import { ChebyshevEphemeris } from '../../src/physics/chebyshev-ephemeris';
import { installCheckpointAsset } from '../../src/physics/checkpoint-asset';
import { J2000_BODIES } from '../../src/physics/solar-system';
import { DEFAULT_ASCENT_TIME_S, launchSite, launchToParams, orbitNormalOf, planeCrossings } from '../../src/mission/launch';
import { encodePlan, LIMITS, makePlan, type MissionPlan, type PlanBurn, type Stage } from '../../src/mission/plan';
import { LUNAR_FREE_RETURN } from '../../src/mission/samples';
import solutions from '../../test/fixtures/campaign-solutions.json';

const DAY = 86400;
/** 2027-01-10 12:00 UTC as TDB s from J2000 (TT - UTC = 69.184 s; as src/mission/campaign.ts utcTdb). */
export const JAN_2027 = (Date.UTC(2027, 0, 10, 12) - Date.UTC(2000, 0, 1, 12)) / 1000 + 69.184;
export const TLI_STAGE = { wetMass: 30000, dryMass: 12000, engines: [{ thrust: 200e3, isp: 450 }] };

interface Solution { params: number[]; duration: number; rtol: number; burns: PlanBurn[]; separations: { time: number }[] }

export interface Fixtures {
  /** Lunar free return (version 4): a vehicle launch from Kourou, one upper-stage trans-lunar burn, flyby, reentry. */
  freeReturn(fingerprint: string, opts?: { burnShift?: number; duration?: number; site?: string }): MissionPlan;
  /** The free return as planned for the mission's version 3: a free delivery to a 200 km parking orbit (format 1), 30 t stage. */
  oldFreeReturn(fingerprint: string): MissionPlan;
  /** A format-2 plan at every staged limit: 6 stages of 8 engines, 5 separations, 200 burns, 40 years, a vehicle launch. */
  largestStaged(fingerprint: string): MissionPlan;
  /** 40 years, 200 small burns, from a LEO launch: the longest plan the plan layer allows. */
  longest(fingerprint: string, escape: boolean): MissionPlan;
}

export function fixtures(checkpoints: Uint8Array): Fixtures {
  const eph = new ChebyshevEphemeris(J2000_BODIES);
  installCheckpointAsset(eph, J2000_BODIES, checkpoints);
  let lunar: { t: number; az: number } | null = null;
  const lunarLaunch = () => {
    if (!lunar) {
      const n = orbitNormalOf(eph, J2000_BODIES, 'moon', JAN_2027 + 4 * DAY);
      const c = planeCrossings(launchSite('kourou'), n, JAN_2027, JAN_2027 + DAY).find((x) => x.azimuthAllowed);
      if (!c) throw new Error('fixtures: no lunar-plane launch window');
      lunar = { t: c.t, az: c.azimuthDeg };
    }
    return lunar;
  };
  const launchStart = (t: number, az: number) => ({
    kind: 'launch' as const,
    site: 'kourou',
    params: launchToParams({ mode: 'parking-orbit', siteId: 'kourou', launchTime: t, azimuthDeg: az, altitudeM: 200e3, ascentTimeS: DEFAULT_ASCENT_TIME_S }),
  });
  return {
    freeReturn(fingerprint, opts = {}) {
      const site = opts.site ?? 'kourou';
      const s = (solutions as unknown as Record<string, Record<string, Solution>>)['lunar-free-return'][site];
      const m = LUNAR_FREE_RETURN;
      const shift = opts.burnShift ?? 0;
      return makePlan({
        data: fingerprint,
        epoch: s.params[0],
        duration: opts.duration ?? s.duration,
        rtol: s.rtol,
        start: { kind: 'launch', site, params: launchToParams({ mode: 'parking-orbit', siteId: site, launchTime: s.params[0], azimuthDeg: s.params[1], altitudeM: s.params[2] }), ascent: 'vehicle' },
        spacecraft: m.spacecraft,
        lowerStages: m.rules.vehicle!.lowerStages,
        burns: s.burns.map((b) => ({ ...b, start: b.start + shift })),
        separations: s.separations,
      });
    },
    largestStaged(fingerprint) {
      const l = lunarLaunch();
      const engines = Array.from({ length: LIMITS.maxEngines }, (_, i) => ({ thrust: 1e5 + i, isp: 300 + i }));
      const stage = (k: number): Stage => ({ wetMass: 1e5 / (k + 1), dryMass: 1e4 / (k + 1), engines });
      const lowerStages = Array.from({ length: LIMITS.maxStages - 1 }, (_, k) => stage(k));
      const duration = LIMITS.maxDuration;
      const separations = Array.from({ length: LIMITS.maxSeparations }, (_, k) => ({ time: 1000 + 1000 * k + 0.123456789 }));
      const burns: PlanBurn[] = [];
      for (let i = 0; i < LIMITS.maxBurns; i++) burns.push({ start: 10 * DAY + (i * (duration - 20 * DAY)) / LIMITS.maxBurns + 0.1, duration: 1.000000001, engine: i % LIMITS.maxEngines, stage: LIMITS.maxStages - 1, direction: [0.1 + i * 1e-3, 0.2, 0.3], frame: { kind: 'orbital', body: 'earth' } });
      return makePlan({ data: fingerprint, epoch: l.t, duration, rtol: 1e-10, start: { ...launchStart(l.t, l.az), ascent: 'vehicle' }, spacecraft: stage(LIMITS.maxStages - 1), lowerStages, burns, separations });
    },
    oldFreeReturn(fingerprint) {
      const l = lunarLaunch();
      return makePlan({
        data: fingerprint,
        epoch: l.t,
        duration: 10 * DAY,
        rtol: 1e-10,
        start: launchStart(l.t, l.az),
        spacecraft: TLI_STAGE,
        burns: [{ start: 2900, duration: 339, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }],
      });
    },
    longest(fingerprint, escape) {
      const l = lunarLaunch();
      const burns: PlanBurn[] = [];
      // First burn: escape (3.8 km/s, most of the propellant) or a tiny trim; then 199 one-second trims spread over 40 years.
      burns.push({ start: 3000, duration: escape ? 420 : 1, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } });
      const duration = LIMITS.maxDuration;
      for (let i = 1; i < LIMITS.maxBurns; i++) burns.push({ start: 10 * DAY + (i * (duration - 20 * DAY)) / LIMITS.maxBurns, duration: 1, engine: 0, direction: [0, 0, 1], frame: { kind: 'inertial' } });
      return makePlan({ data: fingerprint, epoch: l.t, duration, rtol: 1e-10, start: launchStart(l.t, l.az), spacecraft: TLI_STAGE, burns });
    },
  };
}

export { encodePlan };
