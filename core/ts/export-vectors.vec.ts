/**
 * Parity-vector exporter for the Rust core (core/). Runs the project's own
 * TypeScript physics and writes inputs and expected outputs, as raw IEEE-754
 * bit patterns, to core/fixtures/generated/. The Rust harness
 * (core/src/parity.rs, run natively by `cargo test` and as WebAssembly by
 * core/scripts/run-wasm.mjs) reads them back and compares bit for bit.
 *
 * Run: `pnpm core:vectors` (vitest with core/ts/vitest.config.ts; not part of
 * `pnpm test`). Output is a few tens of MB and gitignored; it is a pure
 * function of the TypeScript sources, so regenerate rather than check in.
 *
 * FORMAT (see core/README.md, "Fixtures"): text, one record per line,
 * whitespace-separated tokens; every number (integers too) is 16 lowercase hex
 * digits, the big-endian bytes of its float64; other tokens are words. Chunk
 * coefficients are raw little-endian float64 files chunk_<k>.bin.
 *
 * vi.mock wraps two modules without changing their arithmetic: Dop853, to
 * record right-hand-side evaluations (inputs and outputs) of the spacecraft
 * derivative, and propagate, to capture the propagations the corrector runs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Instrumentation (hoisted by vitest above the imports below).

const rec = vi.hoisted(() => ({
  /** When set, every derivative call of a Dop853 is passed here until refresh() is called. */
  derivSink: null as null | ((t: number, y: Float64Array, out: Float64Array) => void),
  stopOnRefresh: true,
  /** When set, every propagate() call (inputs and result) is passed here. */
  propSink: null as null | ((args: unknown[], result: { t: number; y: Float64Array; accepted: number; rejected: number }) => void),
}));

vi.mock('../../src/physics/dop853', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/physics/dop853')>();
  class RecordingDop853 extends m.Dop853 {
    constructor(n: number, f: import('../../src/physics/dop853').Derivative, s: import('../../src/physics/dop853').ScaleFn) {
      super(n, (t, y, out) => {
        f(t, y, out);
        if (rec.derivSink !== null) rec.derivSink(t, y, out);
      }, s);
    }
    override refresh(): void {
      if (rec.stopOnRefresh) rec.derivSink = null;
      super.refresh();
    }
  }
  return { ...m, Dop853: RecordingDop853 };
});

vi.mock('../../src/physics/spacecraft', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/physics/spacecraft')>();
  const propagate: typeof m.propagate = (...args) => {
    const r = m.propagate(...args);
    if (rec.propSink !== null) rec.propSink(args, r);
    return r;
  };
  return { ...m, propagate };
});

import { atan, atan2, cos, rad, sin, sincos, sincosInto } from '../../src/physics/dmath';
import { exactExp, exactLn, Hasher } from '../../src/mission/exact-math';
import { componentwiseScale, Dop853 } from '../../src/physics/dop853';
import { HarmonicField, ZonalSeries, type TesseralTerm } from '../../src/physics/gravity-field';
import { BodyFrame, bodyToIcrf, IAU_ROTATION, PoleTable, poleAngles, poleAt, polesAt, primeMeridian } from '../../src/physics/orientation';
import { deltaT, EARTH_ROTATION, EARTH_ROTATION_IAU, earthPrimeMeridianDeg, primeMeridianDeg } from '../../src/physics/earth-rotation';
import { ChebyshevEphemeris } from '../../src/physics/chebyshev-ephemeris';
import { DAY, J2000_BODIES, JULIAN_YEAR, bodyIndex } from '../../src/physics/solar-system';
import { FixedBodies, propagate, sharedBodyFrame, type Burn, type Ephemeris } from '../../src/physics/spacecraft';
import { EXPECTED_HEX, burns as detBurns, ephemeris as detEphem, options as detOptions, t0 as detT0, t1 as detT1, y0 as detY0, GM_EARTH } from '../../src/fixtures/determinism';
import { correctBurn } from '../../src/planning/corrector';
import { planDeparture } from '../../src/planning/departure';
import { CASES, ENGINE, setupCase } from '../../test/helpers/planning-cases';

