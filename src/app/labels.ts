/**
 * Screen-space markers and labels as DOM elements over the canvas. Bodies too
 * small to see get a dot. Which labels show, where, and which markers
 * collapse into a cluster is decided by label-layout.ts (pure).
 */
import { layoutLabels, type Disc, type Placed } from './label-layout';

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
  /** Absolute time of the marked point (fading and time relevance). */
  t?: number;
}

interface Entry {
  line?: HTMLSpanElement;
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
    /** The key of a marker dot within its tap radius of a client point, or null (a tap on text goes to the dot then). */
    private readonly dotAt?: (x: number, y: number) => string | null,
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
    el.addEventListener('click', (ev) => {
      // A marker dot under the tap wins over this label's text (pick.ts dotUnderTap): the text may cover another
      // marker's, or a cluster's, dot.
      const key = this.dotAt?.(ev.clientX, ev.clientY) ?? item.key;
      const target = this.entries.get(key)?.el ?? el;
      if (target.dataset.cluster) {
        this.expanded = key;
        return;
      }
      this.onPick(key, ev.clientX, ev.clientY);
    });
    this.root.append(el);
    e = { el, dot, text };
    this.entries.set(item.key, e);
    return e;
  }

  /** Leader of the expanded cluster (a tap on a cluster expands it; a tap elsewhere or a new selection collapses it). */
  expanded: string | null = null;
  /** Cluster radius of the last layout, px (larger in touch mode). */
  clusterRadius = 7;

  update(items: LabelItem[], ctx: { cursor: number; fadeScale: number; discs: readonly Disc[]; touch: boolean } = { cursor: 0, fadeScale: 0, discs: [], touch: false }): Placed[] {
    // Remove entries no longer present (event and node markers come and go).
    const keys = new Set(items.map((i) => i.key));
    for (const [k, e] of this.entries) {
      if (!keys.has(k)) {
        e.el.remove();
        this.entries.delete(k);
      }
    }
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    const shown = items.filter((i) => i.onScreen);
    if (this.expanded && !shown.some((i) => i.key === this.expanded)) this.expanded = null;
    this.clusterRadius = ctx.touch ? 22 : 7;
    const layout = layoutLabels(shown.map((i) => ({
      key: i.key, text: i.text, priority: i.priority, x: i.x, y: i.y, marker: i.marker, offset: i.offset, t: i.t,
      selected: /\bselected\b/.test(i.className ?? ''), keep: /\bfailure\b/.test(i.className ?? ''), occluded: i.occluded, body: /^\d+$/.test(i.key),
    })), { width: w, height: h, cursor: ctx.cursor, fadeScale: ctx.fadeScale, discs: ctx.discs, clusterRadius: this.clusterRadius, expanded: this.expanded });
    const byKey = new Map(layout.map((p) => [p.key, p]));
    for (const item of items) {
      const e = this.entry(item);
      const p = byKey.get(item.key);
      if (!p || p.hidden || (!p.label && !item.marker)) {
        e.el.style.display = 'none';
        continue;
      }
      e.el.style.display = '';
      const cls = `label${item.className ? ` ${item.className}` : ''}${item.occluded ? ' occluded' : ''}${p.clusterSize > 0 ? ' cluster' : ''}`;
      if (item.title !== undefined && e.text.title !== item.title) {
        e.text.title = item.title;
        e.text.setAttribute('aria-label', `${item.text}. ${item.title}`);
      }
      if (e.el.dataset.cls !== cls) {
        e.el.dataset.cls = cls;
        e.el.className = cls;
      }
      e.el.dataset.cluster = p.clusterSize > 0 ? String(p.clusterSize) : '';
      e.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      e.el.style.opacity = p.opacity < 1 && !item.occluded ? p.opacity.toFixed(2) : '';
      e.dot.style.display = item.marker ? '' : 'none';
      e.dot.style.background = item.color;
      if (e.el.style.getPropertyValue('--mc') !== item.color) e.el.style.setProperty('--mc', item.color); // marker colour for rings and boxes (style.css)
      if (e.text.textContent !== p.text) e.text.textContent = p.text;
      e.text.style.display = p.label ? '' : 'none';
      if (p.label) {
        e.text.style.left = `${p.label.dx}px`;
        e.text.style.top = `${p.label.dy}px`;
      }
      this.leader(e, p.leader);
      e.el.classList.toggle('dim', !p.label);
    }
    return layout;
  }

  private leader(e: Entry, l: Placed['leader']): void {
    if (!l) {
      if (e.line) e.line.style.display = 'none';
      return;
    }
    if (!e.line) {
      e.line = document.createElement('span');
      e.line.className = 'leader';
      e.el.prepend(e.line);
    }
    const len = Math.hypot(l.x1 - l.x0, l.y1 - l.y0);
    e.line.style.display = len > 2 ? '' : 'none';
    e.line.style.width = `${len.toFixed(1)}px`;
    e.line.style.transform = `translate(${l.x0.toFixed(1)}px, ${l.y0.toFixed(1)}px) rotate(${Math.atan2(l.y1 - l.y0, l.x1 - l.x0).toFixed(4)}rad)`;
  }
}
