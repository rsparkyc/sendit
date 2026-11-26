/**
 * Sampled spacecraft trajectories (dense output from the propagator) and their
 * evaluation. Pure.
 *
 * Layout: `data` holds n records of SAMPLE_STRIDE float64: t, x, y, z, vx, vy, vz
 * (ICRF barycentric, s, m, m/s), with strictly increasing t.
 */
export const SAMPLE_STRIDE = 7;

export interface Trajectory {
  readonly data: Float64Array;
  readonly n: number;
}

export function trajectoryFrom(data: Float64Array): Trajectory {
  return { data, n: Math.floor(data.length / SAMPLE_STRIDE) };
}

export function startTime(tr: Trajectory): number {
  return tr.data[0];
}

export function endTime(tr: Trajectory): number {
  return tr.data[(tr.n - 1) * SAMPLE_STRIDE];
}

/** Index i of the sample interval [t_i, t_{i+1}] containing t (clamped). */
export function findInterval(tr: Trajectory, t: number): number {
  let lo = 0;
  let hi = tr.n - 1;
  const d = tr.data;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d[mid * SAMPLE_STRIDE] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * State at t by cubic Hermite interpolation of position with velocity
 * (velocity from the derivative of the cubic). Returns false if t is outside
 * the trajectory. out: x y z vx vy vz.
 */
export function stateAt(tr: Trajectory, t: number, out: Float64Array): boolean {
  if (tr.n < 2 || t < startTime(tr) || t > endTime(tr)) return false;
  const i = findInterval(tr, t);
  const d = tr.data;
  const a = i * SAMPLE_STRIDE;
  const b = a + SAMPLE_STRIDE;
  const h = d[b] - d[a];
  if (!(h > 0)) {
    out.set(d.subarray(a + 1, a + 7));
    return true;
  }
  const s = (t - d[a]) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const g00 = (6 * s2 - 6 * s) / h;
  const g10 = 3 * s2 - 4 * s + 1;
  const g01 = (-6 * s2 + 6 * s) / h;
  const g11 = 3 * s2 - 2 * s;
  for (let k = 0; k < 3; k++) {
    const p0 = d[a + 1 + k];
    const p1 = d[b + 1 + k];
    const v0 = d[a + 4 + k];
    const v1 = d[b + 4 + k];
    out[k] = h00 * p0 + h10 * h * v0 + h01 * p1 + h11 * h * v1;
    out[3 + k] = g00 * p0 + g10 * v0 + g01 * p1 + g11 * v1;
  }
  return true;
}
