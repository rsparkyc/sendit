import { describe, expect, it } from 'vitest';
import { ChebyshevEphemeris } from '../src/physics/chebyshev-ephemeris';
import { J2000_BODIES, bodyIndex } from '../src/physics/solar-system';
import { propagate } from '../src/physics/spacecraft';
import {
  LAUNCH_SITES,
  asymptotePlaneNormals,
  azimuthForInclination,
  geocentricLatitudeDeg,
  launchPlane,
  launchSite,
  launchState,
  launchFromParams,
  launchToParams,
  orbitNormalOf,
  planeCrossings,
  stellarDay,
  type ParkingOrbitLaunch,
} from '../src/mission/launch';

const DEG = Math.PI / 180;
const eph = new ChebyshevEphemeris();
const EARTH = bodyIndex('earth', J2000_BODIES);
const T0 = 2.5e8; // ~2007.9 TDB
eph.ensure(T0 - 86400, T0 + 3 * 86400);

const spec = (siteId: string, azimuthDeg: number, extra: Partial<ParkingOrbitLaunch> = {}): ParkingOrbitLaunch => ({
  mode: 'parking-orbit',
  siteId,
  launchTime: T0,
  azimuthDeg,
  altitudeM: 200e3,
  ...extra,
});

const angle = (a: readonly number[], b: readonly number[]) =>
  Math.atan2(
    Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]),
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  );

describe('launch geometry', () => {
  it('inclination follows cos i = cos(lat) sin(az) for every site and allowed azimuth', () => {
    for (const site of LAUNCH_SITES) {
      const lat = geocentricLatitudeDeg(site) * DEG;
      for (let az = 0; az < 360; az += 7.5) {
        const p = launchPlane(site, T0 + az * 1000, az);
        const cosI = p.normal[0] * p.pole[0] + p.normal[1] * p.pole[1] + p.normal[2] * p.pole[2];
        expect(Math.abs(cosI - Math.cos(lat) * Math.sin(az * DEG))).toBeLessThan(1e-14);
      }
    }
  });

  it('launchState reports the same inclination and rejects azimuths outside range safety', () => {
    const r = launchState(spec('cape-canaveral', 90), eph);
    expect(Math.abs(r.inclinationDeg - geocentricLatitudeDeg(launchSite('cape-canaveral')))).toBeLessThan(1e-9);
    expect(() => launchState(spec('cape-canaveral', 180), eph)).toThrow(/range-safety/);
    expect(() => launchState(spec('vandenberg', 90), eph)).toThrow(/range-safety/);
    expect(() => launchState(spec('kourou', 355), eph)).not.toThrow(); // -5 deg, inside -10.5..93.5
  });

  it('inclinations below site latitude are impossible by construction', () => {
    for (const site of LAUNCH_SITES) {
      const lat = Math.abs(geocentricLatitudeDeg(site));
      for (let az = 0; az < 360; az += 1) {
        const p = launchPlane(site, T0, az);
        const i = angle(p.normal, p.pole) / DEG;
        expect(Math.min(i, 180 - i)).toBeGreaterThanOrEqual(lat - 1e-9);
      }
      if (lat > 1) expect(azimuthForInclination(site, lat - 0.5)).toBeNull();
    }
  });

  it('azimuthForInclination hits the requested inclination', () => {
    for (const [id, inc] of [['cape-canaveral', 51.6], ['baikonur', 51.6], ['vandenberg', 97.5], ['mahia', 45], ['kourou', 6]] as const) {
      const site = launchSite(id);
      const a = azimuthForInclination(site, inc)!;
      for (const az of [a.northerly, a.southerly]) {
        const p = launchPlane(site, T0, az);
        const i = angle(p.normal, p.pole) / DEG;
        expect(Math.abs(i - inc)).toBeLessThan(1e-9);
      }
    }
    // ISS from Baikonur is a northerly (NE) launch inside the corridor; SSO from Vandenberg southerly.
    expect(azimuthForInclination(launchSite('baikonur'), 51.6)!.northerlyAllowed).toBe(true);
    expect(azimuthForInclination(launchSite('vandenberg'), 97.5)!.southerlyAllowed).toBe(true);
  });

  it('launching one stellar day later reproduces the inertial plane', () => {
    const site = launchSite('cape-canaveral');
    const a = launchPlane(site, T0, 60).normal;
    const b = launchPlane(site, T0 + stellarDay(), 60).normal;
    const c = launchPlane(site, T0 + 86400, 60).normal; // a solar day later: ~1 deg off
    // Expected drift in one day: pole precession (0.56 deg/century in dec,
    // 0.64 in RA => ~3e-7 rad) plus Delta-T slope (~1e-7 rad).
    console.log(`plane change after a stellar day ${angle(a, b).toExponential(2)} rad, after a solar day ${(angle(a, c) / DEG).toFixed(3)} deg`);
    expect(angle(a, b)).toBeLessThan(1e-6);
    expect(angle(a, c) / DEG).toBeGreaterThan(0.5);
  });
});

