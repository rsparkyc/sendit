/** Shared Earth->Mars / Earth->Venus first-guess cases for the planning tests. */
import type { ChebyshevEphemeris } from '../../src/physics/chebyshev-ephemeris';
import { J2000_BODIES } from '../../src/physics/solar-system';
import { findBody, utcToTdb } from '../../src/planning/bodies';
import { circularParkingState, parkingNormalForAsymptote, type Engine } from '../../src/planning/departure';
import { gridMinimum, PorkchopJob, type PorkchopSpec } from '../../src/planning/porkchop';

export const DAY = 86400;
export const DEG = Math.PI / 180;
export const EARTH = findBody(J2000_BODIES, 'earth');
export const MOON = findBody(J2000_BODIES, 'moon');
export const SUN = findBody(J2000_BODIES, 'sun');
/** A Centaur-class upper stage: 50 kN, Isp 450 s, 20 t in a 200 km parking orbit. */
export const ENGINE: Engine = { thrust: 50e3, isp: 450 };
export const MASS = 20000;
export const EPHEM_SPAN: [number, number] = [utcToTdb(2026, 1, 1), utcToTdb(2028, 1, 1)];

export interface FirstGuessCase {
  name: string;
  spec: PorkchopSpec;
}

export const CASES: FirstGuessCase[] = [
  {
    name: 'Earth->Mars 2026',
    spec: {
      departure: 'earth', arrival: 'mars',
      departureTimes: { start: utcToTdb(2026, 9, 15), end: utcToTdb(2026, 12, 15), count: 92 },
      arrivalTimes: { start: utcToTdb(2027, 6, 1), end: utcToTdb(2027, 11, 1), count: 154 },
      arrivalOrbit: { kind: 'flyby' },
    },
  },
  {
    name: 'Earth->Venus 2026',
    spec: {
      departure: 'earth', arrival: 'venus',
      departureTimes: { start: utcToTdb(2026, 3, 1), end: utcToTdb(2026, 8, 31), count: 184 },
      flightTimes: { start: 80 * DAY, end: 200 * DAY, count: 121 },
      arrivalOrbit: { kind: 'flyby' },
    },
  },
];

/** Set up a case: minimum-C3 porkchop point and a parking orbit whose plane contains the asymptote. */
export function setupCase(e: ChebyshevEphemeris, c: FirstGuessCase) {
  const job = new PorkchopJob(e, J2000_BODIES, c.spec);
  job.step(job.total);
  const g = job.grid;
  const k = gridMinimum(g.c3).index;
  const i = k % g.nDep;
  const j = (k - i) / g.nDep;
  const tDep = g.depTimes[i];
  const tArr = g.yMode === 'arrival' ? g.yValues[j] : tDep + g.yValues[j];
  const p = job.point(tDep, tArr)!;
  const n = parkingNormalForAsymptote(p.vInfDepVec, 28.5 * DEG)!;
  const t0 = tDep - 3 * 3600;
  const parking = circularParkingState(e, EARTH, t0, n, J2000_BODIES[EARTH].radius + 200e3, 0, MASS);
  return { p, tDep, tArr, t0, parking, target: findBody(J2000_BODIES, c.spec.arrival) };
}

