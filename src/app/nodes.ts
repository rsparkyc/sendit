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
 */
import type { MissionPlan, PlanBurn, PlanFrame, Spacecraft } from './mission-layer';

/** Standard gravity, m/s^2 (defines Isp; same constant as the physics). */
export const G0 = 9.80665;

export type Vec3 = [number, number, number];

export interface ManeuverNode {
  /** Burn centre, seconds after the plan epoch. */
  t: number;
  /** Requested delta-v, m/s: (prograde, normal, radial-out) for an orbital frame, ICRF x y z for inertial. */
  dv: Vec3;
  frame: PlanFrame;
  /** Index into spacecraft.engines. */
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

/** Propellant a burn requests, kg (thrust / ve * duration), capped by what is left. */
function propellant(burn: PlanBurn, sc: Spacecraft, m: number): number {
  const e = sc.engines[burn.engine] ?? sc.engines[0];
  return Math.min((e.thrust / (e.isp * G0)) * burn.duration, Math.max(0, m - sc.dryMass));
}

/** Every burn of the plan as a node, with its mass chain. */
export function nodesOf(plan: MissionPlan): NodeInfo[] {
  const sc = plan.spacecraft;
  let m = sc.wetMass;
  return plan.burns.map((burn) => {
    const node = burnToNode(burn, sc, m);
    const e = sc.engines[burn.engine] ?? sc.engines[0];
    const want = (e.thrust / (e.isp * G0)) * burn.duration;
    const used = propellant(burn, sc, m);
    const info = { node, burn, m0: m, m1: m - used, short: want > used * (1 + 1e-12) };
    m -= used;
    return info;
  });
}

function sortNodes(nodes: ManeuverNode[]): ManeuverNode[] {
  return nodes.map((n, i) => ({ n, i })).sort((a, b) => a.n.t - b.n.t || a.i - b.i).map((x) => x.n);
}

/**
 * Plan whose burns are plan.burns[0..keep) unchanged, followed by burns for
 * `nodes` (all of them, sorted by time) with the mass chain continuing.
 */
function rebuild(plan: MissionPlan, keep: number, nodes: ManeuverNode[]): MissionPlan {
  const sc = plan.spacecraft;
  const burns: PlanBurn[] = plan.burns.slice(0, keep);
  let m = sc.wetMass;
  for (const b of burns) m -= propellant(b, sc, m);
  for (const n of nodes) {
    const b = nodeToBurn(n, sc, m);
    burns.push(b);
    m -= propellant(b, sc, m);
  }
  return { ...plan, burns };
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
  const sc = plan.spacecraft;
  const nodes = nodesOf(plan);
  // Ideal total with the engine of the first node (or engine 0).
  const e = sc.engines[nodes[0]?.burn.engine ?? 0] ?? sc.engines[0];
  const total = e.isp * G0 * Math.log(sc.wetMass / sc.dryMass);
  let requested = 0;
  for (const n of nodes) requested += Number.isFinite(dvMagnitude(n.node.dv)) ? dvMagnitude(n.node.dv) : 0;
  const mEnd = nodes.length ? nodes[nodes.length - 1].m1 : sc.wetMass;
  // Remaining with engine 0 from the mass left after all requested burns.
  const remaining = sc.engines[0].isp * G0 * Math.log(Math.max(mEnd, sc.dryMass) / sc.dryMass);
  return { total, requested, remaining, propellant: sc.wetMass - mEnd, nodes };
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

/** Inverse of stateFromElements for display (periapsis / apoapsis altitude, inclination). Unbound orbits give apoAlt = Infinity. */
export function elementsFromState(mu: number, radius: number, pole: readonly number[] | null, s: readonly number[]): { periAlt: number; apoAlt: number; incDeg: number } {
  const r: V3 = [s[0], s[1], s[2]];
  const v: V3 = [s[3], s[4], s[5]];
  const rn = Math.hypot(...r);
  const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const h = cross(r, v);
  const hn = Math.hypot(...h);
  const energy = v2 / 2 - mu / rn;
  const a = -mu / (2 * energy);
  const e = Math.sqrt(Math.max(0, 1 - (hn * hn) / (mu * a)));
  const B = equatorialBasis(pole);
  const incDeg = (Math.acos(Math.max(-1, Math.min(1, (h[0] * B.z[0] + h[1] * B.z[1] + h[2] * B.z[2]) / hn))) * 180) / Math.PI;
  const periAlt = (energy < 0 ? a * (1 - e) : (hn * hn) / mu / (1 + e)) - radius;
  const apoAlt = energy < 0 ? a * (1 + e) - radius : Infinity;
  return { periAlt, apoAlt, incDeg };
}
