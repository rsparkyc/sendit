/**
 * One altitude convention across every layer (physics model 2, stage 3):
 * altitude above a body is distance from its centre minus the body's
 * reference radius (BodyData.referenceRadius: the equatorial radius its
 * gravity field is referred to, else the mean radius). Pinned here for the
 * body data, the mission world (impact and atmosphere thresholds), the launch,
 * replay events, objectives, the planning aids and the UI's formatting; plus
 * the pole inclination objectives measure against (the physics' own,
 * time-dependent one).
 */
import { describe, expect, it } from 'vitest';
import { bandFromCentre, fromCentre, fromSurface, setDistanceMode } from '../src/app/units';
import { BODIES } from '../src/app/physics';
import { altitudeBand, PLANE_CHANGE } from '../src/mission/campaign';
import { launchState, launchToParams } from '../src/mission/launch';
import { evaluate, initialMissionPlan } from '../src/mission/objectives';
import { makePlan } from '../src/mission/plan';
import { replay, type ReplayResult } from '../src/mission/replay';
import { GEO_FROM_LEO } from '../src/mission/samples';
import { ATMOSPHERE_HEIGHT, bodyIndexOf, bodyPoleAt } from '../src/mission/world';
import { J2000_BODIES } from '../src/physics/solar-system';
import { PorkchopJob } from '../src/planning/porkchop';
import { realWorld } from './helpers/real-world';

const { eph, world } = realWorld();
const earth = J2000_BODIES.find((b) => b.id === 'earth')!;

describe('altitude reference radius', () => {
  it('is the gravity field radius where there is a field, else the mean radius, in the body data and the mission world', () => {
    for (const b of J2000_BODIES) {
      expect(b.referenceRadius, b.id).toBe(b.j2Radius ?? b.radius);
      const k = bodyIndexOf(world, b.id);
      expect(world.bodies[k].radius, b.id).toBe(b.referenceRadius);
      expect(world.bodies[k].atmosphere).toBe(ATMOSPHERE_HEIGHT[b.id] ?? 0);
    }
    expect(earth.referenceRadius).toBe(6378136.6);
    // The UI's altitude radius is the same number; the mean radius stays for drawing.
    for (const b of BODIES) expect(b.refRadius).toBe(J2000_BODIES[b.index].referenceRadius);
  });

  it('a parking orbit requested at 400 km is 400 km in the launch, the replay events and the UI', () => {
    const plan = initialMissionPlan(PLANE_CHANGE, world.fingerprint);
    expect(plan.start.kind === 'launch' && plan.start.params[2]).toBe(400e3);
    const p = plan.start.kind === 'launch' ? plan.start.params : [];
    const l = launchState({ mode: 'parking-orbit', siteId: 'cape-canaveral', launchTime: p[0], azimuthDeg: p[1], altitudeM: p[2] }, eph, J2000_BODIES);
    const r0 = Math.hypot(l.geocentric[0], l.geocentric[1], l.geocentric[2]);
    // j2-mean insertion: mean radius R + 400 km, forced wobble of ~1-2 km.
    expect(Math.abs(r0 - (earth.referenceRadius + 400e3))).toBeLessThan(3e3);
    const r = replay({ ...plan, duration: 4 * 3600 }, world);
    const ext = r.events.filter((e) => e.body === 'earth' && (e.kind === 'periapsis' || e.kind === 'apoapsis'));
    expect(ext.length).toBeGreaterThan(3);
    for (const e of ext) {
      expect(e.altitude).toBe(e.distance - earth.referenceRadius);
      expect(Math.abs(e.altitude - 400e3)).toBeLessThan(15e3);
    }
    const mean = ext.reduce((s, e) => s + e.altitude, 0) / ext.length;
    expect(Math.abs(mean - 400e3)).toBeLessThan(5e3);
    // The plane-change band is 350-450 km of altitude.
    expect(altitudeBand('earth', 350e3, 450e3)).toEqual([earth.referenceRadius + 350e3, earth.referenceRadius + 450e3]);
    const orbit = PLANE_CHANGE.objectives[0];
    expect(orbit.kind === 'orbit' && orbit.periapsis).toEqual(altitudeBand('earth', 350e3, 450e3));
    setDistanceMode('alt');
    expect(fromSurface(400e3, 'earth')).toBe('400 km alt');
    expect(fromCentre(earth.referenceRadius + 400e3, 'earth')).toBe('400 km alt');
    if (orbit.kind === 'orbit') expect(bandFromCentre(orbit.periapsis[0], orbit.periapsis[1], 'earth')).toBe('350–450 km alt');
    setDistanceMode('radius');
    expect(fromSurface(400e3, 'earth')).toBe('6,778 km radius'); // 6,778.1366 km
    setDistanceMode('alt');
  });

  it('the impact sphere and atmosphere top are at the reference radius', () => {
    // A state 1 km above Earth's reference radius but inside the atmosphere top: atmosphere entry at once.
    const s = [0, 0, earth.referenceRadius + 1e3, 0, 0, 0];
    const r = replay(makePlan({ data: world.fingerprint, epoch: 8.5e8, duration: 60, rtol: 1e-10, start: { kind: 'state', center: 'earth', state: s }, spacecraft: { wetMass: 1000, dryMass: 500, engines: [{ thrust: 1000, isp: 300 }] }, burns: [] }), world);
    expect(r.outcome).toBe('atmosphere');
    expect(r.events[r.events.length - 1].altitude).toBeCloseTo(1e3, 3);
  });

  it('the porkchop parking orbit and capture orbit are referred to the same radius', () => {
    const job = new PorkchopJob(eph, J2000_BODIES, { departure: 'earth', arrival: 'mars', departureTimes: { start: 9.1e8, end: 9.1e8 + 86400, count: 2 }, flightTimes: { start: 200 * 86400, end: 201 * 86400, count: 2 }, parkingAltitude: 200e3, arrivalOrbit: { kind: 'capture', altitude: 400e3 } });
    const j = job as unknown as { rPark: number; rCap: number };
    expect(j.rPark).toBe(earth.referenceRadius + 200e3);
    expect(j.rCap).toBe(J2000_BODIES.find((b) => b.id === 'mars')!.referenceRadius + 400e3);
  });
});

