//! Plain WebAssembly exports (no wasm-bindgen): the parity suite and the
//! benchmark entry points, driven from JavaScript by core/scripts/run-wasm.mjs.
//! Memory protocol: JavaScript calls `alloc`, copies bytes in, passes
//! (pointer, length); results are read from exported buffers.
//!
//! The one import, `env.on_step(t, y_ptr) -> i32`, exists only to measure the
//! cost of a per-step JavaScript callback (see core/README.md).

use crate::cheb::ChebEphemeris;
use crate::fixture::World;
use crate::parity;
use crate::spacecraft::{self as sc, Burn, BurnFrame, ForceModel, PropagateOptions};
use std::cell::RefCell;

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn on_step(t: f64, y: *const f64) -> i32;
}

struct State {
    world: World,
    eph: ChebEphemeris,
    fm: ForceModel,
    pos: Vec<f64>,
    samples: Vec<f64>,
    result: [f64; 10],
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    static REPORT: RefCell<String> = const { RefCell::new(String::new()) };
    static FILES: RefCell<std::collections::HashMap<String, Vec<u8>>> = RefCell::new(std::collections::HashMap::new());
}

/// Install a named byte file (the checkpoint asset, chunk bins) for sections that read several files.
#[unsafe(no_mangle)]
pub extern "C" fn add_file(name: *const u8, name_len: usize, ptr: *const u8, len: usize) {
    let n = text(name, name_len).to_string();
    let b = bytes(ptr, len).to_vec();
    FILES.with(|f| f.borrow_mut().insert(n, b));
}
fn file(name: &str) -> Option<Vec<u8>> {
    FILES.with(|f| f.borrow().get(name).cloned())
}

fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    unsafe { std::slice::from_raw_parts(ptr, len) }
}
fn text<'a>(ptr: *const u8, len: usize) -> &'a str {
    std::str::from_utf8(bytes(ptr, len)).expect("utf-8")
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[unsafe(no_mangle)]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) }
}

/// Parse world.txt and build the ephemeris (no chunks yet) and force model.
#[unsafe(no_mangle)]
pub extern "C" fn set_world(ptr: *const u8, len: usize) {
    let world = World::parse(text(ptr, len));
    let eph = ChebEphemeris::new(world.layout.clone(), world.gm.clone(), world.t0);
    let fm = ForceModel::new(&world.gm, &world.fields, world.relativity);
    let n = world.layout.count;
    STATE.with(|s| *s.borrow_mut() = Some(State { world, eph, fm, pos: vec![0.0; 3 * n], samples: Vec::new(), result: [0.0; 10] }));
}

/// Chunk k's coefficients as little-endian float64 bytes.
#[unsafe(no_mangle)]
pub extern "C" fn add_chunk(k: i32, ptr: *const u8, len: usize) {
    STATE.with(|s| s.borrow_mut().as_mut().unwrap().eph.add_chunk(k as i64, crate::fixture::f64s_le(bytes(ptr, len))));
}

#[unsafe(no_mangle)]
pub extern "C" fn set_simd(on: i32) {
    STATE.with(|s| s.borrow_mut().as_mut().unwrap().eph.simd = on != 0);
}

/// Run one parity section over the fixture text; returns the number of mismatches
/// (u32::MAX if nothing was compared). The summary is in report_ptr/report_len.
/// Sections: 0 dmath, 1 dop853, 2 gravity, 3 orientation, 4 ephem, 5 golden eval,
/// 6 deriv, 7 prop, 8 corrector, 9 relativistic derivative, 10 n-body integrator,
/// 11 chunks (needs add_file: the checkpoint asset and the chunk bins), 12 plan codec, 13 launch, 14 ascent, 15 replay, 16 objectives (both need the checkpoint asset), 17 sandbox spheres (no fixture).
#[unsafe(no_mangle)]
pub extern "C" fn run_section(section: u32, ptr: *const u8, len: usize) -> u32 {
    let t = text(ptr, len);
    let r = match section {
        0 => parity::dmath(t),
        1 => parity::dop853(t),
        2 => parity::gravity(t),
        9 => parity::deriv_rel(t),
        10 => crate::parity2::nbody(t, &crate::data::world()),
        12 => crate::parity3::plan_codec(t, &crate::mission::mdata::MissionData::parse(crate::data::MISSION_JSON)),
        13 => crate::parity3::launch(t, &crate::mission::mdata::MissionData::parse(crate::data::MISSION_JSON)),
        14 => crate::parity4::ascent(t, &crate::mission::mdata::MissionData::parse(crate::data::MISSION_JSON)),
        15 => {
            let asset = file("checkpoints-1950-2100.bin").expect("add_file the checkpoint asset first");
            crate::parity4::replay(t, &crate::mission::mdata::MissionData::parse(crate::data::MISSION_JSON), &asset)
        }
        16 => {
            let asset = file("checkpoints-1950-2100.bin").expect("add_file the checkpoint asset first");
            crate::parity5::objectives(t, &crate::mission::mdata::MissionData::parse(crate::data::MISSION_JSON), &asset)
        }
        17 => crate::parity5::sandbox_spheres(&crate::mission::mdata::MissionData::parse(crate::data::MISSION_JSON), &crate::data::world().initial),
        11 => {
            let asset = file("checkpoints-1950-2100.bin").expect("add_file the checkpoint asset first");
            crate::parity2::chunks(t, &crate::data::world(), &asset, file)
        }
        _ => STATE.with(|s| {
            let mut g = s.borrow_mut();
            let st = g.as_mut().expect("set_world first");
            match section {
                3 => parity::orientation(t, &st.world),
                4 => parity::ephem(t, &mut st.eph),
                5 => parity::golden_eval(&mut st.eph, &st.world),
                6 => parity::deriv(t, &mut st.eph, &mut st.fm),
                7 => parity::prop(t, &mut st.eph, &mut st.fm, "propagation"),
                _ => parity::prop(t, &mut st.eph, &mut st.fm, "corrector propagations"),
            }
        }),
    };
    REPORT.with(|rep| *rep.borrow_mut() = r.summary());
    if r.checked == 0 { u32::MAX } else { r.mismatches as u32 }
}

