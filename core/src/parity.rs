//! The parity suite: replays the TypeScript-exported vectors through the Rust
//! port and compares every float64 bit for bit. The same code runs natively
//! (`cargo test`, tests/parity.rs) and as WebAssembly (src/wasm.rs, driven by
//! core/scripts/run-wasm.mjs), fed the same fixture bytes.
//!
//! Each section returns a Report: how many values were compared, how many
//! differed, and the first few differences with their inputs.

use crate::cheb::ChebEphemeris;
use crate::dmath;
use crate::dop853::{componentwise_scale, Dop853, Rhs};
use crate::exact_math::{exact_exp, exact_ln, Hasher};
use crate::fixture::{lines, Line, World};
use crate::gravity::{HarmonicField, TesseralTerm, ZonalSeries};
use crate::orientation::{self as ori, BodyFrame, PoleTable, PrimeMeridianKind, RotationModel};
use crate::spacecraft::{self as sc, Burn, BurnFrame, Ephemeris, FixedBodies, ForceModel, PropagateOptions};

pub struct Report {
    pub section: String,
    pub checked: u64,
    pub mismatches: u64,
    pub first: Vec<String>,
}

impl Report {
    pub fn new(section: &str) -> Self {
        Report { section: section.into(), checked: 0, mismatches: 0, first: Vec::new() }
    }
    #[inline]
    fn same(a: f64, b: f64) -> bool {
        a.to_bits() == b.to_bits() || (a != a && b != b)
    }
    /// Compare one value; on a mismatch keep the first few with context.
    #[inline]
    pub fn cmp(&mut self, got: f64, want: f64, ctx: impl FnOnce() -> String) -> bool {
        self.checked += 1;
        if Self::same(got, want) {
            return true;
        }
        self.fail(format!("{} : got {:016x} ({got:e}) want {:016x} ({want:e})", ctx(), got.to_bits(), want.to_bits()));
        false
    }
    pub fn cmps(&mut self, got: &[f64], want: &[f64], ctx: impl Fn(usize) -> String) -> bool {
        let mut ok = true;
        for i in 0..want.len() {
            ok &= self.cmp(got[i], want[i], || ctx(i));
        }
        ok
    }
    pub fn fail(&mut self, msg: String) {
        self.mismatches += 1;
        if self.first.len() < 8 {
            self.first.push(msg);
        }
    }
    pub fn ok(&self) -> bool {
        self.mismatches == 0 && self.checked > 0
    }
    pub fn summary(&self) -> String {
        let mut s = format!("{}: {} values compared, {} mismatches", self.section, self.checked, self.mismatches);
        for f in &self.first {
            s.push_str("\n    ");
            s.push_str(f);
        }
        s
    }
}

