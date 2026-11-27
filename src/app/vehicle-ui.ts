/**
 * Vehicle and launch panels (plain DOM, as editor-ui.ts):
 *
 *  - VehiclePanel: the stack drawn bottom (stage 1) to top (spacecraft), each
 *    stage with its masses, engines, thrust-to-weight at ignition and its
 *    delta-v with everything above it as payload; the total budget; before a
 *    replay what the ascent left each stage and what the nodes ask of it,
 *    after a replay what each stage used and has left and which one reached
 *    orbit. Read-only in a mission; in Sandbox a full editor (presets, a
 *    spacecraft alone with free delivery, add / remove / reorder stages,
 *    masses and engines), every change an undoable edit.
 *  - LaunchFeedback (inside the Start panel): the ascent's required delta-v
 *    and its breakdown, which stage reaches orbit and what the upper stage
 *    has left, or why the vehicle cannot reach the orbit; and two charts of
 *    upper-stage delta-v left at insertion, against parking altitude and
 *    against azimuth (with the inclination each azimuth gives and the site's
 *    range-safety corridor), computed in ascent-worker.ts point by point.
 *    Tap or drag a chart to set the value (committed on release).
 */
import { el, esc, section, setText } from './dom';
import type { UiContext } from './editor-ui';
import { PARKING_BAND, VEHICLES, azimuthAllowed, catalogueStages, launchPlane, launchSite, planAscent, planErrors, vehicleStages, type AscentResult, type MissionPlan, type Spacecraft } from './mission-layer';
import { launchOf, missionById } from './missions';
import { BODY_DATA } from './physics';
import type { AppState } from './store';
import { bodyRadius, distanceMode, onDistanceMode } from './units';
import { catalogueMatch, stagePlan, stageRows } from './vehicle';
import type { AscentJob, FromAscent } from './ascent-protocol';

const fmtDv = (v: number) => (Number.isFinite(v) ? `${Math.round(v).toLocaleString('en-US')} m/s` : '—');
const fmtKg = (v: number) => (Number.isFinite(v) ? `${Math.round(v).toLocaleString('en-US')} kg` : '—');
const fmtKn = (n: number) => `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} kN`;

/** Chart and ascent timings for the report and the tests. */
export const ascentMetrics = { altChartMs: NaN, azChartMs: NaN, firstPointMs: NaN, pointMs: [] as number[], feedbackMs: NaN };

function numField(title: string, value: number, onCommit: (v: number) => void, cls = ''): HTMLInputElement {
  const i = el('input', { type: 'text', title, className: `num ${cls}`, inputMode: 'decimal', enterKeyHint: 'done', spellcheck: false, autocomplete: 'off', value: String(value) });
  i.setAttribute('aria-label', title);
  const commit = () => {
    const v = Number(i.value);
    if (i.value.trim() !== '' && Number.isFinite(v) && v > 0) onCommit(v);
  };
  i.addEventListener('change', commit);
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); i.blur(); } });
  return i;
}

const DEFAULT_STAGE: Spacecraft = { wetMass: 30000, dryMass: 3000, engines: [{ thrust: 300e3, isp: 340 }] };

// ---------------------------------------------------------------------------

export class VehiclePanel {
  readonly root: HTMLElement;
  private readonly note = el('div', { className: 'hint vehicle-note' });
  private readonly preset = el('select', { title: 'Start from a catalogue vehicle, or a spacecraft alone', className: 'vehicle-preset' });
  private readonly editBar = el('div', { className: 'row wrap vehicle-edit' });
  private readonly stack = el('div', { className: 'stack' });
  private readonly totals = el('div', { className: 'stack-totals' });
  private readonly errs = el('div', { className: 'error' });
  private key = '';

