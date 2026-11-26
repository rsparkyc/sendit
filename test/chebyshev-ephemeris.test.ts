/**
 * Chebyshev ephemeris: accuracy against the integrator at times the fit did not
 * use, velocity, continuity, backward extension, order-independent bit-exact
 * chunks, speed, storage, and end-to-end spacecraft propagation compared with
 * IntegratedEphemeris.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { KAHAN_LI_8, NBodyIntegrator } from '../src/physics/nbody';
import {
  ChebyshevEphemeris,
  DEFAULT_CHUNK_STEPS,
  buildChunk,
  initialCheckpoint,
  type Checkpoint,
} from '../src/physics/chebyshev-ephemeris';
import { DAY, DEFAULT_STEP, IntegratedEphemeris, J2000_BODIES, JULIAN_YEAR, bodyIndex, initialState, solarSystemPhysics } from '../src/physics/solar-system';
import { propagate, type Ephemeris } from '../src/physics/spacecraft';

const N = J2000_BODIES.length;
/** One ephemeris shared by the read-only tests: building chunks is the expensive part (~1.8 s each). */
let shared: ChebyshevEphemeris;
const SHARED_CHUNKS = 8;
beforeAll(() => {
  shared = new ChebyshevEphemeris();
  const t0 = performance.now();
  shared.ensure(-SHARED_CHUNKS * C, SHARED_CHUNKS * C - 1);
  const ms = performance.now() - t0;
  console.log(`built ${2 * SHARED_CHUNKS} chunks (${((2 * SHARED_CHUNKS * C) / JULIAN_YEAR).toFixed(1)} yr) in ${ms.toFixed(0)} ms: ${(ms / (2 * SHARED_CHUNKS)).toFixed(0)} ms per chunk, ${((2 * SHARED_CHUNKS * C) / JULIAN_YEAR / (ms / 1000)).toFixed(2)} yr of ephemeris per second`);
}, 120_000);
const H = DEFAULT_STEP;
const S = DEFAULT_CHUNK_STEPS;
const C = S * H;
const EARTH = bodyIndex('earth');
const GM = Float64Array.from(J2000_BODIES.map((b) => b.gm));
const PHYSICS = solarSystemPhysics();
/** Short chunks (128 d) for the tests that need many chunks: same code paths, same fits. */
const SMALL = 4096;

function dist3(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number): number {
  return Math.hypot(a[ao] - b[bo], a[ao + 1] - b[bo + 1], a[ao + 2] - b[bo + 2]);
}

/**
 * Walk the integrator `steps` steps in direction dir; at every `every`-th step,
 * call `check(t, pos, vel)` with the integrator's output at off-grid times
 * (one fractional Kahan-Li step from that grid state; local error ~h^9).
 */
function heldOut(steps: number, dir: 1 | -1, every: number, fracs: number[], check: (t: number, pos: Float64Array, vel: Float64Array) => void): void {
  const it = new NBodyIntegrator(GM, initialState(), 0, dir * H, KAHAN_LI_8, PHYSICS);
  const state = new Float64Array(6 * N);
  for (let i = 0; i < steps; i++) {
    if (i % every === 0) {
      it.getState(state);
      for (const f of fracs) {
        const sub = new NBodyIntegrator(GM, state, 0, dir * f * H, KAHAN_LI_8, PHYSICS);
        sub.step();
        check(it.t + dir * f * H, sub.q, sub.v);
      }
    }
    it.step();
  }
}

