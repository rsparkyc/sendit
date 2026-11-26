/**
 * Achievability of every campaign mission from every launch site: each
 * (mission, site) pair solved from scratch with the same planning aids as
 * test/mission-campaign-solve.test.ts (porkchop, flyby chain search,
 * departure builder, differential corrector, tuning on the replay), then
 * flown as a player's plan. The solutions it prints (SITE_SOLUTIONS JSON) are
 * the literals in test/mission-campaign-sites.test.ts; their delta-v and time
 * are the per-site reference values in campaign.ts (`launchSites`).
 *
 * Slow (several minutes; outer-planet flights take years of replay) and its
 * numbers depend on Math.* in the planning code, so it runs only with SLOW=1:
 *   SLOW=1 pnpm vitest run test/mission-campaign-sites-solve.test.ts
 * ONLY=<mission-id> and SITES=<id,id> narrow it.
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGN, utcTdb } from '../src/mission/campaign';
import { asymptotePlaneNormals, azimuthForInclination, LAUNCH_SITES, launchSite, orbitNormalOf, planeCrossings } from '../src/mission/launch';
import { missionReplayOptions, type CompleteMission } from '../src/mission/objectives';
import type { MissionPlan, PlanBurn } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { J2000_BODIES } from '../src/physics/solar-system';
import { optimizeChain } from '../src/planning/flyby';
import type { PorkchopPoint } from '../src/planning/porkchop';
import {
  DAY, bAngleFor, bodyIdx, chainPoint, closest, cross, describeRun, dot, eph, fly, insertion, launchForAsymptote, launchPlan,
  matchVelocity, nelderMead, norm, poleAt, porkchopBest, refRadius, solveDeparture, solveTcm, unitv, world, type LaunchChoice,
} from './helpers/campaign-solver';
import { ENV, SLOW } from './helpers/real-world';

const mission = (id: string): CompleteMission => CAMPAIGN.find((m) => m.id === id)!;
const pro = (start: number, duration: number, dir: [number, number, number] = [1, 0, 0], body = 'earth'): PlanBurn => ({ start, duration, engine: 0, direction: dir, frame: { kind: 'orbital', body } });
const ONLY = ENV.ONLY;
const SITES = ENV.SITES ? ENV.SITES.split(',') : LAUNCH_SITES.map((s) => s.id);
const out: Record<string, Record<string, unknown>> = {};

function record(m: CompleteMission, plan: MissionPlan): void {
  const x = fly(m, plan);
  console.log(describeRun(m, x));
  const s = plan.start;
  const site = s.kind === 'launch' ? s.site : '';
  const goalsOk = x.ev.objectives.filter((o) => o.objective.kind !== 'max-delta-v' && o.objective.kind !== 'max-time').every((o) => o.ok);
  (out[m.id] ??= {})[site] = goalsOk
    ? { params: s.kind === 'launch' ? s.params.slice(0, 3) : [], duration: plan.duration, rtol: plan.rtol, burns: plan.burns, dv: x.ev.deltaV, time: x.ev.missionTime }
    : { failed: describeRun(m, x), params: s.kind === 'launch' ? s.params.slice(0, 3) : [], duration: plan.duration, rtol: plan.rtol, burns: plan.burns };
}

function attempt(m: CompleteMission, site: string, f: () => MissionPlan): void {
  try {
    record(m, f());
  } catch (e) {
    console.log(`${m.id} @ ${site}: ${(e as Error).message}`);
    (out[m.id] ??= {})[site] = { failed: (e as Error).message };
  }
}

/** Lowest inclination the site's corridor reaches, with the azimuth (prograde first). */
function lowestInclination(site: string): { inc: number; az: number } {
  const s = launchSite(site);
  for (let inc = 0; inc <= 180; inc += 0.05) {
    const a = azimuthForInclination(s, inc);
    if (!a) continue;
    if (a.northerlyAllowed) return { inc, az: a.northerly };
    if (a.southerlyAllowed) return { inc, az: a.southerly };
  }
  throw new Error('no inclination');
}

/** Equator crossing (ascending if asc) of an Earth orbit after `after`; NaN for an equatorial orbit. */
function nodeTime(plan: MissionPlan, after: number, asc: boolean): number {
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
        const pole = poleAt('earth', ti);
        const z = (y[0] - es[0]) * pole[0] + (y[1] - es[1]) * pole[1] + (y[2] - es[2]) * pole[2];
        if (Number.isNaN(tNode) && ti > after && (asc ? prev < 0 && z >= 0 : prev * z <= 0)) tNode = tp0 + (ti - tp0) * (prev / (prev - z));
        prev = z;
        tp0 = ti;
      }
    },
  });
  return tNode;
}

