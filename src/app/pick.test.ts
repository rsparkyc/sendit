import { describe, expect, it } from 'vitest';
import { History } from './history';
import { isDoubleTap, kindOfLabel, pickTarget, type PickCandidate } from './pick';

const c = (kind: PickCandidate['kind'], key: string, screenDist = 5, depth = 1e7): PickCandidate => ({ kind, key, screenDist, depth });

describe('pickTarget precedence', () => {
  it('follows spacecraft > node > event > site > body > trajectory', () => {
    const all = [c('trajectory', 't'), c('body', '3'), c('site', 's'), c('event', 'e'), c('node', 'n'), c('spacecraft', 'sc')];
    const order: string[] = [];
    let left = all;
    while (left.length) {
      const p = pickTarget(left)!;
      order.push(p.kind);
      left = left.filter((x) => x !== p);
    }
    expect(order).toEqual(['spacecraft', 'node', 'event', 'site', 'body', 'trajectory']);
  });
  it('a node marker wins over a nearer trajectory point and the planet behind', () => {
    expect(pickTarget([c('trajectory', 't', 1), c('body', '3', 0), c('node', 'node:0', 10)])!.key).toBe('node:0');
  });
  it('among bodies the nearest to the camera wins (moon in front of its planet)', () => {
    expect(pickTarget([c('body', 'earth', 0, 3.8e8), c('body', 'moon', 30, 1e8)])!.key).toBe('moon');
  });
  it('within a class the nearest on screen wins', () => {
    expect(pickTarget([c('event', 'a', 9), c('event', 'b', 2), c('event', 'c', 4)])!.key).toBe('b');
  });
  it('nothing to pick', () => {
    expect(pickTarget([])).toBeNull();
  });
  it('label keys map to kinds', () => {
    expect(['sc', 'node:1', 'burn:0:s', 'ev:3', 'pn:2', 'site:ksc', '4', 'axN'].map(kindOfLabel)).toEqual(['spacecraft', 'node', 'node', 'event', 'event', 'site', 'body', null]);
  });
  it('double tap: close in time and place only', () => {
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, 200, 10, 10)).toBe(true);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, 500, 0, 0)).toBe(false);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, 100, 80, 0)).toBe(false);
    expect(isDoubleTap(null, 100, 0, 0)).toBe(false);
  });
});

describe('History', () => {
  it('undo and redo single edits', () => {
    const h = new History<number>();
    h.record(0, null, 0); // 0 -> 1
    h.record(1, null, 10); // 1 -> 2
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBe(0);
    expect(h.undo(0)).toBeNull();
    expect(h.redo(0)).toBe(1);
    expect(h.redo(1)).toBe(2);
    expect(h.redo(2)).toBeNull();
  });
  it('coalesces a burst with the same key into one step', () => {
    const h = new History<number>();
    for (let i = 0; i < 10; i++) h.record(i, 'dv:0:0', i * 100); // 0 -> 10 in a burst
    expect(h.undo(10)).toBe(0);
    expect(h.canUndo).toBe(false);
  });
  it('does not coalesce across keys, after the window, or after seal', () => {
    const h = new History<number>();
    h.record(0, 'a', 0);
    h.record(1, 'b', 10);
    h.record(2, 'b', 5000);
    h.seal();
    h.record(3, 'b', 5010);
    expect([h.undo(4), h.undo(3), h.undo(2), h.undo(1)]).toEqual([3, 2, 1, 0]);
  });
  it('the idle window is measured between edits, not from the first', () => {
    const h = new History<number>();
    for (let i = 0; i < 6; i++) h.record(i, 'k', i * 1400); // 7 s in all, never 1.5 s idle
    expect(h.undo(6)).toBe(0);
    expect(h.canUndo).toBe(false);
  });
  it('inside a gesture a same-key burst is one step however slow, and only until another key, undo or the end', () => {
    const h = new History<number>();
    h.beginGesture();
    for (let i = 0; i < 5; i++) h.record(i, 'dv:0:0', i * 10_000); // a slow machine: 10 s between clicks
    h.record(5, 'dv:0:1', 40_010); // another value: a new step even inside the gesture
    h.record(6, 'dv:0:0', 40_020); // and back: new step again (no other edit may sit inside a run)
    h.endGesture();
    h.record(7, 'dv:0:0', 40_030); // just after the gesture: the idle window still joins it
    h.record(8, 'dv:0:0', 60_000); // long idle outside a gesture: a new step
    expect([h.undo(9), h.undo(8), h.undo(6), h.undo(5), h.undo(0)]).toEqual([8, 6, 5, 0, null]);
  });
  it('a gesture does not join edits across a seal or an undo', () => {
    const h = new History<number>();
    h.beginGesture();
    h.record(0, 'k', 0);
    h.seal();
    h.record(1, 'k', 1);
    expect(h.undo(2)).toBe(1);
    h.record(1, 'k', 2);
    expect([h.undo(2), h.undo(1), h.undo(0)]).toEqual([1, 0, null]);
  });
  it('a new edit clears redo; limit drops the oldest', () => {
    const h = new History<number>(3);
    for (let i = 0; i < 5; i++) h.record(i, null, i);
    expect(h.undo(5)).toBe(4);
    h.record(4, null, 10);
    expect(h.canRedo).toBe(false);
    expect([h.undo(5), h.undo(4), h.undo(3), h.undo(2)]).toEqual([4, 3, 2, null]);
  });
});
