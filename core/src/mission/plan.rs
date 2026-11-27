//! Port of src/mission/plan.ts: plan types, the binary encoding (formats 1,
//! 2, 3; base64url without padding, canonical only; float64 stored exactly),
//! the strict decoder with its messages, and validatePlanIssues (codes, paths
//! and messages, the launch semantics included).

use crate::mission::jsfmt::num;
use crate::mission::mdata::{LaunchSite, Limits, MissionData};

pub const PLAN_FORMAT: u8 = 1;
pub const PLAN_FORMAT_STAGED: u8 = 2;
pub const PLAN_FORMAT_DIRECT: u8 = 3;
const PLAN_FORMATS: [u8; 3] = [1, 2, 3];
const G0_PLAN: f64 = 9.80665;
const ENGINE_NO_RESTART: u8 = 1;
const ENGINE_NO_THROTTLE: u8 = 2;

#[derive(Clone, Debug, PartialEq)]
pub struct Engine {
    pub thrust: f64,
    pub isp: f64,
    /// Present only when false in a canonical plan (Some(true) is allowed in memory).
    pub restartable: Option<bool>,
    pub throttleable: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stage {
    pub wet_mass: f64,
    pub dry_mass: f64,
    pub engines: Vec<Engine>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Frame {
    Inertial,
    Orbital(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlanBurn {
    pub start: f64,
    pub duration: f64,
    pub engine: usize,
    pub stage: Option<usize>,
    pub direction: [f64; 3],
    pub frame: Frame,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AscentKind {
    /// Free delivery to the parking orbit (format 1).
    Delivered,
    Vehicle,
    Direct,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Start {
    State { center: String, state: [f64; 6] },
    Launch { site: String, params: Vec<f64>, ascent: AscentKind },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub format: u8,
    pub model: u32,
    pub data: String,
    pub epoch: f64,
    pub duration: f64,
    pub rtol: f64,
    pub start: Start,
    pub spacecraft: Stage,
    pub burns: Vec<PlanBurn>,
    pub lower_stages: Option<Vec<Stage>>,
    /// Separation times, s after the epoch.
    pub separations: Option<Vec<f64>>,
}

impl Start {
    pub fn is_vehicle(&self) -> bool {
        matches!(self, Start::Launch { ascent: AscentKind::Vehicle, .. })
    }
    pub fn is_direct(&self) -> bool {
        matches!(self, Start::Launch { ascent: AscentKind::Direct, .. })
    }
    pub fn is_flown(&self) -> bool {
        self.is_vehicle() || self.is_direct()
    }
}

impl Plan {
    /// vehicleStages(): lower stages then the spacecraft.
    pub fn stages(&self) -> Vec<Stage> {
        match &self.lower_stages {
            Some(l) if !l.is_empty() => {
                let mut v = l.clone();
                v.push(self.spacecraft.clone());
                v
            }
            _ => vec![self.spacecraft.clone()],
        }
    }
    /// burnStage().
    pub fn burn_stage(&self, b: &PlanBurn) -> usize {
        b.stage.unwrap_or_else(|| self.lower_stages.as_ref().map_or(0, |l| l.len()))
    }
    pub fn uses_propulsion_flags(&self) -> bool {
        let lower = self.lower_stages.iter().flatten();
        lower.chain(std::iter::once(&self.spacecraft)).any(|s| s.engines.iter().any(|e| e.restartable == Some(false) || e.throttleable == Some(false)))
    }
    /// requiredFormat().
    pub fn required_format(&self) -> u8 {
        if self.start.is_direct() || self.uses_propulsion_flags() {
            return PLAN_FORMAT_DIRECT;
        }
        let staged = self.lower_stages.is_some() || self.separations.is_some() || self.start.is_vehicle() || self.burns.iter().any(|b| b.stage.is_some());
        if staged { PLAN_FORMAT_STAGED } else { PLAN_FORMAT }
    }
    /// simulationStartOffset() (NaN where the TypeScript reads a missing parameter as undefined).
    pub fn simulation_start_offset(&self, default_ascent: f64) -> f64 {
        simulation_start_offset(&self.start, default_ascent)
    }
}

pub fn simulation_start_offset(start: &Start, default_ascent: f64) -> f64 {
    match start {
        Start::Launch { params, ascent: AscentKind::Direct, .. } => params.get(4).copied().unwrap_or(f64::NAN),
        Start::Launch { params, .. } => params.get(3).copied().unwrap_or(default_ascent),
        Start::State { .. } => 0.0,
    }
}

/// One flight action in time order.
#[derive(Clone, Debug)]
pub enum Action {
    Burn { t: f64, index: usize },
    Separation { t: f64, index: usize },
}

/// flightActions(): burns and separations by time, a separation first at equal times.
pub fn flight_actions(plan: &Plan) -> Vec<Action> {
    let mut out = Vec::new();
    let seps: &[f64] = plan.separations.as_deref().unwrap_or(&[]);
    let mut j = 0;
    for (i, b) in plan.burns.iter().enumerate() {
        while j < seps.len() && seps[j] <= b.start {
            out.push(Action::Separation { t: seps[j], index: j });
            j += 1;
        }
        out.push(Action::Burn { t: b.start, index: i });
    }
    while j < seps.len() {
        out.push(Action::Separation { t: seps[j], index: j });
        j += 1;
    }
    out
}

#[derive(Clone, Debug, PartialEq)]
pub struct Issue {
    pub code: &'static str,
    pub path: String,
    pub burn: Option<usize>,
    pub message: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LaunchCheck {
    Full,
    Structural,
}

fn finite(x: f64) -> bool {
    x.is_finite()
}

fn is_id(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
}

/// JSON.stringify of a string (the id messages).
fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            '\u{8}' => o.push_str("\\b"),
            '\u{c}' => o.push_str("\\f"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// azimuthAllowed().
pub fn azimuth_allowed(site: &LaunchSite, azimuth_deg: f64) -> bool {
    let span = site.azimuth_max_deg - site.azimuth_min_deg;
    if span >= 360.0 {
        return true;
    }
    let mut d = azimuth_deg - site.azimuth_min_deg;
    d = d - 360.0 * (d / 360.0).floor();
    d <= span
}

struct V<'a> {
    errs: Vec<Issue>,
    l: &'a Limits,
}

impl V<'_> {
    fn add(&mut self, code: &'static str, path: &str, message: String, burn: Option<usize>) {
        self.errs.push(Issue { code, path: path.to_string(), burn, message });
    }
    fn burn_of(path: &str) -> Option<usize> {
        let rest = path.strip_prefix("burns[")?;
        let end = rest.find(']')?;
        rest[..end].parse().ok()
    }
    fn range(&mut self, name: &str, v: f64, lo: f64, hi: f64, lo_open: bool) {
        let bad = !finite(v) || (if lo_open { !(v > lo) } else { !(v >= lo) }) || !(v <= hi);
        if bad {
            let m = format!("{name} must be a finite number in {}{}, {}], got {}", if lo_open { "(" } else { "[" }, num(lo), num(hi), num(v));
            self.add("range", name, m, Self::burn_of(name));
        }
    }
    fn id(&mut self, name: &str, v: &str) {
        if !is_id(v, self.l.max_id_length) {
            let m = format!("{name} must be an id of 1-{} characters [a-z0-9_-], got {}", self.l.max_id_length, json_str(v));
            self.add("id", name, m, Self::burn_of(name));
        }
    }
    fn stage_ok(&mut self, st: &Stage, name: &str, eng_path: &dyn Fn(usize) -> String) {
        let l = self.l;
        self.range(&format!("{name}.wetMass"), st.wet_mass, 0.0, l.max_mass, true);
        self.range(&format!("{name}.dryMass"), st.dry_mass, 0.0, l.max_mass, true);
        if finite(st.wet_mass) && finite(st.dry_mass) && st.dry_mass > st.wet_mass {
            self.add("mass-order", &format!("{name}.dryMass"), format!("{name}.dryMass must not exceed wetMass"), None);
        }
        if st.engines.is_empty() || st.engines.len() > l.max_engines {
            self.add("engines", &format!("{name}.engines"), format!("{name} needs 1-{} engines", l.max_engines), None);
        } else {
            for (i, e) in st.engines.iter().enumerate() {
                self.range(&format!("{}.thrust", eng_path(i)), e.thrust, 0.0, l.max_thrust, true);
                self.range(&format!("{}.isp", eng_path(i)), e.isp, 0.0, l.max_isp, true);
                // restartable / throttleable are booleans or absent by type.
            }
        }
    }
}

/// validatePlanIssues(plan, { launch, ascentFirstStage }).
pub fn validate_plan_issues(plan: &Plan, d: &MissionData, launch: LaunchCheck, ascent_first_stage: Option<usize>) -> Vec<Issue> {
    let l = &d.limits;
    let mut v = V { errs: Vec::new(), l };
    if !PLAN_FORMATS.contains(&plan.format) {
        v.add("format", "format", format!("unsupported plan format {} (this build reads 1, 2, 3)", plan.format), None);
    } else if plan.format < plan.required_format() {
        let need = plan.required_format();
        let m = if need == PLAN_FORMAT_DIRECT {
            format!("plan format {} cannot hold engine propulsion flags or a direct-injection launch (needs format {PLAN_FORMAT_DIRECT})", plan.format)
        } else {
            format!("plan format {} cannot hold stages, separations, burn stages or a vehicle launch (needs format {PLAN_FORMAT_STAGED})", plan.format)
        };
        v.add("format", "format", m, None);
    }
    if plan.model > 0xffff {
        v.add("model", "model", "model must be an integer 0-65535".into(), None);
    }
    if !(plan.data.len() == 8 && plan.data.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))) {
        v.add("data", "data", "data fingerprint must be 8 hex digits".into(), None);
    }
    v.range("epoch", plan.epoch, -l.max_epoch, l.max_epoch, false);
    v.range("duration", plan.duration, 0.0, l.max_duration, true);
    v.range("rtol", plan.rtol, l.min_rtol, l.max_rtol, false);

    match &plan.start {
        Start::State { center, state } => {
            v.id("start.center", center);
            for i in 0..3 {
                v.range(&format!("start.state[{i}]"), state[i], -l.max_position, l.max_position, false);
            }
            for i in 3..6 {
                v.range(&format!("start.state[{i}]"), state[i], -l.max_velocity, l.max_velocity, false);
            }
        }
        Start::Launch { site, params, ascent } => {
            v.id("start.site", site);
            if params.len() > l.max_launch_params {
                v.add("launch-params", "start.params", format!("start.params must be at most {} numbers", l.max_launch_params), None);
            } else {
                let mut all_finite = true;
                for (i, &p) in params.iter().enumerate() {
                    if !finite(p) {
                        all_finite = false;
                        v.add("launch-params", &format!("start.params[{i}]"), format!("start.params[{i}] must be finite"), None);
                    }
                }
                if params.is_empty() || params[0] != plan.epoch {
                    v.add("launch-epoch", "start.params[0]", "start.params[0] (launch time) must equal epoch: the epoch of a launch plan is liftoff".into(), None);
                }
                let asc = simulation_start_offset(&plan.start, d.default_ascent_time_s);
                // `${ascent}` of an absent params[4] is "undefined".
                let asc_text = if asc.is_nan() && *ascent == AscentKind::Direct && params.len() < 5 { "undefined".to_string() } else { num(asc) };
                if !(asc >= 0.0 && asc <= 86400.0) {
                    v.add("launch-ascent", "start.params[3]", format!("launch ascent time must be in [0, 86400] s, got {asc_text}"), None);
                } else {
                    if !(plan.duration > asc) {
                        v.add("launch-duration", "duration", format!("duration must extend past orbit insertion ({asc_text} s after liftoff)"), None);
                    }
                    if plan.burns.len() <= l.max_burns || true {
                        for (i, b) in plan.burns.iter().enumerate() {
                            if finite(b.start) && b.start < asc {
                                v.add("burn-before-insertion", &format!("burns[{i}].start"), format!("burns[{i}] starts at {} s, before orbit insertion at {asc_text} s after liftoff", num(b.start)), Some(i));
                            }
                        }
                    }
                }
                if *ascent == AscentKind::Direct {
                    if params.len() != l.direct_params {
                        v.add("launch-params", "start.params", format!("start.params: a direct-injection launch takes exactly {} parameters [time, azimuth, c3, injectionAltitude, flightStart], got {}", l.direct_params, params.len()), None);
                    } else if launch == LaunchCheck::Full && all_finite {
                        direct_launch_issues(&mut v, d, site, params);
                    }
                } else if launch == LaunchCheck::Full && all_finite {
                    launch_issues(&mut v, d, site, params);
                }
            }
        }
    }

    v.stage_ok(&plan.spacecraft, "spacecraft", &|i| format!("engines[{i}]"));
    let lower = plan.lower_stages.as_ref();
    let lower_ok = lower.is_some_and(|x| x.len() <= l.max_stages - 1);
    if let Some(low) = lower {
        if low.len() > l.max_stages - 1 {
            v.add("stages", "lowerStages", format!("a vehicle has at most {} stages (the spacecraft included)", l.max_stages), None);
        } else {
            for (k, st) in low.iter().enumerate() {
                v.stage_ok(st, &format!("lowerStages[{k}]"), &|i| format!("lowerStages[{k}].engines[{i}]"));
            }
        }
    }
    let stages: Vec<&Stage> = if lower_ok { lower.unwrap().iter().chain(std::iter::once(&plan.spacecraft)).collect() } else { vec![&plan.spacecraft] };
    if plan.start.is_flown() && !lower.is_some_and(|x| !x.is_empty()) {
        v.add("stages", "lowerStages", "a vehicle launch needs at least one stage below the spacecraft (the spacecraft never flies the ascent)".into(), None);
    }

    if plan.burns.len() > l.max_burns {
        v.add("burns", "burns", format!("at most {} burns", l.max_burns), None);
    } else {
        let mut prev_end = f64::NEG_INFINITY;
        for (i, b) in plan.burns.iter().enumerate() {
            let n = format!("burns[{i}]");
            v.range(&format!("{n}.start"), b.start, 0.0, l.max_duration, false);
            v.range(&format!("{n}.duration"), b.duration, 0.0, l.max_duration, true);
            let k = b.stage.unwrap_or(stages.len() - 1);
            let se = if k < stages.len() { Some(&stages[k].engines) } else { None };
            if b.stage.is_some() && se.is_none() {
                v.add("burn-stage", &format!("{n}.stage"), format!("{n}.stage must index the vehicle's {} stage(s)", stages.len()), Some(i));
            } else if se.is_none_or(|e| b.engine >= e.len()) {
                let m = if b.stage.is_none() { format!("{n}.engine must index spacecraft.engines") } else { format!("{n}.engine must index the engines of stage {k}") };
                v.add("burn-engine", &format!("{n}.engine"), m, Some(i));
            }
            let dd = b.direction;
            if !dd.iter().all(|&x| finite(x) && x.abs() <= 1e6) {
                v.add("burn-direction", &format!("{n}.direction"), format!("{n}.direction must be 3 finite numbers with |x| <= 1e6"), Some(i));
            } else if !(dd[0] * dd[0] + dd[1] * dd[1] + dd[2] * dd[2] > 1e-24) {
                v.add("burn-direction", &format!("{n}.direction"), format!("{n}.direction must not be zero"), Some(i));
            }
            if let Frame::Orbital(body) = &b.frame {
                v.id(&format!("{n}.frame.body"), body);
            }
            if finite(b.start) && finite(b.duration) {
                if b.start < prev_end {
                    v.add("burn-overlap", &format!("{n}.start"), format!("{n} starts before the previous burn ends (burns must be sorted and not overlap)"), Some(i));
                }
                prev_end = b.start + b.duration;
            }
        }
    }

    if let Some(seps) = &plan.separations {
        if seps.len() > l.max_separations {
            v.add("action-order", "separations", format!("at most {} separations", l.max_separations), None);
        } else {
            for (j, &t) in seps.iter().enumerate() {
                v.range(&format!("separations[{j}].time"), t, 0.0, l.max_duration, false);
            }
            for j in 1..seps.len() {
                if finite(seps[j]) && finite(seps[j - 1]) && seps[j] < seps[j - 1] {
                    v.add("action-order", &format!("separations[{j}].time"), "separations must be sorted by time".into(), None);
                }
            }
        }
    }
    let mut errs = v.errs;
    if errs.is_empty() && !plan.start.is_flown() {
        errs.extend(staging_issues(plan, 0, d.default_ascent_time_s));
    } else if errs.is_empty() && launch == LaunchCheck::Full {
        if let Some(f) = ascent_first_stage {
            errs.extend(staging_issues(plan, f, d.default_ascent_time_s));
            errs.extend(ascent_restart_issues(plan, f));
        }
    }
    if errs.is_empty() {
        errs.extend(propulsion_issues(plan));
    }
    errs
}

pub fn validate_plan(plan: &Plan, d: &MissionData, launch: LaunchCheck) -> Vec<String> {
    validate_plan_issues(plan, d, launch, None).into_iter().map(|i| i.message).collect()
}

/// propulsionIssues().
pub fn propulsion_issues(plan: &Plan) -> Vec<Issue> {
    let mut out = Vec::new();
    if !plan.uses_propulsion_flags() {
        return out;
    }
    let stages = plan.stages();
    let mut seen: Vec<(usize, usize)> = Vec::new();
    for (i, b) in plan.burns.iter().enumerate() {
        let k = plan.burn_stage(b);
        let st = &stages[k];
        let e = &st.engines[b.engine];
        if e.restartable == Some(false) {
            if seen.contains(&(k, b.engine)) {
                out.push(Issue { code: "engine-restart", path: format!("burns[{i}].engine"), burn: Some(i), message: format!("burns[{i}]: engine {} of stage {k} cannot restart (it already fired in an earlier burn)", b.engine) });
            }
            seen.push((k, b.engine));
        }
        if e.throttleable == Some(false) {
            let full = (st.wet_mass - st.dry_mass) / (e.thrust / (e.isp * G0_PLAN));
            if !(b.duration >= full) {
                out.push(Issue {
                    code: "engine-throttle",
                    path: format!("burns[{i}].duration"),
                    burn: Some(i),
                    message: format!("burns[{i}]: engine {} of stage {k} cannot be shut down (non-throttleable): its burn must last until depletion, at least {} s, got {}", b.engine, num(full), num(b.duration)),
                });
            }
        }
    }
    out
}

/// ascentRestartIssues().
pub fn ascent_restart_issues(plan: &Plan, upper: usize) -> Vec<Issue> {
    let stages = plan.stages();
    let mut out = Vec::new();
    for (i, b) in plan.burns.iter().enumerate() {
        let k = plan.burn_stage(b);
        if k == upper && stages.get(k).and_then(|s| s.engines.get(b.engine)).is_some_and(|e| e.restartable == Some(false)) {
            out.push(Issue { code: "engine-restart", path: format!("burns[{i}].engine"), burn: Some(i), message: format!("burns[{i}]: stage {k} was lit during the ascent and engine {} cannot restart", b.engine) });
        }
    }
    out
}

/// stagingIssues(plan, first).
pub fn staging_issues(plan: &Plan, first: usize, default_ascent: f64) -> Vec<Issue> {
    let mut out = Vec::new();
    let n = plan.stages().len();
    let t0 = plan.simulation_start_offset(default_ascent);
    let mut active = first;
    let seps: &[f64] = plan.separations.as_deref().unwrap_or(&[]);
    for a in flight_actions(plan) {
        match a {
            Action::Separation { t, index } => {
                let path = format!("separations[{index}].time");
                if t < t0 {
                    let extra = if matches!(plan.start, Start::Launch { .. }) { ", orbit insertion" } else { "" };
                    out.push(Issue { code: "separation-before-insertion", path: path.clone(), burn: None, message: format!("separations[{index}] at {} s is before the flight starts ({} s after the epoch{extra})", num(t), num(t0)) });
                }
                if active >= n - 1 {
                    out.push(Issue { code: "separation-last", path, burn: None, message: format!("separations[{index}] would drop the spacecraft (the last stage)") });
                } else {
                    active += 1;
                }
            }
            Action::Burn { index, .. } => {
                let b = &plan.burns[index];
                let k = plan.burn_stage(b);
                if k != active {
                    out.push(Issue { code: "burn-stage", path: format!("burns[{index}].stage"), burn: Some(index), message: format!("burns[{index}] fires stage {k}, but stage {active} is the active stage at {} s", num(b.start)) });
                }
                let end = b.start + b.duration;
                for (j, &s) in seps.iter().enumerate() {
                    if s > b.start && s < end {
                        out.push(Issue {
                            code: "burn-spans-separation",
                            path: format!("burns[{index}].duration"),
                            burn: Some(index),
                            message: format!("burns[{index}] ({}..{} s) is still firing at separations[{j}] ({} s)", num(b.start), num(end), num(s)),
                        });
                    }
                }
            }
        }
    }
    out
}

fn known_sites(d: &MissionData) -> String {
    d.sites.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(", ")
}

fn launch_issues(v: &mut V, d: &MissionData, site_id: &str, params: &[f64]) {
    let Some(site) = d.site(site_id) else {
        v.add("launch-site", "start.site", format!("start.site: unknown launch site {site_id} (known: {})", known_sites(d)), None);
        return;
    };
    if params.len() < 3 || params.len() > 6 {
        v.add("launch-params", "start.params", format!("start.params: a parking-orbit launch takes 3 to 6 parameters [time, azimuth, altitude, ascent?, downrange?, circularization?], got {}", params.len()), None);
        return;
    }
    let c = params.get(5).copied().unwrap_or(0.0);
    if c != 0.0 && c != 1.0 {
        v.add("launch-mode", "start.params[5]", format!("start.params[5] (circularization) must be 0 (j2-mean) or 1 (two-body), got {}", num(c)), None);
    }
    if !azimuth_allowed(site, params[1]) {
        v.add("launch-azimuth", "start.params[1]", format!("start.params[1]: azimuth {} deg is outside {}'s range-safety corridor {}..{} deg", num(params[1]), site.id, num(site.azimuth_min_deg), num(site.azimuth_max_deg)), None);
    }
    if !(params[2] > 0.0 && params[2] <= d.max_parking_altitude) {
        v.add("launch-altitude", "start.params[2]", format!("start.params[2]: parking-orbit altitude must be in (0, {}] m, got {}", num(d.max_parking_altitude), num(params[2])), None);
    }
}

fn direct_launch_issues(v: &mut V, d: &MissionData, site_id: &str, params: &[f64]) {
    let Some(site) = d.site(site_id) else {
        v.add("launch-site", "start.site", format!("start.site: unknown launch site {site_id} (known: {})", known_sites(d)), None);
        return;
    };
    if !azimuth_allowed(site, params[1]) {
        v.add("launch-azimuth", "start.params[1]", format!("start.params[1]: azimuth {} deg is outside {}'s range-safety corridor {}..{} deg", num(params[1]), site.id, num(site.azimuth_min_deg), num(site.azimuth_max_deg)), None);
    }
    let [c0, c1] = d.limits.direct_c3_range;
    if !(params[2] >= c0 && params[2] <= c1) {
        v.add("launch-c3", "start.params[2]", format!("start.params[2]: target C3 must be in [{}, {}] m^2/s^2, got {}", num(c0), num(c1), num(params[2])), None);
    }
    let [h0, h1] = d.limits.direct_altitude_range;
    if !(params[3] >= h0 && params[3] <= h1) {
        v.add("launch-altitude", "start.params[3]", format!("start.params[3]: injection altitude must be in [{}, {}] m, got {}", num(h0), num(h1), num(params[3])), None);
    }
}

// ---------------------------------------------------------------- encoding

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn to_base64url(bytes: &[u8]) -> String {
    let mut s = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((*bytes.get(i + 1).unwrap_or(&0) as u32) << 8) | (*bytes.get(i + 2).unwrap_or(&0) as u32);
        let chars = if i + 2 < bytes.len() { 4 } else if i + 1 < bytes.len() { 3 } else { 2 };
        for c in 0..chars {
            s.push(B64[((n >> (18 - 6 * c)) & 63) as usize] as char);
        }
        i += 3;
    }
    s
}

/// fromBase64Url(), on the UTF-16 code units of the string (as JavaScript sees it).
pub fn from_base64url(s: &str) -> Result<Vec<u8>, String> {
    let u: Vec<u16> = s.encode_utf16().collect();
    if u.len() % 4 == 1 {
        return Err("plan string has an impossible length".into());
    }
    let mut inv = [-1i16; 128];
    for (i, &c) in B64.iter().enumerate() {
        inv[c as usize] = i as i16;
    }
    let mut out = vec![0u8; (u.len() * 3) / 4];
    let mut o = 0;
    let mut i = 0;
    while i < u.len() {
        let mut n: u32 = 0;
        let chars = (u.len() - i).min(4);
        for c in 0..4 {
            let mut v: i32 = 0;
            if c < chars {
                let code = u[i + c];
                v = if code < 128 { inv[code as usize] as i32 } else { -1 };
                if v < 0 {
                    return Err(format!("plan string has an invalid character at position {}", i + c));
                }
            }
            n = (n << 6) | v as u32;
        }
        out[o] = ((n >> 16) & 255) as u8;
        o += 1;
        if chars > 2 {
            out[o] = ((n >> 8) & 255) as u8;
            o += 1;
        }
        if chars > 3 {
            out[o] = (n & 255) as u8;
            o += 1;
        }
        i += 4;
    }
    if to_base64url(&out) != s {
        return Err("plan string is not canonical base64url".into());
    }
    Ok(out)
}

struct W(Vec<u8>);
impl W {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn str(&mut self, s: &str) {
        self.u8(s.len() as u8);
        self.0.extend_from_slice(s.as_bytes());
    }
}

/// encodePlan(): refuses a plan that fails the structural validation.
pub fn encode_plan(plan: &Plan, d: &MissionData) -> Result<String, String> {
    let errs = validate_plan(plan, d, LaunchCheck::Structural);
    if !errs.is_empty() {
        return Err(format!("invalid plan: {}", errs.join("; ")));
    }
    let mut w = W(Vec::new());
    w.u8(0x53);
    w.u8(plan.format);
    w.u16(plan.model as u16);
    w.u32(u32::from_str_radix(&plan.data, 16).unwrap());
    w.f64(plan.epoch);
    w.f64(plan.duration);
    w.f64(plan.rtol);
    match &plan.start {
        Start::State { center, state } => {
            w.u8(0);
            w.str(center);
            for x in state {
                w.f64(*x);
            }
        }
        Start::Launch { site, params, ascent } => {
            w.u8(match ascent {
                AscentKind::Direct => 3,
                AscentKind::Vehicle => 2,
                AscentKind::Delivered => 1,
            });
            w.str(site);
            w.u8(params.len() as u8);
            for p in params {
                w.f64(*p);
            }
        }
    }
    let stage = |w: &mut W, sc: &Stage| {
        w.f64(sc.wet_mass);
        w.f64(sc.dry_mass);
        w.u8(sc.engines.len() as u8);
        for e in &sc.engines {
            w.f64(e.thrust);
            w.f64(e.isp);
            if plan.format == PLAN_FORMAT_DIRECT {
                w.u8((if e.restartable == Some(false) { ENGINE_NO_RESTART } else { 0 }) | (if e.throttleable == Some(false) { ENGINE_NO_THROTTLE } else { 0 }));
            }
        }
    };
    let burn = |w: &mut W, b: &PlanBurn, with_stage: bool| {
        w.f64(b.start);
        w.f64(b.duration);
        if with_stage {
            w.u8(plan.burn_stage(b) as u8);
        }
        w.u8(b.engine as u8);
        for x in b.direction {
            w.f64(x);
        }
        match &b.frame {
            Frame::Inertial => w.u8(0),
            Frame::Orbital(body) => {
                w.u8(1);
                w.str(body);
            }
        }
    };
    if plan.format == PLAN_FORMAT {
        stage(&mut w, &plan.spacecraft);
        w.u16(plan.burns.len() as u16);
        for b in &plan.burns {
            burn(&mut w, b, false);
        }
    } else {
        let stages = plan.stages();
        w.u8(stages.len() as u8);
        for s in &stages {
            stage(&mut w, s);
        }
        let acts = flight_actions(plan);
        w.u16(acts.len() as u16);
        for a in acts {
            match a {
                Action::Burn { index, .. } => {
                    w.u8(0);
                    burn(&mut w, &plan.burns[index], true);
                }
                Action::Separation { t, .. } => {
                    w.u8(1);
                    w.f64(t);
                }
            }
        }
    }
    Ok(to_base64url(&w.0))
}

struct R<'a> {
    buf: &'a [u8],
    pos: usize,
    max_id: usize,
}
impl R<'_> {
    fn need(&self, n: usize, what: &str) -> Result<(), String> {
        if self.pos + n > self.buf.len() {
            return Err(format!("plan is truncated (reading {what} at byte {})", self.pos));
        }
        Ok(())
    }
    fn u8(&mut self, what: &str) -> Result<u8, String> {
        self.need(1, what)?;
        self.pos += 1;
        Ok(self.buf[self.pos - 1])
    }
    fn u16(&mut self, what: &str) -> Result<u16, String> {
        self.need(2, what)?;
        let v = u16::from_le_bytes(self.buf[self.pos..self.pos + 2].try_into().unwrap());
        self.pos += 2;
        Ok(v)
    }
    fn u32(&mut self, what: &str) -> Result<u32, String> {
        self.need(4, what)?;
        let v = u32::from_le_bytes(self.buf[self.pos..self.pos + 4].try_into().unwrap());
        self.pos += 4;
        Ok(v)
    }
    fn f64(&mut self, what: &str) -> Result<f64, String> {
        self.need(8, what)?;
        let v = f64::from_le_bytes(self.buf[self.pos..self.pos + 8].try_into().unwrap());
        self.pos += 8;
        Ok(v)
    }
    fn str(&mut self, what: &str) -> Result<String, String> {
        let n = self.u8(what)? as usize;
        if n == 0 || n > self.max_id {
            return Err(format!("{what}: bad id length {n}"));
        }
        self.need(n, what)?;
        // String.fromCharCode of each byte (Latin-1), then the id pattern.
        let s: String = self.buf[self.pos..self.pos + n].iter().map(|&b| b as char).collect();
        self.pos += n;
        if !is_id(&s, usize::MAX) {
            return Err(format!("{what}: id has invalid characters"));
        }
        Ok(s)
    }
    fn done(&self) -> Result<(), String> {
        if self.pos != self.buf.len() {
            return Err(format!("plan has {} unexpected trailing bytes", self.buf.len() - self.pos));
        }
        Ok(())
    }
}

/// decodePlan(): decode and validate (structural). Err carries the PlanError message.
pub fn decode_plan(s: &str, d: &MissionData) -> Result<Plan, String> {
    let l = &d.limits;
    let len16 = s.encode_utf16().count();
    if len16 > l.max_encoded_length {
        return Err(format!("plan string is too long ({len16} > {})", l.max_encoded_length));
    }
    let bytes = from_base64url(s)?;
    let mut r = R { buf: &bytes, pos: 0, max_id: l.max_id_length };
    if r.u8("magic")? != 0x53 {
        return Err("not a mission plan (bad magic byte)".into());
    }
    let format = r.u8("format")?;
    if !PLAN_FORMATS.contains(&format) {
        return Err(format!("unsupported plan format {format} (this build reads 1, 2, 3)"));
    }
    let model = r.u16("model")? as u32;
    let data = format!("{:08x}", r.u32("data")?);
    let epoch = r.f64("epoch")?;
    let duration = r.f64("duration")?;
    let rtol = r.f64("rtol")?;
    let tag = r.u8("start kind")?;
    let start = if tag == 0 {
        let center = r.str("start.center")?;
        let mut state = [0.0; 6];
        for x in state.iter_mut() {
            *x = r.f64("start.state")?;
        }
        Start::State { center, state }
    } else if tag == 1 || (tag == 2 && format >= PLAN_FORMAT_STAGED) || (tag == 3 && format == PLAN_FORMAT_DIRECT) {
        let site = r.str("start.site")?;
        let n = r.u8("start.params count")? as usize;
        if n > l.max_launch_params {
            return Err(format!("too many launch parameters ({n})"));
        }
        let mut params = Vec::with_capacity(n);
        for _ in 0..n {
            params.push(r.f64("start.params")?);
        }
        Start::Launch { site, params, ascent: if tag == 3 { AscentKind::Direct } else if tag == 2 { AscentKind::Vehicle } else { AscentKind::Delivered } }
    } else {
        return Err(format!("unknown start kind {tag}"));
    };
    let read_stage = |r: &mut R, what: &str| -> Result<Stage, String> {
        let wet_mass = r.f64(&format!("{what}.wetMass"))?;
        let dry_mass = r.f64(&format!("{what}.dryMass"))?;
        let ne = r.u8(&format!("{what} engine count"))? as usize;
        if ne > l.max_engines {
            return Err(format!("too many engines ({ne})"));
        }
        let mut engines = Vec::new();
        for _ in 0..ne {
            let thrust = r.f64("engine thrust")?;
            let isp = r.f64("engine isp")?;
            if format != PLAN_FORMAT_DIRECT {
                engines.push(Engine { thrust, isp, restartable: None, throttleable: None });
                continue;
            }
            let fl = r.u8("engine flags")?;
            if fl & !(ENGINE_NO_RESTART | ENGINE_NO_THROTTLE) != 0 {
                return Err(format!("{what}: unknown engine flag bits {fl}"));
            }
            engines.push(Engine { thrust, isp, restartable: if fl & ENGINE_NO_RESTART != 0 { Some(false) } else { None }, throttleable: if fl & ENGINE_NO_THROTTLE != 0 { Some(false) } else { None } });
        }
        Ok(Stage { wet_mass, dry_mass, engines })
    };
    let read_burn = |r: &mut R, i: usize, with_stage: bool| -> Result<PlanBurn, String> {
        let bs = r.f64(&format!("burns[{i}].start"))?;
        let bd = r.f64(&format!("burns[{i}].duration"))?;
        let stage = if with_stage { Some(r.u8(&format!("burns[{i}].stage"))? as usize) } else { None };
        let engine = r.u8(&format!("burns[{i}].engine"))? as usize;
        let direction = [r.f64("direction")?, r.f64("direction")?, r.f64("direction")?];
        let fk = r.u8(&format!("burns[{i}].frame"))?;
        let frame = match fk {
            0 => Frame::Inertial,
            1 => Frame::Orbital(r.str(&format!("burns[{i}].frame.body"))?),
            _ => return Err(format!("burns[{i}]: unknown frame kind {fk}")),
        };
        Ok(PlanBurn { start: bs, duration: bd, engine, stage, direction, frame })
    };
    let plan = if format == PLAN_FORMAT {
        let spacecraft = read_stage(&mut r, "spacecraft")?;
        let nb = r.u16("burn count")? as usize;
        if nb > l.max_burns {
            return Err(format!("too many burns ({nb} > {})", l.max_burns));
        }
        let mut burns = Vec::new();
        for i in 0..nb {
            burns.push(read_burn(&mut r, i, false)?);
        }
        r.done()?;
        Plan { format, model, data, epoch, duration, rtol, start, spacecraft, burns, lower_stages: None, separations: None }
    } else {
        let ns = r.u8("stage count")? as usize;
        if ns < 1 || ns > l.max_stages {
            return Err(format!("a vehicle needs 1-{} stages, got {ns}", l.max_stages));
        }
        let mut stages = Vec::new();
        for k in 0..ns {
            stages.push(read_stage(&mut r, &format!("stages[{k}]"))?);
        }
        let na = r.u16("action count")? as usize;
        if na > l.max_burns + l.max_separations {
            return Err(format!("too many actions ({na})"));
        }
        let mut burns = Vec::new();
        let mut seps = Vec::new();
        let mut prev_t = f64::NEG_INFINITY;
        let mut prev_kind: i32 = -1;
        for i in 0..na {
            let kind = r.u8(&format!("actions[{i}] kind"))?;
            let t;
            if kind == 0 {
                if burns.len() >= l.max_burns {
                    return Err(format!("too many burns (> {})", l.max_burns));
                }
                let b = read_burn(&mut r, burns.len(), true)?;
                t = b.start;
                burns.push(b);
            } else if kind == 1 {
                if seps.len() >= l.max_separations {
                    return Err(format!("too many separations (> {})", l.max_separations));
                }
                t = r.f64(&format!("separations[{}].time", seps.len()))?;
                seps.push(t);
            } else {
                return Err(format!("actions[{i}]: unknown action kind {kind}"));
            }
            if t < prev_t || (t == prev_t && kind == 1 && prev_kind == 0) {
                return Err(format!("actions[{i}]: actions are not in time order (action-order)"));
            }
            prev_t = t;
            prev_kind = kind as i32;
        }
        r.done()?;
        let spacecraft = stages.pop().unwrap();
        Plan { format, model, data, epoch, duration, rtol, start, spacecraft, burns, lower_stages: Some(stages), separations: Some(seps) }
    };
    let errs = validate_plan(&plan, d, LaunchCheck::Structural);
    if !errs.is_empty() {
        return Err(format!("invalid plan: {}", errs.join("; ")));
    }
    Ok(plan)
}