fn hx(v: f64) -> String {
    format!("{:016x}", v.to_bits())
}
fn hxs(v: &[f64]) -> String {
    v.iter().map(|&x| hx(x)).collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------

pub fn dmath(text: &str) -> Report {
    let mut r = Report::new("dmath+exact-math");
    for mut l in lines(text) {
        let op = l.word();
        let ln = l.number;
        match op {
            "sin" | "cos" | "sincos" | "sincosinto" | "rad" | "atan" | "ln" | "exp" => {
                let x = l.f();
                let got: Option<Vec<f64>> = match op {
                    "sin" => dmath::try_sin(x).ok().map(|v| vec![v]),
                    "cos" => dmath::try_cos(x).ok().map(|v| vec![v]),
                    "sincos" | "sincosinto" => dmath::try_sincos(x).ok().map(|(s, c)| vec![s, c]),
                    "rad" => Some(vec![dmath::rad(x)]),
                    "atan" => Some(vec![dmath::atan(x)]),
                    "ln" => exact_ln(x).map(|v| vec![v]),
                    _ => exact_exp(x).map(|v| vec![v]),
                };
                check_result(&mut r, &mut l, got, || format!("line {ln}: {op}({})", hx(x)));
            }
            "atan2" => {
                let y = l.f();
                let x = l.f();
                check_result(&mut r, &mut l, Some(vec![dmath::atan2(y, x)]), || format!("line {ln}: atan2({}, {})", hx(y), hx(x)));
            }
            "hash" => {
                let n = l.n();
                let mut h = Hasher::new();
                for _ in 0..n {
                    match l.word() {
                        "f" => {
                            h.f64(l.f());
                        }
                        "u" => {
                            h.u32(l.f() as u32);
                        }
                        "s" => {
                            let k = l.n();
                            let codes: Vec<u16> = (0..k).map(|_| l.f() as u16).collect();
                            h.str_utf16(&codes);
                        }
                        w => panic!("hash token {w}"),
                    }
                }
                assert_eq!(l.word(), "hex");
                let want = l.word();
                let want_u = l.f();
                r.checked += 2;
                if h.hex() != want || h.u32_value() as f64 != want_u {
                    r.fail(format!("line {ln}: hash got {} want {want}", h.hex()));
                }
            }
            w => panic!("dmath.txt line {ln}: unknown op {w}"),
        }
    }
    r
}

fn check_result(r: &mut Report, l: &mut Line<'_>, got: Option<Vec<f64>>, ctx: impl Fn() -> String) {
    if l.is_err() {
        r.checked += 1;
        if got.is_some() {
            r.fail(format!("{}: expected an error, got {:?}", ctx(), got));
        }
        return;
    }
    let want = l.fs(l.rest());
    match got {
        None => r.fail(format!("{}: unexpected error", ctx())),
        Some(g) => {
            r.cmps(&g, &want, |i| format!("{} [{i}]", ctx()));
        }
    }
}

// ---------------------------------------------------------------------------

/// The simple right-hand sides of the DOP853 vectors (same definitions as the exporter).
pub struct TestRhs {
    pub kind: String,
    pub rtol: f64,
    pub atol: f64,
}
impl Rhs for TestRhs {
    fn eval(&mut self, t: f64, y: &[f64], o: &mut [f64]) {
        match self.kind.as_str() {
            "osc" => {
                o[0] = y[1];
                o[1] = -y[0];
            }
            "kepler" => {
                let r2 = y[0] * y[0] + y[1] * y[1];
                let r3 = r2 * r2.sqrt();
                o[0] = y[2];
                o[1] = y[3];
                o[2] = -y[0] / r3;
                o[3] = -y[1] / r3;
            }
            "tdep" => {
                o[0] = y[1];
                o[1] = (-y[0] * (1.0 + 0.1 * t)) / (1.0 + y[2] * y[2]);
                o[2] = 0.01 * y[0] * y[1] - t * 1e-3;
            }
            "blowup" => o[0] = y[0] * y[0],
            k => panic!("unknown rhs {k}"),
        }
    }
    fn scale(&self, y: &[f64], y_new: &[f64], s: &mut [f64]) {
        componentwise_scale(self.rtol, self.atol, y, y_new, s);
    }
}

pub fn dop853(text: &str) -> Report {
    let mut r = Report::new("dop853");
    let mut cur: Option<(TestRhs, Dop853, String, f64, f64, usize)> = None;
    const FR: [f64; 5] = [0.0, 0.13, 0.5, 0.77, 1.0];
    let mut step_no = 0;
    for mut l in lines(text) {
        let ln = l.number;
        let w = l.word();
        match w {
            "case" => {
                let kind = l.word().to_string();
                let mode = l.word().to_string();
                let n = l.n();
                let y0 = l.fs(n);
                let t0 = l.f();
                let t_end = l.f();
                let rtol = l.f();
                let atol = l.f();
                let h = l.f();
                let mut rhs = TestRhs { kind, rtol, atol };
                let mut d = Dop853::new(n);
                d.reset(&mut rhs, t0, &y0, if h > 0.0 { Some(h) } else { None });
                step_no = 0;
                cur = Some((rhs, d, mode, t_end, h, n));
            }
            "init" => {
                let (_, d, ..) = cur.as_mut().unwrap();
                let want = l.f();
                r.cmp(d.h, want, || format!("line {ln}: initial step"));
            }
            "step" | "error" => {
                let is_err = w == "error";
                let (rhs, d, mode, t_end, h, n) = cur.as_mut().unwrap();
                let n = *n;
                let res = if mode == "fixed" { d.step_fixed(rhs, *h) } else { d.step(rhs, *t_end) };
                step_no += 1;
                if is_err {
                    r.checked += 1;
                    if res.is_ok() {
                        r.fail(format!("line {ln}: step {step_no} expected an error, got t={}", d.t));
                    }
                    continue;
                }
                if let Err(e) = res {
                    r.fail(format!("line {ln}: step {step_no}: unexpected error {e:?}"));
                    continue;
                }
                let kind = rhs.kind.clone();
                let ctx = |what: &str| format!("line {ln}: {kind} step {step_no} {what}");
                r.cmp(d.t, l.f(), || ctx("t"));
                let y = l.fs(n);
                r.cmps(&d.y.clone(), &y, |i| ctx(&format!("y[{i}]")));
                r.cmp(d.h, l.f(), || ctx("h"));
                r.cmp(d.accepted as f64, l.f(), || ctx("accepted"));
                r.cmp(d.rejected as f64, l.f(), || ctx("rejected"));
                let mut tmp = vec![0.0; n];
                for (fi, f) in FR.iter().enumerate() {
                    let tq = d.t_previous + (d.t - d.t_previous) * f;
                    d.interpolate(rhs, tq, &mut tmp).unwrap();
                    let want = l.fs(n);
                    r.cmps(&tmp, &want, |i| ctx(&format!("interpolate(frac {fi})[{i}]")));
                }
            }
            "refresh" => {
                let (rhs, d, ..) = cur.as_mut().unwrap();
                d.refresh(rhs);
            }
            "end" => {}
            w => panic!("dop853.txt line {ln}: {w}"),
        }
    }
    r
}

// ---------------------------------------------------------------------------

pub fn gravity(text: &str) -> Report {
    let mut r = Report::new("gravity-field");
    let mut zonals: Vec<ZonalSeries> = Vec::new();
    let mut fields: Vec<HarmonicField> = Vec::new();
    for mut l in lines(text) {
        let ln = l.number;
        match l.word() {
            "zonalcfg" => {
                let radius = l.f();
                let n = l.n();
                zonals.push(ZonalSeries::new(&l.fs(n), radius));
            }
            "fieldcfg" => {
                let radius = l.f();
                let n = l.n();
                let jn = l.fs(n);
                let nt = l.n();
                let tess: Vec<TesseralTerm> = (0..nt).map(|_| (l.f() as u32, l.f() as u32, l.f(), l.f())).collect();
                fields.push(HarmonicField::new(&jn, &tess, radius));
            }
            "zonal" => {
                let ci = l.n();
                let gm = l.f();
                let x = l.fs(3);
                let p = l.fs(3);
                let s = l.f();
                let mut out = [l.f(), l.f(), l.f()];
                zonals[ci].add(gm, x[0], x[1], x[2], p[0], p[1], p[2], &mut out, s);
                let want = l.fs(3);
                r.cmps(&out, &want, |i| format!("line {ln}: zonal cfg {ci} r=({}) pole=({}) [{i}]", hxs(&x), hxs(&p)));
            }
            "field" => {
                let ci = l.n();
                let gm = l.f();
                let x = l.fs(3);
                let s = l.f();
                let mut out = [l.f(), l.f(), l.f()];
                fields[ci].add(gm, x[0], x[1], x[2], &mut out, s);
                let want = l.fs(3);
                r.cmps(&out, &want, |i| format!("line {ln}: field cfg {ci} (degree {}) r=({}) [{i}]", fields[ci].degree, hxs(&x)));
            }
            "fieldicrf" => {
                let ci = l.n();
                let gm = l.f();
                let x = l.fs(3);
                let m = l.fs(9);
                let s = l.f();
                let mut out = [l.f(), l.f(), l.f()];
                fields[ci].add_icrf(gm, x[0], x[1], x[2], &m, &mut out, s);
                let want = l.fs(3);
                r.cmps(&out, &want, |i| format!("line {ln}: fieldIcrf cfg {ci} r=({}) [{i}]", hxs(&x)));
            }
            w => panic!("gravity.txt line {ln}: {w}"),
        }
    }
    r
}

// ---------------------------------------------------------------------------

pub fn orientation(text: &str, world: &World) -> Report {
    let mut r = Report::new("orientation+earth-rotation");
    let ids: Vec<String> = world.models.iter().map(|m| m.id.clone()).collect();
    let mut tables: Vec<PoleTable> = world.models.iter().map(|m| PoleTable::new(m.clone(), ori::POLE_NODE_SPACING)).collect();
    let mut tables0: Vec<PoleTable> = world.models.iter().map(|m| PoleTable::new(m.clone(), 0.0)).collect();
    let mut frames: Vec<BodyFrame> = world.models.iter().map(|m| BodyFrame::new(m.clone(), PrimeMeridianKind::Iau, ori::POLE_NODE_SPACING)).collect();
    let mut frames0: Vec<BodyFrame> = world.models.iter().map(|m| BodyFrame::new(m.clone(), PrimeMeridianKind::Iau, 0.0)).collect();
    let mut era = BodyFrame::new(world.model("earth").clone(), PrimeMeridianKind::EarthRotationAngle, ori::POLE_NODE_SPACING);
    let mut ptabs: Vec<PoleTable> = world.models.iter().map(|m| PoleTable::new(m.clone(), ori::POLE_NODE_SPACING)).collect();
    let offs: Vec<usize> = (0..ids.len()).map(|i| 3 * i).collect();
    let rm_era = RotationModel::earth();
    let rm_iau = RotationModel::earth_iau(world.model("earth"));
    for mut l in lines(text) {
        let ln = l.number;
        match l.word() {
            "earth" => {
                let t = l.f();
                let got = [ori::delta_t(t), ori::earth_prime_meridian_deg(t), rm_era.prime_meridian_deg(t), rm_iau.prime_meridian_deg(t)];
                let want = l.fs(4);
                let names = ["deltaT", "earthPrimeMeridianDeg", "primeMeridianDeg(EARTH_ROTATION)", "primeMeridianDeg(EARTH_ROTATION_IAU)"];
                r.cmps(&got, &want, |i| format!("line {ln}: {}(t={})", names[i], hx(t)));
            }
            "era" => {
                let t = l.f();
                r.cmp(era.theta(t), l.f(), || format!("line {ln}: ERA frame theta(t={})", hx(t)));
                let mut m = [0.0; 9];
                era.at(t, &mut m);
                let want = l.fs(9);
                r.cmps(&m, &want, |i| format!("line {ln}: ERA frame matrix(t={})[{i}]", hx(t)));
            }
            "body" => {
                let id = l.word();
                let i = ids.iter().position(|x| x == id).unwrap();
                let m = &world.models[i];
                let t = l.f();
                let ctx = |what: &str| format!("line {ln}: {id} {what} at t={}", hx(t));
                let a = ori::pole_angles(m, t);
                let want = l.fs(4);
                r.cmps(&[a.ra, a.dec, a.ra_rate, a.dec_rate], &want, |k| ctx(&format!("poleAngles[{k}]")));
                let mut p = [0.0; 3];
                let mut rate = [0.0; 3];
                ori::pole_at(m, t, &mut p, Some(&mut rate));
                let wp = l.fs(3);
                r.cmps(&p, &wp, |k| ctx(&format!("poleAt[{k}]")));
                let wr = l.fs(3);
                r.cmps(&rate, &wr, |k| ctx(&format!("poleAt rate[{k}]")));
                r.cmp(ori::prime_meridian(m, t), l.f(), || ctx("primeMeridian"));
                let mut m9 = [0.0; 9];
                ori::body_to_icrf(m, t, &mut m9);
                let w9 = l.fs(9);
                r.cmps(&m9, &w9, |k| ctx(&format!("bodyToIcrf[{k}]")));
                let mut tab = [0.0; 3];
                tables[i].at(t, &mut tab);
                let w = l.fs(3);
                r.cmps(&tab, &w, |k| ctx(&format!("PoleTable.at[{k}]")));
                tables0[i].at(t, &mut tab);
                let w = l.fs(3);
                r.cmps(&tab, &w, |k| ctx(&format!("PoleTable(spacing 0).at[{k}]")));
                let thp = if tables[i].theta_periodic { tables[i].theta_periodic_at(t) } else { 0.0 };
                r.cmp(thp, l.f(), || ctx("thetaPeriodicAt"));
                r.cmp(frames[i].theta(t), l.f(), || ctx("BodyFrame.theta"));
                frames[i].at(t, &mut m9);
                let w9 = l.fs(9);
                r.cmps(&m9, &w9, |k| ctx(&format!("BodyFrame.at[{k}]")));
                r.cmp(frames0[i].theta(t), l.f(), || ctx("BodyFrame(spacing 0).theta"));
                frames0[i].at(t, &mut m9);
                let w9 = l.fs(9);
                r.cmps(&m9, &w9, |k| ctx(&format!("BodyFrame(spacing 0).at[{k}]")));
                frames[i].at(t, &mut m9);
                let w9 = l.fs(9);
                r.cmps(&m9, &w9, |k| ctx(&format!("sharedBodyFrame.at[{k}]")));
            }
            "polesat" => {
                let t = l.f();
                let mut all = vec![0.0; 3 * ids.len()];
                ori::poles_at(&mut ptabs, t, &mut all, &offs);
                let want = l.fs(3 * ids.len());
                r.cmps(&all, &want, |k| format!("line {ln}: polesAt(t={})[{}].{}", hx(t), ids[k / 3], k % 3));
            }
            w => panic!("orientation.txt line {ln}: {w}"),
        }
    }
    r
}

// ---------------------------------------------------------------------------

/// The golden tests' Digest (test/ephemeris-golden.test.ts).
pub struct Digest {
    h1: u32,
    h2: u32,
    n: u64,
}
impl Default for Digest {
    fn default() -> Self {
        Digest { h1: 0x811c9dc5, h2: 0x9747b28c, n: 0 }
    }
}
impl Digest {
    #[inline]
    pub fn add(&mut self, x: f64) {
        let b = x.to_bits();
        for w in [b as u32, (b >> 32) as u32] {
            self.h1 = (self.h1 ^ w).wrapping_mul(0x01000193);
            self.h2 = ((self.h2 ^ w).wrapping_add(0x9e3779b9)).wrapping_mul(0x85ebca6b);
            self.h2 ^= self.h2 >> 13;
        }
        self.n += 1;
    }
    pub fn add_all(&mut self, a: &[f64]) {
        for &x in a {
            self.add(x);
        }
    }
    pub fn hex(&self) -> String {
        format!("{}:{:08x}{:08x}", self.n, self.h1, self.h2)
    }
}

pub fn ephem(text: &str, eph: &mut ChebEphemeris) -> Report {
    let mut r = Report::new("chebyshev-evaluation");
    let n = eph.layout.count;
    let mut pos = vec![0.0; 3 * n];
    let mut vel = vec![0.0; 3 * n];
    for mut l in lines(text) {
        let ln = l.number;
        match l.word() {
            "positions" => {
                let t = l.f();
                eph.positions(t, &mut pos);
                let want = l.fs(3 * n);
                r.cmps(&pos, &want, |k| format!("line {ln}: positions(t={}) body {} [{}]", hx(t), k / 3, k % 3));
            }
            "evaluate" => {
                let t = l.f();
                eph.evaluate(t, &mut pos, Some(&mut vel));
                let wp = l.fs(3 * n);
                let wv = l.fs(3 * n);
                r.cmps(&pos, &wp, |k| format!("line {ln}: evaluate(t={}) pos body {} [{}]", hx(t), k / 3, k % 3));
                r.cmps(&vel, &wv, |k| format!("line {ln}: evaluate(t={}) vel body {} [{}]", hx(t), k / 3, k % 3));
            }
            "bodystate" => {
                let b = l.n();
                let t = l.f();
                let mut one = [0.0; 6];
                eph.body_state(b, t, &mut one);
                let w = l.fs(6);
                r.cmps(&one, &w, |k| format!("line {ln}: bodyState({b}, t={})[{k}]", hx(t)));
            }
            "evaluatebodies" => {
                let t = l.f();
                let k = l.n();
                let sub: Vec<usize> = (0..k).map(|_| l.n()).collect();
                let mut sp = vec![0.0; 3 * k];
                let mut sv = vec![0.0; 3 * k];
                eph.evaluate_bodies(t, &sub, &mut sp, Some(&mut sv));
                let wp = l.fs(3 * k);
                let wv = l.fs(3 * k);
                r.cmps(&sp, &wp, |q| format!("line {ln}: evaluateBodies pos [{q}]"));
                r.cmps(&sv, &wv, |q| format!("line {ln}: evaluateBodies vel [{q}]"));
            }
            w => panic!("ephem.txt line {ln}: {w}"),
        }
    }
    r
}

/// The golden-test times (deterministic LCG, plus chunk and segment boundaries).
pub fn golden_times(chunk_span: f64, h: f64) -> (Vec<f64>, Vec<f64>) {
    let mut s: u32 = 0x2545f491;
    let mut rnd = || {
        s = s.wrapping_mul(1103515245).wrapping_add(12345);
        s as f64 / 4294967296.0
    };
    let c = chunk_span;
    let random: Vec<f64> = (0..3000).map(|_| (-2.0 + 5.0 * rnd()) * c).collect();
    let mut boundaries = Vec::new();
    for k in -2..=2 {
        for steps in [0.0, 8.0, 16.0, 32.0, 64.0, 128.0, 512.0, 1024.0, 2048.0, 4095.0] {
            let kf = k as f64;
            boundaries.push(kf * c + steps * h);
            boundaries.push(kf * c + steps * h - h / 7.0);
            boundaries.push(kf * c + steps * h + h / 3.0);
        }
    }
    (random, boundaries)
}

/// evalDigests() of test/ephemeris-golden.test.ts.
pub fn eval_digests(eph: &mut ChebEphemeris, world: &World, order: &[f64]) -> [String; 5] {
    let n = eph.layout.count;
    let b = |id: &str| world.body(id);
    let subsets: Vec<Vec<usize>> = vec![
        vec![b("io"), b("earth"), b("jupiter")],
        vec![b("sun")],
        vec![b("saturn"), b("titan"), b("rhea"), b("saturn")],
        vec![b("charon"), b("pluto"), b("moon"), b("triton"), b("oberon")],
        (0..n).rev().collect(),
    ];
    let mut pos = vec![0.0; 3 * n];
    let mut vel = vec![0.0; 3 * n];
    let mut one = [0.0; 6];
    let mut sp = vec![0.0; 3 * n];
    let mut sv = vec![0.0; 3 * n];
    let mut d: [Digest; 5] = Default::default();
    for &t in order {
        eph.positions(t, &mut pos);
        d[0].add_all(&pos);
        eph.evaluate(t, &mut pos, None);
        d[1].add_all(&pos);
        eph.evaluate(t, &mut pos, Some(&mut vel));
        d[2].add_all(&pos);
        d[2].add_all(&vel);
        for body in 0..n {
            eph.body_state(body, t, &mut one);
            d[3].add_all(&one);
        }
        for sub in &subsets {
            let k = 3 * sub.len();
            eph.evaluate_bodies(t, sub, &mut sp[..k], Some(&mut sv[..k]));
            d[4].add_all(&sp[..k]);
            d[4].add_all(&sv[..k]);
            eph.evaluate_bodies(t, sub, &mut sp[..k], None);
            d[4].add_all(&sp[..k]);
        }
    }
    [d[0].hex(), d[1].hex(), d[2].hex(), d[3].hex(), d[4].hex()]
}

/// The evaluation digests pinned in test/ephemeris-golden.test.ts.
pub const GOLDEN_EVAL: [(&str, [&str; 5]); 5] = [
    ("random", ["261000:9171d60c6ce5e3b8", "261000:9171d60c6ce5e3b8", "522000:82c96eaa2dffc3d5", "522000:965b9ca23aa9fcc7", "1134000:d62d40d35ff55e07"]),
    ("boundaries", ["13050:201ad02ff97f504a", "13050:201ad02ff97f504a", "26100:9e67fba0028f6212", "26100:078eb3d8ee7000d0", "56700:143490ce1911c915"]),
    ("ascending", ["52200:d664d112e3cb156b", "52200:d664d112e3cb156b", "104400:261e1a6d315cc001", "104400:7f229b290e82b6f4", "226800:679f22e7fdb47f67"]),
    ("descending", ["52200:6d183e2aea51cfbc", "52200:6d183e2aea51cfbc", "104400:f51abd992531c9f0", "104400:1ba390edc5ca330e", "226800:c10a2dc356fbd9e1"]),
    ("repeated", ["69600:7cdf8a6908631683", "69600:7cdf8a6908631683", "139200:4ecf8271731d99e0", "139200:37df1ba97aa83765", "302400:76af0d755b5f55bf"]),
];

/// The propagation digests pinned in test/ephemeris-golden.test.ts (names as in prop.txt).
pub const GOLDEN_PROP: [(&str, &str); 4] = [
    ("leo30", "185860:ea68c75025bc6e97"),
    ("leoburns", "8590:ae68bf6567e1538c"),
    ("helio", "790:2ab21683eb224e57"),
    ("jovian", "2110:4de7f01a02f9252e"),
];

/// Final state of the canonical determinism scenario (src/fixtures/determinism.ts EXPECTED_HEX).
pub const DETERMINISM_EXPECTED: [u64; 7] = [0x411aa7a37bb3bc76, 0xc161fa6fe7646c9d, 0xc1356c1e6a20aff5, 0x40b9bf3496951c91, 0x40a87fbbb081cd3a, 0x40813171df732ba1, 0x409364190a6de257];

pub fn golden_eval(eph: &mut ChebEphemeris, world: &World) -> Report {
    let mut r = Report::new("golden evaluation digests");
    let (random, boundaries) = golden_times(eph.layout.chunk_span, eph.layout.h);
    let mut asc: Vec<f64> = random[..600].to_vec();
    asc.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let desc: Vec<f64> = asc.iter().rev().copied().collect();
    let rep: Vec<f64> = random[..200].iter().flat_map(|&t| [t, t, t + 1e-3, t]).collect();
    let orders: [&[f64]; 5] = [&random, &boundaries, &asc, &desc, &rep];
    let names = ["positions", "evaluateNull", "evaluateVel", "bodyState", "evaluateBodies"];
    for (i, (name, want)) in GOLDEN_EVAL.iter().enumerate() {
        let got = eval_digests(eph, world, orders[i]);
        for k in 0..5 {
            r.checked += 1;
            if got[k] != want[k] {
                r.fail(format!("{name}.{}: got {} want {}", names[k], got[k], want[k]));
            }
        }
    }
    r
}

/// The derivative's caches never change bits, so a coast derivative can be evaluated alone.
pub fn deriv(text: &str, eph: &mut ChebEphemeris, fm: &mut ForceModel) -> Report {
    let mut r = Report::new("spacecraft derivative");
    for mut l in lines(text) {
        let ln = l.number;
        assert_eq!(l.word(), "deriv");
        let name = l.word();
        let t = l.f();
        let y = l.fs(7);
        let mut out = [0.0; 7];
        sc::coast_derivative(eph, fm, t, &y, &mut out);
        let want = l.fs(7);
        r.cmps(&out, &want, |k| format!("line {ln}: {name} deriv(t={}, y=[{}])[{k}]", hx(t), hxs(&y)));
    }
    r
}

/// Derivative of a one-body ephemeris with the Sun's 1PN term at relativistic speeds (deriv-rel.txt).
pub fn deriv_rel(text: &str) -> Report {
    let mut r = Report::new("1PN derivative (one body, v up to c/2)");
    for mut l in lines(text) {
        let ln = l.number;
        assert_eq!(l.word(), "derivfixed");
        let gm = l.f();
        let t = l.f();
        let y = l.fs(7);
        let mut eph = FixedBodies { gm: vec![gm], pos: vec![0.0; 3] };
        let mut fm = ForceModel::new(&[gm], &[None], Some(0));
        let mut out = [0.0; 7];
        sc::coast_derivative(&mut eph, &mut fm, t, &y, &mut out);
        let want = l.fs(7);
        r.cmps(&out, &want, |k| format!("line {ln}: deriv(y=[{}])[{k}]", hxs(&y)));
    }
    r
}

struct Case {
    name: String,
    kind: String,
    y0: Vec<f64>,
    t0: f64,
    t1: f64,
    rtol: f64,
    dry: f64,
    burns: Vec<Burn>,
}

fn read_case(l: &mut Line<'_>) -> Case {
    let name = l.word().to_string();
    let kind = l.word().to_string();
    let y0 = l.fs(7);
    let t0 = l.f();
    let t1 = l.f();
    let rtol = l.f();
    let dry = l.f();
    let nb = l.n();
    let burns = (0..nb)
        .map(|_| {
            let t_start = l.f();
            let duration = l.f();
            let thrust = l.f();
            let isp = l.f();
            let direction = [l.f(), l.f(), l.f()];
            let orbital = l.f() == 1.0;
            let body = l.f();
            Burn { t_start, duration, thrust, isp, direction, frame: if orbital { BurnFrame::Orbital { body: body as usize } } else { BurnFrame::Inertial } }
        })
        .collect();
    Case { name, kind, y0, t0, t1, rtol, dry, burns }
}

/// What a propagation produced: every step (t, y, dense sample) and the result.
pub struct PropRun {
    pub steps: Vec<[f64; 15]>,
    pub result: sc::PropagateResult,
    pub digest: String,
}

pub fn run_case<E: Ephemeris>(eph: &mut E, fm: &mut ForceModel, y0: &[f64], t0: f64, t1: f64, burns: &[Burn], rtol: f64, dry: f64, record: bool) -> Result<PropRun, sc::PropagateError> {
    let mut d = Digest::default();
    let mut steps = Vec::new();
    let mut cb = |v: &mut sc::StepView<'_, '_, E>| -> bool {
        let t = v.t();
        let tp = v.t_prev();
        let mut rec = [0.0; 15];
        rec[0] = t;
        rec[1..8].copy_from_slice(v.y());
        let mut tmp = [0.0; 7];
        v.interpolate(tp + (t - tp) * 0.37, &mut tmp).expect("interpolate");
        rec[8..15].copy_from_slice(&tmp);
        d.add_all(&rec);
        if record {
            steps.push(rec);
        }
        true
    };
    let res = sc::propagate(eph, fm, y0, t0, t1, burns, &PropagateOptions { rtol, dry_mass: dry }, Some(&mut cb))?;
    d.add(res.t);
    d.add_all(&res.y);
    d.add(res.accepted as f64);
    d.add(res.rejected as f64);
    Ok(PropRun { steps, result: res, digest: d.hex() })
}

pub fn prop(text: &str, eph: &mut ChebEphemeris, fm: &mut ForceModel, section: &str) -> Report {
    let mut r = Report::new(section);
    let mut cur: Option<(Case, PropRun, usize)> = None;
    let mut fixed = FixedBodies { gm: vec![3.986004418e14], pos: vec![0.0, 0.0, 0.0] };
    let mut fixed_fm = ForceModel::point_masses(&fixed.gm.clone());
    let mut ncase = 0;
    for mut l in lines(text) {
        let ln = l.number;
        match l.word() {
            "case" => {
                let c = read_case(&mut l);
                ncase += 1;
                let run = if c.kind == "fixed" {
                    run_case(&mut fixed, &mut fixed_fm, &c.y0, c.t0, c.t1, &c.burns, c.rtol, c.dry, true)
                } else {
                    run_case(eph, fm, &c.y0, c.t0, c.t1, &c.burns, c.rtol, c.dry, true)
                };
                match run {
                    Ok(run) => cur = Some((c, run, 0)),
                    Err(e) => {
                        r.fail(format!("line {ln}: case {} #{ncase}: propagate failed: {e:?}", c.name));
                        cur = None;
                    }
                }
            }
            "step" => {
                let Some((c, run, k)) = cur.as_mut() else { continue };
                let want = l.fs(15);
                if *k >= run.steps.len() {
                    r.fail(format!("line {ln}: {}: Rust took only {} steps", c.name, run.steps.len()));
                    *k += 1;
                    continue;
                }
                // Report the first differing step only (later ones follow from it).
                let got = run.steps[*k];
                let before = r.mismatches;
                let names = |i: usize| match i {
                    0 => "t".to_string(),
                    1..=7 => format!("y[{}]", i - 1),
                    _ => format!("dense(0.37)[{}]", i - 8),
                };
                if r.first.len() < 8 || r.mismatches == 0 {
                    r.cmps(&got, &want, |i| format!("line {ln}: {} step {} {}", c.name, *k + 1, names(i)));
                } else {
                    r.checked += 15;
                    if got.iter().zip(want.iter()).any(|(a, b)| a.to_bits() != b.to_bits()) {
                        r.mismatches += 1;
                    }
                }
                let _ = before;
                *k += 1;
            }
            "final" => {
                let Some((c, run, k)) = cur.as_mut() else { continue };
                let res = &run.result;
                let want_t = l.f();
                let want_y = l.fs(7);
                let acc = l.f();
                let rej = l.f();
                r.cmp(res.t, want_t, || format!("line {ln}: {} #{ncase} final t", c.name));
                r.cmps(&res.y, &want_y, |i| format!("line {ln}: {} #{ncase} final y[{i}]", c.name));
                r.cmp(res.accepted as f64, acc, || format!("line {ln}: {} #{ncase} accepted", c.name));
                r.cmp(res.rejected as f64, rej, || format!("line {ln}: {} #{ncase} rejected", c.name));
                assert_eq!(l.word(), "digest");
                let want_d = l.word();
                if want_d != "-" {
                    r.checked += 1;
                    if run.digest != want_d {
                        r.fail(format!("{}: digest got {} want {want_d} (TypeScript)", c.name, run.digest));
                    }
                    if *k > 0 && *k != run.steps.len() {
                        r.fail(format!("{}: Rust took {} steps, TypeScript {}", c.name, run.steps.len(), k));
                    }
                }
                if let Some((_, g)) = GOLDEN_PROP.iter().find(|(n, _)| *n == c.name) {
                    r.checked += 1;
                    if run.digest != *g {
                        r.fail(format!("{}: digest got {} want {g} (golden test)", c.name, run.digest));
                    }
                }
            }
            "expect" => {
                let name = l.word();
                let Some((c, run, _)) = cur.as_ref() else { continue };
                assert_eq!(c.name, name);
                for i in 0..7 {
                    let w = u64::from_str_radix(l.word(), 16).unwrap();
                    r.cmp(run.result.y[i], f64::from_bits(w), || format!("{name}: EXPECTED_HEX[{i}]"));
                    r.cmp(run.result.y[i], f64::from_bits(DETERMINISM_EXPECTED[i]), || format!("{name}: pinned EXPECTED_HEX[{i}]"));
                }
            }
            w => panic!("{section} line {ln}: {w}"),
        }
    }
    r
}

/// Build the ephemeris and force model of world.txt; `chunk` supplies chunk k's bytes.
pub fn load_world(world: &World, mut chunk: impl FnMut(i64) -> Vec<u8>) -> (ChebEphemeris, ForceModel) {
    let mut eph = ChebEphemeris::new(world.layout.clone(), world.gm.clone(), world.t0);
    for &k in &world.chunks {
        eph.add_chunk(k, crate::fixture::f64s_le(&chunk(k)));
    }
    let fm = ForceModel::new(&world.gm, &world.fields, world.relativity);
    (eph, fm)
}
