/**
 * Production ephemeris: piecewise Chebyshev polynomials fitted to the N-body
 * integrator's output (the representation of JPL's DE files and Principia's
 * continuous trajectories).
 *
 * REPRESENTATION
 *  - Time is split into CHUNKS of `chunkSteps` integrator steps (default 2048
 *    steps of 0.5 d = 1024 d), numbered by a signed index k: chunk k covers
 *    [t0 + k*C, t0 + (k+1)*C). Chunks k >= 0 come from forward integration from
 *    the epoch, chunks k < 0 from backward integration.
 *  - Inside a chunk each body has its own segment length L_b (a power-of-two
 *    number of steps dividing the chunk) and degree n_b. Each segment stores
 *    3*(n_b+1) coefficients of x(t), y(t), z(t) in the Chebyshev basis on
 *    [segStart, segStart + L_b], interleaved as c0x c0y c0z c1x c1y c1z ...
 *    Velocity is the derivative of the position polynomial.
 *  - A chunk is ONE Float64Array holding every body's segments back to back;
 *    the offsets are a pure function of the layout, so nothing but the numbers
 *    needs storing or transferring (see `ChebyshevLayout`).
 *
 * FIT
 *  Least squares on the integrator's own grid: at every `stride`-th step inside
 *  the segment (including both ends) the fit matches position, velocity*(L/2)
 *  and acceleration*(L/2)^2 (all in metres after that scaling) with equal
 *  weight. The sample abscissae are x_j = 2j/M - 1, exact rationals, so no
 *  cosine is ever needed: Chebyshev *nodes* are not required for a well-
 *  conditioned fit when the problem is oversampled 3x by derivative data and
 *  solved by Householder QR (only + - * / sqrt). The design matrix depends only
 *  on (M, degree), so its pseudo-inverse is computed once per configuration and
 *  every segment fit is a fixed-order matrix-vector product: cheap and
 *  bit-reproducible.
 *
 * DETERMINISM: only + - * /, Math.sqrt, Math.floor, Math.abs, comparisons.
 * ECMAScript forbids fused multiply-add contraction, so each expression rounds
 * identically in every engine. Coefficients depend only on (bodies, h, t0,
 * layout) and the chunk index, never on build order, because each chunk is fit
 * from the integrator states of its own steps, and those states are always
 * produced by the same unbroken integration from the epoch (resumed, if at all,
 * from a full-precision checkpoint including the Kahan compensation terms).
 *
 * BOUNDARIES: intervals are half-open. A time exactly at a chunk or segment
 * boundary belongs to the later one; the chunk is floor((t - t0)/C) and the
 * segment floor((t - chunkStart)/L), clamped into the chunk.
 */
import { KAHAN_LI_8, NBodyIntegrator, type NBodyPhysics } from './nbody';
import type { BodyOblateness, Ephemeris } from './spacecraft';
import { DEFAULT_STEP, J2000_BODIES, initialState, oblatenessOf, solarSystemPhysics, type BodyData } from './solar-system';

/** Per-body fit: segment length in integrator steps, and polynomial degree. */
export interface BodyFit {
  readonly segSteps: number;
  readonly degree: number;
}

export const DEFAULT_CHUNK_STEPS = 2048;

/**
 * Tuned by test/chebyshev-tune.test.ts (run with TUNE=1) at h = 0.5 d: among
 * segment lengths of 2^p steps and degrees 5..12, the fit with the fewest
 * coefficients per unit time whose maximum position error against the
 * integrator, at held-out mid-step times over 11 years, is below TUNE_TARGET.
 *
 * The degree cap trades storage for speed. Evaluation evaluates one segment per
 * body, so its cost is proportional to sum(degree+1); storage to
 * sum((degree+1)/length). Measured (same tuner): cap 12 -> sum 117, 9.8 MB per
 * century; cap 16 -> 140, 7.9 MB; cap 20 -> 183, 6.4 MB. Evaluation is the hot
 * path and 10 MB per century is small, so cap 12.
 * Comment: segment length, tuned max error.
 */