const OUT = new URL('../fixtures/generated/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Encoding

const dv = new DataView(new ArrayBuffer(8));
function hx(x: number): string {
  dv.setFloat64(0, x);
  return dv.getUint32(0).toString(16).padStart(8, '0') + dv.getUint32(4).toString(16).padStart(8, '0');
}
function hxs(a: ArrayLike<number>, n = a.length): string {
  const s: string[] = [];
  for (let i = 0; i < n; i++) s.push(hx(a[i]));
  return s.join(' ');
}
function fromBits(hi: number, lo: number): number {
  dv.setUint32(0, hi >>> 0);
  dv.setUint32(4, lo >>> 0);
  return dv.getFloat64(0);
}
class Lines {
  private readonly l: string[] = [];
  add(...parts: (string | number | ArrayLike<number>)[]): void {
    this.l.push(parts.map((p) => (typeof p === 'string' ? p : typeof p === 'number' ? hx(p) : hxs(p))).join(' '));
  }
  get length(): number {
    return this.l.length;
  }
  write(name: string): void {
    writeFileSync(OUT + name, this.l.join('\n') + '\n');
  }
}
/** Same LCG the golden tests use. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}
function attempt(f: () => number[]): number[] | 'ERR' {
  try {
    return f();
  } catch {
    return 'ERR';
  }
}
function addResult(L: Lines, op: string, args: number[], f: () => number[]): void {
  const r = attempt(f);
  L.add(op, args, r === 'ERR' ? 'ERR' : r);
}

// ---------------------------------------------------------------------------
// 1. Elementary functions

describe('vectors', () => {
  it('dmath and exact-math', () => {
    const L = new Lines();
    const rnd = lcg(1);
    const xs: number[] = [0, -0, 1, -1, Infinity, -Infinity, NaN, 5e-324, -5e-324, 2.2250738585072014e-308, 2.225073858507201e-308, -1e-310, 1e-300, 7.450580596923828e-9, 7.45e-9, 1e-8];
    // Multiples of pi/2 (the zeros of sin and cos and the reduction's octant edges), +- a few ulps.
    for (let k = -2100; k <= 2100; k++) {
      const c = k * 1.5707963267948966;
      xs.push(c);
      dv.setFloat64(0, c);
      const hi = dv.getUint32(0), lo = dv.getUint32(4);
      for (const d of [-3, -2, -1, 1, 2, 3]) xs.push(fromBits(hi, lo + d));
      xs.push(k * 0.7853981633974483);
    }
    // Pi/4 edge of the reduction, and the range limit.
    for (const c of [0.7853981633974483, 823549.6654067, 823549.6654068, 823549.6654066, 524288 * 1.5707963267948966]) {
      xs.push(c, -c, c * (1 + 2.2e-16), c * (1 - 1.1e-16));
    }
    // Dense small and moderate, random large.
    for (let i = 0; i < 4000; i++) xs.push((rnd() - 0.5) * 10);
    for (let i = 0; i < 3000; i++) xs.push((rnd() - 0.5) * 2 * 8.2e5);
    for (let i = 0; i < 1000; i++) xs.push((rnd() - 0.5) * 2 ** (-40 * rnd()));
    for (let i = 0; i < 300; i++) xs.push((rnd() - 0.5) * 2e6);
    for (const x of xs) {
      addResult(L, 'sin', [x], () => [sin(x)]);
      addResult(L, 'cos', [x], () => [cos(x)]);
      addResult(L, 'sincos', [x], () => sincos(x));
      addResult(L, 'sincosinto', [x], () => {
        const o = new Float64Array(3);
        sincosInto(x, o, 1);
        return [o[1], o[2]];
      });
      addResult(L, 'rad', [x], () => [rad(x)]);
    }
    const as: number[] = [0, -0, Infinity, -Infinity, NaN, 5e-324, -5e-324, 1.8014398509481984e16, 1.8014398509481982e16, 0.4375, 0.4374999999999999, 0.6875, 1.1875, 2.4375, 7.450580596923828e-9, 7.450580596923827e-9];
    for (let i = 0; i < 4000; i++) as.push((rnd() - 0.5) * 2 ** (60 * rnd() - 30));
    for (let i = 0; i < 2000; i++) as.push((rnd() - 0.5) * 6);
    for (const x of as) addResult(L, 'atan', [x], () => [atan(x)]);
    const specials = [0, -0, 1, -1, Infinity, -Infinity, NaN, 5e-324, -5e-324, 1e300, -1e300];
    for (const y of specials) for (const x of specials) addResult(L, 'atan2', [y, x], () => [atan2(y, x)]);
    for (let i = 0; i < 6000; i++) {
      const y = (rnd() - 0.5) * 2 ** (40 * rnd() - 20);
      const x = (rnd() - 0.5) * 2 ** (40 * rnd() - 20);
      addResult(L, 'atan2', [y, x], () => [atan2(y, x)]);
    }
    // |y/x| at 2^+-54 thresholds.
    for (const s of [1.8014398509481984e16, 5.551115123125783e-17]) for (const f of [0.999999, 1, 1.000001]) for (const x of [1, -1, 3.7, -3.7]) addResult(L, 'atan2', [s * f * Math.abs(x), x], () => [atan2(s * f * Math.abs(x), x)]);
    const ls: number[] = [5e-324, 1e-310, 2.2250738585072014e-308, 1, 2, 0.5, 1.4142135623730951, 0.7071067811865476, 0.7071067811865475, 4294967296, 2.3283064365386963e-10, 1.7976931348623157e308, 0, -0, -1, Infinity, NaN];
    for (let i = 0; i < 4000; i++) ls.push(2 ** (2000 * rnd() - 1000) * (1 + rnd()));
    for (let i = 0; i < 2000; i++) ls.push(0.5 + 1.5 * rnd());
    for (const x of ls) addResult(L, 'ln', [x], () => [exactLn(x)]);
    const es: number[] = [0, -0, 700, -700, 700.0000000000001, -700.0000000000001, 0.34657359027997264, 0.34657359027997264 * 3, -0.34657359027997264, 1, -1, NaN, Infinity, 709, 1e-300];
    for (let i = 0; i < 4000; i++) es.push((rnd() - 0.5) * 1400);
    for (let i = 0; i < 2000; i++) es.push((rnd() - 0.5) * 2);
    for (const x of es) addResult(L, 'exp', [x], () => [exactExp(x)]);
    // Hasher: a sequence of f64, u32 and string records (strings as UTF-16 code units).
    for (let c = 0; c < 50; c++) {
      const h = new Hasher();
      const toks: string[] = [];
      const n = 1 + Math.floor(rnd() * 20);
      for (let i = 0; i < n; i++) {
        const kind = Math.floor(rnd() * 3);
        if (kind === 0) {
          const v = c === 0 && i === 0 ? -0 : (rnd() - 0.5) * 2 ** (100 * rnd() - 50);
          h.f64(v);
          toks.push('f', hx(v));
        } else if (kind === 1) {
          const v = Math.floor(rnd() * 4294967296);
          h.u32(v);
          toks.push('u', hx(v));
        } else {
          const len = Math.floor(rnd() * 6);
          let s = '';
          for (let k = 0; k < len; k++) s += String.fromCharCode(rnd() < 0.7 ? 32 + Math.floor(rnd() * 90) : Math.floor(rnd() * 65536));
          h.str(s);
          const codes: number[] = [];
          for (let k = 0; k < s.length; k++) codes.push(s.charCodeAt(k));
          toks.push('s', hx(codes.length), ...codes.map(hx));
        }
      }
      L.add('hash', hx(n), toks.join(' '), 'hex', h.hex(), hx(h.u32Value()));
    }
    L.write('dmath.txt');
    console.log(`dmath.txt: ${L.length} vectors`);
  });

  // -------------------------------------------------------------------------
  // 2. DOP853 on simple right-hand sides (the same definitions are in core/src/parity.rs).

  it('dop853', () => {
    const L = new Lines();
    type Rhs = { n: number; f: (t: number, y: Float64Array, o: Float64Array) => void };
    const RHS: Record<string, Rhs> = {
      osc: { n: 2, f: (_t, y, o) => { o[0] = y[1]; o[1] = -y[0]; } },
      kepler: { n: 4, f: (_t, y, o) => { const r2 = y[0] * y[0] + y[1] * y[1]; const r3 = r2 * Math.sqrt(r2); o[0] = y[2]; o[1] = y[3]; o[2] = -y[0] / r3; o[3] = -y[1] / r3; } },
      tdep: { n: 3, f: (t, y, o) => { o[0] = y[1]; o[1] = (-y[0] * (1 + 0.1 * t)) / (1 + y[2] * y[2]); o[2] = 0.01 * y[0] * y[1] - t * 1e-3; } },
      blowup: { n: 1, f: (_t, y, o) => { o[0] = y[0] * y[0]; } },
    };
    const cases: { rhs: string; y0: number[]; t0: number; tEnd: number; rtol: number; atol: number; h?: number; maxSteps: number; mode: 'step' | 'fixed' | 'refresh' }[] = [
      { rhs: 'osc', y0: [1, 0], t0: 0, tEnd: 50, rtol: 1e-10, atol: 1e-12, maxSteps: 1000, mode: 'step' },
      { rhs: 'osc', y0: [0, 1], t0: -3, tEnd: 7, rtol: 1e-6, atol: 1e-9, h: 0.5, maxSteps: 1000, mode: 'step' },
      { rhs: 'kepler', y0: [1, 0, 0, 1.2], t0: 0, tEnd: 40, rtol: 1e-12, atol: 1e-14, maxSteps: 5000, mode: 'step' },
      { rhs: 'kepler', y0: [0.3, 0, 0, 2.4], t0: 0, tEnd: 30, rtol: 1e-9, atol: 1e-12, maxSteps: 5000, mode: 'step' },
      { rhs: 'tdep', y0: [1, 0.5, -0.2], t0: 0, tEnd: 20, rtol: 1e-11, atol: 1e-13, maxSteps: 5000, mode: 'step' },
      { rhs: 'tdep', y0: [1, 0.5, -0.2], t0: 0, tEnd: 20, rtol: 1e-11, atol: 1e-13, maxSteps: 400, mode: 'refresh' },
      { rhs: 'kepler', y0: [1, 0, 0, 1], t0: 0, tEnd: 0, rtol: 1e-10, atol: 1e-12, h: 0.01, maxSteps: 300, mode: 'fixed' },
      { rhs: 'blowup', y0: [1], t0: 0, tEnd: 2, rtol: 1e-10, atol: 1e-12, maxSteps: 100000, mode: 'step' },
      { rhs: 'osc', y0: [0, 0], t0: 0, tEnd: 1, rtol: 1e-10, atol: 1e-12, maxSteps: 100, mode: 'step' },
    ];
    const FR = [0, 0.13, 0.5, 0.77, 1];
    let nv = 0;
    for (const c of cases) {
      const R = RHS[c.rhs];
      const d = new Dop853(R.n, R.f, componentwiseScale(c.rtol, c.atol));
      L.add('case', c.rhs, c.mode, R.n, c.y0, c.t0, c.tEnd, c.rtol, c.atol, c.h ?? -1, c.maxSteps);
      d.reset(c.t0, c.y0, c.h);
      L.add('init', d.h);
      const tmp = new Float64Array(R.n);
      for (let s = 0; s < c.maxSteps; s++) {
        let err = false;
        try {
          if (c.mode === 'fixed') d.stepFixed(c.h!);
          else {
            if (!(d.t < c.tEnd)) break;
            d.step(c.tEnd);
          }
        } catch {
          err = true;
        }
        if (err) {
          L.add('error');
          break;
        }
        const ints: number[] = [];
        for (const f of FR) {
          d.interpolate(d.tPrevious + (d.t - d.tPrevious) * f, tmp);
          ints.push(...tmp);
        }
        L.add('step', d.t, d.y, d.h, d.accepted, d.rejected, ints);
        nv++;
        if (c.mode === 'refresh' && s % 7 === 3) {
          d.refresh();
          L.add('refresh');
        }
      }
      L.add('end');
    }
    L.write('dop853.txt');
    console.log(`dop853.txt: ${cases.length} cases, ${nv} steps`);
  });

  // -------------------------------------------------------------------------
  // 3. Gravity fields

  it('gravity fields', () => {
    const L = new Lines();
    const rnd = lcg(7);
    const B = (id: string) => J2000_BODIES[bodyIndex(id)];
    const zonalCfgs: { jn: number[]; radius: number }[] = [
      { jn: [0, ...B('jupiter').jn!.slice(1)], radius: B('jupiter').j2Radius! },
      { jn: [0, ...B('saturn').jn!.slice(1)], radius: B('saturn').j2Radius! },
      { jn: [1e-3, -2e-6, 3e-5, 0, 1e-7], radius: 6e6 },
      { jn: [1.0826e-3], radius: 6378137 },
    ];
    const fieldCfgs: { jn: number[]; tess: TesseralTerm[]; radius: number }[] = [
      { jn: [0, ...B('earth').jn!.slice(1)], tess: B('earth').tesseral!.map((r) => [r[0], r[1], r[2], r[3]] as const), radius: B('earth').j2Radius! },
      { jn: [0, ...B('moon').jn!.slice(1)], tess: B('moon').tesseral!.map((r) => [r[0], r[1], r[2], r[3]] as const), radius: B('moon').j2Radius! },
      { jn: [1e-3, 2e-6, -1e-6, 5e-7, -2e-7], tess: [[2, 2, 1.5e-6, -9e-7], [3, 1, 2e-6, 2.5e-7], [5, 3, 1e-8, -3e-8], [6, 6, 2e-10, 1e-10], [4, 4, 0, 0]], radius: 3e6 },
      { jn: [2e-3, 1e-5], tess: [[3, 3, 1e-7, 2e-7]], radius: 1e6 },
      // Degree 4, zonal only (the unrolled path with every tesseral coefficient 0):
      // on the plane x = -0 an all-zero component keeps the sign the arithmetic gives it.
      { jn: [1e-3, 2e-6, -1.5e-6], tess: [], radius: 2e6 },
    ];
    for (let ci = 0; ci < zonalCfgs.length; ci++) {
      const c = zonalCfgs[ci];
      L.add('zonalcfg', c.radius, c.jn.length, c.jn);
      const z = new ZonalSeries(c.jn, c.radius);
      for (let i = 0; i < 1500; i++) {
        const r = c.radius * (1.001 + 60 * rnd() * rnd());
        const th = Math.acos(2 * rnd() - 1);
        const ph = 2 * Math.PI * rnd();
        const x = [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)];
        if (i % 50 === 0) { x[0] = 0; x[1] = 0; x[2] = r * (i % 100 === 0 ? 1 : -1); }
        let p = [2 * rnd() - 1, 2 * rnd() - 1, 2 * rnd() - 1];
        const pn = Math.hypot(p[0], p[1], p[2]);
        p = p.map((v) => v / pn);
        const gm = 1e13 * (1 + 1e4 * rnd());
        const scale = i % 3 === 0 ? 1 : rnd();
        const out = new Float64Array([rnd() - 0.5, 0, -0]);
        const o0 = Array.from(out);
        z.add(gm, x[0], x[1], x[2], p[0], p[1], p[2], out, 0, scale);
        L.add('zonal', ci, gm, x, p, scale, o0, out);
      }
    }
    for (let ci = 0; ci < fieldCfgs.length; ci++) {
      const c = fieldCfgs[ci];
      L.add('fieldcfg', c.radius, c.jn.length, c.jn, c.tess.length, c.tess.flat());
      const f = new HarmonicField(c.jn, c.tess, c.radius);
      for (let i = 0; i < 1500; i++) {
        const r = c.radius * (1.001 + 60 * rnd() * rnd());
        const th = Math.acos(2 * rnd() - 1);
        const ph = 2 * Math.PI * rnd();
        const x = [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)];
        if (i % 50 === 0) { x[0] = i % 100 === 0 ? 0 : -0; x[1] = 0; x[2] = -r; }
        const gm = 4e14 * (1 + rnd());
        const scale = i % 3 === 0 ? 1 : rnd();
        const out = new Float64Array([rnd() - 0.5, 0, -0]);
        const o0 = Array.from(out);
        f.add(gm, x[0], x[1], x[2], out, 0, scale);
        L.add('field', ci, gm, x, scale, o0, out);
        const M = new Float64Array(9).map(() => 2 * rnd() - 1);
        const out2 = new Float64Array([0, rnd(), 0]);
        const o2 = Array.from(out2);
        f.addIcrf(gm, x[0], x[1], x[2], M, 0, out2, 0, scale);
        L.add('fieldicrf', ci, gm, x, M, scale, o2, out2);
      }
      // Signed zeros: points on the axes and coordinate planes, accumulators
      // starting at +-0, so the sign of an all-zero component reaches the output.
      const zs = [0, -0];
      for (const sx of [0, -0, 1, -1]) for (const sy of [0, -0, 1, -1]) for (const sz of [0, -0, 1, -1]) {
        if (sx * sx + sy * sy + sz * sz === 0) continue;
        const r = c.radius * 1.7;
        const x = [sx === 0 ? sx : sx * r * 0.6, sy === 0 ? sy : sy * r * 0.48, sz === 0 ? sz : sz * r * 0.64];
        for (const o0 of [[zs[0], zs[1], zs[0]], [zs[1], zs[0], zs[1]]]) {
          const out = new Float64Array(o0);
          f.add(4e14, x[0], x[1], x[2], out, 0, 1);
          L.add('field', ci, 4e14, x, 1, o0, out);
        }
      }
    }
    L.write('gravity.txt');
    console.log(`gravity.txt: ${L.length} lines`);
  });

  // -------------------------------------------------------------------------
  // 4. Orientation and Earth rotation (models are written to world.txt).

  it('orientation', () => {
    const L = new Lines();
    const rnd = lcg(11);
    const times: number[] = [0, -0, 86400, -86400, 43200, 1, -1, 3.15576e9, -3.15576e9, 4.7e9, -4.7e9];
    for (let i = 0; i < 250; i++) times.push((rnd() - 0.5) * 2 * 4.7e9);
    for (let i = 0; i < 40; i++) { const k = Math.floor((rnd() - 0.5) * 60000); times.push(k * 86400, k * 86400 - 1e-6, k * 86400 + 1e-3, k * 86400 + 86399.999); }
    for (let i = 0; i < 100; i++) times.push(1e8 + i * 3000.7);
    const ids = Object.keys(IAU_ROTATION);
    const tables = ids.map((id) => new PoleTable(IAU_ROTATION[id]));
    const tables0 = ids.map((id) => new PoleTable(IAU_ROTATION[id], 0));
    const frames = ids.map((id) => new BodyFrame(IAU_ROTATION[id]));
    const frames0 = ids.map((id) => new BodyFrame(IAU_ROTATION[id], { spacing: 0 }));
    const sframes = ids.map((id) => sharedBodyFrame(IAU_ROTATION[id]));
    const eraFrame = sharedBodyFrame(IAU_ROTATION.earth, 'earth-rotation-angle');
    const offs = Int32Array.from(ids.map((_, i) => 3 * i));
    const all = new Float64Array(3 * ids.length);
    const p = new Float64Array(3);
    const r = new Float64Array(3);
    const m9 = new Float64Array(9);
    let nv = 0;
    for (const t of times) {
      L.add('earth', t, [deltaT(t), earthPrimeMeridianDeg(t), primeMeridianDeg(EARTH_ROTATION, t), primeMeridianDeg(EARTH_ROTATION_IAU, t)]);
      L.add('era', t, eraFrame.theta(t), eraFrame.at(t));
      for (let i = 0; i < ids.length; i++) {
        const m = IAU_ROTATION[ids[i]];
        const a = poleAngles(m, t);
        poleAt(m, t, p, 0, r, 0);
        tables[i].at(t, all, 0);
        const tab = [all[0], all[1], all[2]];
        tables0[i].at(t, all, 0);
        const tab0 = [all[0], all[1], all[2]];
        const thp = tables[i].thetaPeriodic ? tables[i].thetaPeriodicAt(t) : 0;
        L.add('body', ids[i], t, [a.ra, a.dec, a.raRate, a.decRate], p, r, primeMeridian(m, t), bodyToIcrf(m, t, m9), tab, tab0, thp, frames[i].theta(t), frames[i].at(t), frames0[i].theta(t), frames0[i].at(t), sframes[i].at(t));
        nv++;
      }
      polesAt(tables, t, all, offs);
      L.add('polesat', t, all);
    }
    L.write('orientation.txt');
    console.log(`orientation.txt: ${times.length} times x ${ids.length} bodies (${nv} body records)`);
  });
});

// ---------------------------------------------------------------------------
// 5-7. Ephemeris, spacecraft derivative and propagation (real 29-body ephemeris).

/** The golden-test digest (test/ephemeris-golden.test.ts), reproduced to cross-check. */
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

describe('world', () => {
  const N = J2000_BODIES.length;
  let eph: ChebyshevEphemeris;
  let C: number;
  const chunksWritten = new Set<number>();
  const world = new Lines();

  function writeChunk(k: number): void {
    if (chunksWritten.has(k)) return;
    eph.ensure(k * C, k * C);
    const c = eph.getChunk(k)!;
    writeFileSync(`${OUT}chunk_${k}.bin`, new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
    chunksWritten.add(k);
  }

  beforeAll(() => {
    eph = new ChebyshevEphemeris();
    C = eph.layout.chunkSpan;
    eph.ensure(-2 * C, 3 * C - 1);
  });

  it('world description (models, layout, force model)', () => {
    for (const id of Object.keys(IAU_ROTATION)) {
      const m = IAU_ROTATION[id];
      const nut = m.nut ?? [];
      const pad = (a: readonly number[]) => [a[0], a[1] ?? 0, a[2] ?? 0];
      world.add('model', id, m.naifId, pad(m.ra), pad(m.dec), pad(m.pm), nut.length, nut.flatMap((n) => [...pad(n.angle), n.ra, n.dec, n.pm]));
    }
    const Ly = eph.layout;
    world.add('layout', Ly.count, Ly.h, Ly.chunkSteps, Ly.chunkSpan, eph.t0, Ly.chunkLength);
    const arr = (name: string, a: ArrayLike<number>) => world.add('array', name, a.length, a);
    arr('segLen', Ly.segLen);
    arr('twoOverLen', Ly.twoOverLen);
    arr('segCount', Ly.segCount);
    arr('offset', Ly.offset);
    arr('stride3', Ly.stride3);
    arr('degree', Ly.degree);
    arr('center', Ly.center);
    arr('weight', Ly.weight);
    arr('sysPlanet', Ly.sysPlanet);
    arr('sysStart', Ly.sysStart);
    arr('sysMoons', Ly.sysMoons);
    arr('systemOf', Ly.systemOf);
    arr('samples', Ly.samples);
    arr('sampleStride', Ly.sampleStride);
    arr('gm', eph.gm);
    for (let i = 0; i < N; i++) {
      const ob = eph.oblateness[i];
      if (ob === null) {
        world.add('body', J2000_BODIES[i].id, i, 'none');
        continue;
      }
      const rotId = ob.rotation ? Object.keys(IAU_ROTATION).find((k) => IAU_ROTATION[k] === ob.rotation)! : 'none';
      const jn = ob.jn ?? [];
      const tess = ob.tesseral ?? [];
      world.add('body', J2000_BODIES[i].id, i, 'field', ob.j2, ob.j4 ?? 0, ob.j4 !== undefined ? 'j4' : 'noj4', ob.radius, ob.pole, rotId, ob.primeMeridian ?? 'iau',
        ob.taper ? 'taper' : 'notaper', ob.taper ? [ob.taper[0], ob.taper[1]] : [0, 0], jn.length, jn, tess.length, tess.flat());
    }
    world.add('relativity', eph.relativity ? eph.relativity.body : -1);
    // Chunk -3 too: the golden boundary times include -2C - h/7.
    for (let k = -3; k <= 2; k++) writeChunk(k);
    world.write('world.txt');
  });

  it('ephemeris evaluation vectors and digests', () => {
    const L = new Lines();
    const rnd = lcg(0x2545f491);
    const times: number[] = [];
    for (let i = 0; i < 3000; i++) times.push((-2 + 5 * rnd()) * C);
    const h = eph.layout.h;
    for (let k = -2; k <= 2; k++) for (const steps of [0, 8, 16, 32, 64, 128, 512, 1024, 2048, 4095]) times.push(k * C + steps * h, k * C + steps * h - h / 7, k * C + steps * h + h / 3);
    const pos = new Float64Array(3 * N);
    const vel = new Float64Array(3 * N);
    const one = new Float64Array(6);
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      eph.positions(t, pos);
      L.add('positions', t, pos);
      eph.evaluate(t, pos, vel);
      L.add('evaluate', t, pos, vel);
      if (i % 10 === 0) for (let b = 0; b < N; b++) {
        eph.bodyState(b, t, one);
        L.add('bodystate', b, t, one);
      }
      if (i % 10 === 0) {
        const sub = [bodyIndex('saturn'), bodyIndex('titan'), bodyIndex('rhea'), bodyIndex('saturn')];
        const sp = new Float64Array(12), sv = new Float64Array(12);
        eph.evaluateBodies(t, sub, sp, sv);
        L.add('evaluatebodies', t, sub.length, sub, sp, sv);
      }
    }
    L.write('ephem.txt');
    console.log(`ephem.txt: ${L.length} lines`);
  });

  /** Propagation cases: the four golden ones, the determinism scenario, and the bench's LEO / heliocentric runs. */
  it('propagations and derivative vectors', () => {
    const P = new Lines();
    const D = new Lines();
    const EARTH = bodyIndex('earth');
    const JUPITER = bodyIndex('jupiter');
    const state = (b: number, t: number) => {
      const s = new Float64Array(6);
      eph.bodyState(b, t, s);
      return s;
    };
    const writeBurns = (burns: readonly Burn[]) => [hx(burns.length), ...burns.map((b) => [b.tStart, b.duration, b.thrust, b.isp, ...b.direction, b.frame.kind === 'orbital' ? 1 : 0, b.frame.kind === 'orbital' ? b.frame.body : -1].map(hx).join(' '))].join(' ');
    const run = (name: string, ep: Ephemeris, y0: number[], t0: number, t1: number, burns: Burn[], rtol: number | undefined, dryMass: number, steps: boolean, derivCalls: number) => {
      P.add('case', name, ep === detEphem ? 'fixed' : 'cheb', y0, t0, t1, rtol ?? 1e-12, dryMass, writeBurns(burns));
      let nd = 0;
      rec.derivSink = derivCalls > 0 ? (t, y, out) => {
        if (nd++ < derivCalls) D.add('deriv', name, t, y, out);
      } : null;
      const d = new Digest();
      const tmp = new Float64Array(7);
      const r = propagate(ep, y0, t0, t1, burns, {
        rtol,
        dryMass,
        onStep: (t, y, interp, tPrev) => {
          d.add(t);
          d.addAll(y);
          interp(tPrev + (t - tPrev) * 0.37, tmp);
          d.addAll(tmp);
          if (steps) P.add('step', t, y, tmp);
        },
      });
      rec.derivSink = null;
      d.add(r.t);
      d.addAll(r.y);
      d.add(r.accepted);
      d.add(r.rejected);
      P.add('final', r.t, r.y, r.accepted, r.rejected, 'digest', d.hex());
      console.log(`${name}: ${r.accepted} steps, digest ${d.hex()}`);
    };
    {
      const e = state(EARTH, 0);
      const R = 6_778_000;
      const v = Math.sqrt(J2000_BODIES[EARTH].gm / R);
      run('leo30', eph, [e[0] + R, e[1], e[2], e[3], e[4] + v, e[5], 1000], 0, 30 * DAY, [], undefined, 500, true, 3000);
    }
    {
      const t0 = -1.5 * C;
      const e = state(EARTH, t0);
      const R = 6_978_000;
      const v = Math.sqrt(J2000_BODIES[EARTH].gm / R);
      const burns: Burn[] = [
        { tStart: t0 + 3000, duration: 600, thrust: 50e3, isp: 450, direction: [1, 0.1, -0.05], frame: { kind: 'orbital', body: EARTH } },
        { tStart: t0 + 20000, duration: 300, thrust: 20e3, isp: 320, direction: [0.3, -1, 0.2], frame: { kind: 'inertial' } },
      ];
      run('leoburns', eph, [e[0], e[1] + R, e[2], e[3] - v, e[4], e[5] + 100, 20000], t0, t0 + 3 * DAY, burns, undefined, 500, true, 1000);
    }
    {
      const e = state(EARTH, -C);
      const vn = Math.hypot(e[3], e[4], e[5]);
      const y0 = [e[0] + (1e9 * e[3]) / vn, e[1] + (1e9 * e[4]) / vn, e[2] + (1e9 * e[5]) / vn, e[3] * (1 + 3000 / vn), e[4] * (1 + 3000 / vn), e[5] * (1 + 3000 / vn), 1000];
      run('helio', eph, y0, -C, 2.5 * C, [], undefined, 500, true, 2000);
    }
    {
      const t0 = 0.3 * C;
      const j = state(JUPITER, t0);
      const y0 = [j[0] + 3e9, j[1] - 1e9, j[2] + 2e8, j[3] - 9000, j[4] + 2500, j[5], 2000];
      const burns: Burn[] = [{ tStart: t0 + 2 * DAY, duration: 900, thrust: 4e3, isp: 320, direction: [-1, 0, 0.2], frame: { kind: 'orbital', body: JUPITER } }];
      run('jovian', eph, y0, t0, t0 + 12 * DAY, burns, 1e-11, 500, true, 3000);
    }
    run('determinism', detEphem, [...detY0], detT0, detT1, detBurns.map((b) => ({ ...b })), detOptions.rtol, detOptions.dryMass, true, 0);
    P.add('expect', 'determinism', EXPECTED_HEX.join(' '));
    // Bench workloads (no per-step records): heliocentric 1 yr from the epoch.
    {
      const e = state(EARTH, 0);
      const vn = Math.hypot(e[3], e[4], e[5]);
      const y0 = [e[0] + (1e9 * e[3]) / vn, e[1] + (1e9 * e[4]) / vn, e[2] + (1e9 * e[5]) / vn, e[3] * (1 + 3000 / vn), e[4] * (1 + 3000 / vn), e[5] * (1 + 3000 / vn), 1000];
      run('helio1yr', eph, y0, 0, JULIAN_YEAR, [], undefined, 0, false, 0);
    }
    // The Sun's 1PN term alone is ~v^2/c^2 of the Newtonian pull, so its last
    // bits never survive the force sum at solar-system speeds. A one-body
    // ephemeris with relativity and craft speeds up to ~0.5 c makes the two
    // comparable, so a reassociation of the 1PN formula shows in the output.
    {
      const relEph: Ephemeris = {
        count: 1,
        gm: [1.32712440041279419e20],
        positions: (_t, o) => { o[0] = 0; o[1] = 0; o[2] = 0; },
        bodyState: (_b, _t, o) => o.fill(0, 0, 6),
        relativity: { body: 0 },
      };
      const R = new Lines();
      const rnd = lcg(99);
      class Done {}
      for (let i = 0; i < 4000; i++) {
        const r = 1e8 * 10 ** (4 * rnd());
        const vesc = Math.sqrt(2 * relEph.gm[0] / r);
        const v = Math.min(1.5e8, vesc * 10 ** (3 * rnd() - 1));
        const u = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
        const w = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
        const nu = Math.hypot(...u), nw = Math.hypot(...w);
        const y0 = [r * u[0] / nu, r * u[1] / nu, r * u[2] / nu, v * w[0] / nw, v * w[1] / nw, v * w[2] / nw, 1000];
        rec.derivSink = (t, y, out) => { R.add('derivfixed', relEph.gm[0], t, y, out); throw new Done(); };
        try { propagate(relEph, y0, 0, 1, []); } catch (e) { if (!(e instanceof Done)) throw e; }
        rec.derivSink = null;
      }
      R.write('deriv-rel.txt');
    }
    void GM_EARTH;
    void FixedBodies;
    P.write('prop.txt');
    D.write('deriv.txt');
    console.log(`deriv.txt: ${D.length} derivative evaluations`);
  });

  it('corrector workload (captured propagations)', () => {
    const c = CASES[0];
    const { p, tArr, t0, parking, target } = setupCase(eph, c);
    const plan = planDeparture(eph, J2000_BODIES, { departure: 'earth', vInf: p.vInfDepVec, tDep: p.tDep, parking, t0, engine: ENGINE });
    const L = new Lines();
    let lo = Infinity;
    let hi = -Infinity;
    rec.propSink = (args, r) => {
      const [, y0, ta, tb, burns, opts] = args as [Ephemeris, ArrayLike<number>, number, number, Burn[] | undefined, { rtol?: number; dryMass?: number } | undefined];
      const b = burns ?? [];
      L.add('case', 'corr', 'cheb', Array.from(y0), ta, tb, opts?.rtol ?? 1e-12, opts?.dryMass ?? 0,
        [hx(b.length), ...b.map((x) => [x.tStart, x.duration, x.thrust, x.isp, ...x.direction, x.frame.kind === 'orbital' ? 1 : 0, x.frame.kind === 'orbital' ? x.frame.body : -1].map(hx).join(' '))].join(' '));
      L.add('final', r.t, r.y, r.accepted, r.rejected, 'digest', '-');
      lo = Math.min(lo, ta);
      hi = Math.max(hi, tb);
    };
    const r0 = correctBurn(eph, parking, t0, plan.burn, { kind: 'position', body: target, epoch: tArr }, { tolerance: 20000e3 });
    const r1 = correctBurn(eph, parking, t0, r0.burn, { body: target, bt: 1e7, br: 0, epoch: tArr - 5 * DAY, tPeri: tArr }, { tolerance: 1000, maxIterations: 4 });
    rec.propSink = null;
    L.write('corrector.txt');
    for (let k = eph.chunkIndex(lo); k <= eph.chunkIndex(hi); k++) writeChunk(k);
    world.add('chunks', chunksWritten.size, [...chunksWritten].sort((a, b) => a - b));
    world.write('world.txt');
    console.log(`corrector.txt: ${r0.evaluations + r1.evaluations} propagations, chunks ${eph.chunkIndex(lo)}..${eph.chunkIndex(hi)}`);
  });
});
