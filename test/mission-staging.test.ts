/**
 * Staged vehicles (plan format 2): simulation, validation, encoding, and that
 * format-1 plans are untouched.
 */
import { describe, expect, it } from 'vitest';
import { G0, FixedBodies } from '../src/physics/spacecraft';
import { makeWorld } from '../src/mission/world';
import {
  decodePlan, encodePlan, flightActions, fromBase64Url, LIMITS, makePlan, PLAN_FORMAT, PLAN_FORMAT_STAGED, PlanError, toBase64Url,
  validatePlan, validatePlanIssues, type MissionPlan, type PlanBurn, type Stage,
} from '../src/mission/plan';
import { replay } from '../src/mission/replay';

// Free space: one negligible mass far away.
const world = makeWorld(new FixedBodies([{ gm: 1e-9, position: [0, 0, 0] }]), [{ id: 'earth', radius: 1, atmosphere: 0, pole: [0, 0, 1] }], [0, 0, 0]);
const START = { kind: 'state' as const, center: 'earth', state: [1e12, 0, 0, 0, 0, 0] };

const booster: Stage = { wetMass: 10000, dryMass: 1000, engines: [{ thrust: 100e3, isp: 300 }] };
const craft: Stage = { wetMass: 2000, dryMass: 500, engines: [{ thrust: 10e3, isp: 400 }, { thrust: 500, isp: 3000 }] };
const burn = (start: number, duration: number, stage: number, engine = 0, direction: [number, number, number] = [1, 0, 0]): PlanBurn => ({ start, duration, stage, engine, direction, frame: { kind: 'inertial' } });

function staged(over: Partial<MissionPlan> = {}): MissionPlan {
  return makePlan({
    data: world.fingerprint, epoch: 0, duration: 5000, rtol: 1e-12, start: START,
    spacecraft: craft, lowerStages: [booster],
    burns: [burn(10, 380, 0), burn(500, 2000, 1)],
    separations: [{ time: 400 }],
    ...over,
  });
}

const speed = (y: readonly number[]) => Math.hypot(y[3], y[4], y[5]);
const rel = (a: number, b: number) => Math.abs(a / b - 1);

describe('staged simulation', () => {
  it('two stages in free space match the staged rocket equation', () => {
    const r = replay(staged(), world);
    expect(r.outcome).toBe('completed');
    const dv0 = 300 * G0 * Math.log(12000 / 3000);
    const dv1 = 400 * G0 * Math.log(2000 / 500);
    console.log(`staged rocket eq: ${speed(r.finalState)} vs ${dv0 + dv1} m/s`);
    expect(rel(speed(r.finalState), dv0 + dv1)).toBeLessThan(1e-11);
    expect(r.finalState[6]).toBe(500);
    expect(rel(r.stages[0].deltaV, dv0)).toBeLessThan(1e-12);
    expect(rel(r.stages[1].deltaV, dv1)).toBeLessThan(1e-12);
    expect(r.stages[0]).toMatchObject({ propellantUsed: 9000, propellantLeft: 0, separatedAt: 400, droppedInAscent: false });
    expect(r.stages[1]).toMatchObject({ propellantUsed: 1500, propellantLeft: 0, separatedAt: null });
    expect(r.totalDeltaV).toBe(r.deltaV);
  });

  it('burns cut off when the active stage is empty, not the vehicle', () => {
    const r = replay(staged(), world);
    // Stage 0 holds 9000 kg at 100e3/(300 g0) kg/s: 264.8 s of the 380 s asked for.
    // (burnTime is measured over integrator steps, so it may include the step after cutoff.)
    const tDry = 9000 / (100e3 / (300 * G0));
    expect(tDry).toBeLessThan(380);
    expect(r.burns[0].propellant).toBe(9000);
    expect(r.stages[0].propellantLeft).toBe(0);
    // The spacecraft's tanks were not touched by stage 0's burn.
    expect(r.burns[1].propellant).toBe(1500);
  });

  it('a separation drops mass exactly and changes nothing else', () => {
    const one = staged({ burns: [burn(10, 100, 0)], separations: [] });
    const two = staged({ burns: [burn(10, 100, 0)], separations: [{ time: 2000 }] });
    const a = replay(one, world);
    const b = replay(two, world);
    expect(b.finalState[6]).toBe(2000); // the spacecraft, exactly
    expect(a.finalState[6]).toBeGreaterThan(2000);
    for (let i = 0; i < 6; i++) expect(Math.abs(b.finalState[i] - a.finalState[i])).toBeLessThan(1e-6 * (1 + Math.abs(a.finalState[i])));
    expect(b.stages[0].separatedAt).toBe(2000);
    expect(b.stages[0].propellantLeft).toBeCloseTo(9000 - 100 * (100e3 / (300 * G0)), 6);
  });

  it('a separation before a burn starts the next stage with its full tanks', () => {
    const r = replay(staged({ burns: [burn(100, 50, 1)], separations: [{ time: 50 }] }), world);
    expect(r.outcome).toBe('completed');
    expect(r.stages[0].propellantUsed).toBe(0);
    expect(r.stages[0].propellantLeft).toBe(9000);
    expect(rel(speed(r.finalState), r.burns[0].deltaV)).toBeLessThan(1e-11);
  });
});

