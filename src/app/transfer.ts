/**
 * Pure helpers for the planning aids: B-plane aim from a requested altitude
 * and pass side, corrector staging epochs, plan <-> physics burn conversion,
 * the plan prefix used to get the state before a burn, the measured closest
 * approach from a replay, and launch opportunities into a plane containing a
 * departure asymptote. Advisory maths (Math.*); nothing here enters a replay
 * except through ordinary nodes.
 */
import { asymptotePlaneNormals, azimuthAllowed, launchSite, planeCrossings, simulationStartOffset, type MissionPlan, type PlanBurn, type TrajectoryEvent } from './mission-layer';
import { burnToNode, nodesOf, type ManeuverNode } from './nodes';

/** Physics burn shape (absolute times, body index), mirrored here to keep this module pure. */
export interface AbsBurn {
  tStart: number;
  duration: number;
  thrust: number;
  isp: number;
  direction: readonly [number, number, number];
  frame: { kind: 'inertial' } | { kind: 'orbital'; body: number };
}

/**
 * Pass side in the B-plane: angle theta from +T (T in the ecliptic, R = S x T).
 * 0: prograde pass (orbit normal toward the ecliptic north pole), 180:
 * retrograde, 90: B points along +R, i.e. passes south of the body; 270: north.
 * null: keep the side the trajectory already has.
 */
export type PassSide = number | null;

export const PASS_SIDES: readonly { value: string; label: string; theta: PassSide }[] = [
  { value: 'keep', label: 'Keep current side', theta: null },
  { value: '0', label: 'Prograde (ecliptic sense)', theta: 0 },
  { value: '180', label: 'Retrograde', theta: 180 },
  { value: '270', label: 'Over the north pole', theta: 270 },
  { value: '90', label: 'Under the south pole', theta: 90 },
];

/** B-plane aim point for magnitude b and side theta (deg). */
export function bPlaneAim(b: number, thetaDeg: number): { bt: number; br: number } {
  const t = (thetaDeg * Math.PI) / 180;
  return { bt: b * Math.cos(t), br: b * Math.sin(t) };
}

/** Side angle (deg, 0..360) of an existing B-plane point; 0 if undefined. */
export function sideOf(bt: number, br: number): number {
  if (!Number.isFinite(bt) || !Number.isFinite(br) || (bt === 0 && br === 0)) return 0;
  const d = (Math.atan2(br, bt) * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
}

/**
 * Corrector staging epochs before closest approach, from the time to cross
 * the sphere of influence tau = soi / vinf: the first B-plane stage at 2 tau
 * (clamped to 2 h .. 5 days), the second at tau / 4 (30 min .. 12 h). For
 * Mars this is the measured recipe (about 4-5 days, then 12 h).
 */
export function stagingOffsets(soi: number, vinf: number): { first: number; second: number } {
  const tau = soi / Math.max(vinf, 100);
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  return { first: clamp(2 * tau, 2 * 3600, 5 * 86400), second: clamp(tau / 4, 1800, 12 * 3600) };
}

/** Physics form of plan burn i (absolute times). */
export function toAbsBurn(plan: MissionPlan, i: number, bodyIndex: (id: string) => number): AbsBurn {
  const b = plan.burns[i];
  const e = plan.spacecraft.engines[b.engine];
  return {
    tStart: plan.epoch + b.start,
    duration: b.duration,
    thrust: e.thrust,
    isp: e.isp,
    direction: [b.direction[0], b.direction[1], b.direction[2]],
    frame: b.frame.kind === 'orbital' ? { kind: 'orbital', body: bodyIndex(b.frame.body) } : { kind: 'inertial' },
  };
}

/** Node for a corrected physics burn replacing plan burn i (same engine and frame). */
export function nodeFromAbsBurn(plan: MissionPlan, i: number, b: AbsBurn): ManeuverNode {
  const old = plan.burns[i];
  const n = Math.hypot(b.direction[0], b.direction[1], b.direction[2]);
  const pb: PlanBurn = { start: b.tStart - plan.epoch, duration: b.duration, engine: old.engine, direction: [b.direction[0] / n, b.direction[1] / n, b.direction[2] / n], frame: old.frame };
  return burnToNode(pb, plan.spacecraft, nodesOf(plan)[i].m0);
}

/**
 * Plan that flies only the burns before index `i` up to mission time `until`
 * (to read the state just before burn i), or null if `until` is not after
 * the simulation start.
 */
export function prefixPlan(plan: MissionPlan, i: number, until: number): MissionPlan | null {
  if (!(until > simulationStartOffset(plan.start))) return null;
  return { ...plan, burns: plan.burns.slice(0, i).filter((b) => b.start + b.duration <= until), duration: until };
}

/** Mission time a little before burn i ignites (up to 10 min, at most half the gap to the start / previous burn). */
export function beforeBurn(plan: MissionPlan, i: number): number | null {
  const b = plan.burns[i];
  const prevEnd = i > 0 ? plan.burns[i - 1].start + plan.burns[i - 1].duration : simulationStartOffset(plan.start);
  const gap = b.start - prevEnd;
  if (!(gap > 2)) return null;
  return b.start - Math.min(600, gap / 2);
}

/** Closest approach to `body` in a replay's events (periapsis or impact), or null. */
export function measuredClosest(events: readonly TrajectoryEvent[], body: string, after = -Infinity): { t: number; altitude: number; speed: number; impact: boolean } | null {
  let best: { t: number; altitude: number; speed: number; impact: boolean } | null = null;
  for (const e of events) {
    if (e.body !== body || e.t < after) continue;
    if (e.kind !== 'periapsis' && e.kind !== 'impact' && e.kind !== 'atmosphere-entry') continue;
    if (!best || e.altitude < best.altitude) best = { t: e.t, altitude: e.altitude, speed: e.speed, impact: e.kind !== 'periapsis' };
  }
  return best;
}

export interface LaunchOpportunity {
  /** Liftoff, s TDB. */
  t: number;
  azimuthDeg: number;
  allowed: boolean;
  /** Which of the two planes containing the asymptote (0 or 1). */
  plane: number;
}

/**
 * Liftoff times and inertial azimuths in [tStart, tEnd] that put the parking
 * orbit (inclination incDeg) in a plane containing the departure asymptote
 * direction vInf, sorted by time. Uses the mission layer's launch helpers.
 */
export function launchOpportunities(siteId: string, vInf: readonly number[], tRef: number, incDeg: number, tStart: number, tEnd: number): LaunchOpportunity[] {
  const site = launchSite(siteId);
  const out: LaunchOpportunity[] = [];
  asymptotePlaneNormals(vInf, incDeg, tRef).forEach((n, plane) => {
    for (const c of planeCrossings(site, n, tStart, tEnd)) {
      // Each plane is crossed twice a day; only the crossing whose launch direction is prograde-ish in that plane counts.
      out.push({ t: c.t, azimuthDeg: c.azimuthDeg, allowed: c.azimuthAllowed && azimuthAllowed(site, c.azimuthDeg), plane });
    }
  });
  return out.sort((a, b) => a.t - b.t);
}

/** Default parking inclination for an asymptote: at least the site's latitude and the asymptote's declination, plus a margin. */
export function defaultInclination(latDeg: number, dlaDeg: number): number {
  return Math.min(89, Math.max(Math.abs(latDeg), Math.abs(dlaDeg)) + 1);
}
