/**
 * Flight-plan editing actions on the store. Every change produces a new plan
 * object (the plan is immutable), so "did the plan change" is an identity
 * check and the replay client sees each edit exactly once.
 */
import { initialPlan, missionById, MISSIONS, withLaunch, withStateStart, type LaunchDefaults } from './missions';
import { PHYSICS_MODEL, type MissionPlan, type PlanFrame, type Spacecraft } from './mission-layer';
import { addNode, disableNode, enableNode, nodesOf, removeNode, setSpacecraft, updateNode, type ManeuverNode, type Vec3 } from './nodes';
import type { AppState, Store } from './store';

export class Editor {
  constructor(
    private readonly store: Store<AppState>,
    readonly fingerprint: string,
  ) {}

  get plan(): MissionPlan {
    return this.store.get().plan;
  }

  private commit(plan: MissionPlan, extra: Partial<AppState> = {}): void {
    this.store.set({ plan, ...extra });
  }

  selectMission(id: string): void {
    const m = missionById(id) ?? MISSIONS[0];
    const plan = initialPlan(m, this.fingerprint);
    this.store.set({ missionId: m.id, plan, parked: [], selectedNode: null, selectedEvent: null, replay: null, t: plan.epoch + 600, loadingTarget: plan.epoch + 600 });
  }

  /** Replace the whole plan (shared link, saved state). */
  load(missionId: string, plan: MissionPlan, parked: readonly ManeuverNode[] = []): void {
    this.store.set({ missionId: missionById(missionId)?.id ?? 'sandbox', plan, parked, selectedNode: null, selectedEvent: null, replay: null });
  }

  /** Re-stamp a plan made for another physics build so this build will replay it. */
  adoptForThisBuild(): void {
    this.commit({ ...this.plan, model: PHYSICS_MODEL, data: this.fingerprint }, { notice: null });
  }

  setLaunch(l: LaunchDefaults): void {
    this.commit(withLaunch(this.plan, l));
  }

  setStateStart(center: string, epoch: number, state: number[]): void {
    this.commit(withStateStart(this.plan, center, epoch, state));
  }

  setDuration(seconds: number): void {
    this.commit({ ...this.plan, duration: seconds });
  }

  setSpacecraft(sc: Spacecraft): void {
    this.commit(setSpacecraft(this.plan, sc));
  }

  addNode(t: number, frame: PlanFrame, dv: Vec3 = [1, 0, 0]): number {
    const engine = 0;
    const r = addNode(this.plan, { t, dv, frame, engine });
    this.commit(r.plan, { selectedNode: r.index });
    return r.index;
  }

  updateNode(i: number, patch: Partial<ManeuverNode>): void {
    const r = updateNode(this.plan, i, patch);
    this.commit(r.plan, { selectedNode: r.index });
  }

  /** Add `delta` to delta-v component `axis` (0 prograde, 1 normal, 2 radial) of node i. */
  nudgeDv(i: number, axis: 0 | 1 | 2, delta: number): void {
    const n = nodesOf(this.plan)[i]?.node;
    if (!n) return;
    const dv: Vec3 = [...n.dv];
    dv[axis] = roundTo(dv[axis] + delta, Math.abs(delta));
    this.updateNode(i, { dv });
  }

  nudgeTime(i: number, delta: number): void {
    const n = nodesOf(this.plan)[i]?.node;
    if (!n) return;
    this.updateNode(i, { t: roundTo(n.t + delta, Math.abs(delta)) });
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

  deleteParked(k: number): void {
    const parked = [...this.store.get().parked];
    parked.splice(k, 1);
    this.store.set({ parked });
  }
}

/** Round x to a multiple of step / 100 so repeated nudges do not accumulate float noise in the display. */
function roundTo(x: number, step: number): number {
  if (!(step > 0)) return x;
  const q = step / 100;
  return Math.round(x / q) * q;
}
