/**
 * Direct injection (ascent.ts computeDirectAscent, launch.ts
 * directInjectionState, plan format 3, replay, mission rules): determinism
 * pinned by a golden hash, behaviour, validation codes, encoding round trip
 * and fuzz, and end-to-end flights to the Moon with the real ephemeris.
 */
import { describe, expect, it } from 'vitest';
import { ASCENT_BODIES, computeAscent, computeDirectAscent, type DirectAscentResult } from '../src/mission/ascent';
import { Hasher } from '../src/mission/exact-math';
import { c3ForApoapsis, departureGeometry, directInjectionWindows } from '../src/mission/direct-planning';
import { directToParams, launchGeometry, launchSite } from '../src/mission/launch';
import { checkPlanConformance, vehicleLaunch, type MissionDefinition } from '../src/mission/objectives';
import { decodePlan, encodePlan, makePlan, PlanError, SOLID, validatePlanIssues, type MissionPlan, type Stage } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { J2000_BODIES } from '../src/physics/solar-system';
import { SOLID_VEHICLES, vehicleSpec, VEHICLES, withSpacecraft } from '../src/mission/vehicles';
import { EARTH } from './helpers/direct';
import { realWorld } from './helpers/real-world';

const T = 8.5e8;
const SC: Stage = { wetMass: 2000, dryMass: 1400, engines: [{ thrust: 440, isp: 320 }] };
const LUNAR_C3 = c3ForApoapsis(EARTH.gm, EARTH.radius + 185e3, 384400e3);

function hashDirect(a: DirectAscentResult): string {
  const h = new Hasher();
  if (!a.ok) return h.str(a.reason).f64(a.liftoffTW).hex();
  h.u32(a.upperStage).f64(a.upperPropellant).f64(a.massAtInsertion).f64(a.deltaV).f64(a.kick).f64(a.achievedC3).f64(a.shortfall).str(a.cutoff);
  for (const v of Object.values(a.losses)) h.f64(v);
  for (const v of Object.values(a.burnout)) h.f64(v);
  for (const s of a.stages) h.f64(s.propellantUsed).f64(s.deltaV).f64(s.time);
  return h.hex();
}

function cases(): DirectAscentResult[] {
  const out: DirectAscentResult[] = [];
  for (const v of [...VEHICLES, ...SOLID_VEHICLES]) {
    for (const [site, az, c3, hI] of [['cape-canaveral', 90, LUNAR_C3, 185e3], ['vandenberg', 190, -50e6, 400e3], ['kourou', 45, 12e6, 250e3]] as const) {
      const sc = v.class === 'small' ? { ...SC, wetMass: 150, dryMass: 100 } : SC;
      out.push(computeDirectAscent(withSpacecraft(v, sc), { ...EARTH, c3, injectionAltitudeM: hI }, launchGeometry(launchSite(site), T, az), ASCENT_BODIES.earth));
    }
  }
  return out;
}

