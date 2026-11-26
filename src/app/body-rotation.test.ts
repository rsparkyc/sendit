/**
 * Orientation checks of the display rotation model against reality, using
 * JPL Horizons states (test/fixtures/horizons-moons.json) for where things
 * actually are and independent formulas for what should face them.
 */
import { describe, expect, it } from 'vitest';
import fixture from '../../test/fixtures/horizons-moons.json';
import { BODIES } from './physics';
import { IAU_ROTATION, bodyToIcrf, subPoint } from './body-rotation';

interface Sample { t: number; jd: number; state: number[] }
const samples = new Map<string, Sample[]>(fixture.bodies.map((b: { id: string; samples: Sample[] }) => [b.id, b.samples]));
const EPOCHS = samples.get('sun')!.map((s) => s.t);

function pos(id: string, t: number): number[] {
  if (t === 0) return BODIES.find((b) => b.id === id)!.state0.slice(0, 3); // J2000 states from the body data
  const s = samples.get(id)!.find((x) => x.t === t)!;
  return s.state.slice(0, 3);
}
function dir(from: string, to: string, t: number): number[] {
  const a = pos(from, t), b = pos(to, t);
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const n = Math.hypot(d[0], d[1], d[2]);
  return d.map((x) => x / n);
}
const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;

describe('IAU rotation model (display)', () => {
  it('pole agrees with the pole vectors in the physics body data at J2000', () => {
    for (const b of BODIES) {
      if (!b.pole) continue;
      const r = bodyToIcrf(IAU_ROTATION[b.id], 0);
      // The data poles are the same IAU model at J2000, periodic terms included and
      // north-pole sense (Uranus too); test/orientation.test.ts checks physics against display at other dates.
      const dot = r[2] * b.pole[0] + r[5] * b.pole[1] + r[8] * b.pole[2];
      expect(Math.acos(Math.min(1, dot)) * (180 / Math.PI), b.id).toBeLessThan(1e-6);
    }
  });

  it('Earth: sub-solar point matches GMST (IAU 1982, on UT1) and the Sun position', () => {
    // Independent of the pck W: sub-solar east longitude = RA(sun, equinox of date) - GMST(UT1), latitude = Dec.
    // Delta-T = TT - UT1 (s) at the fixture epochs (IERS); RA/Dec precessed from J2000 to date with the
    // standard annual rates m = 3.075 s, n = 1.336 s, n' = 20.04".
    const deltaT = (y: number) => (y < 1980 ? 45.5 : y < 1995 ? 56.9 : y < 2000 ? 63.8 : y < 2005 ? 64.1 : y < 2015 ? 66.1 : 69.1);
    for (const t of EPOCHS) {
      const s = dir('earth', 'sun', t);
      const got = subPoint(IAU_ROTATION.earth, t, s);
      const years = t / (365.25 * 86400);
      const du = (t - deltaT(2000 + years)) / 86400;
      const Tu = du / 36525;
      const gmstSec = 67310.54841 + (876600 * 3600 + 8640184.812866) * Tu + 0.093104 * Tu * Tu; // Tu from JD 2451545.0 UT1
      const gmst = ((gmstSec / 240) % 360 + 360) % 360;
      const ra0 = Math.atan2(s[1], s[0]);
      const dec0 = Math.asin(s[2]);
      const ra = (ra0 * 180) / Math.PI + years * (3.075 + 1.336 * Math.sin(ra0) * Math.tan(dec0)) / 240;
      const dec = (dec0 * 180) / Math.PI + (years * 20.04 * Math.cos(ra0)) / 3600;
      expect(Math.abs(wrap(got.lon - (ra - gmst))), `lon t=${t}`).toBeLessThan(0.1);
      expect(Math.abs(got.lat - dec), `lat t=${t}`).toBeLessThan(0.05);
    }
  });

  it('Earth at J2000.0 (2000-01-01 11:58:56 UTC): Sun over ~1 deg E, 23 deg S', () => {
    // Equation of time on Jan 1 2000: -3.3 min, so local apparent noon at Greenwich was at ~12:03 UTC;
    // 4.3 min earlier the Sun stood ~1.1 deg east of Greenwich. Declination -23.03 deg.
    const got = subPoint(IAU_ROTATION.earth, 0, dir('earth', 'sun', 0));
    expect(got.lon).toBeGreaterThan(0.6);
    expect(got.lon).toBeLessThan(1.6);
    expect(got.lat).toBeCloseTo(-23.03, 1);
  });

  it('Moon: the sub-Earth point stays near 0 lon, 0 lat (near side faces Earth; libration < 8 deg)', () => {
    for (const t of EPOCHS) {
      const p = subPoint(IAU_ROTATION.moon, t, dir('moon', 'earth', t));
      expect(Math.abs(p.lon), `lon t=${t}`).toBeLessThan(8.5);
      expect(Math.abs(p.lat), `lat t=${t}`).toBeLessThan(7);
    }
  });

  const locked: [string, string, number][] = [
    ['io', 'jupiter', 2], ['europa', 'jupiter', 3], ['ganymede', 'jupiter', 3], ['callisto', 'jupiter', 3],
    ['tethys', 'saturn', 12], ['dione', 'saturn', 3], ['rhea', 'saturn', 5], ['titan', 'saturn', 6], ['iapetus', 'saturn', 15],
    ['ariel', 'uranus', 5], ['umbriel', 'uranus', 5], ['titania', 'uranus', 5], ['oberon', 'uranus', 5],
    ['triton', 'neptune', 5], ['charon', 'pluto', 2], ['pluto', 'charon', 2],
  ];
  it.each(locked)('%s keeps its prime meridian toward %s', (moon, planet, tol) => {
    for (const t of EPOCHS) {
      const p = subPoint(IAU_ROTATION[moon], t, dir(moon, planet, t));
      expect(Math.abs(wrap(p.lon)), `${moon} lon t=${t}`).toBeLessThan(tol);
    }
  });

  it('Uranus is on its side and rotates retrograde; Saturn pole ~28 deg from the ecliptic pole', () => {
    const ecl = (id: string) => {
      const r = bodyToIcrf(IAU_ROTATION[id], 0);
      const e = 23.4392911 * (Math.PI / 180);
      // ecliptic z of the pole
      return -Math.sin(e) * r[5] + Math.cos(e) * r[8];
    };
    // IAU north pole 82 deg from ecliptic north with retrograde W: spin axis 98 deg from the ecliptic pole.
    expect(Math.acos(ecl('uranus')) * (180 / Math.PI)).toBeCloseTo(82.3, 0);
    expect(IAU_ROTATION.uranus.pm[1]).toBeLessThan(0);
    expect(Math.acos(ecl('saturn')) * (180 / Math.PI)).toBeCloseTo(28, 0);
    expect(360 / IAU_ROTATION.jupiter.pm[1] * 24).toBeCloseTo(9.925, 2); // System III period, hours
  });
});
