/**
 * The "Trajectory and overlays" controls of the View tab: the drawn span
 * after the last burn (with the bright current-revolution option, one
 * control), the flight length (the plan's duration, which is replayed and
 * scored), the ascending / descending node reference plane, and the
 * reference-geometry overlays. Display settings persist (view-settings.ts);
 * the duration is an ordinary plan edit.
 */
import { el, section, setText, setValue } from './dom';
import { missionById } from './missions';
import { BODIES } from './physics';
import type { AppState, Store } from './store';
import type { Editor } from './editor';
import { DAY } from './time';
import { setDistanceMode } from './units';
import { onTimeMode, setTimeMode, timeMode } from './timefmt';
import { saveViewSettings, type DrawSpan, type ViewSettings } from './view-settings';

export class ViewOptions {
  readonly root: HTMLElement;
  private readonly durText = el('span', { className: 'dur-text' });
  private readonly durNote = el('div', { className: 'hint dur-note' });
  private readonly daysRow: HTMLElement;
  private readonly nodeSummary = el('div', { className: 'hint node-summary' });

  constructor(
    private readonly store: Store<AppState>,
    private readonly editor: Editor,
    readonly settings: ViewSettings,
    private readonly changed: () => void,
  ) {
    const s = settings;
    const commit = () => {
      saveViewSettings(s);
      this.sync();
      changed();
    };
    // Drawn span.
    const span = el('select', { className: 'span-sel', title: 'How much of the flight after the last burn is drawn (display only; the whole flight is still replayed and scored)' });
    for (const [v, t] of [['auto', 'Auto (escape: all; orbit: 3 revs + faint rest)'], ['rev1', '1 revolution'], ['rev3', '3 revolutions'], ['time', 'A chosen time'], ['all', 'Everything']] as const) span.append(el('option', { value: v, textContent: t }));
    span.value = s.span;
    this.spanSel = span;
    span.onchange = () => {
      s.span = span.value as DrawSpan;
      commit();
    };
    const days = el('input', { type: 'text', inputMode: 'decimal', className: 'num', title: 'Days drawn after the last burn', value: String(s.spanDays) });
    days.onchange = () => {
      const v = Number(days.value);
      if (Number.isFinite(v) && v > 0) {
        s.spanDays = v;
        commit();
      }
    };
    this.daysRow = el('label', { className: 'frow' }, el('span', { textContent: 'Days' }), days);
    const bright = el('input', { type: 'checkbox', id: 'show-all-revs' });
    bright.checked = s.brightAll;
    bright.onchange = () => {
      s.brightAll = bright.checked;
      commit();
    };
    // Flight length.
    const b = (t: string, title: string, f: () => void) => {
      const x = el('button', { className: 'btn small', type: 'button', textContent: t, title });
      x.setAttribute('aria-label', title);
      x.onclick = f;
      return x;
    };
    const setDur = (d: number) => {
      const max = this.maxDuration();
      const v = Math.max(3600, Math.min(max ?? Infinity, d));
      if (Number.isFinite(v)) editor.setDuration(Math.round(v));
    };
    const dur = () => store.get().plan.duration;
    const durRow = el('div', { className: 'dur-row' },
      b('÷2', 'Halve the flight length', () => setDur(dur() / 2)),
      b('−1 d', 'Flight length −1 day', () => setDur(dur() - DAY)),
      this.durText,
      b('+1 d', 'Flight length +1 day', () => setDur(dur() + DAY)),
      b('×2', 'Double the flight length', () => setDur(dur() * 2)),
      b('Max', 'Flight length: the mission maximum', () => { const m = this.maxDuration(); if (m) setDur(m); }));
    // Nodes.
    const nodes = el('input', { type: 'checkbox', id: 'show-plane-nodes' });
    nodes.checked = s.showNodes;
    nodes.onchange = () => {
      s.showNodes = nodes.checked;
      commit();
    };
    const plane = el('select', { className: 'plane-sel', title: 'Reference plane of the ascending and descending node markers and of the Orbit panel (inclination, node)' });
    plane.append(el('option', { value: 'equator', textContent: 'Equator of the reference body' }), el('option', { value: 'ecliptic', textContent: 'Ecliptic' }));
    for (const bd of BODIES) if (bd.id !== 'sun') plane.append(el('option', { value: bd.id, textContent: `Orbital plane of ${bd.name}` }));
    plane.value = s.nodePlane;
    plane.onchange = () => {
      s.nodePlane = plane.value;
      commit();
    };
    // Overlays.
    const ob = el('select', { className: 'overlay-body', title: 'Body whose axis and equator are drawn' });
    ob.append(el('option', { value: '', textContent: 'Focused body' }));
    for (const bd of BODIES) ob.append(el('option', { value: bd.id, textContent: bd.name }));
    ob.value = s.overlayBody;
    ob.onchange = () => {
      s.overlayBody = ob.value;
      commit();
    };
    const chk = (id: string, key: 'showAxis' | 'showEquator' | 'showTargetPlane', text: string) => {
      const c = el('input', { type: 'checkbox', id });
      c.checked = s[key];
      c.onchange = () => {
        s[key] = c.checked;
        commit();
      };
      return el('label', { className: 'check' }, c, ` ${text}`);
    };
    const radius = el('input', { type: 'range', min: '1.05', max: '15', step: '0.05', className: 'disc-radius', title: 'Equator disc radius, body radii' });
    radius.value = String(s.discRadius || 8);
    const radiusText = el('span', { className: 'hint' });
    radius.oninput = () => {
      s.discRadius = Number(radius.value);
      commit();
    };
    const opacity = el('input', { type: 'range', min: '0.05', max: '0.8', step: '0.05', className: 'disc-opacity', title: 'Disc opacity' });
    opacity.value = String(s.discOpacity);
    opacity.oninput = () => {
      s.discOpacity = Number(opacity.value);
      commit();
    };
    this.radiusText = radiusText;
    this.radiusInput = radius;
    const dist = el('select', { className: 'dist-sel', title: 'How distances to bodies are shown everywhere (objectives, markers, events, readouts)' });
    dist.append(el('option', { value: 'alt', textContent: 'Altitude above the surface' }), el('option', { value: 'radius', textContent: 'Radius from the centre' }));
    dist.value = s.distances;
    dist.onchange = () => {
      s.distances = dist.value === 'radius' ? 'radius' : 'alt';
      saveViewSettings(s);
      setDistanceMode(s.distances);
    };
    const tm = el('select', { className: 'time-sel', title: 'How points in time are shown everywhere (timeline, nodes, events, markers, readouts); durations stay durations' });
    tm.append(el('option', { value: 'met', textContent: 'Mission elapsed time (T+)' }), el('option', { value: 'utc', textContent: 'Absolute, UTC' }), el('option', { value: 'tdb', textContent: 'Absolute, TDB (simulation time)' }));
    tm.value = s.timeMode;
    tm.onchange = () => {
      s.timeMode = tm.value as ViewSettings['timeMode'];
      saveViewSettings(s);
      setTimeMode(s.timeMode);
    };
    onTimeMode(() => {
      if (tm.value !== timeMode()) { tm.value = timeMode(); s.timeMode = timeMode(); saveViewSettings(s); }
    });
    this.root = section('Trajectory & overlays', 'traj-view',
      el('label', { className: 'frow' }, el('span', { textContent: 'Distances' }), dist),
      el('label', { className: 'frow' }, el('span', { textContent: 'Times' }), tm),
      el('div', { className: 'sub', textContent: 'Drawn after the last burn' }),
      span, this.daysRow, this.spanNote,
      el('label', { className: 'check' }, bright, ' Bright: every revolution drawn (else only the one at the cursor)'),
      el('div', { className: 'sub', textContent: 'Flight length (replayed and scored)' }),
      durRow, this.durNote,
      el('div', { className: 'sub', textContent: 'Ascending / descending nodes' }),
      el('label', { className: 'check' }, nodes, ' Mark AN / DN'), plane, this.nodeSummary,
      el('div', { className: 'sub', textContent: 'Reference geometry' }),
      el('label', { className: 'frow' }, el('span', { textContent: 'Body' }), ob),
      chk('show-axis', 'showAxis', 'Rotation axis (red north, blue south)'),
      chk('show-equator', 'showEquator', 'Equatorial plane'),
      chk('show-target-plane', 'showTargetPlane', 'Node plane disc (when it is an orbital plane)'),
      el('label', { className: 'frow' }, el('span', { textContent: 'Radius' }), radius), radiusText,
      el('label', { className: 'frow' }, el('span', { textContent: 'Opacity' }), opacity));
    store.subscribe((st, p) => {
      if (st.plan !== p.plan || st.missionId !== p.missionId || st.replay !== p.replay) this.sync();
    });
    this.sync();
  }

