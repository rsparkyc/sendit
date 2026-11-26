/**
 * Payload capacity of a catalogue vehicle under the ascent model (tooling:
 * ordinary Math allowed). Geometry from latitude and inclination:
 * pad speed V = omega R cos(lat); azimuth sin A = cos i / cos lat;
 * along-track V sin A, cross-track V cos A.
 */
import { ASCENT_BODIES, computeAscent } from '../../src/mission/ascent';
import type { Stage } from '../../src/mission/plan';
import type { VehicleSpec } from '../../src/mission/vehicles';

export const MU = 3.986004418e14;
export const RE = 6378136.6;
const OMEGA = 7.292115e-5;
const G0 = 9.80665;

export interface Orbit {
  readonly latDeg: number;
  readonly incDeg: number;
  /** Circular altitude, m (for GTO: the parking / perigee altitude). */
  readonly altitudeM: number;
  /** Delta-v the upper stage must still give after the parking orbit (GTO injection etc.), m/s. */
  readonly afterDv?: number;
}

export function geometry(latDeg: number, incDeg: number): { alongTrack: number; crossTrack: number } {
  const lat = (latDeg * Math.PI) / 180;
  const V = OMEGA * RE * Math.cos(lat);
  let s = Math.cos((incDeg * Math.PI) / 180) / Math.cos(lat);
  if (s > 1) s = 1;
  const c = Math.sqrt(1 - s * s);
  return { alongTrack: V * s, crossTrack: V * c };
}

/** Delta-v from a circular parking orbit at hp to an ellipse with apogee ha (perigee burn). */
export function perigeeBurn(hp: number, ha: number): number {
  const rp = RE + hp;
  const ra = RE + ha;
  return Math.sqrt((2 * MU * ra) / (rp * (rp + ra))) - Math.sqrt(MU / rp);
}

/** Largest payload (kg) the vehicle puts in the orbit, bisected to 1 kg. */
export function payload(v: VehicleSpec, o: Orbit): number {
  const ok = (p: number): boolean => {
    const stages: Stage[] = [...v.stages, { wetMass: p, dryMass: p, engines: [{ thrust: 1, isp: 1 }] }];
    const a = computeAscent(stages, { gm: MU, radius: RE, altitudeM: o.altitudeM }, geometry(o.latDeg, o.incDeg), ASCENT_BODIES.earth);
    if (!a.ok) return false;
    if (!o.afterDv) return true;
    // Rest of the upper stage, then any stage above it but below the payload.
    let need = o.afterDv;
    let m = a.massAtInsertion;
    for (let k = a.upperStage; k < v.stages.length; k++) {
      const s = v.stages[k];
      const F = s.engines.reduce((x, e) => x + e.thrust, 0);
      const ve = F / s.engines.reduce((x, e) => x + e.thrust / (e.isp * G0), 0);
      let above = p;
      for (let j = k + 1; j < v.stages.length; j++) above += v.stages[j].wetMass;
      const dry = above + s.dryMass;
      const can = ve * Math.log(m / dry);
      if (can >= need) return true;
      need -= can;
      m = above;
    }
    return false;
  };
  let lo = 0;
  let hi = 200000;
  if (!ok(1)) return 0;
  while (hi - lo > 1) {
    const mid = 0.5 * (lo + hi);
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
