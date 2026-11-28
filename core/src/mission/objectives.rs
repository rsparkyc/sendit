//! Port of src/mission/objectives.ts (mission types, evaluate with every
//! objective kind and its details, the score and leaderboard keys,
//! compareKeys, missionForSite, allowedSites, checkPlanConformance) and of the
//! computed parts of src/mission/campaign-sites.ts (parSite, sitePar,
//! offeredSites, loosestLimits). Types are filled from
//! core/data/mission-data.json by mdata.rs. Same operations in the same
//! order as the TypeScript; messages formatted with jsfmt (String(x),
//! toFixed).

use crate::dmath::{cos, DEG, PI};
use crate::fixture::World;
use crate::mission::events::{EventKind, TrajectoryEvent};
use crate::mission::jsfmt::{fixed, num};
use crate::mission::plan::{Engine, Plan, Stage, Start};
use crate::mission::replay::{MissionWorld, ReplayResult};
use crate::orientation::{PoleTable, POLE_NODE_SPACING};

#[derive(Clone, Debug, PartialEq)]
pub enum Objective {
    Flyby { body: String, min_altitude: Option<f64>, max_altitude: Option<f64>, max_speed: Option<f64> },
    Visit { body: String, within: f64 },
    Orbit { body: String, periapsis: [f64; 2], apoapsis: [f64; 2], inclination: Option<[f64; 2]>, reference_frame: bool, revolutions: f64 },
    Reentry { body: String, max_speed: Option<f64> },
    Return { body: String, max_altitude: f64 },
    Escape { body: String, min_speed: f64 },
    Sequence(Vec<Objective>),
    MaxDeltaV(f64),
    MaxTime(f64),
}

