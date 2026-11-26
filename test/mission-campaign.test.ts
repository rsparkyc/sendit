/**
 * The campaign is solvable: the author's solution to every mission, flown as
 * a player's shared plan would be (encode -> decode -> replay with the
 * mission's options -> evaluate with conformance), on the real ephemeris with
 * the shipped checkpoint asset. These plans are the "par" each mission's
 * limits and scoring references were set from (campaign.ts); they live only
 * here, never in the mission definitions. How they were found:
 * test/mission-campaign-solve.test.ts (SLOW=1).
 *
 * The two outer-planet missions fly 2.3 and 6.4 years and build ~25
 * ephemeris chunks (~1 s and ~4 s); they run only with SLOW=1:
 *   SLOW=1 pnpm vitest run test/mission-campaign.test.ts
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGN } from '../src/mission/campaign';
import { launchToParams } from '../src/mission/launch';
import { checkPlanConformance, evaluate, initialMissionPlan, missionForSite, missionReplayOptions, PAR_SCORE, type CompleteMission } from '../src/mission/objectives';
import { decodePlan, encodePlan, makePlan, validatePlan, type MissionPlan, type PlanBurn } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { SAMPLE_MISSIONS } from '../src/mission/samples';
import { realWorld, SLOW } from './helpers/real-world';

const { world } = realWorld();
const DAY = 86400;

interface Solution { site: string; params: number[]; duration: number; rtol: number; burns: PlanBurn[] }

/** Author's solutions: launch [liftoff, azimuth, altitude], duration, burns. */
const SOLUTIONS: Record<string, Solution> = {
  'plane-change': { site: 'cape-canaveral', params: [852854469.184, 35, 400000], duration: 34560, rtol: 1e-10, burns: [{"start": 5288.115416441123, "duration": 155.02494805304153, "engine": 0, "direction": [-2.6951073605951024, 723.2208367669274, 0.9765475241819237], "frame": {"kind": "orbital", "body": "earth"}}] },
  'geo-from-leo': { site: 'kourou', params: [852854469.184, 90, 250000], duration: 348975.2717319727, rtol: 1e-10, burns: [{"start": 1442.4306913912678, "duration": 432.34685772649755, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 20572.149141751735, "duration": 166.24518044191677, "engine": 0, "direction": [1467.7194847994383, -208.65039723667766, -1.621285090784651], "frame": {"kind": "orbital", "body": "earth"}}] },
  'earth-escape': { site: 'cape-canaveral', params: [852854469.184, 90, 300000], duration: 110023.5866316557, rtol: 1e-10, burns: [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8555.97233068943, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22867.464287808165, "duration": 862.2446876950562, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}] },
  'lunar-flyby': { site: 'kourou', params: [852884584.4450974, 62.76528525062618, 200000], duration: 259200, rtol: 1e-10, burns: [{"start": 2850, "duration": 339, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}] },
  'lunar-free-return': { site: 'kourou', params: [852884584.4450974, 62.76528525062618, 200000], duration: 1036800, rtol: 1e-10, burns: [{"start": 2900, "duration": 339, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}] },
  'lunar-orbit': { site: 'kourou', params: [852884584.4450974, 62.76528525062618, 200000], duration: 320498.0465422869, rtol: 1e-10, burns: [{"start": 2487.6375266681243, "duration": 1010.5161090370441, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 190816.17603910342, "duration": 163.74100636690855, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}] },
  'venus-flyby': { site: 'cape-canaveral', params: [890840062.1845732, 115.59064869423229, 200000], duration: 14987942.327614307, rtol: 1e-11, burns: [{"start": 39645.53253567219, "duration": 414.5840306026615, "engine": 0, "direction": [0.997758112249735, -0.06689393630462757, 0.0019876432068603083], "frame": {"kind": "orbital", "body": "earth"}}] },
  'mars-flyby': { site: 'cape-canaveral', params: [912395285.8704681, 98.33353319677121, 200000], duration: 27420647.920319796, rtol: 1e-11, burns: [{"start": 29122.82218647003, "duration": 836.8569198032994, "engine": 0, "direction": [0.9959110775487174, -0.08543887958197946, -0.02934831292474375], "frame": {"kind": "orbital", "body": "earth"}}] },
  'mars-orbit': { site: 'cape-canaveral', params: [911877107.6734085, 98.33353355838719, 200000], duration: 26205046.27172017, rtol: 1e-11, burns: [{"start": 29349.98455452919, "duration": 498.4247354801031, "engine": 0, "direction": [0.996360157819068, -0.08519078751458348, 0.0029942667561533316], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 23354039.214413166, "duration": 0.0460591896015376, "engine": 0, "direction": [0.05043451318898782, -0.8746604747303153, 0.4821051895841087], "frame": {"kind": "inertial"}}, {"start": 25945800.333285563, "duration": 91.87686921373714, "engine": 0, "direction": [-1206.3471120209917, -1.4725933397130575e-06, 0.00108906720474522], "frame": {"kind": "orbital", "body": "mars"}}] },
  'venus-to-mercury': { site: 'cape-canaveral', params: [1003951000.8039117, 98.33348354724285, 200000], duration: 29051650.545744896, rtol: 1e-11, burns: [{"start": 60043.52968323231, "duration": 606.2359501284358, "engine": 0, "direction": [0.9937729340496511, -0.11140919688038373, -0.0018293170352409285], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 14018057.04647863, "duration": 1.836724894432852, "engine": 0, "direction": [-0.23850169630572365, -0.05952917860069426, 0.96931585035757], "frame": {"kind": "inertial"}}] },
  'solar-escape': { site: 'cape-canaveral', params: [983014827.6357384, 106.50646501915736, 200000], duration: 71779225.70678258, rtol: 1e-11, burns: [{"start": 64353.82576227188, "duration": 769.2871038834237, "engine": 0, "direction": [0.9973781721674514, -0.07236482846343163, -0.00033657892398581633], "frame": {"kind": "orbital", "body": "earth"}}] },
  'jupiter-saturn': { site: 'cape-canaveral', params: [1088231208.3711262, 98.33351402759972, 200000], duration: 202015311.10000396, rtol: 1e-11, burns: [{"start": 33905.369763851166, "duration": 770.0905339441118, "engine": 0, "direction": [0.997068516938881, -0.07598938711687624, -0.008943465486162634], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101727684.9929812, "duration": 3.3541407110276515, "engine": 0, "direction": [0.02745670398463944, 0.782206990187156, 0.6224133304393876], "frame": {"kind": "inertial"}}] },
};

