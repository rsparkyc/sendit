/**
 * Differential corrector: adjust one finite burn (direction, duration, start
 * time) so that the trajectory flown in the real N-body model hits a B-plane
 * target at a body.
 *
 * Each evaluation is a full `propagate` from the initial state through the
 * burn to the B-plane epoch, where the osculating hyperbola about the target
 * gives (B.T, B.R) (see `bPlane`). Sensitivities are forward finite
 * differences (4 extra propagations per iteration). The update is the
 * minimum-norm Gauss-Newton step in scaled controls (2 or 3 equations: B.T,
 * B.R and optionally the periapsis time, weighted by v-infinity so it is in
 * metres; 4 unknowns), with backtracking when it does not reduce the miss.
 */
import type { Burn, Ephemeris } from '../physics/spacecraft';
import { propagate } from '../physics/spacecraft';
import { bPlane } from './departure';
import { cross, norm, unit, type Vec3 } from './kepler';

export interface BPlaneTarget {
  kind?: 'bplane';
  /** Target body index (look it up with findBody). */
  body: number;
  /** Desired B.T and B.R, m (ecliptic-referenced B-plane). */
  bt: number;
  br: number;
  /** Epoch at which the osculating B-plane is evaluated, s TDB (before the encounter). */
  epoch: number;
  /**
   * Optional time of periapsis on the osculating hyperbola, s TDB. Strongly
   * recommended: without it a fixed-epoch B-plane can also be matched by a
   * trajectory receding from the body, which is nowhere near an encounter.
   */
  tPeri?: number;
}

/**
 * Position target: spacecraft minus body at `epoch` equal to `offset` (default
 * zero, i.e. the body centre). Smooth and nearly linear while far from the
 * body, so it is the right first stage from a Lambert guess that misses by
 * millions of km; switch to a B-plane target once within ~1e5 km.
 */
export interface PositionTarget {
  kind: 'position';
  body: number;
  epoch: number;
  offset?: readonly [number, number, number];
}

export interface CorrectorOptions {
  maxIterations?: number;
  /** Stop when the B-plane miss is below this, m. Default 1 km. */
  tolerance?: number;
  /** Propagator tolerance. Default 1e-11. */
  rtol?: number;
  /** Finite-difference steps: direction (rad), duration (s), start (s). */
  fdAngle?: number;
  fdDuration?: number;
  fdStart?: number;
}

export interface CorrectorIteration {
  iteration: number;
  bt: number;
  br: number;
  /** |B - B_target| (B-plane target) or |position error| (position target), m. */
  miss: number;
  /** v-infinity times periapsis-time error, m (0 without a time target). */
  timeResidual: number;
  burn: Burn;
}

export interface CorrectorResult {
  converged: boolean;
  burn: Burn;
  history: CorrectorIteration[];
  /** Total propagations. */
  evaluations: number;
}

/** Minimum B-plane target magnitude for periapsis radius rp at excess speed vinf. */
export function bForPeriapsis(rp: number, vinf: number, mu: number): number {
  return rp * Math.sqrt(1 + (2 * mu) / (rp * vinf * vinf));
}

