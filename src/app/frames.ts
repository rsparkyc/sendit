/**
 * Reference frames for plotting, after Principia's "plotting frames". Pure; no DOM, no three.js.
 *
 * Every frame is given by a time-dependent origin o(t) and orthonormal axes
 * R(t) (rows are the frame's x, y, z axes expressed in ICRF). A point p(t) in
 * ICRF has frame coordinates q = R(t) (p(t) - o(t)). A trajectory is drawn by
 * transforming each sample with the frame AT THAT SAMPLE'S TIME; the scene is
 * then rendered in frame coordinates, so the camera lives in the frame too
 * (in a rotating frame the picture holds still while the axes turn).
 *
 *  - barycentric: origin at the barycentre of the listed bodies, ecliptic J2000 axes.
 *  - inertial:    origin at one body, non-rotating; z along the body's north
 *                 rotation pole (from BodySnapshot.pole, taken at a fixed
 *                 epoch so the axes do not turn), x along the ascending node of
 *                 the body's equator on the ecliptic, y = z × x. Without a
 *                 pole (no rotation model, or the Sun) the axes are ecliptic.
 *  - rotating:    origin at `center`; x toward `secondary`; z along the
 *                 secondary's orbital angular momentum about the centre; y = z × x.
 *
 * The axes of inertial frames only choose what is "up" on screen (frame z):
 * ecliptic north for the barycentre and the Sun, the body's north pole for a
 * body-centred frame. That is a fixed rotation and changes nothing physical.
 */

export type FrameSpec =
  | { kind: 'barycentric' }
  | { kind: 'inertial'; center: number }
  | { kind: 'rotating'; center: number; secondary: number }
  /** Body-fixed: origin at the body, axes turning with its surface (a geostationary satellite is a fixed point). */
  | { kind: 'surface'; center: number };

/**
 * Body orientation for surface frames: writes the body-fixed -> ICRF rotation
 * (row-major) at TDB t into out and returns the spin rate about the body's
 * pole in rad/s, or NaN when the body has no rotation model.
 */
export type Orientation = (body: number, t: number, out: Float64Array) => number;

/** Obliquity of the ecliptic at J2000 (IAU 2006), 84381.406 arcsec. */
export const OBLIQUITY_J2000 = (84381.406 / 3600) * (Math.PI / 180);

/** ICRF -> ecliptic J2000 rotation, rows = ecliptic axes in ICRF. */
export const ECLIPTIC_AXES: readonly number[] = (() => {
  const c = Math.cos(OBLIQUITY_J2000);
  const s = Math.sin(OBLIQUITY_J2000);
  return [1, 0, 0, 0, c, s, 0, -s, c];
})();

export interface FrameState {
  /** Origin position and velocity in ICRF. */
  readonly origin: Float64Array; // 3
  readonly originVel: Float64Array; // 3
  /** Rows are frame axes in ICRF (row-major 3x3). */
  readonly axes: Float64Array; // 9
  /** Angular velocity of the axes, ICRF, rad/s (zero for inertial frames). */
  readonly omega: Float64Array; // 3
}

export function newFrameState(): FrameState {
  return { origin: new Float64Array(3), originVel: new Float64Array(3), axes: new Float64Array(9), omega: new Float64Array(3) };
}

/** Instantaneous body states for computing a frame: pos/vel are 3*count, gm per body. */
export interface BodySnapshot {
  readonly count: number;
  readonly pos: ArrayLike<number>;
  readonly vel: ArrayLike<number>;
  readonly gm: ArrayLike<number>;
  /** Time and orientation provider, needed only by surface frames. */
  readonly t?: number;
  readonly orient?: Orientation;
  /**
   * Display pole for body-centred inertial frames: writes the body's north
   * pole (unit, ICRF) into out and returns true, or false to use ecliptic
   * axes. Must not depend on the snapshot time, or the frame would turn.
   */
  readonly pole?: (body: number, out: Float64Array) => boolean;
}

const ORIENT_TMP = new Float64Array(9);
const POLE_TMP = new Float64Array(3);

