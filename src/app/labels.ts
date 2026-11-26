/**
 * Screen-space markers and labels as DOM elements over the canvas. Bodies too
 * small to see get a dot; every visible object gets a label unless a
 * higher-priority label already occupies that spot.
 */

export interface LabelItem {
  key: string;
  text: string;
  color: string;
  /** Higher wins when labels overlap. */
  priority: number;
  x: number;
  y: number;
  /** Draw a dot (the object is smaller than a few pixels). */
  marker: boolean;
  /** Offset of the label from the point, px (clears the disc of large bodies). */
  offset: number;
  onScreen: boolean;
  /** Extra CSS class (e.g. event and node markers). */
  className?: string;
  /** One sentence saying what the marker is (tooltip and accessible name). */
  title?: string;
  /** Behind a body as seen from the camera: drawn dimmed and not tappable. */
  occluded?: boolean;
}

interface Entry {
  el: HTMLDivElement;
  dot: HTMLSpanElement;
  text: HTMLSpanElement;
}

export class Labels {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly root: HTMLElement,
    /** A click or tap on a label, with its client position (for double-tap detection). */
    private readonly onPick: (key: string, x: number, y: number) => void,
    /** Map element that gets gestures started on a label (a drag or a second finger), so labels never block orbiting or pinching. */
    private readonly gestureTarget?: HTMLElement,
  ) {
    if (gestureTarget) this.wireForwarding();
  }

  /**
   * A press on a label is a pick only if it stays a single, still press. As
   * soon as it moves beyond a few px or a second finger comes down, the
   * pointers are replayed on the map element (down, then every move and up),
   * and the label's click is suppressed.
   */
  private wireForwarding(): void {
    const target = this.gestureTarget!;
    const held = new Map<number, { down: PointerEvent; forwarded: boolean }>();
    let suppressClick = false;
    const clone = (type: string, e: PointerEvent) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary, clientX: e.clientX, clientY: e.clientY, button: e.button, buttons: e.buttons, pressure: e.pressure });
    const forwardAll = () => {
      for (const h of held.values()) {
        if (h.forwarded) continue;
        h.forwarded = true;
        target.dispatchEvent(clone('pointerdown', h.down));
      }
      suppressClick = true;
    };
    this.root.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('.label')) return;
      held.set(e.pointerId, { down: e, forwarded: false });
      if (held.size > 1) forwardAll();
    });
    // A second finger that lands on the map while one is held on a label: forward the held one too.
    target.addEventListener('pointerdown', (e) => {
      if (e.isTrusted && held.size > 0 && !held.has(e.pointerId)) forwardAll();
    }, true);
    this.root.addEventListener('pointermove', (e) => {
      const h = held.get(e.pointerId);
      if (!h) return;
      if (!h.forwarded && Math.hypot(e.clientX - h.down.clientX, e.clientY - h.down.clientY) > 8) forwardAll();
      if (h.forwarded) target.dispatchEvent(clone('pointermove', e));
    });
    const end = (type: string) => (e: PointerEvent) => {
      const h = held.get(e.pointerId);
      if (!h) return;
      held.delete(e.pointerId);
      if (h.forwarded) target.dispatchEvent(clone(type, e));
    };
    // Pointers whose events were captured elsewhere (the map took them over): forget them.
    for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, (e) => held.delete((e as PointerEvent).pointerId));
    this.root.addEventListener('pointerup', end('pointerup'));
    this.root.addEventListener('pointercancel', end('pointercancel'));
    this.root.addEventListener('click', (e) => {
      if (suppressClick) {
        e.stopPropagation();
        suppressClick = held.size > 0;
      }
    }, true);
  }

  private entry(item: LabelItem): Entry {
    let e = this.entries.get(item.key);
    if (e) return e;
    const el = document.createElement('div');
    el.className = 'label';
    el.dataset.key = item.key;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const text = document.createElement('span');
    text.className = 'text';
    el.append(dot, text);
    el.addEventListener('click', (ev) => this.onPick(item.key, ev.clientX, ev.clientY));
    this.root.append(el);
    e = { el, dot, text };
    this.entries.set(item.key, e);
    return e;
  }

  update(items: LabelItem[]): void {
    // Remove entries no longer present (event and node markers come and go).
    const keys = new Set(items.map((i) => i.key));
    for (const [k, e] of this.entries) {
      if (!keys.has(k)) {
        e.el.remove();
        this.entries.delete(k);
      }
    }
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const sorted = [...items].sort((a, b) => b.priority - a.priority);
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    for (const item of sorted) {
      const e = this.entry(item);
      const inView = item.onScreen && item.x > -50 && item.y > -20 && item.x < w + 50 && item.y < h + 20;
      if (!inView) {
        e.el.style.display = 'none';
        continue;
      }
      // Try right, left, below, above the point; give up (dot only) if all collide.
      const tw = 7.2 * item.text.length + 4;
      const gap = item.offset + 6;
      const candidates = [
        { dx: gap, dy: -8 },
        { dx: -gap - tw, dy: -8 },
        { dx: -tw / 2, dy: gap },
        { dx: -tw / 2, dy: -gap - 16 },
      ];
      let chosen: { dx: number; dy: number } | null = null;
      for (const c of candidates) {
        const box = { x0: item.x + c.dx, y0: item.y + c.dy, x1: item.x + c.dx + tw, y1: item.y + c.dy + 16 };
        if (!placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) {
          chosen = c;
          placed.push(box);
          break;
        }
      }
      if (!chosen && !item.marker) {
        e.el.style.display = 'none';
        continue;
      }
      e.el.style.display = '';
      const cls = `label${item.className ? ` ${item.className}` : ''}${item.occluded ? ' occluded' : ''}`;
      if (item.title !== undefined && e.text.title !== item.title) {
        e.text.title = item.title;
        e.text.setAttribute('aria-label', `${item.text}. ${item.title}`);
      }
      if (e.el.dataset.cls !== cls) {
        e.el.dataset.cls = cls;
        e.el.className = cls;
      }
      e.el.style.transform = `translate(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px)`;
      e.dot.style.display = item.marker ? '' : 'none';
      e.dot.style.background = item.color;
      if (e.text.textContent !== item.text) e.text.textContent = item.text;
      e.text.style.display = chosen ? '' : 'none';
      if (chosen) {
        e.text.style.left = `${chosen.dx}px`;
        e.text.style.top = `${chosen.dy}px`;
      }
      e.el.classList.toggle('dim', !chosen);
    }
  }
}
