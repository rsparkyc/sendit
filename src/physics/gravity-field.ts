/**
 * Gravity fields beyond the point mass: zonal harmonics about a pole, and the
 * full spherical-harmonic expansion (zonal, sectoral and tesseral terms) in a
 * body-fixed frame. Shared by the spacecraft (spacecraft.ts) and the
 * massive-body integrator (nbody.ts).
 *
 * POTENTIAL (unnormalized coefficients, reference radius R, the geodesy sign
 * convention used by the DE440 header, the JPL satellite ephemerides and EGM):
 *   U = GM/r [ 1 - sum_n J_n (R/r)^n P_n(sin phi)
 *              + sum_{n>=2, 1<=m<=n} (R/r)^n P_nm(sin phi) (C_nm cos m lam + S_nm sin m lam) ],
 * a = grad U, with phi, lam latitude and east longitude in the body-fixed frame
 * (z along the IAU north pole, x through the prime meridian), and P_nm without
 * the Condon-Shortley phase. J_n = -C_n0.
 *
 * ZONAL TERMS ONLY (`addZonal`), u = (r . p)/r for pole p:
 *   a_n = GM J_n R^n / r^(n+2) [ ((n+1) P_n(u) + u P_n'(u)) r_hat - P_n'(u) p ],
 * with P_n, P_n' by the recurrences n P_n = (2n-1) u P_{n-1} - (n-1) P_{n-2} and
 * P_n' = P_{n-2}' + (2n-1) P_{n-1} (no division by 1 - u^2, so no pole
 * singularity). For n = 2 this is the familiar
 *   a = -(3/2) J2 GM R^2 / r^5 [ (1 - 5 u^2) r + 2 (r . p) p ].
 * ODD n are odd in the pole: the pole must point to the north of the
 * convention the coefficients are defined in (see solar-system.ts, POLES).
 *
 * FULL FIELD (`HarmonicField`): the Cunningham recursion of the solid
 * harmonics V_nm, W_nm in Cartesian body-fixed coordinates, and the
 * acceleration formulas of O. Montenbruck, E. Gill, Satellite Orbits (2000),
 * sec. 3.2.4-3.2.5, eqs. 3.29-3.33. No trigonometric functions and no
 * singularity at the poles.
 *
 * Both are verified against an independent numerical gradient of the
 * potential written directly from associated Legendre functions in spherical
 * coordinates (test/gravity-field.test.ts).
 *
 * DETERMINISM: + - * / and Math.sqrt only, in a fixed order.
 */

/** Precomputed zonal series of one body: J_n (n = 2..N) and the recurrence factors. */
export class ZonalSeries {
  /** Highest degree with a nonzero J_n. */
  readonly degree: number;
  /** jr[n] = J_n R^n (index = degree; 0 where absent). */
  readonly jr: Float64Array;
  /** Recurrence factors: a[n] = (2n-1)/n, b[n] = (n-1)/n, c[n] = 2n-1, d[n] = n+1. */
  private readonly ra: Float64Array;
  private readonly rb: Float64Array;
  private readonly rc: Float64Array;
  private readonly rd: Float64Array;
  /** Degree-2-only field: use the closed form. */
  readonly onlyJ2: boolean;

  /** @param jn J_n for n = 2, 3, ... (jn[0] = J2), unnormalized, reference radius `radius`. */
  constructor(jn: readonly number[], radius: number) {
    let deg = 1;
    for (let i = 0; i < jn.length; i++) if (jn[i] !== 0) deg = i + 2;
    this.degree = deg;
    this.jr = new Float64Array(deg + 1);
    this.ra = new Float64Array(deg + 1);
    this.rb = new Float64Array(deg + 1);
    this.rc = new Float64Array(deg + 1);
    this.rd = new Float64Array(deg + 1);
    let rn = radius;
    for (let n = 2; n <= deg; n++) {
      rn *= radius;
      this.jr[n] = jn[n - 2] * rn;
      this.ra[n] = (2 * n - 1) / n;
      this.rb[n] = (n - 1) / n;
      this.rc[n] = 2 * n - 1;
      this.rd[n] = n + 1;
    }
    this.onlyJ2 = deg === 2;
  }

