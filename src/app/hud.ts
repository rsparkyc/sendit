/**
 * HUD in plain DOM: the status bar (time, play / warp, outcome, key number,
 * shortcut reference), the Time and View panels, the readouts and the loading
 * banner. Controls write to the store; the HUD re-renders from store changes.
 * Per-frame numbers (readouts, perf) come through `frame()`. Where each piece
 * sits on screen is the layout's business (layout.ts).
 */
import { KeysDialog } from './keys-dialog';
import { el, fillBodySelect, formatMet, section } from './dom';
import { fmtTime, otherTime, parseTime, timeMode, onTimeMode, setTimeMode, nextTimeMode, TIME_MODE_LABEL, setTimeEpoch } from './timefmt';
import { frameLabel, frameExplain, type FrameSpec } from './frames';
import { hasSurfaceFrame } from './orientation';
import { formatSpeed } from './format';
import { distanceRow } from './units';
import type { Status } from './status';
import type { AppState, Store } from './store';
import { WARP_RATES } from './store';
import { formatCalendar, formatRate, tdbToCalendar, tdbToUtc, utcIsPredicted } from './time';

export interface HudBody {
  name: string;
  /** Default secondary for a rotating frame centred here. */
  defaultSecondary: number;
}

export interface Readout {
  title: string;
  /** Relative to: e.g. "Earth" or "SSB". */
  relativeTo: string;
  /** Body id the distance is measured from (its centre), or null for a barycentre. */
  relativeId?: string | null;
  distance: number;
  speed: number;
  extra?: string;
}

export interface HudActions {
  jump(text: string): string | null; // returns an error message or null
  jumpTo(t: number): void;
  presets: { label: string; t: number }[];
  spacecraftName: string | null;
  status(s: AppState): Status;
}

export class Hud {
  readonly timePanel: HTMLElement;
  readonly viewPanel: HTMLElement;
  readonly infoPanel: HTMLElement;
  readonly keys: HTMLDialogElement;
  private readonly keysDialog: KeysDialog;
  // The Time panel's calendar lines and the status bar's second line are the "other mode" reference (data-time-other):
  // they show the instant in the other forms whatever the time-display setting is.
  private readonly date = el('div', { className: 'date', dataset: { timeOther: '1' } });
  private readonly utc = el('div', { className: 'utc', dataset: { timeOther: '1' } });
  private readonly tbDate = el('span', { className: 'tb-date', dataset: { timeOther: '1' } });
  private readonly tbMet = el('button', { className: 'tb-met', type: 'button' });
  private readonly chip = el('span', { className: 'chip' });
  private readonly key = el('span', { className: 'tb-key' });
  private readonly warp = el('span', { className: 'warp' });
  private readonly pauseBtn = el('button', { className: 'btn tb-btn', type: 'button' });
  private readonly focusSel = el('select', { title: 'Focus' });
  private readonly kindSel = el('select', { title: 'Frame type', className: 'frame-kind' });
  private readonly centerSel = el('select', { title: 'Frame centre' });
  private readonly frameNote = el('p', { className: 'hint frame-note' });
  private readonly secondarySel = el('select', { title: 'Body held fixed on the frame x axis' });
  private readonly readouts = el('div', { className: 'readouts' });
  private readonly perf = el('div', { className: 'perf' });
  private readonly loading = el('div', { className: 'loading', role: 'status' });
  private readonly jumpInput = el('input', { type: 'text', placeholder: 'YYYY-MM-DD [HH:MM]', spellcheck: false, title: 'Jump to a TDB date', inputMode: 'numeric', enterKeyHint: 'go' });
  private readonly jumpError = el('div', { className: 'error' });

