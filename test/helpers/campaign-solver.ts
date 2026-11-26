/**
 * Tools the campaign solutions (test/mission-campaign*.test.ts) are built
 * with: plans flown exactly as a player's would be (encode -> decode ->
 * replay with the mission's options -> evaluate with conformance), state
 * sampling through the replay hooks, conversion from the planning modules'
 * physics burns, and a small Nelder-Mead minimiser for tuning on the replay.
 * Advisory code (ordinary Math is fine here).
 */
import { launchState, launchToParams, launchFromParams } from '../../src/mission/launch';
import { evaluate, missionReplayOptions, type CompleteMission, type Evaluation } from '../../src/mission/objectives';
import { decodePlan, encodePlan, makePlan, type MissionPlan, type PlanBurn } from '../../src/mission/plan';
import { replay, type ReplayResult } from '../../src/mission/replay';
import { J2000_BODIES } from '../../src/physics/solar-system';
import type { Burn } from '../../src/physics/spacecraft';
import { realWorld } from './real-world';
import { bodyPoleAt } from '../../src/mission/world';

export const { eph, world } = realWorld();
export const DAY = 86400;
export const bodyIdx = (id: string) => J2000_BODIES.findIndex((b) => b.id === id);
/** Reference radius (altitude zero) of a body. */
export const refRadius = (id: string) => J2000_BODIES[bodyIdx(id)].referenceRadius;
/** A body's pole at t as the physics (and the orbit objective) uses it. */
export function poleAt(id: string, t: number): number[] {
  const out = [0, 0, 1];
  bodyPoleAt(world, bodyIdx(id), t, out);
  return out;
}

export interface LaunchChoice { site: string; t: number; az: number; alt: number }

export function launchPlan(m: CompleteMission, l: LaunchChoice, burns: PlanBurn[], duration: number): MissionPlan {
  return makePlan({
    data: world.fingerprint, epoch: l.t, duration, rtol: 1e-10,
    start: { kind: 'launch', site: l.site, params: launchToParams({ mode: 'parking-orbit', siteId: l.site, launchTime: l.t, azimuthDeg: l.az, altitudeM: l.alt }) },
    spacecraft: m.spacecraft, burns,
  });
}

/** Barycentric state with mass at insertion. */
export function insertion(p: MissionPlan): { t: number; y: Float64Array } {
  if (p.start.kind !== 'launch') throw new Error('not a launch plan');
  const r = launchState(launchFromParams(p.start.site, p.start.params), eph, J2000_BODIES);
  const y = new Float64Array(7);
  y.set(r.state);
  y[6] = p.spacecraft.wetMass;
  return { t: r.t, y };
}

/** Replay a plan up to absolute time t (burns after t dropped); returns the state there. */
export function stateAt(p: MissionPlan, t: number): Float64Array {
  const r = replay({ ...p, duration: t - p.epoch, burns: p.burns.filter((b) => b.start < t - p.epoch) }, world);
  if (r.outcome !== 'completed') throw new Error(`stateAt: ${r.outcome} ${r.reason}`);
  return Float64Array.from(r.finalState);
}

/** A physics burn (absolute time, body index frame) as a plan burn. */
export function planBurn(epoch: number, b: Burn, engine = 0): PlanBurn {
  const frame: PlanBurn['frame'] = b.frame.kind === 'orbital' ? { kind: 'orbital', body: J2000_BODIES[b.frame.body].id } : { kind: 'inertial' };
  return { start: b.tStart - epoch, duration: b.duration, engine, direction: [b.direction[0], b.direction[1], b.direction[2]], frame };
}

/** A plan burn as a physics burn for the planning modules. */
export function physicsBurn(epoch: number, b: PlanBurn, m: CompleteMission): Burn {
  const e = m.spacecraft.engines[b.engine];
  return { tStart: epoch + b.start, duration: b.duration, thrust: e.thrust, isp: e.isp, direction: [b.direction[0], b.direction[1], b.direction[2]], frame: b.frame.kind === 'orbital' ? { kind: 'orbital', body: bodyIdx(b.frame.body) } : { kind: 'inertial' } };
}

