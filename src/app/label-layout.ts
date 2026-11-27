/**
 * Map label layout (pure; labels.ts applies it to the DOM). Near a body the
 * markers of a flight (burns and their ends, separations, apsides, nodes,
 * launch sites) pile up on a few pixels; this decides, per frame:
 *
 *  - PRIORITY: an item's own priority (by kind, set by main.ts), raised for
 *    the selected item and for items close in time to the cursor, so the
 *    labels that matter now win the space.
 *  - CLUSTERS: markers whose dots lie within a cluster radius of a stronger
 *    marker collapse into it; the strongest one is drawn with a "+N" badge
 *    and is one tap target (key `cluster:<leader>`). Expanding it fans its
 *    members out on a ring, each joined to its true point by a leader line.
 *    The selected item and bodies are never absorbed.
 *  - PLACEMENT: each label tries positions around its point (right, left,
 *    below, above, the diagonals), then the same further out with a leader
 *    line; a position is refused if it overlaps a placed label or the disc
 *    of a body drawn larger than a few pixels (labels never sit on a globe).
 *    No room: the dot stays (tappable), the text is hidden.
 *  - FADING: items with a time far from the cursor fade (opacity down to
 *    0.35; their text is dropped first when space is short).
 *  - OVER A GLOBE: a point drawn over a body's disc (a launch site, a marker
 *    in front of the planet) has its label put just outside the disc with a
 *    leader line, never on the globe.
 *  - OCCLUSION: an item behind a body keeps a dimmed dot and loses its text
 *    (unless it is the selected item or a failure, which stay named), and is
 *    never a tap target (main.ts candidatesAt).
 *
 * Dots stay tap targets whatever happens to their text: the map's tap
 * picking (main.ts candidatesAt) works on the dot positions with a 28 px
 * radius on touch (a 56 px target), so a marker whose text is hidden is
 * still tappable; a cluster is one target that expands on the first tap.
 */

export interface LayoutItem {
  key: string;
  text: string;
  priority: number;
  x: number;
  y: number;
  /** Draws a dot (markers, small bodies). Only markers cluster. */
  marker: boolean;
  /** Radius of the object's own disc, px (labels start outside it). */
  offset: number;
  /** Absolute time of the marked point, when it has one. */
  t?: number;
  selected?: boolean;
  occluded?: boolean;
  /** Bodies are never clustered. */
  body?: boolean;
  /** Always named when there is room, however far in time (a failure: impact, atmosphere). */
  keep?: boolean;
}

export interface Disc { x: number; y: number; r: number }

export interface LayoutOptions {
  width: number;
  height: number;
  /** Time cursor (absolute s). */
  cursor: number;
  /** Time scale (s) over which labels fade with distance from the cursor. */
  fadeScale: number;
  /** Screen discs of bodies (labels must not overlap them). */
  discs: readonly Disc[];
  /** Cluster radius, px (larger on touch). */
  clusterRadius: number;
  /** Leader of an expanded cluster, if any. */
  expanded?: string | null;
  /** Average glyph width, px (text width estimate). */
  charWidth?: number;
}

export interface Placed {
  key: string;
  /** Dot position (a fanned-out cluster member: its ring position). */
  x: number;
  y: number;
  /** Text offset from (x, y), or null when the text is hidden. */
  label: { dx: number; dy: number } | null;
  /** Leader line from the dot to the label (or, for a fanned member, from its true point to its ring position): offsets from (x, y). */
  leader: { x0: number; y0: number; x1: number; y1: number } | null;
  opacity: number;
  /** Leader of the cluster this item was absorbed into (not drawn), or null. */
  clusteredInto: string | null;
  /** A cluster leader's count of absorbed members (0: not a cluster). */
  clusterSize: number;
  /** Shown text (a cluster leader's carries "+N"). */
  text: string;
  hidden: boolean;
}

const H = 16;

