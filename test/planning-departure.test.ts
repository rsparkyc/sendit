import { beforeAll, describe, expect, it } from 'vitest';
import { ChebyshevEphemeris } from '../src/physics/chebyshev-ephemeris';
import { J2000_BODIES } from '../src/physics/solar-system';
import { propagate, type Burn } from '../src/physics/spacecraft';
import { tdbToIso } from '../src/planning/bodies';
import { flyToTarget, MaskedEphemeris, osculatingVInf, planDeparture } from '../src/planning/departure';
import { CASES, DAY, DEG, EARTH, ENGINE, EPHEM_SPAN, MASS, MOON, SUN, setupCase } from './helpers/planning-cases';

let ephem: ChebyshevEphemeris;
beforeAll(() => {
  ephem = new ChebyshevEphemeris();
  ephem.ensure(...EPHEM_SPAN);
}, 300000);

describe('first-guess departure burn, flown in the N-body model', () => {
  for (const c of CASES) {
    it(`${c.name}: miss distance and its causes`, () => {
      const { p, tDep, tArr, t0, parking, target } = setupCase(ephem, c);
      const lines: string[] = [];
      lines.push(`${c.name}: depart ${tdbToIso(tDep)} arrive ${tdbToIso(tArr)} (${((tArr - tDep) / DAY).toFixed(1)} d), C3 ${(p.c3 / 1e6).toFixed(3)} km2/s2, DLA ${(p.dla / DEG).toFixed(2)} deg, vinf arr ${(Math.hypot(...p.vInfArrVec) / 1e3).toFixed(3)} km/s`);
      const fmt = (label: string, enc: ReturnType<typeof flyToTarget>, ms: number) =>
        lines.push(`  ${label.padEnd(52)} at arrival time ${(enc.distanceAtRef / 1e3).toFixed(0).padStart(9)} km; closest ${(enc.closest / 1e3).toFixed(0).padStart(9)} km at ${((enc.tClosest - tArr) / 3600).toFixed(1)} h; B(T,R) ${(enc.bt / 1e3).toFixed(0)}, ${(enc.br / 1e3).toFixed(0)} km  [${ms.toFixed(0)} ms]`);
      const tEnd = tArr + 20 * DAY;
      const earth = new Float64Array(6);
      ephem.bodyState(EARTH, tDep, earth);
      // Lambert start: Earth's centre (+1 m, so a silenced Earth gives 0, not 0/0) with Earth velocity + vinf.
      const yL = [earth[0] + 1, earth[1], earth[2], earth[3] + p.vInfDepVec[0], earth[4] + p.vInfDepVec[1], earth[5] + p.vInfDepVec[2], MASS];
      const others = J2000_BODIES.map((_, i) => i).filter((i) => i !== SUN);
      const run = (label: string, eph: ConstructorParameters<typeof MaskedEphemeris>[0], y0: ArrayLike<number>, ta: number, burns: Burn[] = []) => {
        const t1 = performance.now();
        const enc = flyToTarget(eph, target, y0, ta, tEnd, tArr, burns, { searchFrom: tArr - 60 * DAY });
        fmt(label, enc, performance.now() - t1);
        return enc;
      };
      const a = run('A  Sun only, from Earth centre (conic check)', new MaskedEphemeris(ephem, others, false), yL, tDep);
      const a2 = run('A2 Sun + target only, from Earth centre', new MaskedEphemeris(ephem, others.filter((i) => i !== target), false), yL, tDep);
      const b = run('B  all but Earth+Moon, from Earth centre', new MaskedEphemeris(ephem, [EARTH, MOON]), yL, tDep);
      // Departure from the parking orbit.
      const impulsive = planDeparture(ephem, J2000_BODIES, { departure: 'earth', vInf: p.vInfDepVec, tDep, parking, t0, engine: { thrust: 1e9, isp: ENGINE.isp } });
      const finite = planDeparture(ephem, J2000_BODIES, { departure: 'earth', vInf: p.vInfDepVec, tDep, parking, t0, engine: ENGINE });
      lines.push(`  burn: dv ${finite.dvMag.toFixed(1)} m/s at ${tdbToIso(finite.tImpulse)} (${((finite.tImpulse - tDep) / 60).toFixed(1)} min from porkchop date), duration ${finite.burn.duration.toFixed(1)} s, dir (pro,nrm,rad) ${finite.burn.direction.map((x) => x.toFixed(1)).join(', ')}, asymptote error ${(finite.asymptoteError / DEG).toFixed(4)} deg`);
      const ci = run('C  full model, parking orbit, ~impulsive burn', ephem, parking, t0, [impulsive.burn]);
      const cm = run('C2 as C without the Moon', new MaskedEphemeris(ephem, [MOON]), parking, t0, [impulsive.burn]);
      const strong = planDeparture(ephem, J2000_BODIES, { departure: 'earth', vInf: p.vInfDepVec, tDep, parking, t0, engine: { thrust: 4 * ENGINE.thrust, isp: ENGINE.isp } });
      run(`D2 full model, finite burn at 4x thrust (${(4 * ENGINE.thrust) / 1e3} kN)`, ephem, parking, t0, [strong.burn]);
      // What the departure actually produced, 2 days after the burn (osculating about Earth).
      const want = Math.hypot(...p.vInfDepVec);
      for (const [label, plan] of [['impulsive', impulsive], ['finite 50 kN', finite], ['finite 200 kN', strong]] as const) {
        const tq = plan.tImpulse + 2 * DAY;
        const y = propagate(ephem, parking, t0, tq, [plan.burn], { rtol: 1e-11 }).y;
        const o = osculatingVInf(ephem, EARTH, tq, y);
        const ang = Math.acos(Math.min(1, (o.dir[0] * p.vInfDepVec[0] + o.dir[1] * p.vInfDepVec[1] + o.dir[2] * p.vInfDepVec[2]) / want));
        lines.push(`  achieved vinf (${label}): ${o.vinf.toFixed(1)} m/s vs ${want.toFixed(1)} wanted (${(o.vinf - want).toFixed(1)} m/s), direction off by ${(ang / DEG).toFixed(3)} deg`);
      }
      const d = run(`D  full model, finite burn (${ENGINE.thrust / 1e3} kN, ${ENGINE.isp} s, ${MASS / 1e3} t)`, ephem, parking, t0, [finite.burn]);
      console.log(lines.join('\n'));
      // Without Earth the heliocentric conic flies close to the target; the real first guess misses by far more.
      expect(b.closest).toBeLessThan(5e7);
      expect(a.closest).toBeGreaterThan(0);
      expect(d.closest).toBeGreaterThan(1e6);
      expect(Number.isFinite(b.closest + a2.closest + ci.closest + cm.closest)).toBe(true);
    }, 600000);
  }
});
