/**
 * The real solar system with NEWTONIAN POINT MASSES ONLY (the baseline):
 * conservation, step-size convergence, reversibility, and comparison with JPL
 * Horizons (DE441), with the residuals attributed. The production physics
 * (J2 + Sun 1PN) is tested in nbody-physics.test.ts.
 *
 * Run with `--silent=false` to see the tables.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { NBodyIntegrator, invariants } from '../src/physics/nbody';
import { DAY, DEFAULT_STEP, J2000_BODIES, JULIAN_YEAR, bodyIndex, initialState } from '../src/physics/solar-system';
import ref from './fixtures/horizons-reference.json';
import { RAD_TO_ARCSEC, eccVector, integrateRK4, relative, rtn, signedAngle, type Vec3 } from './helpers/analysis';

const bodies = J2000_BODIES;
const N = bodies.length;
const gm = bodies.map((b) => b.gm);
const s0 = initialState();
const ids = bodies.map((b) => b.id);
const SUN = bodyIndex('sun');
const EARTH = bodyIndex('earth');
const MOON = bodyIndex('moon');
const MERCURY = bodyIndex('mercury');

/** Every distinct reference time in the fixture, seconds from J2000. */
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

/** Integrate from J2000 in one direction, capturing the state at the given times (multiples of h). */
function runCapture(h: number, times: number[]): Map<number, Float64Array> {
  const out = new Map<number, Float64Array>();
  const it = new NBodyIntegrator(gm, s0, 0, h);
  const targets = times.map((t) => Math.round(t / h)).sort((a, b) => Math.abs(a) - Math.abs(b));
  for (const k of targets) {
    if (Math.abs(k * h - times.find((t) => Math.round(t / h) === k)!) > 1e-6) throw new Error('time not on grid');
    while (it.steps < Math.abs(k)) it.step();
    const s = new Float64Array(6 * N);
    it.getState(s);
    out.set(k * h, s);
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

let states: Map<number, Float64Array>;
let conservation: { t: number; dE: number; dP: number; dL: number }[];

/**
 * Step used for the Horizons comparison: 0.25 d, because the fixture dates
 * (multiples of 365.25 d) are not on the 0.5 d default grid. The step-halving
 * test shows 0.25 d and 0.5 d agree to ~2 m (Moon), so this is the same answer.
 */
const COMPARE_STEP = 0.25 * DAY;

beforeAll(() => {
  const fwdTimes = refTimes.filter((t) => t > 0);
  const bwdTimes = refTimes.filter((t) => t < 0);
  states = new Map([...runCapture(COMPARE_STEP, fwdTimes), ...runCapture(-COMPARE_STEP, bwdTimes)]);
  const h = DEFAULT_STEP;

  // Conservation over 100 years, sampled every year.
  const inv0 = invariants(gm, s0);
  const pScale = Math.hypot(...bodies.map((b, i) => b.gm * Math.hypot(s0[6 * i + 3], s0[6 * i + 4], s0[6 * i + 5])));
  const L0 = Math.hypot(...inv0.L);
  conservation = [];
  const it = new NBodyIntegrator(gm, s0, 0, h);
  const perYear = Math.round(JULIAN_YEAR / h); // sampling cadence only; need not be exact
  const st = new Float64Array(6 * N);
  for (let y = 1; y <= 100; y++) {
    for (let k = 0; k < perYear; k++) it.step();
    it.getState(st);
    const inv = invariants(gm, st);
    conservation.push({
      t: y,
      dE: Math.abs(inv.energy / inv0.energy - 1),
      dP: Math.hypot(inv.p[0] - inv0.p[0], inv.p[1] - inv0.p[1], inv.p[2] - inv0.p[2]) / pScale,
      dL: Math.hypot(inv.L[0] - inv0.L[0], inv.L[1] - inv0.L[1], inv.L[2] - inv0.L[2]) / L0,
    });
  }
}, 120_000);

describe('real solar system, Newtonian point masses (baseline)', () => {
  it('conserves energy, linear and angular momentum over 100 years', () => {
    const maxE = Math.max(...conservation.map((c) => c.dE));
    const maxP = Math.max(...conservation.map((c) => c.dP));
    const maxL = Math.max(...conservation.map((c) => c.dL));
    const last = conservation[conservation.length - 1];
    console.log(
      `conservation over 100 yr at h=${DEFAULT_STEP / DAY} d: max |dE/E|=${maxE.toExponential(2)} (final ${last.dE.toExponential(2)}),` +
        ` max |dP|/sum|p|=${maxP.toExponential(2)}, max |dL|/|L|=${maxL.toExponential(2)}`,
    );
    // Symplectic: energy error is bounded, not drifting. Observed max ~3e-15 at
    // 0.5 d and 0.25 d alike, i.e. the truncation part is below roundoff.
    // Momentum and angular momentum are conserved exactly by the scheme up to roundoff.
    expect(maxE).toBeLessThan(2e-14);
    expect(maxP).toBeLessThan(1e-13);
    expect(maxL).toBeLessThan(1e-13);
    // No secular energy drift: the last decade is no worse than the max of the first.
    const firstDecade = Math.max(...conservation.slice(0, 10).map((c) => c.dE));
    const lastDecade = Math.max(...conservation.slice(90).map((c) => c.dE));
    expect(lastDecade).toBeLessThan(3 * firstDecade + 1e-14);
  });

  it('step-halving: position change at +50 yr bounds the numerical error', () => {
    const T = 18260 * DAY; // ~50 yr (49.99), a multiple of every step size tested
    const steps = [4, 2, 1, 0.5, 0.25, 0.125].map((d) => d * DAY);
    const res = steps.map((h) => runCapture(h, [T]).get(T)!);
    const rows = ids.map((id, i) => ({
      body: id,
      ...Object.fromEntries(steps.slice(0, -1).map((h, j) => [`${h / DAY}d vs ${h / 2 / DAY}d (m)`, Number(posErr(res[j], res[j + 1], i).toPrecision(3))])),
    }));
    console.log('Position change at +50 yr when the step is halved:');
    console.table(rows);
    // Observed (m), Moon: 4d/2d 1.2e8, 2d/1d 2.6e5, 1d/0.5d 900, 0.5d/0.25d 2.3,
    // 0.25d/0.125d 0.65. Successive ratios ~290 and ~400 ~ 2^8: the real system
    // shows the scheme's order 8 down to 0.5 d. At 0.25 d the change stops
    // dropping: that is the accumulated-roundoff floor (~0.6 m over 50 yr).
    const moon = (j: number) => posErr(res[j], res[j + 1], MOON);
    const r1 = moon(1) / moon(2);
    const r2 = moon(2) / moon(3);
    expect(r1).toBeGreaterThan(150);
    expect(r2).toBeGreaterThan(150);
    // Default step 0.5 d: its error (~ the 0.5d/0.25d change, 2.3 m for the Moon,
    // <= 4 cm for planets, after 50 yr) is ~5 orders below the missing-physics
    // error vs Horizons, at half the cost of 0.25 d. 4 d is still stable but the
    // Moon error is 1e5 km; 2 d gives 260 km, so 0.5 d leaves a 4x stability and
    // accuracy margin.
    const iDefault = steps.indexOf(DEFAULT_STEP);
    expect(posErr(res[iDefault], res[iDefault + 1], MOON)).toBeLessThan(5);
    for (let i = 0; i < N; i++) if (i !== MOON) expect(posErr(res[iDefault], res[iDefault + 1], i)).toBeLessThan(0.1);
  }, 60_000);

  it('forward 10 years then backward returns to the start', () => {
    const h = DEFAULT_STEP;
    const n = Math.round((10 * JULIAN_YEAR) / h);
    const f = new NBodyIntegrator(gm, s0, 0, h);
    for (let i = 0; i < n; i++) f.step();
    const mid = new Float64Array(6 * N);
    f.getState(mid);
    const b = new NBodyIntegrator(gm, mid, f.t, -h);
    for (let i = 0; i < n; i++) b.step();
    const end = new Float64Array(6 * N);
    b.getState(end);
    const errs = ids.map((_, i) => posErr(end, s0, i));
    console.log('forward/back 10 yr, position error per body (m):', Object.fromEntries(ids.map((id, i) => [id, errs[i].toExponential(1)])));
    expect(b.t).toBe(0);
    // Roundoff only (the scheme is exactly symmetric). Observed: Moon ~4e-2 m,
    // planets <= 1e-2 m, after 2 x 14610 steps.
    expect(Math.max(...errs)).toBeLessThan(0.2);
  });

  it('matches Horizons within the error explained by missing physics', () => {
    const rows: Record<string, string | number>[] = [];
    const errAt = new Map<number, number[]>();
    for (const t of refTimes) {
      const hz = horizonsState(t);
      if (!hz) continue;
      const ours = states.get(t)!;
      const e = ids.map((_, i) => posErr(ours, hz, i));
      errAt.set(t, e);
      rows.push({
        years: Number((t / JULIAN_YEAR).toFixed(2)),
        ...Object.fromEntries(ids.map((id, i) => [id, Math.round(e[i] / 1000)])),
        'moon geo': Math.round(geoMoonErr(ours, hz) / 1000),
      });
    }
    console.log('Position error vs Horizons (km). "moon geo" is the Earth-relative Moon error.');
    console.table(rows);

    // Regression thresholds (km) at |t| = 1, 10, 50, 100 yr: ~1.5x the larger
    // of the observed +t / -t errors at time of writing. Growth is ~linear in t
    // (along-track drift from a mean-motion offset); Mercury's oscillates with
    // the phase of its perihelion error. Attribution (see the tests below):
    const limitsKm: Record<string, number[]> = {
      sun: [1, 8, 40, 90], // obs 0/4/23/59. Barycentre reflex of asteroids/KBOs not modelled; GR does not help.
      mercury: [150, 2800, 12500, 12500], // obs 66/1823/8282/8327. GR: 43"/cy perihelion + mean-motion offset.
      venus: [150, 1400, 7000, 14000], // obs 99/919/4625/9186. GR (along-track); 47 km left with Sun 1PN.
      earth: [100, 1000, 4600, 9200], // obs 61/611/3053/6109. GR (along-track); 36 km left with Sun 1PN.
      moon: [110, 1100, 4600, 12000], // obs 71/747/3062/7838. Earth's GR drift + geocentric drift ("moon geo").
      mars: [60, 600, 2700, 6800], // obs 40/382/1788/4532. GR; 63 km left with Sun 1PN (asteroids).
      jupiter: [5, 110, 420, 700], // obs 1/71/275/455. GR + asteroids.
      saturn: [2, 25, 200, 310], // obs 0/16/130/206. GR + asteroids/KBOs.
      uranus: [2, 8, 240, 360], // obs 0/4/160/240. Not GR; KBO ring / asteroid masses in DE440.
      neptune: [2, 12, 360, 1650], // obs 0/7/242/1081. Not GR; Kuiper-belt ring in DE440.
      pluto: [2, 12, 360, 1250], // obs 0/8/236/833. Same.
    };
    // Earth-relative Moon, obs 20/185/914/1826 km: Earth J2 (~75%, see below),
    // plus lunar figure, tides and Earth's pole precession.
    const moonGeoKm = [30, 280, 1400, 2700];
    for (const [t, e] of errAt) {
      const y = Math.abs(t / JULIAN_YEAR);
      const col = [1, 10, 50, 100].findIndex((v) => Math.abs(v - y) < 1e-9);
      if (col < 0) continue;
      ids.forEach((id, i) => expect(e[i] / 1000, `${id} at ${t / JULIAN_YEAR} yr`).toBeLessThan(limitsKm[id][col]));
      expect(geoMoonErr(states.get(t)!, horizonsState(t)!) / 1000).toBeLessThan(moonGeoKm[col]);
    }
  });

  it('Mercury residual is a perihelion rotation of 43"/century (GR)', () => {
    // Angle from our Sun-relative eccentricity vector to Horizons', about the orbit normal.
    const rows = [];
    for (const years of [-100, -50, 50, 100]) {
      const t = years * JULIAN_YEAR;
      const hz = horizonsState(t)!;
      const ours = states.get(t)!;
      const mu = gm[SUN] + gm[MERCURY];
      const H = relative(hz, MERCURY, SUN);
      const O = relative(ours, MERCURY, SUN);
      const eh = eccVector(H.r, H.v, mu);
      const eo = eccVector(O.r, O.v, mu);
      const dPeri = signedAngle(eo.e, eh.e, eh.hHat) * RAD_TO_ARCSEC;
      const d: Vec3 = [0, 1, 2].map((k) => ours[6 * MERCURY + k] - hz[6 * MERCURY + k]) as Vec3;
      const c = rtn(d, H.r, H.v);
      rows.push({ years, 'dPeri (arcsec)': dPeri.toFixed(2), 'arcsec/cy': ((dPeri * 100) / years).toFixed(2), radialKm: Math.round(c.radial / 1e3), alongKm: Math.round(c.along / 1e3), crossKm: Math.round(c.cross / 1e3) });
      // GR predicts 42.98"/cy; Newtonian planetary perturbations are in both models
      // and cancel. Observed 43.05"/cy.
      expect(Math.abs((dPeri * 100) / years - 42.98)).toBeLessThan(0.5);
      // Error is in the orbit plane: cross-track is < 1% of the total.
      expect(Math.abs(c.cross)).toBeLessThan(0.01 * Math.hypot(c.radial, c.along));
    }
    console.log('Mercury: Horizons perihelion minus ours, and position error in radial/along/cross-track (km)');
    console.table(rows);
  });

  it('adding Sun 1PN (GR) removes the bulk of the inner-planet error (independent RK4 check)', () => {
    // Test-side RK4 at 0.05 d, independent of the production integrator. If the
    // Newtonian residual is GR, adding the Schwarzschild 1PN term must collapse it.
    const T = 100 * JULIAN_YEAR;
    const hRK = 0.05 * DAY;
    const pn = integrateRK4(gm, s0, hRK, Math.round(T / hRK), true);
    const hz = horizonsState(T)!;
    const ours = states.get(T)!;
    // Observed: Mercury 7409 -> 51, Venus 9186 -> 47, Earth 6109 -> 36, Mars 4110 -> 63, Jupiter 424 -> 76.
    for (const id of ['mercury', 'venus', 'earth', 'mars']) {
      const i = ids.indexOf(id);
      expect(posErr(pn, hz, i)).toBeLessThan(0.03 * posErr(ours, hz, i));
    }
    // But GR does almost nothing for the Moon's Earth-relative error (~1450 km).
    expect(geoMoonErr(pn, hz)).toBeGreaterThan(0.9 * geoMoonErr(ours, hz));
  }, 120_000);
});
