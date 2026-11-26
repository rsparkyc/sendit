/**
 * Solar-system bodies and an `Ephemeris` backed by the N-body integrator.
 *
 * The body list is data-driven (src/physics/data/solar-system-j2000.json,
 * produced by scripts/fetch-horizons.py). Adding moons later means adding rows.
 *
 * DETERMINISM: only + - * /, Math.sqrt, and Math.floor (exact, used only to
 * find the sample interval) in here.
 */
import data from './data/solar-system-j2000.json';
import type { Ephemeris } from './spacecraft';
import { NBodyIntegrator } from './nbody';

export interface BodyData {
  readonly id: string;
  readonly name: string;
  /** GM, m^3/s^2. */
  readonly gm: number;
  /** Mean radius, m. */
  readonly radius: number;
  /** Barycentric ICRF [x,y,z,vx,vy,vz] at J2000 TDB, m and m/s. */
  readonly state: readonly number[];
}

export const J2000_BODIES: readonly BodyData[] = data.bodies;
export const DAY = 86400;
export const JULIAN_YEAR = 365.25 * DAY;

/**
 * Default step: 0.5 day. From the step-halving study in
 * test/nbody-solar-system.test.ts: halving it moves the Moon by ~2 m and every
 * planet by < 4 cm after 50 years, ~5 orders of magnitude below the error from
 * missing physics (GR, Earth J2). The scheme is still in its h^8 regime at 2 d,
 * so this leaves a 4x margin. Adding fast moons (Phobos: 7.7 h) will need a
 * smaller step or a multirate scheme.
 */
export const DEFAULT_STEP = 0.5 * DAY;

export function bodyIndex(id: string, bodies: readonly BodyData[] = J2000_BODIES): number {
  const i = bodies.findIndex((b) => b.id === id);
  if (i < 0) throw new Error(`unknown body ${id}`);
  return i;
}

export function initialState(bodies: readonly BodyData[] = J2000_BODIES): Float64Array {
  const s = new Float64Array(6 * bodies.length);
  bodies.forEach((b, i) => s.set(b.state, 6 * i));
  return s;
}

/**
 * Ephemeris that integrates on demand, forward and backward from the epoch, and
 * stores position, velocity and acceleration of every body at every step.
 * Between samples it uses quintic Hermite interpolation (exact to O(h^6)).
 *
 * Measured accuracy at the default 0.5 d step (test/nbody-ephemeris.test.ts):
 * interpolated Moon position within ~1e-2 m of a direct integration to the same time;
 * see the test for the bound. Memory is 72*n bytes per step (n bodies); a century
 * would be ~116 MB for 11 bodies, so this is for smoke tests, not production —
 * the production path is a Chebyshev fit.
 */
export class IntegratedEphemeris implements Ephemeris {
  readonly count: number;
  readonly gm: Float64Array;
  readonly h: number;
  readonly t0: number;
  private readonly fwd: NBodyIntegrator;
  private readonly bwd: NBodyIntegrator;
  /** fwdSamples[k] is the sample at t0 + k*h; bwdSamples[k] at t0 - k*h. Layout: q(3n) v(3n) a(3n). */
  private readonly fwdSamples: Float64Array[] = [];
  private readonly bwdSamples: Float64Array[] = [];

  constructor(bodies: readonly BodyData[] = J2000_BODIES, h: number = DEFAULT_STEP, t0 = 0) {
    this.count = bodies.length;
    this.gm = Float64Array.from(bodies.map((b) => b.gm));
    this.h = h;
    this.t0 = t0;
    const s = initialState(bodies);
    this.fwd = new NBodyIntegrator(this.gm, s, t0, h);
    this.bwd = new NBodyIntegrator(this.gm, s, t0, -h);
    const first = this.snapshot(this.fwd);
    this.fwdSamples.push(first);
    this.bwdSamples.push(first);
  }

  private snapshot(it: NBodyIntegrator): Float64Array {
    const m = 3 * this.count;
    const out = new Float64Array(3 * m);
    out.set(it.q, 0);
    out.set(it.v, m);
    out.set(it.acc, 2 * m);
    return out;
  }

  /** Sample k steps from the epoch (k may be negative), integrating as needed. */
  private sample(k: number): Float64Array {
    if (k >= 0) {
      while (this.fwdSamples.length <= k) {
        this.fwd.step();
        this.fwdSamples.push(this.snapshot(this.fwd));
      }
      return this.fwdSamples[k];
    }
    const j = -k;
    while (this.bwdSamples.length <= j) {
      this.bwd.step();
      this.bwdSamples.push(this.snapshot(this.bwd));
    }
    return this.bwdSamples[j];
  }

  /** Evaluate positions (and optionally velocities) of all bodies at t. */
  evaluate(t: number, pos: Float64Array | null, vel: Float64Array | null): void {
    const x = (t - this.t0) / this.h;
    const k = Math.floor(x);
    const s = x - k;
    const p0 = this.sample(k);
    const p1 = this.sample(k + 1);
    const dt = this.h;
    const m = 3 * this.count;
    const s2 = s * s;
    const s3 = s2 * s;
    const s4 = s3 * s;
    const s5 = s4 * s;
    if (pos !== null) {
      const h0 = 1 - 10 * s3 + 15 * s4 - 6 * s5;
      const h1 = (s - 6 * s3 + 8 * s4 - 3 * s5) * dt;
      const h2 = (0.5 * s2 - 1.5 * s3 + 1.5 * s4 - 0.5 * s5) * dt * dt;
      const h3 = (0.5 * s3 - s4 + 0.5 * s5) * dt * dt;
      const h4 = (-4 * s3 + 7 * s4 - 3 * s5) * dt;
      const h5 = 10 * s3 - 15 * s4 + 6 * s5;
      for (let i = 0; i < m; i++) {
        pos[i] = h0 * p0[i] + h5 * p1[i] + h1 * p0[m + i] + h4 * p1[m + i] + h2 * p0[2 * m + i] + h3 * p1[2 * m + i];
      }
    }
    if (vel !== null) {
      const d0 = (-30 * s2 + 60 * s3 - 30 * s4) / dt;
      const d1 = 1 - 18 * s2 + 32 * s3 - 15 * s4;
      const d2 = (s - 4.5 * s2 + 6 * s3 - 2.5 * s4) * dt;
      const d3 = (1.5 * s2 - 4 * s3 + 2.5 * s4) * dt;
      const d4 = -12 * s2 + 28 * s3 - 15 * s4;
      const d5 = (30 * s2 - 60 * s3 + 30 * s4) / dt;
      for (let i = 0; i < m; i++) {
        vel[i] = d0 * p0[i] + d5 * p1[i] + d1 * p0[m + i] + d4 * p1[m + i] + d2 * p0[2 * m + i] + d3 * p1[2 * m + i];
      }
    }
  }

  positions(t: number, out: Float64Array): void {
    this.evaluate(t, out, null);
  }

  private readonly tmpP = new Float64Array(3 * 64);
  private readonly tmpV = new Float64Array(3 * 64);
  bodyState(body: number, t: number, out: Float64Array): void {
    const p = this.tmpP.length >= 3 * this.count ? this.tmpP : new Float64Array(3 * this.count);
    const v = this.tmpV.length >= 3 * this.count ? this.tmpV : new Float64Array(3 * this.count);
    this.evaluate(t, p, v);
    for (let k = 0; k < 3; k++) {
      out[k] = p[3 * body + k];
      out[3 + k] = v[3 * body + k];
    }
  }
}