export function effectivePriority(it: LayoutItem, cursor: number, fadeScale: number): number {
  let p = it.priority;
  if (it.selected) p += 5000;
  if (it.keep) p += 3000;
  if (it.t !== undefined && fadeScale > 0) p += 400 * Math.exp(-Math.abs(it.t - cursor) / fadeScale);
  if (it.occluded && !it.selected) p -= 2000;
  return p;
}

/** Opacity of an item at |dt| from the cursor: 1 within fadeScale, down to 0.35 at 6x. */
export function fadeOpacity(dt: number | undefined, fadeScale: number): number {
  if (dt === undefined || !(fadeScale > 0)) return 1;
  const k = Math.abs(dt) / fadeScale;
  if (k <= 1) return 1;
  return Math.max(0.35, 1 - (0.65 * (k - 1)) / 5);
}

interface Box { x0: number; y0: number; x1: number; y1: number }
const hits = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
function hitsDisc(b: Box, d: Disc): boolean {
  const cx = Math.max(b.x0, Math.min(d.x, b.x1));
  const cy = Math.max(b.y0, Math.min(d.y, b.y1));
  return Math.hypot(cx - d.x, cy - d.y) < d.r;
}

export function layoutLabels(items: readonly LayoutItem[], o: LayoutOptions): Placed[] {
  const cw = o.charWidth ?? 7.2;
  const order = items
    .map((it) => ({ it, p: effectivePriority(it, o.cursor, o.fadeScale) }))
    .sort((a, b) => b.p - a.p || (a.it.key < b.it.key ? -1 : 1));
  const out = new Map<string, Placed>();
  const inView = (it: LayoutItem) => it.x > -50 && it.y > -20 && it.x < o.width + 50 && it.y < o.height + 20;

  // 1. Clusters: greedy, strongest first.
  const leaders: { it: LayoutItem; members: LayoutItem[] }[] = [];
  const memberOf = new Map<string, string>();
  for (const { it } of order) {
    if (!inView(it)) continue;
    const canJoin = it.marker && !it.body && !it.selected && !it.occluded;
    const lead = canJoin ? leaders.find((l) => l.it.marker && !l.it.body && !l.it.occluded && Math.hypot(l.it.x - it.x, l.it.y - it.y) < o.clusterRadius) : undefined;
    if (lead) {
      lead.members.push(it);
      memberOf.set(it.key, lead.it.key);
    } else leaders.push({ it, members: [] });
  }

  // 2. Placement.
  const placed: Box[] = [];
  const discs = o.discs.filter((d) => d.r > 4);
  const free = (b: Box, own: LayoutItem) => !placed.some((p) => hits(b, p)) && !discs.some((d) => !(own.body && Math.hypot(d.x - own.x, d.y - own.y) < 1) && hitsDisc(b, d));
  const place = (it: LayoutItem, x: number, y: number, text: string): { label: Placed['label']; leader: Placed['leader'] } => {
    if (!text) return { label: null, leader: null };
    const tw = cw * text.length + 4;
    const tryBox = (dx: number, dy: number): boolean => {
      const b = { x0: x + dx, y0: y + dy, x1: x + dx + tw, y1: y + dy + H };
      if (b.x0 < 0 || b.x1 > o.width || b.y0 < 0 || b.y1 > o.height || !free(b, it)) return false;
      placed.push(b);
      return true;
    };
    const lead = (dx: number, dy: number) => ({ x0: 0, y0: 0, x1: Math.max(dx, Math.min(0, dx + tw)), y1: Math.max(dy, Math.min(0, dy + H)) });
    // A point drawn over a globe (a launch site, a marker in front of the planet): its label goes just outside
    // the disc, along the ray from the disc's centre through the point, with a leader line.
    const over = it.body ? undefined : discs.filter((d) => Math.hypot(x - d.x, y - d.y) < d.r).sort((a, b) => b.r - a.r)[0];
    if (over) {
      const a0 = Math.atan2(y - over.y, x - over.x);
      for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 6, -6, 8, -8, 12]) {
        const a = a0 + k * 0.18;
        const ex = over.x + (over.r + 8) * Math.cos(a), ey = over.y + (over.r + 8) * Math.sin(a);
        const dx = (Math.cos(a) >= 0 ? ex : ex - tw) - x;
        const dy = ey - H / 2 + (Math.sin(a) * H) / 2 - y;
        if (tryBox(dx, dy)) return { label: { dx, dy }, leader: lead(dx, dy) };
      }
      return { label: null, leader: null };
    }
    for (const ring of [0, 1, 2]) {
      const gap = it.offset + 6 + ring * 22;
      const cands = [
        { dx: gap, dy: -H / 2 }, { dx: -gap - tw, dy: -H / 2 }, { dx: -tw / 2, dy: gap }, { dx: -tw / 2, dy: -gap - H },
        { dx: gap * 0.75, dy: gap * 0.75 - H / 2 }, { dx: -gap * 0.75 - tw, dy: gap * 0.75 - H / 2 },
        { dx: gap * 0.75, dy: -gap * 0.75 - H / 2 }, { dx: -gap * 0.75 - tw, dy: -gap * 0.75 - H / 2 },
      ];
      for (const c of cands) if (tryBox(c.dx, c.dy)) return { label: c, leader: ring > 0 ? lead(c.dx, c.dy) : null };
    }
    return { label: null, leader: null };
  };

  // Dots take space first, so labels do not cover other markers' dots.
  for (const l of leaders) if (l.it.marker && inView(l.it)) placed.push({ x0: l.it.x - 4, y0: l.it.y - 4, x1: l.it.x + 4, y1: l.it.y + 4 });

  for (const l of leaders) {
    const it = l.it;
    const expanded = o.expanded === it.key && l.members.length > 0;
    const op = fadeOpacity(it.t === undefined ? undefined : it.t - o.cursor, o.fadeScale);
    const n = l.members.length;
    const text = it.occluded && !it.selected && !it.keep ? '' : n > 0 && !expanded ? `${it.text || 'Markers'} +${n}` : it.text;
    // Far in time and faded: text only if it fits in the first ring (never pushes others out with a leader).
    const pl = place(it, it.x, it.y, op < 0.6 && !it.selected && !it.keep ? '' : text);
    out.set(it.key, { key: it.key, x: it.x, y: it.y, label: pl.label, leader: pl.leader, opacity: it.occluded ? 1 : op, clusteredInto: null, clusterSize: expanded ? 0 : n, text, hidden: false });
    if (expanded) {
      // Fan the members out on a ring around the leader, each with a leader line from its true point.
      const R = Math.max(34, o.clusterRadius * 1.6);
      l.members.forEach((m, k) => {
        const a = -Math.PI / 2 + ((k + 1) * 2 * Math.PI) / (n + 1);
        const x = it.x + R * Math.cos(a), y = it.y + R * Math.sin(a);
        placed.push({ x0: x - 4, y0: y - 4, x1: x + 4, y1: y + 4 });
        const p2 = place({ ...m, offset: 0 }, x, y, m.text);
        out.set(m.key, { key: m.key, x, y, label: p2.label, leader: { x0: m.x - x, y0: m.y - y, x1: 0, y1: 0 }, opacity: 1, clusteredInto: null, clusterSize: 0, text: m.text, hidden: false });
      });
    } else {
      for (const m of l.members) out.set(m.key, { key: m.key, x: m.x, y: m.y, label: null, leader: null, opacity: 1, clusteredInto: it.key, clusterSize: 0, text: m.text, hidden: true });
    }
  }
  for (const it of items) if (!out.has(it.key)) out.set(it.key, { key: it.key, x: it.x, y: it.y, label: null, leader: null, opacity: 1, clusteredInto: null, clusterSize: 0, text: it.text, hidden: true });
  return items.map((it) => out.get(it.key)!);
}
