/**
 * Test tooling for direct injection (ordinary Math): payload of a vehicle by
 * direct injection or through a parking orbit, for a target C3.
 */
import { ASCENT_BODIES, computeAscent, computeDirectAscent, type AscentGeometry } from '../../src/mission/ascent';
import type { Stage } from '../../src/mission/plan';
import { G0 } from '../../src/physics/spacecraft';

export const EARTH = { gm: 3.986004418e14, radius: 6378136.6 };
const dummy = (m: number): Stage => ({ wetMass: m, dryMass: m, engines: [{ thrust: 1, isp: 300 }] });

/** Largest m in [lo, hi] with ok(m), assuming ok is monotone (true then false). NaN if ok(lo) fails. */
function maxMass(ok: (m: number) => boolean, lo = 1, hi = 100000): number {
  if (!ok(lo)) return NaN;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function directPayload(lower: readonly Stage[], c3: number, hI: number, geom: AscentGeometry): number {
  return maxMass((m) => {
    const a = computeDirectAscent([...lower, dummy(m)], { ...EARTH, c3, injectionAltitudeM: hI }, geom, ASCENT_BODIES.earth);
    return a.ok && a.shortfall === 0 && a.achievedC3 >= c3 - 1e4;
  });
}

/** Impulsive departure delta-v from a circular orbit of altitude h to C3. */
export function departureDv(c3: number, h: number): number {
  const r = EARTH.radius + h;
  return Math.sqrt(c3 + (2 * EARTH.gm) / r) - Math.sqrt(EARTH.gm / r);
}

/**
 * Parking route: the ascent to a circular orbit at h, then an impulsive
 * departure burn with what the upper stage has left (and the next stages
 * below the spacecraft, in order).
 */
export function parkingRoute(lower: readonly Stage[], m: number, c3: number, h: number, geom: AscentGeometry): { ok: boolean; ascentDv: number; departureDv: number; reason?: string } {
  const stages = [...lower, dummy(m)];
  const a = computeAscent(stages, { ...EARTH, altitudeM: h }, geom, ASCENT_BODIES.earth);
  const need = departureDv(c3, h);
  if (!a.ok) return { ok: false, ascentDv: NaN, departureDv: need, reason: a.reason };
  let mass = a.massAtInsertion;
  let left = need;
  for (let k = a.upperStage; k < stages.length - 1 && left > 0; k++) {
    const e = stages[k].engines[0];
    if (k === a.upperStage && e.restartable === false) break;
    let above = 0;
    for (let j = k + 1; j < stages.length; j++) above += stages[j].wetMass;
    const dry = above + stages[k].dryMass;
    const ve = e.isp * G0;
    const avail = ve * Math.log(mass / dry);
    left -= avail;
    mass = above;
  }
  return { ok: left <= 0, ascentDv: a.deltaV, departureDv: need };
}

export function parkingPayload(lower: readonly Stage[], c3: number, h: number, geom: AscentGeometry): number {
  return maxMass((m) => parkingRoute(lower, m, c3, h, geom).ok);
}
