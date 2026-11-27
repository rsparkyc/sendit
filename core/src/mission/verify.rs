//! The leaderboard's verification as one call: plan string, mission id,
//! mission version (and the site the caller files it under) -> accepted with
//! the leaderboard keys and digest, or rejected with the code and message
//! the leaderboard would return. Mirrors, in order, what
//! server/leaderboard/service.ts `submit` does after its field, secret, name
//! and rate-limit checks, with server/leaderboard/engine.ts as the engine:
//! missionAt (id, version), decode (decodePlan + validatePlanIssues), the
//! physics version check, checkRules (checkPlanConformance + SERVER_RULES),
//! then the replay (missionReplayOptions + the step budget) and evaluate
//! with the plan, mapped through `verdict` and submit's status checks.
//! Not mirrored: the wall-clock deadline (a timeout depends on the machine;
//! the caller can bound steps instead), the score cache and the storage.

use crate::fixture::World;
use crate::mission::jsfmt::{fixed, num};
use crate::mission::mdata::MissionData;
use crate::mission::objectives::*;
use crate::mission::plan::{decode_plan, validate_plan_issues, LaunchCheck, Plan, Start};
use crate::mission::replay::{replay, MissionWorld, ReplayOptions};

#[derive(Clone, Debug, PartialEq)]
pub struct ObjectiveSummary {
    pub kind: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Accepted {
        score: f64,
        /// keys.deltaV / 10, m/s.
        delta_v: f64,
        /// keys.time, s.
        mission_time: f64,
        digest: String,
        site: String,
        steps: u64,
        objectives: Vec<ObjectiveSummary>,
    },
    Rejected {
        code: &'static str,
        message: String,
        /// objectives-not-met only: the flight's outcome, reason, objectives and digest.
        flight: Option<(String, String, Vec<ObjectiveSummary>, String)>,
    },
}

fn reject(code: &'static str, message: String) -> Verdict {
    Verdict::Rejected { code, message, flight: None }
}

/// versionOf for a versioned definition (a non-negative integer); None otherwise
/// (the content-hash versions of unversioned definitions are not ported: every
/// leaderboard mission has a version).
pub fn version_of(m: &Mission) -> Option<String> {
    match m.version {
        Some(v) if v >= 0.0 && v.floor() == v && v.is_finite() => Some(num(v)),
        _ => None,
    }
}

/// siteOfPlan.
pub fn site_of_plan(plan: &Plan) -> String {
    match &plan.start {
        Start::Launch { site, .. } => site.clone(),
        Start::State { .. } => "state".into(),
    }
}

fn slice16(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&u)
}

/// `new Date(Date.UTC(2000, 0, 1, 12) + tdb * 1000).toISOString().slice(0, 10)`.
pub fn iso_date(tdb: f64) -> String {
    let ms = 946_728_000_000.0 + tdb * 1000.0;
    let days = (ms / 86_400_000.0).floor() as i64;
    // Civil date from days since 1970-01-01 (H. Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }
    if (0..=9999).contains(&y) { format!("{y:04}-{m:02}-{d:02}") } else { format!("{}{:06}-{m:02}-{d:02}", if y < 0 { "-" } else { "+" }, y.abs()) }
}

/// engine.ts checkRules: the conformance issues, then the server's own rules.
pub fn check_rules(plan: &Plan, def: &Mission, d: &MissionData) -> Vec<ConformanceIssue> {
    let rules = &d.leaderboard;
    let mut out = check_plan_conformance(def, plan, d.default_ascent_time_s, d.default_downrange_deg);
    // `rules.launchOnly !== undefined`: the Rust rules keep launchOnly as a bool, so a
    // definition with rules but no launchOnly counts as saying it (none in the catalogue).
    let mission_says_start = def.rules.as_ref().is_some_and(|r| r.launch_only) || def.start.is_some();
    if rules.launch_only_by_default && !mission_says_start && !matches!(plan.start, Start::Launch { .. }) {
        out.push(ConformanceIssue { code: "start-kind", path: "start.kind".into(), message: "leaderboard flights must start with a launch".into() });
    }
    if !(plan.epoch >= rules.earliest && plan.epoch + plan.duration <= rules.latest) {
        out.push(ConformanceIssue { code: "date", path: "epoch".into(), message: format!("the whole flight must lie between {} and {}", iso_date(rules.earliest), iso_date(rules.latest)) });
    }
    if def.max_duration.is_none() {
        let max_time = def.objectives.iter().find_map(|o| if let Objective::MaxTime(m) = o { Some(*m) } else { None });
        let limit = js_min(rules.max_duration, max_time.unwrap_or(f64::INFINITY));
        if !(plan.duration <= limit) {
            out.push(ConformanceIssue { code: "duration", path: "duration".into(), message: format!("the flight may last at most {} days for this mission", fixed(limit / 86400.0, 2)) });
        }
    }
    if !(plan.rtol >= rules.min_rtol && plan.rtol <= rules.max_rtol) {
        out.push(ConformanceIssue { code: "rtol", path: "rtol".into(), message: format!("integrator tolerance must be in [{}, {}]", num(rules.min_rtol), num(rules.max_rtol)) });
    }
    out
}