/** Fly as a player's shared plan is scored. */
export function fly(m: CompleteMission, p: MissionPlan): { r: ReplayResult; ev: Evaluation } {
  const shared = decodePlan(encodePlan(p));
  const r = replay(shared, world, missionReplayOptions(m));
  return { r, ev: evaluate(m, r, world, shared.epoch, shared) };
}

export function describeRun(m: CompleteMission, x: { r: ReplayResult; ev: Evaluation }): string {
  return `${m.id}: ${x.r.outcome} ${x.r.reason} success=${x.ev.success} dv=${x.ev.deltaV.toFixed(1)} t=${(x.ev.missionTime / DAY).toFixed(3)} d score=${x.ev.score} steps=${x.r.steps}\n  ` +
    x.ev.objectives.map((o) => `${o.ok ? 'ok' : 'NO'} ${o.objective.kind}: ${o.detail}`).join('\n  ') + (x.ev.ruleViolations?.length ? `\n  rules: ${x.ev.ruleViolations.join('; ')}` : '');
}

/** Closest periapsis event of `body` in a result (after t), or null. */
export function closest(r: ReplayResult, body: string, after = -Infinity) {
  let best: (typeof r.events)[number] | null = null;
  for (const e of r.events) if (e.body === body && e.kind === 'periapsis' && e.t > after && (best === null || e.distance < best.distance)) best = e;
  return best;
}

/** Nelder-Mead minimiser. */
export function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], iters = 200, tol = 1e-9): { x: number[]; f: number } {
  const n = x0.length;
  let pts = [x0.slice(), ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step[j] : v)))];
  let vals = pts.map(f);
  for (let it = 0; it < iters; it++) {
    const ord = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    pts = ord.map((i) => pts[i]);
    vals = ord.map((i) => vals[i]);
    if (Math.abs(vals[n] - vals[0]) <= tol * (Math.abs(vals[0]) + tol)) break;
    const c = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
    const at = (k: number) => c.map((v, j) => v + k * (pts[n][j] - v));
    const xr = at(-1);
    const fr = f(xr);
    if (fr < vals[0]) {
      const xe = at(-2);
      const fe = f(xe);
      if (fe < fr) { pts[n] = xe; vals[n] = fe; } else { pts[n] = xr; vals[n] = fr; }
    } else if (fr < vals[n - 1]) { pts[n] = xr; vals[n] = fr; }
    else {
      const xc = at(fr < vals[n] ? -0.5 : 0.5);
      const fc = f(xc);
      if (fc < Math.min(fr, vals[n])) { pts[n] = xc; vals[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) { pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j])); vals[i] = f(pts[i]); }
      }
    }
  }
  const b = vals.indexOf(Math.min(...vals));
  return { x: pts[b], f: vals[b] };
}

type V = readonly number[];
export const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V) => Math.sqrt(dot(a, a));
export const unitv = (a: V) => a.map((x) => x / norm(a));

/** Body-relative state at absolute t of a flying plan. */
export function relState(p: MissionPlan, body: string, t: number): number[] {
  const y = stateAt(p, t);
  const bs = new Float64Array(6);
  eph.bodyState(bodyIdx(body), t, bs);
  return [0, 1, 2, 3, 4, 5].map((k) => y[k] - bs[k]);
}

/** A vector (inertial) in the (prograde, normal, radial-out) frame of a relative state. */
export function toOrbital(rel: number[], d: V): [number, number, number] {
  const r = rel.slice(0, 3);
  const v = rel.slice(3, 6);
  const p = unitv(v);
  const n = unitv(cross(r, v));
  const o = cross(p, n);
  return [dot(d, p), dot(d, n), dot(d, o)];
}

