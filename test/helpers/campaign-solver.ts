/**
 * Tools the campaign solutions (test/mission-campaign*.test.ts) are built
 * with: plans flown exactly as a player's would be (encode -> decode ->
 * replay with the mission's options -> evaluate with conformance), state
 * sampling through the replay hooks, conversion from the planning modules'
 * physics burns, and a small Nelder-Mead minimiser for tuning on the replay.
 * Advisory code (ordinary Math is fine here).
 *
 * VEHICLE LAUNCHES (part three). Every campaign mission launches on its
 * vehicle (rules.vehicle): `launchPlan` builds the vehicle-launch plan, the
 * ascent model (ascent.ts) gives the stage that reaches orbit and what it has
 * left, and `appendLeg` turns a "logical" burn (a delta-v at a time, in a
 * direction) into what the stack can fly: the active stage fires; if it runs
 * dry first, it burns to depletion, separates one second later and the next
 * stage finishes the delta-v in the same direction. Solvers tune delta-v
 * rather than burn durations, so the same solver works whichever stage flies.
 * `separateAfter` drops a stage that still has propellant (the reference
 * solutions drop the upper stage after the departure, so the spacecraft
 * flies the rest). `bestParkingAltitude` picks the parking altitude in the
 * mission's band that minimises the ascent's delta-v plus an analytic
 * estimate of what the flight needs from there.
 */
import { ASCENT_BODIES, computeAscent, massAbove, type AscentResult } from '../../src/mission/ascent';
import { launchGeometry, launchState, launchToParams, launchFromParams } from '../../src/mission/launch';
import { evaluate, missionReplayOptions, type CompleteMission, type Evaluation } from '../../src/mission/objectives';
import { decodePlan, encodePlan, makePlan, type MissionPlan, type PlanBurn, type PlanSeparation, type Stage } from '../../src/mission/plan';
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

const EARTH = J2000_BODIES[J2000_BODIES.findIndex((b) => b.id === 'earth')];
export const MU_EARTH = EARTH.gm;
const G0 = 9.80665;

/** The mission's whole stack: its vehicle's lower stages, then the spacecraft. */
export function stagesOf(m: CompleteMission): Stage[] {
  const V = m.rules.vehicle;
  if (!V) throw new Error(`${m.id}: no launch vehicle`);
  return [...V.lowerStages, m.spacecraft];
}
/** Index of the spacecraft (the top stage). */
export const scIndex = (m: CompleteMission): number => stagesOf(m).length - 1;
const thrustOf = (s: Stage) => s.engines.reduce((a, e) => a + e.thrust, 0);
const flowOf = (s: Stage) => s.engines.reduce((a, e) => a + e.thrust / (e.isp * G0), 0);

/** The ascent of the mission's vehicle for a launch (throws if it cannot reach orbit). */
export function ascentFor(m: CompleteMission, l: LaunchChoice): Extract<AscentResult, { ok: true }> {
  const a = computeAscent(stagesOf(m), { gm: EARTH.gm, radius: EARTH.referenceRadius, altitudeM: l.alt }, launchGeometry(launchSite(l.site), l.t, l.az), ASCENT_BODIES.earth);
  if (!a.ok) throw new Error(`${m.id}: ascent from ${l.site}: ${a.reason}`);
  return a;
}

export function launchPlan(m: CompleteMission, l: LaunchChoice, burns: PlanBurn[], duration: number, separations: PlanSeparation[] = []): MissionPlan {
  return makePlan({
    data: world.fingerprint, epoch: l.t, duration, rtol: 1e-10,
    start: { kind: 'launch', site: l.site, params: launchToParams({ mode: 'parking-orbit', siteId: l.site, launchTime: l.t, azimuthDeg: l.az, altitudeM: l.alt }), ascent: 'vehicle' },
    spacecraft: m.spacecraft, lowerStages: stagesOf(m).slice(0, -1), burns, separations: separations.slice().sort((a, b) => a.time - b.time),
  });
}

/** The launch choice of a launch plan. */
export function choiceOf(p: MissionPlan): LaunchChoice {
  if (p.start.kind !== 'launch') throw new Error('not a launch plan');
  return { site: p.start.site, t: p.start.params[0], az: p.start.params[1], alt: p.start.params[2] };
}

