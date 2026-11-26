/**
 * Undo / redo history for plan edits (pure). It stores snapshots of whatever
 * the editor considers "the document" (plan, disabled nodes, selection).
 *
 * Coalescing: an edit recorded with the same non-null `key` as the previous
 * one, within `windowMs` of it, does not add a step: a drag of a value, a
 * held step button or a burst of step clicks on one component undoes in one
 * go. `seal()` ends the current run (a new gesture starts a new step).
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastKey: string | null = null;
  private lastAt = -Infinity;

  constructor(readonly limit = 200, readonly windowMs = 1500) {}

  /** Record `before`, the state the edit replaced. */
  record(before: T, key: string | null, now: number): void {
    this.future = [];
    const coalesce = key !== null && key === this.lastKey && now - this.lastAt <= this.windowMs && this.past.length > 0;
    this.lastKey = key;
    this.lastAt = now;
    if (coalesce) return;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
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
