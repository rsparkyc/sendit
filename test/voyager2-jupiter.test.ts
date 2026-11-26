/**
 * ACCEPTANCE TEST FOR THE GRAVITY ASSIST: Voyager 2 at Jupiter, 1979-07-09.
 *
 * Replays the real flyby with the game's propagator (adaptive DOP853, all
 * bodies' point masses + J2/J4 + Sun 1PN, spacecraft massless) and compares
 * with the navigation reconstruction. Run with `--silent=false` for the tables.
 *
 * REFERENCE. test/fixtures/voyager2-jupiter.json, from
 * scripts/fetch-voyager2-jupiter.py: NAIF vgr2_jup230.bsp, the Voyager
 * navigation team's integrated, tracking-fitted trajectory relative to the
 * Jupiter barycenter (not Horizons' -32, which before 1989 is a patched-conic
 * mission-design trajectory, ~300 km off at closest approach). SSB states are
 * Horizons' DE441 Jupiter barycenter + the SPK state. Closest approach: 721,673
 * km from Jupiter's center at 1979-07-09 22:29 TDB.
 *
 * MANEUVERS, found in the data itself (`maneuver scan` below: one-hour arcs
 * propagated from the reference and compared with it an hour later; quiet arcs
 * agree to < 0.06 mm/s):
 *   1979-06-27 ~19 h TDB  0.75 m/s  pre-encounter TCM
 *   1979-07-10 00-02 h    ~13 m/s   post-encounter TCM, ~2 h after closest
 *                                   approach (matches NASA's "course correction
 *                                   two hours after its closest approach")
 *   small impulses of 1-20 mm/s (attitude-control activity; Voyager's
 *   thrusters are not fully balanced): 06-24 13 h (10), 07-06 16 h (12),
 *   07-08 06 h (16), 07-08 16 h (4), and 1-3 mm/s on 07-10..07-18.
 * COMPARISON WINDOW: 1979-06-28 00:00 (after the TCM) to 07-09 23:30 (one hour
 * after closest approach, before the post-encounter TCM). The outbound result
 * is evaluated at 07-21 00:00 by coasting both our state and the reference
 * state at 07-09 23:30 ballistically with the same model ("real-ballistic"),
 * so the post-encounter TCM, which the real Voyager did fly, stays out of it.
 *
 * NON-GRAVITATIONAL FORCES. On quiet arcs the reference departs from our
 * gravity-only model by 3-10 nm/s^2 pointing away from the Sun (cosine -0.9 to
 * -0.99): solar radiation pressure (expected ~4e-9 m/s^2 for Voyager's 3.7 m
 * dish and ~800 kg at 5.2 AU) plus RTG thermal recoil. Over the 12-day window
 * that alone is ~1-2 km; with the 07-06..07-08 impulses it is most of the
 * plain-model residual. The "full" runs below add, test-side only, the
 * impulses (measured from the data) and the window's mean residual
 * acceleration as a constant force, so what is left measures the game's
 * gravity model.
 *
 * VARIANTS. (b) default: a test-only ephemeris started from Horizons states at
 * 1979-06-05 built as solar-system.ts documents. (a) SLOW=1: the game's real
 * ephemeris integrated back from J2000 (~13 s to build back to 1979).
 *
 * WHAT THE NUMBERS SAY (thresholds below are ~1.5-2x the observed values):
 *   (b) plain:  9.1 km / 162 mm/s at closest approach; CA distance +7.1 km;
 *       heliocentric velocity after 114 mm/s, gain 20 mm/s, turn 2.4 arcsec.
 *   (b) full:   1.9 km / 25 mm/s; CA distance -0.43 km, time -0.08 s; moons'
 *       CA within 2.5 km, 0.6 s; heliocentric velocity 4 mm/s, gain 1 mm/s,
 *       v_inf 0.8 mm/s, turn 0.09 arcsec. A 1 km / 1 mm/s change of the start
 *       state moves the CA state by 0.4-2.6 km, so this is at the level of the
 *       start-state and non-gravitational-model uncertainty.
 *   Attribution (b, full model, effect switched off): Jupiter J2+J4 71 km at
 *       CA, 2.4 m/s; J4 alone 12 m; Sun 1PN 3 m; Io 7.6 km, Europa 65 km,
 *       Ganymede 1781 km, Callisto 721 km. Every modelled moon and J2 is
 *       resolved well above the residual; J4 and 1PN are below it.
 *   (a): the J2000 ephemeris has Jupiter's barycenter 6.5 km along-track off
 *       DE441 in 1979 and the moons' along-track drift (Io 2670, Europa 1310,
 *       Ganymede 450, Callisto 105 km). Moon CAs are off by up to ~1000 km and
 *       ~76 s (Io), the outbound heliocentric velocity by 60-150 mm/s.
 *       Substituting variant (b)'s moons (planet-relative) removes this:
 *       evidence the moon drift is the cause.
 * No bug found: frame (ICRF equatorial, REF_PLANE=FRAME), TDB, geometric
 * states and centers were checked; one-hour arcs through closest approach
 * agree to < 1 m.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fx from './fixtures/voyager2-jupiter.json';
import { DEFAULT_STEP, IntegratedEphemeris, J2000_BODIES, bodyIndex, oblatenessOf, type BodyData } from '../src/physics/solar-system';
import { ChebyshevEphemeris } from '../src/physics/chebyshev-ephemeris';
import { propagate, type Ephemeris } from '../src/physics/spacecraft';
import { angle, capture, closestApproach, hyperbola, norm3, sub, withOverrides, type Impulse, type State, type Track } from './helpers/flyby';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SLOW = ENV.SLOW === '1';

const S = fx.samples;
const byT = new Map(S.map((s) => [s.t, s]));
const EPOCH = Date.parse('2000-01-01T12:00:00Z');
/** Seconds TDB from J2000 of a TDB calendar time 'YYYY-MM-DDTHH:MM'. */
const T = (tdb: string) => (Date.parse(tdb + ':00Z') - EPOCH) / 1000;
const label = (t: number) => new Date(EPOCH + t * 1000).toISOString().slice(5, 16);
const refRel = (t: number) => Float64Array.from(byT.get(t)!.scRelJupBary);
const refSSB = (t: number) => {
  const s = byT.get(t)!;
  return Float64Array.from(s.scRelJupBary, (x, i) => x + s.jupBary[i]);
};