  constructor(private readonly ctx: UiContext) {
    this.preset.append(el('option', { value: '', textContent: 'Vehicle preset…' }), el('option', { value: '@none', textContent: 'Spacecraft only (free delivery to the parking orbit)' }));
    for (const v of VEHICLES) this.preset.append(el('option', { value: v.id, textContent: v.name }));
    this.preset.onchange = () => {
      const v = this.preset.value;
      this.preset.value = '';
      if (v === '@none') ctx.editor.setStages(null);
      else if (v) ctx.editor.setStages(catalogueStages(v));
    };
    const add = el('button', { className: 'btn small', type: 'button', textContent: '+ Stage under the spacecraft' });
    add.onclick = () => ctx.editor.setStages([...(this.plan().lowerStages ?? []), { ...DEFAULT_STAGE, engines: DEFAULT_STAGE.engines.map((e) => ({ ...e })) }]);
    this.editBar.append(this.preset, add);
    this.root = section('Vehicle', 'vehicle', this.note, this.editBar, this.totals, this.stack, this.errs);
    ctx.store.subscribe((s, p) => {
      if (s.plan !== p.plan || s.missionId !== p.missionId || s.replay !== p.replay) this.render(s);
    });
    this.render(ctx.store.get());
  }

  private plan(): MissionPlan {
    return this.ctx.store.get().plan;
  }

  private setLower(f: (lower: Spacecraft[]) => Spacecraft[]): void {
    const lower = (this.plan().lowerStages ?? []).map((x) => ({ ...x, engines: x.engines.map((e) => ({ ...e })) }));
    const next = f(lower);
    this.ctx.editor.setStages(next.length ? next : null);
  }

  private render(s: AppState): void {
    const plan = s.plan;
    const entry = missionById(s.missionId);
    const locked = !!entry?.def;
    const rows = stageRows(plan);
    const a = planAscent(plan, BODY_DATA);
    const sp = stagePlan(plan, a);
    const r = s.replay && s.replay.plan === plan && s.replay.preview === null ? s.replay.result : null;
    const cat = catalogueMatch(plan.lowerStages);
    this.editBar.style.display = locked ? 'none' : '';
    setText(this.note, locked
      ? `This mission fixes the vehicle${cat ? `: ${cat.name}` : ''} with its spacecraft on top. You choose the site, azimuth and parking altitude (Start); the ascent is paid for in upper-stage propellant.`
      : rows.length === 1 ? 'Spacecraft only: it is delivered free to the parking orbit (no ascent is charged). Pick a vehicle preset or add a stage to fly a launch vehicle.' : `${cat ? cat.name : 'Custom vehicle'}: the lower stages fly the ascent (computed, not flown); burns after insertion use the lowest remaining stage.`);
    // Totals.
    const budget = rows.reduce((x, y) => x + y.deltaV, 0);
    const ok = a && a.ok ? a : null;
    this.totals.innerHTML =
      `<div class="kv"><span>Total budget (ideal, from the pad)</span><b class="budget-total">${fmtDv(budget)}</b></div>` +
      (ok ? `<div class="kv"><span>Ascent needs</span><b>${fmtDv(ok.deltaV)} · reaches orbit on ${esc(rows[ok.upperStage]?.tag ?? '')}</b></div>` : a && !a.ok ? `<div class="kv bad"><span>Ascent</span><b>cannot reach orbit</b></div>` : '') +
      (r ? `<div class="kv"><span>Flown (replay)</span><b>ascent ${fmtDv(r.ascent?.deltaV ?? 0)} + flight ${fmtDv(r.deltaV)} = ${fmtDv(r.totalDeltaV)}</b></div>` : '');
    // Stack, top (spacecraft) first in the DOM, so it reads as a rocket: stage 1 at the bottom.
    const k = JSON.stringify([locked, plan.lowerStages, plan.spacecraft, distanceMode()]);
    const focused = this.stack.contains(document.activeElement);
    if (k !== this.key && !focused) {
      this.key = k;
      this.stack.replaceChildren(...rows.slice().reverse().map((row) => this.stageCard(row.index, rows, locked)));
    }
    // Live figures in each card.
    for (const row of rows) {
      const card = this.stack.querySelector(`[data-stage="${row.index}"] .stage-live`);
      if (!card) continue;
      const p = sp[row.index];
      const rep = r?.stages[row.index];
      const lines: string[] = [];
      if (p.ascent === 'dropped') lines.push(`<span class="tag drop">burns out in the ascent</span>`);
      if (p.ascent === 'reached-orbit') lines.push(`<span class="tag orbit">reaches orbit</span> with ${fmtKg(p.atStart)} left`);
      if (p.requested > 0) lines.push(`nodes use ${fmtKg(p.requested)} · plan leaves ${fmtKg(p.left)} (${fmtDv(p.dvLeft)})`);
      else if (p.ascent !== 'dropped') lines.push(`plan leaves ${fmtKg(p.left)} (${fmtDv(p.dvLeft)})`);
      if (rep) lines.push(`<b>replay</b>: Δv ${fmtDv(rep.deltaV)}${rep.ascentDeltaV > 0 ? ` (ascent ${fmtDv(rep.ascentDeltaV)})` : ''} · used ${fmtKg(rep.propellantUsed)} · left ${fmtKg(rep.propellantLeft)}${rep.droppedInAscent ? ' · dropped in the ascent' : rep.separatedAt !== null ? ' · separated' : ''}`);
      card.innerHTML = lines.map((x) => `<div>${x}</div>`).join('');
    }
    const errs = planErrors(plan).plan.filter((e) => /stage|lowerStages|spacecraft|mass|engine|thrust|isp|ascent/i.test(e));
    setText(this.errs, errs.join('\n'));
  }

