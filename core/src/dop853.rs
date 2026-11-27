//! Dormand-Prince 8(5,3) with dense output: port of src/physics/dop853.ts.
//!
//! Same stage storage scheme (16 stage vectors with a slot permutation for
//! FSAL), same sparse coefficient sums in ascending index order starting from
//! +0, same controller (err^(-1/8) as three nested square roots), same
//! non-finite detection. Errors the TypeScript throws are returned as `DopError`.

use crate::dop853_coefficients as k;

pub const N_STAGES: usize = k::N_STAGES;
pub const N_STAGES_EXTENDED: usize = k::N_STAGES_EXTENDED;
pub const INTERPOLATOR_POWER: usize = k::INTERPOLATOR_POWER;

#[derive(Debug, Clone, PartialEq)]
pub enum DopError {
    NonFiniteState { t: f64, h: f64 },
    NonFiniteErrorNorm { t: f64, h: f64 },
    StepUnderflow { t: f64 },
    TEndNotAfter,
    InterpolateOutside { t: f64 },
    /// Raised by a right-hand side (e.g. an undefined orbital burn frame).
    Rhs(String),
    /// The step callback asked to stop.
    Stopped,
}

/// Right-hand side and error scale of an integration.
pub trait Rhs {
    fn eval(&mut self, t: f64, y: &[f64], out: &mut [f64]);
    fn scale(&self, y: &[f64], y_new: &[f64], scale: &mut [f64]);
    /// A deferred error raised inside `eval` (checked after each step), as a TypeScript throw.
    fn take_error(&mut self) -> Option<String> {
        None
    }
}

struct Sparse {
    idx: Vec<usize>,
    val: Vec<f64>,
}
fn sparse(row: &[f64]) -> Sparse {
    let mut idx = Vec::new();
    let mut val = Vec::new();
    for (i, &v) in row.iter().enumerate() {
        if v != 0.0 {
            idx.push(i);
            val.push(v);
        }
    }
    Sparse { idx, val }
}

struct Tables {
    a: Vec<Sparse>,
    b: Sparse,
    a_extra: Vec<Sparse>,
    d: Vec<Sparse>,
    e_idx: Vec<usize>,
}
fn tables() -> &'static Tables {
    use std::sync::OnceLock;
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| Tables {
        a: k::A.iter().map(|r| sparse(r)).collect(),
        b: sparse(&k::B),
        a_extra: k::A_EXTRA.iter().map(|r| sparse(r)).collect(),
        d: k::D.iter().map(|r| sparse(r)).collect(),
        e_idx: (0..k::E5.len()).filter(|&i| k::E5[i] != 0.0 || k::E3[i] != 0.0).collect(),
    })
}

const SAFETY: f64 = 0.9;
const MIN_FACTOR: f64 = 0.2;
const MAX_FACTOR: f64 = 10.0;

/// componentwiseScale(rtol, atol) of the TypeScript.
pub fn componentwise_scale(rtol: f64, atol: f64, y: &[f64], y_new: &[f64], scale: &mut [f64]) {
    for j in 0..y.len() {
        let a = y[j].abs();
        let b = y_new[j].abs();
        scale[j] = atol + rtol * (if a > b { a } else { b });
    }
}

pub struct Dop853 {
    pub t: f64,
    pub y: Vec<f64>,
    pub h: f64,
    pub accepted: u64,
    pub rejected: u64,
    pub t_previous: f64,
    n: usize,
    kf: Vec<f64>,
    k_slot: [usize; N_STAGES_EXTENDED],
    y_new: Vec<f64>,
    y_tmp: Vec<f64>,
    scale: Vec<f64>,
    last_rejected: bool,
    h_prev: f64,
    y_old: Vec<f64>,
    f: Vec<f64>, // INTERPOLATOR_POWER * n
    s_slot: [usize; N_STAGES_EXTENDED],
    dense_ready: bool,
    tab: &'static Tables,
}

impl Dop853 {
    pub fn new(n: usize) -> Self {
        let mut ks = [0usize; N_STAGES_EXTENDED];
        for (i, s) in ks.iter_mut().enumerate() {
            *s = i;
        }
        Dop853 {
            t: 0.0,
            y: vec![0.0; n],
            h: 0.0,
            accepted: 0,
            rejected: 0,
            t_previous: f64::NAN,
            n,
            kf: vec![0.0; N_STAGES_EXTENDED * n],
            k_slot: ks,
            y_new: vec![0.0; n],
            y_tmp: vec![0.0; n],
            scale: vec![0.0; n],
            last_rejected: false,
            h_prev: 0.0,
            y_old: vec![0.0; n],
            f: vec![0.0; INTERPOLATOR_POWER * n],
            s_slot: ks,
            dense_ready: false,
            tab: tables(),
        }
    }

    #[inline]
    fn stage_mut(kf: &mut [f64], slot: usize, n: usize) -> &mut [f64] {
        &mut kf[slot * n..(slot + 1) * n]
    }

