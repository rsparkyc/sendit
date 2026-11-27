//! Port of src/physics/orientation.ts (IAU rotation model, PoleTable,
//! BodyFrame) and src/physics/earth-rotation.ts (Delta-T, Earth Rotation Angle).
//! dmath sin/cos and exactly rounded + - * / sqrt floor only.
//!
//! Caches (the pole table's node cache and current interval, the body frame's
//! theta interval) hold values that are pure functions of the node index, as
//! in the TypeScript, so they never change a bit; they only save work.

use crate::dmath::{sincos, DEG};

pub const SECONDS_PER_DAY: f64 = 86400.0;
pub const SECONDS_PER_CENTURY: f64 = 36525.0 * SECONDS_PER_DAY;
pub const DAYS_PER_CENTURY: f64 = 36525.0;
pub const POLE_NODE_SPACING: f64 = SECONDS_PER_DAY;

#[derive(Clone, Debug)]
pub struct Nutation {
    /// angle[0] + angle[1] T + angle[2] T^2 (angle[2] = 0 where the data has none, as `?? 0`).
    pub angle: [f64; 3],
    pub ra: f64,
    pub dec: f64,
    pub pm: f64,
}

/// IAU rotation constants of one body (src/physics/data/iau-rotation.json).
#[derive(Clone, Debug)]
pub struct IauRotation {
    pub id: String,
    pub naif_id: i32,
    pub ra: [f64; 3],
    pub dec: [f64; 3],
    pub pm: [f64; 3],
    pub nut: Vec<Nutation>,
}

#[inline]
fn reduce_deg(x: f64) -> f64 {
    x - 360.0 * (x / 360.0).floor()
}

pub fn pole_is_time_dependent(m: &IauRotation) -> bool {
    if m.ra[1] != 0.0 || m.ra[2] != 0.0 || m.dec[1] != 0.0 || m.dec[2] != 0.0 {
        return true;
    }
    m.nut.iter().any(|n| n.ra != 0.0 || n.dec != 0.0)
}

