/**
 * Maneuver nodes and plan editing operations. Pure (no DOM, no workers).
 *
 * The plan (MissionPlan) is the source of truth; nodes are a VIEW of its
 * burns. A node is what a KSP / Principia player edits: a time and a delta-v
 * (prograde, normal, radial-out) in the orbital frame of a reference body.
 * The simulator flies finite burns, so a node is stored as a real PlanBurn:
 *   mass at ignition m0 = wet mass minus the propellant of all earlier burns
 *     (requested burn times, capped at the dry mass),
 *   ve = Isp g0, mf = m0 exp(-|dv| / ve), duration = (m0 - mf) ve / thrust,
 *   start = node time - duration / 2 (centred), direction = dv / |dv|.
 * Converting back inverts each step, so a node survives a round trip to a few
 * ulps. Edits keep every earlier burn bit-for-bit and keep the REQUESTED
 * delta-v of every later node (later burn times are recomputed for the new
 * mass), which is how planners expect a node chain to behave.
 *
 * Disabled nodes are parked burns kept outside the plan (editor-only state).
 *
 * STAGES (format-2 plans: a launch vehicle's lower stages under the
 * spacecraft). A node is fired by the stage active at its time: the first
 * stage of the flight (after a vehicle ascent, the upper stage, with the
 * propellant the ascent left it: planAscent) plus one per separation before
 * it. The mass chain is the whole stack's. When the requested burns have
 * emptied the active stage, the next new node is given to the next stage
 * with a separation one second after the empty stage's last burn ("separate
 * when empty"); separations already in the plan are kept as they are.
 * Format-1 plans (spacecraft only) are unchanged, bit for bit.
 */
import { makePlan, planAscent, simulationStartOffset, vehicleStages, isVehicleLaunch, type MissionPlan, type PlanBurn, type PlanFrame, type PlanSeparation, type Spacecraft } from './mission-layer';
import { BODY_DATA } from './physics';
import { osculating } from './orbit-elements';

/** Standard gravity, m/s^2 (defines Isp; same constant as the physics). */
export const G0 = 9.80665;

export type Vec3 = [number, number, number];

export interface ManeuverNode {
  /** Burn centre, seconds after the plan epoch. */
  t: number;
  /** Requested delta-v, m/s: (prograde, normal, radial-out) for an orbital frame, ICRF x y z for inertial. */
  dv: Vec3;
  frame: PlanFrame;
  /** Index into the firing stage's engines (spacecraft.engines for a spacecraft-only plan). */
  engine: number;
}

export interface NodeInfo {
  node: ManeuverNode;
  burn: PlanBurn;
  /** Mass at ignition and at cutoff by the rocket equation, kg. */
  m0: number;
  m1: number;
  /** True if the requested delta-v needs more propellant than is left (the burn will be cut short). */
  short: boolean;
  /** Stage that fires it (index into lower stages, then the spacecraft). */
  stage: number;
}

/** The stack of a plan: its stages, the first one flying, and its propellant then. */
interface Stack {
  readonly stages: readonly Spacecraft[];
  readonly first: number;
  readonly staged: boolean;
  readonly prop: number[];
}

function stackOf(plan: MissionPlan): Stack {
  const stages = vehicleStages(plan);
  const staged = plan.format >= 2 && (plan.lowerStages !== undefined || isVehicleLaunch(plan.start));
  const prop = stages.map((x) => x.wetMass - x.dryMass);
  let first = 0;
  if (isVehicleLaunch(plan.start)) {
    const a = planAscent(plan, BODY_DATA);
    first = a?.ok ? a.upperStage : Math.max(0, stages.length - 2);
    if (a?.ok) prop[first] = a.upperPropellant;
    for (let k = 0; k < first; k++) prop[k] = 0;
  }
  return { stages, first, staged, prop };
}

/** Stack mass with stage k active and `prop` propellant in it. */
function stackMass(st: Stack, k: number, prop: number): number {
  return prop + emptyMass(st, k);
}

/** Stack mass with stage k active and empty (spacecraft-only: its dry mass, exactly). */
function emptyMass(st: Stack, k: number): number {
  let m = st.stages[k].dryMass;
  for (let j = k + 1; j < st.stages.length; j++) m += st.stages[j].wetMass;
  return m;
}

