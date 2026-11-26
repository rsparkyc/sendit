import { describe, expect, it } from 'vitest';
import { cross, dot, ECLIPTIC_POLE_ICRF, keplerPropagate, norm, sub, type Vec3 } from '../src/planning/kepler';
import { lambertStats, solveLambert } from '../src/planning/lambert';
import { FixedBodies, propagate } from '../src/physics/spacecraft';

/**
 * Independent check with the game's DOP853 propagator (rtol 1e-14) about a
 * fixed Sun, in AU / solar time units scaled to SI. Used where the
 * universal-variable Kepler propagator is itself ill-conditioned (hyperbolas at
 * hundreds of times escape speed).
 */
function dop853Residual(r1: Vec3, r2: Vec3, v1: Vec3, tof: number): number {
  const AU = 1.495978707e11;
  const mu = 1.32712440018e20;
  const TU = Math.sqrt((AU * AU * AU) / mu);
  const VU = AU / TU;
  const eph = new FixedBodies([{ gm: mu, position: [0, 0, 0] }]);
  const y0 = [r1[0] * AU, r1[1] * AU, r1[2] * AU, v1[0] * VU, v1[1] * VU, v1[2] * VU, 1];
  const y = propagate(eph, y0, 0, tof * TU, [], { rtol: 1e-14 }).y;
  return norm(sub([y[0] / AU, y[1] / AU, y[2] / AU], r2)) / norm(r2);
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDir(r: () => number): Vec3 {
  const z = 2 * r() - 1;
  const p = 2 * Math.PI * r();
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(p), s * Math.sin(p), z];
}

/** Position and velocity residual of a Lambert solution, relative to |r2| and |v2|. */
function residual(r1: Vec3, r2: Vec3, v1: Vec3, v2: Vec3, tof: number, mu: number): { dr: number; dv: number } {
  const p = keplerPropagate(r1, v1, tof, mu);
  return { dr: norm(sub(p.r, r2)) / norm(r2), dv: norm(sub(p.v, v2)) / norm(v2) };
}

describe('keplerPropagate', () => {
  it('returns to the start after one period and conserves energy on hyperbolas', () => {
    const mu = 3.986004418e14;
    const r0: Vec3 = [7e6, 0, 0];
    const v0: Vec3 = [0, 7.5e3, 1e3];
    const a = 1 / (2 / norm(r0) - dot(v0, v0) / mu);
    const P = 2 * Math.PI * Math.sqrt((a * a * a) / mu);
    const p = keplerPropagate(r0, v0, P, mu);
    expect(norm(sub(p.r, r0)) / norm(r0)).toBeLessThan(1e-11);
    const vh: Vec3 = [0, 12e3, 0];
    const q = keplerPropagate(r0, vh, 5e5, mu);
    const e0 = dot(vh, vh) / 2 - mu / norm(r0);
    const e1 = dot(q.v, q.v) / 2 - mu / norm(q.r);
    expect(Math.abs(e1 - e0) / Math.abs(e0)).toBeLessThan(1e-11);
    const back = keplerPropagate(q.r, q.v, -5e5, mu);
    expect(norm(sub(back.r, r0)) / norm(r0)).toBeLessThan(1e-10);
  });
});

