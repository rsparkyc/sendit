import { describe, expect, it } from 'vitest';
import { decodePlan, encodePlan, fromBase64Url, LIMITS, makePlan, PlanError, toBase64Url, validatePlan, type MissionPlan, type PlanBurn } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { earthOnlyWorld } from './helpers/mission-worlds';

const burn = (start: number, i = 0): PlanBurn => ({
  start,
  duration: 123.456789,
  engine: 0,
  direction: [1, 0.1 * i, -0.3],
  frame: i % 2 === 0 ? { kind: 'orbital', body: 'earth' } : { kind: 'inertial' },
});

const plan = (nBurns: number): MissionPlan =>
  makePlan({
    data: '0123abcd',
    epoch: 8.5e8 + 0.1,
    duration: 3 * 86400 + 1 / 3,
    rtol: 1e-10,
    start: { kind: 'state', center: 'earth', state: [6.678e6 + 0.1, -0, 1e-300, Math.PI, 7725.84 + 1e-9, 5e-324] },
    spacecraft: { wetMass: 12000, dryMass: 3000.5, engines: [{ thrust: 100e3, isp: 320 }, { thrust: 400, isp: 3100 }] },
    burns: Array.from({ length: nBurns }, (_, i) => burn(1000 + 10_000 * i, i)),
  });

const bits = (x: number) => {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return v.getBigUint64(0);
};

/** Deep equality comparing floats by bits (so -0 vs 0 and every ulp matter). */
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

