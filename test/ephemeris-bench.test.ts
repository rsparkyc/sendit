/**
 * Benchmark of ephemeris evaluation and spacecraft propagation, with a profile
 * of where propagation time goes. Not part of `pnpm test`; run with
 * `pnpm bench:ephemeris` (BENCH=1). Reports median and spread (min..max and
 * interquartile range) over repeated runs after warm-up.
 */
import { beforeAll, describe, it } from 'vitest';
import { ChebyshevEphemeris } from '../src/physics/chebyshev-ephemeris';
import { Dop853 } from '../src/physics/dop853';
import { DAY, J2000_BODIES, JULIAN_YEAR, bodyIndex } from '../src/physics/solar-system';
import { propagate, type Ephemeris } from '../src/physics/spacecraft';
import { correctBurn } from '../src/planning/corrector';
import { planDeparture } from '../src/planning/departure';
import { CASES, ENGINE, EPHEM_SPAN, setupCase } from './helpers/planning-cases';

const RUN = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BENCH === '1';
const N = J2000_BODIES.length;
const EARTH = bodyIndex('earth');
const SUN = bodyIndex('sun');

interface Stats { median: number; min: number; max: number; q1: number; q3: number }
function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { median: q(0.5), min: s[0], max: s[s.length - 1], q1: q(0.25), q3: q(0.75) };
}
const fmt = (x: Stats, unit: string, d = 0) =>
  `median ${x.median.toFixed(d)} ${unit} (IQR ${x.q1.toFixed(d)}..${x.q3.toFixed(d)}, range ${x.min.toFixed(d)}..${x.max.toFixed(d)})`;

/** Per-call ns of fn over `times`, `reps` timed passes after `warm` untimed ones. */
function perCall(times: Float64Array, fn: (t: number) => void, reps = 25, warm = 5): Stats {
  const out: number[] = [];
  for (let r = 0; r < warm + reps; r++) {
    const t0 = performance.now();
    for (let i = 0; i < times.length; i++) fn(times[i]);
    const ns = ((performance.now() - t0) * 1e6) / times.length;
    if (r >= warm) out.push(ns);
  }
  return stats(out);
}
function wall(fn: () => void, reps: number, warm = 2): Stats {
  const out: number[] = [];
  for (let r = 0; r < warm + reps; r++) {
    const t0 = performance.now();
    fn();
    if (r >= warm) out.push(performance.now() - t0);
  }
  return stats(out);
}

/** Records every time (and kind) of ephemeris query a propagation makes, and replays them. */
class Recorder implements Ephemeris {
  readonly count: number;
  readonly gm: ArrayLike<number>;
  readonly oblateness?: Ephemeris['oblateness'];
  readonly relativity?: Ephemeris['relativity'];
  posTimes: number[] = [];
  stateCalls: [number, number][] = [];
  constructor(private readonly base: Ephemeris) {
    this.count = base.count;
    this.gm = base.gm;
    this.oblateness = base.oblateness;
    this.relativity = base.relativity;
  }
  positions(t: number, out: Float64Array): void {
    this.posTimes.push(t);
    this.base.positions(t, out);
  }
  bodyState(body: number, t: number, out: Float64Array): void {
    this.stateCalls.push([body, t]);
    this.base.bodyState(body, t, out);
  }
}

/** Serves recorded results in call order: propagation minus ephemeris cost. */
class Replay implements Ephemeris {
  readonly count: number;
  readonly gm: ArrayLike<number>;
  readonly oblateness?: Ephemeris['oblateness'];
  readonly relativity?: Ephemeris['relativity'];
  private ip = 0;
  private is = 0;
  constructor(base: Ephemeris, private readonly pos: Float64Array[], private readonly st: Float64Array[]) {
    this.count = base.count;
    this.gm = base.gm;
    this.oblateness = base.oblateness;
    this.relativity = base.relativity;
  }
  rewind(): void { this.ip = this.is = 0; }
  positions(_t: number, out: Float64Array): void { out.set(this.pos[this.ip++]); }
  bodyState(_b: number, _t: number, out: Float64Array): void { out.set(this.st[this.is++]); }
}

