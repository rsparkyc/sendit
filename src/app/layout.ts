/**
 * The app shell: where each panel lives at each screen size. One instance of
 * every panel; the layout only moves it between containers.
 *
 * Three modes, from the viewport (re-evaluated on resize and orientation change):
 *
 *  - 'wide'  (>= 1200 x 600, desktop): one docked column on the right, wide
 *    enough that values do not wrap (27 % of the window, 360-460 px, resizable),
 *    with the same tabs as the other modes at its top, here as section links
 *    over one scrolling column. Tabs and column follow one list, TABS (so the
 *    two orders cannot drift): Nodes (list and the selected node's editor)
 *    first, then Mission, Start and Vehicle (set once; each collapses by its
 *    header to a one-line summary, remembered), Events, Results, Orbit, View;
 *    within a tab, panels keep the order main.ts adds them in. The tab of the section at the
 *    top of the column is highlighted as it scrolls. The orbit at the cursor is
 *    also a one-line strip above the timeline, next to the map. The dock
 *    collapses to a rail of tab buttons. Selecting a node scrolls to Nodes.
 *  - 'side'  (landscape >= 900 wide, or any landscape phone): one tabbed
 *    column on the right (collapsible to a rail of tab buttons); the map keeps
 *    the rest.
 *  - 'sheet' (portrait phones and tablets): the map is full-screen; panels
 *    live in a bottom sheet with tabs and three heights (peek: tabs only,
 *    half, full), dragged by its grip or set by tapping a tab.
 *
 * Floating windows (desktop and landscape tablets, not phones: floatAllowed):
 * the first panel of each tab has an undock button that moves the tab's
 * panels (the same nodes) into a window over the map (float-window.ts); its
 * tab stays in the strip, marked floating, and brings the window to front.
 * Which tabs float, and each window's place, size, collapse and opacity, are
 * remembered per mode; phones dock everything without forgetting them.
 *
 * In every mode a compact status bar (time, play / warp, outcome, the one
 * number that matters now) and the timeline stay visible. The 3D view always
 * covers the whole window; `freeRect` is the part no panel covers, and the
 * camera centres its focus there (so a dock or the sheet never hides it).
 */
import { el } from './dom';
import { DEFAULT_OPACITY, defaultRect, emptyFloats, floatAllowed, parseFloats, type FloatModes } from './float-geom';
import { FloatWindow } from './float-window';

export type TabId = 'nodes' | 'mission' | 'start' | 'vehicle' | 'events' | 'results' | 'orbit' | 'view';
export type Mode = 'wide' | 'side' | 'sheet';
export type SheetState = 'peek' | 'half' | 'full';
export type Dock = 'left' | 'right' | 'bottom';

/**
 * The one order of the panels: the tab strip in every mode and, in wide mode,
 * the scrolling column (orderEntries). What is touched while tuning a burn
 * first, what is set once next, then the rest.
 */
export const TABS: readonly { id: TabId; label: string; icon: string }[] = [
  { id: 'nodes', label: 'Nodes', icon: '△' },
  { id: 'mission', label: 'Mission', icon: '◎' },
  { id: 'start', label: 'Start', icon: '⇡' },
  { id: 'vehicle', label: 'Vehicle', icon: '▥' },
  { id: 'events', label: 'Events', icon: '☰' },
  { id: 'results', label: 'Results', icon: '★' },
  { id: 'orbit', label: 'Orbit', icon: '◯' },
  { id: 'view', label: 'View', icon: '◐' },
];
const TAB_IDS = TABS.map((t) => t.id);

/** Panels in display order: by their tab's place in TABS, then in the order they were added (pure). */
export function orderEntries<T extends { tab: TabId; order: number }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => TAB_IDS.indexOf(a.tab) - TAB_IDS.indexOf(b.tab) || a.order - b.order);
}

/** Mode for a viewport (pure; exported for tests). */
export function modeFor(w: number, h: number): Mode {
  if (w >= 1200 && h >= 600) return 'wide';
  if (w > h && (w >= 900 || h < 520)) return 'side';
  return 'sheet';
}

