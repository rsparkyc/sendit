/**
 * Real plans for tests and the benchmark, built with the mission layer's
 * launch helpers against the real ephemeris: a lunar free return (the
 * author's solution from src/app/missions.test.ts, rebuilt here as plain
 * burns) and worst-case plans at the plan layer's limits.
 */
import { ChebyshevEphemeris } from '../../src/physics/chebyshev-ephemeris';
import { installCheckpointAsset } from '../../src/physics/checkpoint-asset';
import { J2000_BODIES } from '../../src/physics/solar-system';
import { DEFAULT_ASCENT_TIME_S, launchSite, launchToParams, orbitNormalOf, planeCrossings } from '../../src/mission/launch';
import { encodePlan, LIMITS, makePlan, type MissionPlan, type PlanBurn } from '../../src/mission/plan';

const DAY = 86400;
/** 2027-01-10 12:00 UTC as TDB s from J2000 (TT - UTC = 69.184 s; as src/mission/campaign.ts utcTdb). */
export const JAN_2027 = (Date.UTC(2027, 0, 10, 12) - Date.UTC(2000, 0, 1, 12)) / 1000 + 69.184;
export const TLI_STAGE = { wetMass: 30000, dryMass: 12000, engines: [{ thrust: 200e3, isp: 450 }] };

export interface Fixtures {
  /** Lunar free return: one trans-lunar burn, flyby, reentry. Duration 10 days. */
  freeReturn(fingerprint: string, opts?: { burnStart?: number; duration?: number }): MissionPlan;
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
      const l = lunarLaunch();
      return makePlan({
        data: fingerprint,
        epoch: l.t,
        duration: opts.duration ?? 10 * DAY,
        rtol: 1e-10,
        start: launchStart(l.t, l.az),
        spacecraft: TLI_STAGE,
        burns: [{ start: opts.burnStart ?? 2900, duration: 339, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }],
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
