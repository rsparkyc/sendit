/**
 * The "Shortcuts and gestures" dialog. The keyboard part is generated from the
 * binding table (shortcuts.ts) that also drives the key handling. A fixed
 * header with the Close button, a body that scrolls on its own, sized to fit
 * the viewport; key / action in two columns on wide screens, stacked on
 * narrow ones (CSS). Touch gestures come first on touch devices. Closes with
 * Escape, Close or a click on the backdrop; focus stays inside while open and
 * goes back to the button that opened it.
 */
import { el } from './dom';
import { BINDINGS, BINDING_NOTES, GROUP_TITLE, type BindingGroup } from './shortcuts';

type Rows = readonly [string, string][];

export const MOUSE: Rows = [
  ['Drag', 'Orbit the camera (tilt and turn)'],
  ['Wheel / trackpad pinch', 'Zoom'],
  ['Click the trajectory', 'Pick that point: the time cursor moves there and its time, altitude and speed show; then “Add node here” (or N / Enter). A click never adds a node by itself, and a click that ends a drag does nothing'],
  ['Click a marker', 'Says what it is; a node marker selects it, an AN / DN marker moves the time cursor there. A cluster (“+2”) fans out on the first click'],
  ['Double-click', 'Focus what is under the pointer: the spacecraft; a node or burn marker; an event or AN / DN marker; a launch site; a body (the one nearest the camera); else a point on the trajectory'],
  ['Hover a timeline mark', 'Says what it is and when; click it to move the time cursor there'],
  ['Drag a value’s ◂ ⠿ ▸ strip', 'Tune it by medium steps; ‹‹‹ ‹‹ ‹ and › ›› ››› either side step large / medium / small; 0 zeroes it, ± flips its sign'],
];

export const TOUCH: Rows = [
  ['One-finger drag', 'Orbit the camera'],
  ['Pinch', 'Zoom (on the timeline: zoom the timeline)'],
  ['Two-finger drag', 'Tilt and turn'],
  ['Tap the trajectory', 'Pick that point: the time cursor moves there; then “Add node here”'],
  ['Tap a marker', 'Says what it is; a node marker selects it; a cluster (“+2”) fans out first'],
  ['Double-tap', 'Focus what is under the finger (spacecraft, marker, body or trajectory point)'],
  ['Tap a timeline mark', 'Says what it is and moves the time cursor there'],
  ['Tap the time', 'Cycle the time display: MET → UTC → TDB (status bar or timeline)'],
];

/** Map marker legend. */
export const LEGEND: Rows = [
  ['◉ Burn 1 (orange, boxed)', 'A maneuver node you placed; ▶ / ■ mark where the burn starts and ends. The thick orange stretch of the path is the burn itself.'],
  ['✂ S2 → SC (teal)', 'A separation: the lower stage is dropped there with whatever propellant it holds, and the next stage fires the burns after it. On the timeline it is a teal scissors mark: drag it to move it, tap it to edit.'],
  ['S2 / SC chip on a burn', 'The stage that fires the burn: S1, S2… are the launch vehicle\'s stages, SC the spacecraft'],
  ['◆ Periapsis, Apoapsis (blue)', 'Event from the replay: lowest / highest point of the orbit'],
  ['◆ Closest to Moon (yellow)', 'Event: closest approach to a body you actually pass near (or a mission target)'],
  ['◆ IMPACT (red)', 'Event: the flight ends here'],
  ['▲ AN / ▼ DN (violet)', 'Ascending / descending node: where the orbit crosses the reference plane (cheapest place to change plane)'],
  ['■ Launch site (green)', 'Launch site on the surface; the selected one is ringed'],
  ['Faded marker, no name', 'Behind a planet as seen from the camera (not tappable); only the selected item and a failure keep their name'],
  ['Pale marker', 'Far in time from the time cursor; names near the cursor and the selected item win the space'],
  ['Name with a thin line', 'No room beside the marker (or it is over a planet): the name sits off to the side, the line points to the marker'],
  ['Burn 1 +2 (ringed dot)', 'Several markers at one spot: tap to fan them out, then tap the one you want'],
];

/** The panels, briefly (README "Flight-plan editor" says the same). */
export const PANELS: Rows = [
  ['Vehicle', 'The stack, stage by stage: masses, engines, thrust-to-weight, delta-v with everything above it. A mission\'s vehicle is read-only; in Sandbox it is an editor (presets, add / remove / reorder stages)'],
  ['Start → launch feedback', 'What the ascent costs (total Δv includes it), which stage reaches orbit and what the upper stage has left; two charts of that against parking altitude and azimuth: tap or drag one to set the value'],
  ['Separations', 'Flight actions like burns: “Separation at cursor”, or “separate after” a burn. Burns after a separation are fired by the next stage'],
  ['Orbit', 'The orbit at the time cursor about the dominant (or a pinned) body: osculating elements, i.e. the two-body orbit matching this instant, which drift in an N-body flight; the replay\'s real next apsis alongside. The status bar shows the same orbit'],
  ['Time display', 'Mission elapsed time (T+), UTC or TDB, in View or by tapping the time under the timeline / in the status bar; every point in time follows it. The transfer planner keeps calendar dates, with T+ alongside'],
];

