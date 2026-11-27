/**
 * Direct injection against the parking-orbit route (README "Direct
 * injection: the trade-off"): payload, total delta-v and launch-window width
 * for a lunar transfer and an Earth-escape departure, on a catalogue vehicle
 * with a restartable upper stage (Atlas V 401, Centaur) and on an all-solid
 * vehicle (Minotaur V, approximate). Everything comes from the models
 * (ascent.ts both modes, direct-planning.ts); the assertions pin the
 * qualitative findings, the console table the numbers.
 *
 * Parking route: the ascent to a 185 km circular orbit, then an impulsive
 * departure burn from what the upper stage has left (no finite-burn loss:
 * for a Centaur TLI, ~0.4 g, that loss is of order 50-100 m/s, which this
 * comparison leaves out in the parking route's favour).
 * Window width: the span of liftoff times around a window instant in which
 * the departure can point within 1 deg of the target direction (direct) or
 * the orbit plane can contain it with an azimuth inside the range corridor
 * (parking: the departure burn is then placed where it points right).
 */
import { describe, expect, it } from 'vitest';
import { ASCENT_BODIES, computeAscent, computeDirectAscent } from '../src/mission/ascent';
import { c3ForApoapsis, directAimError, directInjectionWindows, parkingAzimuthToward, windowSpan } from '../src/mission/direct-planning';
import { launchGeometry, launchSite } from '../src/mission/launch';
import type { Stage } from '../src/mission/plan';
import { J2000_BODIES } from '../src/physics/solar-system';
import { vehicleSpec } from '../src/mission/vehicles';
import { departureDv, directPayload, EARTH, parkingPayload } from './helpers/direct';
import { realWorld } from './helpers/real-world';

const T = 8.5e8;
const H = 185e3;
const LUNAR_C3 = c3ForApoapsis(EARTH.gm, EARTH.radius + H, 384400e3);
const ESCAPE_C3 = 10e6;
const dummy = (m: number): Stage => ({ wetMass: m, dryMass: m, engines: [{ thrust: 1, isp: 300 }] });
const DEG = Math.PI / 180;

interface Row { vehicle: string; target: string; site: string; directPayload: number; parkingPayload: number; directDv: number; parkingDv: number; directWindowMin: number; parkingWindowMin: number }

describe('direct injection against a parking orbit', () => {
  const { eph } = realWorld();
  const rows: Row[] = [];

  const compare = (vehicle: string, siteId: string, target: 'lunar' | 'escape') => {
    const site = launchSite(siteId);
    const lower = vehicleSpec(vehicle).stages;
    const c3 = target === 'lunar' ? LUNAR_C3 : ESCAPE_C3;
    const g = launchGeometry(site, T, 90);
    const pd = directPayload(lower, c3, H, g);
    const pp = parkingPayload(lower, c3, H, g);
    // Delta-v at a common payload (the smaller maximum; the direct one for the solids, which cannot park).
    const m = Number.isNaN(pp) ? pd : Math.min(pd, pp);
    const d = computeDirectAscent([...lower, dummy(m)], { ...EARTH, c3, injectionAltitudeM: H }, g, ASCENT_BODIES.earth);
    const p = computeAscent([...lower, dummy(m)], { ...EARTH, altitudeM: H }, g, ASCENT_BODIES.earth);
    if (!d.ok) throw new Error(d.reason);
    // Window: lunar aims the apoapsis at the Moon; escape aims the asymptote at a fixed direction (declination -20 deg).
    const dir = [Math.cos(-20 * DEG), 0, Math.sin(-20 * DEG)];
    const spec = target === 'lunar' ? { kind: 'body' as const, id: 'moon', ephem: eph, bodies: J2000_BODIES } : { kind: 'direction' as const, direction: dir };
    const wins = directInjectionWindows({ site, stages: [...lower, dummy(m)], c3, injectionAltitudeM: H, target: spec, tStart: T, tEnd: T + (vehicle === 'minotaur-v' && target === 'lunar' ? 120 : 60) * 86400, step: 60 });
    const w = wins.find((x) => x.azimuthAllowed);
    let directWindowMin = NaN;
    let parkingWindowMin = NaN;
    if (w) {
      const phi = Number.isNaN(w.geometry.asymptoteAngle) ? w.geometry.apoapsisAngle : w.geometry.asymptoteAngle;
      const okD = (t: number) => directAimError(site, t, phi, w.direction) <= 1 * DEG;
      directWindowMin = windowSpan(okD, w.t, 10, 3 * 3600).width / 60;
      if (!Number.isNaN(pp)) parkingWindowMin = windowSpan((t) => parkingAzimuthToward(site, t, w.direction) !== null, w.t, 60, 12 * 3600).width / 60;
    }
    const row: Row = {
      vehicle, target, site: siteId,
      directPayload: Math.round(pd), parkingPayload: Number.isNaN(pp) ? NaN : Math.round(pp),
      directDv: Math.round(d.deltaV), parkingDv: p.ok ? Math.round(p.deltaV + departureDv(c3, H)) : NaN,
      directWindowMin: Math.round(directWindowMin * 10) / 10, parkingWindowMin: Math.round(parkingWindowMin),
    };
    rows.push(row);
    return { row, parkingReason: p.ok ? '' : p.reason, window: w };
  };

  it('Atlas V 401 (restartable Centaur): the parking orbit carries more, and its window is hours, not minutes', () => {
    for (const target of ['lunar', 'escape'] as const) {
      const { row } = compare('atlas-v-401', 'cape-canaveral', target);
      expect(row.parkingPayload).toBeGreaterThan(row.directPayload * 1.1);
      expect(row.directDv).toBeGreaterThan(row.parkingDv);
      expect(row.directWindowMin).toBeLessThan(20);
      expect(row.parkingWindowMin).toBeGreaterThan(60);
    }
  });

  it('Falcon 9 (high thrust-to-weight upper stage): payloads within a few percent either way', () => {
    const { row } = compare('falcon-9', 'cape-canaveral', 'lunar');
    expect(Math.abs(row.directPayload / row.parkingPayload - 1)).toBeLessThan(0.03);
  });

  it('Minotaur V (all solid): direct injection only; a parking orbit is refused', () => {
    for (const target of ['lunar', 'escape'] as const) {
      const { row, parkingReason } = compare('minotaur-v', 'equator', target);
      expect(Number.isNaN(row.parkingPayload)).toBe(true);
      expect(parkingReason).toMatch(/cannot shut down/);
      expect(row.directPayload).toBeGreaterThan(300);
      expect(row.directWindowMin).toBeLessThan(20);
    }
  });

  it('prints the table', () => {
    console.log('direct injection vs parking orbit (185 km):\n' + rows.map((r) => JSON.stringify(r)).join('\n'));
    expect(rows.length).toBe(5);
  });
});
