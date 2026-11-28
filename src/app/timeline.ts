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
import { axisTime, fmtTime, otherTime, parseTime, timeMode, onTimeMode, setTimeMode, nextTimeMode, TIME_MODE_LABEL, setTimeEpoch } from './timefmt';
import { nodesOf } from './nodes';
import { stageStyle } from './palette';
import { stageRows } from './vehicle';
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

/**
 * Axis step for a window [w0, w1] (absolute s; labels are mission time from `ep`) drawn `W` px wide:
 * the finest nice step whose longest label (at ~7 px per character of the 11 px monospace font,
 * plus a gap) still fits between neighbouring ticks. Long flights get coarse, readable steps.
 */
export function axisStep(w0: number, w1: number, ep: number, W: number, charPx = 7, gapPx = 16): number {
  const span = w1 - w0;
  for (const st of STEPS) {
    const count = span / st;
    if (count > Math.max(2, Math.floor(W / 40))) continue;
    let longest = 0;
    const first = Math.ceil((w0 - ep) / st) * st;
    for (let m = first, k = 0; ep + m <= w1 + 1e-6 && k < 80; m += st, k++) longest = Math.max(longest, axisLabel(m, st).length);
    if (W / Math.max(1, count) >= longest * charPx + gapPx) return st;
  }
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
  events(): { t: number; label: string; kind: string; words?: string }[];
  /** Plane-node crossings (absolute time, ascending, optional plain-words description). */
  crossings(): { t: number; ascending: boolean; words?: string }[];
  /** Orbital period at absolute time t (NaN if unbound). */
  period(t: number): number;
  /** Separations (absolute time, label): drawn as draggable markers. */
  separations?(): { t: number; label: string }[];
  /** A separation marker was dragged to absolute time t (on release: one edit). */
  moveSeparation?(j: number, t: number): void;
  /**
   * Where separation j would land if dropped at absolute time t (`last`: where it shows now, a valid time): a time no
   * burn is firing at. The drag preview follows it live, and the drop commits it.
   */
  snapSeparation?(j: number, t: number, last: number): number;
  /** A separation marker was tapped. */
  selectSeparation?(j: number): void;
}

interface Mark { x: number; t: number; label: string; kind: string; /** Plain words for the tooltip (no time). */ words: string }

/** Tooltip text for a cluster of marks: one line per mark with its time, capped, "+N more". */
export function tipText(marks: readonly { words: string; t: number }[], when: (t: number) => string, cap = 5): string {
  if (marks.length === 1) return `${marks[0].words} · ${when(marks[0].t)}`;
  const lines = marks.slice(0, cap).map((m) => `${m.words} · ${when(m.t)}`);
  if (marks.length > cap) lines.push(`+${marks.length - cap} more`);
  return `${marks.length} marks here:\n${lines.join('\n')}`;
}