/** Burn duration (s) for delta-v dv from mass m0 with an engine. */
export function burnTime(m0: number, dv: number, thrust: number, isp: number): number {
  const ve = isp * 9.80665;
  return ((m0 * ve) / thrust) * (1 - Math.exp(-dv / ve));
}

/**
 * Append a burn centred on absolute time tc (orbital frame of `body`) that
 * turns the velocity into `target(rel)` (a function of the body-relative state
 * there), refined by fixed-point iteration on the flown state after the burn.
 */
export function matchVelocity(m: CompleteMission, p: MissionPlan, body: string, tc: number, target: (rel: number[]) => V, engine = 0, iters = 6): MissionPlan {
  const e = m.spacecraft.engines[engine];
  const rel0 = relState(p, body, tc);
  let dvVec = target(rel0).map((x, k) => x - rel0[3 + k]);
  let mass = stateAt(p, tc)[6];
  let plan = p;
  for (let it = 0; it < iters; it++) {
    const dur = burnTime(mass, norm(dvVec), e.thrust, e.isp);
    const dir = toOrbital(rel0, dvVec);
    plan = { ...p, burns: [...p.burns, { start: tc - p.epoch - dur / 2, duration: dur, engine, direction: dir, frame: { kind: 'orbital', body } }] };
    const tAfter = tc + dur / 2 + 1;
    const relA = relState({ ...plan, duration: Math.max(plan.duration, tAfter - plan.epoch + 1) }, body, tAfter);
    const res = target(relA).map((x, k) => x - relA[3 + k]);
    if (norm(res) < 0.02) break;
    // Residual measured after the burn; add it in the inertial frame (frame rotates slowly over a burn).
    dvVec = dvVec.map((x, k) => x + res[k]);
    mass = stateAt(p, tc)[6];
  }
  return plan;
}

// ------------------------------------------------------------ interplanetary
import { asymptotePlaneNormals, launchSite, planeCrossings } from '../../src/mission/launch';
import { bForPeriapsis, correctBurn } from '../../src/planning/corrector';
import { flyToTarget, planDeparture } from '../../src/planning/departure';
import { gridMinimum, PorkchopJob, type PorkchopPoint, type PorkchopSpec } from '../../src/planning/porkchop';

/** Cheapest porkchop point by departure C3 (or total delta-v). */
export function porkchopBest(spec: PorkchopSpec, by: 'c3' | 'dvTotal' = 'c3'): PorkchopPoint {
  const job = new PorkchopJob(eph, J2000_BODIES, spec);
  job.step(job.total);
  const g = job.grid;
  const k = gridMinimum(by === 'c3' ? g.c3 : g.dvTotal).index;
  const i = k % g.nDep;
  const j = (k - i) / g.nDep;
  const tDep = g.depTimes[i];
  const tArr = g.yMode === 'arrival' ? g.yValues[j] : tDep + g.yValues[j];
  return job.point(tDep, tArr)!;
}

/**
 * A launch whose parking plane contains the departure asymptote, lifting off
 * 1.5-24 h before the porkchop departure: tries inclinations upward from the
 * site latitude and both plane solutions; the azimuth must be in the corridor.
 */
export function launchForAsymptote(site: string, vInf: number[], tDep: number, alt = 200e3): LaunchChoice {
  const s = launchSite(site);
  for (let inc = Math.ceil(Math.abs(s.latDeg)) + 0.5; inc < 90; inc += 1) {
    for (const n of asymptotePlaneNormals(vInf, inc, tDep)) {
      // Prograde planes only (normal has a +z component).
      if (n[2] <= 0) continue;
      const c = planeCrossings(s, n, tDep - 24 * 3600, tDep - 1.5 * 3600).filter((x) => x.azimuthAllowed);
      if (c.length > 0) return { site, t: c[c.length - 1].t, az: c[c.length - 1].azimuthDeg, alt };
    }
  }
  throw new Error('no launch for this asymptote');
}

