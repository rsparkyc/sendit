//! Chebyshev ephemeris evaluation: port of the evaluation half of
//! src/physics/chebyshev-ephemeris.ts (layout, evalBody, pairPlan, positions,
//! evaluate, evaluateBodies, bodyState, reconstruct). Chunks are loaded from
//! coefficients produced elsewhere (the TypeScript chunk builder, for now):
//! the same Float64Array layout, one flat Vec<f64> per chunk.

use std::collections::HashMap;

/// Everything needed to interpret a chunk (ChebyshevLayout), as plain arrays.
#[derive(Clone, Debug)]
pub struct Layout {
    pub count: usize,
    pub h: f64,
    pub chunk_steps: usize,
    pub chunk_span: f64,
    pub chunk_length: usize,
    pub seg_len: Vec<f64>,
    pub two_over_len: Vec<f64>,
    pub seg_count: Vec<usize>,
    pub offset: Vec<usize>,
    pub stride3: Vec<usize>,
    pub degree: Vec<usize>,
    pub center: Vec<i32>,
    pub weight: Vec<f64>,
    pub sys_planet: Vec<usize>,
    pub sys_start: Vec<usize>,
    pub sys_moons: Vec<usize>,
    pub system_of: Vec<i32>,
}

/// pairPlan: bodies of equal segment length evaluated two at a time (b has the lower degree; -1 alone).
pub fn pair_plan(l: &Layout) -> (Vec<usize>, Vec<isize>) {
    let n = l.count;
    let mut used = vec![false; n];
    let mut a = Vec::new();
    let mut b = Vec::new();
    for i in 0..n {
        if used[i] {
            continue;
        }
        used[i] = true;
        let mut j: isize = -1;
        for k in i + 1..n {
            if !used[k] && l.seg_len[k] == l.seg_len[i] && l.seg_count[k] == l.seg_count[i] && l.two_over_len[k] == l.two_over_len[i] {
                j = k as isize;
                break;
            }
        }
        if j >= 0 {
            used[j as usize] = true;
        }
        if j >= 0 && l.degree[j as usize] > l.degree[i] {
            a.push(j as usize);
            b.push(i as isize);
        } else {
            a.push(i);
            b.push(j);
        }
    }
    (a, b)
}

/// reconstruct(): system barycenter + relative moons -> barycentric bodies, in place.
fn reconstruct(l: &Layout, pos: &mut [f64], vel: Option<&mut [f64]>, only: Option<usize>) {
    let (s0, s1) = match only {
        Some(s) => (s, s + 1),
        None => (0, l.sys_planet.len()),
    };
    let mut vel = vel;
    for s in s0..s1 {
        let p = 3 * l.sys_planet[s];
        let a = l.sys_start[s];
        let b = l.sys_start[s + 1];
        let bx = pos[p];
        let by = pos[p + 1];
        let bz = pos[p + 2];
        let mut x = bx;
        let mut y = by;
        let mut z = bz;
        for k in a..b {
            let m = l.sys_moons[k];
            let w = l.weight[m];
            let i = 3 * m;
            let rx = pos[i];
            let ry = pos[i + 1];
            let rz = pos[i + 2];
            x -= w * rx;
            y -= w * ry;
            z -= w * rz;
            pos[i] = rx + bx;
            pos[i + 1] = ry + by;
            pos[i + 2] = rz + bz;
        }
        pos[p] = x;
        pos[p + 1] = y;
        pos[p + 2] = z;
        if let Some(vel) = vel.as_deref_mut() {
            let vx0 = vel[p];
            let vy0 = vel[p + 1];
            let vz0 = vel[p + 2];
            let mut u = vx0;
            let mut v = vy0;
            let mut w3 = vz0;
            for k in a..b {
                let m = l.sys_moons[k];
                let w = l.weight[m];
                let i = 3 * m;
                let rx = vel[i];
                let ry = vel[i + 1];
                let rz = vel[i + 2];
                u -= w * rx;
                v -= w * ry;
                w3 -= w * rz;
                vel[i] = rx + vx0;
                vel[i + 1] = ry + vy0;
                vel[i + 2] = rz + vz0;
            }
            vel[p] = u;
            vel[p + 1] = v;
            vel[p + 2] = w3;
        }
    }
}

