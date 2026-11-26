/**
 * The editor's three sample missions are solvable in the REAL ephemeris world
 * (not the simplified worlds the samples were authored on), flown through
 * exactly the path the game uses: maneuver nodes -> plan (src/app/nodes.ts)
 * -> share link round trip -> replay in the mission layer with the canonical
 * options (replay-options.ts) -> objectives evaluator.
 *
 * These are the author's solutions; the UI never shows them.
 */
import { describe, expect, it } from 'vitest';
import { decodePlan, encodePlan, evaluateMission, makeWorld, planErrors, replay, replayWithSamples, REPLAY_SAMPLE_STRIDE, type MissionPlan, type ReplayResult } from './mission-layer';
import { conformance, initialPlan, launchOf, missionById, withLaunch, withLaunchRule, type MissionEntry } from './missions';
import solutions from '../../test/fixtures/campaign-solutions.json';
import { addNode, nodesOf, updateNode, type Vec3 } from './nodes';
import { BODY_DATA, ReplayEphemeris } from './physics';
import { replayOptions } from './replay-options';

const FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ FS)) as { readFileSync: (u: URL) => Uint8Array };
const eph = new ReplayEphemeris();
eph.installCheckpoints(new Uint8Array(readFileSync(new URL('../physics/data/checkpoints-1950-2100.bin', import.meta.url))));
const world = makeWorld(eph.physics, BODY_DATA);
const DAY = 86400;

function fly(m: MissionEntry, plan: MissionPlan) {
  const shared = decodePlan(encodePlan(plan)); // as a player receiving the link would
  const r = replayWithSamples(shared, world, replayOptions(m.def));
  // With the plan, as the game and the server do: the launch site's own limits apply.
  const ev = evaluateMission(m.def, r.result, world, shared.epoch, shared)!;
  if (shared.start.kind === 'launch') expect(ev.site).toBe(shared.start.site);
  console.log(`${m.id}: ${r.result.outcome} ${r.result.reason} success=${ev.success} score=${ev.score} dv=${ev.deltaV.toFixed(1)} t=${(ev.missionTime / DAY).toFixed(2)}d digest=${r.result.digest} (${r.ms.toFixed(0)} ms)\n  ` +
    ev.objectives.map((o) => `${o.ok ? 'ok' : 'NO'} ${o.objective.kind}: ${o.detail}`).join('\n  '));
  return { r, ev };
}

interface Solution { params: number[]; duration: number; burns: MissionPlan['burns']; separations: { time: number }[] }
const SOLUTIONS = solutions as unknown as Record<string, Record<string, Solution>>;

/**
 * A mission's reference solution (test/fixtures/campaign-solutions.json) from
 * its par site, re-entered the way a player would: the mission's fresh plan,
 * the launch moved to the solution's (time, azimuth, altitude), each burn
 * added as a maneuver node (its time and delta-v), and the separations the
 * solution places. The nodes give each burn its stage.
 */
function referenceByNodes(m: MissionEntry): MissionPlan {
  const base = initialPlan(m, world.fingerprint);
  const l = launchOf(base)!;
  const s = SOLUTIONS[m.id][l.site];
  const launched = withLaunch({ ...base, duration: s.duration, separations: s.separations }, { site: l.site, time: s.params[0], azimuthDeg: s.params[1], altitudeM: s.params[2] });
  let plan = launched;
  for (const x of nodesOf({ ...launched, burns: s.burns })) plan = addNode(plan, x.node).plan;
  return plan;
}