/**
 * Depart for `target` along a porkchop point and correct the departure burn
 * (position, then B-plane, then B-plane near closest approach) to a periapsis
 * altitude `aimAlt`. Returns the plan burn and the predicted closest approach.
 */
export function solveDeparture(m: CompleteMission, l: LaunchChoice, p: PorkchopPoint, target: string, aimAlt: number, rtol = 1e-11, br = 0) {
  const plan0 = launchPlan(m, l, [], 1);
  const ins = insertion(plan0);
  const ti = bodyIdx(target);
  const e = m.spacecraft.engines[0];
  const dep = planDeparture(eph, J2000_BODIES, { departure: 'earth', vInf: p.vInfDepVec, tDep: p.tDep, parking: ins.y, t0: ins.t, engine: e, propagateOptions: { rtol } });
  if (dep.burn.tStart < ins.t + 60) throw new Error('departure burn before insertion: launch earlier');
  const R = J2000_BODIES[ti].referenceRadius;
  const vinf = Math.hypot(...p.vInfArrVec);
  const b = bForPeriapsis(R + aimAlt, vinf, eph.gm[ti]);
  // Phase 0 aims beside the body (aiming at its centre can fly an iterate through it).
  const side = unitv(cross(p.vInfArrVec, [0, 0, 1])).map((x) => x * Math.max(b, 3 * R)) as [number, number, number];
  const r0 = correctBurn(eph, ins.y, ins.t, dep.burn, { kind: 'position', body: ti, epoch: p.tArr, offset: side }, { tolerance: 20000e3, rtol });
  const r1 = correctBurn(eph, ins.y, ins.t, r0.burn, { body: ti, bt: b * Math.cos(br), br: b * Math.sin(br), epoch: p.tArr - 5 * DAY, tPeri: p.tArr }, { tolerance: 1000, rtol });
  const e1 = flyToTarget(eph, ti, ins.y, ins.t, p.tArr + 30 * DAY, p.tArr, [r1.burn], { searchFrom: p.tArr - 60 * DAY, rtol });
  let r2 = r1;
  let e2 = e1;
  // Near closest approach, repeated while the periapsis is off by > 20 km.
  for (let k = 0; k < 4 && Math.abs(e2.closest - R - aimAlt) > 20e3; k++) {
    r2 = correctBurn(eph, ins.y, ins.t, r2.burn, { body: ti, bt: b * Math.cos(br), br: b * Math.sin(br), epoch: e2.tClosest - 0.5 * DAY, tPeri: e2.tClosest }, { tolerance: 1000, rtol });
    e2 = flyToTarget(eph, ti, ins.y, ins.t, p.tArr + 30 * DAY, p.tArr, [r2.burn], { searchFrom: p.tArr - 60 * DAY, rtol });
  }
  return { burn: planBurn(l.t, r2.burn), converged: r2.converged, closestAlt: e2.closest - R, tClosest: e2.tClosest, dvImpulsive: dep.dvMag };
}

/**
 * Midcourse correction: a small inertial burn at tTcm (engine `engine`)
 * corrected so the flyby of `target` has periapsis altitude aimAlt near tPeri.
 * Tries a few starting directions; returns the plan with the burn appended.
 */
