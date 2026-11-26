/**
 * Planner core: the planning aids (run in planner-worker.ts, off the main thread).
 *  - porkchop: Lambert grid in chunks with progress; cancel by message.
 *  - departure: the departure burn for a selected transfer from the real
 *    parking orbit of the current plan (planDeparture), as an ordinary node.
 *  - correct: the differential corrector on one burn of the plan toward a
 *    closest-approach altitude at a body, with the staging that is known to
 *    work, then the corrected plan flown with the scoring replay to measure
 *    the closest approach actually achieved. Cancel: the client terminates.
 *  - chain: flyby-chain plausibility (fixed dates or a date search).
 *
 * Ephemeris: the real ChebyshevEphemeris with the checkpoint asset, seeded
 * with the chunks the main thread's pool built for the job's date range.
 */
import { makeWorld, replay, simulationStartOffset, type MissionPlan } from './mission-layer';
import { missionById } from './missions';
import { addNode, burnToNode, nodesOf, updateNode } from './nodes';
import { BODY_DATA, ReplayEphemeris, type Burn } from './physics';
import { bForPeriapsis, bPlane, computePorkchopAsync, correctBurn, evaluateChain, findBody, flyToTarget, optimizeChain, planDeparture, type BPlaneTarget, type PositionTarget } from './planning-layer';
import type { FlybyTarget, FromPlanner, StageReport, ToPlanner } from './protocol';
import { replayOptions, sandboxSpheres } from './replay-options';
import { bPlaneAim, beforeBurn, measuredClosest, nodeFromAbsBurn, prefixPlan, sideOf, stagingOffsets, toAbsBurn } from './transfer';

const DAY = 86400;
const bodyIdx = (id: string) => findBody(BODY_DATA, id);
const OBLIQUITY = (84381.406 / 3600) * (Math.PI / 180);

class StageFailed extends Error {}

/** B-plane miss (m) at which the close-in stage is accepted even if the time residual has stalled. */
const B_MISS_OK = 5e3;

