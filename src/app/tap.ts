/**
 * Touch-robust activation for small controls. A touch tap normally produces a
 * click, but the browser may drop it (Chromium suppresses the click of a tap
 * that lands while it still considers an earlier touch gesture active; seen
 * on CI after a window drag), and a late click lands on whatever is under the
 * finger by then (a ghost tap on the control that just moved there).
 *
 * onTap: mouse and keyboard keep using click. For touch and pen, a clean tap
 * (pointerdown and pointerup with the same pointerId, within a few px, not
 * cancelled) activates on pointerup, and a one-shot capture-phase blocker on
 * the document then swallows the click that may follow, wherever it lands.
 * The blocker disarms on that click, on the next pointerdown or after 500 ms.
 */
const SLOP = 12;
const BLOCK_MS = 500;
let blockUntil = 0;
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('click', (e) => {
    if (performance.now() > blockUntil) return;
    blockUntil = 0;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  document.addEventListener('pointerdown', () => { blockUntil = 0; }, true);
}

/** Run fn on a click (mouse, keyboard) or a clean touch / pen tap, once per activation. */
export function onTap(el: HTMLElement, fn: (e: Event) => void): void {
  install();
  let press: { id: number; x: number; y: number } | null = null;
  el.addEventListener('pointerdown', (e) => {
    press = e.pointerType === 'mouse' ? null : { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  el.addEventListener('pointercancel', () => { press = null; });
  el.addEventListener('pointerup', (e) => {
    const p = press;
    press = null;
    if (!p || p.id !== e.pointerId || Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP) return;
    if ((el as HTMLButtonElement).disabled) return;
    blockUntil = performance.now() + BLOCK_MS;
    fn(e);
  });
  el.addEventListener('click', (e) => fn(e));
}
