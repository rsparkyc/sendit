/// <reference lib="webworker" />
/** Planner worker: runs planner-core.ts jobs off the main thread. See planner-core.ts. */
import { ReplayEphemeris } from './physics';
import { plannerCore } from './planner-core';
import type { FromPlanner, ToPlanner } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const eph = new ReplayEphemeris();
const ready = eph.loadCheckpoints().catch((e) => console.warn('planner worker: checkpoint asset unavailable:', e));
const core = plannerCore(eph, (m: FromPlanner, transfer: Transferable[] = []) => self.postMessage(m, transfer));

self.onmessage = async (ev: MessageEvent<ToPlanner>) => {
  const m = ev.data;
  if (m.type === 'chunks') {
    for (const c of m.chunks) eph.add(c.k, c.coeffs);
    return;
  }
  if (m.type === 'cancel') {
    core.aborts.get(m.id)?.abort(new Error('cancelled'));
    return;
  }
  await ready;
  try {
    if (m.type === 'porkchop') await core.porkchop(m.id, m.req);
    else if (m.type === 'departure') core.departure(m);
    else if (m.type === 'correct') await core.correct(m);
    else if (m.type === 'chain') core.chain(m);
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) });
  }
};

void ready.then(() => self.postMessage({ type: 'ready' } satisfies FromPlanner));
