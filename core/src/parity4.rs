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