function moonDir(t: number): number[] {
  const mo = new Float64Array(6);
  const e = new Float64Array(6);
  eph.bodyState(bodyIdx('moon'), t, mo);
  eph.bodyState(bodyIdx('earth'), t, e);
  return [mo[0] - e[0], mo[1] - e[1], mo[2] - e[2]];
}

/**
 * Lunar launch from any site: into the Moon's orbital plane when the corridor
 * allows it (Kourou, the equator, Cape Canaveral in 2027), else into the
 * lowest reachable prograde plane containing the Moon's position about four
 * days after liftoff (the transfer then crosses the Moon's plane on arrival).
 */
function lunarLaunch(site: string, t0: number): LaunchChoice {
  const s = launchSite(site);
  const n = orbitNormalOf(eph, J2000_BODIES, 'moon', t0 + 4 * DAY);
  const c = planeCrossings(s, n, t0, t0 + DAY).find((x) => x.azimuthAllowed);
  if (c) return { site, t: c.t, az: c.azimuthDeg, alt: 200e3 };
  let tl = t0 + 0.5 * DAY;
  let best: LaunchChoice | null = null;
  for (let iter = 0; iter < 4; iter++) {
    best = null;
    const d = moonDir(tl + 3.8 * DAY);
    for (let inc = Math.ceil(Math.abs(s.latDeg)) + 0.5; inc < 90 && !best; inc += 0.5) {
      for (const nn of asymptotePlaneNormals(d, inc, tl)) {
        if (nn[2] <= 0) continue;
        const cs = planeCrossings(s, nn, t0, t0 + 1.5 * DAY).filter((x) => x.azimuthAllowed);
        const pick = cs.sort((a, b) => Math.abs(a.t - tl) - Math.abs(b.t - tl))[0];
        if (pick && (!best || Math.abs(pick.t - tl) < Math.abs(best.t - tl))) best = { site, t: pick.t, az: pick.azimuthDeg, alt: 200e3 };
      }
    }
    if (!best) throw new Error('no lunar launch plane');
    if (Math.abs(best.t - tl) < 60) break;
    tl = best.t;
  }
  return best!;
}

/** Scan the injection start over one parking orbit for the closest lunar approach, then tune [start, duration, normal]. */
function tuneInjection(m: CompleteMission, l: LaunchChoice, dur0: number, cost: (x: number[]) => number): number[] {
  let bestStart = 0;
  let bestD = Infinity;
  for (let st = 1200; st < 1200 + 5400; st += 120) {
    const p = closest(replay(launchPlan(m, l, [pro(st, dur0)], 5 * DAY), world), 'moon');
    if (p && p.distance < bestD) { bestD = p.distance; bestStart = st; }
  }
  let x = [bestStart, dur0, 0];
  for (let k = 0; k < 3; k++) x = nelderMead(cost, x, [40, 6, 0.01], 120, 1e-9).x;
  return x;
}

const injection = (x: number[]) => pro(x[0], x[1], [1, x[2], 0]);

const porkCache = new Map<string, PorkchopPoint>();
function pork(key: string, f: () => PorkchopPoint): PorkchopPoint {
  if (!porkCache.has(key)) porkCache.set(key, f());
  return porkCache.get(key)!;
}