describe('ChebyshevEphemeris accuracy', () => {
  it('fits every body within 1 cm of the integrator at held-out times, 2.8 years each way', () => {
    const eph = shared;
    const pos = new Float64Array(3 * N);
    const vel = new Float64Array(3 * N);
    const errP = new Float64Array(N);
    const errV = new Float64Array(N);
    const chunks = SHARED_CHUNKS;
    for (const dir of [1, -1] as const) {
      heldOut(chunks * S, dir, 37, [0.5, 0.2731], (t, p, v) => {
        eph.evaluate(t, pos, vel);
        for (let b = 0; b < N; b++) {
          errP[b] = Math.max(errP[b], dist3(pos, 3 * b, p, 3 * b));
          errV[b] = Math.max(errV[b], dist3(vel, 3 * b, v, 3 * b));
        }
      });
    }
    J2000_BODIES.forEach((b, i) => console.log(`  ${b.id.padEnd(8)} max position error ${(errP[i] * 1e3).toFixed(2)} mm, velocity ${errV[i].toExponential(2)} m/s`));
    for (let b = 0; b < N; b++) {
      expect(errP[b]).toBeLessThan(0.01);
      expect(errV[b]).toBeLessThan(1e-6);
    }
  }, 300_000);

  it('reproduces integrator grid states (positions and velocities) in both directions', () => {
    const eph = shared;
    const pos = new Float64Array(3 * N);
    const vel = new Float64Array(3 * N);
    for (const dir of [1, -1] as const) {
      const it = new NBodyIntegrator(GM, initialState(), 0, dir * H, KAHAN_LI_8, PHYSICS);
      for (let i = 0; i < 3000; i++) {
        if (i % 37 === 0) {
          eph.evaluate(it.t, pos, vel);
          for (let b = 0; b < N; b++) {
            expect(dist3(pos, 3 * b, it.q, 3 * b)).toBeLessThan(0.01);
            expect(dist3(vel, 3 * b, it.v, 3 * b)).toBeLessThan(3e-6); // inner moons (Io, Tethys): 1.4e-6 m/s observed at 4 h segments; planets < 1e-7
          }
        }
        it.step();
      }
    }
  });

  it('positions (inlined hot path) is bit-identical to evaluate', () => {
    const eph = shared;
    const a = new Float64Array(3 * N);
    const b = new Float64Array(3 * N);
    for (let i = -500; i < 500; i++) {
      const t = i * 123456.7891;
      eph.positions(t, a);
      eph.evaluate(t, b, null);
      for (let k = 0; k < 3 * N; k++) expect(a[k]).toBe(b[k]);
    }
  });

  it('bodyState, evaluateBodies and tryEvaluate agree with evaluate', () => {
    const eph = shared;
    const pos = new Float64Array(3 * N);
    const vel = new Float64Array(3 * N);
    const one = new Float64Array(6);
    const sub = [bodyIndex('io'), EARTH, bodyIndex('jupiter')];
    const sp = new Float64Array(9);
    const sv = new Float64Array(9);
    for (const t of [-8e7, -12345.678, 0, 7 * DAY + 0.1, 7e7]) {
      eph.evaluate(t, pos, vel);
      for (let b = 0; b < N; b++) {
        eph.bodyState(b, t, one);
        for (let k = 0; k < 3; k++) {
          expect(one[k]).toBe(pos[3 * b + k]);
          expect(one[3 + k]).toBe(vel[3 * b + k]);
        }
      }
      eph.evaluateBodies(t, sub, sp, sv);
      sub.forEach((b, j) => {
        for (let k = 0; k < 3; k++) {
          expect(sp[3 * j + k]).toBe(pos[3 * b + k]);
          expect(sv[3 * j + k]).toBe(vel[3 * b + k]);
        }
      });
    }
    expect(eph.tryEvaluate(20 * C, pos, null)).toBe(false);
    expect(eph.hasChunk(20)).toBe(false);
    expect(eph.tryEvaluate(0.5 * C, pos, null)).toBe(true);
    expect(eph.coveredRange()).toEqual({ tStart: -SHARED_CHUNKS * C, tEnd: SHARED_CHUNKS * C });
  });
});

