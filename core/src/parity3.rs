//! Mission-layer parity sections (phase two, layer two). Same Report as src/parity.rs.

use crate::fixture::lines;
use crate::mission::mdata::MissionData;
use crate::mission::plan::{decode_plan, encode_plan, parse_plan, validate_plan_issues, LaunchCheck, Plan};
use crate::parity::Report;

pub fn unhex(s: &str) -> String {
    if s == "-" {
        return String::new();
    }
    let b: Vec<u8> = (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect();
    String::from_utf8(b).expect("utf-8")
}

/// plan.txt (core/ts/export-plan.vec.ts): decode outcome (re-encoding, or the
/// error message) of every string, and validatePlanIssues (code, path, burn,
/// message) of every plan the bytes describe.
pub fn plan_codec(text: &str, d: &MissionData) -> Report {
    let mut r = Report::new("plan codec + validation");
    let mut cur = String::new();
    let mut lenient: Option<Result<Plan, String>> = None;
    let mut issues: Vec<crate::mission::plan::Issue> = Vec::new();
    let mut k = 0usize;
    for mut l in lines(text) {
        match l.word() {
            "plan" => {
                let id = l.word();
                let s = l.word();
                cur = if l.peek() == Some("hex") { unhex(s) } else { s.to_string() };
                lenient = None;
                let _ = id;
            }
            "decode" => {
                r.checked += 1;
                let got = decode_plan(&cur, d);
                match (l.word(), got) {
                    ("ok", Ok(p)) => {
                        let want = l.word();
                        match encode_plan(&p, d) {
                            Ok(s2) if s2 == want => {}
                            other => r.fail(format!("{cur}: re-encoded {other:?} vs {want}")),
                        }
                    }
                    ("err", Err(m)) => {
                        let want = unhex(l.word());
                        if m != want {
                            r.fail(format!("{cur:.60}: error {m:?} vs {want:?}"));
                        }
                    }
                    (w, g) => r.fail(format!("{cur:.60}: decode {w} vs {:?}", g.map(|_| "ok"))),
                }
            }
            "issues" => {
                let mode = if l.word() == "full" { LaunchCheck::Full } else { LaunchCheck::Structural };
                let afs: i64 = l.word().parse().unwrap();
                let n: usize = l.word().parse().unwrap();
                let p = lenient.get_or_insert_with(|| parse_plan(&cur, d, false));
                r.checked += 1;
                match p {
                    Ok(p) => {
                        issues = validate_plan_issues(p, d, mode, if afs < 0 { None } else { Some(afs as usize) });
                        if issues.len() != n {
                            r.fail(format!("{cur:.60}: {} issues vs {n}: {:?}", issues.len(), issues.iter().map(|i| &i.message).collect::<Vec<_>>()));
                        }
                    }
                    Err(e) => {
                        r.fail(format!("{cur:.60}: lenient parse failed: {e}"));
                        issues.clear();
                    }
                }
                k = 0;
            }
            "issue" => {
                let code = l.word();
                let path = unhex(l.word());
                let burn: i64 = l.word().parse().unwrap();
                let msg = unhex(l.word());
                r.checked += 1;
                match issues.get(k) {
                    Some(i) if i.code == code && i.path == path && i.burn.map_or(-1, |b| b as i64) == burn && i.message == msg => {}
                    got => r.fail(format!("{cur:.60}: issue {k} {got:?} vs {code} {path} {burn} {msg:?}")),
                }
                k += 1;
            }
            w => panic!("plan.txt line {}: {w}", l.number),
        }
    }
    r
}

/// launch.txt (core/ts/export-launch.vec.ts): Earth orientation, site frames,
/// launch planes and geometry, corridor checks, parking-orbit and
/// direct-injection states (or the refusal message).
pub fn launch(text: &str, d: &MissionData) -> Report {
    use crate::mission::launch::*;
    let mut r = Report::new("launch");
    let em = EarthModel::new(d);
    let site = |id: &str| d.site(id).unwrap().clone();
    for mut l in lines(text) {
        let n = l.number;
        match l.word() {
            "rot" => {
                let t = l.f();
                let want = l.fs(13);
                let m = em.body_to_icrf(t);
                let p = em.pole_at(t);
                let mut got = m.to_vec();
                got.extend_from_slice(&p);
                got.push(em.prime_meridian_deg(t));
                r.cmps(&got, &want, |i| format!("line {n} rot[{i}]"));
            }
            "geo" => {
                let (a, b, h) = (l.f(), l.f(), l.f());
                let want = l.fs(3);
                r.cmps(&em.geodetic_to_body_fixed(a, b, h), &want, |i| format!("line {n} geo[{i}]"));
            }
            "sicrf" => {
                let (a, b, h, t) = (l.f(), l.f(), l.f(), l.f());
                let want = l.fs(3);
                r.cmps(&em.site_icrf(a, b, h, t), &want, |i| format!("line {n} siteIcrf[{i}]"));
            }
            "az" => {
                let s = site(l.word());
                let a = l.f();
                let want = l.word() == "yes";
                r.checked += 1;
                if azimuth_allowed(&s, a) != want {
                    r.fail(format!("line {n}: azimuthAllowed {} {a} vs {want}", s.id));
                }
            }
            "frame" => {
                let s = site(l.word());
                let t = l.f();
                let want = l.fs(15);
                let f = site_frame(&em, &s, t);
                let got: Vec<f64> = [f.r, f.up, f.east, f.north, f.pole].concat();
                r.cmps(&got, &want, |i| format!("line {n} siteFrame[{i}]"));
            }
            "plane" => {
                let s = site(l.word());
                let (t, a) = (l.f(), l.f());
                let want = l.fs(14);
                let p = launch_plane(&em, &s, t, a);
                let (al, cr) = launch_geometry(&em, &s, t, a);
                let mut got: Vec<f64> = [p.up, p.downrange, p.normal, p.pole].concat();
                got.extend_from_slice(&[al, cr]);
                r.cmps(&got, &want, |i| format!("line {n} plane/geometry[{i}]"));
            }
            kind @ ("park" | "direct") => {
                let sid = l.word().to_string();
                let (spec, burnout) = if kind == "park" {
                    let mode = l.word();
                    let (t, a, alt, asc, dr) = (l.f(), l.f(), l.f(), l.f(), l.f());
                    let default = mode == "default";
                    let spec = ParkingOrbitLaunch {
                        site_id: sid,
                        launch_time: t,
                        azimuth_deg: a,
                        altitude_m: alt,
                        ascent_time_s: if default { None } else { Some(asc) },
                        downrange_deg: if default { None } else { Some(dr) },
                        circularization: match mode {
                            "default" => None,
                            "j2-mean" => Some(Ok(Circularization::J2Mean)),
                            "two-body" => Some(Ok(Circularization::TwoBody)),
                            other => Some(Err(other.to_string())),
                        },
                    };
                    (spec, None)
                } else {
                    let (t, a) = (l.f(), l.f());
                    let b = BurnoutState { time: l.f(), altitude_m: l.f(), horizontal_speed: l.f(), radial_speed: l.f(), downrange: l.f() };
                    (ParkingOrbitLaunch { site_id: sid, launch_time: t, azimuth_deg: a, altitude_m: 0.0, ascent_time_s: None, downrange_deg: None, circularization: None }, Some(b))
                };
                let outcome = l.word();
                let want_call: Vec<f64> = if outcome == "ok" { l.fs(8) } else { vec![0.0; 8] };
                let mut asked: Vec<f64> = Vec::new();
                let res = {
                    let mut eph = |t: f64, out: &mut [f64; 6]| {
                        asked.push(t);
                        out.copy_from_slice(&want_call[2..8]);
                    };
                    match &burnout {
                        None => launch_state(d, &em, &spec, &mut eph),
                        Some(b) => direct_injection_state(d, &em, &spec.site_id, spec.launch_time, spec.azimuth_deg, b, &mut eph),
                    }
                };
                match (outcome, res) {
                    ("ok", Ok(x)) => {
                        let want = l.fs(17);
                        r.checked += 1;
                        if asked.len() != 1 {
                            r.fail(format!("line {n}: {} ephemeris calls", asked.len()));
                        }
                        r.cmp(asked.first().copied().unwrap_or(f64::NAN), want_call[1], || format!("line {n} ephemeris time"));
                        let mut got = vec![x.t];
                        got.extend_from_slice(&x.state);
                        got.extend_from_slice(&x.geocentric);
                        got.extend_from_slice(&x.normal);
                        got.push(x.inclination_deg);
                        r.cmps(&got, &want, |i| format!("line {n} {kind}[{i}]"));
                    }
                    ("ERR", Err(m)) => {
                        r.checked += 1;
                        let want = unhex(l.word());
                        if m != want {
                            r.fail(format!("line {n}: error {m:?} vs {want:?}"));
                        }
                    }
                    (w, g) => r.fail(format!("line {n}: {w} vs {:?}", g.map(|_| "ok"))),
                }
            }
            w => panic!("launch.txt line {n}: {w}"),
        }
    }
    r
}
