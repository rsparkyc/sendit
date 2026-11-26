/**
 * Precomputed integrator checkpoints at every chunk boundary of a date range,
 * shipped as one static binary asset. With them, any chunk in the range is
 * built from its own checkpoint (one chunk build, ~0.2 s), and several workers
 * can build different chunks at once. Chunks built from these checkpoints are
 * bit-identical to building sequentially from the epoch (test/checkpoint-asset.test.ts).
 * Outside the range, ChebyshevEphemeris falls back to integrating from the
 * outermost known checkpoint.
 *
 * FORMAT (little-endian)
 *   0   8 bytes  magic "SNDCKPT1"
 *   8   uint32   header length L (bytes of UTF-8 JSON)
 *   12  L bytes  header JSON: { version, bodies, h, chunkSteps, t0, first, count }
 *   ... zero padding to a multiple of 8
 *   then count * 12n float64: checkpoint data (NBodyIntegrator.exportState:
 *   q, v, q compensation, v compensation) for boundaries first .. first+count-1.
 *
 * `version` is a hash of everything the checkpoints depend on: the initial
 * conditions and constants of every body, the physics options, the step, the
 * chunk length, the epoch and FORMAT_REVISION (bump it when the integrator's
 * arithmetic changes). A loader refuses an asset whose version does not match
 * the ephemeris it is loaded into.
 *
 * Regenerate with `pnpm gen:checkpoints` (scripts/gen-checkpoints.mjs, ~80 s).
 * The asset is checked in rather than generated at build time: generating it
 * takes over a minute of integration, the bits are fully deterministic, and a
 * checked-in file lets a unit test detect staleness.
 */
import { NBodyIntegrator, KAHAN_LI_8, type NBodyPhysics } from './nbody';
import type { BodyData } from './solar-system';
import { initialCheckpoint, type Checkpoint, type ChebyshevEphemeris } from './chebyshev-ephemeris';

/** Bump when the integrator's floating-point operation sequence changes. */
export const FORMAT_REVISION = 1;
const MAGIC = 'SNDCKPT1';

/** Range of the shipped asset: boundaries covering 1950-01-01 .. 2100-01-01 (TDB days from J2000). */
export const ASSET_FIRST_DAY = -18262.5;
export const ASSET_LAST_DAY = 36525;

/** URL of the shipped asset (resolved by Vite at build time). */
export const CHECKPOINT_ASSET_URL: string = new URL('./data/checkpoints-1950-2100.bin', import.meta.url).href;

export interface CheckpointAssetHeader {
  version: string;
  bodies: string[];
  h: number;
  chunkSteps: number;
  t0: number;
  first: number;
  count: number;
}

