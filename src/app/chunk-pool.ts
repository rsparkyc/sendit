/**
 * Main-thread side of the ephemeris chunk pool: a few workers (worker.ts)
 * building chunks in parallel from the checkpoint asset, a scheduler
 * (schedule.ts) choosing what to build from the view time, warp, flight span
 * and explicit coverage requests, and eviction under a memory budget.
 *
 * `require(ta, tb)` is how long computations (porkchop, corrector) get body
 * positions over their whole date range: it pins the range (built first,
 * never evicted while pinned) and resolves once every chunk is installed, so
 * the caller waits without blocking the page; the returned release unpins.
 */
import type { Ephemeris } from './physics';
import { assetChunkRange } from './physics';
import type { FromWorker, ToWorker } from './protocol';
import { chunksMissing, chunksToEvict, EMPTY, nextChunks, outsideAsset, poolSizing, type ChunkRange } from './schedule';

interface Slot {
  worker: Worker;
  busy: number | null;
}

interface Pin {
  range: ChunkRange;
  resolve: (() => void) | null;
  onProgress?: (missing: number, total: number) => void;
}

export interface ViewWant {
  /** Chunk index of the view time or jump target. */
  view: number;
  direction: -1 | 0 | 1;
  /** Chunks of look-ahead in the warp direction. */
  ahead: number;
  flight: ChunkRange;
}

export class ChunkPool {
  private readonly slots: Slot[] = [];
  private readonly asset: ChunkRange;
  private readonly pins = new Set<Pin>();
  private wantState: ViewWant = { view: 0, direction: 0, ahead: 0, flight: EMPTY };
  readonly budget: number;
  readonly stats = { built: 0, evicted: 0, buildMs: [] as number[] };

  constructor(
    private readonly eph: Ephemeris,
    private readonly limit: ChunkRange,
    private readonly hooks: { onInstall(): void; onError(message: string): void },
    sizing = poolSizing(navigator.hardwareConcurrency, (navigator as { deviceMemory?: number }).deviceMemory),
  ) {
    this.budget = sizing.budget;
    this.asset = assetChunkRange(eph.chunkSpan);
    for (let i = 0; i < sizing.workers; i++) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { worker, busy: null };
      worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(slot, ev.data);
      worker.onerror = (e) => hooks.onError(`chunk worker failed to load: ${e.message}`);
      this.slots.push(slot);
    }
  }

  get workers(): number {
    return this.slots.length;
  }

  /** Update what the viewer needs; schedules builds into free workers. */
  want(w: ViewWant): void {
    this.wantState = w;
    this.pump();
  }

  /** Resolve when [ta, tb] is fully installed; the range stays pinned until `release` is called. */
  require(ta: number, tb: number, onProgress?: (missing: number, total: number) => void): { ready: Promise<void>; release: () => void } {
    const range = { lo: this.eph.chunkIndex(Math.min(ta, tb)), hi: this.eph.chunkIndex(Math.max(ta, tb)) };
    const pin: Pin = { range, resolve: null, onProgress };
    const ready = new Promise<void>((res) => (pin.resolve = res));
    this.pins.add(pin);
    this.check();
    this.pump();
    return { ready, release: () => { this.pins.delete(pin); } };
  }

  /** Chunks of `range` not yet installed. */
  missing(range: ChunkRange): number {
    return chunksMissing(new Set(this.eph.chunks()), range);
  }

  private check(): void {
    if (this.pins.size === 0) return;
    const have = new Set(this.eph.chunks());
    for (const p of this.pins) {
      if (!p.resolve) continue;
      const miss = chunksMissing(have, p.range);
      p.onProgress?.(miss, p.range.hi - p.range.lo + 1);
      if (miss === 0) {
        const r = p.resolve;
        p.resolve = null;
        r();
      }
    }
  }

  private pump(): void {
    const free = this.slots.filter((s) => s.busy === null);
    if (free.length === 0) return;
    const inFlight = new Set(this.slots.filter((s) => s.busy !== null).map((s) => s.busy!));
    const w = this.wantState;
    const have = new Set(this.eph.chunks());
    // Pinned ranges that are still waiting; also bounded by the budget.
    const pinned = [...this.pins].filter((p) => p.resolve).map((p) => p.range);
    const ks = nextChunks({
      have, inFlight, view: w.view, direction: w.direction, ahead: w.ahead, flight: w.flight, pinned,
      radius: 3, limit: this.limit, slots: free.length + 2, maxFlight: Math.floor(this.budget / 2),
    });
    // Outside the asset, chunks integrate from a neighbour: only worker 0, one at a time.
    const outsideBusy = [...inFlight].some((k) => outsideAsset(k, this.asset));
    for (const k of ks) {
      let slot: Slot | undefined;
      if (outsideAsset(k, this.asset)) {
        if (outsideBusy || this.slots[0].busy !== null) continue;
        slot = this.slots[0];
      } else slot = this.slots.slice(1).find((s) => s.busy === null) ?? (this.slots[0].busy === null ? this.slots[0] : undefined);
      if (!slot) continue;
      slot.busy = k;
      slot.worker.postMessage({ type: 'build', k } satisfies ToWorker);
    }
  }

  private evict(): void {
    const have = this.eph.chunks();
    if (have.length <= this.budget) return;
    const w = this.wantState;
    const keep: ChunkRange[] = [{ lo: w.view - 3, hi: w.view + 3 }, ...[...this.pins].map((p) => p.range)];
    if (w.direction !== 0) keep.push(w.direction > 0 ? { lo: w.view, hi: w.view + w.ahead } : { lo: w.view - w.ahead, hi: w.view });
    const f = w.flight;
    if (f.hi - f.lo + 1 <= this.budget / 2) keep.push(f);
    const drop = chunksToEvict({ have, view: w.view, keep, budget: this.budget });
    if (drop.length) {
      this.stats.evicted += this.eph.evict(drop);
      this.hooks.onInstall();
    }
  }

  /** Install a chunk that arrived from elsewhere (replay worker). */
  installed(): void {
    this.evict();
    this.check();
  }

  private onMessage(slot: Slot, m: FromWorker): void {
    if (m.type === 'chunk') {
      if (this.eph.install(m.k, m.coeffs)) {
        this.stats.built++;
        if (m.ms > 0) {
          this.stats.buildMs.push(m.ms);
          if (this.stats.buildMs.length > 100) this.stats.buildMs.shift();
        }
        this.hooks.onInstall();
      }
      return;
    }
    if (m.type === 'error') this.hooks.onError(m.message);
    if (m.type === 'done' || (m.type === 'error' && m.k !== undefined)) {
      slot.busy = null;
      this.evict();
      this.check();
      this.pump();
    }
  }
}
