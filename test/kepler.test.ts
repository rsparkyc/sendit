import { describe, expect, it } from 'vitest';
import { Dop853, componentwiseScale } from '../src/physics/dop853';
import { FixedBodies, propagate } from '../src/physics/spacecraft';

const GM_EARTH = 3.986004418e14;
const earth = new FixedBodies([{ gm: GM_EARTH, position: [0, 0, 0] }]);

/** Periapsis state on the +x axis, orbit in the xy plane. */
function periapsisState(rp: number, e: number, mass = 1000) {
  const a = rp / (1 - e);
  const vp = Math.sqrt((GM_EARTH * (1 + e)) / rp);
  const period = 2 * Math.PI * Math.sqrt((a * a * a) / GM_EARTH);
  return { y0: [rp, 0, 0, 0, vp, 0, mass], a, period, ra: a * (1 + e), va: (vp * rp) / (a * (1 + e)) };
}

const energy = (y: ArrayLike<number>) =>
  0.5 * (y[3] ** 2 + y[4] ** 2 + y[5] ** 2) - GM_EARTH / Math.hypot(y[0], y[1], y[2]);

describe('two-body Kepler orbit', () => {
  // DOP853 is not symplectic: dE/E ~ rtol-level gives a period error 1.5x that, which over
  // 10 orbits is pure along-track drift ~ v_p * 10 T * 1.5 dE/E (metres at e=0.95, T=485 000 s).
  const limits: Record<number, { pos: number; dE: number }> = {
    0: { pos: 1, dE: 1e-10 },
    0.7: { pos: 1, dE: 1e-10 },
    0.95: { pos: 20, dE: 1e-9 },
  };
  for (const e of [0, 0.7, 0.95]) {
    it(`e=${e}: reaches apoapsis at T/2 and closes after 10 orbits`, () => {
      const { y0, period, ra, va } = periapsisState(6_678_000, e);

      const half = propagate(earth, y0, 0, period / 2);
      const apoErr = Math.hypot(half.y[0] + ra, half.y[1], half.y[2]);
      const apoVelErr = Math.hypot(half.y[3], half.y[4] + va, half.y[5]);

      const full = propagate(earth, y0, 0, 10 * period);
      const posErr = Math.hypot(full.y[0] - y0[0], full.y[1] - y0[1], full.y[2] - y0[2]);
      const dE = Math.abs(energy(full.y) / energy(y0) - 1);
      console.log(
        `e=${e}: apo err ${apoErr.toExponential(2)} m / ${apoVelErr.toExponential(2)} m/s, ` +
          `10-orbit closure ${posErr.toExponential(2)} m, dE/E ${dE.toExponential(2)}, ` +
          `${full.accepted} steps (${full.rejected} rejected)`,
      );

      expect(apoErr).toBeLessThan(0.01);
      expect(apoVelErr).toBeLessThan(1e-5);
      expect(posErr).toBeLessThan(limits[e].pos);
      expect(dE).toBeLessThan(limits[e].dE);
      expect(full.y[6]).toBe(1000);
    });
  }

  it('is 8th order: halving the step cuts the error ~256x', () => {
    const { y0, period } = periapsisState(6_678_000, 0.3);
    const f = (_t: number, y: Float64Array, out: Float64Array) => {
      const r = Math.hypot(y[0], y[1], y[2]);
      const k = -GM_EARTH / (r * r * r);
      out[0] = y[3];
      out[1] = y[4];
      out[2] = y[5];
      out[3] = k * y[0];
      out[4] = k * y[1];
      out[5] = k * y[2];
    };
    const errorWith = (n: number) => {
      const integ = new Dop853(6, f, componentwiseScale(1e-12, 1e-6));
      integ.reset(0, y0.slice(0, 6));
      for (let i = 0; i < n; i++) integ.stepFixed(period / n);
      return Math.hypot(integ.y[0] - y0[0], integ.y[1] - y0[1], integ.y[2] - y0[2]);
    };
    const e1 = errorWith(40);
    const e2 = errorWith(80);
    const order = Math.log2(e1 / e2);
    console.log(`fixed-step errors ${e1.toExponential(3)} -> ${e2.toExponential(3)} m, order ${order.toFixed(2)}`);
    expect(order).toBeGreaterThan(7.5);
    expect(order).toBeLessThan(9.5);
  });

  it('is bit-identical run to run', () => {
    const { y0, period } = periapsisState(6_678_000, 0.7);
    const a = propagate(earth, y0, 0, 3 * period);
    const b = propagate(earth, y0, 0, 3 * period);
    expect(Array.from(a.y)).toEqual(Array.from(b.y));
  });
});
