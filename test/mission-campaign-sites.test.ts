/**
 * Every campaign mission from every launch site it offers: a solution per
 * (mission, site), flown as a player's shared plan would be (encode -> decode
 * -> replay with the mission's options -> evaluate with conformance), on the
 * real ephemeris. These plans are where each site's reference values and
 * limits in src/mission/campaign-sites.ts come from; they live only here.
 * The default site's solution is the mission's par (mission-campaign.test.ts).
 * How they were found: test/mission-campaign-sites-solve.test.ts (SLOW=1).
 *
 * Near-Earth missions run by default; interplanetary ones (months to years of
 * flight each) only with SLOW=1:
 *   SLOW=1 pnpm vitest run test/mission-campaign-sites.test.ts
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGN } from '../src/mission/campaign';
import { CAMPAIGN_SITES } from '../src/mission/campaign-sites';
import { azimuthForInclination, LAUNCH_SITES, launchSite, launchToParams } from '../src/mission/launch';
import { allowedSites, checkPlanConformance, evaluate, missionForSite, missionReplayOptions, type CompleteMission } from '../src/mission/objectives';
import { decodePlan, encodePlan, makePlan } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { defaultSite, flightMargin, solutionPlan, SOLUTIONS } from './helpers/campaign-solutions';
import { realWorld, SLOW } from './helpers/real-world';

const { world } = realWorld();
const sitePlan = (m: CompleteMission, site: string) => solutionPlan(m, site, world.fingerprint);

const limit = (m: { objectives: CompleteMission['objectives'] }, kind: 'max-delta-v' | 'max-time') => (m.objectives.find((o) => o.kind === kind) as { max: number }).max;
const NEAR_EARTH = new Set(['plane-change', 'geo-from-leo', 'earth-escape', 'lunar-flyby', 'lunar-free-return', 'lunar-orbit']);
const SAMPLE_IDS = new Set(['geo-from-leo', 'lunar-flyby', 'lunar-free-return']);

describe('launch-site table', () => {
  it('lists every launch site once per mission; rules, objectives and the default start agree with it', () => {
    for (const m of CAMPAIGN) {
      const opts = m.launchSites!;
      expect(opts.map((o) => o.site), m.id).toEqual(LAUNCH_SITES.map((s) => s.id));
      expect(m.launchSites).toBe(CAMPAIGN_SITES[m.id]);
      const offered = opts.filter((o) => o.offered);
      expect(m.rules.sites, m.id).toEqual(offered.map((o) => o.site));
      expect(allowedSites(m)).toEqual(offered.map((o) => o.site));
      expect(offered.map((o) => o.site)).toContain(defaultSite(m));
      // The objectives carry the loosest offered limits (evaluation without a plan never rejects a site's flight).
      expect(limit(m, 'max-delta-v'), m.id).toBe(Math.max(...offered.map((o) => (o.offered ? o.maxDeltaV : 0))));
      expect(limit(m, 'max-time'), m.id).toBe(Math.max(...offered.map((o) => (o.offered ? o.maxTime : 0))));
      for (const o of offered) {
        if (!o.offered) continue;
        const ms = missionForSite(m, o.site);
        expect(limit(ms, 'max-delta-v')).toBe(o.maxDeltaV);
        expect(limit(ms, 'max-time')).toBe(o.maxTime);
        expect(o.maxTime).toBeLessThanOrEqual(m.maxDuration);
        if (o.site === defaultSite(m)) {
          // The default site's reference is the mission's par.
          expect(o.deltaV).toBe(m.scoring.deltaVRef);
          expect(o.time).toBe(m.scoring.timeRef);
        }
        expect(Object.keys(SOLUTIONS[m.id] ?? {})).toContain(o.site);
      }
      for (const o of opts) if (!o.offered) expect(o.reason.length, `${m.id} ${o.site}`).toBeGreaterThan(20);
    }
  });

  it('plane-change stays at Cape Canaveral: every other site reaches 64-66° directly, the Cape cannot', () => {
    const m = CAMPAIGN.find((x) => x.id === 'plane-change')!;
    for (const s of LAUNCH_SITES) {
      const reach = [64, 65, 66].some((inc) => {
        const a = azimuthForInclination(launchSite(s.id), inc);
        return !!a && (a.northerlyAllowed || a.southerlyAllowed);
      });
      expect(reach, s.id).toBe(s.id !== 'cape-canaveral');
      expect(m.launchSites!.find((o) => o.site === s.id)!.offered).toBe(s.id === 'cape-canaveral');
    }
  });

  it('conformance refuses a site the mission does not offer, with the reason', () => {
    const m = CAMPAIGN.find((x) => x.id === 'plane-change')!;
    const site = 'vandenberg';
    const t = m.epoch;
    const p = makePlan({ data: world.fingerprint, epoch: t, duration: 3600, rtol: 1e-10, start: { kind: 'launch', site, params: launchToParams({ mode: 'parking-orbit', siteId: site, launchTime: t, azimuthDeg: 160, altitudeM: 400e3 }), ascent: 'vehicle' }, spacecraft: m.spacecraft, lowerStages: m.rules.vehicle!.lowerStages, burns: [] });
    const issues = checkPlanConformance(m, p);
    expect(issues.map((i) => [i.code, i.path])).toEqual([['launch-site', 'start.site']]);
    expect(issues[0].message).toMatch(/vandenberg not offered for this mission: .*64-66°.*\(allowed: cape-canaveral\)/);
  });
});

describe('campaign solutions from every offered site', () => {
  for (const m of CAMPAIGN) {
    for (const o of m.launchSites!) {
      if (!o.offered || o.site === defaultSite(m)) continue;
      it.skipIf(!NEAR_EARTH.has(m.id) && !SLOW)(`${m.id} from ${o.site}: solvable within that site's limits`, { timeout: 300_000 }, () => {
        const plan = decodePlan(encodePlan(sitePlan(m, o.site)));
        expect(checkPlanConformance(m, plan)).toEqual([]);
        const r = replay(plan, world, missionReplayOptions(m));
        const ev = evaluate(m, r, world, plan.epoch, plan);
        const detail = `${m.id}@${o.site}: ${r.outcome} ${r.reason}; ` + ev.objectives.map((x) => `${x.ok ? 'ok' : 'NO'} ${x.objective.kind}: ${x.detail}`).join('; ');
        expect(ev.success, detail).toBe(true);
        expect(ev.site).toBe(o.site);
        // The table's reference values are this solution's.
        expect(Math.abs(ev.deltaV - o.deltaV)).toBeLessThan(0.1);
        expect(Math.abs(ev.missionTime - o.time)).toBeLessThan(1);
        expect(Math.abs(ev.ascentDeltaV - o.ascentDeltaV!)).toBeLessThan(0.1);
        // That site's limits leave the same margins as the default site's (delta-v: on the flight's part).
        const dvMargin = flightMargin(o.maxDeltaV, ev.deltaV, ev.ascentDeltaV);
        const tMargin = o.maxTime / ev.missionTime - 1;
        if (SAMPLE_IDS.has(m.id)) expect(dvMargin).toBeGreaterThan(0.04);
        else {
          expect(dvMargin).toBeGreaterThanOrEqual(0.08);
          expect(dvMargin).toBeLessThan(0.1);
          expect(tMargin).toBeGreaterThanOrEqual(0.15);
          expect(tMargin).toBeLessThan(0.3);
        }
        // Scoring is shared by all sites: the same keys formula, against the mission's single par.
        expect(ev.keys).toBeDefined();
      });
    }
  }
});