  private stageCard(k: number, rows: ReturnType<typeof stageRows>, locked: boolean): HTMLElement {
    const row = rows[k];
    const n = rows.length;
    const head = el('div', { className: 'stage-head' },
      el('span', { className: `nstage${row.isSpacecraft ? ' sc' : ''}`, textContent: row.tag }),
      el('b', { className: 'stage-name', textContent: row.name }));
    const figs = el('div', { className: 'stage-figs' });
    figs.innerHTML =
      `<span>dry ${fmtKg(row.dryMass)}</span><span>propellant ${fmtKg(row.propellant)}</span>` +
      `<span>${fmtKn(row.thrust)} · Isp ${row.isp.toFixed(0)} s</span>` +
      `<span title="Vacuum thrust over the stack's weight at this stage's ignition (Earth g)">T/W ${row.twr.toFixed(2)}</span>` +
      `<span title="Ideal delta-v of the full stage with everything above it as payload">Δv ${fmtDv(row.deltaV)}</span>`;
    const card = el('div', { className: `stage-card${row.isSpacecraft ? ' sc' : ''}`, dataset: { stage: String(k) } }, head, figs, el('div', { className: 'stage-live' }));
    if (locked || row.isSpacecraft) {
      if (row.isSpacecraft && !locked) card.append(el('div', { className: 'hint', textContent: 'Edit the spacecraft in the Spacecraft panel.' }));
      return card;
    }
    // Sandbox editor for a lower stage.
    const set = (patch: Partial<Spacecraft>) => this.setLower((l) => { l[k] = { ...l[k], ...patch }; return l; });
    const st = this.plan().lowerStages![k];
    const prop = numField(`${row.tag} propellant, kg`, st.wetMass - st.dryMass, (v) => set({ wetMass: st.dryMass + v }));
    const dry = numField(`${row.tag} dry mass, kg`, st.dryMass, (v) => set({ dryMass: v, wetMass: v + (st.wetMass - st.dryMass) }));
    const eng = el('div', { className: 'stage-engines' });
    st.engines.forEach((e, ei) => {
      const setE = (patch: Partial<{ thrust: number; isp: number }>) => set({ engines: st.engines.map((x, j) => (j === ei ? { ...x, ...patch } : x)) });
      const del = el('button', { className: 'btn small', type: 'button', textContent: '×', title: 'Remove engine', disabled: st.engines.length < 2 });
      del.setAttribute('aria-label', `Remove engine E${ei + 1} of ${row.tag}`);
      del.onclick = () => set({ engines: st.engines.filter((_, j) => j !== ei) });
      eng.append(el('div', { className: 'engine' }, el('span', { textContent: `E${ei + 1}` }),
        numField(`${row.tag} engine E${ei + 1} vacuum thrust, kN`, e.thrust / 1000, (v) => setE({ thrust: v * 1000 })), el('small', { textContent: 'kN' }),
        numField(`${row.tag} engine E${ei + 1} vacuum Isp, s`, e.isp, (v) => setE({ isp: v })), el('small', { textContent: 's' }), del));
    });
    const b = (t: string, label: string, f: () => void, disabled = false) => {
      const x = el('button', { className: 'btn small', type: 'button', textContent: t, disabled });
      x.setAttribute('aria-label', label);
      x.onclick = f;
      return x;
    };
    const L = n - 1;
    card.append(
      el('div', { className: 'row wrap stage-fields' }, el('label', { className: 'frow' }, el('span', { textContent: 'Prop kg' }), prop), el('label', { className: 'frow' }, el('span', { textContent: 'Dry kg' }), dry)),
      eng,
      el('div', { className: 'row wrap' },
        b('+ Engine', `Add an engine to ${row.tag}`, () => set({ engines: [...st.engines, { thrust: 100e3, isp: 300 }] }), st.engines.length >= 8),
        b('▲ Up', `Move ${row.tag} up the stack`, () => this.setLower((l) => { [l[k], l[k + 1]] = [l[k + 1], l[k]]; return l; }), k >= L - 1),
        b('▼ Down', `Move ${row.tag} down the stack`, () => this.setLower((l) => { [l[k], l[k - 1]] = [l[k - 1], l[k]]; return l; }), k === 0),
        b('Remove', `Remove ${row.tag}`, () => this.setLower((l) => l.filter((_, j) => j !== k)))));
    return card;
  }
}