describe('ChebyshevEphemeris continuity', () => {
  it('is continuous across segment and chunk boundaries', () => {
    const eph = shared;
    const L = eph.layout;
    const a = new Float64Array(3 * N);
    const b = new Float64Array(3 * N);
    const va = new Float64Array(3 * N);
    const vb = new Float64Array(3 * N);
    // s: small enough that a*eps is negligible (< 1e-7 m/s) yet well above the
    // time resolution (ulp of 2e8 s is 3e-8 s). The left position is carried to
    // the boundary with its velocity.
    const eps = 1e-6;
    const jumpP = new Float64Array(N);
    const jumpV = new Float64Array(N);
    let chunkJumpP = 0;
    for (let body = 0; body < N; body++) {
      const seg = L.segLen[body];
      for (let tb = -2 * C; tb < 2 * C; tb += Math.max(seg, C / 64)) {
        eph.evaluate(tb - eps, a, va);
        eph.evaluate(tb, b, vb);
        let dp = 0;
        let dv = 0;
        for (let k = 0; k < 3; k++) {
          const i = 3 * body + k;
          dp += (a[i] + va[i] * eps - b[i]) ** 2;
          dv += (va[i] - vb[i]) ** 2;
        }
        jumpP[body] = Math.max(jumpP[body], Math.sqrt(dp));
        jumpV[body] = Math.max(jumpV[body], Math.sqrt(dv));
        if (tb % C === 0) chunkJumpP = Math.max(chunkJumpP, Math.sqrt(dp));
      }
    }
    J2000_BODIES.forEach((bd, i) => console.log(`  ${bd.id.padEnd(8)} max jump at boundaries: ${(jumpP[i] * 1e3).toFixed(2)} mm, ${jumpV[i].toExponential(2)} m/s`));
    console.log(`  max position jump at chunk boundaries (incl. t=0, forward/backward seam): ${(chunkJumpP * 1e3).toFixed(2)} mm`);
    for (let i = 0; i < N; i++) {
      expect(jumpP[i]).toBeLessThan(0.01);
      expect(jumpV[i]).toBeLessThan(3e-6); // inner moons: 1.05e-6 m/s observed (mm-level fits on 4 h segments)
    }
  });

  it('assigns a time exactly on a boundary to the later segment, reproducibly', () => {
    const eph = new ChebyshevEphemeris(J2000_BODIES, { chunkSteps: SMALL });
    const p1 = new Float64Array(3 * N);
    const p2 = new Float64Array(3 * N);
    const Cs = eph.layout.chunkSpan;
    for (const t of [0, Cs, -Cs, 16 * H, -16 * H]) {
      eph.positions(t, p1);
      // Building more chunks, or evaluating elsewhere first, must not change the answer.
      eph.positions(t + 3 * Cs, p2);
      eph.positions(t - 3 * Cs, p2);
      eph.positions(t, p2);
      for (let i = 0; i < 3 * N; i++) expect(p2[i]).toBe(p1[i]);
    }
    expect(eph.chunkIndex(0)).toBe(0);
    expect(eph.chunkIndex(-1e-9)).toBe(-1);
    expect(eph.chunkIndex(Cs)).toBe(1);
  });
});

describe('ChebyshevEphemeris determinism', () => {
  const sameBits = (a: Float64Array, b: Float64Array): boolean => {
    const ua = new Uint32Array(a.buffer, a.byteOffset, 2 * a.length);
    const ub = new Uint32Array(b.buffer, b.byteOffset, 2 * b.length);
    if (ua.length !== ub.length) return false;
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  };

  it('builds bit-identical chunks regardless of request order or route (128 d chunks)', () => {
    const K = 3;
    const opts = { chunkSteps: SMALL };
    const C = SMALL * H;
    // Forward then backward, one request each.
    const a = new ChebyshevEphemeris(J2000_BODIES, opts);
    a.ensure(0, K * C - 1);
    a.ensure(-K * C, 0);
    // Backward then forward.
    const b = new ChebyshevEphemeris(J2000_BODIES, opts);
    b.ensure(-K * C, -1);
    b.ensure(0, K * C - 1);
    // Many small, interleaved requests via evaluation.
    const c = new ChebyshevEphemeris(J2000_BODIES, opts);
    const out = new Float64Array(3 * N);
    for (let k = 0; k < K; k++) {
      c.positions(-(k + 0.5) * C, out);
      c.positions((k + 0.5) * C, out);
    }
    // "Worker" route: chunks built from transferred checkpoints, then installed.
    const d = new ChebyshevEphemeris(J2000_BODIES, opts);
    for (const dir of [1, -1] as const) {
      let cp: Checkpoint = initialCheckpoint(J2000_BODIES);
      for (let j = 0; j < K; j++) {
        const k = dir > 0 ? j : -1 - j;
        // Round-trip through structured clone, as postMessage would.
        cp = structuredClone(cp);
        const r = buildChunk(d.layout, GM, PHYSICS, 0, k, cp);
        d.addChunk(k, structuredClone(r.coeffs), r.end);
        cp = r.end;
      }
    }
    // "Parallel" route: an ephemeris that only knows the checkpoints (as a
    // shipped asset would provide) builds the outermost chunks first, each
    // independently from its own checkpoint, out of order.
    const f = new ChebyshevEphemeris(J2000_BODIES, { ...opts, checkpoints: structuredClone(a.checkpoints()) });
    for (const k of [-K, K - 1, -1, 0, 1 - K, K - 2]) f.positions((k + 0.5) * C, out);
    for (let k = -K; k < K; k++) {
      const ref = a.getChunk(k)!;
      expect(ref).toBeDefined();
      for (const e of [b, c, d, f]) expect(sameBits(e.getChunk(k)!, ref)).toBe(true);
    }
    expect(f.builtChunks()).toEqual([-K, 1 - K, -1, 0, K - 2, K - 1].sort((x, y) => x - y));
    // Resuming from a checkpoint reproduces the next chunk exactly.
    const e = new ChebyshevEphemeris(J2000_BODIES, opts);
    e.ensure(0, 0);
    const r1 = buildChunk(e.layout, GM, PHYSICS, 0, 1, e.frontier(1));
    expect(sameBits(r1.coeffs, a.getChunk(1)!)).toBe(true);
  }, 120_000);

  it('resumes a full-size chunk from a checkpoint bit for bit, in both directions', () => {
    for (const k of [1, -2]) {
      const start = shared.checkpoint(k > 0 ? k : k + 1)!;
      const r = buildChunk(shared.layout, GM, PHYSICS, 0, k, structuredClone(start));
      expect(sameBits(r.coeffs, shared.getChunk(k)!)).toBe(true);
    }
  }, 60_000);
});

