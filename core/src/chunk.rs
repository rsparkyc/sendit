//! Chunk building: port of the build half of src/physics/chebyshev-ephemeris.ts
//! (fitBasis: Householder pseudo-inverse of the pos/vel/acc Chebyshev design
//! matrix; ChunkFitter; buildChunk; extendTo) and of the checkpoint asset
//! reader of src/physics/checkpoint-asset.ts. A chunk built here from a
//! checkpoint is bit-identical to the TypeScript's, in any build order: the
//! fit of a segment depends only on its samples, the samples only on the
//! integrator state at fixed step counts, and the integrator only on
//! (checkpoint, step count).

use crate::cheb::Layout;
use crate::nbody::{kahan_li_8, NBodyIntegrator, Physics};
use std::collections::HashMap;

/// pinv is cols x rows, row-major; rows = 3 (m + 1).
pub struct FitBasis {
    pub m: usize,
    pub cols: usize,
    pub rows: usize,
    pub pinv: Vec<f64>,
}

/// fitBasis(m, degree).
pub fn fit_basis(m: usize, degree: usize) -> FitBasis {
    let cols = degree + 1;
    let rows = 3 * (m + 1);
    assert!(rows >= cols, "fit {m}/{degree}: underdetermined");
    let mut a = vec![0.0f64; rows * cols];
    for j in 0..=m {
        let x = (2.0 * j as f64) / m as f64 - 1.0;
        let mut t0 = 1.0;
        let mut t1 = x;
        let mut d0 = 0.0;
        let mut d1 = 1.0;
        let mut e0 = 0.0;
        let mut e1 = 0.0;
        for k in 0..cols {
            let (t, d, e);
            if k == 0 {
                t = 1.0;
                d = 0.0;
                e = 0.0;
            } else if k == 1 {
                t = x;
                d = 1.0;
                e = 0.0;
            } else {
                t = 2.0 * x * t1 - t0;
                d = 2.0 * t1 + 2.0 * x * d1 - d0;
                e = 4.0 * d1 + 2.0 * x * e1 - e0;
                t0 = t1;
                t1 = t;
                d0 = d1;
                d1 = d;
                e0 = e1;
                e1 = e;
            }
            a[(3 * j) * cols + k] = t;
            a[(3 * j + 1) * cols + k] = d;
            a[(3 * j + 2) * cols + k] = e;
        }
    }
    let mut vlead = vec![0.0f64; cols];
    let mut diag = vec![0.0f64; cols];
    for k in 0..cols {
        let mut s = 0.0;
        for i in k..rows {
            s += a[i * cols + k] * a[i * cols + k];
        }
        let norm = s.sqrt();
        assert!(norm != 0.0, "fit {m}/{degree}: rank deficient");
        let akk = a[k * cols + k];
        let alpha = if akk > 0.0 { -norm } else { norm };
        let v0 = akk - alpha;
        vlead[k] = v0;
        diag[k] = alpha;
        let mut vtv = v0 * v0;
        for i in k + 1..rows {
            vtv += a[i * cols + k] * a[i * cols + k];
        }
        for c in k + 1..cols {
            let mut dot = v0 * a[k * cols + c];
            for i in k + 1..rows {
                dot += a[i * cols + k] * a[i * cols + c];
            }
            let f = (2.0 * dot) / vtv;
            a[k * cols + c] -= f * v0;
            for i in k + 1..rows {
                a[i * cols + c] -= f * a[i * cols + k];
            }
        }
        a[k * cols + k] = vtv;
    }
    let mut pinv = vec![0.0f64; cols * rows];
    let mut y = vec![0.0f64; rows];
    for r in 0..rows {
        for v in y.iter_mut() {
            *v = 0.0;
        }
        y[r] = 1.0;
        for k in 0..cols {
            let vtv = a[k * cols + k];
            let mut dot = vlead[k] * y[k];
            for i in k + 1..rows {
                dot += a[i * cols + k] * y[i];
            }
            let f = (2.0 * dot) / vtv;
            y[k] -= f * vlead[k];
            for i in k + 1..rows {
                y[i] -= f * a[i * cols + k];
            }
        }
        for k in (0..cols).rev() {
            let mut s = y[k];
            for c in k + 1..cols {
                s -= a[k * cols + c] * y[c];
            }
            y[k] = s / diag[k];
        }
        for k in 0..cols {
            pinv[k * rows + r] = y[k];
        }
    }
    FitBasis { m, cols, rows, pinv }
}

