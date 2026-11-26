/**
 * The massive-body integrator with an explicitly time-dependent force: a
 * zonal field whose pole moves (ZonalHarmonic.rotation). A deliberately fast
 * pole (one precession every ~3 orbits, plus a 5 deg nodding term) makes the
 * time dependence dominate, and the exact series (poleSpacing 0) keeps it
 * smooth, so these tests see the scheme itself: order 8 on both code paths
 * (with and without the velocity-dependent 1PN term), time reversibility,
 * and bit-identical resumption. The production pole table and its effect on
 * the real system are checked at the end.
 */
import { describe, expect, it } from 'vitest';
import { KAHAN_LI_8, NBodyIntegrator, type NBodyPhysics } from '../src/physics/nbody';
import type { IauRotation } from '../src/physics/orientation';
import { DAY, DEFAULT_STEP, J2000_BODIES, JULIAN_YEAR, bodyIndex, initialState, solarSystemPhysics } from '../src/physics/solar-system';

const GM = [4e14, 1e10];
const RADIUS = 7e6;
const R0 = 1e7;
const V0 = Math.sqrt(GM[0] / R0);
const PERIOD = 2 * Math.PI * Math.sqrt((R0 * R0 * R0) / GM[0]); // ~9.9e3 s
const CENTURY = 36525 * DAY;
/** RA advancing 360 deg per 3 orbits, Dec 60 deg nodding by 5 deg twice per orbit. */
const FAST: IauRotation = {
  naifId: 0,
  ra: [10, (360 / (3 * PERIOD)) * CENTURY, 0],
  dec: [60, 0, 0],
  pm: [0, 0, 0],
  nut: [{ angle: [30, (720 / PERIOD) * CENTURY], ra: 0, dec: 5, pm: 0 }],
};
// Inclined, slightly eccentric orbit, so the J2 force has every component.
const STATE = [0, 0, 0, 0, 0, 0, R0, 0, 0, 0, 0.8 * V0, 0.65 * V0];

function physics(rotation: IauRotation | undefined, relativity: boolean): NBodyPhysics {
  const z = { body: 0, j2: 0.05, radius: RADIUS, pole: [0, 0, 1] as [number, number, number], targets: [1], poleSpacing: 0 };
  return { zonal: [rotation ? { ...z, rotation } : z], ...(relativity ? { relativity: { sun: 0 } } : {}) };
}

function run(h: number, t0: number, steps: number, ph: NBodyPhysics): NBodyIntegrator {
  const it = new NBodyIntegrator(GM, STATE, t0, h, KAHAN_LI_8, ph);
  for (let i = 0; i < steps; i++) it.step();
  return it;
}
const err = (a: NBodyIntegrator, b: NBodyIntegrator) => Math.hypot(a.q[3] - b.q[3], a.q[4] - b.q[4], a.q[5] - b.q[5]);

