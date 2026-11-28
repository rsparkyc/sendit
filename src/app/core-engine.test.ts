import { describe, expect, it } from 'vitest';
import { compareReplays, compileCore, CoreEngine } from './core-engine';
import { coreMode } from './core-flag';
import { CAMPAIGN, initialMissionPlan, makePlan, makeWorld, replayWithSamples } from './mission-layer';
import { BODY_DATA, ReplayEphemeris } from './physics';
import { replayOptions } from './replay-options';
import * as M2 from '../fixtures/model2-replay';
import * as STAGED from '../fixtures/staged-replay';

const FS = 'node:fs';
const { existsSync, readFileSync } = (await import(/* @vite-ignore */ FS)) as { existsSync: (u: URL) => boolean; readFileSync: (u: URL) => Uint8Array<ArrayBuffer> };

it('the Rust core is off unless the flag turns it on', () => {
  expect(coreMode()).toBe('off');
});

// The core's module is built by core/scripts/build-web.sh (CI builds it for the browser
// suite; the unit job has no Rust toolchain, so there this block is skipped).
const WASM = new URL('../../public/core/sendit_core.wasm', import.meta.url);
describe.skipIf(!existsSync(WASM))('the Rust core as the replay engine (Node, wasm)', () => {
  it('replays the fixtures and short campaign plans bit-identically to replayWithSamples', async () => {
    const asset = readFileSync(new URL('../physics/data/checkpoints-1950-2100.bin', import.meta.url));
    const engine = await CoreEngine.create(await compileCore(readFileSync(WASM)), asset);
    const eph = new ReplayEphemeris();
    eph.installCheckpoints(asset);
    const world = makeWorld(eph.physics, BODY_DATA);
    const fp = world.fingerprint;
    const cases = [
      { plan: makePlan({ ...M2.PLAN, data: fp }), id: 'sandbox', pinned: M2.DIGEST },
      { plan: makePlan({ ...STAGED.PLAN, data: fp }), id: 'sandbox', pinned: STAGED.DIGEST },
      ...CAMPAIGN.filter((m) => m.maxDuration <= 7 * 86400).map((m) => ({ plan: initialMissionPlan(m, fp), id: m.id, pinned: null })),
    ];
    for (const c of cases) {
      for (const perStep of [2, 12]) {
        const ts = replayWithSamples(c.plan, world, replayOptions(CAMPAIGN.find((m) => m.id === c.id) ?? null), perStep);
        const core = engine.replay(c.plan, c.id, perStep);
        expect(compareReplays(ts, core), `${c.id} ${c.plan.epoch} perStep ${perStep}`).toBeNull();
        if (c.pinned) expect(core.digest).toBe(c.pinned);
      }
    }
  }, 120_000);
});