// ---------------------------------------------------------------------------

interface Series { xs: number[]; pts: (FromAscent & { type: 'point' } | null)[]; id: number; t0: number }

export class LaunchFeedback {
  readonly root = el('div', { className: 'launch-feedback' });
  /** Placed by the Start panel at the top of the launch box (sticky), so the cost stays in view while editing. */
  readonly summary = el('div', { className: 'ascent-summary' });
  private readonly breakdown = el('div', { className: 'ascent-breakdown' });
  private readonly altChart = el('div', { className: 'chart alt-chart' });
  private readonly azChart = el('div', { className: 'chart az-chart' });
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly series: Record<'alt' | 'az', Series> = { alt: { xs: [], pts: [], id: 0, t0: 0 }, az: { xs: [], pts: [], id: 0, t0: 0 } };
  private jobKey: Record<'alt' | 'az', string> = { alt: '', az: '' };
  /** A chart drag in progress: the value it shows until release. */
  private dragging: { kind: 'alt' | 'az'; x: number } | null = null;

  constructor(private readonly ctx: UiContext) {
    this.root.append(this.breakdown, this.altChart, this.azChart);
    this.wireChart(this.altChart, 'alt');
    this.wireChart(this.azChart, 'az');
    // Start the worker now: its first job then does not pay for loading the module.
    setTimeout(() => this.ensureWorker(), 0);
    ctx.store.subscribe((s, p) => { if (s.plan !== p.plan || s.missionId !== p.missionId) this.update(); });
    onDistanceMode(() => this.update());
    this.update();
  }

