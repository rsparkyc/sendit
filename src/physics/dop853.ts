/**
 * Dormand-Prince 8(5,3) adaptive explicit Runge-Kutta integrator.
 *
 * DETERMINISM: only operations that IEEE-754 and ECMAScript define exactly may be
 * used here: + - * /, Math.sqrt (correctly rounded), Math.abs, Math.min/max and
 * comparisons. No transcendental functions (Math.pow / exp / log / trig / hypot),
 * whose results differ between JS engines. The step-size controller needs err^(-1/8),
 * which is computed as three nested square roots. Keep it that way: replays of a
 * mission plan must be bit-identical in every browser.
 */
import {
  A,
  A_EXTRA,
  B,
  C,
  C_EXTRA,
  D,
  E3,
  E5,
  INTERPOLATOR_POWER,
  N_STAGES,
  N_STAGES_EXTENDED,
} from './dop853-coefficients';

export type Derivative = (t: number, y: Float64Array, out: Float64Array) => void;

/** Fills `scale` with the error scale for each component (same units as y). */
export type ScaleFn = (y: Float64Array, yNew: Float64Array, scale: Float64Array) => void;

const SAFETY = 0.9;
const MIN_FACTOR = 0.2;
const MAX_FACTOR = 10;

export function componentwiseScale(rtol: number, atol: number): ScaleFn {
  return (y, yNew, scale) => {
    for (let j = 0; j < y.length; j++) {
      const a = Math.abs(y[j]);
      const b = Math.abs(yNew[j]);
      scale[j] = atol + rtol * (a > b ? a : b);
    }
  };
}

export class Dop853 {
  t = 0;
  /** Current state. Owned by the integrator; copy it if you need to keep it. */
  readonly y: Float64Array;
  /** Step size the controller proposes for the next step. */
  h = 0;
  accepted = 0;
  rejected = 0;

  private readonly n: number;
  private readonly K: Float64Array[];
  private readonly yNew: Float64Array;
  private readonly yTmp: Float64Array;
  private readonly scale: Float64Array;
  private lastRejected = false;

  // Dense output for the last accepted step [tPrevious, t].
  /** Start of the last accepted step; interpolate() is valid on [tPrevious, t]. NaN if none. */
  tPrevious = NaN;
  private hPrev = 0;
  private readonly yOld: Float64Array;
  /** Interpolant coefficients F[0..6] (SciPy Dop853DenseOutput). */
  private readonly F: Float64Array[];
  /** Stage derivatives in SciPy order for the last step (K[0]/K[12] are swapped by FSAL). */
  private readonly S: Float64Array[];
  private denseReady = false;

  constructor(
    n: number,
    private readonly f: Derivative,
    private readonly scaleFn: ScaleFn,
  ) {
    this.n = n;
    this.y = new Float64Array(n);
    this.yNew = new Float64Array(n);
    this.yTmp = new Float64Array(n);
    this.scale = new Float64Array(n);
    this.yOld = new Float64Array(n);
    // K[0..12] are the step stages, K[13..15] the lazily evaluated dense-output stages.
    this.K = [];
    for (let i = 0; i < N_STAGES_EXTENDED; i++) this.K.push(new Float64Array(n));
    this.S = this.K.slice();
    this.F = [];
    for (let i = 0; i < INTERPOLATOR_POWER; i++) this.F.push(new Float64Array(n));
  }

  /** Start (or restart) from a state. Pass `h` to keep a previous step size. */
  reset(t: number, y: ArrayLike<number>, h?: number): void {
    this.t = t;
    this.y.set(y);
    this.lastRejected = false;
    this.tPrevious = NaN;
    this.f(t, this.y, this.K[0]);
    this.h = h !== undefined && h > 0 ? h : this.initialStep();
  }

  /**
   * Re-evaluate the derivative at the current point. Call after the right-hand
   * side changes discontinuously (engine ignition / cutoff).
   */
  refresh(): void {
    // The new right-hand side would corrupt the lazy dense stages of the last step.
    this.tPrevious = NaN;
    this.f(this.t, this.y, this.K[0]);
    this.lastRejected = false;
  }

  private initialStep(): number {
    const { n, y, scale } = this;
    const k0 = this.K[0];
    this.scaleFn(y, y, scale);
    let d0 = 0;
    let d1 = 0;
    for (let j = 0; j < n; j++) {
      const a = y[j] / scale[j];
      const b = k0[j] / scale[j];
      d0 += a * a;
      d1 += b * b;
    }
    d0 = Math.sqrt(d0 / n);
    d1 = Math.sqrt(d1 / n);
    return d0 < 1e-5 || d1 < 1e-5 ? 1e-6 : (0.01 * d0) / d1;
  }

