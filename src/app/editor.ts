/**
 * Flight-plan editing actions on the store. Every change produces a new plan
 * object (the plan is immutable), so "did the plan change" is an identity
 * check and the replay client sees each edit exactly once.
 */
import { initialPlan, missionById, missionForLoadedPlan, MISSIONS, withLaunch, withLaunchRule, withStateStart, type LaunchDefaults } from './missions';
import { PHYSICS_MODEL, type MissionPlan, type PlanFrame, type Spacecraft } from './mission-layer';
import { addNode, addSeparation, disableNode, enableNode, moveSeparation, nodesOf, removeNode, removeSeparation, separationOffer, setSpacecraft, setStages, updateNode, type ManeuverNode, type Vec3 } from './nodes';
import type { AppState, Store } from './store';
import type { FrameSpec } from './frames';
import { History } from './history';

/** What undo restores: the plan, the disabled nodes and the selection. */
export interface PlanSnapshot {
  plan: MissionPlan;
  parked: readonly ManeuverNode[];
  selectedNode: number | null;
}
import { bodyIndex } from './physics';

/** Missions that read best in a particular frame start in it (the player can change it in View). */
const SUGGESTED_FRAME: Readonly<Record<string, () => FrameSpec>> = {
  // A geostationary satellite is a fixed point over one longitude in Earth's surface frame.
  'geo-from-leo': () => ({ kind: 'surface', center: bodyIndex('earth') }),
};

export class Editor {
  /** Undo / redo of plan edits (add, delete, move, values, enable / disable, start, spacecraft, duration). */
  readonly history = new History<PlanSnapshot>();
  private readonly historyListeners = new Set<() => void>();

  constructor(
    private readonly store: Store<AppState>,
    readonly fingerprint: string,
  ) {}

  /** Called after any change to what undo / redo can do. */
  onHistory(f: () => void): void {
    this.historyListeners.add(f);
  }

  private snapshot(): PlanSnapshot {
    const s = this.store.get();
    return { plan: s.plan, parked: s.parked, selectedNode: s.selectedNode };
  }

  private historyChanged(): void {
    for (const f of this.historyListeners) f();
  }

  /** Record the current state before an edit; `key` coalesces a burst of edits of one value. */
  private record(key: string | null = null): void {
    this.history.record(this.snapshot(), key, performance.now());
    this.historyChanged();
  }

  /** End a coalescing run (e.g. at the end of a drag). */
  sealHistory(): void {
    this.history.seal();
  }

  /** A pointer interaction with one control (drag, hold, clicks while hovering one button) starts or ends. */
  gesture(open: boolean): void {
    if (open) this.history.beginGesture();
    else this.history.endGesture();
  }

  undo(): boolean {
    const s = this.history.undo(this.snapshot());
    if (s) this.store.set({ plan: s.plan, parked: s.parked, selectedNode: s.selectedNode });
    this.historyChanged();
    return !!s;
  }

  redo(): boolean {
    const s = this.history.redo(this.snapshot());
    if (s) this.store.set({ plan: s.plan, parked: s.parked, selectedNode: s.selectedNode });
    this.historyChanged();
    return !!s;
  }

  private resetHistory(): void {
    this.history.clear();
    this.historyChanged();
  }

  get plan(): MissionPlan {
    return this.store.get().plan;
  }

  private commit(plan: MissionPlan, extra: Partial<AppState> = {}, key: string | null = null): void {
    if (plan === this.plan && !('parked' in extra)) {
      this.store.set(extra);
      return;
    }
    this.record(key);
    this.store.set({ plan, ...extra });
  }

  selectMission(id: string): void {
    const m = missionById(id) ?? MISSIONS[0];
    const plan = initialPlan(m, this.fingerprint);
    const frame = SUGGESTED_FRAME[m.id]?.();
    this.resetHistory();
    this.store.set({ missionId: m.id, plan, parked: [], selectedNode: null, selectedSeparation: null, selectedEvent: null, replay: null, t: plan.epoch + 600, loadingTarget: plan.epoch + 600, ...(frame ? { frame } : {}) });
  }

  /** Replace the whole plan (shared link, saved state). */
  load(missionId: string, plan: MissionPlan, parked: readonly ManeuverNode[] = []): void {
    const m = missionForLoadedPlan(missionId, plan);
    this.resetHistory();
    this.store.set({ missionId: m.missionId, plan, parked, selectedNode: null, selectedSeparation: null, selectedEvent: null, replay: null, ...(m.notice ? { notice: m.notice } : {}) });
  }

  /** Replace the plan with one made by a planning aid (same mission; ordinary nodes). */
  replacePlan(plan: MissionPlan, selectedNode: number | null = null): void {
    this.commit(plan, { selectedNode });
  }

