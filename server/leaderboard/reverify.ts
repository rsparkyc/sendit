/**
 * Re-verification: re-fly stored plans with the CURRENT build and rewrite the
 * entries, so boards (which only show entries verified under the server's
 * current physics version and the current mission version) fill again after
 * a physics or mission change.
 *
 * For each entry of the source mission version:
 *  - every distinct stored plan (up to one per board) is decoded, checked
 *    against the current mission rules and replayed (allowing the plan's old
 *    model / data stamp: that is the point) and evaluated against the current
 *    mission definition;
 *  - each board then keeps the best of the plans that still succeed, with
 *    their original submission time (so tie order is preserved), or is marked
 *    invalid (with the reason) and leaves the board if none does;
 *  - with a source version different from the current one, results are
 *    merged into the player's entry for the current version (an existing
 *    better result there wins); the source entries are left untouched.
 */
import { SCORE_HIGHER_IS_BETTER, type Engine, type MissionInfo } from './engine';
import { sha256Hex } from './hash';
import { better, BOARDS, sortKey, type BoardId, type Values } from './keys';
import type { Entry, Slot, Store } from './store';

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
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  const sum: ReverifySummary = { entries: 0, plansFlown: 0, slotsValid: 0, slotsInvalid: 0, unchanged: 0, written: 0 };

  for await (const src of store.entries(mission.id, from)) {
    sum.entries++;
    const current = from === mission.version;
    const upToDate = BOARDS.every((b) => {
      const s = src.slots[b];
      return !s || (s.physics === physics && s.status === 'valid') || s.status === 'invalid';
    });
    if (current && upToDate && !o.force) {
      sum.unchanged++;
      continue;
    }

    // Fly each distinct plan once.
    const cands = new Map<string, Candidate>();
    for (const b of BOARDS) {
      const plan = src.plans[b];
      const slot = src.slots[b];
      if (!plan || !slot) continue;
      const planHash = slot.planHash || (await sha256Hex(plan));
      if (cands.has(planHash)) continue;
      cands.set(planHash, await fly(engine, mission, plan, planHash, slot.at, o));
      sum.plansFlown++;
    }

    const target: Entry = current ? src : ((await store.getEntry(mission.id, mission.version, src.playerHash)) ?? { ...src, version: mission.version, rev: 0, slots: {}, plans: {} });
    const slots: Partial<Record<BoardId, Slot>> = { ...target.slots };
    const plans: Partial<Record<BoardId, string>> = { ...target.plans };
    for (const b of BOARDS) {
      const ok = [...cands.values()].filter((c) => c.ok);
      let best: Candidate | undefined;
      for (const c of ok) {
        if (!best || better(b, c.values, best.values, SCORE_HIGHER_IS_BETTER) || (!better(b, best.values, c.values, SCORE_HIGHER_IS_BETTER) && c.at < best.at)) best = c;
      }
      const existing = current ? undefined : target.slots[b];
      const existingWins = existing && existing.status === 'valid' && existing.physics === physics && (!best || !better(b, best.values, existing, SCORE_HIGHER_IS_BETTER));
      if (existingWins) continue;
      if (best) {
        slots[b] = { ...best.values, at: best.at, digest: best.digest, planHash: best.planHash, physics, status: 'valid', key: sortKey(b, best.values, best.at, src.playerHash, SCORE_HIGHER_IS_BETTER) };
        plans[b] = best.plan;
        sum.slotsValid++;
      } else if (current && src.slots[b]) {
        const old = src.slots[b]!;
        const why = cands.get(old.planHash)?.reason ?? 'no stored plan';
        slots[b] = { ...old, status: 'invalid', reason: `re-verified under ${physics}: ${why}` };
        sum.slotsInvalid++;
      }
    }
    log(`${src.pid} ${src.name}#${src.tag}: ${BOARDS.map((b) => `${b}=${slots[b]?.status ?? '-'}`).join(' ')}`);
    if (o.dryRun) continue;
    const next: Entry = { ...target, name: current ? target.name : src.name, tag: src.tag, pid: src.pid, updated: now(), slots, plans, hidden: target.hidden || src.hidden };
    if (await store.putEntry(next)) sum.written++;
    else log(`${src.pid}: changed while re-verifying (a new submission arrived); run again to pick it up`);
  }
  return sum;
}

async function fly(engine: Engine, mission: MissionInfo, encoded: string, planHash: string, at: number, o: ReverifyOptions): Promise<Candidate> {
  const base = { plan: encoded, planHash, at, values: { score: 0, deltaV: 0, missionTime: 0 }, digest: '' };
  let plan;
  try {
    plan = engine.decode(encoded);
  } catch (e) {
    return { ...base, ok: false, reason: `plan no longer decodes: ${(e as Error).message}` };
  }
  const issues = engine.checkRules(plan, mission);
  if (issues.length > 0) return { ...base, ok: false, reason: `breaks the mission rules: ${issues.map((i) => i.message).join('; ')}` };
  const v = engine.verify(plan, mission, { deadline: Date.now() + (o.budgetMs ?? 300_000), maxSteps: o.maxSteps ?? 1_000_000, allowVersionMismatch: true });
  if (!v.success) return { ...base, ok: false, digest: v.digest, reason: v.status === 'ok' ? `objectives not met (${v.objectives.filter((x) => !x.ok).map((x) => x.detail).join('; ')})` : `${v.status}: ${v.reason}` };
  return { ...base, ok: true, values: { score: v.score, deltaV: v.deltaV, missionTime: v.missionTime }, digest: v.digest, reason: '' };
}