/**
 * Stack mass per active stage along the burns (format 1: the spacecraft's
 * mass from its wet mass, the same arithmetic as before stages existed).
 */
function massChain(st: Stack): number[] {
  return st.stages.map((x, k) => (st.staged ? stackMass(st, k, st.prop[k]) : x.wetMass));
}

/** Stage active at mission time t (s after the epoch) given the separations. */
function activeAt(st: Stack, seps: readonly PlanSeparation[], t: number): number {
  let k = st.first;
  for (const s of seps) if (s.time <= t) k++;
  return Math.min(k, st.stages.length - 1);
}

/** Stage a burn of the plan fires (lower stages, then the spacecraft). */
export function stageOfBurn(plan: MissionPlan, b: PlanBurn): Spacecraft {
  const stages = vehicleStages(plan);
  return stages[b.stage ?? (plan.lowerStages?.length ?? 0)] ?? plan.spacecraft;
}

export function dvMagnitude(dv: readonly number[]): number {
  return Math.hypot(dv[0], dv[1], dv[2]);
}

/** Burn for a node, given the mass at ignition. */
export function nodeToBurn(node: ManeuverNode, sc: Spacecraft, m0: number): PlanBurn {
  const e = sc.engines[node.engine] ?? sc.engines[0];
  const ve = e.isp * G0;
  const dv = dvMagnitude(node.dv);
  const mf = m0 * Math.exp(-dv / ve);
  const duration = ((m0 - mf) * ve) / e.thrust;
  const k = dv > 0 ? 1 / dv : 0;
  return {
    start: node.t - duration / 2,
    duration,
    engine: sc.engines[node.engine] ? node.engine : 0,
    direction: [node.dv[0] * k, node.dv[1] * k, node.dv[2] * k],
    frame: node.frame,
  };
}

/** Node for a burn, given the mass at ignition. */
export function burnToNode(burn: PlanBurn, sc: Spacecraft, m0: number): ManeuverNode {
  const e = sc.engines[burn.engine] ?? sc.engines[0];
  const ve = e.isp * G0;
  const mf = m0 - (e.thrust / ve) * burn.duration;
  const dv = mf > 0 ? ve * Math.log(m0 / mf) : Infinity;
  const d = burn.direction;
  const n = dvMagnitude(d);
  const k = n > 0 ? dv / n : 0;
  return { t: burn.start + burn.duration / 2, dv: [d[0] * k, d[1] * k, d[2] * k], frame: burn.frame, engine: burn.engine };
}

/** Propellant a burn requests, kg (thrust / ve * duration), capped by what is left above `empty` (the stack with the stage dry). */
function propellant(burn: PlanBurn, sc: Spacecraft, m: number, empty: number): number {
  const e = sc.engines[burn.engine] ?? sc.engines[0];
  return Math.min((e.thrust / (e.isp * G0)) * burn.duration, Math.max(0, m - empty));
}

/** Every burn of the plan as a node, with its mass chain. */
export function nodesOf(plan: MissionPlan): NodeInfo[] {
  const st = stackOf(plan);
  const mass = massChain(st);
  const L = plan.lowerStages?.length ?? 0;
  return plan.burns.map((burn) => {
    const k = Math.min(burn.stage ?? L, st.stages.length - 1);
    const sc = st.stages[k];
    const m = mass[k];
    const node = burnToNode(burn, sc, m);
    const e = sc.engines[burn.engine] ?? sc.engines[0];
    const want = (e.thrust / (e.isp * G0)) * burn.duration;
    const used = propellant(burn, sc, m, emptyMass(st, k));
    mass[k] = m - used;
    return { node, burn, m0: m, m1: m - used, short: want > used * (1 + 1e-12), stage: k };
  });
}

function sortNodes(nodes: ManeuverNode[]): ManeuverNode[] {
  return nodes.map((n, i) => ({ n, i })).sort((a, b) => a.n.t - b.n.t || a.i - b.i).map((x) => x.n);
}