  /**
   * Add gm * (zonal acceleration) at r = (rx, ry, rz) from the body, pole p
   * (unit), scaled by `scale`, into out[o..o+2]. Returns nothing; pure.
   */
  add(gm: number, rx: number, ry: number, rz: number, px: number, py: number, pz: number, out: Float64Array, o: number, scale = 1): void {
    const r2 = rx * rx + ry * ry + rz * rz;
    const r = Math.sqrt(r2);
    const ir = 1 / r;
    const u = (rx * px + ry * py + rz * pz) * ir;
    const jr = this.jr;
    const ra = this.ra;
    const rb = this.rb;
    const rc = this.rc;
    const rd = this.rd;
    const N = this.degree;
    // sum_n J_n R^n r^-n [ ((n+1) P_n + u P_n') ] and sum_n J_n R^n r^-n P_n'
    let sa = 0;
    let sb = 0;
    let p2 = 1; // P_{n-2}
    let p1 = u; // P_{n-1}
    let d2 = 0; // P'_{n-2}
    let d1 = 1; // P'_{n-1}
    let irn = ir; // r^-n
    for (let n = 2; n <= N; n++) {
      const pn = ra[n] * u * p1 - rb[n] * p2;
      const dn = d2 + rc[n] * p1;
      irn *= ir;
      const j = jr[n] * irn;
      sa += j * (rd[n] * pn + u * dn);
      sb += j * dn;
      p2 = p1;
      p1 = pn;
      d2 = d1;
      d1 = dn;
    }
    // a = gm/r^2 [ sa r_hat - sb p ] = (gm sa / r^3) r - (gm sb / r^2) p
    const fr = (scale * gm * sa) / (r2 * r);
    const fp = (scale * gm * sb) / r2;
    out[o] += fr * rx - fp * px;
    out[o + 1] += fr * ry - fp * py;
    out[o + 2] += fr * rz - fp * pz;
  }
}

/** One coefficient row: degree n, order m (>= 1), unnormalized C_nm, S_nm. */
export type TesseralTerm = readonly [n: number, m: number, c: number, s: number];

/**
 * Full spherical-harmonic field (every C_nm, S_nm with n >= 2, including the
 * zonal C_n0 = -J_n) evaluated in the body-fixed frame by the Cunningham
 * recursion. Holds scratch arrays: not re-entrant, one instance per user.
 */
export class HarmonicField {
  readonly degree: number;
  readonly radius: number;
  /** Solid harmonics V_nm, W_nm for n, m <= degree + 1, by idx(n, m) = n(n+1)/2 + m. */
  private readonly V: Float64Array;
  private readonly W: Float64Array;
  /** Zonal column (m = 0) recurrence for n = 2..N+1: index, (2n-1)/n, (n-1)/n. */
  private readonly zi: Int32Array;
  private readonly za: Float64Array;
  private readonly zb: Float64Array;
  /** Diagonal steps m = 1..N+1: V_mm from V_{m-1,m-1}, factor 2m-1, and the first off-diagonal V_{m+1,m} (2m+1). */
  private readonly di: Int32Array;
  private readonly dp: Int32Array;
  private readonly df: Float64Array;
  private readonly oi: Int32Array;
  private readonly of: Float64Array;
  /** General recurrence V_nm (n >= m + 2): index, n-1 index, n-2 index, (2n-1)/(n-m), (n+m-1)/(n-m). */
  private readonly gi: Int32Array;
  private readonly g1: Int32Array;
  private readonly g2: Int32Array;
  private readonly ga: Float64Array;
  private readonly gb: Float64Array;
  /** Zonal acceleration terms: C_n0, idx(n+1, 0), n+1. */
  private readonly ac: Float64Array;
  private readonly ab: Int32Array;
  private readonly an: Float64Array;
  /** Tesseral acceleration terms (nonzero only): C, S, idx(n+1, m), (n-m+1)(n-m+2), n-m+1. */
  private readonly tc: Float64Array;
  private readonly ts: Float64Array;
  private readonly tb: Int32Array;
  private readonly tf: Float64Array;
  private readonly tn: Float64Array;
  private readonly tmp = new Float64Array(3);
  /** Degree exactly 4: the unrolled recursion (add4) with -J2..-J4 and C/S in (m, n) order. */
  private readonly deg4: boolean;
  private readonly cz4 = new Float64Array(3);
  private readonly ct4 = new Float64Array(9);
  private readonly st4 = new Float64Array(9);

