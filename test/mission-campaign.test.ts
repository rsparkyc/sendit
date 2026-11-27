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
import { briefingText, checkPlanConformance, deltaVKey, evaluate, initialMissionPlan, missionForSite, missionReplayOptions, PAR_SCORE, timeKey, vehicleLaunch, type CompleteMission } from '../src/mission/objectives';
import { decodePlan, encodePlan, isVehicleLaunch, makePlan, validatePlan } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { SAMPLE_MISSIONS } from '../src/mission/samples';
import { PARKING_BAND, VEHICLES } from '../src/mission/vehicles';
import { defaultSite, flightMargin, solutionPlan, SOLUTIONS } from './helpers/campaign-solutions';
import { realWorld, SLOW } from './helpers/real-world';

const { world } = realWorld();
const DAY = 86400;
const solution = (m: CompleteMission) => solutionPlan(m, defaultSite(m), world.fingerprint);

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
      // Every mission launches on a catalogue vehicle (bit for bit) inside the campaign's parking band; no free delivery.
      expect(m.rules.launch, m.id).toBeUndefined();
      const V = m.rules.vehicle!;
      expect(VEHICLES.some((v) => JSON.stringify(v.stages) === JSON.stringify(V.lowerStages)), m.id).toBe(true);
      expect(V).toEqual(vehicleLaunch(V.lowerStages, PARKING_BAND));
      expect(Object.keys(SOLUTIONS[m.id] ?? {})).toContain(defaultSite(m));
      const p = initialMissionPlan(m, world.fingerprint);
      expect(isVehicleLaunch(p.start)).toBe(true);
      expect(p.lowerStages).toEqual(V.lowerStages);
      expect(validatePlan(p)).toEqual([]);
      expect(checkPlanConformance(m, p)).toEqual([]);
      // The default plan's vehicle reaches orbit (replay starts with the ascent).
      const r = replay({ ...p, duration: 3600 }, world, missionReplayOptions(m));
      expect(r.outcome, `${m.id}: ${r.reason}`).toBe('completed');
      expect(r.ascent!.upperStage).toBe(V.lowerStages.length - 1);
    }
    for (const s of SAMPLE_MISSIONS) expect(CAMPAIGN).toContain(s);
  });

  it('conformance rejects a different spacecraft, site, window or duration, with structured reasons', () => {
    const m = CAMPAIGN.find((x) => x.id === 'lunar-flyby')!;
    const p = solution(m);
    expect(checkPlanConformance(m, p)).toEqual([]);
    const isp = checkPlanConformance(m, { ...p, spacecraft: { ...p.spacecraft, engines: [{ thrust: 10e3, isp: 320.0000001 }] } });
    expect(isp.map((i) => [i.code, i.path])).toEqual([['spacecraft', 'spacecraft.engines[0].isp']]);
    const st = p.start.kind === 'launch' ? p.start : null;
    expect(checkPlanConformance(m, { ...p, start: { ...st!, site: 'nowhere' } }).map((i) => i.code)).toEqual(['launch-site']);
    const late = p.epoch + 90 * DAY;
    expect(checkPlanConformance(m, { ...p, epoch: late, start: { ...st!, params: [late, ...st!.params.slice(1)] } }).map((i) => i.code)).toEqual(['launch-window']);
    expect(checkPlanConformance(m, { ...p, duration: 8 * DAY }).map((i) => i.code)).toEqual(['duration']);
    expect(checkPlanConformance(m, { ...p, start: { kind: 'state', center: 'earth', state: [7e6, 0, 0, 0, 7.5e3, 0] } }).map((i) => i.code)).toEqual(['start-kind']);
    // The vehicle and the ascent time, downrange and circularisation are fixed (rules.vehicle); the parking altitude may be anywhere in the band.
    const launchWith = (i: number, v: number) => { const q = st!.params.slice(); q[i] = v; return { ...p, start: { ...st!, params: q } }; };
    expect(checkPlanConformance(m, launchWith(2, 1000e3))).toEqual([]);
    expect(checkPlanConformance(m, launchWith(2, 180e3))).toEqual([]);
    expect(checkPlanConformance(m, launchWith(2, 1000.001e3)).map((i) => [i.code, i.path])).toEqual([['launch-altitude', 'start.params[2]']]);
    expect(checkPlanConformance(m, launchWith(2, 179.999e3)).map((i) => i.code)).toEqual(['launch-altitude']);
    const lower = p.lowerStages!;
    expect(checkPlanConformance(m, { ...p, lowerStages: [lower[0], { ...lower[1], wetMass: lower[1].wetMass + 1e-9 }] }).map((i) => [i.code, i.path])).toEqual([['vehicle', 'lowerStages[1]']]);
    expect(checkPlanConformance(m, { ...p, lowerStages: lower.slice(0, 1) }).map((i) => i.code)).toEqual(['vehicle']);
    expect(checkPlanConformance(m, launchWith(3, 480)).map((i) => [i.code, i.path])).toEqual([['launch-ascent', 'start.params[3]']]);
    expect(checkPlanConformance(m, launchWith(4, 20)).map((i) => [i.code, i.path])).toEqual([['launch-ascent', 'start.params[4]']]);
    expect(checkPlanConformance(m, launchWith(5, 1)).map((i) => [i.code, i.path])).toEqual([['launch-ascent', 'start.params[5]']]);
    // Absent trailing parameters mean the defaults, which the rule fixes.
    expect(checkPlanConformance(m, { ...p, start: { ...st!, params: st!.params.slice(0, 3) } })).toEqual([]);
    // A non-conforming plan fails evaluation when the plan is given.
    const r = replay(p, world, missionReplayOptions(m));
    const bad = { ...p, spacecraft: { ...p.spacecraft, wetMass: 6600 } };
    expect(evaluate(m, r, world, p.epoch, p).success).toBe(true);
    expect(evaluate(m, r, world, p.epoch, bad).success).toBe(false);
  });

  it('refuses a plan made for the previous version (free delivery to the parking orbit) with a clear reason', () => {
    const m = CAMPAIGN.find((x) => x.id === 'lunar-flyby')!;
    const p = solution(m);
    const st = p.start.kind === 'launch' ? p.start : null;
    // The previous version's plan: the same launch and spacecraft as a format-1 free delivery.
    const old = makePlan({ data: p.data, epoch: p.epoch, duration: p.duration, rtol: p.rtol, start: { kind: 'launch', site: st!.site, params: st!.params }, spacecraft: m.spacecraft, burns: [] });
    expect(old.format).toBe(1);
    const issues = checkPlanConformance(m, old);
    expect(issues.map((i) => i.code)).toEqual(['start-kind']);
    expect(issues[0].message).toMatch(/earlier version of the mission.*free of charge.*launches on its vehicle/);
  });

  it('each mission opens at, and scores against, its best reference site (plane-change: the Cape, its subject)', () => {
    for (const m of CAMPAIGN) {
      const site = defaultSite(m);
      const own = m.launchSites!.find((o) => o.site === site);
      expect(own?.offered && m.scoring.deltaVRef === own.deltaV, m.id).toBe(true);
      const best = Math.min(...m.launchSites!.flatMap((o) => (o.offered ? [o.deltaV] : [])));
      if (m.id === 'plane-change') expect(site).toBe('cape-canaveral');
      else expect(m.scoring.deltaVRef, m.id).toBe(best);
    }
  });

  it('scores total delta-v: the ascent plus the flight', () => {
    const m = CAMPAIGN.find((x) => x.id === 'lunar-flyby')!;
    const p = solution(m);
    const r = replay(p, world, missionReplayOptions(m));
    const ev = evaluate(m, r, world, p.epoch, p);
    expect(r.ascent).toBeDefined();
    expect(ev.ascentDeltaV).toBe(r.ascent!.deltaV);
    expect(ev.flightDeltaV).toBe(r.deltaV);
    expect(ev.deltaV).toBe(r.totalDeltaV);
    expect(ev.deltaV).toBe(r.ascent!.deltaV + r.deltaV);
    expect(ev.keys!.deltaV).toBe(Math.ceil(r.totalDeltaV * 10));
  });
});