/**
 * Plan whose burns are plan.burns[0..keep) unchanged, followed by burns for
 * `nodes` (all of them, sorted by time) with the mass chain continuing.
 */
function rebuild(plan: MissionPlan, keep: number, nodes: ManeuverNode[], autoSeparate = true): MissionPlan {
  const st = stackOf(plan);
  const mass = massChain(st);
  const L = plan.lowerStages?.length ?? 0;
  const burns: PlanBurn[] = plan.burns.slice(0, keep);
  const seps: PlanSeparation[] = [...(plan.separations ?? [])];
  const lastEnd: number[] = st.stages.map(() => -Infinity);
  for (const b of burns) {
    const k = Math.min(b.stage ?? L, st.stages.length - 1);
    mass[k] -= propellant(b, st.stages[k], mass[k], emptyMass(st, k));
    lastEnd[k] = Math.max(lastEnd[k], b.start + b.duration);
  }
  for (const n of nodes) {
    let k = st.staged ? activeAt(st, seps, n.t) : 0;
    // Separate when empty: the active stage has nothing left and a stage above it does.
    if (autoSeparate && st.staged && mass[k] - emptyMass(st, k) < 1e-6 * st.stages[k].wetMass && k < st.stages.length - 1 && Number.isFinite(lastEnd[k]) && lastEnd[k] + 1 < n.t) {
      seps.push({ time: lastEnd[k] + 1 });
      seps.sort((a, b) => a.time - b.time);
      k++;
    }
    const sc = st.stages[k];
    const b0 = nodeToBurn(n, sc, mass[k]);
    const b = st.staged ? { ...b0, stage: k } : b0;
    burns.push(b);
    mass[k] -= propellant(b, sc, mass[k], emptyMass(st, k));
    lastEnd[k] = Math.max(lastEnd[k], b.start + b.duration);
  }
  const out: MissionPlan = { ...plan, burns };
  return seps.length !== (plan.separations?.length ?? 0) ? { ...out, separations: seps } : out;
}

/** Index of `node` (by identity) after sorting, for selection tracking. */
function placeAll(plan: MissionPlan, nodes: ManeuverNode[], target: ManeuverNode): { plan: MissionPlan; index: number } {
  const sorted = sortNodes(nodes);
  // Keep the longest prefix of burns whose nodes did not change.
  const old = nodesOf(plan).map((x) => x.node);
  let keep = 0;
  while (keep < sorted.length && keep < old.length && sorted[keep] !== target && sameNode(sorted[keep], old[keep])) keep++;
  // The prefix must also be identical burns in the same positions (identity of the node objects tells us that).
  return { plan: rebuild(plan, keep, sorted.slice(keep)), index: sorted.indexOf(target) };
}

function sameNode(a: ManeuverNode, b: ManeuverNode): boolean {
  return a.t === b.t && a.engine === b.engine && a.dv[0] === b.dv[0] && a.dv[1] === b.dv[1] && a.dv[2] === b.dv[2] && sameFrame(a.frame, b.frame);
}

function sameFrame(a: PlanFrame, b: PlanFrame): boolean {
  return a.kind === b.kind && (a.kind === 'inertial' || a.body === (b as { body: string }).body);
}

/** Add a node; returns the new plan and the node's index. */
export function addNode(plan: MissionPlan, node: ManeuverNode): { plan: MissionPlan; index: number } {
  const nodes = nodesOf(plan).map((x) => x.node);
  return placeAll(plan, [...nodes, node], node);
}

/** Replace node i by `patch` applied to it; returns the new plan and the node's (possibly new) index. */
export function updateNode(plan: MissionPlan, i: number, patch: Partial<ManeuverNode>): { plan: MissionPlan; index: number } {
  const nodes = nodesOf(plan).map((x) => x.node);
  const next: ManeuverNode = { ...nodes[i], ...patch, dv: [...(patch.dv ?? nodes[i].dv)] as Vec3 };
  nodes[i] = next;
  return placeAll(plan, nodes, next);
}

/** Remove node i; later nodes keep their requested delta-v. */
export function removeNode(plan: MissionPlan, i: number): MissionPlan {
  const nodes = nodesOf(plan).map((x) => x.node);
  nodes.splice(i, 1);
  return rebuild(plan, i, nodes.slice(i));
}

