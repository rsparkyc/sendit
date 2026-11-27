/**
 * The keyboard binding table: one list that drives both the key handling
 * (main.ts asks `matchBinding` which action a keydown means) and the
 * "Shortcuts and gestures" dialog (keys-dialog.ts renders `BINDINGS`), so the
 * reference cannot drift from what the keys do. Pure: no DOM.
 *
 * Letter keys that act by position (J / K, W A S D Q E, brackets, Z / Y) match
 * on `event.code`, the physical key, so Caps Lock and Shift do not change them
 * and on AZERTY / Dvorak they sit where a QWERTY J / K would be. Punctuation
 * and named keys (`,` `.` `?` Enter Escape Delete) match on `event.key`.
 */

export type ActionId =
  | 'togglePlay' | 'timeBack' | 'timeForward' | 'warpSlower' | 'warpFaster'
  | 'help' | 'clearSelection'
  | 'addNode' | 'undo' | 'redo'
  | 'progradePlus' | 'progradeMinus' | 'normalPlus' | 'normalMinus' | 'radialPlus' | 'radialMinus'
  | 'nodeEarlier' | 'nodeLater' | 'deleteNode';

export type BindingGroup = 'time' | 'map' | 'edit';

/**
 * Modifier rule for one combo:
 *  none      no Shift, Ctrl, Meta or Alt
 *  shift     Shift only
 *  anyShift  Shift ignored (e.g. `?` needs Shift on most layouts); no Ctrl / Meta / Alt
 *  level     Shift / Alt choose the step size; no Ctrl / Meta
 *  primary   Ctrl or ⌘, no Shift, no Alt
 *  primaryShift  Ctrl or ⌘ with Shift, no Alt
 */
export type ModRule = 'none' | 'shift' | 'anyShift' | 'level' | 'primary' | 'primaryShift';

export interface Combo {
  /** `event.code` to match (physical key). */
  code?: string;
  /** `event.key` to match (compared case-insensitively). */
  key?: string;
  mod: ModRule;
  /** Only when a trajectory point is picked (Enter adds a node there). */
  whenPicked?: boolean;
}

export interface Binding {
  id: ActionId;
  group: BindingGroup;
  /** Key caps shown in the dialog: alternatives separated by ' / ' are shown as separate caps. */
  caps: string[];
  desc: string;
  combos: Combo[];
  /** Acts only with a maneuver node selected (falls through otherwise). */
  needsNode?: boolean;
  /** Fires on key repeat too (default true); J / K hold handles repeat itself. */
  hold?: boolean;
}

export const GROUP_TITLE: Record<BindingGroup, string> = {
  time: 'Playback and time',
  map: 'Map and camera',
  edit: 'Nodes and editing',
};

const c = (code: string, mod: ModRule = 'none'): Combo => ({ code, mod });
const k = (key: string, mod: ModRule = 'none'): Combo => ({ key, mod });

