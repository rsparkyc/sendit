//! Port of src/physics/nbody.ts: the fixed-step Kahan-Li 8th-order symmetric
//! composition for the massive bodies, with Kahan-compensated q and v, the
//! zonal / harmonic pair forces with their reactions (poles from PoleTables,
//! body frames for tesseral terms), the stage-time construction
//! `(t0 + n h) + c_i h`, and the Sun's 1PN term through the generalised
//! Stormer-Verlet base method (implicit half-kick, fixed iteration count).
//! Every expression is the TypeScript's, in its order.

use crate::gravity::{HarmonicField, TesseralTerm, ZonalSeries};
use crate::orientation::{BodyFrame, IauRotation, PoleTable, PrimeMeridianKind, POLE_NODE_SPACING};

pub const C_LIGHT: f64 = 299792458.0;
const C2: f64 = C_LIGHT * C_LIGHT;
pub const PN_ITERATIONS: usize = 2;

const A_HALF: [f64; 9] = [
    0.13020248308889008087881763,
    0.56116298177510838456196441,
    -0.3894749626448472864080786,
    0.15884190655515560089621075,
    -0.39590389413323757733623154,
    0.18453964097831570709183254,
    0.25837438768632204729397911,
    0.29501172360931029887096624,
    -0.60550853383003451169892108,
];

/// A splitting scheme: drift weights a[0..s-1] and kick weights b[0..s].
#[derive(Clone, Debug)]
pub struct Scheme {
    pub a: Vec<f64>,
    pub b: Vec<f64>,
}

/// KAHAN_LI_8 (buildCoefficients).
pub fn kahan_li_8() -> Scheme {
    let mut w: Vec<f64> = A_HALF.to_vec();
    for i in (0..8).rev() {
        w.push(A_HALF[i]);
    }
    let n = w.len();
    let mut b = vec![0.0; n + 1];
    b[0] = w[0] / 2.0;
    for i in 1..n {
        b[i] = (w[i - 1] + w[i]) / 2.0;
    }
    b[n] = w[n - 1] / 2.0;
    Scheme { a: w, b }
}

/// ZonalHarmonic of nbody.ts.
#[derive(Clone, Debug)]
pub struct ZonalTerm {
    pub body: usize,
    pub j2: f64,
    pub j4: Option<f64>,
    pub jn: Option<Vec<f64>>,
    pub tesseral: Option<Vec<TesseralTerm>>,
    pub prime_meridian: PrimeMeridianKind,
    pub radius: f64,
    pub pole: [f64; 3],
    pub rotation: Option<IauRotation>,
    /// Pole table node spacing (POLE_NODE_SPACING when the TypeScript leaves it out).
    pub pole_spacing: f64,
    pub targets: Vec<usize>,
}

#[derive(Clone, Debug, Default)]
pub struct Physics {
    pub zonal: Vec<ZonalTerm>,
    /// Index of the Sun for its 1PN term.
    pub relativity: Option<usize>,
}

enum Field {
    /// Closed J2 (and J4) form.
    Closed,
    Zonal(ZonalSeries),
    Full(HarmonicField),
}

fn field_of(z: &ZonalTerm) -> Field {
    if z.jn.is_none() && z.tesseral.is_none() {
        return Field::Closed;
    }
    let tess: Vec<TesseralTerm> = z.tesseral.clone().unwrap_or_default().into_iter().filter(|r| r.2 != 0.0 || r.3 != 0.0).collect();
    let jn = z.jn.clone().unwrap_or_else(|| vec![z.j2]);
    if !tess.is_empty() {
        assert!(z.rotation.is_some(), "zonal term: tesseral terms need a rotation model");
        Field::Full(HarmonicField::new(&jn, &tess, z.radius))
    } else if z.jn.is_some() {
        Field::Zonal(ZonalSeries::new(&jn, z.radius))
    } else {
        panic!("zonal term with an empty tesseral list and no jn (the TypeScript fails here too)")
    }
}

