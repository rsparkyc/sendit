/**
 * Re-verification: re-fly stored plans with the CURRENT build and rewrite the
 * entries, so boards (which only show entries verified under the server's
 * current physics version and the current mission version) fill again after
 * a physics or mission change.
 *
 * For each player's group (store.ts) of the source mission version:
 *  - every distinct stored plan (from the site entries and the all-sites
 *    entry, including entries written before launch sites existed) is
 *    decoded, checked against the current mission rules and replayed
 *    (allowing the plan's old model / data stamp: that is the point) and
 *    evaluated against the current mission definition;
 *  - each site entry then keeps, per board, the best of the plans from that
 *    site that still succeed, with their original submission time (so tie
 *    order is preserved), or is marked invalid (with the reason) and leaves
 *    the board if none does; the all-sites entry is recomputed from the site
 *    entries (group.ts allFromSites);
 *  - with a source version different from the current one, results are
 *    merged into the player's group for the current version (an existing
 *    better result there wins); the source entries are left untouched. A
 *    player none of whose plans succeeds under the current version (e.g. a
 *    plan from before the mission had its launch vehicle, refused with the
 *    conformance reason) is not written there; each refusal is logged.
 * The whole group is written in one conditional transaction. */
import { SCORE_HIGHER_IS_BETTER, siteOfPlan, type Engine, type MissionInfo } from './engine';
import { allFromSites, isHidden, live, slotOf } from './group';
import { sha256Hex } from './hash';
import { better, BOARDS, type BoardId, type Values } from './keys';
import { ALL, newEntry, type Entry, type Slot, type Store } from './store';