  /** Re-stamp a plan made for another physics build so this build will replay it. */
  adoptForThisBuild(): void {
    const entry = missionById(this.store.get().missionId);
    this.commit(withLaunchRule(entry, { ...this.plan, model: PHYSICS_MODEL, data: this.fingerprint }), { notice: null });
  }

  setLaunch(l: LaunchDefaults): void {
    this.commit(withLaunchRule(missionById(this.store.get().missionId), withLaunch(this.plan, l)));
  }

  setStateStart(center: string, epoch: number, state: number[]): void {
    const def = missionById(this.store.get().missionId)?.def;
    if (def && (def.rules.launchOnly || def.start.kind === 'launch')) {
      this.store.set({ notice: `“${def.title}” starts with a launch; a free start is available in Sandbox.` });
      return;
    }
    this.commit(withStateStart(this.plan, center, epoch, state));
  }

  setDuration(seconds: number): void {
    this.commit({ ...this.plan, duration: seconds });
  }

  /** Change the spacecraft (sandbox only: a mission's spacecraft is fixed). */
  setSpacecraft(sc: Spacecraft): void {
    if (this.store.get().missionId !== 'sandbox') return;
    this.commit(setSpacecraft(this.plan, sc));
  }

  addNode(t: number, frame: PlanFrame, dv: Vec3 = [1, 0, 0]): number {
    const engine = 0;
    const r = addNode(this.plan, { t, dv, frame, engine });
    this.commit(r.plan, { selectedNode: r.index });
    return r.index;
  }

  /** `key` coalesces repeated edits of one value into one undo step (see History). */
  updateNode(i: number, patch: Partial<ManeuverNode>, key: string | null = null): void {
    const r = updateNode(this.plan, i, patch);
    this.commit(r.plan, { selectedNode: r.index }, key);
  }

  /** Add `delta` to delta-v component `axis` (0 prograde, 1 normal, 2 radial) of node i. */
  nudgeDv(i: number, axis: 0 | 1 | 2, delta: number): void {
    const n = nodesOf(this.plan)[i]?.node;
    if (!n) return;
    const dv: Vec3 = [...n.dv];
    dv[axis] = roundTo(dv[axis] + delta, Math.abs(delta));
    this.updateNode(i, { dv }, `dv:${i}:${axis}`);
  }

  nudgeTime(i: number, delta: number): void {
    const n = nodesOf(this.plan)[i]?.node;
    if (!n) return;
    this.updateNode(i, { t: roundTo(n.t + delta, Math.abs(delta)) }, `t:${i}`);
  }

  removeNode(i: number): void {
    this.commit(removeNode(this.plan, i), { selectedNode: null });
  }

  disableNode(i: number): void {
    const r = disableNode(this.plan, i);
    this.commit(r.plan, { parked: [...this.store.get().parked, r.parked], selectedNode: null });
  }

  enableParked(k: number): void {
    const parked = [...this.store.get().parked];
    const [node] = parked.splice(k, 1);
    if (!node) return;
    const r = enableNode(this.plan, node);
    this.commit(r.plan, { parked, selectedNode: r.index });
  }

  /** Add a separation at mission time t (s after the epoch); returns its index, or null with a notice saying why not. */
  addSeparation(t: number): number | null {
    const r = addSeparation(this.plan, t);
    if ('error' in r) {
      this.store.set({ notice: r.error });
      return null;
    }
    this.commit(r.plan, { selectedSeparation: r.index, selectedNode: null });
    return r.index;
  }

  /** "Separate now" after burn i: one second after its cutoff. */
  separateAfter(i: number): number | null {
    const o = separationOffer(this.plan, i);
    return o ? this.addSeparation(o.time) : null;
  }

  /** Move separation j to mission time t; `key` coalesces a drag or a burst of steps into one undo step. */
  moveSeparation(j: number, t: number, key: string | null = null): number | null {
    const r = moveSeparation(this.plan, j, t);
    if ('error' in r) {
      this.store.set({ notice: r.error });
      return null;
    }
    this.commit(r.plan, { selectedSeparation: r.index }, key);
    return r.index;
  }

  removeSeparation(j: number): void {
    this.commit(removeSeparation(this.plan, j), { selectedSeparation: null });
  }

  /** Change the whole stack below the spacecraft (sandbox only); `null` removes the vehicle (free delivery). */
  setStages(lower: readonly Spacecraft[] | null, sc: Spacecraft = this.plan.spacecraft): void {
    if (this.store.get().missionId !== 'sandbox') return;
    this.commit(setStages(this.plan, lower, sc));
  }

  deleteParked(k: number): void {
    const parked = [...this.store.get().parked];
    parked.splice(k, 1);
    this.commit(this.plan, { parked });
  }
}

/** Round x to a multiple of step / 100 so repeated nudges do not accumulate float noise in the display. */
function roundTo(x: number, step: number): number {
  if (!(step > 0)) return x;
  const q = step / 100;
  return Math.round(x / q) * q;
}