/** Planning jobs against one ephemeris; results go to `post` (a worker posts them, a test collects them). */
export function plannerCore(eph: ReplayEphemeris, post: (m: FromPlanner, transfer?: Transferable[]) => void) {
const ephem = eph.physics;
const world = makeWorld(ephem, BODY_DATA);
const aborts = new Map<number, AbortController>();

function progress(id: number, done: number, total: number, label: string): void {
  post({ type: 'progress', id, done, total, label });
}

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------

async function porkchop(id: number, req: Extract<ToPlanner, { type: 'porkchop' }>['req']): Promise<void> {
  const ac = new AbortController();
  aborts.set(id, ac);
  const t0 = performance.now();
  try {
    const g = await computePorkchopAsync(ephem, BODY_DATA, {
      departure: req.departure, arrival: req.arrival,
      departureTimes: { start: req.depStart, end: req.depEnd, count: req.nDep },
      arrivalTimes: { start: req.arrStart, end: req.arrEnd, count: req.nArr },
      arrivalOrbit: { kind: 'flyby' },
    }, { signal: ac.signal, chunk: 2000, onProgress: (d, t) => progress(id, d, t, 'Lambert grid') });
    const grid = { nDep: g.nDep, nArr: g.nArr, depTimes: g.depTimes, arrTimes: g.yValues, c3: g.c3, vInfArr: g.vInfArr, dvTotal: g.dvTotal, dla: g.dla, rla: g.rla, theta: g.theta, vInfDep: g.vInfDep };
    post({ type: 'porkchop', id, ms: performance.now() - t0, grid }, [grid.c3.buffer, grid.vInfArr.buffer, grid.dvTotal.buffer, grid.dla.buffer, grid.rla.buffer, grid.theta.buffer, grid.vInfDep.buffer]);
  } finally {
    aborts.delete(id);
  }
}

/** State [x y z vx vy vz m] and time at mission time `until`, flying burns [0, i) with the scoring replay. */
function stateBefore(plan: MissionPlan, i: number, until: number): { y: Float64Array; t: number } {
  const pre = prefixPlan(plan, i, until);
  if (!pre) throw new Error('that burn starts at orbit insertion: move it later to leave room before it');
  const r = replay(pre, world, {});
  if (r.outcome !== 'completed') throw new Error(`the flight before this burn does not complete (${r.outcome}: ${r.reason})`);
  return { y: Float64Array.from(r.finalState), t: r.finalT };
}

function departure(m: Extract<ToPlanner, { type: 'departure' }>): void {
  const t0w = performance.now();
  const plan = m.plan;
  const start = simulationStartOffset(plan.start);
  // Earlier burns that finish well before departure stay; the parking state is read after them.
  const keep = plan.burns.filter((b) => plan.epoch + b.start + b.duration < m.tDep - 2 * 3600);
  const lastEnd = keep.length ? keep[keep.length - 1].start + keep[keep.length - 1].duration : start;
  const until = lastEnd + 60;
  if (plan.epoch + until > m.tDep - 1800) throw new Error('the plan starts too close to (or after) the departure date: launch or start earlier');
  const { y, t } = stateBefore({ ...plan, burns: keep }, keep.length, until);
  const e = plan.spacecraft.engines[0];
  const d = planDeparture(ephem, BODY_DATA, { departure: m.departure, vInf: m.vInf, tDep: m.tDep, parking: y, t0: t, engine: { thrust: e.thrust, isp: e.isp } });
  const b: Burn = d.burn;
  const pb = { start: b.tStart - plan.epoch, duration: b.duration, engine: 0, direction: [b.direction[0], b.direction[1], b.direction[2]] as [number, number, number], frame: { kind: 'orbital' as const, body: m.departure } };
  const node = burnToNode(pb, plan.spacecraft, y[6]);
  const longer = { ...plan, duration: Math.max(plan.duration, m.tArr - plan.epoch + 20 * DAY) };
  const r = addNode(longer, node);
  const info = nodesOf(r.plan)[r.index];
  const mins = info.burn.duration / 60;
  const warning = info.short
    ? `Not enough propellant: this departure needs ${d.dvMag.toFixed(0)} m/s and the burn will run the tanks dry. Refining will not fix that; use a bigger stage.`
    : mins > 30
      ? `This is a ${mins.toFixed(0)}-minute burn: so long a burn loses much of its effect (gravity loss) and the corrector may not converge. A higher-thrust stage works better.`
      : null;
  post({ type: 'departure', id: m.id, plan: r.plan, index: r.index, dv: d.dvMag, asymptoteErrorDeg: (d.asymptoteError * 180) / Math.PI, tImpulse: d.tImpulse, ms: performance.now() - t0w, warning });
}

async function correct(m: Extract<ToPlanner, { type: 'correct' }>): Promise<void> {
  try {
    await correctInner(m);
  } catch (e) {
    if (!(e instanceof StageFailed)) throw e;
    post({ type: 'correct', id: m.id, ok: false, message: `The corrector failed (${e.message}); the plan was left as it was.`, plan: null, stages: [], measured: null, predicted: null, ms: 0 });
  }
}

async function correctInner(m: Extract<ToPlanner, { type: 'correct' }>): Promise<void> {
  const t0w = performance.now();
  const { plan, target } = m;
  const i = m.burn;
  const stages: StageReport[] = [];
  const fail = (message: string) => post({ type: 'correct', id: m.id, ok: false, message, plan: null, stages, measured: null, predicted: null, ms: performance.now() - t0w });
  if (!plan.burns[i]) return fail('no such burn');
  const until = beforeBurn(plan, i);
  if (until === null) return fail('this burn starts right at orbit insertion or at the end of the previous burn; move it later to leave room');
  progress(m.id, 0, 4, 'state before the burn (replay)');
  const { y: y0, t: t0 } = stateBefore(plan, i, until);
  await yieldNow();
  const bi = bodyIdx(target.body);
  const R = BODY_DATA[bi].radius;
  const mu = ephem.gm[bi];
  const soi = sandboxSpheres().find((s) => s.body === target.body)?.radius ?? 1e9;
  const burn0 = toAbsBurn(plan, i, bodyIdx) as Burn;
  const burnEnd = burn0.tStart + burn0.duration;
  // Encounter search ends at the next burn (the corrector flies only this burn) or the end of the plan.
  const next = plan.burns[i + 1];
  const planEnd = plan.epoch + plan.duration;
  let tEnd = next ? plan.epoch + next.start : planEnd;
  if (target.tArr !== null) tEnd = Math.max(tEnd, target.tArr + 30 * DAY);
  // Tighter than the replay's tolerance at most: finite differences need smooth residuals.
  const rtol = Math.min(plan.rtol, 1e-11);
  const fly = (b: Burn, tq: number) => flyToTarget(ephem, bi, y0, t0, tEnd, tq, [b], { searchFrom: burnEnd + 60, rtol, dryMass: plan.spacecraft.dryMass });
  /** A stage, restarted (fresh linearisation) up to twice while it stalls but still improves. */
  const stage = (label: string, b: Burn, tgt: BPlaneTarget | PositionTarget, tolerance: number) => {
    let r = stageOnce(label, b, tgt, tolerance);
    for (let k = 0; k < 2 && !r.converged && !('bt' in tgt && r.history[r.history.length - 1].miss < B_MISS_OK); k++) {
      const before = r.history[r.history.length - 1].miss;
      const again = stageOnce(`${label} (restart ${k + 1})`, r.burn, tgt, tolerance);
      const after = again.history[again.history.length - 1].miss;
      if (!(after < before)) break;
      r = again;
    }
    const ok = (x: typeof r) => x.converged || ('bt' in tgt && x.history[x.history.length - 1].miss < B_MISS_OK);
    if (!ok(r) && 'bt' in tgt && tgt.tPeri !== undefined) {
      // Fallback: the periapsis-time term stalls the line search; solve the B-plane alone, then re-impose the time.
      const free = stageOnce(`${label} (B-plane only)`, r.burn, { ...tgt, tPeri: undefined }, tolerance);
      if (free.history[free.history.length - 1].miss < r.history[r.history.length - 1].miss) {
        r = free;
        const timed = stageOnce(`${label} (re-timed)`, r.burn, tgt, tolerance);
        if (ok(timed) || timed.history[timed.history.length - 1].miss <= r.history[r.history.length - 1].miss) r = timed;
      }
    }
    return r;
  };
  const stageOnce = (label: string, b: Burn, tgt: BPlaneTarget | PositionTarget, tolerance: number) => {
    const s = performance.now();
    let r: ReturnType<typeof correctBurn>;
    try {
      r = correctBurn(ephem, y0, t0, b, tgt, { tolerance, maxIterations: 20, rtol });
    } catch (e) {
      // A trial trajectory the propagator cannot fly (e.g. through the body): this stage failed.
      stages.push({ label, converged: false, miss: NaN, iterations: 0, evaluations: 0, ms: performance.now() - s });
      throw new StageFailed(`${label}: ${/underflow/.test((e as Error).message) ? 'a trial trajectory ran into the body' : (e as Error).message}`);
    }
    const last = r.history[r.history.length - 1];
    stages.push({ label, converged: r.converged || ('bt' in tgt && last.miss < B_MISS_OK), miss: last.miss, iterations: r.history.length - 1, evaluations: r.evaluations, ms: performance.now() - s });
    return r;
  };
  /** Osculating B-plane and v-infinity at epoch tq. */
  const bAt = (b: Burn, tq: number) => {
    const yq = flyToTarget(ephem, bi, y0, t0, tq, tq, [b], { rtol }).y;
    const s = new Float64Array(6);
    ephem.bodyState(bi, tq, s);
    return bPlane([yq[0] - s[0], yq[1] - s[1], yq[2] - s[2]], [yq[3] - s[3], yq[4] - s[4], yq[5] - s[5]], mu);
  };

  let burn = burn0;
  let enc = fly(burn, target.tArr ?? tEnd);
  let tRef = target.tArr ?? enc.tClosest;
  if (!Number.isFinite(tRef)) return fail(`no approach to ${target.body} found before ${next ? 'the next burn' : 'the end of the plan'}`);
  // Stage 0 (far miss, or a fresh Lambert guess): aim at the body's position at the reference time.
  if (target.tArr !== null || enc.closest > soi) {
    progress(m.id, 1, 4, `aim at ${target.body}'s position`);
    await yieldNow();
    // Aim beside the body (10 radii toward ecliptic north), never at its centre: trial trajectories must not pass through it.
    const tol0 = Math.min(20000e3, soi / 10);
    let r0: ReturnType<typeof correctBurn>;
    try {
      r0 = stage('Position at arrival', burn, { kind: 'position', body: bi, epoch: tRef }, tol0);
    } catch (e) {
      if (!(e instanceof StageFailed)) throw e;
      // A trial passed through the body: aim beside it instead (10 radii toward ecliptic north).
      const aside = 10 * R;
      r0 = stage('Position beside the body', burn, { kind: 'position', body: bi, epoch: tRef, offset: [0, -aside * Math.sin(OBLIQUITY), aside * Math.cos(OBLIQUITY)] }, tol0);
    }
    burn = r0.burn;
    if (!(r0.history[r0.history.length - 1].miss < soi)) return fail(`could not bring the trajectory near ${target.body} (still ${(r0.history[r0.history.length - 1].miss / 1e3).toFixed(0)} km off at the arrival time); the plan was left as it was`);
    enc = fly(burn, tRef);
    // Re-anchor on the encounter actually flown (the Lambert date is only a guess for a finite burn in N-body).
    if (Number.isFinite(enc.tClosest) && enc.closest < soi) tRef = enc.tClosest;
  }
  // Stage 1: B-plane well before the encounter, periapsis at the reference time.
  let vinfGuess = 0;
  let side = target.theta;
  {
    const probe = bAt(burn, tRef - 2 * 3600);
    vinfGuess = probe.vinf;
    if (side === null) side = sideOf(probe.bt, probe.br);
  }
  if (!Number.isFinite(vinfGuess)) return fail(`the approach to ${target.body} is not hyperbolic (captured or too slow); the corrector needs a flyby`);
  const off = stagingOffsets(soi, vinfGuess);
  const b = bForPeriapsis(R + target.altitude, vinfGuess, mu);
  const aim = bPlaneAim(b, side);
  progress(m.id, 2, 4, `B-plane ${(off.first / 3600).toFixed(0)} h out`);
  await yieldNow();
  const r1 = stage(`B-plane ${(off.first / 3600).toFixed(1)} h before`, burn, { body: bi, bt: aim.bt, br: aim.br, epoch: tRef - off.first, tPeri: tRef }, 1000);
  burn = r1.burn;
  const e1 = fly(burn, tRef);
  if (!Number.isFinite(e1.tClosest)) return fail('lost the encounter after the first B-plane stage; the plan was left as it was');
  // Stage 2: B-plane close in, at the actual approach time.
  progress(m.id, 3, 4, `B-plane ${(off.second / 3600).toFixed(1)} h out`);
  await yieldNow();
  const vinf2 = bAt(burn, e1.tClosest - off.second).vinf;
  const b2 = Number.isFinite(vinf2) ? bForPeriapsis(R + target.altitude, vinf2, mu) : b;
  const aim2 = bPlaneAim(b2, side);
  const r2 = stage(`B-plane ${(off.second / 3600).toFixed(1)} h before`, burn, { body: bi, bt: aim2.bt, br: aim2.br, epoch: e1.tClosest - off.second, tPeri: e1.tClosest }, 1000);
  // Judged on the B-plane miss: the periapsis-time term only keeps the solution on the approach branch.
  const bMiss = (r: ReturnType<typeof correctBurn>) => r.history[r.history.length - 1].miss;
  if (!(r2.converged || bMiss(r2) < B_MISS_OK)) return fail(`the corrector did not converge (last miss ${(stages[stages.length - 1].miss / 1e3).toFixed(1)} km in the B-plane); the plan was left as it was`);
  burn = r2.burn;
  let e2 = fly(burn, e1.tClosest);
  // Altitude trim: the osculating B-plane maps to periapsis only approximately
  // (third-body pull inside the sphere of influence), so rescale |B| by the
  // ratio of requested to flown periapsis radius and repeat the close stage.
  // Altitude trim: secant on |B| against the flown periapsis radius, using the
  // two trials closest to the request (the B-plane solves are noisy at the km
  // level), keeping the best trial rather than the last.
  const rpWant = R + target.altitude;
  const altTol = Math.max(1000, 0.002 * target.altitude);
  const tried: { b: number; rp: number; burn: Burn; t: number }[] = [];
  if (Number.isFinite(e2.closest)) tried.push({ b: b2, rp: e2.closest, burn, t: e2.tClosest });
  const byErr = () => [...tried].sort((x, y) => Math.abs(x.rp - rpWant) - Math.abs(y.rp - rpWant));
  for (let k = 0; k < 8 && tried.length; k++) {
    const [p0, p1] = byErr();
    if (Math.abs(p0.rp - rpWant) < altTol) break;
    const slope = p1 && p1.rp !== p0.rp ? (p1.b - p0.b) / (p1.rp - p0.rp) : p0.b / p0.rp;
    const bNext = Math.max(0.2 * p0.b, Math.min(5 * p0.b, p0.b - slope * (p0.rp - rpWant)));
    const aimK = bPlaneAim(bNext, side);
    progress(m.id, 3, 4, `altitude trim ${k + 1}`);
    await yieldNow();
    const rk = stage(`Altitude trim ${k + 1}`, p0.burn, { body: bi, bt: aimK.bt, br: aimK.br, epoch: p0.t - off.second, tPeri: p0.t }, 500);
    if (!(rk.converged || bMiss(rk) < B_MISS_OK)) continue;
    const ek = fly(rk.burn, p0.t);
    if (Number.isFinite(ek.closest)) tried.push({ b: bNext, rp: ek.closest, burn: rk.burn, t: ek.tClosest });
  }
  const best = byErr()[0];
  if (!best) return fail(`lost the encounter with ${target.body} while trimming the altitude; the plan was left as it was`);
  burn = best.burn;
  e2 = fly(burn, best.t);
  if (Math.abs(e2.closest - rpWant) > Math.max(10e3, 0.05 * target.altitude)) {
    return fail(`the corrector reached a pass at ${((e2.closest - R) / 1e3).toFixed(0)} km altitude, not the ${(target.altitude / 1e3).toFixed(0)} km altitude requested, and could not trim it closer; the plan was left as it was`);
  }
  // Ordinary node; earlier burns untouched (nodes.updateNode keeps the prefix bit-for-bit).
  const node = nodeFromAbsBurn(plan, i, burn);
  let next2 = updateNode(plan, i, { t: node.t, dv: node.dv }).plan;
  if (plan.epoch + next2.duration < e2.tClosest + DAY) next2 = { ...next2, duration: e2.tClosest + 2 * DAY - plan.epoch };
  progress(m.id, 4, 4, 'replaying the corrected plan');
  await yieldNow();
  const def = missionById(m.missionId)?.def ?? null;
  const rr = replay(next2, world, replayOptions(def));
  const meas = measuredClosest(rr.events, target.body, burnEnd);
  post({
    type: 'correct', id: m.id, ok: true,
    message: meas ? `Closest approach in the replay: ${(meas.altitude / 1e3).toFixed(1)} km altitude${meas.impact ? ' (enters the atmosphere / impacts)' : ''}` : `The replay shows no approach to ${target.body}`,
    plan: next2, stages, measured: meas ? { ...meas, outcome: rr.outcome } : null, predicted: e2.closest - R, ms: performance.now() - t0w,
  });
}

function chain(m: Extract<ToPlanner, { type: 'chain' }>): void {
  const t0 = performance.now();
  if (m.windowDays !== null) {
    const w = m.windowDays * DAY;
    const r = optimizeChain(ephem, BODY_DATA, m.seq, { windows: m.times.map((t) => ({ start: t - w, end: t + w })) });
    post({ type: 'chain', id: m.id, times: r.times, result: r.result, evaluations: r.evaluations, ms: performance.now() - t0 });
  } else {
    const r = evaluateChain(ephem, BODY_DATA, m.seq, m.times);
    post({ type: 'chain', id: m.id, times: m.times, result: r, evaluations: 1, ms: performance.now() - t0 });
  }
}

return { porkchop, departure, correct, chain, aborts };
}