interface Entry {
  el: HTMLElement;
  tab: TabId;
  dock: Dock;
  order: number;
}

export interface FreeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const STORE_KEY = 'sendit.layout.v1';
export const DOCK_MIN = 220;
export const DOCK_MAX = 520;
const clampWidth = (w: number) => Math.round(Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.min(w, (typeof window !== 'undefined' ? window.innerWidth : 2000) * 0.4))));

export class Layout {
  readonly topbar = el('header', { className: 'topbar' });
  private readonly left = el('aside', { className: 'dock left', ariaLabel: 'Mission panels' });
  private readonly right = el('aside', { className: 'dock right', ariaLabel: 'Plan panels' });
  private readonly leftBody = el('div', { className: 'dock-body' });
  private readonly rightBody = el('div', { className: 'dock-body' });
  readonly bottom = el('div', { className: 'bottom' });
  private readonly bottomExtra = el('div', { className: 'bottom-extra' });
  private readonly sheet = el('section', { className: 'sheet', ariaLabel: 'Panels' });
  private readonly grip = el('button', { className: 'sheet-grip', type: 'button', ariaLabel: 'Resize panel' }, el('span'));
  private readonly tabBar = el('div', { className: 'tabs', role: 'tablist' });
  private readonly tabRow = el('div', { className: 'tabrow' });
  private readonly sheetBody = el('div', { className: 'sheet-body' });
  private readonly tabButtons = new Map<TabId, HTMLButtonElement>();
  /** Floating windows sit here (one stacking context above the docks). */
  private readonly floatLayer = el('div', { className: 'floats' });
  private readonly windows = new Map<string, FloatWindow>();
  private floats: FloatModes = emptyFloats();
  private zTop = 0;
  private floatShown: 'wide' | 'side' | null = null;
  private readonly entries: Entry[] = [];
  private readonly listeners = new Set<() => void>();
  mode: Mode = 'wide';
  tab: TabId = 'mission';
  sheetState: SheetState = 'peek';
  private collapsed = { left: false, right: false, side: false };
  /** A tab press is scrolling the wide column: the scroll spy waits. */
  private scrolling = false;
  /** Dock widths set by dragging their inner edge (px; null: the default for the window size). */
  private widths: { left: number | null; right: number | null } = { left: null, right: null };
  /** Collapsed panels, by their section class. */
  private panelCollapsed = new Set<string>();
  /** Sheet height dragged between the snap points, px (null: the state's own height). */
  private sheetPx: number | null = null;

