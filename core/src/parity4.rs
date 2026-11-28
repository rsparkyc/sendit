//! Mission-layer parity sections, continued: the ascent model. Same Report as src/parity.rs.

use crate::fixture::{lines, Line};
use crate::mission::ascent::*;
use crate::mission::launch::{launch_geometry, EarthModel};
use crate::mission::mdata::MissionData;
use crate::mission::plan::{Engine, Stage};
use crate::parity::Report;
use crate::parity3::unhex;

/// A stage list as core/ts/export-ascent.vec.ts writes it (flags: 0 absent, 1 false, 2 true).
pub fn stages_of(l: &mut Line<'_>) -> Vec<Stage> {
    let flag = |x: f64| if x == 0.0 { None } else { Some(x == 2.0) };
    (0..l.n())
        .map(|_| {
            let wet_mass = l.f();
            let dry_mass = l.f();
            let engines = (0..l.n()).map(|_| Engine { thrust: l.f(), isp: l.f(), restartable: flag(l.f()), throttleable: flag(l.f()) }).collect();
            Stage { wet_mass, dry_mass, engines }
        })
        .collect()
}

fn uses_cmp(r: &mut Report, l: &mut Line<'_>, got: &[StageUse], n: usize) {
    let m = l.n();
    r.checked += 1;
    if m != got.len() {
        r.fail(format!("line {n}: {} stage uses vs {m}", got.len()));
        return;
    }
    for u in got {
        let want = l.fs(6);
        let g = [u.stage as f64, u.propellant_used, u.propellant_left, u.delta_v, u.time, if u.separated { 1.0 } else { 0.0 }];
        r.cmps(&g, &want, |i| format!("line {n} stage use {} [{i}]", u.stage));
    }
}

/// Compare a refusal or a thrown error; Some(result) when both sides succeeded.
fn outcome<T>(r: &mut Report, l: &mut Line<'_>, n: usize, res: Result<Ascent<T>, String>) -> Option<T> {
    let w = l.word();
    match (w, res) {
        ("refused", Ok(Ascent::Refused { reason, liftoff_tw })) => {
            let tw = l.f();
            r.cmp(liftoff_tw, tw, || format!("line {n} liftoffTW"));
            let want = unhex(l.word());
            r.checked += 1;
            if reason != want {
                r.fail(format!("line {n}: reason {reason:?} vs {want:?}"));
            }
            None
        }
        ("ERR", Err(m)) => {
            let want = unhex(l.word());
            r.checked += 1;
            if m != want {
                r.fail(format!("line {n}: error {m:?} vs {want:?}"));
            }
            None
        }
        ("ok", Ok(Ascent::Ok(x))) => Some(x),
        (w, g) => {
            let got = match g {
                Ok(Ascent::Ok(_)) => "ok".to_string(),
                Ok(Ascent::Refused { reason, .. }) => format!("refused {reason}"),
                Err(e) => format!("error {e}"),
            };
            r.fail(format!("line {n}: {w} vs {got}"));
            None
        }
    }
}

