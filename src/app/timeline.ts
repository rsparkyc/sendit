/**
 * The timeline scrubber under the map, zoomable about the cursor.
 *
 *  - The visible window [w0, w1] is a part of the flight [a, b]. Wheel or a
 *    trackpad pinch over the track zooms about the pointer, horizontal wheel
 *    pans; on touch a two-finger pinch zooms and pans; the handle (a range
 *    input over the window) still scrubs with one finger. Buttons: zoom in,
 *    zoom out, fit all, and presets fit burn / event / revolution.
 *  - When zoomed in, an overview strip of the whole flight shows the window;
 *    drag it (or tap a spot) to pan.
 *  - The axis labels mission elapsed time in a unit that suits the zoom; the
 *    calendar date of the cursor is in the readout's tooltip.
 *  - Burn spans, nodes, events and plane crossings stay on the axis at every
 *    zoom; ticks closer than a few pixels merge into one.
 *  - The cursor stays visible: if playback or a selection moves it out of the
 *    window, the window follows.
 *
 * The window only controls what the scrubber shows; it never changes what is
 * drawn in 3D (that is the "drawn after the last burn" setting) nor the plan.
 * The window is remembered per flight (mission + plan epoch).
 */
import { el, formatMet, setText } from './dom';
import { nodesOf } from './nodes';
import type { AppState, Store } from './store';
import { formatCalendar, tdbToCalendar } from './time';

/** Nice axis steps, s. */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 5 * 86400, 10 * 86400, 30 * 86400, 100 * 86400, 365.25 * 86400, 5 * 365.25 * 86400];
export const MIN_WINDOW = 20; // s

/** Smallest nice step giving at most `maxTicks` ticks over `span` seconds. */
export function niceStep(span: number, maxTicks: number): number {
  for (const s of STEPS) if (span / s <= maxTicks) return s;
  return STEPS[STEPS.length - 1];
}

