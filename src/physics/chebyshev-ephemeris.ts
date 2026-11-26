/**
 * Production ephemeris: piecewise Chebyshev polynomials fitted to the N-body
 * integrator's output (the representation of JPL's DE files and Principia's
 * continuous trajectories).
 *
 * REPRESENTATION
 *  - Time is split into CHUNKS of CHUNK_DAYS = 1024 days (`chunkSteps`
 *    integrator steps: 32768 at the default 1/32 d step), numbered by a signed
 *    index k: chunk k covers [t0 + k*C, t0 + (k+1)*C). Chunks k >= 0 come from
 *    forward integration from the epoch, chunks k < 0 from backward integration.
 *  - Inside a chunk each body has its own segment length L_b (a power-of-two
 *    number of steps dividing the chunk) and degree n_b. Each segment stores
 *    3*(n_b+1) coefficients of x(t), y(t), z(t) in the Chebyshev basis on
 *    [segStart, segStart + L_b], interleaved as c0x c0y c0z c1x c1y c1z ...
 *    Velocity is the derivative of the position polynomial.
 *  - SATELLITE SYSTEMS are stored the way JPL stores them (DE files hold the
 *    system barycenter, the satellite ephemerides hold the moons relative to
 *    it): the planet's slot holds the SYSTEM BARYCENTER B (smooth: it moves on
 *    the heliocentric orbit, plus cm-level solar-tide wiggles), each moon's
 *    slot holds the moon RELATIVE TO THAT BARYCENTER, r_i = q_i - B (a few
 *    1e8 m instead of 1e12 m). Evaluation rebuilds q_i = B + r_i and the
 *    planet from the barycenter's definition, q_P = B - sum_i (GM_i/GM_P) r_i.
 *    The planet needs no storage of its own (its barycentric motion, ~100 km
 *    wobbles at the moons' 2-17 d periods for Jupiter, would otherwise need
 *    segments as short as the moons'); relative to the barycenter a moon
 *    carries no reflex wobble of the planet caused by the other moons, which
 *    halves the segments needed (measured with the tuner), and a moon's
 *    position relative to its planet (what a flyby sees) carries its own fit
 *    error plus at most GM_moon/GM_P (< 1e-4) times the other moons'.
 *  - A chunk is ONE Float64Array holding every body's segments back to back;
 *    the offsets are a pure function of the layout, so nothing but the numbers
 *    needs storing or transferring (see `ChebyshevLayout`).
 *
 * FIT
 *  Least squares on the integrator's own grid: at every `stride`-th step inside
 *  the segment (including both ends; stride = segSteps/samples) the fit
 *  matches position, velocity*(L/2) and acceleration*(L/2)^2 (all in metres
 *  after that scaling) with equal weight. The sample abscissae are
 *  x_j = 2j/M - 1, exact rationals, so no cosine is ever needed: Chebyshev
 *  *nodes* are not required for a well-conditioned fit when the problem is
 *  oversampled 3x by derivative data and solved by Householder QR (only
 *  + - * / sqrt). The design matrix depends only on (M, degree), so its
 *  pseudo-inverse is computed once per configuration and every segment fit is
 *  a fixed-order matrix-vector product: cheap and bit-reproducible. Segments
 *  are fitted as soon as the integration has passed them, so a chunk build
 *  keeps only one segment of samples per body in memory.
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
import { DAY, DEFAULT_STEP, J2000_BODIES, initialState, oblatenessOf, solarSystemPhysics, type BodyData } from './solar-system';

/** Per-body fit: segment length in integrator steps, polynomial degree, samples per segment. */
export interface BodyFit {
  readonly segSteps: number;
  readonly degree: number;
  /** Sample intervals per segment; must divide segSteps. Default segSteps (every step). */
  readonly samples?: number;
}

/** Chunk duration, days. */
export const CHUNK_DAYS = 1024;

/** Integrator steps per chunk at step h (CHUNK_DAYS must be a whole number of steps). */
export function chunkStepsFor(h: number): number {
  const s = (CHUNK_DAYS * DAY) / h;
  if (Math.floor(s) !== s) throw new Error(`step ${h} s does not divide ${CHUNK_DAYS} days`);
  return s;
}