function solutionPlan(m: CompleteMission): MissionPlan {
  const s = SOLUTIONS[m.id];
  return makePlan({
    data: world.fingerprint, epoch: s.params[0], duration: s.duration, rtol: s.rtol,
    start: { kind: 'launch', site: s.site, params: launchToParams({ mode: 'parking-orbit', siteId: s.site, launchTime: s.params[0], azimuthDeg: s.params[1], altitudeM: s.params[2] }) },
    spacecraft: m.spacecraft, burns: s.burns,
  });
}

const limit = (m: CompleteMission, kind: 'max-delta-v' | 'max-time') => (m.objectives.find((o) => o.kind === kind) as { max: number }).max;
const SLOW_IDS = new Set(['solar-escape', 'jupiter-saturn']);
const SAMPLE_IDS = new Set(SAMPLE_MISSIONS.map((m) => m.id));

describe('campaign definitions', () => {
  it('are complete, unique, serialisable, and start with a valid default plan', () => {
    expect(new Set(CAMPAIGN.map((m) => m.id)).size).toBe(CAMPAIGN.length);
    for (const m of CAMPAIGN) {
      expect(JSON.parse(JSON.stringify(m))).toEqual(m);
      expect(m.briefing.length).toBeGreaterThan(40);
      expect(Object.keys(SOLUTIONS)).toContain(m.id);
      const p = initialMissionPlan(m, world.fingerprint);
      expect(validatePlan(p)).toEqual([]);
      expect(checkPlanConformance(m, p)).toEqual([]);
    }
    for (const s of SAMPLE_MISSIONS) expect(CAMPAIGN).toContain(s);
  });

  it('conformance rejects a different spacecraft, site, window or duration, with structured reasons', () => {
    const m = CAMPAIGN.find((x) => x.id === 'lunar-flyby')!;
    const p = solutionPlan(m);
    expect(checkPlanConformance(m, p)).toEqual([]);
    const isp = checkPlanConformance(m, { ...p, spacecraft: { ...p.spacecraft, engines: [{ thrust: 200e3, isp: 450.0000001 }] } });
    expect(isp.map((i) => [i.code, i.path])).toEqual([['spacecraft', 'spacecraft.engines[0].isp']]);
    const st = p.start.kind === 'launch' ? p.start : null;
    expect(checkPlanConformance(m, { ...p, start: { ...st!, site: 'nowhere' } }).map((i) => i.code)).toEqual(['launch-site']);
    const late = p.epoch + 90 * DAY;
    expect(checkPlanConformance(m, { ...p, epoch: late, start: { ...st!, params: [late, ...st!.params.slice(1)] } }).map((i) => i.code)).toEqual(['launch-window']);
    expect(checkPlanConformance(m, { ...p, duration: 8 * DAY }).map((i) => i.code)).toEqual(['duration']);
    expect(checkPlanConformance(m, { ...p, start: { kind: 'state', center: 'earth', state: [7e6, 0, 0, 0, 7.5e3, 0] } }).map((i) => i.code)).toEqual(['start-kind']);
    // A non-conforming plan fails evaluation when the plan is given.
    const r = replay(p, world, missionReplayOptions(m));
    const bad = { ...p, spacecraft: { ...p.spacecraft, wetMass: 31000 } };
    expect(evaluate(m, r, world, p.epoch, p).success).toBe(true);
    expect(evaluate(m, r, world, p.epoch, bad).success).toBe(false);
  });
});