const T_START = T('1979-06-28T00:00');
const T_CA = T('1979-07-09T22:30');
const T_PRE = T('1979-07-09T23:30');
const T_END = T('1979-07-21T00:00');
const ARC = 3600;
const IMPULSE_LIMIT = 1e-3; // m/s per one-hour arc

const SUN = bodyIndex('sun');
const JUP = bodyIndex('jupiter');
const MOONS = ['io', 'europa', 'ganymede', 'callisto'] as const;
const MOON_IDX = MOONS.map((m) => bodyIndex(m));
const SYSTEM = [JUP, ...MOON_IDX];
const MU_SYS = SYSTEM.reduce((a, i) => a + J2000_BODIES[i].gm, 0);

/** J2000_BODIES with the Horizons states at 1979-06-05 (fixture epochB). */
const BODIES_B: BodyData[] = J2000_BODIES.map((b) => {
  const s = fx.epochB.bodies.find((x) => x.id === b.id);
  if (!s) throw new Error(`no epochB state for ${b.id}`);
  return { ...b, state: s.state };
});

const state = (eph: Ephemeris, i: number, t: number) => {
  const o = new Float64Array(6);
  eph.bodyState(i, t, o);
  return o;
};
/** The Jupiter system barycenter of eph (true GMs, also when an attribution run overrides them). */
function jupiterBarycenter(eph: Ephemeris, t: number): State {
  const out = new Float64Array(6);
  for (const i of SYSTEM) {
    const s = state(eph, i, t);
    for (let k = 0; k < 6; k++) out[k] += (J2000_BODIES[i].gm / MU_SYS) * s[k];
  }
  return out;
}

