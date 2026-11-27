//! The analytic ascent model (src/mission/ascent.ts): computeAscent (to a
//! parking orbit) and computeDirectAscent (direct injection). Same operations
//! in the same order, the same fixed step and bisection counts. An `Err` is
//! what the TypeScript throws (exactLn / exactExp out of domain); a refusal
//! is an `Ok(Refused)`, as the TypeScript returns `{ ok: false }`.

use crate::dmath::{atan2, sincos, PI};
use crate::exact_math::{exact_exp, exact_ln};
use crate::mission::jsfmt::{fixed, num};
use crate::mission::mdata::AscentBody;
use crate::mission::plan::Stage;
use crate::spacecraft::G0;

const VERTICAL_RISE_SPEED: f64 = 50.0;
const DIRECT_KICK_MAX: f64 = 1.2;
pub const DIRECT_ALTITUDE_TOLERANCE_M: f64 = 5000.0;

fn ln(x: f64) -> Result<f64, String> {
    exact_ln(x).ok_or_else(|| format!("exactLn: argument must be finite and positive, got {}", num(x)))
}
fn exp(x: f64) -> Result<f64, String> {
    exact_exp(x).ok_or_else(|| format!("exactExp: argument must be in [-700, 700], got {}", num(x)))
}

pub fn stage_thrust(s: &Stage) -> f64 {
    let mut f = 0.0;
    for e in &s.engines {
        f += e.thrust;
    }
    f
}
pub fn stage_flow(s: &Stage) -> f64 {
    let mut q = 0.0;
    for e in &s.engines {
        q += e.thrust / (e.isp * G0);
    }
    q
}
pub fn can_shut_down(s: &Stage) -> bool {
    !s.engines.iter().any(|e| e.throttleable == Some(false))
}
pub fn can_restart(s: &Stage) -> bool {
    !s.engines.iter().any(|e| e.restartable == Some(false))
}
/// Mass of stages k+1.. summed from the top (k = -1: everything).
pub fn mass_above(stages: &[Stage], k: isize) -> f64 {
    let mut m = 0.0;
    let mut j = stages.len() as isize - 1;
    while j > k {
        m = m + stages[j as usize].wet_mass;
        j -= 1;
    }
    m
}

#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub along_track: f64,
    pub cross_track: f64,
}

#[derive(Clone, Debug)]
pub struct StageUse {
    pub stage: usize,
    pub propellant_used: f64,
    pub propellant_left: f64,
    pub delta_v: f64,
    pub time: f64,
    pub separated: bool,
}

#[derive(Clone, Debug)]
pub struct AscentOk {
    pub upper_stage: usize,
    pub upper_propellant: f64,
    pub mass_at_insertion: f64,
    pub delta_v: f64,
    /// orbitalSpeed, rotation, gravity, climb, drag, steering, backPressure, circularization.
    pub losses: [f64; 8],
    pub stages: Vec<StageUse>,
    pub liftoff_tw: f64,
    pub kick: f64,
}

#[derive(Clone, Debug)]
pub enum Ascent<T> {
    Ok(T),
    Refused { reason: String, liftoff_tw: f64 },
}

#[derive(Clone, Debug)]
pub struct DirectBurnout {
    pub time: f64,
    pub altitude_m: f64,
    pub speed: f64,
    pub horizontal_speed: f64,
    pub radial_speed: f64,
    pub flight_path_angle: f64,
    pub downrange: f64,
    pub c3: f64,
}

#[derive(Clone, Debug)]
pub struct DirectOk {
    pub upper_stage: usize,
    pub upper_propellant: f64,
    pub mass_at_insertion: f64,
    pub delta_v: f64,
    /// injectionSpeed, rotation, gravity, climb, drag, steering, backPressure.
    pub losses: [f64; 7],
    pub stages: Vec<StageUse>,
    pub liftoff_tw: f64,
    pub kick: f64,
    pub burnout: DirectBurnout,
    pub target_c3: f64,
    pub achieved_c3: f64,
    pub shortfall: f64,
    /// true: 'target'; false: 'depletion'.
    pub cutoff_at_target: bool,
}

