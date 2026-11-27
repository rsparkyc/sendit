//! Spacecraft dynamics and `propagate`: port of src/physics/spacecraft.ts.
//!
//! Forces: point masses, J2 in closed form, the terms above J2 (closed J4,
//! zonal series, or the full field in the body-fixed frame) times the taper,
//! the Sun's 1PN term, finite burns in the inertial or orbital frame. The
//! integrator stops exactly on every ignition, cutoff and depletion time.

use crate::dop853::{Dop853, DopError, Rhs};
use crate::gravity::{HarmonicField, TesseralTerm, ZonalSeries};
use crate::orientation::{poles_at, BodyFrame, IauRotation, PoleTable, PrimeMeridianKind, POLE_NODE_SPACING};

pub const G0: f64 = 9.80665;
pub const STATE_SIZE: usize = 7;
const C_LIGHT: f64 = 299792458.0;
const C2: f64 = C_LIGHT * C_LIGHT;

/// Massive-body positions as a function of time.
pub trait Ephemeris {
    fn count(&self) -> usize;
    fn gm(&self) -> &[f64];
    fn positions(&mut self, t: f64, out: &mut [f64]);
    fn body_state(&mut self, body: usize, t: f64, out: &mut [f64]);
}

impl Ephemeris for crate::cheb::ChebEphemeris {
    fn count(&self) -> usize {
        self.layout.count
    }
    fn gm(&self) -> &[f64] {
        &self.gm
    }
    #[inline]
    fn positions(&mut self, t: f64, out: &mut [f64]) {
        crate::cheb::ChebEphemeris::positions(self, t, out)
    }
    #[inline]
    fn body_state(&mut self, body: usize, t: f64, out: &mut [f64]) {
        crate::cheb::ChebEphemeris::body_state(self, body, t, out)
    }
}

/// Bodies that never move (FixedBodies).
pub struct FixedBodies {
    pub gm: Vec<f64>,
    pub pos: Vec<f64>,
}
impl Ephemeris for FixedBodies {
    fn count(&self) -> usize {
        self.gm.len()
    }
    fn gm(&self) -> &[f64] {
        &self.gm
    }
    fn positions(&mut self, _t: f64, out: &mut [f64]) {
        out.copy_from_slice(&self.pos);
    }
    fn body_state(&mut self, body: usize, _t: f64, out: &mut [f64]) {
        out[0] = self.pos[3 * body];
        out[1] = self.pos[3 * body + 1];
        out[2] = self.pos[3 * body + 2];
        out[3] = 0.0;
        out[4] = 0.0;
        out[5] = 0.0;
    }
}

/// BodyOblateness of the TypeScript.
#[derive(Clone, Debug)]
pub struct BodyField {
    pub j2: f64,
    pub j4: Option<f64>,
    pub jn: Option<Vec<f64>>,
    pub tesseral: Vec<TesseralTerm>,
    pub prime_meridian: PrimeMeridianKind,
    pub taper: Option<(f64, f64)>,
    pub radius: f64,
    pub pole: [f64; 3],
    pub rotation: Option<IauRotation>,
}

fn zonal_coefficients(ob: &BodyField) -> Vec<f64> {
    if let Some(jn) = &ob.jn {
        return jn.clone();
    }
    match ob.j4 {
        Some(j4) if j4 != 0.0 => vec![ob.j2, 0.0, j4],
        _ => vec![ob.j2],
    }
}

/// The per-ephemeris force model (what propagate() derives from the ephemeris
/// before integrating), built once and reused by every propagation. Its
/// tables and scratch arrays are caches of pure functions of t.
pub struct ForceModel {
    n_bodies: usize,
    gm: Vec<f64>,
    rel_body: Option<usize>,
    z_body: Vec<usize>,
    z_pole: Vec<f64>,
    z_tabs: Vec<PoleTable>,
    z_tab_off: Vec<usize>,
    z_series: Vec<Option<ZonalSeries>>,
    z_f2: Vec<f64>,
    z_f4: Vec<f64>,
    z_field: Vec<Option<HarmonicField>>,
    z_frame: Vec<Option<BodyFrame>>,
    z_kind: Vec<u8>,
    z_ti2: Vec<f64>,
    z_to2: Vec<f64>,
    z_ti: Vec<f64>,
    z_tw: Vec<f64>,
}

