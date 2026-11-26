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
    private readonly onPick: (key: string) => void,
  ) {}

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
    el.addEventListener('click', () => this.onPick(item.key));
    this.root.append(el);
    e = { el, dot, text };
    this.entries.set(item.key, e);
    return e;
  }

  update(items: LabelItem[]): void {
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
      e.el.style.transform = `translate(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px)`;
      e.dot.style.display = item.marker ? '' : 'none';
      e.dot.style.background = item.color;
      e.text.textContent = item.text;
      e.text.style.display = chosen ? '' : 'none';
      if (chosen) {
        e.text.style.left = `${chosen.dx}px`;
        e.text.style.top = `${chosen.dy}px`;
      }
      e.el.classList.toggle('dim', !chosen);
    }
  }
}
