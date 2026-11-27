//! Mission-layer parity sections (phase two, layer two). Same Report as src/parity.rs.

use crate::fixture::lines;
use crate::mission::mdata::MissionData;
use crate::mission::plan::{decode_plan, encode_plan, parse_plan, validate_plan_issues, LaunchCheck, Plan};
use crate::parity::Report;

fn unhex(s: &str) -> String {
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
