/**
 * The app's UI state in one small observable store: the view (time, frame,
 * focus) and the flight-plan editor (the plan itself, selection, the latest
 * replay). Panels and the renderer read it and call `set`. Per-frame values
 * (camera, positions) are deliberately not in it.
 */
import type { FrameSpec } from './frames';
import type { Evaluation, MissionPlan, ReplayResult } from './mission-layer';
import type { ManeuverNode } from './nodes';

export interface ViewState {
  /** Simulation time, TDB seconds from J2000. */
  t: number;
  paused: boolean;
  /** Index into WARP_RATES. */
  warpIndex: number;
  focus: number;
  frame: FrameSpec;
  /** Time the viewer is waiting for chunks to reach (null when not waiting). */
  loadingTarget: number | null;
  /** Chunks still missing before the target is shown. */
  loadingChunks: number;
}

/** A finished replay of the current (or a recent) plan, as drawn and scored. */
export interface ReplayView {
  /** Plan the result belongs to (identity: compare with EditorState.plan). */
  plan: MissionPlan;
  result: ReplayResult;
  evaluation: Evaluation | null;
  /** t x y z vx vy vz mass per sample (REPLAY_SAMPLE_STRIDE). */
  samples: Float64Array;
  /** Replay wall time in the worker, ms; edit-to-result latency, ms. */
  replayMs: number;
  latencyMs: number;
  /** Non-null for a preview: only the first `preview` seconds were flown; the full replay is coming. Not scored. */
  preview: number | null;
}

export interface EditorState {
  missionId: string;
  plan: MissionPlan;
  /** Disabled nodes, kept outside the plan (editor-only). */
  parked: readonly ManeuverNode[];
  selectedNode: number | null;
  /** Index into the replay's events. */
  selectedEvent: number | null;
  replay: ReplayView | null;
  /** 'running': a replay of the current plan is in flight; 'chunks': waiting for the ephemeris span. */
  replayStatus: 'idle' | 'running' | 'chunks';
  /** Problem loading a shared link or saved plan (shown until dismissed). */
  notice: string | null;
}

export type AppState = ViewState & EditorState;

/** Simulated seconds per real second. Real time up to ~3 years per second. */
export const WARP_RATES: readonly number[] = [1, 10, 100, 1e3, 1e4, 86400 / 4, 86400, 7 * 86400, 30 * 86400, 0.25 * 365.25 * 86400, 365.25 * 86400, 3 * 365.25 * 86400];

export type Listener<S> = (state: S, prev: S) => void;

export class Store<S extends object> {
  private state: S;
  private readonly listeners = new Set<Listener<S>>();

  constructor(initial: S) {
    this.state = initial;
  }

  get(): Readonly<S> {
    return this.state;
  }

  set(patch: Partial<S>): void {
    const prev = this.state;
    let changed = false;
    for (const k in patch) {
      if (!Object.is(prev[k], patch[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...prev, ...patch };
    for (const l of this.listeners) l(this.state, prev);
  }

  subscribe(l: Listener<S>): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