/// Streaming fitter for one chunk (ChunkFitter).
pub struct ChunkFitter<'a> {
    pub coeffs: Vec<f64>,
    layout: &'a Layout,
    gm: &'a [f64],
    seg: Vec<Vec<f64>>,
    gsys: Vec<f64>,
    any: usize,
    bases: &'a HashMap<(usize, usize), FitBasis>,
    rhs: Vec<f64>,
}

impl<'a> ChunkFitter<'a> {
    pub fn new(layout: &'a Layout, gm: &'a [f64], bases: &'a HashMap<(usize, usize), FitBasis>) -> Self {
        let seg = (0..layout.count).map(|b| vec![0.0; (layout.samples[b] + 1) * 9]).collect();
        let mut gsys = vec![0.0; layout.sys_planet.len()];
        for s in 0..layout.sys_planet.len() {
            let mut g = gm[layout.sys_planet[s]];
            for k in layout.sys_start[s]..layout.sys_start[s + 1] {
                g += gm[layout.sys_moons[k]];
            }
            gsys[s] = g;
        }
        let mut any = layout.chunk_steps;
        for b in 0..layout.count {
            any = any.min(layout.sample_stride[b]);
        }
        let max_rows = (0..layout.count).map(|b| 3 * (layout.samples[b] + 1)).max().unwrap_or(0);
        ChunkFitter { coeffs: vec![0.0; layout.chunk_length], layout, gm, seg, gsys, any, bases, rhs: vec![0.0; max_rows] }
    }

    pub fn wants(&self, j: usize) -> bool {
        if j % self.any != 0 {
            return false;
        }
        (0..self.layout.count).any(|b| j % self.layout.sample_stride[b] == 0)
    }

    fn bary(&self, s: usize, x: &[f64], o: usize, c: usize) -> f64 {
        let l = self.layout;
        let p = l.sys_planet[s];
        let mut sum = self.gm[p] * x[o + 3 * p + c];
        for k in l.sys_start[s]..l.sys_start[s + 1] {
            let i = l.sys_moons[k];
            sum += self.gm[i] * x[o + 3 * i + c];
        }
        sum / self.gsys[s]
    }

    fn value(&self, b: usize, x: &[f64], o: usize, c: usize) -> f64 {
        let s = self.layout.system_of[b];
        if s < 0 {
            return x[o + 3 * b + c];
        }
        if self.layout.center[b] >= 0 {
            return x[o + 3 * b + c] - self.bary(s as usize, x, o, c);
        }
        self.bary(s as usize, x, o, c)
    }

    #[allow(clippy::too_many_arguments)]
    fn write(&mut self, b: usize, li: usize, q: &[f64], qo: usize, v: &[f64], vo: usize, a: &[f64], ao: usize) {
        for c in 0..3 {
            let pq = self.value(b, q, qo, c);
            let pv = self.value(b, v, vo, c);
            let pa = self.value(b, a, ao, c);
            let buf = &mut self.seg[b];
            buf[9 * li + c] = pq;
            buf[9 * li + 3 + c] = pv;
            buf[9 * li + 6 + c] = pa;
        }
    }

    /// State at step j of the chunk (0..chunkSteps, ascending in time); `forward`: steps arrive in increasing j.
    #[allow(clippy::too_many_arguments)]
    pub fn put(&mut self, j: usize, forward: bool, q: &[f64], qo: usize, v: &[f64], vo: usize, a: &[f64], ao: usize) {
        for b in 0..self.layout.count {
            let stride = self.layout.sample_stride[b];
            if j % stride != 0 {
                continue;
            }
            let m = self.layout.samples[b];
            let i = j / stride;
            let s = i / m;
            let li = i - s * m;
            let nseg = self.layout.seg_count[b];
            if forward {
                if li == 0 && s > 0 {
                    self.write(b, m, q, qo, v, vo, a, ao);
                    self.fit(b, s - 1);
                }
                if s < nseg {
                    self.write(b, li, q, qo, v, vo, a, ao);
                }
            } else {
                if s < nseg {
                    self.write(b, li, q, qo, v, vo, a, ao);
                    if li == 0 {
                        self.fit(b, s);
                    }
                }
                if li == 0 && s > 0 {
                    self.write(b, m, q, qo, v, vo, a, ao);
                }
            }
        }
    }

