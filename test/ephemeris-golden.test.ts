/**
 * Golden digests of Chebyshev ephemeris evaluation and of spacecraft
 * propagation on the real 26-body ephemeris.
 *
 * Mission replays are compared bit for bit, so performance work on the
 * evaluation and derivative hot paths must not move a single bit. These
 * digests were recorded with the straightforward per-body implementation
 * (before the grouped-basis evaluation and the derivative trimming); any
 * optimisation must leave every one of them unchanged. If one changes, the
 * results changed: undo the change, do not re-record the digest.
 *
 * Coverage: positions(), evaluate() with and without velocities, bodyState()
 * of every body and evaluateBodies() on several subsets, at a few thousand
 * pseudo-random times over chunks -2..2 (backward- and forward-integrated
 * chunks), at exact chunk and segment boundaries, in random, ascending,
 * descending and repeated-time order (exercising any per-call caching); and
 * full propagations: LEO with Earth J2 and solar 1PN, a heliocentric cruise,
 * finite burns in the inertial and orbital frames, and a pass through the
 * Jovian system (J2/J4, moons), each including every accepted step and dense
 * output samples.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ChebyshevEphemeris } from '../src/physics/chebyshev-ephemeris';
import { DAY, J2000_BODIES, bodyIndex } from '../src/physics/solar-system';
import { propagate, type Burn } from '../src/physics/spacecraft';

const N = J2000_BODIES.length;
let eph: ChebyshevEphemeris;
let C: number;

beforeAll(() => {
  eph = new ChebyshevEphemeris();
  C = eph.layout.chunkSpan;
  eph.ensure(-2 * C, 3 * C - 1);
}, 300_000);

/** Collects float64 bit patterns and hashes them (two independent 32-bit lanes). */
class Digest {
  private h1 = 0x811c9dc5;
  private h2 = 0x9747b28c;
  private n = 0;
  private readonly f = new Float64Array(1);
  private readonly u = new Uint32Array(this.f.buffer);
  add(x: number): void {
    this.f[0] = x;
    for (let i = 0; i < 2; i++) {
      const w = this.u[i];
      this.h1 = Math.imul(this.h1 ^ w, 0x01000193) >>> 0;
      this.h2 = Math.imul((this.h2 ^ w) + 0x9e3779b9, 0x85ebca6b) >>> 0;
      this.h2 = (this.h2 ^ (this.h2 >>> 13)) >>> 0;
    }
    this.n++;
  }
  addAll(a: ArrayLike<number>, n = a.length): void {
    for (let i = 0; i < n; i++) this.add(a[i]);
  }
  hex(): string {
    return `${this.n}:${this.h1.toString(16).padStart(8, '0')}${this.h2.toString(16).padStart(8, '0')}`;
  }
}

/** Deterministic pseudo-random times in [-2C, 3C), plus boundaries. */
function times(): { random: number[]; boundaries: number[] } {
  let s = 0x2545f491;
  const rnd = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
  const random: number[] = [];
  for (let i = 0; i < 3000; i++) random.push((-2 + 5 * rnd()) * C);
  const boundaries: number[] = [];
  const h = eph.layout.h;
  for (let k = -2; k <= 2; k++) {
    for (const steps of [0, 8, 16, 32, 64, 128, 512, 1024, 2048, 4095]) {
      boundaries.push(k * C + steps * h, k * C + steps * h - h / 7, k * C + steps * h + h / 3);
    }
  }
  return { random, boundaries };
}

const SUBSETS: number[][] = [
  [bodyIndex('io'), bodyIndex('earth'), bodyIndex('jupiter')],
  [bodyIndex('sun')],
  [bodyIndex('saturn'), bodyIndex('titan'), bodyIndex('rhea'), bodyIndex('saturn')],
  [bodyIndex('charon'), bodyIndex('pluto'), bodyIndex('moon'), bodyIndex('triton'), bodyIndex('oberon')],
  Array.from({ length: N }, (_, i) => N - 1 - i),
];

function evalDigests(order: number[]): Record<string, string> {
  const pos = new Float64Array(3 * N);
  const vel = new Float64Array(3 * N);
  const one = new Float64Array(6);
  const sp = new Float64Array(3 * N);
  const sv = new Float64Array(3 * N);
  const d = { positions: new Digest(), evaluateNull: new Digest(), evaluateVel: new Digest(), bodyState: new Digest(), evaluateBodies: new Digest() };
  for (const t of order) {
    eph.positions(t, pos);
    d.positions.addAll(pos);
    eph.evaluate(t, pos, null);
    d.evaluateNull.addAll(pos);
    eph.evaluate(t, pos, vel);
    d.evaluateVel.addAll(pos);
    d.evaluateVel.addAll(vel);
    for (let b = 0; b < N; b++) {
      eph.bodyState(b, t, one);
      d.bodyState.addAll(one);
    }
    for (const sub of SUBSETS) {
      eph.evaluateBodies(t, sub, sp, sv);
      d.evaluateBodies.addAll(sp, 3 * sub.length);
      d.evaluateBodies.addAll(sv, 3 * sub.length);
      eph.evaluateBodies(t, sub, sp, null);
      d.evaluateBodies.addAll(sp, 3 * sub.length);
    }
  }
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.hex()]));
}