/** Rows of pole-up axes: z = pole, x = ecliptic north × pole (the equator's ascending node on the ecliptic), y = z × x. False if degenerate. */
export function poleAxes(p: ArrayLike<number>, out: Float64Array): boolean {
  const n = ECLIPTIC_AXES;
  const ez0 = n[6], ez1 = n[7], ez2 = n[8];
  const pl = Math.hypot(p[0], p[1], p[2]);
  if (!(pl > 0)) return false;
  const z0 = p[0] / pl, z1 = p[1] / pl, z2 = p[2] / pl;
  let x0 = ez1 * z2 - ez2 * z1, x1 = ez2 * z0 - ez0 * z2, x2 = ez0 * z1 - ez1 * z0;
  const xl = Math.hypot(x0, x1, x2);
  if (!(xl > 1e-9)) return false;
  x0 /= xl; x1 /= xl; x2 /= xl;
  out[0] = x0; out[1] = x1; out[2] = x2;
  out[3] = z1 * x2 - z2 * x1; out[4] = z2 * x0 - z0 * x2; out[5] = z0 * x1 - z1 * x0;
  out[6] = z0; out[7] = z1; out[8] = z2;
  return true;
}

export function computeFrame(spec: FrameSpec, s: BodySnapshot, out: FrameState): FrameState {
  const { origin, originVel, axes, omega } = out;
  omega.fill(0);
  if (spec.kind === 'barycentric') {
    let m = 0;
    origin.fill(0);
    originVel.fill(0);
    for (let i = 0; i < s.count; i++) {
      const g = s.gm[i];
      m += g;
      for (let k = 0; k < 3; k++) {
        origin[k] += g * s.pos[3 * i + k];
        originVel[k] += g * s.vel[3 * i + k];
      }
    }
    for (let k = 0; k < 3; k++) {
      origin[k] /= m;
      originVel[k] /= m;
    }
    axes.set(ECLIPTIC_AXES);
    return out;
  }
  const c = spec.center;
  for (let k = 0; k < 3; k++) {
    origin[k] = s.pos[3 * c + k];
    originVel[k] = s.vel[3 * c + k];
  }
  if (spec.kind === 'inertial') {
    if (!(s.pole && s.pole(c, POLE_TMP) && poleAxes(POLE_TMP, axes))) axes.set(ECLIPTIC_AXES);
    return out;
  }
  if (spec.kind === 'surface') {
    const m = ORIENT_TMP;
    const rate = s.orient && s.t !== undefined ? s.orient(c, s.t, m) : NaN;
    if (!Number.isFinite(rate)) throw new Error('surface frame undefined: no rotation model for this body');
    // Rows of the frame = body axes in ICRF = columns of body->ICRF.
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) axes[3 * r + k] = m[3 * k + r];
    // Spin about the pole (third body axis); pole precession is neglected.
    omega[0] = rate * m[2];
    omega[1] = rate * m[5];
    omega[2] = rate * m[8];
    return out;
  }
  const j = spec.secondary;
  const rx = s.pos[3 * j] - origin[0];
  const ry = s.pos[3 * j + 1] - origin[1];
  const rz = s.pos[3 * j + 2] - origin[2];
  const vx = s.vel[3 * j] - originVel[0];
  const vy = s.vel[3 * j + 1] - originVel[1];
  const vz = s.vel[3 * j + 2] - originVel[2];
  const r2 = rx * rx + ry * ry + rz * rz;
  const r = Math.sqrt(r2);
  // h = r x v
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const h = Math.hypot(hx, hy, hz);
  if (!(r > 0) || !(h > 0)) throw new Error('rotating frame undefined: secondary coincides with or moves radially from centre');
  const xx = rx / r, xy = ry / r, xz = rz / r;
  const zx = hx / h, zy = hy / h, zz = hz / h;
  axes[0] = xx; axes[1] = xy; axes[2] = xz;
  axes[3] = zy * xz - zz * xy; axes[4] = zz * xx - zx * xz; axes[5] = zx * xy - zy * xx;
  axes[6] = zx; axes[7] = zy; axes[8] = zz;
  // The x axis turns about h at |h|/r^2; the axes also tilt slowly as h changes, which we neglect (it needs the acceleration).
  omega[0] = hx / r2;
  omega[1] = hy / r2;
  omega[2] = hz / r2;
  return out;
}

/** q = R (p - o). p and out may alias. */
export function toFrame(f: FrameState, p: ArrayLike<number>, pi: number, out: Float64Array | number[], oi: number): void {
  const a = f.axes;
  const dx = p[pi] - f.origin[0];
  const dy = p[pi + 1] - f.origin[1];
  const dz = p[pi + 2] - f.origin[2];
  out[oi] = a[0] * dx + a[1] * dy + a[2] * dz;
  out[oi + 1] = a[3] * dx + a[4] * dy + a[5] * dz;
  out[oi + 2] = a[6] * dx + a[7] * dy + a[8] * dz;
}

