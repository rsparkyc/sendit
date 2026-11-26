/**
 * Cross-check of the gravity assist on a different body and geometry:
 * Cassini's Earth flyby, 1999-08-18 03:29 TDB, 7568 km from Earth's center
 * (1171 km altitude) at ~19 km/s. Close to J2000, so the game's own ephemeris
 * is used (Earth within 54 m, Moon 1.6 km, Sun 49 m of Horizons here); it
 * tests Earth's J2 and the Moon instead of a giant planet and its moons.
 * Run with `--silent=false` for the tables.
 *
 * REFERENCE. test/fixtures/cassini-earth.json (scripts/fetch-cassini-earth.py):
 * Horizons -82, the navigation reconstruction, built as Earth (DE441) + Cassini
 * relative to Earth. Horizons' SSB-centred -82 is 118 km off that construction
 * in this period and does not conserve energy about Earth; see the script.
 *
 * MANEUVERS AND SEAMS, from one-hour arcs as in voyager2-jupiter.test.ts:
 * 08-11 15 h 12.25 m/s (TCM); small events 08-11 14 h (2 mm/s), 08-16 06 h
 * (1.9 mm/s), 08-17 22 h (2.9 mm/s); and position-only discontinuities of 2.4 km
 * in the reference between 08-17 11-12 h and 08-18 19-20 h (seams between fit
 * arcs). WINDOW: 08-17 12:00 to 08-18 19:00 TDB (900,000 km in, 900,000 km out).
 *
 * NON-GRAVITATIONAL AND MISSING PHYSICS. Quiet arcs far from Earth show a
 * ~2e-8 m/s^2 residual (solar pressure on Cassini at 1 AU). Near closest approach
 * one-hour arcs miss by up to 51 m / 17 mm/s: Earth's field beyond J2 (J3 and the
 * tesseral C22/S22 terms each give ~2e-5 m/s^2 at 7568 km, over a few hundred
 * seconds). Physics model 1 modelled Earth's J2 only; from stage 2 of model 2
 * the game has Earth to degree 4 (J2..J4 from DE440, C/S from EGM2008, turned
 * with the ERA), and the outbound error fell from 29.3 to 10.4 mm/s (full) and
 * 25.8 to 7.3 mm/s (plain), the turn error from -0.36 to -0.10 arcsec. The
 * history of that attribution, as found under model 1:
 *
 * ATTRIBUTION OF THE ~27 mm/s OUTBOUND ERROR (model 1). It is gained within an hour of
 * closest approach. Ruled out by test-side variants (not kept as tests): the
 * Earth-relative start (our Earth is 53 m from Horizons'), rtol 1e-14, the
 * directly integrated ephemeris instead of the Chebyshev one (identical), Earth
 * J4 (0.3 mm/s), Earth J2 scaled by 1.01 (fixes the turn angle only; the error
 * is mostly out of the turn plane). Earth's field beyond J2 explains it: the
 * EGM96 degree 2-4 terms other than J2 (C22/S22 12 mm/s; J3, J4 and degree 3-4
 * tesserals 8 mm/s), with Earth rotation from the ERA, integrated along the
 * reference path to first order give -18 mm/s, pointing within 20 degrees
 * (cosine 0.94) of our residual change across +-3 h of closest approach (26.6 mm/s;
 * the rest is the position feedback at periapsis the first-order estimate
 * omits). Missing physics, not a bug. (Horizons' Earth also has a 1 m, 22.5
 * minute sawtooth near closest approach; negligible here.)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fx from './fixtures/cassini-earth.json';
import { J2000_BODIES, bodyIndex } from '../src/physics/solar-system';
import { ChebyshevEphemeris } from '../src/physics/chebyshev-ephemeris';
import { propagate, type Ephemeris } from '../src/physics/spacecraft';
import { angle, capture, closestApproach, hyperbola, norm3, sub, withOverrides, type Impulse } from './helpers/flyby';

const EPOCH = Date.parse('2000-01-01T12:00:00Z');
const T = (tdb: string) => (Date.parse(tdb + ':00Z') - EPOCH) / 1000;
const label = (t: number) => new Date(EPOCH + t * 1000).toISOString().slice(5, 19);
const idx = new Map(fx.t.map((t, k) => [t, k]));
const ref = (t: number) => Float64Array.from(fx.cassini[idx.get(t)!]);
const refEarth = (t: number) => Float64Array.from(fx.earth[idx.get(t)!]);
const refSun = (t: number) => Float64Array.from(fx.sun[idx.get(t)!]);

const T_START = T('1999-08-17T12:00');
const T_CA = T('1999-08-18T03:29');
const T_END = T('1999-08-18T19:00');
const ARC = 3600;
const EARTH = bodyIndex('earth');
const MOON = bodyIndex('moon');
const SUN = bodyIndex('sun');
const MU = J2000_BODIES[EARTH].gm;
const AS = 180 * 3600 / Math.PI;

const bodyState = (eph: Ephemeris, i: number, t: number) => {
  const o = new Float64Array(6);
  eph.bodyState(i, t, o);
  return o;
};

/** One-hour arcs; impulses (> 1 mm/s) only further than 6 h from closest approach, where the model floor is < 0.6 mm/s. */
function scan(eph: Ephemeris, t0: number, t1: number) {
  const arcs: { t: number; dv: [number, number, number]; dr: number }[] = [];
  for (let t = t0; t + ARC <= t1; t += ARC) {
    const r = propagate(eph, [...ref(t), 1000], t, t + ARC);
    const e = ref(t + ARC);
    arcs.push({ t, dv: [e[3] - r.y[3], e[4] - r.y[4], e[5] - r.y[5]], dr: Math.hypot(e[0] - r.y[0], e[1] - r.y[1], e[2] - r.y[2]) });
  }
  const far = (t: number) => Math.abs(t + ARC / 2 - T_CA) > 6 * 3600;
  const impulses: Impulse[] = arcs.filter((a) => far(a.t) && Math.hypot(...a.dv) > 1e-3).map((a) => ({ t: a.t + ARC / 2, dv: a.dv }));
  const quiet = arcs.filter((a) => Math.abs(a.t + ARC / 2 - T_CA) > 12 * 3600 && Math.hypot(...a.dv) <= 1e-3);
  const accel = [0, 1, 2].map((k) => quiet.reduce((s, a) => s + a.dv[k], 0) / (quiet.length * ARC)) as [number, number, number];
  return { arcs, impulses, accel };
}

