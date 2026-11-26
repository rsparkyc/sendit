/**
 * The campaign's solvers: one per mission, for any launch site, building the
 * plan a player could fly on the mission's launch vehicle (vehicle launch,
 * staged burns, separations). Used by test/mission-campaign-sites-solve.test.ts
 * (every site; its output is the literals of the per-site tests) and
 * test/mission-campaign-solve.test.ts (the default site: par). Advisory code:
 * ordinary Math, results depend on it, so the solutions are kept as literals
 * and only those are checked on every run.
 *
 * Every solution: the parking altitude is chosen by `bestParkingAltitude`
 * (ascent delta-v plus an analytic estimate of the flight's cost; the band's
 * floor for every mission except where the solver says otherwise), the upper
 * stage flies the departure (if it runs dry the spacecraft finishes the same
 * burn after a separation, `appendLeg`), the upper stage is dropped 600 s
 * after the departure, and the spacecraft flies everything after that.
 */
import { CAMPAIGN, utcTdb } from '../../src/mission/campaign';
import { asymptotePlaneNormals, azimuthForInclination, launchSite, orbitNormalOf, planeCrossings } from '../../src/mission/launch';
import { missionReplayOptions, type CompleteMission } from '../../src/mission/objectives';
import type { MissionPlan } from '../../src/mission/plan';
import { replay } from '../../src/mission/replay';
import { J2000_BODIES } from '../../src/physics/solar-system';
import { optimizeChain } from '../../src/planning/flyby';
import type { PorkchopPoint } from '../../src/planning/porkchop';
import {
  DAY, MU_EARTH, appendLeg, bAngleFor, bestParkingAltitude, bodyIdx, chainPoint, closest, cross, departureDv, dot, eph, fly, insertion,
  launchForAsymptote, launchPlan, matchVelocity, nelderMead, norm, poleAt, porkchopBest, refRadius, separateAfter, solveDeparture, solveTcm,
  stageDvLeft, unitv, world, type LaunchChoice,
} from './campaign-solver';

export const mission = (id: string): CompleteMission => CAMPAIGN.find((m) => m.id === id)!;
const PRO: [number, number, number] = [1, 0, 0];
const RE = refRadius('earth');
const C3_LUNAR = -1.9e6;