describe('time-dependent zonal pole: the scheme', () => {
  for (const rel of [false, true]) {
    it(`is 8th order with the moving pole (${rel ? 'with 1PN: generalized Stormer-Verlet' : 'plain kick-drift'} path)`, () => {
      const ph = physics(FAST, rel);
      const t0 = 123.25 * DAY; // away from 0: stage times must be absolute
      const T = 5 * PERIOD;
      const ns = [32, 48, 64, 96];
      const refIt = run(T / 512, t0, 512, ph);
      const errs = ns.map((n) => err(run(T / n, t0, n, ph), refIt));
      const orders = errs.slice(1).map((e, i) => Math.log(errs[i] / e) / Math.log(ns[i + 1] / ns[i]));
      // The pole's time dependence is not negligible: freezing it moves the satellite by far more than the errors.
      const frozen = err(run(T / 512, t0, 512, physics(undefined, rel)), refIt);
      console.log(`moving pole, ${rel ? '1PN path' : 'plain path'}: steps over 5 orbits ${ns.join(', ')}: errors ${errs.map((e) => e.toExponential(2)).join(', ')} m; orders ${orders.map((o) => o.toFixed(2)).join(', ')}; frozen pole differs by ${frozen.toExponential(2)} m`);
      for (const o of orders) expect(o).toBeGreaterThan(7.5);
      expect(frozen).toBeGreaterThan(1e4 * errs[errs.length - 1]);
    });
  }

  it('is time-reversible with the moving pole, from an absolute start time', () => {
    for (const rel of [false, true]) {
      const ph = physics(FAST, rel);
      const h = PERIOD / 64;
      const f = run(h, 1e6, 640, ph);
      const s = new Float64Array(12);
      f.getState(s);
      const b = new NBodyIntegrator(GM, s, f.t, -h, KAHAN_LI_8, ph);
      b.importState(f.exportState(), 0);
      for (let i = 0; i < 640; i++) b.step();
      const back = Math.hypot(b.q[3] - STATE[6], b.q[4] - STATE[7], b.q[5] - STATE[8]);
      console.log(`moving pole, ${rel ? '1PN' : 'plain'}: 10 orbits forward and back return within ${back.toExponential(2)} m (orbit radius 1e7 m)`);
      // Roundoff: ~2e-13 of the orbit radius after 1280 steps (a fixed pole gives the same).
      expect(back).toBeLessThan(1e-5);
    }
  });

  it('resumes bit for bit from exported state, in both directions', () => {
    for (const dir of [1, -1]) {
      const ph = physics(FAST, true);
      const h = (dir * PERIOD) / 64;
      const a = run(h, 5e5, 100, ph);
      const s = new Float64Array(12);
      a.getState(s);
      const b = new NBodyIntegrator(GM, s, 5e5, h, KAHAN_LI_8, ph);
      b.importState(a.exportState(), a.steps);
      for (let i = 0; i < 150; i++) {
        a.step();
        b.step();
      }
      for (let k = 0; k < 6; k++) {
        expect(Object.is(a.q[k], b.q[k])).toBe(true);
        expect(Object.is(a.v[k], b.v[k])).toBe(true);
      }
    }
  });
});

describe('time-dependent poles in the real system', () => {
  it('the pole table (production) against the exact series: Moon and planets after 1 year', () => {
    const exact: NBodyPhysics = { ...solarSystemPhysics(), zonal: solarSystemPhysics().zonal!.map((z) => ({ ...z, poleSpacing: 0 })) };
    const go = (ph: NBodyPhysics, nudge = false) => {
      const s0 = initialState();
      if (nudge) for (let i = 0; i < s0.length; i += 6) s0[i] *= 1 + 2 ** -52; // one ulp in x: the roundoff floor
      const it = new NBodyIntegrator(J2000_BODIES.map((b) => b.gm), s0, 0, DEFAULT_STEP, KAHAN_LI_8, ph);
      const n = Math.round(JULIAN_YEAR / DEFAULT_STEP);
      const t = performance.now();
      while (it.steps < n) it.step();
      return { q: Float64Array.from(it.q), ms: performance.now() - t };
    };
    const tab = go(solarSystemPhysics());
    const ex = go(exact);
    const ulp = go(solarSystemPhysics(), true);
    const d = (a: Float64Array, b: Float64Array, i: number) => Math.hypot(a[3 * i] - b[3 * i], a[3 * i + 1] - b[3 * i + 1], a[3 * i + 2] - b[3 * i + 2]);
    const lines = J2000_BODIES.map((b, i) => `${b.id.padEnd(8)} table-exact ${d(tab.q, ex.q, i).toExponential(1)} m, 1-ulp start ${d(tab.q, ulp.q, i).toExponential(1)} m`);
    console.log(`1 yr, pole table vs exact series, and the roundoff floor (initial x nudged by one ulp):\n${lines.join('\n')}\ntime ${tab.ms.toFixed(0)} ms (table) vs ${ex.ms.toFixed(0)} ms (exact series at every force evaluation)`);
    // The table's own error (< 1e-6 deg, the Moon's) moves the Moon by < 1 mm in a year; every
    // other difference is roundoff amplified by the moons' orbits, the same size as a one-ulp start.
    expect(d(tab.q, ex.q, bodyIndex('moon'))).toBeLessThan(1e-3);
    J2000_BODIES.forEach((b, i) => expect(d(tab.q, ex.q, i), b.id).toBeLessThan(Math.max(10 * d(tab.q, ulp.q, i), 1e-3)));
  }, 120_000);
});