interface Result {
  label: string;
  residuals: { t: number; dr: number; dv: number }[];
  caT: number;
  caD: number;
  dt: number;
  dd: number;
  helioBefore: number;
  helioOurs: number;
  helioReal: number;
  helioDvErr: number;
  vinfIn: number;
  vinfOurs: number;
  vinfReal: number;
  turnOurs: number;
  turnReal: number;
}

function fly(name: string, eph: Ephemeris, opts: { impulses?: Impulse[]; accel?: [number, number, number]; earthRelative?: boolean; rtol?: number } = {}): Result {
  const times = fx.t.filter((t) => t >= T_START && t <= T_END);
  const y0 = opts.earthRelative ? Float64Array.from(sub(ref(T_START), refEarth(T_START)), (x, k) => x + bodyState(eph, EARTH, T_START)[k]) : ref(T_START);
  const run = capture(eph, y0, T_START, times, opts.impulses ?? [], opts.accel, opts.rtol);
  const residuals = [T_START + 6 * 3600, T_CA - 3600 - 29 * 60, T_CA - 29 * 60, T_CA + 31 * 60, T_CA + 3 * 3600 + 31 * 60, T_END - 6 * 3600, T_END].map((t) => {
    // Earth-relative: ours relative to our Earth, reference relative to Horizons' Earth.
    const d = sub(sub(run.get(t)!, bodyState(eph, EARTH, t)), sub(ref(t), refEarth(t)));
    return { t, dr: norm3(d), dv: norm3(d, 3) };
  });
  const near = fx.t.filter((t) => Math.abs(t - T_CA) <= 3 * 3600);
  const a = closestApproach({ t: near, s: near.map((t) => sub(ref(t), refEarth(t))) });
  const b = closestApproach({ t: near, s: near.map((t) => sub(run.get(t)!, bodyState(eph, EARTH, t))) });
  const oursEnd = run.get(T_END)!;
  const hO = sub(oursEnd, bodyState(eph, SUN, T_END));
  const hR = sub(ref(T_END), refSun(T_END));
  const hIn = hyperbola(sub(ref(T_START), refEarth(T_START)), MU);
  const oO = hyperbola(sub(oursEnd, bodyState(eph, EARTH, T_END)), MU);
  const oR = hyperbola(sub(ref(T_END), refEarth(T_END)), MU);
  return {
    label: name,
    residuals,
    caT: a.t,
    caD: a.d,
    dt: b.t - a.t,
    dd: b.d - a.d,
    helioBefore: norm3(sub(ref(T_START), refSun(T_START)), 3),
    helioOurs: norm3(hO, 3),
    helioReal: norm3(hR, 3),
    helioDvErr: norm3(sub(hO, hR), 3),
    vinfIn: hIn.vinf,
    vinfOurs: oO.vinf,
    vinfReal: oR.vinf,
    turnOurs: angle(hIn.vIn, oO.vOut),
    turnReal: angle(hIn.vIn, oR.vOut),
  };
}

