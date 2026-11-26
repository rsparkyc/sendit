import { expect, it } from 'vitest';
import { DATA, DIGEST, MODEL, PLAN } from '../fixtures/model2-replay';
import { makePlan, makeWorld, PHYSICS_MODEL, replayWithSamples } from './mission-layer';
import { BODY_DATA, ReplayEphemeris } from './physics';
import { replayOptions } from './replay-options';

const FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ FS)) as { readFileSync: (u: URL) => Uint8Array };

it('the cross-engine model-2 replay fixture matches this build (V8 reference for e2e/determinism.e2e.ts)', () => {
  const eph = new ReplayEphemeris();
  eph.installCheckpoints(new Uint8Array(readFileSync(new URL('../physics/data/checkpoints-1950-2100.bin', import.meta.url))));
  const world = makeWorld(eph.physics, BODY_DATA);
  expect(PHYSICS_MODEL).toBe(MODEL);
  expect(world.fingerprint).toBe(DATA);
  const r = replayWithSamples(makePlan({ ...PLAN, data: world.fingerprint }), world, replayOptions(null));
  expect(r.result.outcome).toBe('completed');
  console.log(`model-2 fixture digest ${r.result.digest}`);
  expect(r.result.digest).toBe(DIGEST);
});