/** Lowest inclination the site's corridor reaches, with the azimuth (prograde first). */
export function lowestInclination(site: string): { inc: number; az: number } {
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
export function nodeTime(plan: MissionPlan, after: number, asc: boolean): number {
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

/** With the parking altitude chosen for the mission (ascent + flightDv minimum). */
function withAltitude(m: CompleteMission, l: LaunchChoice, flightDv: (h: number) => number): LaunchChoice {
  return { ...l, alt: bestParkingAltitude(m, l, flightDv).alt };
}

/**
 * Lunar launch from any site: into the Moon's orbital plane when the corridor
 * allows it, else into the lowest reachable prograde plane containing the
 * Moon's position about four days after liftoff.
 */
function lunarLaunch(m: CompleteMission, site: string, t0: number): LaunchChoice {
  const s = launchSite(site);
  const n = orbitNormalOf(eph, J2000_BODIES, 'moon', t0 + 4 * DAY);
  const c = planeCrossings(s, n, t0, t0 + DAY).find((x) => x.azimuthAllowed);
  const fin = (l: LaunchChoice) => withAltitude(m, l, (h) => departureDv(h, C3_LUNAR));
  if (c) return fin({ site, t: c.t, az: c.azimuthDeg, alt: 200e3 });
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
  return fin(best!);
}

/** The injection leg: start (s after liftoff), delta-v, normal component; flown by the active stage, split if it runs dry. */
const injectionPlan = (m: CompleteMission, l: LaunchChoice, x: number[], duration: number): MissionPlan =>
  appendLeg(m, launchPlan(m, l, [], duration), l.t + x[0], x[1], [1, x[2], 0], 'earth', { centre: false });

/** Scan the injection start over one parking orbit for the closest lunar approach, then tune [start, delta-v, normal]. */
function tuneInjection(m: CompleteMission, l: LaunchChoice, dv0: number, cost: (x: number[]) => number): number[] {
  let bestStart = 0;
  let bestD = Infinity;
  for (let st = 1200; st < 1200 + 5400; st += 120) {
    const p = closest(replay(injectionPlan(m, l, [st, dv0, 0], 5 * DAY), world), 'moon');
    if (p && p.distance < bestD) { bestD = p.distance; bestStart = st; }
  }
  let x = [bestStart, dv0, 0];
  for (let k = 0; k < 3; k++) x = nelderMead(cost, x, [40, 20, 0.01], 120, 1e-9).x;
  return x;
}

const porkCache = new Map<string, PorkchopPoint>();
function pork(key: string, f: () => PorkchopPoint): PorkchopPoint {
  if (!porkCache.has(key)) porkCache.set(key, f());
  return porkCache.get(key)!;
}
let vm: ReturnType<typeof optimizeChain> | null = null;
function chainVM() {
  return (vm ??= optimizeChain(eph, J2000_BODIES, ['earth', 'venus', 'mercury'], { windows: [[2031, 9, 2031, 12], [2032, 1, 2032, 7], [2032, 5, 2033, 3]].map(([a, am, b, bm]) => ({ start: utcTdb(a, am, 1), end: utcTdb(b, bm, 1) })), samples: 2000 }));
}
let js: ReturnType<typeof optimizeChain> | null = null;
function chainJS() {
  return (js ??= optimizeChain(eph, J2000_BODIES, ['earth', 'jupiter', 'saturn'], { windows: [[2034, 1, 2034, 12], [2035, 6, 2038, 1], [2037, 1, 2043, 1]].map(([a, am, b, bm]) => ({ start: utcTdb(a, am, 1), end: utcTdb(b, bm, 1) })), samples: 2000 }));
}

/** Launch into the departure asymptote's plane at the parking altitude the departure favours. */
function asymptoteLaunch(m: CompleteMission, site: string, p: PorkchopPoint): LaunchChoice {
  const c3 = p.vInfDepVec[0] ** 2 + p.vInfDepVec[1] ** 2 + p.vInfDepVec[2] ** 2;
  const l0 = launchForAsymptote(site, p.vInfDepVec as number[], p.tDep, 200e3);
  const alt = bestParkingAltitude(m, l0, (h) => departureDv(h, c3)).alt;
  return launchForAsymptote(site, p.vInfDepVec as number[], p.tDep, alt);
}

/** An interplanetary departure plan: the solved departure burn(s) and separation. */
function departurePlan(m: CompleteMission, l: LaunchChoice, s: ReturnType<typeof solveDeparture>, duration: number): MissionPlan {
  return { ...launchPlan(m, l, s.burns, duration, s.separations), rtol: 1e-11 };
}

/** Plane change: corridor edge at the given parking altitude; the plane turn at the ascending node (combined with the climb from a lower orbit). */
export function planeChange(site: string, alt: number): MissionPlan {
  const m = mission('plane-change');
  if (site !== 'cape-canaveral') throw new Error('not offered: the mission is about the Cape corridor (see the sites test)');
  const l = { site, t: m.epoch, az: 35, alt };
  const mu = MU_EARTH;
  const inc = (65 * Math.PI) / 180;
  const R = RE + 400e3;
  const base = launchPlan(m, l, [], 3 * 3600);
  const target = (pole: number[]) => (rel: number[]) => {
    const r = rel.slice(0, 3);
    const e = unitv(cross(pole, r));
    const n = cross(unitv(r), e);
    // Circular at 400 km from wherever the burn is (j2-mean radius differs by a few km).
    const vc = Math.sqrt(mu / norm(r));
    return e.map((x, k) => vc * (Math.cos(inc) * x + Math.sin(inc) * n[k]));
  };
  if (alt >= 350e3) {
    const tNode = nodeTime(base, insertion(base).t, true);
    return separateAfter(m, matchVelocity(m, { ...base, duration: 0.4 * DAY }, 'earth', tNode, target(poleAt('earth', tNode))));
  }
  // From a lower orbit: a prograde burn at the descending node puts apogee (400 km) at the ascending node, where the plane turn and circularisation are one burn.
  const tDn = nodeTime(base, insertion(base).t, false);
  const apo = (dv: number) => replay(appendLeg(m, { ...base, duration: 0.3 * DAY }, tDn, dv, PRO), world).events.find((e) => e.body === 'earth' && e.kind === 'apoapsis' && e.t > tDn + 600);
  let lo = 0;
  let hi = 300;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    const a = apo(mid);
    if (!a || a.distance > R) hi = mid;
    else lo = mid;
  }
  const raised = appendLeg(m, { ...base, duration: 0.4 * DAY }, tDn, lo, PRO);
  const a = apo(lo)!;
  return separateAfter(m, matchVelocity(m, raised, 'earth', a.t, target(poleAt('earth', a.t))));
}

export const SOLVERS: Record<string, (site: string) => MissionPlan> = {
  // Launching low and turning the plane in the circularisation at 400 km beats launching straight to 400 km (mission-campaign-solve.test.ts).
  'plane-change': (site) => planeChange(site, 180e3),

  'geo-from-leo': (site) => {
    const m = mission('geo-from-leo');
    const low = lowestInclination(site);
    const RG = 42164e3;
    // Flight cost from a circular orbit at h: Hohmann to GEO, the launch inclination removed at apogee.
    const flight = (h: number) => {
      const r1 = RE + h;
      const at = (r1 + RG) / 2;
      const vp = Math.sqrt(MU_EARTH * (2 / r1 - 1 / at));
      const va = Math.sqrt(MU_EARTH * (2 / RG - 1 / at));
      const vg = Math.sqrt(MU_EARTH / RG);
      const di = (low.inc * Math.PI) / 180;
      return vp - Math.sqrt(MU_EARTH / r1) + Math.sqrt(va * va + vg * vg - 2 * va * vg * Math.cos(di));
    };
    const l = withAltitude(m, { site, t: m.epoch, az: low.az, alt: 200e3 }, flight);
    const base = launchPlan(m, l, [], 3 * 3600);
    let tNode = low.inc < 0.5 ? NaN : nodeTime(base, insertion(base).t + 600, false);
    if (Number.isNaN(tNode)) tNode = insertion(base).t + 1500;
    const raise = (dv: number) => appendLeg(m, { ...base, duration: DAY }, tNode, dv, PRO);
    const apo = (dv: number) => replay(raise(dv), world).events.find((e) => e.body === 'earth' && e.kind === 'apoapsis' && e.t > tNode + 600);
    let lo = 2000;
    let hi = 2800;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      const a = apo(mid);
      if (!a || a.distance > RG) hi = mid;
      else lo = mid;
    }
    const a = apo(lo)!;
    const pole = poleAt('earth', a.t);
    const raised = separateAfter(m, { ...raise(lo), duration: 6 * DAY });
    const plan = matchVelocity(m, raised, 'earth', a.t, (rel) => {
      const e = unitv(cross(pole, rel.slice(0, 3)));
      const vc = Math.sqrt(MU_EARTH / norm(rel.slice(0, 3)));
      return e.map((x) => x * vc);
    });
    // The combined circularisation and plane change is a long finite burn: tune it on the replay.
    const ib = plan.burns.length - 1;
    const b0 = plan.burns[ib];
    const mk = (x: number[]): MissionPlan => ({ ...plan, duration: a.t - plan.epoch + 1.2 * DAY, burns: plan.burns.map((b, i) => (i !== ib ? b : { ...b0, start: b0.start + x[0], duration: b0.duration * x[1], direction: [b0.direction[0] * (1 + x[2]), b0.direction[1] + x[3] * norm(b0.direction), b0.direction[2] + x[4] * norm(b0.direction)] })) });
    const cost = (x: number[]): number => {
      const r = replay(mk(x), world);
      const ex = r.events.filter((e) => e.body === 'earth' && (e.kind === 'periapsis' || e.kind === 'apoapsis') && e.t > a.t + 2 * 3600).slice(0, 3);
      if (ex.length < 2) return 1e12;
      let c = 0;
      for (const e of ex) {
        const h = cross(e.rel.slice(0, 3), e.rel.slice(3, 6));
        const inc = Math.acos(dot(h, pole) / norm(h)) / (Math.PI / 180);
        c += Math.abs(e.distance - RG) + 1e5 * Math.max(0, inc - 0.3);
      }
      return c;
    };
    let x = [0, 1, 0, 0, 0];
    if (cost(x) > 30e3) for (let k = 0; k < 4; k++) x = nelderMead(cost, x, [10, 0.01, 0.01, 0.01, 0.01], 300, 1e-10).x;
    return { ...mk(x), duration: a.t - plan.epoch + 4.5 * DAY };
  },

  'earth-escape': (site) => {
    const m = mission('earth-escape');
    const l = withAltitude(m, { site, t: m.epoch, az: lowestInclination(site).az, alt: 200e3 }, (h) => departureDv(h, 9e6));
    // The upper stage's whole reserve as the first perigee kick, then drop it.
    const base = launchPlan(m, l, [], DAY);
    let plan = appendLeg(m, base, l.t + 1000, stageDvLeft(m, base, l.t + 1000), PRO, 'earth', { centre: false });
    plan = separateAfter(m, plan, 60);
    // Then the 5 kN stage: a fixed kick at the next perigee and a final one sized to escape.
    const kick = 650;
    const pro = (start: number, duration: number) => ({ start, duration, stage: plan.lowerStages!.length, engine: 0, direction: PRO, frame: { kind: 'orbital' as const, body: 'earth' } });
    let burns = plan.burns.slice();
    for (let k = 0; k < 1; k++) {
      const last = burns[burns.length - 1];
      const r = replay({ ...plan, burns, duration: last.start + last.duration + 2 * DAY }, world);
      const p = r.events.find((e) => e.body === 'earth' && e.kind === 'periapsis' && e.t > l.t + last.start + last.duration + 600)!;
      burns = [...burns, pro(p.t - l.t - kick / 2, kick)];
    }
    const last = burns[burns.length - 1];
    const r = replay({ ...plan, burns, duration: last.start + last.duration + 2 * DAY }, world);
    const pf = r.events.find((e) => e.body === 'earth' && e.kind === 'periapsis' && e.t > l.t + last.start + last.duration + 600)!;
    const fin = (d: number): MissionPlan => {
      const b = [...burns, pro(pf.t - l.t - d / 2, d)];
      return { ...plan, burns: b, duration: b[b.length - 1].start + d + DAY };
    };
    let lo = 50;
    let hi = 1500;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (fly(m, fin(mid)).ev.objectives[0].ok) hi = mid;
      else lo = mid;
    }
    return fin(hi);
  },

  'lunar-flyby': (site) => {
    const m = mission('lunar-flyby');
    const l = lunarLaunch(m, site, m.epoch);
    const x = tuneInjection(m, l, 3130, (x) => {
      const p = closest(replay(injectionPlan(m, l, x, 5 * DAY), world), 'moon');
      return p ? Math.abs(p.altitude - 3000e3) : 1e12;
    });
    const p = closest(replay(injectionPlan(m, l, x, 5 * DAY), world), 'moon')!;
    return separateAfter(m, injectionPlan(m, l, x, Math.ceil(p.t - l.t + DAY)));
  },

  'lunar-free-return': (site) => {
    const m = mission('lunar-free-return');
    const l = lunarLaunch(m, site, m.epoch);
    const f = (x: number[]) => {
      const r = replay(injectionPlan(m, l, x, 11 * DAY), world, missionReplayOptions(m));
      const pm = closest(r, 'moon');
      if (!pm) return 1e12;
      const moonPen = pm.altitude < 300e3 ? 300e3 - pm.altitude : pm.altitude > 15000e3 ? pm.altitude - 15000e3 : 0;
      const last = r.events[r.events.length - 1];
      if (r.outcome === 'atmosphere' && last && last.body === 'earth' && last.t > pm.t) return 10 * moonPen + 100 * Math.max(0, last.speed - 11300);
      const pe = closest(r, 'earth', pm.t);
      return (pe ? Math.abs(pe.altitude - 40e3) : 1e9) + 10 * moonPen;
    };
    // The return corridor is narrow: start from the flyby solution, grid over start and delta-v, then tune.
    const x0 = tuneInjection(m, l, 3130, (x) => { const p = closest(replay(injectionPlan(m, l, x, 5 * DAY), world), 'moon'); return p ? Math.abs(p.altitude - 3000e3) : 1e12; });
    let best = { x: x0, f: f(x0) };
    for (let ds = -300; ds <= 300; ds += 20) for (let dd = -40; dd <= 40; dd += 5) for (const dn of [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03]) {
      const x = [x0[0] + ds, x0[1] + dd, x0[2] + dn];
      const v = f(x);
      if (v < best.f) best = { x, f: v };
    }
    let x = best.x;
    for (let k = 0; k < 4; k++) x = nelderMead(f, x, [5, 3, 0.002], 200, 1e-12).x;
    if (f(x) > 0) {
      best = { x, f: f(x) };
      for (let ds = -300; ds <= 300; ds += 10) for (let dd = -40; dd <= 40; dd += 2.5) for (let dn = -0.03; dn <= 0.0301; dn += 0.005) {
        const y = [x0[0] + ds, x0[1] + dd, x0[2] + dn];
        const v = f(y);
        if (v < best.f) best = { x: y, f: v };
      }
      x = best.x;
      for (let k = 0; k < 4; k++) x = nelderMead(f, x, [5, 3, 0.002], 200, 1e-12).x;
    }
    return separateAfter(m, injectionPlan(m, l, x, 12 * DAY));
  },

  'lunar-orbit': (site) => {
    const m = mission('lunar-orbit');
    const l = lunarLaunch(m, site, m.epoch);
    const peri = (x: number[]) => closest(replay(injectionPlan(m, l, x, 5 * DAY), world), 'moon');
    const x = tuneInjection(m, l, 3150, (x) => { const p = peri(x); return p ? Math.abs(p.altitude - 150e3) : 1e12; });
    const p0 = peri(x)!;
    const tli = separateAfter(m, injectionPlan(m, l, x, 5 * DAY));
    const tp = p0.t;
    const mk = (dv: number) => ({ ...appendLeg(m, tli, tp, dv, [-1, 0, 0], 'moon'), duration: tp - l.t + 1.5 * DAY });
    const apo = (dv: number) => replay(mk(dv), world).events.find((e) => e.body === 'moon' && e.kind === 'apoapsis' && e.t > p0.t)?.altitude ?? Infinity;
    let lo = 100;
    let hi = 1500;
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
    const lv = asymptoteLaunch(v, site, pv);
    const sv = solveDeparture(v, lv, pv, 'venus', 5000e3);
    return departurePlan(v, lv, sv, sv.tClosest - lv.t + DAY);
  },

  'mars-flyby': (site) => {
    const m = mission('mars-flyby');
    const pm = pork('mars', () => porkchopBest({ departure: 'earth', arrival: 'mars', departureTimes: { start: utcTdb(2028, 10, 1), end: utcTdb(2029, 1, 31), count: 62 }, flightTimes: { start: 150 * DAY, end: 360 * DAY, count: 106 }, arrivalOrbit: { kind: 'flyby' } }));
    const lm = asymptoteLaunch(m, site, pm);
    const sm = solveDeparture(m, lm, pm, 'mars', 3000e3);
    return departurePlan(m, lm, sm, sm.tClosest - lm.t + DAY);
  },

  'mars-orbit': (site) => {
    const m = mission('mars-orbit');
    const p = pork('mars-capture', () => porkchopBest({ departure: 'earth', arrival: 'mars', departureTimes: { start: utcTdb(2028, 10, 1), end: utcTdb(2029, 1, 31), count: 62 }, flightTimes: { start: 150 * DAY, end: 360 * DAY, count: 106 }, arrivalOrbit: { kind: 'capture', altitude: 400e3, eccentricity: 0.7 } }, 'dvTotal'));
    const l = asymptoteLaunch(m, site, p);
    const s = solveDeparture(m, l, p, 'mars', 600e3);
    const tc = solveTcm(m, departurePlan(m, l, s, s.tClosest - l.t + 3 * DAY), 'mars', s.tClosest - 30 * DAY, 500e3, s.tClosest);
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
    const l = asymptoteLaunch(m, site, p);
    const s = solveDeparture(m, l, p, 'venus', f.rpBallistic - f.radius, 1e-11, bAngleFor(f.vInfIn, f.vInfOut));
    const tc = solveTcm(m, departurePlan(m, l, s, ch.times[2] - l.t + 20 * DAY), 'mercury', s.tClosest + 10 * DAY, 5000e3, ch.times[2]);
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
    const l = asymptoteLaunch(m, site, p);
    const s = solveDeparture(m, l, p, 'jupiter', rp - RJ, 1e-11, bAngleFor(vIn, vOut));
    return departurePlan(m, l, s, s.tClosest - l.t + 60 * DAY);
  },

  'jupiter-saturn': (site) => {
    const m = mission('jupiter-saturn');
    const ch = chainJS();
    const f = ch.result.flybys[0];
    const p = chainPoint(ch.result);
    const l = asymptoteLaunch(m, site, p);
    const s = solveDeparture(m, l, p, 'jupiter', f.rpBallistic - f.radius, 1e-11, bAngleFor(f.vInfIn, f.vInfOut));
    const tc = solveTcm(m, departurePlan(m, l, s, ch.times[2] - l.t + 30 * DAY), 'saturn', s.tClosest + 30 * DAY, 50000e3, ch.times[2]);
    return { ...tc.plan, duration: tc.tClosest - l.t + 2 * DAY };
  },
};

/** A solved plan as the literal the campaign tests keep. */
export function solutionLiteral(m: CompleteMission, plan: MissionPlan) {
  const x = fly(m, plan);
  const s = plan.start;
  const goalsOk = x.ev.objectives.filter((o) => o.objective.kind !== 'max-delta-v' && o.objective.kind !== 'max-time').every((o) => o.ok);
  return {
    ok: goalsOk && (x.ev.ruleViolations ?? []).length === 0,
    lit: { params: s.kind === 'launch' ? s.params.slice(0, 3) : [], duration: plan.duration, rtol: plan.rtol, burns: plan.burns, separations: plan.separations ?? [] },
    dv: x.ev.deltaV, ascent: x.ev.ascentDeltaV, flight: x.ev.flightDeltaV, time: x.ev.missionTime, x,
  };
}
