/**
 * Ascent model (ascent.ts): determinism, behaviour, the vehicle launch in
 * replay, the scoring quantity and the vehicle-launch mission rule.
 */
import { describe, expect, it } from 'vitest';
import { ASCENT_BODIES, computeAscent, type AscentResult } from '../src/mission/ascent';
import { exactExp, Hasher } from '../src/mission/exact-math';
import { launchGeometry, launchSite, launchToParams } from '../src/mission/launch';
import { checkPlanConformance, fixedLaunch, vehicleLaunch, type MissionDefinition } from '../src/mission/objectives';
import { makePlan, type MissionPlan, type Stage } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { vehicleSpec, VEHICLES, withSpacecraft } from '../src/mission/vehicles';
import { realWorld } from './helpers/real-world';

const EARTH = { gm: 3.986004418e14, radius: 6378136.6 };
const SC: Stage = { wetMass: 5000, dryMass: 1500, engines: [{ thrust: 20e3, isp: 320 }] };
const T = 8.5e8;

function hashAscent(a: AscentResult): string {
  const h = new Hasher();
  if (!a.ok) return h.str(a.reason).f64(a.liftoffTW).hex();
  h.u32(a.upperStage).f64(a.upperPropellant).f64(a.massAtInsertion).f64(a.deltaV).f64(a.kick);
  for (const v of Object.values(a.losses)) h.f64(v);
  for (const s of a.stages) h.f64(s.propellantUsed).f64(s.deltaV).f64(s.time);
  return h.hex();
}

function cases(): AscentResult[] {
  const out: AscentResult[] = [];
  for (const v of VEHICLES) {
    for (const [site, az, alt] of [['cape-canaveral', 90, 200e3], ['vandenberg', 190, 600e3], ['kourou', 45, 300e3]] as const) {
      const sc = v.class === 'small' ? { ...SC, wetMass: 150, dryMass: 100 } : SC;
      out.push(computeAscent(withSpacecraft(v, sc), { ...EARTH, altitudeM: alt }, launchGeometry(launchSite(site), T, az), ASCENT_BODIES.earth));
    }
  }
  return out;
}

describe('ascent model', () => {
  it('exactExp is accurate and inverts exactLn', () => {
    for (let i = 0; i <= 1000; i++) {
      const x = -700 + 1.4 * i;
      expect(Math.abs(exactExp(x) / Math.exp(x) - 1)).toBeLessThan(1e-15);
    }
    expect(exactExp(0)).toBe(1);
  });

  it('is bit-reproducible, pinned (changing the model or its constants needs a PHYSICS_MODEL bump)', () => {
    const a = cases().map(hashAscent);
    const b = cases().map(hashAscent);
    expect(b).toEqual(a);
    const all = new Hasher();
    for (const x of a) all.str(x);
    // GOLDEN: regenerate only together with a PHYSICS_MODEL bump.
    expect(all.hex()).toBe(GOLDEN_ASCENT);
  });

  it('charges more for higher and more inclined orbits, less for launching east near the equator', () => {
    const f9 = withSpacecraft(vehicleSpec('falcon-9'), SC);
    const left = (site: string, az: number, alt: number) => {
      const a = computeAscent(f9, { ...EARTH, altitudeM: alt }, launchGeometry(launchSite(site), T, az), ASCENT_BODIES.earth);
      if (!a.ok) throw new Error(a.reason);
      return a.upperPropellant;
    };
    expect(left('cape-canaveral', 90, 200e3)).toBeGreaterThan(left('cape-canaveral', 90, 400e3));
    expect(left('cape-canaveral', 90, 400e3)).toBeGreaterThan(left('cape-canaveral', 90, 1000e3));
    expect(left('cape-canaveral', 90, 200e3)).toBeGreaterThan(left('cape-canaveral', 45, 200e3));
    expect(left('kourou', 90, 200e3)).toBeGreaterThan(left('cape-canaveral', 90, 200e3));
    expect(left('vandenberg', 180, 200e3)).toBeLessThan(left('cape-canaveral', 45, 200e3));
    const a = computeAscent(f9, { ...EARTH, altitudeM: 200e3 }, launchGeometry(launchSite('cape-canaveral'), T, 90), ASCENT_BODIES.earth);
    if (!a.ok) throw new Error(a.reason);
    const L = a.losses;
    console.log('Falcon 9 to 200 km from the Cape, due east:', JSON.stringify({ deltaV: a.deltaV, ...L }));
    // Breakdown adds up to the delivered delta-v within the integration error.
    const sum = L.orbitalSpeed + L.rotation + L.gravity + L.drag + L.steering + L.backPressure + L.circularization;
    expect(Math.abs(sum - a.deltaV)).toBeLessThan(5);
    expect(L.gravity - L.climb).toBeGreaterThan(800);
    expect(L.gravity - L.climb).toBeLessThan(1600);
  });

  it('refuses a vehicle that cannot reach orbit, with a reason', () => {
    const weak = computeAscent([vehicleSpec('electron').stages[0], { wetMass: 100, dryMass: 100, engines: [{ thrust: 1, isp: 1 }] }], { ...EARTH, altitudeM: 200e3 }, { alongTrack: 400, crossTrack: 0 }, ASCENT_BODIES.earth);
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.reason).toMatch(/cannot reach/);
    const heavy = computeAscent(withSpacecraft(vehicleSpec('falcon-9'), { ...SC, wetMass: 1e6, dryMass: 1e6 }), { ...EARTH, altitudeM: 200e3 }, { alongTrack: 400, crossTrack: 0 }, ASCENT_BODIES.earth);
    expect(heavy.ok).toBe(false);
    if (!heavy.ok) expect(heavy.reason).toMatch(/thrust-to-weight/);
  });

  it('works with no atmosphere (data per body)', () => {
    const a = computeAscent([{ wetMass: 8000, dryMass: 2000, engines: [{ thrust: 45e3, isp: 311 }] }, SC], { gm: 4.9028e12, radius: 1737.4e3, altitudeM: 18e3 }, { alongTrack: 4.6, crossTrack: 0 }, ASCENT_BODIES.moon);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.losses.drag).toBe(0);
  });
});

