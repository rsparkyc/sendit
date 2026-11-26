/**
 * Builds Chebyshev ephemeris chunk 0 and chunk -1 with default settings and
 * returns a SHA-256 of the raw IEEE-754 bytes of each coefficient array. Runs
 * unchanged in Node and in a browser worker, so engines can be compared bit for
 * bit. Uses only the zero-argument constructor and public methods so it keeps
 * working if the API gains optional parameters.
 */
import { ChebyshevEphemeris } from '../src/physics/chebyshev-ephemeris';

export interface ChunkDigest {
  chunk: number;
  length: number;
  sha256: string;
}

async function sha256(a: Float64Array): Promise<string> {
  // Normalise to little-endian bytes so the digest is host-endianness independent.
  const view = new DataView(new ArrayBuffer(a.length * 8));
  for (let i = 0; i < a.length; i++) view.setFloat64(8 * i, a[i], true);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', view.buffer));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function ephemerisDigest(): Promise<{ chunks: ChunkDigest[]; ms: number }> {
  const start = performance.now();
  const eph = new ChebyshevEphemeris();
  const span = eph.layout.chunkSpan;
  // Strictly inside chunks -1 and 0.
  eph.ensure(eph.t0 - span / 2, eph.t0 + span / 2);
  const chunks: ChunkDigest[] = [];
  for (const k of [0, -1]) {
    const c = eph.getChunk(k);
    if (!c) throw new Error(`chunk ${k} was not built`);
    chunks.push({ chunk: k, length: c.length, sha256: await sha256(c) });
  }
  return { chunks, ms: performance.now() - start };
}
