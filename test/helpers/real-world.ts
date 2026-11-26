/** The real ephemeris (ChebyshevEphemeris over J2000_BODIES) with the shipped checkpoint asset, and its mission world. Built once per test file. */
import { ChebyshevEphemeris } from '../../src/physics/chebyshev-ephemeris';
import { installCheckpointAsset } from '../../src/physics/checkpoint-asset';
import { J2000_BODIES } from '../../src/physics/solar-system';
import { worldFromBodyData, type MissionWorld } from '../../src/mission/world';

// node:fs through a computed specifier: the project has no Node type definitions.
const FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ FS)) as { readFileSync: (u: URL) => Uint8Array };

let cached: { eph: ChebyshevEphemeris; world: MissionWorld } | null = null;

export function realWorld(): { eph: ChebyshevEphemeris; world: MissionWorld } {
  if (cached) return cached;
  const eph = new ChebyshevEphemeris(J2000_BODIES);
  installCheckpointAsset(eph, J2000_BODIES, new Uint8Array(readFileSync(new URL('../../src/physics/data/checkpoints-1950-2100.bin', import.meta.url))));
  cached = { eph, world: worldFromBodyData(eph, J2000_BODIES) };
  return cached;
}

export const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
export const SLOW = ENV.SLOW === '1';
