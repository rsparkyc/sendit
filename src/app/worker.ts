/// <reference lib="webworker" />
/**
 * Chunk-pool worker: one of a small pool (see chunk-pool.ts). Loads the
 * checkpoint asset, then builds whichever chunk it is asked for and transfers
 * it to the main thread. Inside the asset (1950 to 2100) a chunk builds
 * directly from its own checkpoint, so several workers build in parallel with
 * bit-identical results; outside it the pool sends every chunk to one worker,
 * which integrates outward from the nearest checkpoint it knows. Built chunks
 * are dropped here after sending (checkpoints are kept), so a worker holds
 * almost no memory.
 */
import { ReplayEphemeris } from './physics';
import type { FromWorker, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const eph = new ReplayEphemeris();
const ready = eph.loadCheckpoints().catch((e) => {
  self.postMessage({ type: 'error', message: `checkpoint asset unavailable (chunks will integrate from J2000): ${String(e)}` } satisfies FromWorker);
});

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type !== 'build') return;
  await ready;
  try {
    const s = performance.now();
    const t = eph.physics.t0 + m.k * eph.physics.layout.chunkSpan;
    const built = eph.ensure(t, t);
    const ms = performance.now() - s;
    const ks = built.includes(m.k) ? built : [...built, m.k];
    for (const k of ks) {
      const coeffs = eph.copy(k)!;
      self.postMessage({ type: 'chunk', k, coeffs, ms: k === m.k ? ms : 0 } satisfies FromWorker, [coeffs.buffer]);
    }
    eph.evict(ks);
    self.postMessage({ type: 'done', k: m.k } satisfies FromWorker);
  } catch (e) {
    self.postMessage({ type: 'error', message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e), k: m.k } satisfies FromWorker);
  }
};
