/**
 * Planner mode: a full-window overlay over the 3D view (the side panels
 * already crowd the view, so the porkchop gets its own space), with three
 * tabs:
 *  - Transfer: porkchop heatmap with contours, readout by hover, tap or finger
 *    drag, a selected cell that stays selected; from the selection, launch
 *    timing and azimuth into a plane containing the departure asymptote, an
 *    inserted departure node, and refinement by the corrector.
 *  - Target flyby: the corrector on any burn toward a closest-approach
 *    altitude at a chosen body (mid-course corrections, next leg).
 *  - Flyby chain: plausibility check of a body sequence.
 * Everything it changes in the plan is an ordinary node (editor.replacePlan);
 * every closest approach it reports is measured in the scoring replay.
 * Layout: one column below ~860 px, chart beside the controls above it; no
 * fixed pixel widths; buttons at least 44 px tall; pointer events only.
 */
import type { ChunkPool } from './chunk-pool';
import { el, esc, fillBodySelect, formatMet } from './dom';
import { errorCount, planErrors } from './mission-layer';
import { splitAcrossSeparation } from './nodes';
import { stageRows } from './vehicle';
import { fmtTime, otherTime, parseTime, plannerDate, timeMode, onTimeMode, setTimeMode, nextTimeMode, TIME_MODE_LABEL, setTimeEpoch } from './timefmt';
import type { Editor } from './editor';
import { geocentricLatitudeDeg, launchSite, type MissionPlan } from './mission-layer';
import { launchOf, missionById } from './missions';
import { dvMagnitude, nodesOf } from './nodes';
import { BODIES, type Ephemeris } from './physics';
import { bodyRadius, convertText, distanceMode, fromCentre, fromSurface, onDistanceMode } from './units';
import { Cancelled, PlannerClient } from './planner-client';
import { argMin, cellAt, colourRange, contour, contourLevels, field, monthTicks, porkchopRequest, QUANTITIES, transferType, viridis, vInfVector, type Grid, type Quantity } from './porkchop-view';
import type { FromPlanner, StageReport } from './protocol';
import type { AppState, Store } from './store';
import { calendarToTdb, DAY, formatCalendar, tdbToCalendar } from './time';
import { missionDeadline, suggestDates, transferBodies } from './porkchop-dates';
import { defaultInclination, launchOpportunities, PASS_SIDES, type LaunchOpportunity } from './transfer';

const DEG = 180 / Math.PI;
/** Planner dates stay absolute, with MET alongside (timefmt.ts plannerDate). */
const fmtDate = (t: number) => plannerDate(t);
type Range4 = [number, number, number, number];
/** Smallest zoom: ranges of this many days on both axes. */
const ZOOM_FLOOR_DAYS = 4;
const dayStr = (t: number) => {
  const c = tdbToCalendar(t);
  return `${c.year}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
};
const parseDay = (s: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  return m ? calendarToTdb({ year: +m[1], month: +m[2], day: +m[3], hour: 0, minute: 0, second: 0 }) : null;
};

function button(text: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { className: `btn pl-btn ${cls}`, textContent: text, type: 'button' });
  b.onclick = onClick;
  return b;
}

function field2(label: string, ctl: HTMLElement): HTMLElement {
  return el('label', { className: 'pl-field' }, el('span', { textContent: label }), ctl);
}

function dateInput(title: string, v: string): HTMLInputElement {
  return el('input', { type: 'date', className: 'pl-input', title, value: v });
}

/**
 * A closest-approach distance field that follows the View setting (units.ts): altitude above the
 * surface, or radius from the centre. The value shown is converted when the setting changes; `metresAlt`
 * always returns the altitude the planner works with.
 */
class FlybyDistance {
  readonly input: HTMLInputElement;
  readonly label = el('span');
  readonly root: HTMLElement;
  private mode = distanceMode();
  constructor(defaultAltKm: string, private readonly body: () => string) {
    this.input = numIn('Closest-approach altitude, km', defaultAltKm, '10');
    this.root = el('label', { className: 'pl-field' }, this.label, this.input);
    this.sync();
    onDistanceMode(() => {
      const v = Number(this.input.value);
      const R = bodyRadius(this.body()) / 1e3;
      const next = distanceMode();
      if (next !== this.mode && this.input.value.trim() !== '' && Number.isFinite(v)) this.input.value = String(Math.round(next === 'radius' ? v + R : v - R));
      this.mode = next;
      this.sync();
    });
  }
  private sync(): void {
    const radius = this.mode === 'radius';
    this.input.title = radius ? 'Closest-approach radius, km' : 'Closest-approach altitude, km';
    this.input.setAttribute('aria-label', this.input.title);
    this.label.textContent = radius ? 'Radius, km' : 'Altitude, km';
  }
  /** The requested closest approach as an altitude above the surface, m. */
  metresAlt(): number {
    const v = Number(this.input.value) * 1e3;
    return this.mode === 'radius' ? v - bodyRadius(this.body()) : v;
  }
}

function numIn(title: string, v: string, step = 'any'): HTMLInputElement {
  return el('input', { type: 'number', className: 'pl-input', title, value: v, step, inputMode: 'decimal' });
}

class Progress {
  readonly root = el('div', { className: 'pl-progress' });
  private readonly bar = el('div', { className: 'pl-bar' });
  private readonly text = el('div', { className: 'pl-ptext' });
  constructor(onCancel: () => void) {
    const cancel = button('Cancel', onCancel, 'bad');
    this.root.append(el('div', { className: 'pl-track' }, this.bar), this.text, cancel);
    this.hide();
  }
  show(label: string, done: number, total: number): void {
    this.root.style.display = '';
    this.bar.style.width = `${total > 0 ? Math.round((100 * done) / total) : 0}%`;
    this.text.textContent = label;
  }
  hide(): void {
    this.root.style.display = 'none';
  }
}

function stageTable(stages: StageReport[]): string {
  if (!stages.length) return '';
  return `<table class="pl-table"><tr><th>Stage</th><th>Result</th><th>B-plane miss</th><th>Time</th></tr>${stages
    .map((s) => `<tr><td>${esc(s.label)}</td><td>${s.converged ? 'converged' : '<b class="bad">not converged</b>'}</td><td>${Number.isFinite(s.miss) ? `${(s.miss / 1e3).toFixed(2)} km` : '—'}</td><td>${s.ms.toFixed(0)} ms</td></tr>`)
    .join('')}</table>`;
}

function correctionSummary(r: Extract<FromPlanner, { type: 'correct' }>, body: string, want: number): string {
  const name = BODIES.find((b) => b.id === body)?.name ?? body;
  if (!r.ok) return `<div class="pl-fail">${esc(convertText(r.message, body))}</div>${stageTable(r.stages)}`;
  const m = r.measured;
  return (
    `<div class="pl-ok">${m ? `Closest approach to ${esc(name)} in the replay: <b>${esc(fromSurface(m.altitude, body))}</b> (requested ${esc(fromSurface(want, body))}) at ${esc(fmtDate(m.t))}, ${(m.speed / 1e3).toFixed(2)} km/s${m.impact ? ' — enters the atmosphere or impacts' : ''}. Replay outcome: ${esc(m.outcome)}.` : `The replay of the corrected plan shows no approach to ${esc(name)}.`}</div>` +
    `<div class="hint">Corrector's own estimate ${r.predicted !== null ? esc(fromSurface(r.predicted, body)) : '—'}; ${(r.ms / 1000).toFixed(2)} s in the worker.</div>` +
    stageTable(r.stages)
  );
}

