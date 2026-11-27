//! Replay a mission plan (src/mission/replay.ts): launch or state start,
//! the analytic ascent, staged propagation with separations, events,
//! burn and stage accounting, and the digest. The `resolveLaunch` option
//! (a TypeScript callback) and the abort hooks are not ported; `on_step`
//! observes as in the TypeScript (it cannot change the result).

use crate::cheb::ChebEphemeris;
use crate::dop853::DopError;
use crate::exact_math::{exact_ln, Hasher};
use crate::mission::ascent::{compute_ascent, compute_direct_ascent, mass_above, Ascent, Geometry, StageUse};
use crate::mission::events::{EventFinder, NoStep, StepEnv, TrajectoryEvent, WorldBody};
use crate::mission::jsfmt::{fixed, num};
use crate::mission::launch::{direct_injection_state, launch_geometry, launch_site, launch_state, BurnoutState, Circularization, EarthModel, LaunchResult, ParkingOrbitLaunch};
use crate::mission::mdata::MissionData;
use crate::mission::plan::{ascent_restart_issues, simulation_start_offset, staging_issues, validate_plan, Frame, LaunchCheck, Plan, Start, PLAN_FORMAT_STAGED};
use crate::spacecraft::{propagate, Burn, BurnFrame, ForceModel, PropagateError, PropagateOptions, StepView, G0, STATE_SIZE};

#[derive(Clone, Debug, Default)]
pub struct ReplayOptions {
    pub spheres: Vec<(String, f64)>,
    pub bodies: Option<Vec<String>>,
    pub stop_on_atmosphere: Option<bool>,
    pub max_steps: Option<u64>,
    pub max_events: Option<usize>,
    pub allow_version_mismatch: bool,
}

#[derive(Clone, Debug)]
pub struct BurnReport {
    pub burn_time: f64,
    pub propellant: f64,
    pub delta_v: f64,
}

#[derive(Clone, Debug)]
pub struct StageReport {
    pub stage: usize,
    pub propellant_used: f64,
    pub propellant_left: f64,
    pub delta_v: f64,
    pub ascent_delta_v: f64,
    pub separated_at: Option<f64>,
    pub dropped_in_ascent: bool,
}

#[derive(Clone, Debug)]
pub struct LaunchInsertion {
    pub t: f64,
    pub state: [f64; 6],
    pub geocentric: [f64; 6],
    pub inclination_deg: f64,
}

/// What replay needs of a flown ascent (parking or direct).
#[derive(Clone, Debug)]
pub struct FlownAscent {
    pub upper_stage: usize,
    pub upper_propellant: f64,
    pub mass_at_insertion: f64,
    pub delta_v: f64,
    pub stages: Vec<StageUse>,
    /// Direct injection: burnout (time, altitude, horizontal, radial, downrange) and achieved C3.
    pub direct: Option<([f64; 5], f64)>,
}

#[derive(Clone, Debug)]
pub struct ReplayResult {
    pub ok: bool,
    pub outcome: &'static str,
    pub reason: String,
    pub events: Vec<TrajectoryEvent>,
    pub burns: Vec<BurnReport>,
    pub delta_v: f64,
    pub propellant_used: f64,
    pub elapsed: f64,
    pub final_t: f64,
    pub final_state: Vec<f64>,
    pub steps: u64,
    pub digest: String,
    pub launch: Option<LaunchInsertion>,
    pub stages: Vec<StageReport>,
    pub total_delta_v: f64,
    pub ascent: Option<FlownAscent>,
}

/// The mission world: the ephemeris and force model, and the body table.
pub struct MissionWorld<'d> {
    pub eph: ChebEphemeris,
    pub fm: ForceModel,
    pub d: &'d MissionData,
}

struct Core {
    outcome: &'static str,
    reason: String,
    events: Vec<TrajectoryEvent>,
    burns: Vec<BurnReport>,
    elapsed: f64,
    final_t: f64,
    final_state: Vec<f64>,
    steps: u64,
}

