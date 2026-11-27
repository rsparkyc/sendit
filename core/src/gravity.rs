//! Port of src/physics/gravity-field.ts: the zonal series about a pole and the
//! full spherical-harmonic field (Cunningham recursion, with the unrolled
//! degree-4 evaluation). Same operations in the same order; + - * / sqrt only.

pub struct ZonalSeries {
    pub degree: usize,
    jr: Vec<f64>,
    ra: Vec<f64>,
    rb: Vec<f64>,
    rc: Vec<f64>,
    rd: Vec<f64>,
    pub only_j2: bool,
}

impl ZonalSeries {
    /// `jn[0]` = J2, `jn[1]` = J3, ...
    pub fn new(jn: &[f64], radius: f64) -> Self {
        let mut deg = 1usize;
        for (i, &j) in jn.iter().enumerate() {
            if j != 0.0 {
                deg = i + 2;
            }
        }
        let mut z = ZonalSeries { degree: deg, jr: vec![0.0; deg + 1], ra: vec![0.0; deg + 1], rb: vec![0.0; deg + 1], rc: vec![0.0; deg + 1], rd: vec![0.0; deg + 1], only_j2: deg == 2 };
        let mut rn = radius;
        for n in 2..=deg {
            rn *= radius;
            let nf = n as f64;
            z.jr[n] = jn[n - 2] * rn;
            z.ra[n] = (2.0 * nf - 1.0) / nf;
            z.rb[n] = (nf - 1.0) / nf;
            z.rc[n] = 2.0 * nf - 1.0;
            z.rd[n] = nf + 1.0;
        }
        z
    }

    #[allow(clippy::too_many_arguments)]
    #[inline]
    pub fn add(&self, gm: f64, rx: f64, ry: f64, rz: f64, px: f64, py: f64, pz: f64, out: &mut [f64; 3], scale: f64) {
        let r2 = rx * rx + ry * ry + rz * rz;
        let r = r2.sqrt();
        let ir = 1.0 / r;
        let u = (rx * px + ry * py + rz * pz) * ir;
        let mut sa = 0.0;
        let mut sb = 0.0;
        let mut p2 = 1.0;
        let mut p1 = u;
        let mut d2 = 0.0;
        let mut d1 = 1.0;
        let mut irn = ir;
        for n in 2..=self.degree {
            let pn = self.ra[n] * u * p1 - self.rb[n] * p2;
            let dn = d2 + self.rc[n] * p1;
            irn *= ir;
            let j = self.jr[n] * irn;
            sa += j * (self.rd[n] * pn + u * dn);
            sb += j * dn;
            p2 = p1;
            p1 = pn;
            d2 = d1;
            d1 = dn;
        }
        let fr = (scale * gm * sa) / (r2 * r);
        let fp = (scale * gm * sb) / r2;
        out[0] += fr * rx - fp * px;
        out[1] += fr * ry - fp * py;
        out[2] += fr * rz - fp * pz;
    }
}

#[inline]
fn idx(n: usize, m: usize) -> usize {
    (n * (n + 1)) / 2 + m
}

/// One coefficient row (n, m >= 1, C_nm, S_nm), unnormalized.
pub type TesseralTerm = (u32, u32, f64, f64);

pub struct HarmonicField {
    pub degree: usize,
    pub radius: f64,
    v: Vec<f64>,
    w: Vec<f64>,
    zi: Vec<usize>,
    za: Vec<f64>,
    zb: Vec<f64>,
    di: Vec<usize>,
    dp: Vec<usize>,
    df: Vec<f64>,
    oi: Vec<isize>,
    of: Vec<f64>,
    gi: Vec<usize>,
    g1: Vec<usize>,
    g2: Vec<usize>,
    ga: Vec<f64>,
    gb: Vec<f64>,
    ac: Vec<f64>,
    ab: Vec<usize>,
    an: Vec<f64>,
    tc: Vec<f64>,
    ts: Vec<f64>,
    tb: Vec<usize>,
    tf: Vec<f64>,
    tn: Vec<f64>,
    deg4: bool,
    cz4: [f64; 3],
    ct4: [f64; 9],
    st4: [f64; 9],
}