/// The verifier: the world (ephemeris with chunks built on demand, from the
/// checkpoint asset when given) and the pole tables, kept across calls.
pub struct Verifier<'d> {
    pub world: MissionWorld<'d>,
    pub poles: Poles,
    pub max_steps: u64,
}

impl<'d> Verifier<'d> {
    pub fn new(d: &'d MissionData, asset: Option<&[u8]>) -> Result<Verifier<'d>, String> {
        let w: World = crate::data::world();
        let (eph, fm) = crate::data::ephemeris(&w, asset, Some(&d.checkpoint_version))?;
        let poles = Poles::new(&w, d);
        Ok(Verifier { world: MissionWorld { eph, fm, d }, poles, max_steps: d.leaderboard.max_steps })
    }

    /// The leaderboard's verdict on a submission. `site`: the board the caller
    /// files it under (None: the plan's own, siteOfPlan); a different site is
    /// rejected with 'site-mismatch' (the leaderboard derives the site from the plan).
    pub fn verify(&mut self, plan_str: &str, mission_id: &str, mission_version: &str, site: Option<&str>) -> Verdict {
        let d = self.world.d;
        let m = match d.campaign.iter().find(|m| m.id == mission_id && version_of(m).is_some()) {
            Some(m) => m,
            None => return reject("unknown-mission", format!("no mission \"{}\"", slice16(mission_id, 40))),
        };
        let mv = version_of(m).unwrap();
        if mv != mission_version {
            return reject("mission-version", format!("mission \"{mission_id}\" is now version {mv}; your plan was made for version {}. Reload to get the current mission.", slice16(mission_version, 32)));
        }
        let plan = match decode_plan(plan_str, d) {
            Ok(p) => p,
            Err(e) => return reject("invalid-plan", e),
        };
        let issues = validate_plan_issues(&plan, d, LaunchCheck::Full, None);
        if !issues.is_empty() {
            return reject("invalid-plan", format!("invalid plan: {}", issues.iter().map(|i| i.message.as_str()).collect::<Vec<_>>().join("; ")));
        }
        if plan.model != d.physics_model || plan.data != d.fingerprint {
            let rel = if plan.model < d.physics_model { "an older" } else if plan.model > d.physics_model { "a newer" } else { "a different" };
            return reject(
                "version-mismatch",
                format!("this plan was made for {rel} version of the game (physics model {} / data {}); the leaderboard runs model {} / data {}. Reload the game and fly it again.", plan.model, plan.data, d.physics_model, d.fingerprint),
            );
        }
        let issues = check_rules(&plan, m, d);
        if !issues.is_empty() {
            return reject("rule-violation", issues.iter().map(|i| i.message.as_str()).collect::<Vec<_>>().join("; "));
        }
        let plan_site = site_of_plan(&plan);
        if let Some(s) = site {
            if s != plan_site {
                return reject("site-mismatch", format!("the plan launches from {plan_site}, not {s}"));
            }
        }
        let mut ro: ReplayOptions = mission_replay_options(m);
        ro.max_steps = Some(self.max_steps);
        let r = replay(&plan, &mut self.world, &ro, None, None);
        match r.outcome {
            "step-limit" | "event-limit" => return reject("replay-limit", format!("the flight is too expensive to verify: {}", r.reason)),
            "invalid-plan" | "version-mismatch" | "unsupported-start" => return reject("invalid-plan", r.reason.clone()),
            "physics-error" => return reject("invalid-plan", format!("the physics refused this plan: {}", r.reason)),
            _ => {}
        }
        let ev = evaluate(m, &r, &mut self.world, &mut self.poles, plan.epoch, Some(&plan));
        let mut objectives: Vec<ObjectiveSummary> = ev.objectives.iter().map(|x| ObjectiveSummary { kind: x.objective.kind().into(), ok: x.ok, detail: x.detail.clone() }).collect();
        for v in ev.rule_violations.iter().flatten() {
            objectives.push(ObjectiveSummary { kind: "rule".into(), ok: false, detail: v.clone() });
        }
        match (ev.success, ev.keys) {
            (true, Some(k)) => Verdict::Accepted { score: k.score, delta_v: k.delta_v / 10.0, mission_time: k.time, digest: r.digest, site: plan_site, steps: r.steps, objectives },
            _ => Verdict::Rejected { code: "objectives-not-met", message: "the flight does not complete the mission".into(), flight: Some((r.outcome.to_string(), r.reason, objectives, r.digest)) },
        }
    }
}