// ---------------------------------------------------------------------------

class PorkchopChart {
  readonly root = el('div', { className: 'pl-chart' });
  private readonly canvas = el('canvas', { className: 'pl-canvas' });
  private grid: Grid | null = null;
  private q: Quantity = 'c3';
  private f: Float64Array | null = null;
  private range: [number, number] = [0, 1];
  private image: HTMLCanvasElement | null = null;
  probe: number | null = null;
  selected: number | null = null;
  private dpr = 1;
  private css = { w: 0, h: 0 };
  private readonly pad = { l: 64, r: 12, t: 12, b: 44 };

  /** Touch: one-finger drag draws a zoom box instead of reading values (the mouse always can: drag vs click). */
  boxMode = false;
  /** Zoom box being drawn, CSS px relative to the canvas. */
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** The selected transfer's exact dates, kept across zoom levels. */
  selectedTimes: { dep: number; arr: number } | null = null;

  constructor(private readonly onProbe: () => void, private readonly onSelect: () => void, private readonly onZoom: (dep0: number, dep1: number, arr0: number, arr1: number) => void) {
    this.root.append(this.canvas);
    new ResizeObserver(() => this.draw()).observe(this.root);
    let down: { x: number; y: number; type: string; boxing: boolean } | null = null;
    const local = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const cell = (e: PointerEvent): number | null => {
      const g = this.grid;
      if (!g) return null;
      const r = this.canvas.getBoundingClientRect();
      const w = r.width - this.pad.l - this.pad.r;
      const h = r.height - this.pad.t - this.pad.b;
      const c = cellAt(g, (e.clientX - r.left - this.pad.l) / w, 1 - (e.clientY - r.top - this.pad.t) / h);
      return c ? c.j * g.nDep + c.i : null;
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      const p = local(e);
      down = { x: p.x, y: p.y, type: e.pointerType, boxing: false };
      this.canvas.setPointerCapture(e.pointerId);
      if (e.pointerType !== 'mouse' && this.boxMode) return;
      this.probe = cell(e);
      this.draw();
      this.onProbe();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const p = local(e);
      if (down) {
        // A drag beyond the threshold is a zoom box: always with a mouse or pen, on touch only in box mode.
        const canBox = down.type !== 'touch' || this.boxMode;
        if (canBox && !down.boxing && Math.hypot(p.x - down.x, p.y - down.y) > 6) down.boxing = true;
        if (down.boxing) {
          this.box = { x0: down.x, y0: down.y, x1: p.x, y1: p.y };
          this.draw();
          return;
        }
        if (canBox && down.type !== 'touch') return;
        if (this.boxMode) return;
      } else if (e.pointerType !== 'mouse') return;
      const k = cell(e);
      if (k === this.probe) return;
      this.probe = k;
      this.draw();
      this.onProbe();
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d) return;
      if (d.boxing && this.box) {
        const b = this.box;
        this.box = null;
        this.draw();
        if (Math.abs(b.x1 - b.x0) > 6 && Math.abs(b.y1 - b.y0) > 6) this.zoomBox(b);
        return;
      }
      if (this.boxMode && d.type === 'touch') return;
      const k = cell(e);
      if (k !== null && Number.isFinite(this.grid!.c3[k])) this.select(k);
    });
    this.canvas.addEventListener('pointercancel', () => {
      down = null;
      this.box = null;
      this.draw();
    });
    this.canvas.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !down) {
        this.probe = null;
        this.draw();
        this.onProbe();
      }
    });
  }

  select(k: number): void {
    const g = this.grid!;
    this.selected = k;
    const i = k % g.nDep;
    this.selectedTimes = { dep: g.depTimes[i], arr: g.arrTimes[(k - i) / g.nDep] };
    this.draw();
    this.onSelect();
  }

  /** Plot geometry: time <-> CSS px (cell centres span the plot less half a cell each side). */
  private geom() {
    const g = this.grid!;
    const P = this.pad;
    const pw = this.css.w - P.l - P.r;
    const ph = this.css.h - P.t - P.b;
    const sx = pw / g.nDep;
    const sy = ph / g.nArr;
    const t0x = g.depTimes[0], t1x = g.depTimes[g.nDep - 1], t0y = g.arrTimes[0], t1y = g.arrTimes[g.nArr - 1];
    return {
      xOf: (t: number) => P.l + 0.5 * sx + ((t - t0x) / (t1x - t0x || 1)) * (pw - sx),
      yOf: (t: number) => P.t + ph - 0.5 * sy - ((t - t0y) / (t1y - t0y || 1)) * (ph - sy),
      tx: (x: number) => t0x + ((x - P.l - 0.5 * sx) / (pw - sx)) * (t1x - t0x),
      ty: (y: number) => t0y + ((P.t + ph - 0.5 * sy - y) / (ph - sy)) * (t1y - t0y),
      t0x, t1x, t0y, t1y,
    };
  }

  private zoomBox(b: { x0: number; y0: number; x1: number; y1: number }): void {
    if (!this.grid) return;
    const G = this.geom();
    const clampX = (t: number) => Math.max(G.t0x, Math.min(G.t1x, t));
    const clampY = (t: number) => Math.max(G.t0y, Math.min(G.t1y, t));
    const d0 = clampX(G.tx(Math.min(b.x0, b.x1))), d1 = clampX(G.tx(Math.max(b.x0, b.x1)));
    const a0 = clampY(G.ty(Math.max(b.y0, b.y1))), a1 = clampY(G.ty(Math.min(b.y0, b.y1)));
    this.onZoom(d0, d1, a0, a1);
  }

  /** After a recompute: mark the kept selection at the nearest cell, if it is in view. */
  restoreSelection(): void {
    const g = this.grid;
    const st = this.selectedTimes;
    this.selected = null;
    if (!g || !st) return;
    const G = this.geom();
    if (st.dep < G.t0x || st.dep > G.t1x || st.arr < G.t0y || st.arr > G.t1y) return;
    const near = (ts: Float64Array, t: number) => {
      let b = 0;
      for (let q = 1; q < ts.length; q++) if (Math.abs(ts[q] - t) < Math.abs(ts[b] - t)) b = q;
      return b;
    };
    this.selected = near(g.arrTimes, st.arr) * g.nDep + near(g.depTimes, st.dep);
    this.draw();
  }

  get data(): Grid | null {
    return this.grid;
  }

  set(g: Grid | null, q: Quantity): void {
    this.grid = g;
    this.q = q;
    this.selected = null;
    this.box = null;
    this.probe = null;
    this.prepare();
  }

  quantity(q: Quantity): void {
    this.q = q;
    this.prepare();
  }

  private prepare(): void {
    const g = this.grid;
    this.image = null;
    this.f = null;
    if (g) {
      this.f = field(g, this.q);
      this.range = colourRange(this.f);
      // Heatmap at grid resolution, scaled when drawn.
      const im = document.createElement('canvas');
      im.width = g.nDep;
      im.height = g.nArr;
      const ctx = im.getContext('2d')!;
      const data = ctx.createImageData(g.nDep, g.nArr);
      const [lo, hi] = this.range;
      for (let j = 0; j < g.nArr; j++) {
        for (let i = 0; i < g.nDep; i++) {
          const v = this.f[j * g.nDep + i];
          const o = 4 * ((g.nArr - 1 - j) * g.nDep + i);
          if (!Number.isFinite(v)) {
            data.data[o + 3] = 0;
            continue;
          }
          const [r, gg, b] = viridis((v - lo) / (hi - lo));
          data.data[o] = r;
          data.data[o + 1] = gg;
          data.data[o + 2] = b;
          data.data[o + 3] = v > hi ? 150 : 255;
        }
      }
      ctx.putImageData(data, 0, 0);
      this.image = im;
    }
    this.draw();
  }

  draw(): void {
    const rect = this.root.getBoundingClientRect();
    const w = Math.max(200, Math.floor(rect.width));
    const h = Math.max(200, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    if (w !== this.css.w || h !== this.css.h || dpr !== this.dpr) {
      this.css = { w, h };
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const P = this.pad;
    const pw = w - P.l - P.r;
    const ph = h - P.t - P.b;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(P.l, P.t, pw, ph);
    const g = this.grid;
    ctx.font = '11px system-ui, sans-serif';
    if (!g || !this.image || !this.f) {
      ctx.fillStyle = '#8592a3';
      ctx.fillText('Choose bodies and dates, then Compute.', P.l + 12, P.t + 24);
      return;
    }
    ctx.imageSmoothingEnabled = false;
    // Cell centres map to [0, n-1]; extend half a cell each side.
    const sx = pw / g.nDep;
    const sy = ph / g.nArr;
    ctx.drawImage(this.image, P.l, P.t, pw, ph);
    const X = (ci: number) => P.l + (ci + 0.5) * sx;
    const Y = (cj: number) => P.t + ph - (cj + 0.5) * sy;
    // Contours of the plotted quantity.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const lv of contourLevels(this.range[0], this.range[1], 7)) {
      const seg = contour(this.f, g.nDep, g.nArr, lv);
      ctx.beginPath();
      for (let s = 0; s < seg.length; s += 4) {
        ctx.moveTo(X(seg[s]), Y(seg[s + 1]));
        ctx.lineTo(X(seg[s + 2]), Y(seg[s + 3]));
      }
      ctx.stroke();
      if (seg.length >= 4) {
        const m = Math.floor(seg.length / 8) * 4;
        ctx.fillText(String(lv), X(seg[m]) + 2, Y(seg[m + 1]) - 2);
      }
    }
    // Type I / II boundary (transfer angle 180 deg): dashed, labelled on both sides.
    const th = contour(g.theta, g.nDep, g.nArr, Math.PI);
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#ff8a3d';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let s = 0; s < th.length; s += 4) {
      ctx.moveTo(X(th[s]), Y(th[s + 1]));
      ctx.lineTo(X(th[s + 2]), Y(th[s + 3]));
    }
    ctx.stroke();
    ctx.restore();
    if (th.length) {
      const m = Math.floor(th.length / 8) * 4;
      ctx.fillStyle = '#ff8a3d';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText('Type II ↑', X(th[m]) + 6, Y(th[m + 1]) - 6);
      ctx.fillText('Type I ↓', X(th[m]) + 6, Y(th[m + 1]) + 16);
    }
    // Axes with real dates.
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#c3ccd8';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    const t0x = g.depTimes[0];
    const t1x = g.depTimes[g.nDep - 1];
    const t0y = g.arrTimes[0];
    const t1y = g.arrTimes[g.nArr - 1];
    const xOf = (t: number) => P.l + 0.5 * sx + ((t - t0x) / (t1x - t0x || 1)) * (pw - sx);
    const yOf = (t: number) => P.t + ph - 0.5 * sy - ((t - t0y) / (t1y - t0y || 1)) * (ph - sy);
    ctx.textAlign = 'center';
    for (const tk of monthTicks(t0x, t1x)) {
      const x = xOf(tk.t);
      ctx.beginPath();
      ctx.moveTo(x, P.t + ph);
      ctx.lineTo(x, P.t + ph + 5);
      ctx.stroke();
      ctx.fillText(tk.label, x, P.t + ph + 17);
    }
    ctx.fillText('Departure date', P.l + pw / 2, h - 8);
    ctx.textAlign = 'right';
    for (const tk of monthTicks(t0y, t1y)) {
      const y = yOf(tk.t);
      ctx.beginPath();
      ctx.moveTo(P.l - 5, y);
      ctx.lineTo(P.l, y);
      ctx.stroke();
      ctx.fillText(tk.label, P.l - 7, y + 4);
    }
    ctx.save();
    ctx.translate(12, P.t + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Arrival date', 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';
    // Probe and selection.
    const mark = (k: number, color: string, r: number) => {
      const i = k % g.nDep;
      const j = (k - i) / g.nDep;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(i), Y(j), r, 0, 2 * Math.PI);
      ctx.stroke();
    };
    if (this.probe !== null) mark(this.probe, 'rgba(255,255,255,0.9)', 6);
    if (this.selected !== null) {
      mark(this.selected, '#000', 9);
      mark(this.selected, '#7dffb0', 8);
    }
    if (this.box) {
      const b = this.box;
      ctx.save();
      ctx.fillStyle = 'rgba(125,255,176,0.12)';
      ctx.strokeStyle = '#7dffb0';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------

export class PlannerOverlay {
  readonly root = el('div', { className: 'planner', role: 'dialog', ariaLabel: 'Transfer planner' });
  private readonly client: PlannerClient;
  private readonly tabs = new Map<string, { btn: HTMLButtonElement; pane: HTMLElement }>();
  private readonly progress: Progress;
  // Transfer tab.
  private readonly depSel = el('select', { className: 'pl-input', title: 'Departure body' });
  private readonly arrSel = el('select', { className: 'pl-input', title: 'Arrival body' });
  // Filled from the mission when the planner opens (suggestDates).
  private readonly depFrom = dateInput('Earliest departure', '2026-09-01');
  private readonly depTo = dateInput('Latest departure', '2026-12-31');
  private readonly arrFrom = dateInput('Earliest arrival', '2027-06-01');
  private readonly arrTo = dateInput('Latest arrival', '2027-11-01');
  private readonly qSel = el('select', { className: 'pl-input', title: 'Quantity shown' });
  private readonly chart: PorkchopChart;
  private readonly readout = el('div', { className: 'pl-readout' });
  private readonly status = el('div', { className: 'pl-status' });
  private readonly useBox = el('div', { className: 'pl-use' });
  private readonly incIn = numIn('Parking orbit inclination, deg', '', '0.1');
  private readonly opsBox = el('div', { className: 'pl-ops' });
  private readonly altIn = new FlybyDistance('500', () => this.departure?.body ?? this.arrSel.value);
  private readonly sideSel = el('select', { className: 'pl-input', title: 'Pass side' });
  private readonly result = el('div', { className: 'pl-result' });
  private chosenOp: LaunchOpportunity | null = null;
  /** Zoom history: ranges shown before the current one ([0] is the computed original). */
  private zoomStack: Range4[] = [];
  private current: Range4 | null = null;
  private readonly zoomBoxBtn = button('Zoom box', () => this.toggleBox(), 'pl-zoombox');
  private readonly zoomOutBtn = button('Zoom out', () => void this.zoomOut());
  private readonly zoomResetBtn = button('Reset zoom', () => void this.zoomReset());
  private readonly zoomNote = el('div', { className: 'hint pl-zoomnote', role: 'status' });
  private departure: { index: number; tArr: number; body: string } | null = null;
  /** Mission, liftoff and start the transfer dates were last suggested for (re-suggested on open when it changes). */
  private suggestedFor = '';
  // Target tab.
  private readonly tBurn = el('select', { className: 'pl-input', title: 'Burn to correct' });
  private readonly tBody = el('select', { className: 'pl-input', title: 'Flyby body' });
  private readonly tAlt = new FlybyDistance('300', () => this.tBody.value);
  private readonly tSide = el('select', { className: 'pl-input', title: 'Pass side' });
  private readonly tResult = el('div', { className: 'pl-result' });
  // Chain tab.
  private readonly cSeq = el('input', { className: 'pl-input', type: 'text', value: 'earth venus earth', title: 'Body sequence, separated by spaces' });
  private readonly cDates = el('input', { className: 'pl-input', type: 'text', value: '2026-03-20 2026-08-15 2027-06-01', title: 'One date per body (YYYY-MM-DD)' });
  private readonly cWin = numIn('Search window, ± days', '60', '1');
  private readonly cResult = el('div', { className: 'pl-result' });

  constructor(private readonly store: Store<AppState>, private readonly editor: Editor, eph: Ephemeris, pool: ChunkPool) {
    this.client = new PlannerClient(eph, pool);
    this.progress = new Progress(() => this.client.cancel());
    this.chart = new PorkchopChart(() => this.showReadout(), () => this.selectCell(), (a, b, c, d) => void this.zoomTo(a, b, c, d));
    fillBodySelect(this.depSel, (i) => BODIES[i].id);
    fillBodySelect(this.arrSel, (i) => BODIES[i].id);
    fillBodySelect(this.tBody, (i) => BODIES[i].id);
    this.depSel.value = 'earth';
    this.arrSel.value = 'mars';
    this.tBody.value = 'moon';
    for (const q of QUANTITIES) this.qSel.append(el('option', { value: q.id, textContent: `${q.label} (${q.unit})` }));
    this.qSel.onchange = () => this.chart.quantity(this.qSel.value as Quantity);
    // Other bodies, other timescales: new dates for the pair.
    this.depSel.addEventListener('change', () => this.suggestDates(false));
    this.arrSel.addEventListener('change', () => this.suggestDates(false));
    for (const sel of [this.sideSel, this.tSide]) for (const s of PASS_SIDES) sel.append(el('option', { value: s.value, textContent: s.label }));

    const close = button('Close planner', () => this.close(), 'pl-close');
    const head = el('div', { className: 'pl-head' }, el('div', { className: 'pl-title', textContent: 'Planner' }), el('div', { className: 'pl-tabs', role: 'tablist' }), close);
    const body = el('div', { className: 'pl-body' });
    this.root.append(head, this.progress.root, body);
    const addTab = (id: string, label: string, pane: HTMLElement) => {
      const btn = button(label, () => this.tab(id), 'pl-tab');
      btn.setAttribute('role', 'tab');
      head.querySelector('.pl-tabs')!.append(btn);
      pane.classList.add('pl-pane');
      body.append(pane);
      this.tabs.set(id, { btn, pane });
    };
    addTab('transfer', 'Transfer', this.transferPane());
    addTab('target', 'Target flyby', this.targetPane());
    addTab('chain', 'Flyby chain', this.chainPane());
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    this.root.style.display = 'none';
    document.body.append(this.root);
    store.subscribe((s, p) => {
      if (s.plan !== p.plan && this.isOpen) this.refreshTarget();
    });
    this.zoomBoxBtn.setAttribute('aria-pressed', 'false');
    this.syncZoomUi();
    this.tab('transfer');
  }

  get isOpen(): boolean {
    return this.root.style.display !== 'none';
  }

  open(tab = 'transfer', node: number | null = null): void {
    this.root.style.display = '';
    this.refreshTarget();
    const s = this.store.get();
    const key = `${s.missionId}|${s.plan.epoch}|${s.plan.start.kind === 'state' ? s.plan.start.center : 'launch'}`;
    if (key !== this.suggestedFor) {
      this.suggestedFor = key;
      this.suggestDates(true);
    }
    if (node !== null) this.tBurn.value = String(node);
    this.tab(tab);
    this.chart.draw();
  }

  close(): void {
    this.root.style.display = 'none';
  }

  private tab(id: string): void {
    for (const [k, t] of this.tabs) {
      t.pane.style.display = k === id ? '' : 'none';
      t.btn.classList.toggle('active', k === id);
      t.btn.setAttribute('aria-selected', String(k === id));
    }
    if (id === 'transfer') this.chart.draw();
  }

  private async job<T>(f: () => Promise<T>): Promise<T | null> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof Cancelled) {
        this.status.textContent = 'Cancelled.';
        return null;
      }
      throw e;
    } finally {
      this.progress.hide();
    }
  }

  private onProgress = (label: string, done: number, total: number) => this.progress.show(label, done, total);

  // -- Transfer -------------------------------------------------------------

  private transferPane(): HTMLElement {
    const form = el('div', { className: 'pl-form' },
      el('div', { className: 'pl-pair' }, field2('From', this.depSel), field2('To', this.arrSel)),
      el('div', { className: 'pl-pair' }, field2('Depart from', this.depFrom), field2('to', this.depTo)),
      el('div', { className: 'pl-pair' }, field2('Arrive from', this.arrFrom), field2('to', this.arrTo)),
      field2('Show', this.qSel),
      el('div', { className: 'pl-row' }, button('Compute porkchop', () => void this.compute(), 'primary'), button('Select minimum', () => this.pickMin()), button('Suggest dates', () => this.suggestDates(true))),
      this.status);
    const legend = el('div', { className: 'hint' }, 'Colour: viridis, dark = low (better). White lines: contours of the shown quantity. Orange dashed: 180° transfer angle, Type I below, Type II above. Faded cells are above the colour range. Tap or drag on the chart to read values; release to select. Zoom: drag a box with the mouse, or turn on Zoom box and drag with a finger; each zoom recomputes the grid over the new dates.');
    this.useBox.append(
      el('div', { className: 'sub', textContent: 'Use this transfer' }),
      field2('Parking inclination, deg', this.incIn),
      this.opsBox,
      el('div', { className: 'pl-row' }, button('Insert departure burn', () => void this.insertDeparture(), 'primary')),
      el('div', { className: 'sub', textContent: 'Refine to a flyby (corrector, real N-body)' }),
      el('div', { className: 'pl-pair' }, this.altIn.root, field2('Pass', this.sideSel)),
      el('div', { className: 'pl-row' }, button('Refine', () => void this.refine(), 'primary')),
      this.result);
    this.incIn.addEventListener('change', () => this.proposeLaunch());
    this.useBox.style.display = 'none';
    return el('div', { className: 'pl-transfer' },
      el('div', { className: 'pl-main' }, this.chart.root, el('div', { className: 'pl-row pl-zoom' }, this.zoomBoxBtn, this.zoomOutBtn, this.zoomResetBtn), this.zoomNote, legend),
      el('div', { className: 'pl-side' }, form, this.readout, this.useBox));
  }

  private toggleBox(): void {
    this.chart.boxMode = !this.chart.boxMode;
    this.zoomBoxBtn.setAttribute('aria-pressed', String(this.chart.boxMode));
    this.zoomBoxBtn.classList.toggle('active', this.chart.boxMode);
  }

  private syncZoomUi(note = ''): void {
    this.zoomOutBtn.disabled = this.zoomStack.length === 0;
    this.zoomResetBtn.disabled = this.zoomStack.length === 0;
    this.zoomNote.textContent = note || (this.zoomStack.length ? `Zoom level ${this.zoomStack.length}.` : '');
  }

  private setInputs(r: Range4): void {
    this.depFrom.value = dayStr(r[0]);
    this.depTo.value = dayStr(r[1]);
    this.arrFrom.value = dayStr(r[2]);
    this.arrTo.value = dayStr(r[3]);
  }

  /**
   * Fill the date ranges from the mission profile and the current time
   * (porkchop-dates.ts): departures from liftoff, or from the view time when
   * that is later and still inside the mission, around the next window, with
   * arrivals by the mission's time limit. `fromMission` also sets the bodies.
   */
  private suggestDates(fromMission: boolean): void {
    const s = this.store.get();
    const def = missionById(s.missionId)?.def ?? null;
    if (fromMission) {
      const tb = transferBodies(BODIES, def, s.plan);
      if (tb.departure) this.depSel.value = tb.departure;
      if (tb.arrival) this.arrSel.value = tb.arrival;
    }
    const deadline = missionDeadline(def, s.plan.epoch);
    const fromNow = s.t > s.plan.epoch && s.t < deadline;
    const earliest = fromNow ? s.t : s.plan.epoch;
    const sug = suggestDates(BODIES, this.depSel.value, this.arrSel.value, earliest, deadline);
    if (!sug) {
      this.status.textContent = 'No suggested dates: the porkchop is Sun-centred, so choose two different planets (or their moons).';
      return;
    }
    const [a, b, c, d] = sug.range;
    const end = (t: number) => dayStr(t + DAY - 1);
    this.depFrom.value = dayStr(a);
    this.depTo.value = end(b);
    this.arrFrom.value = dayStr(c);
    this.arrTo.value = end(d);
    const name = (id: string) => BODIES.find((x) => x.id === id)?.name ?? id;
    const from = fromNow ? 'the current time' : 'liftoff';
    this.status.textContent = sug.window !== null
      ? `Dates suggested from ${from}${Number.isFinite(deadline) ? ' and the mission time limit' : ''}: the best ${name(this.depSel.value)} → ${name(this.arrSel.value)} window departs around ${dayStr(sug.window)} (about ${Math.round(sug.tof / DAY)} d flight, two-body estimate). Compute to see it.`
      : `No ${name(this.depSel.value)} → ${name(this.arrSel.value)} transfer arrives within the mission time limit; dates start at ${from}.`;
  }

  /** Zoom to a box: whole days (the date inputs show days and stay in sync), never below the floor. */
  private async zoomTo(d0: number, d1: number, a0: number, a1: number): Promise<void> {
    if (!this.current) return;
    const lo = (t: number) => parseDay(dayStr(t))!;
    let r: Range4 = [lo(d0), lo(d1) + DAY, lo(a0), lo(a1) + DAY];
    const span = (x: number, y: number) => (y - x) / DAY;
    if (span(this.current[0], this.current[1]) <= ZOOM_FLOOR_DAYS && span(this.current[2], this.current[3]) <= ZOOM_FLOOR_DAYS) {
      this.syncZoomUi(`Zoom limit reached: ${ZOOM_FLOOR_DAYS}-day ranges (cells about ${((ZOOM_FLOOR_DAYS * 24 * 60) / 159).toFixed(0)} minutes apart; the dates are whole days).`);
      return;
    }
    const widen = (x: number, y: number): [number, number] => {
      const s = span(x, y);
      if (s >= ZOOM_FLOOR_DAYS) return [x, y];
      const pad = Math.ceil((ZOOM_FLOOR_DAYS - s) / 2) * DAY;
      return [x - pad, y + pad];
    };
    r = [...widen(r[0], r[1]), ...widen(r[2], r[3])] as Range4;
    this.zoomStack.push(this.current);
    await this.compute(r);
  }

  private async zoomOut(): Promise<void> {
    const r = this.zoomStack.pop();
    if (r) await this.compute(r);
  }

  private async zoomReset(): Promise<void> {
    const r = this.zoomStack[0];
    this.zoomStack = [];
    if (r) await this.compute(r);
  }

  /** Compute the porkchop over the inputs' dates (a new chart), or over `zoom` (a zoom step, keeping the selection). */
  private async compute(zoom?: Range4): Promise<void> {
    if (zoom) this.setInputs(zoom);
    const a = parseDay(this.depFrom.value), b = parseDay(this.depTo.value), c = parseDay(this.arrFrom.value), d = parseDay(this.arrTo.value);
    if (a === null || b === null || c === null || d === null || !(b > a) || !(d > c)) {
      this.status.textContent = 'Give both date ranges, each ending after it starts.';
      return;
    }
    if (this.depSel.value === this.arrSel.value) {
      this.status.textContent = 'Choose two different bodies.';
      return;
    }
    if (!zoom) {
      this.zoomStack = [];
      this.chart.selectedTimes = null;
    }
    const t0 = performance.now();
    this.status.textContent = 'Computing…';
    // The client pins ephemeris coverage for [a, d] and waits for it without blocking the page.
    const r = await this.job(() => this.client.run({ type: 'porkchop', req: porkchopRequest(this.depSel.value, this.arrSel.value, a, b, c, d, 160, 160) }, a, d, this.onProgress));
    if (!r) return;
    const g: Grid = r.grid;
    this.current = [a, b, c, d];
    this.chart.set(g, this.qSel.value as Quantity);
    this.chart.restoreSelection();
    if (!zoom || this.chart.selected === null) {
      this.useBox.style.display = 'none';
      this.departure = null;
    }
    const k = argMin(g.c3);
    const cellH = ((b - a) / (g.nDep - 1) / 3600);
    this.status.textContent = `${g.nDep} × ${g.nArr} transfers in ${r.ms.toFixed(0)} ms (${(performance.now() - t0).toFixed(0)} ms including ephemeris).` + (k >= 0 ? ` Minimum C3 ${(g.c3[k] / 1e6).toFixed(2)} km²/s², departing ${dayStr(g.depTimes[k % g.nDep])}.` : ' No solutions.') + (zoom ? ` Cells ${cellH < 24 ? `${cellH.toFixed(1)} h` : `${(cellH / 24).toFixed(2)} d`} apart.` : '');
    this.syncZoomUi();
    this.showReadout();
  }

  private pickMin(): void {
    const g = this.chart.data;
    if (!g) return;
    const k = argMin(g[this.qSel.value as Quantity]);
    if (k < 0) return;
    this.chart.select(k);
  }

  private cellText(k: number, title: string): string {
    const g = this.chart.data!;
    const i = k % g.nDep;
    const j = (k - i) / g.nDep;
    const ty = transferType(g.theta[k]);
    if (!Number.isFinite(g.c3[k])) return `<div class="ro-title">${title}</div><div class="hint">No transfer for ${dayStr(g.depTimes[i])} → ${dayStr(g.arrTimes[j])}.</div>`;
    const kv = (a: string, b: string) => `<div class="kv"><span>${a}</span><b>${b}</b></div>`;
    return `<div class="ro-title">${title}</div>` +
      kv('Depart → arrive', `${dayStr(g.depTimes[i])} → ${dayStr(g.arrTimes[j])}`) +
      kv('Flight time', `${((g.arrTimes[j] - g.depTimes[i]) / DAY).toFixed(0)} d, Type ${ty}`) +
      kv('C3', `${(g.c3[k] / 1e6).toFixed(2)} km²/s²`) +
      kv('Arrival v∞', `${(g.vInfArr[k] / 1e3).toFixed(2)} km/s`) +
      kv('Total Δv (from 200 km alt)', `${(g.dvTotal[k] / 1e3).toFixed(2)} km/s`) +
      kv('Asymptote DLA / RLA', `${(g.dla[k] * DEG).toFixed(1)}° / ${(g.rla[k] * DEG).toFixed(1)}°`);
  }

  private showReadout(): void {
    const g = this.chart.data;
    if (!g) {
      this.readout.innerHTML = '';
      return;
    }
    const parts: string[] = [];
    if (this.chart.probe !== null && this.chart.probe !== this.chart.selected) parts.push(this.cellText(this.chart.probe, 'Under pointer'));
    if (this.chart.selected !== null) parts.push(this.cellText(this.chart.selected, 'Selected transfer'));
    this.readout.innerHTML = parts.join('') || '<div class="hint">Tap the chart to select a transfer, or use Select minimum.</div>';
  }

  private selectCell(): void {
    this.showReadout();
    const g = this.chart.data;
    const k = this.chart.selected;
    if (!g || k === null) return;
    this.useBox.style.display = '';
    this.departure = null;
    this.result.innerHTML = '';
    const plan = this.store.get().plan;
    const l = launchOf(plan);
    if (l) {
      const lat = geocentricLatitudeDeg(launchSite(l.site));
      this.incIn.value = defaultInclination(lat, g.dla[k] * DEG).toFixed(1);
    }
    this.proposeLaunch();
  }

  private selection(): { tDep: number; tArr: number; vInf: [number, number, number]; dep: string; arr: string } | null {
    const g = this.chart.data;
    const k = this.chart.selected;
    if (!g || k === null) return null;
    const i = k % g.nDep;
    return { tDep: g.depTimes[i], tArr: g.arrTimes[(k - i) / g.nDep], vInf: vInfVector(g, k), dep: this.depSel.value, arr: this.arrSel.value };
  }

  /** Launch timing and azimuth into a plane containing the departure asymptote, with the alternatives. */
  private proposeLaunch(): void {
    const sel = this.selection();
    const plan = this.store.get().plan;
    const l = launchOf(plan);
    this.opsBox.replaceChildren();
    this.chosenOp = null;
    this.incIn.parentElement!.style.display = l ? '' : 'none';
    if (!sel) return;
    if (!l) {
      this.opsBox.append(el('div', { className: 'hint', textContent: `The plan starts from a free orbit at ${fmtDate(plan.epoch)}; the departure burn will be placed on that orbit near ${fmtDate(sel.tDep)}. For a parking orbit that contains the asymptote, switch the start to a launch.` }));
      return;
    }
    if (sel.dep !== 'earth') {
      this.opsBox.append(el('div', { className: 'hint', textContent: 'Launches are from Earth; this transfer departs elsewhere, so the burn will be placed on the plan\'s current orbit.' }));
      return;
    }
    const inc = Number(this.incIn.value);
    const ops = launchOpportunities(l.site, sel.vInf, sel.tDep, inc, sel.tDep - 2 * DAY, sel.tDep + DAY);
    if (ops.length === 0) {
      this.opsBox.append(el('div', { className: 'pl-fail', textContent: `No launch from ${launchSite(l.site).name} reaches a ${inc.toFixed(1)}° plane containing this asymptote (declination ${(this.chart.data!.dla[this.chart.selected!] * DEG).toFixed(1)}°). Raise the inclination.` }));
      return;
    }
    const usable = ops.filter((o) => o.allowed && o.t < sel.tDep - 3 * 3600);
    this.chosenOp = usable.at(-1) ?? null;
    const list = el('div', { className: 'pl-oplist', role: 'radiogroup', ariaLabel: 'Launch opportunities' });
    for (const o of ops) {
      const chosen = o === this.chosenOp;
      const b = el('button', {
        type: 'button',
        className: `pl-op${chosen ? ' chosen' : ''}${o.allowed ? '' : ' blocked'}`,
        disabled: !o.allowed,
        innerHTML: `<b>${esc(fmtDate(o.t))}</b> <span>azimuth ${o.azimuthDeg.toFixed(2)}°</span> <span>${o.allowed ? (o.t < sel.tDep - 3 * 3600 ? `${((sel.tDep - o.t) / 3600).toFixed(1)} h before departure` : 'too late for this departure') : 'outside the range-safety corridor'}</span>`,
      });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(chosen));
      b.onclick = () => {
        this.chosenOp = o;
        for (const x of list.children) {
          x.classList.toggle('chosen', x === b);
          x.setAttribute('aria-checked', String(x === b));
        }
      };
      list.append(b);
    }
    this.opsBox.append(el('div', { className: 'hint', textContent: `Liftoffs from ${l.site} into a ${inc.toFixed(1)}° parking orbit whose plane contains the departure asymptote (two planes, each crossed once a day). Proposed: the last allowed one before departure.` }), list);
  }

  private async insertDeparture(): Promise<void> {
    const sel = this.selection();
    if (!sel) return;
    const l = launchOf(this.store.get().plan);
    if (l && sel.dep === 'earth') {
      if (!this.chosenOp) {
        this.result.innerHTML = '<div class="pl-fail">Choose a launch opportunity first.</div>';
        return;
      }
      this.editor.setLaunch({ ...l, time: this.chosenOp.t, azimuthDeg: this.chosenOp.azimuthDeg });
    }
    const plan = this.store.get().plan;
    const r = await this.job(() => this.client.run({ type: 'departure', plan, departure: sel.dep, vInf: sel.vInf, tDep: sel.tDep, tArr: sel.tArr }, plan.epoch, sel.tArr + 30 * DAY, this.onProgress)).catch((e: Error) => {
      this.result.innerHTML = `<div class="pl-fail">${esc(e.message)}</div>`;
      return null;
    });
    if (!r) return;
    const planned = this.withinMission(r.plan);
    const refused = this.refusal(planned);
    if (refused) {
      this.result.innerHTML = `<div class="pl-fail">The departure burn was not inserted: the plan would not be valid (${esc(refused)}).</div>`;
      return;
    }
    this.editor.replacePlan(planned, r.index);
    this.departure = { index: r.index, tArr: sel.tArr, body: sel.arr };
    this.result.innerHTML = `<div class="pl-ok">Inserted burn #${r.index + 1}: ${r.dv.toFixed(0)} m/s at ${esc(fmtDate(r.tImpulse))}${l ? `, after liftoff ${esc(fmtDate(this.store.get().plan.epoch))} at azimuth ${launchOf(this.store.get().plan)!.azimuthDeg.toFixed(2)}°` : ''}. It is a normal node: edit it freely. A Lambert guess flown with a real engine misses by millions of km; Refine fixes that.</div>` + (r.warning ? `<div class="pl-fail">${esc(r.warning)}</div>` : '');
    if (r.split) this.offerSplit(this.result, this.withinMission(r.split.plan), (p) => { this.departure = { index: r.split!.first, tArr: sel.tArr, body: sel.arr }; void p; });
  }

  /** The first validation problem of a plan (plan layer, with the ascent's staging), or null. */
  private refusal(plan: MissionPlan): string | null {
    const e = planErrors(plan);
    if (errorCount(e) === 0) return null;
    return [...e.plan, ...[...e.burns.values()].flat(), ...[...e.separations.values()].flat()][0] ?? 'invalid plan';
  }

  /** "Split across a separation": a button that applies the split plan (validated first). */
  private offerSplit(out: HTMLElement, plan: MissionPlan, after: (p: MissionPlan) => void): void {
    const why = this.refusal(plan);
    if (why) {
      out.append(el('div', { className: 'pl-fail', textContent: `A split across a separation would not be valid either (${why}).` }));
      return;
    }
    const b = el('button', { className: 'btn primary split-btn', type: 'button', textContent: '✂ Split across a separation (the next stage finishes)' });
    b.onclick = () => {
      this.editor.replacePlan(plan, null);
      after(plan);
      b.disabled = true;
      out.append(el('div', { className: 'pl-ok', textContent: 'Split: the stage burns what it has, separates one second after cutoff, and the next stage flies the rest in the same direction. Refine the first burn to aim it again.' }));
    };
    out.append(b);
  }

  private async refine(): Promise<void> {
    const d = this.departure;
    if (!d) {
      this.result.innerHTML += '<div class="pl-fail">Insert the departure burn first.</div>';
      return;
    }
    await this.correct(d.index, d.body, this.altIn.metresAlt(), this.sideSel.value, d.tArr, this.result);
  }

  private async correct(burn: number, body: string, altitude: number, sideValue: string, tArr: number | null, out: HTMLElement): Promise<void> {
    const before = this.store.get().plan;
    if (!before.burns[burn]) {
      out.innerHTML = '<div class="pl-fail">No such burn.</div>';
      return;
    }
    if (!(altitude >= 0)) {
      out.innerHTML = '<div class="pl-fail">Give a closest-approach altitude of 0 km or more.</div>';
      return;
    }
    const theta = PASS_SIDES.find((s) => s.value === sideValue)?.theta ?? null;
    const end = Math.max(before.epoch + before.duration, (tArr ?? 0) + 30 * DAY);
    const t0 = performance.now();
    out.innerHTML = '<div class="hint">Correcting…</div>';
    const r = await this.job(() => this.client.run({ type: 'correct', plan: before, missionId: this.store.get().missionId, burn, target: { body, altitude, theta, tArr } }, before.epoch, end, this.onProgress)).catch((e: Error) => {
      out.innerHTML = `<div class="pl-fail">${esc(e.message)}</div>`;
      return null;
    });
    if (!r) {
      if (!out.querySelector('.pl-fail')) out.innerHTML = '<div class="hint">Cancelled; the plan is unchanged.</div>';
      return;
    }
    // Only apply if the plan has not been edited meanwhile.
    let applied: MissionPlan | null = null;
    if (r.ok && r.plan && this.store.get().plan === before) {
      const p = this.withinMission(r.plan);
      const why = this.refusal(p);
      if (why) { r.ok = false; r.message = `The corrected burn was not applied: the plan would not be valid (${why}).`; }
      else { this.editor.replacePlan(p, burn); applied = p; }
    } else if (r.ok) r.message += ' (not applied: the plan changed while the corrector ran)';
    out.innerHTML = correctionSummary(r, body, altitude) + `<div class="hint">Total ${((performance.now() - t0) / 1000).toFixed(2)} s including ephemeris.</div>`;
    out.dataset.measured = r.measured ? String(r.measured.altitude) : '';
    out.dataset.ok = String(r.ok);
    // The stage that fires it cannot complete the corrected burn: say so and offer the split.
    const info = applied ? nodesOf(applied)[burn] : undefined;
    if (applied && info?.short) {
      const rows = stageRows(applied);
      const sp = splitAcrossSeparation(applied, burn);
      out.append(el('div', { className: 'pl-fail', textContent: `${rows[info.stage]?.name ?? 'This stage'} runs dry before completing this burn${sp ? `: it has about ${sp.available.toFixed(0)} m/s of the ${(sp.available + sp.rest).toFixed(0)} m/s` : ''}.` }));
      if (sp) this.offerSplit(out, this.withinMission(sp.plan), () => undefined);
    }
  }

  /** A mission caps the plan duration; the planner may have extended it to reach the encounter. */
  private withinMission(plan: MissionPlan): MissionPlan {
    const def = missionById(this.store.get().missionId)?.def;
    return def && plan.duration > def.maxDuration ? { ...plan, duration: def.maxDuration } : plan;
  }

  // -- Target flyby ---------------------------------------------------------

  private targetPane(): HTMLElement {
    return el('div', { className: 'pl-target' },
      el('div', { className: 'pl-form' },
        el('p', { className: 'blurb', textContent: 'Adjust one burn (direction, duration, start time) so the real N-body trajectory passes a body at the altitude you ask for. Earlier burns are not touched; later burns are ignored while correcting, so target an encounter before the next burn. The result is measured in the scoring replay.' }),
        field2('Burn', this.tBurn),
        field2('Body', this.tBody),
        el('div', { className: 'pl-pair' }, this.tAlt.root, field2('Pass', this.tSide)),
        el('div', { className: 'pl-row' }, button('Target this flyby', () => void this.correct(Number(this.tBurn.value), this.tBody.value, this.tAlt.metresAlt(), this.tSide.value, null, this.tResult), 'primary'))),
      this.tResult);
  }

  private refreshTarget(): void {
    const plan: MissionPlan = this.store.get().plan;
    const keep = this.tBurn.value;
    this.tBurn.replaceChildren(...nodesOf(plan).map((x, i) => el('option', { value: String(i), textContent: `#${i + 1} ${fmtTime(x.node.t, 0)} · ${dvMagnitude(x.node.dv).toFixed(1)} m/s` })));
    if (plan.burns.length === 0) this.tBurn.append(el('option', { value: '', textContent: 'No burns in the plan', disabled: true }));
    if (keep) this.tBurn.value = keep;
  }

  // -- Chain ----------------------------------------------------------------

  private chainPane(): HTMLElement {
    const run = async (search: boolean) => {
      const seq = this.cSeq.value.trim().toLowerCase().split(/[\s,>-]+/).filter(Boolean);
      const times = this.cDates.value.trim().split(/[\s,]+/).map(parseDay);
      if (seq.length < 2 || times.length !== seq.length || times.some((t) => t === null)) {
        this.cResult.innerHTML = '<div class="pl-fail">Give at least two bodies and one YYYY-MM-DD date per body.</div>';
        return;
      }
      const unknown = seq.filter((s) => !BODIES.some((b) => b.id === s || b.name.toLowerCase() === s));
      if (unknown.length) {
        this.cResult.innerHTML = `<div class="pl-fail">Unknown body: ${esc(unknown.join(', '))}</div>`;
        return;
      }
      const ts = times as number[];
      const w = search ? Math.max(1, Number(this.cWin.value) || 60) : null;
      const r = await this.job(() => this.client.run({ type: 'chain', seq, times: ts, windowDays: w }, Math.min(...ts) - (w ?? 0) * DAY, Math.max(...ts) + (w ?? 0) * DAY, this.onProgress)).catch((e: Error) => {
        this.cResult.innerHTML = `<div class="pl-fail">${esc(e.message)}</div>`;
        return null;
      });
      if (!r) return;
      if (search) this.cDates.value = r.times.map(dayStr).join(' ');
      this.cResult.innerHTML = chainTable(seq, r.times, r.result, r.ms, r.evaluations);
    };
    return el('div', { className: 'pl-chain' },
      el('div', { className: 'pl-form' },
        el('p', { className: 'pl-warn', textContent: 'Plausibility check only: planet-centre to planet-centre Lambert legs, zero revolutions. Resonant returns (e.g. Earth to Earth after exactly a year), multi-revolution legs and deep-space manoeuvres are not considered, so a sequence flagged here may still be flyable, and one that passes still needs real refinement.' }),
        field2('Bodies', this.cSeq),
        field2('Dates', this.cDates),
        field2('Search ± days', this.cWin),
        el('div', { className: 'pl-row' }, button('Check these dates', () => void run(false), 'primary'), button('Search dates', () => void run(true)))),
      this.cResult);
  }
}