/** Steps per chunk at DEFAULT_STEP (32768). */
export const DEFAULT_CHUNK_STEPS = chunkStepsFor(DEFAULT_STEP);

/**
 * Tuned by test/chebyshev-tune.test.ts (TUNE=1 TUNE_CHUNKS=2: 5.6 years, ~1150
 * orbits of Io): among segment lengths of 2^p steps and degrees 5..20, the fit
 * with the fewest coefficients per unit time whose maximum error against the
 * integrator, at held-out mid-step times, is below TUNE_TARGET, in the
 * quantity the slot stores (for a planet with moons the SYSTEM BARYCENTER, for
 * a moon its position RELATIVE TO THAT BARYCENTER; see REPRESENTATION).
 * segSteps are in steps of DEFAULT_STEP (1/32 d); samples = min(segSteps, 32).
 *
 * The degree cap trades storage for speed. Evaluation evaluates one segment per
 * body, so its cost is proportional to sum(degree+1); storage to
 * sum((degree+1)/length). Measured (same tuner): cap 12 -> sum 277, 306 MB per
 * century; cap 14 -> 323, 290 MB; cap 16 -> ~350, 266 MB; cap 20 -> ~370,
 * 245 MB. The moons dominate (Io alone 39 MB): a 1.77 d orbit needs ~1/7 of
 * its period per segment at degree 10 for mm accuracy (Chebyshev coefficients
 * of a circle fall like J_n(omega L/2)), and a looser target barely helps
 * (1 cm: 244 MB, 3 cm: 209 MB at cap 12). Evaluation is the hot path, so cap 12.
 * Comment: segment length, tuned max error. Several are at the float64 floor
 * (~2-3 mm at 5-40 AU).
 */
export const DEFAULT_FITS: Readonly<Record<string, BodyFit>> = {
  sun: { segSteps: 512, degree: 9, samples: 32 }, // 16 d, 2.0 mm
  mercury: { segSteps: 128, degree: 10, samples: 32 }, // 4 d, 0.9 mm
  venus: { segSteps: 512, degree: 10, samples: 32 }, // 16 d, 2.2 mm
  earth: { segSteps: 128, degree: 10, samples: 32 }, // 4 d, 0.3 mm
  moon: { segSteps: 128, degree: 11, samples: 32 }, // 4 d, 2.5 mm
  mars: { segSteps: 1024, degree: 11, samples: 32 }, // 32 d, 1.4 mm
  jupiter: { segSteps: 1024, degree: 12, samples: 32 }, // 32 d, 2.3 mm (system barycenter)
  saturn: { segSteps: 2048, degree: 8, samples: 32 }, // 64 d, 2.2 mm (system barycenter)
  uranus: { segSteps: 4096, degree: 10, samples: 32 }, // 128 d, 3.0 mm (system barycenter)
  neptune: { segSteps: 2048, degree: 5, samples: 32 }, // 64 d, 2.5 mm (system barycenter)
  pluto: { segSteps: 1024, degree: 5, samples: 32 }, // 32 d, 3.0 mm (system barycenter)
  io: { segSteps: 8, degree: 10, samples: 8 }, // 0.25 d, 2.3 mm
  europa: { segSteps: 8, degree: 11, samples: 8 }, // 0.25 d, 0.8 mm
  ganymede: { segSteps: 16, degree: 11, samples: 16 }, // 0.5 d, 1.5 mm
  callisto: { segSteps: 16, degree: 8, samples: 16 }, // 0.5 d, 2.6 mm
  tethys: { segSteps: 8, degree: 9, samples: 8 }, // 0.25 d, 1.3 mm
  dione: { segSteps: 8, degree: 8, samples: 8 }, // 0.25 d, 2.8 mm
  rhea: { segSteps: 16, degree: 10, samples: 16 }, // 0.5 d, 1.7 mm
  titan: { segSteps: 32, degree: 10, samples: 32 }, // 1 d, 1.2 mm
  iapetus: { segSteps: 64, degree: 9, samples: 32 }, // 2 d, 2.3 mm
  ariel: { segSteps: 16, degree: 11, samples: 16 }, // 0.5 d, 2.6 mm
  umbriel: { segSteps: 16, degree: 11, samples: 16 }, // 0.5 d, 2.7 mm
  titania: { segSteps: 16, degree: 8, samples: 16 }, // 0.5 d, 2.8 mm
  oberon: { segSteps: 32, degree: 11, samples: 32 }, // 1 d, 2.5 mm
  triton: { segSteps: 64, degree: 12, samples: 32 }, // 2 d, 2.1 mm
  charon: { segSteps: 64, degree: 11, samples: 32 }, // 2 d, 2.9 mm
};
/** Conservative fallback for bodies not yet tuned: 1 d segments at the default step. Retune when adding bodies. */
export const FALLBACK_FIT: BodyFit = { segSteps: 32, degree: 12, samples: 16 };

