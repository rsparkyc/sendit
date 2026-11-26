/// <reference lib="webworker" />
/**
 * The staged replay of src/fixtures/staged-replay.ts (a format-2 plan with a
 * vehicle ascent, a separation and burns by two stages), computed exactly as
 * src/app/staged-replay.test.ts computes the V8 reference: the real Chebyshev
 * ephemeris from the checkpoint asset, the app's world and the sandbox replay
 * options. No WebGL and none of the app's UI. Besides the digest it returns
 * the ascent's results as IEEE-754 hex, so a mismatch says whether the ascent
 * (its deterministic exp/log) or the flight differs. The checkpoint asset is
 * required (see model2-worker.ts).
 */
import { makePlan, makeWorld, PHYSICS_MODEL, replayWithSamples } from '../app/mission-layer';
import { BODY_DATA, ReplayEphemeris } from '../app/physics';
import { replayOptions } from '../app/replay-options';
import { f64Hex } from '../app/staged-replay-hex';
import { PLAN } from '../fixtures/staged-replay';

export interface StagedResult {
  model: number;
  data: string;
  digest: string;
  outcome: string;
  ascent: { upperPropellant: string; deltaV: string; totalDeltaV: string };
  /** Wall time, ms: checkpoint fetch and install, chunk building, the replay (ascent included), and all of it. */
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
    const span = eph.physics.layout.chunkSpan;
    eph.ensure(eph.physics.t0 + eph.chunkIndex(PLAN.epoch - 3600) * span, eph.physics.t0 + eph.chunkIndex(PLAN.epoch + PLAN.duration + 3600) * span);
    const t2 = performance.now();
    const world = makeWorld(eph.physics, BODY_DATA);
    const r = replayWithSamples(makePlan({ ...PLAN, data: world.fingerprint }), world, replayOptions(null)).result;
    const t3 = performance.now();
    if (!r.ascent) throw new Error(`no ascent: ${r.outcome} ${r.reason}`);
    self.postMessage({
      model: PHYSICS_MODEL,
      data: world.fingerprint,
      digest: r.digest,
      outcome: r.outcome,
      ascent: { upperPropellant: f64Hex(r.ascent.upperPropellant), deltaV: f64Hex(r.ascent.deltaV), totalDeltaV: f64Hex(r.totalDeltaV) },
      fetchMs: t1 - t0,
      chunkMs: t2 - t1,
      replayMs: t3 - t2,
      totalMs: t3 - t0,
    } satisfies StagedResult);
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
};
