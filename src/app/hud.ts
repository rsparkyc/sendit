/**
 * HUD in plain DOM. Controls write to the store; the HUD re-renders from store
 * changes. Per-frame numbers (readouts, perf) come through `frame()`.
 */
import { frameLabel, type FrameSpec } from './frames';
import { formatDistance, formatSpeed } from './format';
import type { Store, ViewState } from './store';
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
  distance: number;
  speed: number;
  extra?: string;
}

export interface HudActions {
  jump(text: string): string | null; // returns an error message or null
  jumpTo(t: number): void;
  presets: { label: string; t: number }[];
  spacecraftName: string | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

export class Hud {
  private readonly date = el('div', { className: 'date' });
  private readonly utc = el('div', { className: 'utc' });
  private readonly warp = el('span', { className: 'warp' });
  private readonly pauseBtn = el('button', { className: 'btn', title: 'Pause / resume (Space)' });
  private readonly focusSel = el('select', { title: 'Focus' });
  private readonly kindSel = el('select', { title: 'Frame type' });
  private readonly centerSel = el('select', { title: 'Frame centre' });
  private readonly secondarySel = el('select', { title: 'Body held fixed on the frame x axis' });
  private readonly readouts = el('div', { className: 'readouts' });
  private readonly perf = el('div', { className: 'perf' });
  private readonly loading = el('div', { className: 'loading' });
  private readonly jumpInput = el('input', { type: 'text', placeholder: 'YYYY-MM-DD [HH:MM]', spellcheck: false, title: 'Jump to a TDB date' });
  private readonly jumpError = el('div', { className: 'error' });

  constructor(
    root: HTMLElement,
    private readonly store: Store<ViewState>,
    private readonly bodies: readonly HudBody[],
    private readonly actions: HudActions,
  ) {
    const slower = el('button', { className: 'btn', textContent: '«', title: 'Slower (,)' });
    const faster = el('button', { className: 'btn', textContent: '»', title: 'Faster (.)' });
    slower.onclick = () => this.stepWarp(-1);
    faster.onclick = () => this.stepWarp(1);
    this.pauseBtn.onclick = () => store.set({ paused: !store.get().paused });

    const jumpForm = el('form', { className: 'jump' }, this.jumpInput, el('button', { className: 'btn', type: 'submit', textContent: 'Go' }));
    jumpForm.onsubmit = (e) => {
      e.preventDefault();
      const err = actions.jump(this.jumpInput.value);
      this.jumpError.textContent = err ?? '';
      if (!err) this.jumpInput.blur();
    };
    const presets = el('div', { className: 'presets' });
    for (const p of actions.presets) {
      const b = el('button', { className: 'btn small', textContent: p.label });
      b.onclick = () => actions.jumpTo(p.t);
      presets.append(b);
    }

    const time = el('section', { className: 'panel time' },
      this.date, this.utc,
      el('div', { className: 'row' }, this.pauseBtn, slower, this.warp, faster),
      jumpForm, this.jumpError, presets);

    if (actions.spacecraftName) this.focusSel.append(el('option', { value: '-1', textContent: actions.spacecraftName }));
    bodies.forEach((b, i) => this.focusSel.append(el('option', { value: String(i), textContent: b.name })));
    this.focusSel.onchange = () => store.set({ focus: Number(this.focusSel.value) });

    for (const [v, t] of [['barycentric', 'Barycentric'], ['inertial', 'Body-centred inertial'], ['rotating', 'Body-centred rotating']]) {
      this.kindSel.append(el('option', { value: v, textContent: t }));
    }
    bodies.forEach((b, i) => {
      this.centerSel.append(el('option', { value: String(i), textContent: b.name }));
      this.secondarySel.append(el('option', { value: String(i), textContent: b.name }));
    });
    const onFrame = () => this.commitFrame();
    this.kindSel.onchange = onFrame;
    this.centerSel.onchange = () => {
      // New centre: reset the secondary to its natural partner.
      this.secondarySel.value = String(bodies[Number(this.centerSel.value)].defaultSecondary);
      this.commitFrame();
    };
    this.secondarySel.onchange = onFrame;

    const view = el('section', { className: 'panel view' },
      el('label', {}, el('span', { textContent: 'Focus' }), this.focusSel),
      el('label', {}, el('span', { textContent: 'Frame' }), this.kindSel),
      el('label', { className: 'center' }, el('span', { textContent: 'Centre' }), this.centerSel),
      el('label', { className: 'secondary' }, el('span', { textContent: 'Fixed' }), this.secondarySel));

    const help = el('div', { className: 'help', textContent: 'Drag: rotate · Wheel: zoom · Click label: focus · Space: pause · , . : warp' });
    root.append(time, view, el('section', { className: 'panel info' }, this.readouts, this.perf), this.loading, help);

    store.subscribe((s, p) => this.render(s, p));
    this.render(store.get(), null);
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
    else {
      if (secondary === center) secondary = this.bodies[center].defaultSecondary;
      frame = { kind: 'rotating', center, secondary };
    }
    this.store.set({ frame });
  }

  private render(s: ViewState, p: ViewState | null): void {
    if (!p || s.paused !== p.paused) {
      this.pauseBtn.textContent = s.paused ? '▶' : '❚❚';
      this.pauseBtn.classList.toggle('active', s.paused);
    }
    if (!p || s.warpIndex !== p.warpIndex || s.paused !== p.paused) {
      this.warp.textContent = `${s.paused ? 'paused · ' : ''}${formatRate(WARP_RATES[s.warpIndex])}`;
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
    }
    if (!p || s.t !== p.t) {
      this.date.textContent = `${formatCalendar(tdbToCalendar(s.t))} TDB`;
      const u = tdbToUtc(s.t);
      this.utc.textContent = !u ? 'UTC not shown before 1972' : `${formatCalendar(u)} UTC${utcIsPredicted(s.t) ? ' (predicted: no new leap seconds)' : ''}`;
    }
    if (!p || s.loadingTarget !== p.loadingTarget || s.loadingChunks !== p.loadingChunks) {
      if (s.loadingTarget === null) this.loading.style.display = 'none';
      else {
        this.loading.style.display = '';
        this.loading.textContent = `Integrating ephemeris to ${formatCalendar(tdbToCalendar(s.loadingTarget), false)} TDB… ${s.loadingChunks} chunk${s.loadingChunks === 1 ? '' : 's'} to go`;
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
            ? `<div class="kv"><span>Distance from ${esc(r.relativeTo)}</span><b>${formatDistance(r.distance)}</b></div>` +
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

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