function chainTable(seq: string[], times: number[], r: import('./planning-layer').ChainResult, ms: number, evals: number): string {
  const name = (id: string) => BODIES.find((b) => b.id === id)?.name ?? id;
  const km = (m: number) => (Number.isFinite(m) ? `${(m / 1e3).toLocaleString('en-US', { maximumFractionDigits: 0 })} km` : '—');
  const rows = r.flybys.map((f) => {
    const flag = f.poweredBelowSurface ? '<b class="bad">below the surface</b>' : f.poweredBelowMin ? '<b class="warnc">below the minimum altitude</b>' : 'ok';
    return `<tr><td>${esc(name(f.body))}<br><small>${dayStr(f.t)}</small></td><td>${(f.vInfInMag / 1e3).toFixed(2)} / ${(f.vInfOutMag / 1e3).toFixed(2)} km/s</td><td>${(f.mismatch).toFixed(0)} m/s</td><td>${(f.turnAngle * DEG).toFixed(1)}°</td><td>${Number.isFinite(f.rpPowered) ? esc(fromCentre(f.rpPowered, f.body)) : '—'}<br><small>ballistic ${Number.isFinite(f.rpBallistic) ? esc(fromCentre(f.rpBallistic, f.body)) : '—'}</small></td><td>${flag}</td></tr>`;
  }).join('');
  return `<div class="${r.ok ? 'pl-ok' : 'pl-fail'}">${seq.map(name).join(' → ')}: departure C3 ${(r.c3 / 1e6).toFixed(2)} km²/s², arrival v∞ ${(r.arrivalVInf / 1e3).toFixed(2)} km/s, Δv estimate ${(r.totalDv / 1e3).toFixed(2)} km/s (departure + |mismatches| + arrival). ${evals > 1 ? `${evals.toLocaleString('en-US')} evaluations, ` : ''}${ms.toFixed(0)} ms.</div>` +
    (rows ? `<table class="pl-table"><tr><th>Flyby</th><th>v∞ in / out</th><th>Mismatch</th><th>Turn</th><th>Required periapsis</th><th>Check</th></tr>${rows}</table>` : '<div class="hint">No intermediate flybys (a direct leg).</div>') +
    `<div class="hint">Dates: ${times.map(dayStr).join(', ')}. Mismatch: |v∞ out| − |v∞ in|, which a ballistic flyby cannot provide (powered-flyby periapsis burn in the Δv estimate). Required periapsis from the powered-flyby model; minimum altitudes are the top of the atmosphere.</div>`;
}
