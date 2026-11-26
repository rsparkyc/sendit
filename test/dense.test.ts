import { describe, expect, it } from 'vitest';
import { Dop853, componentwiseScale, type ScaleFn } from '../src/physics/dop853';

const GM = 3.986004418e14;

const kepler = (_t: number, y: Float64Array, out: Float64Array) => {
  const r2 = y[0] * y[0] + y[1] * y[1] + y[2] * y[2];
  const k = -GM / (r2 * Math.sqrt(r2));
  out[0] = y[3];
  out[1] = y[4];
  out[2] = y[5];
  out[3] = k * y[0];
  out[4] = k * y[1];
  out[5] = k * y[2];
};

/** Position/velocity scaled by vector magnitude, like spacecraft.ts. */
const magScale = (rtol: number): ScaleFn => (y, yNew, s) => {
  const r = Math.max(Math.hypot(y[0], y[1], y[2]), Math.hypot(yNew[0], yNew[1], yNew[2]));
  const v = Math.max(Math.hypot(y[3], y[4], y[5]), Math.hypot(yNew[3], yNew[4], yNew[5]));
  s[0] = s[1] = s[2] = 1e-3 + rtol * r;
  s[3] = s[4] = s[5] = 1e-9 + rtol * v;
};

function periapsis(e: number) {
  const rp = 6_678_000;
  const a = rp / (1 - e);
  return { y0: [rp, 0, 0, 0, Math.sqrt((GM * (1 + e)) / rp), 0], period: 2 * Math.PI * Math.sqrt(a ** 3 / GM) };
}

const posErr = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('Dop853 dense output', () => {
  for (const e of [0, 0.3, 0.7, 0.95]) {
    it(`e=${e}: interpolant error is of the order of the step's own local error`, () => {
      const rtol = 1e-10;
      const { y0, period } = periapsis(e);
      let evals = 0;
      const f = (t: number, y: Float64Array, out: Float64Array) => {
        evals++;
        kepler(t, y, out);
      };
      const integ = new Dop853(6, f, magScale(rtol));
      integ.reset(0, y0);
      const ref = new Dop853(6, kepler, magScale(1e-15));
      const out = new Float64Array(6);
      const SAMPLES = 16;
      let worstRatio = 0;
      let worstInterp = 0;
      let worstLocal = 0;
      let steps = 0;
      while (integ.t < period) {
        const before = evals;
        integ.step(period);
        expect(evals - before).toBeGreaterThanOrEqual(12); // no dense stages yet
        steps++;
        const t0 = integ.tPrevious;
        const t1 = integ.t;
        // Independent reference started from this step's own initial state, so only
        // this step's (local) error is measured.
        ref.reset(t0, integ['yOld']);
        let stepInterp = 0;
        for (let k = 1; k < SAMPLES; k++) {
          const t = t0 + ((t1 - t0) * k) / SAMPLES;
          const pre = evals;
          integ.interpolate(t, out);
          // Three extra stages, only on the first interpolation of the step.
          expect(evals - pre).toBe(k === 1 ? 3 : 0);
          ref.integrateTo(t);
          stepInterp = Math.max(stepInterp, posErr(out, ref.y));
        }
        ref.integrateTo(t1);
        const local = posErr(integ.y, ref.y);
        // Floor at the tolerance the step was asked to meet, so tiny-local-error
        // steps don't produce meaningless ratios.
        const tolScale = rtol * Math.hypot(integ.y[0], integ.y[1], integ.y[2]);
        worstRatio = Math.max(worstRatio, stepInterp / Math.max(local, tolScale));
        worstInterp = Math.max(worstInterp, stepInterp / tolScale);
        worstLocal = Math.max(worstLocal, local / tolScale);
      }
      console.log(
        `e=${e}: ${steps} steps, max interp err / max(local err, rtol*r) = ${worstRatio.toFixed(2)}, ` +
          `max interp err = ${worstInterp.toFixed(3)} rtol*r, max local err = ${worstLocal.toFixed(3)} rtol*r`,
      );
      // The interpolant is 7th order against the step's 8th, so inside a step it is
      // expected to be worse than the endpoint. SciPy's DOP853 dense output on the same
      // problem gives max interp err 6.5 / 16 / 9.0 / 4.2 rtol*r for e = 0 / 0.3 / 0.7 / 0.95.
      expect(worstInterp).toBeLessThan(50);
      expect(worstRatio).toBeLessThan(50);
    });
  }

  it('interpolant local error converges at 8th order in h (7th-order interpolant)', () => {
    const { y0, period } = periapsis(0.3);
    const ref = new Dop853(6, kepler, magScale(1e-15));
    const out = new Float64Array(6);
    const errAt = (h: number) => {
      const integ = new Dop853(6, kepler, magScale(1e-10));
      integ.reset(0, y0);
      integ.stepFixed(h);
      const t = h * 0.37;
      integ.interpolate(t, out);
      ref.reset(0, y0);
      ref.integrateTo(t);
      return posErr(out, ref.y);
    };
    const h = period / 12;
    const order = Math.log2(errAt(h) / errAt(h / 2));
    console.log(`dense output local order ${order.toFixed(2)}`);
    expect(order).toBeGreaterThan(7.5);
    expect(order).toBeLessThan(9.5);
  });

  it('reproduces step endpoints and is continuous at them', () => {
    const { y0, period } = periapsis(0.7);
    const integ = new Dop853(6, kepler, componentwiseScale(1e-11, 1e-3));
    integ.reset(0, y0);
    const out = new Float64Array(6);
    let prevEnd = Float64Array.from(y0);
    for (let i = 0; i < 30; i++) {
      integ.step(period);
      const t0 = integ.tPrevious;
      const t1 = integ.t;
      integ.interpolate(t0, out);
      expect(Array.from(out)).toEqual(Array.from(prevEnd));
      integ.interpolate(t1, out);
      expect(Array.from(out)).toEqual(Array.from(integ.y));
      // Just inside the endpoints the polynomial itself must agree to rounding.
      // Just inside the endpoints the polynomial must match y -/+ eps * v to rounding.
      const eps = (t1 - t0) * 1e-7;
      integ.interpolate(t1 - eps, out);
      const lin1 = [0, 1, 2].map((j) => integ.y[j] - eps * integ.y[3 + j]);
      expect(posErr(out, lin1)).toBeLessThan(1e-6);
      integ.interpolate(t0 + eps, out);
      const lin0 = [0, 1, 2].map((j) => prevEnd[j] + eps * prevEnd[3 + j]);
      expect(posErr(out, lin0)).toBeLessThan(1e-6);
      prevEnd = Float64Array.from(integ.y);
    }
    expect(() => integ.interpolate(integ.t + 1, out)).toThrow(/outside/);
    integ.refresh();
    expect(() => integ.interpolate(integ.t, out)).toThrow(/outside/);
  });
});