  constructor(
    topbar: HTMLElement,
    overlay: HTMLElement,
    private readonly store: Store<AppState>,
    private readonly bodies: readonly HudBody[],
    private readonly actions: HudActions,
  ) {
    const slower = el('button', { className: 'btn tb-btn', type: 'button', textContent: '«', title: 'Slower time warp (Shift+J or ,)', ariaLabel: 'Slower time warp' });
    const faster = el('button', { className: 'btn tb-btn', type: 'button', textContent: '»', title: 'Faster time warp (Shift+K or .)', ariaLabel: 'Faster time warp' });
    slower.onclick = () => this.stepWarp(-1);
    faster.onclick = () => this.stepWarp(1);
    this.pauseBtn.onclick = () => store.set({ paused: !store.get().paused });
    const help = el('button', { className: 'btn tb-btn tb-help', type: 'button', textContent: '?', title: 'Shortcuts and gestures (?)', ariaLabel: 'Shortcuts and gestures' });
    help.onclick = () => this.showKeys(help);
    const status = el('div', { className: 'tb-status', role: 'status' }, this.chip, this.key);
    status.setAttribute('aria-live', 'polite');
    topbar.append(
      el('div', { className: 'tb-clock' }, this.pauseBtn, slower, this.warp, faster),
      el('div', { className: 'tb-time' }, this.tbDate, this.tbMet),
      status,
      el('a', { className: 'tb-credits', id: 'image-credits', href: 'credits.html', textContent: 'Credits', title: 'Image credits: sources and licences of the planet and moon maps' }),
      help,
    );

    const jumpForm = el('form', { className: 'jump' }, this.jumpInput, el('button', { className: 'btn', type: 'submit', textContent: 'Go' }));
    jumpForm.onsubmit = (e) => {
      e.preventDefault();
      const err = actions.jump(this.jumpInput.value);
      this.jumpError.textContent = err ?? '';
      if (!err) this.jumpInput.blur();
    };
    const presets = el('div', { className: 'presets' });
    for (const p of actions.presets) {
      const b = el('button', { className: 'btn small', type: 'button', textContent: p.label });
      b.onclick = () => actions.jumpTo(p.t);
      presets.append(b);
    }
    const help2 = el('button', { className: 'btn small keys-open', type: 'button', textContent: 'Shortcuts and gestures' });
    help2.onclick = () => this.showKeys(help2);
    presets.append(help2);
    this.timePanel = section('Time', 'time', this.date, this.utc, el('label', { className: 'sr-only', htmlFor: 'jump-date', textContent: 'Jump to a TDB date' }), jumpForm, this.jumpError, presets);
    this.jumpInput.id = 'jump-date';

    fillBodySelect(this.focusSel, String, actions.spacecraftName ? [{ value: '-1', label: actions.spacecraftName }] : []);
    this.focusSel.onchange = () => store.set({ focus: Number(this.focusSel.value) });
    for (const [v, t] of [['inertial', 'Inertial, centred on a body'], ['surface', "Rotating with a body's surface"], ['rotating', 'Rotating with a line between two bodies'], ['barycentric', 'Inertial, Solar System centre']]) {
      this.kindSel.append(el('option', { value: v, textContent: t }));
    }
    fillBodySelect(this.centerSel);
    fillBodySelect(this.secondarySel);
    const onFrame = () => this.commitFrame();
    this.kindSel.onchange = onFrame;
    this.centerSel.onchange = () => {
      this.secondarySel.value = String(bodies[Number(this.centerSel.value)].defaultSecondary);
      this.commitFrame();
    };
    this.secondarySel.onchange = onFrame;
    const lab = (t: string, s: HTMLSelectElement, cls = '') => el('label', { className: `frow ${cls}` }, el('span', { textContent: t }), s);
    this.viewPanel = section('View', 'view', lab('Focus', this.focusSel), lab('Frame', this.kindSel), lab('Centre', this.centerSel, 'center'), lab('Toward', this.secondarySel, 'secondary'), this.frameNote);

    const perfD = el('details', { className: 'perf-d' }, el('summary', { textContent: 'Performance' }), this.perf);
    this.infoPanel = el('section', { className: 'panel info' }, this.readouts, perfD);
    this.infoPanel.setAttribute('aria-label', 'Readouts');

    this.keysDialog = new KeysDialog(() => (help.offsetParent !== null ? help : help2.offsetParent !== null ? help2 : null));
    this.keys = this.keysDialog.root;
    overlay.append(this.loading, this.keys);

    store.subscribe((s, p) => this.render(s, p));
    this.tbMet.onclick = () => setTimeMode(nextTimeMode(timeMode()));
    onTimeMode(() => this.render(store.get(), null));
    this.render(store.get(), null);
  }

  showKeys(opener?: HTMLElement): void {
    this.keysDialog.show(opener);
  }

  stepWarp(d: number): void {
    const s = this.store.get();
    this.store.set({ warpIndex: Math.max(0, Math.min(WARP_RATES.length - 1, s.warpIndex + d)) });
  }

  private commitFrame(): void {
    const kind = this.kindSel.value;
    const center = Number(this.centerSel.value);
    let secondary = Number(this.secondarySel.value);
    let frame: FrameSpec;
    if (kind === 'barycentric') frame = { kind: 'barycentric' };
    else if (kind === 'inertial') frame = { kind: 'inertial', center };
    else if (kind === 'surface') frame = hasSurfaceFrame(center) ? { kind: 'surface', center } : { kind: 'inertial', center };
    else {
      const prev = this.store.get().frame;
      if (secondary === center || prev.kind !== 'rotating') secondary = this.bodies[center].defaultSecondary;
      frame = { kind: 'rotating', center, secondary };
    }
    this.store.set({ frame });
  }

