/**
 * Undo / redo history for plan edits (pure). It stores snapshots of whatever
 * the editor considers "the document" (plan, disabled nodes, selection).
 *
 * Coalescing groups edits by interaction: an edit recorded with the same
 * non-null `key` as the previous edit (no other edit in between) does not
 * add a step when either
 *  - a gesture is open (`beginGesture` .. `endGesture`): a drag of a value,
 *    a held step button, or a burst of clicks while the pointer stays on one
 *    step button. Inside a gesture time does not matter, so a slow machine
 *    (or a slow player) cannot split one interaction into several steps; or
 *  - it comes within `windowMs` of the previous edit (idle time measured
 *    between consecutive edits, not since the first): bursts without a
 *    pointer gesture, such as taps or keyboard nudges.
 * `seal()` ends the current run (a new gesture starts a new step).
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastKey: string | null = null;
  private lastAt = -Infinity;
  private gesture = false;

  constructor(readonly limit = 200, readonly windowMs = 1500) {}

  /** Record `before`, the state the edit replaced. */
  record(before: T, key: string | null, now: number): void {
    this.future = [];
    const coalesce = key !== null && key === this.lastKey && this.past.length > 0 && (this.gesture || now - this.lastAt <= this.windowMs);
    this.lastKey = key;
    this.lastAt = now;
    if (coalesce) return;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
  }

  /** A pointer interaction with one control starts: its same-key edits are one step however long it lasts. */
  beginGesture(): void {
    this.gesture = true;
  }

  /** The interaction ended; later edits coalesce with it only within the idle window. */
  endGesture(): void {
    this.gesture = false;
  }

  seal(): void {
    this.lastKey = null;
  }

  /** The state to restore, given the current one (which becomes redoable); null if nothing to undo. */
  undo(current: T): T | null {
    const s = this.past.pop();
    if (s === undefined) return null;
    this.future.push(current);
    this.seal();
    return s;
  }

  redo(current: T): T | null {
    const s = this.future.pop();
    if (s === undefined) return null;
    this.past.push(current);
    this.seal();
    return s;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.seal();
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