describe('vehicle launch (rules.vehicle)', () => {
  it('every campaign mission launches on its vehicle; the editor brings a plan into line, sandbox stays free', () => {
    for (const id of ['plane-change', 'geo-from-leo', 'earth-escape', 'lunar-flyby', 'mars-orbit', 'jupiter-saturn']) {
      const m = missionById(id)!;
      const V = m.def!.rules.vehicle!;
      expect(V.kind).toBe('vehicle');
      expect(m.def!.rules.launch).toBeUndefined();
      const base = initialPlan(m, world.fingerprint);
      expect(base.start.kind === 'launch' && base.start.ascent).toBe('vehicle');
      expect(base.lowerStages).toEqual(V.lowerStages);
      expect(conformance(m, base)).toEqual([]);
      // Moving the launch keeps it a vehicle launch; any altitude in the band is the player's choice.
      expect(conformance(m, withLaunch(base, { ...launchOf(base)!, altitudeM: 600e3 }))).toEqual([]);
      // Outside the band is refused, with a structured reason; withLaunchRule clamps it into the band.
      const high = withLaunch(base, { ...launchOf(base)!, altitudeM: 2000e3 });
      expect(conformance(m, high).map((i) => [i.code, i.path])).toEqual([['launch-altitude', 'start.params[2]']]);
      const fixed = withLaunchRule(m, high);
      expect(conformance(m, fixed)).toEqual([]);
      expect(launchOf(fixed)!.altitudeM).toBe(V.altitude[1]);
      // A plan from before the vehicle (a free delivery, format 1) is refused with the old-version reason, and brought into line.
      const { lowerStages: _drop, ...rest } = base;
      void _drop;
      const old: MissionPlan = { ...rest, format: 1, start: { kind: 'launch', site: launchOf(base)!.site, params: (base.start as { params: readonly number[] }).params } };
      expect(conformance(m, old).map((i) => i.code)).toEqual(['start-kind']);
      expect(conformance(m, old)[0].message).toMatch(/earlier version of the mission/);
      expect(conformance(m, withLaunchRule(m, old))).toEqual([]);
    }
    const sb = missionById('sandbox')!;
    const p = withLaunch(initialPlan(sb, world.fingerprint), { site: 'kourou', time: 8.5e8, azimuthDeg: 90, altitudeM: 1500e3 });
    expect(withLaunchRule(sb, p)).toBe(p);
    expect(conformance(sb, p)).toEqual([]);
  });

  it('nodes in a vehicle launch are fired by the active stage; an emptied stage separates before the next node', () => {
    const m = missionById('lunar-flyby')!;
    const base = initialPlan(m, world.fingerprint);
    const L = base.lowerStages!.length;
    let plan = addNode(base, { t: 3000, dv: [100, 0, 0], frame: { kind: 'orbital', body: 'earth' }, engine: 0 }).plan;
    expect(plan.burns[0].stage).toBe(L - 1); // the upper stage, with what the ascent left it
    expect(nodesOf(plan)[0].stage).toBe(L - 1);
    // Ask for more than the upper stage has: the burn runs it dry; the next node goes to the spacecraft after a separation.
    plan = updateNode(plan, 0, { dv: [20000, 0, 0] }).plan;
    expect(nodesOf(plan)[0].short).toBe(true);
    const end = plan.burns[0].start + plan.burns[0].duration;
    plan = addNode(plan, { t: end + 4000, dv: [10, 0, 0], frame: { kind: 'orbital', body: 'earth' }, engine: 0 }).plan;
    expect(plan.separations).toEqual([{ time: end + 1 }]);
    expect(plan.burns[1].stage).toBe(L);
    expect(planErrors(plan).plan).toEqual([]);
  });
});

describe('replayWithSamples', () => {
  it('draws from the scoring replay without changing a bit of it (same digest as a plain replay)', () => {
    const m = missionById('lunar-free-return')!;
    const plan = referenceByNodes(m);
    const sampled = replayWithSamples(plan, world, replayOptions(m.def));
    const plain = replay(plan, world, replayOptions(m.def));
    expect(sampled.result.digest).toBe(plain.digest);
    expect(sampled.result).toEqual(plain);
    const n = sampled.samples.length / REPLAY_SAMPLE_STRIDE;
    expect(n).toBeGreaterThan(100);
    expect(sampled.samples[(n - 1) * REPLAY_SAMPLE_STRIDE]).toBe(plain.finalT);
  });

  it('can be cancelled from the per-step hook', () => {
    const m = missionById('lunar-flyby')!;
    let steps = 0;
    const r = replayWithSamples(referenceByNodes(m), world, replayOptions(m.def), 4, () => ++steps > 5);
    expect(r.cancelled).toBe(true);
  });
});