  private render(s: AppState, p: AppState | null): void {
    if (!p || s.paused !== p.paused) {
      this.pauseBtn.textContent = s.paused ? '▶' : '❚❚';
      this.pauseBtn.ariaLabel = s.paused ? 'Play (Space)' : 'Pause (Space)';
      this.pauseBtn.title = this.pauseBtn.ariaLabel;
      this.pauseBtn.classList.toggle('active', s.paused);
    }
    if (!p || s.warpIndex !== p.warpIndex || s.paused !== p.paused) {
      this.warp.textContent = formatRate(WARP_RATES[s.warpIndex]);
      this.warp.title = `Time warp: simulated time per real second${s.paused ? ' (paused)' : ''}. Shift+J / Shift+K: slower / faster; hold J / K: move back / forward at this rate`;
    }
    if (!p || s.focus !== p.focus) this.focusSel.value = String(s.focus);
    if (!p || s.frame !== p.frame) {
      const f = s.frame;
      this.kindSel.value = f.kind;
      if (f.kind !== 'barycentric') this.centerSel.value = String(f.center);
      if (f.kind === 'rotating') this.secondarySel.value = String(f.secondary);
      (this.centerSel.parentElement as HTMLElement).style.display = f.kind === 'barycentric' ? 'none' : '';
      (this.secondarySel.parentElement as HTMLElement).style.display = f.kind === 'rotating' ? '' : 'none';
      this.kindSel.title = frameLabel(f, (i) => this.bodies[i].name);
      this.frameNote.textContent = `${frameLabel(f, (i) => this.bodies[i].name)}. ${frameExplain(f, (i) => this.bodies[i].name)}`;
    }
    if (!p || s.t !== p.t || s.plan !== p.plan) {
      const cal = formatCalendar(tdbToCalendar(s.t));
      this.date.textContent = `${cal} TDB`;
      const u = tdbToUtc(s.t);
      this.utc.textContent = !u ? 'UTC not shown before 1972' : `${formatCalendar(u)} UTC${utcIsPredicted(s.t) ? ' (predicted: no new leap seconds)' : ''}`;
      // The secondary line: the same instant in the other form (timefmt otherTime), the documented exception.
      this.tbDate.textContent = otherTime(s.t - s.plan.epoch);
      this.tbMet.textContent = fmtTime(s.t - s.plan.epoch, 0);
      this.tbMet.title = `${otherTime(s.t - s.plan.epoch)} · tap to show times as ${TIME_MODE_LABEL[nextTimeMode(timeMode())]}`;
      this.tbMet.setAttribute('aria-label', `Time ${fmtTime(s.t - s.plan.epoch, 0)}; tap to show times as ${TIME_MODE_LABEL[nextTimeMode(timeMode())]}`);
    }
    if (!p || s.t !== p.t || s.replay !== p.replay || s.plan !== p.plan || s.replayStatus !== p.replayStatus || s.missionId !== p.missionId) {
      const st = this.actions.status(s);
      this.chip.className = `chip tone-${st.tone}`;
      this.chip.textContent = `${st.icon} ${st.text}`;
      this.key.textContent = st.key;
    }
    if (!p || s.loadingTarget !== p.loadingTarget || s.loadingChunks !== p.loadingChunks) {
      if (s.loadingTarget === null) this.loading.style.display = 'none';
      else {
        this.loading.style.display = '';
        this.loading.textContent = `Integrating ephemeris to ${fmtTime(s.loadingTarget - s.plan.epoch, 0)}… ${s.loadingChunks} chunk${s.loadingChunks === 1 ? '' : 's'} to go`;
      }
    }
  }

  /** Per-frame readouts. */
  frame(readouts: Readout[], perf: string): void {
    const html = readouts
      .map(
        (r) =>
          `<div class="ro"><div class="ro-title">${esc(r.title)}</div>` +
          (Number.isFinite(r.distance)
            ? distanceKv(r) +
              `<div class="kv"><span>Speed rel. ${esc(r.relativeTo)}</span><b>${formatSpeed(r.speed)}</b></div>`
            : '') +
          (r.extra ? `<div class="kv extra">${esc(r.extra)}</div>` : '') +
          `</div>`,
      )
      .join('');
    if (html !== this.lastReadout) {
      this.readouts.innerHTML = html;
      this.lastReadout = html;
    }
    if (perf !== this.lastPerf) {
      this.perf.textContent = perf;
      this.lastPerf = perf;
    }
  }
  private lastReadout = '';
  private lastPerf = '';
}

function distanceKv(r: Readout): string {
  const [label, value] = distanceRow(r.distance, r.relativeId ?? null, r.relativeTo);
  return `<div class="kv"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
