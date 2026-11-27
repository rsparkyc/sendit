/**
 * Touch-robust activation for small controls. A touch tap normally produces a
 * click, but the browser may drop it (seen on CI: pointerdown / pointerup on
 * the button, no click), deliver it late (a busy main thread), or deliver it
 * onto whatever is under the finger by then (a ghost tap on the control that
 * just moved there).
 *
 * onTap: mouse and keyboard use click. For touch and pen, a clean tap
 * (pointerdown and pointerup with the same pointerId, within a few px, not
 * cancelled) activates on pointerup, and the click that may follow is ignored
 * however late it comes, with no timer:
 *  - the element remembers it handled this press and ignores its next pointer
 *    click until the next pointerdown anywhere;
 *  - a one-shot capture-phase blocker on the document swallows the next
 *    pointer click wherever it lands (the ghost tap), disarmed by that click
 *    or by the next pointerdown.
 * A click with detail 0 (keyboard Enter / Space, element.click()) is never
 * swallowed or ignored, so keyboard use after a touch tap works at once (the
 * blocker stays armed for the late pointer click it is waiting for). A mouse
 * press disarms everything (its pointerdown).
 */
const SLOP = 12;
let armed = false;
/** Counts pointerdowns anywhere: a press's marks expire when the next one starts. */
let pressSeq = 0;
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('click', (e) => {
    if (!armed || e.detail === 0) return;
    armed = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  document.addEventListener('pointerdown', () => {
    armed = false;
    pressSeq++;
  }, true);
}

/** Run fn on a click (mouse, keyboard) or a clean touch / pen tap, once per activation. */
export function onTap(el: HTMLElement, fn: (e: Event) => void): void {
  install();
  let press: { id: number; x: number; y: number } | null = null;
  let handled = -1;
  el.addEventListener('pointerdown', (e) => {
    press = e.pointerType === 'mouse' ? null : { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  el.addEventListener('pointercancel', () => { press = null; });
  el.addEventListener('pointerup', (e) => {
    const p = press;
    press = null;
    if (!p || p.id !== e.pointerId || Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP) return;
    if ((el as HTMLButtonElement).disabled) return;
    armed = true;
    handled = pressSeq;
    fn(e);
  });
  el.addEventListener('click', (e) => {
    if (e.detail !== 0 && handled === pressSeq) return; // this press already acted on pointerup
    fn(e);
  });
}
