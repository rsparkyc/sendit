/**
 * The app's single adapter to src/physics. Nothing else in src/app imports from
 * the physics modules, so API additions (new bodies, integrator changes) are
 * absorbed here. Body count and order always come from the data.
 *
 * Used on both threads: the worker builds chunks and propagates spacecraft; the
 * main thread installs transferred chunks and evaluates them, and never builds.
 */
import { ChebyshevEphemeris } from '../physics/chebyshev-ephemeris';
import { CHECKPOINT_ASSET_URL, installCheckpointAsset } from '../physics/checkpoint-asset';
import { J2000_BODIES, type BodyData } from '../physics/solar-system';

export interface BodyInfo {
  readonly index: number;
  readonly id: string;
  /** Display name from the data (e.g. "Mars", not "Mars system barycenter"). */
  readonly name: string;
  /** Id of the planet a moon belongs to, from the data's `parent` field. */
  readonly parentId: string | null;
  /** m^3/s^2 */
  readonly gm: number;
  /** Mean radius, m. */
  readonly radius: number;
  /** Barycentric ICRF state at J2000, m and m/s (for deriving parents and periods). */
  readonly state0: readonly number[];
  /** Spin-axis unit vector (ICRF), if the data has one. */
  readonly pole: readonly number[] | null;
}

export const BODIES: readonly BodyInfo[] = J2000_BODIES.map((b, index) => ({
  index,
  id: b.id,
  name: b.displayName ?? b.name,
  parentId: b.parent ?? null,
  gm: b.gm,
  radius: b.radius,
  state0: b.state,
  pole: b.pole ?? null,
}));

export const BODY_GM: Float64Array = Float64Array.from(BODIES.map((b) => b.gm));

export function bodyIndex(id: string): number {
  return BODIES.findIndex((b) => b.id === id);
}

/**
 * Ephemeris wrapper that knows which chunks it holds. [lo, hi] is the
 * contiguous range around the epoch that the background worker builds outward;
 * the main thread may also install chunks elsewhere (built by the replay
 * worker from the checkpoint asset for a flight's span), so `has`/`covers`
 * look at the chunks actually present.
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
    return this.eph.hasChunk(k);
  }

  /** True if t can be evaluated without building anything. */
  covers(t: number): boolean {
    return this.has(this.chunkIndex(t));
  }

  /** Covered time span [ta, tb). Empty if ta >= tb. */
  span(): [number, number] {
    return [this.chunkStart(this.lo), this.chunkStart(this.hi + 1)];
  }

  /** Install a chunk built elsewhere (any order; ignored if already present). Returns true if new. */
  install(k: number, coeffs: Float64Array): boolean {
    if (this.eph.hasChunk(k)) return false;
    this.eph.addChunk(k, coeffs);
    this.resync();
    return true;
  }

  /** Indices of every installed chunk. */
  chunks(): number[] {
    return this.eph.builtChunks();
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
    if (this.eph.hasChunk(k)) return this.eph.getChunk(k)!.slice();
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
    return this.eph.getChunk(k);
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

/** Physics body data, for the mission adapter's world (launch starts need it). Opaque to the rest of the app. */
export const BODY_DATA: readonly BodyData[] = J2000_BODIES;
export type { BodyData };

/**
 * Ephemeris used by the replay worker: the real ChebyshevEphemeris with the
 * shipped checkpoint asset installed, so any chunk between 1950 and 2100 is
 * built directly from its nearest checkpoint (a flight's span is available in
 * a few chunk builds, not by integrating outward from J2000). Chunks are
 * bit-identical either way, so replay results do not depend on who built them.
 */
export class ReplayEphemeris {
  readonly physics = new ChebyshevEphemeris(J2000_BODIES);
  readonly chunkLength = this.physics.layout.chunkLength;

  /** Fetch and install the checkpoint asset. Without it chunks are still correct, only slower to build. */
  async loadCheckpoints(): Promise<void> {
    const res = await fetch(CHECKPOINT_ASSET_URL);
    if (!res.ok) throw new Error(`checkpoint asset: HTTP ${res.status}`);
    installCheckpointAsset(this.physics, J2000_BODIES, new Uint8Array(await res.arrayBuffer()));
  }

  /** Install checkpoints from bytes (tests, Node). */
  installCheckpoints(bytes: Uint8Array): void {
    installCheckpointAsset(this.physics, J2000_BODIES, bytes);
  }

  chunkIndex(t: number): number {
    return this.physics.chunkIndex(t);
  }

  has(k: number): boolean {
    return this.physics.hasChunk(k);
  }

  add(k: number, coeffs: Float64Array): void {
    if (!this.physics.hasChunk(k)) this.physics.addChunk(k, coeffs);
  }

  /** Build every chunk covering [ta, tb]; returns the indices that were newly built. */
  ensure(ta: number, tb: number): number[] {
    const before = new Set(this.physics.builtChunks());
    this.physics.ensure(ta, tb);
    return this.physics.builtChunks().filter((k) => !before.has(k));
  }

  /** Copy of chunk k for transfer. */
  copy(k: number): Float64Array | undefined {
    return this.physics.getChunk(k)?.slice();
  }
}
