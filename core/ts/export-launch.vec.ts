/**
 * Launch vectors (core/fixtures/generated/launch.txt) for core/src/mission/launch.rs.
 *
 * Earth orientation (bodyToIcrf, poleAt, primeMeridianDeg of EARTH_ROTATION,
 * geodeticToBodyFixed, siteIcrf), siteFrame, launchPlane, launchGeometry,
 * azimuthAllowed, launchState (parking orbit, j2-mean / two-body / defaults,
 * refusals) and directInjectionState, for every launch site x azimuths
 * (corridor limits, one ulp and 1e-9 deg either side, interior, wrapped by
 * +-360, NaN) x parking altitudes (limits, 0, negative, NaN) x epochs from
 * 1949 to 2101. Earth's barycentric state comes from a recording fake
 * ephemeris (the Chebyshev evaluation is proven separately): the record
 * carries the time asked for and the six numbers returned.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { Lines } from './shared';
import { EARTH_ROTATION, WGS84, bodyToIcrf, geodeticToBodyFixed, poleAt, primeMeridianDeg, siteIcrf } from '../../src/mission/earth-orientation';
import {
  LAUNCH_SITES, azimuthAllowed, directInjectionState, launchGeometry, launchPlane, launchState, siteFrame,
  type DirectInjectionLaunch, type ParkingOrbitLaunch,
} from '../../src/mission/launch';
import { MAX_PARKING_ALTITUDE } from '../../src/mission/plan';
import type { Ephemeris } from '../../src/physics/spacecraft';

const OUT = new URL('../fixtures/generated/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex') || '-';
const YEAR = 365.25 * 86400;

let rng = 0x9e3779b9;
const rand = () => {
  rng = (Math.imul(rng ^ (rng >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
  rng ^= rng >>> 13;
  return (rng >>> 0) / 4294967296;
};
const up = (x: number) => { const b = new Float64Array([x]); const u = new BigInt64Array(b.buffer); u[0] += x >= 0 ? 1n : -1n; return b[0]; };
const dn = (x: number) => { const b = new Float64Array([x]); const u = new BigInt64Array(b.buffer); u[0] += x > 0 ? -1n : 1n; return b[0]; };

/** Fake ephemeris: Earth's state is a smooth function of t; every call is recorded. */
function fakeEphem(calls: number[][]): Ephemeris {
  return {
    bodyState(i: number, t: number, out: Float64Array) {
      const s = [1.4e11 + 3e4 * t * 1e-3, -2.1e10 + t * 0.71, 9.1e9 - t * 0.33, -2.9e4 + 1e-9 * t, 2.7e3, 1.1e3 - 1e-10 * t];
      for (let k = 0; k < 6; k++) out[k] = s[k];
      calls.push([i, t, ...s]);
    },
  } as unknown as Ephemeris;
}