  /** Parking-altitude range: the mission's band, or what a launch start accepts in Sandbox. */
  band(): [number, number] {
    const V = missionById(this.ctx.store.get().missionId)?.def?.rules.vehicle;
    return V ? [V.altitude[0], V.altitude[1]] : [PARKING_BAND[0] - 20e3, 2000e3];
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./ascent-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<FromAscent>) => this.onPoint(ev.data);
    this.worker = w;
    return w;
  }

  private onPoint(m: FromAscent): void {
    const S = this.series[m.kind];
    if (m.id !== S.id) return;
    if (m.type === 'done') {
      if (m.kind === 'alt') ascentMetrics.altChartMs = performance.now() - S.t0;
      else ascentMetrics.azChartMs = performance.now() - S.t0;
      (m.kind === 'alt' ? this.altChart : this.azChart).dataset.complete = 'true';
      return;
    }
    if (S.pts.every((x) => x === null)) ascentMetrics.firstPointMs = performance.now() - S.t0;
    ascentMetrics.pointMs.push(m.ms);
    if (ascentMetrics.pointMs.length > 400) ascentMetrics.pointMs.splice(0, 200);
    S.pts[m.i] = m;
    this.draw(m.kind);
  }

  private request(kind: 'alt' | 'az', plan: MissionPlan, xs: number[]): void {
    const st = plan.start;
    if (st.kind !== 'launch') return;
    const key = JSON.stringify([kind, vehicleStages(plan), st.site, st.params[0], kind === 'alt' ? st.params[1] : st.params[2], xs[0], xs.at(-1)]);
    if (key === this.jobKey[kind]) return;
    this.jobKey[kind] = key;
    const id = this.nextId++;
    this.series[kind] = { xs, pts: xs.map(() => null), id, t0: performance.now() };
    (kind === 'alt' ? this.altChart : this.azChart).dataset.complete = 'false';
    const job: AscentJob = { id, kind, stages: vehicleStages(plan), site: st.site, time: st.params[0], azimuthDeg: st.params[1], altitudeM: st.params[2], xs };
    this.ensureWorker().postMessage(job);
  }

  private update(): void {
    const s = this.ctx.store.get();
    const plan = s.plan;
    const st = plan.start;
    const staged = st.kind === 'launch' && st.ascent === 'vehicle';
    this.root.style.display = staged ? '' : 'none';
    this.summary.style.display = staged ? '' : 'none';
    if (!staged || st.kind !== 'launch') return;
    const t0 = performance.now();
    const a = planAscent(plan, BODY_DATA);
    ascentMetrics.feedbackMs = performance.now() - t0;
    this.renderSummary(plan, a);
    // Chart sweeps (worker).
    const [lo, hi] = this.band();
    const n = 25;
    this.request('alt', plan, Array.from({ length: n }, (_, i) => Math.round(lo + ((hi - lo) * i) / (n - 1))));
    const site = launchSite(st.site);
    const [a0, a1] = this.azRange(site);
    const m = 37;
    this.request('az', plan, Array.from({ length: m }, (_, i) => Math.round((a0 + ((a1 - a0) * i) / (m - 1)) * 100) / 100));
    this.draw('alt');
    this.draw('az');
  }

  /** Azimuths drawn: the corridor with a margin on each side (unwrapped, deg). */
  private azRange(site: ReturnType<typeof launchSite>): [number, number] {
    const lo = site.azimuthMinDeg;
    let hi = site.azimuthMaxDeg;
    if (hi < lo) hi += 360;
    const pad = Math.max(10, (hi - lo) * 0.2);
    return [lo - pad, hi + pad];
  }

  private renderSummary(plan: MissionPlan, a: AscentResult | null): void {
    const rows = stageRows(plan);
    if (!a) { this.summary.innerHTML = ''; this.breakdown.innerHTML = ''; return; }
    if (!a.ok) {
      this.summary.className = 'ascent-summary fail';
      this.summary.innerHTML = `<div class="ascent-fail"><b>⚠ This vehicle cannot reach the chosen orbit.</b><div>${esc(a.reason)}</div><div class="hint">Liftoff thrust-to-weight ${a.liftoffTW.toFixed(2)}. Try a lower parking orbit, an azimuth with more rotation credit, a lighter spacecraft or more stage propellant.</div></div>`;
      this.breakdown.innerHTML = '';
      return;
    }
    const up = rows[a.upperStage];
    const left = stagePlan(plan, a)[a.upperStage];
    const L = a.losses;
    const req = L.orbitalSpeed + L.rotation + L.gravity + L.drag + L.backPressure + L.steering + L.circularization;
    this.summary.className = 'ascent-summary';
    this.summary.innerHTML =
      `<div class="kv big"><span>Upper stage left at insertion</span><b class="upper-reserve">${fmtDv(stagePlanDv(plan, a))} · ${fmtKg(a.upperPropellant)}</b></div>` +
      `<div class="kv"><span>Reaches orbit on</span><b>${esc(up?.tag ?? '')} ${esc(up?.name ?? '')}</b></div>` +
      `<div class="kv"><span>Ascent Δv required</span><b class="ascent-required">${fmtDv(req)}</b></div>` +
      (left.requested > 0 ? `<div class="kv"><span>After your nodes on ${esc(up?.tag ?? '')}</span><b>${fmtKg(left.left)} · ${fmtDv(left.dvLeft)}</b></div>` : '');
    const line = (k: string, v: number, cls = '') => `<div class="kv${cls ? ` ${cls}` : ''}"><span>${k}</span><b>${v >= 0 ? '' : '−'}${fmtDv(Math.abs(v))}</b></div>`;
    this.breakdown.innerHTML = `<details class="ascent-detail"><summary>Ascent breakdown</summary>` +
      line('Orbital speed at insertion', L.orbitalSpeed) +
      line('Climb (part of gravity)', L.climb, 'sub') +
      line('Gravity (climb + loss)', L.gravity) +
      line('Drag', L.drag) + line('Back-pressure', L.backPressure) + line('Steering', L.steering) +
      (L.circularization > 0 ? line('Circularisation at apogee', L.circularization) : '') +
      line(L.rotation <= 0 ? 'Earth rotation credit' : 'Earth rotation (against)', L.rotation, L.rotation <= 0 ? 'credit' : 'bad') +
      line('= Required', req, 'total') + `</details>`;
  }

  // ----- charts -----

  private current(kind: 'alt' | 'az'): number {
    const l = launchOf(this.ctx.store.get().plan);
    if (!l) return NaN;
    if (kind === 'alt') return l.altitudeM;
    const site = launchSite(l.site);
    const [a0] = this.azRange(site);
    let az = l.azimuthDeg;
    while (az < a0) az += 360;
    return az;
  }

  private draw(kind: 'alt' | 'az'): void {
    const box = kind === 'alt' ? this.altChart : this.azChart;
    const S = this.series[kind];
    if (!S.xs.length) return;
    const W = 320, H = 132, ml = 44, mr = 18, mt = kind === 'az' ? 22 : 10, mb = 26;
    const x0 = S.xs[0], x1 = S.xs.at(-1)!;
    const vals = S.pts.filter((p) => p && p.ok).map((p) => p!.dv);
    const ymax = Math.max(100, ...vals) * 1.08;
    const ymin = Math.min(0, ...vals);
    const X = (x: number) => ml + ((x - x0) / (x1 - x0)) * (W - ml - mr);
    const Y = (y: number) => mt + (1 - (y - ymin) / (ymax - ymin)) * (H - mt - mb);
    const radius = distanceMode() === 'radius';
    const R = bodyRadius('earth');
    const xLabel = (x: number) => (kind === 'alt' ? `${Math.round((x + (radius ? R : 0)) / 1000).toLocaleString('en-US')}` : `${(((x % 360) + 360) % 360).toFixed(0)}°`);
    const parts: string[] = [];
    // Corridor shading (azimuth) and inclination ticks.
    const l = launchOf(this.ctx.store.get().plan);
    if (kind === 'az' && l) {
      const site = launchSite(l.site);
      let run: number | null = null;
      const steps = 120;
      for (let i = 0; i <= steps; i++) {
        const x = x0 + ((x1 - x0) * i) / steps;
        const ok = azimuthAllowed(site, ((x % 360) + 360) % 360);
        if (!ok && run === null) run = x;
        if ((ok || i === steps) && run !== null) {
          parts.push(`<rect class="out" x="${X(run).toFixed(1)}" y="${mt}" width="${(X(x) - X(run)).toFixed(1)}" height="${H - mt - mb}"><title>Outside ${esc(site.name)}'s range-safety corridor</title></rect>`);
          run = null;
        }
      }
      for (let i = 0; i < 5; i++) {
        const x = x0 + ((x1 - x0) * (i + 0.5)) / 5;
        const pl = launchPlane(site, l.time, ((x % 360) + 360) % 360);
        const c = pl.normal[0] * pl.pole[0] + pl.normal[1] * pl.pole[1] + pl.normal[2] * pl.pole[2];
        const inc = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
        parts.push(`<text class="inc" x="${X(x).toFixed(1)}" y="${mt - 8}" text-anchor="middle">i ${inc.toFixed(1)}°</text>`);
      }
    }
    // Axes.
    parts.push(`<line class="ax" x1="${ml}" y1="${H - mb}" x2="${W - mr}" y2="${H - mb}"/><line class="ax" x1="${ml}" y1="${mt}" x2="${ml}" y2="${H - mb}"/>`);
    for (const y of niceTicks(ymin, ymax, 3)) parts.push(`<text class="tl" x="${ml - 4}" y="${(Y(y) + 3).toFixed(1)}" text-anchor="end">${Math.round(y).toLocaleString('en-US')}</text><line class="grid" x1="${ml}" y1="${Y(y).toFixed(1)}" x2="${W - mr}" y2="${Y(y).toFixed(1)}"/>`);
    for (let i = 0; i <= 4; i++) {
      const x = x0 + ((x1 - x0) * i) / 4;
      parts.push(`<text class="tl" x="${X(x).toFixed(1)}" y="${H - mb + 12}" text-anchor="middle">${xLabel(x)}</text>`);
    }
    // Curve (segments between computed neighbours) and failures.
    let d = '';
    let last = -1;
    S.pts.forEach((p, i) => {
      if (!p) return;
      if (p.ok) {
        d += `${last === i - 1 && last >= 0 && S.pts[last]?.ok ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.dv).toFixed(1)}`;
        parts.push(`<circle class="pt" cx="${X(p.x).toFixed(1)}" cy="${Y(p.dv).toFixed(1)}" r="1.6"/>`);
      } else parts.push(`<text class="failpt" x="${X(p.x).toFixed(1)}" y="${(H - mb - 4).toFixed(1)}" text-anchor="middle">×<title>${esc(p.reason)}</title></text>`);
      last = i;
    });
    parts.push(`<path class="curve" d="${d}"/>`);
    // Current choice (or the value being dragged).
    const cur = this.dragging?.kind === kind ? this.dragging.x : this.current(kind);
    if (Number.isFinite(cur) && cur >= x0 && cur <= x1) {
      const near = nearest(S, cur);
      parts.push(`<line class="cur" x1="${X(cur).toFixed(1)}" y1="${mt}" x2="${X(cur).toFixed(1)}" y2="${H - mb}"/>`);
      if (near && near.ok) parts.push(`<circle class="curpt" cx="${X(cur).toFixed(1)}" cy="${Y(interp(S, cur)).toFixed(1)}" r="4"/>`);
    }
    const unit = kind === 'alt' ? (radius ? 'Parking orbit, km radius (from Earth’s centre)' : 'Parking orbit, km alt') : 'Azimuth (inclination above)';
    const pending = S.pts.some((p) => p === null);
    box.innerHTML = `<div class="chart-title">Upper-stage Δv left (m/s) vs ${kind === 'alt' ? (radius ? 'parking radius' : 'parking altitude') : 'azimuth'}${pending ? ' <span class="computing">computing…</span>' : ''}</div>` +
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Upper-stage delta-v left at insertion against ${kind === 'alt' ? (radius ? 'parking radius' : 'parking altitude') : 'azimuth'}; tap or drag to set">${parts.join('')}<text class="xl" x="${(ml + W - mr) / 2}" y="${H - 2}" text-anchor="middle">${esc(unit)}</text></svg>` +
      `<div class="chart-read">${this.readout(kind, cur)}</div>`;
  }

  private readout(kind: 'alt' | 'az', x: number): string {
    const S = this.series[kind];
    const p = nearest(S, x);
    if (!Number.isFinite(x)) return '';
    const radius = distanceMode() === 'radius';
    const xs = kind === 'alt' ? `${Math.round((x + (radius ? bodyRadius('earth') : 0)) / 1000).toLocaleString('en-US')} km ${radius ? 'radius' : 'alt'}` : `azimuth ${(((x % 360) + 360) % 360).toFixed(1)}°`;
    if (!p) return `${xs}: computing…`;
    return p.ok ? `${xs}: ≈ ${fmtDv(interp(S, x))} left on the upper stage${this.dragging ? ' · release to set' : ''}` : `${xs}: cannot reach orbit (${esc(p.reason)})`;
  }

  private wireChart(box: HTMLElement, kind: 'alt' | 'az'): void {
    const valueAt = (clientX: number) => {
      const svg = box.querySelector('svg');
      const S = this.series[kind];
      if (!svg || !S.xs.length) return NaN;
      const r = svg.getBoundingClientRect();
      const W = 320, ml = 44, mr = 18;
      const u = ((clientX - r.left) / r.width) * W;
      const f = Math.max(0, Math.min(1, (u - ml) / (W - ml - mr)));
      return S.xs[0] + f * (S.xs.at(-1)! - S.xs[0]);
    };
    box.style.touchAction = 'pan-y';
    box.addEventListener('pointerdown', (e) => {
      if (!(e.target as Element).closest('svg')) return;
      try { box.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      this.dragging = { kind, x: valueAt(e.clientX) };
      this.draw(kind);
    });
    box.addEventListener('pointermove', (e) => {
      if (this.dragging?.kind !== kind) return;
      this.dragging.x = valueAt(e.clientX);
      this.draw(kind);
    });
    const done = (commit: boolean) => {
      const d = this.dragging;
      if (d?.kind !== kind) return;
      this.dragging = null;
      const l = launchOf(this.ctx.store.get().plan);
      if (commit && l && Number.isFinite(d.x)) {
        if (kind === 'alt') {
          const [lo, hi] = this.band();
          this.ctx.editor.setLaunch({ ...l, altitudeM: Math.max(lo, Math.min(hi, Math.round(d.x / 1000) * 1000)) });
        } else this.ctx.editor.setLaunch({ ...l, azimuthDeg: Math.round((((d.x % 360) + 360) % 360) * 10) / 10 });
      }
      this.draw(kind);
    };
    box.addEventListener('pointerup', () => done(true));
    box.addEventListener('pointercancel', () => done(false));
  }
}