/// The shared right-hand side (the `f` closure of both ascents). out:
/// vdot, hdot, gammadot, lg', ld', ls', lp', thetadot.
struct Rhs {
    mu: f64,
    r_: f64,
    atm: Option<(f64, f64)>,
    eps: f64,
    cd_a: f64,
    u: f64,
}
impl Rhs {
    #[inline]
    fn eval(&self, v: f64, h: f64, gm: f64, m: f64, f_: f64, out: &mut [f64; 8]) -> Result<(), String> {
        let vertical = v < VERTICAL_RISE_SPEED;
        let (s, c) = if vertical { (1.0, 0.0) } else { sincos(gm) };
        let hh = if h > 0.0 { h } else { 0.0 };
        let r = self.r_ + hh;
        let g = self.mu / (r * r);
        let mut rr = 0.0;
        if let Some((_, scale_h)) = self.atm {
            let z = hh / scale_h;
            rr = if z < 700.0 { exp(-z)? } else { 0.0 };
        }
        let a_v = f_ / m;
        let a_t = a_v * (1.0 - self.eps * rr);
        let a_d = match self.atm {
            Some((rho0, _)) => (0.5 * rho0 * rr * v * v * self.cd_a) / m,
            None => 0.0,
        };
        let vh = self.u + v * c;
        let geff = g - (vh * vh) / r;
        let mut ca = 1.0;
        let mut gdot = 0.0;
        if !vertical {
            if gm <= 0.0 && geff > 0.0 {
                let mut sa = (geff * c) / a_t;
                if sa > 1.0 {
                    sa = 1.0;
                }
                ca = (1.0 - sa * sa).sqrt();
                gdot = (a_t * sa - geff * c) / v;
            } else {
                gdot = -(geff * c) / v;
            }
        }
        out[0] = a_t * ca - g * s - a_d;
        out[1] = v * s;
        out[2] = gdot;
        out[3] = g * s;
        out[4] = a_d;
        out[5] = a_t * (1.0 - ca);
        out[6] = a_v - a_t;
        out[7] = vh / r;
        Ok(())
    }
}

fn cd_area(body: &AscentBody, m0: f64) -> Result<f64, String> {
    Ok(if body.atmosphere.is_some() && body.drag_area > 0.0 { body.drag_area * exp((2.0 / 3.0) * ln(m0 / 1000.0)?)? } else { 0.0 })
}

struct Run {
    reached: bool,
    h: f64,
    v: f64,
    stage: usize,
    mass: f64,
    t: f64,
    lg: f64,
    ld: f64,
    ls: f64,
    lp: f64,
    burnout: Vec<f64>,
}