/** Park node i outside the plan (disable). The parked form is its node, so re-enabling restores its delta-v. */
export function disableNode(plan: MissionPlan, i: number): { plan: MissionPlan; parked: ManeuverNode } {
  const parked = nodesOf(plan)[i].node;
  return { plan: removeNode(plan, i), parked };
}

/** Put a parked node back. */
export function enableNode(plan: MissionPlan, node: ManeuverNode): { plan: MissionPlan; index: number } {
  return addNode(plan, { ...node, dv: [...node.dv] as Vec3 });
}

// ---------------------------------------------------------------------------
// Separations (format-2 staged plans). A separation drops the active stage at
// its time, with whatever propellant it still holds. Editing one keeps every
// burn that ends before the earliest time touched bit-for-bit and re-fires
// every later node (same requested delta-v) on the stage active at its time;
// the automatic "separate when empty" is not applied, so a separation the
// player removed stays removed.

export interface SeparationInfo {
  /** Index into plan.separations. */
  index: number;
  /** Mission time, s after the epoch. */
  time: number;
  /** Stage dropped (index into vehicleStages) and the stage that takes over. */
  dropped: number;
  next: number;
  /** Propellant the dropped stage still holds (by the node chain), kg. */
  propellantLeft: number;
  /** The dropped stage was dry (a "separate when empty"). */
  empty: boolean;
}

/** Plan's separations with the stage each one drops (by the node chain's masses). */
export function separationsOf(plan: MissionPlan): SeparationInfo[] {
  const st = stackOf(plan);
  const seps = plan.separations ?? [];
  if (!seps.length) return [];
  const left = st.prop.slice();
  const infos = nodesOf(plan);
  return seps.map((s, j) => {
    const dropped = Math.min(st.first + j, st.stages.length - 1);
    let p = left[dropped];
    for (const x of infos) if (x.stage === dropped && x.burn.start < s.time) p -= x.m0 - x.m1;
    p = Math.max(0, p);
    return { index: j, time: s.time, dropped, next: Math.min(dropped + 1, st.stages.length - 1), propellantLeft: p, empty: p < 1e-6 * st.stages[dropped].wetMass + 1e-9 };
  });
}

/** Stage that is active at mission time t (s after the epoch): the flight's first stage plus one per earlier separation. */
export function stageAt(plan: MissionPlan, t: number): number {
  const st = stackOf(plan);
  return activeAt(st, plan.separations ?? [], t);
}

/** First stage of the flight (after a vehicle ascent: the stage that reached orbit; else 0). */
export function firstStage(plan: MissionPlan): number {
  return stackOf(plan).first;
}

/** Why a separation cannot go at time t (null if it can). */
export function separationRefusal(plan: MissionPlan, t: number, ignore = -1): string | null {
  const st = stackOf(plan);
  if (!st.staged) return 'This vehicle has a single stage: there is nothing to separate.';
  const seps = (plan.separations ?? []).filter((_, j) => j !== ignore);
  if (st.first + seps.length >= st.stages.length - 1) return 'Every stage below the spacecraft is already separated (a separation would drop the spacecraft).';
  if (seps.length >= 5) return 'At most 5 separations.';
  const t0 = simulationStartOffset(plan.start);
  if (!(t >= t0)) return 'A separation cannot come before orbit insertion.';
  if (!(t <= plan.duration)) return 'A separation must be within the flight.';
  return null;
}

function withSeparations(plan: MissionPlan, seps: PlanSeparation[], touched: number): MissionPlan {
  const sorted = seps.slice().sort((a, b) => a.time - b.time);
  const nodes = nodesOf(plan).map((x) => x.node);
  // Keep every burn whose node and burn both end before the earliest touched time.
  let keep = 0;
  while (keep < plan.burns.length && plan.burns[keep].start + plan.burns[keep].duration <= touched && nodes[keep].t < touched) keep++;
  const { separations: _old, ...rest } = plan;
  void _old;
  const base: MissionPlan = sorted.length ? { ...rest, separations: sorted } : (plan.format >= 2 ? { ...rest, separations: [] } : rest);
  return rebuild(base, keep, nodes.slice(keep), false);
}