it('export launch vectors', () => {
  const W = new Lines();
  const epochs: number[] = [-51 * YEAR, -50 * YEAR, -12.3 * YEAR, 0, 1, 7.77 * YEAR, 25.5 * YEAR, 50 * YEAR, 99.9 * YEAR, 100 * YEAR, 101 * YEAR];
  for (let i = 0; i < 6; i++) epochs.push((-50 + 150 * rand()) * YEAR);

  // Orientation of Earth and geodetic conversion.
  for (let i = 0; i < 300; i++) {
    const t = i < epochs.length ? epochs[i] : (-55 + 160 * rand()) * YEAR;
    W.add('rot', t, bodyToIcrf(EARTH_ROTATION, t), poleAt(EARTH_ROTATION, t), primeMeridianDeg(EARTH_ROTATION, t));
  }
  // Many geodetic points: e2 sp^2 is ~0.007 of 1, so a rounding change in it
  // reaches 1 - e2 sp^2 in only a few percent of points.
  for (let i = 0; i < 20000; i++) {
    const lat = -90 + 180 * rand();
    const h = -500 + 9000 * rand();
    W.add('geo', lat, 0, h, geodeticToBodyFixed(WGS84, lat, 0, h));
  }
  for (let i = 0; i < 300; i++) {
    const lat = i < 4 ? [90, -90, 0, -0][i] : -90 + 180 * rand();
    const lon = -180 + 540 * rand();
    const h = i % 7 === 0 ? 0 : -500 + 9000 * rand();
    W.add('geo', lat, lon, h, geodeticToBodyFixed(WGS84, lat, lon, h));
    const t = epochs[i % epochs.length];
    W.add('sicrf', lat, lon, h, t, siteIcrf(EARTH_ROTATION, WGS84, lat, lon, h, t));
  }

  for (const s of LAUNCH_SITES) {
    const az: number[] = [s.azimuthMinDeg, s.azimuthMaxDeg, dn(s.azimuthMinDeg), up(s.azimuthMaxDeg), s.azimuthMinDeg - 1e-9, s.azimuthMaxDeg + 1e-9,
      s.azimuthMinDeg + 360, s.azimuthMaxDeg - 360, s.azimuthMinDeg - 360, 0, 90, 180, 270, 359.999, -0, 720.5, NaN];
    for (let i = 0; i < 8; i++) az.push(s.azimuthMinDeg + ((s.azimuthMaxDeg - s.azimuthMinDeg + 360) % 360) * rand());
    for (let i = 0; i < 4; i++) az.push(360 * rand());
    for (const a of az) W.add('az', s.id, a, azimuthAllowed(s, a) ? 'yes' : 'no');

    for (const t of epochs) {
      const f = siteFrame(s, t);
      W.add('frame', s.id, t, f.r, f.up, f.east, f.north, f.pole);
    }
    const alts = [1, 150e3, 185e3, 200e3, 400e3, 2000e3, MAX_PARKING_ALTITUDE, up(MAX_PARKING_ALTITUDE), 0, -0, -1, NaN];
    let k = 0;
    for (const a of az) {
      for (let j = 0; j < 3; j++) {
        const t = epochs[(k++ * 7) % epochs.length] + (j === 0 ? 0 : 86400 * 30 * rand());
        const plane = (() => { try { const p = launchPlane(s, t, a); const g = launchGeometry(s, t, a); return [p.up, p.downrange, p.normal, p.pole, [g.alongTrack, g.crossTrack]]; } catch { return null; } })();
        if (plane) W.add('plane', s.id, t, a, ...plane);
        for (const mode of ['j2-mean', 'two-body', 'default', 'bogus'] as const) {
          const alt = alts[(k + j + mode.length) % alts.length];
          const opts: { ascentTimeS?: number; downrangeDeg?: number; circularization?: 'j2-mean' } =
            mode === 'default' ? {} : { ascentTimeS: 300 + 600 * rand(), downrangeDeg: j === 1 ? -0 : 30 * rand(), circularization: mode as 'j2-mean' };
          const spec: ParkingOrbitLaunch = { mode: 'parking-orbit', siteId: s.id, launchTime: t, azimuthDeg: a, altitudeM: alt, ...opts };
          const calls: number[][] = [];
          const head = ['park', s.id, mode, t, a, alt, opts.ascentTimeS ?? 0, opts.downrangeDeg ?? 0] as const;
          try {
            const r = launchState(spec, fakeEphem(calls));
            W.add(...head, 'ok', calls[0], r.t, r.state, r.geocentric, r.normal, r.inclinationDeg);
          } catch (e) {
            W.add(...head, 'ERR', hex((e as Error).message));
          }
        }
        // Direct injection burnout.
        const spec: DirectInjectionLaunch = { mode: 'direct', siteId: s.id, launchTime: t, azimuthDeg: a, c3: 0, injectionAltitudeM: 200e3, flightStartS: 0 };
        const b = { time: 200 + 600 * rand(), altitudeM: 1e5 + 3e5 * rand(), horizontalSpeed: 7000 + 4500 * rand(), radialSpeed: -200 + 800 * rand(), downrange: 0.5 * rand() };
        const calls: number[][] = [];
        const head = ['direct', s.id, t, a, b.time, b.altitudeM, b.horizontalSpeed, b.radialSpeed, b.downrange] as const;
        try {
          const r = directInjectionState(spec, b, fakeEphem(calls));
          W.add(...head, 'ok', calls[0], r.t, r.state, r.geocentric, r.normal, r.inclinationDeg);
        } catch (e) {
          W.add(...head, 'ERR', hex((e as Error).message));
        }
      }
    }
  }
  // Dense valid parking launches (the J2 corrections are ~1e-3 relative, so
  // their rounding shows in a fraction of cases only).
  for (const s of LAUNCH_SITES) {
    const span = (s.azimuthMaxDeg - s.azimuthMinDeg + 360) % 360;
    for (let i = 0; i < 1500; i++) {
      const t = (-50 + 150 * rand()) * YEAR;
      const a = s.azimuthMinDeg + span * rand();
      const alt = 150e3 + 1850e3 * rand();
      const mode = i % 3 === 0 ? 'two-body' : 'j2-mean';
      const spec: ParkingOrbitLaunch = { mode: 'parking-orbit', siteId: s.id, launchTime: t, azimuthDeg: a, altitudeM: alt, ascentTimeS: 540, downrangeDeg: 30 * rand(), circularization: mode };
      const calls: number[][] = [];
      const head = ['park', s.id, mode, t, a, alt, 540, spec.downrangeDeg!] as const;
      try {
        const r = launchState(spec, fakeEphem(calls));
        W.add(...head, 'ok', calls[0], r.t, r.state, r.geocentric, r.normal, r.inclinationDeg);
      } catch (e) {
        W.add(...head, 'ERR', hex((e as Error).message));
      }
    }
  }
  // Unknown site.
  try {
    launchState({ mode: 'parking-orbit', siteId: 'nowhere', launchTime: 0, azimuthDeg: 90, altitudeM: 2e5 }, fakeEphem([]));
  } catch (e) {
    W.add('park', 'nowhere', 'default', 0, 90, 2e5, 0, 0, 'ERR', hex((e as Error).message));
  }
  writeFileSync(OUT + 'launch.txt', W.text());
});
