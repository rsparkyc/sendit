/**
 * Achievability of every campaign mission from every launch site: each
 * (mission, site) pair solved from scratch on the mission's launch vehicle
 * with the solvers of test/helpers/campaign-solvers.ts (porkchop, flyby chain
 * search, departure builder, differential corrector, the ascent model's
 * parking-altitude choice, tuning on the replay), then flown as a player's
 * plan. It prints each solution (SITE_SOLUTION <mission> <json>); those are
 * the literals in test/mission-campaign-sites.test.ts and, for the default
 * site, in test/mission-campaign.test.ts; their delta-v (ascent + flight)
 * and time are the per-site reference values in campaign-sites.ts.
 *
 * Slow (tens of minutes; outer-planet flights take years of replay) and its
 * numbers depend on Math.* in the planning code, so it runs only with SLOW=1:
 *   SLOW=1 pnpm vitest run test/mission-campaign-sites-solve.test.ts
 * ONLY=<mission-id,...> and SITES=<id,id> narrow it.
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGN } from '../src/mission/campaign';
import { LAUNCH_SITES } from '../src/mission/launch';
import { describeRun } from './helpers/campaign-solver';
import { SOLVERS, solutionLiteral } from './helpers/campaign-solvers';
import { ENV, SLOW } from './helpers/real-world';

const ONLY = ENV.ONLY;
const SITES = ENV.SITES ? ENV.SITES.split(',') : LAUNCH_SITES.map((s) => s.id);

describe.skipIf(!SLOW)('campaign missions from every launch site', { timeout: 6 * 3_600_000 }, () => {
  for (const m of CAMPAIGN) {
    if (ONLY && !ONLY.split(',').includes(m.id)) continue;
    it(m.id, () => {
      const out: Record<string, unknown> = {};
      for (const site of SITES) {
        if (!m.launchSites!.find((o) => o.site === site)?.offered) continue;
        try {
          const s = solutionLiteral(m, SOLVERS[m.id](site));
          console.log(`${site}: ${describeRun(m, s.x)}`);
          out[site] = s.ok ? { ...s.lit, dv: s.dv, ascent: s.ascent, flight: s.flight, time: s.time } : { failed: describeRun(m, s.x), ...s.lit };
        } catch (e) {
          console.log(`${m.id} @ ${site}: ${(e as Error).stack}`);
          out[site] = { failed: (e as Error).message };
        }
      }
      console.log(`SITE_SOLUTION ${m.id} ${JSON.stringify(out)}`);
      expect(Object.values(out).every((x) => !(x as { failed?: string }).failed)).toBe(true);
    });
  }
});