describe('plane-crossing helper', () => {
  it('puts the site in the Moon orbit plane and launches into it', () => {
    // Kourou: in late 2007 the Moon's orbit is inclined ~28 deg to the equator
    // (near major standstill), below Cape Canaveral's 28.4 deg geocentric latitude.
    const site = launchSite('kourou');
    const h = orbitNormalOf(eph, J2000_BODIES, 'moon', T0);
    const xs = planeCrossings(site, h, T0, T0 + 2 * 86400);
    expect(xs.length).toBeGreaterThanOrEqual(3);
    for (const x of xs) {
      const p = launchPlane(site, x.t, x.azimuthDeg);
      const offPlane = p.up[0] * h[0] + p.up[1] * h[1] + p.up[2] * h[2];
      expect(Math.abs(offPlane)).toBeLessThan(1e-9);
      expect(angle(p.normal, h)).toBeLessThan(1e-8);
    }
  });

  it('finds a plane containing a departure asymptote and launches into it', () => {
    const site = launchSite('cape-canaveral');
    const s = [0.3, -0.8, 0.2];
    const normals = asymptotePlaneNormals(s, 30, T0);
    expect(normals.length).toBe(2);
    for (const h of normals) {
      expect(Math.abs((h[0] * s[0] + h[1] * s[1] + h[2] * s[2]) / Math.hypot(...s))).toBeLessThan(1e-12);
      const xs = planeCrossings(site, h, T0, T0 + 86400);
      expect(xs.length).toBe(2);
      for (const x of xs) expect(angle(launchPlane(site, x.t, x.azimuthDeg).normal, h)).toBeLessThan(1e-8);
    }
    expect(asymptotePlaneNormals([0, 0.1, 1], 30, T0)).toEqual([]); // declination ~84 deg > 30
  });
});

describe('insertion state with the real ephemeris', () => {
  function altitudeStats(s: ParkingOrbitLaunch, revs: number) {
    const r = launchState(s, eph);
    const e = new Float64Array(6);
    const y0 = [...r.state, 1000];
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    let n = 0;
    const out = new Float64Array(7);
    const period = 2 * Math.PI * Math.sqrt((6378137 + s.altitudeM) ** 3 / 398600435507022.56);
    propagate(eph, y0, r.t, r.t + revs * period, [], {
      onStep: (t, _y, interp, tPrev) => {
        for (let k = 1; k <= 8; k++) {
          const tk = tPrev + ((t - tPrev) * k) / 8;
          interp(tk, out);
          eph.bodyState(EARTH, tk, e);
          const alt = Math.hypot(out[0] - e[0], out[1] - e[1], out[2] - e[2]) - 6378137;
          lo = Math.min(lo, alt);
          hi = Math.max(hi, alt);
          sum += alt;
          n++;
        }
      },
    });
    return { lo, hi, mean: sum / n, r };
  }

  it('is a near-circular orbit at the requested altitude over 5 revolutions', () => {
    for (const [site, az] of [['cape-canaveral', 90], ['vandenberg', 190], ['equator', 90], ['baikonur', 40]] as const) {
      const j = altitudeStats(spec(site, az), 5);
      const k = altitudeStats(spec(site, az, { circularization: 'two-body' }), 5);
      console.log(
        `${site} az ${az}: j2-mean alt ${(j.lo / 1e3).toFixed(1)}..${(j.hi / 1e3).toFixed(1)} km mean ${(j.mean / 1e3).toFixed(2)}; ` +
          `two-body ${(k.lo / 1e3).toFixed(1)}..${(k.hi / 1e3).toFixed(1)} mean ${(k.mean / 1e3).toFixed(2)}`,
      );
      expect(Math.abs(j.mean - 200e3)).toBeLessThan(1e3);
      expect(j.hi - j.lo).toBeLessThan(5e3);
      // Geocentric velocity is horizontal at insertion up to the small J2 radial term.
      const g = j.r.geocentric;
      expect(Math.abs(g[0] * g[3] + g[1] * g[4] + g[2] * g[5])).toBeLessThan(1e-3 * Math.hypot(g[0], g[1], g[2]) * Math.hypot(g[3], g[4], g[5]));
    }
  });

  it('is bit-reproducible: same spec, same bits', () => {
    const a = launchState(spec('tanegashima', 100), eph);
    const b = launchState(JSON.parse(JSON.stringify(spec('tanegashima', 100))), eph);
    expect(b.state).toEqual(a.state);
    expect(b.t).toBe(T0 + 540);
    const c = launchState(launchFromParams('tanegashima', launchToParams(spec('tanegashima', 100))), eph);
    expect(c.state).toEqual(a.state);
  });
});