/** Barycentric state with mass at insertion (the vehicle's mass at insertion). */
export function insertion(p: MissionPlan, m?: CompleteMission): { t: number; y: Float64Array } {
  if (p.start.kind !== 'launch') throw new Error('not a launch plan');
  const r = launchState(launchFromParams(p.start.site, p.start.params), eph, J2000_BODIES);
  const y = new Float64Array(7);
  y.set(r.state);
  const stages = [...(p.lowerStages ?? []), p.spacecraft];
  y[6] = stages.length > 1 ? (computeAscent(stages, { gm: EARTH.gm, radius: EARTH.referenceRadius, altitudeM: p.start.params[2] }, launchGeometry(launchSite(p.start.site), p.start.params[0], p.start.params[1]), ASCENT_BODIES.earth) as { massAtInsertion: number }).massAtInsertion : p.spacecraft.wetMass;
  void m;
  return { t: r.t, y };
}

/** Replay a plan up to absolute time t (burns and separations after t dropped); returns the state there. */
export function stateAt(p: MissionPlan, t: number): Float64Array {
  const r = replay({ ...p, duration: t - p.epoch, burns: p.burns.filter((b) => b.start < t - p.epoch), ...(p.separations ? { separations: p.separations.filter((x) => x.time < t - p.epoch) } : {}) }, world);
  if (r.outcome !== 'completed') throw new Error(`stateAt: ${r.outcome} ${r.reason}`);
  return Float64Array.from(r.finalState);
}

/**
 * Stage active at absolute time t and the stack's mass then, from the plan's
 * own bookkeeping (exact: burns drain mass linearly at the stage's flow, a
 * separation leaves the stages above; assumes no burn runs a tank dry).
 */
export function stackAt(m: CompleteMission, p: MissionPlan, t: number): { stage: number; mass: number; propellant: number } {
  const stages = stagesOf(m);
  const a = ascentFor(m, choiceOf(p));
  let k = a.upperStage;
  let mass = a.massAtInsertion;
  const acts = [...p.burns.map((b) => ({ t: b.start, b })), ...(p.separations ?? []).map((x) => ({ t: x.time, b: null as PlanBurn | null }))].sort((x, y) => x.t - y.t || (x.b ? 1 : -1));
  for (const x of acts) {
    if (p.epoch + x.t >= t) break;
    if (x.b === null) { mass = massAbove(stages, k); k++; continue; }
    const st = stages[x.b.stage ?? stages.length - 1];
    const dur = Math.min(x.b.duration, (t - p.epoch) - x.b.start);
    mass -= flowOf(st) * dur;
  }
  return { stage: k, mass, propellant: mass - massAbove(stages, k) - stages[k].dryMass };
}

/** Delta-v the active stage can still give at absolute time t, m/s. */
export function stageDvLeft(m: CompleteMission, p: MissionPlan, t: number): number {
  const s = stackAt(m, p, t);
  const st = stagesOf(m)[s.stage];
  const ve = thrustOf(st) / flowOf(st);
  return ve * Math.log(s.mass / (s.mass - s.propellant));
}

export interface LegOptions {
  /** True (default): centre the burn (all its pieces) on tc; false: start at tc. */
  centre?: boolean;
}

/**
 * Append a logical burn of `dv` m/s in direction `dir` (orbital frame of
 * `body`), centred on (or starting at) absolute time tc: the active stage
 * fires; if it runs dry, it burns to depletion, a separation follows 1 s
 * later, and the next stage finishes in the same direction.
 */