/// computeAscent: `gm`, `radius` of the body, parking `altitude_m`.
pub fn compute_ascent(stages: &[Stage], gm: f64, radius: f64, altitude_m: f64, geom: Geometry, body: &AscentBody) -> Result<Ascent<AscentOk>, String> {
    let n = stages.len();
    let mu = gm;
    let r_ = radius;
    let m0 = mass_above(stages, -1);
    let g0s = mu / (r_ * r_);
    let liftoff_tw = if n > 1 { stage_thrust(&stages[0]) / (m0 * g0s) } else { 0.0 };
    let refuse = |reason: String| Ok(Ascent::Refused { reason, liftoff_tw });
    if n < 2 {
        return refuse("a vehicle launch needs a stage below the spacecraft".into());
    }
    if !(altitude_m > 0.0) {
        return refuse("parking altitude must be positive".into());
    }
    let h_p = if altitude_m < body.powered_insertion_altitude_m { altitude_m } else { body.powered_insertion_altitude_m };
    let r_p = r_ + h_p;
    let r_t = r_ + altitude_m;
    let v_ins = ((2.0 * mu * r_t) / (r_p * (r_p + r_t))).sqrt();
    let circ = (mu / r_t).sqrt() - (v_ins * r_p) / r_t;
    let du = v_ins - geom.along_track;
    let v_goal = (du * du + geom.cross_track * geom.cross_track).sqrt();
    let atm = body.atmosphere;
    let eps = if atm.is_some() { body.back_pressure_loss } else { 0.0 };
    let cd_a = cd_area(body, m0)?;
    let nn = body.steps;
    if !(liftoff_tw * (1.0 - eps) > 1.0) {
        return refuse(format!("liftoff thrust-to-weight {} is too low to lift off", fixed(liftoff_tw, 3)));
    }
    let rhs = Rhs { mu, r_, atm, eps, cd_a, u: geom.along_track };

    let run = |kick: f64| -> Result<Run, String> {
        let mut v = 0.0f64;
        let mut h = 0.0f64;
        let mut gam = 0.5 * PI - kick;
        let (mut lg, mut ld, mut ls, mut lp) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        let mut t = 0.0f64;
        let mut mass = m0;
        let mut burnout = Vec::new();
        let mut out = [0.0f64; 8];
        for k in 0..n - 1 {
            let st = &stages[k];
            let f_ = stage_thrust(st);
            let mdot = stage_flow(st);
            let prop = st.wet_mass - st.dry_mass;
            let tt = prop / mdot;
            let dt = tt / nn as f64;
            let m_start = mass;
            for i in 0..nn {
                let fi = i as f64;
                let ma = m_start - mdot * (fi * dt);
                let mm = m_start - mdot * ((fi + 0.5) * dt);
                rhs.eval(v, h, gam, ma, f_, &mut out)?;
                let vm = v + 0.5 * dt * out[0];
                let hm = h + 0.5 * dt * out[1];
                let mut gmid = gam + 0.5 * dt * out[2];
                if gmid < 0.0 {
                    gmid = 0.0;
                }
                rhs.eval(vm, hm, gmid, mm, f_, &mut out)?;
                let dv = dt * out[0];
                let vn = v + dv;
                let fr = if vn >= v_goal { if dv > 0.0 { (v_goal - v) / dv } else { 1.0 } } else { 1.0 };
                h += fr * dt * out[1];
                gam += fr * dt * out[2];
                if gam < 0.0 {
                    gam = 0.0;
                }
                lg += fr * dt * out[3];
                ld += fr * dt * out[4];
                ls += fr * dt * out[5];
                lp += fr * dt * out[6];
                if vn >= v_goal {
                    t += (fi + fr) * dt;
                    return Ok(Run { reached: true, h, v: v_goal, stage: k, mass: m_start - mdot * ((fi + fr) * dt), t, lg, ld, ls, lp, burnout });
                }
                v = vn;
                if v < 0.0 || h < 0.0 {
                    return Ok(Run { reached: false, h, v, stage: k, mass: ma, t: t + fi * dt, lg, ld, ls, lp, burnout });
                }
            }
            t += tt;
            burnout.push(t);
            mass = mass_above(stages, k as isize);
        }
        Ok(Run { reached: false, h, v, stage: n - 1, mass, t, lg, ld, ls, lp, burnout })
    };

    let mut lo = 0.0f64;
    let mut hi = 0.5f64;
    for _ in 0..50 {
        let mid = 0.5 * (lo + hi);
        let r = run(mid)?;
        if r.h > h_p {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let best = run(hi)?;
    if best.reached && !can_shut_down(&stages[best.stage]) {
        return refuse(format!(
            "stage {} cannot shut down at orbital speed (a non-throttleable engine burns to depletion once lit): a parking orbit needs a stage that can stop; use direct injection",
            best.stage
        ));
    }
    if !best.reached {
        return refuse(format!("the vehicle cannot reach the parking orbit: its lower stages run dry {} m/s short of orbital speed", fixed(v_goal - best.v, 0)));
    }
    if best.h < h_p - 1000.0 {
        return refuse(format!("the vehicle cannot climb to {} km while reaching orbital speed (reaches {} km)", fixed(h_p / 1000.0, 0), fixed(best.h / 1000.0, 0)));
    }

    let mut k = best.stage;
    let mut mass = best.mass;
    let mut need = if circ > 0.0 { circ } else { 0.0 };
    if need > 0.0 && !can_restart(&stages[k]) {
        return refuse(format!(
            "stage {k} cannot restart to circularise at {} km (a non-restartable engine): choose a parking orbit at or below {} km",
            fixed(altitude_m / 1000.0, 0),
            fixed(body.powered_insertion_altitude_m / 1000.0, 0)
        ));
    }
    // (m0, m1, t) per stage.
    let mut used: Vec<(f64, f64, f64)> = Vec::new();
    for j in 0..k {
        used.push((if j == 0 { m0 } else { mass_above(stages, j as isize - 1) }, mass_above(stages, j as isize) + stages[j].dry_mass, best.burnout[j]));
    }
    let mut up_start = if k == 0 { m0 } else { mass_above(stages, k as isize - 1) };
    while need > 0.0 {
        let ve = stage_thrust(&stages[k]) / stage_flow(&stages[k]);
        let dry = mass_above(stages, k as isize) + stages[k].dry_mass;
        let m_end = mass * exp(-need / ve)?;
        if m_end >= dry {
            mass = m_end;
            break;
        }
        need -= ve * ln(mass / dry)?;
        used.push((up_start, dry, best.t));
        if k + 1 >= n - 1 {
            return refuse(format!("the vehicle cannot circularise at {} km: {} m/s short", fixed(altitude_m / 1000.0, 0), fixed(need, 0)));
        }
        k += 1;
        mass = mass_above(stages, k as isize - 1);
        up_start = mass;
    }
    used.push((up_start, mass, best.t));

    let mut uses = Vec::new();
    let mut delta_v = 0.0;
    for j in 0..=k {
        let st = &stages[j];
        let (um0, um1, ut) = used[j];
        let ve = stage_thrust(st) / stage_flow(st);
        let dvj = if um1 < um0 { ve * ln(um0 / um1)? } else { 0.0 };
        delta_v += dvj;
        let pu = um0 - um1;
        uses.push(StageUse { stage: j, propellant_used: pu, propellant_left: st.wet_mass - st.dry_mass - pu, delta_v: dvj, time: ut, separated: j < k });
    }
    let upper_propellant = mass - mass_above(stages, k as isize) - stages[k].dry_mass;
    let climb = (v_ins * v_ins + 2.0 * mu * (1.0 / r_ - 1.0 / r_p)).sqrt() - v_ins;
    Ok(Ascent::Ok(AscentOk {
        upper_stage: k,
        upper_propellant,
        mass_at_insertion: mass,
        delta_v,
        losses: [v_ins, v_goal - v_ins, best.lg, climb, best.ld, best.ls, best.lp, if circ > 0.0 { circ } else { 0.0 }],
        stages: uses,
        liftoff_tw,
        kick: hi,
    }))
}

struct DirectRun {
    crashed: bool,
    reached_target: bool,
    h: f64,
    v: f64,
    gam: f64,
    th: f64,
    stage: usize,
    mass: f64,
    t: f64,
    lg: f64,
    ld: f64,
    ls: f64,
    lp: f64,
    burnout: Vec<f64>,
}

/// computeDirectAscent.
pub fn compute_direct_ascent(stages: &[Stage], gm: f64, radius: f64, c3: f64, injection_altitude_m: f64, geom: Geometry, body: &AscentBody) -> Result<Ascent<DirectOk>, String> {
    let n = stages.len();
    let mu = gm;
    let r_ = radius;
    let m0 = mass_above(stages, -1);
    let g0s = mu / (r_ * r_);
    let liftoff_tw = if n > 1 { stage_thrust(&stages[0]) / (m0 * g0s) } else { 0.0 };
    let refuse = |reason: String| Ok(Ascent::Refused { reason, liftoff_tw });
    if n < 2 {
        return refuse("a vehicle launch needs a stage below the spacecraft".into());
    }
    let h_i = injection_altitude_m;
    if !(h_i > 0.0) {
        return refuse("injection altitude must be positive".into());
    }
    let e_goal = 0.5 * c3;
    let u = geom.along_track;
    let c2 = geom.cross_track * geom.cross_track;
    let atm = body.atmosphere;
    let eps = if atm.is_some() { body.back_pressure_loss } else { 0.0 };
    let cd_a = cd_area(body, m0)?;
    let nn = body.steps;
    if !(liftoff_tw * (1.0 - eps) > 1.0) {
        return refuse(format!("liftoff thrust-to-weight {} is too low to lift off", fixed(liftoff_tw, 3)));
    }
    let rhs = Rhs { mu, r_, atm, eps, cd_a, u };

    let inertial = |v: f64, gm: f64| -> (f64, f64) {
        let vp2 = v * v - c2;
        let vp = if vp2 > 0.0 { vp2.sqrt() } else { 0.0 };
        let (s, c) = if v < VERTICAL_RISE_SPEED { (1.0, 0.0) } else { sincos(gm) };
        (u + vp * c, vp * s)
    };
    let energy = |v: f64, h: f64, gm: f64| -> f64 {
        let (x, y) = inertial(v, gm);
        0.5 * (x * x + y * y) - mu / (r_ + (if h > 0.0 { h } else { 0.0 }))
    };

    let run = |kick: f64| -> Result<DirectRun, String> {
        let mut v = 0.0f64;
        let mut h = 0.0f64;
        let mut gam = 0.5 * PI - kick;
        let mut th = 0.0f64;
        let (mut lg, mut ld, mut ls, mut lp) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        let mut t = 0.0f64;
        let mut mass = m0;
        let mut reached_target = false;
        let mut burnout = Vec::new();
        let mut out = [0.0f64; 8];
        for k in 0..n - 1 {
            let st = &stages[k];
            let f_ = stage_thrust(st);
            let mdot = stage_flow(st);
            let prop = st.wet_mass - st.dry_mass;
            let tt = prop / mdot;
            let dt = tt / nn as f64;
            let m_start = mass;
            let stoppable = can_shut_down(st);
            let mut e0 = energy(v, h, gam);
            for i in 0..nn {
                let fi = i as f64;
                let ma = m_start - mdot * (fi * dt);
                let mm = m_start - mdot * ((fi + 0.5) * dt);
                rhs.eval(v, h, gam, ma, f_, &mut out)?;
                let vm = v + 0.5 * dt * out[0];
                let hm = h + 0.5 * dt * out[1];
                let mut gmid = gam + 0.5 * dt * out[2];
                if gmid < 0.0 {
                    gmid = 0.0;
                }
                rhs.eval(vm, hm, gmid, mm, f_, &mut out)?;
                let vn = v + dt * out[0];
                let hn = h + dt * out[1];
                let mut gn = gam + dt * out[2];
                if gn < 0.0 {
                    gn = 0.0;
                }
                let e1 = energy(vn, hn, gn);
                let cross = !reached_target && e1 >= e_goal;
                if cross {
                    reached_target = true;
                }
                let fr = if cross && stoppable { if e1 > e0 { (e_goal - e0) / (e1 - e0) } else { 1.0 } } else { 1.0 };
                v += fr * dt * out[0];
                h += fr * dt * out[1];
                gam += fr * dt * out[2];
                if gam < 0.0 {
                    gam = 0.0;
                }
                th += fr * dt * out[7];
                lg += fr * dt * out[3];
                ld += fr * dt * out[4];
                ls += fr * dt * out[5];
                lp += fr * dt * out[6];
                if cross && stoppable {
                    t += (fi + fr) * dt;
                    return Ok(DirectRun { crashed: false, reached_target, h, v, gam, th, stage: k, mass: m_start - mdot * ((fi + fr) * dt), t, lg, ld, ls, lp, burnout });
                }
                if v < 0.0 || h < 0.0 {
                    return Ok(DirectRun { crashed: true, reached_target, h, v, gam, th, stage: k, mass: ma, t: t + fi * dt, lg, ld, ls, lp, burnout });
                }
                e0 = e1;
            }
            t += tt;
            if reached_target || k == n - 2 {
                return Ok(DirectRun { crashed: false, reached_target, h, v, gam, th, stage: k, mass: mass_above(stages, k as isize) + st.dry_mass, t, lg, ld, ls, lp, burnout });
            }
            burnout.push(t);
            mass = mass_above(stages, k as isize);
        }
        Ok(DirectRun { crashed: true, reached_target, h, v, gam, th, stage: n - 1, mass, t, lg, ld, ls, lp, burnout })
    };

    let mut lo = 0.0f64;
    let mut hi = DIRECT_KICK_MAX;
    for _ in 0..50 {
        let mid = 0.5 * (lo + hi);
        let r = run(mid)?;
        if !r.crashed && r.h > h_i {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let mut kick = hi;
    let mut best = run(kick)?;
    if best.crashed {
        kick = lo;
        best = run(kick)?;
    }
    if best.crashed {
        return refuse(format!("the vehicle cannot fly a direct ascent to {} km: it falls back before burnout", fixed(h_i / 1000.0, 0)));
    }
    if best.h < h_i - DIRECT_ALTITUDE_TOLERANCE_M || best.h > h_i + DIRECT_ALTITUDE_TOLERANCE_M {
        return refuse(format!("the vehicle cannot end its powered flight at {} km (it ends at {} km)", fixed(h_i / 1000.0, 0), fixed(best.h / 1000.0, 0)));
    }
    let k = best.stage;
    let mut uses = Vec::new();
    let mut delta_v = 0.0;
    for j in 0..=k {
        let st = &stages[j];
        let m_a = if j == 0 { m0 } else { mass_above(stages, j as isize - 1) };
        let m_b = if j < k { mass_above(stages, j as isize) + st.dry_mass } else { best.mass };
        let ve = stage_thrust(st) / stage_flow(st);
        let dvj = if m_b < m_a { ve * ln(m_a / m_b)? } else { 0.0 };
        delta_v += dvj;
        let pu = m_a - m_b;
        uses.push(StageUse { stage: j, propellant_used: pu, propellant_left: st.wet_mass - st.dry_mass - pu, delta_v: dvj, time: if j < k { best.burnout[j] } else { best.t }, separated: j < k });
    }
    let upper_propellant = best.mass - mass_above(stages, k as isize) - stages[k].dry_mass;
    let (hs, rs) = inertial(best.v, best.gam);
    let r = r_ + best.h;
    let speed = (hs * hs + rs * rs).sqrt();
    let achieved_c3 = speed * speed - (2.0 * mu) / r;
    let climb = (speed * speed + 2.0 * mu * (1.0 / r_ - 1.0 / r)).sqrt() - speed;
    let cut_at_target = best.reached_target && can_shut_down(&stages[k]) && upper_propellant > 0.0;
    Ok(Ascent::Ok(DirectOk {
        upper_stage: k,
        upper_propellant,
        mass_at_insertion: best.mass,
        delta_v,
        losses: [speed, best.v - speed, best.lg, climb, best.ld, best.ls, best.lp],
        stages: uses,
        liftoff_tw,
        kick,
        burnout: DirectBurnout {
            time: best.t,
            altitude_m: best.h,
            speed,
            horizontal_speed: hs,
            radial_speed: rs,
            flight_path_angle: atan2(rs, hs),
            downrange: best.th,
            c3: achieved_c3,
        },
        target_c3: c3,
        achieved_c3,
        shortfall: if !cut_at_target && c3 > achieved_c3 { c3 - achieved_c3 } else { 0.0 },
        cutoff_at_target: cut_at_target,
    }))
}