describe('mission plan encoding', () => {
  it('round-trips every float64 bit-exactly', () => {
    for (const n of [0, 1, 2, 5, 20]) {
      const p = plan(n);
      const s = encodePlan(p);
      expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
      const q = decodePlan(s);
      expect(sameBits(p, q)).toBe(true);
      expect(encodePlan(q)).toBe(s);
    }
    // Random doubles (any bit pattern that passes validation) in the start state.
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    for (let k = 0; k < 200; k++) {
      const state = Array.from({ length: 6 }, (_, i) => (rnd() - 0.5) * (i < 3 ? 1e10 : 1e4) * 2 ** -Math.floor(rnd() * 40));
      const p: MissionPlan = { ...plan(1), start: { kind: 'state', center: 'earth', state } };
      expect(sameBits(decodePlan(encodePlan(p)), p)).toBe(true);
    }
  });

  it('is short enough for a link', () => {
    const sizes = [1, 2, 4, 10].map((n) => [n, encodePlan(plan(n)).length]);
    console.log('encoded plan length (chars) by burn count:', JSON.stringify(sizes));
    expect(encodePlan(plan(2)).length).toBeLessThan(400);
    expect(encodePlan(plan(10)).length).toBeLessThan(1000);
  });

  it('supports a launch start (seam for the launch module)', () => {
    const base = plan(1);
    const p: MissionPlan = { ...base, start: { kind: 'launch', site: 'cape', params: [base.epoch, 90, 200e3, 540] } };
    expect(sameBits(decodePlan(encodePlan(p)), p)).toBe(true);
    const w = earthOnlyWorld();
    const q = { ...p, data: w.fingerprint };
    expect(replay(q, w).outcome).toBe('unsupported-start');
    const r = replay(q, w, { resolveLaunch: () => [6.678e6, 0, 0, 0, 7725.8, 0] });
    expect(r.outcome).toBe('completed');
    // Simulation starts at insertion; elapsed counts from liftoff (the epoch).
    expect(r.elapsed).toBe(p.duration);
    // Time rules: epoch is liftoff, no burns before insertion.
    expect(validatePlan({ ...p, epoch: p.epoch + 1 }).join()).toMatch(/launch time\) must equal epoch/);
    expect(validatePlan({ ...p, burns: [burn(100)] }).join()).toMatch(/before orbit insertion/);
  });

  it('base64url is strict', () => {
    const bytes = Uint8Array.from({ length: 50 }, (_, i) => (i * 37) & 255);
    for (let n = 0; n <= 50; n++) expect(Array.from(fromBase64Url(toBase64Url(bytes.slice(0, n))))).toEqual(Array.from(bytes.slice(0, n)));
    expect(() => fromBase64Url('AB=')).toThrow(PlanError);
    expect(() => fromBase64Url('A')).toThrow(PlanError);
    expect(() => fromBase64Url('AB')).toThrow(/canonical/); // stray low bits
  });

  it('rejects malformed input with PlanError only, never anything else', () => {
    const good = encodePlan(plan(3));
    const bytes = fromBase64Url(good);
    const attempts: string[] = ['', 'x', 'é', '!!!!', 'AAAA', good + 'AA', 'A'.repeat(LIMITS.maxEncodedLength + 1)];
    for (let n = 0; n < bytes.length; n++) attempts.push(toBase64Url(bytes.slice(0, n))); // every truncation
    let seed = 99;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let k = 0; k < 2000; k++) {
      const b = bytes.slice();
      const flips = 1 + Math.floor(rnd() * 3);
      for (let f = 0; f < flips; f++) b[Math.floor(rnd() * b.length)] ^= 1 << Math.floor(rnd() * 8);
      attempts.push(toBase64Url(b));
    }
    for (let k = 0; k < 300; k++) attempts.push(toBase64Url(Uint8Array.from({ length: Math.floor(rnd() * 300) }, () => Math.floor(rnd() * 256))));
    let accepted = 0;
    for (const s of attempts) {
      try {
        const p = decodePlan(s);
        // Anything accepted must be valid and re-encode identically.
        expect(validatePlan(p)).toEqual([]);
        expect(encodePlan(p)).toBe(s);
        accepted++;
      } catch (e) {
        expect(e).toBeInstanceOf(PlanError);
      }
    }
    console.log(`fuzz: ${attempts.length} inputs, ${accepted} decoded to valid plans (bit flips in values), rest rejected`);
  });

  it('gives clear errors and bounds the work a plan can demand', () => {
    const p = plan(2);
    const check = (q: MissionPlan, re: RegExp) => {
      expect(validatePlan(q).join('; ')).toMatch(re);
      expect(() => encodePlan(q)).toThrow(re);
    };
    check({ ...p, duration: LIMITS.maxDuration * 2 }, /duration/);
    check({ ...p, duration: NaN }, /duration/);
    check({ ...p, rtol: 1e-16 }, /rtol/);
    check({ ...p, rtol: 0.1 }, /rtol/);
    check({ ...p, burns: Array.from({ length: LIMITS.maxBurns + 1 }, (_, i) => burn(1000 * i)) }, /at most/);
    check({ ...p, burns: [burn(1000), burn(1050)] }, /sorted/);
    check({ ...p, burns: [{ ...burn(0), engine: 5 }] }, /engine/);
    check({ ...p, burns: [{ ...burn(0), direction: [0, 0, 0] }] }, /zero/);
    check({ ...p, burns: [{ ...burn(0), frame: { kind: 'orbital', body: 'Earth!' } }] }, /frame.body/);
    check({ ...p, spacecraft: { ...p.spacecraft, dryMass: 20000 } }, /dryMass/);
    check({ ...p, start: { kind: 'state', center: 'earth', state: [1, 2, 3] } }, /6 numbers/);
    check({ ...p, start: { kind: 'state', center: 'earth', state: [Infinity, 0, 0, 0, 0, 0] } }, /start.state\[0\]/);
    // Encoded counts beyond limits are rejected before any allocation proportional to them.
    const bytes = fromBase64Url(encodePlan(p));
    expect(() => decodePlan(toBase64Url(Uint8Array.of(...bytes.slice(0, 2), 9, 9)))).toThrow(/truncated/);
    expect(() => decodePlan(toBase64Url(Uint8Array.of(0x53, 7)))).toThrow(/format 7/);
  });

  it('replay refuses a plan made against other data or another physics model', () => {
    const w = earthOnlyWorld();
    const p = { ...plan(1), burns: [], data: w.fingerprint };
    expect(replay(p, w).outcome).toBe('completed');
    const old = replay({ ...p, data: 'deadbeef' }, w);
    expect(old.outcome).toBe('version-mismatch');
    expect(old.reason).toMatch(/deadbeef/);
    expect(replay({ ...p, model: 0 }, w).outcome).toBe('version-mismatch');
    expect(replay({ ...p, data: 'deadbeef' }, w, { allowVersionMismatch: true }).outcome).toBe('completed');
  });
});
