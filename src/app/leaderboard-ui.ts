/**
 * Leaderboard UI: a small panel under the flight results (submit, open the
 * boards) and one dialog with three views: submit, boards, identity.
 *
 * Nothing touches the network until the player asks (Submit or Leaderboard);
 * the client module is fetched then (leaderboard-layer.ts). If the API is not
 * there (not deployed yet), the dialog says so in one line and submission is
 * disabled for the rest of the visit — no error dialog, nothing on load.
 */
import { el, section } from './dom';
import type { Editor } from './editor';
import { explainError, loadClient, type BoardEntry, type BoardId, type ErrorLike, type MeResponse, type MissionsResponse, type RankInfo, type SubmitResponse } from './leaderboard-layer';
import { LAUNCH_SITES, allowedSites, decodePlan, encodePlan, validatePlan } from './mission-layer';
import { missionById } from './missions';
import type { AppState, Store } from './store';

const NAME_KEY = 'sendit.leaderboard.name';
const BOARDS: { id: BoardId; label: string }[] = [
  { id: 'combined', label: 'Score' },
  { id: 'deltaV', label: 'Δv total' },
  { id: 'time', label: 'Time' },
];
export const VERIFY_LINE = 'Scores are verified: the server re-flies your plan with the same physics and computes every number itself.';

function missionVersion(id: string): string | null {
  const v = (missionById(id)?.def as { version?: unknown } | null | undefined)?.version;
  return typeof v === 'number' || typeof v === 'string' ? String(v) : null;
}

const fmtValue = (b: BoardId, v: { score: number; deltaV: number; missionTime: number }) =>
  b === 'combined' ? v.score.toLocaleString('en-US') : b === 'deltaV' ? `${v.deltaV.toLocaleString('en-US', { maximumFractionDigits: 1 })} m/s` : `${(v.missionTime / 86400).toFixed(2)} d`;
/** "Cape Canaveral SFS SLC-40, Florida, USA" -> "Cape Canaveral SFS SLC-40". */
const siteName = (id: string) => LAUNCH_SITES.find((x) => x.id === id)?.name.split(',')[0] ?? id;
const fmtDate = (iso: string) => (iso ? iso.slice(0, 10) : '');
const rankText = (r: RankInfo | null) => (!r ? '—' : r.rank !== null ? `#${r.rank.toLocaleString('en-US')}` : `beyond #${(r.beyond ?? 0).toLocaleString('en-US')}`);

function toErr(e: unknown): ErrorLike {
  if (e && typeof e === 'object' && 'code' in e) return e as ErrorLike;
  return { code: 'network', message: e instanceof Error ? e.message : String(e) };
}

export class LeaderboardPanel {
  readonly root: HTMLElement;
  readonly dialog = el('dialog', { className: 'lb' });
  private readonly submitBtn = el('button', { className: 'btn primary', type: 'button', textContent: 'Submit to leaderboard' });
  private readonly viewBtn = el('button', { className: 'btn', type: 'button', textContent: 'Leaderboard' });
  private readonly note = el('div', { className: 'hint lb-note' });
  private readonly body = el('div', { className: 'lb-body' });
  private readonly titleEl = el('h2', { className: 'lb-title' });
  /** null: not probed yet. */
  private available: boolean | null = null;
  private missions: MissionsResponse | null = null;
  private board: BoardId = 'combined';

  constructor(private readonly store: Store<AppState>, private readonly editor: Editor) {
    this.submitBtn.onclick = () => void this.openSubmit();
    this.viewBtn.onclick = () => void this.openBoards();
    this.root = section('Leaderboard', 'leaderboard', el('div', { className: 'row wrap' }, this.submitBtn, this.viewBtn), this.note);
    const close = el('button', { className: 'btn lb-close', type: 'button', textContent: '✕', title: 'Close', ariaLabel: 'Close leaderboard' });
    close.onclick = () => this.dialog.close();
    this.dialog.append(el('div', { className: 'lb-head' }, this.titleEl, close), this.body);
    this.dialog.setAttribute('aria-labelledby', 'lb-title');
    this.titleEl.id = 'lb-title';
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
    store.subscribe((s, p) => {
      if (s.replay !== p.replay || s.plan !== p.plan || s.missionId !== p.missionId || s.replayStatus !== p.replayStatus) this.render();
    });
    this.render();
  }

  private successNow(): boolean {
    const s = this.store.get();
    const r = s.replay;
    return !!r && r.plan === s.plan && r.preview === null && s.replayStatus === 'idle' && !!r.evaluation?.success;
  }

