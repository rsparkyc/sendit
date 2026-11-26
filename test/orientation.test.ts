/**
 * One source of truth for body orientation (physics model 2):
 *  - the physics pole (src/physics/orientation.ts, dmath, tabulated) against
 *    the IAU WGCCRE model of pck00011 evaluated independently here (Math),
 *    for every body with a J2, at dates from 1950 to 2100, plus anchor values;
 *  - display orientation (src/app/body-rotation.ts: textures, drawn axis and
 *    equator) against physics orientation, full rotation, every body;
 *  - the launch code's Earth (src/mission/earth-orientation.ts) against physics;
 *  - the J2000 pole vectors in the body data against the model;
 *  - the field is blind to the pole's sense (Uranus: the satellite ephemeris
 *    uses the spin pole, the IAU the north pole).
 */
import { describe, expect, it } from 'vitest';
import { IAU_ROTATION as DISPLAY_ROTATION, bodyToIcrf as displayBodyToIcrf } from '../src/app/body-rotation';
import { EARTH_ROTATION, EARTH_ROTATION_IAU, poleAt as launchPoleAt } from '../src/mission/earth-orientation';
import { addZonalAccelerations, type ZonalHarmonic } from '../src/physics/nbody';
import { IAU_ROTATION, IAU_ROTATION_SOURCE, PoleTable, bodyToIcrf, poleAt, type IauRotation } from '../src/physics/orientation';
import { J2000_BODIES, oblatenessOf } from '../src/physics/solar-system';

const DAY = 86400;
const YEAR = 365.25 * DAY;
const CENTURY = 36525 * DAY;
const R = Math.PI / 180;
/** 1950, 1979 (Voyager), 2000, 2025, 2050, 2100 and a few odd times (s TDB from J2000). */
const DATES = [-50 * YEAR, -20.5 * YEAR + 3.3 * DAY, 0, 0.37 * DAY, 25 * YEAR + 0.81 * DAY, 50 * YEAR, 100 * YEAR - 0.2 * DAY];

/** IAU pole (RA, Dec in degrees) by the pck formula, written out independently with Math. */
function iauRaDec(m: IauRotation, t: number): [number, number] {
  const T = t / CENTURY;
  let ra = m.ra[0] + m.ra[1] * T + (m.ra[2] ?? 0) * T * T;
  let dec = m.dec[0] + m.dec[1] * T + (m.dec[2] ?? 0) * T * T;
  for (const n of m.nut ?? []) {
    const A = (n.angle[0] + n.angle[1] * T + (n.angle[2] ?? 0) * T * T) * R;
    ra += n.ra * Math.sin(A);
    dec += n.dec * Math.cos(A);
  }
  return [ra, dec];
}
const unit = (ra: number, dec: number) => [Math.cos(dec * R) * Math.cos(ra * R), Math.cos(dec * R) * Math.sin(ra * R), Math.sin(dec * R)];
const angle = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(Math.hypot(c[0], c[1], c[2]), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
};
const J2_BODIES = J2000_BODIES.filter((b) => b.j2 !== undefined).map((b) => b.id);