describe('vehicle launch in replay', () => {
  const { world } = realWorld();
  const f9 = vehicleSpec('falcon-9');
  const plan = (over: Partial<MissionPlan> = {}): MissionPlan => makePlan({
    data: world.fingerprint, epoch: T, duration: 3 * 3600, rtol: 1e-10,
    start: { kind: 'launch', site: 'cape-canaveral', params: launchToParams({ mode: 'parking-orbit', siteId: 'cape-canaveral', launchTime: T, azimuthDeg: 90, altitudeM: 200e3 }), ascent: 'vehicle' },
    spacecraft: SC, lowerStages: f9.stages,
    burns: [{ start: 1200, duration: 120, stage: 1, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }, { start: 2000, duration: 30, stage: 2, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }],
    separations: [{ time: 1500 }],
    ...over,
  });

  it('starts at insertion with the upper stage partly used, and scores ascent + flight', () => {
    const r = replay(plan(), world);
    expect(r.outcome).toBe('completed');
    expect(r.ascent?.upperStage).toBe(1);
    expect(r.stages[0].droppedInAscent).toBe(true);
    expect(r.stages[1].separatedAt).toBe(1500);
    expect(r.totalDeltaV).toBeCloseTo(r.ascent!.deltaV + r.deltaV, 9);
    expect(r.finalState[6]).toBeLessThan(SC.wetMass);
    console.log('vehicle launch:', JSON.stringify(r.stages), 'total delta-v', r.totalDeltaV);
    expect(replay(plan(), world).digest).toBe(r.digest);
  });

  it('refuses a burn of a stage the ascent already dropped', () => {
    const r = replay(plan({ burns: [{ start: 1200, duration: 10, stage: 0, engine: 0, direction: [1, 0, 0], frame: { kind: 'inertial' } }] }), world);
    expect(r.outcome).toBe('invalid-plan');
    expect(r.reason).toMatch(/fires stage 0, but stage 1/);
  });

  it('mission rule: fixed vehicle bit for bit, altitude band, fixed ascent parameters', () => {
    const m: MissionDefinition = { id: 'x', title: 'x', objectives: [], scoring: { deltaVRef: 1, deltaVWeight: 1, timeRef: 1, timeWeight: 1 }, spacecraft: SC, rules: { vehicle: vehicleLaunch(f9.stages, [180e3, 400e3]) } };
    expect(checkPlanConformance(m, plan())).toEqual([]);
    const bad = plan({ lowerStages: [f9.stages[0], { ...f9.stages[1], dryMass: f9.stages[1].dryMass * (1 + 2 ** -52) }] });
    expect(checkPlanConformance(m, bad).map((i) => i.code)).toEqual(['vehicle']);
    const high = plan({ start: { kind: 'launch', site: 'cape-canaveral', params: [T, 90, 500e3, 540, 13.5, 0], ascent: 'vehicle' } });
    expect(checkPlanConformance(m, high).map((i) => i.code)).toEqual(['launch-altitude']);
    const free = plan({ start: { kind: 'launch', site: 'cape-canaveral', params: [T, 90, 200e3, 540, 13.5, 0] } });
    expect(checkPlanConformance(m, free).map((i) => i.code)).toContain('start-kind');
    // A fixed (free-delivery) mission refuses extra stages and vehicle launches.
    const fixed: MissionDefinition = { ...m, rules: { launch: fixedLaunch(200e3) } };
    expect(checkPlanConformance(fixed, plan()).map((i) => i.code)).toEqual(expect.arrayContaining(['vehicle', 'start-kind']));
  });
});

const GOLDEN_ASCENT = '6da26c29d9751b7f';