#[derive(Default)]
struct Extra {
    launch: Option<LaunchInsertion>,
    stages: Option<Vec<StageReport>>,
    ascent: Option<FlownAscent>,
    staged: bool,
}

fn hstr(h: &mut Hasher, s: &str) {
    let u: Vec<u16> = s.encode_utf16().collect();
    h.str_utf16(&u);
}

fn finish(r: Core, x: Extra) -> ReplayResult {
    let mut delta_v = 0.0;
    let mut propellant_used = 0.0;
    for b in &r.burns {
        delta_v += b.delta_v;
        propellant_used += b.propellant;
    }
    let mut h = Hasher::new();
    hstr(&mut h, r.outcome);
    h.f64(r.elapsed).f64(r.final_t).f64(delta_v).f64(propellant_used).u32(r.steps as u32);
    for &v in &r.final_state {
        h.f64(v);
    }
    for b in &r.burns {
        h.f64(b.burn_time).f64(b.propellant).f64(b.delta_v);
    }
    h.u32(r.events.len() as u32);
    for e in &r.events {
        hstr(&mut h, e.kind.name());
        hstr(&mut h, &e.body);
        h.f64(e.t).f64(e.mass);
        for &v in &e.rel {
            h.f64(v);
        }
    }
    let total_delta_v = match &x.ascent {
        Some(a) => a.delta_v + delta_v,
        None => delta_v,
    };
    let stages = x.stages.unwrap_or_default();
    if x.staged {
        h.f64(total_delta_v).u32(stages.len() as u32);
        for s in &stages {
            h.f64(s.propellant_used).f64(s.propellant_left).f64(s.delta_v).f64(s.separated_at.unwrap_or(f64::NAN));
        }
    }
    if let Some(FlownAscent { direct: Some((b, c3)), upper_stage, .. }) = &x.ascent {
        hstr(&mut h, "direct");
        h.f64(b[0]).f64(b[1]).f64(b[2]).f64(b[3]).f64(b[4]).f64(*c3).u32(*upper_stage as u32);
    }
    ReplayResult {
        ok: r.outcome == "completed",
        outcome: r.outcome,
        reason: r.reason,
        events: r.events,
        burns: r.burns,
        delta_v,
        propellant_used,
        elapsed: r.elapsed,
        final_t: r.final_t,
        final_state: r.final_state,
        steps: r.steps,
        digest: h.hex(),
        launch: x.launch,
        stages,
        total_delta_v,
        ascent: x.ascent,
    }
}

fn fail(outcome: &'static str, reason: String) -> ReplayResult {
    finish(Core { outcome, reason, events: Vec::new(), burns: Vec::new(), elapsed: 0.0, final_t: f64::NAN, final_state: Vec::new(), steps: 0 }, Extra::default())
}

/// The JavaScript Error message of a propagation failure.
pub fn propagate_message(e: &PropagateError) -> String {
    match e {
        PropagateError::InvalidBurn(s) => s.clone(),
        PropagateError::Integrator(d) => dop_message(d),
    }
}
fn dop_message(d: &DopError) -> String {
    match d {
        DopError::NonFiniteState { t, h } => format!("non-finite state in step at t={}, h={}: state or derivative is not finite", num(*t), num(*h)),
        DopError::NonFiniteErrorNorm { t, h } => format!("non-finite error norm at t={}, h={}: state or derivative is not finite", num(*t), num(*h)),
        DopError::StepUnderflow { t } => format!("step size underflow at t={}", num(*t)),
        DopError::TEndNotAfter => "step: tEnd must be after current time".into(),
        DopError::InterpolateOutside { t } => format!("interpolate: t={} outside last step", num(*t)),
        DopError::Rhs(s) => s.clone(),
        DopError::Stopped => "stopped".into(),
    }
}

struct Stop {
    outcome: &'static str,
    reason: String,
    t: f64,
    y: Vec<f64>,
}