/** Error goal for tuning; the tests accept 1 cm. */
export const TUNE_TARGET = 3e-3;

/** Number of grid intervals the fit samples in a segment (default: every step). */
export function sampleIntervals(fit: BodyFit): number {
  return fit.samples ?? fit.segSteps;
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
 * deterministically from (fits, h, chunkSteps, centers, gm), so worker and main
 * thread build identical layouts and only the coefficient buffer crosses threads.
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
  /** Per body: sample intervals per segment, and steps between samples. */
  readonly samples: Int32Array;
  readonly sampleStride: Int32Array;
  /**
   * Per body: the planet of a moon, or -1. A planet that is some moon's center
   * is stored as its system barycenter, and its moons relative to that
   * barycenter (see REPRESENTATION).
   */
  readonly center: Int32Array;
  /** Per moon: GM_moon / GM_planet (0 for bodies that are not moons). */
  readonly weight: Float64Array;
  /** Satellite systems: planet index, and its moons sysMoons[sysStart[s] .. sysStart[s+1]-1]. */
  readonly sysPlanet: Int32Array;
  readonly sysStart: Int32Array;
  readonly sysMoons: Int32Array;
  /** Per body: index of its satellite system, or -1. */
  readonly systemOf: Int32Array;
  /** Float64 elements per chunk. */
  readonly chunkLength: number;

  /**
   * @param centers per body, the index of its planet or -1 (default: none).
   * @param gm      per body GM; required when any center is given (barycenter weights).
   */
  constructor(fits: readonly BodyFit[], h: number = DEFAULT_STEP, chunkSteps = chunkStepsFor(h), centers?: readonly number[], gm?: ArrayLike<number>) {
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
    this.samples = new Int32Array(n);
    this.sampleStride = new Int32Array(n);
    this.center = new Int32Array(n).fill(-1);
    this.weight = new Float64Array(n);
    this.systemOf = new Int32Array(n).fill(-1);
    const planets: number[] = [];
    const moonsOf: number[][] = [];
    if (centers !== undefined) {
      if (centers.length !== n) throw new Error('centers must have one entry per body');
      for (let i = 0; i < n; i++) {
        const c = centers[i];
        if (c < 0) continue;
        if (c >= i || centers[c] >= 0) throw new Error(`body ${i}: its center must precede it and not be a moon`);
        this.center[i] = c;
        let s = planets.indexOf(c);
        if (s < 0) {
          s = planets.length;
          planets.push(c);
          moonsOf.push([]);
        }
        moonsOf[s].push(i);
      }
      if (planets.length > 0 && gm === undefined) throw new Error('gm is required with centers');
    }
    const start: number[] = [0];
    const moons: number[] = [];
    planets.forEach((p, s) => {
      for (const m of moonsOf[s]) {
        this.weight[m] = gm![m] / gm![p];
        this.systemOf[m] = s;
        moons.push(m);
      }
      this.systemOf[p] = s;
      start.push(moons.length);
    });
    this.sysPlanet = Int32Array.from(planets);
    this.sysStart = Int32Array.from(start);
    this.sysMoons = Int32Array.from(moons);
    let off = 0;
    for (let i = 0; i < n; i++) {
      const f = fits[i];
      const M = sampleIntervals(f);
      if (!(f.segSteps >= 1) || chunkSteps % f.segSteps !== 0) throw new Error(`body ${i}: segSteps must divide chunkSteps`);
      if (!(M >= 1) || f.segSteps % M !== 0) throw new Error(`body ${i}: samples must divide segSteps`);
      if (3 * (M + 1) < 2 * (f.degree + 1)) throw new Error(`body ${i}: degree too high for segment (need 3 samples per 2 coefficients)`);
      this.segLen[i] = f.segSteps * h;
      this.twoOverLen[i] = 2 / (f.segSteps * h);
      this.segCount[i] = chunkSteps / f.segSteps;
      this.degree[i] = f.degree;
      this.samples[i] = M;
      this.sampleStride[i] = f.segSteps / M;
      this.stride3[i] = 3 * (f.degree + 1);
      this.offset[i] = off;
      off += this.segCount[i] * this.stride3[i];
    }
    this.chunkLength = off;
  }

  static forBodies(bodies: readonly BodyData[], h: number = DEFAULT_STEP, chunkSteps = chunkStepsFor(h)): ChebyshevLayout {
    // DEFAULT_FITS are in steps of DEFAULT_STEP; rescale for other steps,
    // keeping the number of samples unless the segment has fewer steps.
    const r = DEFAULT_STEP / h;
    const fits = bodies.map((b): BodyFit => {
      const f = DEFAULT_FITS[b.id] ?? FALLBACK_FIT;
      const segSteps = Math.max(1, Math.round(f.segSteps * r));
      const samples = Math.min(sampleIntervals(f), segSteps);
      return { segSteps, degree: f.degree, samples };
    });
    return new ChebyshevLayout(fits, h, chunkSteps, centersOf(bodies), bodies.map((b) => b.gm));
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

/** Index of each body's parent (the body it is fitted relative to), or -1. */
export function centersOf(bodies: readonly BodyData[]): number[] {
  return bodies.map((b) => {
    if (b.parent === undefined) return -1;
    const c = bodies.findIndex((x) => x.id === b.parent);
    if (c < 0) throw new Error(`${b.id}: parent ${b.parent} not in the body list`);
    return c;
  });
}

/**
 * Turn raw evaluated entries (system barycenter B in each planet's slot, each
 * moon relative to B) into barycentric positions (and velocities) of every
 * body, in place: q_i = B + r_i, q_P = B - sum_i (GM_i/GM_P) r_i.
 * `only` restricts it to one system.
 */
function reconstruct(L: ChebyshevLayout, pos: Float64Array, vel: Float64Array | null, only = -1): void {
  const { sysPlanet, sysStart, sysMoons, weight } = L;
  const s0 = only >= 0 ? only : 0;
  const s1 = only >= 0 ? only + 1 : sysPlanet.length;
  for (let s = s0; s < s1; s++) {
    const p = 3 * sysPlanet[s];
    const a = sysStart[s];
    const b = sysStart[s + 1];
    for (let c = 0; c < 3; c++) {
      const B = pos[p + c];
      let x = B;
      for (let k = a; k < b; k++) {
        const i = 3 * sysMoons[k] + c;
        x -= weight[sysMoons[k]] * pos[i];
        pos[i] += B;
      }
      pos[p + c] = x;
      if (vel !== null) {
        const V = vel[p + c];
        let u = V;
        for (let k = a; k < b; k++) {
          const i = 3 * sysMoons[k] + c;
          u -= weight[sysMoons[k]] * vel[i];
          vel[i] += V;
        }
        vel[p + c] = u;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Checkpoints and chunk building

/**
 * Full-precision integrator state at a chunk boundary, as written by
 * NBodyIntegrator.exportState: q, v and their Kahan compensation terms
 * (4 * 3n float64). Boundary b is at t0 + b*C; b > 0 comes from forward
 * integration, b < 0 from backward, b = 0 is the initial state.
 * Transferable as `data.buffer`.
 */
export interface Checkpoint {
  readonly boundary: number;
  readonly data: Float64Array;
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
  it.importState(cp.data, Math.abs(cp.boundary) * layout.chunkSteps);
  return it;
}

/**
 * Streaming fitter for one chunk. Feed it the state at every step (any
 * direction); it keeps one segment of samples per body and fits each segment
 * as soon as all its samples are in. The fit of a segment depends only on its
 * samples, so the result is the same whichever direction the steps come in.
 */
class ChunkFitter {
  readonly coeffs: Float64Array;
  private readonly seg: Float64Array[];
  private readonly gsys: Float64Array;
  private readonly any: number;

  constructor(
    private readonly layout: ChebyshevLayout,
    private readonly gm: ArrayLike<number>,
  ) {
    this.coeffs = new Float64Array(layout.chunkLength);
    this.seg = [];
    for (let b = 0; b < layout.count; b++) this.seg.push(new Float64Array((layout.samples[b] + 1) * 9));
    // System GM, summed in the same order as the barycenter below.
    this.gsys = new Float64Array(layout.sysPlanet.length);
    for (let s = 0; s < layout.sysPlanet.length; s++) {
      let g = gm[layout.sysPlanet[s]];
      for (let k = layout.sysStart[s]; k < layout.sysStart[s + 1]; k++) g += gm[layout.sysMoons[k]];
      this.gsys[s] = g;
    }
    let any = layout.chunkSteps;
    for (let b = 0; b < layout.count; b++) any = Math.min(any, layout.sampleStride[b]);
    this.any = any;
  }

  /** Does any body take a sample at step j (0..chunkSteps)? */
  wants(j: number): boolean {
    if (j % this.any !== 0) return false;
    for (let b = 0; b < this.layout.count; b++) if (j % this.layout.sampleStride[b] === 0) return true;
    return false;
  }

  /** Component c of the barycenter of system s, from q, v or a in `x`. */
  private bary(s: number, x: ArrayLike<number>, o: number, c: number): number {
    const L = this.layout;
    const gm = this.gm;
    const p = L.sysPlanet[s];
    let sum = gm[p] * x[o + 3 * p + c];
    for (let k = L.sysStart[s]; k < L.sysStart[s + 1]; k++) {
      const i = L.sysMoons[k];
      sum += gm[i] * x[o + 3 * i + c];
    }
    return sum / this.gsys[s];
  }

  /** The value fitted for body b (component c of q, v or a in `x`), see REPRESENTATION. */
  private value(b: number, x: ArrayLike<number>, o: number, c: number): number {
    const s = this.layout.systemOf[b];
    if (s < 0) return x[o + 3 * b + c];
    if (this.layout.center[b] >= 0) return x[o + 3 * b + c] - this.bary(s, x, o, c);
    return this.bary(s, x, o, c);
  }

  private write(b: number, li: number, q: ArrayLike<number>, qo: number, v: ArrayLike<number>, vo: number, a: ArrayLike<number>, ao: number): void {
    const buf = this.seg[b];
    for (let c = 0; c < 3; c++) {
      buf[9 * li + c] = this.value(b, q, qo, c);
      buf[9 * li + 3 + c] = this.value(b, v, vo, c);
      buf[9 * li + 6 + c] = this.value(b, a, ao, c);
    }
  }

  /**
   * State at step j of the chunk (0..chunkSteps, ascending in time): q, v, a
   * of all bodies at offsets qo, vo, ao. `forward`: steps arrive in increasing j.
   */
  put(j: number, forward: boolean, q: ArrayLike<number>, qo: number, v: ArrayLike<number>, vo: number, a: ArrayLike<number>, ao: number): void {
    const L = this.layout;
    for (let b = 0; b < L.count; b++) {
      const stride = L.sampleStride[b];
      if (j % stride !== 0) continue;
      const M = L.samples[b];
      const i = j / stride;
      const s = Math.floor(i / M);
      const li = i - s * M;
      const nseg = L.segCount[b];
      if (forward) {
        if (li === 0 && s > 0) {
          this.write(b, M, q, qo, v, vo, a, ao);
          this.fit(b, s - 1);
        }
        if (s < nseg) this.write(b, li, q, qo, v, vo, a, ao);
      } else {
        if (s < nseg) {
          this.write(b, li, q, qo, v, vo, a, ao);
          if (li === 0) this.fit(b, s);
        }
        if (li === 0 && s > 0) this.write(b, M, q, qo, v, vo, a, ao);
      }
    }
  }

  /** Fit segment s of body b from its M+1 buffered samples. */
  private fit(b: number, s: number): void {
    const L = this.layout;
    const M = L.samples[b];
    const basis = fitBasis(M, L.degree[b]);
    const half = L.segLen[b] / 2;
    const half2 = half * half;
    const rows = basis.rows;
    const cols = basis.cols;
    const rhs = new Float64Array(rows);
    const buf = this.seg[b];
    const jm = Math.floor(M / 2);
    const xm = (2 * jm) / M - 1;
    const base = L.offset[b] + s * L.stride3[b];
    const out = this.coeffs;
    for (let c = 0; c < 3; c++) {
      // Fit the residual from the tangent line at the middle sample, so the
      // fitted values are small and the long dot products below do not lose
      // the low bits of a 1e12 m coordinate. The line goes back into c0, c1.
      const p0 = buf[9 * jm + c];
      const v0 = buf[9 * jm + 3 + c] * half;
      for (let j = 0; j <= M; j++) {
        const x = (2 * j) / M - 1;
        rhs[3 * j] = buf[9 * j + c] - p0 - v0 * (x - xm);
        rhs[3 * j + 1] = buf[9 * j + 3 + c] * half - v0;
        rhs[3 * j + 2] = buf[9 * j + 6 + c] * half2;
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
  const fitter = new ChunkFitter(layout, gm);
  const acc = new Float64Array(3 * n);
  const it = restoreIntegrator(gm, physics, start, layout, t0, fwd ? 1 : -1);
  const put = (j: number) => {
    if (!fitter.wants(j)) return;
    it.totalAcceleration(acc);
    fitter.put(j, fwd, it.q, 0, it.v, 0, acc, 0);
  };
  put(fwd ? 0 : S);
  for (let i = 1; i <= S; i++) {
    it.step();
    put(fwd ? i : S - i);
  }
  return { coeffs: fitter.coeffs, end: { boundary: fwd ? k + 1 : k, data: it.exportState() } };
}

/**
 * Fit every body of a chunk from samples on the integrator grid (S+1 steps
 * ascending, each q v a of 3n floats). Same result as buildChunk for the same
 * states. Exported for the tuner.
 */
export function fitSamples(layout: ChebyshevLayout, samples: Float64Array, n: number, out: Float64Array, gm: ArrayLike<number> = J2000_BODIES.map((b) => b.gm)): void {
  const m3 = 3 * n;
  const fitter = new ChunkFitter(layout, gm);
  for (let j = 0; j <= layout.chunkSteps; j++) {
    if (!fitter.wants(j)) continue;
    const o = j * 3 * m3;
    fitter.put(j, true, samples, o, samples, o + m3, samples, o + 2 * m3);
  }
  out.set(fitter.coeffs);
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
  /** Steps per chunk. Default: CHUNK_DAYS of steps. */
  chunkSteps?: number;
  /** Override the per-body fits (same order as bodies). */
  fits?: readonly BodyFit[];
  /** With `fits`: override the fit centers (default: each body's parent; -1 for barycentric fits). */
  centers?: readonly number[];
  /**
   * Known checkpoints (e.g. a shipped static asset, or ones exported by another
   * worker): any chunk starting at one of them is built without integrating
   * from the epoch, and chunks starting at different checkpoints can be built
   * independently, in parallel, with identical bits.
   */
  checkpoints?: readonly Checkpoint[];
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
  /** Built chunks by signed index. */
  private readonly chunks = new Map<number, Float64Array>();
  /** Known checkpoints by boundary. */
  private readonly cps = new Map<number, Checkpoint>();
  private readonly tmpP: Float64Array;
  private readonly tmpV: Float64Array;

  constructor(bodies: readonly BodyData[] = J2000_BODIES, opts: ChebyshevEphemerisOptions = {}) {
    const h = opts.h ?? DEFAULT_STEP;
    const chunkSteps = opts.chunkSteps ?? chunkStepsFor(h);
    this.count = bodies.length;
    this.gm = Float64Array.from(bodies.map((b) => b.gm));
    this.t0 = opts.t0 ?? 0;
    this.physics = opts.physics ?? solarSystemPhysics(bodies);
    this.oblateness = bodies.map(oblatenessOf);
    if (this.physics.relativity) this.relativity = { body: this.physics.relativity.sun };
    this.layout = opts.fits
      ? new ChebyshevLayout(opts.fits, h, chunkSteps, opts.centers ?? centersOf(bodies), this.gm)
      : ChebyshevLayout.forBodies(bodies, h, chunkSteps);
    this.cps.set(0, initialCheckpoint(bodies));
    for (const cp of opts.checkpoints ?? []) this.addCheckpoint(cp);
    this.tmpP = new Float64Array(3 * this.count);
    this.tmpV = new Float64Array(3 * this.count);
  }

  /** Chunk index containing t. */
  chunkIndex(t: number): number {
    return Math.floor((t - this.t0) / this.layout.chunkSpan);
  }

  hasChunk(k: number): boolean {
    return this.chunks.has(k);
  }

  /** Coefficients of chunk k, if built. The array is shared; do not mutate. */
  getChunk(k: number): Float64Array | undefined {
    return this.chunks.get(k);
  }

  /** Indices of all built chunks, ascending. */
  builtChunks(): number[] {
    return [...this.chunks.keys()].sort((x, y) => x - y);
  }

  /**
   * The contiguous time range [tStart, tEnd) covered by built chunks around
   * time t (default: the epoch), or null if the chunk containing t is not built.
   */
  coveredRange(t: number = this.t0): { tStart: number; tEnd: number } | null {
    const k = this.chunkIndex(t);
    if (!this.chunks.has(k)) return null;
    let lo = k;
    let hi = k;
    while (this.chunks.has(lo - 1)) lo--;
    while (this.chunks.has(hi + 1)) hi++;
    const C = this.layout.chunkSpan;
    return { tStart: this.t0 + lo * C, tEnd: this.t0 + (hi + 1) * C };
  }

  /** Checkpoint at the outermost known boundary in direction dir (where extending would start). */
  frontier(dir: 1 | -1): Checkpoint {
    let best = this.cps.get(0)!;
    for (const cp of this.cps.values()) if (dir * cp.boundary > dir * best.boundary) best = cp;
    return best;
  }

  /** Checkpoint at boundary b, if known. */
  checkpoint(b: number): Checkpoint | undefined {
    return this.cps.get(b);
  }

  /** All known checkpoints, by ascending boundary (e.g. to ship as a static asset). */
  checkpoints(): Checkpoint[] {
    return [...this.cps.values()].sort((x, y) => x.boundary - y.boundary);
  }

  /** Make a checkpoint known (see ChebyshevEphemerisOptions.checkpoints). */
  addCheckpoint(cp: Checkpoint): void {
    if (cp.data.length !== 12 * this.count) throw new Error('checkpoint size does not match body count');
    if (!this.cps.has(cp.boundary)) this.cps.set(cp.boundary, cp);
  }

  /**
   * Install a chunk built elsewhere (worker, cache), in any order. `end` (if
   * given) is the checkpoint at its far boundary in integration order.
   */
  addChunk(k: number, coeffs: Float64Array, end?: Checkpoint): void {
    if (coeffs.length !== this.layout.chunkLength) throw new Error('chunk size does not match layout');
    this.chunks.set(k, coeffs);
    if (end) this.addCheckpoint(end);
  }

  /** Build every chunk needed to cover [ta, tb]. */
  ensure(ta: number, tb: number): void {
    const ka = this.chunkIndex(ta);
    const kb = this.chunkIndex(tb);
    for (let k = Math.min(ka, kb); k <= Math.max(ka, kb); k++) this.chunk(k);
  }

  /** Coefficients of chunk k, building it (and any chunks between it and the nearest checkpoint) if needed. */
  private chunk(k: number): Float64Array {
    const c = this.chunks.get(k);
    if (c !== undefined) return c;
    return this.extendTo(k);
  }

  private extendTo(k: number): Float64Array {
    const dir: 1 | -1 = k >= 0 ? 1 : -1;
    // Start boundary of chunk j in integration order: j forward, j+1 backward.
    const startOf = (j: number) => (dir > 0 ? j : j + 1);
    let j = k;
    while (!this.cps.has(startOf(j))) j -= dir;
    for (; dir > 0 ? j <= k : j >= k; j += dir) {
      if (this.chunks.has(j) && this.cps.has(startOf(j + dir))) continue;
      const r = buildChunk(this.layout, this.gm, this.physics, this.t0, j, this.cps.get(startOf(j))!);
      if (!this.chunks.has(j)) this.chunks.set(j, r.coeffs);
      this.addCheckpoint(r.end);
    }
    return this.chunks.get(k)!;
  }

  /**
   * Like evaluate, but never builds: returns false (leaving pos/vel untouched)
   * if the chunk containing t is not built.
   */
  tryEvaluate(t: number, pos: Float64Array, vel: Float64Array | null): boolean {
    if (!this.chunks.has(this.chunkIndex(t))) return false;
    this.evaluate(t, pos, vel);
    return true;
  }

  /**
   * Positions (and optionally velocities) of a subset of bodies: body
   * `bodies[j]` goes to pos[3j..3j+2] (vel likewise). Same bits as evaluate for
   * those bodies; costs only the bodies asked for (plus, for a planet or moon,
   * the rest of its satellite system). Builds the chunk if needed.
   */
  evaluateBodies(t: number, bodies: ArrayLike<number>, pos: Float64Array, vel: Float64Array | null): void {
    const v = vel ?? this.tmpV;
    for (let j = 0; j < bodies.length; j++) {
      this.bodyState(bodies[j], t, this.one);
      pos[3 * j] = this.one[0];
      pos[3 * j + 1] = this.one[1];
      pos[3 * j + 2] = this.one[2];
      if (vel !== null) {
        v[3 * j] = this.one[3];
        v[3 * j + 1] = this.one[4];
        v[3 * j + 2] = this.one[5];
      }
    }
  }
  private readonly one = new Float64Array(6);

  /** Positions (and optionally velocities) of all bodies at t. No allocation once the chunk exists. */
  evaluate(t: number, pos: Float64Array, vel: Float64Array | null): void {
    const L = this.layout;
    const rel = t - this.t0;
    const k = Math.floor(rel / L.chunkSpan);
    const coeffs = this.chunk(k);
    const local = rel - k * L.chunkSpan;
    for (let b = 0; b < this.count; b++) evalBody(L, coeffs, b, local, pos, 3 * b, vel, 3 * b);
    reconstruct(L, pos, vel);
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
    if (L.sysPlanet.length > 0) reconstruct(L, out, null);
  }

  bodyState(body: number, t: number, out: Float64Array): void {
    const L = this.layout;
    const rel = t - this.t0;
    const k = Math.floor(rel / L.chunkSpan);
    const coeffs = this.chunk(k);
    const local = rel - k * L.chunkSpan;
    const p = this.tmpP;
    const v = this.tmpV;
    const s = L.systemOf[body];
    if (s < 0) {
      evalBody(L, coeffs, body, local, p, 3 * body, v, 3 * body);
    } else {
      // A planet or moon needs its whole system (same arithmetic as evaluate).
      evalBody(L, coeffs, L.sysPlanet[s], local, p, 3 * L.sysPlanet[s], v, 3 * L.sysPlanet[s]);
      for (let i = L.sysStart[s]; i < L.sysStart[s + 1]; i++) {
        const m = L.sysMoons[i];
        evalBody(L, coeffs, m, local, p, 3 * m, v, 3 * m);
      }
      reconstruct(L, p, v, s);
    }
    for (let i = 0; i < 3; i++) {
      out[i] = p[3 * body + i];
      out[3 + i] = v[3 * body + i];
    }
  }
}
