/// <reference lib="webworker" />
/**
 * Physics worker: builds ephemeris chunks one at a time (yielding to the event
 * loop between chunks so new requests are seen promptly), ships each to the main
 * thread as a transferred buffer in order outward from the epoch, and runs the
 * demo mission once its span is covered.
 */
import { missionChunkTimes, runMission } from './mission';
import { Ephemeris } from './physics';
import type { FromWorker, ToWorker } from './protocol';
import { isEmpty, nextChunk, union, type ChunkRange } from './schedule';
import { calendarToTdb } from './time';

declare const self: DedicatedWorkerGlobalScope;

const eph = new Ephemeris();
/** Background prefetch limit: 1900 to 2150. */
const LIMIT: ChunkRange = {
  lo: eph.chunkIndex(calendarToTdb({ year: 1900, month: 1, day: 1, hour: 0, minute: 0, second: 0 })),
  hi: eph.chunkIndex(calendarToTdb({ year: 2150, month: 1, day: 1, hour: 0, minute: 0, second: 0 })),
};
const [mA, mB] = missionChunkTimes();
const MISSION_RANGE: ChunkRange = { lo: eph.chunkIndex(mA), hi: eph.chunkIndex(mB) };

let want: ChunkRange = { lo: 0, hi: -1 };
let missionDone = false;
let scheduled = false;
/** Chunks already posted to the main thread. */
const sent: ChunkRange = { lo: 0, hi: -1 };
const buildMs = new Map<number, number>();

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

/** Post every built chunk the main thread does not have yet, in order outward. */
function flush(): void {
  const send = (k: number) => {
    const coeffs = eph.build(k); // already built: returns a copy
    post({ type: 'chunk', k, coeffs, ms: buildMs.get(k) ?? 0 }, [coeffs.buffer]);
  };
  if (eph.lo > eph.hi) return;
  if (sent.lo > sent.hi) {
    const first = eph.has(0) ? 0 : -1;
    send(first);
    sent.lo = sent.hi = first;
  }
  while (sent.hi < eph.hi) send(++sent.hi);
  while (sent.lo > eph.lo) send(--sent.lo);
}

function covered(r: ChunkRange): boolean {
  return isEmpty(r) || (eph.has(r.lo) && eph.has(r.hi));
}

function step(): void {
  scheduled = false;
  try {
    if (!missionDone && covered(MISSION_RANGE) && covered(want)) {
      const { samples, info } = runMission(eph);
      missionDone = true;
      flush(); // propagation may have extended the ephemeris
      post({ type: 'mission', samples, info }, [samples.buffer]);
      schedule();
      return;
    }
    const target = missionDone ? want : union(want, MISSION_RANGE);
    const k = nextChunk({ lo: eph.lo, hi: eph.hi }, target, LIMIT);
    if (k === null) {
      post({ type: 'idle' });
      return;
    }
    const s = performance.now();
    eph.build(k);
    buildMs.set(k, performance.now() - s);
    flush();
    schedule();
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(step, 0);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type === 'want') {
    want = { lo: m.lo, hi: m.hi };
    schedule();
  }
};
