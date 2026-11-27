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
/** Controls wired with onTap (or that otherwise act on pointerup themselves): the tap layer leaves them alone. */
const own = new WeakSet<Element>();

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
  // The compatibility mousedown that may follow a handled touch tap (no pointerdown precedes it; a real mouse
  // press's pointerdown disarms first) would move focus back onto the tapped control after its action ran.
  document.addEventListener('mousedown', (e) => {
    if (armed) e.preventDefault();
  }, true);
}

/** Arm the late-click blocker for a press a control handled itself on pointerup (e.g. the sheet grip). */
export function armClickBlock(): void {
  install();
  armed = true;
}

/** Exclude a control from the tap layer (it handles touch activation itself). */
export function ownTap(el: Element): void {
  own.add(el);
}

function focusFor(el: HTMLElement): void {
  if (document.activeElement !== el && el.tabIndex >= 0) el.focus({ preventScroll: true });
}

/**
 * Controls the tap layer covers: buttons and the ARIA button-likes the UI builds (rows via role="button", tabs,
 * radio choices, switches), <summary>, and anything marked data-tap. Not: native form fields, links, sliders,
 * drag handles (they do not match, or their pointerdown is defaultPrevented: they manage their own gesture).
 */
const CONTROL = 'button, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="option"], summary, [data-tap]';
const NATIVE = 'input, select, textarea, a[href], label, [contenteditable=""], [contenteditable="true"], [data-tap="native"]';

function controlOf(t: EventTarget | null): HTMLElement | null {
  if (!(t instanceof Element)) return null;
  const c = t.closest<HTMLElement>(CONTROL);
  if (!c) return null;
  const n = t.closest(NATIVE);
  if (n && (n === c || c.contains(n))) return null; // a field or link inside (or as) the control keeps native behaviour
  return c;
}

let layer = false;
/**
 * The tap layer: onTap's touch behaviour for every button-like control at once, without wiring each. A clean
 * touch / pen tap on a control (same pointerId, <= 12 px, not cancelled, pointerdown / pointerup not
 * defaultPrevented, control not disabled and not wired with onTap) dispatches the control's click on pointerup
 * (detail 1, the tap's coordinates), focuses it as a tap would, and arms the blocker so the browser's own click
 * (prompt, late, or landing on another control) is swallowed. Handlers keep listening to click, so mouse and
 * keyboard are untouched, and onclick / click listeners see one click per tap whether or not the browser drops
 * its own. Install once at startup.
 */
export function installTapLayer(): void {
  if (layer) return;
  layer = true;
  install();
  let press: { id: number; x: number; y: number; c: HTMLElement; down: PointerEvent } | null = null;
  document.addEventListener('pointerdown', (e) => {
    press = null;
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    const c = controlOf(e.target);
    if (c && !own.has(c)) press = { id: e.pointerId, x: e.clientX, y: e.clientY, c, down: e };
  }, true);
  document.addEventListener('pointercancel', () => { press = null; }, true);
  // Bubble phase on window: the control's own pointerup handlers (e.g. a held step button stopping its repeat) run first.
  window.addEventListener('pointerup', (e) => {
    const p = press;
    press = null;
    if (!p || p.id !== e.pointerId || p.down.defaultPrevented || e.defaultPrevented) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP) return;
    const c = p.c;
    if (!c.isConnected || (c as HTMLButtonElement).disabled || c.closest('fieldset:disabled, [inert]')) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (!hit || !c.contains(hit)) return; // the control moved or was covered: leave it to the browser
    focusFor(c);
    c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, view: window }));
    armed = true;
  });
}

/** Run fn on a click (mouse, keyboard) or a clean touch / pen tap, once per activation. */
export function onTap(el: HTMLElement, fn: (e: Event) => void): void {
  install();
  own.add(el);
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
    focusFor(el);
    fn(e);
  });
  el.addEventListener('click', (e) => {
    if (e.detail !== 0 && handled === pressSeq) return; // this press already acted on pointerup
    fn(e);
  });
}