/** Add a separation at time t; returns the new plan and its index, or the refusal. */
export function addSeparation(plan: MissionPlan, t: number): { plan: MissionPlan; index: number } | { error: string } {
  const why = separationRefusal(plan, t);
  if (why) return { error: why };
  const seps = [...(plan.separations ?? []), { time: t }];
  const out = withSeparations(plan, seps, t);
  return { plan: out, index: (out.separations ?? []).findIndex((s) => s.time === t) };
}

/** Move separation j to time t. */
export function moveSeparation(plan: MissionPlan, j: number, t: number): { plan: MissionPlan; index: number } | { error: string } {
  const old = plan.separations?.[j];
  if (!old) return { error: 'No such separation.' };
  const why = separationRefusal(plan, t, j);
  if (why) return { error: why };
  const seps = (plan.separations ?? []).map((s, k) => (k === j ? { time: t } : s));
  const out = withSeparations(plan, seps, Math.min(old.time, t));
  return { plan: out, index: (out.separations ?? []).findIndex((s) => s.time === t) };
}

/** Remove separation j; later nodes are re-fired on the stage then active. */
export function removeSeparation(plan: MissionPlan, j: number): MissionPlan {
  const old = plan.separations?.[j];
  if (!old) return plan;
  return withSeparations(plan, (plan.separations ?? []).filter((_, k) => k !== j), old.time);
}

/**
 * Where "separate now" after burn i would go: one second after its cutoff,
 * when burn i's stage is not the spacecraft and nothing separates it before
 * the next burn. `empty`: the burn leaves its stage dry.
 */
export function separationOffer(plan: MissionPlan, i: number): { time: number; empty: boolean; stage: number } | null {
  const infos = nodesOf(plan);
  const x = infos[i];
  if (!x) return null;
  const st = stackOf(plan);
  if (!st.staged || x.stage >= st.stages.length - 1) return null;
  const end = x.burn.start + x.burn.duration;
  const next = infos[i + 1];
  if (next && !(end + 1 <= next.burn.start)) return null; // no room before the next burn
  const seps = plan.separations ?? [];
  if (activeAt(st, seps, end + 1) !== x.stage) return null; // already separated after it
  if (separationRefusal(plan, end + 1)) return null;
  const dry = x.m1 - emptyMass(st, x.stage) < 1e-6 * st.stages[x.stage].wetMass + 1e-9;
  return { time: end + 1, empty: dry, stage: x.stage };
}

/**
 * Change the stack (sandbox vehicle editor): `lower` stages under `sc`, or
 * null for a spacecraft alone delivered free to the parking orbit (format 1,
 * as before vehicles). A launch start becomes a vehicle launch when there
 * are lower stages. Nodes keep their requested delta-v and time; separations
 * beyond what the new stack can drop are removed (latest first).
 */
export function setStages(plan: MissionPlan, lower: readonly Spacecraft[] | null, sc: Spacecraft): MissionPlan {
  const nodes = nodesOf(plan).map((x) => x.node);
  const { lowerStages: _l, separations: _s, format: _f, model, ...rest } = plan;
  void _l; void _s; void _f;
  let start = rest.start;
  if (start.kind === 'launch') {
    const { ascent: _a, ...st } = start;
    void _a;
    start = lower && lower.length ? { ...st, ascent: 'vehicle' as const } : st;
  }
  const staged = !!lower && lower.length > 0;
  const keepSeps = staged ? (plan.separations ?? []).slice(0, Math.max(0, lower.length)) : [];
  const fresh = makePlan({ ...rest, start, spacecraft: sc, burns: [], ...(staged ? { lowerStages: lower.map((x) => ({ ...x, engines: x.engines.map((e) => ({ ...e })) })), separations: keepSeps } : {}) });
  const p: MissionPlan = { ...fresh, model };
  const out = rebuild(p, 0, nodes, false);
  // Drop separations the stack cannot take (they would drop the spacecraft).
  const first = stackOf(out).first;
  const n = vehicleStages(out).length;
  const max = Math.max(0, n - 1 - first);
  return (out.separations?.length ?? 0) > max ? rebuild({ ...out, separations: out.separations!.slice(0, max) }, 0, nodes, false) : out;
}