/// replay.txt (core/ts/export-replay.vec.ts): whole replays of the corpus on
/// the real ephemeris (chunks built from the checkpoint asset): outcome,
/// reason, digest, events, burn and stage reports, launch insertion, ascent
/// totals, final state, steps, and dense-output samples seen by on_step.
pub fn replay(text: &str, d: &MissionData, asset: &[u8]) -> Report {
    use crate::mission::plan::decode_plan;
    use crate::mission::replay::{replay, MissionWorld, ReplayOptions};
    let mut r = Report::new("replay");
    let w = crate::data::world();
    let (eph, fm) = crate::data::ephemeris(&w, Some(asset), Some(&d.checkpoint_version)).expect("ephemeris");
    let mut world = MissionWorld { eph, fm, d };
    let mut it = lines(text).peekable();
    let mut replays = 0;
    while let Some(mut l) = it.next() {
        let n = l.number;
        assert_eq!(l.word(), "replay", "replay.txt line {n}");
        let name = l.word().to_string();
        let s = l.word().to_string();
        let mut o = ReplayOptions { stop_on_atmosphere: Some(l.word() == "atm"), ..Default::default() };
        o.max_steps = Some(l.f() as u64);
        o.max_events = Some(l.f() as usize);
        let nbodies: i64 = l.word().parse().unwrap();
        if nbodies >= 0 {
            o.bodies = Some((0..nbodies).map(|_| l.word().to_string()).collect());
        }
        let ns: usize = l.word().parse().unwrap();
        for _ in 0..ns {
            let b = l.word().to_string();
            o.spheres.push((b, l.f()));
        }
        o.allow_version_mismatch = l.word() == "anyversion";
        let plan = decode_plan(&s, d).unwrap_or_else(|e| panic!("{name}: {e}"));
        let samples: std::cell::RefCell<Vec<Vec<f64>>> = std::cell::RefCell::new(Vec::new());
        let mut k = 0u64;
        let res = {
            let mut on_start = |t: f64, y: &[f64]| {
                let mut v = vec![-1.0, t];
                v.extend_from_slice(y);
                samples.borrow_mut().push(v);
            };
            let mut on_step = |t: f64, t_prev: f64, env: &mut dyn crate::mission::events::StepEnv| {
                if k % 97 == 0 {
                    let tm = t_prev + (t - t_prev) * 0.375;
                    let mut out = [0.0; 7];
                    env.interp(tm, &mut out).unwrap();
                    let mut v = vec![k as f64, tm];
                    v.extend_from_slice(&out);
                    samples.borrow_mut().push(v);
                }
                k += 1;
            };
            replay(&plan, &mut world, &o, Some(&mut on_start), Some(&mut on_step))
        };
        let samples = samples.into_inner();
        replays += 1;
        let ctx = |what: &str| format!("{name} (line {n}) {what}");
        let mut l = it.next().unwrap();
        assert_eq!(l.word(), "result");
        let outcome = l.word();
        let reason = unhex(l.word());
        let digest = l.word();
        r.checked += 3;
        if res.outcome != outcome {
            r.fail(format!("{}: {} vs {outcome} ({} / {reason})", ctx("outcome"), res.outcome, res.reason));
        }
        if res.reason != reason {
            r.fail(format!("{}: {:?} vs {reason:?}", ctx("reason"), res.reason));
        }
        if res.digest != digest {
            r.fail(format!("{}: {} vs {digest}", ctx("digest"), res.digest));
        }
        let want = l.fs(6);
        let got = [res.steps as f64, res.elapsed, res.final_t, res.delta_v, res.propellant_used, res.total_delta_v];
        r.cmps(&got, &want, |i| ctx(&format!("totals[{i}]")));
        let nf: usize = l.word().parse().unwrap();
        let wf = l.fs(nf);
        r.checked += 1;
        if res.final_state.len() != nf {
            r.fail(ctx("final state length"));
        } else {
            r.cmps(&res.final_state, &wf, |i| ctx(&format!("finalState[{i}]")));
        }
        let (mut ie, mut ib, mut is, mut ism) = (0usize, 0usize, 0usize, 0usize);
        loop {
            let mut l = it.next().unwrap();
            match l.word() {
                "ev" => {
                    let kind = l.word();
                    let body = l.word();
                    let want = l.fs(12);
                    r.checked += 1;
                    match res.events.get(ie) {
                        Some(e) if e.kind.name() == kind && e.body == body => {
                            let mut g = vec![e.t, e.distance, e.altitude, e.speed];
                            g.extend_from_slice(&e.rel);
                            g.push(e.mass);
                            g.push(e.sphere.unwrap_or(f64::NAN));
                            r.cmps(&g, &want, |i| ctx(&format!("event {ie} {kind} {body} [{i}]")));
                        }
                        g => r.fail(format!("{}: {:?} vs {kind} {body}", ctx(&format!("event {ie}")), g.map(|e| (e.kind.name(), &e.body)))),
                    }
                    ie += 1;
                }
                "burn" => {
                    let want = l.fs(3);
                    if let Some(b) = res.burns.get(ib) {
                        r.cmps(&[b.burn_time, b.propellant, b.delta_v], &want, |i| ctx(&format!("burn {ib} [{i}]")));
                    }
                    ib += 1;
                }
                "stage" => {
                    let want = l.fs(7);
                    if let Some(s) = res.stages.get(is) {
                        let g = [s.stage as f64, s.propellant_used, s.propellant_left, s.delta_v, s.ascent_delta_v, s.separated_at.unwrap_or(f64::NAN), if s.dropped_in_ascent { 1.0 } else { 0.0 }];
                        r.cmps(&g, &want, |i| ctx(&format!("stage {is} [{i}]")));
                    }
                    is += 1;
                }
                "launch" => {
                    let want = l.fs(14);
                    r.checked += 1;
                    match &res.launch {
                        Some(x) => {
                            let mut g = vec![x.t];
                            g.extend_from_slice(&x.state);
                            g.extend_from_slice(&x.geocentric);
                            g.push(x.inclination_deg);
                            r.cmps(&g, &want, |i| ctx(&format!("launch [{i}]")));
                        }
                        None => r.fail(ctx("launch missing")),
                    }
                }
                "ascent" => {
                    let want = l.fs(4);
                    r.checked += 1;
                    match &res.ascent {
                        Some(a) => r.cmps(&[a.upper_stage as f64, a.upper_propellant, a.mass_at_insertion, a.delta_v], &want, |i| ctx(&format!("ascent [{i}]"))),
                        None => {
                            r.fail(ctx("ascent missing"));
                            true
                        }
                    };
                }
                "sample" => {
                    let want = l.fs(9);
                    if let Some(s) = samples.get(ism) {
                        r.cmps(s, &want, |i| ctx(&format!("sample {ism} [{i}]")));
                    }
                    ism += 1;
                }
                "end" => {
                    let c: Vec<usize> = (0..4).map(|_| l.word().parse().unwrap()).collect();
                    r.checked += 1;
                    if c != [res.events.len(), res.burns.len(), res.stages.len(), samples.len()] || c != [ie, ib, is, ism] {
                        r.fail(format!("{}: counts {:?} vs {c:?}", ctx("end"), [res.events.len(), res.burns.len(), res.stages.len(), samples.len()]));
                    }
                    break;
                }
                w => panic!("replay.txt line {}: {w}", l.number),
            }
        }
    }
    r.section = format!("replay ({replays} replays)");
    r
}