describe('ChebyshevEphemeris cost', () => {
  it('measures evaluation speed and storage against IntegratedEphemeris', () => {
    const cheb = shared;
    const integ = new IntegratedEphemeris();
    const span = 0.25 * C;
    const pos = new Float64Array(3 * N);
    const vel = new Float64Array(3 * N);
    integ.positions(span, pos); // pre-build
    const M = 200_000;
    const times = new Float64Array(M);
    let s = 12345;
    for (let i = 0; i < M; i++) {
      s = (s * 1103515245 + 12345) % 2147483648;
      times[i] = (s / 2147483648) * span;
    }
    const bench = (f: (t: number) => void): number => {
      for (let i = 0; i < 50_000; i++) f(times[i]); // warm up
      let best = Infinity;
      for (let rep = 0; rep < 3; rep++) {
        const t0 = performance.now();
        for (let i = 0; i < M; i++) f(times[i]);
        best = Math.min(best, ((performance.now() - t0) * 1e6) / M);
      }
      return best;
    };
    const cPos = bench((t) => cheb.positions(t, pos));
    const iPos = bench((t) => integ.positions(t, pos));
    const cPV = bench((t) => cheb.evaluate(t, pos, vel));
    const iPV = bench((t) => integ.evaluate(t, pos, vel));
    // Sequential times (as a propagator sees them) for cache behaviour.
    const seq = new Float64Array(M);
    for (let i = 0; i < M; i++) seq[i] = (i / M) * span;
    const cSeq = (() => {
      const t0 = performance.now();
      for (let i = 0; i < M; i++) cheb.positions(seq[i], pos);
      return ((performance.now() - t0) * 1e6) / M;
    })();
    console.log(
      `all-body evaluation (${N} bodies), ns: Chebyshev positions ${cPos.toFixed(0)} (sequential ${cSeq.toFixed(0)}), pos+vel ${cPV.toFixed(0)}; ` +
        `IntegratedEphemeris positions ${iPos.toFixed(0)}, pos+vel ${iPV.toFixed(0)}`,
    );
    const st = cheb.layout.bytesPerCentury();
    J2000_BODIES.forEach((b, i) => console.log(`  storage per century ${b.id.padEnd(8)} ${(st.perBody[i] / 1024).toFixed(0)} KiB`));
    const integBytes = ((36525 * DAY) / H) * 9 * N * 8;
    const sub = [bodyIndex('io'), EARTH, bodyIndex('jupiter')];
    const sp = new Float64Array(9);
    const cSub = bench((t) => cheb.evaluateBodies(t, sub, sp, null));
    console.log(`  evaluateBodies(Io, Earth, Jupiter): ${cSub.toFixed(0)} ns`);
    console.log(
      `  total ${(st.total / 1e6).toFixed(2)} MB per century (chunk = ${(cheb.layout.chunkLength * 8) / 1024} KiB per ${S * H / DAY} d) ` +
        `vs IntegratedEphemeris ${(integBytes / 1e6).toFixed(1)} MB`,
    );
    expect(st.total).toBeLessThan(integBytes / 5);
  }, 120_000);
});

