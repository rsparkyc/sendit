/**
 * J / K: move the time cursor back / forward at the current warp rate while
 * the key is held (per animation frame), stopping on release. A tap moves at
 * least TAP_SECONDS of real time's worth (rate × 0.1 s). Pressing either pauses
 * playback and does not resume it. The cursor is clamped to the flight span
 * exactly as the timeline scrubber is (plan epoch … end of flight).
 * Window blur or the tab being hidden releases the key, so it cannot stick.
 */
import type { AppState, Store } from './store';
import { WARP_RATES } from './store';

/** Real seconds a single tap is worth. */
export const TAP_SECONDS = 0.1;
/** Longest real-time slice applied in one frame (a stalled frame must not leap). */
const MAX_FRAME = 0.25;

/** New cursor time after `realSeconds` of motion in direction `dir` at `rate` sim s per real s, clamped to [a, b]. */
export function stepTime(t: number, dir: -1 | 1, rate: number, realSeconds: number, span: readonly [number, number]): number {
  const n = t + dir * rate * realSeconds;
  return Math.max(span[0], Math.min(span[1], n));
}

export class TimeKeys {
  private dir: -1 | 1 | 0 = 0;
  private moved = 0; // real seconds applied so far for this press
  private last = 0;
  private raf = 0;

  constructor(private readonly store: Store<AppState>, private readonly span: () => [number, number], private readonly now: () => number = () => performance.now()) {
    const release = () => this.release(false);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
    window.addEventListener('keyup', (e) => {
      if ((e.code === 'KeyJ' && this.dir === -1) || (e.code === 'KeyK' && this.dir === 1)) this.release(true);
    });
  }

  get held(): boolean {
    return this.dir !== 0;
  }

  /** A J (-1) or K (+1) keydown. Repeats of the held key are ignored. */
  press(dir: -1 | 1): void {
    if (this.dir === dir) return;
    if (this.dir !== 0) this.release(false);
    this.dir = dir;
    this.last = this.now();
    this.moved = 0;
    if (!this.store.get().paused) this.store.set({ paused: true });
    this.raf = requestAnimationFrame(() => this.frame());
  }

  /** Stop; with `topUp`, a press shorter than a tap still moves a whole tap. */
  release(topUp: boolean): void {
    if (this.dir === 0) return;
    if (topUp && this.moved < TAP_SECONDS) this.apply(TAP_SECONDS - this.moved);
    this.dir = 0;
    cancelAnimationFrame(this.raf);
  }

  private frame(): void {
    if (this.dir === 0) return;
    const now = this.now();
    const dt = Math.min(MAX_FRAME, (now - this.last) / 1000);
    this.last = now;
    if (dt > 0) this.apply(dt);
    this.raf = requestAnimationFrame(() => this.frame());
  }

  private apply(realSeconds: number): void {
    if (this.dir === 0) return;
    this.moved += realSeconds;
    const s = this.store.get();
    const from = s.loadingTarget ?? s.t;
    const t = stepTime(from, this.dir, WARP_RATES[s.warpIndex], realSeconds, this.span());
    if (t !== from) this.store.set({ t, paused: true, loadingTarget: t });
  }
}
