/**
 * A value tuner usable with a mouse, a keyboard and a finger:
 *
 *   label | [value input] | 0 | ±            (0 and ± for signed values only)
 *         | <<< << < [drag] > >> >>>       (large, medium, small steps; each shows its step)
 *
 *  - the input takes direct entry (Enter or blur commits; `inputmode` picks
 *    the on-screen keyboard: decimal pad for Δv, full keyboard for times);
 *  - the six step buttons nudge by the small, medium or large step and
 *    repeat while held; each shows its step under the arrows, number over unit
 *    (no hover needed);
 *  - the strip (role="slider") is dragged sideways: one medium step per 12 px, so a
 *    long drag is coarse and a short one fine; arrow keys on it nudge too;
 *  - the ± button negates the value (signed values only).
 *
 * No native `title` tooltips on the step buttons or the strip: they showed
 * over the neighbouring buttons. Everything they said is visible text or the
 * accessible name.
 *
 * The three step sizes come from the caller (`levels`).
 */
import { el, setValue } from './dom';

export const PX_PER_STEP = 12;

export interface TunerOptions {
  label: string;
  /** Accessible name / tooltip of the input (also what tests select by). */
  title: string;
  inputClass: string;
  inputMode: 'decimal' | 'text';
  /** Small, medium and large step. */
  levels: readonly [number, number, number];
  /** Text of a step, e.g. "1 m/s" or "10 min". */
  levelText(v: number): string;
  /** Change by delta (one nudge or a drag increment). */
  nudge(delta: number): void;
  /** Direct entry; return an error message or null. */
  commit(text: string): string | null;
  /** Negate (signed values only). */
  negate?(): void;
  /** Reset to zero (signed values only). */
  zero?(): void;
  /**
   * A pointer interaction starts (true) or ends (false): pressing a step button until the pointer
   * leaves it (so a hold, or a burst of clicks on it, is one interaction however slow), or a drag
   * of the strip. The editor groups the undo history by it.
   */
  gesture?(open: boolean): void;
}

export class Tuner {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly labelEl: HTMLElement;
  private readonly pad: HTMLElement;

