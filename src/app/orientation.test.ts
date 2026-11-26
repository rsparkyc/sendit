/** Surface-fixed frames with the real rotation models. */
import { describe, expect, it } from 'vitest';
import { computeFrame, frameKey, newFrameState, parseFrameKey, toFrame, type BodySnapshot } from './frames';
import { bodyOrientation } from './orientation';
import { BODIES, bodyIndex } from './physics';

const E = bodyIndex('earth');
const n = BODIES.length;
/** Earth at an arbitrary (moving) heliocentric place; other bodies irrelevant. */
function snap(t: number): BodySnapshot {
  const pos = new Float64Array(3 * n), vel = new Float64Array(3 * n);
  pos[3 * E] = 1.4e11 + 30e3 * t;
  pos[3 * E + 1] = -2e10;
  vel[3 * E] = 30e3;
  return { count: n, pos, vel, gm: new Float64Array(n).fill(1), t, orient: bodyOrientation };
}

describe('surface frame', () => {
  const t0 = 8.5e8; // 2026
  const M0 = new Float64Array(9);
  const w = bodyOrientation(E, t0, M0);

  it('holds a geostationary satellite still for several days', () => {
    expect(w).toBeCloseTo(7.2921159e-5, 10);
    const R = 42_164e3;
    const fs = newFrameState();
    const q = new Float64Array(3);
    let first: Float64Array | null = null;
    let worst = 0;
    for (let h = 0; h <= 5 * 24; h += 1.7) {
      const t = t0 + h * 3600;
      const th = w * (t - t0) + 0.3;
      const s = snap(t);
      // Circular equatorial orbit at the sidereal rate, about the pole at t0.
      const p = [0, 1, 2].map((k) => s.pos[3 * E + k] + R * (Math.cos(th) * M0[3 * k] + Math.sin(th) * M0[3 * k + 1]));
      computeFrame({ kind: 'surface', center: E }, s, fs);
      toFrame(fs, p, 0, q, 0);
      if (!first) first = q.slice();
      else worst = Math.max(worst, Math.hypot(q[0] - first[0], q[1] - first[1], q[2] - first[2]));
    }
    expect(Math.hypot(...first!)).toBeCloseTo(R, -1);
    expect(worst).toBeLessThan(500); // m over five days (pole precession and UT1 drift)
  });

  it('keeps a launch site fixed', () => {
    const site = [6.378e6 * Math.cos(0.09), 0.3e6, 6.378e6 * Math.sin(0.09)]; // body-fixed, Kourou-like latitude
    const fs = newFrameState();
    const M = new Float64Array(9), q = new Float64Array(3);
    for (const dt of [0, 3600, 86400 * 3.3]) {
      const t = t0 + dt;
      const s = snap(t);
      bodyOrientation(E, t, M);
      const p = [0, 1, 2].map((k) => s.pos[3 * E + k] + M[3 * k] * site[0] + M[3 * k + 1] * site[1] + M[3 * k + 2] * site[2]);
      computeFrame({ kind: 'surface', center: E }, s, fs);
      toFrame(fs, p, 0, q, 0);
      for (let k = 0; k < 3; k++) expect(Math.abs(q[k] - site[k])).toBeLessThan(0.01); // m, float rounding at 1 AU
    }
  });

  it('has a key, and other bodies use the IAU model', () => {
    const ids = BODIES.map((b) => b.id);
    expect(frameKey({ kind: 'surface', center: E }, (i) => ids[i])).toBe('fix:earth');
    expect(parseFrameKey('fix:mars', bodyIndex)).toEqual({ kind: 'surface', center: bodyIndex('mars') });
    expect(bodyOrientation(bodyIndex('mars'), t0, new Float64Array(9))).toBeCloseTo((350.89198226 * Math.PI) / 180 / 86400, 9);
  });
});
