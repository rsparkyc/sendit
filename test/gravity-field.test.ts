/**
 * Gravity fields beyond the point mass (src/physics/gravity-field.ts), checked
 * against independent calculations:
 *  - the numerical gradient of the potential written directly in spherical
 *    coordinates from associated Legendre functions built from Rodrigues'
 *    formula (polynomial algebra, no recurrence shared with the code);
 *  - the closed J2 and J4 forms the integrators used before;
 *  - the classical secular theory of J3 (the eccentricity vector of a circular
 *    polar orbit drifts at (3/8) n J3 (R/a)^3 sin i (5 sin^2 i - 4) along the
 *    line of nodes), which also fixes the SENSE of the pole: J3 is odd in it;
 *  - the east-west drift of geostationary satellites toward the stable points
 *    near 75 E and 105 W (Earth's C22/S22 and degree-3 terms, rotating with the
 *    Earth Rotation Angle);
 *  - that every body with odd or body-fixed terms has an IAU frame whose north
 *    is the rotational north its coefficients are defined about.
 */
import { describe, expect, it } from 'vitest';
import { HarmonicField, ZonalSeries, type TesseralTerm } from '../src/physics/gravity-field';
import { addZonalAccelerations } from '../src/physics/nbody';
import { IAU_ROTATION } from '../src/physics/orientation';
import { J2000_BODIES, bodyIndex, oblatenessOf } from '../src/physics/solar-system';
import { checkFieldOrientation, propagate, sharedBodyFrame, type BodyOblateness, type Ephemeris } from '../src/physics/spacecraft';

const EARTH = J2000_BODIES[bodyIndex('earth')];
const MOON = J2000_BODIES[bodyIndex('moon')];

/** Coefficients of P_n(x) (Rodrigues: P_n = 1/(2^n n!) d^n/dx^n (x^2 - 1)^n), lowest power first. */
function legendrePoly(n: number): number[] {
  // (x^2 - 1)^n
  let p = [1];
  for (let k = 0; k < n; k++) {
    const q = new Array(p.length + 2).fill(0);
    p.forEach((c, i) => {
      q[i + 2] += c;
      q[i] -= c;
    });
    p = q;
  }
  for (let k = 0; k < n; k++) p = p.slice(1).map((c, i) => c * (i + 1));
  let f = 1;
  for (let k = 1; k <= n; k++) f *= 2 * k;
  return p.map((c) => c / f);
}
const polyval = (c: number[], x: number) => c.reduceRight((s, a) => s * x + a, 0);
const deriv = (c: number[]) => c.slice(1).map((a, i) => a * (i + 1));

/** P_nm(x) = (1 - x^2)^(m/2) d^m/dx^m P_n(x), no Condon-Shortley phase. */
function assocLegendre(n: number, m: number, x: number): number {
  let c = legendrePoly(n);
  for (let k = 0; k < m; k++) c = deriv(c);
  return Math.pow(1 - x * x, m / 2) * polyval(c, x);
}

/** Non-central potential per unit GM at body-fixed (x, y, z), written in spherical coordinates. */
function potential(jn: readonly number[], tess: readonly TesseralTerm[], R: number, x: number, y: number, z: number): number {
  const r = Math.hypot(x, y, z);
  const s = z / r;
  const lam = Math.atan2(y, x);
  let u = 0;
  jn.forEach((j, i) => {
    const n = i + 2;
    u -= j * Math.pow(R / r, n) * assocLegendre(n, 0, s);
  });
  for (const [n, m, c, sn] of tess) u += Math.pow(R / r, n) * assocLegendre(n, m, s) * (c * Math.cos(m * lam) + sn * Math.sin(m * lam));
  return u / r;
}

