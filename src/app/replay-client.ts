/**
 * Main-thread side of the replay worker: debounces edits, keeps one replay in
 * flight, cancels and measures.
 *
 * Every plan change calls `request(plan)`. After a short debounce the newest
 * plan is posted. While a run is in flight, newer requests wait and only the
 * newest is flown next (intermediate drag positions are skipped). If a run
 * has been propagating for longer than CANCEL_AFTER_MS when a newer edit
 * arrives, it is cancelled by terminating the worker; a spare worker, seeded
 * with the main thread's chunks, takes over at once. (replay is synchronous
 * and exposes no abort signal, so termination is the only way to stop it
 * mid-flight without SharedArrayBuffer; see the report.)
 *
 * Latency is measured from the edit (request time) to the moment the result
 * has been handed to the store, i.e. what the player waits for.
 */
import type { Evaluation, MissionPlan, ReplayResult } from './mission-layer';
import type { Ephemeris } from './physics';
import type { FromReplay, ToReplay } from './protocol';

export const DEBOUNCE_MS = 12;
export const CANCEL_AFTER_MS = 150;
/** Consecutive broken workers replaced before the client gives up (a worker that cannot load at all). */
const MAX_WORKER_FAILURES = 3;

export interface ReplayDelivery {
  plan: MissionPlan;
  result: ReplayResult;
  evaluation: Evaluation | null;
  samples: Float64Array;
  replayMs: number;
  latencyMs: number;
  /** True if a newer plan is already waiting (this result is for an older edit). */
  stale: boolean;
  /** Non-null for a preview (prefix of the flight to this mission time); the full replay follows. */
  preview: number | null;
}

export interface ReplayClientHooks {
  onResult(d: ReplayDelivery): void;
  onChunk(k: number, coeffs: Float64Array): void;
  onStatus(s: 'idle' | 'running' | 'chunks'): void;
  onError(message: string): void;
}

interface Job {
  id: number;
  plan: MissionPlan;
  missionId: string;
  requestedAt: number;
}

export class ReplayClient {
  private worker: Worker;
  private spare: Worker | null = null;
  private nextId = 1;
  private inFlight: (Job & { replayingSince: number | null }) | null = null;
  private queued: Job | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  readonly stats = { runs: 0, cancels: 0, lastLatencyMs: 0, lastReplayMs: 0, latencies: [] as number[] };

  constructor(
    private readonly eph: Ephemeris,
    private readonly hooks: ReplayClientHooks,
  ) {
    this.worker = this.spawn();
    this.spare = this.spawn();
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./replay-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<FromReplay>) => this.onMessage(w, ev.data);
    w.onerror = (e) => {
      e.preventDefault?.();
      this.workerFailed(w, `replay worker failed: ${e.message || 'could not load or crashed'}`);
    };
    w.onmessageerror = () => this.workerFailed(w, 'replay worker: a message could not be read');
    return w;
  }

  /**
   * A worker broke outside a run's own try/catch (failed to load, uncaught error, unreadable message).
   * It will never answer, so the run in flight is reported as failed and the worker replaced; without
   * this the status stayed 'chunks' or 'running' for good. A broken spare is just replaced.
   */
  private workerFailed(w: Worker, message: string): void {
    this.hooks.onError(message);
    w.terminate();
    if (w === this.spare) {
      this.spare = null;
      return;
    }
    if (w !== this.worker) return;
    this.inFlight = null;
    // A worker that cannot even load would fail again at once: replace it a few times, then stop.
    if (++this.failures > MAX_WORKER_FAILURES) {
      this.queued = null;
      this.hooks.onStatus('idle');
      return;
    }
    this.worker = this.spare ?? this.spawn();
    this.spare = null;
    if (this.queued) this.dispatch();
    else this.hooks.onStatus('idle');
  }

  /** Request a replay of `plan` (debounced; the newest request wins). */
  request(plan: MissionPlan, missionId: string): void {
    this.queued = { id: this.nextId++, plan, missionId, requestedAt: this.queued?.requestedAt ?? performance.now() };
    // Latency is from the FIRST edit not yet shown (what the player perceives while dragging).
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dispatch();
    }, DEBOUNCE_MS);
  }

  private dispatch(): void {
    const job = this.queued;
    if (!job) return;
    if (this.failures > MAX_WORKER_FAILURES) {
      this.queued = null;
      this.hooks.onError('replay worker unavailable: it failed to start repeatedly (reload the page)');
      this.hooks.onStatus('idle');
      return;
    }
    const f = this.inFlight;
    if (f) {
      if (f.replayingSince !== null && performance.now() - f.replayingSince > CANCEL_AFTER_MS) this.cancel();
      else return; // sent when the current run finishes
    }
    this.queued = null;
    this.inFlight = { ...job, replayingSince: null };
    this.hooks.onStatus('chunks');
    this.post({ type: 'run', id: job.id, plan: job.plan, missionId: job.missionId });
  }

  private post(m: ToReplay, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }

  /** Terminate the busy worker and promote the spare, seeding it with the chunks of the queued flight. */
  private cancel(): void {
    this.stats.cancels++;
    this.worker.terminate();
    this.worker = this.spare ?? this.spawn();
    this.spare = this.spawn();
    const f = this.queued ?? this.inFlight;
    this.inFlight = null;
    if (f) this.seed(f.plan);
  }

  private seed(plan: MissionPlan): void {
    const ka = this.eph.chunkIndex(plan.epoch - 3600);
    const kb = this.eph.chunkIndex(plan.epoch + plan.duration + 3600);
    const chunks: { k: number; coeffs: Float64Array }[] = [];
    for (let k = ka; k <= kb && k - ka < 400; k++) {
      const c = this.eph.chunk(k);
      if (c) chunks.push({ k, coeffs: c.slice() });
    }
    if (chunks.length) this.post({ type: 'chunks', chunks }, chunks.map((c) => c.coeffs.buffer));
  }

  private onMessage(w: Worker, m: FromReplay): void {
    if (m.type === 'chunk') {
      this.hooks.onChunk(m.k, m.coeffs);
      return;
    }
    if (w !== this.worker) return; // spare saying ready, or a terminated worker's last words
    if (m.type === 'ready') return;
    const f = this.inFlight;
    if (!f || m.id !== f.id) return;
    if (m.type === 'replaying') {
      f.replayingSince = performance.now();
      this.hooks.onStatus('running');
      return;
    }
    if (m.type === 'result' && m.preview !== null) {
      // First look at a long flight: show it, keep waiting for the full replay.
      this.hooks.onResult({ plan: f.plan, result: m.result, evaluation: null, samples: m.samples, replayMs: m.ms, latencyMs: performance.now() - f.requestedAt, stale: this.queued !== null, preview: m.preview });
      return;
    }
    this.inFlight = null;
    if (m.type === 'error') {
      this.hooks.onError(m.message);
    } else {
      const latencyMs = performance.now() - f.requestedAt;
      this.failures = 0;
      this.stats.runs++;
      this.stats.lastLatencyMs = latencyMs;
      this.stats.lastReplayMs = m.ms;
      this.stats.latencies.push(latencyMs);
      if (this.stats.latencies.length > 200) this.stats.latencies.shift();
      this.hooks.onResult({ plan: f.plan, result: m.result, evaluation: m.evaluation, samples: m.samples, replayMs: m.ms, latencyMs, stale: this.queued !== null, preview: null });
    }
    if (this.queued) this.dispatch();
    else this.hooks.onStatus('idle');
  }
}
