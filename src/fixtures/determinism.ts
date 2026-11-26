/**
 * Canonical determinism scenario. A browser page and test/determinism.test.ts both
 * run this and compare the final state bit-for-bit against EXPECTED_HEX, so any
 * engine whose physics drifts by even one ulp is caught.
 *
 * Do not change anything here without regenerating EXPECTED_HEX (and saying why):
 * the point is that these numbers never move.
 */
import { FixedBodies, propagate, type Burn } from '../physics/spacecraft';

export const GM_EARTH = 3.986004418e14;

/** Earth fixed at the origin. */
export const ephemeris = new FixedBodies([{ gm: GM_EARTH, position: [0, 0, 0] }]);

/** Periapsis of a 7000 km x ~13 700 km orbit (e ~ 0.32, i ~ 8 deg). */
export const y0: readonly number[] = [7_000_000, 0, 0, 0, 8_600, 1_200, 1_500];

export const t0 = 0;
/** About 4.7 orbits (period is roughly 10 500 s before the burn). */
export const t1 = 50_000;

/** A 400 s mixed-direction burn in the orbital frame during the second orbit. */
export const burns: readonly Burn[] = [
  {
    tStart: 20_000,
    duration: 400,
    thrust: 2_000,
    isp: 315,
    direction: [1, 0.25, -0.5],
    frame: { kind: 'orbital', body: 0 },
  },
];

export const options = { rtol: 1e-12, dryMass: 1_000 } as const;

export function runScenario(): Float64Array {
  return propagate(ephemeris, y0, t0, t1, burns, options).y;
}

/** Big-endian hex of the IEEE-754 bytes of each component. */
export function toHex(values: ArrayLike<number>): string[] {
  const view = new DataView(new ArrayBuffer(8));
  const out: string[] = [];
  for (let i = 0; i < values.length; i++) {
    view.setFloat64(0, values[i]);
    let s = '';
    for (let b = 0; b < 8; b++) s += view.getUint8(b).toString(16).padStart(2, '0');
    out.push(s);
  }
  return out;
}

/** Final [x, y, z, vx, vy, vz, mass] at t1, recorded on V8 (Node, vitest). */
export const EXPECTED_HEX: readonly string[] = [
  '411aa7a37bb3bc76',
  'c161fa6fe7646c9d',
  'c1356c1e6a20aff5',
  '40b9bf3496951c91',
  '40a87fbbb081cd3a',
  '40813171df732ba1',
  '409364190a6de257',
];