    /// Start from a state; `h` > 0 keeps a step size, otherwise the initial-step heuristic.
    pub fn reset<R: Rhs>(&mut self, rhs: &mut R, t: f64, y: &[f64], h: Option<f64>) {
        self.t = t;
        self.y.copy_from_slice(y);
        self.last_rejected = false;
        self.t_previous = f64::NAN;
        let n = self.n;
        rhs.eval(t, &self.y, Self::stage_mut(&mut self.kf, self.k_slot[0], n));
        self.h = match h {
            Some(h) if h > 0.0 => h,
            _ => self.initial_step(rhs),
        };
    }

    pub fn refresh<R: Rhs>(&mut self, rhs: &mut R) {
        self.t_previous = f64::NAN;
        let n = self.n;
        rhs.eval(self.t, &self.y, Self::stage_mut(&mut self.kf, self.k_slot[0], n));
        self.last_rejected = false;
    }

    fn initial_step<R: Rhs>(&mut self, rhs: &mut R) -> f64 {
        let n = self.n;
        rhs.scale(&self.y, &self.y, &mut self.scale);
        let k0 = &self.kf[self.k_slot[0] * n..(self.k_slot[0] + 1) * n];
        let mut d0 = 0.0;
        let mut d1 = 0.0;
        for j in 0..n {
            let a = self.y[j] / self.scale[j];
            let b = k0[j] / self.scale[j];
            d0 += a * a;
            d1 += b * b;
        }
        d0 = (d0 / n as f64).sqrt();
        d1 = (d1 / n as f64).sqrt();
        if d0 < 1e-5 || d1 < 1e-5 { 1e-6 } else { (0.01 * d0) / d1 }
    }

    fn rk_step<R: Rhs>(&mut self, rhs: &mut R, h: f64) -> Result<(), DopError> {
        let n = self.n;
        let t = self.t;
        let tab = self.tab;
        let mut nan = 0.0f64;
        for s in 1..N_STAGES {
            let sp = &tab.a[s];
            for j in 0..n {
                let mut sum = 0.0;
                for q in 0..sp.idx.len() {
                    sum += sp.val[q] * self.kf[self.k_slot[sp.idx[q]] * n + j];
                }
                let v = self.y[j] + h * sum;
                nan += 0.0 * v;
                self.y_tmp[j] = v;
            }
            let slot = self.k_slot[s];
            rhs.eval(t + k::C[s] * h, &self.y_tmp, Self::stage_mut(&mut self.kf, slot, n));
        }
        {
            let sp = &tab.b;
            for j in 0..n {
                let mut sum = 0.0;
                for q in 0..sp.idx.len() {
                    sum += sp.val[q] * self.kf[self.k_slot[sp.idx[q]] * n + j];
                }
                let v = self.y[j] + h * sum;
                nan += 0.0 * v;
                self.y_new[j] = v;
            }
        }
        if nan != 0.0 || nan != nan {
            return Err(DopError::NonFiniteState { t, h });
        }
        let slot = self.k_slot[N_STAGES];
        rhs.eval(t + h, &self.y_new, Self::stage_mut(&mut self.kf, slot, n));
        Ok(())
    }

    fn error_norm<R: Rhs>(&mut self, rhs: &mut R, h: f64) -> f64 {
        let n = self.n;
        rhs.scale(&self.y, &self.y_new, &mut self.scale);
        let mut e5 = 0.0;
        let mut e3 = 0.0;
        let e_idx = &self.tab.e_idx;
        for j in 0..n {
            let mut s5 = 0.0;
            let mut s3 = 0.0;
            for &i in e_idx.iter() {
                let kv = self.kf[self.k_slot[i] * n + j];
                if k::E5[i] != 0.0 {
                    s5 += k::E5[i] * kv;
                }
                if k::E3[i] != 0.0 {
                    s3 += k::E3[i] * kv;
                }
            }
            s5 /= self.scale[j];
            s3 /= self.scale[j];
            e5 += s5 * s5;
            e3 += s3 * s3;
        }
        if e5 == 0.0 && e3 == 0.0 {
            return 0.0;
        }
        let denom = e5 + 0.01 * e3;
        (h.abs() * e5) / (denom * n as f64).sqrt()
    }

    fn accept(&mut self, t_new: f64, h: f64) {
        self.y_old.copy_from_slice(&self.y);
        self.t_previous = self.t;
        self.h_prev = h;
        self.dense_ready = false;
        self.t = t_new;
        self.y.copy_from_slice(&self.y_new);
        self.k_slot.swap(0, N_STAGES);
        self.accepted += 1;
    }