export const DEFAULT_FITS: Readonly<Record<string, BodyFit>> = {
  sun: { segSteps: 32, degree: 9 }, // 16 d, 2.0 mm
  mercury: { segSteps: 8, degree: 11 }, // 4 d, 0.2 mm
  venus: { segSteps: 32, degree: 10 }, // 16 d, 1.9 mm
  earth: { segSteps: 8, degree: 10 }, // 4 d, 2.7 mm
  moon: { segSteps: 8, degree: 12 }, // 4 d, 0.9 mm
  mars: { segSteps: 64, degree: 11 }, // 32 d, 1.7 mm
  jupiter: { segSteps: 128, degree: 10 }, // 64 d, 2.9 mm
  saturn: { segSteps: 128, degree: 7 }, // 64 d, 2.8 mm
  uranus: { segSteps: 256, degree: 8 }, // 128 d, 2.1 mm
  neptune: { segSteps: 512, degree: 11 }, // 256 d, 2.2 mm
  pluto: { segSteps: 256, degree: 7 }, // 128 d, 2.9 mm (float64 floor is ~2 mm at 30-50 AU)
};
/** Conservative fallback for bodies not yet tuned (e.g. new moons): 4 d at the default step. Retune when adding bodies. */
export const FALLBACK_FIT: BodyFit = { segSteps: 8, degree: 12 };

/** Error goal for tuning; the tests accept 1 cm. */
export const TUNE_TARGET = 3e-3;

/**
 * Number of grid intervals the fit samples in a segment: every step. (Sparser
 * sampling was tried; the error then plateaus at the sampling limit rather than
 * falling with degree, and the fit is cheap anyway.)
 */
export function sampleIntervals(fit: BodyFit): number {
  return fit.segSteps;
}

// ---------------------------------------------------------------------------
// Fit basis: pseudo-inverse of the (pos, vel, acc) Chebyshev design matrix.

/** pinv is (degree+1) x rows, row-major; rows = 3*(M+1). */
interface FitBasis {
  readonly m: number;
  readonly cols: number;
  readonly rows: number;
  readonly pinv: Float64Array;
}

const basisCache = new Map<string, FitBasis>();

function fitBasis(m: number, degree: number): FitBasis {
  const key = `${m}/${degree}`;
  const hit = basisCache.get(key);
  if (hit !== undefined) return hit;
  const cols = degree + 1;
  const rows = 3 * (m + 1);
  if (rows < cols) throw new Error(`fit ${key}: underdetermined`);
  // Design matrix, row-major rows x cols.
  const a = new Float64Array(rows * cols);
  for (let j = 0; j <= m; j++) {
    const x = (2 * j) / m - 1;
    // T, T', T'' by recurrence.
    let t0 = 1;
    let t1 = x;
    let d0 = 0;
    let d1 = 1;
    let e0 = 0;
    let e1 = 0;
    for (let k = 0; k < cols; k++) {
      let t: number;
      let d: number;
      let e: number;
      if (k === 0) {
        t = 1;
        d = 0;
        e = 0;
      } else if (k === 1) {
        t = x;
        d = 1;
        e = 0;
      } else {
        t = 2 * x * t1 - t0;
        d = 2 * t1 + 2 * x * d1 - d0;
        e = 4 * d1 + 2 * x * e1 - e0;
        t0 = t1;
        t1 = t;
        d0 = d1;
        d1 = d;
        e0 = e1;
        e1 = e;
      }
      a[(3 * j) * cols + k] = t;
      a[(3 * j + 1) * cols + k] = d;
      a[(3 * j + 2) * cols + k] = e;
    }
  }
  // Householder QR, in place. a becomes R above the diagonal and the
  // Householder vectors below; vlead holds each vector's leading element.
  const vlead = new Float64Array(cols);
  const diag = new Float64Array(cols);
  for (let k = 0; k < cols; k++) {
    let s = 0;
    for (let i = k; i < rows; i++) s += a[i * cols + k] * a[i * cols + k];
    const norm = Math.sqrt(s);
    if (norm === 0) throw new Error(`fit ${key}: rank deficient`);
    const akk = a[k * cols + k];
    const alpha = akk > 0 ? -norm : norm;
    const v0 = akk - alpha;
    vlead[k] = v0;
    diag[k] = alpha;
    // v = (v0, a[k+1..rows-1, k])
    let vtv = v0 * v0;
    for (let i = k + 1; i < rows; i++) vtv += a[i * cols + k] * a[i * cols + k];
    for (let c = k + 1; c < cols; c++) {
      let dot = v0 * a[k * cols + c];
      for (let i = k + 1; i < rows; i++) dot += a[i * cols + k] * a[i * cols + c];
      const f = (2 * dot) / vtv;
      a[k * cols + c] -= f * v0;
      for (let i = k + 1; i < rows; i++) a[i * cols + c] -= f * a[i * cols + k];
    }
    a[k * cols + k] = vtv; // stash v^T v
  }
  // pinv column r = R^-1 (Q^T e_r)[0..cols-1].
  const pinv = new Float64Array(cols * rows);
  const y = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < rows; i++) y[i] = 0;
    y[r] = 1;
    for (let k = 0; k < cols; k++) {
      const vtv = a[k * cols + k];
      let dot = vlead[k] * y[k];
      for (let i = k + 1; i < rows; i++) dot += a[i * cols + k] * y[i];
      const f = (2 * dot) / vtv;
      y[k] -= f * vlead[k];
      for (let i = k + 1; i < rows; i++) y[i] -= f * a[i * cols + k];
    }
    for (let k = cols - 1; k >= 0; k--) {
      let s = y[k];
      for (let c = k + 1; c < cols; c++) s -= a[k * cols + c] * y[c];
      y[k] = s / diag[k];
    }
    for (let k = 0; k < cols; k++) pinv[k * rows + r] = y[k];
  }
  const basis = { m, cols, rows, pinv };
  basisCache.set(key, basis);
  return basis;
}

