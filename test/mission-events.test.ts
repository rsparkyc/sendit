import { describe, expect, it } from 'vitest';
import { FixedBodies, propagate } from '../src/physics/spacecraft';
import { EventFinder, type TrajectoryEvent } from '../src/mission/events';
import { makeWorld } from '../src/mission/world';
import { earthOnlyWorld, GM_EARTH, R_EARTH } from './helpers/mission-worlds';

/** Run the finder over a propagation; also record each step and the step containing each event. */
function run(world: ReturnType<typeof earthOnlyWorld>, y0: number[], t1: number, rtol: number, opts = {}) {
  const finder = new EventFinder(world, opts);
  const steps: [number, number][] = [];
  let terminal: TrajectoryEvent | null = finder.start(0, y0);
  try {
    propagate(world.ephemeris, y0, 0, t1, [], {
      rtol,
      onStep: (t, _y, interp, tPrev) => {
        steps.push([tPrev, t]);
        const term = finder.step(t, interp, tPrev);
        if (term) { terminal = term; throw new Error('stop'); }
      },
    });
  } catch (e) {
    if ((e as Error).message !== 'stop') throw e;
  }
  const stepOf = (t: number) => steps.find(([a, b]) => t > a && t <= b)!;
  return { events: finder.events, terminal: terminal as TrajectoryEvent | null, steps, stepOf };
}

/** A massless "planet" of Earth's radius at the origin: straight-line motion, so steps grow huge. */
const rockWorld = () => makeWorld(new FixedBodies([{ gm: 0, position: [0, 0, 0] }]), [{ id: 'rock', radius: 6.4e6, atmosphere: 0, pole: null }]);

