/**
 * The full body set (Sun, planets, Moon and 15 major moons) at the production
 * step DEFAULT_STEP = 1/32 d: convergence order with moons, time reversibility,
 * checkpoint export/import resume in both directions, and agreement with JPL
 * Horizons (test/fixtures/horizons-moons.json, made by scripts/fetch-horizons.py).
 *
 * The +-1 yr Horizons comparison runs by default (~3 s); +-10 and +-25 yr take
 * ~30 s and run with `pnpm test:slow` (SLOW=1).
 */
import { describe, expect, it } from 'vitest';
import { KAHAN_LI_8, NBodyIntegrator } from '../src/physics/nbody';
import { DAY, DEFAULT_STEP, J2000_BODIES, JULIAN_YEAR, bodyIndex, initialState, solarSystemPhysics } from '../src/physics/solar-system';
import ref from './fixtures/horizons-moons.json';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SLOW = ENV.SLOW === '1';
const B = J2000_BODIES;
const N = B.length;
const GM = B.map((b) => b.gm);
const PHYS = solarSystemPhysics();
const IO = bodyIndex('io');
const make = (h: number) => new NBodyIntegrator(GM, initialState(), 0, h, KAHAN_LI_8, PHYS);
const dist = (a: ArrayLike<number>, b: ArrayLike<number>, i: number) => Math.hypot(a[3 * i] - b[3 * i], a[3 * i + 1] - b[3 * i + 1], a[3 * i + 2] - b[3 * i + 2]);

describe('full body set: numerics', () => {
  it('converges at 8th order with the moons (Io, 20 days)', () => {
    const T = 20 * DAY;
    const run = (h: number) => {
      const it = make(h);
      while (it.steps < Math.round(T / h)) it.step();
      return Float64Array.from(it.q);
    };
    const refQ = run(DAY / 64);
    const errs = [8, 16, 32].map((d) => dist(run(DAY / d), refQ, IO));
    console.log(`Io error after 20 d vs h = 1/64 d: h = 1/8 d ${errs[0].toExponential(2)} m, 1/16 ${errs[1].toExponential(2)}, 1/32 ${errs[2].toExponential(2)}; ratios ${(errs[0] / errs[1]).toFixed(0)}, ${(errs[1] / errs[2]).toFixed(0)} (2^8 = 256)`);
    // Halving the step divides the error by ~2^8. The 1/32 -> 1/64 difference
    // is still included in errs[2], so the second ratio reads a little low.
    expect(errs[0] / errs[1]).toBeGreaterThan(150);
    expect(errs[1] / errs[2]).toBeGreaterThan(100);
    expect(errs[2]).toBeLessThan(1);
  }, 60_000);

  it('is time-reversible: 30 days forward and back returns to the start', () => {
    const it = make(DEFAULT_STEP);
    const q0 = Float64Array.from(it.q);
    const steps = Math.round((30 * DAY) / DEFAULT_STEP);
    for (let i = 0; i < steps; i++) it.step();
    const back = new NBodyIntegrator(GM, (() => {
      const s = new Float64Array(6 * N);
      it.getState(s);
      return s;
    })(), it.t, -DEFAULT_STEP, KAHAN_LI_8, PHYS);
    // Starts at the forward run's end time (the poles make the force time-dependent).
    back.importState(it.exportState(), 0);
    for (let i = 0; i < steps; i++) back.step();
    let worst = 0;
    let who = '';
    for (let i = 0; i < N; i++) {
      const d = dist(back.q, q0, i);
      if (d > worst) [worst, who] = [d, B[i].id];
    }
    console.log(`30 d forward and back (${steps} steps each way): worst body ${who} returns within ${worst.toExponential(2)} m`);
    // The scheme is symmetric; what remains is roundoff (the 1PN implicit
    // solve's asymmetry is far smaller). Observed 2.6 cm, against an Io-step
    // truncation error of ~1e-1 m over the same span.
    expect(worst).toBeLessThan(0.1);
  }, 60_000);

  it('resumes from exported state bit for bit, forward and backward', () => {
    for (const dir of [1, -1]) {
      const a = make(dir * DEFAULT_STEP);
      for (let i = 0; i < 200; i++) a.step();
      const saved = a.exportState();
      const s = new Float64Array(6 * N);
      a.getState(s);
      const b = new NBodyIntegrator(GM, s, 0, dir * DEFAULT_STEP, KAHAN_LI_8, PHYS);
      b.importState(saved, a.steps);
      for (let i = 0; i < 300; i++) {
        a.step();
        b.step();
      }
      expect(b.steps).toBe(a.steps);
      for (let j = 0; j < 3 * N; j++) {
        expect(Object.is(b.q[j], a.q[j])).toBe(true);
        expect(Object.is(b.v[j], a.v[j])).toBe(true);
      }
    }
  }, 60_000);
});