function numericGradient(f: (x: number, y: number, z: number) => number, p: number[], h: number): number[] {
  return [0, 1, 2].map((k) => {
    const a = [...p];
    const b = [...p];
    a[k] += h;
    b[k] -= h;
    // 4th-order central difference.
    const a2 = [...p];
    const b2 = [...p];
    a2[k] += 2 * h;
    b2[k] -= 2 * h;
    return (8 * (f(a[0], a[1], a[2]) - f(b[0], b[1], b[2])) - (f(a2[0], a2[1], a2[2]) - f(b2[0], b2[1], b2[2]))) / (12 * h);
  });
}

let seed = 12345;
const rnd = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
};
function randomPoint(r: number): number[] {
  const z = 2 * rnd() - 1;
  const a = 2 * Math.PI * rnd();
  const c = Math.sqrt(1 - z * z);
  return [r * c * Math.cos(a), r * c * Math.sin(a), r * z];
}

const tess = (b: typeof EARTH) => (b.tesseral ?? []).map((r) => [r[0], r[1], r[2], r[3]] as const);

describe('field accelerations against the gradient of the potential', () => {
  const cases: { name: string; jn: readonly number[]; tess: readonly TesseralTerm[]; R: number; radii: number[] }[] = [
    { name: 'Earth (data)', jn: EARTH.jn!, tess: tess(EARTH), R: EARTH.j2Radius!, radii: [6.6e6, 7.6e6, 4.2e7] },
    { name: 'Moon (data)', jn: MOON.jn!, tess: tess(MOON), R: MOON.j2Radius!, radii: [1.79e6, 3e6] },
    {
      name: 'random degree 6',
      jn: [1e-3, -3e-5, 2e-5, -7e-6, 4e-6],
      tess: Array.from({ length: 6 - 1 }, (_, i) => i + 2).flatMap((n) => Array.from({ length: n }, (_, k) => [n, k + 1, 1e-5 * (rnd() - 0.5), 1e-5 * (rnd() - 0.5)] as const)),
      R: 1e6,
      radii: [1.05e6, 2e6],
    },
  ];
  for (const c of cases) {
    it(`full field (Cunningham): ${c.name}`, () => {
      const f = new HarmonicField(c.jn, c.tess, c.R);
      let worst = 0;
      for (const r of c.radii) {
        for (let k = 0; k < 40; k++) {
          const p = randomPoint(r);
          const g = numericGradient((x, y, z) => potential(c.jn, c.tess, c.R, x, y, z), p, r * 1e-4);
          const a = new Float64Array(3);
          f.add(1, p[0], p[1], p[2], a, 0);
          const scale = Math.hypot(...g);
          worst = Math.max(worst, Math.hypot(a[0] - g[0], a[1] - g[1], a[2] - g[2]) / scale);
        }
      }
      // The difference is the finite-difference error (~1e-12 relative to the field terms).
      expect(worst).toBeLessThan(1e-7);
    });
  }

  it('the unrolled degree-4 recursion gives the general recursion\'s bits', () => {
    for (const id of ['earth', 'moon']) {
      const ob = oblatenessOf(J2000_BODIES[bodyIndex(id)])!;
      const f4 = new HarmonicField(ob.jn!, ob.tesseral!, ob.radius);
      const gen = new HarmonicField(ob.jn!, ob.tesseral!, ob.radius);
      (gen as unknown as { deg4: boolean }).deg4 = false;
      for (let k = 0; k < 200; k++) {
        const r = ob.radius * (1.01 + k * 0.37);
        const x = r * Math.cos(k * 1.3) * Math.cos(k * 0.7), y = r * Math.sin(k * 1.3) * Math.cos(k * 0.7), z = r * Math.sin(k * 0.7);
        const a = new Float64Array(3), b = new Float64Array(3);
        f4.add(J2000_BODIES[bodyIndex(id)].gm, x, y, z, a, 0, 0.75);
        gen.add(J2000_BODIES[bodyIndex(id)].gm, x, y, z, b, 0, 0.75);
        for (let c = 0; c < 3; c++) expect(a[c] === b[c], `${id} ${k} ${c}`).toBe(true);
      }
    }
  });

  it('zonal series about an arbitrary pole equals the full field with that pole as z', () => {
    const jn = [EARTH.jn![0], EARTH.jn![1], EARTH.jn![2], -2.3e-7, 5.4e-7];
    const z = new ZonalSeries(jn, EARTH.j2Radius!);
    const R = EARTH.j2Radius!;
    // A rotation taking the body z axis to pole p: columns e1, e2, p.
    const p = [0.3, -0.5, Math.sqrt(1 - 0.34)];
    const e1 = [p[2], 0, -p[0]].map((v) => v / Math.hypot(p[2], p[0]));
    const e2 = [p[1] * e1[2] - p[2] * e1[1], p[2] * e1[0] - p[0] * e1[2], p[0] * e1[1] - p[1] * e1[0]];
    let worst = 0;
    for (let k = 0; k < 50; k++) {
      const q = randomPoint(7e6 + 3e7 * rnd());
      const a = new Float64Array(3);
      z.add(1, q[0], q[1], q[2], p[0], p[1], p[2], a, 0);
      // Body coordinates and the potential's gradient there.
      const b = [e1, e2, p].map((e) => e[0] * q[0] + e[1] * q[1] + e[2] * q[2]);
      const g = numericGradient((x, y, w) => potential(jn, [], R, x, y, w), b, Math.hypot(...b) * 1e-4);
      const gi = [0, 1, 2].map((i) => e1[i] * g[0] + e2[i] * g[1] + p[i] * g[2]);
      worst = Math.max(worst, Math.hypot(a[0] - gi[0], a[1] - gi[1], a[2] - gi[2]) / Math.hypot(...gi));
    }
    expect(worst).toBeLessThan(1e-7);
  });

  it('J2 and J4 through the series equal the closed forms of the integrators', () => {
    const j2 = 0.0146965063;
    const j4 = -5.866085e-4;
    const R = 7.1492e7;
    const pole = [0.1, 0.2, Math.sqrt(0.95)] as [number, number, number];
    const gm = [1.27e17, 1];
    for (let k = 0; k < 20; k++) {
      const p = randomPoint(R * (1.05 + 30 * rnd()));
      const closed = new Float64Array(6);
      addZonalAccelerations(gm, [0, 0, 0, ...p], [{ body: 0, j2, j4, radius: R, pole, targets: [1] }], closed);
      const series = new Float64Array(3);
      new ZonalSeries([j2, 0, j4], R).add(gm[0], p[0], p[1], p[2], pole[0], pole[1], pole[2], series, 0);
      for (let i = 0; i < 3; i++) expect(Math.abs(series[i] - closed[3 + i])).toBeLessThan(1e-13 * Math.hypot(closed[3], closed[4], closed[5]));
    }
  });
});

