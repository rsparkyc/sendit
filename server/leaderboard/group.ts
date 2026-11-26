/**
 * How a player's group of entries (store.ts: one all-sites entry plus one
 * entry per launch site flown) changes. Pure functions: the callers read the
 * group, compute the next state here, and write the changed entries in one
 * conditional transaction (Store.putEntries), retrying on a lost race.
 *
 * Rules (both writers, submit and re-verification, follow them):
 *  - a site entry's slot on a board is replaced only by a strictly better
 *    result from that site (a tie keeps the earlier one), or when the stored
 *    slot is invalid or verified under another physics version;
 *  - the all-sites slot on a board is the best valid, current-physics slot
 *    among the site entries (ties: earlier submission), carrying its site;
 *  - `hidden`, name and tag are the same on every entry of the group.
 */
import { better, BOARDS, sortKey, type BoardId, type Values } from './keys';
import { ALL, newEntry, type Entry, type Group, type Slot } from './store';

export interface Flight {
  readonly values: Values;
  /** Submission time (ms): kept from the original submission on re-verification. */
  readonly at: number;
  readonly digest: string;
  readonly planHash: string;
  readonly plan: string;
  readonly site: string;
}

export interface Identity {
  readonly pid: string;
  readonly name: string;
  readonly tag: string;
}

export type Flags = Record<BoardId, boolean>;
const none = (): Flags => ({ combined: false, deltaV: false, time: false });

export function slotOf(b: BoardId, f: Flight, physics: string, playerHash: string, scoreHigherIsBetter: boolean): Slot {
  return { ...f.values, at: f.at, digest: f.digest, planHash: f.planHash, physics, site: f.site, status: 'valid', key: sortKey(b, f.values, f.at, playerHash, scoreHigherIsBetter) };
}

/** True if `s` is a valid slot verified under `physics`. */
export function live(s: Slot | undefined, physics: string): s is Slot {
  return !!s && s.status === 'valid' && s.physics === physics;
}

/** a ranks strictly before b (values, then earlier submission). */
function before(b: BoardId, a: Slot, c: Slot, hi: boolean): boolean {
  return better(b, a, c, hi) || (!better(b, c, a, hi) && a.at < c.at);
}

export interface Change {
  /** Entries to write (empty: nothing changed). */
  readonly writes: Entry[];
  readonly all: Entry;
  readonly site: Entry;
  readonly improvedSite: Flags;
  readonly improvedAll: Flags;
}

/** The group after a verified flight (submission). */
export function withFlight(g: Group, f: Flight, id: Identity, physics: string, now: number, hi: boolean): Change {
  const hidden = isHidden(g);
  const created = g.all?.created ?? now;
  const base = { ...id, hidden, created };
  const oldSite = g.sites.get(f.site);
  let site: Entry = oldSite ?? newEntry(g, f.site, base);
  let all: Entry = g.all ?? newEntry(g, ALL, base);
  const improvedSite = none();
  const improvedAll = none();
  for (const b of BOARDS) {
    const slot = slotOf(b, f, physics, g.playerHash, hi);
    const cs = site.slots[b];
    if (!live(cs, physics) || better(b, f.values, cs, hi)) {
      improvedSite[b] = true;
      site = { ...site, slots: { ...site.slots, [b]: slot }, plans: { ...site.plans, [b]: f.plan } };
    }
    const ca = all.slots[b];
    if (!live(ca, physics) || better(b, f.values, ca, hi)) {
      improvedAll[b] = true;
      all = { ...all, slots: { ...all.slots, [b]: slot }, plans: { ...all.plans, [b]: f.plan } };
    }
  }
  const renamed = (e: Entry) => e.name !== id.name || e.tag !== id.tag;
  const anyRenamed = [g.all, ...g.sites.values()].some((e) => e && renamed(e));
  const siteChanged = !oldSite || BOARDS.some((b) => improvedSite[b]);
  const allChanged = !g.all || BOARDS.some((b) => improvedAll[b]);
  if (!siteChanged && !allChanged && !anyRenamed) return { writes: [], all, site, improvedSite, improvedAll };
  const touch = (e: Entry): Entry => ({ ...e, name: id.name, tag: id.tag, pid: id.pid, hidden, updated: now });
  site = touch(site);
  all = touch(all);
  // The all-sites entry is always written: its rev condition serialises the group.
  const writes = [all, site];
  if (anyRenamed) for (const e of g.sites.values()) if (e.site !== f.site && renamed(e)) writes.push(touch(e));
  return { writes, all, site, improvedSite, improvedAll };
}

export function isHidden(g: Group): boolean {
  return (g.all?.hidden ?? false) || [...g.sites.values()].some((e) => e.hidden);
}

/** The group with `hidden` set on every entry (admin). */
export function withHidden(g: Group, hidden: boolean, now: number): Entry[] {
  return [g.all, ...g.sites.values()].filter((e): e is Entry => !!e).map((e) => ({ ...e, hidden, updated: now }));
}

/**
 * All-sites slots recomputed from site entries (re-verification): per board
 * the best live site slot; if none, the previous all-sites slot marked
 * invalid (with `reason`) or nothing.
 */
export function allFromSites(all: Entry, sites: readonly Entry[], physics: string, hi: boolean, reason: string): Entry {
  const slots: Partial<Record<BoardId, Slot>> = {};
  const plans: Partial<Record<BoardId, string>> = {};
  for (const b of BOARDS) {
    let best: { slot: Slot; plan: string | undefined } | null = null;
    for (const e of sites) {
      const s = e.slots[b];
      if (live(s, physics) && (!best || before(b, s, best.slot, hi))) best = { slot: s, plan: e.plans[b] };
    }
    if (best) {
      slots[b] = best.slot;
      if (best.plan !== undefined) plans[b] = best.plan;
    } else if (all.slots[b]) {
      slots[b] = { ...all.slots[b]!, status: 'invalid', reason };
      if (all.plans[b] !== undefined) plans[b] = all.plans[b];
    }
  }
  return { ...all, slots, plans };
}