  private render(): void {
    const s = this.store.get();
    const v = missionVersion(s.missionId);
    this.root.style.display = v ? '' : 'none';
    const ok = this.successNow();
    this.submitBtn.disabled = !ok || this.available === false;
    this.viewBtn.disabled = this.available === false;
    // While a replay of the current plan is pending, keep the last note (its length changes the panel's height).
    const pending = !s.replay || s.replay.plan !== s.plan || s.replay.preview !== null || s.replayStatus !== 'idle';
    if (pending && this.available !== false && this.note.textContent) return;
    this.note.textContent =
      this.available === false ? 'The leaderboard is not online yet. Your plan is kept here and in its share link.'
      : ok ? VERIFY_LINE
      : 'Complete the mission to submit your flight.';
  }

  /** Probe the API once; quietly mark it unavailable. */
  private async probe(): Promise<boolean> {
    if (this.available !== null && this.missions) return this.available;
    try {
      const c = await loadClient();
      this.missions = await c.getMissions({ fresh: this.available === null });
      this.available = true;
    } catch (e) {
      const code = toErr(e).code;
      // Not deployed (404 / not JSON) vs a passing network failure: only the former disables it for the visit.
      this.available = code === 'network' || code === 'aborted' || code === 'server-error' ? null : false;
      this.render();
      this.show(this.errorBox(toErr(e)));
      return false;
    }
    this.render();
    return true;
  }

  private open(title: string): void {
    this.titleEl.textContent = title;
    this.body.replaceChildren(el('p', { className: 'hint', textContent: 'Contacting the leaderboard…' }));
    if (!this.dialog.open) this.dialog.showModal();
  }

  private show(...nodes: Node[]): void {
    this.body.replaceChildren(...nodes);
  }

  private errorBox(e: ErrorLike): HTMLElement {
    const x = explainError(e);
    const box = el('div', { className: 'lb-error', role: 'alert' },
      el('b', { textContent: `⚠ ${x.title}` }),
      el('p', { textContent: x.text }),
      x.items.length ? el('ul', {}, ...x.items.map((t) => el('li', { textContent: t }))) : null);
    if (x.action === 'reload') {
      const b = el('button', { className: 'btn', type: 'button', textContent: 'Reload page' });
      b.onclick = () => location.reload();
      box.append(b);
    }
    return box;
  }

  // ------------------------------------------------------------ submit