/// Pairwise Newtonian accelerations (accelerations()).
pub fn accelerations(n: usize, gm: &[f64], q: &[f64], out: &mut [f64]) {
    for o in out.iter_mut().take(3 * n) {
        *o = 0.0;
    }
    for i in 0..n {
        let xi = q[3 * i];
        let yi = q[3 * i + 1];
        let zi = q[3 * i + 2];
        let mut axi = 0.0;
        let mut ayi = 0.0;
        let mut azi = 0.0;
        for j in i + 1..n {
            let dx = q[3 * j] - xi;
            let dy = q[3 * j + 1] - yi;
            let dz = q[3 * j + 2] - zi;
            let d2 = dx * dx + dy * dy + dz * dz;
            let inv3 = 1.0 / (d2 * d2.sqrt());
            let fi = gm[j] * inv3;
            let fj = gm[i] * inv3;
            axi += fi * dx;
            ayi += fi * dy;
            azi += fi * dz;
            out[3 * j] -= fj * dx;
            out[3 * j + 1] -= fj * dy;
            out[3 * j + 2] -= fj * dz;
        }
        out[3 * i] += axi;
        out[3 * i + 1] += ayi;
        out[3 * i + 2] += azi;
    }
}

/// relativisticAccelerations(): overwrites `out`.
pub fn relativistic_accelerations(n: usize, gm: &[f64], sun: usize, q: &[f64], v: &[f64], out: &mut [f64]) {
    for o in out.iter_mut().take(3 * n) {
        *o = 0.0;
    }
    let mu = gm[sun];
    let sx = q[3 * sun];
    let sy = q[3 * sun + 1];
    let sz = q[3 * sun + 2];
    let svx = v[3 * sun];
    let svy = v[3 * sun + 1];
    let svz = v[3 * sun + 2];
    let mut ax = 0.0;
    let mut ay = 0.0;
    let mut az = 0.0;
    for i in 0..n {
        if i == sun {
            continue;
        }
        let rx = q[3 * i] - sx;
        let ry = q[3 * i + 1] - sy;
        let rz = q[3 * i + 2] - sz;
        let vx = v[3 * i] - svx;
        let vy = v[3 * i + 1] - svy;
        let vz = v[3 * i + 2] - svz;
        let r2 = rx * rx + ry * ry + rz * rz;
        let r = r2.sqrt();
        let f = mu / (C2 * r2 * r);
        let cr = f * ((4.0 * mu) / r - (vx * vx + vy * vy + vz * vz));
        let cv = f * 4.0 * (rx * vx + ry * vy + rz * vz);
        let gx = cr * rx + cv * vx;
        let gy = cr * ry + cv * vy;
        let gz = cr * rz + cv * vz;
        out[3 * i] = gx;
        out[3 * i + 1] = gy;
        out[3 * i + 2] = gz;
        let back = gm[i] / mu;
        ax -= back * gx;
        ay -= back * gy;
        az -= back * gz;
    }
    out[3 * sun] = ax;
    out[3 * sun + 1] = ay;
    out[3 * sun + 2] = az;
}