export interface ReverifyOptions {
  readonly engine: Engine;
  readonly store: Store;
  readonly mission: MissionInfo;
  /** Source mission version (default: the current one). */
  readonly from?: string;
  /** Re-fly even slots already verified under the current physics version. */
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly budgetMs?: number;
  readonly maxSteps?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface ReverifySummary {
  entries: number;
  plansFlown: number;
  slotsValid: number;
  slotsInvalid: number;
  unchanged: number;
  written: number;
}

interface Candidate {
  readonly plan: string;
  /** Launch site of the plan ('' if it no longer decodes). */
  readonly site: string;
  readonly planHash: string;
  readonly at: number;
  readonly ok: boolean;
  readonly values: Values;
  readonly digest: string;
  readonly reason: string;
}

export async function reverify(o: ReverifyOptions): Promise<ReverifySummary> {
  const { engine, store, mission } = o;
  const from = o.from ?? mission.version;
  const physics = engine.physicsVersion;
  const hi = SCORE_HIGHER_IS_BETTER;
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  const sum: ReverifySummary = { entries: 0, plansFlown: 0, slotsValid: 0, slotsInvalid: 0, unchanged: 0, written: 0 };

  for await (const src of store.groups(mission.id, from)) {
    sum.entries++;
    const current = from === mission.version;
    const items = [src.all, ...src.sites.values()].filter((e): e is Entry => !!e);
    const upToDate = items.every((e) => BOARDS.every((b) => {
      const s = e.slots[b];
      return !s || (live(s, physics) && s.site !== undefined) || s.status === 'invalid';
    }));
    if (current && upToDate && src.all && !o.force) {
      sum.unchanged++;
      continue;
    }

    // Fly each distinct plan once.
    const cands = new Map<string, Candidate>();
    for (const e of items) {
      for (const b of BOARDS) {
        const plan = e.plans[b];
        const slot = e.slots[b];
        if (!plan || !slot) continue;
        const planHash = slot.planHash || (await sha256Hex(plan));
        if (cands.has(planHash)) continue;
        cands.set(planHash, await fly(engine, mission, plan, planHash, slot.at, o));
        sum.plansFlown++;
      }
    }
    const ok = [...cands.values()].filter((c) => c.ok);
    for (const c of cands.values()) if (!c.ok) log(`${items[0].pid} ${items[0].name}#${items[0].tag}: plan ${c.planHash.slice(0, 12)} ${c.site ? `@${c.site} ` : ''}refused: ${c.reason}`);
    if (!current && ok.length === 0) {
      // Carrying into a new version: nothing still succeeds there, so there is nothing to write (the source stays as it is).
      sum.slotsInvalid += cands.size;
      continue;
    }

    const target = current ? src : await store.getGroup(mission.id, mission.version, src.playerHash);
    const first = items[0];
    const ident = { pid: first.pid, name: current ? (target.all?.name ?? first.name) : first.name, tag: first.tag };
    const hidden = isHidden(src) || isHidden(target);
    const created = target.all?.created ?? first.created;
    const base = { ...ident, hidden, created };
    const siteIds = new Set<string>([...target.sites.keys(), ...ok.map((c) => c.site)]);
    if (current) for (const s of src.sites.keys()) siteIds.add(s);
    const sites: Entry[] = [];
    for (const site of siteIds) {
      const old = target.sites.get(site) ?? newEntry(target, site, base);
      const slots: Partial<Record<BoardId, Slot>> = { ...old.slots };
      const plans: Partial<Record<BoardId, string>> = { ...old.plans };
      for (const b of BOARDS) {
        let best: Candidate | undefined;
        for (const c of ok) {
          if (c.site !== site) continue;
          if (!best || better(b, c.values, best.values, hi) || (!better(b, best.values, c.values, hi) && c.at < best.at)) best = c;
        }
        const existing = current ? undefined : old.slots[b];
        if (live(existing, physics) && existing.site !== undefined && (!best || !better(b, best.values, existing, hi))) continue;
        if (best) {
          slots[b] = slotOf(b, { ...best, site }, physics, src.playerHash, hi);
          plans[b] = best.plan;
          sum.slotsValid++;
        } else if (current && old.slots[b]) {
          const prev = old.slots[b]!;
          slots[b] = { ...prev, status: 'invalid', reason: `re-verified under ${physics}: ${cands.get(prev.planHash)?.reason ?? 'no stored plan'}` };
          sum.slotsInvalid++;
        }
      }
      sites.push({ ...old, ...ident, hidden, updated: now(), slots, plans });
    }
    const allBase = target.all ?? newEntry(target, ALL, base);
    const all = { ...allFromSites(allBase, sites, physics, hi, `re-verified under ${physics}: no result still succeeds`), ...ident, hidden, updated: now() };
    log(`${first.pid} ${first.name}#${first.tag}: all ${BOARDS.map((b) => `${b}=${all.slots[b]?.status ?? '-'}${all.slots[b]?.site ? `@${all.slots[b]!.site}` : ''}`).join(' ')}; sites ${sites.map((e) => e.site).join(',') || '-'}`);
    if (o.dryRun) continue;
    if (await store.putEntries([all, ...sites])) sum.written++;
    else log(`${first.pid}: changed while re-verifying (a new submission arrived); run again to pick it up`);
  }
  return sum;
}

async function fly(engine: Engine, mission: MissionInfo, encoded: string, planHash: string, at: number, o: ReverifyOptions): Promise<Candidate> {
  const base0 = { plan: encoded, planHash, at, values: { score: 0, deltaV: 0, missionTime: 0 } as Values, digest: '' };
  let plan;
  try {
    plan = engine.decode(encoded);
  } catch (e) {
    return { ...base0, site: '', ok: false, reason: `plan no longer decodes: ${(e as Error).message}` };
  }
  const base = { ...base0, site: siteOfPlan(plan) };
  const issues = engine.checkRules(plan, mission);
  if (issues.length > 0) return { ...base, ok: false, reason: `breaks the mission rules: ${issues.map((i) => i.message).join('; ')}` };
  const v = engine.verify(plan, mission, { deadline: Date.now() + (o.budgetMs ?? 300_000), maxSteps: o.maxSteps ?? 1_000_000, allowVersionMismatch: true });
  if (!v.success) return { ...base, ok: false, digest: v.digest, reason: v.status === 'ok' ? `objectives not met (${v.objectives.filter((x) => !x.ok).map((x) => x.detail).join('; ')})` : `${v.status}: ${v.reason}` };
  return { ...base, ok: true, values: { score: v.score, deltaV: v.deltaV, missionTime: v.missionTime }, digest: v.digest, reason: '' };
}