function print(r: Result): void {
  const l = [`--- ${r.label}`, '  time (TDB)           |dr| km    |dv| mm/s   (Earth-relative, ours - reference)'];
  for (const x of r.residuals) l.push(`  ${label(x.t)}  ${(x.dr / 1e3).toFixed(3).padStart(9)} ${(x.dv * 1e3).toFixed(2).padStart(11)}`);
  l.push(
    `  closest approach: reference ${label(r.caT)} TDB, ${(r.caD / 1e3).toFixed(2)} km; ours dt ${r.dt.toFixed(3)} s, dd ${(r.dd / 1e3).toFixed(3)} km`,
    `  heliocentric speed: before ${r.helioBefore.toFixed(3)} m/s; after ours ${r.helioOurs.toFixed(3)}, real ${r.helioReal.toFixed(3)}; gain ours ${(r.helioOurs - r.helioBefore).toFixed(3)}, real ${(r.helioReal - r.helioBefore).toFixed(3)} m/s; heliocentric velocity error ${(r.helioDvErr * 1e3).toFixed(2)} mm/s`,
    `  v_inf: in ${r.vinfIn.toFixed(3)}; out ours ${r.vinfOurs.toFixed(4)}, real ${r.vinfReal.toFixed(4)} m/s (err ${((r.vinfOurs - r.vinfReal) * 1e3).toFixed(2)} mm/s); turn ours ${(r.turnOurs * 180 / Math.PI).toFixed(5)} deg, real ${(r.turnReal * 180 / Math.PI).toFixed(5)} (err ${((r.turnOurs - r.turnReal) * AS).toFixed(3)} arcsec)`,
  );
  console.log(l.join('\n'));
}