/// addZonalAccelerations(): `poles` (3 per term) when any term has a time-dependent pole, `frames` (9 per term) for tesseral terms.
fn add_zonal_accelerations(gm: &[f64], q: &[f64], zonal: &[ZonalTerm], fields: &mut [Field], out: &mut [f64], poles: Option<&[f64]>, frames: Option<&[f64]>) {
    let mut acc = [0.0f64; 3];
    for (z, zt) in zonal.iter().enumerate() {
        let e = zt.body;
        let (px, py, pz) = match poles {
            Some(p) => (p[3 * z], p[3 * z + 1], p[3 * z + 2]),
            None => (zt.pole[0], zt.pole[1], zt.pole[2]),
        };
        match &mut fields[z] {
            Field::Closed => {}
            f => {
                for &o in &zt.targets {
                    let x = q[3 * o] - q[3 * e];
                    let y = q[3 * o + 1] - q[3 * e + 1];
                    let zz = q[3 * o + 2] - q[3 * e + 2];
                    acc[0] = 0.0;
                    acc[1] = 0.0;
                    acc[2] = 0.0;
                    match f {
                        Field::Full(h) => {
                            let fr = frames.expect("addZonalAccelerations: a tesseral term needs its body frame");
                            h.add_icrf(1.0, x, y, zz, &fr[9 * z..9 * z + 9], &mut acc, 1.0);
                        }
                        Field::Zonal(s) => s.add(1.0, x, y, zz, px, py, pz, &mut acc, 1.0),
                        Field::Closed => unreachable!(),
                    }
                    let ge = gm[e];
                    let go = gm[o];
                    out[3 * o] += ge * acc[0];
                    out[3 * o + 1] += ge * acc[1];
                    out[3 * o + 2] += ge * acc[2];
                    out[3 * e] -= go * acc[0];
                    out[3 * e + 1] -= go * acc[1];
                    out[3 * e + 2] -= go * acc[2];
                }
                continue;
            }
        }
        let r2c = zt.radius * zt.radius;
        let k = 1.5 * zt.j2 * r2c;
        let j4 = zt.j4.unwrap_or(0.0);
        let k4 = 0.125 * j4 * r2c * r2c;
        for &o in &zt.targets {
            let x = q[3 * o] - q[3 * e];
            let y = q[3 * o + 1] - q[3 * e + 1];
            let zz = q[3 * o + 2] - q[3 * e + 2];
            let r2 = x * x + y * y + zz * zz;
            let sp = x * px + y * py + zz * pz;
            let f = -k / (r2 * r2 * r2.sqrt());
            let c1 = 1.0 - (5.0 * sp * sp) / r2;
            let mut gx = c1 * x + 2.0 * sp * px;
            let mut gy = c1 * y + 2.0 * sp * py;
            let mut gz = c1 * zz + 2.0 * sp * pz;
            if j4 != 0.0 {
                let u2 = (sp * sp) / r2;
                let r = r2.sqrt();
                let u = sp / r;
                let g = -k4 / (k * r2);
                let cr = g * (315.0 * u2 * u2 - 210.0 * u2 + 15.0);
                let cp = g * r * u * (140.0 * u2 - 60.0);
                gx += cr * x - cp * px;
                gy += cr * y - cp * py;
                gz += cr * zz - cp * pz;
            }
            let fo = f * gm[e];
            let fe = f * gm[o];
            out[3 * o] += fo * gx;
            out[3 * o + 1] += fo * gy;
            out[3 * o + 2] += fo * gz;
            out[3 * e] -= fe * gx;
            out[3 * e + 1] -= fe * gy;
            out[3 * e + 2] -= fe * gz;
        }
    }
}

/// NBodyIntegrator of nbody.ts.
pub struct NBodyIntegrator {
    pub n: usize,
    pub gm: Vec<f64>,
    pub q: Vec<f64>,
    pub v: Vec<f64>,
    pub acc: Vec<f64>,
    qc: Vec<f64>,
    vc: Vec<f64>,
    pub t0: f64,
    pub h: f64,
    pub steps: f64,
    scheme: Scheme,
    zonal: Vec<ZonalTerm>,
    fields: Vec<Field>,
    sun: Option<usize>,
    apn: Vec<f64>,
    vt: Vec<f64>,
    pole_tables: Vec<Option<PoleTable>>,
    poles: Option<Vec<f64>>,
    body_frames: Vec<Option<BodyFrame>>,
    frames: Option<Vec<f64>>,
    stage_c: Vec<f64>,
}

