/// <reference lib="webworker" />
/**
 * The model-2 mission replay of src/fixtures/model2-replay.ts, computed exactly as
 * src/app/model2-replay.test.ts computes the V8 reference: the real Chebyshev
 * ephemeris from the checkpoint asset, the app's world (Earth and Moon gravity
 * fields, time-dependent poles) and the sandbox replay options. No WebGL and
 * none of the app's UI, so it runs in every engine on a headless runner.
 *
 * The checkpoint asset is required here: the app falls back to integrating from
 * J2000 when it is missing (correct, only far slower), but a proof run must not
 * silently take that path, so a failed fetch is reported as an error.
 */
import { makePlan, makeWorld, PHYSICS_MODEL, replayWithSamples } from '../app/mission-layer';
import { BODY_DATA, ReplayEphemeris } from '../app/physics';
import { replayOptions } from '../app/replay-options';
import { PLAN } from '../fixtures/model2-replay';

export interface Model2Result {
  model: number;
  data: string;
  digest: string;
  outcome: string;
  /** Chunks built for the flight span. */
  chunks: number;
  /** Wall time, ms: checkpoint fetch and install, chunk building, the replay itself, and all of it. */
  fetchMs: number;
  chunkMs: number;
  replayMs: number;
  totalMs: number;
}

self.onmessage = async () => {
  try {
    const t0 = performance.now();
    const eph = new ReplayEphemeris();
    await eph.loadCheckpoints();
    const t1 = performance.now();
    const ka = eph.chunkIndex(PLAN.epoch - 3600);
    const kb = eph.chunkIndex(PLAN.epoch + PLAN.duration + 3600);
    const span = eph.physics.layout.chunkSpan;
    const built = eph.ensure(eph.physics.t0 + ka * span, eph.physics.t0 + kb * span);
    const t2 = performance.now();
    const world = makeWorld(eph.physics, BODY_DATA);
    const r = replayWithSamples(makePlan({ ...PLAN, data: world.fingerprint }), world, replayOptions(null));
    const t3 = performance.now();
    self.postMessage({
      model: PHYSICS_MODEL,
      data: world.fingerprint,
      digest: r.result.digest,
      outcome: r.result.outcome,
      chunks: built.length,
      fetchMs: t1 - t0,
      chunkMs: t2 - t1,
      replayMs: t3 - t2,
      totalMs: t3 - t0,
    } satisfies Model2Result);
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
};