#[unsafe(no_mangle)]
pub extern "C" fn report_ptr() -> *const u8 {
    REPORT.with(|r| r.borrow().as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn report_len() -> usize {
    REPORT.with(|r| r.borrow().len())
}

// ---------------------------------------------------------------------------
// Benchmark entry points

/// Buffer of 3N positions written by `positions`.
#[unsafe(no_mangle)]
pub extern "C" fn pos_ptr() -> *const f64 {
    STATE.with(|s| s.borrow().as_ref().unwrap().pos.as_ptr())
}

/// One positions() call per JavaScript call (measures the boundary).
#[unsafe(no_mangle)]
pub extern "C" fn positions(t: f64) {
    STATE.with(|s| {
        let mut g = s.borrow_mut();
        let st = g.as_mut().unwrap();
        let State { eph, pos, .. } = st;
        eph.positions(t, pos);
    });
}

/// positions() at n times from memory, all inside WebAssembly; returns a checksum.
#[unsafe(no_mangle)]
pub extern "C" fn positions_many(times: *const f64, n: usize) -> f64 {
    let ts = unsafe { std::slice::from_raw_parts(times, n) };
    STATE.with(|s| {
        let mut g = s.borrow_mut();
        let st = g.as_mut().unwrap();
        let State { eph, pos, .. } = st;
        let mut acc = 0.0;
        for &t in ts {
            eph.positions(t, pos);
            acc += pos[0];
        }
        acc
    })
}

/// evaluate(t, pos, vel) at n times inside WebAssembly.
#[unsafe(no_mangle)]
pub extern "C" fn evaluate_many(times: *const f64, n: usize) -> f64 {
    let ts = unsafe { std::slice::from_raw_parts(times, n) };
    STATE.with(|s| {
        let mut g = s.borrow_mut();
        let st = g.as_mut().unwrap();
        let nb = st.eph.layout.count;
        let mut vel = vec![0.0; 3 * nb];
        let State { eph, pos, .. } = st;
        let mut acc = 0.0;
        for &t in ts {
            eph.evaluate(t, pos, Some(&mut vel));
            acc += pos[0] + vel[0];
        }
        acc
    })
}

/// Burn records: 9 float64 each (tStart, duration, thrust, isp, dx, dy, dz, orbital 0/1, body).
fn read_burns(p: *const f64, n: usize) -> Vec<Burn> {
    let b = unsafe { std::slice::from_raw_parts(p, 9 * n) };
    (0..n)
        .map(|i| {
            let r = &b[9 * i..9 * i + 9];
            Burn { t_start: r[0], duration: r[1], thrust: r[2], isp: r[3], direction: [r[4], r[5], r[6]], frame: if r[7] == 1.0 { BurnFrame::Orbital { body: r[8] as usize } } else { BurnFrame::Inertial } }
        })
        .collect()
}

/// propagate() from JavaScript. mode 0: no callback; 1: call env.on_step for every
/// accepted step (the per-step boundary crossing); 2: record (t, y, dense sample)
/// per step into a WebAssembly buffer read once at the end (samples_ptr/len).
/// Result (t, y[7], accepted, rejected) in result_ptr; returns 0, or 1 on error.
#[unsafe(no_mangle)]
pub extern "C" fn propagate(y0: *const f64, t0: f64, t1: f64, rtol: f64, dry: f64, burns: *const f64, nb: usize, mode: u32) -> u32 {
    let y0 = unsafe { std::slice::from_raw_parts(y0, 7) }.to_vec();
    let burns = read_burns(burns, nb);
    STATE.with(|s| {
        let mut g = s.borrow_mut();
        let st = g.as_mut().unwrap();
        let State { eph, fm, samples, result, .. } = st;
        samples.clear();
        let opts = PropagateOptions { rtol, dry_mass: dry };
        let res = match mode {
            0 => sc::propagate(eph, fm, &y0, t0, t1, &burns, &opts, None),
            1 => {
                let mut cb = |v: &mut sc::StepView<'_, '_, ChebEphemeris>| unsafe { on_step(v.t(), v.y().as_ptr()) != 0 };
                sc::propagate(eph, fm, &y0, t0, t1, &burns, &opts, Some(&mut cb))
            }
            _ => {
                let mut cb = |v: &mut sc::StepView<'_, '_, ChebEphemeris>| {
                    let t = v.t();
                    let tp = v.t_prev();
                    samples.push(t);
                    samples.extend_from_slice(v.y());
                    let mut tmp = [0.0; 7];
                    v.interpolate(tp + (t - tp) * 0.37, &mut tmp).unwrap();
                    samples.extend_from_slice(&tmp);
                    true
                };
                sc::propagate(eph, fm, &y0, t0, t1, &burns, &opts, Some(&mut cb))
            }
        };
        match res {
            Ok(r) => {
                result[0] = r.t;
                result[1..8].copy_from_slice(&r.y);
                result[8] = r.accepted as f64;
                result[9] = r.rejected as f64;
                0
            }
            Err(e) => {
                REPORT.with(|rep| *rep.borrow_mut() = format!("{e:?}"));
                1
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn result_ptr() -> *const f64 {
    STATE.with(|s| s.borrow().as_ref().unwrap().result.as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn samples_ptr() -> *const f64 {
    STATE.with(|s| s.borrow().as_ref().unwrap().samples.as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn samples_len() -> usize {
    STATE.with(|s| s.borrow().as_ref().unwrap().samples.len())
}

// ---------------------------------------------------------------------------
// The leaderboard verifier (phase-four shape): one call per submission.

fn mission_data() -> &'static crate::mission::mdata::MissionData {
    static D: std::sync::OnceLock<crate::mission::mdata::MissionData> = std::sync::OnceLock::new();
    D.get_or_init(|| crate::mission::mdata::MissionData::parse(crate::data::MISSION_JSON))
}

thread_local! {
    static VERIFIER: RefCell<Option<crate::mission::verify::Verifier<'static>>> = const { RefCell::new(None) };
}

/// A fresh verifier (checkpoint asset from add_file; no chunks built yet).
#[unsafe(no_mangle)]
pub extern "C" fn verifier_new() {
    let asset = file("checkpoints-1950-2100.bin").expect("add_file the checkpoint asset first");
    let v = crate::mission::verify::Verifier::new(mission_data(), Some(&asset)).expect("verifier");
    VERIFIER.with(|x| *x.borrow_mut() = Some(v));
}

/// Verify a submission: the input is "plan\nmission id\nversion\nsite" (site "-": the plan's own).
/// Returns 0 accepted, 1 rejected; the verdict as text in report_ptr/report_len.
#[unsafe(no_mangle)]
pub extern "C" fn verifier_verify(ptr: *const u8, len: usize) -> u32 {
    let t = text(ptr, len);
    let f: Vec<&str> = t.split('\n').collect();
    let site = if f[3] == "-" { None } else { Some(f[3]) };
    let v = VERIFIER.with(|x| x.borrow_mut().as_mut().expect("verifier_new first").verify(f[0], f[1], f[2], site));
    let code = if matches!(v, crate::mission::verify::Verdict::Accepted { .. }) { 0 } else { 1 };
    REPORT.with(|rep| *rep.borrow_mut() = format!("{v:?}"));
    code
}

/// Replay a plan for a campaign mission with the verifier's world (chunks stay warm); returns the step count.
#[unsafe(no_mangle)]
pub extern "C" fn verifier_replay(ptr: *const u8, len: usize) -> u32 {
    let t = text(ptr, len);
    let f: Vec<&str> = t.split('\n').collect();
    let d = mission_data();
    let m = d.mission(f[1]).expect("mission");
    let p = crate::mission::plan::decode_plan(f[0], d).expect("plan");
    let o = crate::mission::objectives::mission_replay_options(m);
    VERIFIER.with(|x| {
        let mut g = x.borrow_mut();
        let v = g.as_mut().expect("verifier_new first");
        let r = crate::mission::replay::replay(&p, &mut v.world, &o, None, None);
        REPORT.with(|rep| *rep.borrow_mut() = r.digest.clone());
        r.steps as u32
    })
}

/// Build chunk k cold: a fresh ephemeris from the checkpoint asset (asset decode included).
#[unsafe(no_mangle)]
pub extern "C" fn chunk_cold(k: i32) -> u32 {
    let asset = file("checkpoints-1950-2100.bin").expect("add_file the checkpoint asset first");
    let (mut eph, _) = crate::data::ephemeris(&crate::data::world(), Some(&asset), None).expect("ephemeris");
    eph.ensure_chunk(k as i64);
    eph.has_chunk(k as i64) as u32
}

// ---------------------------------------------------------------------------
// The browser engine (phase three): the app's replay worker's call, behind
// its feature flag. One MissionWorld per instance; chunks are built from the
// checkpoint asset or handed in (bit-identical either way).

struct Engine {
    world: crate::mission::replay::MissionWorld<'static>,
    state0: Vec<f64>,
    samples: Vec<f64>,
}

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
}

/// A fresh engine over the built-in world, with the checkpoint asset if add_file
/// gave one. Returns 0, or 1 with the reason in report_ptr/report_len.
#[unsafe(no_mangle)]
pub extern "C" fn engine_new() -> u32 {
    let d = mission_data();
    let w = crate::data::world();
    let asset = file("checkpoints-1950-2100.bin");
    match crate::data::ephemeris(&w, asset.as_deref(), Some(&d.checkpoint_version)) {
        Ok((eph, fm)) => {
            ENGINE.with(|e| *e.borrow_mut() = Some(Engine { world: crate::mission::replay::MissionWorld { eph, fm, d }, state0: w.initial, samples: Vec::new() }));
            0
        }
        Err(m) => {
            REPORT.with(|rep| *rep.borrow_mut() = m);
            1
        }
    }
}

/// Install chunk k (little-endian float64 bytes), unless the engine has it.
#[unsafe(no_mangle)]
pub extern "C" fn engine_add_chunk(k: i32, ptr: *const u8, len: usize) {
    ENGINE.with(|e| {
        let mut g = e.borrow_mut();
        let en = g.as_mut().expect("engine_new first");
        if !en.world.eph.has_chunk(k as i64) {
            en.world.eph.add_chunk(k as i64, crate::fixture::f64s_le(bytes(ptr, len)));
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_has_chunk(k: i32) -> u32 {
    ENGINE.with(|e| e.borrow().as_ref().expect("engine_new first").world.eph.has_chunk(k as i64) as u32)
}

/// replayWithSamples(plan, world, replayOptions(mission), perStep). Input:
/// "mission id\nper step\nencoded plan". Returns 0 replayed, 1 the plan did not
/// decode. Report lines: outcome, digest, steps, final t (hex bits), final state
/// (hex bits, comma separated), reason (the rest). Samples: engine_samples_ptr/len.
#[unsafe(no_mangle)]
pub extern "C" fn engine_replay(ptr: *const u8, len: usize) -> u32 {
    let t = text(ptr, len);
    let mut f = t.splitn(3, '\n');
    let (mission, per_step, plan) = (f.next().unwrap_or(""), f.next().unwrap_or("12"), f.next().unwrap_or(""));
    let per_step: u32 = per_step.parse().unwrap_or(12).max(1);
    ENGINE.with(|e| {
        let mut g = e.borrow_mut();
        let en = g.as_mut().expect("engine_new first");
        let d = en.world.d;
        let p = match crate::mission::plan::decode_plan(plan, d) {
            Ok(p) => p,
            Err(m) => {
                REPORT.with(|rep| *rep.borrow_mut() = m);
                en.samples.clear();
                return 1;
            }
        };
        let o = crate::mission::engine::replay_options_for(d, mission, &en.state0);
        let (r, s) = crate::mission::engine::replay_with_samples(&p, &mut en.world, &o, per_step);
        en.samples = s;
        let fs: Vec<String> = r.final_state.iter().map(|v| format!("{:016x}", v.to_bits())).collect();
        REPORT.with(|rep| *rep.borrow_mut() = format!("{}\n{}\n{}\n{:016x}\n{}\n{}", r.outcome, r.digest, r.steps, r.final_t.to_bits(), fs.join(","), r.reason));
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_samples_ptr() -> *const f64 {
    ENGINE.with(|e| e.borrow().as_ref().map_or(std::ptr::null(), |en| en.samples.as_ptr()))
}
#[unsafe(no_mangle)]
pub extern "C" fn engine_samples_len() -> usize {
    ENGINE.with(|e| e.borrow().as_ref().map_or(0, |en| en.samples.len()))
}