export function appendLeg(m: CompleteMission, p: MissionPlan, tc: number, dv: number, dir: readonly number[], body = 'earth', o: LegOptions = {}): MissionPlan {
  const stages = stagesOf(m);
  const s0 = stackAt(m, p, tc);
  const pieces: { stage: number; dur: number }[] = [];
  let k = s0.stage;
  let mass = s0.mass;
  let prop = s0.propellant;
  let left = dv;
  while (left > 1e-9) {
    const st = stages[k];
    const ve = thrustOf(st) / flowOf(st);
    const cap = ve * Math.log(mass / (mass - prop));
    if (left <= cap || k === stages.length - 1) {
      pieces.push({ stage: k, dur: (mass * (1 - Math.exp(-left / ve))) / flowOf(st) });
      break;
    }
    pieces.push({ stage: k, dur: prop / flowOf(st) });
    left -= cap;
    mass = massAbove(stages, k);
    k++;
    prop = stages[k].wetMass - stages[k].dryMass;
  }
  const total = pieces.reduce((a, x) => a + x.dur, 0) + (pieces.length - 1);
  let t = (o.centre ?? true ? tc - total / 2 : tc) - p.epoch;
  const burns = p.burns.slice();
  const seps = (p.separations ?? []).slice();
  pieces.forEach((x, i) => {
    if (i > 0) { seps.push({ time: t }); }
    burns.push({ start: t, duration: x.dur, stage: x.stage, engine: 0, direction: [dir[0], dir[1], dir[2]], frame: { kind: 'orbital', body } });
    t += x.dur + 1;
  });
  return { ...p, burns: burns.sort((a, b) => a.start - b.start), separations: seps.sort((a, b) => a.time - b.time) };
}

/** Separate the active stage `after` s after the last burn ends (no-op if the spacecraft is already active). */
export function separateAfter(m: CompleteMission, p: MissionPlan, after = 600): MissionPlan {
  const last = p.burns[p.burns.length - 1];
  const t = last ? last.start + last.duration + after : simulationStart(p) + after;
  if (stackAt(m, p, p.epoch + t).stage === scIndex(m)) return p;
  return { ...p, separations: [...(p.separations ?? []), { time: t }].sort((a, b) => a.time - b.time) };
}
const simulationStart = (p: MissionPlan) => (p.start.kind === 'launch' ? (p.start.params[3] ?? 540) : 0);

/**
 * Parking altitude in the mission's band (5 km grid) minimising the ascent's
 * delta-v plus `flightDv(alt)`, an analytic estimate of the flight's cost from
 * that orbit. Returns the altitude and the costs it compared.
 */
export function bestParkingAltitude(m: CompleteMission, l: Omit<LaunchChoice, 'alt'>, flightDv: (altM: number) => number): { alt: number; ascent: number; flight: number } {
  const [lo, hi] = m.rules.vehicle!.altitude;
  let best = { alt: lo, ascent: Infinity, flight: Infinity };
  for (let h = lo; h <= hi + 1; h += 5e3) {
    let a: number;
    try { a = ascentFor(m, { ...l, alt: h }).deltaV; } catch { continue; }
    const f = flightDv(h);
    if (a + f < best.ascent + best.flight) best = { alt: h, ascent: a, flight: f };
  }
  return best;
}

/** Impulsive departure from a circular orbit at altitude h to excess speed vInf (m/s; vInf^2 may be negative: C3 < 0). */
export function departureDv(h: number, c3: number): number {
  const r = EARTH.referenceRadius + h;
  return Math.sqrt(c3 + (2 * MU_EARTH) / r) - Math.sqrt(MU_EARTH / r);
}

/** A physics burn (absolute time, body index frame) as a plan burn (stage absent: the spacecraft). */
export function planBurn(epoch: number, b: Burn, engine = 0, stage?: number): PlanBurn {
  const frame: PlanBurn['frame'] = b.frame.kind === 'orbital' ? { kind: 'orbital', body: J2000_BODIES[b.frame.body].id } : { kind: 'inertial' };
  const base = { start: b.tStart - epoch, duration: b.duration, engine, direction: [b.direction[0], b.direction[1], b.direction[2]] as [number, number, number], frame };
  return stage === undefined ? base : { ...base, stage };
}

/** A plan burn as a physics burn for the planning modules. */
export function physicsBurn(epoch: number, b: PlanBurn, m: CompleteMission): Burn {
  const e = (b.stage === undefined ? m.spacecraft : stagesOf(m)[b.stage]).engines[b.engine];
  return { tStart: epoch + b.start, duration: b.duration, thrust: e.thrust, isp: e.isp, direction: [b.direction[0], b.direction[1], b.direction[2]], frame: b.frame.kind === 'orbital' ? { kind: 'orbital', body: bodyIdx(b.frame.body) } : { kind: 'inertial' } };
}

/** Fly as a player's shared plan is scored. */
export function fly(m: CompleteMission, p: MissionPlan): { r: ReplayResult; ev: Evaluation } {
  const shared = decodePlan(encodePlan(p));
  const r = replay(shared, world, missionReplayOptions(m));
  return { r, ev: evaluate(m, r, world, shared.epoch, shared) };
}

