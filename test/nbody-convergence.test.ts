/**
 * Order and reversibility of the N-body splitting on a problem with a known
 * answer: the two-body problem, whose relative motion is an exact Kepler ellipse.
 */
import { describe, expect, it } from 'vitest';
import { KAHAN_LI_8, LEAPFROG, NBodyIntegrator, type SplittingScheme } from '../src/physics/nbody';

const GM1 = 1.0;
const GM2 = 1e-3;
const MU = GM1 + GM2;
const A = 1.0;
const E = 0.5;
const PERIOD = 2 * Math.PI * Math.sqrt((A * A * A) / MU);

/** Barycentric two-body state starting at periapsis on +x, orbit in xy plane. */
function initial(): number[] {
  const rp = A * (1 - E);
  const vp = Math.sqrt((MU * (1 + E)) / rp);
  const f1 = GM2 / MU;
  const f2 = GM1 / MU;
  return [-f1 * rp, 0, 0, 0, -f1 * vp, 0, f2 * rp, 0, 0, 0, f2 * vp, 0];
}

/** Exact relative position (body 2 - body 1) at time t, from Kepler's equation. */
function keplerRelative(t: number): [number, number] {
  const M = 2 * Math.PI * (t / PERIOD);
  let Ea = M;
  for (let i = 0; i < 50; i++) Ea -= (Ea - E * Math.sin(Ea) - M) / (1 - E * Math.cos(Ea));
  return [A * (Math.cos(Ea) - E), A * Math.sqrt(1 - E * E) * Math.sin(Ea)];
}

function errorAfter(scheme: SplittingScheme, stepsPerOrbit: number, orbits: number): number {
  const h = PERIOD / stepsPerOrbit;
  const it = new NBodyIntegrator([GM1, GM2], initial(), 0, h, scheme);
  for (let i = 0; i < stepsPerOrbit * orbits; i++) it.step();
  const [x, y] = keplerRelative(it.t);
  return Math.hypot(it.q[3] - it.q[0] - x, it.q[4] - it.q[1] - y, it.q[5] - it.q[2]);
}

describe('Kahan-Li order-8 composition', () => {
  it('coefficients are consistent and symmetric', () => {
    const { a, b } = KAHAN_LI_8;
    expect(a.length).toBe(17);
    expect(b.length).toBe(18);
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < a.length; i++) {
      sa += a[i];
      expect(a[i]).toBe(a[a.length - 1 - i]);
    }
    for (let i = 0; i < b.length; i++) {
      sb += b[i];
      expect(b[i]).toBe(b[b.length - 1 - i]);
    }
    expect(Math.abs(sa - 1)).toBeLessThan(1e-15);
    expect(Math.abs(sb - 1)).toBeLessThan(1e-15);
  });

  it('converges at order 8 on an e=0.5 Kepler orbit', () => {
    // Steps per orbit chosen so the error stays far above roundoff (~1e-13).
    const ns = [60, 85, 120, 170, 240];
    const errs = ns.map((n) => errorAfter(KAHAN_LI_8, n, 10));
    const orders = [];
    for (let i = 1; i < ns.length; i++) orders.push(Math.log(errs[i - 1] / errs[i]) / Math.log(ns[i] / ns[i - 1]));
    console.log('KL8 steps/orbit', ns, '\n  errors', errs.map((e) => e.toExponential(2)), '\n  observed order', orders.map((o) => o.toFixed(2)));
    // Asymptotic order 8; the coarsest pair is pre-asymptotic.
    for (const o of orders.slice(1)) {
      expect(o).toBeGreaterThan(7.5);
      expect(o).toBeLessThan(8.6);
    }
  });

  it('leapfrog reference converges at order 2 (validates the harness)', () => {
    const e1 = errorAfter(LEAPFROG, 2000, 2);
    const e2 = errorAfter(LEAPFROG, 4000, 2);
    const order = Math.log2(e1 / e2);
    expect(order).toBeGreaterThan(1.95);
    expect(order).toBeLessThan(2.05);
  });

  it('is time-reversible: N steps forward then N back returns to the start', () => {
    const y0 = initial();
    const h = PERIOD / 100;
    const fwd = new NBodyIntegrator([GM1, GM2], y0, 0, h);
    for (let i = 0; i < 1000; i++) fwd.step();
    const mid = new Float64Array(12);
    fwd.getState(mid);
    const back = new NBodyIntegrator([GM1, GM2], mid, fwd.t, -h);
    for (let i = 0; i < 1000; i++) back.step();
    const end = new Float64Array(12);
    back.getState(end);
    let maxErr = 0;
    for (let k = 0; k < 12; k++) maxErr = Math.max(maxErr, Math.abs(end[k] - y0[k]));
    // Pure roundoff: positions are O(1), so ~1e-13 after 2000 compensated steps.
    expect(maxErr).toBeLessThan(1e-12);
    expect(back.t).toBe(0);
  });
});