  constructor(private readonly root: HTMLElement) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
      if (saved && typeof saved === 'object') {
        if (TABS.some((t) => t.id === saved.tab)) this.tab = saved.tab;
        this.collapsed = { ...this.collapsed, ...(saved.collapsed ?? {}) };
        for (const k of ['left', 'right'] as const) if (typeof saved.widths?.[k] === 'number') this.widths[k] = clampWidth(saved.widths[k]);
        if (Array.isArray(saved.panels)) this.panelCollapsed = new Set(saved.panels.filter((x: unknown) => typeof x === 'string'));
        this.floats = parseFloats(saved.floats, TAB_IDS);
        for (const m of Object.values(this.floats)) for (const f of Object.values(m)) this.zTop = Math.max(this.zTop, f.z);
      }
      else if (window.innerHeight < 520 && window.innerWidth > window.innerHeight) this.collapsed.side = true; // landscape phone: map first
    } catch {
      /* storage unavailable: defaults */
    }
    const dockToggle = (side: 'left' | 'right') => {
      const b = el('button', { className: 'btn dock-toggle', type: 'button' });
      b.onclick = () => {
        this.collapsed[side] = !this.collapsed[side];
        this.persist();
        this.apply();
      };
      return b;
    };
    this.left.append(dockToggle('left'), this.leftBody, this.resizeHandle('left'));
    this.right.append(dockToggle('right'), this.rightBody, this.resizeHandle('right'));
    for (const t of TABS) {
      const b = el('button', { className: 'tab', type: 'button', role: 'tab', id: `tab-${t.id}` },
        el('span', { className: 'tab-icon', ariaHidden: 'true', textContent: t.icon }),
        el('span', { className: 'tab-label', textContent: t.label }),
        el('span', { className: 'tab-float', ariaHidden: 'true', textContent: '⧉' }));
      b.setAttribute('aria-controls', 'sheet-body');
      b.onclick = () => this.pressTab(t.id);
      b.ondblclick = () => { if (this.isFloating(t.id)) this.dock(t.id); };
      b.onkeydown = (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const i = TABS.findIndex((x) => x.id === this.tab);
        const n = TABS[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : TABS.length - 1)) % TABS.length];
        this.showTab(n.id);
        this.tabButtons.get(n.id)?.focus();
      };
      this.tabButtons.set(t.id, b);
      this.tabBar.append(b);
    }
    const sideToggle = el('button', { className: 'btn side-toggle', type: 'button' });
    sideToggle.onclick = () => {
      const k = this.mode === 'wide' ? 'right' : 'side';
      this.collapsed[k] = !this.collapsed[k];
      this.persist();
      this.apply();
    };
    this.sheetBody.id = 'sheet-body';
    this.sheetBody.setAttribute('role', 'tabpanel');
    this.tabRow.append(this.tabBar, sideToggle);
    this.sheet.append(this.grip, this.tabRow, this.sheetBody);
    this.bottom.append(this.bottomExtra);
    // Wide: the tab of the section at the top of the scrolled column is highlighted.
    this.rightBody.addEventListener('scroll', () => {
      if (this.mode !== 'wide' || this.scrolling) return;
      const top = this.rightBody.getBoundingClientRect().top + 8;
      let cur: Entry | null = null;
      for (const e of orderEntries(this.entries)) {
        if (e.el.parentElement !== this.rightBody) continue;
        if (e.el.getBoundingClientRect().top <= top) cur = e;
      }
      const t = cur?.tab ?? 'nodes';
      if (t !== this.tab) { this.tab = t; this.apply(); }
    }, { passive: true });
    root.append(this.topbar, this.left, this.right, this.bottom, this.sheet, this.floatLayer);
    this.wireGrip();

    const onResize = () => this.update();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    new ResizeObserver(() => this.emit()).observe(this.sheet);
    new ResizeObserver(() => this.emit()).observe(this.topbar);
    new ResizeObserver(() => this.emit()).observe(this.bottom);
    this.update();
  }

  /** Register a panel: its tab (sheet / side modes) and dock (wide mode), in order. */
  add(panel: HTMLElement, tab: TabId, dock: Dock, order = this.entries.length): void {
    this.entries.push({ el: panel, tab, dock, order });
    // Panel collapse by its header, remembered across reloads (sections from dom.ts).
    const key = this.panelKey(panel);
    const head = panel.querySelector(':scope > .sec-h > .sec-title') as HTMLElement | null;
    if (key && head) {
      if (this.panelCollapsed.has(key)) {
        panel.classList.add('collapsed');
        head.setAttribute('aria-expanded', 'false');
      }
      head.addEventListener('click', () => {
        if (panel.classList.contains('collapsed')) this.panelCollapsed.add(key);
        else this.panelCollapsed.delete(key);
        this.persist();
        this.emit();
      });
    }
    // Undock: shown on the first panel of each tab (place()); it floats the whole tab.
    if (head) {
      const label = TABS.find((t) => t.id === tab)!.label;
      const u = el('button', { className: 'btn small undock', type: 'button', textContent: '⧉', title: `Pop out ${label} into a floating window` });
      u.setAttribute('aria-label', `Pop out ${label} into a floating window`);
      u.onclick = () => this.undock(tab);
      head.parentElement!.append(u);
    }
    this.entries.sort((a, b) => a.order - b.order);
    this.place();
  }

  /** Called when the free area of the map changes. */
  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** Bring a tab forward (sheet / side modes; in wide mode, scroll its first panel into view; floating: its window to front). */
  showTab(tab: TabId, open = true): void {
    const w = this.windowOf(tab);
    if (w) {
      this.front(tab);
      if (open && w.state.collapsed) {
        w.state.collapsed = false;
        w.render();
        w.clamp();
        this.persist();
      }
      w.flash();
      return;
    }
    this.tab = tab;
    if (this.mode === 'sheet' && open && this.sheetState === 'peek') this.sheetState = 'half';
    if (this.mode === 'side' && open) this.collapsed.side = false;
    if (this.mode === 'wide') {
      const e = this.entries.find((x) => x.tab === tab && x.dock !== 'bottom');
      if (e) {
        e.el.classList.remove('collapsed');
        const side = e.dock === 'left' ? 'left' : e.dock === 'right' ? 'right' : null;
        if (side && this.collapsed[side]) {
          this.collapsed[side] = false;
          this.persist();
        }
        this.scrolling = true;
        requestAnimationFrame(() => {
          // Bring the section to the top of the column (not the page).
          const b = this.rightBody;
          b.scrollTop += e.el.getBoundingClientRect().top - b.getBoundingClientRect().top;
          setTimeout(() => { this.scrolling = false; }, 120);
        });
      }
    }
    this.persist();
    this.apply();
  }

  setSheet(state: SheetState): void {
    this.sheetState = state;
    this.sheetPx = null;
    this.apply();
  }

  private pressTab(tab: TabId): void {
    if (this.isFloating(tab)) {
      this.showTab(tab);
      return;
    }
    if (this.mode === 'sheet' && tab === this.tab && this.sheetState !== 'peek') {
      this.setSheet('peek');
      return;
    }
    if (this.mode === 'side' && tab === this.tab && !this.collapsed.side) {
      this.collapsed.side = true;
      this.persist();
      this.apply();
      return;
    }
    this.showTab(tab);
  }

  private persist(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ tab: this.tab, collapsed: this.collapsed, widths: this.widths, panels: [...this.panelCollapsed], floats: this.floats }));
    } catch {
      /* not persistent */
    }
  }

  private update(): void {
    const m = modeFor(window.innerWidth, window.innerHeight);
    if (m !== this.mode || !this.root.dataset.mode) {
      this.mode = m;
      this.place();
    } else if (this.floatMode() !== this.floatShown) this.place();
    for (const w of this.windows.values()) w.clamp();
    this.apply();
  }

  /** The mode whose floating windows are shown, or null (phones: everything docked). */
  private floatMode(): 'wide' | 'side' | null {
    const m = this.mode;
    return floatAllowed(m, window.innerWidth, window.innerHeight) ? m : null;
  }

  /** Is this tab in a floating window now? */
  isFloating(tab: TabId): boolean {
    return this.windowOf(tab) !== null;
  }

  private windowOf(tab: TabId): FloatWindow | null {
    const fm = this.floatMode();
    return fm ? this.windows.get(`${fm}:${tab}`) ?? null : null;
  }

  /** Move a tab's panels into a floating window over the map. */
  undock(tab: TabId): void {
    const fm = this.floatMode();
    if (!fm || this.floats[fm][tab]) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const f = this.freeRect();
    const k = Object.keys(this.floats[fm]).length;
    this.floats[fm][tab] = { ...defaultRect(tab, k, { left: f.left, top: f.top, right: W - f.right, bottom: H - f.bottom }), collapsed: false, opacity: DEFAULT_OPACITY, z: ++this.zTop };
    this.place();
    this.persist();
    this.apply();
    const w = this.windowOf(tab);
    if (w) {
      w.clamp();
      w.root.focus({ preventScroll: true });
      w.flash();
    }
  }

  /** Put a floating tab back in the dock (and show it there). */
  dock(tab: TabId): void {
    const fm = this.floatMode();
    if (!fm || !this.floats[fm][tab]) return;
    delete this.floats[fm][tab];
    this.place();
    this.showTab(tab);
    this.tabButtons.get(tab)?.focus({ preventScroll: true });
  }

  private front(tab: TabId): void {
    const w = this.windowOf(tab);
    if (!w || w.state.z === this.zTop) return;
    w.state.z = ++this.zTop;
    w.render();
    this.persist();
  }

  /** Create / remove windows to match the floating tabs of the current mode. */
  private syncWindows(): void {
    const fm = this.floatMode();
    this.floatShown = fm;
    const want = new Set(fm ? Object.keys(this.floats[fm]).map((t) => `${fm}:${t}`) : []);
    for (const [k, w] of this.windows) {
      if (!want.has(k)) {
        w.root.remove();
        this.windows.delete(k);
      }
    }
    if (!fm) return;
    for (const [tab, st] of Object.entries(this.floats[fm])) {
      const k = `${fm}:${tab}`;
      if (this.windows.has(k)) continue;
      const id = tab as TabId;
      const w = new FloatWindow(tab, TABS.find((t) => t.id === tab)!.label, st, {
        changed: () => this.persist(),
        dock: () => this.dock(id),
        front: () => this.front(id),
        escape: () => this.tabButtons.get(id)?.focus(),
      });
      this.windows.set(k, w);
      this.floatLayer.append(w.root);
      w.clamp();
    }
  }

  /** Put each panel into the container of the current mode. */
  private place(): void {
    // One column in wide mode: the tab row heads the right dock (the left dock is not used).
    if (this.mode === 'wide') { if (this.tabRow.parentElement !== this.right || this.tabRow.nextElementSibling !== this.rightBody) this.right.insertBefore(this.tabRow, this.rightBody); }
    else if (this.tabRow.parentElement !== this.sheet) this.sheet.insertBefore(this.tabRow, this.sheetBody);
    this.syncWindows();
    const active = document.activeElement as HTMLElement | null;
    const seen = new Set<TabId>();
    for (const e of orderEntries(this.entries)) {
      const w = this.windowOf(e.tab);
      const target = w ? w.body : this.mode === 'wide' ? (e.dock === 'bottom' ? this.bottomExtra : this.rightBody) : this.sheetBody;
      if (e.el.parentElement !== target || target.lastElementChild !== e.el) target.append(e.el);
      const u = e.el.querySelector(':scope > .sec-h > .undock') as HTMLElement | null;
      if (u) u.hidden = seen.has(e.tab);
      seen.add(e.tab);
    }
    // Moving a node drops its focus: give it back (typing is never interrupted).
    if (active && active !== document.activeElement && active.isConnected && !active.closest('[hidden]')) active.focus({ preventScroll: true });
  }

  private apply(): void {
    const r = this.root;
    r.dataset.mode = this.mode;
    r.dataset.sheet = this.sheetState;
    r.dataset.leftCollapsed = String(this.collapsed.left);
    r.dataset.rightCollapsed = String(this.collapsed.right);
    r.dataset.sideCollapsed = String(this.collapsed.side);
    for (const k of ['left', 'right'] as const) {
      const w = this.widths[k];
      if (w === null) r.style.removeProperty(`--dock-${k[0]}`);
      else r.style.setProperty(`--dock-${k[0]}`, `${w}px`);
      const h = (k === 'left' ? this.left : this.right).querySelector('.dock-resize') as HTMLElement;
      h.setAttribute('aria-valuenow', String(Math.round(this.dockWidth(k))));
    }
    this.sheet.style.height = this.mode === 'sheet' && this.sheetPx !== null ? `${this.sheetPx}px` : '';
    r.dataset.sheetCustom = String(this.mode === 'sheet' && this.sheetPx !== null);
    document.documentElement.dataset.mode = this.mode;
    const tabbed = this.mode !== 'wide';
    // The column never shows a floating tab: pick the first docked one (none docked: the column is a rail).
    if (this.isFloating(this.tab)) this.tab = TAB_IDS.find((t) => !this.isFloating(t)) ?? this.tab;
    const allFloat = TAB_IDS.every((t) => this.isFloating(t));
    r.dataset.float = String(this.floatMode() !== null);
    r.dataset.allFloating = String(allFloat);
    if (allFloat) r.dataset[this.mode === 'wide' ? 'rightCollapsed' : 'sideCollapsed'] = 'true';
    for (const e of this.entries) e.el.hidden = tabbed && !this.isFloating(e.tab) && e.tab !== this.tab;
    for (const [id, b] of this.tabButtons) {
      const fl = this.isFloating(id);
      b.classList.toggle('floating', fl);
      b.title = fl ? 'Floating window: click to bring it to front, double-click to dock it back' : '';
      const on = !fl && id === this.tab && (this.mode === 'sheet' ? this.sheetState !== 'peek' : this.mode === 'side' ? !this.collapsed.side : !this.collapsed.right);
      b.setAttribute('aria-selected', String(id === this.tab));
      b.classList.toggle('active', on);
      b.tabIndex = id === this.tab ? 0 : -1;
    }
    this.sheetBody.setAttribute('aria-labelledby', `tab-${this.tab}`);
    for (const [side, d] of [['left', this.left], ['right', this.right]] as const) {
      const b = d.querySelector('.dock-toggle') as HTMLButtonElement;
      const c = this.collapsed[side];
      b.textContent = (side === 'left') !== c ? '‹' : '›';
      b.ariaLabel = `${c ? 'Show' : 'Hide'} the ${side} panels`;
      b.title = b.ariaLabel;
      b.setAttribute('aria-expanded', String(!c));
    }
    const st = this.tabRow.querySelector('.side-toggle') as HTMLButtonElement;
    const hid = (this.mode === 'wide' ? this.collapsed.right : this.collapsed.side) || allFloat;
    st.textContent = hid ? '‹' : '›';
    st.ariaLabel = hid ? 'Show panels' : 'Hide panels';
    st.setAttribute('aria-expanded', String(!hid));
    st.title = st.ariaLabel;
    this.grip.setAttribute('aria-expanded', String(this.sheetState !== 'peek'));
    this.grip.ariaLabel = `Panel height: ${this.sheetState}. Tap to change.`;
    this.emit();
  }

  private emit(): void {
    const h = this.mode === 'sheet' ? this.sheet.getBoundingClientRect().height : 0;
    this.root.style.setProperty('--sheet-h', `${Math.round(h)}px`);
    for (const l of this.listeners) l();
  }

  /** Map area no panel covers, in CSS px from the window edges. */
  freeRect(): FreeRect {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const vis = (e: HTMLElement) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const tb = this.topbar.getBoundingClientRect();
    const out: FreeRect = { left: 0, top: tb.bottom > 0 ? tb.bottom : 0, right: 0, bottom: 0 };
    const bt = this.bottom.getBoundingClientRect();
    if (vis(this.bottom) && bt.height > 0) out.bottom = Math.max(out.bottom, H - bt.top);
    if (this.mode === 'wide') {
      const l = this.left.getBoundingClientRect();
      const rr = this.right.getBoundingClientRect();
      out.left = Math.max(0, l.right);
      out.right = Math.max(0, W - rr.left);
    } else if (this.mode === 'side') {
      out.right = Math.max(0, W - this.sheet.getBoundingClientRect().left);
    } else {
      out.bottom = Math.max(out.bottom, H - this.sheet.getBoundingClientRect().top);
    }
    // Never let panels squeeze the map's centre to nothing.
    if (W - out.left - out.right < W * 0.35) out.left = out.right = 0;
    if (H - out.top - out.bottom < H * 0.3) out.bottom = Math.max(0, H * 0.7 - out.top);
    return out;
  }

  private panelKey(panel: HTMLElement): string | null {
    const c = [...panel.classList].find((x) => x !== 'panel' && x !== 'ed' && x !== 'collapsed');
    return c ?? null;
  }

  private dockWidth(side: 'left' | 'right'): number {
    const d = side === 'left' ? this.left : this.right;
    return d.getBoundingClientRect().width || parseFloat(getComputedStyle(this.root).getPropertyValue(`--dock-${side[0]}`)) || 0;
  }

  /** Width handle on a dock's inner edge: drag, arrow keys (Shift: larger steps), double-click resets. */
  private resizeHandle(side: 'left' | 'right'): HTMLElement {
    const h = el('div', { className: 'dock-resize', tabIndex: 0, role: 'separator', title: 'Drag to resize; double-click to reset' });
    h.setAttribute('aria-orientation', 'vertical');
    h.setAttribute('aria-label', `Resize the ${side} panels`);
    h.setAttribute('aria-valuemin', String(DOCK_MIN));
    h.setAttribute('aria-valuemax', String(DOCK_MAX));
    const set = (w: number | null) => {
      this.widths[side] = w === null ? null : clampWidth(w);
      this.persist();
      this.apply();
    };
    let drag: { x: number; w: number } | null = null;
    h.addEventListener('pointerdown', (e) => {
      if (this.collapsed[side]) return;
      drag = { x: e.clientX, w: this.dockWidth(side) };
      try { h.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      h.classList.add('dragging');
      e.preventDefault();
    });
    h.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      set(drag.w + (side === 'left' ? dx : -dx));
    });
    const end = () => {
      drag = null;
      h.classList.remove('dragging');
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
    h.addEventListener('dblclick', () => set(null));
    h.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10;
      const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
      const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
      if (e.key === grow) set(this.dockWidth(side) + step);
      else if (e.key === shrink) set(this.dockWidth(side) - step);
      else if (e.key === 'Home' || e.key === 'Enter') set(null);
      else return;
      e.preventDefault();
    });
    return h;
  }

  private wireGrip(): void {
    let start: { y: number; h: number; moved: boolean } | null = null;
    const order: SheetState[] = ['peek', 'half', 'full'];
    this.grip.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'sheet') return;
      start = { y: e.clientY, h: this.sheet.getBoundingClientRect().height, moved: false };
      this.grip.setPointerCapture(e.pointerId);
    });
    this.grip.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dy = e.clientY - start.y;
      if (Math.abs(dy) > 6) start.moved = true;
      if (start.moved) {
        this.sheet.style.height = `${Math.max(60, start.h - dy)}px`;
        this.sheet.classList.add('dragging');
      }
    });
    const end = (e: PointerEvent) => {
      if (!start) return;
      const s = start;
      start = null;
      this.sheet.classList.remove('dragging');
      if (!s.moved) {
        if (e.type === 'pointerup') this.setSheet(order[(order.indexOf(this.sheetState) + 1) % 3]);
        return;
      }
      const h = s.h - (e.clientY - s.y);
      const H = window.innerHeight;
      const targets: [SheetState, number][] = [['peek', 0], ['half', H * 0.45], ['full', H * 0.88]];
      targets.sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h));
      // Near a snap point (or below half the half height): snap; otherwise stay at the dragged height.
      if (Math.abs(targets[0][1] - h) < 48 || h < H * 0.2) this.setSheet(targets[0][0]);
      else {
        this.sheetState = h > H * 0.66 ? 'full' : 'half';
        this.sheetPx = Math.min(H - 96, h);
        this.apply();
      }
    };
    this.grip.addEventListener('pointerup', end);
    this.grip.addEventListener('pointercancel', end);
    // Keyboard: Enter / Space activate the button (click), handled as a cycle above via pointer;
    // for keyboard users the click event is the only one fired.
    this.grip.addEventListener('click', (e) => {
      if ((e as PointerEvent).pointerType === '' || e.detail === 0) this.setSheet(order[(order.indexOf(this.sheetState) + 1) % 3]);
    });
  }
}