impl ForceModel {
    /// `fields[i]`: body i's field (None: point mass only). `relativity`: the Sun's index.
    pub fn new(gm: &[f64], fields: &[Option<BodyField>], relativity: Option<usize>) -> Self {
        let mut m = ForceModel {
            n_bodies: gm.len(),
            gm: gm.to_vec(),
            rel_body: relativity,
            z_body: vec![], z_pole: vec![], z_tabs: vec![], z_tab_off: vec![], z_series: vec![], z_f2: vec![], z_f4: vec![],
            z_field: vec![], z_frame: vec![], z_kind: vec![], z_ti2: vec![], z_to2: vec![], z_ti: vec![], z_tw: vec![],
        };
        for (i, ob) in fields.iter().enumerate() {
            let Some(ob) = ob else { continue };
            let q = m.z_body.len();
            m.z_body.push(i);
            m.z_pole.extend_from_slice(&ob.pole);
            if let Some(rot) = &ob.rotation {
                m.z_tabs.push(PoleTable::new(rot.clone(), POLE_NODE_SPACING));
                m.z_tab_off.push(3 * q);
            }
            let jn = zonal_coefficients(ob);
            let tess: Vec<TesseralTerm> = ob.tesseral.iter().copied().filter(|r| r.2 != 0.0 || r.3 != 0.0).collect();
            let r2 = ob.radius * ob.radius;
            m.z_f2.push(-1.5 * jn[0] * gm[i] * r2);
            let mut hi = jn.clone();
            hi[0] = 0.0;
            let only_j4 = tess.is_empty() && hi.iter().enumerate().all(|(n, &j)| n == 2 || j == 0.0);
            m.z_f4.push(if only_j4 && hi.len() > 2 { 0.125 * hi[2] * gm[i] * r2 * r2 } else { 0.0 });
            let (ti, to) = match ob.taper {
                Some((a, b)) => {
                    assert!(a >= 0.0 && b > a, "body {i}: taper needs 0 <= inner < outer");
                    (a * ob.radius, b * ob.radius)
                }
                None => (f64::INFINITY, f64::INFINITY),
            };
            m.z_ti.push(ti);
            m.z_ti2.push(ti * ti);
            m.z_to2.push(to * to);
            m.z_tw.push(1.0 / (to - ti));
            if !tess.is_empty() {
                m.z_kind.push(2);
                m.z_series.push(None);
                m.z_field.push(Some(HarmonicField::new(&hi, &tess, ob.radius)));
                let rot = ob.rotation.clone().expect("tesseral terms need a rotation model");
                m.z_frame.push(Some(BodyFrame::new(rot, ob.prime_meridian, POLE_NODE_SPACING)));
            } else {
                let none = hi.iter().all(|&j| j == 0.0);
                m.z_kind.push(if none { 0 } else if only_j4 { 3 } else { 1 });
                m.z_series.push(if none || only_j4 { None } else { Some(ZonalSeries::new(&hi, ob.radius)) });
                m.z_field.push(None);
                m.z_frame.push(None);
            }
        }
        m
    }

