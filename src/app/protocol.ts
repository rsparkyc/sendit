/** Messages between the main thread and the physics worker. Buffers are transferred, not copied. */

export type ToWorker =
  /** Build chunk k (and post it, plus any intermediate chunks it needed). */
  { type: 'build'; k: number };

export type FromWorker =
  | { type: 'chunk'; k: number; coeffs: Float64Array; ms: number }
  /** Finished the build request for k. */
  | { type: 'done'; k: number }
  | { type: 'error'; message: string; k?: number };

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

// ---------------------------------------------------------------------------
// Planner worker (planner-worker.ts): porkchop grids, departure burns, the
// differential corrector and flyby-chain checks. Advisory: it returns plans
// whose new burns are ordinary nodes, plus measurements from the real replay.

export interface PorkchopRequest {
  departure: string;
  arrival: string;
  depStart: number;
  depEnd: number;
  nDep: number;
  arrStart: number;
  arrEnd: number;
  nArr: number;
}

export interface FlybyTarget {
  body: string;
  /** Requested closest-approach altitude, m. */
  altitude: number;
  /** B-plane side, deg (see transfer.ts PassSide); null keeps the current side. */
  theta: number | null;
  /** Lambert arrival time (s TDB) when refining a fresh departure; enables the position stage. */
  tArr: number | null;
}

export interface StageReport {
  label: string;
  converged: boolean;
  /** Final miss of that stage, m. */
  miss: number;
  iterations: number;
  evaluations: number;
  ms: number;
}

export type ToPlanner =
  | { type: 'chunks'; chunks: { k: number; coeffs: Float64Array }[] }
  | { type: 'porkchop'; id: number; req: PorkchopRequest }
  | { type: 'cancel'; id: number }
  | { type: 'departure'; id: number; plan: import('./mission-layer').MissionPlan; departure: string; vInf: number[]; tDep: number; tArr: number }
  | { type: 'correct'; id: number; plan: import('./mission-layer').MissionPlan; missionId: string; burn: number; target: FlybyTarget }
  | { type: 'chain'; id: number; seq: string[]; times: number[]; windowDays: number | null };

export type FromPlanner =
  | { type: 'ready' }
  | { type: 'progress'; id: number; done: number; total: number; label: string }
  | {
      type: 'porkchop';
      id: number;
      ms: number;
      grid: { nDep: number; nArr: number; depTimes: Float64Array; arrTimes: Float64Array; c3: Float64Array; vInfArr: Float64Array; dvTotal: Float64Array; dla: Float64Array; rla: Float64Array; theta: Float64Array; vInfDep: Float64Array };
    }
  | { type: 'departure'; id: number; plan: import('./mission-layer').MissionPlan; index: number; dv: number; asymptoteErrorDeg: number; tImpulse: number; ms: number; warning: string | null; split: { plan: import('./mission-layer').MissionPlan; first: number; second: number } | null }
  | {
      type: 'correct';
      id: number;
      ok: boolean;
      message: string;
      plan: import('./mission-layer').MissionPlan | null;
      stages: StageReport[];
      /** Closest approach measured in the real replay of the corrected plan. */
      measured: { t: number; altitude: number; speed: number; impact: boolean; outcome: string } | null;
      /** Corrector's own prediction (for comparison), m altitude. */
      predicted: number | null;
      ms: number;
    }
  | { type: 'chain'; id: number; times: number[]; result: import('./planning-layer').ChainResult; evaluations: number; ms: number }
  | { type: 'error'; id: number; message: string };
