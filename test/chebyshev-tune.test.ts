/**
 * Tuner for DEFAULT_FITS. Skipped unless TUNE=1 (takes a minute or two):
 *   TUNE=1 pnpm vitest run test/chebyshev-tune.test.ts
 * For every body and candidate (segment length, degree, samples) it fits
 * TUNE_CHUNKS chunks (default 1, 128 days: ~72 orbits of Io) and measures the
 * maximum error at held-out mid-step times against the integrator, in the
 * quantity the body's slot stores: a moon's position relative to its system
 * barycenter, a planet's system barycenter, any other body's position. For several degree
 * caps it prints, per body, the candidate with the fewest coefficients per unit
 * time whose error is below TUNE_TARGET. DEFAULT_FITS is the cap-12 table.
 * TUNE_BODIES=io,europa restricts the search (the planets were tuned earlier
 * at h = 0.5 d and only need re-checking).
 */
import { describe, expect, it } from 'vitest';
import { ChebyshevLayout, TUNE_TARGET, centersOf, fitSamples, sampleIntervals, type BodyFit } from '../src/physics/chebyshev-ephemeris';
import { J2000_BODIES } from '../src/physics/solar-system';
import { gridRun, offGrid } from './helpers/chebyshev-reference';
import { ChebyshevEphemeris } from '../src/physics/chebyshev-ephemeris';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUN = ENV.TUNE === '1';

describe.skipIf(!RUN)('Chebyshev fit tuner', () => {
  it('finds the cheapest fit per body under the target', () => {
    const bodies = J2000_BODIES;
    const n = bodies.length;
    const m = 3 * n;
    const gm = bodies.map((b) => b.gm);
    const centers = centersOf(bodies);
    const only = ENV.TUNE_BODIES ? new Set(ENV.TUNE_BODIES.split(',')) : null;
    const probe = ChebyshevLayout.forBodies(bodies);
    const S = probe.chunkSteps;
    const chunks = Number(ENV.TUNE_CHUNKS ?? 1);
    const run = gridRun(chunks * S);
    // The quantity stored in each slot, from barycentric positions.
    const gsys = new Float64Array(n);
    probe.sysPlanet.forEach((p, s) => {
      let g = gm[p];
      for (let k = probe.sysStart[s]; k < probe.sysStart[s + 1]; k++) g += gm[probe.sysMoons[k]];
      gsys[p] = g;
    });
    const bary = (q: ArrayLike<number>, s: number, c: number): number => {
      const pl = probe.sysPlanet[s];
      let sum = gm[pl] * q[3 * pl + c];
      for (let k = probe.sysStart[s]; k < probe.sysStart[s + 1]; k++) sum += gm[probe.sysMoons[k]] * q[3 * probe.sysMoons[k] + c];
      return sum / gsys[pl];
    };
    const slot = (q: ArrayLike<number>, b: number, c: number): number => {
      const s = probe.systemOf[b];
      if (s < 0) return q[3 * b + c];
      return centers[b] >= 0 ? q[3 * b + c] - bary(q, s, c) : bary(q, s, c);
    };
    // Held-out references: every 3rd mid-step.
    const tests: number[] = [];
    for (let j = 1; j < chunks * S; j += 3) tests.push(j);
    const refs = new Float64Array(tests.length * m);
    const v = new Float64Array(m);
    const p = new Float64Array(m);
    tests.forEach((j, i) => {
      offGrid(run, j, 0.5, p, v);
      for (let b = 0; b < n; b++) for (let c = 0; c < 3; c++) refs[i * m + 3 * b + c] = slot(p, b, c);
    });
    const table: { fit: BodyFit; err: Float64Array }[] = [];
    const out = new Float64Array(m);
    for (let seg = 4; seg <= S; seg *= 2) { // a segment must divide the chunk
      for (let deg = 5; deg <= 20; deg++) {
        const fit: BodyFit = { segSteps: seg, degree: deg, samples: Math.min(seg, 32) };
        if (3 * (sampleIntervals(fit) + 1) < 2 * (deg + 1)) continue;
        const fits = bodies.map(() => fit);
        const layout = new ChebyshevLayout(fits, run.h, S, centers, gm);
        const eph = new ChebyshevEphemeris(bodies, { fits, h: run.h, chunkSteps: S });
        for (let c = 0; c < chunks; c++) {
          const coeffs = new Float64Array(layout.chunkLength);
          fitSamples(layout, run.samples.subarray(c * S * 3 * m, ((c + 1) * S + 1) * 3 * m), n, coeffs, gm);
          eph.addChunk(c, coeffs);
        }
        const err = new Float64Array(n);
        tests.forEach((j, i) => {
          eph.positions((j + 0.5) * run.h, out);
          for (let b = 0; b < n; b++) {
            if (only && !only.has(bodies[b].id)) continue;
            const e = Math.hypot(slot(out, b, 0) - refs[i * m + 3 * b], slot(out, b, 1) - refs[i * m + 3 * b + 1], slot(out, b, 2) - refs[i * m + 3 * b + 2]);
            if (e > err[b]) err[b] = e;
          }
        });
        if (ENV.TUNE_VERBOSE) console.log(`seg ${seg} deg ${deg}: ${Array.from(err, (e) => e.toExponential(1)).join(' ')}`);
        table.push({ fit, err });
      }
    }
    // Per degree cap: cheapest storage under the target. Evaluation cost ~ sum of (degree+1).
    const target = Number(ENV.TUNE_TARGET ?? TUNE_TARGET);
    for (const cap of [10, 12, 14, 16, 20]) {
      const best: ({ fit: BodyFit; err: number } | undefined)[] = [];
      for (const { fit, err } of table) {
        if (fit.degree > cap) continue;
        for (let b = 0; b < n; b++) {
          if (!(err[b] < target)) continue;
          const cur = best[b];
          const cost = (fit.degree + 1) / fit.segSteps;
          const curCost = cur ? (cur.fit.degree + 1) / cur.fit.segSteps : Infinity;
          if (cost < curCost || (cost === curCost && cur && fit.degree < cur.fit.degree)) best[b] = { fit, err: err[b] };
        }
      }
      let terms = 0;
      let bytes = 0;
      const lines: string[] = [];
      bodies.forEach((body, b) => {
        if (only && !only.has(body.id)) return;
        const f = best[b];
        if (!f) {
          lines.push(`  ${body.id}: none`);
          terms = NaN;
          return;
        }
        terms += f.fit.degree + 1;
        bytes += ((36525 * 86400) / (f.fit.segSteps * run.h)) * 3 * (f.fit.degree + 1) * 8;
        lines.push(
          `  ${body.id}: { segSteps: ${f.fit.segSteps}, degree: ${f.fit.degree}, samples: ${f.fit.samples} }, // ${(f.fit.segSteps * run.h) / 86400} d, ${(f.err * 1e3).toFixed(1)} mm`,
        );
      });
      console.log(`degree cap ${cap}: sum(degree+1) = ${terms}, ${(bytes / 1e6).toFixed(2)} MB/century\n${lines.join('\n')}`);
    }
    expect(table.length).toBeGreaterThan(0);
  }, 3_600_000);
});