/// evalBody: one body of a chunk at chunk-local time `local`.
#[allow(clippy::too_many_arguments)]
#[inline]
fn eval_body(l: &Layout, coeffs: &[f64], b: usize, local: f64, pos: &mut [f64], po: usize, vel: Option<&mut [f64]>, vo: usize) {
    let len = l.seg_len[b];
    let mut s = (local / len).floor();
    let nseg = l.seg_count[b] as f64;
    if s < 0.0 {
        s = 0.0;
    } else if s >= nseg {
        s = nseg - 1.0;
    }
    let x = (local - s * len) * l.two_over_len[b] - 1.0;
    let deg = l.degree[b];
    let mut o = l.offset[b] + (s as usize) * l.stride3[b];
    let mut px = coeffs[o] + x * coeffs[o + 3];
    let mut py = coeffs[o + 1] + x * coeffs[o + 4];
    let mut pz = coeffs[o + 2] + x * coeffs[o + 5];
    let x2 = 2.0 * x;
    let mut t_prev = 1.0;
    let mut t = x;
    match vel {
        None => {
            for _ in 2..=deg {
                let tn = x2 * t - t_prev;
                t_prev = t;
                t = tn;
                o += 3;
                px += tn * coeffs[o + 3];
                py += tn * coeffs[o + 4];
                pz += tn * coeffs[o + 5];
            }
        }
        Some(vel) => {
            let mut vx = coeffs[o + 3];
            let mut vy = coeffs[o + 4];
            let mut vz = coeffs[o + 5];
            let mut d_prev = 0.0;
            let mut d = 1.0;
            for _ in 2..=deg {
                let tn = x2 * t - t_prev;
                let dn = 2.0 * t + x2 * d - d_prev;
                t_prev = t;
                t = tn;
                d_prev = d;
                d = dn;
                o += 3;
                let cx = coeffs[o + 3];
                let cy = coeffs[o + 4];
                let cz = coeffs[o + 5];
                px += tn * cx;
                py += tn * cy;
                pz += tn * cz;
                vx += dn * cx;
                vy += dn * cy;
                vz += dn * cz;
            }
            let sc = l.two_over_len[b];
            vel[vo] = vx * sc;
            vel[vo + 1] = vy * sc;
            vel[vo + 2] = vz * sc;
        }
    }
    pos[po] = px;
    pos[po + 1] = py;
    pos[po + 2] = pz;
}

/// Ephemeris backed by Chebyshev chunks loaded from outside.
pub struct ChebEphemeris {
    pub layout: Layout,
    pub gm: Vec<f64>,
    pub t0: f64,
    chunks: HashMap<i64, Vec<f64>>,
    pair_a: Vec<usize>,
    pair_b: Vec<isize>,
    tmp_p: Vec<f64>,
    tmp_v: Vec<f64>,
    need: Vec<bool>,
    sys_need: Vec<bool>,
    /// Use the f64x2 evaluation for positions() where available (same per-lane arithmetic).
    pub simd: bool,
}

impl ChebEphemeris {
    pub fn new(layout: Layout, gm: Vec<f64>, t0: f64) -> Self {
        let (pair_a, pair_b) = pair_plan(&layout);
        let n = layout.count;
        let ns = layout.sys_planet.len();
        ChebEphemeris { layout, gm, t0, chunks: HashMap::new(), pair_a, pair_b, tmp_p: vec![0.0; 3 * n], tmp_v: vec![0.0; 3 * n], need: vec![false; n], sys_need: vec![false; ns], simd: false }
    }

    pub fn add_chunk(&mut self, k: i64, coeffs: Vec<f64>) {
        assert_eq!(coeffs.len(), self.layout.chunk_length, "chunk size does not match layout");
        self.chunks.insert(k, coeffs);
    }

    pub fn has_chunk(&self, k: i64) -> bool {
        self.chunks.contains_key(&k)
    }

    pub fn chunk_index(&self, t: f64) -> i64 {
        ((t - self.t0) / self.layout.chunk_span).floor() as i64
    }

    #[inline]
    fn locate(&self, t: f64) -> (&[f64], f64) {
        let rel = t - self.t0;
        let k = (rel / self.layout.chunk_span).floor();
        let local = rel - k * self.layout.chunk_span;
        let c = self.chunks.get(&(k as i64)).unwrap_or_else(|| panic!("chunk {k} not loaded"));
        (c, local)
    }

