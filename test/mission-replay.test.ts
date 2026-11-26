import { describe, expect, it } from 'vitest';
import { FixedBodies, G0 } from '../src/physics/spacecraft';
import { ChebyshevEphemeris } from '../src/physics/chebyshev-ephemeris';
import { J2000_BODIES } from '../src/physics/solar-system';
import { exactLn } from '../src/mission/exact-math';
import { decodePlan, encodePlan, makePlan, type PlanBurn } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { launchToParams } from '../src/mission/launch';
import { makeWorld, worldFromBodyData } from '../src/mission/world';
import { earthOnlyWorld, GM_EARTH, R_EARTH } from './helpers/mission-worlds';

const engine = { thrust: 5000, isp: 320 };
const pro = (start: number, duration: number): PlanBurn => ({ start, duration, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } });

describe('replay', () => {
  it('exactLn matches Math.log', () => {
    let worst = 0;
    for (const x of [1, 1 + 1e-15, 1.5, 2, Math.E, 10, 1e-300, 1e300, 0.3, 123456.789, 2 ** 52 + 1]) {
      const err = Math.abs(exactLn(x) - Math.log(x)) / Math.max(1e-300, Math.abs(Math.log(x)));
      worst = Math.max(worst, x === 1 ? Math.abs(exactLn(x)) : err);
    }
    for (let i = 1; i < 10000; i++) {
      const x = 1 + i * 0.0007;
      worst = Math.max(worst, Math.abs(exactLn(x) - Math.log(x)) / Math.log(x));
    }
    expect(worst).toBeLessThan(1e-15);
    expect(() => exactLn(0)).toThrow();
  });

  it('delta-v and propellant follow the rocket equation, including running dry', () => {
    const w = makeWorld(new FixedBodies([{ gm: 0, position: [1e12, 0, 0] }]), [{ id: 'rock', radius: 1, atmosphere: 0, pole: null }]);
    const mk = (burns: PlanBurn[]) =>
      makePlan({ data: w.fingerprint, epoch: 0, duration: 5000, rtol: 1e-10, start: { kind: 'state', center: 'rock', state: [-1e12, 0, 0, 0, 0, 0] },
        spacecraft: { wetMass: 2000, dryMass: 1500, engines: [engine] }, burns });
    const inertial = (start: number, duration: number): PlanBurn => ({ start, duration, engine: 0, direction: [0, 1, 0], frame: { kind: 'inertial' } });
    const ve = engine.isp * G0;
    const mdot = engine.thrust / ve;
    const r = replay(mk([inertial(100, 50), inertial(500, 1e4)]), w);
    expect(r.outcome).toBe('completed');
    const m1 = 2000 - mdot * 50;
    expect(Math.abs(r.burns[0].deltaV / (ve * Math.log(2000 / m1)) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(r.burns[1].propellant - (m1 - 1500))).toBeLessThan(1e-8);
    expect(Math.abs(r.burns[1].burnTime - (m1 - 1500) / mdot)).toBeLessThan(1e-6);
    expect(Math.abs(r.deltaV / (ve * Math.log(2000 / 1500)) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(r.propellantUsed - 500)).toBeLessThan(1e-8);
    // The real velocity change agrees.
    expect(Math.abs(r.finalState[4] / r.deltaV - 1)).toBeLessThan(1e-10);
  });

  it('is deterministic and its digest sees a one-ulp change', () => {
    const w = earthOnlyWorld();
    const r0 = R_EARTH + 300e3;
    const p = makePlan({ data: w.fingerprint, epoch: 0, duration: 30000, rtol: 1e-10, start: { kind: 'state', center: 'earth', state: [r0, 0, 0, 0, Math.sqrt(GM_EARTH / r0), 100] },
      spacecraft: { wetMass: 3000, dryMass: 1000, engines: [engine] }, burns: [pro(1000, 300)] });
    const a = replay(p, w);
    const b = replay(decodePlan(encodePlan(p)), w);
    expect(a.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(b.digest).toBe(a.digest);
    expect(b).toEqual(a);
    const c = replay({ ...p, burns: [pro(1000.0000000000001, 300)] }, w);
    expect(c.digest).not.toBe(a.digest);
    console.log(`digest ${a.digest}, ${a.steps} steps, ${a.events.length} events`);
  });

  it('ends at the first impact, with the real state there', () => {
    const w = earthOnlyWorld();
    const r0 = R_EARTH + 300e3;
    const p = makePlan({ data: w.fingerprint, epoch: 0, duration: 30000, rtol: 1e-10, start: { kind: 'state', center: 'earth', state: [r0, 0, 0, 0, Math.sqrt(GM_EARTH / r0), 0] },
      spacecraft: { wetMass: 3000, dryMass: 1000, engines: [engine] }, burns: [{ ...pro(1000, 400), direction: [-1, 0, 0] }] });
    const r = replay(p, w);
    expect(r.outcome).toBe('atmosphere');
    expect(r.ok).toBe(false);
    expect(Math.abs(Math.hypot(r.finalState[0], r.finalState[1], r.finalState[2]) - (R_EARTH + 122e3))).toBeLessThan(1e-3);
    const r2 = replay(p, w, { stopOnAtmosphere: false });
    expect(r2.outcome).toBe('impact');
    expect(r2.elapsed).toBeGreaterThan(r.elapsed);
  });

  it('bounds the work: step limit, physics errors become results', () => {
    const w = earthOnlyWorld();
    const r0 = R_EARTH + 300e3;
    const p = makePlan({ data: w.fingerprint, epoch: 0, duration: 1e6, rtol: 1e-12, start: { kind: 'state', center: 'earth', state: [r0, 0, 0, 0, Math.sqrt(GM_EARTH / r0), 0] },
      spacecraft: { wetMass: 3000, dryMass: 1000, engines: [engine] }, burns: [] });
    expect(replay(p, w, { maxSteps: 100 }).outcome).toBe('step-limit');
    const bad = { ...p, start: { kind: 'state' as const, center: 'earth', state: [r0, 0, 0, 100, 0, 0] }, burns: [pro(0, 10)] };
    const r = replay(bad, w);
    expect(r.outcome === 'physics-error' || r.outcome === 'impact' || r.outcome === 'atmosphere').toBe(true);
    expect(replay({ ...p, burns: [{ ...pro(0, 10), frame: { kind: 'orbital', body: 'mars' } }] }, w).outcome).toBe('invalid-plan');
  });

  it('real solar system: a launch-kind plan replays bit-identically after an encode/decode round trip', { timeout: 300_000 }, () => {
    const eph = new ChebyshevEphemeris(J2000_BODIES);
    const w = worldFromBodyData(eph, J2000_BODIES);
    const liftoff = 8e8; // 2025-05 TDB
    const params = launchToParams({ mode: 'parking-orbit', siteId: 'cape-canaveral', launchTime: liftoff, azimuthDeg: 90, altitudeM: 300e3 });
    const p = makePlan({
      data: w.fingerprint, epoch: liftoff, duration: 6 * 3600, rtol: 1e-10,
      start: { kind: 'launch', site: 'cape-canaveral', params },
      spacecraft: { wetMass: 3000, dryMass: 1000, engines: [engine] },
      burns: [pro(3000, 200)],
    });
    const s = encodePlan(p);
    const a = replay(p, w);
    const b = replay(decodePlan(s), w);
    expect(a.outcome).toBe('completed');
    expect(b.digest).toBe(a.digest);
    expect(b).toEqual(a);
    const earthPeri = a.events.filter((e) => e.body === 'earth' && e.kind === 'periapsis');
    expect(earthPeri.length).toBeGreaterThan(2);
    for (const e of earthPeri) expect(e.altitude).toBeGreaterThan(200e3);
    // Moon is watched by id; its closest approach is far.
    expect(a.events.every((e) => e.body !== 'moon' || e.distance > 3e8)).toBe(true);
    console.log(`real system launch plan: ${s.length} chars, ${a.steps} steps, ${a.events.length} events, digest ${a.digest}`);
  });
});