impl NBodyIntegrator {
    /// `state`: [x,y,z,vx,vy,vz] per body at t0; `h` negative to integrate backward.
    pub fn new(gm: &[f64], state: &[f64], t0: f64, h: f64, scheme: Scheme, physics: &Physics) -> Self {
        let n = gm.len();
        assert_eq!(state.len(), 6 * n, "state must hold 6 numbers per body");
        let mut q = vec![0.0; 3 * n];
        let mut v = vec![0.0; 3 * n];
        for i in 0..n {
            for k in 0..3 {
                q[3 * i + k] = state[6 * i + k];
                v[3 * i + k] = state[6 * i + 3 + k];
            }
        }
        let zonal = physics.zonal.clone();
        let fields: Vec<Field> = zonal.iter().map(field_of).collect();
        let pole_tables: Vec<Option<PoleTable>> = zonal.iter().map(|z| z.rotation.clone().map(|r| PoleTable::new(r, z.pole_spacing))).collect();
        let mut poles = if pole_tables.iter().any(|p| p.is_some()) { Some(vec![0.0; 3 * zonal.len()]) } else { None };
        let body_frames: Vec<Option<BodyFrame>> = zonal
            .iter()
            .zip(fields.iter())
            .map(|(z, f)| match f {
                // The TypeScript's frame shares the term's pole table (same model and spacing: same bits).
                Field::Full(_) => Some(BodyFrame::new(z.rotation.clone().unwrap(), z.prime_meridian, POLE_NODE_SPACING)),
                _ => None,
            })
            .collect();
        for (z, zt) in zonal.iter().enumerate() {
            if body_frames[z].is_some() {
                assert_eq!(zt.pole_spacing, POLE_NODE_SPACING, "a tesseral term's pole table must use the default spacing (as its BodyFrame)");
            }
        }
        let frames = if body_frames.iter().any(|f| f.is_some()) { Some(vec![0.0; 9 * zonal.len()]) } else { None };
        if let Some(p) = poles.as_mut() {
            for (z, zt) in zonal.iter().enumerate() {
                if pole_tables[z].is_none() {
                    p[3 * z..3 * z + 3].copy_from_slice(&zt.pole);
                }
            }
        }
        let mut stage_c = vec![0.0; scheme.a.len()];
        let mut c = 0.0;
        for i in 0..scheme.a.len() {
            c += scheme.a[i];
            stage_c[i] = c;
        }
        let last = stage_c.len() - 1;
        stage_c[last] = 1.0;
        let mut it = NBodyIntegrator {
            n,
            gm: gm.to_vec(),
            q,
            v,
            acc: vec![0.0; 3 * n],
            qc: vec![0.0; 3 * n],
            vc: vec![0.0; 3 * n],
            t0,
            h,
            steps: 0.0,
            scheme,
            zonal,
            fields,
            sun: physics.relativity,
            apn: vec![0.0; 3 * n],
            vt: vec![0.0; 3 * n],
            pole_tables,
            poles,
            body_frames,
            frames,
            stage_c,
        };
        let t = it.t();
        it.forces(t);
        it
    }

    pub fn t(&self) -> f64 {
        self.t0 + self.steps * self.h
    }

    fn forces(&mut self, time: f64) {
        accelerations(self.n, &self.gm, &self.q, &mut self.acc);
        if !self.zonal.is_empty() {
            if let Some(poles) = self.poles.as_mut() {
                for (z, tab) in self.pole_tables.iter_mut().enumerate() {
                    if let Some(tab) = tab {
                        tab.at(time, &mut poles[3 * z..3 * z + 3]);
                    }
                }
            }
            if let Some(frames) = self.frames.as_mut() {
                let poles = self.poles.as_ref().unwrap();
                for (z, f) in self.body_frames.iter_mut().enumerate() {
                    if let Some(f) = f {
                        f.matrix_with_pole(time, poles[3 * z], poles[3 * z + 1], poles[3 * z + 2], &mut frames[9 * z..9 * z + 9]);
                    }
                }
            }
            add_zonal_accelerations(&self.gm, &self.q, &self.zonal, &mut self.fields, &mut self.acc, self.poles.as_deref(), self.frames.as_deref());
        }
    }