/** In priority order: the first match wins (node-only bindings first so they shadow nothing else). */
export const BINDINGS: readonly Binding[] = [
  { id: 'undo', group: 'edit', caps: ['Ctrl / ⌘', 'Z'], desc: 'Undo the last plan edit (a drag or a burst of steps is one edit)', combos: [c('KeyZ', 'primary')] },
  { id: 'redo', group: 'edit', caps: ['Shift', 'Ctrl / ⌘', 'Z', 'or', 'Ctrl / ⌘', 'Y'], desc: 'Redo', combos: [c('KeyZ', 'primaryShift'), c('KeyY', 'primary'), c('KeyY', 'primaryShift')] },
  { id: 'progradePlus', group: 'edit', caps: ['W'], desc: 'Selected node: prograde +', combos: [c('KeyW', 'level')], needsNode: true },
  { id: 'progradeMinus', group: 'edit', caps: ['S'], desc: 'Selected node: prograde −', combos: [c('KeyS', 'level')], needsNode: true },
  { id: 'normalPlus', group: 'edit', caps: ['D'], desc: 'Selected node: normal +', combos: [c('KeyD', 'level')], needsNode: true },
  { id: 'normalMinus', group: 'edit', caps: ['A'], desc: 'Selected node: normal −', combos: [c('KeyA', 'level')], needsNode: true },
  { id: 'radialPlus', group: 'edit', caps: ['E'], desc: 'Selected node: radial out +', combos: [c('KeyE', 'level')], needsNode: true },
  { id: 'radialMinus', group: 'edit', caps: ['Q'], desc: 'Selected node: radial out −', combos: [c('KeyQ', 'level')], needsNode: true },
  { id: 'nodeEarlier', group: 'edit', caps: ['['], desc: 'Move the selected node earlier', combos: [c('BracketLeft', 'level')], needsNode: true },
  { id: 'nodeLater', group: 'edit', caps: [']'], desc: 'Move the selected node later', combos: [c('BracketRight', 'level')], needsNode: true },
  { id: 'deleteNode', group: 'edit', caps: ['Delete', 'Backspace'], desc: 'Delete the selected node (Undo brings it back)', combos: [k('Delete', 'anyShift'), k('Backspace', 'anyShift')], needsNode: true },
  { id: 'togglePlay', group: 'time', caps: ['Space'], desc: 'Pause / resume', combos: [c('Space', 'anyShift')] },
  { id: 'timeBack', group: 'time', caps: ['J'], desc: 'Hold: move the time cursor back at the current warp rate; tap: a short step (pauses playback)', combos: [c('KeyJ')], hold: false },
  { id: 'timeForward', group: 'time', caps: ['K'], desc: 'Hold: move the time cursor forward at the current warp rate; tap: a short step (pauses playback)', combos: [c('KeyK')], hold: false },
  { id: 'warpSlower', group: 'time', caps: ['Shift', 'J', 'or', ','], desc: 'Slower time warp (one step, as «)', combos: [c('KeyJ', 'shift'), k(',')] },
  { id: 'warpFaster', group: 'time', caps: ['Shift', 'K', 'or', '.'], desc: 'Faster time warp (one step, as »)', combos: [c('KeyK', 'shift'), k('.')] },
  { id: 'addNode', group: 'edit', caps: ['N', 'Enter'], desc: 'Add a node at the picked trajectory point (else N: at the time cursor)', combos: [k('n', 'anyShift'), { key: 'Enter', mod: 'none', whenPicked: true }] },
  { id: 'clearSelection', group: 'map', caps: ['Esc'], desc: 'Clear the selection; closes a dialog', combos: [k('Escape', 'anyShift')] },
  { id: 'help', group: 'map', caps: ['?'], desc: 'This reference', combos: [k('?', 'anyShift')] },
];

/** Extra rows explaining modifiers (not bindings of their own). */
export const BINDING_NOTES: readonly { group: BindingGroup; caps: string[]; desc: string }[] = [
  { group: 'edit', caps: ['Alt', '·', 'none', '·', 'Shift'], desc: 'With W S D A E Q [ ]: small / medium / large step (0.1, 1, 10 m/s; 1 s, 1 min, 10 min)' },
];

export interface KeyLike {
  code: string;
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

function modOk(e: KeyLike, m: ModRule): boolean {
  const prim = e.ctrlKey || e.metaKey;
  switch (m) {
    case 'none': return !prim && !e.altKey && !e.shiftKey;
    case 'shift': return !prim && !e.altKey && e.shiftKey;
    case 'anyShift': return !prim && !e.altKey;
    case 'level': return !prim;
    case 'primary': return prim && !e.altKey && !e.shiftKey;
    case 'primaryShift': return prim && !e.altKey && e.shiftKey;
  }
}

export function comboMatches(e: KeyLike, cb: Combo, picked = false): boolean {
  if (cb.whenPicked && !picked) return false;
  if (cb.code !== undefined && e.code !== cb.code) return false;
  if (cb.key !== undefined && e.key.toLowerCase() !== cb.key.toLowerCase()) return false;
  return modOk(e, cb.mod);
}

/** The binding a keydown means, given whether a node is selected and a trajectory point is picked. */
export function matchBinding(e: KeyLike, ctx: { node: boolean; picked: boolean }): Binding | null {
  for (const b of BINDINGS) {
    if (b.needsNode && !ctx.node) continue;
    if (b.combos.some((cb) => comboMatches(e, cb, ctx.picked))) return b;
  }
  return null;
}

/** Step level from the modifiers: 0 small (Alt), 1 medium, 2 large (Shift). */
export function stepLevel(e: KeyLike): 0 | 1 | 2 {
  return e.shiftKey ? 2 : e.altKey ? 0 : 1;
}

/** The cap text a combo's key shows as (for the "every bound key is listed" check). */
export function comboCap(cb: Combo): string {
  if (cb.key) return cb.key === 'Escape' ? 'Esc' : cb.key.length === 1 ? cb.key.toUpperCase() : cb.key;
  const code = cb.code ?? '';
  if (code.startsWith('Key')) return code.slice(3);
  return ({ Space: 'Space', BracketLeft: '[', BracketRight: ']' } as Record<string, string>)[code] ?? code;
}

/** Typing targets: keys go to the field, never to the map. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !!el.isContentEditable;
}