  private readonly radiusText: HTMLElement;
  private readonly radiusInput: HTMLInputElement;

  /** Disc radius in body radii and its km readout (the caller knows the body). */
  showRadius(radii: number, km: number): void {
    setValue(this.radiusInput, String(radii));
    setText(this.radiusText, `${radii.toFixed(2)} radii · ${Math.round(km).toLocaleString('en-US')} km from the centre`);
  }

  private spanSel!: HTMLSelectElement;
  private readonly spanNote = el('div', { className: 'hint span-note' });

  /**
   * Tell the span control whether the flight ends on a closed orbit (period in s, NaN if not).
   * Revolutions of a closed orbit retrace one ellipse, so 1 and 3 revolutions look the same: the
   * 3-revolution choice is then marked as such and a note says what does differ.
   */
  setOrbitContext(period: number): void {
    const closed = Number.isFinite(period) && period > 0;
    const rev3 = this.spanSel.querySelector('option[value="rev3"]') as HTMLOptionElement;
    const rev1 = this.spanSel.querySelector('option[value="rev1"]') as HTMLOptionElement;
    setText(rev1, closed ? '1 revolution (one ellipse)' : '1 revolution');
    setText(rev3, closed ? '3 revolutions (same ellipse retraced)' : '3 revolutions');
    const p = period >= 86400 ? `${(period / 86400).toFixed(2)} d` : `${(period / 3600).toFixed(2)} h`;
    setText(this.spanNote, closed && ['auto', 'rev1', 'rev3'].includes(this.settings.span)
      ? `Closed orbit, period ${p}: every revolution retraces the same ellipse, so 1 and 3 revolutions look alike; perturbations show only over longer spans ("Everything").`
      : '');
  }

  setNodeSummary(text: string): void {
    setText(this.nodeSummary, text);
  }

  maxDuration(): number | null {
    const def = missionById(this.store.get().missionId)?.def;
    return def?.maxDuration ?? null;
  }

  private sync(): void {
    const st = this.store.get();
    this.daysRow.hidden = this.settings.span !== 'time';
    const max = this.maxDuration();
    setText(this.durText, `${(st.plan.duration / DAY).toFixed(2)} d${max ? ` / ${(max / DAY).toFixed(1)} max` : ''}`);
    setText(this.durNote, max ? 'Capped by the mission maximum. An objective that needs time in orbit needs the flight to run long enough.' : 'Sandbox: no limit (long flights take longer to replay).');
  }
}