    fn stage_time(&self, st: usize) -> f64 {
        if st == self.stage_c.len() - 1 {
            return self.t0 + (self.steps + 1.0) * self.h;
        }
        self.t0 + self.steps * self.h + self.stage_c[st] * self.h
    }

    /// Total acceleration at the current (q, v), including the velocity-dependent part.
    pub fn total_acceleration(&mut self, out: &mut [f64]) {
        out[..3 * self.n].copy_from_slice(&self.acc);
        if let Some(sun) = self.sun {
            relativistic_accelerations(self.n, &self.gm, sun, &self.q, &self.v, &mut self.apn);
            for k in 0..3 * self.n {
                out[k] += self.apn[k];
            }
        }
    }

    pub fn step(&mut self) {
        if self.sun.is_some() {
            self.step_relativistic();
            return;
        }
        let m = 3 * self.n;
        let h = self.h;
        let s = self.scheme.a.len();
        for st in 0..=s {
            let kb = self.scheme.b[st] * h;
            if kb != 0.0 {
                for k in 0..m {
                    let y = kb * self.acc[k] - self.vc[k];
                    let tmp = self.v[k] + y;
                    self.vc[k] = tmp - self.v[k] - y;
                    self.v[k] = tmp;
                }
            }
            if st == s {
                break;
            }
            let ka = self.scheme.a[st] * h;
            for k in 0..m {
                let y = ka * self.v[k] - self.qc[k];
                let tmp = self.q[k] + y;
                self.qc[k] = tmp - self.q[k] - y;
                self.q[k] = tmp;
            }
            let ts = self.stage_time(st);
            self.forces(ts);
        }
        self.steps += 1.0;
    }

    fn kick(&mut self, c: f64) {
        for k in 0..self.v.len() {
            let y = c * (self.acc[k] + self.apn[k]) - self.vc[k];
            let tmp = self.v[k] + y;
            self.vc[k] = tmp - self.v[k] - y;
            self.v[k] = tmp;
        }
    }

    fn step_relativistic(&mut self) {
        let n = self.n;
        let m = 3 * n;
        let h = self.h;
        let sun = self.sun.unwrap();
        for st in 0..self.scheme.a.len() {
            let tau = self.scheme.a[st] * h;
            let half = 0.5 * tau;
            relativistic_accelerations(n, &self.gm, sun, &self.q, &self.v, &mut self.apn);
            for _ in 0..PN_ITERATIONS {
                for k in 0..m {
                    self.vt[k] = self.v[k] + half * (self.acc[k] + self.apn[k]);
                }
                relativistic_accelerations(n, &self.gm, sun, &self.q, &self.vt, &mut self.apn);
            }
            self.kick(half);
            for k in 0..m {
                let y = tau * self.v[k] - self.qc[k];
                let tmp = self.q[k] + y;
                self.qc[k] = tmp - self.q[k] - y;
                self.q[k] = tmp;
            }
            let ts = self.stage_time(st);
            self.forces(ts);
            relativistic_accelerations(n, &self.gm, sun, &self.q, &self.v, &mut self.apn);
            self.kick(half);
        }
        self.steps += 1.0;
    }

    /// [q(3n), v(3n), qc(3n), vc(3n)].
    pub fn export_state(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(12 * self.n);
        out.extend_from_slice(&self.q);
        out.extend_from_slice(&self.v);
        out.extend_from_slice(&self.qc);
        out.extend_from_slice(&self.vc);
        out
    }

    pub fn import_state(&mut self, data: &[f64], steps: f64) {
        let m = 3 * self.n;
        assert_eq!(data.len(), 4 * m, "importState: need {} numbers", 4 * m);
        for k in 0..m {
            self.q[k] = data[k];
            self.v[k] = data[m + k];
            self.qc[k] = data[2 * m + k];
            self.vc[k] = data[3 * m + k];
        }
        self.steps = steps;
        let t = self.t();
        self.forces(t);
    }
}
