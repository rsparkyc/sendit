/**
 * A value tuner usable with a mouse, a keyboard and a finger:
 *
 *   label | [value input] | 0 | ± | ◂▸ drag strip
 *         | <<< << < | > >> >>>      (large, medium, small steps; each shows its step)
 *
 *  - the input takes direct entry (Enter or blur commits; `inputmode` picks
 *    the on-screen keyboard: decimal pad for Δv, full keyboard for times);
 *  - the six step buttons nudge by the small, medium or large step and
 *    repeat while held; each shows its step under the arrows (no hover needed);
 *  - the strip (role="slider") is dragged sideways: one medium step per 12 px, so a
 *    long drag is coarse and a short one fine; arrow keys on it nudge too;
 *  - on touch layouts a ± button negates (decimal pads have no minus key).
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
    const steps = [2, 1, 0].map((k) => this.repeatButton(arrows[k].replace(/</g, '‹'), o.levelText(o.levels[k]), `${o.label}: −${o.levelText(o.levels[k])}`, -o.levels[k]))
      .concat([0, 1, 2].map((k) => this.repeatButton(arrows[k].replace(/</g, '›'), o.levelText(o.levels[k]), `${o.label}: +${o.levelText(o.levels[k])}`, o.levels[k])));
    this.pad = el('div', { className: 'tn-pad', tabIndex: 0, role: 'slider', title: `Drag sideways to tune ${o.label}` }, el('span', { ariaHidden: 'true', textContent: '◂ ▸' }));
    this.pad.setAttribute('aria-label', `${o.label}: drag sideways or use arrow keys`);
    this.wirePad();
    const neg = o.negate ? el('button', { className: 'btn tn-neg', type: 'button', textContent: '±', title: `Negate ${o.label}` }) : null;
    if (neg) neg.onclick = () => o.negate!();
    const zero = o.zero ? el('button', { className: 'btn tn-zero', type: 'button', textContent: '0', title: `Set ${o.label} to zero` }) : null;
    if (zero) {
      zero.setAttribute('aria-label', `${o.label}: set to zero`);
      zero.onclick = () => o.zero!();
    }
    this.root = el('div', { className: 'tuner' }, this.labelEl, el('div', { className: 'tn-ctl' }, this.input, zero, neg, this.pad), el('div', { className: 'tn-steps' }, ...steps));
  }

  setLabel(t: string): void {
    if (this.labelEl.textContent !== t) this.labelEl.textContent = t;
  }

  setValue(text: string): void {
    setValue(this.input, text);
    this.pad.setAttribute('aria-valuetext', text);
  }

  private repeatButton(arrows: string, sub: string, label: string, delta: number): HTMLButtonElement {
    const b = el('button', { className: `btn tn-step ${delta < 0 ? 'dec' : 'inc'}`, type: 'button', title: label }, el('span', { className: 'tn-arrows', textContent: arrows }), el('span', { className: 'tn-sub', textContent: sub }));
    b.setAttribute('aria-label', label);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let fired = false;
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const fire = () => this.o.nudge(delta);
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      fired = false;
      const repeat = (delay: number) => {
        timer = setTimeout(() => {
          fired = true;
          fire();
          repeat(Math.max(60, delay * 0.8));
        }, delay);
      };
      repeat(450);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
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