export function correctBurn(ephem: Ephemeris, y0: ArrayLike<number>, t0: number, burn0: Burn, target: BPlaneTarget | PositionTarget, opts: CorrectorOptions = {}): CorrectorResult {
  const maxIt = opts.maxIterations ?? 20;
  const tol = opts.tolerance ?? 1e3;
  const rtol = opts.rtol ?? 1e-11;
  const hA = opts.fdAngle ?? 1e-5;
  const hD = opts.fdDuration ?? 0.01;
  const hS = opts.fdStart ?? 0.1;
  // Scales making one unit of each control comparable: 1 mrad, 1 s, 10 s.
  const SC = [1e-3, 1e-3, 1, 10];
  const tb = new Float64Array(6);
  let evaluations = 0;

  const d0 = unit(burn0.direction);
  // Perpendicular basis for direction changes.
  let e1 = cross(d0, Math.abs(d0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
  e1 = unit(e1);
  const e2 = cross(d0, e1);
  const make = (u: readonly number[]): Burn => {
    const d: Vec3 = [d0[0] + u[0] * e1[0] + u[1] * e2[0], d0[1] + u[0] * e1[1] + u[1] * e2[1], d0[2] + u[0] * e1[2] + u[1] * e2[2]];
    const n = norm(d);
    return { ...burn0, direction: [d[0] / n, d[1] / n, d[2] / n], duration: burn0.duration + u[2], tStart: burn0.tStart + u[3] };
  };
  const isPos = target.kind === 'position';
  const useT = !isPos && (target as BPlaneTarget).tPeri !== undefined;
  const m = isPos || useT ? 3 : 2;
  /** Residuals, m: position offset error, or [dBT, dBR, (vinf * dTperi)]. */
  const evalB = (u: readonly number[]): number[] => {
    evaluations++;
    const b = make(u);
    if (!(b.duration > 0) || b.tStart < t0) return Array(m).fill(NaN);
    const y = propagate(ephem, y0, t0, target.epoch, [b], { rtol }).y;
    ephem.bodyState(target.body, target.epoch, tb);
    if (target.kind === 'position') {
      const o = target.offset ?? [0, 0, 0];
      return [0, 1, 2].map((k) => y[k] - tb[k] - o[k]);
    }
    const r = bPlane([y[0] - tb[0], y[1] - tb[1], y[2] - tb[2]], [y[3] - tb[3], y[4] - tb[4], y[5] - tb[5]], ephem.gm[target.body]);
    const out = [r.bt - target.bt, r.br - target.br];
    if (useT) out.push(r.vinf * (target.epoch + r.dtPeri - target.tPeri!));
    return out;
  };
  const size = (f: number[]) => Math.hypot(...f);

  let u = [0, 0, 0, 0];
  let f = evalB(u);
  const history: CorrectorIteration[] = [];
  const record = (it: number) =>
    history.push(
      target.kind === 'position'
        ? { iteration: it, bt: NaN, br: NaN, miss: size(f), timeResidual: 0, burn: make(u) }
        : { iteration: it, bt: f[0] + target.bt, br: f[1] + target.br, miss: Math.hypot(f[0], f[1]), timeResidual: useT ? f[2] : 0, burn: make(u) },
    );
  record(0);
  let converged = size(f) < tol;
  for (let it = 1; it <= maxIt && !converged; it++) {
    if (!f.every(Number.isFinite)) break;
    // Jacobian (m x 4) by forward differences, in scaled controls.
    const steps = [hA, hA, hD, hS];
    const J: number[][] = Array.from({ length: m }, () => [0, 0, 0, 0]);
    for (let k = 0; k < 4; k++) {
      const up = u.slice();
      up[k] += steps[k];
      const fk = evalB(up);
      for (let q = 0; q < m; q++) J[q][k] = ((fk[q] - f[q]) / steps[k]) * SC[k];
    }
    // Minimum-norm step: dz = J^T (J J^T)^-1 (-f).
    const A = J.map((ri) => J.map((rj) => ri.reduce((s, x, k) => s + x * rj[k], 0)));
    const lam = solveSmall(A, f.map((x) => -x));
    if (lam === null) break;
    const dz = [0, 1, 2, 3].map((k) => J.reduce((s, row, q) => s + row[k] * lam[q], 0));
    // Backtracking on |f|.
    const m0 = size(f);
    let alpha = 1;
    let accepted = false;
    for (let ls = 0; ls < 12; ls++) {
      const un = u.map((x, k) => x + alpha * dz[k] * SC[k]);
      const fn = evalB(un);
      if (fn.every(Number.isFinite) && size(fn) < m0) {
        u = un;
        f = fn;
        accepted = true;
        break;
      }
      alpha /= 2;
    }
    record(it);
    if (!accepted) break;
    converged = size(f) < tol;
  }
  return { converged, burn: make(u), history, evaluations };
}

/** Solve a small dense system by Gaussian elimination with partial pivoting; null if singular. */
function solveSmall(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 0)) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const k = M[r][c] / M[c][c];
      for (let q = c; q <= n; q++) M[r][q] -= k * M[c][q];
    }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let q = r + 1; q < n; q++) s -= M[r][q] * x[q];
    x[r] = s / M[r][r];
  }
  return x;
}