/** One-hour arcs from the reference: velocity residual after each arc, and the impulses and mean quiet-arc acceleration. */
function scan(eph: Ephemeris, t0: number, t1: number) {
  const arcs: { t: number; dv: [number, number, number]; dr: number }[] = [];
  for (let t = t0; t + ARC <= t1; t += ARC) {
    const r = propagate(eph, [...refSSB(t), 1000], t, t + ARC);
    const e = refSSB(t + ARC);
    arcs.push({ t, dv: [e[3] - r.y[3], e[4] - r.y[4], e[5] - r.y[5]], dr: Math.hypot(e[0] - r.y[0], e[1] - r.y[1], e[2] - r.y[2]) });
  }
  const impulses: Impulse[] = arcs.filter((a) => Math.hypot(...a.dv) > IMPULSE_LIMIT).map((a) => ({ t: a.t + ARC / 2, dv: a.dv }));
  const quiet = arcs.filter((a) => Math.hypot(...a.dv) <= IMPULSE_LIMIT);
  const accel = [0, 1, 2].map((k) => quiet.reduce((s, a) => s + a.dv[k], 0) / (quiet.length * ARC)) as [number, number, number];
  return { arcs, impulses, accel };
}

interface Result {
  label: string;
  /** Jupiter-relative position / velocity residual at each checkpoint. */
  residuals: { t: number; dr: number; along: number; dv: number }[];
  /** Closest approach: reference time and distance, our error. */
  ca: Record<string, { t: number; d: number; dt: number; dd: number }>;
  helioBefore: number;
  helioOurs: number;
  helioReal: number;
  helioRealWithTcm: number;
  helioDvErr: number;
  helioDirErr: number;
  vinfIn: number;
  vinfOurs: number;
  vinfReal: number;
  turnOurs: number;
  turnReal: number;
}

const CHECKPOINTS = [T_START + 86400, T('1979-07-02T22:00'), T('1979-07-06T22:00'), T('1979-07-08T22:00'), T_CA - 6 * 3600, T_CA - 3600, T_CA, T_PRE];

/**
 * Propagate from y0 at T_START to T_PRE through `eph`, coast to T_END, and
 * compare with the reference. `coastEph` coasts the reference from T_PRE.
 */
function fly(name: string, eph: Ephemeris, coastEph: Ephemeris, opts: { impulses?: Impulse[]; accel?: [number, number, number]; y0?: ArrayLike<number> } = {}): Result {
  const times = S.map((s) => s.t).filter((t) => t >= T_START && t <= T_PRE);
  const run = capture(eph, opts.y0 ?? refSSB(T_START), T_START, times, opts.impulses ?? [], opts.accel);
  const ours = (t: number) => run.get(t)!;
  const residuals = CHECKPOINTS.map((t) => {
    const d = sub(sub(ours(t), jupiterBarycenter(eph, t)), refRel(t));
    const r = refRel(t);
    const vn = norm3(r, 3);
    return { t, dr: norm3(d), along: (d[0] * r[3] + d[1] * r[4] + d[2] * r[5]) / vn, dv: norm3(d, 3) };
  });
  const moonTimes = fx.moons.t.filter((t) => t >= T_START && t <= T_PRE);
  const ca: Result['ca'] = {};
  for (const [id, idx] of [['jupiter', JUP], ...MOONS.map((m, k) => [m, MOON_IDX[k]])] as [string, number][]) {
    const refBody = (fx.moons.relJupBary as Record<string, number[][]>)[id];
    const refTrack: Track = { t: moonTimes, s: moonTimes.map((t) => sub(refRel(t), refBody[fx.moons.t.indexOf(t)])) };
    const ourTrack: Track = { t: moonTimes, s: moonTimes.map((t) => sub(ours(t), state(eph, idx, t))) };
    const a = closestApproach(refTrack);
    const b = closestApproach(ourTrack);
    ca[id] = { t: a.t, d: a.d, dt: b.t - a.t, dd: b.d - a.d };
  }
  const oursEnd = capture(eph, ours(T_PRE), T_PRE, [T_END]).get(T_END)!;
  const realEnd = capture(coastEph, refSSB(T_PRE), T_PRE, [T_END]).get(T_END)!;
  const sEnd = byT.get(T_END)!;
  const hOurs = sub(oursEnd, state(eph, SUN, T_END));
  const hReal = sub(realEnd, sEnd.sun);
  const s0 = byT.get(T_START)!;
  const hIn = hyperbola(refRel(T_START), MU_SYS);
  const oOurs = hyperbola(sub(oursEnd, jupiterBarycenter(eph, T_END)), MU_SYS);
  const oReal = hyperbola(sub(realEnd, sEnd.jupBary), MU_SYS);
  return {
    label: name,
    residuals,
    ca,
    helioBefore: norm3(sub(refSSB(T_START), s0.sun), 3),
    helioOurs: norm3(hOurs, 3),
    helioReal: norm3(hReal, 3),
    helioRealWithTcm: norm3(sub(refSSB(T_END), sEnd.sun), 3),
    helioDvErr: norm3(sub(hOurs, hReal), 3),
    helioDirErr: angle(hOurs.slice(3), hReal.slice(3)),
    vinfIn: hIn.vinf,
    vinfOurs: oOurs.vinf,
    vinfReal: oReal.vinf,
    turnOurs: angle(hIn.vIn, oOurs.vOut),
    turnReal: angle(hIn.vIn, oReal.vOut),
  };
}

