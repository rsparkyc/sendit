//! Mission-layer parity, last section: objectives, conformance, scoring,
//! campaign sites and the leaderboard verdict (core/ts/export-objectives.vec.ts).
//! Same Report as src/parity.rs.

use crate::fixture::{lines, Line};
use crate::mission::mdata::{mission_of, MissionData};
use crate::mission::objectives::*;
use crate::mission::plan::{decode_plan, parse_plan};
use crate::mission::replay::{replay, MissionWorld, ReplayOptions};
use crate::mission::verify::{check_rules, ObjectiveSummary, Verdict, Verifier};
use crate::parity::Report;
use crate::parity3::unhex;

fn mission_ref(s: &str, d: &MissionData) -> Mission {
    if let Some(id) = s.strip_prefix("c:") {
        return d.mission(id).unwrap_or_else(|| panic!("no campaign mission {id}")).clone();
    }
    let j = unhex(s.strip_prefix("j:").expect("mission ref"));
    mission_of(&crate::json::parse(&j).expect("mission json"))
}

fn bool_of(x: f64) -> bool {
    x == 1.0
}

fn str_cmp(r: &mut Report, got: &str, want: &str, ctx: impl FnOnce() -> String) {
    r.checked += 1;
    if got != want {
        r.fail(format!("{}: {got:?} vs {want:?}", ctx()));
    }
}

fn read_replay_options(l: &mut Line<'_>) -> ReplayOptions {
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
    o
}

fn board_of(s: &str) -> Board {
    match s {
        "combined" => Board::Combined,
        "delta-v" => Board::DeltaV,
        _ => Board::Time,
    }
}

fn summaries_cmp<'a>(r: &mut Report, it: &mut impl Iterator<Item = Line<'a>>, got: &[ObjectiveSummary], n: usize, ctx: &str) {
    r.checked += 1;
    if got.len() != n {
        r.fail(format!("{ctx}: {} objective summaries vs {n}", got.len()));
    }
    for k in 0..n {
        let mut l = it.next().unwrap();
        assert_eq!(l.word(), "vobj");
        let kind = l.word();
        let ok = bool_of(l.f());
        let detail = unhex(l.word());
        if let Some(g) = got.get(k) {
            str_cmp(r, &g.kind, kind, || format!("{ctx} objective {k} kind"));
            r.checked += 1;
            if g.ok != ok {
                r.fail(format!("{ctx} objective {k} ok {} vs {ok}", g.ok));
            }
            str_cmp(r, &g.detail, &detail, || format!("{ctx} objective {k} detail"));
        }
    }
}

