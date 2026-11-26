/**
 * Simple worlds for mission-layer tests: Earth alone (fixed), and Earth fixed
 * with the Moon on an analytic circular orbit. Test-only (uses Math.cos/sin).
 */
import { FixedBodies, type Ephemeris } from '../../src/physics/spacecraft';
import { J2000_BODIES } from '../../src/physics/solar-system';
import { ATMOSPHERE_HEIGHT, makeWorld, type MissionWorld } from '../../src/mission/world';

const data = (id: string) => {
  const b = J2000_BODIES.find((x) => x.id === id);
  if (!b) throw new Error(id);
  return b;
};
export const EARTH = data('earth');
export const MOON = data('moon');
export const GM_EARTH = EARTH.gm;
export const GM_MOON = MOON.gm;
export const R_EARTH = EARTH.radius;
export const R_MOON = MOON.radius;

export function earthOnlyWorld(): MissionWorld {
  const eph = new FixedBodies([{ gm: GM_EARTH, position: [0, 0, 0] }]);
  return makeWorld(eph, [{ id: 'earth', radius: R_EARTH, atmosphere: ATMOSPHERE_HEIGHT.earth, pole: [0, 0, 1] }], [0, 0, 0]);
}

/** Moon on a circular orbit of radius A_MOON in the xy plane, phase 0 at t = 0. Earth fixed at the origin. */
export const A_MOON = 384_400e3;
export const N_MOON = Math.sqrt((GM_EARTH + GM_MOON) / A_MOON ** 3);

export class EarthMoonEphemeris implements Ephemeris {
  readonly count = 2;
  readonly gm = Float64Array.from([GM_EARTH, GM_MOON]);
  positions(t: number, out: Float64Array): void {
    out[0] = out[1] = out[2] = 0;
    out[3] = A_MOON * Math.cos(N_MOON * t);
    out[4] = A_MOON * Math.sin(N_MOON * t);
    out[5] = 0;
  }
  bodyState(body: number, t: number, out: Float64Array): void {
    if (body === 0) {
      out.fill(0, 0, 6);
      return;
    }
    const c = Math.cos(N_MOON * t);
    const s = Math.sin(N_MOON * t);
    out[0] = A_MOON * c;
    out[1] = A_MOON * s;
    out[2] = 0;
    out[3] = -A_MOON * N_MOON * s;
    out[4] = A_MOON * N_MOON * c;
    out[5] = 0;
  }
}

export function earthMoonWorld(): MissionWorld {
  return makeWorld(
    new EarthMoonEphemeris(),
    [
      { id: 'earth', radius: R_EARTH, atmosphere: ATMOSPHERE_HEIGHT.earth, pole: [0, 0, 1] },
      { id: 'moon', radius: R_MOON, atmosphere: 0, pole: [0, 0, 1] },
    ],
    [A_MOON, 0],
  );
}