// ---------------------------------------------------------------------------
// Layout

/**
 * Everything needed to interpret a chunk's Float64Array. Pure data, derived
 * deterministically from (fits, h, chunkSteps), so worker and main thread
 * build identical layouts and only the coefficient buffer crosses threads.
 */
export class ChebyshevLayout {
  readonly count: number;
  readonly h: number;
  readonly chunkSteps: number;
  /** Chunk duration, s. */
  readonly chunkSpan: number;
  readonly fits: readonly BodyFit[];
  /** Per body: segment length s, segments per chunk, start offset in chunk, 3*(degree+1). */
  readonly segLen: Float64Array;
  readonly twoOverLen: Float64Array;
  readonly segCount: Int32Array;
  readonly offset: Int32Array;
  readonly stride3: Int32Array;
  readonly degree: Int32Array;
  /** Float64 elements per chunk. */
  readonly chunkLength: number;

  constructor(fits: readonly BodyFit[], h: number = DEFAULT_STEP, chunkSteps = DEFAULT_CHUNK_STEPS) {
    const n = fits.length;
    this.count = n;
    this.h = h;
    this.chunkSteps = chunkSteps;
    this.chunkSpan = chunkSteps * h;
    this.fits = fits.map((f) => ({ ...f }));
    this.segLen = new Float64Array(n);
    this.twoOverLen = new Float64Array(n);
    this.segCount = new Int32Array(n);
    this.offset = new Int32Array(n);
    this.stride3 = new Int32Array(n);
    this.degree = new Int32Array(n);
    let off = 0;
    for (let i = 0; i < n; i++) {
      const f = fits[i];
      if (!(f.segSteps >= 1) || chunkSteps % f.segSteps !== 0) throw new Error(`body ${i}: segSteps must divide chunkSteps`);
      if (3 * (sampleIntervals(f) + 1) < 2 * (f.degree + 1)) throw new Error(`body ${i}: degree too high for segment (need 3 samples per 2 coefficients)`);
      this.segLen[i] = f.segSteps * h;
      this.twoOverLen[i] = 2 / (f.segSteps * h);
      this.segCount[i] = chunkSteps / f.segSteps;
      this.degree[i] = f.degree;
      this.stride3[i] = 3 * (f.degree + 1);
      this.offset[i] = off;
      off += this.segCount[i] * this.stride3[i];
    }
    this.chunkLength = off;
  }

  static forBodies(bodies: readonly BodyData[], h: number = DEFAULT_STEP, chunkSteps = DEFAULT_CHUNK_STEPS): ChebyshevLayout {
    // DEFAULT_FITS are in steps of DEFAULT_STEP; rescale for other steps.
    const r = DEFAULT_STEP / h;
    const fits = bodies.map((b) => {
      const f = DEFAULT_FITS[b.id] ?? FALLBACK_FIT;
      const segSteps = Math.max(1, Math.round(f.segSteps * r));
      return { segSteps, degree: f.degree };
    });
    return new ChebyshevLayout(fits, h, chunkSteps);
  }

