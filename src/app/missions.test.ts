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
import { decodePlan, encodePlan, evaluateMission, launchSite, makeWorld, orbitNormalOf, planeCrossings, replay, replayWithSamples, REPLAY_SAMPLE_STRIDE, type MissionPlan, type ReplayResult } from './mission-layer';
import { conformance, initialPlan, launchOf, missionById, withLaunch, withLaunchRule, type MissionEntry } from './missions';
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

/** Launch into the Moon's orbital plane at arrival, from Kourou (the Moon's plane is below Cape Canaveral's latitude in 2027). */
function lunarLaunch(m: MissionEntry): MissionPlan {
  const base = initialPlan(m, world.fingerprint);
  const l = launchOf(base)!;
  const n = orbitNormalOf(eph.physics, BODY_DATA, 'moon', l.time + 4 * DAY);
  const c = planeCrossings(launchSite('kourou'), n, l.time, l.time + DAY).find((x) => x.azimuthAllowed)!;
  return withLaunch(base, { site: 'kourou', time: c.t, azimuthDeg: c.azimuthDeg, altitudeM: 200e3 });
}

/** Node for a prograde burn of `duration` seconds starting at `start` with the plan's first engine and full tanks. */
function tliNode(plan: MissionPlan, start: number, duration: number) {
  const sc = plan.spacecraft;
  const e = sc.engines[0];
  const ve = e.isp * 9.80665;
  const dv = ve * Math.log(sc.wetMass / (sc.wetMass - (e.thrust / ve) * duration));
  return addNode(plan, { t: start + duration / 2, dv: [dv, 0, 0], frame: { kind: 'orbital', body: 'earth' }, engine: 0 }).plan;
}

describe('fixed launch (rules.launch)', () => {
  it('every campaign mission fixes the parking orbit; the editor brings a plan into line, sandbox stays free', () => {
    for (const id of ['plane-change', 'geo-from-leo', 'earth-escape', 'lunar-flyby', 'mars-orbit', 'jupiter-saturn']) {
      const m = missionById(id)!;
      const L = m.def!.rules.launch!;
      expect(L.kind).toBe('fixed');
      const base = initialPlan(m, world.fingerprint);
      expect(launchOf(base)!.altitudeM).toBe(L.altitudeM);
      expect(conformance(m, base)).toEqual([]);
      // A free choice of altitude (the old free delta-v) is refused, with a structured reason; withLaunchRule restores it.
      const high = withLaunch(base, { ...launchOf(base)!, altitudeM: 2000e3 });
      expect(conformance(m, high).map((i) => [i.code, i.path])).toEqual([['launch-altitude', 'start.params[2]']]);
      expect(conformance(m, withLaunchRule(m, high))).toEqual([]);
    }
    expect(missionById('plane-change')!.def!.rules.launch!.altitudeM).toBe(400e3);
    const sb = missionById('sandbox')!;
    const p = withLaunch(initialPlan(sb, world.fingerprint), { site: 'kourou', time: 8.5e8, azimuthDeg: 90, altitudeM: 1500e3 });
    expect(withLaunchRule(sb, p)).toBe(p);
    expect(conformance(sb, p)).toEqual([]);
  });
});

describe('replayWithSamples', () => {
  it('draws from the scoring replay without changing a bit of it (same digest as a plain replay)', () => {
    const m = missionById('lunar-free-return')!;
    const plan = tliNode(lunarLaunch(m), 2900, 339);
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
    const r = replayWithSamples(tliNode(lunarLaunch(m), 2850, 339), world, replayOptions(m.def), 4, () => ++steps > 5);
    expect(r.cancelled).toBe(true);
  });
});

describe('sample missions in the real world', () => {
  it('lunar flyby: one trans-lunar burn from a parking orbit in the Moon’s plane', () => {
    const m = missionById('lunar-flyby')!;
    const plan = tliNode(lunarLaunch(m), 2850, 339);
    const { ev, r } = fly(m, plan);
    expect(ev.success).toBe(true);
    expect(ev.score).toBeGreaterThan(0);
    expect(r.result.events.some((e) => e.kind === 'enter' && e.body === 'moon')).toBe(true);
  });

  it('lunar free return: flyby then Earth reentry on the same single burn', () => {
    const m = missionById('lunar-free-return')!;
    const plan = tliNode(lunarLaunch(m), 2900, 339);
    const { ev, r } = fly(m, plan);
    expect(r.result.outcome).toBe('atmosphere');
    expect(ev.success).toBe(true);
    // The same injection one minute earlier misses the return corridor: the timing matters.
    expect(fly(m, updateNode(plan, 0, { t: nodesOf(plan)[0].node.t - 60 }).plan).ev.success).toBe(false);
  });

  it('geostationary: transfer burn at the equator crossing, circularise and remove the inclination at apogee', () => {
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

    // 3. Circularisation and plane change at apogee: impulsive guess, then fixed-point corrections from the flown state.
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
    expect(ev.deltaV).toBeLessThan(4500);
  }, 60_000);
});
