import { describe, expect, it } from 'vitest';
import { latLon, osculating, planeBasis, ECLIPTIC_POLE } from './orbit-elements';
import { stateFromElements } from './nodes';

const MU = 3.986004418e14;
const R = 6378136.6;
const EQ = planeBasis([0, 0, 1]);

describe('osculating elements', () => {
  it('circular equatorial: no node, no periapsis direction, said so; true longitude', () => {
    const r = R + 400e3;
    const v = Math.sqrt(MU / r);
    const o = osculating(MU, [r, 0, 0, 0, v, 0], EQ);
    expect(o.e).toBeLessThan(1e-12);
    expect(o.incDeg).toBeCloseTo(0, 9);
    expect(o.raanDeg).toBeNull();
    expect(o.argPeDeg).toBeNull();
    expect(o.anomalyKind).toBe('true longitude');
    expect(o.degenerate.length).toBe(2);
    expect(o.period).toBeCloseTo(2 * Math.PI * Math.sqrt(r ** 3 / MU), 6);
    expect(o.fpaDeg).toBeCloseTo(0, 9);
  });

  it('inclined eccentric orbit: recovers its elements and the times to its apsides and nodes', () => {
    const el = { periAlt: 300e3, apoAlt: 35786e3, incDeg: 28.5, raanDeg: 40, argPeDeg: 178, trueAnomalyDeg: 30 };
    const s = stateFromElements(MU, R, null, el);
    const o = osculating(MU, s, EQ);
    expect(o.rp - R).toBeCloseTo(300e3, 0);
    expect(o.ra - R).toBeCloseTo(35786e3, 0);
    expect(o.incDeg).toBeCloseTo(28.5, 9);
    expect(o.raanDeg!).toBeCloseTo(40, 7);
    expect(o.argPeDeg!).toBeCloseTo(178, 7);
    expect(o.trueAnomalyDeg).toBeCloseTo(30, 7);
    expect(o.toApoapsis).toBeLessThan(o.period / 2);
    expect(o.toPeriapsis).toBeGreaterThan(o.period / 2);
    // The descending node (u = 180°) is 2° of true anomaly ahead of the apoapsis... no: u = argPe + nu = 208°, so both nodes lie ahead within a period.
    expect(o.toAscending).toBeGreaterThan(0);
    expect(o.toDescending).toBeLessThan(o.period);
  });

  it('hyperbola: excess speed, C3, asymptote; no apoapsis or period', () => {
    const rp = R + 200e3;
    const vinf = 3000;
    const vp = Math.sqrt(vinf ** 2 + (2 * MU) / rp);
    const o = osculating(MU, [rp, 0, 0, 0, vp, 0], EQ);
    expect(o.bound).toBe(false);
    expect(o.vInf).toBeCloseTo(vinf, 6);
    expect(o.c3).toBeCloseTo(9, 6);
    expect(o.ra).toBe(Infinity);
    expect(Number.isNaN(o.period)).toBe(true);
    const e = 1 + (rp * vinf ** 2) / MU;
    expect(o.e).toBeCloseTo(e, 9);
    expect(o.asymptote!.lonDeg).toBeCloseTo((Math.acos(-1 / e) * 180) / Math.PI, 6);
    expect(o.asymptote!.latDeg).toBeCloseTo(0, 9);
  });

  it('near-circular inclined: argument of latitude, the node still defined', () => {
    const r = R + 35786e3;
    const v = Math.sqrt(MU / r);
    const c = Math.cos(0.1), sn = Math.sin(0.1);
    const o = osculating(MU, [r, 0, 0, 0, v * c, v * sn], EQ);
    expect(o.argPeDeg).toBeNull();
    expect(o.anomalyKind).toBe('argument of latitude');
    expect(o.raanDeg).toBeCloseTo(0, 9);
    expect(o.trueAnomalyDeg).toBeCloseTo(0, 9);
  });

  it('the ecliptic plane: an orbit in the ICRF equator is 23.44° inclined to it', () => {
    const o = osculating(MU, [R + 1e6, 0, 0, 0, 7000, 0], planeBasis(ECLIPTIC_POLE));
    expect(o.incDeg).toBeCloseTo(23.4392911, 6);
  });

  it('latitude and longitude over the surface', () => {
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    expect(latLon([0, 1, 1], I).latDeg).toBeCloseTo(45, 9);
    expect(latLon([0, 1, 0], I).lonDeg).toBeCloseTo(90, 9);
    expect(latLon([-1, -1e-9, 0], I).lonDeg).toBeCloseTo(-180, 6);
  });
});