/**
 * Change the spacecraft. Nodes keep their requested delta-v and time (burn
 * times are recomputed for the new masses and engines); nodes on an engine
 * that no longer exists move to engine 0.
 */
export function setSpacecraft(plan: MissionPlan, sc: Spacecraft): MissionPlan {
  const nodes = nodesOf(plan).map((x) => ({ ...x.node, engine: x.node.engine < sc.engines.length ? x.node.engine : 0 }));
  return rebuild({ ...plan, spacecraft: sc }, 0, nodes);
}

/** Delta-v budget: total ideal delta-v of the spacecraft and what the nodes request. */
export function budget(plan: MissionPlan): { total: number; requested: number; remaining: number; propellant: number; nodes: NodeInfo[] } {
  // The spacecraft's own budget (in a staged plan, the lower stages' burns are not counted here).
  const sc = plan.spacecraft;
  const all = nodesOf(plan);
  const S = plan.lowerStages?.length ?? 0;
  const own = all.filter((n) => n.stage === S);
  // Ideal total with the engine of the first node (or engine 0).
  const e = sc.engines[own[0]?.burn.engine ?? 0] ?? sc.engines[0];
  const total = e.isp * G0 * Math.log(sc.wetMass / sc.dryMass);
  let requested = 0;
  for (const n of own) requested += Number.isFinite(dvMagnitude(n.node.dv)) ? dvMagnitude(n.node.dv) : 0;
  const mEnd = own.length ? own[own.length - 1].m1 : sc.wetMass;
  // Remaining with engine 0 from the mass left after all requested burns.
  const remaining = sc.engines[0].isp * G0 * Math.log(Math.max(mEnd, sc.dryMass) / sc.dryMass);
  return { total, requested, remaining, propellant: sc.wetMass - mEnd, nodes: all };
}

// ---------------------------------------------------------------------------
// Starting orbits (free start): Keplerian elements to a state relative to the body.

export interface OrbitElements {
  /** Periapsis and apoapsis altitude above the body's reference radius (BodyData.referenceRadius), m. */
  periAlt: number;
  apoAlt: number;
  /** Inclination to the body's equator (its pole; ICRF equator if unknown), deg. */
  incDeg: number;
  /** Longitude of the ascending node from the reference direction, deg. */
  raanDeg: number;
  /** Argument of periapsis, deg. */
  argPeDeg: number;
  /** True anomaly at the epoch, deg. */
  trueAnomalyDeg: number;
}

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/**
 * Equatorial basis of a body: z = pole (or ICRF z), x = ascending node of the
 * body's equator on the ICRF equator (or ICRF x when the pole is ICRF z).
 */
export function equatorialBasis(pole: readonly number[] | null): { x: V3; y: V3; z: V3 } {
  const z: V3 = pole ? unit([pole[0], pole[1], pole[2]]) : [0, 0, 1];
  const n = cross([0, 0, 1], z);
  const x: V3 = Math.hypot(n[0], n[1], n[2]) < 1e-9 ? [1, 0, 0] : unit(n);
  return { x, y: cross(z, x), z };
}

/** State [x y z vx vy vz] relative to the body (m, m/s) for orbit elements. Advisory planning maths (Math.*). */
export function stateFromElements(mu: number, radius: number, pole: readonly number[] | null, el: OrbitElements): number[] {
  const rp = radius + Math.min(el.periAlt, el.apoAlt);
  const ra = radius + Math.max(el.periAlt, el.apoAlt);
  const a = (rp + ra) / 2;
  const e = (ra - rp) / (ra + rp);
  const p = a * (1 - e * e);
  const nu = (el.trueAnomalyDeg * Math.PI) / 180;
  const r = p / (1 + e * Math.cos(nu));
  const h = Math.sqrt(mu * p);
  // Perifocal.
  const rPf = [r * Math.cos(nu), r * Math.sin(nu), 0];
  const vPf = [(-mu / h) * Math.sin(nu), (mu / h) * (e + Math.cos(nu)), 0];
  const D = Math.PI / 180;
  const [cO, sO] = [Math.cos(el.raanDeg * D), Math.sin(el.raanDeg * D)];
  const [ci, si] = [Math.cos(el.incDeg * D), Math.sin(el.incDeg * D)];
  const [cw, sw] = [Math.cos(el.argPeDeg * D), Math.sin(el.argPeDeg * D)];
  // Perifocal -> equatorial (3-1-3 rotation).
  const R = [
    [cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci, sO * si],
    [sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci, -cO * si],
    [sw * si, cw * si, ci],
  ];
  const mul = (v: number[]) => [0, 1, 2].map((i) => R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]);
  const rq = mul(rPf);
  const vq = mul(vPf);
  const B = equatorialBasis(pole);
  const toIcrf = (q: number[]) => [0, 1, 2].map((k) => q[0] * B.x[k] + q[1] * B.y[k] + q[2] * B.z[k]);
  return [...toIcrf(rq), ...toIcrf(vq)];
}