  async openSubmit(): Promise<void> {
    const s = this.store.get();
    const m = missionById(s.missionId);
    const version = missionVersion(s.missionId);
    if (!m || !version) return;
    this.open(`Submit · ${m.title}`);
    if (!(await this.probe())) return;
    const c = await loadClient();
    let name = '';
    try {
      name = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      /* not remembered */
    }
    const nameIn = el('input', { type: 'text', id: 'lb-name', value: name, maxLength: 24, enterKeyHint: 'send', spellcheck: false, required: true });
    const go = el('button', { className: 'btn primary', type: 'submit', textContent: 'Submit flight' });
    const out = el('div', { className: 'lb-out', role: 'status' });
    out.setAttribute('aria-live', 'polite');
    const form = el('form', { className: 'lb-form' },
      el('p', { className: 'hint', textContent: VERIFY_LINE }),
      el('label', { htmlFor: 'lb-name', textContent: 'Display name (shown with a 5-character tag from your identity key)' }),
      el('div', { className: 'row' }, nameIn, go),
      c.secretIsPersistent() ? null : el('p', { className: 'notice', textContent: 'This browser cannot store your identity key: export it below or you will lose ownership of this entry.' }));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const n = nameIn.value.trim();
      if (!n) {
        nameIn.focus();
        return;
      }
      try {
        localStorage.setItem(NAME_KEY, n);
      } catch {
        /* not remembered */
      }
      const st = this.store.get();
      if (!this.successNow()) {
        out.replaceChildren(el('p', { className: 'error', textContent: 'The plan changed and no longer completes the mission.' }));
        return;
      }
      go.disabled = true;
      out.replaceChildren(el('p', { className: 'hint', textContent: 'The server is re-flying your plan…' }));
      try {
        const why = await c.checkCompatible(st.missionId, version, { model: st.plan.model, data: st.plan.data });
        if (why) {
          out.replaceChildren(this.errorBox({ code: /mission/.test(why) ? 'mission-version' : 'version-mismatch', message: why }));
          return;
        }
        const r = await c.submitFlight({ missionId: st.missionId, missionVersion: version, plan: encodePlan(st.plan), name: n });
        out.replaceChildren(this.resultView(r, st.replay?.result.digest ?? ''));
      } catch (err) {
        out.replaceChildren(this.errorBox(toErr(err)));
      } finally {
        go.disabled = false;
      }
    };
    this.show(form, out, this.identityView());
  }

  private resultView(r: SubmitResponse, localDigest: string): HTMLElement {
    const same = r.result.digest === localDigest;
    const rows = BOARDS.map((b) => el('tr', {},
      el('th', { scope: 'row', textContent: b.label }),
      el('td', { textContent: fmtValue(b.id, r.result) }),
      el('td', { className: 'lb-rank', textContent: `${rankText(r.ranks[b.id])}${r.improved[b.id] ? ' ▲' : ''}` }),
      el('td', { className: 'lb-rank lb-site-rank', textContent: `${rankText(r.siteRanks[b.id])}${r.siteImproved[b.id] ? ' ▲' : ''}` })));
    const view = el('button', { className: 'btn primary', type: 'button', textContent: 'View leaderboard' });
    view.onclick = () => void this.openBoards();
    return el('div', { className: 'lb-result' },
      el('p', { className: 'ok-line', textContent: `✓ Accepted as ${r.player.name} #${r.player.tag}` }),
      el('table', { className: 'lb-table' }, el('thead', {}, el('tr', {}, el('th', { textContent: 'Board' }), el('th', { textContent: 'Server result' }), el('th', { textContent: 'All sites' }), el('th', { textContent: siteName(r.site) }))), el('tbody', {}, ...rows)),
      el('p', { className: 'hint lb-dv-note', textContent: 'Δv total is what you are ranked on: the ascent plus everything flown after orbit insertion, as the server computed it.' }),
      el('p', { className: 'hint', textContent: `Your ranks on the all-sites boards and on the ${siteName(r.site)} boards (flown from there); ▲ new best.` }),
      el('p', { className: 'hint', textContent: same ? `Replay digest ${r.result.digest} matches your flight bit for bit.` : `Server digest ${r.result.digest} (yours ${localDigest || '—'}).` }),
      view);
  }

  // ------------------------------------------------------------ boards

  async openBoards(): Promise<void> {
    const s = this.store.get();
    const m = missionById(s.missionId);
    const version = missionVersion(s.missionId);
    if (!m || !version) return;
    this.open(`Leaderboard · ${m.title}`);
    if (!(await this.probe())) return;
    const c = await loadClient();
    const tabs = el('div', { className: 'lb-tabs', role: 'tablist' });
    const list = el('div', { className: 'lb-list' });
    const mine = el('div', { className: 'lb-mine' });
    const more = el('button', { className: 'btn', type: 'button', textContent: 'Show more' });
    let me: MeResponse | null = null;
    let cursor: string | null = null;
    let rows: BoardEntry[] = [];
    const exposed = !!this.missions?.exposePlans;
    // Launch-site filter: All sites first, then the sites the mission offers. Defaults to the site of the current plan.
    const ALL = c.ALL_SITES;
    const entry = this.missions?.missions.find((x) => x.id === s.missionId);
    const offered = entry?.sites ? entry.sites.filter((x) => x.offered).map((x) => x.id) : [...(allowedSites(m.def!) ?? LAUNCH_SITES.map((x) => x.id))];
    const planSite = s.plan.start.kind === 'launch' ? s.plan.start.site : null;
    let site = planSite && offered.includes(planSite) ? planSite : ALL;
    const siteSel = el('select', { className: 'lb-site', title: 'Launch site' });
    siteSel.setAttribute('aria-label', 'Launch site');
    siteSel.append(el('option', { value: ALL, textContent: 'All sites' }), ...offered.map((id) => el('option', { value: id, textContent: siteName(id) })));
    siteSel.value = site;
    const draw = () => {
      const b = this.board;
      const pid = me?.player?.pid;
      list.replaceChildren(rows.length
        ? el('table', { className: 'lb-table' },
          el('thead', {}, el('tr', {}, el('th', { textContent: 'Rank' }), el('th', { textContent: 'Player' }), el('th', { textContent: 'Site' }), el('th', { textContent: BOARDS.find((x) => x.id === b)!.label }), el('th', { textContent: 'Date' }), exposed ? el('th', { textContent: '' }) : null)),
          el('tbody', {}, ...rows.map((e) => {
            const tr = el('tr', { className: e.pid === pid ? 'me' : '' },
              el('td', { textContent: `${e.rank}` }),
              el('td', {}, el('span', { textContent: e.name }), ' ', el('small', { className: 'tag', textContent: `#${e.tag}` }), e.pid === pid ? el('b', { className: 'you', textContent: ' (you)' }) : null),
              el('td', { className: 'lb-site-cell', textContent: siteName(e.site) }),
              el('td', { className: 'num', textContent: fmtValue(b, e) }),
              el('td', { textContent: fmtDate(e.submittedAt) }));
            if (exposed) {
              const v = el('button', { className: 'btn small', type: 'button', textContent: 'View flight' });
              const at = site;
              v.onclick = () => void this.viewFlight(s.missionId, version, b, e.pid, at);
              tr.append(el('td', {}, v));
            }
            return tr;
          })))
        : el('p', { className: 'hint', textContent: 'No entries yet. Be the first.' }));
      more.hidden = cursor === null;
      const r = me?.ranks[b] ?? null;
      const inList = !!pid && rows.some((e) => e.pid === pid);
      mine.replaceChildren(me?.player && r
        ? el('p', { className: inList ? 'hint' : 'lb-you' }, `You (${me.player.name} #${me.player.tag}): ${rankText(r)} · ${fmtValue(b, r)} · ${siteName(r.site)}`)
        : el('p', { className: 'hint', textContent: site === ALL ? 'You have no entry on this mission yet.' : `You have no entry from ${siteName(site)} yet.` }));
    };
    const load = async (reset: boolean) => {
      try {
        const page = await c.getBoard(s.missionId, version, this.board, { site, limit: 20, cursor: reset ? undefined : cursor ?? undefined });
        rows = reset ? [...page.entries] : [...rows, ...page.entries];
        cursor = page.next;
        draw();
      } catch (e) {
        list.replaceChildren(this.errorBox(toErr(e)));
      }
    };
    for (const b of BOARDS) {
      const t = el('button', { className: 'btn tab', type: 'button', role: 'tab', textContent: b.label });
      t.setAttribute('aria-selected', String(b.id === this.board));
      t.onclick = () => {
        this.board = b.id;
        for (const x of tabs.children) x.setAttribute('aria-selected', String(x === t));
        rows = [];
        cursor = null;
        void load(true);
      };
      tabs.append(t);
    }
    more.onclick = () => void load(false);
    const loadMe = async () => {
      try {
        me = await c.getMyRanks(s.missionId, version, { site });
      } catch {
        me = null; // own rank is a nicety; the board still shows
      }
    };
    siteSel.onchange = async () => {
      site = siteSel.value;
      rows = [];
      cursor = null;
      await loadMe();
      await load(true);
    };
    this.show(el('p', { className: 'hint', textContent: VERIFY_LINE }), el('label', { className: 'frow lb-site-row' }, el('span', { textContent: 'Launch site' }), siteSel), tabs, mine, list, more, this.identityView());
    await loadMe();
    await load(true);
  }

  private async viewFlight(missionId: string, version: string, board: BoardId, pid: string, site: string): Promise<void> {
    try {
      const c = await loadClient();
      const r = await c.getPlan(missionId, version, board, pid, { site });
      const plan = decodePlan(r.plan);
      if (validatePlan(plan).length) throw new Error('the stored plan is not valid in this build');
      if (this.store.get().plan.burns.length > 0 && !confirm('Replace your current plan with this flight? Yours stays in its share link only.')) return;
      this.editor.load(missionId, plan);
      this.dialog.close();
    } catch (e) {
      this.show(this.errorBox(toErr(e)));
    }
  }

  // ------------------------------------------------------------ identity

  private identityView(): HTMLElement {
    const d = el('details', { className: 'lb-id' }, el('summary', { textContent: 'Your identity key (export / import)' }));
    const p = el('p', { className: 'hint' });
    p.innerHTML = `Your entries belong to a secret key kept in this browser. <b>Losing it means losing ownership of your entries</b>: they stay on the board, but you can no longer improve them. Copy it to keep it safe or to use another device, and treat it like a password.`;
    const out = el('input', { type: 'text', readOnly: true, className: 'lb-secret', ariaLabel: 'Your identity key', spellcheck: false });
    const show = el('button', { className: 'btn', type: 'button', textContent: 'Show key' });
    const copy = el('button', { className: 'btn', type: 'button', textContent: 'Copy' });
    const inp = el('input', { type: 'text', placeholder: 'Paste a key from another browser', className: 'lb-import', ariaLabel: 'Identity key to import', spellcheck: false, autocomplete: 'off' });
    const use = el('button', { className: 'btn', type: 'button', textContent: 'Use this key' });
    const msg = el('p', { className: 'hint', role: 'status' });
    show.onclick = async () => {
      out.value = (await loadClient()).exportSecret();
      out.select();
    };
    copy.onclick = async () => {
      const k = (await loadClient()).exportSecret();
      out.value = k;
      try {
        await navigator.clipboard.writeText(k);
        msg.textContent = 'Copied.';
      } catch {
        out.select();
        msg.textContent = 'Select the key and copy it.';
      }
    };
    use.onclick = async () => {
      if (!inp.value.trim()) return;
      if (!confirm('Switch to this key? Entries made with your current key stay theirs; export it first if you want to keep them.')) return;
      const ok = (await loadClient()).importSecret(inp.value);
      msg.textContent = ok ? '✓ Key imported: you are now that player.' : '⚠ That is not a valid key.';
      if (ok) inp.value = '';
    };
    d.append(p, el('div', { className: 'row' }, out, show, copy), el('div', { className: 'row' }, inp, use), msg);
    return d;
  }
}