describe('inclination objectives measure against the pole the physics uses', () => {
  it('an orbit 0.95° from Earth’s 2027 equator meets the geostationary 0-1° band, though it is >1° from the J2000 equator', () => {
    const k = bodyIndexOf(world, 'earth');
    const t0 = GEO_FROM_LEO.epoch + 86400;
    const p = [0, 0, 0];
    bodyPoleAt(world, k, t0, p);
    const p0 = world.bodies[k].pole!;
    const drift = (Math.acos(p[0] * p0[0] + p[1] * p0[1] + p[2] * p0[2]) * 180) / Math.PI;
    expect(drift).toBeGreaterThan(0.12); // Earth's pole has moved ~0.15° since J2000
    expect(drift).toBeLessThan(0.18);
    // u: unit vector perpendicular to p, away from the J2000 pole.
    const d = [p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]];
    const dp = d[0] * p[0] + d[1] * p[1] + d[2] * p[2];
    const u0 = d.map((x, i) => x - dp * p[i]);
    const un = Math.hypot(...u0);
    const u = u0.map((x) => x / un);
    const a = (0.95 * Math.PI) / 180;
    const h = p.map((x, i) => Math.cos(a) * x + Math.sin(a) * u[i]);
    expect((Math.acos(h[0] * p0[0] + h[1] * p0[1] + h[2] * p0[2]) * 180) / Math.PI).toBeGreaterThan(1.05);
    // Circular geostationary-radius orbit in the plane with normal h: extrema every half period for 4 revolutions.
    const R = 42164e3;
    const mu = world.ephemeris.gm[k];
    const v = Math.sqrt(mu / R);
    const e1 = (() => { const c = [h[1], -h[0], 0]; const n = Math.hypot(...c); return c.map((x) => x / n); })();
    const e2 = [h[1] * e1[2] - h[2] * e1[1], h[2] * e1[0] - h[0] * e1[2], h[0] * e1[1] - h[1] * e1[0]];
    const P = 2 * Math.PI * Math.sqrt((R * R * R) / mu);
    const events = [];
    for (let i = 0; i < 9; i++) {
      const th = Math.PI * i;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const rr = e1.map((x, j) => R * (c * x + s * e2[j]));
      const vv = e1.map((x, j) => v * (-s * x + c * e2[j]));
      events.push({ kind: i % 2 === 0 ? 'periapsis' : 'apoapsis', t: t0 + (i * P) / 2, body: 'earth', distance: R, altitude: R - world.bodies[k].radius, speed: v, rel: [...rr, ...vv], mass: 1 } as const);
    }
    const result = { ok: true, outcome: 'completed', reason: '', events, burns: [], deltaV: 0, propellantUsed: 0, elapsed: t0 + 4.5 * P - GEO_FROM_LEO.epoch, finalT: t0 + 4.5 * P, finalState: [], steps: 1, digest: '' } as unknown as ReplayResult;
    const ev = evaluate({ ...GEO_FROM_LEO, objectives: [GEO_FROM_LEO.objectives[0]] }, result, world, GEO_FROM_LEO.epoch);
    expect(ev.objectives[0].ok, ev.objectives[0].detail).toBe(true);
    // Tilt the same orbit 1.05° from the 2027 pole instead: outside the band.
    const b = (1.05 * Math.PI) / 180;
    const h2 = p.map((x, i) => Math.cos(b) * x + Math.sin(b) * u[i]);
    const rot = (w: number[]) => { // rotate vectors of plane h into plane h2 about axis h x h2
      const ax = [h[1] * h2[2] - h[2] * h2[1], h[2] * h2[0] - h[0] * h2[2], h[0] * h2[1] - h[1] * h2[0]];
      const sn = Math.hypot(...ax);
      const cs = h[0] * h2[0] + h[1] * h2[1] + h[2] * h2[2];
      const k3 = ax.map((x) => x / sn);
      const kd = k3[0] * w[0] + k3[1] * w[1] + k3[2] * w[2];
      const kx = [k3[1] * w[2] - k3[2] * w[1], k3[2] * w[0] - k3[0] * w[2], k3[0] * w[1] - k3[1] * w[0]];
      return w.map((x, i) => x * cs + kx[i] * sn + k3[i] * kd * (1 - cs));
    };
    const events2 = events.map((e) => ({ ...e, rel: [...rot(e.rel.slice(0, 3)), ...rot(e.rel.slice(3))] }));
    const ev2 = evaluate({ ...GEO_FROM_LEO, objectives: [GEO_FROM_LEO.objectives[0]] }, { ...result, events: events2 }, world, GEO_FROM_LEO.epoch);
    expect(ev2.objectives[0].ok).toBe(false);
  });

  it('the pole is the physics’ own (shared PoleTable), not the static J2000 pole', () => {
    const k = bodyIndexOf(world, 'earth');
    const a = [0, 0, 0];
    bodyPoleAt(world, k, 0, a);
    const p0 = world.bodies[k].pole!;
    expect(Math.acos(Math.min(1, a[0] * p0[0] + a[1] * p0[1] + a[2] * p0[2]))).toBeLessThan(1e-8);
    expect(world.bodies[k].rotation).toBeDefined();
  });
});
