/**
 * Tuner for DEFAULT_FITS. Skipped unless TUNE=1 (takes a few seconds):
 *   TUNE=1 pnpm vitest run test/chebyshev-tune.test.ts
 * For every body and candidate (segment length, degree) it fits 4 chunks
 * (~11 years) and measures the maximum position error at held-out mid-step
 * times against the integrator. For several degree caps it prints, per body,
 * the candidate with the fewest coefficients per unit time whose error is
 * below TUNE_TARGET. DEFAULT_FITS is the cap-12 table.
 */
import { describe, expect, it } from 'vitest';
import { ChebyshevEphemeris, ChebyshevLayout, DEFAULT_CHUNK_STEPS, TUNE_TARGET, fitSamples, sampleIntervals, type BodyFit } from '../src/physics/chebyshev-ephemeris';
import { J2000_BODIES } from '../src/physics/solar-system';
import { gridRun, offGrid } from './helpers/chebyshev-reference';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUN = ENV.TUNE === '1';

describe.skipIf(!RUN)('Chebyshev fit tuner', () => {
  it('finds the cheapest fit per body under the target', () => {
    const S = DEFAULT_CHUNK_STEPS;
    const chunks = 4;
    const run = gridRun(chunks * S);
    const n = run.n;
    const m = 3 * n;
    // Held-out references: every 3rd mid-step.
    const tests: number[] = [];
    for (let j = 1; j < chunks * S; j += 3) tests.push(j);
    const refs = new Float64Array(tests.length * m);
    const v = new Float64Array(m);
    const p = new Float64Array(m);
    tests.forEach((j, i) => {
      offGrid(run, j, 0.5, p, v);
      refs.set(p, i * m);
    });
    const table: { fit: BodyFit; err: Float64Array }[] = [];
    const out = new Float64Array(m);
    for (let seg = 1; seg <= 1024; seg *= 2) {
      for (let deg = 5; deg <= 20; deg++) {
        const fit = { segSteps: seg, degree: deg };
        if (3 * (sampleIntervals(fit) + 1) < 2 * (deg + 1)) continue;
        const fits = J2000_BODIES.map(() => fit);
        const layout = new ChebyshevLayout(fits);
        const eph = new ChebyshevEphemeris(J2000_BODIES, { fits });
        for (let c = 0; c < chunks; c++) {
          const coeffs = new Float64Array(layout.chunkLength);
          fitSamples(layout, run.samples.subarray(c * S * 3 * m, ((c + 1) * S + 1) * 3 * m), n, coeffs);
          eph.addChunk(c, coeffs);
        }
        const err = new Float64Array(n);
        tests.forEach((j, i) => {
          eph.positions((j + 0.5) * run.h, out);
          for (let b = 0; b < n; b++) {
            const e = Math.hypot(out[3 * b] - refs[i * m + 3 * b], out[3 * b + 1] - refs[i * m + 3 * b + 1], out[3 * b + 2] - refs[i * m + 3 * b + 2]);
            if (e > err[b]) err[b] = e;
          }
        });
        if (ENV.TUNE_VERBOSE) console.log(`seg ${seg} deg ${deg}: ${Array.from(err, (e) => e.toExponential(1)).join(' ')}`);
        table.push({ fit, err });
      }
    }
    // Per degree cap: cheapest storage under the target. Evaluation cost ~ sum of (degree+1).
    for (const cap of [8, 10, 12, 14, 16, 20]) {
      const best: ({ fit: BodyFit; err: number } | undefined)[] = [];
      for (const { fit, err } of table) {
        if (fit.degree > cap) continue;
        for (let b = 0; b < n; b++) {
          if (!(err[b] < TUNE_TARGET)) continue;
          const cur = best[b];
          const cost = (fit.degree + 1) / fit.segSteps;
          const curCost = cur ? (cur.fit.degree + 1) / cur.fit.segSteps : Infinity;
          if (cost < curCost || (cost === curCost && cur && fit.degree < cur.fit.degree)) best[b] = { fit, err: err[b] };
        }
      }
      let terms = 0;
      let bytes = 0;
      const lines: string[] = [];
      J2000_BODIES.forEach((body, b) => {
        const f = best[b];
        if (!f) {
          lines.push(`  ${body.id}: none`);
          terms = NaN;
          return;
        }
        terms += f.fit.degree + 1;
        bytes += ((36525 * 2) / f.fit.segSteps) * 3 * (f.fit.degree + 1) * 8;
        lines.push(`  ${body.id}: { segSteps: ${f.fit.segSteps}, degree: ${f.fit.degree} }, // ${f.fit.segSteps / 2} d, ${(f.err * 1e3).toFixed(1)} mm`);
      });
      console.log(`degree cap ${cap}: sum(degree+1) = ${terms}, ${(bytes / 1e6).toFixed(2)} MB/century\n${lines.join('\n')}`);
    }
    expect(table.length).toBeGreaterThan(0);
  }, 600_000);
});