  /**
   * @param jn  J_n for n = 2, 3, ... (jn[0] = J2).
   * @param tesseral  rows (n, m, C_nm, S_nm), 1 <= m <= n.
   */
  constructor(jn: readonly number[], tesseral: readonly TesseralTerm[], radius: number) {
    let deg = 2;
    for (let i = 0; i < jn.length; i++) if (jn[i] !== 0) deg = Math.max(deg, i + 2);
    for (const [n, m, c, s] of tesseral) {
      if (!(m >= 1 && m <= n && n >= 2)) throw new Error(`tesseral term (${n}, ${m}): need 2 <= n, 1 <= m <= n`);
      if (c !== 0 || s !== 0) deg = Math.max(deg, n);
    }
    const N = deg;
    this.degree = N;
    this.radius = radius;
    const size = ((N + 2) * (N + 3)) / 2;
    this.V = new Float64Array(size);
    this.W = new Float64Array(size);
    const zi: number[] = [], za: number[] = [], zb: number[] = [];
    for (let n = 2; n <= N + 1; n++) {
      zi.push(idx(n, 0));
      za.push((2 * n - 1) / n);
      zb.push((n - 1) / n);
    }
    this.zi = Int32Array.from(zi);
    this.za = Float64Array.from(za);
    this.zb = Float64Array.from(zb);
    const di: number[] = [], dp: number[] = [], df: number[] = [], oi: number[] = [], of: number[] = [];
    const gi: number[] = [], g1: number[] = [], g2: number[] = [], ga: number[] = [], gb: number[] = [];
    for (let m = 1; m <= N + 1; m++) {
      di.push(idx(m, m));
      dp.push(idx(m - 1, m - 1));
      df.push(2 * m - 1);
      // V_{m+1,m} exists when m + 1 <= N + 1; -1 marks none.
      oi.push(m <= N ? idx(m + 1, m) : -1);
      of.push(2 * m + 1);
    }
    for (let m = 1; m <= N + 1; m++) {
      for (let n = m + 2; n <= N + 1; n++) {
        gi.push(idx(n, m));
        g1.push(idx(n - 1, m));
        g2.push(idx(n - 2, m));
        ga.push((2 * n - 1) / (n - m));
        gb.push((n + m - 1) / (n - m));
      }
    }
    this.di = Int32Array.from(di);
    this.dp = Int32Array.from(dp);
    this.df = Float64Array.from(df);
    this.oi = Int32Array.from(oi);
    this.of = Float64Array.from(of);
    this.gi = Int32Array.from(gi);
    this.g1 = Int32Array.from(g1);
    this.g2 = Int32Array.from(g2);
    this.ga = Float64Array.from(ga);
    this.gb = Float64Array.from(gb);
    const ac: number[] = [], ab: number[] = [], an: number[] = [];
    for (let n = 2; n <= N; n++) {
      const c = -(jn[n - 2] ?? 0);
      if (c === 0) continue;
      ac.push(c);
      ab.push(idx(n + 1, 0));
      an.push(n + 1);
    }
    this.ac = Float64Array.from(ac);
    this.ab = Int32Array.from(ab);
    this.an = Float64Array.from(an);
    const tc: number[] = [], ts: number[] = [], tb: number[] = [], tf: number[] = [], tn: number[] = [];
    const sorted = [...tesseral].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (const [n, m, c, s] of sorted) {
      if (c === 0 && s === 0) continue;
      tc.push(c);
      ts.push(s);
      tb.push(idx(n + 1, m));
      tf.push((n - m + 1) * (n - m + 2));
      tn.push(n - m + 1);
    }
    this.tc = Float64Array.from(tc);
    this.ts = Float64Array.from(ts);
    this.tb = Int32Array.from(tb);
    this.tf = Float64Array.from(tf);
    this.tn = Float64Array.from(tn);
    this.deg4 = N === 4;
    if (this.deg4) {
      for (let n = 2; n <= 4; n++) this.cz4[n - 2] = -(jn[n - 2] ?? 0);
      let k = 0;
      for (let m = 1; m <= 4; m++)
        for (let n = Math.max(m, 2); n <= 4; n++, k++)
          for (const [tn2, tm, c, s] of tesseral)
            if (tn2 === n && tm === m) {
              this.ct4[k] = c;
              this.st4[k] = s;
            }
    }
  }