describe('Cassini Earth flyby 1999-08-18 (game ephemeris from J2000)', () => {
  let eph: ChebyshevEphemeris;
  let sc: ReturnType<typeof scan>;
  let full: Result;
  beforeAll(() => {
    eph = new ChebyshevEphemeris();
    sc = scan(eph, fx.t[0], fx.t[fx.t.length - 1]);
    full = fly('measured impulses + solar pressure', eph, { impulses: sc.impulses.filter((i) => i.t > T_START && i.t < T_END), accel: sc.accel });
    print(full);
  }, 600_000);

  it('the ephemeris agrees with Horizons here, and the window is free of maneuvers and seams', () => {
    let we = 0, wm = 0;
    fx.t.forEach((t) => {
      we = Math.max(we, norm3(sub(bodyState(eph, EARTH, t), refEarth(t))));
      wm = Math.max(wm, norm3(sub(bodyState(eph, MOON, t), fx.moon[idx.get(t)!])));
    });
    console.log(`ephemeris vs Horizons: Earth ${we.toFixed(1)} m, Moon ${wm.toFixed(1)} m`);
    console.log('arcs > 1 mm/s or > 100 m: ' + sc.arcs.filter((a) => Math.hypot(...a.dv) > 1e-3 || a.dr > 100).map((a) => `${label(a.t)} ${(Math.hypot(...a.dv) * 1e3).toFixed(1)} mm/s ${a.dr.toFixed(0)} m`).join(', '));
    // Observed 54 m and 1.6 km.
    expect(we).toBeLessThan(150);
    expect(wm).toBeLessThan(3e3);
    // The 12 m/s TCM on 08-11 is found; nothing above 20 mm/s or 100 m inside the window.
    const tcm = sc.arcs.filter((a) => Math.hypot(...a.dv) > 1);
    expect(tcm.length).toBe(1);
    expect(label(tcm[0].t).startsWith('08-11')).toBe(true);
    for (const a of sc.arcs) {
      if (a.t < T_START || a.t + ARC > T_END) continue;
      expect(Math.hypot(...a.dv)).toBeLessThan(0.02);
      expect(a.dr).toBeLessThan(100);
    }
  });

  it('plain model', () => {
    const r = fly('plain', eph);
    print(r);
    // Observed (see the tables): thresholds ~2x.
    expect(Math.abs(r.dd)).toBeLessThan(LIMITS.plain.dd);
    expect(Math.abs(r.dt)).toBeLessThan(LIMITS.plain.dt);
    expect(r.helioDvErr).toBeLessThan(LIMITS.plain.helio);
    expect(Math.abs(r.vinfOurs - r.vinfReal)).toBeLessThan(LIMITS.plain.vinf);
    expect(Math.abs(r.turnOurs - r.turnReal) * AS).toBeLessThan(LIMITS.plain.turn);
  });

  it('with the measured non-gravitational forces', () => {
    expect(Math.abs(full.dd)).toBeLessThan(LIMITS.full.dd);
    expect(Math.abs(full.dt)).toBeLessThan(LIMITS.full.dt);
    expect(full.helioDvErr).toBeLessThan(LIMITS.full.helio);
    expect(Math.abs(full.vinfOurs - full.vinfReal)).toBeLessThan(LIMITS.full.vinf);
    expect(Math.abs(full.turnOurs - full.turnReal) * AS).toBeLessThan(LIMITS.full.turn);
  });

  it('attribution: Earth J2, the Moon, the Sun 1PN term', () => {
    const opts = { impulses: sc.impulses.filter((i) => i.t > T_START && i.t < T_END), accel: sc.accel };
    const runs: [string, Ephemeris][] = [
      ['no Earth J2', withOverrides(eph, { oblateness: new Map([[EARTH, null]]) })],
      ['Moon lumped into Earth', withOverrides(eph, { gm: new Map([[MOON, 0], [EARTH, MU + J2000_BODIES[MOON].gm]]) })],
      ['no Sun 1PN', withOverrides(eph, { noRelativity: true })],
    ];
    const out: Record<string, Result> = {};
    const l = ['  effect switched off      CA dd km   CA dt s   helio err mm/s   v_inf err mm/s   turn err arcsec'];
    for (const [name, e] of runs) {
      const r = fly(name, e, opts);
      out[name] = r;
      l.push(`  ${name.padEnd(24)} ${(r.dd / 1e3).toFixed(3).padStart(8)} ${r.dt.toFixed(3).padStart(9)} ${(r.helioDvErr * 1e3).toFixed(2).padStart(16)} ${((r.vinfOurs - r.vinfReal) * 1e3).toFixed(2).padStart(16)} ${((r.turnOurs - r.turnReal) * AS).toFixed(3).padStart(17)}`);
    }
    console.log(`attribution (full model: helio err ${(full.helioDvErr * 1e3).toFixed(2)} mm/s)\n` + l.join('\n'));
    expect(out['no Earth J2'].helioDvErr).toBeGreaterThan(LIMITS.attribution.j2 * full.helioDvErr);
    expect(out['Moon lumped into Earth'].helioDvErr).toBeGreaterThan(LIMITS.attribution.moon * full.helioDvErr);
  }, 600_000);
});

/**
 * Limits, ~2x the observed values (physics model 2 stage 2; stage 1 in brackets):
 *   plain: CA distance +12 m [+18], time -0.001 s; heliocentric velocity
 *     7.3 mm/s [25.8]; v_inf 5.9 mm/s [6.2]; turn -0.055 arcsec [-0.32].
 *     Gain ours 3923.358 m/s, real 3923.356 [3923.344].
 *   full (measured impulses + mean solar pressure): +16 m [+22], -0.002 s;
 *     10.4 mm/s [29.3]; 7.2 mm/s [7.5]; -0.097 arcsec [-0.36].
 *   attribution: no Earth J2 4139 mm/s (397x), Moon lumped 79,600 mm/s, Sun
 *     1PN 0.05 mm/s.
 */
const LIMITS = {
  plain: { dd: 30, dt: 0.02, helio: 0.015, vinf: 0.012, turn: 0.15 },
  full: { dd: 35, dt: 0.02, helio: 0.021, vinf: 0.015, turn: 0.2 },
  attribution: { j2: 50, moon: 1000 },
};