    fn fit(&mut self, b: usize, s: usize) {
        let l = self.layout;
        let m = l.samples[b];
        let basis = &self.bases[&(m, l.degree[b])];
        let half = l.seg_len[b] / 2.0;
        let half2 = half * half;
        let rows = basis.rows;
        let cols = basis.cols;
        let buf = &self.seg[b];
        let rhs = &mut self.rhs;
        let jm = m / 2;
        let xm = (2.0 * jm as f64) / m as f64 - 1.0;
        let base = l.offset[b] + s * l.stride3[b];
        for c in 0..3 {
            let p0 = buf[9 * jm + c];
            let v0 = buf[9 * jm + 3 + c] * half;
            for j in 0..=m {
                let x = (2.0 * j as f64) / m as f64 - 1.0;
                rhs[3 * j] = buf[9 * j + c] - p0 - v0 * (x - xm);
                rhs[3 * j + 1] = buf[9 * j + 3 + c] * half - v0;
                rhs[3 * j + 2] = buf[9 * j + 6 + c] * half2;
            }
            for kk in 0..cols {
                let mut sum = 0.0;
                let prow = kk * rows;
                for r in 0..rows {
                    sum += basis.pinv[prow + r] * rhs[r];
                }
                if kk == 0 {
                    sum += p0 - v0 * xm;
                } else if kk == 1 {
                    sum += v0;
                }
                self.coeffs[base + 3 * kk + c] = sum;
            }
        }
    }
}

/// Every fit basis a layout needs, keyed by (samples, degree).
pub fn bases_for(layout: &Layout) -> HashMap<(usize, usize), FitBasis> {
    let mut m = HashMap::new();
    for b in 0..layout.count {
        let key = (layout.samples[b], layout.degree[b]);
        m.entry(key).or_insert_with(|| fit_basis(key.0, key.1));
    }
    m
}

/// A checkpoint: NBodyIntegrator.exportState at boundary `boundary` (12 n numbers).
#[derive(Clone, Debug)]
pub struct Checkpoint {
    pub boundary: i64,
    pub data: Vec<f64>,
}

/// initialCheckpoint(bodies) from the initial states [x,y,z,vx,vy,vz] per body.
pub fn initial_checkpoint(state: &[f64]) -> Checkpoint {
    let n = state.len() / 6;
    let mut data = vec![0.0; 12 * n];
    for i in 0..n {
        for k in 0..3 {
            data[3 * i + k] = state[6 * i + k];
            data[3 * n + 3 * i + k] = state[6 * i + 3 + k];
        }
    }
    Checkpoint { boundary: 0, data }
}

/// restoreIntegrator().
fn restore_integrator(gm: &[f64], physics: &Physics, cp: &Checkpoint, layout: &Layout, t0: f64, dir: f64) -> NBodyIntegrator {
    let n = gm.len();
    let m = 3 * n;
    let mut state = vec![0.0; 6 * n];
    for i in 0..n {
        for k in 0..3 {
            state[6 * i + k] = cp.data[3 * i + k];
            state[6 * i + 3 + k] = cp.data[m + 3 * i + k];
        }
    }
    let mut it = NBodyIntegrator::new(gm, &state, t0, dir * layout.h, kahan_li_8(), physics);
    it.import_state(&cp.data, (cp.boundary.unsigned_abs() as f64) * layout.chunk_steps as f64);
    it
}

/// buildChunk(): integrate chunk k from its start checkpoint and fit it. Returns the coefficients and the far checkpoint.
pub fn build_chunk(layout: &Layout, gm: &[f64], physics: &Physics, bases: &HashMap<(usize, usize), FitBasis>, t0: f64, k: i64, start: &Checkpoint) -> (Vec<f64>, Checkpoint) {
    let fwd = k >= 0;
    assert_eq!(start.boundary, if fwd { k } else { k + 1 }, "chunk {k}: wrong start checkpoint {}", start.boundary);
    let s = layout.chunk_steps;
    let n = gm.len();
    let mut fitter = ChunkFitter::new(layout, gm, bases);
    let mut acc = vec![0.0; 3 * n];
    let mut it = restore_integrator(gm, physics, start, layout, t0, if fwd { 1.0 } else { -1.0 });
    let mut put = |it: &mut NBodyIntegrator, fitter: &mut ChunkFitter, j: usize| {
        if !fitter.wants(j) {
            return;
        }
        it.total_acceleration(&mut acc);
        fitter.put(j, fwd, &it.q, 0, &it.v, 0, &acc, 0);
    };
    put(&mut it, &mut fitter, if fwd { 0 } else { s });
    for i in 1..=s {
        it.step();
        put(&mut it, &mut fitter, if fwd { i } else { s - i });
    }
    let end = Checkpoint { boundary: if fwd { k + 1 } else { k }, data: it.export_state() };
    (fitter.coeffs, end)
}