  /** Compute all stages for a step of size h. Leaves the result in yNew / K[12]. */
  private rkStep(h: number): void {
    const { n, y, yNew, yTmp, K, t, f } = this;
    for (let s = 1; s < N_STAGES; s++) {
      const a = A[s];
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let i = 0; i < s; i++) sum += a[i] * K[i][j];
        yTmp[j] = y[j] + h * sum;
      }
      f(t + C[s] * h, yTmp, K[s]);
    }
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let i = 0; i < N_STAGES; i++) sum += B[i] * K[i][j];
      yNew[j] = y[j] + h * sum;
    }
    f(t + h, yNew, K[N_STAGES]);
  }

  private errorNorm(h: number): number {
    const { n, y, yNew, K, scale } = this;
    this.scaleFn(y, yNew, scale);
    let e5 = 0;
    let e3 = 0;
    for (let j = 0; j < n; j++) {
      let s5 = 0;
      let s3 = 0;
      for (let i = 0; i <= N_STAGES; i++) {
        const k = K[i][j];
        s5 += E5[i] * k;
        s3 += E3[i] * k;
      }
      s5 /= scale[j];
      s3 /= scale[j];
      e5 += s5 * s5;
      e3 += s3 * s3;
    }
    if (e5 === 0 && e3 === 0) return 0;
    const denom = e5 + 0.01 * e3;
    return (Math.abs(h) * e5) / Math.sqrt(denom * n);
  }

  private accept(tNew: number, h: number): void {
    this.yOld.set(this.y);
    this.tPrevious = this.t;
    this.hPrev = h;
    this.denseReady = false;
    this.t = tNew;
    this.y.set(this.yNew);
    // FSAL: the last stage is the derivative at the new point.
    const k0 = this.K[0];
    this.K[0] = this.K[N_STAGES];
    this.K[N_STAGES] = k0;
    this.accepted++;
  }

  /** Take one error-controlled step, landing exactly on tEnd if it is within reach. */
  step(tEnd: number): void {
    if (!(tEnd > this.t)) throw new Error('step: tEnd must be after current time');
    const proposed = this.h;
    let h = proposed;
    let rejectedThisStep = false;
    for (;;) {
      let clipped = false;
      if (this.t + h >= tEnd) {
        h = tEnd - this.t;
        clipped = true;
      }
      if (this.t + h === this.t) throw new Error(`step size underflow at t=${this.t}`);

      this.rkStep(h);
      const err = this.errorNorm(h);

      if (err < 1) {
        // err^(-1/8) via nested sqrt -- see determinism note at top of file.
        let factor = err === 0 ? MAX_FACTOR : SAFETY / Math.sqrt(Math.sqrt(Math.sqrt(err)));
        if (factor > MAX_FACTOR) factor = MAX_FACTOR;
        if (this.lastRejected && factor > 1) factor = 1;
        this.lastRejected = false;
        let hNext = h * factor;
        // A step shortened only to hit tEnd shouldn't shrink the cruise step size,
        // unless the controller also had to reject a step here.
        if (clipped && !rejectedThisStep && hNext < proposed) hNext = proposed;
        this.accept(clipped ? tEnd : this.t + h, h);
        this.h = hNext;
        return;
      }

      let factor = SAFETY / Math.sqrt(Math.sqrt(Math.sqrt(err)));
      if (factor < MIN_FACTOR) factor = MIN_FACTOR;
      h *= factor;
      rejectedThisStep = true;
      this.lastRejected = true;
      this.rejected++;
    }
  }

  /** Step repeatedly until exactly tEnd. */
  integrateTo(tEnd: number, onStep?: (t: number, y: Float64Array, integ: Dop853) => void): void {
    while (this.t < tEnd) {
      this.step(tEnd);
      if (onStep) onStep(this.t, this.y, this);
    }
  }

  /**
   * State at time t inside the last accepted step, written to `out` (length n).
   * Valid for t in [tPrevious, t]; the endpoints return the stored states exactly.
   * The first call after a step costs three extra derivative evaluations; later
   * calls for the same step are a degree-7 polynomial evaluation. Invalidated by
   * reset() and refresh(), and the right-hand side must not have changed since
   * the step was taken (the extra stages are evaluated with the current f).
   */
  interpolate(t: number, out: Float64Array): void {
    const t0 = this.tPrevious;
    if (!(t >= t0 && t <= this.t)) {
      throw new Error(`interpolate: t=${t} outside last step [${t0}, ${this.t}]`);
    }
    if (t === this.t) {
      out.set(this.y);
      return;
    }
    if (t === t0) {
      out.set(this.yOld);
      return;
    }
    if (!this.denseReady) this.prepareDense();
    const { n, F, yOld } = this;
    const x = (t - t0) / this.hPrev;
    const x1 = 1 - x;
    // Horner-like scheme from SciPy: alternately multiply by x and (1 - x).
    for (let j = 0; j < n; j++) {
      let v = 0;
      for (let i = INTERPOLATOR_POWER - 1; i >= 0; i--) {
        v += F[i][j];
        v *= (INTERPOLATOR_POWER - 1 - i) % 2 === 0 ? x : x1;
      }
      out[j] = v + yOld[j];
    }
  }

  private prepareDense(): void {
    const { n, K, S, F, yOld, yTmp, y, f } = this;
    const h = this.hPrev;
    const t0 = this.tPrevious;
    // Undo the FSAL swap: SciPy order is S[0] = f(t0, yOld), S[12] = f(t1, y).
    S[0] = K[N_STAGES];
    S[N_STAGES] = K[0];
    for (let i = 1; i < N_STAGES; i++) S[i] = K[i];
    for (let s = N_STAGES + 1; s < N_STAGES_EXTENDED; s++) {
      S[s] = K[s];
      const a = A_EXTRA[s - N_STAGES - 1];
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let i = 0; i < s; i++) sum += a[i] * S[i][j];
        yTmp[j] = yOld[j] + h * sum;
      }
      f(t0 + C_EXTRA[s - N_STAGES - 1] * h, yTmp, S[s]);
    }
    const fOld = S[0];
    const fNew = S[N_STAGES];
    for (let j = 0; j < n; j++) {
      const dy = y[j] - yOld[j];
      F[0][j] = dy;
      F[1][j] = h * fOld[j] - dy;
      F[2][j] = 2 * dy - h * (fNew[j] + fOld[j]);
      for (let r = 0; r < 4; r++) {
        const d = D[r];
        let sum = 0;
        for (let i = 0; i < N_STAGES_EXTENDED; i++) sum += d[i] * S[i][j];
        F[3 + r][j] = h * sum;
      }
    }
    this.denseReady = true;
  }

  /** One step of exactly h with no error control (for convergence tests). */
  stepFixed(h: number): void {
    this.rkStep(h);
    this.accept(this.t + h, h);
  }
}
