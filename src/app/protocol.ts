/** Messages between the main thread and the physics worker. Buffers are transferred, not copied. */

export type ToWorker =
  /** Chunk range the viewer needs now (built first, in order outward from the epoch). */
  { type: 'want'; lo: number; hi: number };

export type FromWorker =
  | { type: 'chunk'; k: number; coeffs: Float64Array; ms: number }
  | { type: 'idle' }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Replay worker (replay-worker.ts): runs the mission layer's replay, the same
// function that scores a flight, and returns its result with trajectory samples.

export type ToReplay =
  /** Chunks the main thread already has (a respawned worker starts with these). */
  | { type: 'chunks'; chunks: { k: number; coeffs: Float64Array }[] }
  | { type: 'run'; id: number; plan: import('./mission-layer').MissionPlan; missionId: string };

export type FromReplay =
  | { type: 'ready' }
  /** A chunk this worker built (from the checkpoint asset) for a flight's span. */
  | { type: 'chunk'; k: number; coeffs: Float64Array }
  /** Run `id` has its ephemeris span and is now propagating. */
  | { type: 'replaying'; id: number; chunkMs: number }
  | {
      type: 'result';
      id: number;
      result: import('./mission-layer').ReplayResult;
      evaluation: import('./mission-layer').Evaluation | null;
      samples: Float64Array;
      ms: number;
      /** Non-null for a preview: the plan was flown only to this mission time (s), not scored. */
      preview: number | null;
    }
  | { type: 'error'; id: number; message: string };
