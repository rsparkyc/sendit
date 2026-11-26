/**
 * Reference data for Chebyshev ephemeris tests: the integrator's grid samples,
 * and its own output at off-grid ("held-out") times, obtained by one extra
 * Kahan-Li step of fractional size from the preceding grid state. That step's
 * local error is O(h^9), far below a micrometre, so it is the integrator's
 * output at that time, not an interpolation.
 */
import { KAHAN_LI_8, NBodyIntegrator } from '../../src/physics/nbody';
import { DEFAULT_STEP, J2000_BODIES, initialState, solarSystemPhysics } from '../../src/physics/solar-system';

const PHYSICS = solarSystemPhysics();

export interface GridRun {
  n: number;
  gm: Float64Array;
  h: number;
  steps: number;
  /** Ascending in time from tStart; per step q(3n) v(3n) a(3n). */
  samples: Float64Array;
  tStart: number;
}

/** Integrate `steps` steps from the epoch in direction dir, samples ascending in time. */
export function gridRun(steps: number, dir: 1 | -1 = 1, h = DEFAULT_STEP): GridRun {
  const gm = Float64Array.from(J2000_BODIES.map((b) => b.gm));
  const n = gm.length;
  const m = 3 * n;
  const it = new NBodyIntegrator(gm, initialState(), 0, dir * h, KAHAN_LI_8, PHYSICS);
  const samples = new Float64Array((steps + 1) * 3 * m);
  const put = (j: number) => {
    const o = j * 3 * m;
    samples.set(it.q, o);
    samples.set(it.v, o + m);
    it.totalAcceleration(samples.subarray(o + 2 * m, o + 3 * m));
  };
  put(dir > 0 ? 0 : steps);
  for (let i = 1; i <= steps; i++) {
    it.step();
    put(dir > 0 ? i : steps - i);
  }
  return { n, gm, h, steps, samples, tStart: dir > 0 ? 0 : -steps * h };
}

/** Integrator positions and velocities at tStart + (j + frac)*h, 0 <= frac < 1. */
export function offGrid(run: GridRun, j: number, frac: number, pos: Float64Array, vel: Float64Array): void {
  const { n, gm, h, samples } = run;
  const m = 3 * n;
  const o = j * 3 * m;
  const state = new Float64Array(6 * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      state[6 * i + k] = samples[o + 3 * i + k];
      state[6 * i + 3 + k] = samples[o + m + 3 * i + k];
    }
  }
  // The force is time-dependent (the poles move): start the step at its true time.
  const it = new NBodyIntegrator(gm, state, run.tStart + j * h, frac * h, KAHAN_LI_8, PHYSICS);
  it.step();
  pos.set(it.q);
  vel.set(it.v);
}
