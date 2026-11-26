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
    })(), 0, -DEFAULT_STEP, KAHAN_LI_8, PHYS);
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
 * Error thresholds against Horizons, km. Planets (and Sun, Moon): barycentric
 * position. Moons: position relative to their planet. Each is ~1.5x the
 * observed value at the time of writing (in the comment, worst of -t and +t,
 * and the phase error along the orbit in degrees).
 *
 * Causes: the moons' errors grow linearly with time, i.e. mean-motion errors
 * from physics we leave out: unmodelled moons (Enceladus and Mimas, in
 * resonance with Dione and Tethys, dominate Tethys, Dione), tides, degree > 4
 * gravity, pole precession of the planets, and for Charon a residual 3e-4
 * mean-motion offset of unknown cause. The Uranian moons' ~400 km at 1 yr that
 * does not grow is a frame/parameter mismatch with ura184 (not resolved).
 * Planets: 10-50 km at 25 yr from the missing asteroids and Moon/Earth tides.
 */
const LIMIT_1: Record<string, number> = {
  sun: 2, mercury: 2, venus: 2, earth: 2, moon: 7, mars: 2, jupiter: 2, saturn: 2, uranus: 2, neptune: 2, pluto: 7, // <= 4.3 (Moon, Pluto)
  io: 220, // 145 km, 0.02 deg
  europa: 12, // 6.7
  ganymede: 25, // 15
  callisto: 10, // 5.5
  tethys: 750, // 493, 0.10 deg
  dione: 275, // 181
  rhea: 375, // 249
  titan: 130, // 86
  iapetus: 25, // 15
  ariel: 675, // 450
  umbriel: 630, // 419
  titania: 585, // 388
  oberon: 580, // 384
  triton: 195, // 128
  charon: 60, // 40, 0.116 deg
};
const LIMIT_25: Record<string, number> = {
  sun: 16, mercury: 17, venus: 17, earth: 16, moon: 150, mars: 30, jupiter: 20, saturn: 24, uranus: 37, neptune: 72, pluto: 215, // 10, 11, 11, 11, 100, 20, 13, 16, 24, 48, 143
  io: 4900, // 3271, 0.45 deg
  europa: 2300, // 1521, 0.13
  ganymede: 810, // 539
  callisto: 195, // 128
  tethys: 52000, // 34780, 6.8 deg (Mimas resonance)
  dione: 8400, // 5569, 0.85
  rhea: 9400, // 6245, 0.68
  titan: 2900, // 1902, 0.09
  iapetus: 520, // 348
  ariel: 13500, // 9020, 2.7
  umbriel: 1500, // 980
  titania: 1700, // 1130
  oberon: 1450, // 963
  triton: 2800, // 1845, 0.29
  charon: 1500, // 991, 2.9
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

