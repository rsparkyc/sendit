import { describe, expect, it } from 'vitest';
import { chunksMissing, chunksToEvict, EMPTY, nextChunks, outsideAsset, poolSizing, type ScheduleInput } from './schedule';

const base = (p: Partial<ScheduleInput> = {}): ScheduleInput => ({
  have: new Set(), inFlight: new Set(), view: 100, direction: 0, ahead: 0, flight: EMPTY, pinned: [], radius: 3, limit: { lo: -1000, hi: 1000 }, slots: 50, ...p,
});

describe('chunk scheduling (checkpoint asset: any chunk builds independently)', () => {
  it('builds the view chunk first, then neighbours, then prefetch, with no path from the epoch', () => {
    const order = nextChunks(base());
    expect(order[0]).toBe(100);
    expect(order.slice(1, 3).sort()).toEqual([101, 99].sort());
    expect(new Set(order)).toEqual(new Set([97, 98, 99, 100, 101, 102, 103]));
    expect(order).not.toContain(0);
  });

  it('puts pinned requests before neighbours and warp look-ahead before prefetch', () => {
    const order = nextChunks(base({ pinned: [{ lo: 10, hi: 12 }], direction: 1, ahead: 4 }));
    expect(order.slice(0, 4)).toEqual([100, 10, 11, 12]);
    expect(order.slice(4, 8)).toEqual([101, 102, 103, 104]);
  });

  it('skips present and in-flight chunks, respects slots and limits', () => {
    const order = nextChunks(base({ have: new Set([100, 101]), inFlight: new Set([99]), slots: 2, limit: { lo: 0, hi: 102 } }));
    expect(order).toEqual([102, 98]);
  });

  it('caps the flight span around the view', () => {
    const order = nextChunks(base({ flight: { lo: 0, hi: 400 }, maxFlight: 10, radius: 0 }));
    expect(Math.min(...order)).toBeGreaterThanOrEqual(95);
    expect(Math.max(...order)).toBeLessThanOrEqual(105);
  });

  it('evicts farthest from the view first and never kept ranges', () => {
    const have = [0, 1, 2, 50, 98, 99, 100, 101, 300];
    const ev = chunksToEvict({ have, view: 100, keep: [{ lo: 99, hi: 101 }, { lo: 0, hi: 0 }], budget: 5 });
    expect(ev).toEqual([300, 1, 2, 50]);
    expect(chunksToEvict({ have, view: 100, keep: [], budget: 20 })).toEqual([]);
  });

  it('counts missing chunks and flags chunks outside the asset', () => {
    expect(chunksMissing(new Set([1, 3]), { lo: 0, hi: 3 })).toBe(2);
    expect(outsideAsset(-200, { lo: -143, hi: 285 })).toBe(true);
    expect(outsideAsset(0, { lo: -143, hi: 285 })).toBe(false);
  });

  it('sizes the pool for the device', () => {
    expect(poolSizing(8, 8)).toEqual({ workers: 4, budget: 120 });
    expect(poolSizing(4, 2)).toEqual({ workers: 3, budget: 48 });
    expect(poolSizing(undefined, undefined).workers).toBe(1);
  });
});