export class Timeline {
  readonly root: HTMLElement;
  private readonly range = el('input', { type: 'range', min: '0', max: '100000', step: '1', className: 'scrub', title: 'Time along the flight (drag to scrub)' });
  private readonly met = el('button', { className: 'scrub-met', type: 'button', onclick: () => setTimeMode(nextTimeMode(timeMode())) });
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
    this.wireTicks();
    store.subscribe((s, p) => {
      if (s.t !== p.t || s.replay !== p.replay || s.selectedNode !== p.selectedNode || s.selectedSeparation !== p.selectedSeparation || s.plan !== p.plan || s.selectedEvent !== p.selectedEvent) this.render(s);
    });
    // First render after the app has finished setting up (the mark getters read state created later).
    requestAnimationFrame(() => {
      this.ready = true;
      this.render(store.get());
      new ResizeObserver(() => this.render(store.get())).observe(this.track);
    });
  }

  /** The flight span the scrubber covers (absolute s): plan epoch to the end of flight. */
  flightSpan(): [number, number] {
    return this.span();
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

  /** The mark tooltip (one, on the page body so the panel cannot clip it). */
  private readonly tip = el('div', { className: 'tl-tip', role: 'tooltip' });
  private tipTimer = 0;
  /** Repeated clicks on one cluster step through its marks. */
  private cycle: { key: string; i: number } | null = null;

  private showTip(target: HTMLElement, text: string, autoHide: number): void {
    if (!this.tip.isConnected) document.body.append(this.tip);
    this.tip.textContent = text;
    this.tip.hidden = false;
    const r = target.getBoundingClientRect();
    const w = this.tip.offsetWidth, h = this.tip.offsetHeight;
    const x = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
    const y = r.top - h - 14 >= 4 ? r.top - h - 14 : r.bottom + 8;
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
    clearTimeout(this.tipTimer);
    if (autoHide) this.tipTimer = window.setTimeout(() => this.hideTip(), autoHide);
  }

  private hideTip(): void {
    clearTimeout(this.tipTimer);
    this.tip.hidden = true;
  }

  /** Move the time cursor to absolute time t, as a scrub does. */
  private seek(t: number): void {
    const [a, b] = this.span();
    const c = Math.max(a, Math.min(b, t));
    this.store.set({ t: c, paused: true, loadingTarget: c });
  }

  /**
   * Ticks and burn spans: hover (mouse) shows the tooltip; a click / tap moves the
   * cursor to the mark (a cluster: the first, then the next on each repeated click)
   * and shows the tooltip. A drag that starts on a mark scrubs like the range input.
   * Separation markers have their own handlers (they stop propagation).
   */
  private wireTicks(): void {
    const markOf = (e: Event) => (e.target as HTMLElement).closest?.<HTMLElement>('[data-tip]') ?? null;
    this.ticks.addEventListener('pointerover', (e) => {
      const m = markOf(e);
      if (m && e.pointerType === 'mouse' && !press) this.showTip(m, m.dataset.tip ?? '', 0);
    });
    this.ticks.addEventListener('pointerout', (e) => {
      if (e.pointerType === 'mouse' && markOf(e) && !press) this.hideTip();
    });
    let press: { id: number; x0: number; times: number[]; tip: string; key: string; moved: boolean; el: HTMLElement } | null = null;
    const tAtX = (clientX: number) => {
      const r = this.range.getBoundingClientRect();
      const [w0, w1] = this.window();
      return w0 + ((clientX - r.left) / Math.max(1, r.width)) * (w1 - w0);
    };
    this.ticks.addEventListener('pointerdown', (e) => {
      const m = markOf(e);
      if (!m || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      try { this.ticks.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      const times = (m.dataset.times ?? '').split(',').map(Number).filter(Number.isFinite);
      press = { id: e.pointerId, x0: e.clientX, times, tip: m.dataset.tip ?? '', key: m.dataset.times ?? '', moved: false, el: m };
    });
    this.ticks.addEventListener('pointermove', (e) => {
      if (!press || press.id !== e.pointerId) return;
      if (!press.moved && Math.abs(e.clientX - press.x0) > 4) {
        press.moved = true;
        this.hideTip();
      }
      if (press.moved) this.seek(tAtX(e.clientX));
    });
    const end = (e: PointerEvent, commit: boolean) => {
      if (!press || press.id !== e.pointerId) return;
      const p = press;
      press = null;
      if (!commit || p.moved || !p.times.length) return;
      const i = this.cycle && this.cycle.key === p.key ? (this.cycle.i + 1) % p.times.length : 0;
      this.cycle = { key: p.key, i };
      this.seek(p.times[i]);
      // The mark element may have been re-rendered by the seek: place the tip from the fresh one.
      const fresh = [...this.ticks.querySelectorAll<HTMLElement>('[data-tip]')].find((x) => x.dataset.times === p.key) ?? p.el;
      const lines = p.tip;
      this.showTip(fresh.isConnected ? fresh : this.range, lines, e.pointerType === 'mouse' ? 0 : 3500);
    };
    this.ticks.addEventListener('pointerup', (e) => end(e, true));
    this.ticks.addEventListener('pointercancel', (e) => end(e, false));
    this.track.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !press) this.hideTip(); });
  }

  private ready = false;
  /** A separation marker being dragged: index, pointer start, and the time it shows. */
  private sepDrag: { j: number; x0: number; t0: number; t: number; moved: boolean; el: HTMLElement } | null = null;

  private wireSeparation(tk: HTMLElement, j: number, t: number): void {
    tk.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { tk.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      this.sepDrag = { j, x0: e.clientX, t0: t, t, moved: false, el: tk };
      tk.classList.add('dragging');
    });
    tk.addEventListener('pointermove', (e) => {
      const d = this.sepDrag;
      if (!d || d.j !== j) return;
      const r = this.range.getBoundingClientRect();
      const [w0, w1] = this.window();
      const dx = e.clientX - d.x0;
      if (Math.abs(dx) > 3) d.moved = true;
      if (!d.moved) return;
      const [a, b] = this.span();
      const raw = Math.max(a, Math.min(b, d.t0 + (dx / Math.max(1, r.width)) * (w1 - w0)));
      d.t = this.marks.snapSeparation ? this.marks.snapSeparation(j, raw, d.t) : raw;
      tk.style.left = `${((d.t - w0) / (w1 - w0)) * 100}%`;
      tk.title = `Separation → ${fmtTime(d.t - this.store.get().plan.epoch, 0)} (release to move)`;
    });
    const end = (commit: boolean) => {
      const d = this.sepDrag;
      if (!d || d.j !== j) return;
      this.sepDrag = null;
      tk.classList.remove('dragging');
      if (!commit) return this.render(this.store.get());
      if (d.moved) this.marks.moveSeparation?.(j, this.marks.snapSeparation ? d.t : Math.round(d.t));
      else this.marks.selectSeparation?.(j);
    };
    tk.addEventListener('pointerup', () => end(true));
    tk.addEventListener('pointercancel', () => end(false));
  }

  private render(s: AppState): void {
    if (!this.ready || this.sepDrag) return;
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
    setText(this.met, `${fmtTime(s.t - s.plan.epoch, 0)}${timeMode() === 'met' ? ' MET' : ''}`);
    const cal = tdbToCalendar(s.t);
    this.met.title = otherTime(s.t - s.plan.epoch);
    // Overview.
    this.ovWin.style.left = `${((w0 - a) / (b - a)) * 100}%`;
    this.ovWin.style.width = `${Math.max(0.5, ((w1 - w0) / (b - a)) * 100)}%`;
    this.ovCursor.style.left = `${((s.t - a) / (b - a)) * 100}%`;
    // Axis.
    const W = this.range.getBoundingClientRect().width || 300;
    const step = axisStep(w0, w1, s.plan.epoch, W);
    const ep = s.plan.epoch;
    const first = Math.ceil((w0 - ep) / step) * step;
    const labels: HTMLElement[] = [];
    for (let m = first; ep + m <= w1 + 1e-6; m += step) {
      const x = ((ep + m - w0) / (w1 - w0)) * 100;
      const lab = el('span', { className: 'ax', textContent: axisTime(m, step, axisLabel) });
      lab.style.left = `${x}%`;
      labels.push(lab);
      if (labels.length > 60) break;
    }
    this.axis.replaceChildren(...labels);
    // Ticks: burn spans, nodes, events, crossings; clustered.
    const out: HTMLElement[] = [];
    const r = s.replay;
    const flown = r && r.plan === s.plan && r.preview === null ? r.result.burns : null;
    const rows = stageRows(s.plan);
    const staged = rows.length > 1;
    nodesOf(s.plan).forEach((n, i) => {
      const row = rows[n.stage];
      const ss = stageStyle(n.stage, !row || row.isSpacecraft, row?.tag);
      const t0 = ep + n.burn.start;
      const dur = flown?.[i] ? flown[i].burnTime : n.burn.duration;
      const short = !!flown?.[i] && flown[i].burnTime < n.burn.duration * 0.999;
      const x0 = ((t0 - w0) / (w1 - w0)) * 100;
      const w = (dur / (w1 - w0)) * 100;
      if (x0 > 100 || x0 + w < 0) return;
      const burnTip = `Burn ${i + 1}${staged ? ` · fired by ${row?.name ?? ss.tag} (${ss.tag})` : ''} · ${fmtTime(n.burn.start, 0)} to ${fmtTime(n.burn.start + dur, 0)}${short ? ' (cut short: out of propellant)' : ''}`;
      const sp = el('span', { className: `span burn${short ? ' short' : ''}${s.selectedNode === i ? ' selected' : ''}`, ...(touchUi() ? {} : { role: 'button', tabIndex: -1 }) });
      sp.setAttribute('aria-label', burnTip);
      sp.dataset.tip = burnTip;
      sp.dataset.times = String(t0);
      sp.style.setProperty('--stage', ss.colour);
      sp.dataset.stage = ss.tag;
      // The tag written on the span when there is room (CSS hides it on narrow spans); colour is the second cue.
      if (staged && w > 3) sp.append(el('span', { className: 'span-tag', textContent: ss.tag }));
      sp.style.left = `${Math.max(0, x0)}%`;
      sp.style.width = `${Math.min(100 - Math.max(0, x0), Math.max(w, 0))}%`;
      out.push(sp);
    });
    const pts: Mark[] = [];
    const px = (t: number) => ((t - w0) / (w1 - w0)) * W;
    nodesOf(s.plan).forEach((n, i) => pts.push({ x: px(ep + n.node.t), t: ep + n.node.t, label: `Node ${fmtTime(n.node.t, 0)}`, kind: 'node', words: `Maneuver node ${i + 1}${staged ? ` · ${stageStyle(n.stage, !rows[n.stage] || rows[n.stage].isSpacecraft, rows[n.stage]?.tag).tag}` : ''}` }));
    for (const e of this.marks.events()) pts.push({ x: px(e.t), t: e.t, label: `${e.label} ${fmtTime(e.t - ep, 0)}`, kind: e.kind, words: e.words ?? e.label });
    for (const c of this.marks.crossings()) pts.push({ x: px(c.t), t: c.t, label: `${c.ascending ? 'AN' : 'DN'} ${fmtTime(c.t - ep, 0)}`, kind: c.ascending ? 'pnode an' : 'pnode dn', words: c.words ?? `${c.ascending ? 'Ascending' : 'Descending'} node (crosses the reference plane)` });
    const when = (t: number) => fmtTime(t - ep, 0);
    for (const g of cluster(pts.filter((p) => p.x >= -2 && p.x <= W + 2), 5)) {
      const kinds = new Set(g.map((p) => p.kind));
      const k = kinds.has('failure') ? 'failure' : kinds.has('node') ? 'node' : [...kinds][0];
      const tip = tipText(g, when);
      const tk = el('span', { className: `tick ${k}${g.length > 1 ? ' many' : ''}`, role: 'button', tabIndex: -1 });
      tk.setAttribute('aria-label', tip.replace(/\n/g, '; '));
      tk.dataset.tip = tip;
      tk.dataset.times = g.map((p) => p.t).join(',');
      tk.style.left = `${(g[0].x / W) * 100}%`;
      out.push(tk);
    }
    // Separations: draggable (release moves it: one edit, one undo step); a tap selects it.
    (this.marks.separations?.() ?? []).forEach((sp, j) => {
      const x = px(sp.t);
      if (x < -2 || x > W + 2) return;
      const tk = el('span', { className: `tick sep${s.selectedSeparation === j && s.selectedNode === null ? ' selected' : ''}`, title: `${sp.label} ${fmtTime(sp.t - ep, 0)}: drag to move, tap to edit` });
      tk.dataset.sep = String(j);
      tk.setAttribute('aria-label', `${sp.label} at ${fmtTime(sp.t - ep, 0)}`);
      tk.append(el('span', { className: 'sep-glyph', textContent: '✂' }));
      tk.style.left = `${(x / W) * 100}%`;
      this.wireSeparation(tk, j, sp.t);
      out.push(tk);
    });
    if (r && r.result.outcome !== 'completed' && Number.isFinite(r.result.finalT) && r.result.finalT <= w1) {
      const t = el('span', { className: 'tick end', role: 'button', tabIndex: -1 });
      t.dataset.tip = `End of flight · ${fmtTime(r.result.finalT - ep, 0)}`;
      t.setAttribute('aria-label', t.dataset.tip);
      t.dataset.times = String(r.result.finalT);
      t.style.left = `${((r.result.finalT - w0) / (w1 - w0)) * 100}%`;
      out.push(t);
    }
    this.ticks.replaceChildren(...out);
  }
}

/** Touch layouts: burn bars are not tap targets (too thin; the node mark at their centre is). */
function touchUi(): boolean {
  return document.documentElement.classList.contains('touch');
}
