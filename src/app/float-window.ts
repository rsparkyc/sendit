/**
 * A floating panel window over the map (desktop and landscape tablets): the
 * same panel nodes the dock holds, moved here by layout.ts (never rebuilt, so
 * inputs keep their state). Not modal: the map stays live around it, and
 * pointer and wheel events over the window stay in it (they never reach the
 * canvas, which only listens on itself).
 *
 * Title bar: drag to move (pointer events: mouse, pen and touch); a move grip
 * (arrow keys move it, Shift for larger steps), an opacity slider, collapse to
 * the title bar, dock back. Resize by the right and bottom edges and the
 * corner (corner: arrow keys too). Only the background is translucent; the
 * text keeps full opacity, with a blur behind it so it stays readable.
 */
import { el } from './dom';
import { onTap } from './tap';
import { DEFAULT_OPACITY, FLOAT_MIN_H, FLOAT_MIN_W, OPACITY_MIN, clampRect, type FloatState } from './float-geom';

export interface FloatHooks {
  /** State changed by the user (drag end, resize end, opacity, collapse): persist it. */
  changed(): void;
  dock(): void;
  front(): void;
  /** Escape in the window: focus its tab. */
  escape(): void;
}

export class FloatWindow {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly collapseBtn: HTMLButtonElement;
  private readonly opacityIn: HTMLInputElement;