export function describeRun(m: CompleteMission, x: { r: ReplayResult; ev: Evaluation }): string {
  const st = x.r.stages.map((s) => `[${s.stage}: dv ${s.deltaV.toFixed(0)} left ${s.propellantLeft.toFixed(0)} kg${s.separatedAt !== null ? ` sep ${s.separatedAt.toFixed(0)}` : ''}]`).join(' ');
  return `${m.id}: ${x.r.outcome} ${x.r.reason} success=${x.ev.success} dv=${x.ev.deltaV.toFixed(1)} (ascent ${x.ev.ascentDeltaV.toFixed(1)} + flight ${x.ev.flightDeltaV.toFixed(1)}) ${st} t=${(x.ev.missionTime / DAY).toFixed(3)} d score=${x.ev.score} steps=${x.r.steps}\n  ` +
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
export function matchVelocity(m: CompleteMission, p: MissionPlan, body: string, tc: number, target: (rel: number[]) => V, iters = 6): MissionPlan {
  const rel0 = relState(p, body, tc);
  let dvVec = target(rel0).map((x, k) => x - rel0[3 + k]);
  let plan = p;
  for (let it = 0; it < iters; it++) {
    const dir = toOrbital(rel0, dvVec);
    plan = appendLeg(m, p, tc, norm(dvVec), dir, body);
    const lb = plan.burns[plan.burns.length - 1];
    const tAfter = plan.epoch + lb.start + lb.duration + 1;
    const relA = relState({ ...plan, duration: Math.max(plan.duration, tAfter - plan.epoch + 1) }, body, tAfter);
    const res = target(relA).map((x, k) => x - relA[3 + k]);
    if (norm(res) < 0.02) break;
    // Residual measured after the burn; add it in the inertial frame (frame rotates slowly over a burn).
    dvVec = dvVec.map((x, k) => x + res[k]);
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
 * Depart for `target` along a porkchop point and correct the departure (position,
 * then B-plane, then B-plane near closest approach) to a periapsis altitude
 * `aimAlt`. The vehicle's upper stage flies the departure; if it cannot give it
 * all (its reserve at insertion is short), it burns to depletion, separates,
 * and the spacecraft's burn that finishes the departure is the one corrected.
 * Either way the upper stage is dropped 600 s after the departure (the
 * spacecraft flies everything later). Returns the plan's burns and
 * separations and the predicted closest approach.
 */
export function solveDeparture(m: CompleteMission, l: LaunchChoice, p: PorkchopPoint, target: string, aimAlt: number, rtol = 1e-11, br = 0) {
  const plan0 = launchPlan(m, l, [], 1);
  const ins = insertion(plan0);
  const asc = ascentFor(m, l);
  const stages = stagesOf(m);
  const U = asc.upperStage;
  const SC = stages.length - 1;
  const ti = bodyIdx(target);
  const eU = { thrust: thrustOf(stages[U]), isp: thrustOf(stages[U]) / flowOf(stages[U]) / G0 };
  const eS = { thrust: thrustOf(stages[SC]), isp: thrustOf(stages[SC]) / flowOf(stages[SC]) / G0 };
  const dep = planDeparture(eph, J2000_BODIES, { departure: 'earth', vInf: p.vInfDepVec, tDep: p.tDep, parking: ins.y, t0: ins.t, engine: eU, propagateOptions: { rtol } });
  const R = J2000_BODIES[ti].referenceRadius;
  const vinf = Math.hypot(...p.vInfArrVec);
  const b = bForPeriapsis(R + aimAlt, vinf, eph.gm[ti]);
  const side = unitv(cross(p.vInfArrVec, [0, 0, 1])).map((x) => x * Math.max(b, 3 * R)) as [number, number, number];
  const correct = (y0: Float64Array, t0: number, burn0: Burn) => {
    const r0 = correctBurn(eph, y0, t0, burn0, { kind: 'position', body: ti, epoch: p.tArr, offset: side }, { tolerance: 20000e3, rtol });
    const r1 = correctBurn(eph, y0, t0, r0.burn, { body: ti, bt: b * Math.cos(br), br: b * Math.sin(br), epoch: p.tArr - 5 * DAY, tPeri: p.tArr }, { tolerance: 1000, rtol });
    let r2 = r1;
    let e2 = flyToTarget(eph, ti, y0, t0, p.tArr + 30 * DAY, p.tArr, [r1.burn], { searchFrom: p.tArr - 60 * DAY, rtol });
    // Near closest approach, repeated while the periapsis is off by > 20 km.
    for (let k = 0; k < 4 && Math.abs(e2.closest - R - aimAlt) > 20e3; k++) {
      r2 = correctBurn(eph, y0, t0, r2.burn, { body: ti, bt: b * Math.cos(br), br: b * Math.sin(br), epoch: e2.tClosest - 0.5 * DAY, tPeri: e2.tClosest }, { tolerance: 1000, rtol });
      e2 = flyToTarget(eph, ti, y0, t0, p.tArr + 30 * DAY, p.tArr, [r2.burn], { searchFrom: p.tArr - 60 * DAY, rtol });
    }
    return { r2, e2 };
  };
  const mdotU = flowOf(stages[U]);
  if (dep.burn.tStart < ins.t + 60) throw new Error('departure burn before insertion: launch earlier');
  if (dep.burn.duration * mdotU <= 0.99 * asc.upperPropellant) {
    // The upper stage has enough: correct its burn, then drop it.
    const { r2, e2 } = correct(ins.y, ins.t, dep.burn);
    if (r2.burn.duration * mdotU > asc.upperPropellant) throw new Error('corrected departure needs more than the upper stage holds');
    const burns = [planBurn(l.t, r2.burn, 0, U)];
    const separations = [{ time: r2.burn.tStart + r2.burn.duration - l.t + 600 }];
    return { burns, separations, split: false, converged: r2.converged, closestAlt: e2.closest - R, tClosest: e2.tClosest, dvImpulsive: dep.dvMag };
  }
  // Split: the upper stage burns to depletion, separates 1 s later, and the spacecraft finishes.
  const veU = eU.isp * G0;
  const dU = asc.upperPropellant / mdotU;
  const dvU = veU * Math.log(asc.massAtInsertion / (asc.massAtInsertion - asc.upperPropellant));
  const veS = eS.isp * G0;
  // Aim first as if the upper stage could fly it all (direction and centre), then split that burn:
  // the spacecraft gives what the upper stage's propellant cannot.
  const whole = correct(ins.y, ins.t, dep.burn).r2.burn;
  const dvWhole = veU * Math.log(asc.massAtInsertion / (asc.massAtInsertion - mdotU * whole.duration));
  const dvS = Math.max(10, dvWhole - dvU);
  const dS = burnTime(stages[SC].wetMass, dvS, eS.thrust, eS.isp);
  const tc = whole.tStart + whole.duration / 2;
  const tStart = tc - (dU + 1 + dS) / 2;
  if (tStart < ins.t + 60) throw new Error('departure burn before insertion: launch earlier');
  void veS;
  const burnU = { ...whole, tStart, duration: dU, thrust: eU.thrust, isp: eU.isp };
  const tSep = tStart + dU + 1;
  const withU = launchPlan(m, l, [planBurn(l.t, burnU, 0, U)], tSep - l.t + 1, [{ time: tSep - l.t }]);
  const yS = stateAt(withU, tSep);
  // After the separation only the spacecraft is left (unfired: its wet mass).
  yS[6] = stages[SC].wetMass;
  // The spacecraft's burn starts a minute after the separation (room for the corrector to move it earlier).
  const burnS0: Burn = { ...whole, tStart: tSep + 60, duration: dS, thrust: eS.thrust, isp: eS.isp };
  const { r2, e2 } = correct(yS, tSep, burnS0);
  if (r2.burn.tStart < tSep) throw new Error('spacecraft burn moved before the separation');
  const burns = [planBurn(l.t, burnU, 0, U), planBurn(l.t, r2.burn, 0, SC)];
  return { burns, separations: [{ time: tSep - l.t }], split: true, converged: r2.converged, closestAlt: e2.closest - R, tClosest: e2.tClosest, dvImpulsive: dep.dvMag };
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
  return { plan: { ...plan, burns: [...plan.burns, planBurn(plan.epoch, best.burn, engine, scIndex(m))] }, closestAlt: best.alt, tClosest: best.t };
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