  /** Bytes per Julian century. */
  bytesPerCentury(): { total: number; perBody: number[] } {
    const century = 36525 * 86400;
    const perBody: number[] = [];
    let total = 0;
    for (let i = 0; i < this.count; i++) {
      const b = (century / this.segLen[i]) * this.stride3[i] * 8;
      perBody.push(b);
      total += b;
    }
    return { total, perBody };
  }
}

// ---------------------------------------------------------------------------
// Checkpoints and chunk building

/**
 * Full-precision integrator state at a chunk boundary: q, v and their Kahan
 * compensation terms (4 * 3n float64). Boundary b is at t0 + b*C; b > 0 comes
 * from forward integration, b < 0 from backward, b = 0 is the initial state.
 * Transferable as `data.buffer`.
 */
export interface Checkpoint {
  readonly boundary: number;
  readonly data: Float64Array;
}

/** Narrow view of NBodyIntegrator internals needed for exact resume. */
interface IntegratorInternals {
  qc: Float64Array;
  vc: Float64Array;
}

function internals(it: NBodyIntegrator): IntegratorInternals {
  const x = it as unknown as IntegratorInternals;
  if (!(x.qc instanceof Float64Array) || !(x.vc instanceof Float64Array)) {
    throw new Error('NBodyIntegrator no longer exposes compensation arrays qc/vc; update checkpointing');
  }
  return x;
}

export function initialCheckpoint(bodies: readonly BodyData[]): Checkpoint {
  const n = bodies.length;
  const data = new Float64Array(12 * n);
  const s = initialState(bodies);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      data[3 * i + k] = s[6 * i + k];
      data[3 * n + 3 * i + k] = s[6 * i + 3 + k];
    }
  }
  return { boundary: 0, data };
}

function captureCheckpoint(it: NBodyIntegrator, boundary: number): Checkpoint {
  const m = 3 * it.n;
  const data = new Float64Array(4 * m);
  const { qc, vc } = internals(it);
  data.set(it.q, 0);
  data.set(it.v, m);
  data.set(qc, 2 * m);
  data.set(vc, 3 * m);
  return { boundary, data };
}

function restoreIntegrator(gm: Float64Array, physics: NBodyPhysics, cp: Checkpoint, layout: ChebyshevLayout, t0: number, dir: 1 | -1): NBodyIntegrator {
  const n = gm.length;
  const m = 3 * n;
  const state = new Float64Array(6 * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      state[6 * i + k] = cp.data[3 * i + k];
      state[6 * i + 3 + k] = cp.data[m + 3 * i + k];
    }
  }
  const it = new NBodyIntegrator(gm, state, t0, dir * layout.h, KAHAN_LI_8, physics);
  const { qc, vc } = internals(it);
  qc.set(cp.data.subarray(2 * m, 3 * m));
  vc.set(cp.data.subarray(3 * m, 4 * m));
  it.steps = Math.abs(cp.boundary) * layout.chunkSteps;
  return it;
}

/** Scratch for chunk building: samples ascending in time, q v a per step. */
class SampleBuffer {
  readonly data: Float64Array;
  constructor(
    readonly steps: number,
    readonly n: number,
  ) {
    this.data = new Float64Array((steps + 1) * 9 * n);
  }
  put(j: number, it: NBodyIntegrator): void {
    const m = 3 * this.n;
    const o = j * 3 * m;
    this.data.set(it.q, o);
    this.data.set(it.v, o + m);
    it.totalAcceleration(this.data.subarray(o + 2 * m, o + 3 * m));
  }
}

/**
 * Integrate one chunk and fit it. `start` must be the checkpoint at the
 * chunk's starting boundary in integration order: boundary k for forward chunk
 * k >= 0, boundary k+1 for backward chunk k < 0. `physics` must be the same
 * object configuration for every chunk of one ephemeris. Returns the coefficients and
 * the checkpoint at the far boundary.
 */
export function buildChunk(
  layout: ChebyshevLayout,
  gm: Float64Array,
  physics: NBodyPhysics,
  t0: number,
  k: number,
  start: Checkpoint,
): { coeffs: Float64Array; end: Checkpoint } {
  const fwd = k >= 0;
  if (start.boundary !== (fwd ? k : k + 1)) throw new Error(`chunk ${k}: wrong start checkpoint ${start.boundary}`);
  const S = layout.chunkSteps;
  const n = gm.length;
  const buf = new SampleBuffer(S, n);
  const it = restoreIntegrator(gm, physics, start, layout, t0, fwd ? 1 : -1);
  buf.put(fwd ? 0 : S, it);
  for (let i = 1; i <= S; i++) {
    it.step();
    buf.put(fwd ? i : S - i, it);
  }
  const coeffs = new Float64Array(layout.chunkLength);
  fitSamples(layout, buf.data, n, coeffs);
  return { coeffs, end: captureCheckpoint(it, fwd ? k + 1 : k) };
}