const AS = 180 * 3600 / Math.PI; // arcsec per radian
const caErr = (r: Result) => r.residuals[r.residuals.findIndex((x) => x.t === T_CA)];

function print(r: Result): void {
  const lines = [`--- ${r.label}`, '  time (TDB)      |dr| km   along km   |dv| mm/s   (Jupiter-relative, ours - reference)'];
  for (const x of r.residuals) lines.push(`  ${label(x.t)}  ${(x.dr / 1e3).toFixed(3).padStart(9)} ${(x.along / 1e3).toFixed(3).padStart(10)} ${(x.dv * 1e3).toFixed(2).padStart(11)}`);
  lines.push('  closest approach  reference (TDB, km)          ours: dt s   dd km');
  for (const [id, c] of Object.entries(r.ca)) lines.push(`  ${id.padEnd(9)} ${label(c.t)} ${(c.d / 1e3).toFixed(1).padStart(11)}   ${c.dt.toFixed(2).padStart(8)} ${(c.dd / 1e3).toFixed(3).padStart(9)}`);
  lines.push(
    `  heliocentric speed: before ${r.helioBefore.toFixed(3)} m/s; after ours ${r.helioOurs.toFixed(3)}, real (ballistic) ${r.helioReal.toFixed(3)}, real with post-encounter TCM ${r.helioRealWithTcm.toFixed(3)}`,
    `  gravity-assist gain: ours ${(r.helioOurs - r.helioBefore).toFixed(3)} m/s, real ${(r.helioReal - r.helioBefore).toFixed(3)} m/s; heliocentric velocity error ${(r.helioDvErr * 1e3).toFixed(2)} mm/s, direction ${(r.helioDirErr * AS).toFixed(3)} arcsec`,
    `  v_inf: in ${r.vinfIn.toFixed(3)} m/s; out ours ${r.vinfOurs.toFixed(4)}, real ${r.vinfReal.toFixed(4)} (err ${((r.vinfOurs - r.vinfReal) * 1e3).toFixed(2)} mm/s); turn angle ours ${(r.turnOurs * 180 / Math.PI).toFixed(5)} deg, real ${(r.turnReal * 180 / Math.PI).toFixed(5)} deg (err ${((r.turnOurs - r.turnReal) * AS).toFixed(3)} arcsec)`,
  );
  console.log(lines.join('\n'));
}

interface Limits {
  caPos: number;
  caVel: number;
  jupD: number;
  jupT: number;
  moonD: Partial<Record<(typeof MOONS)[number], number>>;
  moonT: number;
  helioDv: number;
  gain: number;
  vinf: number;
  turn: number; // arcsec
}
function check(r: Result, l: Limits): void {
  const c = caErr(r);
  expect(c.dr).toBeLessThan(l.caPos);
  expect(c.dv).toBeLessThan(l.caVel);
  expect(Math.abs(r.ca.jupiter.dd)).toBeLessThan(l.jupD);
  expect(Math.abs(r.ca.jupiter.dt)).toBeLessThan(l.jupT);
  for (const m of MOONS) {
    expect(Math.abs(r.ca[m].dd), m).toBeLessThan(l.moonD[m] ?? Infinity);
    expect(Math.abs(r.ca[m].dt), m).toBeLessThan(l.moonT);
  }
  expect(r.helioDvErr).toBeLessThan(l.helioDv);
  expect(Math.abs(r.helioOurs - r.helioReal)).toBeLessThan(l.gain);
  expect(Math.abs(r.vinfOurs - r.vinfReal)).toBeLessThan(l.vinf);
  expect(Math.abs(r.turnOurs - r.turnReal) * AS).toBeLessThan(l.turn);
}