describe.skipIf(!RUN)('ephemeris benchmark', () => {
  let eph: ChebyshevEphemeris;
  beforeAll(() => {
    eph = new ChebyshevEphemeris();
    eph.ensure(-JULIAN_YEAR, 2 * JULIAN_YEAR);
    eph.ensure(...EPHEM_SPAN);
  }, 600_000);

  it('evaluation', () => {
    const C = eph.layout.chunkSpan;
    // Random times over built chunks, and a propagation-like sequence (13 stages of a 600 s step).
    let s = 12345;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    const random = Float64Array.from({ length: 20000 }, () => (-1 + 3 * rnd()) * C);
    const seq = Float64Array.from({ length: 20000 }, (_, i) => 0.3 * C + Math.floor(i / 13) * 600 + ((i % 13) / 12) * 600);
    const pos = new Float64Array(3 * N);
    const vel = new Float64Array(3 * N);
    const one = new Float64Array(6);
    const sub = [bodyIndex('io'), EARTH, bodyIndex('jupiter')];
    const sp = new Float64Array(9);
    const lines = [
      `positions, random:      ${fmt(perCall(random, (t) => eph.positions(t, pos)), 'ns')}`,
      `positions, sequential:  ${fmt(perCall(seq, (t) => eph.positions(t, pos)), 'ns')}`,
      `evaluate pos+vel:       ${fmt(perCall(random, (t) => eph.evaluate(t, pos, vel)), 'ns')}`,
      `evaluateBodies(3):      ${fmt(perCall(random, (t) => eph.evaluateBodies(t, sub, sp, null)), 'ns')}`,
      `bodyState(sun):         ${fmt(perCall(random, (t) => eph.bodyState(SUN, t, one)), 'ns')}`,
      `bodyState(io):          ${fmt(perCall(random, (t) => eph.bodyState(bodyIndex('io'), t, one)), 'ns')}`,
    ];
    console.log(lines.join('\n'));
  }, 600_000);

  const leo = () => {
    const e = new Float64Array(6);
    eph.bodyState(EARTH, 0, e);
    const R = 6_778_000;
    const v = Math.sqrt(J2000_BODIES[EARTH].gm / R);
    return { y0: [e[0] + R, e[1], e[2], e[3], e[4] + v, e[5], 1000], t1: 30 * DAY };
  };
  const helio = () => {
    const e = new Float64Array(6);
    eph.bodyState(EARTH, 0, e);
    const vn = Math.hypot(e[3], e[4], e[5]);
    return { y0: [e[0] + (1e9 * e[3]) / vn, e[1] + (1e9 * e[4]) / vn, e[2] + (1e9 * e[5]) / vn, e[3] * (1 + 3000 / vn), e[4] * (1 + 3000 / vn), e[5] * (1 + 3000 / vn), 1000], t1: JULIAN_YEAR };
  };

  it('propagation and profile', () => {
    for (const [name, mk, reps] of [['LEO 30 d', leo, 15], ['heliocentric 1 yr', helio, 40]] as const) {
      const { y0, t1 } = mk();
      const total = wall(() => propagate(eph, y0, 0, t1), reps);
      // Profile: record the queries, then time (a) the queries alone, (b) the
      // propagation served from the recording (force sum + integrator), (c) the
      // integrator with a trivial right-hand side for the same number of calls.
      const rec = new Recorder(eph);
      const r = propagate(rec, y0, 0, t1);
      const pt = Float64Array.from(rec.posTimes);
      const p = new Float64Array(3 * N);
      const one = new Float64Array(6);
      const ephPos = wall(() => { for (let i = 0; i < pt.length; i++) eph.positions(pt[i], p); }, reps);
      const ephState = wall(() => { for (const [b, t] of rec.stateCalls) eph.bodyState(b, t, one); }, reps);
      const posRec = rec.posTimes.map((t) => { const o = new Float64Array(3 * N); eph.positions(t, o); return o; });
      const stRec = rec.stateCalls.map(([b, t]) => { const o = new Float64Array(6); eph.bodyState(b, t, o); return o; });
      const rp = new Replay(eph, posRec, stRec);
      const replayed = wall(() => { rp.rewind(); propagate(rp, y0, 0, t1); }, reps);
      const calls = rec.posTimes.length;
      const trivial = wall(() => {
        let c = 0;
        const d = new Dop853(7, (_t, y, out) => { c++; out[0] = y[3]; out[1] = y[4]; out[2] = y[5]; out[3] = -y[0] * 1e-30; out[4] = -y[1] * 1e-30; out[5] = -y[2] * 1e-30; out[6] = 0; }, (_y, _yn, sc) => sc.fill(1));
        d.reset(0, y0, 1);
        while (c < calls) d.step(1e30);
      }, reps);
      console.log(
        `${name}: ${r.accepted} steps, ${calls} positions() calls, ${rec.stateCalls.length} bodyState() calls\n` +
          `  total            ${fmt(total, 'ms', 1)}\n` +
          `  positions()      ${fmt(ephPos, 'ms', 1)}\n` +
          `  bodyState()      ${fmt(ephState, 'ms', 1)}\n` +
          `  replayed (force sum + integrator + replay copies) ${fmt(replayed, 'ms', 1)}\n` +
          `  integrator, trivial rhs, same call count          ${fmt(trivial, 'ms', 1)}`,
      );
    }
  }, 600_000);

  it('corrector workload (Earth->Mars, phase 0 and 1 of test/planning-corrector)', () => {
    const c = CASES[0];
    const { p, tArr, t0, parking, target } = setupCase(eph, c);
    const plan = planDeparture(eph, J2000_BODIES, { departure: 'earth', vInf: p.vInfDepVec, tDep: p.tDep, parking, t0, engine: ENGINE });
    let evals = 0;
    const w = wall(() => {
      const r0 = correctBurn(eph, parking, t0, plan.burn, { kind: 'position', body: target, epoch: tArr }, { tolerance: 20000e3 });
      const r1 = correctBurn(eph, parking, t0, r0.burn, { body: target, bt: 1e7, br: 0, epoch: tArr - 5 * DAY, tPeri: tArr }, { tolerance: 1000, maxIterations: 4 });
      evals = r0.evaluations + r1.evaluations;
    }, 5, 1);
    console.log(`corrector: ${evals} propagations per run, ${fmt(w, 'ms')}`);
  }, 600_000);
});