export function solveTcm(m: CompleteMission, plan: MissionPlan, target: string, tTcm: number, aimAlt: number, tPeri: number, engine = 0, br = 0, rtol = 1e-11): { plan: MissionPlan; closestAlt: number; tClosest: number } {
  const y0 = stateAt(plan, tTcm);
  const ti = bodyIdx(target);
  const R = J2000_BODIES[ti].referenceRadius;
  const e = m.spacecraft.engines[engine];
  // Approach velocity relative to the target a few days out (v-infinity estimate and B-plane direction).
  const pre = flyToTarget(eph, ti, y0, tTcm, tPeri + 20 * DAY, tPeri, [], { searchFrom: tPeri - 40 * DAY, rtol });
  const tq = Math.max(tTcm + 1, pre.tClosest - 5 * DAY);
  const yq = stateAt(plan, tq);
  const bq = new Float64Array(6);
  eph.bodyState(ti, tq, bq);
  const vRel = [yq[3] - bq[3], yq[4] - bq[4], yq[5] - bq[5]];
  const vinf = norm(vRel);
  const b = bForPeriapsis(R + aimAlt, vinf, eph.gm[ti]);
  const side = unitv(cross(vRel, [0, 0, 1])).map((x) => x * b) as [number, number, number];
  let best: { burn: Burn; alt: number; t: number } | null = null;
  const dirs: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const d of dirs) {
    const burn0: Burn = { tStart: tTcm + 60, duration: burnTime(y0[6], 2, e.thrust, e.isp), thrust: e.thrust, isp: e.isp, direction: d, frame: { kind: 'inertial' } };
    try {
      let r = correctBurn(eph, y0, tTcm, burn0, { kind: 'position', body: ti, epoch: pre.tClosest, offset: side }, { tolerance: Math.max(0.1 * b, 3 * R), rtol, fdDuration: 0.001 });
      let enc = flyToTarget(eph, ti, y0, tTcm, tPeri + 20 * DAY, tPeri, [r.burn], { searchFrom: tPeri - 40 * DAY, rtol });
      for (let k = 0; k < 12 && Math.abs(enc.closest - R - aimAlt) > 10e3; k++) {
        r = correctBurn(eph, y0, tTcm, r.burn, { body: ti, bt: b * Math.cos(br), br: b * Math.sin(br), epoch: enc.tClosest - 0.5 * DAY, tPeri: enc.tClosest }, { tolerance: 500, rtol, fdDuration: 0.001 });
        enc = flyToTarget(eph, ti, y0, tTcm, tPeri + 20 * DAY, tPeri, [r.burn], { searchFrom: tPeri - 40 * DAY, rtol });
      }
      const alt = enc.closest - R;
      if (r.burn.duration > 0 && (best === null || Math.abs(alt - aimAlt) < Math.abs(best.alt - aimAlt) - 1e3 || (Math.abs(alt - aimAlt) < 20e3 && r.burn.duration < best.burn.duration))) best = { burn: r.burn, alt, t: enc.tClosest };
      if (best && Math.abs(best.alt - aimAlt) < 10e3) break;
    } catch { /* this start diverged; try the next */ }
  }
  if (!best) throw new Error('TCM did not converge');
  return { plan: { ...plan, burns: [...plan.burns, planBurn(plan.epoch, best.burn, engine)] }, closestAlt: best.alt, tClosest: best.t };
}


import { ECLIPTIC_POLE_ICRF } from '../../src/planning/kepler';
import type { ChainResult } from '../../src/planning/flyby';

/** B-plane angle (atan2(B.R, B.T), bPlane's ecliptic convention) that turns vIn toward vOut. */
export function bAngleFor(vIn: number[], vOut: number[]): number {
  const S = unitv(vIn);
  const k = dot(vOut, S);
  const Bh = unitv(vOut.map((x, i) => -(x - k * S[i])));
  const T = unitv(cross(S, ECLIPTIC_POLE_ICRF as number[]));
  const R = cross(S, T);
  return Math.atan2(dot(Bh, R), dot(Bh, T));
}

/** A porkchop-like point for the first leg of a chain. */
export function chainPoint(c: ChainResult): PorkchopPoint {
  const leg = c.legs[0];
  const vIn = c.flybys.length > 0 ? c.flybys[0].vInfIn : ([NaN, NaN, NaN] as [number, number, number]);
  return { tDep: leg.t0, tArr: leg.t1, vInfDepVec: c.departureVInf, vInfArrVec: vIn } as unknown as PorkchopPoint;
}
