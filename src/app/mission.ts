/**
 * The hard-coded demo mission: low Earth parking orbit, one finite prograde
 * trans-lunar injection burn, ten-day coast. Runs in the worker.
 *
 * The parking orbit lies in the Moon's current orbital plane about the Earth.
 * The burn is centred roughly opposite where the Moon will be at arrival; a
 * small search over ignition time and burn duration then picks the pair with
 * the closest lunar approach. Everything is propagated with the real N-body
 * ephemeris (all bodies, J2, solar 1PN), so this is a physical trajectory.
 */
import { BODIES, bodyIndex, propagateDense, type Ephemeris, type ThrustBurn } from './physics';
import type { MissionInfo } from './protocol';
import { calendarToTdb, DAY } from './time';

export const MISSION_LAUNCH = calendarToTdb({ year: 2027, month: 1, day: 10, hour: 0, minute: 0, second: 0 });
export const MISSION_DURATION = 10 * DAY;
const ALTITUDE = 200e3; // m
const G0 = 9.80665;
const VEHICLE = { mass: 40000, dryMass: 15000, thrust: 110e3, isp: 450 };
const NOMINAL_DV = 3130; // m/s from a 200 km circular orbit: near-escape, apogee at lunar distance
const COAST_BEFORE_BURN = 900; // s of parking orbit before ignition (nominal)
const TRANSFER_TIME = 3.3 * DAY; // rough TLI-to-Moon time used only for aiming

interface Plan {
  y0: Float64Array;
  burn: ThrustBurn;
}

