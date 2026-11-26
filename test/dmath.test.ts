import { describe, expect, it } from 'vitest';
import * as dm from '../src/physics/dmath';

const buf = new DataView(new ArrayBuffer(8));
function ordered(x: number): bigint {
  buf.setFloat64(0, x);
  const b = buf.getBigInt64(0);
  return b < 0n ? -(b & 0x7fffffffffffffffn) : b;
}
/** Distance in units in the last place between two doubles. */
function ulps(a: number, b: number): number {
  if (a === b) return 0;
  const d = ordered(a) - ordered(b);
  return Number(d < 0n ? -d : d);
}

// Deterministic PRNG (mulberry32) so the sample set is fixed.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function worst(xs: number[], f: (x: number) => number, g: (x: number) => number): { ulp: number; at: number } {
  let w = 0;
  let at = 0;
  for (const x of xs) {
    const e = ulps(f(x), g(x));
    if (e > w) {
      w = e;
      at = x;
    }
  }
  return { ulp: w, at };
}

/**
 * Math.sin in V8 is fdlibm-derived and within 1 ulp of the true value, as is
 * dmath; two such results can be up to 1 ulp apart in either direction, and
 * where the result is near zero (close to a multiple of pi) both are
 * accurate in absolute but not in relative terms. We therefore assert <= 2 ulp
 * against Math.* away from zeros, and an absolute bound near zeros.
 */
describe('dmath sin/cos', () => {
  const r = rng(12345);
  const xs: number[] = [];
  for (let i = 0; i < 200000; i++) xs.push((r() * 2 - 1) * 8); // [-8, 8]
  for (let i = 0; i < 50000; i++) xs.push((r() * 2 - 1) * 1e5); // large
  for (let i = 0; i < 20000; i++) xs.push((r() * 2 - 1) * 8e5); // near the limit
  // Dense near multiples of pi/2 (where the reduction loses the most bits).
  for (let k = -2000; k <= 2000; k++) {
    const c = k * (Math.PI / 2);
    for (let j = -8; j <= 8; j++) xs.push(c + j * 1e-9 * (1 + Math.abs(c)));
    xs.push(c, c + Number.EPSILON * Math.abs(c), c - Number.EPSILON * Math.abs(c));
  }
  // Tiny arguments.
  for (let i = 0; i < 1000; i++) xs.push((r() * 2 - 1) * 1e-8);

  it('sin within 2 ulp of Math.sin away from zeros, 1e-16 absolute near zeros', () => {
    let wRel = 0;
    let wAbs = 0;
    for (const x of xs) {
      const a = dm.sin(x);
      const b = Math.sin(x);
      if (Math.abs(b) > 1e-3) wRel = Math.max(wRel, ulps(a, b));
      else wAbs = Math.max(wAbs, Math.abs(a - b));
    }
    console.log(`sin: worst ${wRel} ulp (|sin|>1e-3), worst abs ${wAbs.toExponential(2)} near zeros, ${xs.length} samples`);
    expect(wRel).toBeLessThanOrEqual(1);
    expect(wAbs).toBeLessThan(2e-16);
  });

  it('cos within 2 ulp of Math.cos away from zeros, 1e-16 absolute near zeros', () => {
    let wRel = 0;
    let wAbs = 0;
    for (const x of xs) {
      const a = dm.cos(x);
      const b = Math.cos(x);
      if (Math.abs(b) > 1e-3) wRel = Math.max(wRel, ulps(a, b));
      else wAbs = Math.max(wAbs, Math.abs(a - b));
    }
    console.log(`cos: worst ${wRel} ulp (|cos|>1e-3), worst abs ${wAbs.toExponential(2)} near zeros`);
    expect(wRel).toBeLessThanOrEqual(1);
    expect(wAbs).toBeLessThan(2e-16);
  });

  it('small arguments are exact to the ulp (no reduction)', () => {
    const w = worst(xs.filter((x) => Math.abs(x) < 0.785), dm.sin, Math.sin);
    expect(w.ulp).toBeLessThanOrEqual(1);
  });

  it('sincos equals sin, cos bit for bit', () => {
    for (let i = 0; i < 20000; i++) {
      const [s, c] = dm.sincos(xs[i * 13]);
      expect(Object.is(s, dm.sin(xs[i * 13])) && Object.is(c, dm.cos(xs[i * 13]))).toBe(true);
    }
  });

  it('throws beyond the supported range and passes NaN through', () => {
    expect(() => dm.sin(1e7)).toThrow(RangeError);
    expect(Number.isNaN(dm.cos(NaN))).toBe(true);
  });
});

describe('dmath atan/atan2', () => {
  const r = rng(999);
  it('atan within 1 ulp of Math.atan', () => {
    const xs: number[] = [];
    for (let i = 0; i < 100000; i++) xs.push((r() * 2 - 1) * 4);
    for (let i = 0; i < 50000; i++) xs.push(Math.tan((r() * 2 - 1) * 1.5707));
    for (const b of [0.4375, 0.6875, 1.1875, 2.4375]) for (let j = -50; j <= 50; j++) xs.push(b * (1 + j * 1e-15));
    const w = worst(xs, dm.atan, Math.atan);
    console.log(`atan: worst ${w.ulp} ulp at ${w.at}`);
    expect(w.ulp).toBeLessThanOrEqual(1);
  });

  it('atan2 within 2 ulp of Math.atan2 over all quadrants', () => {
    let w = 0;
    for (let i = 0; i < 200000; i++) {
      const y = (r() * 2 - 1) * Math.pow(10, r() * 8 - 4);
      const x = (r() * 2 - 1) * Math.pow(10, r() * 8 - 4);
      w = Math.max(w, ulps(dm.atan2(y, x), Math.atan2(y, x)));
    }
    // Unit circle, dense, including the axes.
    for (let k = 0; k < 100000; k++) {
      const a = -Math.PI + (2 * Math.PI * k) / 100000;
      w = Math.max(w, ulps(dm.atan2(Math.sin(a), Math.cos(a)), Math.atan2(Math.sin(a), Math.cos(a))));
    }
    console.log(`atan2: worst ${w} ulp`);
    expect(w).toBeLessThanOrEqual(1);
  });

  it('atan2 special cases match Math.atan2', () => {
    const v = [0, -0, 1, -1, Infinity, -Infinity, 1e-300, -1e300];
    for (const y of v) for (const x of v) expect(dm.atan2(y, x)).toBe(Math.atan2(y, x));
  });
});