/** Galilean moons vs Horizons, 32-38 days after epoch B (observed values in the test). */
const MOON_DRIFT_LIMIT: Record<string, number> = { io: 25e3, europa: 2e3, ganymede: 2e3, callisto: 2e3 };

describe('Voyager 2 Jupiter flyby: reference data', () => {
  let eph: IntegratedEphemeris;
  let sc: ReturnType<typeof scan>;
  beforeAll(() => {
    eph = new IntegratedEphemeris(BODIES_B, DEFAULT_STEP, fx.epochB.t);
    sc = scan(eph, S[0].t, T_END);
  }, 600_000);

  it('the epoch-B bodies reproduce Horizons over the window (construction, frame and time scale)', () => {
    // The test ephemeris, started on 06-05 from the fixture's body states, must
    // follow Horizons' Jupiter barycenter and Sun and the Galilean moons. Jupiter
    // barycenter and Sun: observed 0.8 m and 4.3 m (46 days); moons
    // relative to the barycenter, 32-38 days after the start: Io 15.7 km, the
    // others < 0.9 km: Io's along-track drift (mean-motion error), the same
    // ~0.4 km/day seen over 25 years from J2000. Io's 15.7 km is also most of
    // the 2.5 km error in Voyager's closest approach to Io (at 1.13e6 km).
    let worstBary = 0, worstSun = 0;
    const worstMoon: Record<string, number> = {};
    for (const s of S.filter((x) => x.t % 3600 === 0)) {
      worstBary = Math.max(worstBary, norm3(sub(jupiterBarycenter(eph, s.t), s.jupBary)));
      worstSun = Math.max(worstSun, norm3(sub(state(eph, SUN, s.t), s.sun)));
    }
    fx.moons.t.forEach((t, k) => {
      const jb = jupiterBarycenter(eph, t);
      MOONS.forEach((m, j) => {
        const ref = (fx.moons.relJupBary as Record<string, number[][]>)[m][k];
        worstMoon[m] = Math.max(worstMoon[m] ?? 0, norm3(sub(sub(state(eph, MOON_IDX[j], t), jb), ref)));
      });
    });
    console.log(`epoch-B ephemeris vs Horizons: Jupiter barycenter ${worstBary.toFixed(2)} m, Sun ${worstSun.toFixed(2)} m, moons relative to it (km) ${MOONS.map((m) => `${m} ${(worstMoon[m] / 1e3).toFixed(2)}`).join(', ')}`);
    expect(worstBary).toBeLessThan(100);
    expect(worstSun).toBeLessThan(100);
    for (const m of MOONS) expect(worstMoon[m], m).toBeLessThan(MOON_DRIFT_LIMIT[m]);
  });

  it('finds the maneuvers, and the comparison window is free of them', () => {
    const big = sc.arcs.filter((a) => Math.hypot(...a.dv) > 0.1).map((a) => ({ t: a.t, dv: Math.hypot(...a.dv) }));
    console.log('arcs with > 0.1 m/s: ' + big.map((b) => `${label(b.t)} ${b.dv.toFixed(3)} m/s`).join(', '));
    console.log('impulses > 1 mm/s: ' + sc.impulses.map((i) => `${label(i.t)} ${(Math.hypot(...i.dv) * 1e3).toFixed(1)} mm/s`).join(', '));
    // Pre-encounter TCM: one arc on 06-27, 0.75 m/s.
    const pre = big.filter((b) => b.t < T_START);
    expect(pre.length).toBe(1);
    expect(label(pre[0].t).startsWith('06-27')).toBe(true);
    expect(pre[0].dv).toBeGreaterThan(0.7);
    expect(pre[0].dv).toBeLessThan(0.8);
    // Post-encounter TCM: 07-10 00:00-02:00, all after T_PRE.
    const post = big.filter((b) => b.t >= T_START);
    expect(post.length).toBeGreaterThan(0);
    for (const b of post) {
      expect(b.t).toBeGreaterThanOrEqual(T_PRE);
      expect(b.t).toBeLessThan(T('1979-07-10T02:00'));
    }
    // Inside the window only small impulses (< 20 mm/s per arc).
    for (const a of sc.arcs) if (a.t >= T_START && a.t + ARC <= T_PRE) expect(Math.hypot(...a.dv)).toBeLessThan(0.02);
  });

  it('one-hour arcs through closest approach reproduce the reference to < 2 m and 0.1 mm/s', () => {
    // Force-model check without accumulation: from 07-09 10:00 to 23:30
    // (Ganymede, Europa, Io and Jupiter closest approaches). Observed: < 0.9 m,
    // < 0.23 mm/s on 07-09 06-09 h (Ganymede; see the header), < 0.03 mm/s
    // from 10 h on. The residual left is the SPK's own interpolation noise
    // (alternating 0.37 / 0.66 m) and solar pressure.
    const near = sc.arcs.filter((a) => a.t >= T('1979-07-09T10:00') && a.t + ARC <= T_PRE);
    expect(near.length).toBe(13);
    for (const a of near) {
      expect(a.dr).toBeLessThan(2);
      expect(Math.hypot(...a.dv)).toBeLessThan(1e-4);
    }
    // Quiet-arc residual acceleration: anti-Sunward, a few nm/s^2 (solar pressure).
    const quiet = sc.arcs.filter((a) => a.t >= T_START && a.t + ARC <= T_PRE && Math.hypot(...a.dv) < IMPULSE_LIMIT);
    const acc = [0, 1, 2].map((k) => quiet.reduce((s, a) => s + a.dv[k], 0) / (quiet.length * ARC));
    const s = byT.get(T_CA)!;
    const toSun = [0, 1, 2].map((k) => s.sun[k] - refSSB(T_CA)[k]);
    const cos = (acc[0] * toSun[0] + acc[1] * toSun[1] + acc[2] * toSun[2]) / (norm3(acc) * norm3(toSun));
    console.log(`mean quiet-arc residual acceleration ${norm3(acc).toExponential(2)} m/s^2, cosine to the Sun direction ${cos.toFixed(2)}`);
    expect(norm3(acc)).toBeGreaterThan(1e-9);
    expect(norm3(acc)).toBeLessThan(2e-8);
    expect(cos).toBeLessThan(-0.7);
  });
});

