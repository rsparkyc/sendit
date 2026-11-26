/**
 * Main-thread side of the planner worker. Every job first asks the chunk pool
 * for ephemeris coverage of its whole date range (built in parallel, without
 * blocking the page), hands those chunks to the worker, then runs the job
 * with progress. One job at a time; a new job cancels the previous one.
 * Cancel: the porkchop stops at its next chunk of cells; the corrector,
 * departure and chain search are synchronous inside the worker, so the
 * worker is terminated and a fresh one takes over.
 */
import type { ChunkPool } from './chunk-pool';
import type { Ephemeris } from './physics';
import type { FromPlanner, ToPlanner } from './protocol';

type Job = Exclude<ToPlanner, { type: 'chunks' } | { type: 'cancel' }>;
type Result<T extends Job['type']> = Extract<FromPlanner, { type: T }>;
export type Progress = (label: string, done: number, total: number) => void;

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export class PlannerClient {
  private worker: Worker;
  private nextId = 1;
  private current: { id: number; type: Job['type']; reject: (e: Error) => void; release: () => void } | null = null;
  private listeners = new Map<number, (m: FromPlanner) => void>();

  constructor(private readonly eph: Ephemeris, private readonly pool: ChunkPool) {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./planner-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<FromPlanner>) => {
      const m = ev.data;
      if (m.type === 'ready') return;
      this.listeners.get(m.id)?.(m);
    };
    w.onerror = (e) => console.error('planner worker:', e.message);
    return w;
  }

  get busy(): boolean {
    return this.current !== null;
  }

  /** Cancel the running job (its promise rejects with Cancelled). */
  cancel(): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    this.listeners.delete(c.id);
    c.release();
    if (c.type === 'porkchop') this.worker.postMessage({ type: 'cancel', id: c.id } satisfies ToPlanner);
    else {
      this.worker.terminate();
      this.worker = this.spawn();
    }
    c.reject(new Cancelled());
  }

  /** Run a job over ephemeris span [ta, tb]. */
  async run<T extends Job['type']>(job: Omit<Extract<Job, { type: T }>, 'id'> & { type: T }, ta: number, tb: number, onProgress: Progress): Promise<Result<T>> {
    this.cancel();
    const id = this.nextId++;
    const cov = this.pool.require(ta, tb, (missing, total) => onProgress(`ephemeris: ${total - missing} of ${total} chunks`, total - missing, total));
    let rejectEarly: (e: Error) => void = () => {};
    const early = new Promise<never>((_, rej) => (rejectEarly = rej));
    this.current = { id, type: job.type, reject: rejectEarly, release: cov.release };
    await Promise.race([cov.ready, early]);
    // Hand the worker the chunks for the span (copies: the main thread keeps its own).
    const chunks: { k: number; coeffs: Float64Array }[] = [];
    for (let k = this.eph.chunkIndex(Math.min(ta, tb)); k <= this.eph.chunkIndex(Math.max(ta, tb)); k++) {
      const c = this.eph.chunk(k);
      if (c) chunks.push({ k, coeffs: c.slice() });
    }
    this.worker.postMessage({ type: 'chunks', chunks } satisfies ToPlanner, chunks.map((c) => c.coeffs.buffer));
    return new Promise<Result<T>>((resolve, reject) => {
      this.current = { id, type: job.type, reject, release: cov.release };
      early.catch(() => {});
      this.listeners.set(id, (m) => {
        if (m.type === 'progress') {
          onProgress(m.label, m.done, m.total);
          return;
        }
        this.listeners.delete(id);
        if (this.current?.id === id) {
          this.current.release();
          this.current = null;
        }
        if (m.type === 'error') reject(new Error(m.message));
        else resolve(m as Result<T>);
      });
      this.worker.postMessage({ ...job, id } as unknown as ToPlanner);
    });
  }
}