  constructor(readonly tab: string, label: string, readonly state: FloatState, private readonly hooks: FloatHooks) {
    const titleId = `fw-title-${tab}`;
    const grip = el('button', { className: 'btn small fw-move', type: 'button', textContent: '⠿', title: 'Drag the title bar to move; arrow keys move (Shift: faster)' });
    grip.setAttribute('aria-label', `Move the ${label} window (arrow keys)`);
    this.opacityIn = el('input', { className: 'fw-opacity', type: 'range', min: String(OPACITY_MIN * 100), max: '100', step: '5', title: 'Background opacity' });
    this.opacityIn.setAttribute('aria-label', `${label} window background opacity`);
    this.collapseBtn = el('button', { className: 'btn small fw-collapse', type: 'button' });
    const dock = el('button', { className: 'btn small fw-dock', type: 'button', textContent: '⇥', title: 'Dock back' });
    dock.setAttribute('aria-label', `Dock the ${label} window back`);
    this.bar = el('div', { className: 'fw-bar' },
      grip,
      el('h2', { className: 'fw-title', id: titleId, textContent: label }),
      this.opacityIn, this.collapseBtn, dock);
    this.body = el('div', { className: 'fw-body' });
    const handles = (['e', 's', 'se'] as const).map((d) => this.resizer(d, label));
    this.root = el('section', { className: 'float-win', tabIndex: -1 }, this.bar, this.body, ...handles);
    this.root.dataset.tab = tab;
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-labelledby', titleId);

    this.root.addEventListener('pointerdown', () => this.hooks.front(), true);
    this.root.addEventListener('focusin', () => this.hooks.front());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hooks.escape();
    });
    // Belt and braces: nothing inside a window counts as a map gesture.
    for (const t of ['pointerdown', 'wheel', 'contextmenu'] as const) this.root.addEventListener(t, (e) => e.stopPropagation());

    this.opacityIn.addEventListener('input', () => {
      this.state.opacity = Number(this.opacityIn.value) / 100;
      this.render();
    });
    this.opacityIn.addEventListener('change', () => this.hooks.changed());
    onTap(this.collapseBtn, () => {
      this.state.collapsed = !this.state.collapsed;
      this.render();
      this.clamp();
      this.hooks.changed();
    });
    onTap(dock, () => this.hooks.dock());
    this.wireDrag();
    grip.addEventListener('keydown', (e) => {
      const d = this.arrow(e);
      if (!d) return;
      this.state.x += d[0];
      this.state.y += d[1];
      this.clamp();
      this.hooks.changed();
    });
    this.render();
  }

  /** Arrow key step [dx, dy], or null (and the event is left alone). */
  private arrow(e: KeyboardEvent): [number, number] | null {
    const s = e.shiftKey ? 40 : 10;
    const d: Record<string, [number, number]> = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] };
    const v = d[e.key];
    if (!v) return null;
    e.preventDefault();
    e.stopPropagation();
    return v;
  }

  private wireDrag(): void {
    let drag: { px: number; py: number; x: number; y: number; id: number } | null = null;
    this.bar.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('input, button:not(.fw-move)') || e.button > 0) return;
      drag = { px: e.clientX, py: e.clientY, x: this.state.x, y: this.state.y, id: e.pointerId };
      try { this.bar.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      this.root.classList.add('dragging');
      e.preventDefault();
    });
    this.bar.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      this.state.x = drag.x + e.clientX - drag.px;
      this.state.y = drag.y + e.clientY - drag.py;
      this.clamp();
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      this.root.classList.remove('dragging');
      this.hooks.changed();
    };
    this.bar.addEventListener('pointerup', end);
    this.bar.addEventListener('pointercancel', end);
  }

  private resizer(dir: 'e' | 's' | 'se', label: string): HTMLElement {
    const h = el('div', { className: `fw-rz ${dir}` });
    if (dir === 'se') {
      h.tabIndex = 0;
      h.setAttribute('role', 'button');
      h.setAttribute('aria-label', `Resize the ${label} window (arrow keys)`);
      h.title = 'Drag to resize; arrow keys resize (Shift: faster)';
      h.addEventListener('keydown', (e) => {
        const d = this.arrow(e);
        if (!d) return;
        this.state.w += d[0];
        this.state.h += d[1];
        this.clamp();
        this.hooks.changed();
      });
    }
    let drag: { px: number; py: number; w: number; h: number; id: number } | null = null;
    h.addEventListener('pointerdown', (e) => {
      drag = { px: e.clientX, py: e.clientY, w: this.state.w, h: this.state.h, id: e.pointerId };
      try { h.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      this.root.classList.add('resizing');
      e.preventDefault();
    });
    h.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      // Grow toward the pointer, but never past the viewport edge (the position stays put).
      const maxW = window.innerWidth - 4 - this.state.x;
      const maxH = window.innerHeight - 4 - this.state.y;
      if (dir !== 's') this.state.w = Math.max(FLOAT_MIN_W, Math.min(maxW, drag.w + e.clientX - drag.px));
      if (dir !== 'e') this.state.h = Math.max(FLOAT_MIN_H, Math.min(maxH, drag.h + e.clientY - drag.py));
      this.clamp();
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      this.root.classList.remove('resizing');
      this.hooks.changed();
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
    return h;
  }

  /** Keep the window in the viewport (also after the browser window changes size). */
  clamp(): void {
    const barH = this.bar.getBoundingClientRect().height || 34;
    Object.assign(this.state, clampRect(this.state, window.innerWidth, window.innerHeight, this.state.collapsed ? barH + 2 : undefined));
    this.place();
  }

  private place(): void {
    const s = this.root.style;
    s.left = `${this.state.x}px`;
    s.top = `${this.state.y}px`;
    s.width = `${this.state.w}px`;
    s.height = this.state.collapsed ? '' : `${this.state.h}px`;
    s.zIndex = String(this.state.z);
  }

  render(): void {
    const st = this.state;
    if (!(st.opacity >= OPACITY_MIN && st.opacity <= 1)) st.opacity = DEFAULT_OPACITY;
    this.root.style.setProperty('--fw-alpha', String(st.opacity));
    const pct = String(Math.round(st.opacity * 100));
    if (this.opacityIn.value !== pct && document.activeElement !== this.opacityIn) this.opacityIn.value = pct;
    this.opacityIn.setAttribute('aria-valuetext', `${pct} %`);
    this.root.classList.toggle('collapsed', st.collapsed);
    this.body.hidden = st.collapsed;
    const label = this.root.querySelector('.fw-title')?.textContent ?? '';
    this.collapseBtn.textContent = st.collapsed ? '▸' : '▾';
    this.collapseBtn.setAttribute('aria-label', `${st.collapsed ? 'Expand' : 'Collapse'} the ${label} window`);
    this.collapseBtn.title = st.collapsed ? 'Expand' : 'Collapse to the title bar';
    this.collapseBtn.setAttribute('aria-expanded', String(!st.collapsed));
    this.place();
  }

  /** Draw the eye to the window (its tab was pressed, or something selected it). */
  flash(): void {
    this.root.classList.remove('flash');
    void this.root.offsetWidth;
    this.root.classList.add('flash');
    setTimeout(() => this.root.classList.remove('flash'), 700);
  }
}