describe('Voyager 2 Jupiter flyby: variant (b), ephemeris started 1979-06-05 from Horizons', () => {
  let eph: IntegratedEphemeris;
  let ev: ReturnType<typeof scan>;
  let full: Result;
  beforeAll(() => {
    eph = new IntegratedEphemeris(BODIES_B, DEFAULT_STEP, fx.epochB.t);
    ev = scan(eph, T_START, T_PRE);
    full = fly('(b) + measured impulses + mean solar pressure', eph, eph, { impulses: ev.impulses, accel: ev.accel });
    print(full);
  }, 600_000);

  it('plain model (gravity only) against the reference', () => {
    const r = fly('(b) plain', eph, eph);
    print(r);
    // Observed 9.1 km / 162 mm/s at CA; CA +7.1 km / 0.00 s; moons within
    // 9 km / 0.6 s; heliocentric velocity 114 mm/s, gain 20 mm/s; v_inf 28
    // mm/s; turn 2.4 arcsec. Dominated by the unmodelled impulses and solar
    // pressure (see the header).
    check(r, { caPos: 15e3, caVel: 0.25, jupD: 12e3, jupT: 1, moonD: { io: 15e3, europa: 6e3, ganymede: 7e3, callisto: 4e3 }, moonT: 1, helioDv: 0.2, gain: 0.04, vinf: 0.05, turn: 4 });
  });

  it('with the measured non-gravitational forces, the gravity model matches to the data quality', () => {
    // Observed 1.92 km / 25 mm/s at CA; CA -0.43 km, -0.08 s; moons <= 2.5 km
    // (Io, a shallow minimum at 1.13e6 km) and 0.6 s; heliocentric velocity
    // 4.3 mm/s, gain 1 mm/s; v_inf 0.8 mm/s; turn 0.09 arcsec.
    check(full, { caPos: 3e3, caVel: 0.04, jupD: 1e3, jupT: 0.3, moonD: { io: 4e3, europa: 1e3, ganymede: 1e3, callisto: 1e3 }, moonT: 1, helioDv: 8e-3, gain: 3e-3, vinf: 2e-3, turn: 0.3 });
  });

  it('attribution: each effect switched off, against the full-model residual', () => {
    const base = caErr(full).dr;
    const opts = { impulses: ev.impulses, accel: ev.accel };
    const jo = oblatenessOf(J2000_BODIES[JUP])!;
    const runs: [string, Ephemeris][] = [
      ['no Jupiter J2, J4', withOverrides(eph, { oblateness: new Map([[JUP, null]]) })],
      ['no Jupiter J4', withOverrides(eph, { oblateness: new Map([[JUP, { j2: jo.j2, radius: jo.radius, pole: jo.pole }]]) })],
      ['no Sun 1PN', withOverrides(eph, { noRelativity: true })],
      ...MOONS.map((m, k): [string, Ephemeris] => [`${m} lumped into Jupiter`, withOverrides(eph, { gm: new Map([[MOON_IDX[k], 0], [JUP, J2000_BODIES[JUP].gm + J2000_BODIES[MOON_IDX[k]].gm]]) })]),
    ];
    const effect: Record<string, number> = {};
    const lines = ['  effect switched off        CA |dr| km  vs full   CA dist err km  v_inf err mm/s  turn err arcsec'];
    for (const [name, e] of runs) {
      const r = fly(name, e, eph, opts);
      // The effect itself: our trajectory with it minus without it, at CA.
      effect[name] = caErr(r).dr;
      lines.push(`  ${name.padEnd(26)} ${(caErr(r).dr / 1e3).toFixed(3).padStart(9)}  ${(caErr(r).dr / base).toFixed(1).padStart(7)}x ${(r.ca.jupiter.dd / 1e3).toFixed(3).padStart(14)} ${((r.vinfOurs - r.vinfReal) * 1e3).toFixed(2).padStart(15)} ${((r.turnOurs - r.turnReal) * AS).toFixed(2).padStart(16)}`);
    }
    const y = refSSB(T_START);
    for (const [name, k, d] of [['start +1 km (x)', 0, 1e3], ['start +1 km (z)', 2, 1e3], ['start +1 mm/s (vx)', 3, 1e-3], ['start +1 mm/s (vz)', 5, 1e-3]] as [string, number, number][]) {
      const y2 = Float64Array.from(y);
      y2[k] += d;
      const r = fly(name, eph, eph, { ...opts, y0: y2 });
      effect[name] = caErr(r).dr;
      lines.push(`  ${name.padEnd(26)} ${(caErr(r).dr / 1e3).toFixed(3).padStart(9)}  ${(caErr(r).dr / base).toFixed(1).padStart(7)}x ${(r.ca.jupiter.dd / 1e3).toFixed(3).padStart(14)} ${((r.vinfOurs - r.vinfReal) * 1e3).toFixed(2).padStart(15)} ${((r.turnOurs - r.turnReal) * AS).toFixed(2).padStart(16)}`);
    }
    console.log(`attribution (full-model CA residual ${(base / 1e3).toFixed(3)} km)\n` + lines.join('\n'));
    // Observed: J2+J4 71 km; Io 7.6, Europa 65, Ganymede 1781, Callisto 721 km.
    // Each must be clearly resolved above the residual.
    expect(effect['no Jupiter J2, J4']).toBeGreaterThan(20 * base);
    expect(effect['io lumped into Jupiter']).toBeGreaterThan(2.5 * base);
    expect(effect['europa lumped into Jupiter']).toBeGreaterThan(20 * base);
    expect(effect['ganymede lumped into Jupiter']).toBeGreaterThan(300 * base);
    expect(effect['callisto lumped into Jupiter']).toBeGreaterThan(150 * base);
    // J4 and the Sun's 1PN term are below the data's resolution here (observed
    // changes of 12 m and 3 m).
    expect(Math.abs(effect['no Jupiter J4'] - base)).toBeLessThan(100);
    expect(Math.abs(effect['no Sun 1PN'] - base)).toBeLessThan(100);
  }, 600_000);
});