impl HarmonicField {
    pub fn new(jn: &[f64], tesseral: &[TesseralTerm], radius: f64) -> Self {
        let mut deg = 2usize;
        for (i, &j) in jn.iter().enumerate() {
            if j != 0.0 {
                deg = deg.max(i + 2);
            }
        }
        for &(n, m, c, s) in tesseral {
            assert!(m >= 1 && m <= n && n >= 2, "tesseral term ({n}, {m}): need 2 <= n, 1 <= m <= n");
            if c != 0.0 || s != 0.0 {
                deg = deg.max(n as usize);
            }
        }
        let nn = deg;
        let size = ((nn + 2) * (nn + 3)) / 2;
        let mut f = HarmonicField {
            degree: nn,
            radius,
            v: vec![0.0; size],
            w: vec![0.0; size],
            zi: vec![], za: vec![], zb: vec![], di: vec![], dp: vec![], df: vec![], oi: vec![], of: vec![],
            gi: vec![], g1: vec![], g2: vec![], ga: vec![], gb: vec![], ac: vec![], ab: vec![], an: vec![],
            tc: vec![], ts: vec![], tb: vec![], tf: vec![], tn: vec![],
            deg4: nn == 4,
            cz4: [0.0; 3],
            ct4: [0.0; 9],
            st4: [0.0; 9],
        };
        for n in 2..=nn + 1 {
            let nf = n as f64;
            f.zi.push(idx(n, 0));
            f.za.push((2.0 * nf - 1.0) / nf);
            f.zb.push((nf - 1.0) / nf);
        }
        for m in 1..=nn + 1 {
            f.di.push(idx(m, m));
            f.dp.push(idx(m - 1, m - 1));
            f.df.push(2.0 * m as f64 - 1.0);
            f.oi.push(if m <= nn { idx(m + 1, m) as isize } else { -1 });
            f.of.push(2.0 * m as f64 + 1.0);
        }
        for m in 1..=nn + 1 {
            for n in m + 2..=nn + 1 {
                f.gi.push(idx(n, m));
                f.g1.push(idx(n - 1, m));
                f.g2.push(idx(n - 2, m));
                let (nf, mf) = (n as f64, m as f64);
                f.ga.push((2.0 * nf - 1.0) / (nf - mf));
                f.gb.push((nf + mf - 1.0) / (nf - mf));
            }
        }
        for n in 2..=nn {
            let c = -(jn.get(n - 2).copied().unwrap_or(0.0));
            if c == 0.0 {
                continue;
            }
            f.ac.push(c);
            f.ab.push(idx(n + 1, 0));
            f.an.push(n as f64 + 1.0);
        }
        let mut sorted: Vec<TesseralTerm> = tesseral.to_vec();
        // Stable sort by (m, n), as the TypeScript's Array.prototype.sort (stable since ES2019).
        sorted.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
        for &(n, m, c, s) in &sorted {
            if c == 0.0 && s == 0.0 {
                continue;
            }
            let (n, m) = (n as usize, m as usize);
            f.tc.push(c);
            f.ts.push(s);
            f.tb.push(idx(n + 1, m));
            f.tf.push(((n - m + 1) * (n - m + 2)) as f64);
            f.tn.push((n - m + 1) as f64);
        }
        if f.deg4 {
            for n in 2..=4 {
                f.cz4[n - 2] = -(jn.get(n - 2).copied().unwrap_or(0.0));
            }
            let mut k = 0;
            for m in 1..=4u32 {
                for n in m.max(2)..=4u32 {
                    for &(tn2, tm, c, s) in tesseral {
                        if tn2 == n && tm == m {
                            f.ct4[k] = c;
                            f.st4[k] = s;
                        }
                    }
                    k += 1;
                }
            }
        }
        f
    }

    /// gm * acceleration of the n >= 2 terms at body-fixed (x, y, z), times scale, added to out.
    #[allow(clippy::too_many_arguments)]
    pub fn add(&mut self, gm: f64, x: f64, y: f64, z: f64, out: &mut [f64; 3], scale: f64) {
        let rr = self.radius;
        let r2 = x * x + y * y + z * z;
        let ir2 = 1.0 / r2;
        let rho = rr * rr * ir2;
        let x0 = rr * x * ir2;
        let y0 = rr * y * ir2;
        let z0 = rr * z * ir2;
        if self.deg4 {
            self.add4(rr, r2, rho, x0, y0, z0, gm, out, scale);
            return;
        }
        let v = &mut self.v;
        let w = &mut self.w;
        v[0] = rr / r2.sqrt();
        w[0] = 0.0;
        v[1] = z0 * v[0];
        w[1] = 0.0;
        for k in 0..self.zi.len() {
            let i = self.zi[k];
            let n = k + 2;
            v[i] = self.za[k] * z0 * v[i - n] - self.zb[k] * rho * v[i - 2 * n + 1];
            w[i] = 0.0;
        }
        for k in 0..self.di.len() {
            let d = self.di[k];
            let p = self.dp[k];
            let f = self.df[k];
            let vv = f * (x0 * v[p] - y0 * w[p]);
            let ww = f * (x0 * w[p] + y0 * v[p]);
            v[d] = vv;
            w[d] = ww;
            let q = self.oi[k];
            if q >= 0 {
                let q = q as usize;
                v[q] = self.of[k] * z0 * vv;
                w[q] = self.of[k] * z0 * ww;
            }
        }
        for k in 0..self.gi.len() {
            let i = self.gi[k];
            let i1 = self.g1[k];
            let i2 = self.g2[k];
            let a = self.ga[k] * z0;
            let b = self.gb[k] * rho;
            v[i] = a * v[i1] - b * v[i2];
            w[i] = a * w[i1] - b * w[i2];
        }
        let mut ax = 0.0;
        let mut ay = 0.0;
        let mut az = 0.0;
        for k in 0..self.ac.len() {
            let c = self.ac[k];
            let b = self.ab[k];
            ax -= c * v[b + 1];
            ay -= c * w[b + 1];
            az -= self.an[k] * c * v[b];
        }
        for k in 0..self.tc.len() {
            let c = self.tc[k];
            let s = self.ts[k];
            let b = self.tb[k];
            let fac = self.tf[k];
            let vp = v[b + 1];
            let wp = w[b + 1];
            let vm = v[b - 1];
            let wm = w[b - 1];
            ax += 0.5 * (-c * vp - s * wp + fac * (c * vm + s * wm));
            ay += 0.5 * (-c * wp + s * vp + fac * (-c * wm + s * vm));
            az += self.tn[k] * (-c * v[b] - s * w[b]);
        }
        let kk = (scale * gm) / (rr * rr);
        out[0] += kk * ax;
        out[1] += kk * ay;
        out[2] += kk * az;
    }

