/**
 * The campaign's reference solutions, one per (mission, offered site), as
 * kept in test/fixtures/campaign-solutions.json (printed by
 * test/mission-campaign-sites-solve.test.ts, SLOW=1). The default site's
 * solution is the mission's par (test/mission-campaign.test.ts); the others
 * are the per-site references (test/mission-campaign-sites.test.ts). They
 * live only under test/, never in the mission definitions.
 */
import { launchToParams } from '../../src/mission/launch';
import type { CompleteMission } from '../../src/mission/objectives';
import { makePlan, type MissionPlan, type PlanBurn, type PlanSeparation } from '../../src/mission/plan';
import data from '../fixtures/campaign-solutions.json';

export interface Solution {
  /** [liftoff TDB s, azimuth deg, parking altitude m]. */
  params: number[];
  duration: number;
  rtol: number;
  burns: PlanBurn[];
  separations: PlanSeparation[];
}

export const SOLUTIONS = data as unknown as Record<string, Record<string, Solution>>;

/** The solution's plan: a vehicle launch on the mission's vehicle. */
export function solutionPlan(m: CompleteMission, site: string, fingerprint: string): MissionPlan {
  const s = SOLUTIONS[m.id]?.[site];
  if (!s) throw new Error(`no solution for ${m.id} from ${site}`);
  return makePlan({
    data: fingerprint, epoch: s.params[0], duration: s.duration, rtol: s.rtol,
    start: { kind: 'launch', site, params: launchToParams({ mode: 'parking-orbit', siteId: site, launchTime: s.params[0], azimuthDeg: s.params[1], altitudeM: s.params[2] }), ascent: 'vehicle' },
    spacecraft: m.spacecraft, lowerStages: m.rules.vehicle!.lowerStages, burns: s.burns, separations: s.separations,
  });
}

/** Default (par) site of a mission. */
export const defaultSite = (m: CompleteMission): string => (m.start.kind === 'launch' ? m.start.site : '');

/**
 * The delta-v margin rule (campaign.ts): the limit leaves `ratio - 1` of the
 * reference's FLIGHT delta-v on top of its whole delta-v (ascent + flight).
 */
export const flightMargin = (limit: number, total: number, ascent: number) => (limit - ascent) / (total - ascent) - 1;