    /// Positions of all bodies at t (the hot path).
    pub fn positions(&self, t: f64, out: &mut [f64]) {
        if self.simd {
            #[cfg(any(target_arch = "aarch64", all(target_arch = "wasm32", target_feature = "simd128")))]
            {
                return self.positions_simd(t, out);
            }
        }
        let l = &self.layout;
        let (coeffs, local) = self.locate(t);
        for q in 0..self.pair_a.len() {
            let a = self.pair_a[q];
            let b = self.pair_b[q];
            let len = l.seg_len[a];
            let mut s = (local / len).floor();
            let nseg = l.seg_count[a] as f64;
            if s < 0.0 {
                s = 0.0;
            } else if s >= nseg {
                s = nseg - 1.0;
            }
            let x = (local - s * len) * l.two_over_len[a] - 1.0;
            let si = s as usize;
            let mut o = l.offset[a] + si * l.stride3[a];
            let mut px = coeffs[o] + x * coeffs[o + 3];
            let mut py = coeffs[o + 1] + x * coeffs[o + 4];
            let mut pz = coeffs[o + 2] + x * coeffs[o + 5];
            let x2 = 2.0 * x;
            let mut t_prev = 1.0;
            let mut tc = x;
            let end = o + 3 * l.degree[a];
            o += 6;
            if b >= 0 {
                let b = b as usize;
                let mut ob = l.offset[b] + si * l.stride3[b];
                let mut qx = coeffs[ob] + x * coeffs[ob + 3];
                let mut qy = coeffs[ob + 1] + x * coeffs[ob + 4];
                let mut qz = coeffs[ob + 2] + x * coeffs[ob + 5];
                let end_b = ob + 3 * l.degree[b];
                ob += 6;
                while ob <= end_b {
                    let tn = x2 * tc - t_prev;
                    t_prev = tc;
                    tc = tn;
                    px += tn * coeffs[o];
                    py += tn * coeffs[o + 1];
                    pz += tn * coeffs[o + 2];
                    qx += tn * coeffs[ob];
                    qy += tn * coeffs[ob + 1];
                    qz += tn * coeffs[ob + 2];
                    ob += 3;
                    o += 3;
                }
                out[3 * b] = qx;
                out[3 * b + 1] = qy;
                out[3 * b + 2] = qz;
            }
            while o <= end {
                let tn = x2 * tc - t_prev;
                t_prev = tc;
                tc = tn;
                px += tn * coeffs[o];
                py += tn * coeffs[o + 1];
                pz += tn * coeffs[o + 2];
                o += 3;
            }
            out[3 * a] = px;
            out[3 * a + 1] = py;
            out[3 * a + 2] = pz;
        }
        if !l.sys_planet.is_empty() {
            reconstruct(l, out, None, None);
        }
    }

    /// positions() with the two bodies of a pair in the two lanes of an f64x2
    /// where both still have terms, so each lane performs exactly its scalar
    /// sequence: lane-wise multiply, then lane-wise add or subtract, never fused.
    /// The x, y, z sums of a body are independent, as in the scalar code.
    #[cfg(any(target_arch = "aarch64", all(target_arch = "wasm32", target_feature = "simd128")))]
    fn positions_simd(&self, t: f64, out: &mut [f64]) {
        use crate::simd::F64x2;
        let l = &self.layout;
        let (coeffs, local) = self.locate(t);
        for q in 0..self.pair_a.len() {
            let a = self.pair_a[q];
            let b = self.pair_b[q];
            let len = l.seg_len[a];
            let mut s = (local / len).floor();
            let nseg = l.seg_count[a] as f64;
            if s < 0.0 {
                s = 0.0;
            } else if s >= nseg {
                s = nseg - 1.0;
            }
            let x = (local - s * len) * l.two_over_len[a] - 1.0;
            let si = s as usize;
            let mut o = l.offset[a] + si * l.stride3[a];
            let x2 = 2.0 * x;
            let mut t_prev = 1.0;
            let mut tc = x;
            let end = o + 3 * l.degree[a];
            if b >= 0 {
                let b = b as usize;
                let mut ob = l.offset[b] + si * l.stride3[b];
                let xv = F64x2::splat(x);
                // Lanes: (a, b) for each of x, y, z.
                let mut sx = F64x2::new(coeffs[o], coeffs[ob]).add(xv.mul(F64x2::new(coeffs[o + 3], coeffs[ob + 3])));
                let mut sy = F64x2::new(coeffs[o + 1], coeffs[ob + 1]).add(xv.mul(F64x2::new(coeffs[o + 4], coeffs[ob + 4])));
                let mut sz = F64x2::new(coeffs[o + 2], coeffs[ob + 2]).add(xv.mul(F64x2::new(coeffs[o + 5], coeffs[ob + 5])));
                let end_b = ob + 3 * l.degree[b];
                o += 6;
                ob += 6;
                while ob <= end_b {
                    let tn = x2 * tc - t_prev;
                    t_prev = tc;
                    tc = tn;
                    let tv = F64x2::splat(tn);
                    sx = sx.add(tv.mul(F64x2::new(coeffs[o], coeffs[ob])));
                    sy = sy.add(tv.mul(F64x2::new(coeffs[o + 1], coeffs[ob + 1])));
                    sz = sz.add(tv.mul(F64x2::new(coeffs[o + 2], coeffs[ob + 2])));
                    ob += 3;
                    o += 3;
                }
                out[3 * b] = sx.hi();
                out[3 * b + 1] = sy.hi();
                out[3 * b + 2] = sz.hi();
                // Lane a continues alone: x and y in one vector, z scalar.
                let mut pxy = F64x2::new(sx.lo(), sy.lo());
                let mut pz = sz.lo();
                while o <= end {
                    let tn = x2 * tc - t_prev;
                    t_prev = tc;
                    tc = tn;
                    pxy = pxy.add(F64x2::splat(tn).mul(F64x2::load(&coeffs[o..o + 2])));
                    pz += tn * coeffs[o + 2];
                    o += 3;
                }
                out[3 * a] = pxy.lo();
                out[3 * a + 1] = pxy.hi();
                out[3 * a + 2] = pz;
            } else {
                let xv = F64x2::splat(x);
                let mut pxy = F64x2::load(&coeffs[o..o + 2]).add(xv.mul(F64x2::load(&coeffs[o + 3..o + 5])));
                let mut pz = coeffs[o + 2] + x * coeffs[o + 5];
                o += 6;
                while o <= end {
                    let tn = x2 * tc - t_prev;
                    t_prev = tc;
                    tc = tn;
                    pxy = pxy.add(F64x2::splat(tn).mul(F64x2::load(&coeffs[o..o + 2])));
                    pz += tn * coeffs[o + 2];
                    o += 3;
                }
                out[3 * a] = pxy.lo();
                out[3 * a + 1] = pxy.hi();
                out[3 * a + 2] = pz;
            }
        }
        if !l.sys_planet.is_empty() {
            reconstruct(l, out, None, None);
        }
    }

