import { describe, expect, it } from 'vitest';
import { chunksMissing, nextChunk, union, type ChunkRange } from './schedule';

const EMPTY: ChunkRange = { lo: 0, hi: -1 };
const LIMIT: ChunkRange = { lo: -3, hi: 5 };

/** Run the scheduler to completion, checking every step is adjacent to the covered range. */
function drain(covered: ChunkRange, want: ChunkRange, limit: ChunkRange): number[] {
  const order: number[] = [];
  let c = { ...covered };
  for (let guard = 0; guard < 1000; guard++) {
    const k = nextChunk(c, want, limit);
    if (k === null) return order;
    const empty = c.lo > c.hi;
    if (empty) expect([0, -1]).toContain(k);
    else expect(k === c.hi + 1 || k === c.lo - 1).toBe(true);
    order.push(k);
    c = empty ? { lo: k, hi: k } : { lo: Math.min(c.lo, k), hi: Math.max(c.hi, k) };
  }
  throw new Error('did not terminate');
}

describe('chunk scheduling', () => {
  it('builds the wanted range first, outward from the epoch, then prefetches to the limits', () => {
    const order = drain(EMPTY, { lo: 3, hi: 4 }, LIMIT);
    expect(order.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(order)).toEqual(new Set([-3, -2, -1, 0, 1, 2, 3, 4, 5]));
  });

  it('handles a backward target', () => {
    const order = drain(EMPTY, { lo: -2, hi: -2 }, LIMIT);
    expect(order.slice(0, 2)).toEqual([-1, -2]);
  });

  it('honours a want beyond the prefetch limit', () => {
    const order = drain({ lo: 0, hi: 2 }, { lo: 9, hi: 10 }, LIMIT);
    expect(order.slice(0, 8)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(order).not.toContain(11);
  });

  it('prefetch alternates to keep both sides balanced', () => {
    const order = drain({ lo: 0, hi: 0 }, EMPTY, { lo: -2, hi: 2 });
    expect(order).toEqual([-1, 1, -2, 2]);
  });

  it('nothing to do when covered', () => {
    expect(nextChunk({ lo: -3, hi: 5 }, { lo: 0, hi: 1 }, LIMIT)).toBeNull();
  });

  it('counts missing chunks', () => {
    expect(chunksMissing(EMPTY, { lo: 4, hi: 4 })).toBe(5);
    expect(chunksMissing({ lo: -1, hi: 2 }, { lo: -4, hi: 3 })).toBe(4);
    expect(chunksMissing({ lo: -1, hi: 2 }, EMPTY)).toBe(0);
  });

  it('union ignores empties', () => {
    expect(union(EMPTY, { lo: 2, hi: 3 }, { lo: -1, hi: 0 })).toEqual({ lo: -1, hi: 3 });
    expect(union(EMPTY)).toEqual(EMPTY);
  });
});
