import { beforeAll, describe, expect, it } from 'vitest';
import { ChebyshevEphemeris } from '../src/physics/chebyshev-ephemeris';
import { J2000_BODIES } from '../src/physics/solar-system';
import { bForPeriapsis, correctBurn } from '../src/planning/corrector';
import { flyToTarget, planDeparture } from '../src/planning/departure';
import { CASES, DAY, ENGINE, EPHEM_SPAN, setupCase } from './helpers/planning-cases';

let ephem: ChebyshevEphemeris;
beforeAll(() => {
  ephem = new ChebyshevEphemeris();
  ephem.ensure(...EPHEM_SPAN);
}, 300000);

const AIM_ALTITUDE = 500e3;

describe('differential corrector from the Lambert first guess (finite burn, full N-body model)', () => {
  for (const c of CASES) {
    it(`${c.name}: converges onto a ${AIM_ALTITUDE / 1e3} km flyby`, () => {
      const { p, tArr, t0, parking, target } = setupCase(ephem, c);
      const plan = planDeparture(ephem, J2000_BODIES, { departure: 'earth', vInf: p.vInfDepVec, tDep: p.tDep, parking, t0, engine: ENGINE });
      const R = J2000_BODIES[target].radius;
      const vinf = Math.hypot(...p.vInfArrVec);
      const b = bForPeriapsis(R + AIM_ALTITUDE, vinf, ephem.gm[target]);
      const lines: string[] = [`${c.name}: aim B.T = ${(b / 1e3).toFixed(0)} km, B.R = 0 (periapsis altitude ${AIM_ALTITUDE / 1e3} km)`];
      const t1 = performance.now();
      // Phase 0: aim at the body's position at the Lambert arrival time (nearly linear far out).
      const r0 = correctBurn(ephem, parking, t0, plan.burn, { kind: 'position', body: target, epoch: tArr }, { tolerance: 20000e3 });
      for (const h of r0.history) lines.push(`  phase 0 it ${h.iteration}: |position error at arrival time| ${(h.miss / 1e3).toFixed(0)} km`);
      // Phase 1: B-plane 5 days before the Lambert arrival date, periapsis at that date.
      const r1 = correctBurn(ephem, parking, t0, r0.burn, { body: target, bt: b, br: 0, epoch: tArr - 5 * DAY, tPeri: tArr }, { tolerance: 1000 });
      for (const h of r1.history) lines.push(`  phase 1 it ${h.iteration}: |B - aim| ${(h.miss / 1e3).toFixed(1)} km, vinf*dt_peri ${(h.timeResidual / 1e3).toFixed(1)} km`);
      const e1 = flyToTarget(ephem, target, parking, t0, tArr + 30 * DAY, tArr, [r1.burn], { searchFrom: tArr - 60 * DAY });
      // Phase 2: B-plane 12 h before the actual closest approach (inside the sphere of
      // influence, where the osculating hyperbola predicts periapsis well), same approach time.
      const r2 = correctBurn(ephem, parking, t0, r1.burn, { body: target, bt: b, br: 0, epoch: e1.tClosest - 0.5 * DAY, tPeri: e1.tClosest }, { tolerance: 1000 });
      for (const h of r2.history) lines.push(`  phase 2 it ${h.iteration}: |B - aim| ${(h.miss / 1e3).toFixed(3)} km`);
      const e2 = flyToTarget(ephem, target, parking, t0, tArr + 30 * DAY, tArr, [r2.burn], { searchFrom: tArr - 60 * DAY });
      const ms = performance.now() - t1;
      const fb = r2.burn;
      lines.push(`  evaluations ${r0.evaluations} + ${r1.evaluations} + ${r2.evaluations}, ${ms.toFixed(0)} ms; burn change: duration ${(fb.duration - plan.burn.duration).toFixed(2)} s, start ${(fb.tStart - plan.burn.tStart).toFixed(2)} s, direction ${(Math.acos(Math.min(1, dirDot(fb.direction, plan.burn.direction))) * 180 / Math.PI).toFixed(3)} deg`);
      lines.push(`  closest approach after phase 1: altitude ${((e1.closest - R) / 1e3).toFixed(0)} km; after phase 2: ${((e2.closest - R) / 1e3).toFixed(1)} km at ${((e2.tClosest - tArr) / 3600).toFixed(1)} h from the Lambert arrival`);
      console.log(lines.join('\n'));
      expect(r2.converged).toBe(true);
      expect(Math.abs(e2.closest - R - AIM_ALTITUDE)).toBeLessThan(50e3);
    }, 600000);
  }
});

function dirDot(a: readonly number[], b: readonly number[]): number {
  const na = Math.hypot(a[0], a[1], a[2]);
  const nb = Math.hypot(b[0], b[1], b[2]);
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
}