    /// Positions and velocities of all bodies (evaluate(t, pos, vel)).
    pub fn evaluate(&self, t: f64, pos: &mut [f64], vel: Option<&mut [f64]>) {
        let vel = match vel {
            None => return self.positions(t, pos),
            Some(v) => v,
        };
        let l = &self.layout;
        let (coeffs, local) = self.locate(t);
        for q in 0..self.pair_a.len() {
            let a = self.pair_a[q];
            let b = self.pair_b[q];
            let len = l.seg_len[a];
            let mut s = (local / len).floor();
            let nseg = l.seg_count[a] as f64;
            if s < 0.0 {
                s = 0.0;
            } else if s >= nseg {
                s = nseg - 1.0;
            }
            let x = (local - s * len) * l.two_over_len[a] - 1.0;
            let si = s as usize;
            let mut o = l.offset[a] + si * l.stride3[a];
            let mut px = coeffs[o] + x * coeffs[o + 3];
            let mut py = coeffs[o + 1] + x * coeffs[o + 4];
            let mut pz = coeffs[o + 2] + x * coeffs[o + 5];
            let mut vx = coeffs[o + 3];
            let mut vy = coeffs[o + 4];
            let mut vz = coeffs[o + 5];
            let x2 = 2.0 * x;
            let mut t_prev = 1.0;
            let mut tc = x;
            let mut d_prev = 0.0;
            let mut d = 1.0;
            let end = o + 3 * l.degree[a];
            o += 6;
            if b >= 0 {
                let b = b as usize;
                let mut ob = l.offset[b] + si * l.stride3[b];
                let mut qx = coeffs[ob] + x * coeffs[ob + 3];
                let mut qy = coeffs[ob + 1] + x * coeffs[ob + 4];
                let mut qz = coeffs[ob + 2] + x * coeffs[ob + 5];
                let mut wx = coeffs[ob + 3];
                let mut wy = coeffs[ob + 4];
                let mut wz = coeffs[ob + 5];
                let end_b = ob + 3 * l.degree[b];
                ob += 6;
                while ob <= end_b {
                    let tn = x2 * tc - t_prev;
                    let dn = 2.0 * tc + x2 * d - d_prev;
                    t_prev = tc;
                    tc = tn;
                    d_prev = d;
                    d = dn;
                    let (cx, cy, cz) = (coeffs[o], coeffs[o + 1], coeffs[o + 2]);
                    px += tn * cx;
                    py += tn * cy;
                    pz += tn * cz;
                    vx += dn * cx;
                    vy += dn * cy;
                    vz += dn * cz;
                    let (ex, ey, ez) = (coeffs[ob], coeffs[ob + 1], coeffs[ob + 2]);
                    qx += tn * ex;
                    qy += tn * ey;
                    qz += tn * ez;
                    wx += dn * ex;
                    wy += dn * ey;
                    wz += dn * ez;
                    ob += 3;
                    o += 3;
                }
                let sb = l.two_over_len[b];
                vel[3 * b] = wx * sb;
                vel[3 * b + 1] = wy * sb;
                vel[3 * b + 2] = wz * sb;
                pos[3 * b] = qx;
                pos[3 * b + 1] = qy;
                pos[3 * b + 2] = qz;
            }
            while o <= end {
                let tn = x2 * tc - t_prev;
                let dn = 2.0 * tc + x2 * d - d_prev;
                t_prev = tc;
                tc = tn;
                d_prev = d;
                d = dn;
                let (cx, cy, cz) = (coeffs[o], coeffs[o + 1], coeffs[o + 2]);
                px += tn * cx;
                py += tn * cy;
                pz += tn * cz;
                vx += dn * cx;
                vy += dn * cy;
                vz += dn * cz;
                o += 3;
            }
            let sa = l.two_over_len[a];
            vel[3 * a] = vx * sa;
            vel[3 * a + 1] = vy * sa;
            vel[3 * a + 2] = vz * sa;
            pos[3 * a] = px;
            pos[3 * a + 1] = py;
            pos[3 * a + 2] = pz;
        }
        reconstruct(l, pos, Some(vel), None);
    }

