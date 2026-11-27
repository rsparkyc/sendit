/**
 * Map legend: a disclosure ("Legend") next to the timeline that lists what the
 * map draws, each entry with the shape and colour the map uses (palette.ts),
 * including one burn swatch per stage of the current plan with its tag. Closed
 * by default; open state remembered.
 */
import { el } from './dom';
import { MAP, stageStyle } from './palette';
import type { AppState, Store } from './store';
import { stageRows } from './vehicle';

const KEY = 'sendit.legend.v1';

export class MapLegend {
  readonly root = el('details', { className: 'map-legend' });
  private readonly list = el('ul', { className: 'lg-list' });
  private key = '';

  constructor(private readonly store: Store<AppState>) {
    const sum = el('summary', { textContent: 'Legend' });
    sum.title = 'What the colours and shapes on the map mean';
    this.root.append(sum, this.list);
    try { this.root.open = localStorage.getItem(KEY) === 'open'; } catch { /* default closed */ }
    this.root.addEventListener('toggle', () => { try { localStorage.setItem(KEY, this.root.open ? 'open' : ''); } catch { /* not kept */ } });
    store.subscribe((s, p) => { if (s.plan !== p.plan) this.render(); });
    this.render();
  }

  private render(): void {
    const rows = stageRows(this.store.get().plan);
    const k = rows.map((r) => r.tag + r.name).join('|');
    if (k === this.key) return;
    this.key = k;
    const item = (sw: HTMLElement, text: string) => el('li', {}, sw, el('span', { textContent: text }));
    const line = (cls: string, colour: string, text: string, tag = '') => {
      const sw = el('span', { className: `lg-sw ${cls}`, textContent: tag });
      sw.style.setProperty('--c', colour);
      return item(sw, text);
    };
    const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
    const items: HTMLElement[] = [
      line('lg-line', hex(MAP.coast), 'Trajectory ahead of the cursor'),
      line('lg-line', hex(MAP.coastPast), 'Trajectory flown (behind the cursor)'),
      ...rows.slice().reverse().filter((r) => rows.length > 1 || r.isSpacecraft).map((r) => {
        const ss = stageStyle(r.index, r.isSpacecraft, r.tag);
        return line('lg-burn', ss.colour, `Burn flown by ${r.name}${rows.length > 1 ? '' : ''}`, rows.length > 1 ? ss.tag : '');
      }),
      line('lg-dot lg-node', stageStyle(0, true).colour, 'Maneuver node (boxed label, stage tag), ▶ ignition, ■ cutoff'),
      line('lg-glyph', MAP.separation, 'Separation (stage dropped → next stage)', '✂'),
      line('lg-diamond', MAP.event, 'Event (periapsis, SOI change…)'),
      line('lg-diamond', MAP.closest, 'Closest approach to a target'),
      line('lg-diamond lg-bold', MAP.failure, 'Failure (impact, atmosphere)'),
      line('lg-tri', MAP.planeNode, 'AN ▲ / DN ▼ plane crossing'),
      line('lg-square', MAP.site, 'Launch site (selected: ringed)'),
      line('lg-line lg-faint', '#9fc6ff', 'Body orbits: thin, in the body’s colour'),
    ];
    this.list.replaceChildren(...items);
  }
}