describe('ChebyshevEphemeris end to end', () => {
  const run = (eph: Ephemeris, y0: number[], t1: number) => {
    const t0 = performance.now();
    const r = propagate(eph, y0, 0, t1);
    return { r, ms: performance.now() - t0 };
  };
  const report = (label: string, a: ReturnType<typeof run>, b: ReturnType<typeof run>) => {
    const dp = dist3(a.r.y, 0, b.r.y, 0);
    const dv = dist3(a.r.y, 3, b.r.y, 3);
    console.log(
      `${label}: Chebyshev ${a.ms.toFixed(0)} ms (${a.r.accepted} steps), Integrated ${b.ms.toFixed(0)} ms (${b.r.accepted} steps); ` +
        `final state differs by ${dp.toExponential(2)} m, ${dv.toExponential(2)} m/s`,
    );
    return { dp, dv };
  };

  it('heliocentric cruise, 1 year', () => {
    const cheb = shared;
    const integ = new IntegratedEphemeris();
    const e = new Float64Array(6);
    cheb.bodyState(EARTH, 0, e);
    // Leave Earth's vicinity: 1.0e9 m ahead in Earth's orbit, with 3 km/s extra prograde.
    const vn = Math.hypot(e[3], e[4], e[5]);
    const y0 = [e[0] + (1e9 * e[3]) / vn, e[1] + (1e9 * e[4]) / vn, e[2] + (1e9 * e[5]) / vn, e[3] * (1 + 3000 / vn), e[4] * (1 + 3000 / vn), e[5] * (1 + 3000 / vn), 1000];
    // Pre-build both so timing measures propagation, not ephemeris construction.
    cheb.ensure(0, JULIAN_YEAR);
    integ.positions(JULIAN_YEAR + DAY, new Float64Array(3 * N));
    const a = run(cheb, y0, JULIAN_YEAR);
    const b = run(integ, y0, JULIAN_YEAR);
    const { dp } = report('heliocentric 1 yr', a, b);
    expect(dp).toBeLessThan(100);
  }, 120_000);

  it('low Earth orbit, 30 days', () => {
    const cheb = shared;
    const integ = new IntegratedEphemeris();
    const e = new Float64Array(6);
    cheb.bodyState(EARTH, 0, e);
    const R = 6_778_000;
    const v = Math.sqrt(J2000_BODIES[EARTH].gm / R);
    const y0 = [e[0] + R, e[1], e[2], e[3], e[4] + v, e[5], 1000];
    cheb.ensure(0, 31 * DAY);
    integ.positions(31 * DAY, new Float64Array(3 * N));
    const a = run(cheb, y0, 30 * DAY);
    const b = run(integ, y0, 30 * DAY);
    // Geocentric difference.
    const ea = new Float64Array(6);
    cheb.bodyState(EARTH, 30 * DAY, ea);
    const ra = Math.hypot(a.r.y[0] - ea[0], a.r.y[1] - ea[1], a.r.y[2] - ea[2]);
    console.log(`  LEO radius at end: ${(ra / 1e3).toFixed(3)} km`);
    const { dp } = report('LEO 30 d', a, b);
    // Context: the propagator's own sensitivity. Same ephemeris, tighter tolerance.
    const c = propagate(cheb, y0, 0, 30 * DAY, [], { rtol: 1e-13 });
    console.log(`  same Chebyshev ephemeris, rtol 1e-12 vs 1e-13: final state differs by ${dist3(a.r.y, 0, c.y, 0).toExponential(2)} m`);
    expect(dp).toBeLessThan(100);
  }, 300_000);
});