describe('sense of the pole', () => {
  it('every body with odd zonal or body-fixed terms rotates prograde: IAU north is rotational north', () => {
    const lines: string[] = [];
    for (const b of J2000_BODIES) {
      const ob = oblatenessOf(b);
      if (ob === null) continue;
      const odd = (ob.jn ?? []).some((j, i) => i % 2 === 1 && j !== 0);
      const t = (ob.tesseral ?? []).length > 0;
      lines.push(`${b.id}: odd ${odd}, tesseral ${t}, W rate ${IAU_ROTATION[b.id].pm[1]}`);
      if (odd || t) expect(IAU_ROTATION[b.id].pm[1], b.id).toBeGreaterThan(0);
      expect(() => checkFieldOrientation(b.id, ob)).not.toThrow();
    }
    // Uranus (IAU north = rotational south) has only even terms.
    const u = oblatenessOf(J2000_BODIES[bodyIndex('uranus')])!;
    expect(u.jn!.filter((_, i) => i % 2 === 1).every((j) => j === 0)).toBe(true);
    // An odd term on a retrograde rotator is refused.
    expect(() => checkFieldOrientation('uranus', { ...u, jn: [u.j2, 1e-6] })).toThrow(/retrograde/);
    console.log(lines.join('\n'));
  });

  it('J3 drives a circular polar orbit\'s eccentricity vector along the node line at the classical rate, with the known sign', () => {
    // Earth point mass + J3 alone (no J2, so nothing else moves the elements secularly).
    const gm = EARTH.gm;
    const R = EARTH.j2Radius!;
    const J3 = EARTH.jn![1];
    const a = 7.0e6;
    const pole = [0, 0, 1] as const;
    const field = (sense: 1 | -1): Ephemeris => ({
      count: 1,
      gm: [gm],
      positions: (_t, out) => out.fill(0, 0, 3),
      bodyState: (_b, _t, out) => out.fill(0, 0, 6),
      oblateness: [{ j2: 0, jn: [0, J3], radius: R, pole: [0, 0, sense] } satisfies BodyOblateness],
    });
    const v = Math.sqrt(gm / a);
    // Ascending node on +x, polar: r = a x_hat, v = v z_hat (moving north).
    const y0 = [a, 0, 0, 0, 0, v, 1000];
    const n = Math.sqrt(gm / (a * a * a));
    const period = (2 * Math.PI) / n;
    const T = 100 * period;
    const ecc = (y: ArrayLike<number>) => {
      const r = [y[0], y[1], y[2]];
      const w = [y[3], y[4], y[5]];
      const rn = Math.hypot(...r);
      const rv = r[0] * w[0] + r[1] * w[1] + r[2] * w[2];
      const v2 = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
      return [0, 1, 2].map((k) => ((v2 - gm / rn) * r[k] - rv * w[k]) / gm);
    };
    const run = (sense: 1 | -1) => {
      // Average the eccentricity vector over the first and last orbit (removes the short-period terms).
      const avg = (t0: number) => {
        const s = [0, 0, 0];
        const K = 64;
        let y = propagate(field(sense), y0, 0, t0, [], { rtol: 1e-13 }).y;
        let t = t0;
        for (let k = 0; k < K; k++) {
          const e = ecc(y);
          for (let i = 0; i < 3; i++) s[i] += e[i] / K;
          y = propagate(field(sense), y, t, t + period / K, [], { rtol: 1e-13 }).y;
          t += period / K;
        }
        return s;
      };
      const e0 = avg(0);
      const e1 = avg(T);
      return e1.map((x, i) => (x - e0[i]) / T);
    };
    const rate = run(1);
    // Classical secular J3 (e.g. Vallado, Fundamentals of Astrodynamics, eq. 9-41 limit e -> 0;
    // Kozai 1959): d(e cos w)/dt = (3/8) n J3 (R/a)^3 sin i (5 sin^2 i - 4); i = 90 deg: (3/8) n J3 (R/a)^3.
    const expected = 0.375 * n * J3 * Math.pow(R / a, 3);
    console.log(`J3 polar orbit: e-vector rate along the node ${rate[0].toExponential(4)} /s, theory ${expected.toExponential(4)} /s; across ${rate[1].toExponential(1)}, ${rate[2].toExponential(1)}`);
    // Earth's J3 < 0: the eccentricity vector moves toward the DESCENDING node (-x here).
    expect(J3).toBeLessThan(0);
    expect(rate[0]).toBeLessThan(0);
    expect(Math.abs(rate[0] / expected - 1)).toBeLessThan(0.02);
    expect(Math.hypot(rate[1], rate[2])).toBeLessThan(0.02 * Math.abs(expected));
    // The opposite pole reverses it: odd zonals depend on the sense of the pole.
    const flipped = run(-1);
    expect(Math.abs(flipped[0] / expected + 1)).toBeLessThan(0.02);
  }, 120_000);
});