/** Axis label for mission time `t` (s) at step `step`: drops units finer than the step. */
export function axisLabel(t: number, step: number): string {
  const sign = t < 0 ? '−' : '';
  const a = Math.abs(t);
  const d = Math.floor(a / 86400);
  const h = Math.floor((a % 86400) / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = Math.round(a % 60);
  if (step >= 86400) return `${sign}${(a / 86400).toFixed(step % 86400 ? 1 : 0)}d`;
  if (step >= 3600) return `${sign}${d ? `${d}d ` : ''}${h}h`;
  if (step >= 60) return `${sign}${d ? `${d}d ` : ''}${h}:${String(m).padStart(2, '0')}`;
  return `${sign}${d || h ? `${d ? `${d}d ` : ''}${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Zoom window [w0, w1] by factor f (< 1 zooms in) about time c, clamped to [a, b]. */
export function zoomWindow(w0: number, w1: number, c: number, f: number, a: number, b: number): [number, number] {
  const span = Math.min(b - a, Math.max(MIN_WINDOW, (w1 - w0) * f));
  const u = w1 > w0 ? (c - w0) / (w1 - w0) : 0.5;
  return clampWindow(c - u * span, c - u * span + span, a, b);
}

/** Shift a window to lie inside [a, b], keeping its width (up to b - a). */
export function clampWindow(w0: number, w1: number, a: number, b: number): [number, number] {
  const span = Math.min(b - a, w1 - w0);
  let s = Math.max(a, Math.min(w0, b - span));
  if (!Number.isFinite(s)) s = a;
  return [s, s + span];
}

/** Merge pixel positions closer than `px` into clusters (sorted input not required). */
export function cluster<T extends { x: number }>(items: readonly T[], px: number): T[][] {
  const sorted = [...items].sort((p, q) => p.x - q.x);
  const out: T[][] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && it.x - last[last.length - 1].x < px) last.push(it);
    else out.push([it]);
  }
  return out;
}

export interface TimelineMarks {
  /** Listed events to tick (absolute time, short label, css kind). */
  events(): { t: number; label: string; kind: string }[];
  /** Plane-node crossings (absolute time, ascending). */
  crossings(): { t: number; ascending: boolean }[];
  /** Orbital period at absolute time t (NaN if unbound). */
  period(t: number): number;
}

interface Mark { x: number; t: number; label: string; kind: string }

export class Timeline {
  readonly root: HTMLElement;
  private readonly range = el('input', { type: 'range', min: '0', max: '100000', step: '1', className: 'scrub', title: 'Time along the flight (drag to scrub)' });
  private readonly met = el('span', { className: 'scrub-met' });
  private readonly track = el('div', { className: 'scrub-track' });
  private readonly ticks = el('div', { className: 'scrub-ticks' });
  private readonly axis = el('div', { className: 'scrub-axis', ariaHidden: 'true' });
  private readonly overview = el('div', { className: 'scrub-overview', title: 'Whole flight: drag to pan the zoomed timeline' });
  private readonly ovWin = el('div', { className: 'ov-win' });
  private readonly ovCursor = el('div', { className: 'ov-cursor' });
  /** Visible window, absolute s; null = the whole flight. */
  private win: [number, number] | null = null;
  private winKey = '';

  constructor(private readonly store: Store<AppState>, private readonly marks: TimelineMarks) {
    this.range.addEventListener('input', () => {
      const [w0, w1] = this.window();
      const t = w0 + ((w1 - w0) * Number(this.range.value)) / 100000;
      store.set({ t, paused: true, loadingTarget: t });
    });
    const b = (text: string, title: string, f: () => void, cls = '') => {
      const x = el('button', { className: `btn small ${cls}`, textContent: text, title, type: 'button' });
      x.setAttribute('aria-label', title);
      x.onclick = f;
      return x;
    };
    const start = b('⏮', 'Flight start', () => {
      const [a] = this.span();
      store.set({ t: a, paused: true, loadingTarget: a });
    });
    const zin = b('+', 'Zoom the timeline in (about the cursor)', () => this.zoom(0.25, store.get().t), 'tl-zin');
    const zout = b('−', 'Zoom the timeline out', () => this.zoom(4, store.get().t), 'tl-zout');
    const fit = b('⤢', 'Fit the whole flight', () => this.setWindow(null), 'tl-fit');
    const presets = el('select', { className: 'tl-presets', title: 'Fit the timeline to…' });
    for (const [v, t] of [['', 'Fit…'], ['in', 'Zoom in ×4'], ['out', 'Zoom out ×4'], ['all', 'Whole flight'], ['burn', 'Selected burn'], ['event', 'Selected event'], ['rev', 'Current revolution']]) presets.append(el('option', { value: v, textContent: t }));
    presets.onchange = () => {
      this.preset(presets.value);
      presets.value = '';
    };
    this.overview.append(this.ovWin, this.ovCursor);
    this.track.append(this.overview, this.range, this.ticks, this.axis);
    this.root = el('div', { className: 'panel scrubber' }, start, this.track, el('div', { className: 'tl-zoom' }, zout, zin, fit, presets), this.met);
    this.wireZoom();
    store.subscribe((s, p) => {
      if (s.t !== p.t || s.replay !== p.replay || s.selectedNode !== p.selectedNode || s.plan !== p.plan || s.selectedEvent !== p.selectedEvent) this.render(s);
    });
    // First render after the app has finished setting up (the mark getters read state created later).
    requestAnimationFrame(() => {
      this.ready = true;
      this.render(store.get());
      new ResizeObserver(() => this.render(store.get())).observe(this.track);
    });
  }

  private span(): [number, number] {
    const s = this.store.get();
    const r = s.replay;
    const a = s.plan.epoch;
    const end = r && Number.isFinite(r.result.finalT) ? r.result.finalT : a + s.plan.duration;
    return [a, Math.max(end, a + 1)];
  }

  /** The visible window, absolute s. */
  window(): [number, number] {
    const [a, b] = this.span();
    if (!this.win) return [a, b];
    return clampWindow(this.win[0], this.win[1], a, b);
  }

  setWindow(w: [number, number] | null): void {
    const [a, b] = this.span();
    this.win = w && w[1] - w[0] < (b - a) * 0.999 ? clampWindow(w[0], w[1], a, b) : null;
    this.persist();
    this.render(this.store.get());
  }

  zoom(f: number, about: number): void {
    const [a, b] = this.span();
    const [w0, w1] = this.window();
    this.setWindow(zoomWindow(w0, w1, Math.max(a, Math.min(b, about)), f, a, b));
  }

  private preset(kind: string): void {
    const s = this.store.get();
    const ep = s.plan.epoch;
    if (kind === 'all') return this.setWindow(null);
    if (kind === 'in') return this.zoom(0.25, s.t);
    if (kind === 'out') return this.zoom(4, s.t);
    if (kind === 'burn') {
      const nodes = nodesOf(s.plan);
      const n = nodes[s.selectedNode ?? 0];
      if (!n) return;
      const flown = s.replay?.plan === s.plan ? s.replay.result.burns[s.selectedNode ?? 0]?.burnTime : undefined;
      const t0 = ep + n.burn.start, t1 = t0 + (flown ?? n.burn.duration);
      const m = Math.max(30, 0.25 * (t1 - t0));
      return this.setWindow([t0 - m, t1 + m]);
    }
    if (kind === 'event') {
      const ev = s.selectedEvent !== null ? s.replay?.result.events[s.selectedEvent] : undefined;
      const t = ev?.t ?? s.t;
      const P = this.marks.period(t);
      const half = Number.isFinite(P) ? P / 8 : 3600;
      return this.setWindow([t - half, t + half]);
    }
    if (kind === 'rev') {
      const P = this.marks.period(s.t);
      if (!Number.isFinite(P)) return this.setWindow([s.t - 43200, s.t + 43200]);
      return this.setWindow([s.t - 0.1 * P, s.t + 0.9 * P]);
    }
  }

  private persist(): void {
    try {
      const all = JSON.parse(localStorage.getItem('sendit.timeline.v1') ?? '{}') as Record<string, [number, number] | null>;
      if (this.win) all[this.winKey] = this.win;
      else delete all[this.winKey];
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete all[k];
      localStorage.setItem('sendit.timeline.v1', JSON.stringify(all));
    } catch {
      /* not persistent */
    }
  }

  private restore(key: string): void {
    this.winKey = key;
    this.win = null;
    try {
      const all = JSON.parse(localStorage.getItem('sendit.timeline.v1') ?? '{}');
      const w = all[key];
      if (Array.isArray(w) && w.length === 2 && w.every(Number.isFinite)) this.win = [w[0], w[1]];
    } catch {
      /* none */
    }
  }

  private wireZoom(): void {
    const tAtX = (clientX: number) => {
      const r = this.range.getBoundingClientRect();
      const [w0, w1] = this.window();
      return w0 + ((clientX - r.left) / Math.max(1, r.width)) * (w1 - w0);
    };
    this.track.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const [w0, w1] = this.window();
        const r = this.range.getBoundingClientRect();
        const dt = (e.deltaX / Math.max(1, r.width)) * (w1 - w0);
        this.setWindow([w0 + dt, w1 + dt]);
      } else this.zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), tAtX(e.clientX));
    }, { passive: false });
    // Two-finger pinch / pan on touch.
    const pts = new Map<number, number>();
    let pinch: { d: number; mid: number; w: [number, number] } | null = null;
    this.track.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      pts.set(e.pointerId, e.clientX);
      if (pts.size === 2) {
        const [x0, x1] = [...pts.values()];
        pinch = { d: Math.max(20, Math.abs(x1 - x0)), mid: tAtX((x0 + x1) / 2), w: this.window() };
      }
    }, true);
    this.track.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, e.clientX);
      if (pinch && pts.size === 2) {
        e.preventDefault();
        const [x0, x1] = [...pts.values()];
        const d = Math.max(20, Math.abs(x1 - x0));
        const [a, b] = this.span();
        const [p0, p1] = pinch.w;
        const span = Math.min(b - a, Math.max(MIN_WINDOW, ((p1 - p0) * pinch.d) / d));
        const r = this.range.getBoundingClientRect();
        const u = ((x0 + x1) / 2 - r.left) / Math.max(1, r.width);
        this.setWindow([pinch.mid - u * span, pinch.mid - u * span + span]);
      }
    }, true);
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
    };
    this.track.addEventListener('pointerup', up, true);
    this.track.addEventListener('pointercancel', up, true);
    // Overview strip: drag or tap to pan.
    let drag = false;
    const panTo = (clientX: number) => {
      const r = this.overview.getBoundingClientRect();
      const [a, b] = this.span();
      const [w0, w1] = this.window();
      const c = a + ((clientX - r.left) / Math.max(1, r.width)) * (b - a);
      this.setWindow([c - (w1 - w0) / 2, c + (w1 - w0) / 2]);
    };
    this.overview.addEventListener('pointerdown', (e) => {
      drag = true;
      try { this.overview.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      panTo(e.clientX);
      e.preventDefault();
    });
    this.overview.addEventListener('pointermove', (e) => drag && panTo(e.clientX));
    this.overview.addEventListener('pointerup', () => (drag = false));
    this.overview.addEventListener('pointercancel', () => (drag = false));
  }

  private ready = false;

  private render(s: AppState): void {
    if (!this.ready) return;
    const key = `${s.missionId}:${s.plan.epoch}`;
    if (key !== this.winKey) this.restore(key);
    const [a, b] = this.span();
    let [w0, w1] = this.window();
    // Follow the cursor.
    if (this.win && (s.t < w0 || s.t > w1) && s.t >= a && s.t <= b) {
      const span = w1 - w0;
      const c = s.t < w0 ? s.t - 0.1 * span : s.t - 0.9 * span;
      this.win = clampWindow(c, c + span, a, b);
      [w0, w1] = this.win;
    }
    const zoomed = !!this.win;
    this.root.classList.toggle('zoomed', zoomed);
    if (document.activeElement !== this.range) this.range.value = String(Math.round(((s.t - w0) / (w1 - w0)) * 100000));
    setText(this.met, `${formatMet(s.t - s.plan.epoch, 0)} MET`);
    const cal = tdbToCalendar(s.t);
    this.met.title = cal ? `${formatCalendar(cal, true)} TDB` : '';
    // Overview.
    this.ovWin.style.left = `${((w0 - a) / (b - a)) * 100}%`;
    this.ovWin.style.width = `${Math.max(0.5, ((w1 - w0) / (b - a)) * 100)}%`;
    this.ovCursor.style.left = `${((s.t - a) / (b - a)) * 100}%`;
    // Axis.
    const W = this.range.getBoundingClientRect().width || 300;
    const step = niceStep(w1 - w0, Math.max(2, Math.floor(W / 70)));
    const ep = s.plan.epoch;
    const first = Math.ceil((w0 - ep) / step) * step;
    const labels: HTMLElement[] = [];
    for (let m = first; ep + m <= w1 + 1e-6; m += step) {
      const x = ((ep + m - w0) / (w1 - w0)) * 100;
      const lab = el('span', { className: 'ax', textContent: axisLabel(m, step) });
      lab.style.left = `${x}%`;
      labels.push(lab);
      if (labels.length > 60) break;
    }
    this.axis.replaceChildren(...labels);
    // Ticks: burn spans, nodes, events, crossings; clustered.
    const out: HTMLElement[] = [];
    const r = s.replay;
    const flown = r && r.plan === s.plan && r.preview === null ? r.result.burns : null;
    nodesOf(s.plan).forEach((n, i) => {
      const t0 = ep + n.burn.start;
      const dur = flown?.[i] ? flown[i].burnTime : n.burn.duration;
      const short = !!flown?.[i] && flown[i].burnTime < n.burn.duration * 0.999;
      const x0 = ((t0 - w0) / (w1 - w0)) * 100;
      const w = (dur / (w1 - w0)) * 100;
      if (x0 > 100 || x0 + w < 0) return;
      const sp = el('span', { className: `span burn${short ? ' short' : ''}${s.selectedNode === i ? ' selected' : ''}`, title: `Burn ${i + 1}: ${formatMet(n.burn.start, 0)} to ${formatMet(n.burn.start + dur, 0)}${short ? ' (cut short: out of propellant)' : ''}` });
      sp.style.left = `${Math.max(0, x0)}%`;
      sp.style.width = `${Math.min(100 - Math.max(0, x0), Math.max(w, 0))}%`;
      out.push(sp);
    });
    const pts: Mark[] = [];
    const px = (t: number) => ((t - w0) / (w1 - w0)) * W;
    for (const n of nodesOf(s.plan)) pts.push({ x: px(ep + n.node.t), t: ep + n.node.t, label: `Node ${formatMet(n.node.t, 0)}`, kind: 'node' });
    for (const e of this.marks.events()) pts.push({ x: px(e.t), t: e.t, label: `${e.label} ${formatMet(e.t - ep, 0)}`, kind: e.kind });
    for (const c of this.marks.crossings()) pts.push({ x: px(c.t), t: c.t, label: `${c.ascending ? 'AN' : 'DN'} ${formatMet(c.t - ep, 0)}`, kind: 'pnode' });
    for (const g of cluster(pts.filter((p) => p.x >= -2 && p.x <= W + 2), 5)) {
      const kinds = new Set(g.map((p) => p.kind));
      const k = kinds.has('failure') ? 'failure' : kinds.has('node') ? 'node' : [...kinds][0];
      const tk = el('span', { className: `tick ${k}${g.length > 1 ? ' many' : ''}`, title: g.length > 1 ? `${g.length} marks: ${g.slice(0, 4).map((p) => p.label).join(', ')}${g.length > 4 ? '…' : ''}` : g[0].label });
      tk.style.left = `${(g[0].x / W) * 100}%`;
      out.push(tk);
    }
    if (r && r.result.outcome !== 'completed' && Number.isFinite(r.result.finalT) && r.result.finalT <= w1) {
      const t = el('span', { className: 'tick end', title: 'End of flight' });
      t.style.left = `${((r.result.finalT - w0) / (w1 - w0)) * 100}%`;
      out.push(t);
    }
    this.ticks.replaceChildren(...out);
  }
}