describe('campaign solutions (par)', () => {
  for (const m of CAMPAIGN) {
    it.skipIf(SLOW_IDS.has(m.id) && !SLOW)(`${m.id}: solvable within the limits, with margin`, { timeout: 300_000 }, () => {
      const plan = decodePlan(encodePlan(solutionPlan(m)));
      const r = replay(plan, world, missionReplayOptions(m));
      const ev = evaluate(m, r, world, plan.epoch, plan);
      const s = SOLUTIONS[m.id];
      const detail = `${m.id}: ${r.outcome} ${r.reason}; ` + ev.objectives.map((o) => `${o.ok ? 'ok' : 'NO'} ${o.objective.kind}: ${o.detail}`).join('; ');
      expect(ev.success, detail).toBe(true);
      expect(ev.ruleViolations).toEqual([]);
      // Par is what the scoring references were set from.
      expect(Math.abs(ev.deltaV - m.scoring.deltaVRef)).toBeLessThan(0.1);
      expect(Math.abs(ev.missionTime - m.scoring.timeRef)).toBeLessThan(1);
      expect(Math.abs(ev.score - PAR_SCORE)).toBeLessThanOrEqual(30);
      expect(ev.keys).toBeDefined();
      // The default site's limits leave a margin over the solution: 8% delta-v (samples keep their original limits), 15-25% time.
      expect(ev.site).toBe(s.site);
      const ms = missionForSite(m, s.site);
      const dvMargin = limit(ms, 'max-delta-v') / ev.deltaV - 1;
      const tMargin = limit(ms, 'max-time') / ev.missionTime - 1;
      if (!SAMPLE_IDS.has(m.id)) {
        expect(dvMargin).toBeGreaterThanOrEqual(0.08);
        expect(dvMargin).toBeLessThan(0.1);
        expect(tMargin).toBeGreaterThanOrEqual(0.15);
        expect(tMargin).toBeLessThan(0.3);
      } else expect(dvMargin).toBeGreaterThan(0.04);
    });
  }
});
