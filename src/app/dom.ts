/**
 * Plain-DOM helpers shared by the panels. The UI stays framework-free: each
 * panel builds its elements once and updates them in place from the store,
 * never rebuilding an input that has focus (so typing and dragging are never
 * interrupted). With a single store and a handful of panels that is simpler
 * than adopting a UI library, and keeps the bundle to three.js plus our code.
 */
import { deriveMeta } from './body-meta';
import { BODIES } from './physics';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(e, rest);
  if (dataset) for (const [k, v] of Object.entries(dataset)) e.dataset[k] = v;
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Set an input's value unless the user is editing it. */
export function setValue(input: HTMLInputElement | HTMLSelectElement, v: string): void {
  if (document.activeElement === input) return;
  if (input.value !== v) input.value = v;
}

export function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

const meta = deriveMeta(BODIES);

/**
 * Parent planet of each body for grouping: the data's `parent` field, else the
 * derived parent when that is not the root (the Moon has no `parent` in the
 * data; it is grouped under the Earth by its Hill sphere).
 */
export function groupParent(i: number): number {
  const b = BODIES[i];
  if (b.parentId) return BODIES.findIndex((x) => x.id === b.parentId);
  const p = meta[i].parent;
  return p >= 0 && meta[p].parent >= 0 ? p : -1;
}

/**
 * Fill a select with every body, moons grouped under their planet
 * (optgroup labelled with the planet, planet first). Values are body indices
 * unless `value` maps them (e.g. to ids).
 */
export function fillBodySelect(sel: HTMLSelectElement, value: (i: number) => string = String, extra: { value: string; label: string }[] = []): void {
  sel.replaceChildren();
  for (const x of extra) sel.append(el('option', { value: x.value, textContent: x.label }));
  const moons = new Map<number, number[]>();
  BODIES.forEach((_, i) => {
    const p = groupParent(i);
    if (p >= 0) moons.set(p, [...(moons.get(p) ?? []), i]);
  });
  BODIES.forEach((b, i) => {
    if (groupParent(i) >= 0) return;
    const ms = moons.get(i);
    if (!ms) {
      sel.append(el('option', { value: value(i), textContent: b.name }));
      return;
    }
    const g = el('optgroup', { label: `${b.name} system` });
    g.append(el('option', { value: value(i), textContent: b.name }));
    for (const m of ms) g.append(el('option', { value: value(m), textContent: `  ${BODIES[m].name}` }));
    sel.append(g);
  });
}

/** Mission elapsed time, e.g. "T+2d 03:14:05.2" (s may be negative). */
export function formatMet(s: number, decimals = 1): string {
  if (!Number.isFinite(s)) return '—';
  const sign = s < 0 ? '−' : '+';
  const q = 10 ** decimals;
  let a = Math.round(Math.abs(s) * q) / q; // round first so 59.96 s shows as 01:00.0, not 00:60.0
  const d = Math.floor(a / 86400);
  a -= d * 86400;
  const h = Math.floor(a / 3600);
  a -= h * 3600;
  const m = Math.floor(a / 60);
  a -= m * 60;
  const sec = a.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return `T${sign}${d ? `${d}d ` : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
}

/**
 * Parse a duration typed by the player: "3600", "1h 30m", "2d 4h", "01:30:00",
 * "T+1d 02:00:00", with optional sign. Returns seconds or null.
 */
export function parseDuration(text: string): number | null {
  let s = text.trim().replace(/^T/i, '').replace(/−/g, '-');
  let sign = 1;
  if (s.startsWith('-')) { sign = -1; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  s = s.trim();
  if (s === '') return null;
  if (/^\d+(\.\d+)?$/.test(s)) return sign * Number(s);
  let total = 0;
  let rest = s;
  const dm = /^(\d+(?:\.\d+)?)\s*d\s*/i.exec(rest);
  if (dm) { total += Number(dm[1]) * 86400; rest = rest.slice(dm[0].length); }
  const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.exec(rest);
  if (clock) return sign * (total + Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] ?? 0));
  const unitRe = /(\d+(?:\.\d+)?)\s*(d|h|m|s)\s*/iy;
  let pos = 0;
  while (pos < rest.length) {
    unitRe.lastIndex = pos;
    const m = unitRe.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2].toLowerCase() as 'd' | 'h' | 'm' | 's'];
    pos = unitRe.lastIndex;
  }
  return sign * total;
}

/** A collapsible panel section: a heading button (aria-expanded) and a body. */
export function section(title: string, cls: string, ...children: (Node | string | null)[]): HTMLElement {
  const head = el('button', { className: 'sec-title', textContent: title, type: 'button' });
  head.setAttribute('aria-expanded', 'true');
  const body = el('div', { className: 'sec-body' }, ...children);
  const s = el('section', { className: `panel ed ${cls}` }, el('h2', { className: 'sec-h' }, head), body);
  s.setAttribute('aria-label', title);
  head.onclick = () => {
    s.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!s.classList.contains('collapsed')));
  };
  return s;
}

/** One-line summary of a section, shown after its title while it is collapsed (style.css). */
export function setSummary(panel: HTMLElement, text: string): void {
  const head = panel.querySelector(':scope > .sec-h > .sec-title') as HTMLElement | null;
  if (head && head.dataset.summary !== text) head.dataset.summary = text;
}
