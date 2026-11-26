/** Messages between the main thread and the physics worker. Buffers are transferred, not copied. */

export type ToWorker =
  /** Chunk range the viewer needs now (built first, in order outward from the epoch). */
  { type: 'want'; lo: number; hi: number };

export interface MissionInfo {
  name: string;
  /** Burn ignition and cutoff, TDB s from J2000. */
  burnStart: number;
  burnEnd: number;
  launch: number;
  end: number;
  /** Achieved delta-v, m/s, and closest lunar approach found, m. */
  deltaV: number;
  closestApproach: number;
  closestApproachTime: number;
  /** Bodies the mission is relative to (indices into the body list). */
  center: number;
  target: number;
  /** Wall time spent propagating the final trajectory, and the timing search, ms. */
  propagateMs: number;
  searchMs: number;
  steps: number;
}

export type FromWorker =
  | { type: 'chunk'; k: number; coeffs: Float64Array; ms: number }
  | { type: 'mission'; samples: Float64Array; info: MissionInfo }
  | { type: 'idle' }
  | { type: 'error'; message: string };
