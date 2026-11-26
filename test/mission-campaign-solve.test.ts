/**
 * How the campaign solutions in test/mission-campaign.test.ts were found:
 * each mission solved from scratch with the planning aids (porkchop, flyby
 * chain search, departure builder, differential corrector) and tuning on the
 * replay itself, then flown as a player's plan. Slow-ish (~1 min) and its
 * numbers depend on Math.* in the planning code, so it runs only with SLOW=1
 * (`SLOW=1 pnpm vitest run test/mission-campaign-solve.test.ts`); it prints
 * each solution as JSON (the literals in mission-campaign.test.ts) and checks
 * it succeeds.
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGN, utcTdb } from '../src/mission/campaign';
import { launchSite, orbitNormalOf, planeCrossings } from '../src/mission/launch';
import type { CompleteMission } from '../src/mission/objectives';
import type { MissionPlan, PlanBurn } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { J2000_BODIES } from '../src/physics/solar-system';
import { optimizeChain } from '../src/planning/flyby';
import {
  DAY, bAngleFor, bodyIdx, chainPoint, closest, cross, describeRun, dot, eph, fly, insertion, launchForAsymptote, launchPlan,
  matchVelocity, nelderMead, norm, porkchopBest, solveDeparture, solveTcm, unitv, world, type LaunchChoice,
} from './helpers/campaign-solver';
import { SLOW } from './helpers/real-world';

const mission = (id: string): CompleteMission => CAMPAIGN.find((m) => m.id === id)!;
const pro = (start: number, duration: number, dir: [number, number, number] = [1, 0, 0], body = 'earth'): PlanBurn => ({ start, duration, engine: 0, direction: dir, frame: { kind: 'orbital', body } });
const out: Record<string, unknown> = {};

function record(m: CompleteMission, plan: MissionPlan): void {
  const x = fly(m, plan);
  console.log(describeRun(m, x));
  const s = plan.start;
  out[m.id] = { site: s.kind === 'launch' ? s.site : '', params: s.kind === 'launch' ? s.params.slice(0, 3) : [], duration: plan.duration, rtol: plan.rtol, burns: plan.burns, dv: x.ev.deltaV, time: x.ev.missionTime };
  expect(x.ev.objectives.filter((o) => o.objective.kind !== 'max-delta-v' && o.objective.kind !== 'max-time').every((o) => o.ok)).toBe(true);
  expect(x.ev.ruleViolations).toEqual([]);
}

/** Equator crossings (ascending if `asc`) of an Earth orbit, found with the replay's step hook. */
function nodeTime(plan: MissionPlan, after: number, asc: boolean): number {
  const pole = world.bodies[bodyIdx('earth')].pole!;
  const es = new Float64Array(6);
  const y = new Float64Array(7);
  let prev = NaN;
  let tp0 = NaN;
  let tNode = NaN;
  replay(plan, world, {
    onStep: (t, tp, interp) => {
      for (let i = 1; i <= 8; i++) {
        const ti = tp + ((t - tp) * i) / 8;
        interp(ti, y);
        eph.bodyState(bodyIdx('earth'), ti, es);
        const z = (y[0] - es[0]) * pole[0] + (y[1] - es[1]) * pole[1] + (y[2] - es[2]) * pole[2];
        if (Number.isNaN(tNode) && ti > after && (asc ? prev < 0 && z >= 0 : prev * z <= 0)) tNode = tp0 + (ti - tp0) * (prev / (prev - z));
        prev = z;
        tp0 = ti;
      }
    },
  });
  return tNode;
}

function lunarLaunch(t0: number): LaunchChoice {
  const n = orbitNormalOf(eph, J2000_BODIES, 'moon', t0 + 4 * DAY);
  const c = planeCrossings(launchSite('kourou'), n, t0, t0 + DAY).find((x) => x.azimuthAllowed)!;
  return { site: 'kourou', t: c.t, az: c.azimuthDeg, alt: 200e3 };
}