    pub fn point_masses(gm: &[f64]) -> Self {
        Self::new(gm, &vec![None; gm.len()], None)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BurnFrame {
    Inertial,
    Orbital { body: usize },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Burn {
    pub t_start: f64,
    pub duration: f64,
    pub thrust: f64,
    pub isp: f64,
    pub direction: [f64; 3],
    pub frame: BurnFrame,
}

#[derive(Debug, Clone)]
pub struct PropagateResult {
    pub t: f64,
    pub y: [f64; 7],
    pub accepted: u64,
    pub rejected: u64,
    pub stopped: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PropagateError {
    InvalidBurn(String),
    Integrator(DopError),
}

/// The right-hand side of one propagation: the force model, the ephemeris and the burn state.
struct Deriv<'a, E: Ephemeris> {
    ephem: &'a mut E,
    fm: &'a mut ForceModel,
    rtol: f64,
    body_pos: Vec<f64>,
    ref_state: [f64; 6],
    sun_state: [f64; 6],
    z_mat: Vec<f64>,
    z_mat_t: Vec<u64>,
    pos_t: u64,
    pole_t: u64,
    sun_t: u64,
    ref_t: u64,
    ref_body: isize,
    active: Option<Burn>,
    active_index: isize,
    ux: f64,
    uy: f64,
    uz: f64,
    error: Option<String>,
}

const NAN_BITS: u64 = 0x7ff8_0000_0000_0001; // never the bits of a time

impl<E: Ephemeris> Rhs for Deriv<'_, E> {
    #[inline]
    fn eval(&mut self, t: f64, y: &[f64], out: &mut [f64]) {
        let x = y[0];
        let yy = y[1];
        let z = y[2];
        let mut ax = 0.0;
        let mut ay = 0.0;
        let mut az = 0.0;
        let tb = t.to_bits();
        if tb != self.pos_t {
            self.ephem.positions(t, &mut self.body_pos);
            self.pos_t = tb;
        }
        let fm = &mut *self.fm;
        let bp = &self.body_pos;
        let gm = &fm.gm;
        for i in 0..fm.n_bodies {
            let dx = bp[3 * i] - x;
            let dy = bp[3 * i + 1] - yy;
            let dz = bp[3 * i + 2] - z;
            let d2 = dx * dx + dy * dy + dz * dz;
            let k = gm[i] / (d2 * d2.sqrt());
            ax += k * dx;
            ay += k * dy;
            az += k * dz;
        }
        if !fm.z_tabs.is_empty() && tb != self.pole_t {
            poles_at(&mut fm.z_tabs, t, &mut fm.z_pole, &fm.z_tab_off);
            self.pole_t = tb;
        }
        let mut field_acc = [0.0f64; 3];
        for q in 0..fm.z_body.len() {
            let i = fm.z_body[q];
            let rx = x - bp[3 * i];
            let ry = yy - bp[3 * i + 1];
            let rz = z - bp[3 * i + 2];
            let px = fm.z_pole[3 * q];
            let py = fm.z_pole[3 * q + 1];
            let pz = fm.z_pole[3 * q + 2];
            let r2 = rx * rx + ry * ry + rz * rz;
            let sp = rx * px + ry * py + rz * pz;
            let f = fm.z_f2[q] / (r2 * r2 * r2.sqrt());
            let c1 = 1.0 - (5.0 * sp * sp) / r2;
            ax += f * (c1 * rx + 2.0 * sp * px);
            ay += f * (c1 * ry + 2.0 * sp * py);
            az += f * (c1 * rz + 2.0 * sp * pz);
            let kind = fm.z_kind[q];
            if kind == 0 || r2 >= fm.z_to2[q] {
                continue;
            }
            let mut w = 1.0;
            if r2 > fm.z_ti2[q] {
                let sx = (r2.sqrt() - fm.z_ti[q]) * fm.z_tw[q];
                w = 1.0 - sx * sx * sx * (10.0 - sx * (15.0 - 6.0 * sx));
            }
            if kind == 3 {
                let r = r2.sqrt();
                let u = sp / r;
                let u2 = u * u;
                let f4 = (w * fm.z_f4[q]) / (r2 * r2 * r2 * r);
                let cr = f4 * (315.0 * u2 * u2 - 210.0 * u2 + 15.0);
                let cp = f4 * r * u * (140.0 * u2 - 60.0);
                ax += cr * rx - cp * px;
                ay += cr * ry - cp * py;
                az += cr * rz - cp * pz;
            } else if kind == 1 {
                fm.z_series[q].as_ref().unwrap().add(gm[i], rx, ry, rz, px, py, pz, &mut field_acc, w);
            } else {
                let mo = 9 * q;
                if self.z_mat_t[q] != tb {
                    fm.z_frame[q].as_mut().unwrap().matrix_with_pole(t, px, py, pz, &mut self.z_mat[mo..mo + 9]);
                    self.z_mat_t[q] = tb;
                }
                fm.z_field[q].as_mut().unwrap().add_icrf(gm[i], rx, ry, rz, &self.z_mat[mo..mo + 9], &mut field_acc, w);
            }
        }
        ax += field_acc[0];
        ay += field_acc[1];
        az += field_acc[2];

        if let Some(rb) = fm.rel_body {
            if tb != self.sun_t {
                self.ephem.body_state(rb, t, &mut self.sun_state);
                self.sun_t = tb;
            }
            let s = &self.sun_state;
            let rx = x - s[0];
            let ry = yy - s[1];
            let rz = z - s[2];
            let vx = y[3] - s[3];
            let vy = y[4] - s[4];
            let vz = y[5] - s[5];
            let mu = fm.gm[rb];
            let r2 = rx * rx + ry * ry + rz * rz;
            let r = r2.sqrt();
            let f = mu / (C2 * r2 * r);
            let cr = f * ((4.0 * mu) / r - (vx * vx + vy * vy + vz * vz));
            let cv = f * 4.0 * (rx * vx + ry * vy + rz * vz);
            ax += cr * rx + cv * vx;
            ay += cr * ry + cv * vy;
            az += cr * rz + cv * vz;
        }

        let mut mdot = 0.0;
        if let Some(active) = &self.active {
            let mut tx = self.ux;
            let mut ty = self.uy;
            let mut tz = self.uz;
            if let BurnFrame::Orbital { body } = active.frame {
                if tb != self.ref_t || self.ref_body != body as isize {
                    self.ephem.body_state(body, t, &mut self.ref_state);
                    self.ref_t = tb;
                    self.ref_body = body as isize;
                }
                let r = &self.ref_state;
                let rx = x - r[0];
                let ry = yy - r[1];
                let rz = z - r[2];
                let vx = y[3] - r[3];
                let vy = y[4] - r[4];
                let vz = y[5] - r[5];
                let v2 = vx * vx + vy * vy + vz * vz;
                if !(v2 > 0.0) {
                    self.error.get_or_insert_with(|| format!("burn {}: orbital frame undefined (zero velocity relative to body {body})", self.active_index));
                }
                let v_inv = 1.0 / v2.sqrt();
                let px = vx * v_inv;
                let py = vy * v_inv;
                let pz = vz * v_inv;
                let mut nx = ry * vz - rz * vy;
                let mut ny = rz * vx - rx * vz;
                let mut nz = rx * vy - ry * vx;
                let n2 = nx * nx + ny * ny + nz * nz;
                if !(n2 > 0.0) {
                    self.error.get_or_insert_with(|| format!("burn {}: orbital frame undefined (velocity parallel to radius from body {body})", self.active_index));
                }
                let n_inv = 1.0 / n2.sqrt();
                nx *= n_inv;
                ny *= n_inv;
                nz *= n_inv;
                let ox = py * nz - pz * ny;
                let oy = pz * nx - px * nz;
                let oz = px * ny - py * nx;
                tx = self.ux * px + self.uy * nx + self.uz * ox;
                ty = self.ux * py + self.uy * ny + self.uz * oy;
                tz = self.ux * pz + self.uy * nz + self.uz * oz;
            }
            let a_thrust = active.thrust / y[6];
            ax += a_thrust * tx;
            ay += a_thrust * ty;
            az += a_thrust * tz;
            mdot = -active.thrust / (active.isp * G0);
        }
        out[0] = y[3];
        out[1] = y[4];
        out[2] = y[5];
        out[3] = ax;
        out[4] = ay;
        out[5] = az;
        out[6] = mdot;
    }

    #[inline]
    fn scale(&self, y: &[f64], y_new: &[f64], scale: &mut [f64]) {
        const ATOL_R: f64 = 1e-3;
        const ATOL_V: f64 = 1e-9;
        const ATOL_M: f64 = 1e-9;
        let rtol = self.rtol;
        let r0 = (y[0] * y[0] + y[1] * y[1] + y[2] * y[2]).sqrt();
        let r1 = (y_new[0] * y_new[0] + y_new[1] * y_new[1] + y_new[2] * y_new[2]).sqrt();
        let v0 = (y[3] * y[3] + y[4] * y[4] + y[5] * y[5]).sqrt();
        let v1 = (y_new[3] * y_new[3] + y_new[4] * y_new[4] + y_new[5] * y_new[5]).sqrt();
        let sr = ATOL_R + rtol * (if r0 > r1 { r0 } else { r1 });
        let sv = ATOL_V + rtol * (if v0 > v1 { v0 } else { v1 });
        scale[0] = sr;
        scale[1] = sr;
        scale[2] = sr;
        scale[3] = sv;
        scale[4] = sv;
        scale[5] = sv;
        scale[6] = ATOL_M + rtol * (if y[6] > y_new[6] { y[6] } else { y_new[6] });
    }

    fn take_error(&mut self) -> Option<String> {
        self.error.take()
    }
}

/// The coast derivative (no burn) at (t, y), as propagate() evaluates it.
pub fn coast_derivative<E: Ephemeris>(ephem: &mut E, fm: &mut ForceModel, t: f64, y: &[f64], out: &mut [f64]) {
    let n = ephem.count();
    let nz = fm.z_body.len();
    let mut rhs = Deriv::new(ephem, fm, 1e-12, n, nz);
    rhs.eval(t, y, out);
}

impl<'a, E: Ephemeris> Deriv<'a, E> {
    fn new(ephem: &'a mut E, fm: &'a mut ForceModel, rtol: f64, n_bodies: usize, nz: usize) -> Self {
        Deriv {
            ephem,
            fm,
            rtol,
            body_pos: vec![0.0; 3 * n_bodies],
            ref_state: [0.0; 6],
            sun_state: [0.0; 6],
            z_mat: vec![0.0; 9 * nz],
            z_mat_t: vec![NAN_BITS; nz],
            pos_t: NAN_BITS,
            pole_t: NAN_BITS,
            sun_t: NAN_BITS,
            ref_t: NAN_BITS,
            ref_body: -1,
            active: None,
            active_index: -1,
            ux: 0.0,
            uy: 0.0,
            uz: 0.0,
            error: None,
        }
    }
}

/// What a step callback sees: the accepted step and dense output inside it.
pub struct StepView<'s, 'a, E: Ephemeris> {
    integ: &'s mut Dop853,
    rhs: &'s mut Deriv<'a, E>,
}
impl<E: Ephemeris> StepView<'_, '_, E> {
    pub fn t(&self) -> f64 {
        self.integ.t
    }
    pub fn t_prev(&self) -> f64 {
        self.integ.t_previous
    }
    pub fn y(&self) -> &[f64] {
        &self.integ.y
    }
    pub fn interpolate(&mut self, t: f64, out: &mut [f64]) -> Result<(), DopError> {
        self.integ.interpolate(self.rhs, t, out)
    }
}

pub struct PropagateOptions {
    pub rtol: f64,
    pub dry_mass: f64,
}
impl Default for PropagateOptions {
    fn default() -> Self {
        PropagateOptions { rtol: 1e-12, dry_mass: 0.0 }
    }
}

fn validate_burns(burns: &[Burn]) -> Result<(), PropagateError> {
    for (i, b) in burns.iter().enumerate() {
        if !(b.duration > 0.0) || !(b.thrust > 0.0) || !(b.isp > 0.0) {
            return Err(PropagateError::InvalidBurn(format!("burn {i}: duration, thrust and isp must be positive")));
        }
        let [dx, dy, dz] = b.direction;
        if dx * dx + dy * dy + dz * dz == 0.0 {
            return Err(PropagateError::InvalidBurn(format!("burn {i}: zero direction")));
        }
        if i > 0 && b.t_start < burns[i - 1].t_start + burns[i - 1].duration {
            return Err(PropagateError::InvalidBurn(format!("burn {i}: burns must be sorted and must not overlap")));
        }
    }
    Ok(())
}

/// Propagate a spacecraft from t0 to t1 through a list of burns. `on_step` is
/// called after every accepted step; returning false stops the propagation.
pub fn propagate<E: Ephemeris>(
    ephem: &mut E,
    fm: &mut ForceModel,
    y0: &[f64],
    t0: f64,
    t1: f64,
    burns: &[Burn],
    opts: &PropagateOptions,
    mut on_step: Option<&mut dyn FnMut(&mut StepView<'_, '_, E>) -> bool>,
) -> Result<PropagateResult, PropagateError> {
    validate_burns(burns)?;
    let n_bodies = ephem.count();
    let nz = fm.z_body.len();
    let dry_mass = opts.dry_mass;
    let mut rhs = Deriv::new(ephem, fm, opts.rtol, n_bodies, nz);
    let err = PropagateError::Integrator;
    let mut integ = Dop853::new(STATE_SIZE);
    integ.reset(&mut rhs, t0, y0, None);
    if let Some(e) = rhs.take_error() {
        return Err(err(DopError::Rhs(e)));
    }
    let mut coast_step = integ.h;
    let mut active: Option<usize> = None;
    let mut i = 0usize;
    while integ.t < t1 {
        let t = integ.t;
        while i < burns.len() && burns[i].t_start + burns[i].duration <= t {
            i += 1;
        }
        let next = burns.get(i);
        let mut seg_end = t1;
        let mut burning: Option<usize> = None;
        let mut runs_dry = false;
        match next {
            Some(nb) if nb.t_start <= t => {
                let propellant = integ.y[6] - dry_mass;
                if propellant <= 0.0 {
                    i += 1;
                    continue;
                }
                let mdot = nb.thrust / (nb.isp * G0);
                let requested_end = nb.t_start + nb.duration;
                let dry_time = t + propellant / mdot;
                burning = Some(i);
                if dry_time < requested_end {
                    if dry_time <= seg_end {
                        seg_end = dry_time;
                        runs_dry = true;
                    }
                } else if requested_end < seg_end {
                    seg_end = requested_end;
                }
            }
            Some(nb) if nb.t_start < seg_end => seg_end = nb.t_start,
            _ => {}
        }
        if burning != active {
            active = burning;
            rhs.active_index = burning.map(|b| b as isize).unwrap_or(-1);
            rhs.active = burning.map(|b| burns[b].clone());
            if let Some(b) = burning {
                let [dx, dy, dz] = burns[b].direction;
                let inv = 1.0 / (dx * dx + dy * dy + dz * dz).sqrt();
                rhs.ux = dx * inv;
                rhs.uy = dy * inv;
                rhs.uz = dz * inv;
                coast_step = integ.h;
                integ.refresh(&mut rhs);
                let span = seg_end - t;
                if integ.h > span / 8.0 {
                    integ.h = span / 8.0;
                }
            } else {
                integ.refresh(&mut rhs);
                integ.h = coast_step;
            }
            if let Some(e) = rhs.take_error() {
                return Err(err(DopError::Rhs(e)));
            }
        }
        // integrateTo(segEnd, onStep)
        while integ.t < seg_end {
            integ.step(&mut rhs, seg_end).map_err(err)?;
            if let Some(cb) = on_step.as_deref_mut() {
                let mut view = StepView { integ: &mut integ, rhs: &mut rhs };
                let go = cb(&mut view);
                if let Some(e) = rhs.take_error() {
                    return Err(err(DopError::Rhs(e)));
                }
                if !go {
                    let mut y = [0.0; 7];
                    y.copy_from_slice(&integ.y);
                    return Ok(PropagateResult { t: integ.t, y, accepted: integ.accepted, rejected: integ.rejected, stopped: true });
                }
            }
        }
        if runs_dry {
            integ.y[6] = dry_mass;
        }
        if let Some(b) = burning {
            if integ.t >= burns[b].t_start + burns[b].duration {
                i += 1;
            } else if runs_dry {
                i += 1;
            }
        } else if runs_dry {
            i += 1;
        }
    }
    let mut y = [0.0; 7];
    y.copy_from_slice(&integ.y);
    Ok(PropagateResult { t: integ.t, y, accepted: integ.accepted, rejected: integ.rejected, stopped: false })
}