const solvers: Record<string, (site: string) => MissionPlan> = {
  'plane-change': (site) => {
    const m = mission('plane-change');
    if (site !== 'cape-canaveral') throw new Error('not offered: the mission is about the Cape corridor (see the sites test)');
    const l = { site, t: m.epoch, az: 35, alt: 400e3 };
    const base = launchPlan(m, l, [], 3 * 3600);
    const tNode = nodeTime(base, insertion(base).t, true);
    const mu = eph.gm[bodyIdx('earth')];
    const pole = poleAt('earth', tNode);
    const inc = (65 * Math.PI) / 180;
    return matchVelocity(m, { ...base, duration: 0.4 * DAY }, 'earth', tNode, (rel) => {
      const r = rel.slice(0, 3);
      const e = unitv(cross(pole, r));
      const n = cross(unitv(r), e);
      const vc = Math.sqrt(mu / norm(r));
      return e.map((x, k) => vc * (Math.cos(inc) * x + Math.sin(inc) * n[k]));
    });
  },

  'geo-from-leo': (site) => {
    const m = mission('geo-from-leo');
    const low = lowestInclination(site);
    const l = { site, t: m.epoch, az: low.az, alt: 250e3 };
    const base = launchPlan(m, l, [], 3 * 3600);
    let tNode = low.inc < 0.5 ? NaN : nodeTime(base, insertion(base).t + 600, false);
    if (Number.isNaN(tNode)) tNode = insertion(base).t + 1500;
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
    const pole = poleAt('earth', a.t);
    const plan = matchVelocity(m, launchPlan(m, l, [pro(tn - lo / 2, lo)], 6 * DAY), 'earth', a.t, (rel) => {
      const e = unitv(cross(pole, rel.slice(0, 3)));
      const vc = Math.sqrt(mu / norm(rel.slice(0, 3)));
      return e.map((x) => x * vc);
    });
    // The combined circularisation and plane change is a long finite burn: tune it on the replay.
    const R = 42164e3;
    const b0 = plan.burns[1];
    const mk = (x: number[]): MissionPlan => ({ ...plan, duration: a.t - plan.epoch + 1.2 * DAY, burns: [plan.burns[0], { ...b0, start: b0.start + x[0], duration: b0.duration * x[1], direction: [b0.direction[0] * (1 + x[2]), b0.direction[1] + x[3] * norm(b0.direction), b0.direction[2] + x[4] * norm(b0.direction)] }] });
    const cost = (x: number[]): number => {
      const r = replay(mk(x), world);
      const ex = r.events.filter((e) => e.body === 'earth' && (e.kind === 'periapsis' || e.kind === 'apoapsis') && e.t > a.t + 2 * 3600).slice(0, 3);
      if (ex.length < 2) return 1e12;
      let c = 0;
      for (const e of ex) {
        const h = cross(e.rel.slice(0, 3), e.rel.slice(3, 6));
        const inc = Math.acos(dot(h, pole) / norm(h)) / (Math.PI / 180);
        c += Math.abs(e.distance - R) + 1e5 * Math.max(0, inc - 0.3);
      }
      return c;
    };
    let x = [0, 1, 0, 0, 0];
    if (cost(x) > 30e3) for (let k = 0; k < 4; k++) x = nelderMead(cost, x, [10, 0.01, 0.01, 0.01, 0.01], 300, 1e-10).x;
    // Fly long enough for three revolutions of a near-circular orbit, whose extrema come irregularly (from Mahia 3.8 days were short).
    return { ...mk(x), duration: a.t - plan.epoch + 4.5 * DAY };
  },

  'earth-escape': (site) => {
    const m = mission('earth-escape');
    const l = { site, t: m.epoch, az: lowestInclination(site).az, alt: 300e3 };
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
    return fin(hi);
  },

  'lunar-flyby': (site) => {
    const m = mission('lunar-flyby');
    const l = lunarLaunch(site, m.epoch);
    const x = tuneInjection(m, l, 339, (x) => {
      const p = closest(replay(launchPlan(m, l, [injection(x)], 5 * DAY), world), 'moon');
      return p ? Math.abs(p.altitude - 3000e3) : 1e12;
    });
    const p = closest(replay(launchPlan(m, l, [injection(x)], 5 * DAY), world), 'moon')!;
    return launchPlan(m, l, [injection(x)], Math.ceil(p.t - l.t + DAY));
  },

  'lunar-free-return': (site) => {
    const m = mission('lunar-free-return');
    const l = lunarLaunch(site, m.epoch);
    const f = (x: number[]) => {
      const r = replay(launchPlan(m, l, [injection(x)], 11 * DAY), world, missionReplayOptions(m));
      const pm = closest(r, 'moon');
      if (!pm) return 1e12;
      const moonPen = pm.altitude < 300e3 ? 300e3 - pm.altitude : pm.altitude > 15000e3 ? pm.altitude - 15000e3 : 0;
      const last = r.events[r.events.length - 1];
      if (r.outcome === 'atmosphere' && last && last.body === 'earth' && last.t > pm.t) return 10 * moonPen + 100 * Math.max(0, last.speed - 11300);
      const pe = closest(r, 'earth', pm.t);
      return (pe ? Math.abs(pe.altitude - 40e3) : 1e9) + 10 * moonPen;
    };
    // The return corridor is narrow: start from the flyby solution, grid over start and duration, then tune.
    const x0 = tuneInjection(m, l, 339, (x) => { const p = closest(replay(launchPlan(m, l, [injection(x)], 5 * DAY), world), 'moon'); return p ? Math.abs(p.altitude - 3000e3) : 1e12; });
    let best = { x: x0, f: f(x0) };
    // Normal component: +-0.03 (the free return from the Cape needs ~0.025 more than the flyby's).
    for (let ds = -300; ds <= 300; ds += 20) for (let dd = -8; dd <= 8; dd += 1) for (const dn of [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03]) {
      const x = [x0[0] + ds, x0[1] + dd, x0[2] + dn];
      const v = f(x);
      if (v < best.f) best = { x, f: v };
    }
    let x = best.x;
    for (let k = 0; k < 4; k++) x = nelderMead(f, x, [5, 0.5, 0.002], 200, 1e-12).x;
    if (f(x) > 0) {
      // Missed the corridor (from the Cape under model 2): a finer grid, then tune again.
      best = { x, f: f(x) };
      for (let ds = -300; ds <= 300; ds += 10) for (let dd = -8; dd <= 8; dd += 1) for (let dn = -0.03; dn <= 0.0301; dn += 0.005) {
        const y = [x0[0] + ds, x0[1] + dd, x0[2] + dn];
        const v = f(y);
        if (v < best.f) best = { x: y, f: v };
      }
      x = best.x;
      for (let k = 0; k < 4; k++) x = nelderMead(f, x, [5, 0.5, 0.002], 200, 1e-12).x;
    }
    return launchPlan(m, l, [injection(x)], 12 * DAY);
  },

  'lunar-orbit': (site) => {
    const m = mission('lunar-orbit');
    const l = lunarLaunch(site, m.epoch);
    const peri = (x: number[]) => closest(replay(launchPlan(m, l, [injection(x)], 5 * DAY), world), 'moon');
    const x = tuneInjection(m, l, 1010, (x) => { const p = peri(x); return p ? Math.abs(p.altitude - 150e3) : 1e12; });
    const tli = injection(x);
    const p0 = peri(x)!;
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
    return mk(hi);
  },

  'venus-flyby': (site) => {
    const v = mission('venus-flyby');
    const pv = pork('venus', () => porkchopBest({ departure: 'earth', arrival: 'venus', departureTimes: { start: utcTdb(2028, 2, 1), end: utcTdb(2028, 5, 1), count: 90 }, flightTimes: { start: 80 * DAY, end: 250 * DAY, count: 86 }, arrivalOrbit: { kind: 'flyby' } }));
    const lv = launchForAsymptote(site, pv.vInfDepVec, pv.tDep);
    const sv = solveDeparture(v, lv, pv, 'venus', 5000e3);
    return { ...launchPlan(v, lv, [sv.burn], sv.tClosest - lv.t + DAY), rtol: 1e-11 };
  },

  'mars-flyby': (site) => {
    const m = mission('mars-flyby');
    const pm = pork('mars', () => porkchopBest({ departure: 'earth', arrival: 'mars', departureTimes: { start: utcTdb(2028, 10, 1), end: utcTdb(2029, 1, 31), count: 62 }, flightTimes: { start: 150 * DAY, end: 360 * DAY, count: 106 }, arrivalOrbit: { kind: 'flyby' } }));
    const lm = launchForAsymptote(site, pm.vInfDepVec, pm.tDep);
    const sm = solveDeparture(m, lm, pm, 'mars', 3000e3);
    return { ...launchPlan(m, lm, [sm.burn], sm.tClosest - lm.t + DAY), rtol: 1e-11 };
  },

  'mars-orbit': (site) => {
    const m = mission('mars-orbit');
    const p = pork('mars-capture', () => porkchopBest({ departure: 'earth', arrival: 'mars', departureTimes: { start: utcTdb(2028, 10, 1), end: utcTdb(2029, 1, 31), count: 62 }, flightTimes: { start: 150 * DAY, end: 360 * DAY, count: 106 }, arrivalOrbit: { kind: 'capture', altitude: 400e3, eccentricity: 0.7 } }, 'dvTotal'));
    const l = launchForAsymptote(site, p.vInfDepVec, p.tDep);
    const s = solveDeparture(m, l, p, 'mars', 600e3);
    const tc = solveTcm(m, { ...launchPlan(m, l, [s.burn], s.tClosest - l.t + 3 * DAY), rtol: 1e-11 }, 'mars', s.tClosest - 30 * DAY, 500e3, s.tClosest);
    const mu = eph.gm[bodyIdx('mars')];
    const ra = refRadius('mars') + 20000e3;
    return matchVelocity(m, { ...tc.plan, duration: tc.tClosest - l.t + 3 * DAY }, 'mars', tc.tClosest, (rel) => {
      const r = norm(rel.slice(0, 3));
      return unitv(rel.slice(3)).map((x) => x * Math.sqrt(mu * (2 / r - 2 / (r + ra))));
    });
  },

  'venus-to-mercury': (site) => {
    const m = mission('venus-to-mercury');
    const ch = chainVM();
    const f = ch.result.flybys[0];
    const p = chainPoint(ch.result);
    const l = launchForAsymptote(site, p.vInfDepVec, p.tDep);
    const s = solveDeparture(m, l, p, 'venus', f.rpBallistic - f.radius, 1e-11, bAngleFor(f.vInfIn, f.vInfOut));
    const tc = solveTcm(m, { ...launchPlan(m, l, [s.burn], ch.times[2] - l.t + 20 * DAY), rtol: 1e-11 }, 'mercury', s.tClosest + 10 * DAY, 5000e3, ch.times[2]);
    return { ...tc.plan, duration: tc.tClosest - l.t + DAY };
  },

  'solar-escape': (site) => {
    const m = mission('solar-escape');
    const p = pork('jupiter', () => porkchopBest({ departure: 'earth', arrival: 'jupiter', departureTimes: { start: utcTdb(2031, 1, 1), end: utcTdb(2032, 1, 1), count: 73 }, flightTimes: { start: 400 * DAY, end: 1100 * DAY, count: 71 }, arrivalOrbit: { kind: 'flyby' } }));
    const vIn = p.vInfArrVec as number[];
    const J = new Float64Array(6);
    const S = new Float64Array(6);
    eph.bodyState(bodyIdx('jupiter'), p.tArr, J);
    eph.bodyState(bodyIdx('sun'), p.tArr, S);
    const vJ = [J[3] - S[3], J[4] - S[4], J[5] - S[5]];
    const mu = eph.gm[bodyIdx('jupiter')];
    const RJ = refRadius('jupiter');
    const v = norm(vIn);
    const dmax = 2 * Math.asin(1 / (1 + ((RJ + 100000e3) * v * v) / mu));
    const turn = Math.min(dmax, Math.acos(dot(unitv(vIn), unitv(vJ))));
    const u = unitv(vIn);
    const w = cross(unitv(cross(vIn, vJ)), u);
    const vOut = u.map((x, k) => v * (Math.cos(turn) * x + Math.sin(turn) * w[k]));
    const rp = (mu / (v * v)) * (1 / Math.sin(turn / 2) - 1);
    const l = launchForAsymptote(site, p.vInfDepVec, p.tDep);
    const s = solveDeparture(m, l, p, 'jupiter', rp - RJ, 1e-11, bAngleFor(vIn, vOut));
    return { ...launchPlan(m, l, [s.burn], s.tClosest - l.t + 60 * DAY), rtol: 1e-11 };
  },

  'jupiter-saturn': (site) => {
    const m = mission('jupiter-saturn');
    const ch = chainJS();
    const f = ch.result.flybys[0];
    const p = chainPoint(ch.result);
    const l = launchForAsymptote(site, p.vInfDepVec, p.tDep);
    const s = solveDeparture(m, l, p, 'jupiter', f.rpBallistic - f.radius, 1e-11, bAngleFor(f.vInfIn, f.vInfOut));
    const tc = solveTcm(m, { ...launchPlan(m, l, [s.burn], ch.times[2] - l.t + 30 * DAY), rtol: 1e-11 }, 'saturn', s.tClosest + 30 * DAY, 50000e3, ch.times[2]);
    return { ...tc.plan, duration: tc.tClosest - l.t + 2 * DAY };
  },
};