function stagePlanDv(plan: MissionPlan, a: Extract<AscentResult, { ok: true }>): number {
  const rows = stageRows(plan);
  const r = rows[a.upperStage];
  return r.isp * 9.80665 * Math.log((r.dryMass + a.upperPropellant + r.above) / (r.dryMass + r.above));
}

function nearest(S: Series, x: number) {
  let best: Series['pts'][number] = null;
  for (const p of S.pts) if (p && (!best || Math.abs(p.x - x) < Math.abs(best.x - x))) best = p;
  return best;
}

/** Linear interpolation between the computed neighbours of x (display only). */
function interp(S: Series, x: number): number {
  let lo: Series['pts'][number] = null, hi: Series['pts'][number] = null;
  for (const p of S.pts) {
    if (!p || !p.ok) continue;
    if (p.x <= x && (!lo || p.x > lo.x)) lo = p;
    if (p.x >= x && (!hi || p.x < hi.x)) hi = p;
  }
  if (lo && hi && hi.x !== lo.x) return lo.dv + ((hi.dv - lo.dv) * (x - lo.x)) / (hi.x - lo.x);
  return (lo ?? hi)?.dv ?? NaN;
}

function niceTicks(a: number, b: number, n: number): number[] {
  const span = b - a;
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(a / step) * step; v <= b; v += step) out.push(v);
  return out;
}
