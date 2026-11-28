//! Earth orientation for launch sites and the abstracted launch
//! (src/mission/earth-orientation.ts, src/mission/launch.ts: the replay-path
//! functions; the planning helpers that use Math.* are not ported).
//! Every expression keeps the TypeScript's operation order.

use crate::dmath::{atan2, sincos, DEG};
use crate::mission::jsfmt;
use crate::mission::mdata::{BodyInfo, EarthRotation, LaunchSite, MissionData};
use crate::orientation::{RotationModel, DAYS_PER_CENTURY, SECONDS_PER_DAY};

pub type V3 = [f64; 3];

#[inline]
pub fn cross(a: &V3, b: &V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
pub fn dot(a: &V3, b: &V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
pub fn norm(a: &V3) -> f64 {
    dot(a, a).sqrt()
}
#[inline]
pub fn scale(a: &V3, k: f64) -> V3 {
    [a[0] * k, a[1] * k, a[2] * k]
}

/// earth-orientation.ts with EARTH_ROTATION (the IAU pole, the ERA prime meridian).
pub struct EarthModel {
    pub rot: EarthRotation,
    pm: RotationModel,
    pub a: f64,
    pub f: f64,
}

impl EarthModel {
    pub fn new(d: &MissionData) -> Self {
        let r = d.earth_rotation.clone();
        let pm = RotationModel { w0: r.w0, w_dot: r.w_dot, w1: Some(r.w1), delta_t: true };
        EarthModel { rot: r, pm, a: d.wgs84_a, f: d.wgs84_f }
    }
    pub fn prime_meridian_deg(&self, t: f64) -> f64 {
        self.pm.prime_meridian_deg(t)
    }
    /// bodyToIcrf: rotation body-fixed -> ICRF at t, row-major.
    pub fn body_to_icrf(&self, t: f64) -> [f64; 9] {
        let m = &self.rot;
        let tt = t / (SECONDS_PER_DAY * DAYS_PER_CENTURY);
        let ra = m.ra0 + m.ra1 * tt;
        let dec = m.dec0 + m.dec1 * tt;
        let (sa, ca) = sincos((ra + 90.0) * DEG);
        let (sd, cd) = sincos((90.0 - dec) * DEG);
        let (sw, cw) = sincos(self.prime_meridian_deg(t) * DEG);
        let (a00, a01, a02) = (ca, -sa * cd, sa * sd);
        let (a10, a11, a12) = (sa, ca * cd, -ca * sd);
        let (a20, a21, a22) = (0.0f64, sd, cd);
        [
            a00 * cw + a01 * sw,
            -a00 * sw + a01 * cw,
            a02,
            a10 * cw + a11 * sw,
            -a10 * sw + a11 * cw,
            a12,
            a20 * cw + a21 * sw,
            -a20 * sw + a21 * cw,
            a22,
        ]
    }
    pub fn pole_at(&self, t: f64) -> V3 {
        let r = self.body_to_icrf(t);
        [r[2], r[5], r[8]]
    }
    pub fn spin_rate(&self) -> f64 {
        (self.rot.w_dot * DEG) / SECONDS_PER_DAY
    }
    /// geodeticToBodyFixed on WGS84.
    pub fn geodetic_to_body_fixed(&self, lat_deg: f64, lon_deg: f64, height_m: f64) -> V3 {
        let (sp, cp) = sincos(lat_deg * DEG);
        let (sl, cl) = sincos(lon_deg * DEG);
        let e2 = self.f * (2.0 - self.f);
        let n = self.a / (1.0 - e2 * sp * sp).sqrt();
        let rc = (n + height_m) * cp;
        [rc * cl, rc * sl, (n * (1.0 - e2) + height_m) * sp]
    }
    pub fn site_icrf(&self, lat_deg: f64, lon_deg: f64, height_m: f64, t: f64) -> V3 {
        apply_mat3(&self.body_to_icrf(t), &self.geodetic_to_body_fixed(lat_deg, lon_deg, height_m))
    }
}

pub fn apply_mat3(r: &[f64; 9], v: &V3) -> V3 {
    [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]]
}

pub fn azimuth_allowed(site: &LaunchSite, azimuth_deg: f64) -> bool {
    let span = site.azimuth_max_deg - site.azimuth_min_deg;
    if span >= 360.0 {
        return true;
    }
    let mut d = azimuth_deg - site.azimuth_min_deg;
    d = d - 360.0 * (d / 360.0).floor();
    d <= span
}

pub struct SiteFrame {
    pub r: V3,
    pub up: V3,
    pub east: V3,
    pub north: V3,
    pub pole: V3,
}

pub fn site_frame(em: &EarthModel, site: &LaunchSite, t: f64) -> SiteFrame {
    let r = em.site_icrf(site.lat_deg, site.lon_deg, site.height_m, t);
    let up = scale(&r, 1.0 / norm(&r));
    let pole = em.pole_at(t);
    let e = cross(&pole, &up);
    let east = scale(&e, 1.0 / norm(&e));
    let north = cross(&up, &east);
    SiteFrame { r, up, east, north, pole }
}

pub struct Plane {
    pub up: V3,
    pub downrange: V3,
    pub normal: V3,
    pub pole: V3,
}

pub fn launch_plane(em: &EarthModel, site: &LaunchSite, t: f64, azimuth_deg: f64) -> Plane {
    let f = site_frame(em, site, t);
    let (sa, ca) = sincos(azimuth_deg * DEG);
    let d = [ca * f.north[0] + sa * f.east[0], ca * f.north[1] + sa * f.east[1], ca * f.north[2] + sa * f.east[2]];
    Plane { up: f.up, downrange: d, normal: cross(&f.up, &d), pole: f.pole }
}

/// launchGeometry: (alongTrack, crossTrack) of the pad's inertial velocity.
pub fn launch_geometry(em: &EarthModel, site: &LaunchSite, t: f64, azimuth_deg: f64) -> (f64, f64) {
    let f = site_frame(em, site, t);
    let w = em.spin_rate();
    let vp = scale(&cross(&f.pole, &f.r), w);
    let p = launch_plane(em, site, t, azimuth_deg);
    (dot(&vp, &p.downrange), dot(&vp, &p.normal))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Circularization {
    TwoBody,
    J2Mean,
}

#[derive(Clone, Debug)]
pub struct ParkingOrbitLaunch {
    pub site_id: String,
    pub launch_time: f64,
    pub azimuth_deg: f64,
    pub altitude_m: f64,
    pub ascent_time_s: Option<f64>,
    pub downrange_deg: Option<f64>,
    /// Err(name) stands for an unknown circularization string (refused).
    pub circularization: Option<Result<Circularization, String>>,
}

#[derive(Clone, Debug)]
pub struct BurnoutState {
    pub time: f64,
    pub altitude_m: f64,
    pub horizontal_speed: f64,
    pub radial_speed: f64,
    pub downrange: f64,
}

#[derive(Clone, Debug)]
pub struct LaunchResult {
    pub t: f64,
    pub state: [f64; 6],
    pub geocentric: [f64; 6],
    pub normal: V3,
    pub inclination_deg: f64,
}

pub fn launch_site<'a>(d: &'a MissionData, id: &str) -> Result<&'a LaunchSite, String> {
    d.site(id).ok_or_else(|| format!("unknown launch site {id}"))
}

