import { describe, expect, it } from 'vitest';
import fx from './fixtures/mission/horizons-sites.json';
import {
  EARTH_ROTATION,
  EARTH_ROTATION_IAU,
  WGS84,
  bodyToIcrf,
  deltaT,
  poleAt,
  siteIcrf,
} from '../src/mission/earth-orientation';
import { J2000_BODIES } from '../src/physics/solar-system';

const YEAR = 365.25 * 86400;

function residuals(model: typeof EARTH_ROTATION) {
  return fx.sites.flatMap((s) =>
    s.points.map((p) => {
      const r = siteIcrf(model, WGS84, s.latDeg, s.lonDeg, s.heightM, p.t);
      const d = Math.hypot(r[0] - p.position[0], r[1] - p.position[1], r[2] - p.position[2]);
      return { id: s.id, years: p.t / YEAR, km: d / 1000 };
    }),
  );
}

describe('Earth orientation vs JPL Horizons topocentric sites', () => {
  it('ERA + Delta-T model: every site within 0.35 km, 1950-2050', () => {
    const res = residuals(EARTH_ROTATION);
    const worst = (f: (y: number) => boolean) => Math.max(...res.filter((r) => f(r.years)).map((r) => r.km));
    const atJ2000 = worst((y) => Math.abs(y) < 0.01);
    const at50 = worst((y) => Math.abs(Math.abs(y) - 50) < 0.1);
    const all = worst(() => true);
    console.log(`residual km: J2000 ${atJ2000.toFixed(3)}, +-50y ${at50.toFixed(3)}, all ${all.toFixed(3)} (${res.length} points)`);
    expect(all).toBeLessThan(0.35);
  });

  it('pure IAU W (linear in TDB) is 4-16 km off: why EARTH_ROTATION uses ERA', () => {
    const res = residuals(EARTH_ROTATION_IAU);
    const all = Math.max(...res.map((r) => r.km));
    console.log(`IAU-W residual worst ${all.toFixed(2)} km`);
    expect(all).toBeGreaterThan(3);
    expect(all).toBeLessThan(20);
  });

  it('rotation matrix is orthonormal and the pole matches the data file at J2000', () => {
    const r = bodyToIcrf(EARTH_ROTATION, 1.234e8);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const d = r[i] * r[j] + r[3 + i] * r[3 + j] + r[6 + i] * r[6 + j];
        expect(Math.abs(d - (i === j ? 1 : 0))).toBeLessThan(1e-15);
      }
    const pole = J2000_BODIES.find((b) => b.id === 'earth')!.pole!;
    const p = poleAt(EARTH_ROTATION, 0);
    for (let i = 0; i < 3; i++) expect(Math.abs(p[i] - pole[i])).toBeLessThan(1e-15);
  });

  it('Delta-T table: 63.83 s at 2000, held flat after 2025', () => {
    expect(Math.abs(deltaT(-43200) - 63.83)).toBeLessThan(1e-9);
    expect(deltaT(40 * YEAR)).toBe(69.1);
  });
});