  /**
   * gm * acceleration of the non-central terms (n >= 2) at the body-fixed
   * position (x, y, z), times `scale`, added to out[o..o+2] (body-fixed).
   */
  add(gm: number, x: number, y: number, z: number, out: Float64Array, o: number, scale = 1): void {
    const R = this.radius;
    const V = this.V;
    const W = this.W;
    const r2 = x * x + y * y + z * z;
    const ir2 = 1 / r2;
    const rho = R * R * ir2;
    const x0 = R * x * ir2;
    const y0 = R * y * ir2;
    const z0 = R * z * ir2;
    if (this.deg4) {
      this.add4(R, r2, rho, x0, y0, z0, gm, out, o, scale);
      return;
    }
    // Zonal column m = 0 (W_n0 = 0).
    V[0] = R / Math.sqrt(r2);
    W[0] = 0;
    V[1] = z0 * V[0];
    W[1] = 0;
    const zi = this.zi;
    const za = this.za;
    const zb = this.zb;
    for (let k = 0; k < zi.length; k++) {
      const i = zi[k];
      // idx(n-1, 0) = i - n, idx(n-2, 0) = i - 2n + 1, with n = k + 2.
      const n = k + 2;
      V[i] = za[k] * z0 * V[i - n] - zb[k] * rho * V[i - 2 * n + 1];
      W[i] = 0;
    }
    // Diagonals and first off-diagonals.
    const di = this.di;
    const dp = this.dp;
    const df = this.df;
    const oi = this.oi;
    const of = this.of;
    for (let k = 0; k < di.length; k++) {
      const d = di[k];
      const p = dp[k];
      const f = df[k];
      const v = f * (x0 * V[p] - y0 * W[p]);
      const w = f * (x0 * W[p] + y0 * V[p]);
      V[d] = v;
      W[d] = w;
      const q = oi[k];
      if (q >= 0) {
        V[q] = of[k] * z0 * v;
        W[q] = of[k] * z0 * w;
      }
    }
    // The rest of each column.
    const gi = this.gi;
    const g1 = this.g1;
    const g2 = this.g2;
    const ga = this.ga;
    const gb = this.gb;
    for (let k = 0; k < gi.length; k++) {
      const i = gi[k];
      const i1 = g1[k];
      const i2 = g2[k];
      const a = ga[k] * z0;
      const b = gb[k] * rho;
      V[i] = a * V[i1] - b * V[i2];
      W[i] = a * W[i1] - b * W[i2];
    }
    let ax = 0;
    let ay = 0;
    let az = 0;
    const ac = this.ac;
    const ab = this.ab;
    const an = this.an;
    for (let k = 0; k < ac.length; k++) {
      const c = ac[k];
      const b = ab[k];
      ax -= c * V[b + 1];
      ay -= c * W[b + 1];
      az -= an[k] * c * V[b];
    }
    const tc = this.tc;
    const ts = this.ts;
    const tb = this.tb;
    const tf = this.tf;
    const tn = this.tn;
    for (let k = 0; k < tc.length; k++) {
      const c = tc[k];
      const s = ts[k];
      const b = tb[k];
      const fac = tf[k];
      const vp = V[b + 1];
      const wp = W[b + 1];
      const vm = V[b - 1];
      const wm = W[b - 1];
      ax += 0.5 * (-c * vp - s * wp + fac * (c * vm + s * wm));
      ay += 0.5 * (-c * wp + s * vp + fac * (-c * wm + s * vm));
      az += tn[k] * (-c * V[b] - s * W[b]);
    }
    const kk = (scale * gm) / (R * R);
    out[o] += kk * ax;
    out[o + 1] += kk * ay;
    out[o + 2] += kk * az;
  }