describe('direct ascent model', () => {
  it('is bit-reproducible, pinned (changing it needs a PHYSICS_MODEL bump)', () => {
    const a = cases().map(hashDirect);
    expect(cases().map(hashDirect)).toEqual(a);
    const all = new Hasher();
    for (const x of a) all.str(x);
    expect(all.hex()).toBe(GOLDEN_DIRECT);
  });

  it('a liquid upper stage shuts down at the target energy; the breakdown adds up', () => {
    const a = computeDirectAscent(withSpacecraft(vehicleSpec('falcon-9'), SC), { ...EARTH, c3: LUNAR_C3, injectionAltitudeM: 185e3 }, launchGeometry(launchSite('cape-canaveral'), T, 90), ASCENT_BODIES.earth);
    if (!a.ok) throw new Error(a.reason);
    expect(a.cutoff).toBe('target');
    expect(a.shortfall).toBe(0);
    expect(Math.abs(a.achievedC3 - LUNAR_C3)).toBeLessThan(1e4);
    expect(a.upperPropellant).toBeGreaterThan(0);
    expect(Math.abs(a.burnout.altitudeM - 185e3)).toBeLessThan(5000);
    const L = a.losses;
    expect(Math.abs(L.injectionSpeed + L.rotation + L.gravity + L.drag + L.steering + L.backPressure - a.deltaV)).toBeLessThan(5);
    // Time and downrange come from the ascent, not the parking orbit's fixed 540 s and 13.5 deg.
    expect(a.burnout.time).toBeGreaterThan(400);
    expect(a.burnout.downrange).toBeGreaterThan(13.5 * (Math.PI / 180));
    console.log('Falcon 9 direct to lunar C3:', JSON.stringify({ deltaV: a.deltaV, burnout: a.burnout, losses: L }));
  });

  it('solids burn to depletion: overshoot (light payload) or shortfall (heavy)', () => {
    const g = launchGeometry(launchSite('cape-canaveral'), T, 90);
    const lower = vehicleSpec('minotaur-v').stages;
    const light = computeDirectAscent([...lower, { ...SC, wetMass: 200, dryMass: 150 }], { ...EARTH, c3: LUNAR_C3, injectionAltitudeM: 185e3 }, g, ASCENT_BODIES.earth);
    const heavy = computeDirectAscent([...lower, { ...SC, wetMass: 1500, dryMass: 1000 }], { ...EARTH, c3: LUNAR_C3, injectionAltitudeM: 185e3 }, g, ASCENT_BODIES.earth);
    if (!light.ok || !heavy.ok) throw new Error('ascent failed');
    expect(light.cutoff).toBe('depletion');
    expect(light.achievedC3).toBeGreaterThan(LUNAR_C3 + 5e6);
    expect(light.upperPropellant).toBeCloseTo(0, 6);
    expect(heavy.shortfall).toBeGreaterThan(0);
    expect(heavy.upperStage).toBe(lower.length - 1);
    // An early target: the stage burning when it is reached is a solid, so it burns out and no later stage is lit.
    const early = computeDirectAscent([...lower, { ...SC, wetMass: 200, dryMass: 150 }], { ...EARTH, c3: -55e6, injectionAltitudeM: 185e3 }, g, ASCENT_BODIES.earth);
    if (!early.ok) throw new Error(early.reason);
    expect(early.upperStage).toBeLessThan(lower.length - 1);
    expect(early.achievedC3).toBeGreaterThan(-55e6);
  });

  it('a parking orbit refuses a solid upper stage and a non-restartable circularisation', () => {
    const g = launchGeometry(launchSite('cape-canaveral'), T, 90);
    const solid = computeAscent([...vehicleSpec('minotaur-v').stages, SC], { ...EARTH, altitudeM: 185e3 }, g, ASCENT_BODIES.earth);
    expect(solid.ok).toBe(false);
    if (!solid.ok) expect(solid.reason).toMatch(/cannot shut down/);
    const f9 = vehicleSpec('falcon-9').stages;
    const once = [f9[0], { ...f9[1], engines: [{ ...f9[1].engines[0], restartable: false }] }, SC];
    expect(computeAscent(once, { ...EARTH, altitudeM: 185e3 }, g, ASCENT_BODIES.earth).ok).toBe(true);
    const high = computeAscent(once, { ...EARTH, altitudeM: 600e3 }, g, ASCENT_BODIES.earth);
    expect(high.ok).toBe(false);
    if (!high.ok) expect(high.reason).toMatch(/cannot restart/);
  });
});

