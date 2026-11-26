/// <reference lib="webworker" />
/**
 * Replay worker: flies the current plan with the mission layer's `replay`
 * (the scoring path) and returns the result, the objective evaluation and
 * trajectory samples taken from inside that same replay.
 *
 * Ephemeris: the real ChebyshevEphemeris with the checkpoint asset, so a
 * flight's span costs one chunk build per 128 days wherever it is; chunks it
 * builds are posted to the main thread for drawing. A fresh worker (after a
 * cancel by termination) is seeded with the chunks the main thread holds.
 *
 * Runs are processed newest-first: if several requests queued while one was
 * running, only the latest is flown.
 *
 * PREVIEW THEN REFINE. When the previous full replay took longer than
 * PREVIEW_ABOVE_MS, the plan is first replayed for a shortened duration: the
 * SAME replay with the same initial state, burns and tolerance, so its
 * trajectory is exactly the first part of the full flight (the integrator
 * takes the same steps up to the cut), sized to take about PREVIEW_MS. It is
 * posted as a preview (shown as such, not scored), then the full replay runs
 * unless a newer edit has arrived meanwhile.
 *
 * Sampling density adapts to the last run's step count so a long low-orbit
 * flight does not ship tens of thousands of points to draw.
 */
import { evaluateMission, makeWorld, replayWithSamples, type MissionPlan } from './mission-layer';
import { missionById } from './missions';
import { BODY_DATA, ReplayEphemeris } from './physics';
import type { FromReplay, ToReplay } from './protocol';
import { replayOptions } from './replay-options';

declare const self: DedicatedWorkerGlobalScope;

const eph = new ReplayEphemeris();
const world = makeWorld(eph.physics, BODY_DATA);
const ready = eph.loadCheckpoints().catch((e) => {
  // Still correct without the asset, only slower (chunks integrate from J2000).
  console.warn('replay worker: checkpoint asset unavailable:', e);
});

function post(m: FromReplay, transfer: Transferable[] = []): void {
  self.postMessage(m, transfer);
}

let pending: { id: number; plan: MissionPlan; missionId: string } | null = null;
let busy = false;
const PREVIEW_ABOVE_MS = 60;
const PREVIEW_MS = 25;
const TARGET_SAMPLES = 12000;
let last = { ms: 0, steps: 0, duration: 1 };

function perStepFor(steps: number): number {
  return Math.max(2, Math.min(12, Math.round(TARGET_SAMPLES / Math.max(1, steps))));
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await ready;
    while (pending) {
      const job = pending;
      pending = null;
      await run(job);
    }
  } finally {
    busy = false;
  }
}

async function run(job: { id: number; plan: MissionPlan; missionId: string }): Promise<void> {
  try {
    const { plan } = job;
    const entry = missionById(job.missionId);
    const def = entry?.def ?? null;
    const t0 = performance.now();
    // Chunks for the flight span, one at a time so newer requests can supersede this one.
    if (Number.isFinite(plan.epoch) && Number.isFinite(plan.duration) && plan.duration > 0 && plan.duration < 50 * 365.25 * 86400) {
      const ka = eph.chunkIndex(plan.epoch - 3600);
      const kb = eph.chunkIndex(plan.epoch + plan.duration + 3600);
      for (let k = ka; k <= kb; k++) {
        if (eph.has(k)) continue;
        const span = eph.physics.layout.chunkSpan;
        const built = eph.ensure(eph.physics.t0 + k * span, eph.physics.t0 + k * span);
        for (const b of built) {
          const c = eph.copy(b)!;
          post({ type: 'chunk', k: b, coeffs: c }, [c.buffer]);
        }
        await new Promise((r) => setTimeout(r, 0));
        if (pending) return; // superseded
      }
    }
    post({ type: 'replaying', id: job.id, chunkMs: performance.now() - t0 });
    const opts = replayOptions(def);
    // Expected cost from the last run, scaled by duration.
    const expect = last.ms * (plan.duration / last.duration);
    if (expect > PREVIEW_ABOVE_MS) {
      const frac = PREVIEW_MS / expect;
      const start = plan.start.kind === 'launch' ? (plan.start.params[3] ?? 540) : 0;
      const cut = Math.max(start + 3600, plan.duration * frac);
      if (cut < plan.duration * 0.8) {
        const pv = replayWithSamples({ ...plan, duration: cut }, world, opts, perStepFor(last.steps * frac));
        post({ type: 'result', id: job.id, result: pv.result, evaluation: null, samples: pv.samples, ms: pv.ms, preview: cut }, [pv.samples.buffer]);
        await new Promise((r) => setTimeout(r, 0));
        if (pending) return; // superseded: never fly the stale full plan
      }
    }
    const steps = last.steps * (plan.duration / last.duration);
    const r = replayWithSamples(plan, world, opts, last.steps ? perStepFor(steps) : 12);
    last = { ms: r.ms, steps: r.result.steps, duration: plan.duration };
    const evaluation = evaluateMission(def, r.result, world, plan.epoch);
    post({ type: 'result', id: job.id, result: r.result, evaluation, samples: r.samples, ms: r.ms, preview: null }, [r.samples.buffer]);
  } catch (e) {
    post({ type: 'error', id: job.id, message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
}

self.onmessage = (ev: MessageEvent<ToReplay>) => {
  const m = ev.data;
  if (m.type === 'chunks') {
    for (const c of m.chunks) eph.add(c.k, c.coeffs);
  } else if (m.type === 'run') {
    pending = { id: m.id, plan: m.plan, missionId: m.missionId };
    void pump();
  }
};

void ready.then(() => post({ type: 'ready' }));
