/**
 * The viewer's UI state in one small observable store. Anything a future UI
 * framework would bind to lives here; the renderer and HUD read it and call
 * `set`. Per-frame values (camera, positions) are deliberately not in it.
 */
import type { FrameSpec } from './frames';

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
