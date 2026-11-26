import { expect, it } from 'vitest';
import { ASCENT_HEX, DATA, DIGEST, MODEL, PLAN } from '../fixtures/staged-replay';
import { makePlan, makeWorld, PHYSICS_MODEL, replayWithSamples } from './mission-layer';
import { BODY_DATA, ReplayEphemeris } from './physics';
import { replayOptions } from './replay-options';
import { f64Hex } from './staged-replay-hex';

const FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ FS)) as { readFileSync: (u: URL) => Uint8Array };

it('the cross-engine staged replay fixture (vehicle ascent, separation, stage burns) matches this build (V8 reference)', () => {
  const eph = new ReplayEphemeris();
  eph.installCheckpoints(new Uint8Array(readFileSync(new URL('../physics/data/checkpoints-1950-2100.bin', import.meta.url))));
  const world = makeWorld(eph.physics, BODY_DATA);
  expect(PHYSICS_MODEL).toBe(MODEL);
  expect(world.fingerprint).toBe(DATA);
  const plan = makePlan({ ...PLAN, data: world.fingerprint });
  expect(plan.format).toBe(2);
  const r = replayWithSamples(plan, world, replayOptions(null)).result;
  expect(r.outcome, r.reason).toBe('completed');
  expect(r.ascent?.ok).toBe(true);
  // Both stages fly: the upper stage's injection, then the probe's correction after the separation.
  expect(r.stages?.map((s) => s.separatedAt !== null)).toEqual([true, true, false]);
  const got = { upperPropellant: f64Hex(r.ascent!.upperPropellant), deltaV: f64Hex(r.ascent!.deltaV), totalDeltaV: f64Hex(r.totalDeltaV) };
  console.log(`staged fixture digest ${r.digest} ${JSON.stringify(got)}`);
  expect(r.digest).toBe(DIGEST);
  expect(got).toEqual(ASCENT_HEX);
});
