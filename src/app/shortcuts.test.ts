/** The key binding table, J / K time stepping and timeline tooltip text (pure parts). */
import { describe, expect, it } from 'vitest';
import { BINDINGS, comboCap, matchBinding, stepLevel, type KeyLike } from './shortcuts';
import { stepTime, TAP_SECONDS } from './time-keys';
import { tipText } from './timeline';

const key = (code: string, k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ code, key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods });
const none = { node: false, picked: false };
const node = { node: true, picked: false };

describe('binding table', () => {
  it('ids are unique and every combo is shown in its caps (the dialog renders caps)', () => {
    expect(new Set(BINDINGS.map((b) => b.id)).size).toBe(BINDINGS.length);
    for (const b of BINDINGS) {
      for (const cb of b.combos) expect(b.caps.map((c) => c.toUpperCase()), `${b.id}`).toContain(comboCap(cb).toUpperCase());
      if (b.combos.some((cb) => cb.mod === 'shift' || cb.mod === 'primaryShift')) expect(b.caps).toContain('Shift');
      if (b.combos.some((cb) => cb.mod.startsWith('primary'))) expect(b.caps.some((c) => c.startsWith('Ctrl'))).toBe(true);
    }
  });

  it('J / K move time, Shift+J / Shift+K step the warp, also with Caps Lock (event.key upper case)', () => {
    expect(matchBinding(key('KeyJ', 'j'), none)?.id).toBe('timeBack');
    expect(matchBinding(key('KeyK', 'k'), none)?.id).toBe('timeForward');
    expect(matchBinding(key('KeyK', 'K'), none)?.id).toBe('timeForward'); // Caps Lock
    expect(matchBinding(key('KeyJ', 'J', { shiftKey: true }), none)?.id).toBe('warpSlower');
    expect(matchBinding(key('KeyK', 'K', { shiftKey: true }), node)?.id).toBe('warpFaster');
    expect(matchBinding(key('Comma', ','), none)?.id).toBe('warpSlower');
    expect(matchBinding(key('Period', '.'), none)?.id).toBe('warpFaster');
  });

  it('ignores Ctrl / ⌘ / Alt with J / K so browser shortcuts still work', () => {
    expect(matchBinding(key('KeyJ', 'j', { ctrlKey: true }), none)).toBeNull();
    expect(matchBinding(key('KeyK', 'k', { metaKey: true }), none)).toBeNull();
    expect(matchBinding(key('KeyK', 'k', { altKey: true }), none)).toBeNull();
    expect(matchBinding(key('KeyJ', 'J', { shiftKey: true, ctrlKey: true }), none)).toBeNull();
  });

  it('keeps the existing bindings', () => {
    expect(matchBinding(key('KeyZ', 'z', { ctrlKey: true }), none)?.id).toBe('undo');
    expect(matchBinding(key('KeyZ', 'z', { metaKey: true, shiftKey: true }), none)?.id).toBe('redo');
    expect(matchBinding(key('KeyY', 'y', { ctrlKey: true }), none)?.id).toBe('redo');
    expect(matchBinding(key('KeyW', 'w'), none)).toBeNull();
    expect(matchBinding(key('KeyW', 'W', { shiftKey: true }), node)?.id).toBe('progradePlus');
    expect(matchBinding(key('KeyQ', 'q', { altKey: true }), node)?.id).toBe('radialMinus');
    expect(matchBinding(key('BracketLeft', '['), node)?.id).toBe('nodeEarlier');
    expect(matchBinding(key('Backspace', 'Backspace'), node)?.id).toBe('deleteNode');
    expect(matchBinding(key('Backspace', 'Backspace'), none)).toBeNull();
    expect(matchBinding(key('Space', ' '), none)?.id).toBe('togglePlay');
    expect(matchBinding(key('Slash', '?', { shiftKey: true }), none)?.id).toBe('help');
    expect(matchBinding(key('Escape', 'Escape'), none)?.id).toBe('clearSelection');
    expect(matchBinding(key('KeyN', 'n'), none)?.id).toBe('addNode');
    expect(matchBinding(key('Enter', 'Enter'), none)).toBeNull();
    expect(matchBinding(key('Enter', 'Enter'), { node: false, picked: true })?.id).toBe('addNode');
    expect(stepLevel(key('KeyW', 'w', { altKey: true }))).toBe(0);
    expect(stepLevel(key('KeyW', 'W', { shiftKey: true }))).toBe(2);
  });
});

describe('J / K time step', () => {
  const span: [number, number] = [1000, 5000];
  it('moves rate × real time in either direction', () => {
    expect(stepTime(2000, 1, 100, 2, span)).toBe(2200);
    expect(stepTime(2000, -1, 100, 2, span)).toBe(1800);
    expect(stepTime(2000, 1, 1000, TAP_SECONDS, span)).toBe(2100);
  });
  it('clamps to the flight span like the scrubber', () => {
    expect(stepTime(4990, 1, 1000, 1, span)).toBe(5000);
    expect(stepTime(1010, -1, 1000, 1, span)).toBe(1000);
    expect(stepTime(5000, 1, 1, 1, span)).toBe(5000);
  });
});

describe('timeline tooltip text', () => {
  const when = (t: number) => `T+${t}`;
  it('one mark: words and time', () => {
    expect(tipText([{ words: 'Apoapsis (highest point) · Earth · 200 km alt', t: 5 }], when)).toBe('Apoapsis (highest point) · Earth · 200 km alt · T+5');
  });
  it('a cluster lists its members, capped with +N more', () => {
    const marks = Array.from({ length: 7 }, (_, i) => ({ words: `M${i}`, t: i }));
    const s = tipText(marks, when);
    expect(s.split('\n')[0]).toBe('7 marks here:');
    expect(s).toContain('M0 · T+0');
    expect(s).toContain('M4 · T+4');
    expect(s).not.toContain('M5');
    expect(s).toContain('+2 more');
  });
});