describe('staged validation', () => {
  const codes = (p: MissionPlan) => validatePlanIssues(p).map((i) => i.code);
  it('reports every staging error with its code', () => {
    expect(codes(staged())).toEqual([]);
    expect(codes(staged({ burns: [burn(10, 100, 1)] }))).toContain('burn-stage'); // spacecraft while the booster is active
    expect(codes(staged({ burns: [burn(500, 100, 0)] }))).toContain('burn-stage'); // booster after it separated
    expect(codes(staged({ burns: [burn(10, 100, 5)] }))).toContain('burn-stage'); // no such stage
    expect(codes(staged({ burns: [burn(10, 100, 0, 3)] }))).toContain('burn-engine');
    expect(codes(staged({ burns: [burn(300, 200, 0)] }))).toContain('burn-spans-separation');
    expect(codes(staged({ separations: [{ time: 400 }, { time: 600 }] }))).toContain('separation-last');
    expect(codes(staged({ separations: [{ time: 600 }, { time: 400 }] }))).toContain('action-order');
    expect(codes(staged({ start: { kind: 'launch', site: 'equator', params: [0, 90, 200e3, 540] }, separations: [{ time: 100 }], burns: [] }))).toContain('separation-before-insertion');
    expect(codes(staged({ start: START, lowerStages: [] , separations: [], burns: [], format: PLAN_FORMAT } as Partial<MissionPlan>))).toContain('format');
    expect(codes(staged({ start: { kind: 'launch', site: 'equator', params: [0, 90, 200e3], ascent: 'vehicle' }, lowerStages: [], separations: [], burns: [] }))).toContain('stages');
    expect(codes(staged({ lowerStages: Array.from({ length: LIMITS.maxStages }, () => booster) }))).toContain('stages');
    // replay refuses them too
    expect(replay(staged({ burns: [burn(300, 200, 0)] }), world).outcome).toBe('invalid-plan');
  });

  it('merges burns and separations into one time-ordered action list', () => {
    expect(flightActions(staged()).map((a) => [a.kind, a.t])).toEqual([['burn', 10], ['separation', 400], ['burn', 500]]);
    expect(flightActions(staged({ burns: [burn(400, 1, 1)] })).map((a) => a.kind)).toEqual(['separation', 'burn']);
  });
});

const bits = (x: number) => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, x); return v.getBigUint64(0); };
function sameBits(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return bits(a) === bits(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameBits(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return sameBits(ka, kb) && ka.every((k) => sameBits((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

describe('staged encoding', () => {
  it('round-trips staged plans bit-exactly in format 2', () => {
    const plans = [
      staged(),
      staged({ start: { kind: 'launch', site: 'cape-canaveral', params: [0, 90, 200e3, 540, 13.5, 0], ascent: 'vehicle' }, burns: [burn(600, 10, 0), burn(700, 1, 1, 1)], separations: [{ time: 650 }] }),
      staged({ lowerStages: [booster, { ...booster, dryMass: 1 / 3 }], burns: [burn(0, 1, 0), burn(3, 1, 1), burn(5, 1, 2)], separations: [{ time: 2 }, { time: 5 }] }),
    ];
    for (const p of plans) {
      expect(p.format).toBe(PLAN_FORMAT_STAGED);
      const s = encodePlan(p);
      expect(fromBase64Url(s)[1]).toBe(2);
      const q = decodePlan(s);
      expect(sameBits(q, p)).toBe(true);
      expect(encodePlan(q)).toBe(s);
    }
  });

  it('keeps one-stage plans in format 1, byte for byte as before', () => {
    const p = makePlan({ data: world.fingerprint, epoch: 0, duration: 10, rtol: 1e-10, start: START, spacecraft: craft, burns: [{ start: 1, duration: 1, engine: 1, direction: [0, 1, 0], frame: { kind: 'inertial' } }] });
    expect(p.format).toBe(PLAN_FORMAT);
    expect(p).not.toHaveProperty('lowerStages');
    // Format 1 layout: magic, format, model, data, 3 f64, start, spacecraft, burns; no stage byte.
    const bytes = fromBase64Url(encodePlan(p));
    expect(bytes[1]).toBe(1);
    expect(bytes.length).toBe(1 + 1 + 2 + 4 + 24 + (1 + 1 + 5 + 48) + (16 + 1 + 32) + 2 + (8 + 8 + 1 + 24 + 1));
  });

  it('refuses actions out of order and fuzzed input with PlanError only', () => {
    const good = encodePlan(staged());
    const bytes = fromBase64Url(good);
    const outOfOrder = staged({ burns: [burn(10, 100, 0)], separations: [{ time: 400 }] });
    const b2 = fromBase64Url(encodePlan(outOfOrder));
    // Last 9 bytes are the separation (u8 1 + f64 time): set its time before the burn's start (10 s).
    const view = new DataView(b2.buffer);
    view.setFloat64(b2.length - 8, 5, true);
    expect(() => decodePlan(toBase64Url(b2))).toThrow(/time order/);

    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const attempts: string[] = [];
    for (let n = 0; n < bytes.length; n++) attempts.push(toBase64Url(bytes.slice(0, n)));
    for (let k = 0; k < 3000; k++) {
      const b = bytes.slice();
      const flips = 1 + Math.floor(rnd() * 3);
      for (let f = 0; f < flips; f++) b[Math.floor(rnd() * b.length)] ^= 1 << Math.floor(rnd() * 8);
      attempts.push(toBase64Url(b));
    }
    for (let k = 0; k < 300; k++) attempts.push(toBase64Url(Uint8Array.from({ length: Math.floor(rnd() * 300) }, (_, i) => (i < 2 ? [0x53, 2][i] : Math.floor(rnd() * 256)))));
    let accepted = 0;
    for (const s of attempts) {
      try {
        const p = decodePlan(s);
        expect(validatePlan(p, { launch: 'structural' })).toEqual([]);
        expect(encodePlan(p)).toBe(s);
        accepted++;
      } catch (e) {
        expect(e).toBeInstanceOf(PlanError);
      }
    }
    console.log(`staged fuzz: ${attempts.length} inputs, ${accepted} decoded to valid plans`);
  });
});