describe('sample missions in the real world', () => {
  it('lunar flyby: one trans-lunar burn by the upper stage from a parking orbit in the Moon’s plane', () => {
    const m = missionById('lunar-flyby')!;
    const plan = referenceByNodes(m);
    const { ev, r } = fly(m, plan);
    expect(ev.success).toBe(true);
    expect(ev.score).toBeGreaterThan(0);
    expect(r.result.events.some((e) => e.kind === 'enter' && e.body === 'moon')).toBe(true);
  });

  it('lunar free return: flyby then Earth reentry on the same single burn', () => {
    const m = missionById('lunar-free-return')!;
    const plan = referenceByNodes(m);
    const { ev, r } = fly(m, plan);
    expect(r.result.outcome).toBe('atmosphere');
    expect(ev.success).toBe(true);
    // The same injection one minute earlier misses the return corridor: the timing matters.
    expect(fly(m, updateNode(plan, 0, { t: nodesOf(plan)[0].node.t - 60 }).plan).ev.success).toBe(false);
  });

  it('geostationary: upper-stage transfer burn at the equator crossing, separate, circularise and remove the inclination at apogee', () => {
    const m = missionById('geo-from-leo')!;
    let plan = { ...initialPlan(m, world.fingerprint), duration: 4.6 * DAY };
    const mu = eph.physics.gm[BODY_DATA.findIndex((b) => b.id === 'earth')];
    const earthIndex = BODY_DATA.findIndex((b) => b.id === 'earth');
    const pole = world.bodies[earthIndex].pole!;
    const es = new Float64Array(6);
    const rel = (s: Float64Array, i: number) => {
      const o = i * REPLAY_SAMPLE_STRIDE;
      eph.physics.bodyState(earthIndex, s[o], es);
      return [0, 1, 2, 3, 4, 5].map((k) => s[o + 1 + k] - es[k]);
    };
    const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a: readonly number[], b: readonly number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a: readonly number[]) => Math.sqrt(dot(a, a));
    const R_GEO = 42_164e3;

    // 1. Coast: find the first equator crossing after insertion.
    const coast = replayWithSamples({ ...plan, duration: 3 * 3600 }, world, replayOptions(m.def));
    let tNode = NaN;
    for (let i = 1; i < coast.samples.length / REPLAY_SAMPLE_STRIDE; i++) {
      const a = dot(rel(coast.samples, i - 1), pole);
      const b = dot(rel(coast.samples, i), pole);
      const ta = coast.samples[(i - 1) * REPLAY_SAMPLE_STRIDE] - plan.epoch;
      if (ta > 900 && a * b <= 0) {
        tNode = ta + (coast.samples[i * REPLAY_SAMPLE_STRIDE] - coast.samples[(i - 1) * REPLAY_SAMPLE_STRIDE]) * (a / (a - b));
        break;
      }
    }
    expect(Number.isFinite(tNode)).toBe(true);

    // 2. Transfer burn: tune prograde delta-v so the first apogee is at GEO radius.
    plan = addNode(plan, { t: tNode, dv: [2440, 0, 0], frame: { kind: 'orbital', body: 'earth' }, engine: 0 }).plan;
    const apogee = (p: MissionPlan, after: number) => {
      const r = replayWithSamples({ ...p, duration: 1 * DAY }, world, replayOptions(m.def)).result;
      return r.events.find((e) => e.body === 'earth' && e.kind === 'apoapsis' && e.t > p.epoch + after);
    };
    // Apogee radius grows monotonically with the injection: bisect.
    let lo = 2300;
    let hi = 2600;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      plan = updateNode(plan, 0, { dv: [mid, 0, 0] }).plan;
      const a = apogee(plan, tNode + 600);
      if (!a || a.distance > R_GEO) hi = mid;
      else lo = mid;
    }
    const apo = apogee(plan, tNode + 600)!;

    // 3. The upper stage did the transfer; drop it ten minutes after (the spacecraft flies the rest).
    const tb = plan.burns[0];
    plan = { ...plan, separations: [{ time: tb.start + tb.duration + 600 }] };
    // 4. Circularisation and plane change at apogee: impulsive guess, then fixed-point corrections from the flown state.
    const tA = apo.t - plan.epoch;
    const toOrbital = (rr: readonly number[], v: readonly number[], d: readonly number[]): Vec3 => {
      const p = v.map((x) => x / norm(v));
      const h = cross(rr, v);
      const nn = h.map((x) => x / norm(h));
      const o = cross(p, nn);
      return [dot(d, p), dot(d, nn), dot(d, o)];
    };
    const circularDv = (s: readonly number[]) => {
      const rr = s.slice(0, 3);
      const east = cross(pole, rr);
      const vc = Math.sqrt(mu / norm(rr));
      const target = east.map((x) => (x / norm(east)) * vc);
      return toOrbital(rr, s.slice(3), target.map((x, k) => x - s[3 + k]));
    };
    plan = addNode(plan, { t: tA, dv: circularDv(apo.rel), frame: { kind: 'orbital', body: 'earth' }, engine: 0 }).plan;
    let result: ReplayResult | null = null;
    for (let k = 0; k < 4; k++) {
      const info = nodesOf(plan)[1];
      const tAfter = plan.epoch + info.burn.start + info.burn.duration + 120;
      const run = replayWithSamples({ ...plan, duration: info.burn.start + info.burn.duration + 240 }, world, replayOptions(m.def));
      result = run.result;
      let i = 0;
      while ((i + 1) * REPLAY_SAMPLE_STRIDE < run.samples.length && run.samples[(i + 1) * REPLAY_SAMPLE_STRIDE] <= tAfter) i++;
      const res = circularDv(rel(run.samples, i));
      if (norm(res) < 0.05) break;
      const dv = info.node.dv;
      plan = updateNode(plan, 1, { dv: [dv[0] + res[0], dv[1] + res[1], dv[2] + res[2]] }).plan;
    }
    expect(result).not.toBeNull();
    const { ev } = fly(m, plan);
    console.log('GEO solution nodes:', JSON.stringify(nodesOf(plan).map((x) => ({ t: x.node.t, dv: x.node.dv }))));
    expect(ev.success).toBe(true);
    expect(plan.burns.map((b) => b.stage)).toEqual([plan.lowerStages!.length - 1, plan.lowerStages!.length]);
    // The flight's own delta-v (what this test bounded before the ascent was charged); the total adds the ascent.
    expect(ev.flightDeltaV).toBeLessThan(4500);
    expect(ev.deltaV).toBe(ev.ascentDeltaV + ev.flightDeltaV);
  }, 60_000);
});