fn corridor_error(site: &LaunchSite, az: f64) -> String {
    format!("azimuth {} deg outside {} range-safety corridor {}..{}", jsfmt::num(az), site.id, jsfmt::num(site.azimuth_min_deg), jsfmt::num(site.azimuth_max_deg))
}

pub fn earth_data(d: &MissionData) -> &BodyInfo {
    d.bodies.iter().find(|b| b.id == "earth").expect("earth in the body list")
}

fn finish(plane: &Plane, t: f64, geo: [f64; 6], earth_state: &mut dyn FnMut(f64, &mut [f64; 6])) -> LaunchResult {
    let mut e = [0.0; 6];
    earth_state(t, &mut e);
    let state = [e[0] + geo[0], e[1] + geo[1], e[2] + geo[2], e[3] + geo[3], e[4] + geo[4], e[5] + geo[5]];
    let cos_i = dot(&plane.normal, &plane.pole);
    let sin_i = norm(&cross(&plane.normal, &plane.pole));
    LaunchResult { t, state, geocentric: geo, normal: plane.normal, inclination_deg: atan2(sin_i, cos_i) / DEG }
}

/// directInjectionState. `earth_state(t, out)` is Earth's barycentric state (ephem.bodyState).
pub fn direct_injection_state(
    d: &MissionData,
    em: &EarthModel,
    site_id: &str,
    launch_time: f64,
    azimuth_deg: f64,
    b: &BurnoutState,
    earth_state: &mut dyn FnMut(f64, &mut [f64; 6]),
) -> Result<LaunchResult, String> {
    let site = launch_site(d, site_id)?;
    if !azimuth_allowed(site, azimuth_deg) {
        return Err(corridor_error(site, azimuth_deg));
    }
    let earth = earth_data(d);
    let plane = launch_plane(em, site, launch_time, azimuth_deg);
    let (st, ct) = sincos(b.downrange);
    let (u, dd) = (&plane.up, &plane.downrange);
    let rh = [ct * u[0] + st * dd[0], ct * u[1] + st * dd[1], ct * u[2] + st * dd[2]];
    let vh_ = [ct * dd[0] - st * u[0], ct * dd[1] - st * u[1], ct * dd[2] - st * u[2]];
    let r0 = earth.reference_radius + b.altitude_m;
    let vh = b.horizontal_speed;
    let vr = b.radial_speed;
    let geo = [rh[0] * r0, rh[1] * r0, rh[2] * r0, vh_[0] * vh + rh[0] * vr, vh_[1] * vh + rh[1] * vr, vh_[2] * vh + rh[2] * vr];
    let t = launch_time + b.time;
    Ok(finish(&plane, t, geo, earth_state))
}