  constructor(private readonly o: TunerOptions) {
    this.input = el('input', { type: 'text', title: o.title, className: o.inputClass, inputMode: o.inputMode, enterKeyHint: 'done', spellcheck: false, autocomplete: 'off' });
    this.input.setAttribute('aria-label', o.title);
    const commit = () => {
      const err = o.commit(this.input.value);
      this.input.setAttribute('aria-invalid', String(!!err));
    };
    this.input.addEventListener('change', commit);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commit();
        this.input.blur();
      }
    });
    this.labelEl = el('span', { className: 'tn-label', textContent: o.label });
    const arrows = ['<', '<<', '<<<'];
    const dec = [2, 1, 0].map((k) => this.repeatButton(arrows[k].replace(/</g, '‹'), o.levelText(o.levels[k]), `${o.label}: −${o.levelText(o.levels[k])}`, -o.levels[k]));
    const inc = [0, 1, 2].map((k) => this.repeatButton(arrows[k].replace(/</g, '›'), o.levelText(o.levels[k]), `${o.label}: +${o.levelText(o.levels[k])}`, o.levels[k]));
    this.pad = el('div', { className: 'tn-pad', tabIndex: 0, role: 'slider' },
      el('span', { className: 'tn-grip', ariaHidden: 'true', textContent: '◂ ⠿ ▸' }),
      el('span', { className: 'tn-sub', ariaHidden: 'true', textContent: 'drag' }));
    this.pad.setAttribute('aria-label', `${o.label}: drag sideways or use arrow keys`);
    this.wirePad();
    const neg = o.negate ? el('button', { className: 'btn tn-neg', type: 'button', textContent: '±' }) : null;
    if (neg) {
      neg.setAttribute('aria-label', `${o.label}: flip sign`);
      neg.onclick = () => o.negate!();
    }
    const zero = o.zero ? el('button', { className: 'btn tn-zero', type: 'button', textContent: '0' }) : null;
    if (zero) {
      zero.setAttribute('aria-label', `${o.label}: set to zero`);
      zero.onclick = () => o.zero!();
    }
    this.root = el('div', { className: 'tuner' }, this.labelEl, el('div', { className: 'tn-ctl' }, this.input, zero, neg), el('div', { className: 'tn-steps' }, ...dec, this.pad, ...inc));
  }

  setLabel(t: string): void {
    if (this.labelEl.textContent !== t) this.labelEl.textContent = t;
  }

  setValue(text: string): void {
    setValue(this.input, text);
    this.pad.setAttribute('aria-valuetext', text);
  }

  private repeatButton(arrows: string, sub: string, label: string, delta: number): HTMLButtonElement {
    // The step on two lines, number over unit ("10" / "m/s"): on one line the captions of a ~250 px dock ran together.
    const sp = sub.indexOf(' ');
    const caption = sp > 0 ? [el('span', { textContent: sub.slice(0, sp) }), el('span', { textContent: sub.slice(sp + 1) })] : [el('span', { textContent: sub })];
    const b = el('button', { className: `btn tn-step ${delta < 0 ? 'dec' : 'inc'}`, type: 'button' }, el('span', { className: 'tn-arrows', textContent: arrows }), el('span', { className: 'tn-sub' }, ...caption));
    b.setAttribute('aria-label', label);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let fired = false;
    let open = false;
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const close = () => {
      stop();
      if (open) this.o.gesture?.(false);
      open = false;
      document.removeEventListener('pointerdown', elsewhere, true);
    };
    // Also ends when the player presses anywhere else (covers a button hidden under a resting pointer).
    const elsewhere = (e: PointerEvent) => {
      if (e.target instanceof Node && b.contains(e.target)) return;
      close();
    };
    const fire = () => this.o.nudge(delta);
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      fired = false;
      if (!open) {
        this.o.gesture?.(true);
        document.addEventListener('pointerdown', elsewhere, true);
      }
      open = true;
      const repeat = (delay: number) => {
        timer = setTimeout(() => {
          fired = true;
          fire();
          repeat(Math.max(60, delay * 0.8));
        }, delay);
      };
      repeat(450);
    });
    // Releasing stops the repeat but keeps the interaction open while the pointer stays on the button
    // (more clicks on it are the same burst); leaving the button or losing focus ends it.
    b.addEventListener('pointerup', stop);
    for (const ev of ['pointerleave', 'pointercancel', 'blur']) b.addEventListener(ev, close);
    // Click covers taps, mouse clicks and keyboard; skip it if holding already repeated.
    b.addEventListener('click', () => {
      stop();
      if (!fired) fire();
      fired = false;
    });
    return b;
  }

  private wirePad(): void {
    let drag: { x: number; acc: number; id: number } | null = null;
    let pending = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (pending !== 0) {
        const d = pending;
        pending = 0;
        this.o.nudge(d);
      }
    };
    const queue = (steps: number) => {
      pending += steps * this.o.levels[1];
      if (!flushTimer) flushTimer = setTimeout(flush, 70);
    };
    this.pad.addEventListener('pointerdown', (e) => {
      if (!drag) this.o.gesture?.(true);
      drag = { x: e.clientX, acc: 0, id: e.pointerId };
      try {
        this.pad.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic */
      }
      this.pad.classList.add('dragging');
      e.preventDefault();
    });
    this.pad.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.acc += e.clientX - drag.x;
      drag.x = e.clientX;
      const steps = Math.trunc(drag.acc / PX_PER_STEP);
      if (steps !== 0) {
        drag.acc -= steps * PX_PER_STEP;
        queue(steps);
      }
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      this.pad.classList.remove('dragging');
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      this.o.gesture?.(false);
    };
    this.pad.addEventListener('pointerup', end);
    this.pad.addEventListener('pointercancel', end);
    this.pad.addEventListener('keydown', (e) => {
      const m = this.o.levels[e.shiftKey ? 2 : e.altKey ? 0 : 1];
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') this.o.nudge(m);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') this.o.nudge(-m);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
}