describe.skipIf(!SLOW)('campaign solutions, derived from scratch', { timeout: 300_000 }, () => {
  it('plane-change: launch at the corridor edge, then a normal burn at the ascending node', () => {
    const m = mission('plane-change');
    const l = { site: 'cape-canaveral', t: m.epoch, az: 35, alt: 400e3 };
    const base = launchPlan(m, l, [], 3 * 3600);
    const tNode = nodeTime(base, insertion(base).t, true);
    const mu = eph.gm[bodyIdx('earth')];
    const pole = world.bodies[bodyIdx('earth')].pole!;
    const inc = (65 * Math.PI) / 180;
    const plan = matchVelocity(m, { ...base, duration: 0.4 * DAY }, 'earth', tNode, (rel) => {
      const r = rel.slice(0, 3);
      const e = unitv(cross(pole, r));
      const n = cross(unitv(r), e);
      const vc = Math.sqrt(mu / norm(r));
      return e.map((x, k) => vc * (Math.cos(inc) * x + Math.sin(inc) * n[k]));
    });
    record(m, plan);
  });

  it('geo-from-leo: transfer at the equator crossing, circularise and flatten at apogee', () => {
    const m = mission('geo-from-leo');
    const l = { site: 'kourou', t: m.epoch, az: 90, alt: 250e3 };
    const base = launchPlan(m, l, [], 3 * 3600);
    const tNode = nodeTime(base, insertion(base).t + 600, false);
    const tn = tNode - l.t;
    const apo = (d: number) => replay(launchPlan(m, l, [pro(tn - d / 2, d)], DAY), world).events.find((e) => e.body === 'earth' && e.kind === 'apoapsis' && e.t > tNode + 600);
    let lo = 300;
    let hi = 600;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      const a = apo(mid);
      if (!a || a.distance > 42164e3) hi = mid;
      else lo = mid;
    }
    const a = apo(lo)!;
    const mu = eph.gm[bodyIdx('earth')];
    const pole = world.bodies[bodyIdx('earth')].pole!;
    let plan = matchVelocity(m, launchPlan(m, l, [pro(tn - lo / 2, lo)], 6 * DAY), 'earth', a.t, (rel) => {
      const e = unitv(cross(pole, rel.slice(0, 3)));
      const vc = Math.sqrt(mu / norm(rel.slice(0, 3)));
      return e.map((x) => x * vc);
    });
    plan = { ...plan, duration: a.t - plan.epoch + 3.8 * DAY };
    record(m, plan);
  });

  it('earth-escape: three perigee burns with a low-thrust stage', () => {
    const m = mission('earth-escape');
    const l = { site: 'cape-canaveral', t: m.epoch, az: 90, alt: 300e3 };
    const kick = 650;
    let burns: PlanBurn[] = [pro(1000, kick)];
    for (let k = 0; k < 2; k++) {
      const last = burns[burns.length - 1];
      const r = replay(launchPlan(m, l, burns, last.start + last.duration + 2 * DAY), world);
      const p = r.events.find((e) => e.body === 'earth' && e.kind === 'periapsis' && e.t > l.t + last.start + last.duration + 600)!;
      burns = [...burns, pro(p.t - l.t - kick / 2, kick)];
    }
    const fin = (d: number) => {
      const b = burns.slice();
      const lb = b[b.length - 1];
      b[b.length - 1] = pro(lb.start + (lb.duration - d) / 2, d);
      return launchPlan(m, l, b, lb.start + lb.duration + DAY);
    };
    let lo = 200;
    let hi = 1300;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (fly(m, fin(mid)).ev.objectives[0].ok) hi = mid;
      else lo = mid;
    }
    record(m, fin(hi));
  });

  it('lunar-flyby and lunar-free-return: one injection from a parking orbit in the Moon’s plane', () => {
    const fb = mission('lunar-flyby');
    const l = lunarLaunch(fb.epoch);
    record(fb, launchPlan(fb, l, [pro(2850, 339)], 3 * DAY));
    const fr = mission('lunar-free-return');
    record(fr, launchPlan(fr, l, [pro(2900, 339)], 12 * DAY));
  });

  it('lunar-orbit: a long low-thrust injection tuned on the replay, retro burn at periselene', () => {
    const m = mission('lunar-orbit');
    const l = lunarLaunch(m.epoch);
    const peri = (x: number[]) => closest(replay(launchPlan(m, l, [pro(x[0], x[1])], 5 * DAY), world), 'moon');
    const r = nelderMead((x) => { const p = peri(x); return p ? Math.abs(p.altitude - 150e3) : 1e10; }, [2450, 1010], [60, 8], 80, 1e-6);
    const tli = pro(r.x[0], r.x[1]);
    const p0 = peri(r.x)!;
    const tp = p0.t - l.t;
    const mk = (d: number) => launchPlan(m, l, [tli, pro(tp - d / 2, d, [-1, 0, 0], 'moon')], tp + 1.5 * DAY);
    const apo = (d: number) => replay(mk(d), world).events.find((e) => e.body === 'moon' && e.kind === 'apoapsis' && e.t > p0.t)?.altitude ?? Infinity;
    let lo = 20;
    let hi = 200;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (apo(mid) > 3000e3) lo = mid;
      else hi = mid;
    }
    record(m, mk(hi));
  });

  it('venus-flyby and mars-flyby: porkchop, launch into the asymptote plane, corrected departure', () => {
    const v = mission('venus-flyby');
    const pv = porkchopBest({ departure: 'earth', arrival: 'venus', departureTimes: { start: utcTdb(2028, 2, 1), end: utcTdb(2028, 5, 1), count: 90 }, flightTimes: { start: 80 * DAY, end: 250 * DAY, count: 86 }, arrivalOrbit: { kind: 'flyby' } });
    const lv = launchForAsymptote('cape-canaveral', pv.vInfDepVec, pv.tDep);
    const sv = solveDeparture(v, lv, pv, 'venus', 5000e3);
    record(v, { ...launchPlan(v, lv, [sv.burn], sv.tClosest - lv.t + DAY), rtol: 1e-11 });
    const m = mission('mars-flyby');
    const pm = porkchopBest({ departure: 'earth', arrival: 'mars', departureTimes: { start: utcTdb(2028, 10, 1), end: utcTdb(2029, 1, 31), count: 62 }, flightTimes: { start: 150 * DAY, end: 360 * DAY, count: 106 }, arrivalOrbit: { kind: 'flyby' } });
    const lm = launchForAsymptote('cape-canaveral', pm.vInfDepVec, pm.tDep);
    const sm = solveDeparture(m, lm, pm, 'mars', 3000e3);
    record(m, { ...launchPlan(m, lm, [sm.burn], sm.tClosest - lm.t + DAY), rtol: 1e-11 });
  });

  it('mars-orbit: departure, midcourse correction, capture burn at periapsis', () => {
    const m = mission('mars-orbit');
    const p = porkchopBest({ departure: 'earth', arrival: 'mars', departureTimes: { start: utcTdb(2028, 10, 1), end: utcTdb(2029, 1, 31), count: 62 }, flightTimes: { start: 150 * DAY, end: 360 * DAY, count: 106 }, arrivalOrbit: { kind: 'capture', altitude: 400e3, eccentricity: 0.7 } }, 'dvTotal');
    const l = launchForAsymptote('cape-canaveral', p.vInfDepVec, p.tDep);
    const s = solveDeparture(m, l, p, 'mars', 600e3);
    const tc = solveTcm(m, { ...launchPlan(m, l, [s.burn], s.tClosest - l.t + 3 * DAY), rtol: 1e-11 }, 'mars', s.tClosest - 30 * DAY, 500e3, s.tClosest);
    const mu = eph.gm[bodyIdx('mars')];
    const ra = 3389.5e3 + 20000e3;
    const plan = matchVelocity(m, { ...tc.plan, duration: tc.tClosest - l.t + 3 * DAY }, 'mars', tc.tClosest, (rel) => {
      const r = norm(rel.slice(0, 3));
      return unitv(rel.slice(3)).map((x) => x * Math.sqrt(mu * (2 / r - 2 / (r + ra))));
    });
    record(m, plan);
  });

  it('venus-to-mercury: chain search, B-plane aim at Venus, correction toward Mercury', () => {
    const m = mission('venus-to-mercury');
    const ch = optimizeChain(eph, J2000_BODIES, ['earth', 'venus', 'mercury'], { windows: [[2031, 9, 2031, 12], [2032, 1, 2032, 7], [2032, 5, 2033, 3]].map(([a, am, b, bm]) => ({ start: utcTdb(a, am, 1), end: utcTdb(b, bm, 1) })), samples: 2000 });
    const f = ch.result.flybys[0];
    const p = chainPoint(ch.result);
    const l = launchForAsymptote('cape-canaveral', p.vInfDepVec, p.tDep);
    const s = solveDeparture(m, l, p, 'venus', f.rpBallistic - f.radius, 1e-11, bAngleFor(f.vInfIn, f.vInfOut));
    const tc = solveTcm(m, { ...launchPlan(m, l, [s.burn], ch.times[2] - l.t + 20 * DAY), rtol: 1e-11 }, 'mercury', s.tClosest + 10 * DAY, 5000e3, ch.times[2]);
    record(m, { ...tc.plan, duration: tc.tClosest - l.t + DAY });
  });

  it('solar-escape: Jupiter flyby turning the excess velocity toward Jupiter’s motion', () => {
    const m = mission('solar-escape');
    const p = porkchopBest({ departure: 'earth', arrival: 'jupiter', departureTimes: { start: utcTdb(2031, 1, 1), end: utcTdb(2032, 1, 1), count: 73 }, flightTimes: { start: 400 * DAY, end: 1100 * DAY, count: 71 }, arrivalOrbit: { kind: 'flyby' } });
    const vIn = p.vInfArrVec as number[];
    const J = new Float64Array(6);
    const S = new Float64Array(6);
    eph.bodyState(bodyIdx('jupiter'), p.tArr, J);
    eph.bodyState(bodyIdx('sun'), p.tArr, S);
    const vJ = [J[3] - S[3], J[4] - S[4], J[5] - S[5]];
    const mu = eph.gm[bodyIdx('jupiter')];
    const RJ = J2000_BODIES[bodyIdx('jupiter')].radius;
    const v = norm(vIn);
    const dmax = 2 * Math.asin(1 / (1 + ((RJ + 100000e3) * v * v) / mu));
    const turn = Math.min(dmax, Math.acos(dot(unitv(vIn), unitv(vJ))));
    const u = unitv(vIn);
    const w = cross(unitv(cross(vIn, vJ)), u);
    const vOut = u.map((x, k) => v * (Math.cos(turn) * x + Math.sin(turn) * w[k]));
    const rp = (mu / (v * v)) * (1 / Math.sin(turn / 2) - 1);
    const l = launchForAsymptote('cape-canaveral', p.vInfDepVec, p.tDep);
    const s = solveDeparture(m, l, p, 'jupiter', rp - RJ, 1e-11, bAngleFor(vIn, vOut));
    record(m, { ...launchPlan(m, l, [s.burn], s.tClosest - l.t + 60 * DAY), rtol: 1e-11 });
  });

  it('jupiter-saturn: E-J-S chain, B-plane aim at Jupiter, correction toward Saturn', () => {
    const m = mission('jupiter-saturn');
    const ch = optimizeChain(eph, J2000_BODIES, ['earth', 'jupiter', 'saturn'], { windows: [[2034, 1, 2034, 12], [2035, 6, 2038, 1], [2037, 1, 2043, 1]].map(([a, am, b, bm]) => ({ start: utcTdb(a, am, 1), end: utcTdb(b, bm, 1) })), samples: 2000 });
    const f = ch.result.flybys[0];
    const p = chainPoint(ch.result);
    const l = launchForAsymptote('cape-canaveral', p.vInfDepVec, p.tDep);
    const s = solveDeparture(m, l, p, 'jupiter', f.rpBallistic - f.radius, 1e-11, bAngleFor(f.vInfIn, f.vInfOut));
    const tc = solveTcm(m, { ...launchPlan(m, l, [s.burn], ch.times[2] - l.t + 30 * DAY), rtol: 1e-11 }, 'saturn', s.tClosest + 30 * DAY, 50000e3, ch.times[2]);
    record(m, { ...tc.plan, duration: tc.tClosest - l.t + 2 * DAY });
  });

  it('prints the solutions', () => {
    console.log('SOLUTIONS ' + JSON.stringify(out));
  });
});