/// Replay `plan`. `on_step(t, t_prev, view)` observes every accepted step
/// before its events are searched (it must not change anything).
pub fn replay(plan: &Plan, world: &mut MissionWorld<'_>, opts: &ReplayOptions, mut on_start: Option<&mut dyn FnMut(f64, &[f64])>, mut on_step: Option<&mut dyn FnMut(f64, f64, &mut dyn StepEnv)>) -> ReplayResult {
    let d = world.d;
    let errs = validate_plan(plan, d, LaunchCheck::Structural);
    if !errs.is_empty() {
        return fail("invalid-plan", errs.join("; "));
    }
    if !opts.allow_version_mismatch && (plan.model != d.physics_model || plan.data != d.fingerprint) {
        return fail("version-mismatch", format!("plan made for model {} / data {}; this build is model {} / data {}", plan.model, plan.data, d.physics_model, d.fingerprint));
    }
    let body_index = |id: &str| d.bodies.iter().position(|b| b.id == id);
    let epoch = plan.epoch;
    let mut t0 = epoch + simulation_start_offset(&plan.start, d.default_ascent_time_s);
    let t1 = epoch + plan.duration;
    let mut y0 = [0.0f64; STATE_SIZE];
    let mut launch: Option<LaunchInsertion> = None;
    let mut flown: Option<FlownAscent> = None;
    let em = EarthModel::new(d);
    match &plan.start {
        Start::State { center, state } => {
            let Some(c) = body_index(center) else { return fail("invalid-plan", format!("start.center: unknown body {center}")) };
            let mut bs = [0.0; 6];
            crate::spacecraft::Ephemeris::body_state(&mut world.eph, c, t0, &mut bs);
            for j in 0..6 {
                y0[j] = bs[j] + state[j];
            }
        }
        Start::Launch { site, params, .. } => {
            let full = validate_plan(plan, d, LaunchCheck::Full);
            if !full.is_empty() {
                return fail("invalid-plan", full.join("; "));
            }
            let earth_i = body_index("earth");
            let Some(earth_i) = earth_i else { return fail("unsupported-start", "a vehicle launch needs Earth in the body data".into()) };
            let earth = &d.bodies[earth_i];
            let eph = &mut world.eph;
            let mut earth_state = |t: f64, out: &mut [f64; 6]| crate::spacecraft::Ephemeris::body_state(eph, earth_i, t, out);
            let res: Result<Result<LaunchResult, ReplayResult>, String> = (|| {
                if plan.start.is_direct() {
                    if params.len() != 5 {
                        return Err(format!("direct injection expects 5 parameters, got {}", params.len()));
                    }
                    let (lt, az, c3, alt, fs) = (params[0], params[1], params[2], params[3], params[4]);
                    let s = launch_site(d, site)?;
                    let (al, cr) = launch_geometry(&em, s, lt, az);
                    let a = compute_direct_ascent(&plan.stages(), earth.gm, earth.reference_radius, c3, alt, Geometry { along_track: al, cross_track: cr }, &d.ascent_earth)?;
                    let a = match a {
                        Ascent::Refused { reason, .. } => return Ok(Err(fail("invalid-plan", format!("ascent: {reason}")))),
                        Ascent::Ok(a) => a,
                    };
                    if !(a.burnout.time <= fs) {
                        return Ok(Err(fail(
                            "invalid-plan",
                            format!("launch-burnout: the direct ascent burns out {} s after liftoff, after the declared flight start start.params[4] = {} s", num(a.burnout.time), num(fs)),
                        )));
                    }
                    let b = &a.burnout;
                    let bo = BurnoutState { time: b.time, altitude_m: b.altitude_m, horizontal_speed: b.horizontal_speed, radial_speed: b.radial_speed, downrange: b.downrange };
                    let r = direct_injection_state(d, &em, site, lt, az, &bo, &mut earth_state)?;
                    flown = Some(FlownAscent {
                        upper_stage: a.upper_stage,
                        upper_propellant: a.upper_propellant,
                        mass_at_insertion: a.mass_at_insertion,
                        delta_v: a.delta_v,
                        stages: a.stages.clone(),
                        direct: Some(([b.time, b.altitude_m, b.horizontal_speed, b.radial_speed, b.downrange], a.achieved_c3)),
                    });
                    Ok(Ok(r))
                } else {
                    if params.len() < 3 || params.len() > 6 {
                        return Err(format!("launch expects 3..6 parameters, got {}", params.len()));
                    }
                    let c = params.get(5).copied().unwrap_or(0.0);
                    if c != 0.0 && c != 1.0 {
                        return Err(format!("bad circularization code {}", num(c)));
                    }
                    let spec = ParkingOrbitLaunch {
                        site_id: site.clone(),
                        launch_time: params[0],
                        azimuth_deg: params[1],
                        altitude_m: params[2],
                        ascent_time_s: Some(params.get(3).copied().unwrap_or(d.default_ascent_time_s)),
                        downrange_deg: Some(params.get(4).copied().unwrap_or(d.default_downrange_deg)),
                        circularization: Some(Ok(if c == 1.0 { Circularization::TwoBody } else { Circularization::J2Mean })),
                    };
                    let r = launch_state(d, &em, &spec, &mut earth_state)?;
                    if r.t != t0 {
                        return Ok(Err(fail("invalid-plan", format!("launch insertion time {} differs from epoch + ascent {}", num(r.t), num(t0)))));
                    }
                    if plan.start.is_vehicle() {
                        let s = launch_site(d, site)?;
                        let (al, cr) = launch_geometry(&em, s, params[0], params[1]);
                        let a = compute_ascent(&plan.stages(), earth.gm, earth.reference_radius, params[2], Geometry { along_track: al, cross_track: cr }, &d.ascent_earth)?;
                        match a {
                            Ascent::Refused { reason, .. } => return Ok(Err(fail("invalid-plan", format!("ascent: {reason}")))),
                            Ascent::Ok(a) => {
                                flown = Some(FlownAscent {
                                    upper_stage: a.upper_stage,
                                    upper_propellant: a.upper_propellant,
                                    mass_at_insertion: a.mass_at_insertion,
                                    delta_v: a.delta_v,
                                    stages: a.stages.clone(),
                                    direct: None,
                                })
                            }
                        }
                    }
                    Ok(Ok(r))
                }
            })();
            let r = match res {
                Err(m) => return fail("invalid-plan", format!("launch: {m}")),
                Ok(Err(f)) => return f,
                Ok(Ok(r)) => r,
            };
            if plan.start.is_direct() {
                t0 = r.t;
            }
            launch = Some(LaunchInsertion { t: r.t, state: r.state, geocentric: r.geocentric, inclination_deg: r.inclination_deg });
            y0[..6].copy_from_slice(&r.state);
        }
    }
    let stages = plan.stages();
    let n_stages = stages.len();
    let staged = plan.format >= PLAN_FORMAT_STAGED;
    let first_stage = flown.as_ref().map_or(0, |a| a.upper_stage);
    if flown.is_some() {
        let mut issues = staging_issues(plan, first_stage, d.default_ascent_time_s);
        issues.extend(ascent_restart_issues(plan, first_stage));
        if !issues.is_empty() {
            return fail("invalid-plan", issues.iter().map(|i| i.message.clone()).collect::<Vec<_>>().join("; "));
        }
    }
    y0[6] = match &flown {
        Some(a) => a.mass_at_insertion,
        None => mass_above(&stages, -1),
    };
    let cutoff = |k: usize| mass_above(&stages, k as isize) + stages[k].dry_mass;

    let mut burns: Vec<Burn> = Vec::new();
    for (i, b) in plan.burns.iter().enumerate() {
        let e = &stages[plan.burn_stage(b)].engines[b.engine];
        let frame = match &b.frame {
            Frame::Orbital(body) => match body_index(body) {
                Some(k) => BurnFrame::Orbital { body: k },
                None => return fail("invalid-plan", format!("burns[{i}].frame.body: unknown body {body}")),
            },
            Frame::Inertial => BurnFrame::Inertial,
        };
        burns.push(Burn { t_start: epoch + b.start, duration: b.duration, thrust: e.thrust, isp: e.isp, direction: b.direction, frame });
    }

    let wb: Vec<WorldBody> = d.bodies.iter().map(|b| WorldBody { id: &b.id, radius: b.reference_radius, atmosphere: b.atmosphere }).collect();
    let mut finder = match EventFinder::new(&wb, opts.bodies.as_deref(), &opts.spheres, opts.stop_on_atmosphere.unwrap_or(true)) {
        Ok(f) => f,
        Err(m) => return fail("invalid-plan", m),
    };
    let max_steps = opts.max_steps.unwrap_or(2_000_000);
    let max_events = opts.max_events.unwrap_or(200_000);

    let nb = burns.len();
    let mut m_start = vec![f64::NAN; nb];
    let mut m_end = vec![f64::NAN; nb];
    let mut t_first = vec![f64::NAN; nb];
    let mut t_last = vec![f64::NAN; nb];
    let mut bi = 0usize;
    let mut prev_mass = y0[6];
    let mut account = |t_prev: f64, t: f64, m_prev: f64, m: f64| {
        while bi < nb && burns[bi].t_start + burns[bi].duration <= t_prev {
            bi += 1;
        }
        if bi < nb && burns[bi].t_start <= t_prev && t <= burns[bi].t_start + burns[bi].duration && m != m_prev {
            if m_start[bi].is_nan() {
                m_start[bi] = m_prev;
                t_first[bi] = t_prev;
            }
            m_end[bi] = m;
            t_last[bi] = t;
        }
    };

    let mut stage_left = vec![f64::NAN; n_stages];
    let mut separated_at: Vec<Option<f64>> = vec![None; n_stages];
    let mut active = first_stage;
    let mut steps: u64 = 0;
    let mut outcome: &'static str = "completed";
    let mut reason = String::new();
    let final_t: f64;
    let final_y: Vec<f64>;

    if let Some(cb) = on_start.as_deref_mut() {
        cb(t0, &y0);
    }
    let first = finder.start(&mut NoStep(&mut world.eph), t0, &y0);
    if let Some(first) = first {
        outcome = if first.kind == crate::mission::events::EventKind::Impact { "impact" } else { "atmosphere" };
        reason = format!("starts inside {} ({})", first.body, first.kind.name());
        final_t = t0;
        final_y = y0.to_vec();
    } else {
        let sep_times: Vec<f64> = plan.separations.iter().flatten().map(|x| epoch + x).filter(|&t| t < t1).collect();
        let mut y_start = y0;
        let mut t_start = t0;
        let mut res = None;
        let mut stop: Option<Stop> = None;
        let mut perr: Option<String> = None;
        for seg in 0..=sep_times.len() {
            let t_end = if seg < sep_times.len() { sep_times[seg] } else { t1 };
            let popts = PropagateOptions { rtol: plan.rtol, dry_mass: cutoff(active) };
            let mut cb = |v: &mut StepView<'_, '_, ChebEphemeris>| -> bool {
                steps += 1;
                let (t, t_prev) = (v.t(), v.t_prev());
                if let Some(o) = on_step.as_deref_mut() {
                    o(t, t_prev, v);
                }
                let term = match finder.step(v, t, t_prev) {
                    Ok(x) => x,
                    Err(e) => {
                        perr = Some(dop_message(&e));
                        return false;
                    }
                };
                if let Some(term) = term {
                    let mut yi = vec![0.0; STATE_SIZE];
                    if let Err(e) = v.interpolate(term.t, &mut yi) {
                        perr = Some(dop_message(&e));
                        return false;
                    }
                    account(t_prev, term.t, prev_mass, yi[6]);
                    let why = if term.kind == crate::mission::events::EventKind::Impact { "impact" } else { "atmosphere" };
                    stop = Some(Stop { outcome: why, reason: format!("{} at {}, speed {} m/s", term.kind.name(), term.body, fixed(term.speed, 1)), t: term.t, y: yi });
                    return false;
                }
                let y6 = v.y()[6];
                account(t_prev, t, prev_mass, y6);
                prev_mass = y6;
                if steps >= max_steps && t < t1 {
                    stop = Some(Stop { outcome: "step-limit", reason: format!("more than {max_steps} integrator steps"), t, y: v.y().to_vec() });
                    return false;
                }
                if finder.events.len() > max_events {
                    stop = Some(Stop { outcome: "event-limit", reason: format!("more than {max_events} events"), t, y: v.y().to_vec() });
                    return false;
                }
                true
            };
            let r = propagate(&mut world.eph, &mut world.fm, &y_start, t_start, t_end, &burns, &popts, Some(&mut cb));
            if perr.is_some() || stop.is_some() {
                break;
            }
            let r = match r {
                Ok(r) => r,
                Err(e) => {
                    perr = Some(propagate_message(&e));
                    break;
                }
            };
            if seg < sep_times.len() {
                stage_left[active] = r.y[6] - cutoff(active);
                separated_at[active] = Some(t_end - epoch);
                y_start = r.y;
                y_start[6] = mass_above(&stages, active as isize);
                prev_mass = y_start[6];
                active += 1;
                t_start = t_end;
            }
            res = Some(r);
        }
        if let Some(m) = perr {
            let core = Core { outcome: "physics-error", reason: m, events: finder.events.clone(), burns: Vec::new(), elapsed: 0.0, final_t: f64::NAN, final_state: Vec::new(), steps };
            return finish(core, Extra { launch, ascent: flown, staged, stages: None });
        }
        if let Some(s) = stop {
            outcome = s.outcome;
            reason = s.reason;
            final_t = s.t;
            final_y = s.y;
        } else {
            let r = res.unwrap();
            final_y = r.y.to_vec();
            final_t = r.t;
        }
    }

    let mut reports: Vec<BurnReport> = Vec::new();
    for i in 0..nb {
        if m_start[i].is_nan() {
            reports.push(BurnReport { burn_time: 0.0, propellant: 0.0, delta_v: 0.0 });
            continue;
        }
        let ve = burns[i].isp * G0;
        let ln = exact_ln(m_start[i] / m_end[i]).expect("exactLn of a burn's mass ratio");
        reports.push(BurnReport { burn_time: t_last[i] - t_first[i], propellant: m_start[i] - m_end[i], delta_v: ve * ln });
    }
    let mut stage_reports = Vec::new();
    for k in 0..n_stages {
        let au = flown.as_ref().and_then(|a| a.stages.get(k));
        let mut used = au.map_or(0.0, |u| u.propellant_used);
        let mut dv = au.map_or(0.0, |u| u.delta_v);
        for i in 0..nb {
            if plan.burn_stage(&plan.burns[i]) == k {
                used += reports[i].propellant;
                dv += reports[i].delta_v;
            }
        }
        let prop = stages[k].wet_mass - stages[k].dry_mass;
        let dropped = au.is_some_and(|u| u.separated);
        let left = if dropped {
            au.unwrap().propellant_left
        } else if separated_at[k].is_some() {
            stage_left[k]
        } else if k == active && final_y.len() == STATE_SIZE {
            final_y[6] - cutoff(k)
        } else {
            prop - used
        };
        stage_reports.push(StageReport {
            stage: k,
            propellant_used: used,
            propellant_left: left,
            delta_v: dv,
            ascent_delta_v: au.map_or(0.0, |u| u.delta_v),
            separated_at: if dropped { Some(au.unwrap().time) } else { separated_at[k] },
            dropped_in_ascent: dropped,
        });
    }
    let elapsed = if outcome == "completed" { plan.duration } else { final_t - epoch };
    let core = Core { outcome, reason, events: finder.events.clone(), burns: reports, elapsed, final_t, final_state: final_y, steps };
    finish(core, Extra { launch, ascent: flown, staged, stages: Some(stage_reports) })
}