describe('direct-injection plans', () => {
  const { world, eph } = realWorld();
  const lower = vehicleSpec('atlas-v-401').stages;
  const plan = (over: Partial<MissionPlan> = {}, params?: number[]): MissionPlan => makePlan({
    data: world.fingerprint, epoch: T, duration: 3 * 86400, rtol: 1e-10,
    start: { kind: 'launch', site: 'cape-canaveral', params: params ?? directToParams({ mode: 'direct', siteId: 'cape-canaveral', launchTime: T, azimuthDeg: 90, c3: LUNAR_C3, injectionAltitudeM: 185e3, flightStartS: 1500 }), ascent: 'direct' },
    spacecraft: SC, lowerStages: lower, burns: [], separations: [], ...over,
  });
  const codes = (p: MissionPlan) => validatePlanIssues(p).map((i) => i.code);

  it('is format 3 and round-trips exactly; flag-free plans keep their format', () => {
    const p = plan();
    expect(p.format).toBe(3);
    const s = encodePlan(p);
    expect(decodePlan(s)).toEqual(p);
    expect(encodePlan(decodePlan(s))).toBe(s);
    const flags = makePlan({ ...plan(), start: { kind: 'launch', site: 'cape-canaveral', params: [T, 90, 200e3], ascent: 'vehicle' }, lowerStages: vehicleSpec('minotaur-v').stages, separations: [] });
    expect(flags.format).toBe(3);
    expect(decodePlan(encodePlan(flags))).toEqual(flags);
    const { format: _f, model: _m, ...rest } = plan();
    void _f; void _m;
    expect(makePlan({ ...rest, start: { kind: 'launch', site: 'cape-canaveral', params: [T, 90, 200e3], ascent: 'vehicle' } }).format).toBe(2);
  });

  it('validates with structured codes', () => {
    expect(codes(plan())).toEqual([]);
    expect(codes(plan({}, [T, 90, LUNAR_C3, 185e3]))).toContain('launch-params');
    expect(codes(plan({}, [T, 90, 1e12, 185e3, 1500]))).toContain('launch-c3');
    expect(codes(plan({}, [T, 90, LUNAR_C3, 50e3, 1500]))).toContain('launch-altitude');
    expect(codes(plan({}, [T, 200, LUNAR_C3, 185e3, 1500]))).toContain('launch-azimuth');
    expect(codes(plan({}, [T, 90, LUNAR_C3, 185e3, -1]))).toContain('launch-ascent');
    expect(codes(plan({}, [T + 1, 90, LUNAR_C3, 185e3, 1500]))).toContain('launch-epoch');
    expect(codes(plan({ lowerStages: [] }))).toContain('stages');
    expect(codes(plan({ duration: 1000 }))).toContain('launch-duration');
    expect(codes(plan({ burns: [{ start: 1000, duration: 10, stage: 1, engine: 0, direction: [1, 0, 0], frame: { kind: 'inertial' } }] }))).toContain('burn-before-insertion');
    expect(codes({ ...plan(), format: 2 })).toContain('format');
    const bad = { ...plan(), spacecraft: { ...SC, engines: [{ thrust: 440, isp: 320, restartable: 'no' as unknown as boolean }] } };
    expect(codes(bad)).toContain('engine-flags');
    const kick: Stage = { wetMass: 1000, dryMass: 100, engines: [{ thrust: 50e3, isp: 290, ...SOLID }] };
    const kp = (burns: MissionPlan['burns']) => plan({ spacecraft: kick, burns });
    const b = (start: number, duration: number) => ({ start, duration, stage: 2, engine: 0, direction: [1, 0, 0] as const, frame: { kind: 'inertial' as const } });
    expect(codes(kp([b(2000, 100)]))).toEqual([]);
    expect(codes(kp([b(2000, 10)]))).toContain('engine-throttle');
    expect(codes(kp([b(2000, 100), b(3000, 100)]))).toContain('engine-restart');
  });

  it('replay refuses a burnout after the declared flight start, and a relight of a non-restartable stage lit in the ascent', () => {
    const late = replay(plan({}, [T, 90, LUNAR_C3, 185e3, 600]), world);
    expect(late.outcome).toBe('invalid-plan');
    expect(late.reason).toMatch(/launch-burnout/);
    const once = [lower[0], { ...lower[1], engines: [{ ...lower[1].engines[0], restartable: false }] }];
    const r = replay(plan({ lowerStages: once, burns: [{ start: 2000, duration: 10, stage: 1, engine: 0, direction: [1, 0, 0], frame: { kind: 'inertial' } }] }), world);
    expect(r.outcome).toBe('invalid-plan');
    expect(r.reason).toMatch(/cannot restart/);
  });

  it('encoding fuzz: random direct plans round-trip; mutated strings decode to canonical plans or are refused', () => {
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    let accepted = 0;
    for (let n = 0; n < 200; n++) {
      const eng = () => ({ thrust: 1e3 + rnd() * 1e6, isp: 200 + rnd() * 250, ...(rnd() < 0.5 ? { restartable: false } : {}), ...(rnd() < 0.3 ? { throttleable: false } : {}) });
      const st = (): Stage => { const dry = 100 + rnd() * 1e4; return { wetMass: dry * (1 + rnd() * 10), dryMass: dry, engines: [eng()] }; };
      const p = makePlan({
        data: world.fingerprint, epoch: T + rnd() * 1e7, duration: 1e5 + rnd() * 1e6, rtol: 1e-10,
        start: { kind: 'launch', site: 'kourou', params: [0, rnd() * 90, -50e6 + rnd() * 100e6, 150e3 + rnd() * 1e6, 600 + rnd() * 3000], ascent: 'direct' },
        spacecraft: st(), lowerStages: [st(), st()], burns: [], separations: [{ time: 5000 + rnd() * 1e4 }],
      });
      const q = { ...p, start: { ...p.start, params: [p.epoch, ...(p.start as { readonly params: readonly number[] }).params.slice(1)] } } as MissionPlan;
      const s = encodePlan(q);
      expect(decodePlan(s)).toEqual(q);
      for (let k = 0; k < 5; k++) {
        const i = Math.floor(rnd() * s.length);
        const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(rnd() * 64)];
        const m = s.slice(0, i) + c + s.slice(i + 1);
        try {
          const d = decodePlan(m);
          expect(encodePlan(d)).toBe(m);
          accepted++;
        } catch (e) {
          expect(e).toBeInstanceOf(PlanError);
        }
      }
    }
    console.log(`direct fuzz: ${accepted} of 1000 mutations decoded to valid plans`);
  });

  it('flies to the Moon: Atlas V 401 from the Cape, window from the planning aid, replayed with the real ephemeris', () => {
    const stages = [...lower, SC];
    const w = directInjectionWindows({ site: launchSite('cape-canaveral'), stages, c3: LUNAR_C3, injectionAltitudeM: 185e3, target: { kind: 'body', id: 'moon', ephem: eph, bodies: J2000_BODIES }, tStart: T, tEnd: T + 3 * 86400, step: 120 }).find((x) => x.azimuthAllowed && x.converged);
    if (!w) throw new Error('no window');
    const p = makePlan({
      data: world.fingerprint, epoch: w.t, duration: 6 * 86400, rtol: 1e-10,
      start: { kind: 'launch', site: 'cape-canaveral', params: directToParams({ mode: 'direct', siteId: 'cape-canaveral', launchTime: w.t, azimuthDeg: w.azimuthDeg, c3: LUNAR_C3, injectionAltitudeM: 185e3, flightStartS: 1500 }), ascent: 'direct' },
      spacecraft: SC, lowerStages: lower, burns: [], separations: [{ time: 1500 }],
    });
    const r = replay(p, world, { bodies: ['earth', 'moon'] });
    expect(r.outcome).toBe('completed');
    expect(r.launch!.t).toBe(w.t + r.directAscent!.burnout.time);
    expect(r.stages[0].droppedInAscent).toBe(true);
    expect(r.stages[1].separatedAt).toBe(1500);
    expect(r.totalDeltaV).toBe(r.directAscent!.deltaV + r.deltaV);
    const moon = r.events.filter((e) => e.kind === 'periapsis' && e.body === 'moon');
    expect(moon.length).toBeGreaterThan(0);
    const closest = Math.min(...moon.map((e) => e.distance));
    console.log('Atlas V direct lunar flight:', JSON.stringify({ liftoff: w.t, azimuth: w.azimuthDeg, rateDegPerMin: w.errorRateDegPerMin, burnout: r.directAscent!.burnout, closestMoonKm: closest / 1e3, hours: (moon[0].t - w.t) / 3600, digest: r.digest }));
    expect(closest).toBeLessThan(30_000e3);
    expect(replay(p, world, { bodies: ['earth', 'moon'] }).digest).toBe(r.digest);
    expect(r.digest).toBe(GOLDEN_FLIGHT);
  });

  it('all-solid: Minotaur V from Kourou, payload set so the solids burn out on the lunar C3', () => {
    const site = launchSite('kourou');
    const minotaur = vehicleSpec('minotaur-v').stages;
    const sc = (m: number): Stage => ({ wetMass: m, dryMass: 0.7 * m, engines: [{ thrust: 440, isp: 320 }] });
    const m = 528;
    const w = directInjectionWindows({ site, stages: [...minotaur, sc(m)], c3: LUNAR_C3, injectionAltitudeM: 185e3, target: { kind: 'body', id: 'moon', ephem: eph, bodies: J2000_BODIES }, tStart: T + 43 * 86400, tEnd: T + 46 * 86400, step: 60 }).find((x) => x.azimuthAllowed);
    if (!w) throw new Error('no window');
    const g = departureGeometry(w.ascent.burnout, EARTH.gm, EARTH.radius);
    const p = makePlan({
      data: world.fingerprint, epoch: w.t, duration: 6 * 86400, rtol: 1e-10,
      start: { kind: 'launch', site: 'kourou', params: directToParams({ mode: 'direct', siteId: 'kourou', launchTime: w.t, azimuthDeg: w.azimuthDeg, c3: LUNAR_C3, injectionAltitudeM: 185e3, flightStartS: 600 }), ascent: 'direct' },
      spacecraft: sc(m), lowerStages: minotaur, burns: [],
    });
    const r = replay(p, world, { bodies: ['earth', 'moon'] });
    expect(r.outcome).toBe('completed');
    expect(r.directAscent!.cutoff).toBe('depletion');
    const closest = Math.min(...r.events.filter((e) => e.kind === 'periapsis' && e.body === 'moon').map((e) => e.distance));
    console.log('Minotaur V direct lunar flight:', JSON.stringify({ liftoffDay: (w.t - T) / 86400, azimuth: w.azimuthDeg, rateDegPerMin: w.errorRateDegPerMin, apoapsisKm: g.apoapsisRadius / 1e3, achievedC3: r.directAscent!.achievedC3, closestMoonKm: closest / 1e3 }));
    expect(closest).toBeLessThan(30_000e3);
  });
});