/**
 * Error thresholds against Horizons, km. Planets (and Sun): barycentric
 * position. Moons (the Moon too, now parented to Earth): position relative to
 * their planet. Each is ~1.5x the observed value (physics model 2; in the
 * comment, worst of -t and +t, then the model-1 value against the old fixture).
 *
 * The model-1 fixture's moon samples were wrong (SSB-centred states overwrote
 * the planet-relative reference: 340-1050 km off DE441 + the satellite
 * ephemerides for the Uranian moons, up to 320 km for Triton), so model-1
 * numbers mix fixture error with model error; the model-2 numbers do not.
 *
 * Causes of what remains (errors grow linearly: mean-motion errors):
 *  - Tethys, Dione: Mimas and Enceladus are not modelled (Tethys-Mimas 4:2,
 *    Dione-Enceladus 2:1 resonances). Adding them in an experiment brought
 *    Tethys to 104 km and Dione to 5 km at 1 yr; left for a later model.
 *  - Io, Europa: the Laplace resonance with degree > 4 gravity and tides missing.
 *  - Titania 7 km/yr: unexplained (Ariel, Umbriel, Oberon are at 1 km/yr).
 *  - Miranda 9 km/yr: its inclined, resonance-affected orbit and ura182's own
 *    fit (Miranda is modelled from model 2: without it Ariel was 184 km and
 *    Umbriel 90 km off after a year).
 *  - Charon 1.7 km/yr (was 39.5: Nix, Hydra, Kerberos and Styx, outside
 *    Charon's orbit, were lumped into Pluto's GM).
 *  - Planets: 10-50 km at 25 yr from the missing asteroids and tides.
 */
const LIMIT_1: Record<string, number> = {
  sun: 2, mercury: 2, venus: 2, earth: 2, mars: 2, jupiter: 2, saturn: 2, uranus: 2, neptune: 2, pluto: 2, // <= 0.3 (model 1: Pluto 4.2)
  moon: 7, // 4.0 (geocentric; model 1, barycentric: 4.3)
  io: 220, // 145, 0.02 deg (145)
  europa: 12, // 6.7 (6.7)
  ganymede: 25, // 15 (15)
  callisto: 10, // 5.5 (5.5)
  tethys: 1300, // 859, 0.17 deg (493: old fixture; Mimas missing)
  dione: 165, // 107 (181)
  rhea: 32, // 20 (249)
  titan: 50, // 33 (86)
  iapetus: 6, // 3.2 (15)
  miranda: 14, // 9.2 (not modelled)
  ariel: 2, // 1.2 (450)
  umbriel: 1.2, // 0.7 (419)
  titania: 11, // 7.2 (388)
  oberon: 0.5, // 0.05 (384)
  triton: 11, // 7.3 (128)
  charon: 2.6, // 1.7 (40, 0.116 deg)
};
const LIMIT_25: Record<string, number> = {
  sun: 16, mercury: 17, venus: 17, earth: 16, mars: 30, jupiter: 20, saturn: 24, uranus: 37, neptune: 72, // 10, 11, 11, 11, 19, 13, 16, 24, 48 (unchanged)
  pluto: 80, // 53 (143)
  moon: 150, // 100 (geocentric; 100)
  io: 4900, // 3271, 0.45 deg (3271)
  europa: 2300, // 1521, 0.13 (1521)
  ganymede: 810, // 538 (539)
  callisto: 195, // 128 (128)
  tethys: 66000, // 43934, 8.6 deg (34780; Mimas missing)
  dione: 1350, // 896 (5569)
  rhea: 780, // 520 (6245)
  titan: 790, // 522 (1902)
  iapetus: 105, // 70 (348)
  miranda: 400, // 260 (not modelled)
  ariel: 130, // 84 (9020)
  umbriel: 36, // 24 (980)
  titania: 270, // 178 (1130)
  oberon: 4, // 2.3 (963)
  triton: 265, // 176 (1845)
  charon: 65, // 42 (991, 2.9 deg)
};

function compare(years: number[], limit: Record<string, number>): void {
  const states = new Map<number, Float64Array>();
  for (const dir of [1, -1]) {
    const it = make(dir * DEFAULT_STEP);
    for (const y of years.filter((y) => Math.sign(y) === dir).sort((a, b) => Math.abs(a) - Math.abs(b))) {
      const k = Math.round((Math.abs(y) * JULIAN_YEAR) / DEFAULT_STEP);
      while (it.steps < k) it.step();
      states.set(y, Float64Array.from(it.q));
    }
  }
  const lines: string[] = [];
  B.forEach((b, i) => {
    const row = ref.bodies[i];
    expect(row.id).toBe(b.id);
    const p = b.parent ? bodyIndex(b.parent) : -1;
    const cells = years.map((y) => {
      const q = states.get(y)!;
      const h = row.samples.find((s) => Math.abs(s.t - y * JULIAN_YEAR) < 1)!.state;
      let err: number;
      if (p < 0) err = Math.hypot(q[3 * i] - h[0], q[3 * i + 1] - h[1], q[3 * i + 2] - h[2]);
      else {
        const hp = ref.bodies[p].samples.find((s) => Math.abs(s.t - y * JULIAN_YEAR) < 1)!.state;
        err = Math.hypot(q[3 * i] - q[3 * p] - (h[0] - hp[0]), q[3 * i + 1] - q[3 * p + 1] - (h[1] - hp[1]), q[3 * i + 2] - q[3 * p + 2] - (h[2] - hp[2]));
      }
      expect(err / 1e3, `${b.id} at ${y} yr`).toBeLessThan(limit[b.id]);
      return (err / 1e3).toFixed(1);
    });
    lines.push(`${b.id.padEnd(9)} ${cells.join('  ')}`);
  });
  console.log(`km vs Horizons at ${years.join(', ')} yr (moons relative to planet)\n${lines.join('\n')}`);
}

describe('full body set vs JPL Horizons', () => {
  it('agrees at +-1 year', () => compare([-1, 1], LIMIT_1), 60_000);
  it.skipIf(!SLOW)('agrees at +-10 and +-25 years (SLOW=1)', () => compare([-25, -10, 10, 25], LIMIT_25), 600_000);
});