/// objectives.txt. `asset`: the checkpoint asset (chunks are built from it, as in the replay section).
pub fn objectives(text: &str, d: &MissionData, asset: &[u8]) -> Report {
    let mut r = Report::new("objectives");
    let w = crate::data::world();
    let (eph, fm) = crate::data::ephemeris(&w, Some(asset), Some(&d.checkpoint_version)).expect("ephemeris");
    let mut world = MissionWorld { eph, fm, d };
    let mut poles = Poles::new(&w, d);
    let mut verifier = Verifier::new(d, Some(asset)).expect("verifier");
    let (mut nrep, mut neval, mut nconf, mut nverify, mut nkey) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut it = lines(text).peekable();
    let mut cur: Option<(crate::mission::replay::ReplayResult, crate::mission::plan::Plan, String)> = None;
    let mut site_mission: Option<Mission> = None;
    while let Some(mut l) = it.next() {
        let n = l.number;
        match l.word() {
            "key" => {
                let succ = l.word() == "ok";
                let (dv, t) = (l.f(), l.f());
                let w = ScoreWeights { delta_v_ref: l.f(), delta_v_weight: l.f(), time_ref: l.f(), time_weight: l.f() };
                let want = l.fs(3);
                r.cmps(&[score(succ, dv, t, &w), delta_v_key(dv), time_key(t)], &want, |i| format!("line {n} key[{i}]"));
                nkey += 1;
            }
            "cmp" => {
                let b = board_of(l.word());
                let a = LeaderboardKeys { score: l.f(), delta_v: l.f(), time: l.f() };
                let bb = LeaderboardKeys { score: l.f(), delta_v: l.f(), time: l.f() };
                let want = l.f();
                r.cmp(compare_keys(b, &a, &bb), want, || format!("line {n} compareKeys"));
            }
            "sites" => {
                let id = l.word();
                let m = d.mission(id).unwrap().clone();
                let ls = m.launch_sites.clone().unwrap();
                str_cmp(&mut r, &par_site(&ls).unwrap(), l.word(), || format!("line {n} parSite"));
                let k: usize = l.word().parse().unwrap();
                let want: Vec<String> = (0..k).map(|_| l.word().to_string()).collect();
                str_cmp(&mut r, &offered_sites(&ls).join(","), &want.join(","), || format!("line {n} offeredSites"));
                let (a, b) = loosest_limits(&ls);
                let wl = l.fs(2);
                r.cmps(&[a, b], &wl, |i| format!("line {n} loosestLimits[{i}]"));
                let k: usize = l.word().parse().unwrap();
                let want: Vec<String> = (0..k).map(|_| l.word().to_string()).collect();
                str_cmp(&mut r, &allowed_sites(&m).unwrap_or_default().join(","), &want.join(","), || format!("line {n} allowedSites"));
                site_mission = Some(m);
            }
            "site" => {
                let m = site_mission.as_ref().unwrap();
                let s = l.word();
                let ls = m.launch_sites.as_ref().unwrap();
                let sp = site_par(ls, s);
                let has = l.word() == "par";
                r.checked += 1;
                match (sp, has) {
                    (Some(w), true) => {
                        let want = l.fs(4);
                        r.cmps(&[w.delta_v_ref, w.delta_v_weight, w.time_ref, w.time_weight], &want, |i| format!("line {n} sitePar {s} [{i}]"));
                    }
                    (None, false) => {}
                    _ => r.fail(format!("line {n}: sitePar {s} presence")),
                }
                let k: usize = l.word().parse().unwrap();
                let want = l.fs(k);
                let mf = mission_for_site(m, s);
                let got: Vec<f64> = mf.objectives.iter().filter_map(|o| match o {
                    Objective::MaxDeltaV(x) | Objective::MaxTime(x) => Some(*x),
                    _ => None,
                }).collect();
                r.checked += 1;
                if got.len() != k {
                    r.fail(format!("line {n}: missionForSite {s} limits {got:?}"));
                } else {
                    r.cmps(&got, &want, |i| format!("line {n} missionForSite {s} [{i}]"));
                }
            }
            "scoring" => {
                // The mission's par is sitePar(parSite) of its own table (plane-change: the Cape, its only offered site).
                let m = site_mission.as_ref().unwrap();
                let ls = m.launch_sites.as_ref().unwrap();
                let want = l.fs(4);
                let sc = &m.scoring;
                r.cmps(&[sc.delta_v_ref, sc.delta_v_weight, sc.time_ref, sc.time_weight], &want, |i| format!("line {n} scoring[{i}]"));
                let p = site_par(ls, &par_site(ls).unwrap()).unwrap();
                r.cmps(&[p.delta_v_ref, p.delta_v_weight, p.time_ref, p.time_weight], &want, |i| format!("line {n} sitePar(parSite)[{i}]"));
                let (a, b) = loosest_limits(ls);
                let lim: Vec<f64> = m.objectives.iter().filter_map(|o| match o {
                    Objective::MaxDeltaV(x) | Objective::MaxTime(x) => Some(*x),
                    _ => None,
                }).collect();
                r.cmps(&lim, &[a, b], |i| format!("line {n} loosest limit objective [{i}]"));
            }
            "replay" => {
                let name = l.word().to_string();
                let s = l.word().to_string();
                let o = read_replay_options(&mut l);
                let plan = decode_plan(&s, d).unwrap_or_else(|e| panic!("{name}: {e}"));
                let res = replay(&plan, &mut world, &o, None, None);
                nrep += 1;
                let mut l = it.next().unwrap();
                assert_eq!(l.word(), "digest");
                str_cmp(&mut r, &res.digest, l.word(), || format!("{name}: digest"));
                str_cmp(&mut r, res.outcome, l.word(), || format!("{name}: outcome"));
                cur = Some((res, plan, name));
            }
            "replayend" => cur = None,
            "eval" => {
                let (res, plan, name) = cur.as_ref().expect("eval outside a replay");
                let mref = l.word();
                let m = mission_ref(mref, d);
                let with_plan = l.word() == "plan";
                let epoch = l.f();
                let e = evaluate(&m, res, &mut world, &mut poles, epoch, if with_plan { Some(plan) } else { None });
                neval += 1;
                let ctx = format!("{name} (line {n}) {}", m.id);
                let mut l = it.next().unwrap();
                assert_eq!(l.word(), "evres");
                let want = l.fs(6);
                r.cmps(&[if e.success { 1.0 } else { 0.0 }, e.delta_v, e.ascent_delta_v, e.flight_delta_v, e.mission_time, e.score], &want, |i| format!("{ctx} evaluation[{i}]"));
                let has_keys = l.word() == "keys";
                r.checked += 1;
                match (e.keys, has_keys) {
                    (Some(k), true) => {
                        let want = l.fs(3);
                        r.cmps(&[k.score, k.delta_v, k.time], &want, |i| format!("{ctx} keys[{i}]"));
                    }
                    (None, false) => {}
                    (_, has) => {
                        if has {
                            l.fs(3);
                        }
                        r.fail(format!("{ctx}: keys presence {:?}", e.keys));
                    }
                }
                str_cmp(&mut r, e.site.as_deref().unwrap_or("-"), l.word(), || format!("{ctx} site"));
                let no: usize = l.word().parse().unwrap();
                let nv = l.word();
                r.checked += 1;
                if e.objectives.len() != no {
                    r.fail(format!("{ctx}: {} objective results vs {no}", e.objectives.len()));
                }
                for k in 0..no {
                    let mut l = it.next().unwrap();
                    assert_eq!(l.word(), "obj");
                    let kind = l.word();
                    let ok = bool_of(l.f());
                    let at = l.f();
                    let max = l.f();
                    let detail = unhex(l.word());
                    if let Some(g) = e.objectives.get(k) {
                        str_cmp(&mut r, g.objective.kind(), kind, || format!("{ctx} objective {k} kind"));
                        r.checked += 1;
                        if g.ok != ok {
                            r.fail(format!("{ctx} objective {k} ({kind}) ok {} vs {ok}: {:?} / {detail:?}", g.ok, g.detail));
                        }
                        r.cmp(g.at.unwrap_or(f64::NAN), at, || format!("{ctx} objective {k} ({kind}) at"));
                        let gmax = match g.objective {
                            Objective::MaxDeltaV(x) | Objective::MaxTime(x) => x,
                            _ => f64::NAN,
                        };
                        r.cmp(gmax, max, || format!("{ctx} objective {k} max"));
                        str_cmp(&mut r, &g.detail, &detail, || format!("{ctx} objective {k} ({kind}) detail"));
                    }
                }
                r.checked += 1;
                match (&e.rule_violations, nv) {
                    (None, "-") => {}
                    (Some(v), w) if w != "-" => {
                        let k: usize = w.parse().unwrap();
                        if v.len() != k {
                            r.fail(format!("{ctx}: {} rule violations vs {k}", v.len()));
                        }
                        for j in 0..k {
                            let mut l = it.next().unwrap();
                            assert_eq!(l.word(), "viol");
                            let want = unhex(l.word());
                            if let Some(g) = v.get(j) {
                                str_cmp(&mut r, g, &want, || format!("{ctx} violation {j}"));
                            }
                        }
                    }
                    (_, w) => {
                        r.fail(format!("{ctx}: rule violation presence"));
                        if w != "-" {
                            for _ in 0..w.parse::<usize>().unwrap() {
                                it.next();
                            }
                        }
                    }
                }
            }
            "conf" => {
                let m = mission_ref(l.word(), d);
                let s = l.word();
                let plan = parse_plan(s, d, false).unwrap_or_else(|e| panic!("line {n}: {e}"));
                let ni: usize = l.word().parse().unwrap();
                let nr: usize = l.word().parse().unwrap();
                let issues = check_plan_conformance(&m, &plan, d.default_ascent_time_s, d.default_downrange_deg);
                let rules = check_rules(&plan, &m, d);
                nconf += 1;
                r.checked += 1;
                if issues.len() != ni || rules.len() != nr {
                    r.fail(format!("line {n} {}: {} / {} issues vs {ni} / {nr}: {:?}", m.id, issues.len(), rules.len(), rules.iter().map(|i| &i.message).collect::<Vec<_>>()));
                }
                let all: Vec<&ConformanceIssue> = issues.iter().chain(rules.iter()).collect();
                for k in 0..ni + nr {
                    let mut l = it.next().unwrap();
                    assert_eq!(l.word(), "issue");
                    let code = l.word();
                    let path = unhex(l.word());
                    let msg = unhex(l.word());
                    if let Some(g) = all.get(k) {
                        str_cmp(&mut r, g.code, code, || format!("line {n} {} issue {k} code", m.id));
                        str_cmp(&mut r, &g.path, &path, || format!("line {n} {} issue {k} path", m.id));
                        str_cmp(&mut r, &g.message, &msg, || format!("line {n} {} issue {k} message", m.id));
                    }
                }
            }
            "verify" => {
                let plan = unhex(l.word());
                let id = unhex(l.word());
                let version = unhex(l.word());
                let site = match l.word() {
                    "-" => None,
                    s => Some(s.to_string()),
                };
                let v = verifier.verify(&plan, &id, &version, site.as_deref());
                nverify += 1;
                let ctx = format!("verify line {n} ({id} {version} {site:?})");
                let mut l = it.next().unwrap();
                match (l.word(), &v) {
                    ("accepted", Verdict::Accepted { score, delta_v, mission_time, digest, site, steps, objectives }) => {
                        let want = l.fs(3);
                        r.cmps(&[*score, *delta_v, *mission_time], &want, |i| format!("{ctx} values[{i}]"));
                        str_cmp(&mut r, digest, l.word(), || format!("{ctx} digest"));
                        str_cmp(&mut r, site, l.word(), || format!("{ctx} site"));
                        r.cmp(*steps as f64, l.f(), || format!("{ctx} steps"));
                        let k: usize = l.word().parse().unwrap();
                        summaries_cmp(&mut r, &mut it, objectives, k, &ctx);
                    }
                    ("rejected", Verdict::Rejected { code, message, flight }) => {
                        str_cmp(&mut r, code, l.word(), || format!("{ctx} code"));
                        str_cmp(&mut r, message, &unhex(l.word()), || format!("{ctx} message"));
                        let has = l.word() == "flight";
                        r.checked += 1;
                        match (flight, has) {
                            (Some((outcome, reason, objs, digest)), true) => {
                                str_cmp(&mut r, outcome, l.word(), || format!("{ctx} outcome"));
                                str_cmp(&mut r, reason, &unhex(l.word()), || format!("{ctx} reason"));
                                str_cmp(&mut r, digest, l.word(), || format!("{ctx} digest"));
                                let k: usize = l.word().parse().unwrap();
                                summaries_cmp(&mut r, &mut it, objs, k, &ctx);
                            }
                            (None, false) => {}
                            _ => {
                                r.fail(format!("{ctx}: flight detail presence"));
                                while it.peek().is_some_and(|x| x.peek() == Some("vobj")) {
                                    it.next();
                                }
                            }
                        }
                    }
                    (w, g) => {
                        r.fail(format!("{ctx}: {w} vs {g:?}"));
                        // Skip the expected summaries.
                        while it.peek().is_some_and(|x| x.peek() == Some("vobj")) {
                            it.next();
                        }
                    }
                }
            }
            "counts" => {
                let (a, b): (usize, usize) = (l.word().parse().unwrap(), l.word().parse().unwrap());
                r.checked += 1;
                if a != nrep {
                    r.fail(format!("counts: {nrep} replays vs {a} ({b} reference verdicts)"));
                }
            }
            w => panic!("objectives.txt line {n}: {w}"),
        }
    }
    r.section = format!("objectives ({nkey} key vectors, {nrep} replays, {neval} evaluations, {nconf} conformance checks, {nverify} verdicts)");
    r
}