  /**
   * add() for degree 4, unrolled: the same operations in the same order as
   * the general recursion (generated by a script from it; zero terms add an
   * exact 0), so the result is the general one up to the sign of a zero.
   */
  private add4(R: number, r2: number, rho: number, x0: number, y0: number, z0: number, gm: number, out: Float64Array, o: number, scale: number): void {
    const v00 = R / Math.sqrt(r2);
    const v10 = z0 * v00;
    const v20 = 1.5 * z0 * v10 - 0.5 * rho * v00;
    const v30 = 1.6666666666666667 * z0 * v20 - 0.6666666666666666 * rho * v10;
    const v40 = 1.75 * z0 * v30 - 0.75 * rho * v20;
    const v50 = 1.8 * z0 * v40 - 0.8 * rho * v30;
    const v11 = 1 * (x0 * v00 - y0 * 0);
    const w11 = 1 * (x0 * 0 + y0 * v00);
    const v21 = 3 * z0 * v11;
    const w21 = 3 * z0 * w11;
    const v22 = 3 * (x0 * v11 - y0 * w11);
    const w22 = 3 * (x0 * w11 + y0 * v11);
    const v32 = 5 * z0 * v22;
    const w32 = 5 * z0 * w22;
    const v33 = 5 * (x0 * v22 - y0 * w22);
    const w33 = 5 * (x0 * w22 + y0 * v22);
    const v43 = 7 * z0 * v33;
    const w43 = 7 * z0 * w33;
    const v44 = 7 * (x0 * v33 - y0 * w33);
    const w44 = 7 * (x0 * w33 + y0 * v33);
    const v54 = 9 * z0 * v44;
    const w54 = 9 * z0 * w44;
    const v55 = 9 * (x0 * v44 - y0 * w44);
    const w55 = 9 * (x0 * w44 + y0 * v44);
    const a31 = 2.5 * z0;
    const b31 = 1.5 * rho;
    const v31 = a31 * v21 - b31 * v11;
    const w31 = a31 * w21 - b31 * w11;
    const a41 = 2.3333333333333335 * z0;
    const b41 = 1.3333333333333333 * rho;
    const v41 = a41 * v31 - b41 * v21;
    const w41 = a41 * w31 - b41 * w21;
    const a51 = 2.25 * z0;
    const b51 = 1.25 * rho;
    const v51 = a51 * v41 - b51 * v31;
    const w51 = a51 * w41 - b51 * w31;
    const a42 = 3.5 * z0;
    const b42 = 2.5 * rho;
    const v42 = a42 * v32 - b42 * v22;
    const w42 = a42 * w32 - b42 * w22;
    const a52 = 3 * z0;
    const b52 = 2 * rho;
    const v52 = a52 * v42 - b52 * v32;
    const w52 = a52 * w42 - b52 * w32;
    const a53 = 4.5 * z0;
    const b53 = 3.5 * rho;
    const v53 = a53 * v43 - b53 * v33;
    const w53 = a53 * w43 - b53 * w33;
    const cz = this.cz4;
    let ax = 0;
    let ay = 0;
    let az = 0;
    ax -= cz[0] * v31;
    ay -= cz[0] * w31;
    az -= 3 * cz[0] * v30;
    ax -= cz[1] * v41;
    ay -= cz[1] * w41;
    az -= 4 * cz[1] * v40;
    ax -= cz[2] * v51;
    ay -= cz[2] * w51;
    az -= 5 * cz[2] * v50;
    const ct = this.ct4;
    const st = this.st4;
    {
      const c = ct[0];
      const s = st[0];
      ax += 0.5 * (-c * v32 - s * w32 + 6 * (c * v30 + s * 0));
      ay += 0.5 * (-c * w32 + s * v32 + 6 * (-c * 0 + s * v30));
      az += 2 * (-c * v31 - s * w31);
    }
    {
      const c = ct[1];
      const s = st[1];
      ax += 0.5 * (-c * v42 - s * w42 + 12 * (c * v40 + s * 0));
      ay += 0.5 * (-c * w42 + s * v42 + 12 * (-c * 0 + s * v40));
      az += 3 * (-c * v41 - s * w41);
    }
    {
      const c = ct[2];
      const s = st[2];
      ax += 0.5 * (-c * v52 - s * w52 + 20 * (c * v50 + s * 0));
      ay += 0.5 * (-c * w52 + s * v52 + 20 * (-c * 0 + s * v50));
      az += 4 * (-c * v51 - s * w51);
    }
    {
      const c = ct[3];
      const s = st[3];
      ax += 0.5 * (-c * v33 - s * w33 + 2 * (c * v31 + s * w31));
      ay += 0.5 * (-c * w33 + s * v33 + 2 * (-c * w31 + s * v31));
      az += 1 * (-c * v32 - s * w32);
    }
    {
      const c = ct[4];
      const s = st[4];
      ax += 0.5 * (-c * v43 - s * w43 + 6 * (c * v41 + s * w41));
      ay += 0.5 * (-c * w43 + s * v43 + 6 * (-c * w41 + s * v41));
      az += 2 * (-c * v42 - s * w42);
    }
    {
      const c = ct[5];
      const s = st[5];
      ax += 0.5 * (-c * v53 - s * w53 + 12 * (c * v51 + s * w51));
      ay += 0.5 * (-c * w53 + s * v53 + 12 * (-c * w51 + s * v51));
      az += 3 * (-c * v52 - s * w52);
    }
    {
      const c = ct[6];
      const s = st[6];
      ax += 0.5 * (-c * v44 - s * w44 + 2 * (c * v42 + s * w42));
      ay += 0.5 * (-c * w44 + s * v44 + 2 * (-c * w42 + s * v42));
      az += 1 * (-c * v43 - s * w43);
    }
    {
      const c = ct[7];
      const s = st[7];
      ax += 0.5 * (-c * v54 - s * w54 + 6 * (c * v52 + s * w52));
      ay += 0.5 * (-c * w54 + s * v54 + 6 * (-c * w52 + s * v52));
      az += 2 * (-c * v53 - s * w53);
    }
    {
      const c = ct[8];
      const s = st[8];
      ax += 0.5 * (-c * v55 - s * w55 + 2 * (c * v53 + s * w53));
      ay += 0.5 * (-c * w55 + s * v55 + 2 * (-c * w53 + s * v53));
      az += 1 * (-c * v54 - s * w54);
    }
    const kk = (scale * gm) / (R * R);
    out[o] += kk * ax;
    out[o + 1] += kk * ay;
    out[o + 2] += kk * az;
  }

