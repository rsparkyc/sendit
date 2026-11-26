/**
 * The app's single adapter to src/physics. Nothing else in src/app imports from
 * the physics modules, so API additions (new bodies, integrator changes) are
 * absorbed here. Body count and order always come from the data.
 *
 * Used on both threads: the worker builds chunks and propagates spacecraft; the
 * main thread installs transferred chunks and evaluates them, and never builds.
 */
import { ChebyshevEphemeris } from '../physics/chebyshev-ephemeris';
import { J2000_BODIES } from '../physics/solar-system';
import { propagate, type Burn, type BurnFrame } from '../physics/spacecraft';

export interface BodyInfo {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  /** m^3/s^2 */
  readonly gm: number;
  /** Mean radius, m. */
  readonly radius: number;
  /** Barycentric ICRF state at J2000, m and m/s (for deriving parents and periods). */
  readonly state0: readonly number[];
}

export const BODIES: readonly BodyInfo[] = J2000_BODIES.map((b, index) => ({
  index,
  id: b.id,
  name: b.name,
  gm: b.gm,
  radius: b.radius,
  state0: b.state,
}));

export const BODY_GM: Float64Array = Float64Array.from(BODIES.map((b) => b.gm));

export function bodyIndex(id: string): number {
  return BODIES.findIndex((b) => b.id === id);
}

/**
 * Ephemeris wrapper that knows which chunks it holds. Covered chunks are always
 * a contiguous range [lo, hi] containing chunk 0 (or empty: lo = 0, hi = -1),
 * because chunks are built and installed outward from the epoch.
 */
export class Ephemeris {
  private readonly eph = new ChebyshevEphemeris(J2000_BODIES);
  readonly count = this.eph.count;
  readonly chunkSpan = this.eph.layout.chunkSpan;
  readonly t0 = this.eph.t0;
  /** Float64 elements per chunk; must match on both threads. */
  readonly chunkLength = this.eph.layout.chunkLength;
  lo = 0;
  hi = -1;

  chunkIndex(t: number): number {
    return this.eph.chunkIndex(t);
  }

  /** Start time of chunk k. */
  chunkStart(k: number): number {
    return this.t0 + k * this.chunkSpan;
  }

  has(k: number): boolean {
    return k >= this.lo && k <= this.hi;
  }

  /** True if t can be evaluated without building anything. */
  covers(t: number): boolean {
    return this.has(this.chunkIndex(t));
  }

  /** Covered time span [ta, tb). Empty if ta >= tb. */
  span(): [number, number] {
    return [this.chunkStart(this.lo), this.chunkStart(this.hi + 1)];
  }

  /** Install a chunk built elsewhere. Must be the next one outward (hi+1 or lo-1). */
  install(k: number, coeffs: Float64Array): void {
    this.eph.addChunk(k, coeffs);
    this.track(k);
  }

  private track(k: number): void {
    if (this.lo > this.hi) {
      this.lo = this.hi = k;
    } else if (k === this.hi + 1) this.hi = k;
    else if (k === this.lo - 1) this.lo = k;
  }

  /**
   * Build chunk k (worker only; synchronous). k must be the next chunk outward.
   * Returns a copy of the coefficients suitable for transfer.
   */
  build(k: number): Float64Array {
    if (this.has(k)) return this.eph.getChunk(k)!.slice();
    if (!(k === this.hi + 1 || k === this.lo - 1 || (this.lo > this.hi && (k === 0 || k === -1)))) {
      throw new Error(`chunk ${k} is not next to the covered range [${this.lo}, ${this.hi}]`);
    }
    const t = this.chunkStart(k);
    this.eph.ensure(t, t);
    this.track(k);
    return this.eph.getChunk(k)!.slice();
  }

  /** Coefficients of an installed chunk (shared; do not mutate). */
  chunk(k: number): Float64Array | undefined {
    return this.has(k) ? this.eph.getChunk(k) : undefined;
  }

  /**
   * Positions (and velocities) of all bodies at t, ICRF barycentric, m and m/s.
   * Returns false, writing nothing, if t is not covered: never builds.
   */
  evaluate(t: number, pos: Float64Array, vel: Float64Array | null): boolean {
    if (!this.covers(t)) return false;
    this.eph.evaluate(t, pos, vel);
    return true;
  }

  /** The physics Ephemeris for propagation (worker only: may build chunks on demand). */
  get physics(): ChebyshevEphemeris {
    return this.eph;
  }

  /** After propagation may have extended the underlying ephemeris, resync the covered range. */
  resync(): void {
    if (this.lo > this.hi) {
      if (this.eph.hasChunk(0)) this.lo = this.hi = 0;
      else if (this.eph.hasChunk(-1)) this.lo = this.hi = -1;
      else return;
    }
    while (this.eph.hasChunk(this.hi + 1)) this.hi++;
    while (this.eph.hasChunk(this.lo - 1)) this.lo--;
  }
}

export interface ThrustBurn {
  tStart: number;
  duration: number;
  thrust: number;
  isp: number;
  /** (prograde, normal, radial-out) relative to `body`, held for the whole burn. */
  direction: readonly [number, number, number];
  body: number;
}

export interface DenseSample {
  t: number;
  /** x y z vx vy vz mass */
  y: Float64Array;
}

/**
 * Propagate a spacecraft with the real ephemeris, calling `sample` with dense
 * output at `perStep` evenly spaced times inside every accepted step (plus the
 * initial state). Returns the final state.
 */
export function propagateDense(
  eph: Ephemeris,
  y0: ArrayLike<number>,
  t0: number,
  t1: number,
  burns: readonly ThrustBurn[],
  perStep: number,
  sample: (t: number, y: Float64Array) => void,
  dryMass = 0,
): { t: number; y: Float64Array; steps: number } {
  const physBurns: Burn[] = burns.map((b) => ({
    tStart: b.tStart,
    duration: b.duration,
    thrust: b.thrust,
    isp: b.isp,
    direction: b.direction,
    frame: { kind: 'orbital', body: b.body } satisfies BurnFrame,
  }));
  const tmp = new Float64Array(7);
  sample(t0, Float64Array.from(y0));
  const r = propagate(eph.physics, y0, t0, t1, physBurns, {
    dryMass,
    onStep: (t, y, interpolate, tPrev) => {
      for (let i = 1; i < perStep; i++) {
        const ti = tPrev + ((t - tPrev) * i) / perStep;
        interpolate(ti, tmp);
        sample(ti, tmp);
      }
      sample(t, y);
    },
  });
  eph.resync();
  return { t: r.t, y: r.y, steps: r.accepted };
}