describe('Earth tesseral field: geostationary east-west drift', () => {
  it('accelerates toward the stable points near 75 E and 105 W, at the classical rate', () => {
    const ob = oblatenessOf(EARTH)!;
    const frame = sharedBodyFrame(IAU_ROTATION.earth, 'earth-rotation-angle');
    const eph: Ephemeris = {
      count: 1,
      gm: [EARTH.gm],
      positions: (_t, out) => out.fill(0, 0, 3),
      bodyState: (_b, _t, out) => out.fill(0, 0, 6),
      oblateness: [ob],
    };
    const M = new Float64Array(9);
    const lonOf = (t: number, y: ArrayLike<number>) => {
      frame.at(t, M);
      const x = M[0] * y[0] + M[3] * y[1] + M[6] * y[2];
      const yy = M[1] * y[0] + M[4] * y[1] + M[7] * y[2];
      return Math.atan2(yy, x) * (180 / Math.PI);
    };
    const omega = (360.9856122880876 * Math.PI) / 180 / 86400;
    const R = ob.radius;
    const J2 = ob.j2;
    // Circular equatorial orbit whose mean motion with J2 equals Earth's rotation: n^2 a^3 = GM (1 + 1.5 J2 (R/a)^2).
    let a = Math.cbrt(EARTH.gm / (omega * omega));
    for (let k = 0; k < 5; k++) a = Math.cbrt((EARTH.gm * (1 + 1.5 * J2 * (R / a) ** 2)) / (omega * omega));
    const C22 = ob.tesseral!.find((r) => r[0] === 2 && r[1] === 2)!;
    const J22 = Math.hypot(C22[2], C22[3]);
    const lam22 = (Math.atan2(C22[3], C22[2]) / 2) * (180 / Math.PI);
    const DAYS = 60;
    const lines: string[] = [];
    for (const lon0 of [30, 150, -60, -150]) {
      // Start over lon0 on the equator (in the true equator of date), co-rotating.
      const t0 = 0;
      frame.at(t0, M);
      const L = (lon0 * Math.PI) / 180;
      const bx = [Math.cos(L), Math.sin(L), 0];
      const by = [-Math.sin(L), Math.cos(L), 0];
      const r = [0, 1, 2].map((i) => a * (M[3 * i] * bx[0] + M[3 * i + 1] * bx[1]));
      const vdir = [0, 1, 2].map((i) => M[3 * i] * by[0] + M[3 * i + 1] * by[1]);
      const y0 = [...r, ...vdir.map((d) => d * omega * a), 1000];
      // Longitude every 2 days; least-squares parabola.
      const ts: number[] = [];
      const ls: number[] = [];
      let y: ArrayLike<number> = y0;
      for (let d = 0; d <= DAYS; d += 2) {
        if (d > 0) y = propagate(eph, y, (d - 2) * 86400, d * 86400, [], { rtol: 1e-12 }).y;
        ts.push(d);
        ls.push(lonOf(d * 86400, y));
      }
      // Fit l = c0 + c1 d + c2 d^2.
      const S = (f: (i: number) => number) => ts.reduce((s, _, i) => s + f(i), 0);
      const A = [0, 1, 2].map((p) => [0, 1, 2].map((q) => S((i) => ts[i] ** (p + q))));
      const b = [0, 1, 2].map((p) => S((i) => ts[i] ** p * ls[i]));
      const sol = solve3(A, b);
      const accel = 2 * sol[2]; // deg/day^2
      // Degree-2 theory: lambda'' = -3 a_t / a, a_t = -6 GM/a^2 (R/a)^2 J22 sin 2(lambda - lambda22).
      const at = -6 * (EARTH.gm / (a * a)) * (R / a) ** 2 * J22 * Math.sin((2 * (lon0 - lam22) * Math.PI) / 180);
      const theory = ((-3 * at) / a) * 86400 * 86400 * (180 / Math.PI);
      lines.push(`start ${String(lon0).padStart(4)} deg: longitude acceleration ${accel.toExponential(3)} deg/day^2 (degree-2 theory ${theory.toExponential(3)})`);
      // Toward 75 E from 30 E and 150 E, toward 105 W from 60 W and 150 W.
      const expectEast = lon0 === 30 || lon0 === -150;
      expect(Math.sign(accel), String(lon0)).toBe(expectEast ? 1 : -1);
      // Degree 3-4 terms change it by up to ~30% from the degree-2 value.
      expect(Math.abs(accel / theory - 1), String(lon0)).toBeLessThan(0.35);
    }
    console.log(`geostationary drift (C22/S22: J22 ${J22.toExponential(4)}, lambda22 ${lam22.toFixed(2)} deg)\n${lines.join('\n')}`);
  }, 120_000);
});

