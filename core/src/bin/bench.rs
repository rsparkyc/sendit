//! Native benchmark of the workloads of test/ephemeris-bench.test.ts, on the
//! chunks and cases exported by `pnpm core:vectors`. Run:
//!   cargo run --release --bin bench
//! Reports median, IQR and range over repeated runs after warm-up.

use sendit_core::fixture::{lines, World};
use sendit_core::parity;
use sendit_core::spacecraft::{self as sc, Burn, BurnFrame, PropagateOptions};
use std::hint::black_box;
use std::path::PathBuf;
use std::time::Instant;

fn dir() -> PathBuf {
    std::env::var_os("SENDIT_FIXTURES").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/generated"))
}

struct Stats(Vec<f64>);
impl Stats {
    fn fmt(mut self, unit: &str, d: usize) -> String {
        self.0.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let s = &self.0;
        let q = |p: f64| s[((p * (s.len() - 1) as f64 + 0.5).floor() as usize).min(s.len() - 1)];
        format!("median {:.d$} {unit} (IQR {:.d$}..{:.d$}, range {:.d$}..{:.d$})", q(0.5), q(0.25), q(0.75), s[0], s[s.len() - 1])
    }
}
fn per_call(times: &[f64], reps: usize, warm: usize, mut f: impl FnMut(f64)) -> Stats {
    let mut out = Vec::new();
    for r in 0..warm + reps {
        let t0 = Instant::now();
        for &t in times {
            f(t);
        }
        if r >= warm {
            out.push(t0.elapsed().as_nanos() as f64 / times.len() as f64);
        }
    }
    Stats(out)
}
fn wall(reps: usize, warm: usize, mut f: impl FnMut()) -> Stats {
    let mut out = Vec::new();
    for r in 0..warm + reps {
        let t0 = Instant::now();
        f();
        if r >= warm {
            out.push(t0.elapsed().as_secs_f64() * 1e3);
        }
    }
    Stats(out)
}

struct Case {
    name: String,
    y0: Vec<f64>,
    t0: f64,
    t1: f64,
    rtol: f64,
    dry: f64,
    burns: Vec<Burn>,
}
fn cases(file: &str) -> Vec<Case> {
    let text = std::fs::read_to_string(dir().join(file)).unwrap();
    let mut out = Vec::new();
    for mut l in lines(&text) {
        if l.word() != "case" {
            continue;
        }
        let name = l.word().to_string();
        let _kind = l.word();
        let y0 = l.fs(7);
        let (t0, t1, rtol, dry) = (l.f(), l.f(), l.f(), l.f());
        let nb = l.n();
        let burns = (0..nb)
            .map(|_| {
                let v = l.fs(9);
                Burn { t_start: v[0], duration: v[1], thrust: v[2], isp: v[3], direction: [v[4], v[5], v[6]], frame: if v[7] == 1.0 { BurnFrame::Orbital { body: v[8] as usize } } else { BurnFrame::Inertial } }
            })
            .collect();
        out.push(Case { name, y0, t0, t1, rtol, dry, burns });
    }
    out
}

/// `bench chunk`: build one chunk from its checkpoint in the asset, and the
/// lazy builder from the epoch (also makes the n-body integrator and the chunk
/// fitter part of this binary, which scripts/check-no-fma.sh scans).
fn bench_chunk() {
    use sendit_core::chunk::{bases_for, build_chunk, decode_checkpoint_asset, initial_checkpoint, ChunkBuilder};
    let w = sendit_core::data::world();
    let asset = std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/physics/data/checkpoints-1950-2100.bin")).unwrap();
    let a = decode_checkpoint_asset(&asset).unwrap();
    let bases = bases_for(&w.layout);
    let cp = a.checkpoints.iter().find(|c| c.boundary == 0).unwrap().clone();
    let st = wall(5, 1, || {
        black_box(build_chunk(&w.layout, &w.gm, &w.nbody, &bases, w.t0, 0, &cp));
    });
    println!("build chunk 0 from the asset checkpoint: {}", st.fmt("ms", 1));
    let st = wall(3, 0, || {
        let mut b = ChunkBuilder::new(w.layout.clone(), w.gm.clone(), w.nbody.clone(), w.t0, initial_checkpoint(&w.initial));
        let mut built = std::collections::HashMap::new();
        b.extend_to(0, &mut built);
        black_box(built.len());
    });
    println!("lazy builder, chunk 0 from the epoch: {}", st.fmt("ms", 1));
}

