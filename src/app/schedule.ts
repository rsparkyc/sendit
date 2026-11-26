/**
 * Which ephemeris chunks the viewer's worker pool should build next, and which
 * to evict. Pure.
 *
 * With the checkpoint asset every chunk from 1950 to 2100 builds independently
 * from its own checkpoint, so there is no "outward from J2000" order any more:
 * the pool builds what is needed where it is needed, several at once.
 * Priorities, highest first:
 *   1. the chunk under the view time (or the jump target);
 *   2. explicit coverage requests (planner, corrector), oldest first;
 *   3. look-ahead in the direction of time warp (enough for ~2 s of warp),
 *      then the immediate neighbours of the view chunk;
 *   4. the flight span (the replay worker usually supplies it already);
 *   5. a small prefetch radius around the view.
 * Chunks outside the checkpoint asset are integrated from the nearest
 * checkpoint, so they must be built in order outward; the caller sends them
 * all to one worker (see `outsideAsset`).
 *
 * Eviction keeps the view neighbourhood, the flight span and pinned requests,
 * and drops the chunks farthest from the view time first until the count is
 * within budget.
 */

export interface ChunkRange {
  lo: number;
  hi: number;
}

export const EMPTY: ChunkRange = { lo: 0, hi: -1 };

export function isEmpty(r: ChunkRange): boolean {
  return r.lo > r.hi;
}

export interface ScheduleInput {
  /** Chunks installed on the main thread. */
  have: ReadonlySet<number>;
  /** Chunks being built right now. */
  inFlight: ReadonlySet<number>;
  /** Chunk of the view time (or jump target). */
  view: number;
  /** Warp direction (+1 forward, -1 backward, 0 paused) and chunks of look-ahead in that direction. */
  direction: -1 | 0 | 1;
  ahead: number;
  /** Flight span (empty if none). */
  flight: ChunkRange;
  /** Explicit requests, in arrival order. */
  pinned: readonly ChunkRange[];
  /** Prefetch radius around the view, chunks. */
  radius: number;
  /** Hard limits: nothing outside is ever scheduled. */
  limit: ChunkRange;
  /** How many chunks to return at most. */
  slots: number;
  /** Cap on how many flight chunks to schedule (memory budget). */
  maxFlight?: number;
}

/** The next chunks to build, best first, at most `slots`, none already present or in flight. */
export function nextChunks(inp: ScheduleInput): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (k: number): boolean => {
    if (out.length >= inp.slots) return false;
    if (k < inp.limit.lo || k > inp.limit.hi) return true;
    if (seen.has(k) || inp.have.has(k) || inp.inFlight.has(k)) return true;
    seen.add(k);
    out.push(k);
    return out.length < inp.slots;
  };
  const range = (r: ChunkRange, from: number): boolean => {
    // Nearest to `from` first.
    if (isEmpty(r)) return true;
    const c = Math.min(r.hi, Math.max(r.lo, from));
    for (let d = 0; c - d >= r.lo || c + d <= r.hi; d++) {
      if (c + d <= r.hi && !add(c + d)) return false;
      if (d > 0 && c - d >= r.lo && !add(c - d)) return false;
    }
    return true;
  };
  if (!add(inp.view)) return out;
  for (const p of inp.pinned) if (!range(p, p.lo)) return out;
  const dir = inp.direction;
  if (dir !== 0) for (let i = 1; i <= inp.ahead; i++) if (!add(inp.view + dir * i)) return out;
  if (!add(inp.view + 1) || !add(inp.view - 1)) return out;
  if (!isEmpty(inp.flight)) {
    const cap = inp.maxFlight ?? Infinity;
    const f = inp.flight;
    const r = f.hi - f.lo + 1 > cap ? { lo: Math.max(f.lo, inp.view - Math.floor(cap / 2)), hi: Math.min(f.hi, inp.view + Math.ceil(cap / 2)) } : f;
    if (!range(r, inp.view)) return out;
  }
  for (let d = 2; d <= inp.radius; d++) {
    const a = dir < 0 ? -1 : 1;
    if (!add(inp.view + a * d) || !add(inp.view - a * d)) return out;
  }
  return out;
}

export interface EvictInput {
  have: readonly number[];
  view: number;
  /** Chunks that must stay (view neighbourhood, flight span, pinned requests). */
  keep: readonly ChunkRange[];
  budget: number;
}

/** Chunks to drop so that at most `budget` remain, farthest from the view first; kept ranges are never dropped. */
export function chunksToEvict(inp: EvictInput): number[] {
  const excess = inp.have.length - inp.budget;
  if (excess <= 0) return [];
  const kept = (k: number) => inp.keep.some((r) => k >= r.lo && k <= r.hi);
  const cand = inp.have.filter((k) => !kept(k)).sort((a, b) => Math.abs(b - inp.view) - Math.abs(a - inp.view) || a - b);
  return cand.slice(0, excess);
}

/** Number of chunks of `want` not yet installed. */
export function chunksMissing(have: ReadonlySet<number>, want: ChunkRange): number {
  let n = 0;
  for (let k = want.lo; k <= want.hi; k++) if (!have.has(k)) n++;
  return n;
}

/** True if chunk k must be integrated from a neighbour (outside the checkpoint asset). */
export function outsideAsset(k: number, asset: ChunkRange): boolean {
  return k < asset.lo || k > asset.hi;
}

/**
 * Pool size and chunk budget for a device: workers from the core count with a
 * small cap (phones have few cores and little memory), budget from the
 * device-memory hint when the browser gives one (GB), else from the core count.
 */
export function poolSizing(cores: number | undefined, memoryGb: number | undefined): { workers: number; budget: number } {
  const c = Number.isFinite(cores) && cores! > 0 ? cores! : 2;
  const workers = Math.max(1, Math.min(4, c - 1));
  const small = (memoryGb !== undefined && memoryGb <= 4) || c <= 4;
  // ~1.07 MB per chunk: 48 chunks ~ 51 MB, 120 ~ 128 MB.
  return { workers, budget: small ? 48 : 120 };
}