function solve3(A: number[][], b: number[]): number[] {
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [0, 1, 2].map((i) => m[i][3] / m[i][i]);
}

/**
 * The taper of the terms above J2 (BodyOblateness.taper, radii in
 * solar-system-j2000.json "fieldTaper", chosen in scripts/fetch-horizons.py).
 */
describe('field taper', () => {
  it('the stored radii meet the criterion: discarded acceleration at the inner radius <= 1e-12 m/s^2 (and not far below it)', () => {
    const dirs: number[][] = [];
    for (let i = 0; i < 400; i++) {
      const z = -1 + (2 * i + 1) / 400;
      const s = Math.sqrt(1 - z * z);
      dirs.push([s * Math.cos(i * 2.399963), s * Math.sin(i * 2.399963), z]);
    }
    const lines: string[] = [];
    for (const b of J2000_BODIES) {
      const ob = oblatenessOf(b);
      if (!ob || ob.jn === undefined || ob.jn.length < 2) continue;
      expect(ob.taper, `${b.id} has terms above J2 and needs a taper`).toBeDefined();
      const [ki, ko] = ob.taper!;
      expect(ko).toBeCloseTo(1.25 * ki, -0.5);
      const f = new HarmonicField([0, ...ob.jn.slice(1)], ob.tesseral ?? [], ob.radius);
      const r = ki * ob.radius;
      let mx = 0;
      const a = new Float64Array(3);
      for (const d of dirs) {
        a.fill(0);
        f.add(b.gm, d[0] * r, d[1] * r, d[2] * r, a, 0);
        mx = Math.max(mx, Math.hypot(a[0], a[1], a[2]));
      }
      lines.push(`${b.id}: inner ${ki} R, outer ${ko} R; discarded at inner ${mx.toExponential(2)} m/s^2 = ${(mx / (b.gm / (r * r))).toExponential(1)} of the point mass`);
      expect(mx).toBeLessThan(1e-12);
      expect(mx).toBeGreaterThan(5e-13);
    }
    console.log(lines.join('\n'));
  });

  // Earth alone at the origin with its full field, and a hyperbolic departure
  // from 100 R across the taper (114..143 R) in about two days.
  const ob = oblatenessOf(EARTH)!;
  const earthOnly = (taper: readonly [number, number] | undefined): Ephemeris => ({
    count: 1,
    gm: [EARTH.gm],
    oblateness: [{ ...ob, taper }],
    positions: (_t, out) => out.fill(0, 0, 3),
    bodyState: (_b, _t, out) => out.fill(0, 0, 6),
  });
  const r0 = 100 * ob.radius;
  const y0 = [r0 * 0.8, r0 * 0.5, r0 * Math.sqrt(1 - 0.89), 1200, 900, 300, 1000];
  const T = 5 * 86400;
  const run = (taper: readonly [number, number] | undefined, rtol: number) => propagate(earthOnly(taper), y0, 0, T, [], { rtol });
  const d = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  it('is smooth: crossing it costs no extra steps and tight and loose tolerances agree as without it', () => {
    const rEnd = Math.hypot(...run(ob.taper, 1e-12).y.slice(0, 3)) / ob.radius;
    expect(rEnd).toBeGreaterThan(ob.taper![1] + 5); // the run does cross the taper
    const tap = [1e-9, 1e-12].map((tol) => run(ob.taper, tol));
    const off = [1e-9, 1e-12].map((tol) => run(undefined, tol));
    console.log(
      `taper crossing (to ${rEnd.toFixed(0)} R): steps with taper ${tap.map((r) => `${r.accepted}+${r.rejected}`).join(' / ')}, without ${off.map((r) => `${r.accepted}+${r.rejected}`).join(' / ')} (rtol 1e-9 / 1e-12, accepted+rejected); ` +
        `loose vs tight ${d(tap[0].y, tap[1].y).toExponential(2)} m (without taper ${d(off[0].y, off[1].y).toExponential(2)} m); taper vs none ${d(tap[1].y, off[1].y).toExponential(2)} m`,
    );
    for (let k = 0; k < 2; k++) {
      expect(tap[k].accepted).toBeLessThanOrEqual(off[k].accepted + 2);
      expect(tap[k].rejected).toBeLessThanOrEqual(off[k].rejected + 2);
    }
    expect(d(tap[0].y, tap[1].y)).toBeLessThan(10 * d(off[0].y, off[1].y) + 1e-3);
    // What the taper discards (<= 1e-12 m/s^2 at 114 R, less outside) over 5 days.
    expect(d(tap[1].y, off[1].y)).toBeLessThan(1);
  });

  it('is smooth where the field is strong: an artificial taper at 3..4 R crossed 2 x per orbit', () => {
    // Orbit 2 R x 6 R for 2 days (~9 crossings). The taper's derivatives are
    // then large, so a discontinuity would show as rejected steps; compare a
    // near-hard cutoff (width 1e-6 R).
    const rp = 2 * ob.radius;
    const ra = 6 * ob.radius;
    const a = (rp + ra) / 2;
    const vp = Math.sqrt(EARTH.gm * (2 / rp - 1 / a));
    const y = [rp, 0, 0, 0, vp * 0.8, vp * 0.6, 1000];
    const go = (taper: readonly [number, number] | undefined, rtol: number) => propagate(earthOnly(taper), y, 0, 2 * 86400, [], { rtol });
    const lines: string[] = [];
    for (const rtol of [1e-9, 1e-12]) {
      const sm = go([3, 4], rtol);
      const none = go(undefined, rtol);
      const hard = go([3.5, 3.5 + 1e-6], rtol);
      lines.push(`rtol ${rtol}: accepted+rejected smooth ${sm.accepted}+${sm.rejected}, no taper ${none.accepted}+${none.rejected}, near-hard ${hard.accepted}+${hard.rejected}`);
      expect(sm.accepted).toBeLessThan(1.15 * none.accepted + 5);
      expect(sm.rejected).toBeLessThan(none.rejected + 0.05 * none.accepted + 3);
    }
    const t9 = go([3, 4], 1e-9).y;
    const t12 = go([3, 4], 1e-12).y;
    const n9 = go(undefined, 1e-9).y;
    const n12 = go(undefined, 1e-12).y;
    lines.push(`loose vs tight: smooth taper ${d(t9, t12).toExponential(2)} m, no taper ${d(n9, n12).toExponential(2)} m`);
    console.log(lines.join('\n'));
    expect(d(t9, t12)).toBeLessThan(3 * d(n9, n12) + 1e-2);
  });

  it('is path-independent: the same bits whatever was propagated before', () => {
    const a = run(ob.taper, 1e-11).y;
    propagate(earthOnly(ob.taper), [7e6, 0, 0, 0, 7500, 100, 1000], 3e5, 4e5, [], { rtol: 1e-9 });
    propagate(earthOnly(ob.taper), [1.3e8 * 6, 0, 0, 0, 900, 100, 1000], -1e6, -2e5, [], { rtol: 1e-10 });
    const b = run(ob.taper, 1e-11).y;
    for (let k = 0; k < 7; k++) expect(Object.is(a[k], b[k])).toBe(true);
  });
});