/** Inverse of stateFromElements for display (periapsis / apoapsis altitude, inclination); orbit-elements.ts does the work. Unbound orbits give apoAlt = Infinity. */
export function elementsFromState(mu: number, radius: number, pole: readonly number[] | null, s: readonly number[]): { periAlt: number; apoAlt: number; incDeg: number } {
  const B = equatorialBasis(pole);
  const o = osculating(mu, s, B);
  return { periAlt: o.rp - radius, apoAlt: o.ra - radius, incDeg: o.incDeg };
}

// ---------------------------------------------------------------------------
// Splitting a burn its stage cannot complete (planner and targeting).

/**
 * Node i asks more of its stage than the stage holds: return a plan where
 * that stage burns what it has (same direction, same ignition), a
 * separation follows one second after cutoff, and the next stage flies the
 * rest of the requested delta-v in the same direction right after. Null if
 * the burn is not short, is already on the spacecraft, or a separation
 * cannot go there. A first approximation: refine it (the corrector) after.
 */
export function splitAcrossSeparation(plan: MissionPlan, i: number): { plan: MissionPlan; first: number; second: number; available: number; rest: number } | null {
  const infos = nodesOf(plan);
  const x = infos[i];
  if (!x || !x.short) return null;
  const st = stackOf(plan);
  const k = x.stage;
  if (!st.staged || k >= st.stages.length - 1) return null;
  const sc = st.stages[k];
  const e = sc.engines[x.node.engine] ?? sc.engines[0];
  const ve = e.isp * G0;
  const empty = emptyMass(st, k);
  const available = ve * Math.log(x.m0 / empty) * (1 - 1e-9);
  const total = dvMagnitude(x.node.dv);
  if (!(available > 0) || !(total > available)) return null;
  const u = x.node.dv.map((v) => v / total) as Vec3;
  const dv1 = u.map((v) => v * available) as Vec3;
  const b1 = nodeToBurn({ ...x.node, dv: dv1 }, sc, x.m0);
  const start = x.burn.start;
  let p = updateNode(plan, i, { dv: dv1, t: start + b1.duration / 2 }).plan;
  const sepT = start + b1.duration + 1;
  if (separationRefusal(p, sepT)) return null;
  const r = addSeparation(p, sepT);
  if ('error' in r) return null;
  p = r.plan;
  const next = st.stages[k + 1];
  const m1 = emptyMass(st, k + 1) + (next.wetMass - next.dryMass);
  const rest = total - available;
  const dv2 = u.map((v) => v * rest) as Vec3;
  const b2 = nodeToBurn({ ...x.node, dv: dv2, engine: 0 }, next, m1);
  const a = addNode(p, { t: sepT + 1 + b2.duration / 2, dv: dv2, frame: x.node.frame, engine: 0 });
  return { plan: a.plan, first: i, second: a.index, available, rest };
}

/** Mass at which burn i's stage is empty (the stack above plus its dry mass): the cutoff a corrector must respect. */
export function stageCutoffMass(plan: MissionPlan, i: number): number {
  const st = stackOf(plan);
  const x = nodesOf(plan)[i];
  return x ? emptyMass(st, x.stage) : plan.spacecraft.dryMass;
}