    #[allow(clippy::too_many_arguments)]
    #[inline]
    fn add4(&self, rr: f64, r2: f64, rho: f64, x0: f64, y0: f64, z0: f64, gm: f64, out: &mut [f64; 3], scale: f64) {
        let v00 = rr / r2.sqrt();
        let v10 = z0 * v00;
        let v20 = 1.5 * z0 * v10 - 0.5 * rho * v00;
        let v30 = 1.6666666666666667 * z0 * v20 - 0.6666666666666666 * rho * v10;
        let v40 = 1.75 * z0 * v30 - 0.75 * rho * v20;
        let v50 = 1.8 * z0 * v40 - 0.8 * rho * v30;
        // `y0 * 0` and `x0 * 0` are kept: they can be -0 or NaN, as in the TypeScript.
        let v11 = 1.0 * (x0 * v00 - y0 * 0.0);
        let w11 = 1.0 * (x0 * 0.0 + y0 * v00);
        let v21 = 3.0 * z0 * v11;
        let w21 = 3.0 * z0 * w11;
        let v22 = 3.0 * (x0 * v11 - y0 * w11);
        let w22 = 3.0 * (x0 * w11 + y0 * v11);
        let v32 = 5.0 * z0 * v22;
        let w32 = 5.0 * z0 * w22;
        let v33 = 5.0 * (x0 * v22 - y0 * w22);
        let w33 = 5.0 * (x0 * w22 + y0 * v22);
        let v43 = 7.0 * z0 * v33;
        let w43 = 7.0 * z0 * w33;
        let v44 = 7.0 * (x0 * v33 - y0 * w33);
        let w44 = 7.0 * (x0 * w33 + y0 * v33);
        let v54 = 9.0 * z0 * v44;
        let w54 = 9.0 * z0 * w44;
        let v55 = 9.0 * (x0 * v44 - y0 * w44);
        let w55 = 9.0 * (x0 * w44 + y0 * v44);
        let a31 = 2.5 * z0;
        let b31 = 1.5 * rho;
        let v31 = a31 * v21 - b31 * v11;
        let w31 = a31 * w21 - b31 * w11;
        let a41 = 2.3333333333333335 * z0;
        let b41 = 1.3333333333333333 * rho;
        let v41 = a41 * v31 - b41 * v21;
        let w41 = a41 * w31 - b41 * w21;
        let a51 = 2.25 * z0;
        let b51 = 1.25 * rho;
        let v51 = a51 * v41 - b51 * v31;
        let w51 = a51 * w41 - b51 * w31;
        let a42 = 3.5 * z0;
        let b42 = 2.5 * rho;
        let v42 = a42 * v32 - b42 * v22;
        let w42 = a42 * w32 - b42 * w22;
        let a52 = 3.0 * z0;
        let b52 = 2.0 * rho;
        let v52 = a52 * v42 - b52 * v32;
        let w52 = a52 * w42 - b52 * w32;
        let a53 = 4.5 * z0;
        let b53 = 3.5 * rho;
        let v53 = a53 * v43 - b53 * v33;
        let w53 = a53 * w43 - b53 * w33;
        let cz = &self.cz4;
        let mut ax = 0.0;
        let mut ay = 0.0;
        let mut az = 0.0;
        ax -= cz[0] * v31;
        ay -= cz[0] * w31;
        az -= 3.0 * cz[0] * v30;
        ax -= cz[1] * v41;
        ay -= cz[1] * w41;
        az -= 4.0 * cz[1] * v40;
        ax -= cz[2] * v51;
        ay -= cz[2] * w51;
        az -= 5.0 * cz[2] * v50;
        let ct = &self.ct4;
        let st = &self.st4;
        // (c, s, vp, wp, vm, wm, fac, v, w, tn) per term, written out as in the TypeScript.
        {
            let (c, s) = (ct[0], st[0]);
            ax += 0.5 * (-c * v32 - s * w32 + 6.0 * (c * v30 + s * 0.0));
            ay += 0.5 * (-c * w32 + s * v32 + 6.0 * (-c * 0.0 + s * v30));
            az += 2.0 * (-c * v31 - s * w31);
        }
        {
            let (c, s) = (ct[1], st[1]);
            ax += 0.5 * (-c * v42 - s * w42 + 12.0 * (c * v40 + s * 0.0));
            ay += 0.5 * (-c * w42 + s * v42 + 12.0 * (-c * 0.0 + s * v40));
            az += 3.0 * (-c * v41 - s * w41);
        }
        {
            let (c, s) = (ct[2], st[2]);
            ax += 0.5 * (-c * v52 - s * w52 + 20.0 * (c * v50 + s * 0.0));
            ay += 0.5 * (-c * w52 + s * v52 + 20.0 * (-c * 0.0 + s * v50));
            az += 4.0 * (-c * v51 - s * w51);
        }
        {
            let (c, s) = (ct[3], st[3]);
            ax += 0.5 * (-c * v33 - s * w33 + 2.0 * (c * v31 + s * w31));
            ay += 0.5 * (-c * w33 + s * v33 + 2.0 * (-c * w31 + s * v31));
            az += 1.0 * (-c * v32 - s * w32);
        }
        {
            let (c, s) = (ct[4], st[4]);
            ax += 0.5 * (-c * v43 - s * w43 + 6.0 * (c * v41 + s * w41));
            ay += 0.5 * (-c * w43 + s * v43 + 6.0 * (-c * w41 + s * v41));
            az += 2.0 * (-c * v42 - s * w42);
        }
        {
            let (c, s) = (ct[5], st[5]);
            ax += 0.5 * (-c * v53 - s * w53 + 12.0 * (c * v51 + s * w51));
            ay += 0.5 * (-c * w53 + s * v53 + 12.0 * (-c * w51 + s * v51));
            az += 3.0 * (-c * v52 - s * w52);
        }
        {
            let (c, s) = (ct[6], st[6]);
            ax += 0.5 * (-c * v44 - s * w44 + 2.0 * (c * v42 + s * w42));
            ay += 0.5 * (-c * w44 + s * v44 + 2.0 * (-c * w42 + s * v42));
            az += 1.0 * (-c * v43 - s * w43);
        }
        {
            let (c, s) = (ct[7], st[7]);
            ax += 0.5 * (-c * v54 - s * w54 + 6.0 * (c * v52 + s * w52));
            ay += 0.5 * (-c * w54 + s * v54 + 6.0 * (-c * w52 + s * v52));
            az += 2.0 * (-c * v53 - s * w53);
        }
        {
            let (c, s) = (ct[8], st[8]);
            ax += 0.5 * (-c * v55 - s * w55 + 2.0 * (c * v53 + s * w53));
            ay += 0.5 * (-c * w55 + s * v55 + 2.0 * (-c * w53 + s * v53));
            az += 1.0 * (-c * v54 - s * w54);
        }
        let kk = (scale * gm) / (rr * rr);
        out[0] += kk * ax;
        out[1] += kk * ay;
        out[2] += kk * az;
    }

    /// gm * acceleration at the ICRF offset r, with body-fixed -> ICRF matrix m (row-major).
    #[allow(clippy::too_many_arguments)]
    pub fn add_icrf(&mut self, gm: f64, rx: f64, ry: f64, rz: f64, m: &[f64], out: &mut [f64; 3], scale: f64) {
        let x = m[0] * rx + m[3] * ry + m[6] * rz;
        let y = m[1] * rx + m[4] * ry + m[7] * rz;
        let z = m[2] * rx + m[5] * ry + m[8] * rz;
        let mut a = [0.0f64; 3];
        self.add(gm, x, y, z, &mut a, scale);
        out[0] += m[0] * a[0] + m[1] * a[1] + m[2] * a[2];
        out[1] += m[3] * a[0] + m[4] * a[1] + m[5] * a[2];
        out[2] += m[6] * a[0] + m[7] * a[1] + m[8] * a[2];
    }
}