  /**
   * gm * acceleration at the ICRF offset r (from the body's centre), given
   * the body-fixed -> ICRF matrix M (row-major, at M[mo..mo+8]); added to out.
   */
  addIcrf(gm: number, rx: number, ry: number, rz: number, M: Float64Array, mo: number, out: Float64Array, o: number, scale = 1): void {
    // body-fixed = M^T r
    const x = M[mo] * rx + M[mo + 3] * ry + M[mo + 6] * rz;
    const y = M[mo + 1] * rx + M[mo + 4] * ry + M[mo + 7] * rz;
    const z = M[mo + 2] * rx + M[mo + 5] * ry + M[mo + 8] * rz;
    const a = this.tmp;
    a[0] = 0;
    a[1] = 0;
    a[2] = 0;
    this.add(gm, x, y, z, a, 0, scale);
    out[o] += M[mo] * a[0] + M[mo + 1] * a[1] + M[mo + 2] * a[2];
    out[o + 1] += M[mo + 3] * a[0] + M[mo + 4] * a[1] + M[mo + 5] * a[2];
    out[o + 2] += M[mo + 6] * a[0] + M[mo + 7] * a[1] + M[mo + 8] * a[2];
  }
}

function idx(n: number, m: number): number {
  return (n * (n + 1)) / 2 + m;
}
