import { describe, expect, it } from 'vitest';
import { evaluate, score, type MissionDefinition } from '../src/mission/objectives';
import { decodePlan, encodePlan, makePlan, type MissionPlan, type PlanBurn } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { GEO_FROM_LEO, LUNAR_FLYBY, LUNAR_FREE_RETURN, SAMPLE_MISSIONS } from '../src/mission/samples';
import type { MissionWorld } from '../src/mission/world';
import { earthMoonWorld, earthOnlyWorld, GM_EARTH, R_EARTH } from './helpers/mission-worlds';

const DAY = 86400;
const prograde = (start: number, duration: number): PlanBurn => ({ start, duration, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } });

function leoPlan(w: MissionWorld, altitude: number, duration: number, rtol: number, craft: MissionPlan['spacecraft'], burns: PlanBurn[]): MissionPlan {
  const r = R_EARTH + altitude;
  return makePlan({ data: w.fingerprint, epoch: 0, duration, rtol, start: { kind: 'state', center: 'earth', state: [r, 0, 0, 0, Math.sqrt(GM_EARTH / r), 0] }, spacecraft: craft, burns });
}

function run(m: MissionDefinition, w: MissionWorld, p: MissionPlan) {
  // Plans are replayed from their shared-link form.
  const decoded = decodePlan(encodePlan(p));
  const r = replay(decoded, w, { spheres: m.spheres });
  const ev = evaluate(m, r, w, p.epoch);
  console.log(`${m.id}: ${r.outcome}, success ${ev.success}, dv ${ev.deltaV.toFixed(1)} m/s, time ${(ev.missionTime / DAY).toFixed(2)} d, score ${ev.score}, link ${encodePlan(p).length} chars\n  ` + ev.objectives.map((o) => `${o.ok ? 'ok ' : 'NO '} ${o.objective.kind}: ${o.detail}`).join('\n  '));
  return { r, ev };
}

// Hohmann-like transfer with finite burns; durations tuned once with the replay itself.
const geoCraft = { wetMass: 12000, dryMass: 3000, engines: [{ thrust: 100e3, isp: 320 }] };
const geoBurns = [prograde(1000, 202.99539402141738), prograde(20068.878973258106, 64.80748388720713)];
// One trans-lunar injection from a 200 km parking orbit, Moon on a circular orbit.
const tliCraft = { wetMass: 30000, dryMass: 12000, engines: [{ thrust: 200e3, isp: 450 }] };

describe('sample missions', () => {
  it('are well-formed', () => {
    expect(new Set(SAMPLE_MISSIONS.map((m) => m.id)).size).toBe(SAMPLE_MISSIONS.length);
    for (const m of SAMPLE_MISSIONS) expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it('GEO from LEO: succeeds with both burns, fails with only the first', () => {
    const w = earthOnlyWorld();
    const good = run(GEO_FROM_LEO, w, leoPlan(w, 300e3, 4 * DAY, 1e-10, geoCraft, geoBurns));
    expect(good.ev.success).toBe(true);
    expect(good.ev.deltaV).toBeGreaterThan(3800);
    expect(good.ev.deltaV).toBeLessThan(4000);
    expect(good.ev.missionTime).toBeGreaterThan(3 * 0.997 * DAY);
    expect(good.ev.score).toBe(score(true, good.ev.deltaV, good.ev.missionTime, GEO_FROM_LEO.scoring));
    const half = run(GEO_FROM_LEO, w, leoPlan(w, 300e3, 4 * DAY, 1e-10, geoCraft, geoBurns.slice(0, 1)));
    expect(half.ev.success).toBe(false);
    expect(half.ev.score).toBe(0);
    // Inclined by a normal component in the circularisation burn: fails the 1 degree limit.
    const tilted = run(GEO_FROM_LEO, w, leoPlan(w, 300e3, 4 * DAY, 1e-10, geoCraft, [geoBurns[0], { ...geoBurns[1], direction: [1, 0.1, 0] }]));
    expect(tilted.ev.objectives[0].ok).toBe(false);
  });

  it('lunar flyby: succeeds; too-tight altitude band fails; impact fails', () => {
    const w = earthMoonWorld();
    const good = run(LUNAR_FLYBY, w, leoPlan(w, 200e3, 6 * DAY, 1e-9, tliCraft, [prograde(3200, 337.75)]));
    expect(good.ev.success).toBe(true);
    expect(good.r.events.some((e) => e.kind === 'enter' && e.body === 'moon')).toBe(true);
    const strict: MissionDefinition = { ...LUNAR_FLYBY, objectives: [{ kind: 'flyby', body: 'moon', maxAltitude: 1000e3 }] };
    expect(run(strict, w, leoPlan(w, 200e3, 6 * DAY, 1e-9, tliCraft, [prograde(3200, 337.75)])).ev.success).toBe(false);
    const crash = run(LUNAR_FLYBY, w, leoPlan(w, 200e3, 6 * DAY, 1e-9, tliCraft, [prograde(3200, 338.25)]));
    expect(crash.r.outcome).toBe('impact');
    expect(crash.r.events.at(-1)?.body).toBe('moon');
    expect(crash.ev.success).toBe(false);
  });

  it('lunar free return: flyby then reentry, in order, on one burn', () => {
    const w = earthMoonWorld();
    const p = leoPlan(w, 200e3, 10 * DAY, 1e-9, tliCraft, [prograde(3200, 339)]);
    const good = run(LUNAR_FREE_RETURN, w, p);
    expect(good.r.outcome).toBe('atmosphere');
    expect(good.ev.success).toBe(true);
    // A plain lunar flyby that does not come back fails the sequence.
    const noReturn = run(LUNAR_FREE_RETURN, w, leoPlan(w, 200e3, 10 * DAY, 1e-9, tliCraft, [prograde(3200, 337.75)]));
    expect(noReturn.ev.success).toBe(false);
    // Reentry without having been to the Moon first fails too (order matters).
    const early = run(LUNAR_FREE_RETURN, w, leoPlan(w, 200e3, 10 * DAY, 1e-9, tliCraft, [prograde(3200, 330)]));
    expect(early.r.outcome).toBe('atmosphere');
    expect(early.ev.success).toBe(false);
    // Over budget: the same flight judged against a lower delta-v cap.
    const tight: MissionDefinition = { ...LUNAR_FREE_RETURN, objectives: [...LUNAR_FREE_RETURN.objectives, { kind: 'max-delta-v', max: 3000 }] };
    expect(evaluate(tight, good.r, w, p.epoch).success).toBe(false);
  });

  it('escape objective uses the final hyperbolic excess speed', () => {
    const w = earthOnlyWorld();
    const r = R_EARTH + 300e3;
    const v = Math.sqrt((2 * GM_EARTH) / r) + 3000;
    const p = makePlan({ data: w.fingerprint, epoch: 0, duration: DAY, rtol: 1e-10, start: { kind: 'state', center: 'earth', state: [r, 0, 0, 0, v, 0] }, spacecraft: geoCraft, burns: [] });
    const res = replay(p, w);
    const vinf = Math.sqrt(v * v - (2 * GM_EARTH) / r);
    const m = (min: number): MissionDefinition => ({ id: 'esc', title: 'Escape', objectives: [{ kind: 'escape', body: 'earth', minSpeed: min }], scoring: GEO_FROM_LEO.scoring });
    expect(evaluate(m(vinf - 1), res, w, 0).success).toBe(true);
    expect(evaluate(m(vinf + 1), res, w, 0).success).toBe(false);
  });
});