    /// Positions (and velocities) of a subset: bodies[j] -> pos[3j..3j+3].
    pub fn evaluate_bodies(&mut self, t: f64, bodies: &[usize], pos: &mut [f64], vel: Option<&mut [f64]>) {
        let want_v = vel.is_some();
        let mut p = std::mem::take(&mut self.tmp_p);
        let mut v = std::mem::take(&mut self.tmp_v);
        {
            let l = &self.layout;
            let (coeffs, local) = self.locate(t);
            let mut need = vec![false; l.count];
            let mut sys_need = vec![false; l.sys_planet.len()];
            for &b in bodies {
                let s = l.system_of[b];
                if s < 0 {
                    need[b] = true;
                } else {
                    sys_need[s as usize] = true;
                }
            }
            for s in 0..sys_need.len() {
                if !sys_need[s] {
                    continue;
                }
                need[l.sys_planet[s]] = true;
                for i in l.sys_start[s]..l.sys_start[s + 1] {
                    need[l.sys_moons[i]] = true;
                }
            }
            for b in 0..l.count {
                if need[b] {
                    eval_body(l, coeffs, b, local, &mut p, 3 * b, if want_v { Some(&mut v) } else { None }, 3 * b);
                }
            }
            for s in 0..sys_need.len() {
                if sys_need[s] {
                    reconstruct(l, &mut p, if want_v { Some(&mut v) } else { None }, Some(s));
                }
            }
            let _ = (&self.need, &self.sys_need);
        }
        let mut vel = vel;
        for (j, &b) in bodies.iter().enumerate() {
            let b3 = 3 * b;
            pos[3 * j..3 * j + 3].copy_from_slice(&p[b3..b3 + 3]);
            if let Some(vel) = vel.as_deref_mut() {
                vel[3 * j..3 * j + 3].copy_from_slice(&v[b3..b3 + 3]);
            }
        }
        self.tmp_p = p;
        self.tmp_v = v;
    }

    /// Position and velocity of one body into out[0..6].
    pub fn body_state(&mut self, body: usize, t: f64, out: &mut [f64]) {
        let mut p = std::mem::take(&mut self.tmp_p);
        let mut v = std::mem::take(&mut self.tmp_v);
        {
            let l = &self.layout;
            let (coeffs, local) = self.locate(t);
            let s = l.system_of[body];
            if s < 0 {
                eval_body(l, coeffs, body, local, &mut p, 3 * body, Some(&mut v), 3 * body);
            } else {
                let s = s as usize;
                let pl = l.sys_planet[s];
                eval_body(l, coeffs, pl, local, &mut p, 3 * pl, Some(&mut v), 3 * pl);
                for i in l.sys_start[s]..l.sys_start[s + 1] {
                    let m = l.sys_moons[i];
                    eval_body(l, coeffs, m, local, &mut p, 3 * m, Some(&mut v), 3 * m);
                }
                reconstruct(l, &mut p, Some(&mut v), Some(s));
            }
        }
        for i in 0..3 {
            out[i] = p[3 * body + i];
            out[3 + i] = v[3 * body + i];
        }
        self.tmp_p = p;
        self.tmp_v = v;
    }
}
