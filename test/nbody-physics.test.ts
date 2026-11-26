/**
 * Production massive-body physics: Newtonian + J2 pairs + Sun 1PN.
 * Order, reversibility, conservation, step size, agreement with an independent
 * RK4 implementation, and the Horizons comparison next to the Newtonian one.
 *
 * Run with `--silent=false` to see the tables.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { KAHAN_LI_8, NBodyIntegrator, conservedEnergy, invariants, type NBodyPhysics } from '../src/physics/nbody';
import {
  DAY,
  DEFAULT_STEP,
  J2000_BODIES,
  JULIAN_YEAR,
  bodyIndex,
  initialState,
  solarSystemPhysics,
  zonalTerms,
} from '../src/physics/solar-system';
import ref from './fixtures/horizons-reference.json';
import { RAD_TO_ARCSEC, eccVector, integrateRK4, relative, signedAngle } from './helpers/analysis';

const bodies = J2000_BODIES;
const N = bodies.length;
const gm = bodies.map((b) => b.gm);
const s0 = initialState();
const ids = bodies.map((b) => b.id);
const SUN = bodyIndex('sun');
const EARTH = bodyIndex('earth');
const MOON = bodyIndex('moon');
const MERCURY = bodyIndex('mercury');
const FULL = solarSystemPhysics();
const NEWTON: NBodyPhysics = {};

const refTimes = [...new Set(ref.bodies.flatMap((b) => b.samples.map((s) => s.t)))].sort((a, b) => a - b);

function horizonsState(t: number): Float64Array | null {
  const out = new Float64Array(6 * N);
  for (let i = 0; i < N; i++) {
    const s = ref.bodies[i].samples.find((x) => x.t === t);
    if (!s) return null;
    out.set(s.state, 6 * i);
  }
  return out;
}

function run(physics: NBodyPhysics, h: number, steps: number, state: ArrayLike<number> = s0, t0 = 0): Float64Array {
  const it = new NBodyIntegrator(gm, state, t0, h, KAHAN_LI_8, physics);
  for (let i = 0; i < steps; i++) it.step();
  const out = new Float64Array(6 * N);
  it.getState(out);
  return out;
}

function runCapture(physics: NBodyPhysics, h: number, times: number[]): Map<number, Float64Array> {
  const out = new Map<number, Float64Array>();
  const it = new NBodyIntegrator(gm, s0, 0, h, KAHAN_LI_8, physics);
  for (const t of [...times].sort((a, b) => Math.abs(a) - Math.abs(b))) {
    const k = Math.round(t / h);
    if (Math.abs(k * h - t) > 1e-6) throw new Error('time not on grid');
    while (it.steps < Math.abs(k)) it.step();
    const s = new Float64Array(6 * N);
    it.getState(s);
    out.set(t, s);
  }
  return out;
}

const posErr = (a: ArrayLike<number>, b: ArrayLike<number>, i: number) =>
  Math.hypot(a[6 * i] - b[6 * i], a[6 * i + 1] - b[6 * i + 1], a[6 * i + 2] - b[6 * i + 2]);
const geoMoonErr = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(
    a[6 * MOON] - a[6 * EARTH] - (b[6 * MOON] - b[6 * EARTH]),
    a[6 * MOON + 1] - a[6 * EARTH + 1] - (b[6 * MOON + 1] - b[6 * EARTH + 1]),
    a[6 * MOON + 2] - a[6 * EARTH + 2] - (b[6 * MOON + 2] - b[6 * EARTH + 2]),
  );

describe('1PN + J2 integrator: order and reversibility', () => {
  it('keeps order 8 with the Sun 1PN term and Sun J2 (Sun + Mercury)', () => {
    // Two bodies on Mercury's orbit; reference: 4x finer step. The 1PN force is
    // ~1e-7 of gravity and would produce a first-order error of ~1e2..1e4 m here
    // if the velocity dependence were handled naively.
    const sun = bodies[SUN];
    const merc = bodies[MERCURY];
    const g = [sun.gm, merc.gm];
    const st = [...sun.state, ...merc.state];
    const phys: NBodyPhysics = { relativity: { sun: 0 }, zonal: [{ body: 0, j2: sun.j2!, radius: sun.j2Radius!, pole: [sun.pole![0], sun.pole![1], sun.pole![2]], targets: [1] }] };
    const period = 87.969 * DAY;
    const orbits = 20;
    const go = (nPer: number) => {
      const it = new NBodyIntegrator(g, st, 0, period / nPer, KAHAN_LI_8, phys);
      for (let i = 0; i < nPer * orbits; i++) it.step();
      return Float64Array.from(it.q);
    };
    const ns = [16, 24, 32, 48];
    const refQ = go(256);
    const errs = ns.map((n) => {
      const q = go(n);
      return Math.hypot(q[3] - q[0] - (refQ[3] - refQ[0]), q[4] - q[1] - (refQ[4] - refQ[1]), q[5] - q[2] - (refQ[5] - refQ[2]));
    });
    const orders = errs.slice(1).map((e, i) => Math.log(errs[i] / e) / Math.log(ns[i + 1] / ns[i]));
    console.log('1PN+J2 Sun-Mercury: steps/orbit', ns, 'errors (m)', errs.map((e) => e.toExponential(2)), 'order', orders.map((o) => o.toFixed(2)));
    for (const o of orders) {
      expect(o).toBeGreaterThan(7.5);
      expect(o).toBeLessThan(8.7);
    }
  });

  it('forward 10 years then backward returns to the start (full physics)', () => {
    const h = DEFAULT_STEP;
    const n = Math.round((10 * JULIAN_YEAR) / h);
    const mid = run(FULL, h, n);
    const end = run(FULL, -h, n, mid, n * h);
    const errs = ids.map((_, i) => posErr(end, s0, i));
    console.log('full physics forward/back 10 yr, position error (m):', Object.fromEntries(ids.map((id, i) => [id, errs[i].toExponential(1)])));
    // The scheme is exactly symmetric; the fixed 2-iteration implicit solve
    // leaves a ~1e-27 relative asymmetry, far below roundoff. Observed: same
    // size as the Newtonian case (Moon ~cm).
    expect(Math.max(...errs)).toBeLessThan(0.2);
  });

  it('agrees with an independent RK4 implementation of the same forces', () => {
    // RK4 at 0.0125 d (test helper) with Sun 1PN and Earth J2 on the Moon (pole
    // ICRF z, like the data file) vs production with the same two terms only.
    // RK4 itself converges to production as its step shrinks (2 yr, Moon:
    // 72 m at 0.05 d, 3.1 m at 0.025 d, 0.5 m at 0.0125 d).
    const T = 2 * JULIAN_YEAR;
    const earth = bodies[EARTH];
    const phys: NBodyPhysics = { relativity: { sun: SUN }, zonal: zonalTerms({ earth: ['moon'] }) };
    const prod = run(phys, 0.25 * DAY, Math.round(T / (0.25 * DAY)));
    const hRK = 0.0125 * DAY;
    const rk = integrateRK4(gm, s0, hRK, Math.round(T / hRK), true, SUN, { body: EARTH, on: MOON, j2: earth.j2!, radius: earth.j2Radius! });
    const errs = ids.map((_, i) => posErr(prod, rk, i));
    console.log('production vs RK4 after 2 yr (m):', Object.fromEntries(ids.map((id, i) => [id, errs[i].toExponential(1)])));
    // RK4 truncation error dominates. Observed: Moon 0.5 m, Mercury 0.04 m, Earth 0.015 m.
    expect(errs[MOON]).toBeLessThan(3);
    for (let i = 0; i < N; i++) if (i !== MOON) expect(errs[i]).toBeLessThan(0.5);
  }, 60_000);
});

describe('conservation with J2 and 1PN', () => {
  it('J2 only: total energy including the J2 pair potentials is conserved', () => {
    const phys: NBodyPhysics = { zonal: FULL.zonal };
    const h = DEFAULT_STEP;
    const E0 = conservedEnergy(gm, s0, phys);
    const N0 = invariants(gm, s0).energy;
    let max = 0;
    let maxNewton = 0;
    const it = new NBodyIntegrator(gm, s0, 0, h, KAHAN_LI_8, phys);
    const st = new Float64Array(6 * N);
    for (let y = 1; y <= 20; y++) {
      for (let k = 0; k < 730; k++) it.step();
      it.getState(st);
      max = Math.max(max, Math.abs(conservedEnergy(gm, st, phys) / E0 - 1));
      maxNewton = Math.max(maxNewton, Math.abs(invariants(gm, st).energy / N0 - 1));
    }
    console.log(`J2 only, 20 yr: |dE/E| with J2 potential ${max.toExponential(2)}, Newtonian energy alone ${maxNewton.toExponential(2)}`);
    // Still a symplectic (Hamiltonian, separable) system: roundoff level.
    expect(max).toBeLessThan(2e-14);
  });

  it('full physics: momentum exact, 1PN energy conserved to its expected level', () => {
    const h = DEFAULT_STEP;
    const inv0 = invariants(gm, s0);
    const E0 = conservedEnergy(gm, s0, FULL);
    const pScale = Math.hypot(...bodies.map((b, i) => b.gm * Math.hypot(s0[6 * i + 3], s0[6 * i + 4], s0[6 * i + 5])));
    const L0 = Math.hypot(...inv0.L);
    const it = new NBodyIntegrator(gm, s0, 0, h, KAHAN_LI_8, FULL);
    const st = new Float64Array(6 * N);
    let dEN = 0;
    let dE = 0;
    let dP = 0;
    let dL = 0;
    for (let y = 1; y <= 100; y++) {
      for (let k = 0; k < 730; k++) it.step();
      it.getState(st);
      const inv = invariants(gm, st);
      dEN = Math.max(dEN, Math.abs(inv.energy / inv0.energy - 1));
      dE = Math.max(dE, Math.abs(conservedEnergy(gm, st, FULL) / E0 - 1));
      dP = Math.max(dP, Math.hypot(inv.p[0] - inv0.p[0], inv.p[1] - inv0.p[1], inv.p[2] - inv0.p[2]) / pScale);
      dL = Math.max(dL, Math.hypot(inv.L[0] - inv0.L[0], inv.L[1] - inv0.L[1], inv.L[2] - inv0.L[2]) / L0);
    }
    console.log(
      `full physics, 100 yr: max |dE/E| Newtonian energy ${dEN.toExponential(2)}, with 1PN + J2 terms ${dE.toExponential(2)}; ` +
        `|dP|/sum|p| ${dP.toExponential(2)}; |dL|/|L| (Newtonian L) ${dL.toExponential(2)}`,
    );
    // Linear momentum: every extra force has an equal and opposite reaction.
    expect(dP).toBeLessThan(1e-13);
    // The 1PN-corrected energy is much better conserved than the Newtonian one,
    // but not exactly: with Sun-only 1PN plus the Sun's reaction there is no
    // exact invariant (that needs full EIH). Thresholds ~3x observed.
    expect(dE).toBeLessThan(dEN / 10);
    expect(dE).toBeLessThan(3e-11);
    // Newtonian angular momentum is not conserved: fixed J2 poles exert torque
    // and the 1PN force has a non-central (v) part. Observed level, as a regression.
    expect(dL).toBeLessThan(1e-9);
  }, 60_000);
});

describe('full physics vs Horizons', () => {
  let full: Map<number, Float64Array>;
  let newton: Map<number, Float64Array>;
  const H = 0.25 * DAY; // fixture dates are on the 0.25 d grid, not on 0.5 d

  beforeAll(() => {
    const fwd = refTimes.filter((t) => t > 0);
    const bwd = refTimes.filter((t) => t < 0);
    full = new Map([...runCapture(FULL, H, fwd), ...runCapture(FULL, -H, bwd)]);
    newton = new Map([...runCapture(NEWTON, H, fwd), ...runCapture(NEWTON, -H, bwd)]);
  }, 120_000);

  it('step-halving with full physics confirms the 0.5 d default', () => {
    const T = 18260 * DAY;
    const steps = [2, 1, 0.5, 0.25, 0.125].map((d) => d * DAY);
    const res = steps.map((h) => run(FULL, h, Math.round(T / h)));
    console.log('Full physics: position change at +50 yr when the step is halved (m):');
    console.table(ids.map((id, i) => ({ body: id, ...Object.fromEntries(steps.slice(0, -1).map((h, j) => [`${h / DAY}d vs ${h / 2 / DAY}d`, Number(posErr(res[j], res[j + 1], i).toPrecision(3))])) })));
    const moon = (j: number) => posErr(res[j], res[j + 1], MOON);
    // Observed Moon: 2d/1d 2.6e5, 1d/0.5d 894, 0.5d/0.25d 5.2, 0.25d/0.125d 0.56 m.
    // Ratios ~290 and ~170: order-8 regime down to 0.5 d, roundoff floor below,
    // as in the Newtonian case. 0.5 d stays the default: ~5 m Moon and < 0.1 m
    // planet numerical error after 50 yr, vs >= 10 km physics residuals.
    expect(moon(0) / moon(1)).toBeGreaterThan(150);
    expect(moon(1) / moon(2)).toBeGreaterThan(150);
    const iD = steps.indexOf(DEFAULT_STEP);
    expect(moon(iD)).toBeLessThan(10);
    for (let i = 0; i < N; i++) if (i !== MOON) expect(posErr(res[iD], res[iD + 1], i)).toBeLessThan(0.1);
  }, 120_000);

  it('error table, Newtonian vs full physics', () => {
    const rows: Record<string, string | number>[] = [];
    for (const t of refTimes) {
      const hz = horizonsState(t);
      if (!hz) continue;
      const f = full.get(t)!;
      const n = newton.get(t)!;
      rows.push({
        years: Number((t / JULIAN_YEAR).toFixed(2)),
        ...Object.fromEntries(ids.map((id, i) => [id, `${Math.round(posErr(n, hz, i) / 1e3)} / ${Math.round(posErr(f, hz, i) / 1e3)}`])),
        'moon geo': `${Math.round(geoMoonErr(n, hz) / 1e3)} / ${Math.round(geoMoonErr(f, hz) / 1e3)}`,
      });
    }
    console.log('Position error vs Horizons, km: "Newtonian / full physics"');
    console.table(rows);

    // Regression thresholds for full physics (km) at |t| = 1, 10, 50, 100 yr,
    // ~1.5x the larger observed +t/-t error (observed in comments). What is left:
    //  - planets: ~linear along-track drift of 30-80 km/century, consistent with
    //    the 343 asteroids and Kuiper-belt ring in DE440/441 (not modelled) and
    //    the Sun's reflex to them (Sun 45-59 km);
    //  - Uranus..Pluto: unchanged by GR/J2, same cause;
    //  - Moon (Earth-relative): ~4 km/yr, not attributed with evidence; candidates
    //    are lunar C22 and higher figure terms, Earth tides (secular acceleration),
    //    Earth J3/J4 and the precession of Earth's pole (0.56 deg/century), all
    //    modelled in DE440 and not here.
    const limitsKm: Record<string, number[]> = {
      sun: [1, 6, 35, 90], // obs <0.5/4/23/59
      mercury: [2, 7, 40, 85], // obs <0.5/4/25/55
      venus: [2, 7, 35, 95], // obs <0.5/4/23/63
      earth: [2, 7, 35, 85], // obs <0.5/4/21/56
      moon: [7, 65, 320, 580], // obs 4/41/215/384
      mars: [2, 10, 30, 120], // obs <0.5/6/16/79
      jupiter: [2, 11, 35, 105], // obs <0.5/7/21/69
      saturn: [2, 6, 40, 90], // obs <0.5/4/27/59
      uranus: [2, 5, 190, 290], // obs <0.5/3/126/194
      neptune: [2, 11, 350, 1560], // obs <0.5/7/232/1041
      pluto: [2, 11, 345, 1200], // obs <0.5/7/229/803
    };
    const moonGeoKm = [7, 65, 300, 630]; // obs 4/42/199/418
    for (const t of refTimes) {
      const y = Math.abs(t / JULIAN_YEAR);
      const col = [1, 10, 50, 100].findIndex((v) => Math.abs(v - y) < 1e-9);
      if (col < 0) continue;
      const hz = horizonsState(t)!;
      const f = full.get(t)!;
      ids.forEach((id, i) => expect(posErr(f, hz, i) / 1e3, `${id} at ${t / JULIAN_YEAR} yr`).toBeLessThan(limitsKm[id][col]));
      expect(geoMoonErr(f, hz) / 1e3).toBeLessThan(moonGeoKm[col]);
    }
  });

  it("Mercury's 43\"/century perihelion residual is gone", () => {
    for (const years of [-100, 100]) {
      const t = years * JULIAN_YEAR;
      const hz = horizonsState(t)!;
      const mu = gm[SUN] + gm[MERCURY];
      const Hh = relative(hz, MERCURY, SUN);
      const Oo = relative(full.get(t)!, MERCURY, SUN);
      const eh = eccVector(Hh.r, Hh.v, mu);
      const d = signedAngle(eccVector(Oo.r, Oo.v, mu).e, eh.e, eh.hHat) * RAD_TO_ARCSEC;
      console.log(`Mercury perihelion, Horizons minus full physics at ${years} yr: ${d.toFixed(3)}"`);
      expect(Math.abs(d)).toBeLessThan(0.3);
    }
  });
});
