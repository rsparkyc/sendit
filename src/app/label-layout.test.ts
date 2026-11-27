import { describe, expect, it } from 'vitest';
import { effectivePriority, fadeOpacity, layoutLabels, type LayoutItem, type LayoutOptions } from './label-layout';

const base: LayoutOptions = { width: 800, height: 600, cursor: 0, fadeScale: 3600, discs: [], clusterRadius: 12 };
const mk = (key: string, x: number, y: number, priority = 100, extra: Partial<LayoutItem> = {}): LayoutItem => ({ key, text: key.toUpperCase(), priority, x, y, marker: true, offset: 0, ...extra });
type Box = { x0: number; y0: number; x1: number; y1: number };
const box = (p: { x: number; y: number; label: { dx: number; dy: number } | null; text: string }): Box | null =>
  p.label ? { x0: p.x + p.label.dx, y0: p.y + p.label.dy, x1: p.x + p.label.dx + 7.2 * p.text.length + 4, y1: p.y + p.label.dy + 16 } : null;
const overlap = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

describe('label layout', () => {
  it('collapses co-located markers into one cluster led by the strongest, with a count', () => {
    const out = layoutLabels([mk('burn', 400, 300, 700), mk('sep', 403, 302, 680), mk('pe', 398, 299, 12)], base);
    const [burn, sep, pe] = out;
    expect(burn.clusterSize).toBe(2);
    expect(burn.text).toBe('BURN +2');
    expect(sep.clusteredInto).toBe('burn');
    expect(pe.clusteredInto).toBe('burn');
    expect(sep.hidden && pe.hidden).toBe(true);
  });

  it('an expanded cluster fans its members out with leader lines back to their true points', () => {
    const out = layoutLabels([mk('burn', 400, 300, 700), mk('sep', 403, 302, 680)], { ...base, expanded: 'burn' });
    const sep = out[1];
    expect(sep.hidden).toBe(false);
    expect(Math.hypot(sep.x - 400, sep.y - 300)).toBeGreaterThan(30);
    expect(sep.leader).not.toBeNull();
    expect(sep.x + sep.leader!.x0).toBeCloseTo(403);
    expect(sep.y + sep.leader!.y0).toBeCloseTo(302);
    expect(out[0].clusterSize).toBe(0);
  });

  it('never absorbs the selected item or a body', () => {
    const out = layoutLabels([mk('a', 400, 300, 900), mk('b', 402, 300, 10, { selected: true }), mk('0', 401, 300, 5, { body: true })], base);
    expect(out[1].clusteredInto).toBeNull();
    expect(out[2].clusteredInto).toBeNull();
  });

  it('placed labels never overlap each other or a large body disc', () => {
    const items: LayoutItem[] = [];
    for (let k = 0; k < 30; k++) items.push(mk(`m${k}`, 300 + (k % 6) * 30, 250 + Math.floor(k / 6) * 25, 100 + k));
    const disc = { x: 380, y: 300, r: 40 };
    const out = layoutLabels(items, { ...base, discs: [disc] });
    const boxes = out.map(box).filter((b): b is Box => !!b);
    expect(boxes.length).toBeGreaterThan(5);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false);
    for (const b of boxes) {
      const cx = Math.max(b.x0, Math.min(disc.x, b.x1)), cy = Math.max(b.y0, Math.min(disc.y, b.y1));
      expect(Math.hypot(cx - disc.x, cy - disc.y)).toBeGreaterThanOrEqual(disc.r);
    }
  });

  it('uses a leader line when the first ring is full', () => {
    const items: LayoutItem[] = [];
    for (let k = 0; k < 8; k++) items.push(mk(`marker-${k}`, 400 + 16 * Math.cos(k), 300 + 16 * Math.sin(k), 900 - k));
    const out = layoutLabels(items, { ...base, clusterRadius: 4 });
    expect(out.some((p) => p.label && p.leader)).toBe(true);
  });

  it('prefers items near the time cursor and the selection; fades items far in time', () => {
    const near = mk('near', 0, 0, 100, { t: 100 });
    const far = mk('far', 0, 0, 100, { t: 100_000 });
    expect(effectivePriority(near, 0, 3600)).toBeGreaterThan(effectivePriority(far, 0, 3600));
    expect(effectivePriority({ ...far, selected: true }, 0, 3600)).toBeGreaterThan(effectivePriority(near, 0, 3600));
    expect(fadeOpacity(1000, 3600)).toBe(1);
    expect(fadeOpacity(10 * 3600, 3600)).toBe(0.35);
    // A failure (keep) stays named however far in time; an ordinary marker that far loses its name.
    const far2 = layoutLabels([mk('impact', 400, 300, 900, { t: 1e6, keep: true }), mk('pe', 100, 100, 12, { t: 1e6 })], base);
    expect(far2[0].label).not.toBeNull();
    expect(far2[1].label).toBeNull();
    // Two markers competing for one spot: the one near the cursor gets the text.
    const out = layoutLabels([mk('far', 400, 300, 100, { t: 50_000 }), mk('near', 420, 300, 100, { t: 10 })], { ...base, clusterRadius: 5, width: 470 });
    expect(out[1].label).not.toBeNull();
  });

  it('a point over a globe gets its label outside the disc, with a leader line', () => {
    const disc = { x: 400, y: 300, r: 120 };
    const out = layoutLabels([mk('site', 420, 310, 500), mk('burn', 380, 280, 700)], { ...base, discs: [disc] });
    for (const p of out) {
      expect(p.label).not.toBeNull();
      expect(p.leader).not.toBeNull();
      const b = box(p)!;
      const cx = Math.max(b.x0, Math.min(disc.x, b.x1)), cy = Math.max(b.y0, Math.min(disc.y, b.y1));
      expect(Math.hypot(cx - disc.x, cy - disc.y)).toBeGreaterThanOrEqual(disc.r);
    }
  });

  it('occluded markers keep a dot, lose their text and are not clustered', () => {
    const out = layoutLabels([mk('a', 400, 300, 900), mk('b', 401, 300, 100, { occluded: true })], base);
    expect(out[1].clusteredInto).toBeNull();
    expect(out[1].label).toBeNull();
    expect(out[1].hidden).toBe(false);
  });
});
