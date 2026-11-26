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
import { briefingText, checkPlanConformance, evaluate, fixedLaunch, initialMissionPlan, missionForSite, missionReplayOptions, PAR_SCORE, type CompleteMission } from '../src/mission/objectives';
import { decodePlan, encodePlan, makePlan, validatePlan, type MissionPlan, type PlanBurn } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { SAMPLE_MISSIONS } from '../src/mission/samples';
import { realWorld, SLOW } from './helpers/real-world';

const { world } = realWorld();
const DAY = 86400;

interface Solution { site: string; params: number[]; duration: number; rtol: number; burns: PlanBurn[] }

/** Author's solutions: launch [liftoff, azimuth, altitude], duration, burns. */
const SOLUTIONS: Record<string, Solution> = {
  'plane-change': { site: 'cape-canaveral', params: [852854469.184, 35, 400000], duration: 34560, rtol: 1e-10, burns: [{"start": 5291.236461103265, "duration": 154.26983034550133, "engine": 0, "direction": [-2.6367631349206135, 719.2615549329524, 1.0902148815260397], "frame": {"kind": "orbital", "body": "earth"}}] },
  'geo-from-leo': { site: 'kourou', params: [852854469.184, 90, 250000], duration: 348995.6426885128, rtol: 1e-10, burns: [{"start": 1462.805705517536, "duration": 432.3469768166433, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 20592.54211093124, "duration": 166.20115516312202, "engine": 0, "direction": [1467.715665002644, -205.3391377520207, -1.621673268307772], "frame": {"kind": "orbital", "body": "earth"}}] },
  'earth-escape': { site: 'cape-canaveral', params: [852854469.184, 90, 300000], duration: 110023.75783932209, rtol: 1e-10, burns: [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8555.970079660416, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22867.636007701978, "duration": 862.2436632402241, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}] },
  'lunar-flyby': { site: 'kourou', params: [852884584.4447339, 62.76530149471511, 200000], duration: 259200, rtol: 1e-10, burns: [{"start": 2850, "duration": 339, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}] },
  'lunar-free-return': { site: 'kourou', params: [852884584.4447339, 62.76530149471511, 200000], duration: 1036800, rtol: 1e-10, burns: [{"start": 2900, "duration": 339, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}] },
  'lunar-orbit': { site: 'kourou', params: [852884584.4447339, 62.76530149471511, 200000], duration: 320532.9627325535, rtol: 1e-10, burns: [{"start": 2487.670733395383, "duration": 1010.5030882548913, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 190851.1078816522, "duration": 163.70970180258155, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}] },
  'venus-flyby': { site: 'cape-canaveral', params: [890840062.1847124, 115.59064869391409, 200000], duration: 14987941.71748197, rtol: 1e-11, burns: [{"start": 39645.91062438488, "duration": 414.56519635984336, "engine": 0, "direction": [0.997793000745949, -0.06636634306832874, 0.002153176753394641], "frame": {"kind": "orbital", "body": "earth"}}] },
  'mars-flyby': { site: 'cape-canaveral', params: [912395285.8704038, 98.33353319616766, 200000], duration: 27420660.915382862, rtol: 1e-11, burns: [{"start": 29121.882085442543, "duration": 836.8588195757641, "engine": 0, "direction": [0.995840499069841, -0.08563169699996347, -0.031127365472145615], "frame": {"kind": "orbital", "body": "earth"}}] },
  'mars-orbit': { site: 'cape-canaveral', params: [911877107.6735537, 98.33353355818092, 200000], duration: 26205088.1642555, rtol: 1e-11, burns: [{"start": 29350.2458050251, "duration": 498.42636635986827, "engine": 0, "direction": [0.9963637101576821, -0.085144591044769, 0.0031234110580512678], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 23354071.738629222, "duration": 0.04624312451252374, "engine": 0, "direction": [0.05831823440062752, -0.8734871201583002, 0.48334173671839337], "frame": {"kind": "inertial"}}, {"start": 25945842.20476124, "duration": 91.91898851672316, "engine": 0, "direction": [-1206.98971867271, -1.282612458908261e-06, 0.0008823944544786855], "frame": {"kind": "orbital", "body": "mars"}}] },
  'venus-to-mercury': { site: 'cape-canaveral', params: [1003951004.651995, 98.33348557120263, 200000], duration: 29050278.472743273, rtol: 1e-11, burns: [{"start": 54738.90947651863, "duration": 605.9487149878498, "engine": 0, "direction": [0.9947016526339251, -0.10279613466354294, -0.001255764935434797], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 14014872.777718782, "duration": 1.5528686013103858, "engine": 0, "direction": [-0.31006779708622084, 0.015999002616781537, 0.9505798194393601], "frame": {"kind": "inertial"}}] },
  'solar-escape': { site: 'cape-canaveral', params: [983014827.6357238, 106.50646501903154, 200000], duration: 71779225.80792737, rtol: 1e-11, burns: [{"start": 64355.26319694519, "duration": 769.3131331941471, "engine": 0, "direction": [0.9973475793164264, -0.07278570712869428, -0.00021649351221483866], "frame": {"kind": "orbital", "body": "earth"}}] },
  'jupiter-saturn': { site: 'cape-canaveral', params: [1088231143.0424323, 98.33351577985455, 200000], duration: 201926361.47240925, rtol: 1e-11, burns: [{"start": 81665.15814590454, "duration": 772.3314992341882, "engine": 0, "direction": [0.9900593127718775, -0.1405908552188489, -0.0040949508556638705], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101448415.43738604, "duration": 3.5721106701163414, "engine": 0, "direction": [-0.01056376956784567, 0.7897253784656056, 0.6133695732426525], "frame": {"kind": "inertial"}}] },
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
      // Every distance in a briefing is structured (the UI states it in the player's convention).
      expect(briefingText(m, () => '<d>'), m.id).not.toMatch(/\{|\d\s?(?:km\b(?!\/s)|million\b)/);
      expect(m.rules.launch, m.id).toEqual(fixedLaunch(m.start.kind === 'launch' ? m.start.altitudeM : NaN));
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
    // The launch is fixed apart from site, liftoff and azimuth (rules.launch): parking altitude, ascent time, downrange, circularisation.
    const launchWith = (i: number, v: number) => { const q = st!.params.slice(); q[i] = v; return { ...p, start: { ...st!, params: q } }; };
    expect(checkPlanConformance(m, launchWith(2, 2000e3)).map((i) => [i.code, i.path])).toEqual([['launch-altitude', 'start.params[2]']]);
    expect(checkPlanConformance(m, launchWith(2, 199e3)).map((i) => i.code)).toEqual(['launch-altitude']);
    expect(checkPlanConformance(m, launchWith(3, 480)).map((i) => [i.code, i.path])).toEqual([['launch-ascent', 'start.params[3]']]);
    expect(checkPlanConformance(m, launchWith(4, 20)).map((i) => [i.code, i.path])).toEqual([['launch-ascent', 'start.params[4]']]);
    expect(checkPlanConformance(m, launchWith(5, 1)).map((i) => [i.code, i.path])).toEqual([['launch-ascent', 'start.params[5]']]);
    // Absent trailing parameters mean the defaults, which the rule fixes.
    expect(checkPlanConformance(m, { ...p, start: { ...st!, params: st!.params.slice(0, 3) } })).toEqual([]);
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