describe('ephemeris evaluation golden digests', () => {
  it('random times over chunks -2..2', () => {
    expect(evalDigests(times().random)).toEqual({
      positions: '234000:f2bf1017997bd1f8',
      evaluateNull: '234000:f2bf1017997bd1f8',
      evaluateVel: '468000:c78bc69e219dda69',
      bodyState: '468000:d968c5e2d52f2529',
      evaluateBodies: '1053000:16b851d98740fd19',
    });
  }, 120_000);

  it('chunk and segment boundaries', () => {
    expect(evalDigests(times().boundaries)).toEqual({
      positions: '11700:bdf84c523491a6e0',
      evaluateNull: '11700:bdf84c523491a6e0',
      evaluateVel: '23400:2107a658139c033b',
      bodyState: '23400:82d83be0d06c0076',
      evaluateBodies: '52650:97d5f48d87fa4b8d',
    });
  });

  it('ascending, descending and repeated times', () => {
    const r = times().random.slice(0, 600);
    const asc = [...r].sort((a, b) => a - b);
    const desc = [...asc].reverse();
    const rep = r.slice(0, 200).flatMap((t) => [t, t, t + 1e-3, t]);
    expect([evalDigests(asc), evalDigests(desc), evalDigests(rep)]).toEqual([
      {
      positions: '46800:fc59f342d02797eb',
      evaluateNull: '46800:fc59f342d02797eb',
      evaluateVel: '93600:766952d66e06f7db',
      bodyState: '93600:fa75e34e04a34863',
      evaluateBodies: '210600:d4477f243793d28e',
    },
      {
      positions: '46800:939b0b5aeb855bd4',
      evaluateNull: '46800:939b0b5aeb855bd4',
      evaluateVel: '93600:c73f77ce2d832308',
      bodyState: '93600:54b090e692cf7b98',
      evaluateBodies: '210600:73d86038da4b14f9',
    },
      {
      positions: '62400:96e8f308a3b3287a',
      evaluateNull: '62400:96e8f308a3b3287a',
      evaluateVel: '124800:a61b76030befc6ba',
      bodyState: '124800:7a9bf54f1da4b137',
      evaluateBodies: '280800:d7d86f631f8bc71d',
    },
    ]);
  }, 120_000);
});

function runDigest(y0: number[], t0: number, t1: number, burns: Burn[] = [], rtol?: number): string {
  const d = new Digest();
  const tmp = new Float64Array(7);
  const r = propagate(eph, y0, t0, t1, burns, {
    rtol,
    dryMass: 500,
    onStep: (t, y, interp, tPrev) => {
      d.add(t);
      d.addAll(y);
      interp(tPrev + (t - tPrev) * 0.37, tmp);
      d.addAll(tmp);
    },
  });
  d.add(r.t);
  d.addAll(r.y);
  d.add(r.accepted);
  d.add(r.rejected);
  return d.hex();
}

describe('propagation golden digests (real ephemeris)', () => {
  const EARTH = bodyIndex('earth');
  const JUPITER = bodyIndex('jupiter');
  const state = (b: number, t: number) => {
    const s = new Float64Array(6);
    eph.bodyState(b, t, s);
    return s;
  };

  it('LEO 30 days (Earth J2, solar 1PN)', () => {
    const e = state(EARTH, 0);
    const R = 6_778_000;
    const v = Math.sqrt(J2000_BODIES[EARTH].gm / R);
    expect(runDigest([e[0] + R, e[1], e[2], e[3], e[4] + v, e[5], 1000], 0, 30 * DAY)).toBe('185860:bc503785bf2328bb');
  }, 120_000);

  it('LEO backward in time with orbital-frame and inertial burns', () => {
    const t0 = -1.5 * C;
    const e = state(EARTH, t0);
    const R = 6_978_000;
    const v = Math.sqrt(J2000_BODIES[EARTH].gm / R);
    const burns: Burn[] = [
      { tStart: t0 + 3000, duration: 600, thrust: 50e3, isp: 450, direction: [1, 0.1, -0.05], frame: { kind: 'orbital', body: EARTH } },
      { tStart: t0 + 20000, duration: 300, thrust: 20e3, isp: 320, direction: [0.3, -1, 0.2], frame: { kind: 'inertial' } },
    ];
    expect(runDigest([e[0], e[1] + R, e[2], e[3] - v, e[4], e[5] + 100, 20000], t0, t0 + 3 * DAY, burns)).toBe('8590:9e6d6d0ee4e26c47');
  }, 120_000);

  it('heliocentric cruise across chunks', () => {
    const e = state(EARTH, -C);
    const vn = Math.hypot(e[3], e[4], e[5]);
    const y0 = [e[0] + (1e9 * e[3]) / vn, e[1] + (1e9 * e[4]) / vn, e[2] + (1e9 * e[5]) / vn, e[3] * (1 + 3000 / vn), e[4] * (1 + 3000 / vn), e[5] * (1 + 3000 / vn), 1000];
    expect(runDigest(y0, -C, 2.5 * C)).toBe('790:9001f6dcf95a606c');
  }, 120_000);

  it('Jovian system pass (J2/J4, moons, orbital burn about Jupiter)', () => {
    const t0 = 0.3 * C;
    const j = state(JUPITER, t0);
    const y0 = [j[0] + 3e9, j[1] - 1e9, j[2] + 2e8, j[3] - 9000, j[4] + 2500, j[5], 2000];
    const burns: Burn[] = [{ tStart: t0 + 2 * DAY, duration: 900, thrust: 4e3, isp: 320, direction: [-1, 0, 0.2], frame: { kind: 'orbital', body: JUPITER } }];
    expect(runDigest(y0, t0, t0 + 12 * DAY, burns, 1e-11)).toBe('2050:f6221dea061c643e');
  }, 120_000);
});