describe.skipIf(!SLOW)('Voyager 2 Jupiter flyby: variant (a), the game ephemeris from J2000 (SLOW=1)', () => {
  let ephA: ChebyshevEphemeris;
  let ephB: IntegratedEphemeris;
  let ev: ReturnType<typeof scan>;
  beforeAll(() => {
    ephA = new ChebyshevEphemeris();
    ephB = new IntegratedEphemeris(BODIES_B, DEFAULT_STEP, fx.epochB.t);
    ev = scan(ephB, T_START, T_PRE);
    const jA = jupiterBarycenter(ephA, T_CA);
    const jB = jupiterBarycenter(ephB, T_CA);
    const lines = [`(a) at closest approach, J2000 ephemeris minus epoch-B ephemeris: Jupiter barycenter ${(norm3(sub(jA, jB)) / 1e3).toFixed(2)} km`];
    MOONS.forEach((m, k) => lines.push(`  ${m} relative to the barycenter ${(norm3(sub(sub(state(ephA, MOON_IDX[k], T_CA), jA), sub(state(ephB, MOON_IDX[k], T_CA), jB))) / 1e3).toFixed(1)} km`));
    console.log(lines.join('\n'));
  }, 600_000);

  it('plain, from the Horizons SSB state', () => {
    const r = fly('(a) plain, SSB start', ephA, ephB);
    print(r);
    // Observed: 16.4 km Jupiter-relative at CA (6.5 km of it is Jupiter's own
    // along-track offset from DE441 at the start), 157 mm/s; Jupiter CA +9.7 km,
    // -0.65 s; moon CAs dominated by the moons' drift (Io -465 km / 76 s, Europa
    // -1040 km / 26 s, Ganymede 313 km / -7 s, Callisto -107 km); heliocentric
    // velocity 154 mm/s, gain 48 mm/s, v_inf 4.5 mm/s, turn 2.9 arcsec.
    check(r, { caPos: 25e3, caVel: 0.25, jupD: 15e3, jupT: 1.5, moonD: { io: 700e3, europa: 1500e3, ganymede: 500e3, callisto: 160e3 }, moonT: 120, helioDv: 0.25, gain: 0.08, vinf: 0.01, turn: 5 });
  });

  it('with measured non-gravitational forces; moon drift isolated by substituting the epoch-B moons', () => {
    const opts = { impulses: ev.impulses, accel: ev.accel };
    const r = fly('(a) + impulses + solar pressure', ephA, ephB, opts);
    print(r);
    // Observed: Jupiter CA +2.1 km; heliocentric velocity 60 mm/s; v_inf -25
    // mm/s; turn -0.4 arcsec: the moons' drift.
    check(r, { caPos: 25e3, caVel: 0.3, jupD: 4e3, jupT: 1.5, moonD: { io: 700e3, europa: 1500e3, ganymede: 500e3, callisto: 160e3 }, moonT: 120, helioDv: 0.1, gain: 0.05, vinf: 0.04, turn: 1 });
    // Same, but the Galilean moons placed relative to Jupiter as in (b).
    const m = fly('(a) + impulses + solar pressure, moons from (b)', withOverrides(ephA, { relativeFrom: { eph: ephB, base: JUP, bodies: MOON_IDX } }), ephB, opts);
    print(m);
    // Observed: moon CAs within 7.2 km and 1.6 s; heliocentric velocity 4.6 mm/s;
    // v_inf 12.5 mm/s; turn 0.07 arcsec. The remaining Jupiter-relative 15 km
    // along-track is the 6.5 km start offset of Jupiter (a 0.75 s time shift).
    check(m, { caPos: 25e3, caVel: 0.3, jupD: 1.5e3, jupT: 1.5, moonD: { io: 10e3, europa: 12e3, ganymede: 8e3, callisto: 8e3 }, moonT: 3, helioDv: 8e-3, gain: 6e-3, vinf: 0.02, turn: 0.3 });
  });

  it('started relative to our Jupiter (removes the planetary drift)', () => {
    const y0 = Float64Array.from(refRel(T_START), (x, k) => x + jupiterBarycenter(ephA, T_START)[k]);
    const r = fly('(a) + impulses + solar pressure, Jupiter-relative start', ephA, ephB, { impulses: ev.impulses, accel: ev.accel, y0 });
    print(r);
    // Observed: 0.7 km up to 07-06 (as (b)), 9.9 km / 125 mm/s at CA (now the
    // moons' drift, through their pull); Jupiter CA +2.3 km, -0.08 s;
    // heliocentric velocity 64 mm/s, v_inf -23 mm/s, turn -0.44 arcsec.
    check(r, { caPos: 20e3, caVel: 0.3, jupD: 4e3, jupT: 0.3, moonD: { io: 700e3, europa: 1500e3, ganymede: 500e3, callisto: 160e3 }, moonT: 120, helioDv: 0.1, gain: 0.05, vinf: 0.04, turn: 1 });
  });
});