describe('physics pole model', () => {
  it('covers every body with a J2, from the generated pck00011 constants', () => {
    expect(J2_BODIES).toEqual(['sun', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
    for (const id of J2_BODIES) expect(oblatenessOf(J2000_BODIES.find((b) => b.id === id)!)!.rotation, id).toBe(IAU_ROTATION[id]);
    expect(IAU_ROTATION_SOURCE).toMatch(/pck00011\.tpc/);
  });

  it('matches the IAU model at dates from 1950 to 2100 (tabulated and exact)', () => {
    const lines: string[] = [];
    for (const id of J2_BODIES) {
      const m = IAU_ROTATION[id];
      const tab = new PoleTable(m);
      const p = new Float64Array(3);
      const q = new Float64Array(3);
      let worstTab = 0;
      let worstExact = 0;
      for (const t of DATES) {
        const [ra, dec] = iauRaDec(m, t);
        const ref = unit(ra, dec);
        tab.at(t, p);
        poleAt(m, t, q);
        worstTab = Math.max(worstTab, angle(p, ref));
        worstExact = Math.max(worstExact, angle(q, ref));
      }
      lines.push(`${id.padEnd(8)} table ${(worstTab / R).toExponential(1)} deg, exact ${(worstExact / R).toExponential(1)} deg`);
      // Exact: the same formula, dmath against Math (~1e-15 rad). Table: the
      // cubic-Hermite interpolation error, largest for the Moon's 13.6 d term.
      expect(worstExact, id).toBeLessThan(1e-13);
      expect(worstTab, id).toBeLessThan(1e-8);
    }
    console.log(`physics pole vs the IAU model, worst over ${DATES.length} dates:\n${lines.join('\n')}`);
  });

  it('reproduces anchor values (pck00011 formula, evaluated by hand)', () => {
    // RA, Dec of the north pole at J2000 with the periodic terms (the Moon's E1
    // term alone moves it 1.5 deg, Mars's long-period terms 1.6 deg, Neptune's N 0.5 deg),
    // and Earth's precessed pole in 2050.
    const anchors: [string, number, number, number][] = [
      ['moon', 0, 266.857733445, 65.641102748],
      ['mars', 0, 317.680854407, 52.886439275],
      ['neptune', 0, 299.333738959, 42.950359022],
      ['uranus', 0, 257.311, -15.175],
      ['earth', 50 * YEAR, -0.3205, 89.7215],
    ];
    const p = new Float64Array(3);
    for (const [id, t, ra, dec] of anchors) {
      new PoleTable(IAU_ROTATION[id]).at(t, p);
      expect(angle(p, unit(ra, dec)) / R, id).toBeLessThan(1e-7);
    }
  });

  it('table vs exact series: interpolation error over 1950-2100, every 0.1 d near nodes and at random times', () => {
    let worst = 0;
    let who = '';
    for (const id of J2_BODIES) {
      const m = IAU_ROTATION[id];
      const tab = new PoleTable(m);
      const p = new Float64Array(3);
      const q = new Float64Array(3);
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      for (let k = 0; k < 4000; k++) {
        const t = (rnd() * 150 - 50) * YEAR;
        tab.at(t, p);
        poleAt(m, t, q);
        const a = angle(p, q);
        if (a > worst) [worst, who] = [a, id];
      }
    }
    console.log(`pole table vs exact series: worst ${(worst / R).toExponential(2)} deg (${who})`);
    expect(worst / R).toBeLessThan(1e-6);
  });

  it('is a pure function of time: the same bits in any query order', () => {
    const m = IAU_ROTATION.moon;
    const times = Array.from({ length: 300 }, (_, i) => (i - 150) * 0.37 * DAY + 0.123);
    const a = new PoleTable(m);
    const ref = times.map((t) => {
      const o = new Float64Array(3);
      a.at(t, o);
      return Array.from(o);
    });
    const b = new PoleTable(m);
    const order = [...times.keys()].reverse().concat([...times.keys()].filter((i) => i % 7 === 3));
    for (const i of order) {
      const o = new Float64Array(3);
      b.at(times[i], o);
      for (let k = 0; k < 3; k++) expect(Object.is(o[k], ref[i][k])).toBe(true);
    }
  });
});

describe('one orientation for physics, display and launch code', () => {
  it('display rotation (texture, axis, equator) equals the physics rotation for every body', () => {
    expect(DISPLAY_ROTATION).toBe(IAU_ROTATION);
    const lines: string[] = [];
    let worstAll = 0;
    for (const id of Object.keys(IAU_ROTATION)) {
      const m = IAU_ROTATION[id];
      const tab = new PoleTable(m);
      const p = new Float64Array(3);
      let worstR = 0;
      let worstPole = 0;
      for (const t of DATES) {
        const d = displayBodyToIcrf(m, t);
        const f = bodyToIcrf(m, t);
        for (let k = 0; k < 9; k++) worstR = Math.max(worstR, Math.abs(d[k] - f[k]));
        tab.at(t, p);
        worstPole = Math.max(worstPole, angle(p, [d[2], d[5], d[8]]));
      }
      worstAll = Math.max(worstAll, worstR);
      lines.push(`${id.padEnd(8)} rotation ${worstR.toExponential(1)}, pole (field) ${(worstPole / R).toExponential(1)} deg`);
      // Display: Math.sin; physics: dmath, and W reduced in a different order (~1e-10 deg).
      expect(worstR, id).toBeLessThan(1e-9);
      expect(worstPole, id).toBeLessThan(1e-8);
    }
    console.log(`display vs physics orientation, worst over ${DATES.length} dates:\n${lines.join('\n')}`);
  });

  it("launch code's Earth: same constants, and its pole equals the physics pole", () => {
    for (const m of [EARTH_ROTATION, EARTH_ROTATION_IAU]) {
      expect([m.ra0, m.ra1, m.dec0, m.dec1]).toEqual([IAU_ROTATION.earth.ra[0], IAU_ROTATION.earth.ra[1], IAU_ROTATION.earth.dec[0], IAU_ROTATION.earth.dec[1]]);
    }
    expect([EARTH_ROTATION_IAU.w0, EARTH_ROTATION_IAU.wDot]).toEqual([IAU_ROTATION.earth.pm[0], IAU_ROTATION.earth.pm[1]]);
    const tab = new PoleTable(IAU_ROTATION.earth);
    const p = new Float64Array(3);
    for (const t of DATES) {
      tab.at(t, p);
      expect(angle(p, launchPoleAt(EARTH_ROTATION, t))).toBeLessThan(1e-12);
    }
  });

  it('body data J2000 poles are the IAU model at J2000 (periodic terms included)', () => {
    const q = new Float64Array(3);
    for (const b of J2000_BODIES) {
      if (!b.pole) continue;
      poleAt(IAU_ROTATION[b.id], 0, q);
      expect(angle(b.pole, q), b.id).toBeLessThan(1e-12);
    }
  });

  it('the zonal field is blind to the sense of the pole (bit for bit)', () => {
    // Uranus: ura182 gives the spin (angular-momentum) pole RA 77.31, Dec +15.17;
    // the IAU north pole is RA 257.31, Dec -15.18, the opposite direction to 0.004 deg.
    const pole = unit(257.311, -15.175) as [number, number, number];
    const gm = [5.8e15, 1.2e12];
    const q = [0, 0, 0, 1.9e8, -3.1e7, 7.7e7];
    const z = (p: [number, number, number]): ZonalHarmonic[] => [{ body: 0, j2: 3.5e-3, j4: -3.6e-5, radius: 2.5559e7, pole: p, targets: [1] }];
    const a = new Float64Array(6);
    const b = new Float64Array(6);
    addZonalAccelerations(gm, q, z(pole), a);
    addZonalAccelerations(gm, q, z([-pole[0], -pole[1], -pole[2]]), b);
    for (let k = 0; k < 6; k++) expect(Object.is(a[k], b[k])).toBe(true);
    expect(Math.hypot(a[3], a[4], a[5])).toBeGreaterThan(0);
  });
});