/** 64-bit FNV-1a over UTF-16 code units, as hex (exact integer arithmetic). */
function fnv64(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    b = (b ^ (b >>> 15)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Version string for an ephemeris configuration (what the checkpoints depend on). */
export function checkpointVersion(eph: Pick<ChebyshevEphemeris, 'physics' | 't0' | 'layout'>, bodies: readonly BodyData[]): string {
  const replacer = (_k: string, v: unknown) => (ArrayBuffer.isView(v) ? Array.from(v as Float64Array) : v);
  const desc = JSON.stringify(
    {
      rev: FORMAT_REVISION,
      bodies: bodies.map((b) => ({ id: b.id, gm: b.gm, state: b.state, j2: b.j2, j4: b.j4, j2Radius: b.j2Radius, pole: b.pole })),
      physics: eph.physics,
      h: eph.layout.h,
      chunkSteps: eph.layout.chunkSteps,
      t0: eph.t0,
    },
    replacer,
  );
  return fnv64(desc);
}

/**
 * Integrate from the epoch and return the checkpoints at boundaries
 * first..last (first <= 0 <= last). Same operations as buildChunk, so the
 * results are bit-identical to the ones chunk building produces.
 */
export function generateCheckpoints(
  eph: Pick<ChebyshevEphemeris, 'physics' | 't0' | 'layout' | 'gm'>,
  bodies: readonly BodyData[],
  first: number,
  last: number,
  onProgress?: (boundary: number) => void,
): Checkpoint[] {
  const out: Checkpoint[] = [initialCheckpoint(bodies)];
  for (const dir of [1, -1] as const) {
    let cp = out[0];
    const end = dir > 0 ? last : first;
    while (cp.boundary !== end) {
      cp = advance(eph, cp, dir);
      out.push(cp);
      onProgress?.(cp.boundary);
    }
  }
  return out.sort((x, y) => x.boundary - y.boundary);
}

function advance(eph: Pick<ChebyshevEphemeris, 'physics' | 't0' | 'layout' | 'gm'>, cp: Checkpoint, dir: 1 | -1): Checkpoint {
  const n = eph.gm.length;
  const S = eph.layout.chunkSteps;
  const state = new Float64Array(6 * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      state[6 * i + k] = cp.data[3 * i + k];
      state[6 * i + 3 + k] = cp.data[3 * n + 3 * i + k];
    }
  }
  const it = new NBodyIntegrator(eph.gm, state, eph.t0, dir * eph.layout.h, KAHAN_LI_8, eph.physics as NBodyPhysics);
  it.importState(cp.data, Math.abs(cp.boundary) * S);
  for (let i = 0; i < S; i++) it.step();
  return { boundary: cp.boundary + dir, data: it.exportState() };
}

export function encodeCheckpointAsset(header: Omit<CheckpointAssetHeader, 'first' | 'count'>, cps: readonly Checkpoint[]): Uint8Array {
  const first = cps[0].boundary;
  cps.forEach((c, i) => {
    if (c.boundary !== first + i) throw new Error('checkpoints must be contiguous and sorted');
  });
  const json = new TextEncoder().encode(JSON.stringify({ ...header, first, count: cps.length }));
  const dataOff = Math.ceil((12 + json.length) / 8) * 8;
  const m = cps[0].data.length;
  const buf = new ArrayBuffer(dataOff + cps.length * m * 8);
  const bytes = new Uint8Array(buf);
  bytes.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(buf).setUint32(8, json.length, true);
  bytes.set(json, 12);
  const dv = new DataView(buf, dataOff);
  cps.forEach((c, i) => c.data.forEach((x, j) => dv.setFloat64((i * m + j) * 8, x, true)));
  return bytes;
}

export function decodeCheckpointAsset(bytes: Uint8Array): { header: CheckpointAssetHeader; checkpoints: Checkpoint[] } {
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) throw new Error('checkpoint asset: bad magic (not a checkpoint file)');
  const dv0 = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const L = dv0.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + L))) as CheckpointAssetHeader;
  const dataOff = Math.ceil((12 + L) / 8) * 8;
  const m = 12 * header.bodies.length;
  if (bytes.byteLength !== dataOff + header.count * m * 8) throw new Error('checkpoint asset: truncated or wrong length');
  const checkpoints: Checkpoint[] = [];
  for (let i = 0; i < header.count; i++) {
    const data = new Float64Array(m);
    for (let j = 0; j < m; j++) data[j] = dv0.getFloat64(dataOff + (i * m + j) * 8, true);
    checkpoints.push({ boundary: header.first + i, data });
  }
  return { header, checkpoints };
}

/**
 * Install an asset's checkpoints into `eph` (built from `bodies`). Throws, and
 * installs nothing, if the asset was made for a different configuration.
 */
export function installCheckpointAsset(eph: ChebyshevEphemeris, bodies: readonly BodyData[], bytes: Uint8Array): CheckpointAssetHeader {
  const { header, checkpoints } = decodeCheckpointAsset(bytes);
  const want = checkpointVersion(eph, bodies);
  if (header.version !== want) {
    throw new Error(
      `checkpoint asset version ${header.version} does not match this ephemeris (${want}): it was generated for different ` +
        `bodies, initial conditions, physics, step or chunk length. Regenerate it with \`pnpm gen:checkpoints\`.`,
    );
  }
  const ids = bodies.map((b) => b.id);
  if (header.bodies.join() !== ids.join()) throw new Error('checkpoint asset body list does not match');
  for (const cp of checkpoints) eph.addCheckpoint(cp);
  return header;
}

/** Header fields for an ephemeris (for encodeCheckpointAsset). */
export function assetHeaderFor(eph: ChebyshevEphemeris, bodies: readonly BodyData[]): Omit<CheckpointAssetHeader, 'first' | 'count'> {
  return { version: checkpointVersion(eph, bodies), bodies: bodies.map((b) => b.id), h: eph.layout.h, chunkSteps: eph.layout.chunkSteps, t0: eph.t0 };
}

/** Boundary range of the shipped asset for a chunk span C (seconds). */
export function assetBoundaries(chunkSpan: number): { first: number; last: number } {
  return { first: Math.floor((ASSET_FIRST_DAY * 86400) / chunkSpan), last: Math.ceil((ASSET_LAST_DAY * 86400) / chunkSpan) };
}