let vm: ReturnType<typeof optimizeChain> | null = null;
function chainVM() {
  return (vm ??= optimizeChain(eph, J2000_BODIES, ['earth', 'venus', 'mercury'], { windows: [[2031, 9, 2031, 12], [2032, 1, 2032, 7], [2032, 5, 2033, 3]].map(([a, am, b, bm]) => ({ start: utcTdb(a, am, 1), end: utcTdb(b, bm, 1) })), samples: 2000 }));
}
let js: ReturnType<typeof optimizeChain> | null = null;
function chainJS() {
  return (js ??= optimizeChain(eph, J2000_BODIES, ['earth', 'jupiter', 'saturn'], { windows: [[2034, 1, 2034, 12], [2035, 6, 2038, 1], [2037, 1, 2043, 1]].map(([a, am, b, bm]) => ({ start: utcTdb(a, am, 1), end: utcTdb(b, bm, 1) })), samples: 2000 }));
}

describe.skipIf(!SLOW)('campaign missions from every launch site', { timeout: 3_600_000 }, () => {
  for (const m of CAMPAIGN) {
    if (ONLY && !ONLY.split(',').includes(m.id)) continue;
    it(m.id, () => {
      for (const site of SITES) attempt(m, site, () => solvers[m.id](site));
      console.log(`SITE_SOLUTION ${m.id} ${JSON.stringify(out[m.id])}`);
      expect(Object.keys(out[m.id] ?? {}).length).toBe(SITES.length);
    });
  }
});
