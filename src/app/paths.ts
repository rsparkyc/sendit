/**
 * Body paths and spacecraft trajectories in a plotting frame, as float64
 * point lists, and their split into locally-anchored float32 segments for the
 * GPU. Pure: takes an evaluator callback rather than the ephemeris itself.
 */
import { computeFrame, newFrameState, toFrame, type FrameSpec, type FrameState, type Orientation } from './frames';
import { SAMPLE_STRIDE, type Trajectory } from './trajectory';

/** Positions and velocities of all bodies at t; false if not available. */
export type Evaluator = (t: number, pos: Float64Array, vel: Float64Array) => boolean;

export interface FrameContext {
  readonly count: number;
  readonly gm: ArrayLike<number>;
  readonly evaluate: Evaluator;
  /** Body orientation, for surface-fixed frames. */
  readonly orient?: Orientation;
}

/** Points (3 per sample) in frame coordinates, plus the sample times. */
export interface FramePath {
  readonly points: Float64Array;
  readonly times: Float64Array;
}

function scratch(ctx: FrameContext) {
  return { pos: new Float64Array(3 * ctx.count), vel: new Float64Array(3 * ctx.count), fs: newFrameState() };
}

/** Frame state at t, or null if the ephemeris does not cover t. */
export function frameAt(ctx: FrameContext, spec: FrameSpec, t: number, s = scratch(ctx)): FrameState | null {
  if (!ctx.evaluate(t, s.pos, s.vel)) return null;
  return computeFrame(spec, { count: ctx.count, pos: s.pos, vel: s.vel, gm: ctx.gm, t, orient: ctx.orient }, s.fs);
}

/**
 * Path of body `body` over [ta, tb] with n+1 evenly spaced samples, each
 * transformed with the frame at its own time. Samples the ephemeris cannot
 * evaluate are dropped (so the caller may pass an unclipped window).
 */
export function bodyPath(ctx: FrameContext, spec: FrameSpec, body: number, ta: number, tb: number, n: number): FramePath {
  const s = scratch(ctx);
  const pts: number[] = [];
  const ts: number[] = [];
  const q = [0, 0, 0];
  for (let i = 0; i <= n; i++) {
    const t = ta + ((tb - ta) * i) / n;
    if (!ctx.evaluate(t, s.pos, s.vel)) continue;
    computeFrame(spec, { count: ctx.count, pos: s.pos, vel: s.vel, gm: ctx.gm, t, orient: ctx.orient }, s.fs);
    toFrame(s.fs, s.pos, 3 * body, q, 0);
    pts.push(q[0], q[1], q[2]);
    ts.push(t);
  }
  return { points: Float64Array.from(pts), times: Float64Array.from(ts) };
}

/** Every trajectory sample in the frame (samples outside ephemeris coverage are dropped). */
export function trajectoryPath(ctx: FrameContext, spec: FrameSpec, tr: Trajectory): FramePath {
  const s = scratch(ctx);
  const pts = new Float64Array(3 * tr.n);
  const ts = new Float64Array(tr.n);
  let m = 0;
  for (let i = 0; i < tr.n; i++) {
    const o = i * SAMPLE_STRIDE;
    const t = tr.data[o];
    if (!ctx.evaluate(t, s.pos, s.vel)) continue;
    computeFrame(spec, { count: ctx.count, pos: s.pos, vel: s.vel, gm: ctx.gm, t, orient: ctx.orient }, s.fs);
    toFrame(s.fs, tr.data, o + 1, pts, 3 * m);
    ts[m] = t;
    m++;
  }
  return { points: pts.slice(0, 3 * m), times: ts.slice(0, m) };
}

export interface AnchoredSegment {
  /** Float64 anchor in frame coordinates, m. */
  readonly anchor: Float64Array;
  /** Vertices relative to the anchor, in render units (km), float32. */
  readonly verts: Float32Array;
}

/**
 * Split a polyline into segments of at most `maxVerts` vertices, each stored
 * relative to its own first point. Float32 error is then relative to the
 * segment's extent, not to the distance from the frame origin. Consecutive
 * segments share an endpoint so the line is unbroken.
 */
export function anchorSegments(points: Float64Array, unit: number, maxVerts = 256): AnchoredSegment[] {
  const n = points.length / 3;
  const out: AnchoredSegment[] = [];
  if (n < 2) return out;
  for (let start = 0; start < n - 1; start += maxVerts - 1) {
    const end = Math.min(n, start + maxVerts);
    const anchor = Float64Array.from(points.subarray(3 * start, 3 * start + 3));
    const verts = new Float32Array(3 * (end - start));
    for (let i = start; i < end; i++) {
      for (let k = 0; k < 3; k++) verts[3 * (i - start) + k] = (points[3 * i + k] - anchor[k]) / unit;
    }
    out.push({ anchor, verts });
  }
  return out;
}