/// Mission layer (also makes its code reachable for scripts/check-no-fma.sh).
fn bench_mission() {
    use sendit_core::mission::{ascent, launch, mdata::MissionData, plan};
    let d = MissionData::parse(sendit_core::data::MISSION_JSON);
    let em = launch::EarthModel::new(&d);
    let site = d.sites[0].clone();
    let az = site.azimuth_min_deg;
    let st = wall(25, 5, || {
        for i in 0..1000 {
            let t = black_box(i as f64 * 8.64e4);
            let spec = launch::ParkingOrbitLaunch { site_id: site.id.clone(), launch_time: t, azimuth_deg: az, altitude_m: 2e5, ascent_time_s: None, downrange_deg: None, circularization: None };
            let r = launch::launch_state(&d, &em, &spec, &mut |_, e| *e = [0.0; 6]).unwrap();
            let b = launch::BurnoutState { time: 500.0, altitude_m: 2e5, horizontal_speed: 7800.0, radial_speed: 10.0, downrange: 0.2 };
            let r2 = launch::direct_injection_state(&d, &em, &site.id, t, az, &b, &mut |_, e| *e = [0.0; 6]).unwrap();
            black_box((r.state, r2.state, launch::launch_geometry(&em, &site, t, az)));
        }
    });
    println!("1000 x (launchState + directInjectionState + launchGeometry): {}", st.fmt("ms", 2));
    let (_, f9) = d.vehicles.iter().find(|(id, _)| id == "falcon-9").unwrap();
    let mut stack = f9.clone();
    stack.push(plan::Stage { wet_mass: 2000.0, dry_mass: 600.0, engines: vec![plan::Engine { thrust: 4000.0, isp: 320.0, restartable: None, throttleable: None }] });
    let earth = launch::earth_data(&d);
    let geom = ascent::Geometry { along_track: 400.0, cross_track: 50.0 };
    let st = wall(10, 2, || {
        black_box(ascent::compute_ascent(&stack, earth.gm, earth.reference_radius, black_box(250e3), geom, &d.ascent_earth).unwrap());
    });
    println!("computeAscent (Falcon 9, 250 km): {}", st.fmt("ms", 2));
    let st = wall(10, 2, || {
        black_box(ascent::compute_direct_ascent(&stack, earth.gm, earth.reference_radius, black_box(-2e6), 200e3, geom, &d.ascent_earth).unwrap());
    });
    println!("computeDirectAscent (Falcon 9, C3 -2 km2/s2): {}", st.fmt("ms", 2));
    black_box(plan::decode_plan(black_box("x"), &d).is_ok());
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("chunk") {
        bench_chunk();
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("mission") {
        bench_mission();
        return;
    }
    let world = World::parse(&std::fs::read_to_string(dir().join("world.txt")).unwrap());
    let (mut eph, mut fm) = parity::load_world(&world, |k| std::fs::read(dir().join(format!("chunk_{k}.bin"))).unwrap());
    let n = world.layout.count;
    let c = world.layout.chunk_span;
    let mut s: u32 = 12345;
    let mut rnd = || {
        s = s.wrapping_mul(1103515245).wrapping_add(12345);
        s as f64 / 4294967296.0
    };
    let random: Vec<f64> = (0..20000).map(|_| (-1.0 + 3.0 * rnd()) * c).collect();
    let seq: Vec<f64> = (0..20000).map(|i| 0.3 * c + (i / 13) as f64 * 600.0 + ((i % 13) as f64 / 12.0) * 600.0).collect();
    let mut pos = vec![0.0; 3 * n];
    let mut vel = vec![0.0; 3 * n];
    let mut one = [0.0; 6];
    println!("native ({})", std::env::consts::ARCH);
    for simd in [false, true] {
        eph.simd = simd;
        let tag = if simd { "f64x2" } else { "scalar" };
        println!("positions, random ({tag}):     {}", per_call(&random, 25, 5, |t| eph.positions(black_box(t), &mut pos)).fmt("ns", 0));
        println!("positions, sequential ({tag}): {}", per_call(&seq, 25, 5, |t| eph.positions(black_box(t), &mut pos)).fmt("ns", 0));
    }
    eph.simd = false;
    println!("evaluate pos+vel:            {}", per_call(&random, 25, 5, |t| eph.evaluate(black_box(t), &mut pos, Some(&mut vel))).fmt("ns", 0));
    let sub = [world.body("io"), world.body("earth"), world.body("jupiter")];
    let mut sp = [0.0; 9];
    println!("evaluateBodies(3):           {}", per_call(&random, 25, 5, |t| eph.evaluate_bodies(black_box(t), &sub, &mut sp, None)).fmt("ns", 0));
    let sun = world.body("sun");
    let io = world.body("io");
    println!("bodyState(sun):              {}", per_call(&random, 25, 5, |t| eph.body_state(sun, black_box(t), &mut one)).fmt("ns", 0));
    println!("bodyState(io):               {}", per_call(&random, 25, 5, |t| eph.body_state(io, black_box(t), &mut one)).fmt("ns", 0));

    let props = cases("prop.txt");
    for (name, reps) in [("leo30", 15), ("helio1yr", 40)] {
        let cs = props.iter().find(|x| x.name == name).unwrap();
        // As the TypeScript bench: propagate(eph, y0, 0, t1) with default options.
        let opts = PropagateOptions::default();
        let mut steps = 0;
        let none = wall(reps, 2, || {
            steps = sc::propagate(&mut eph, &mut fm, &cs.y0, cs.t0, cs.t1, &[], &opts, None).unwrap().accepted;
        });
        let with_cb = wall(reps, 2, || {
            let mut acc = 0.0;
            let mut cb = |v: &mut sc::StepView<'_, '_, sendit_core::cheb::ChebEphemeris>| {
                let t = v.t();
                let tp = v.t_prev();
                let mut tmp = [0.0; 7];
                v.interpolate(tp + (t - tp) * 0.37, &mut tmp).unwrap();
                acc += tmp[0];
                true
            };
            sc::propagate(&mut eph, &mut fm, &cs.y0, cs.t0, cs.t1, &[], &opts, Some(&mut cb)).unwrap();
            black_box(acc);
        });
        println!("{name}: {steps} steps\n  propagate                          {}\n  with per-step dense sample (Rust)  {}", none.fmt("ms", 1), with_cb.fmt("ms", 1));
    }
    let corr = cases("corrector.txt");
    let w = wall(5, 1, || {
        for cs in &corr {
            sc::propagate(&mut eph, &mut fm, &cs.y0, cs.t0, cs.t1, &cs.burns, &PropagateOptions { rtol: cs.rtol, dry_mass: cs.dry }, None).unwrap();
        }
    });
    println!("corrector workload: {} propagations per run, {}", corr.len(), w.fmt("ms", 0));
}
