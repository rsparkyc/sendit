/**
 * Which ephemeris chunk the worker should build next. Pure.
 *
 * Chunks can only be built outward from the epoch, one at a time, so the
 * covered set is always a contiguous range [lo, hi] (empty: lo > hi) that
 * contains chunk 0 or -1. Priorities:
 *   1. the range the viewer needs now (current time +- margin, the demo
 *      mission), toward whichever side is short;
 *   2. background prefetch, alternating outward until the soft limits.
 */

export interface ChunkRange {
  lo: number;
  hi: number;
}

export function isEmpty(r: ChunkRange): boolean {
  return r.lo > r.hi;
}

/** Union of chunk ranges, ignoring empties. */
export function union(...rs: ChunkRange[]): ChunkRange {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rs) {
    if (isEmpty(r)) continue;
    lo = Math.min(lo, r.lo);
    hi = Math.max(hi, r.hi);
  }
  return lo > hi ? { lo: 0, hi: -1 } : { lo, hi };
}

/**
 * Next chunk to build, or null when everything wanted and prefetched is done.
 * `want` must already be clipped to `limit` by the caller if desired; it is
 * honoured even outside the prefetch limit (an explicit jump wins).
 */
export function nextChunk(covered: ChunkRange, want: ChunkRange, limit: ChunkRange): number | null {
  const empty = isEmpty(covered);
  const hi = empty ? -1 : covered.hi;
  const lo = empty ? 0 : covered.lo;
  if (!isEmpty(want)) {
    const needHi = want.hi > hi;
    const needLo = want.lo < lo;
    if (needHi && needLo) {
      // Both sides short (only possible around the epoch): extend the side with more missing chunks.
      return want.hi - hi >= lo - want.lo ? hi + 1 : lo - 1;
    }
    if (needHi) return hi + 1;
    if (needLo) return lo - 1;
  }
  const canHi = hi < limit.hi;
  const canLo = lo > limit.lo;
  if (canHi && canLo) return hi + 1 <= -(lo - 1) - 1 ? hi + 1 : lo - 1; // balance: fwd count (hi+1) vs bwd count (-lo)
  if (canHi) return hi + 1;
  if (canLo) return lo - 1;
  return null;
}

/** Number of chunks still to build before `want` is covered. */
export function chunksMissing(covered: ChunkRange, want: ChunkRange): number {
  if (isEmpty(want)) return 0;
  const empty = isEmpty(covered);
  const hi = empty ? -1 : covered.hi;
  const lo = empty ? 0 : covered.lo;
  return Math.max(0, want.hi - hi) + Math.max(0, lo - want.lo);
}