describe('Izzo Lambert solver', () => {
  it('reproduces Vallado (2013) Example 7-5', () => {
    // Vallado, Fundamentals of Astrodynamics and Applications, 4th ed., Example 7-5:
    // r0 = (15945.34, 0, 0) km, r = (12214.83899, 10249.46731, 0) km, 76 min, short way.
    // Published: v0 = (2.058913, 2.915965, 0) km/s, v = (-3.451565, 0.910315, 0) km/s.
    const mu = 398600.4418e9;
    const r1: Vec3 = [15945.34e3, 0, 0];
    const r2: Vec3 = [12214.83899e3, 10249.46731e3, 0];
    const [s] = solveLambert(r1, r2, 76 * 60, mu, { refNormal: [0, 0, 1] });
    const ev1 = [2.058913, 2.915965, 0];
    const ev2 = [-3.451565, 0.910315, 0];
    for (let i = 0; i < 3; i++) {
      expect(s.v1[i] / 1e3).toBeCloseTo(ev1[i], 5);
      expect(s.v2[i] / 1e3).toBeCloseTo(ev2[i], 5);
    }
  });

  it('reproduces Curtis (2014) Example 5.2', () => {
    // Curtis, Orbital Mechanics for Engineering Students, 3rd ed., Example 5.2:
    // r1 = (5000, 10000, 2100) km, r2 = (-14600, 2500, 7000) km, 1 h, prograde (about +z).
    // Published: v1 = (-5.9925, 1.9254, 3.2456) km/s, v2 = (-3.3125, -4.1966, -0.38529) km/s.
    const mu = 398600e9;
    const [s] = solveLambert([5000e3, 10000e3, 2100e3], [-14600e3, 2500e3, 7000e3], 3600, mu, { refNormal: [0, 0, 1] });
    const ev1 = [-5.9925, 1.9254, 3.2456];
    const ev2 = [-3.3125, -4.1966, -0.38529];
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(s.v1[i] / 1e3 - ev1[i])).toBeLessThan(6e-5);
      expect(Math.abs(s.v2[i] / 1e3 - ev2[i])).toBeLessThan(6e-5);
    }
  });

  it('Hohmann half-orbit (exactly 180 deg) gives the Hohmann speeds', () => {
    const mu = 1.32712440018e20;
    const AU = 1.495978707e11;
    const r1: Vec3 = [AU, 0, 0];
    const r2: Vec3 = [-1.524 * AU, 0, 0];
    const a = (AU + 1.524 * AU) / 2;
    const tof = Math.PI * Math.sqrt((a * a * a) / mu);
    const [s] = solveLambert(r1, r2, tof, mu, { refNormal: [0, 0, 1] });
    const vp = Math.sqrt(mu * (2 / AU - 1 / a));
    expect(s.v1[1] / vp).toBeCloseTo(1, 10);
    expect(Math.abs(s.v1[0]) + Math.abs(s.v1[2])).toBeLessThan(1e-6 * vp);
    const res = residual(r1, r2, s.v1, s.v2, tof, mu);
    expect(res.dr).toBeLessThan(1e-11);
  });

  it('near-180-degree transfers stay accurate down to 1e-9 deg off antipodal', () => {
    const mu = 1;
    for (const epsDeg of [1, 1e-2, 1e-4, 1e-6, 1e-8, 1e-9, 0]) {
      const th = Math.PI - (epsDeg * Math.PI) / 180;
      const r1: Vec3 = [1, 0, 0];
      const r2: Vec3 = [1.5 * Math.cos(th), 1.5 * Math.sin(th), 0];
      for (const tof of [2.5, 4, 8]) {
        const [s] = solveLambert(r1, r2, tof, mu, { refNormal: [0, 0, 1] });
        const res = residual(r1, r2, s.v1, s.v2, tof, mu);
        expect(res.dr).toBeLessThan(1e-9);
        expect(res.dv).toBeLessThan(1e-8);
        // Prograde about +z.
        expect(cross(r1, s.v1)[2]).toBeGreaterThan(0);
      }
    }
  });

  it('handles hyperbolic and near-parabolic transfers', () => {
    const mu = 1;
    const r1: Vec3 = [1, 0, 0];
    const r2: Vec3 = [0, 2, 0.3];
    for (const tof of [1e-3, 0.05, 0.3, 0.8, 1.2, 1.5, 2]) {
      const [s] = solveLambert(r1, r2, tof, mu, { refNormal: [0, 0, 1] });
      const res = residual(r1, r2, s.v1, s.v2, tof, mu);
      expect(res.dr).toBeLessThan(1e-10);
      if (tof < 0.8) expect(s.x).toBeGreaterThan(1);
    }
  });

  it('multi-revolution branches each land on r2 with the right number of revolutions', () => {
    const mu = 1;
    const r1: Vec3 = [1, 0, 0];
    const r2: Vec3 = [-0.3, 1.2, 0.1];
    const tof = 40;
    const sols = solveLambert(r1, r2, tof, mu, { maxRevs: 10, refNormal: [0, 0, 1] });
    expect(sols.length).toBeGreaterThan(5);
    for (const s of sols) {
      const res = residual(r1, r2, s.v1, s.v2, tof, mu);
      expect(res.dr).toBeLessThan(1e-9);
      if (s.revs > 0) {
        const a = 1 / (2 / norm(r1) - dot(s.v1, s.v1) / mu);
        const P = 2 * Math.PI * Math.sqrt(a * a * a / mu);
        expect(tof).toBeGreaterThan(s.revs * P);
        expect(tof).toBeLessThan((s.revs + 1) * P);
      }
    }
  });

  it('randomised round trips: failure rate and accuracy', () => {
    const r = rng(12345);
    const mu = 1;
    lambertStats.branchFailures = 0;
    let cases = 0;
    let zeroRevFailures = 0;
    let solutions = 0;
    let worstDr = 0;
    let worstDv = 0;
    let wrongSense = 0;
    let revMismatch = 0;
    let dopChecks = 0;
    let worstCase = '';
    let worstExtreme = 0;
    for (let k = 0; k < 20000; k++) {
      const r1 = scaleV(randomDir(r), 0.3 + 5 * r());
      const r2 = scaleV(randomDir(r), 0.3 + 5 * r());
      const retro = r() < 0.5;
      // Time of flight log-uniform from very hyperbolic to many revolutions.
      const tof = Math.exp(Math.log(1e-3) + r() * Math.log(1e5));
      const sols = solveLambert(r1, r2, tof, mu, { retrograde: retro, maxRevs: 20, refNormal: ECLIPTIC_POLE_ICRF });
      cases++;
      if (sols.length === 0 || sols[0].revs !== 0) zeroRevFailures++;
      for (const s of sols) {
        solutions++;
        const res = residual(r1, r2, s.v1, s.v2, tof, mu);
        if (res.dr > 1e-9) {
          // Kepler check ill-conditioned (or a real failure): settle it with DOP853.
          dopChecks++;
          res.dr = dop853Residual(r1, r2, s.v1, tof);
          res.dv = 0;
        }
        if (tof < 0.01) {
          // Extreme hyperbolas (speed >~ 100x local escape): tracked separately.
          worstExtreme = Math.max(worstExtreme, res.dr);
          continue;
        }
        if (res.dr > worstDr) worstCase = JSON.stringify({ r1, r2, tof, retro, revs: s.revs, branch: s.branch, x: s.x, it: s.iterations, v1: s.v1, dr: res.dr });
        worstDr = Math.max(worstDr, res.dr);
        worstDv = Math.max(worstDv, res.dv);
        const h = dot(cross(r1, s.v1), ECLIPTIC_POLE_ICRF);
        const plane = dot(cross(r1, r2), ECLIPTIC_POLE_ICRF);
        // Sense check only where the plane is not nearly perpendicular to the reference.
        if (Math.abs(plane) > 1e-6 * norm(r1) * norm(r2) && (h > 0) === retro) wrongSense++;
        if (s.revs > 0) {
          const a = 1 / (2 / norm(r1) - dot(s.v1, s.v1) / mu);
          const P = 2 * Math.PI * Math.sqrt(a * a * a / mu);
          if (!(tof > s.revs * P * (1 - 1e-9) && tof < (s.revs + 1) * P * (1 + 1e-9))) revMismatch++;
        }
      }
    }
    console.log(`Lambert random: ${cases} cases, ${solutions} solutions, zero-rev failures ${zeroRevFailures}, worst |dr|/r2 ${worstDr.toExponential(2)}, worst |dv|/v2 ${worstDv.toExponential(2)}, wrong sense ${wrongSense}, rev mismatches ${revMismatch}, re-checked with DOP853 ${dopChecks}`);
    console.log('dropped N-rev branches', lambertStats.branchFailures);
    expect(lambertStats.branchFailures).toBe(0);
    console.log('worst case (tof >= 0.01)', worstCase, 'worst extreme-hyperbola |dr|/r2', worstExtreme.toExponential(2));
    expect(worstExtreme).toBeLessThan(1e-6);
    expect(zeroRevFailures).toBe(0);
    expect(wrongSense).toBe(0);
    expect(revMismatch).toBe(0);
    expect(worstDr).toBeLessThan(1e-8);
    expect(worstDv).toBeLessThan(1e-7);
  }, 120000);
});

function scaleV(v: Vec3, k: number): Vec3 {
  return [v[0] * k, v[1] * k, v[2] * k];
}