/**
 * Fit every body of a chunk from samples (S+1 steps ascending, each q v a of
 * 3n floats). Exported for the tuner.
 */
export function fitSamples(layout: ChebyshevLayout, samples: Float64Array, n: number, out: Float64Array): void {
  const m3 = 3 * n;
  for (let b = 0; b < layout.count; b++) {
    const fit = layout.fits[b];
    const M = sampleIntervals(fit);
    const stride = fit.segSteps / M;
    const basis = fitBasis(M, fit.degree);
    const half = layout.segLen[b] / 2;
    const half2 = half * half;
    const rows = basis.rows;
    const cols = basis.cols;
    const rhs = new Float64Array(rows);
    const xs = new Float64Array(M + 1);
    for (let j = 0; j <= M; j++) xs[j] = (2 * j) / M - 1;
    const jm = Math.floor(M / 2);
    const xm = xs[jm];
    for (let s = 0; s < layout.segCount[b]; s++) {
      const base = layout.offset[b] + s * layout.stride3[b];
      for (let c = 0; c < 3; c++) {
        // Fit the residual from the tangent line at the middle sample, so the
        // fitted values are small and the long dot products below do not lose
        // the low bits of a 1e12 m coordinate. The line goes back into c0, c1.
        const om = (s * fit.segSteps + jm * stride) * 3 * m3 + 3 * b + c;
        const p0 = samples[om];
        const v0 = samples[om + m3] * half;
        for (let j = 0; j <= M; j++) {
          const o = (s * fit.segSteps + j * stride) * 3 * m3 + 3 * b + c;
          rhs[3 * j] = samples[o] - p0 - v0 * (xs[j] - xm);
          rhs[3 * j + 1] = samples[o + m3] * half - v0;
          rhs[3 * j + 2] = samples[o + 2 * m3] * half2;
        }
        for (let kk = 0; kk < cols; kk++) {
          let sum = 0;
          const prow = kk * rows;
          for (let r = 0; r < rows; r++) sum += basis.pinv[prow + r] * rhs[r];
          if (kk === 0) sum += p0 - v0 * xm;
          else if (kk === 1) sum += v0;
          out[base + 3 * kk + c] = sum;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluation

/**
 * Evaluate body b of a chunk at time t (chunkStart = t0 + k*C). Writes position
 * to pos[po..po+2] and, if vel is not null, velocity to vel[vo..vo+2].
 */
function evalBody(
  layout: ChebyshevLayout,
  coeffs: Float64Array,
  b: number,
  local: number,
  pos: Float64Array,
  po: number,
  vel: Float64Array | null,
  vo: number,
): void {
  const L = layout.segLen[b];
  let s = Math.floor(local / L);
  const nseg = layout.segCount[b];
  if (s < 0) s = 0;
  else if (s >= nseg) s = nseg - 1;
  const x = (local - s * L) * layout.twoOverLen[b] - 1;
  const deg = layout.degree[b];
  let o = layout.offset[b] + s * layout.stride3[b];
  // k = 0, 1
  let px = coeffs[o] + x * coeffs[o + 3];
  let py = coeffs[o + 1] + x * coeffs[o + 4];
  let pz = coeffs[o + 2] + x * coeffs[o + 5];
  const x2 = 2 * x;
  let tPrev = 1;
  let t = x;
  if (vel === null) {
    for (let k = 2; k <= deg; k++) {
      const tn = x2 * t - tPrev;
      tPrev = t;
      t = tn;
      o += 3;
      px += tn * coeffs[o + 3];
      py += tn * coeffs[o + 4];
      pz += tn * coeffs[o + 5];
    }
  } else {
    let vx = coeffs[o + 3];
    let vy = coeffs[o + 4];
    let vz = coeffs[o + 5];
    let dPrev = 0;
    let d = 1;
    for (let k = 2; k <= deg; k++) {
      const tn = x2 * t - tPrev;
      const dn = 2 * t + x2 * d - dPrev;
      tPrev = t;
      t = tn;
      dPrev = d;
      d = dn;
      o += 3;
      const cx = coeffs[o + 3];
      const cy = coeffs[o + 4];
      const cz = coeffs[o + 5];
      px += tn * cx;
      py += tn * cy;
      pz += tn * cz;
      vx += dn * cx;
      vy += dn * cy;
      vz += dn * cz;
    }
    const sc = layout.twoOverLen[b];
    vel[vo] = vx * sc;
    vel[vo + 1] = vy * sc;
    vel[vo + 2] = vz * sc;
  }
  pos[po] = px;
  pos[po + 1] = py;
  pos[po + 2] = pz;
}

export interface ChebyshevEphemerisOptions {
  h?: number;
  t0?: number;
  chunkSteps?: number;
  /** Override the per-body fits (same order as bodies). */
  fits?: readonly BodyFit[];
  /** Massive-body forces. Default solarSystemPhysics(bodies), as IntegratedEphemeris. */
  physics?: NBodyPhysics;
}

/**
 * Ephemeris backed by Chebyshev chunks. Missing chunks are built synchronously
 * on first use, outward from the nearest checkpoint in that direction (a
 * worker would run the same `buildChunk` and hand results to `addChunk`).
 */
export class ChebyshevEphemeris implements Ephemeris {
  readonly count: number;
  readonly gm: Float64Array;
  readonly t0: number;
  readonly layout: ChebyshevLayout;
  readonly physics: NBodyPhysics;
  readonly oblateness: readonly (BodyOblateness | null)[];
  readonly relativity?: { readonly body: number };
  /** fwd[k] = chunk k (k >= 0); bwd[j] = chunk -1-j. */
  private readonly fwd: Float64Array[] = [];
  private readonly bwd: Float64Array[] = [];
  /** Checkpoints at the outermost built boundaries. */
  private fwdEnd: Checkpoint;
  private bwdEnd: Checkpoint;
  private readonly tmpP: Float64Array;
  private readonly tmpV: Float64Array;

  constructor(bodies: readonly BodyData[] = J2000_BODIES, opts: ChebyshevEphemerisOptions = {}) {
    const h = opts.h ?? DEFAULT_STEP;
    const chunkSteps = opts.chunkSteps ?? DEFAULT_CHUNK_STEPS;
    this.count = bodies.length;
    this.gm = Float64Array.from(bodies.map((b) => b.gm));
    this.t0 = opts.t0 ?? 0;
    this.physics = opts.physics ?? solarSystemPhysics(bodies);
    this.oblateness = bodies.map(oblatenessOf);
    if (this.physics.relativity) this.relativity = { body: this.physics.relativity.sun };
    this.layout = opts.fits ? new ChebyshevLayout(opts.fits, h, chunkSteps) : ChebyshevLayout.forBodies(bodies, h, chunkSteps);
    const cp = initialCheckpoint(bodies);
    this.fwdEnd = cp;
    this.bwdEnd = cp;
    this.tmpP = new Float64Array(3 * this.count);
    this.tmpV = new Float64Array(3 * this.count);
  }

  /** Chunk index containing t. */
  chunkIndex(t: number): number {
    return Math.floor((t - this.t0) / this.layout.chunkSpan);
  }

  hasChunk(k: number): boolean {
    return k >= 0 ? this.fwd[k] !== undefined : this.bwd[-1 - k] !== undefined;
  }

  /** Coefficients of chunk k, if built. The array is shared; do not mutate. */
  getChunk(k: number): Float64Array | undefined {
    return k >= 0 ? this.fwd[k] : this.bwd[-1 - k];
  }

  /** Checkpoint at the next boundary to integrate from, in direction dir. */
  frontier(dir: 1 | -1): Checkpoint {
    return dir > 0 ? this.fwdEnd : this.bwdEnd;
  }

  /**
   * Install a chunk built elsewhere (worker, cache). Chunks must arrive in
   * order outward from the epoch; `end` (if given) is the checkpoint at its far
   * boundary, needed only to keep extending locally.
   */
  addChunk(k: number, coeffs: Float64Array, end?: Checkpoint): void {
    if (coeffs.length !== this.layout.chunkLength) throw new Error('chunk size does not match layout');
    if (k >= 0) {
      if (k !== this.fwd.length) throw new Error(`forward chunk ${k} out of order`);
      this.fwd.push(coeffs);
      if (end) this.fwdEnd = end;
    } else {
      if (-1 - k !== this.bwd.length) throw new Error(`backward chunk ${k} out of order`);
      this.bwd.push(coeffs);
      if (end) this.bwdEnd = end;
    }
  }

  /** Build every chunk needed to cover [ta, tb]. */
  ensure(ta: number, tb: number): void {
    this.chunk(this.chunkIndex(ta));
    this.chunk(this.chunkIndex(tb));
  }

  private chunk(k: number): Float64Array {
    const c = k >= 0 ? this.fwd[k] : this.bwd[-1 - k];
    if (c !== undefined) return c;
    return this.extendTo(k);
  }

  private extendTo(k: number): Float64Array {
    if (k >= 0) {
      while (this.fwd.length <= k) {
        const j = this.fwd.length;
        if (this.fwdEnd.boundary !== j) throw new Error(`no checkpoint at boundary ${j}`);
        const r = buildChunk(this.layout, this.gm, this.physics, this.t0, j, this.fwdEnd);
        this.fwd.push(r.coeffs);
        this.fwdEnd = r.end;
      }
      return this.fwd[k];
    }
    while (this.bwd.length <= -1 - k) {
      const j = -1 - this.bwd.length;
      if (this.bwdEnd.boundary !== j + 1) throw new Error(`no checkpoint at boundary ${j + 1}`);
      const r = buildChunk(this.layout, this.gm, this.physics, this.t0, j, this.bwdEnd);
      this.bwd.push(r.coeffs);
      this.bwdEnd = r.end;
    }
    return this.bwd[-1 - k];
  }

  /** Positions (and optionally velocities) of all bodies at t. No allocation once the chunk exists. */
  evaluate(t: number, pos: Float64Array, vel: Float64Array | null): void {
    const L = this.layout;
    const rel = t - this.t0;
    const k = Math.floor(rel / L.chunkSpan);
    const coeffs = this.chunk(k);
    const local = rel - k * L.chunkSpan;
    for (let b = 0; b < this.count; b++) evalBody(L, coeffs, b, local, pos, 3 * b, vel, 3 * b);
  }

  positions(t: number, out: Float64Array): void {
    const L = this.layout;
    const rel = t - this.t0;
    const k = Math.floor(rel / L.chunkSpan);
    const coeffs = this.chunk(k);
    const local = rel - k * L.chunkSpan;
    // Same arithmetic as evalBody(..., null), inlined: this is the hot path.
    const segLen = L.segLen;
    const segCount = L.segCount;
    const twoOverLen = L.twoOverLen;
    const offset = L.offset;
    const stride3 = L.stride3;
    const degree = L.degree;
    const n = this.count;
    for (let b = 0; b < n; b++) {
      const len = segLen[b];
      let s = Math.floor(local / len);
      const nseg = segCount[b];
      if (s < 0) s = 0;
      else if (s >= nseg) s = nseg - 1;
      const x = (local - s * len) * twoOverLen[b] - 1;
      let o = offset[b] + s * stride3[b];
      let px = coeffs[o] + x * coeffs[o + 3];
      let py = coeffs[o + 1] + x * coeffs[o + 4];
      let pz = coeffs[o + 2] + x * coeffs[o + 5];
      const x2 = 2 * x;
      let tPrev = 1;
      let tc = x;
      const end = o + 3 * degree[b];
      for (o += 6; o <= end; o += 3) {
        const tn = x2 * tc - tPrev;
        tPrev = tc;
        tc = tn;
        px += tn * coeffs[o];
        py += tn * coeffs[o + 1];
        pz += tn * coeffs[o + 2];
      }
      out[3 * b] = px;
      out[3 * b + 1] = py;
      out[3 * b + 2] = pz;
    }
  }

  bodyState(body: number, t: number, out: Float64Array): void {
    const L = this.layout;
    const rel = t - this.t0;
    const k = Math.floor(rel / L.chunkSpan);
    const coeffs = this.chunk(k);
    const local = rel - k * L.chunkSpan;
    evalBody(L, coeffs, body, local, this.tmpP, 0, this.tmpV, 0);
    out[0] = this.tmpP[0];
    out[1] = this.tmpP[1];
    out[2] = this.tmpP[2];
    out[3] = this.tmpV[0];
    out[4] = this.tmpV[1];
    out[5] = this.tmpV[2];
  }
}