/** p = o + R^T q. */
export function fromFrame(f: FrameState, q: ArrayLike<number>, qi: number, out: Float64Array | number[], oi: number): void {
  const a = f.axes;
  const x = q[qi], y = q[qi + 1], z = q[qi + 2];
  out[oi] = f.origin[0] + a[0] * x + a[3] * y + a[6] * z;
  out[oi + 1] = f.origin[1] + a[1] * x + a[4] * y + a[7] * z;
  out[oi + 2] = f.origin[2] + a[2] * x + a[5] * y + a[8] * z;
}

/** Velocity in frame coordinates: R (v - vo - omega x (p - o)). */
export function velocityToFrame(f: FrameState, p: ArrayLike<number>, v: ArrayLike<number>, out: Float64Array | number[]): void {
  const dx = p[0] - f.origin[0], dy = p[1] - f.origin[1], dz = p[2] - f.origin[2];
  const w = f.omega;
  const ux = v[0] - f.originVel[0] - (w[1] * dz - w[2] * dy);
  const uy = v[1] - f.originVel[1] - (w[2] * dx - w[0] * dz);
  const uz = v[2] - f.originVel[2] - (w[0] * dy - w[1] * dx);
  const a = f.axes;
  out[0] = a[0] * ux + a[1] * uy + a[2] * uz;
  out[1] = a[3] * ux + a[4] * uy + a[5] * uz;
  out[2] = a[6] * ux + a[7] * uy + a[8] * uz;
}

/** The body whose distance/speed readouts are relative to (null = barycentre). */
export function frameCenter(spec: FrameSpec): number | null {
  return spec.kind === 'barycentric' ? null : spec.center;
}

export function frameLabel(spec: FrameSpec, name: (i: number) => string): string {
  switch (spec.kind) {
    case 'barycentric':
      return 'Inertial, centred on the Solar System barycentre';
    case 'inertial':
      return `Inertial, centred on ${name(spec.center)}`;
    case 'surface':
      return `Rotating with ${name(spec.center)}'s surface`;
    case 'rotating':
      return `Rotating with the ${name(spec.center)} to ${name(spec.secondary)} line`;
  }
}

/** One-line explanation of a frame, for the View panel. */
export function frameExplain(spec: FrameSpec, name: (i: number) => string): string {
  switch (spec.kind) {
    case 'barycentric':
      return 'Fixed stars do not turn; the Sun wobbles slightly about the centre of mass. Good for interplanetary flights.';
    case 'inertial':
      return `${name(spec.center)} stays at the centre and the stars stay still; orbits around it are closed ellipses.`;
    case 'surface':
      return `Turns with ${name(spec.center)}: the ground stands still, a geostationary satellite is a fixed point and a low orbit traces its ground track.`;
    case 'rotating':
      return `${name(spec.center)} at the centre and ${name(spec.secondary)} held still on one axis: shows transfers and flybys between the two.`;
  }
}

/**
 * Compact string form for URLs and <select> values, by body id so it survives
 * changes to the body list: "bary", "in:earth", "rot:earth:moon".
 */
export function frameKey(spec: FrameSpec, id: (i: number) => string): string {
  switch (spec.kind) {
    case 'barycentric':
      return 'bary';
    case 'inertial':
      return `in:${id(spec.center)}`;
    case 'rotating':
      return `rot:${id(spec.center)}:${id(spec.secondary)}`;
    case 'surface':
      return `fix:${id(spec.center)}`;
  }
}

/** Inverse of frameKey; indexOf returns -1 for unknown ids. */
export function parseFrameKey(key: string, indexOf: (id: string) => number): FrameSpec | null {
  if (key === 'bary') return { kind: 'barycentric' };
  const parts = key.split(':');
  const idx = parts.slice(1).map(indexOf);
  if (idx.some((i) => i < 0)) return null;
  if (parts[0] === 'in' && idx.length === 1) return { kind: 'inertial', center: idx[0] };
  if (parts[0] === 'fix' && idx.length === 1) return { kind: 'surface', center: idx[0] };
  if (parts[0] === 'rot' && idx.length === 2 && idx[0] !== idx[1]) return { kind: 'rotating', center: idx[0], secondary: idx[1] };
  return null;
}

export function sameFrame(a: FrameSpec, b: FrameSpec): boolean {
  const k = (i: number) => String(i);
  return frameKey(a, k) === frameKey(b, k);
}
