/**
 * The shipped checkpoint asset (src/physics/data/checkpoints-1950-2100.bin):
 * up to date with the code, refused when mismatched, and giving chunks
 * bit-identical to sequential building from the epoch.
 */
import { describe, expect, it } from 'vitest';
import { ChebyshevEphemeris, buildChunk } from '../src/physics/chebyshev-ephemeris';
import {
  assetBoundaries,
  checkpointVersion,
  decodeCheckpointAsset,
  generateCheckpoints,
  installCheckpointAsset,
} from '../src/physics/checkpoint-asset';
import { J2000_BODIES } from '../src/physics/solar-system';

// node:fs through a computed specifier: the project has no Node type definitions.
const FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ FS)) as { readFileSync: (u: URL) => Uint8Array };
const BYTES = new Uint8Array(readFileSync(new URL('../src/physics/data/checkpoints-1950-2100.bin', import.meta.url)));
const sameBits = (a: Float64Array, b: Float64Array) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

describe('checkpoint asset', () => {
  const { header, checkpoints } = decodeCheckpointAsset(BYTES);
  const byB = new Map(checkpoints.map((c) => [c.boundary, c]));

  it('is up to date with the code that generates it (else run `pnpm gen:checkpoints`)', () => {
    const eph = new ChebyshevEphemeris();
    // Configuration: bodies, initial conditions, physics, step, chunk length.
    expect(header.version).toBe(checkpointVersion(eph, J2000_BODIES));
    expect(assetBoundaries(eph.layout.chunkSpan)).toEqual({ first: header.first, last: header.first + header.count - 1 });
    // Arithmetic: the integrator still produces the same bits (catches changes
    // the version hash cannot see, e.g. an edited force routine).
    for (const cp of generateCheckpoints(eph, J2000_BODIES, -2, 2)) expect(sameBits(cp.data, byB.get(cp.boundary)!.data)).toBe(true);
    console.log(`asset: ${header.count} checkpoints, boundaries ${header.first}..${header.first + header.count - 1}, ${BYTES.length} bytes`);
  }, 60_000);

  it('gives chunks bit-identical to sequential building, forward and backward', () => {
    // Near the epoch: directly against a sequential build.
    const seq = new ChebyshevEphemeris();
    seq.ensure(-3 * seq.layout.chunkSpan, 3 * seq.layout.chunkSpan - 1);
    const fromAsset = new ChebyshevEphemeris();
    installCheckpointAsset(fromAsset, J2000_BODIES, BYTES);
    for (const k of [2, -3, 1, -1]) {
      fromAsset.ensure((k + 0.5) * fromAsset.layout.chunkSpan, (k + 0.5) * fromAsset.layout.chunkSpan);
      expect(fromAsset.builtChunks()).toContain(k);
      expect(sameBits(fromAsset.getChunk(k)!, seq.getChunk(k)!)).toBe(true);
    }
    // Far out (1950s, 2050s, 2090s): one chunk built from its asset
    // checkpoint must end exactly on the next asset checkpoint. The asset was
    // made by one sequential integration from the epoch, so by induction each
    // checkpoint (and the chunk built from it) is what sequential building gives.
    for (const k of [-140, -60, 150, 280]) {
      const start = byB.get(k >= 0 ? k : k + 1)!;
      const r = buildChunk(fromAsset.layout, fromAsset.gm, fromAsset.physics, fromAsset.t0, k, start);
      expect(sameBits(r.end.data, byB.get(r.end.boundary)!.data)).toBe(true);
      fromAsset.ensure((k + 0.5) * fromAsset.layout.chunkSpan, (k + 0.5) * fromAsset.layout.chunkSpan);
      expect(sameBits(fromAsset.getChunk(k)!, r.coeffs)).toBe(true);
    }
    // Only the requested chunks were built (no integration from the epoch).
    expect(fromAsset.builtChunks()).toEqual([-140, -60, -3, -1, 1, 2, 150, 280]);
    // Evicted chunks rebuild identically from their checkpoint.
    const kept = fromAsset.getChunk(150)!;
    expect(fromAsset.evict([150, 999])).toBe(1);
    expect(fromAsset.hasChunk(150)).toBe(false);
    fromAsset.ensure(150.5 * fromAsset.layout.chunkSpan, 150.5 * fromAsset.layout.chunkSpan);
    expect(sameBits(fromAsset.getChunk(150)!, kept)).toBe(true);
  }, 120_000);

  it('is refused by an ephemeris with a different configuration', () => {
    const other = new ChebyshevEphemeris(J2000_BODIES, { chunkSteps: 8192 });
    expect(() => installCheckpointAsset(other, J2000_BODIES, BYTES)).toThrow(/does not match this ephemeris/);
    expect(other.checkpoints().length).toBe(1);
    const bodies = J2000_BODIES.map((b) => (b.id === 'io' ? { ...b, gm: b.gm * (1 + 1e-12) } : b));
    expect(() => installCheckpointAsset(new ChebyshevEphemeris(bodies), bodies, BYTES)).toThrow(/does not match/);
    expect(() => decodeCheckpointAsset(BYTES.subarray(0, 1000))).toThrow();
  });
});
