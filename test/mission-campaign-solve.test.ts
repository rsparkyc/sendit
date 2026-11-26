/**
 * How the campaign solutions in test/mission-campaign.test.ts (par) were
 * found: each mission solved from scratch on its launch vehicle from its
 * default site with the shared solvers (test/helpers/campaign-solvers.ts; the
 * per-site suite runs the same solvers from every site), then flown as a
 * player's plan. Its numbers depend on Math.* in the planning code, so it
 * runs only with SLOW=1 (`SLOW=1 pnpm vitest run test/mission-campaign-solve.test.ts`);
 * it prints each solution as JSON and checks it succeeds.
 *
 * It also settles the plane-change mission's question under the ascent
 * model: is it cheaper to launch straight to the 400 km orbit and turn the
 * plane there, or to launch lower and climb, turning the plane in the
 * circularisation at apogee? Both are solved and compared.
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGN } from '../src/mission/campaign';
import { ASCENT_BODIES, computeAscent } from '../src/mission/ascent';
import { launchGeometry, launchSite } from '../src/mission/launch';
import { describeRun, stagesOf } from './helpers/campaign-solver';
import { mission, planeChange, SOLVERS, solutionLiteral } from './helpers/campaign-solvers';
import { ENV, SLOW } from './helpers/real-world';

const ONLY = ENV.ONLY;

describe.skipIf(!SLOW)('campaign solutions, derived from scratch', { timeout: 3_600_000 }, () => {
  for (const m of CAMPAIGN) {
    if (ONLY && !ONLY.split(',').includes(m.id)) continue;
    it(m.id, () => {
      const site = m.start.kind === 'launch' ? m.start.site : '';
      const s = solutionLiteral(m, SOLVERS[m.id](site));
      console.log(describeRun(m, s.x));
      console.log(`SOLUTION ${m.id} ${JSON.stringify({ site, ...s.lit, dv: s.dv, ascent: s.ascent, flight: s.flight, time: s.time })}`);
      expect(s.ok).toBe(true);
    });
  }

  it('plane change: launching steep is cheap, turning in orbit is dear; direct to 400 km vs climbing from 180 km', () => {
    const m = mission('plane-change');
    // Ascent price of inclination at the Cape: the corridor edge (35°, ~59.7°) against 55° (~44°), at 400 km.
    const geo = (az: number) => computeAscent(stagesOf(m), { gm: 3.986004418e14, radius: 6378136.6, altitudeM: 400e3 }, launchGeometry(launchSite('cape-canaveral'), m.epoch, az), ASCENT_BODIES.earth);
    const a35 = geo(35);
    const a55 = geo(55);
    if (!a35.ok || !a55.ok) throw new Error('ascent');
    const perDegAscent = (a35.deltaV - a55.deltaV) / (59.7 - 43.9);
    const perDegOrbit = 2 * 7669 * Math.sin((0.5 * Math.PI) / 180);
    console.log(`PLANE ascent ${perDegAscent.toFixed(1)} m/s per degree of inclination vs in-orbit ${perDegOrbit.toFixed(1)} m/s per degree`);
    expect(perDegAscent * 5).toBeLessThan(perDegOrbit);
    const direct = solutionLiteral(m, planeChange('cape-canaveral', 400e3));
    const climb = solutionLiteral(m, planeChange('cape-canaveral', 180e3));
    console.log(`PLANE direct 400 km: ${describeRun(m, direct.x)}`);
    console.log(`PLANE from 180 km: ${describeRun(m, climb.x)}`);
    expect(climb.ok).toBe(true);
    // The limits leave no room for doing the turn in orbit at 400 km: the direct launch breaks max-delta-v.
    expect(direct.dv).toBeGreaterThan((m.objectives.find((o) => o.kind === 'max-delta-v') as { max: number }).max);
    expect(direct.x.ev.success).toBe(false); // the orbit is reached, but over the delta-v limit
    expect(direct.x.ev.objectives.find((o) => o.objective.kind === 'max-delta-v')!.ok).toBe(false);
  });
});