fn has_periodic_theta(m: &IauRotation) -> bool {
    m.nut.iter().any(|n| n.pm != 0.0 || n.ra != 0.0)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PoleAngles {
    pub ra: f64,
    pub dec: f64,
    pub ra_rate: f64,
    pub dec_rate: f64,
    pub th: f64,
    pub th_rate: f64,
}

pub fn pole_angles(m: &IauRotation, t: f64) -> PoleAngles {
    let tt = t / SECONDS_PER_CENTURY;
    let ra2 = m.ra[2];
    let dec2 = m.dec[2];
    let mut ra = m.ra[0] + m.ra[1] * tt + ra2 * tt * tt;
    let mut dec = m.dec[0] + m.dec[1] * tt + dec2 * tt * tt;
    let mut ra_rate = m.ra[1] + 2.0 * ra2 * tt;
    let mut dec_rate = m.dec[1] + 2.0 * dec2 * tt;
    for n in &m.nut {
        if n.ra == 0.0 && n.dec == 0.0 {
            continue;
        }
        let a2 = n.angle[2];
        let a = reduce_deg(n.angle[0] + n.angle[1] * tt + a2 * tt * tt);
        let rate = (n.angle[1] + 2.0 * a2 * tt) * DEG;
        let (s, c) = sincos(a * DEG);
        ra += n.ra * s;
        dec += n.dec * c;
        ra_rate += n.ra * c * rate;
        dec_rate -= n.dec * s * rate;
    }
    PoleAngles { ra, dec, ra_rate: ra_rate / SECONDS_PER_CENTURY, dec_rate: dec_rate / SECONDS_PER_CENTURY, th: 0.0, th_rate: 0.0 }
}

fn pole_and_theta_angles(m: &IauRotation, t: f64) -> PoleAngles {
    let tt = t / SECONDS_PER_CENTURY;
    let ra2 = m.ra[2];
    let dec2 = m.dec[2];
    let mut ra = m.ra[0] + m.ra[1] * tt + ra2 * tt * tt;
    let mut dec = m.dec[0] + m.dec[1] * tt + dec2 * tt * tt;
    let mut ra_rate = m.ra[1] + 2.0 * ra2 * tt;
    let mut dec_rate = m.dec[1] + 2.0 * dec2 * tt;
    let mut th = 0.0;
    let mut th_rate = 0.0;
    for n in &m.nut {
        let amp = n.pm + n.ra;
        if n.ra == 0.0 && n.dec == 0.0 && amp == 0.0 {
            continue;
        }
        let a2 = n.angle[2];
        let a = reduce_deg(n.angle[0] + n.angle[1] * tt + a2 * tt * tt);
        let rate = (n.angle[1] + 2.0 * a2 * tt) * DEG;
        let (s, c) = sincos(a * DEG);
        if n.ra != 0.0 || n.dec != 0.0 {
            ra += n.ra * s;
            dec += n.dec * c;
            ra_rate += n.ra * c * rate;
            dec_rate -= n.dec * s * rate;
        }
        if amp != 0.0 {
            th += amp * s;
            th_rate += amp * c * rate;
        }
    }
    PoleAngles { ra, dec, ra_rate: ra_rate / SECONDS_PER_CENTURY, dec_rate: dec_rate / SECONDS_PER_CENTURY, th, th_rate: th_rate / SECONDS_PER_CENTURY }
}

fn pole_from_angles(p: &PoleAngles, out: &mut [f64], rate: Option<&mut [f64; 3]>) {
    let (sa, ca) = sincos(reduce_deg(p.ra) * DEG);
    let (sd, cd) = sincos(p.dec * DEG);
    out[0] = cd * ca;
    out[1] = cd * sa;
    out[2] = sd;
    if let Some(rate) = rate {
        let da = p.ra_rate * DEG;
        let dd = p.dec_rate * DEG;
        rate[0] = -sd * ca * dd - cd * sa * da;
        rate[1] = -sd * sa * dd + cd * ca * da;
        rate[2] = cd * dd;
    }
}

/// Exact pole at t into out[0..3]; with `rate`, also its time derivative.
pub fn pole_at(m: &IauRotation, t: f64, out: &mut [f64], rate: Option<&mut [f64; 3]>) {
    pole_from_angles(&pole_angles(m, t), out, rate);
}

pub fn prime_meridian(m: &IauRotation, t: f64) -> f64 {
    let d = t / SECONDS_PER_DAY;
    let tt = t / SECONDS_PER_CENTURY;
    let turns = (m.pm[1] / 360.0).floor();
    let rem = m.pm[1] - 360.0 * turns;
    let nd = turns * d;
    let mut w = m.pm[0] + rem * d + 360.0 * (nd - nd.floor()) + m.pm[2] * d * d;
    for n in &m.nut {
        if n.pm == 0.0 {
            continue;
        }
        let a = reduce_deg(n.angle[0] + n.angle[1] * tt + n.angle[2] * tt * tt);
        let (s, _) = sincos(a * DEG);
        w += n.pm * s;
    }
    reduce_deg(w)
}

pub fn body_to_icrf(m: &IauRotation, t: f64, out: &mut [f64; 9]) {
    let p = pole_angles(m, t);
    let (sa, ca) = sincos(reduce_deg(p.ra + 90.0) * DEG);
    let (sd, cd) = sincos((90.0 - p.dec) * DEG);
    let (sw, cw) = sincos(prime_meridian(m, t) * DEG);
    let a00 = ca;
    let a01 = -sa * cd;
    let a02 = sa * sd;
    let a10 = sa;
    let a11 = ca * cd;
    let a12 = -ca * sd;
    let a21 = sd;
    let a22 = cd;
    out[0] = a00 * cw + a01 * sw;
    out[1] = -a00 * sw + a01 * cw;
    out[2] = a02;
    out[3] = a10 * cw + a11 * sw;
    out[4] = -a10 * sw + a11 * cw;
    out[5] = a12;
    out[6] = a21 * sw;
    out[7] = a21 * cw;
    out[8] = a22;
}

const NODE_CACHE: usize = 1024;

/// The pole of one body as a pure function of time (daily cubic Hermite nodes).
pub struct PoleTable {
    pub model: IauRotation,
    pub spacing: f64,
    pub time_dependent: bool,
    pub theta_periodic: bool,
    k: f64,
    c: [f64; 12],
    ct: [f64; 4],
    node_key: Vec<f64>,
    node_val: Vec<f64>,
}

impl PoleTable {
    pub fn new(model: IauRotation, spacing: f64) -> Self {
        let td = pole_is_time_dependent(&model);
        let tp = td && has_periodic_theta(&model);
        let mut p = PoleTable { spacing, time_dependent: td, theta_periodic: tp, k: f64::NAN, c: [0.0; 12], ct: [0.0; 4], node_key: vec![f64::NAN; NODE_CACHE], node_val: vec![0.0; 8 * NODE_CACHE], model };
        if !td {
            pole_at(&p.model, 0.0, &mut p.c[0..3], None);
            p.k = 0.0;
        }
        p
    }

    fn node(&mut self, k: f64, o: usize) {
        // `k & (NODE_CACHE - 1)` on a JavaScript number: ToInt32 then mask.
        let slot = ((k as i64 as i32) & (NODE_CACHE as i32 - 1)) as usize;
        let b = 8 * slot;
        if self.node_key[slot] != k {
            let t = k * self.spacing;
            let mut tmp = [0.0f64; 3];
            if self.theta_periodic {
                let a = pole_and_theta_angles(&self.model, t);
                pole_from_angles(&a, &mut self.node_val[b..b + 3], Some(&mut tmp));
                self.node_val[b + 6] = a.th;
                self.node_val[b + 7] = self.spacing * a.th_rate;
            } else {
                pole_at(&self.model, t, &mut self.node_val[b..b + 3], Some(&mut tmp));
            }
            self.node_val[b + 3] = self.spacing * tmp[0];
            self.node_val[b + 4] = self.spacing * tmp[1];
            self.node_val[b + 5] = self.spacing * tmp[2];
            self.node_key[slot] = k;
        }
        self.c[o..o + 6].copy_from_slice(&self.node_val[b..b + 6]);
        self.ct[o / 3] = self.node_val[b + 6];
        self.ct[o / 3 + 1] = self.node_val[b + 7];
    }

    fn load(&mut self, k: f64) {
        if k != self.k {
            if k == self.k + 1.0 {
                for i in 0..6 {
                    self.c[i] = self.c[6 + i];
                }
                self.ct[0] = self.ct[2];
                self.ct[1] = self.ct[3];
                self.node(k + 1.0, 6);
            } else if k == self.k - 1.0 {
                for i in 0..6 {
                    self.c[6 + i] = self.c[i];
                }
                self.ct[2] = self.ct[0];
                self.ct[3] = self.ct[1];
                self.node(k, 0);
            } else {
                self.node(k, 0);
                self.node(k + 1.0, 6);
            }
            self.k = k;
        }
    }

    pub fn theta_periodic_at(&mut self, t: f64) -> f64 {
        let k = (t / self.spacing).floor();
        self.load(k);
        let s = (t - k * self.spacing) / self.spacing;
        let s1 = 1.0 - s;
        let ct = &self.ct;
        (1.0 + 2.0 * s) * s1 * s1 * ct[0] + s * s1 * s1 * ct[1] + s * s * (3.0 - 2.0 * s) * ct[2] - s * s * s1 * ct[3]
    }

    pub fn at(&mut self, t: f64, out: &mut [f64]) {
        if !self.time_dependent {
            out[0] = self.c[0];
            out[1] = self.c[1];
            out[2] = self.c[2];
            return;
        }
        if self.spacing == 0.0 {
            pole_at(&self.model, t, out, None);
            return;
        }
        let k = (t / self.spacing).floor();
        self.load(k);
        let s = (t - k * self.spacing) / self.spacing;
        let s1 = 1.0 - s;
        self.combine((1.0 + 2.0 * s) * s1 * s1, s * s1 * s1, s * s * (3.0 - 2.0 * s), -s * s * s1, out);
    }

    #[inline]
    fn combine(&self, h00: f64, h10: f64, h01: f64, h11: f64, out: &mut [f64]) {
        let c = &self.c;
        let x = h00 * c[0] + h10 * c[3] + h01 * c[6] + h11 * c[9];
        let y = h00 * c[1] + h10 * c[4] + h01 * c[7] + h11 * c[10];
        let z = h00 * c[2] + h10 * c[5] + h01 * c[8] + h11 * c[11];
        let inv = 1.0 / (x * x + y * y + z * z).sqrt();
        out[0] = x * inv;
        out[1] = y * inv;
        out[2] = z * inv;
    }
}

/// polesAt: several tables at one t, the Hermite basis computed once per spacing.
pub fn poles_at(tables: &mut [PoleTable], t: f64, out: &mut [f64], offsets: &[usize]) {
    let mut k = f64::NAN;
    let (mut h00, mut h10, mut h01, mut h11) = (0.0, 0.0, 0.0, 0.0);
    let mut sp = f64::NAN;
    for (i, tab) in tables.iter_mut().enumerate() {
        let o = offsets[i];
        if !tab.time_dependent || tab.spacing == 0.0 {
            tab.at(t, &mut out[o..o + 3]);
            continue;
        }
        if tab.spacing != sp {
            sp = tab.spacing;
            k = (t / sp).floor();
            let s = (t - k * sp) / sp;
            let s1 = 1.0 - s;
            h00 = (1.0 + 2.0 * s) * s1 * s1;
            h10 = s * s1 * s1;
            h01 = s * s * (3.0 - 2.0 * s);
            h11 = -s * s * s1;
        }
        tab.load(k);
        tab.combine(h00, h10, h01, h11, &mut out[o..o + 3]);
    }
}

struct SecularTheta {
    ra0: f64,
    ra1: f64,
    ra2: f64,
    pm0: f64,
    turns: f64,
    rem: f64,
    pm2: f64,
}
impl SecularTheta {
    fn new(m: &IauRotation) -> Self {
        let turns = (m.pm[1] / 360.0).floor();
        SecularTheta { ra0: m.ra[0], ra1: m.ra[1], ra2: m.ra[2], pm0: m.pm[0], turns, rem: m.pm[1] - 360.0 * turns, pm2: m.pm[2] }
    }
    #[inline]
    fn at(&self, t: f64) -> f64 {
        let d = t / SECONDS_PER_DAY;
        let tt = t / SECONDS_PER_CENTURY;
        let nd = self.turns * d;
        let ra = self.ra0 + self.ra1 * tt + self.ra2 * tt * tt;
        90.0 + ra + (self.pm0 + self.rem * d + 360.0 * (nd - nd.floor()) + self.pm2 * d * d)
    }
    #[inline]
    fn ra_part(&self, t: f64) -> f64 {
        let tt = t / SECONDS_PER_CENTURY;
        90.0 + (self.ra0 + self.ra1 * tt + self.ra2 * tt * tt)
    }
}

fn periodic_theta(m: &IauRotation, t: f64) -> (f64, f64) {
    let tt = t / SECONDS_PER_CENTURY;
    let mut w = 0.0;
    let mut rate = 0.0;
    for n in &m.nut {
        let amp = n.pm + n.ra;
        if amp == 0.0 {
            continue;
        }
        let a2 = n.angle[2];
        let a = reduce_deg(n.angle[0] + n.angle[1] * tt + a2 * tt * tt);
        let (s, c) = sincos(a * DEG);
        w += amp * s;
        rate += amp * c * (n.angle[1] + 2.0 * a2 * tt) * DEG;
    }
    (w, rate / SECONDS_PER_CENTURY)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrimeMeridianKind {
    Iau,
    EarthRotationAngle,
}

/// The body-fixed frame of one body as a pure function of time.
pub struct BodyFrame {
    pub model: IauRotation,
    pub pole_table: PoleTable,
    era: bool,
    periodic: bool,
    spacing: f64,
    k: f64,
    c: [f64; 4],
    sec: SecularTheta,
}

impl BodyFrame {
    /// `spacing` is the BodyFrame's (and its own pole table's) node spacing.
    pub fn new(model: IauRotation, kind: PrimeMeridianKind, spacing: f64) -> Self {
        let era = kind == PrimeMeridianKind::EarthRotationAngle;
        assert!(!(era && has_periodic_theta(&model)), "BodyFrame: a custom prime meridian with periodic pole terms is not supported");
        let periodic = !era && has_periodic_theta(&model);
        BodyFrame { sec: SecularTheta::new(&model), pole_table: PoleTable::new(model.clone(), spacing), era, periodic, spacing, k: f64::NAN, c: [0.0; 4], model }
    }

    pub fn theta(&mut self, t: f64) -> f64 {
        if self.era {
            return self.sec.ra_part(t) + earth_prime_meridian_deg(t);
        }
        let sec = self.sec.at(t);
        if !self.periodic {
            return sec;
        }
        if self.spacing == 0.0 {
            return sec + periodic_theta(&self.model, t).0;
        }
        if self.pole_table.theta_periodic && self.pole_table.spacing == self.spacing {
            return sec + self.pole_table.theta_periodic_at(t);
        }
        let sp = self.spacing;
        let k = (t / sp).floor();
        if k != self.k {
            let a = periodic_theta(&self.model, k * sp);
            let b = periodic_theta(&self.model, (k + 1.0) * sp);
            self.c = [a.0, sp * a.1, b.0, sp * b.1];
            self.k = k;
        }
        let c = &self.c;
        let s = (t - k * sp) / sp;
        let s1 = 1.0 - s;
        sec + ((1.0 + 2.0 * s) * s1 * s1 * c[0] + s * s1 * s1 * c[1] + s * s * (3.0 - 2.0 * s) * c[2] - s * s * s1 * c[3])
    }

    /// Body-fixed -> ICRF (row-major) at t given the unit pole at t.
    pub fn matrix_with_pole(&mut self, t: f64, px: f64, py: f64, pz: f64, out: &mut [f64]) {
        let (st, ct) = sincos(reduce_deg(self.theta(t)) * DEG);
        let f = 1.0 / (1.0 + pz);
        let q00 = 1.0 - f * px * px;
        let q01 = -f * px * py;
        let q11 = 1.0 - f * py * py;
        out[0] = q00 * ct + q01 * st;
        out[1] = -q00 * st + q01 * ct;
        out[2] = px;
        out[3] = q01 * ct + q11 * st;
        out[4] = -q01 * st + q11 * ct;
        out[5] = py;
        out[6] = -px * ct - py * st;
        out[7] = px * st - py * ct;
        out[8] = pz;
    }

    pub fn at(&mut self, t: f64, out: &mut [f64]) {
        let mut p = [0.0f64; 3];
        self.pole_table.at(t, &mut p);
        self.matrix_with_pole(t, p[0], p[1], p[2], out);
    }
}

// ---------------------------------------------------------------------------
// earth-rotation.ts

const DT_Y: [f64; 16] = [1950.0, 1955.0, 1960.0, 1965.0, 1970.0, 1975.0, 1980.0, 1985.0, 1990.0, 1995.0, 2000.0, 2005.0, 2010.0, 2015.0, 2020.0, 2025.0];
const DT_V: [f64; 16] = [29.15, 31.07, 33.15, 35.73, 40.18, 45.48, 50.54, 54.34, 56.86, 60.78, 63.83, 64.69, 66.07, 67.64, 69.36, 69.1];
const DT_STEP: f64 = 5.0; // DT_Y[1] - DT_Y[0]

/// TT - UT1 (s) at TDB t: piecewise linear in the table, flat outside.
pub fn delta_t(t: f64) -> f64 {
    let y = 2000.0 + (t + 43200.0) / (365.25 * SECONDS_PER_DAY);
    if y <= DT_Y[0] {
        return DT_V[0];
    }
    let n = DT_Y.len();
    if y >= DT_Y[n - 1] {
        return DT_V[n - 1];
    }
    let mut i = ((y - DT_Y[0]) / DT_STEP).floor();
    if i > (n - 2) as f64 {
        i = (n - 2) as f64;
    }
    let mut i = i as usize;
    while i > 0 && DT_Y[i] > y {
        i -= 1;
    }
    while DT_Y[i + 1] <= y {
        i += 1;
    }
    let y0 = DT_Y[i];
    let v0 = DT_V[i];
    v0 + ((DT_V[i + 1] - v0) * (y - y0)) / (DT_Y[i + 1] - y0)
}

const E_WDOT: f64 = 360.9856122880876;
const E_W0: f64 = 190.46061837504;
/// -IAU_EARTH.ra[1] (pck00011: ra[1] = -0.641 deg/century).
const E_W1: f64 = 0.641;

/// Earth's prime meridian W (degrees, [0, 360)) at TDB t: the ERA model.
pub fn earth_prime_meridian_deg(t: f64) -> f64 {
    let e_n = (E_WDOT / 360.0).floor();
    let e_rem = E_WDOT - 360.0 * e_n;
    let d = (t - delta_t(t)) / SECONDS_PER_DAY;
    let nd = e_n * d;
    let mut w = E_W0 + e_rem * d + 360.0 * (nd - nd.floor());
    w += (E_W1 * t) / (SECONDS_PER_DAY * DAYS_PER_CENTURY);
    w - 360.0 * (w / 360.0).floor()
}

/// RotationModel.primeMeridianDeg for the two Earth models of earth-rotation.ts.
pub struct RotationModel {
    pub w0: f64,
    pub w_dot: f64,
    pub w1: Option<f64>,
    pub delta_t: bool,
}
impl RotationModel {
    pub fn earth() -> Self {
        RotationModel { w0: E_W0, w_dot: E_WDOT, w1: Some(E_W1), delta_t: true }
    }
    pub fn earth_iau(earth: &IauRotation) -> Self {
        RotationModel { w0: earth.pm[0], w_dot: earth.pm[1], w1: None, delta_t: false }
    }
    pub fn prime_meridian_deg(&self, t: f64) -> f64 {
        let tr = if self.delta_t { t - delta_t(t) } else { t };
        let d = tr / SECONDS_PER_DAY;
        let n = (self.w_dot / 360.0).floor();
        let rem = self.w_dot - 360.0 * n;
        let nd = n * d;
        let mut w = self.w0 + rem * d + 360.0 * (nd - nd.floor());
        if let Some(w1) = self.w1 {
            w += (w1 * t) / (SECONDS_PER_DAY * DAYS_PER_CENTURY);
        }
        w - 360.0 * (w / 360.0).floor()
    }
}