    /// One error-controlled step, landing exactly on t_end if within reach.
    pub fn step<R: Rhs>(&mut self, rhs: &mut R, t_end: f64) -> Result<(), DopError> {
        if !(t_end > self.t) {
            return Err(DopError::TEndNotAfter);
        }
        let proposed = self.h;
        let mut h = proposed;
        let mut rejected_this_step = false;
        loop {
            let mut clipped = false;
            if self.t + h >= t_end {
                h = t_end - self.t;
                clipped = true;
            }
            if self.t + h == self.t {
                return Err(DopError::StepUnderflow { t: self.t });
            }
            let r = self.rk_step(rhs, h);
            // A right-hand-side error is what the TypeScript would have thrown first.
            if let Some(e) = rhs.take_error() {
                return Err(DopError::Rhs(e));
            }
            r?;
            let err = self.error_norm(rhs, h);
            if !(err >= 0.0 && err < f64::INFINITY) {
                return Err(DopError::NonFiniteErrorNorm { t: self.t, h });
            }
            if err < 1.0 {
                let mut factor = if err == 0.0 { MAX_FACTOR } else { SAFETY / err.sqrt().sqrt().sqrt() };
                if factor > MAX_FACTOR {
                    factor = MAX_FACTOR;
                }
                if self.last_rejected && factor > 1.0 {
                    factor = 1.0;
                }
                self.last_rejected = false;
                let mut h_next = h * factor;
                if clipped && !rejected_this_step && h_next < proposed {
                    h_next = proposed;
                }
                self.accept(if clipped { t_end } else { self.t + h }, h);
                self.h = h_next;
                return Ok(());
            }
            let mut factor = SAFETY / err.sqrt().sqrt().sqrt();
            if factor < MIN_FACTOR {
                factor = MIN_FACTOR;
            }
            h *= factor;
            rejected_this_step = true;
            self.last_rejected = true;
            self.rejected += 1;
        }
    }

    /// Dense output inside the last accepted step [t_previous, t].
    pub fn interpolate<R: Rhs>(&mut self, rhs: &mut R, t: f64, out: &mut [f64]) -> Result<(), DopError> {
        let t0 = self.t_previous;
        if !(t >= t0 && t <= self.t) {
            return Err(DopError::InterpolateOutside { t });
        }
        if t == self.t {
            out.copy_from_slice(&self.y);
            return Ok(());
        }
        if t == t0 {
            out.copy_from_slice(&self.y_old);
            return Ok(());
        }
        if !self.dense_ready {
            self.prepare_dense(rhs);
            if let Some(e) = rhs.take_error() {
                return Err(DopError::Rhs(e));
            }
        }
        let n = self.n;
        let x = (t - t0) / self.h_prev;
        let x1 = 1.0 - x;
        for j in 0..n {
            let mut v = 0.0;
            let mut i = INTERPOLATOR_POWER;
            while i > 0 {
                i -= 1;
                v += self.f[i * n + j];
                v *= if (INTERPOLATOR_POWER - 1 - i) % 2 == 0 { x } else { x1 };
            }
            out[j] = v + self.y_old[j];
        }
        Ok(())
    }

    fn prepare_dense<R: Rhs>(&mut self, rhs: &mut R) {
        let n = self.n;
        let h = self.h_prev;
        let t0 = self.t_previous;
        let tab = self.tab;
        self.s_slot[0] = self.k_slot[N_STAGES];
        self.s_slot[N_STAGES] = self.k_slot[0];
        for i in 1..N_STAGES {
            self.s_slot[i] = self.k_slot[i];
        }
        for s in N_STAGES + 1..N_STAGES_EXTENDED {
            self.s_slot[s] = self.k_slot[s];
            let sp = &tab.a_extra[s - N_STAGES - 1];
            for j in 0..n {
                let mut sum = 0.0;
                for q in 0..sp.idx.len() {
                    sum += sp.val[q] * self.kf[self.s_slot[sp.idx[q]] * n + j];
                }
                self.y_tmp[j] = self.y_old[j] + h * sum;
            }
            let slot = self.s_slot[s];
            rhs.eval(t0 + k::C_EXTRA[s - N_STAGES - 1] * h, &self.y_tmp, Self::stage_mut(&mut self.kf, slot, n));
        }
        let fo = self.s_slot[0] * n;
        let fn_ = self.s_slot[N_STAGES] * n;
        for j in 0..n {
            let dy = self.y[j] - self.y_old[j];
            let f_old = self.kf[fo + j];
            let f_new = self.kf[fn_ + j];
            self.f[j] = dy;
            self.f[n + j] = h * f_old - dy;
            self.f[2 * n + j] = 2.0 * dy - h * (f_new + f_old);
            for r in 0..4 {
                let sp = &tab.d[r];
                let mut sum = 0.0;
                for q in 0..sp.idx.len() {
                    sum += sp.val[q] * self.kf[self.s_slot[sp.idx[q]] * n + j];
                }
                self.f[(3 + r) * n + j] = h * sum;
            }
        }
        self.dense_ready = true;
    }

    /// One step of exactly h with no error control.
    pub fn step_fixed<R: Rhs>(&mut self, rhs: &mut R, h: f64) -> Result<(), DopError> {
        self.rk_step(rhs, h)?;
        self.accept(self.t + h, h);
        Ok(())
    }
}