describe('trajectory events', () => {
  it('cannot fly through a body inside one long step (massless body, straight line)', () => {
    const w = rockWorld();
    const v = 30e3;
    // Starts 1e9 m away, aimed 3e6 m off centre: passes straight through the body.
    const y0 = [-1e9, 3e6, 0, v, 0, 0, 1000];
    const r = run(w, y0, 1e5, 1e-6);
    expect(r.terminal?.kind).toBe('impact');
    const [a, b] = r.stepOf(r.terminal!.t);
    // The whole pass lies inside one step whose end points are far outside the body.
    const dist = (t: number) => Math.hypot(-1e9 + v * t, 3e6);
    expect(b - a).toBeGreaterThan(1e4);
    expect(dist(a)).toBeGreaterThan(1e8);
    expect(dist(b)).toBeGreaterThan(1e8);
    // Entry point: x = -sqrt(R^2 - 3e6^2).
    const tEntry = (1e9 - Math.sqrt(6.4e6 ** 2 - 9e12)) / v;
    expect(Math.abs(r.terminal!.t - tEntry)).toBeLessThan(1e-6);
    expect(r.terminal!.altitude).toBeLessThan(1e-3);
  });

  it('finds a closest approach and sphere crossings inside one long step', () => {
    const w = rockWorld();
    const v = 30e3;
    const y0 = [-1e9, 7e6, 0, v, 0, 0, 1000];
    const r = run(w, y0, 1e5, 1e-6, { spheres: [{ body: 'rock', radius: 5e7 }] });
    expect(r.terminal).toBeNull();
    const ca = r.events.filter((e) => e.kind === 'periapsis');
    expect(ca).toHaveLength(1);
    expect(Math.abs(ca[0].t - 1e9 / v)).toBeLessThan(1e-6);
    expect(Math.abs(ca[0].distance - 7e6)).toBeLessThan(1e-3);
    expect(ca[0].speed).toBeCloseTo(v, 6);
    const [a, b] = r.stepOf(ca[0].t);
    expect(b - a).toBeGreaterThan(1e4);
    const half = Math.sqrt(5e7 ** 2 - 7e6 ** 2) / v;
    const enter = r.events.find((e) => e.kind === 'enter')!;
    const exit = r.events.find((e) => e.kind === 'exit')!;
    expect(Math.abs(enter.t - (1e9 / v - half))).toBeLessThan(1e-6);
    expect(Math.abs(exit.t - (1e9 / v + half))).toBeLessThan(1e-6);
    expect(r.events.map((e) => e.kind)).toEqual(['enter', 'periapsis', 'exit']);
  });

  describe('fast hyperbolic Earth flyby at loose tolerance', () => {
    const vinf = 30e3;
    // Periapsis of a hyperbola with excess speed vinf and impact parameter b.
    const rpOf = (b: number) => (GM_EARTH / vinf ** 2) * (Math.sqrt(1 + ((b * vinf ** 2) / GM_EARTH) ** 2) - 1);
    /** Start 5e8 m out, moving along +x at offset b, with the speed that gives excess speed vinf. */
    const start = (b: number) => {
      const d = 5e8;
      const v = Math.sqrt(vinf ** 2 + (2 * GM_EARTH) / d);
      return [-Math.sqrt(d * d - b * b), b, 0, v, 0, 0, 1000];
    };

    it('finds periapsis to the analytic value with long steps', () => {
      const w = earthOnlyWorld();
      for (const b of [3e7, 1e8]) {
        // With vy = 0, |r x v| = b * v (not b * vinf): the true impact parameter is b v / vinf.
        const y0 = start(b);
        const v = y0[3];
        const rp = rpOf((b * v) / vinf);
        const r = run(w, y0, 1e5, 1e-6);
        const ca = r.events.filter((e) => e.kind === 'periapsis');
        expect(ca).toHaveLength(1);
        expect(Math.abs(ca[0].distance / rp - 1)).toBeLessThan(1e-5);
        const [a, bb] = r.stepOf(ca[0].t);
        // Both ends of the step that holds periapsis are far from it: a check of step
        // end points alone would have missed the pass.
        const rAt = (t: number) => { const out = new Float64Array(7); propagate(w.ephemeris, y0, 0, t, [], { rtol: 1e-13 }).y.forEach((q, i) => (out[i] = q)); return Math.hypot(out[0], out[1], out[2]); };
        expect(Math.min(rAt(a), rAt(bb))).toBeGreaterThan(1.005 * rp);
        console.log(`flyby b=${b}: rp ${(rp / 1e3).toFixed(0)} km, found ${(ca[0].distance / 1e3).toFixed(3)} km, step ${(bb - a).toFixed(0)} s from ${(rAt(a) / 1e3).toFixed(0)} to ${(rAt(bb) / 1e3).toFixed(0)} km, ${r.steps.length} steps`);
      }
    });

    it('reports impact when the hyperbola dips below the surface, and atmosphere first', () => {
      const w = earthOnlyWorld();
      const y0 = start(4e6);
      const r = run(w, y0, 1e5, 1e-6);
      expect(r.terminal?.kind).toBe('atmosphere-entry');
      const r2 = run(w, y0, 1e5, 1e-6, { stopOnAtmosphere: false });
      expect(r2.terminal?.kind).toBe('impact');
      expect(Math.abs(r2.terminal!.distance - R_EARTH)).toBeLessThan(1e-3);
      expect(r2.events.some((e) => e.kind === 'atmosphere-entry')).toBe(true);
      expect(r2.events.some((e) => e.kind === 'periapsis')).toBe(false);
    });
  });

  it('periapsis and apoapsis of an ellipse match the analytic values and alternate', () => {
    const w = earthOnlyWorld();
    const rp = 7e6;
    const e = 0.3;
    const a = rp / (1 - e);
    const vp = Math.sqrt((GM_EARTH * (1 + e)) / rp);
    const T = 2 * Math.PI * Math.sqrt(a ** 3 / GM_EARTH);
    const r = run(w, [rp, 0, 0, 0, vp, 0, 1000], 3.5 * T, 1e-10);
    const ext = r.events.filter((x) => x.kind === 'periapsis' || x.kind === 'apoapsis');
    expect(ext.map((x) => x.kind)).toEqual(['apoapsis', 'periapsis', 'apoapsis', 'periapsis', 'apoapsis', 'periapsis', 'apoapsis']);
    for (const x of ext) {
      const expected = x.kind === 'periapsis' ? rp : a * (1 + e);
      expect(Math.abs(x.distance / expected - 1)).toBeLessThan(1e-8);
      const n = x.kind === 'periapsis' ? Math.round(x.t / T) : Math.round(x.t / T - 0.5) + 0.5;
      expect(Math.abs(x.t - n * T)).toBeLessThan(1e-3);
    }
  });

  it('flags a start inside a body', () => {
    const w = earthOnlyWorld();
    const f = new EventFinder(w);
    expect(f.start(0, [R_EARTH + 50e3, 0, 0, 0, 7000, 0, 1])?.kind).toBe('atmosphere-entry');
  });
});