describe('campaign solutions (par)', () => {
  for (const m of CAMPAIGN) {
    it.skipIf(SLOW_IDS.has(m.id) && !SLOW)(`${m.id}: solvable within the limits, with margin; the reference scores exactly 10,000`, { timeout: 300_000 }, () => {
      const plan = decodePlan(encodePlan(solution(m)));
      expect(plan.format).toBe(2);
      const r = replay(plan, world, missionReplayOptions(m));
      const ev = evaluate(m, r, world, plan.epoch, plan);
      const site = defaultSite(m);
      const detail = `${m.id}: ${r.outcome} ${r.reason}; ` + ev.objectives.map((o) => `${o.ok ? 'ok' : 'NO'} ${o.objective.kind}: ${o.detail}`).join('; ');
      expect(ev.success, detail).toBe(true);
      expect(ev.ruleViolations).toEqual([]);
      // Par is this flight, stored in the leaderboard's quantised units (delta-v up to 0.1 m/s, time up to
      // the second), so flying the reference scores exactly PAR_SCORE.
      expect(ev.keys).toBeDefined();
      expect(m.scoring.deltaVRef).toBe(ev.keys!.deltaV / 10);
      expect(m.scoring.timeRef).toBe(ev.keys!.time);
      expect(ev.keys!.deltaV).toBe(deltaVKey(ev.deltaV));
      expect(ev.keys!.time).toBe(timeKey(ev.missionTime));
      expect(ev.score).toBe(PAR_SCORE);
      // The default site's limits leave a margin over the solution: 8% of the flight's delta-v on top of the ascent and flight
      // (the samples keep their original ratios), 15-25% time.
      expect(ev.site).toBe(site);
      const ms = missionForSite(m, site);
      const dvMargin = flightMargin(limit(ms, 'max-delta-v'), ev.deltaV, ev.ascentDeltaV);
      expect(ms.launchSites!.find((o) => o.site === site)).toMatchObject({ ascentDeltaV: Math.round(ev.ascentDeltaV * 10) / 10 });
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