impl Objective {
    pub fn kind(&self) -> &'static str {
        match self {
            Objective::Flyby { .. } => "flyby",
            Objective::Visit { .. } => "visit",
            Objective::Orbit { .. } => "orbit",
            Objective::Reentry { .. } => "reentry",
            Objective::Return { .. } => "return",
            Objective::Escape { .. } => "escape",
            Objective::Sequence(_) => "sequence",
            Objective::MaxDeltaV(_) => "max-delta-v",
            Objective::MaxTime(_) => "max-time",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScoreWeights {
    pub delta_v_ref: f64,
    pub delta_v_weight: f64,
    pub time_ref: f64,
    pub time_weight: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FixedLaunchRule {
    pub altitude_m: f64,
    pub ascent_time_s: f64,
    pub downrange_deg: f64,
    pub two_body: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VehicleRule {
    pub lower_stages: Vec<Stage>,
    pub altitude: [f64; 2],
    pub ascent_time_s: f64,
    pub downrange_deg: f64,
    pub two_body: bool,
    pub direct_injection_altitude: Option<[f64; 2]>,
    pub direct_c3: Option<[f64; 2]>,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct StartRules {
    pub sites: Option<Vec<String>>,
    pub window: Option<[f64; 2]>,
    pub altitude: Option<[f64; 2]>,
    pub launch_only: bool,
    pub launch: Option<FixedLaunchRule>,
    pub vehicle: Option<VehicleRule>,
    pub launch_modes: Option<Vec<String>>,
    pub non_restartable_vehicle: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum MissionStart {
    Launch { site: String, azimuth_deg: f64, altitude_m: f64 },
    State { center: String, state: Vec<f64> },
}

#[derive(Clone, Debug, PartialEq)]
pub enum SiteOption {
    /// `delta_v`, `ascent_delta_v`, `time`: the site's reference solution (campaign-sites.ts).
    Offered { site: String, delta_v: Option<f64>, ascent_delta_v: Option<f64>, time: Option<f64>, max_delta_v: f64, max_time: f64 },
    NotOffered { site: String, reason: String },
}

impl SiteOption {
    pub fn site(&self) -> &str {
        match self {
            SiteOption::Offered { site, .. } | SiteOption::NotOffered { site, .. } => site,
        }
    }
    pub fn offered(&self) -> bool {
        matches!(self, SiteOption::Offered { .. })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Mission {
    pub id: String,
    pub title: String,
    pub version: Option<f64>,
    pub objectives: Vec<Objective>,
    pub scoring: ScoreWeights,
    pub spheres: Option<Vec<(String, f64)>>,
    pub epoch: Option<f64>,
    pub start: Option<MissionStart>,
    pub rules: Option<StartRules>,
    pub spacecraft: Option<Stage>,
    pub max_duration: Option<f64>,
    pub atmosphere_is_failure: Option<bool>,
    pub launch_sites: Option<Vec<SiteOption>>,
}

// ------------------------------------------------------------------ score

pub const PAR_SCORE: f64 = 10_000.0;

/// Math.max (NaN wins; +0 over -0).
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == b {
        return if a == 0.0 && a.is_sign_negative() { b } else { a };
    }
    if a > b { a } else { b }
}

/// Math.min (NaN wins; -0 over +0).
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == b {
        return if a == 0.0 && a.is_sign_positive() { b } else { a };
    }
    if a < b { a } else { b }
}

/// deltaVKey: tenths of m/s, rounded up.
pub fn delta_v_key(delta_v: f64) -> f64 {
    (delta_v * 10.0).ceil()
}

/// timeKey: whole seconds, rounded up.
pub fn time_key(mission_time: f64) -> f64 {
    mission_time.ceil()
}

pub fn score(success: bool, delta_v: f64, mission_time: f64, w: &ScoreWeights) -> f64 {
    if !success {
        return 0.0;
    }
    let dv = delta_v_key(delta_v) / 10.0;
    let t = time_key(mission_time);
    let cost = ((w.delta_v_weight * dv) / w.delta_v_ref + (w.time_weight * t) / w.time_ref) / (w.delta_v_weight + w.time_weight);
    if !(cost > 0.0) {
        return 0.0;
    }
    (PAR_SCORE / cost).floor()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LeaderboardKeys {
    pub score: f64,
    pub delta_v: f64,
    pub time: f64,
}

pub fn leaderboard_keys(success: bool, delta_v: f64, mission_time: f64, w: &ScoreWeights) -> Option<LeaderboardKeys> {
    if !success {
        return None;
    }
    Some(LeaderboardKeys { score: score(true, delta_v, mission_time, w), delta_v: delta_v_key(delta_v), time: time_key(mission_time) })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Board {
    Combined,
    DeltaV,
    Time,
}

/// `x || y` on numbers: x unless it is 0 or NaN.
fn or(x: f64, y: f64) -> f64 {
    if x == 0.0 || x.is_nan() { y } else { x }
}

/// compareKeys (negative: a ranks first).
pub fn compare_keys(board: Board, a: &LeaderboardKeys, b: &LeaderboardKeys) -> f64 {
    match board {
        Board::Combined => or(or(b.score - a.score, a.delta_v - b.delta_v), a.time - b.time),
        Board::DeltaV => or(a.delta_v - b.delta_v, a.time - b.time),
        Board::Time => or(a.time - b.time, a.delta_v - b.delta_v),
    }
}

// ------------------------------------------------------------- the world

/// bodyPoleAt's data: per body (MissionData order) its IAU pole table (the
/// shared PoleTable the physics uses) or its static J2000 pole.
pub struct Poles {
    tables: Vec<Option<PoleTable>>,
    statics: Vec<Option<[f64; 3]>>,
}

impl Poles {
    pub fn new(world: &World, d: &crate::mission::mdata::MissionData) -> Poles {
        Poles {
            tables: d.bodies.iter().map(|b| b.rotation.as_ref().map(|id| PoleTable::new(world.model(id).clone(), POLE_NODE_SPACING))).collect(),
            statics: d.bodies.iter().map(|b| b.pole).collect(),
        }
    }
    /// bodyPoleAt(world, k, t, out).
    pub fn at(&mut self, k: usize, t: f64, out: &mut [f64; 3]) -> bool {
        if let Some(tab) = &mut self.tables[k] {
            tab.at(t, out);
            return true;
        }
        match self.statics[k] {
            Some(p) => {
                out[0] = p[0];
                out[1] = p[1];
                out[2] = p[2];
                true
            }
            None => false,
        }
    }
}

struct Ctx<'a, 'w, 'd> {
    result: &'a ReplayResult,
    world: &'a mut MissionWorld<'d>,
    poles: &'w mut Poles,
}

impl Ctx<'_, '_, '_> {
    fn body_index(&self, id: &str) -> Option<usize> {
        self.world.d.bodies.iter().position(|b| b.id == id)
    }
}

struct Met {
    t: Option<f64>,
    detail: String,
}
fn met(t: Option<f64>, detail: String) -> Met {
    Met { t, detail }
}

fn events_of<'a>(ctx: &'a Ctx, body: &str, after: f64, kinds: &[EventKind]) -> Vec<&'a TrajectoryEvent> {
    ctx.result.events.iter().filter(|e| e.body == body && e.t > after && kinds.contains(&e.kind)).collect()
}

fn cross(r: &[f64; 6]) -> [f64; 3] {
    [r[1] * r[5] - r[2] * r[4], r[2] * r[3] - r[0] * r[5], r[0] * r[4] - r[1] * r[3]]
}

fn fmt_km(m: f64) -> String {
    format!("{} km", fixed(m / 1000.0, 1))
}

/// Earliest time > after at which the goal is met.
fn goal(o: &Objective, ctx: &mut Ctx, after: f64) -> Met {
    match o {
        Objective::Flyby { body, min_altitude, max_altitude, max_speed } => {
            let lo = min_altitude.unwrap_or(f64::NEG_INFINITY);
            let hi = max_altitude.unwrap_or(f64::INFINITY);
            let ps = events_of(ctx, body, after, &[EventKind::Periapsis]);
            let vmax = max_speed.unwrap_or(f64::INFINITY);
            if let Some(hit) = ps.iter().find(|e| e.altitude >= lo && e.altitude <= hi && e.speed <= vmax) {
                let sp = if max_speed.is_some() { format!(" at {} km/s", fixed(hit.speed / 1000.0, 2)) } else { String::new() };
                return met(Some(hit.t), format!("closest approach {} altitude{sp}", fmt_km(hit.altitude)));
            }
            if let Some(fast) = ps.iter().find(|e| e.altitude >= lo && e.altitude <= hi) {
                return met(None, format!("closest approach {} altitude at {} km/s, faster than {} km/s", fmt_km(fast.altitude), fixed(fast.speed / 1000.0, 2), fixed(vmax / 1000.0, 2)));
            }
            let mut best: Option<&TrajectoryEvent> = None;
            for e in &ps {
                if best.is_none() || e.altitude < best.unwrap().altitude {
                    best = Some(e);
                }
            }
            met(None, match best {
                Some(b) => format!("closest approach {} altitude, outside the band", fmt_km(b.altitude)),
                None => format!("no close approach to {body}"),
            })
        }
        Objective::Visit { body, within } => match events_of(ctx, body, after, &[EventKind::Periapsis]).into_iter().find(|e| e.distance <= *within) {
            Some(hit) => met(Some(hit.t), format!("passed within {}", fmt_km(hit.distance))),
            None => met(None, format!("never within {} of {body}", fmt_km(*within))),
        },
        Objective::Return { body, max_altitude } => {
            match events_of(ctx, body, after, &[EventKind::Periapsis, EventKind::AtmosphereEntry]).into_iter().find(|e| e.kind == EventKind::AtmosphereEntry || e.altitude <= *max_altitude) {
                Some(hit) => met(Some(hit.t), format!("returned to {body} ({}, {})", hit.kind.name(), fmt_km(hit.altitude))),
                None => met(None, format!("no return to {body}")),
            }
        }
        Objective::Reentry { body, max_speed } => {
            let r = ctx.result;
            let last = r.events.last();
            let last = match last {
                Some(l) if r.outcome == "atmosphere" && l.body == *body && l.t > after => l,
                _ => return met(None, format!("flight did not end in {body}'s atmosphere")),
            };
            if let Some(ms) = max_speed {
                if last.speed > *ms {
                    return met(None, format!("entry at {} m/s exceeds {} m/s", fixed(last.speed, 0), num(*ms)));
                }
            }
            met(Some(last.t), format!("entered at {} m/s", fixed(last.speed, 0)))
        }
        Objective::Escape { body, min_speed } => {
            let r = ctx.result;
            if r.outcome != "completed" || !(r.final_t > after) {
                return met(None, "flight did not complete".into());
            }
            // bodyIndexOf; an unknown body is not reachable from mission data (the TypeScript would read gm[-1]).
            let k = ctx.body_index(body).expect("escape: unknown body");
            let mut bs = [0.0; 6];
            crate::spacecraft::Ephemeris::body_state(&mut ctx.world.eph, k, r.final_t, &mut bs);
            let y = &r.final_state;
            let mut r2 = 0.0;
            let mut v2 = 0.0;
            for j in 0..3 {
                r2 += (y[j] - bs[j]) * (y[j] - bs[j]);
                v2 += (y[j + 3] - bs[j + 3]) * (y[j + 3] - bs[j + 3]);
            }
            let gm = crate::spacecraft::Ephemeris::gm(&ctx.world.eph)[k];
            let vinf2 = v2 - (2.0 * gm) / r2.sqrt();
            let ok = vinf2 >= min_speed * min_speed;
            let shown = if vinf2 > 0.0 { format!("{} m/s", fixed(vinf2.sqrt(), 0)) } else { "bound".into() };
            met(if ok { Some(r.final_t) } else { None }, format!("excess speed {shown}"))
        }
        Objective::Orbit { .. } => orbit_goal(o, ctx, after),
        Objective::Sequence(steps) => {
            let mut t = after;
            let mut parts: Vec<String> = Vec::new();
            for (i, s) in steps.iter().enumerate() {
                let m = goal(s, ctx, t);
                match m.t {
                    None => return met(None, format!("step {} ({}) not met after step {i}: {}", i + 1, s.kind(), m.detail)),
                    Some(mt) => {
                        parts.push(m.detail);
                        t = mt;
                    }
                }
            }
            met(Some(t), parts.join("; then "))
        }
        Objective::MaxDeltaV(_) | Objective::MaxTime(_) => met(None, String::new()),
    }
}

fn orbit_goal(o: &Objective, ctx: &mut Ctx, after: f64) -> Met {
    let Objective::Orbit { body, periapsis, apoapsis, inclination, reference_frame, revolutions } = o else { unreachable!() };
    let k = match ctx.body_index(body) {
        Some(k) => k,
        None => return met(None, format!("unknown body {body}")),
    };
    let mu = crate::spacecraft::Ephemeris::gm(&ctx.world.eph)[k];
    let mut axis = [0.0, 0.0, 1.0];
    let use_equator = !reference_frame;
    let inc = *inclination;
    let cos_hi = match inc {
        Some(b) => cos(b[1] * DEG),
        None => -1.0,
    };
    let cos_lo = match inc {
        Some(b) => cos(b[0] * DEG),
        None => 1.0,
    };
    let ext: Vec<TrajectoryEvent> = events_of(ctx, body, after, &[EventKind::Periapsis, EventKind::Apoapsis]).into_iter().cloned().collect();
    let poles = &mut *ctx.poles;
    let mut in_band = |e: &TrajectoryEvent| -> bool {
        let band = if e.kind == EventKind::Periapsis { periapsis } else { apoapsis };
        if !(e.distance >= band[0] && e.distance <= band[1]) {
            return false;
        }
        if inc.is_none() {
            return true;
        }
        if !use_equator || !poles.at(k, e.t, &mut axis) {
            axis[0] = 0.0;
            axis[1] = 0.0;
            axis[2] = 1.0;
        }
        let h = cross(&e.rel);
        let hn = (h[0] * h[0] + h[1] * h[1] + h[2] * h[2]).sqrt();
        let hk = h[0] * axis[0] + h[1] * axis[1] + h[2] * axis[2];
        hk >= cos_hi * hn && hk <= cos_lo * hn
    };
    let mut best = 0.0;
    let mut s = 0;
    while s < ext.len() {
        if !in_band(&ext[s]) {
            s += 1;
            continue;
        }
        let mut rp = f64::NAN;
        let mut ra = f64::NAN;
        let mut need = f64::INFINITY;
        let mut j = s;
        while j < ext.len() && in_band(&ext[j]) {
            let e = &ext[j];
            if e.kind == EventKind::Periapsis && rp.is_nan() {
                rp = e.distance;
            }
            if e.kind == EventKind::Apoapsis && ra.is_nan() {
                ra = e.distance;
            }
            if need == f64::INFINITY && !rp.is_nan() && !ra.is_nan() {
                let a = 0.5 * (rp + ra);
                need = ext[s].t + revolutions * 2.0 * PI * ((a * a * a) / mu).sqrt();
            }
            if e.t >= need {
                return met(Some(e.t), format!("held {} revolutions (rp {} km, ra {} km)", num(*revolutions), fixed(rp / 1000.0, 0), fixed(ra / 1000.0, 0)));
            }
            if need != f64::INFINITY {
                best = js_max(best, ((e.t - ext[s].t) / (need - ext[s].t)) * revolutions);
            }
            j += 1;
        }
        s = j + 1;
    }
    let ext0 = if !ext.is_empty() {
        let parts: Vec<String> = ext.iter().take(2).map(|e| format!("{} {} km", e.kind.name(), fixed(e.distance / 1000.0, 0))).collect();
        format!("; first extrema {}", parts.join(", "))
    } else {
        String::new()
    };
    met(None, format!("orbit held for at most {} of {} revolutions{ext0}", fixed(best, 2), num(*revolutions)))
}

#[derive(Clone, Debug, PartialEq)]
pub struct ObjectiveResult {
    pub objective: Objective,
    pub ok: bool,
    pub at: Option<f64>,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Evaluation {
    pub success: bool,
    pub objectives: Vec<ObjectiveResult>,
    pub delta_v: f64,
    pub ascent_delta_v: f64,
    pub flight_delta_v: f64,
    pub mission_time: f64,
    pub score: f64,
    pub keys: Option<LeaderboardKeys>,
    pub rule_violations: Option<Vec<String>>,
    pub site: Option<String>,
}

fn uses_reentry(o: &Objective) -> bool {
    match o {
        Objective::Reentry { .. } | Objective::Return { .. } => true,
        Objective::Sequence(s) => s.iter().any(uses_reentry),
        _ => false,
    }
}

/// evaluate(mission, result, world, epoch, plan?).
pub fn evaluate(mission0: &Mission, result: &ReplayResult, world: &mut MissionWorld<'_>, poles: &mut Poles, epoch: f64, plan: Option<&Plan>) -> Evaluation {
    let site = plan.and_then(plan_launch_site);
    let mission = match &site {
        None => mission0.clone(),
        Some(s) => mission_for_site(mission0, s),
    };
    let d = world.d;
    let mut ctx = Ctx { result, world, poles };
    let mut out: Vec<ObjectiveResult> = Vec::new();
    let mut last = f64::NEG_INFINITY;
    for o in &mission.objectives {
        if matches!(o, Objective::MaxDeltaV(_) | Objective::MaxTime(_)) {
            continue;
        }
        let m = goal(o, &mut ctx, f64::NEG_INFINITY);
        out.push(ObjectiveResult { objective: o.clone(), ok: m.t.is_some(), at: m.t, detail: m.detail });
        if let Some(t) = m.t {
            if t > last {
                last = t;
            }
        }
    }
    let goals_ok = out.iter().all(|r| r.ok);
    let mission_time = if last == f64::NEG_INFINITY { result.elapsed } else { last - epoch };
    let dv = result.total_delta_v;
    // result.ascent is the parking-orbit ascent only (a direct injection is directAscent in the TypeScript).
    let ascent_dv = match &result.ascent {
        Some(a) if a.direct.is_none() => a.delta_v,
        _ => 0.0,
    };
    for o in &mission.objectives {
        match o {
            Objective::MaxDeltaV(max) => out.push(ObjectiveResult {
                objective: o.clone(),
                ok: dv <= *max,
                at: None,
                detail: if ascent_dv > 0.0 {
                    format!("used {} of {} m/s (ascent {} + flight {})", fixed(dv, 1), num(*max), fixed(ascent_dv, 1), fixed(result.delta_v, 1))
                } else {
                    format!("used {} of {} m/s", fixed(dv, 1), num(*max))
                },
            }),
            Objective::MaxTime(max) => out.push(ObjectiveResult { objective: o.clone(), ok: goals_ok && mission_time <= *max, at: None, detail: format!("took {} of {} s", fixed(mission_time, 0), num(*max)) }),
            _ => {}
        }
    }
    let atm_ok = mission.atmosphere_is_failure == Some(false) || out.iter().any(|r| r.ok && uses_reentry(&r.objective));
    let ended = result.outcome == "completed" || (result.outcome == "atmosphere" && atm_ok);
    let rule_violations = plan.map(|p| mission_rule_violations(&mission, p, d.default_ascent_time_s, d.default_downrange_deg));
    let success = ended && out.iter().all(|r| r.ok) && rule_violations.as_ref().is_none_or(|v| v.is_empty());
    let keys = leaderboard_keys(success, dv, mission_time, &mission.scoring);
    Evaluation {
        success,
        objectives: out,
        delta_v: dv,
        ascent_delta_v: ascent_dv,
        flight_delta_v: result.delta_v,
        mission_time,
        score: keys.map(|k| k.score).unwrap_or(0.0),
        keys,
        rule_violations,
        site,
    }
}

pub fn plan_launch_site(plan: &Plan) -> Option<String> {
    match &plan.start {
        Start::Launch { site, .. } => Some(site.clone()),
        Start::State { .. } => None,
    }
}

pub fn site_option<'a>(mission: &'a Mission, site: &str) -> Option<&'a SiteOption> {
    mission.launch_sites.as_ref()?.iter().find(|s| s.site() == site)
}

/// allowedSites: offered launchSites filtered by rules.sites (either alone when only one is given).
pub fn allowed_sites(mission: &Mission) -> Option<Vec<String>> {
    let offered: Option<Vec<String>> = mission.launch_sites.as_ref().map(|l| l.iter().filter(|s| s.offered()).map(|s| s.site().to_string()).collect());
    let r = mission.rules.as_ref().and_then(|r| r.sites.as_ref());
    match (offered, r) {
        (Some(o), Some(r)) => Some(o.into_iter().filter(|x| r.contains(x)).collect()),
        (Some(o), None) => Some(o),
        (None, r) => r.cloned(),
    }
}

/// missionForSite: the offered site's limits replace max-delta-v / max-time.
pub fn mission_for_site(mission: &Mission, site: &str) -> Mission {
    let (mdv, mt) = match site_option(mission, site) {
        Some(SiteOption::Offered { max_delta_v, max_time, .. }) => (*max_delta_v, *max_time),
        _ => return mission.clone(),
    };
    let mut m = mission.clone();
    m.objectives = mission
        .objectives
        .iter()
        .map(|x| match x {
            Objective::MaxDeltaV(_) => Objective::MaxDeltaV(mdv),
            Objective::MaxTime(_) => Objective::MaxTime(mt),
            x => x.clone(),
        })
        .collect();
    m
}

// ------------------------------------------------------------ conformance

#[derive(Clone, Debug, PartialEq)]
pub struct ConformanceIssue {
    pub code: &'static str,
    pub path: String,
    pub message: String,
}

pub const OLD_VERSION_MESSAGE: &str = "this plan was made for an earlier version of the mission, whose launch delivered the spacecraft to its parking orbit free of charge; this version launches on its vehicle and charges the ascent, so the plan must be rebuilt";

fn same_flags(a: &Engine, b: &Engine) -> bool {
    (a.restartable == Some(false)) == (b.restartable == Some(false)) && (a.throttleable == Some(false)) == (b.throttleable == Some(false))
}

/// Object.is.
pub fn same_bits(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
}

fn stage_same(a: &Stage, b: &Stage) -> bool {
    same_bits(a.wet_mass, b.wet_mass)
        && same_bits(a.dry_mass, b.dry_mass)
        && a.engines.len() == b.engines.len()
        && a.engines.iter().enumerate().all(|(i, e)| same_bits(e.thrust, b.engines[i].thrust) && same_bits(e.isp, b.engines[i].isp) && same_flags(e, &b.engines[i]))
}

fn circ_name(two_body: bool) -> &'static str {
    if two_body { "two-body" } else { "j2-mean" }
}

/// checkPlanConformance. `default_ascent` / `default_downrange`: the launch model's defaults (DEFAULT_ASCENT_TIME_S, DEFAULT_DOWNRANGE_DEG).
pub fn check_plan_conformance(mission: &Mission, plan: &Plan, default_ascent: f64, default_downrange: f64) -> Vec<ConformanceIssue> {
    let mut out: Vec<ConformanceIssue> = Vec::new();
    let mut add = |code: &'static str, path: String, message: String| out.push(ConformanceIssue { code, path, message });
    let r = mission.rules.as_ref();
    let v_rule = r.and_then(|r| r.vehicle.as_ref());
    let empty: Vec<Stage> = Vec::new();
    let pl = plan.lower_stages.as_ref().unwrap_or(&empty);
    let st = &plan.start;
    let is_launch = matches!(st, Start::Launch { .. });
    if v_rule.is_some() && is_launch && !st.is_flown() && pl.is_empty() {
        add("start-kind", "start.ascent".into(), OLD_VERSION_MESSAGE.into());
        return out;
    }
    if let Some(sc) = &mission.spacecraft {
        let p = &plan.spacecraft;
        if p.engines.len() == sc.engines.len() {
            for (i, e) in sc.engines.iter().enumerate() {
                if !same_flags(&p.engines[i], e) {
                    add("spacecraft", format!("spacecraft.engines[{i}]"), format!("engine {i} must have the mission spacecraft's restartable / throttleable flags"));
                }
            }
        }
        if !same_bits(p.wet_mass, sc.wet_mass) {
            add("spacecraft", "spacecraft.wetMass".into(), format!("wet mass must be {} kg (mission spacecraft), got {}", num(sc.wet_mass), num(p.wet_mass)));
        }
        if !same_bits(p.dry_mass, sc.dry_mass) {
            add("spacecraft", "spacecraft.dryMass".into(), format!("dry mass must be {} kg (mission spacecraft), got {}", num(sc.dry_mass), num(p.dry_mass)));
        }
        if p.engines.len() != sc.engines.len() {
            add("spacecraft", "spacecraft.engines".into(), format!("the mission spacecraft has {} engine(s), plan has {}", sc.engines.len(), p.engines.len()));
        } else {
            for (i, e) in sc.engines.iter().enumerate() {
                if !same_bits(p.engines[i].thrust, e.thrust) {
                    add("spacecraft", format!("spacecraft.engines[{i}].thrust"), format!("engine {i} thrust must be {} N, got {}", num(e.thrust), num(p.engines[i].thrust)));
                }
                if !same_bits(p.engines[i].isp, e.isp) {
                    add("spacecraft", format!("spacecraft.engines[{i}].isp"), format!("engine {i} Isp must be {} s, got {}", num(e.isp), num(p.engines[i].isp)));
                }
            }
        }
    }
    if let Some(v) = v_rule {
        if pl.len() != v.lower_stages.len() {
            add("vehicle", "lowerStages".into(), format!("the mission vehicle has {} stage(s) below the spacecraft, the plan has {}", v.lower_stages.len(), pl.len()));
        } else {
            for (k, s) in v.lower_stages.iter().enumerate() {
                if !stage_same(&pl[k], s) {
                    add("vehicle", format!("lowerStages[{k}]"), format!("stage {k} must be the mission vehicle's (wet {} kg, dry {} kg, {} engine(s)), bit for bit", num(s.wet_mass), num(s.dry_mass), s.engines.len()));
                }
            }
        }
        if is_launch && !st.is_flown() {
            add("start-kind", "start.ascent".into(), "this mission launches on its vehicle (a vehicle launch)".into());
        }
    } else if mission.spacecraft.is_some() && !pl.is_empty() {
        add("vehicle", "lowerStages".into(), "this mission has no launch vehicle: the plan may not add stages".into());
    }
    let mission_launch_start = matches!(mission.start, Some(MissionStart::Launch { .. }));
    if v_rule.is_none() && st.is_flown() && (r.is_some_and(|r| r.launch.is_some()) || mission_launch_start) {
        add("start-kind", "start.ascent".into(), "this mission delivers the spacecraft to its parking orbit (not a vehicle launch)".into());
    }
    if let Some(md) = mission.max_duration {
        if !(plan.duration <= md) {
            add("duration", "duration".into(), format!("duration {} s exceeds the mission limit {} s", num(plan.duration), num(md)));
        }
    }
    let must_launch = r.is_some_and(|r| r.launch_only) || mission_launch_start;
    if must_launch && !is_launch {
        add("start-kind", "start.kind".into(), "this mission starts with a launch".into());
    }
    if let Some(MissionStart::State { center: mc, state: ms }) = &mission.start {
        match st {
            Start::State { center, state } => {
                if center != mc || state.len() != ms.len() || !state.iter().enumerate().all(|(i, v)| same_bits(*v, ms[i])) {
                    add("start-state", "start.state".into(), "the start state must be the mission's".into());
                }
            }
            _ => add("start-kind", "start.kind".into(), "this mission starts from a given orbit, not a launch".into()),
        }
        if let Some(me) = mission.epoch {
            if !same_bits(plan.epoch, me) && !r.is_some_and(|r| r.window.is_some()) {
                add("launch-window", "epoch".into(), format!("start time must be {}", num(me)));
            }
        }
    }
    if let Start::Launch { site, .. } = st {
        if r.is_some_and(|r| r.sites.is_some()) || mission.launch_sites.is_some() {
            let o = site_option(mission, site);
            let allowed = allowed_sites(mission).unwrap_or_default();
            if let Some(SiteOption::NotOffered { reason, .. }) = o {
                add("launch-site", "start.site".into(), format!("launch site {site} not offered for this mission: {reason} (allowed: {})", allowed.join(", ")));
            } else if !allowed.iter().any(|x| x == site) {
                add("launch-site", "start.site".into(), format!("launch site {site} not allowed (allowed: {})", allowed.join(", ")));
            }
        }
    }
    if let Some(r) = r {
        if let Some(w) = r.window {
            if !(plan.epoch >= w[0] && plan.epoch <= w[1]) {
                add("launch-window", "epoch".into(), format!("start time {} outside the window {}..{}", num(plan.epoch), num(w[0]), num(w[1])));
            }
        }
        let direct = st.is_direct();
        if is_launch {
            let default_modes = vec!["parking-orbit".to_string()];
            let modes = r.launch_modes.as_ref().unwrap_or(&default_modes);
            let mode = if direct { "direct" } else { "parking-orbit" };
            if !modes.iter().any(|m| m == mode) {
                add("launch-mode", "start.ascent".into(), format!("this mission does not allow {} (allowed: {})", if mode == "direct" { "direct injection" } else { "a parking-orbit launch" }, modes.join(", ")));
            }
        }
        if r.non_restartable_vehicle {
            for (k, s) in pl.iter().enumerate() {
                for (i, e) in s.engines.iter().enumerate() {
                    if e.restartable != Some(false) {
                        add("vehicle-restartable", format!("lowerStages[{k}].engines[{i}].restartable"), format!("this mission needs a vehicle whose stages cannot restart: stage {k} engine {i} is restartable"));
                    }
                }
            }
            if pl.is_empty() {
                add("vehicle-restartable", "lowerStages".into(), "this mission needs a launch vehicle whose stages cannot restart".into());
            }
        }
        let params: &[f64] = match st {
            Start::Launch { params, .. } => params,
            _ => &[],
        };
        let p = |i: usize| params.get(i).copied();
        let pn = |i: usize| params.get(i).copied().unwrap_or(f64::NAN);
        if let Some(alt) = r.altitude {
            if is_launch && !direct && !(pn(2) >= alt[0] && pn(2) <= alt[1]) {
                add("launch-altitude", "start.params[2]".into(), format!("parking altitude {} m outside {}..{} m", num(pn(2)), num(alt[0]), num(alt[1])));
            }
        }
        if let Some(l) = &r.launch {
            if is_launch && !direct {
                let ascent = p(3).unwrap_or(default_ascent);
                let downrange = p(4).unwrap_or(default_downrange);
                let circ = circ_name(p(5).unwrap_or(0.0) == 1.0);
                if !same_bits(pn(2), l.altitude_m) {
                    add("launch-altitude", "start.params[2]".into(), format!("this mission fixes the parking orbit at {} km altitude, got {} km", num(l.altitude_m / 1000.0), num(pn(2) / 1000.0)));
                }
                if !same_bits(ascent, l.ascent_time_s) {
                    add("launch-ascent", "start.params[3]".into(), format!("this mission fixes the ascent time at {} s, got {}", num(l.ascent_time_s), num(ascent)));
                }
                if !same_bits(downrange, l.downrange_deg) {
                    add("launch-ascent", "start.params[4]".into(), format!("this mission fixes the downrange angle at {}°, got {}", num(l.downrange_deg), num(downrange)));
                }
                if circ != circ_name(l.two_body) {
                    add("launch-ascent", "start.params[5]".into(), format!("this mission fixes the circularisation at {}, got {circ}", circ_name(l.two_body)));
                }
            }
        }
        if let (Some(v), true) = (v_rule, direct) {
            let hb = v.direct_injection_altitude.unwrap_or(v.altitude);
            if !(pn(3) >= hb[0] && pn(3) <= hb[1]) {
                add("launch-altitude", "start.params[3]".into(), format!("injection altitude {} km outside this mission's {}..{} km", num(pn(3) / 1000.0), num(hb[0] / 1000.0), num(hb[1] / 1000.0)));
            }
            if let Some(cb) = v.direct_c3 {
                if !(pn(2) >= cb[0] && pn(2) <= cb[1]) {
                    add("launch-c3", "start.params[2]".into(), format!("target C3 {} km^2/s^2 outside this mission's {}..{} km^2/s^2", num(pn(2) / 1e6), num(cb[0] / 1e6), num(cb[1] / 1e6)));
                }
            }
        } else if let (Some(v), true) = (v_rule, is_launch) {
            let ascent = p(3).unwrap_or(default_ascent);
            let downrange = p(4).unwrap_or(default_downrange);
            let circ = circ_name(p(5).unwrap_or(0.0) == 1.0);
            if !(pn(2) >= v.altitude[0] && pn(2) <= v.altitude[1]) {
                add("launch-altitude", "start.params[2]".into(), format!("parking altitude {} km outside this mission's {}..{} km", num(pn(2) / 1000.0), num(v.altitude[0] / 1000.0), num(v.altitude[1] / 1000.0)));
            }
            if !same_bits(ascent, v.ascent_time_s) {
                add("launch-ascent", "start.params[3]".into(), format!("this mission fixes the ascent time at {} s, got {}", num(v.ascent_time_s), num(ascent)));
            }
            if !same_bits(downrange, v.downrange_deg) {
                add("launch-ascent", "start.params[4]".into(), format!("this mission fixes the downrange angle at {}°, got {}", num(v.downrange_deg), num(downrange)));
            }
            if circ != circ_name(v.two_body) {
                add("launch-ascent", "start.params[5]".into(), format!("this mission fixes the circularisation at {}, got {circ}", circ_name(v.two_body)));
            }
        }
    }
    out
}

pub fn mission_rule_violations(mission: &Mission, plan: &Plan, default_ascent: f64, default_downrange: f64) -> Vec<String> {
    check_plan_conformance(mission, plan, default_ascent, default_downrange).into_iter().map(|i| i.message).collect()
}

/// missionReplayOptions: the mission's spheres, stopOnAtmosphere.
pub fn mission_replay_options(mission: &Mission) -> crate::mission::replay::ReplayOptions {
    crate::mission::replay::ReplayOptions { spheres: mission.spheres.clone().unwrap_or_default(), stop_on_atmosphere: Some(true), ..Default::default() }
}

// --------------------------------------------------------- campaign-sites

/// parSite: the offered site with the lowest reference delta-v (ties: the earlier).
pub fn par_site(sites: &[SiteOption]) -> Option<String> {
    let mut best: Option<(&str, f64)> = None;
    for o in sites {
        if let SiteOption::Offered { site, delta_v, .. } = o {
            let dv = delta_v.unwrap_or(f64::NAN);
            if best.is_none() || dv < best.unwrap().1 {
                best = Some((site, dv));
            }
        }
    }
    best.map(|b| b.0.to_string())
}

/// sitePar: the site's reference, weights 1:1.
pub fn site_par(sites: &[SiteOption], site: &str) -> Option<ScoreWeights> {
    match sites.iter().find(|s| s.site() == site) {
        Some(SiteOption::Offered { delta_v, time, .. }) => Some(ScoreWeights { delta_v_ref: delta_v.unwrap_or(f64::NAN), delta_v_weight: 1.0, time_ref: time.unwrap_or(f64::NAN), time_weight: 1.0 }),
        _ => None,
    }
}

pub fn offered_sites(sites: &[SiteOption]) -> Vec<String> {
    sites.iter().filter(|s| s.offered()).map(|s| s.site().to_string()).collect()
}

/// loosestLimits: (maxDeltaV, maxTime).
pub fn loosest_limits(sites: &[SiteOption]) -> (f64, f64) {
    let mut a = 0.0;
    let mut b = 0.0;
    for s in sites {
        if let SiteOption::Offered { max_delta_v, max_time, .. } = s {
            a = js_max(a, *max_delta_v);
            b = js_max(b, *max_time);
        }
    }
    (a, b)
}
