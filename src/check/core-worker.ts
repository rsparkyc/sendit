/// <reference lib="webworker" />
/**
 * Three-way replay parity in this browser: the Rust core as WebAssembly
 * (core/, src/app/core-engine.ts) against the TypeScript in the same engine,
 * and both against the V8 values pinned in the fixtures.
 *
 * Each case is flown twice with the app's own call: replayWithSamples(plan,
 * world, replayOptions(mission)) in TypeScript, and CoreEngine.replay in the
 * core, which computes its replay options itself (the sandbox's spheres
 * included). The core builds its own chunks from the checkpoint asset, so the
 * chunk builder runs as wasm here too. Compared: outcome, digest, steps,
 * final time and state, and every trajectory sample, bit for bit.
 *
 * Cases: the pinned model-2 and staged fixtures (sandbox spheres) and the
 * initial plan of every campaign mission of 12 days or less (mission options:
 * their spheres, stopOnAtmosphere, vehicle ascents).
 */
import { CAMPAIGN, initialMissionPlan, makePlan, makeWorld, replayWithSamples, type MissionPlan } from '../app/mission-layer';
import { BODY_DATA, ReplayEphemeris } from '../app/physics';
import { replayOptions } from '../app/replay-options';
import { compareReplays, compileCore, CoreEngine } from '../app/core-engine';
import { CORE_WASM_URL } from '../app/core-flag';
import { CHECKPOINT_ASSET_URL } from '../physics/checkpoint-asset';
import * as M2 from '../fixtures/model2-replay';
import * as STAGED from '../fixtures/staged-replay';

export interface CoreCase {
  name: string;
  digest: string;
  coreDigest: string;
  /** The V8 digest pinned for this case, if any. */
  pinned: string | null;
  /** First difference between the core and the TypeScript (null: identical). */
  mismatch: string | null;
  samples: number;
  tsMs: number;
  coreMs: number;
}

export interface CoreCheckResult {
  cases: CoreCase[];
  /** Wall time, ms: loading (asset, module, engine), and all of it. */
  loadMs: number;
  totalMs: number;
  moduleBytes: number;
}

self.onmessage = async () => {
  try {
    const t0 = performance.now();
    const [asset, wasm] = await Promise.all([
      fetch(CHECKPOINT_ASSET_URL).then(async (r) => {
        if (!r.ok) throw new Error(`checkpoint asset: HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      }),
      fetch(new URL(CORE_WASM_URL, self.location.href)).then(async (r) => {
        if (!r.ok) throw new Error(`core module: HTTP ${r.status} for ${CORE_WASM_URL} (build it with core/scripts/build-web.sh)`);
        return new Uint8Array(await r.arrayBuffer());
      }),
    ]);
    const eph = new ReplayEphemeris();
    eph.installCheckpoints(asset);
    const engine = await CoreEngine.create(await compileCore(wasm), asset);
    const loadMs = performance.now() - t0;
    const world = makeWorld(eph.physics, BODY_DATA);
    const fp = world.fingerprint;

    const cases: { name: string; plan: MissionPlan; missionId: string; pinned: string | null }[] = [
      { name: 'model2 (sandbox)', plan: makePlan({ ...M2.PLAN, data: fp }), missionId: 'sandbox', pinned: M2.DIGEST },
      { name: 'staged (sandbox)', plan: makePlan({ ...STAGED.PLAN, data: fp }), missionId: 'sandbox', pinned: STAGED.DIGEST },
      ...CAMPAIGN.filter((m) => m.maxDuration <= 12 * 86400).map((m) => ({ name: `${m.id} initial plan`, plan: initialMissionPlan(m, fp), missionId: m.id, pinned: null })),
    ];
    const out: CoreCase[] = [];
    for (const c of cases) {
      const def = CAMPAIGN.find((m) => m.id === c.missionId) ?? null;
      const a = performance.now();
      const ts = replayWithSamples(c.plan, world, replayOptions(def), 6);
      const b = performance.now();
      const core = engine.replay(c.plan, c.missionId, 6);
      const e = performance.now();
      out.push({ name: c.name, digest: ts.result.digest, coreDigest: core.digest, pinned: c.pinned, mismatch: compareReplays(ts, core), samples: core.samples.length / 8, tsMs: b - a, coreMs: e - b });
    }
    self.postMessage({ cases: out, loadMs, totalMs: performance.now() - t0, moduleBytes: wasm.length } satisfies CoreCheckResult);
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
};