/// What the ephemeris needs to build its own chunks: the physics, the known checkpoints.
pub struct ChunkBuilder {
    pub layout: Layout,
    pub gm: Vec<f64>,
    pub physics: Physics,
    pub t0: f64,
    pub cps: HashMap<i64, Checkpoint>,
    bases: HashMap<(usize, usize), FitBasis>,
    /// Chunks built so far (for progress reporting and benchmarks).
    pub built: u64,
    /// Called after every chunk built (progress), with the chunk index.
    pub on_built: Option<Box<dyn FnMut(i64) + Send>>,
}

impl ChunkBuilder {
    pub fn new(layout: Layout, gm: Vec<f64>, physics: Physics, t0: f64, initial: Checkpoint) -> Self {
        let bases = bases_for(&layout);
        let mut cps = HashMap::new();
        cps.insert(0, initial);
        ChunkBuilder { layout, gm, physics, t0, cps, bases, built: 0, on_built: None }
    }

    /// addCheckpoint(): the first one known for a boundary wins.
    pub fn add_checkpoint(&mut self, cp: Checkpoint) {
        assert_eq!(cp.data.len(), 12 * self.gm.len(), "checkpoint size does not match body count");
        self.cps.entry(cp.boundary).or_insert(cp);
    }

    /// Build one chunk from the checkpoint at its start boundary (which must be known).
    pub fn build(&mut self, k: i64) -> (Vec<f64>, Checkpoint) {
        let start = if k >= 0 { k } else { k + 1 };
        let cp = self.cps.get(&start).unwrap_or_else(|| panic!("chunk {k}: no checkpoint at boundary {start}"));
        let r = build_chunk(&self.layout, &self.gm, &self.physics, &self.bases, self.t0, k, cp);
        self.built += 1;
        if let Some(f) = self.on_built.as_mut() {
            f(k);
        }
        r
    }

    /// extendTo(k).
    pub fn extend_to(&mut self, k: i64, chunks: &mut HashMap<i64, Vec<f64>>) {
        let dir: i64 = if k >= 0 { 1 } else { -1 };
        let start_of = |j: i64| if dir > 0 { j } else { j + 1 };
        let mut j = k;
        while !self.cps.contains_key(&start_of(j)) {
            j -= dir;
        }
        while if dir > 0 { j <= k } else { j >= k } {
            if !(chunks.contains_key(&j) && self.cps.contains_key(&start_of(j + dir))) {
                let (coeffs, end) = self.build(j);
                chunks.entry(j).or_insert(coeffs);
                self.add_checkpoint(end);
            }
            j += dir;
        }
    }
}

/// Decoded checkpoint asset (checkpoint-asset.ts decodeCheckpointAsset).
pub struct CheckpointAsset {
    pub version: String,
    pub bodies: Vec<String>,
    pub h: f64,
    pub chunk_steps: f64,
    pub t0: f64,
    pub first: i64,
    pub checkpoints: Vec<Checkpoint>,
}

pub fn decode_checkpoint_asset(bytes: &[u8]) -> Result<CheckpointAsset, String> {
    if bytes.len() < 12 || &bytes[0..8] != b"SNDCKPT1" {
        return Err("checkpoint asset: bad magic (not a checkpoint file)".into());
    }
    let l = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if bytes.len() < 12 + l {
        return Err("checkpoint asset: truncated header".into());
    }
    let header = std::str::from_utf8(&bytes[12..12 + l]).map_err(|_| "checkpoint asset: header is not UTF-8".to_string())?;
    let j = crate::json::parse(header).map_err(|e| format!("checkpoint asset header: {e}"))?;
    let num = |k: &str| j.get(k).and_then(|v| v.as_f64()).ok_or_else(|| format!("checkpoint asset header: no {k}"));
    let version = j.get("version").and_then(|v| v.as_str()).ok_or("checkpoint asset header: no version")?.to_string();
    let bodies: Vec<String> = j.get("bodies").and_then(|v| v.as_array()).ok_or("checkpoint asset header: no bodies")?.iter().map(|b| b.as_str().unwrap_or("").to_string()).collect();
    let first = num("first")? as i64;
    let count = num("count")? as usize;
    let data_off = (12 + l).div_ceil(8) * 8;
    let m = 12 * bodies.len();
    if bytes.len() != data_off + count * m * 8 {
        return Err("checkpoint asset: truncated or wrong length".into());
    }
    let mut checkpoints = Vec::with_capacity(count);
    for i in 0..count {
        let o = data_off + i * m * 8;
        let data = crate::fixture::f64s_le(&bytes[o..o + m * 8]);
        checkpoints.push(Checkpoint { boundary: first + i as i64, data });
    }
    Ok(CheckpointAsset { version, bodies, h: num("h")?, chunk_steps: num("chunkSteps")?, t0: num("t0")?, first, checkpoints })
}