describe('mission rules for direct injection', () => {
  const { world } = realWorld();
  const minotaur = vehicleSpec('minotaur-v').stages;
  const base: MissionDefinition = { id: 'x', title: 'x', objectives: [], scoring: { deltaVRef: 1, deltaVWeight: 1, timeRef: 1, timeWeight: 1 }, spacecraft: SC, rules: { vehicle: vehicleLaunch(minotaur, [180e3, 400e3]) } };
  const direct = makePlan({ data: world.fingerprint, epoch: T, duration: 86400, rtol: 1e-10, start: { kind: 'launch', site: 'kourou', params: [T, 90, LUNAR_C3, 185e3, 600], ascent: 'direct' }, spacecraft: SC, lowerStages: minotaur, burns: [] });
  const parking = makePlan({ ...direct, start: { kind: 'launch', site: 'kourou', params: [T, 90, 200e3, 540, 13.5, 0], ascent: 'vehicle' } });

  it('missions allow parking orbit only unless they list direct injection', () => {
    expect(checkPlanConformance(base, parking)).toEqual([]);
    expect(checkPlanConformance(base, direct).map((i) => i.code)).toEqual(['launch-mode']);
    const both: MissionDefinition = { ...base, rules: { ...base.rules, launchModes: ['parking-orbit', 'direct'] } };
    expect(checkPlanConformance(both, direct)).toEqual([]);
    const onlyDirect: MissionDefinition = { ...base, rules: { ...base.rules, launchModes: ['direct'] } };
    expect(checkPlanConformance(onlyDirect, parking).map((i) => i.code)).toEqual(['launch-mode']);
  });

  it('bands on injection altitude and C3, the vehicle bit for bit with its flags, and a non-restartable requirement', () => {
    const m: MissionDefinition = { ...base, rules: { vehicle: { ...vehicleLaunch(minotaur, [180e3, 400e3]), direct: { injectionAltitude: [150e3, 200e3], c3: [-3e6, -1e6] } }, launchModes: ['direct'], nonRestartableVehicle: true } };
    expect(checkPlanConformance(m, direct)).toEqual([]);
    const hi = makePlan({ ...direct, start: { ...direct.start, params: [T, 90, 5e6, 300e3, 600] } as MissionPlan['start'] });
    expect(checkPlanConformance(m, hi).map((i) => i.code).sort()).toEqual(['launch-altitude', 'launch-c3']);
    const liquid = minotaur.map((s) => ({ ...s, engines: s.engines.map((e) => ({ thrust: e.thrust, isp: e.isp })) }));
    const swapped = makePlan({ ...direct, lowerStages: liquid });
    const c = checkPlanConformance(m, swapped).map((i) => i.code);
    expect(c).toContain('vehicle');
    expect(c).toContain('vehicle-restartable');
  });
});

const GOLDEN_DIRECT = '08817ab50512c26b';
const GOLDEN_FLIGHT = '17e81889ca5649c9';
