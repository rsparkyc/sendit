//! The leaderboard verdict as a process (the shape of a native Lambda handler,
//! without the runtime API loop): reads one submission from stdin as
//! "plan\nmission id\nversion\nsite" (site "-": the plan's own), prints the
//! verdict, and the phase timings on stderr. Measures what a cold start costs.
//!
//!   verify <checkpoint asset> < submission.txt
//!   verify <checkpoint asset> --noop   (process start, data parse, asset decode only)

use sendit_core::mission::{mdata::MissionData, verify::Verifier};
use std::io::Read;
use std::time::Instant;

fn main() {
    let t0 = Instant::now();
    let args: Vec<String> = std::env::args().collect();
    let asset = std::fs::read(args.get(1).expect("usage: verify <checkpoint asset> [--noop] < submission")).expect("checkpoint asset");
    let d: &'static MissionData = Box::leak(Box::new(MissionData::parse(sendit_core::data::MISSION_JSON)));
    let mut v = Verifier::new(d, Some(&asset)).expect("verifier");
    let t1 = Instant::now();
    if args.get(2).map(|s| s.as_str()) == Some("--noop") {
        eprintln!("init {:.2} ms", (t1 - t0).as_secs_f64() * 1e3);
        return;
    }
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let f: Vec<&str> = input.trim_end_matches('\n').split('\n').collect();
    assert!(f.len() >= 4, "submission: plan, mission id, version, site on four lines");
    let site = if f[3] == "-" { None } else { Some(f[3]) };
    let verdict = v.verify(f[0], f[1], f[2], site);
    let t2 = Instant::now();
    println!("{verdict:?}");
    eprintln!("init {:.2} ms, verify {:.2} ms", (t1 - t0).as_secs_f64() * 1e3, (t2 - t1).as_secs_f64() * 1e3);
}