/// launchState for a parking-orbit launch.
pub fn launch_state(d: &MissionData, em: &EarthModel, spec: &ParkingOrbitLaunch, earth_state: &mut dyn FnMut(f64, &mut [f64; 6])) -> Result<LaunchResult, String> {
    let site = launch_site(d, &spec.site_id)?;
    if !azimuth_allowed(site, spec.azimuth_deg) {
        return Err(corridor_error(site, spec.azimuth_deg));
    }
    if !(spec.altitude_m > 0.0) {
        return Err("parking orbit altitude must be positive".into());
    }
    let ascent = spec.ascent_time_s.unwrap_or(d.default_ascent_time_s);
    let downrange = spec.downrange_deg.unwrap_or(d.default_downrange_deg);
    let mode = spec.circularization.clone().unwrap_or(Ok(Circularization::J2Mean));

    let earth = earth_data(d);
    let plane = launch_plane(em, site, spec.launch_time, spec.azimuth_deg);
    let (st, ct) = sincos(downrange * DEG);
    let (u, dd) = (&plane.up, &plane.downrange);
    let rh = [ct * u[0] + st * dd[0], ct * u[1] + st * dd[1], ct * u[2] + st * dd[2]];
    let vh = [ct * dd[0] - st * u[0], ct * dd[1] - st * u[1], ct * dd[2] - st * u[2]];
    let r0 = earth.reference_radius + spec.altitude_m;
    let cos_i = dot(&plane.normal, &plane.pole);
    let geo = match mode {
        Ok(Circularization::TwoBody) => {
            let v = (earth.gm / r0).sqrt();
            [rh[0] * r0, rh[1] * r0, rh[2] * r0, vh[0] * v, vh[1] * v, vh[2] * v]
        }
        Ok(Circularization::J2Mean) => {
            let j2 = earth.j2.unwrap_or(0.0);
            let re = earth.j2_radius.unwrap_or(earth.reference_radius);
            let eps = 1.5 * j2 * (re / r0) * (re / r0);
            let sin2i = 1.0 - cos_i * cos_i;
            let n = ((earth.gm / (r0 * r0 * r0)) * (1.0 + eps * (1.0 - 1.5 * sin2i))).sqrt();
            let nn = cross(&plane.pole, &plane.normal);
            let a = dot(&rh, &nn);
            let b = dot(&rh, &cross(&plane.normal, &nn));
            let s2c2u = a * a - b * b;
            let s2s2u = 2.0 * a * b;
            let rr = r0 * (1.0 + (eps / 6.0) * s2c2u);
            let vr = -(eps / 3.0) * n * r0 * s2s2u;
            let vt = n * r0 * (1.0 + (eps / 3.0) * s2c2u);
            [rh[0] * rr, rh[1] * rr, rh[2] * rr, vh[0] * vt + rh[0] * vr, vh[1] * vt + rh[1] * vr, vh[2] * vt + rh[2] * vr]
        }
        Err(name) => return Err(format!("unknown circularization {name}")),
    };
    let t = spec.launch_time + ascent;
    Ok(finish(&plane, t, geo, earth_state))
}
