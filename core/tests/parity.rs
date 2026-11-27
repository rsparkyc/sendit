//! Native run of the parity suite against core/fixtures/generated/ (written by
//! `pnpm core:vectors`). Each section is one test; a missing fixture fails.

use sendit_core::fixture::World;
use sendit_core::parity::{self, Report};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

fn dir() -> PathBuf {
    std::env::var_os("SENDIT_FIXTURES").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/generated"))
}
fn read(name: &str) -> String {
    let p = dir().join(name);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e} (run `pnpm core:vectors` first)", p.display()))
}
fn check(r: Report) {
    println!("{}", r.summary());
    assert!(r.ok(), "{}", r.summary());
}

struct Ctx {
    world: World,
    eph: sendit_core::cheb::ChebEphemeris,
    fm: sendit_core::spacecraft::ForceModel,
}
fn ctx() -> &'static Mutex<Ctx> {
    static C: OnceLock<Mutex<Ctx>> = OnceLock::new();
    C.get_or_init(|| {
        let world = World::parse(&read("world.txt"));
        let (eph, fm) = parity::load_world(&world, |k| std::fs::read(dir().join(format!("chunk_{k}.bin"))).unwrap());
        Mutex::new(Ctx { world, eph, fm })
    })
}
fn lock() -> std::sync::MutexGuard<'static, Ctx> {
    ctx().lock().unwrap_or_else(|e| e.into_inner())
}

#[test]
fn dmath() {
    check(parity::dmath(&read("dmath.txt")));
}
#[test]
fn dop853() {
    check(parity::dop853(&read("dop853.txt")));
}
#[test]
fn gravity() {
    check(parity::gravity(&read("gravity.txt")));
}
#[test]
fn orientation() {
    let c = lock();
    check(parity::orientation(&read("orientation.txt"), &c.world));
}
#[test]
fn ephemeris() {
    let mut c = lock();
    check(parity::ephem(&read("ephem.txt"), &mut c.eph));
}
#[test]
fn ephemeris_simd() {
    let mut c = lock();
    c.eph.simd = true;
    let r = parity::ephem(&read("ephem.txt"), &mut c.eph);
    c.eph.simd = false;
    check(r);
}
#[test]
fn ephemeris_golden_digests() {
    let mut g = lock();
    let c = &mut *g;
    check(parity::golden_eval(&mut c.eph, &c.world));
}
#[test]
fn derivative() {
    let mut g = lock();
    let c = &mut *g;
    check(parity::deriv(&read("deriv.txt"), &mut c.eph, &mut c.fm));
}
#[test]
fn propagation() {
    let mut g = lock();
    let c = &mut *g;
    check(parity::prop(&read("prop.txt"), &mut c.eph, &mut c.fm, "propagation"));
}
#[test]
fn corrector_propagations() {
    let mut g = lock();
    let c = &mut *g;
    check(parity::prop(&read("corrector.txt"), &mut c.eph, &mut c.fm, "corrector propagations"));
}
#[test]
fn derivative_relativistic() {
    check(parity::deriv_rel(&read("deriv-rel.txt")));
}
