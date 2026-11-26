/**
 * The integrated ephemeris through the spacecraft `Ephemeris` interface:
 * interpolation accuracy, an end-to-end LEO smoke test, and cost measurements.
 */
import { describe, expect, it } from 'vitest';
import { NBodyIntegrator } from '../src/physics/nbody';
import { DAY, DEFAULT_STEP, IntegratedEphemeris, J2000_BODIES, JULIAN_YEAR, bodyIndex, initialState } from '../src/physics/solar-system';
import { propagate } from '../src/physics/spacecraft';

const N = J2000_BODIES.length;
const EARTH = bodyIndex('earth');

describe('IntegratedEphemeris', () => {
  it('quintic Hermite interpolation error at mid-step is far below a metre', () => {
    // Midpoints of the 0.5 d grid are nodes of a 0.25 d integration, whose
    // states differ from the 0.5 d run by < 1 mm over these spans.
    const coarse = new IntegratedEphemeris(J2000_BODIES, DEFAULT_STEP);
    const fine = new IntegratedEphemeris(J2000_BODIES, DEFAULT_STEP / 2);
    const a = new Float64Array(3 * N);
    const b = new Float64Array(3 * N);
    const va = new Float64Array(3 * N);
    const vb = new Float64Array(3 * N);
    let maxP = 0;
    let maxV = 0;
    for (let k = -60; k < 60; k++) {
      const t = (k + 0.5) * DEFAULT_STEP;
      coarse.evaluate(t, a, va);
      fine.evaluate(t, b, vb);
      for (let i = 0; i < N; i++) {
        maxP = Math.max(maxP, Math.hypot(a[3 * i] - b[3 * i], a[3 * i + 1] - b[3 * i + 1], a[3 * i + 2] - b[3 * i + 2]));
        maxV = Math.max(maxV, Math.hypot(va[3 * i] - vb[3 * i], va[3 * i + 1] - vb[3 * i + 1], va[3 * i + 2] - vb[3 * i + 2]));
      }
    }
    console.log(`interpolation at 0.5 d: max position error ${maxP.toExponential(2)} m, velocity ${maxV.toExponential(2)} m/s (Moon dominates)`);
    // Observed 0.12 m and 1.3e-7 m/s (Moon); planets far smaller. That is ~5e-10
    // of the Earth-Moon distance and ~1e-4 of the numerical error budget.
    expect(maxP).toBeLessThan(0.3);
    expect(maxV).toBeLessThan(1e-6);
  });

  it('nodes reproduce the integrator exactly, forward and backward', () => {
    const eph = new IntegratedEphemeris();
    const out = new Float64Array(3 * N);
    for (const k of [7, -7]) {
      eph.positions(k * DEFAULT_STEP, out);
      const it = new NBodyIntegrator(eph.gm, initialState(), 0, Math.sign(k) * DEFAULT_STEP);
      for (let i = 0; i < Math.abs(k); i++) it.step();
      for (let j = 0; j < 3 * N; j++) expect(out[j]).toBe(it.q[j]);
    }
  });

  it('keeps a spacecraft in low Earth orbit around the moving Earth for 3 days', () => {
    const eph = new IntegratedEphemeris();
    const earth = new Float64Array(6);
    eph.bodyState(EARTH, 0, earth);
    const gmE = J2000_BODIES[EARTH].gm;
    const R = 6_778_000; // 400 km altitude
    const v = Math.sqrt(gmE / R);
    // Circular, in the ICRF xy plane, relative to Earth.
    const y0 = [earth[0] + R, earth[1], earth[2], earth[3], earth[4] + v, earth[5], 1000];
    let rMin = Infinity;
    let rMax = 0;
    const tmp = new Float64Array(6);
    const res = propagate(eph, y0, 0, 3 * DAY, [], {
      onStep: (t, y) => {
        eph.bodyState(EARTH, t, tmp);
        const r = Math.hypot(y[0] - tmp[0], y[1] - tmp[1], y[2] - tmp[2]);
        rMin = Math.min(rMin, r);
        rMax = Math.max(rMax, r);
      },
    });
    console.log(`LEO 3 days: altitude above mean radius ${((rMin - 6_371_000) / 1e3).toFixed(3)}..${((rMax - 6_371_000) / 1e3).toFixed(3)} km altitude, ${res.accepted} steps`);
    expect(res.t).toBe(3 * DAY);
    // Point-mass Earth + Moon/Sun tides: the orbit stays near-circular. Tidal
    // perturbation at LEO is ~1e-7 g, so the radius varies by well under 1 km.
    expect(rMin).toBeGreaterThan(R - 1000);
    expect(rMax).toBeLessThan(R + 1000);
  }, 60_000);

  it('measures cost of a century and memory if every step were stored', () => {
    const h = DEFAULT_STEP;
    const steps = Math.round((100 * JULIAN_YEAR) / h);
    const it = new NBodyIntegrator(J2000_BODIES.map((b) => b.gm), initialState(), 0, h);
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) it.step();
    const ms = performance.now() - t0;
    const bytesPerStep = 9 * N * 8; // q, v, a per body, float64 (what IntegratedEphemeris keeps)
    const posVelBytes = 6 * N * 8;
    console.log(
      `100 yr at h=${h / DAY} d: ${steps} steps, ${(ms / 1000).toFixed(2)} s wall clock, ` +
        `${((steps * 17) / (ms / 1000) / 1e6).toFixed(2)} M force evaluations/s. ` +
        `Storing every step: ${((steps * bytesPerStep) / 1e6).toFixed(1)} MB (pos+vel+acc), ${((steps * posVelBytes) / 1e6).toFixed(1)} MB (pos+vel).`,
    );
    expect(ms).toBeLessThan(30_000);
  }, 60_000);
});