function cross(a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function unit(a: readonly number[]): [number, number, number] {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
}

/** Earth and Moon indices from the data (never by position in the list). */
export function missionBodies(): { earth: number; moon: number } {
  const earth = bodyIndex('earth');
  const moon = bodyIndex('moon');
  if (earth < 0 || moon < 0) throw new Error('demo mission needs bodies "earth" and "moon"');
  return { earth, moon };
}

function plan(eph: Ephemeris, ignitionShift: number, dvScale: number): Plan {
  const { earth, moon } = missionBodies();
  const n = eph.count;
  const pos = new Float64Array(3 * n);
  const vel = new Float64Array(3 * n);
  const t0 = MISSION_LAUNCH;
  if (!eph.evaluate(t0, pos, vel)) throw new Error('mission start not covered');
  const rE = pos.slice(3 * earth, 3 * earth + 3);
  const vE = vel.slice(3 * earth, 3 * earth + 3);
  const rM = [pos[3 * moon] - rE[0], pos[3 * moon + 1] - rE[1], pos[3 * moon + 2] - rE[2]];
  const vM = [vel[3 * moon] - vE[0], vel[3 * moon + 1] - vE[1], vel[3 * moon + 2] - vE[2]];
  const h = unit(cross(rM, vM));
  const e1 = unit(rM);
  const e2 = cross(h, e1);

  // Where the Moon will be at arrival, as an angle in the plane.
  const tArr = t0 + COAST_BEFORE_BURN + TRANSFER_TIME;
  eph.evaluate(tArr, pos, null);
  const ax = pos[3 * moon] - pos[3 * earth];
  const ay = pos[3 * moon + 1] - pos[3 * earth + 1];
  const az = pos[3 * moon + 2] - pos[3 * earth + 2];
  const arrivalAngle = Math.atan2(ax * e2[0] + ay * e2[1] + az * e2[2], ax * e1[0] + ay * e1[1] + az * e1[2]);

  const mu = BODIES[earth].gm;
  const r = BODIES[earth].radius + ALTITUDE;
  const v = Math.sqrt(mu / r);
  const omega = v / r;
  const mdot = VEHICLE.thrust / (VEHICLE.isp * G0);
  const dv = NOMINAL_DV * dvScale;
  const m1 = VEHICLE.mass * Math.exp(-dv / (VEHICLE.isp * G0));
  const duration = (VEHICLE.mass - m1) / mdot;
  const coast = COAST_BEFORE_BURN + ignitionShift;
  // Burn midpoint opposite the arrival point. The vehicle sweeps less angle during the burn than
  // at circular speed... it actually speeds up, so this aim is rough: the search corrects it.
  const midAngle = arrivalAngle - Math.PI;
  const phi = midAngle - omega * (COAST_BEFORE_BURN + duration / 2);
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const y0 = new Float64Array(7);
  for (let k = 0; k < 3; k++) {
    y0[k] = rE[k] + r * (c * e1[k] + s * e2[k]);
    y0[3 + k] = vE[k] + v * (-s * e1[k] + c * e2[k]);
  }
  y0[6] = VEHICLE.mass;
  return {
    y0,
    burn: { tStart: t0 + coast, duration, thrust: VEHICLE.thrust, isp: VEHICLE.isp, direction: [1, 0, 0], body: earth },
  };
}

/** Closest approach to the Moon of a plan, propagated to tEnd (coarse sampling). */
function closest(eph: Ephemeris, p: Plan, tEnd: number): { d: number; t: number } {
  const { moon } = missionBodies();
  const pos = new Float64Array(3 * eph.count);
  let best = { d: Infinity, t: 0 };
  propagateDense(eph, p.y0, MISSION_LAUNCH, tEnd, [p.burn], 4, (t, y) => {
    eph.evaluate(t, pos, null);
    const d = Math.hypot(y[0] - pos[3 * moon], y[1] - pos[3 * moon + 1], y[2] - pos[3 * moon + 2]);
    if (d < best.d) best = { d, t };
  }, VEHICLE.dryMass);
  return best;
}

export function missionChunkTimes(): [number, number] {
  return [MISSION_LAUNCH, MISSION_LAUNCH + MISSION_DURATION];
}

/** Plan, search and propagate the demo. Requires the mission span to be covered. */
export function runMission(eph: Ephemeris): { samples: Float64Array; info: MissionInfo } {
  const { earth, moon } = missionBodies();
  const s0 = performance.now();
  // Coarse search: ignition shifts across ~ +-35 degrees of parking orbit, three burn sizes.
  const minD = BODIES[moon].radius + 100e3; // reject impacts and grazes
  const searchEnd = MISSION_LAUNCH + 6 * DAY;
  let best = { d: Infinity, t: 0, shift: 0, scale: 1 };
  const tryPlan = (shift: number, scale: number) => {
    const c = closest(eph, plan(eph, shift, scale), searchEnd);
    if (c.d < best.d && c.d > minD) best = { ...c, shift, scale };
  };
  for (const scale of [1, 1.01, 1.02, 1.03, 1.04]) for (let shift = -540; shift <= 540; shift += 90) tryPlan(shift, scale);
  // Refine the ignition time around the best.
  const coarse = best;
  for (let shift = coarse.shift - 80; shift <= coarse.shift + 80; shift += 10) tryPlan(shift, coarse.scale);
  const bestPlan = plan(eph, best.shift, best.scale);
  const searchMs = performance.now() - s0;

  const s1 = performance.now();
  const out: number[] = [];
  let lastT = -Infinity;
  const r = propagateDense(eph, bestPlan.y0, MISSION_LAUNCH, MISSION_LAUNCH + MISSION_DURATION, [bestPlan.burn], 16, (t, y) => {
    if (!(t > lastT)) return;
    lastT = t;
    out.push(t, y[0], y[1], y[2], y[3], y[4], y[5]);
  }, VEHICLE.dryMass);
  const propagateMs = performance.now() - s1;
  const samples = Float64Array.from(out);
  const finalMass = r.y[6];
  return {
    samples,
    info: {
      name: 'Demo TLI',
      launch: MISSION_LAUNCH,
      end: MISSION_LAUNCH + MISSION_DURATION,
      burnStart: bestPlan.burn.tStart,
      burnEnd: bestPlan.burn.tStart + bestPlan.burn.duration,
      deltaV: VEHICLE.isp * G0 * Math.log(VEHICLE.mass / finalMass),
      closestApproach: best.d,
      closestApproachTime: best.t,
      center: earth,
      target: moon,
      propagateMs,
      searchMs,
      steps: r.steps,
    },
  };
}