const SEP = new Set(['or', '·', 'none']);

function caps(list: readonly string[]): HTMLElement {
  const d = el('span', { className: 'kcaps' });
  list.forEach((c, i) => {
    if (SEP.has(c)) d.append(el('span', { className: 'ksep', textContent: c }));
    else {
      if (i > 0 && !SEP.has(list[i - 1])) d.append(el('span', { className: 'ksep', textContent: '+' }));
      d.append(el('kbd', { textContent: c }));
    }
  });
  return d;
}

function rowsList(rows: { key: HTMLElement; desc: string; id?: string }[]): HTMLElement {
  const dl = el('dl', { className: 'krows' });
  for (const r of rows) {
    const row = el('div', { className: 'krow' }, el('dt', {}, r.key), el('dd', { textContent: r.desc }));
    if (r.id) row.dataset.action = r.id;
    dl.append(row);
  }
  return dl;
}

const textRows = (rows: Rows) => rowsList(rows.map(([k, v]) => ({ key: el('span', { className: 'kterm', textContent: k }), desc: v })));
const block = (title: string, cls: string, body: HTMLElement) => el('section', { className: `kblock ${cls}` }, el('h3', { textContent: title }), body);

/** The keyboard sections, one per group, from the binding table. */
export function keyboardSections(): HTMLElement[] {
  const groups: BindingGroup[] = ['time', 'map', 'edit'];
  return groups.map((g) => {
    const rows = BINDINGS.filter((b) => b.group === g).map((b) => {
      // "Delete / Backspace" style alternatives: separate caps with "or".
      const list = b.caps.length > 1 && b.caps.every((c) => !SEP.has(c) && c !== 'Shift' && !c.startsWith('Ctrl')) ? b.caps.flatMap((c, i) => (i ? ['or', c] : [c])) : b.caps;
      return { key: caps(list), desc: b.desc, id: b.id };
    });
    const notes = BINDING_NOTES.filter((x) => x.group === g).map((n) => ({ key: caps(n.caps), desc: n.desc }));
    return block(`Keys: ${GROUP_TITLE[g].toLowerCase()}`, `k-${g}`, rowsList([...rows, ...notes]));
  });
}

export class KeysDialog {
  readonly root = el('dialog', { className: 'keys' });
  private readonly body = el('div', { className: 'keys-body', tabIndex: 0 });
  private opener: HTMLElement | null = null;

  constructor(private readonly fallbackFocus: () => HTMLElement | null) {
    const title = el('h2', { id: 'keys-title', textContent: 'Shortcuts and gestures' });
    const close = el('button', { className: 'btn keys-close', type: 'button', textContent: 'Close' });
    close.onclick = () => this.root.close();
    this.root.setAttribute('aria-labelledby', 'keys-title');
    this.body.setAttribute('aria-label', 'Shortcuts and gestures list');
    this.root.append(el('header', { className: 'keys-head' }, title, close), this.body);
    // Backdrop click: the dialog box itself is the target only outside its content (the ::backdrop area).
    this.root.addEventListener('click', (e) => {
      if (e.target !== this.root) return;
      const r = this.root.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) this.root.close();
    });
    // Focus trap: Tab wraps within the dialog.
    this.root.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...this.root.querySelectorAll<HTMLElement>('button, [tabindex="0"], a[href]')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    this.root.addEventListener('close', () => {
      const back = this.opener && this.opener.isConnected && this.opener.offsetParent !== null ? this.opener : this.fallbackFocus();
      this.opener = null;
      back?.focus();
    });
  }

  private build(): void {
    const touch = document.documentElement.classList.contains('touch');
    const gestures = [block('Touch', 'k-touch', textRows(TOUCH)), block('Mouse', 'k-mouse', textRows(MOUSE))];
    if (!touch) gestures.reverse();
    const keyboard = keyboardSections();
    const ordered = touch ? [...gestures, ...keyboard] : [...keyboard, ...gestures];
    this.body.replaceChildren(...ordered, block('Panels', 'k-panels', textRows(PANELS)), block('Map markers', 'k-legend', textRows(LEGEND)));
  }

  show(opener?: HTMLElement | null): void {
    if (this.root.open) return;
    const a = document.activeElement as HTMLElement | null;
    this.opener = opener ?? (a && a !== document.body ? a : null);
    this.build();
    this.root.showModal();
    this.body.scrollTop = 0;
    (this.root.querySelector('.keys-close') as HTMLElement).focus();
  }
}