/// ascent.txt (core/ts/export-ascent.vec.ts): computeAscent and
/// computeDirectAscent outputs, refusals and thrown errors.
pub fn ascent(text: &str, d: &MissionData) -> Report {
    let mut r = Report::new("ascent");
    let em = EarthModel::new(d);
    for mut l in lines(text) {
        let n = l.number;
        let kind = l.word();
        if kind == "geom" {
            let s = d.site(l.word()).unwrap().clone();
            let (t, a) = (l.f(), l.f());
            let want = l.fs(2);
            let (al, cr) = launch_geometry(&em, &s, t, a);
            r.cmps(&[al, cr], &want, |i| format!("line {n} launchGeometry[{i}]"));
            continue;
        }
        let _vid = l.word();
        let body = if l.word() == "earth" { &d.ascent_earth } else { &d.ascent_moon };
        let _tag = l.word();
        let (gm, radius) = (l.f(), l.f());
        let (x1, x2) = if kind == "asc" { (l.f(), 0.0) } else { (l.f(), l.f()) };
        let geom = Geometry { along_track: l.f(), cross_track: l.f() };
        let stages = stages_of(&mut l);
        if kind == "asc" {
            let res = compute_ascent(&stages, gm, radius, x1, geom, body);
            if let Some(x) = outcome(&mut r, &mut l, n, res) {
                let want = l.fs(14);
                let mut g = vec![x.upper_stage as f64, x.upper_propellant, x.mass_at_insertion, x.delta_v];
                g.extend_from_slice(&x.losses);
                g.extend_from_slice(&[x.liftoff_tw, x.kick]);
                r.cmps(&g, &want, |i| format!("line {n} ascent[{i}]"));
                uses_cmp(&mut r, &mut l, &x.stages, n);
            }
        } else {
            let res = compute_direct_ascent(&stages, gm, radius, x1, x2, geom, body);
            if let Some(x) = outcome(&mut r, &mut l, n, res) {
                let want = l.fs(24);
                let b = &x.burnout;
                let mut g = vec![x.upper_stage as f64, x.upper_propellant, x.mass_at_insertion, x.delta_v];
                g.extend_from_slice(&x.losses);
                g.extend_from_slice(&[x.liftoff_tw, x.kick, b.time, b.altitude_m, b.speed, b.horizontal_speed, b.radial_speed, b.flight_path_angle, b.downrange, b.c3, x.target_c3, x.achieved_c3, x.shortfall]);
                r.cmps(&g, &want, |i| format!("line {n} direct[{i}]"));
                let cut = l.word();
                r.checked += 1;
                if (cut == "target") != x.cutoff_at_target {
                    r.fail(format!("line {n}: cutoff {cut} vs {}", x.cutoff_at_target));
                }
                uses_cmp(&mut r, &mut l, &x.stages, n);
            }
        }
    }
    r
}
