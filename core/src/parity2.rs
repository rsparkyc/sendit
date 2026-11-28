//! Phase-two parity sections: the massive-body integrator, chunks built from
//! the checkpoint asset (in any order), and the asset's checkpoints
//! regenerated from the epoch. Same Report as src/parity.rs.

use crate::chunk::{bases_for, build_chunk, decode_checkpoint_asset, initial_checkpoint, Checkpoint, ChunkBuilder};
use crate::fixture::{f64s_le, lines, parse_zonal_term, World};
use crate::nbody::{kahan_li_8, NBodyIntegrator, Physics, Scheme, ZonalTerm};
use crate::parity::{Digest, Report};
use std::collections::HashMap;

/// nbody.txt: every step of eight integrator configurations (state with compensation terms, total acceleration).
pub fn nbody(text: &str, world: &World) -> Report {
    let mut r = Report::new("n-body integrator");
    let n = world.gm.len();
    let mut it: Option<NBodyIntegrator> = None;
    let mut name = String::new();
    type Pending = (String, f64, f64, f64, Option<usize>, usize, Vec<ZonalTerm>);
    let mut pending: Option<Pending> = None;
    let mut step = 0usize;
    let mut acc = vec![0.0; 3 * n];
    for mut l in lines(text) {
        match l.word() {
            "nbcase" => {
                name = l.word().to_string();
                let scheme = l.word().to_string();
                let t0 = l.f();
                let h = l.f();
                let boundary = l.f();
                let rel = l.f();
                let nz = l.n();
                pending = Some((scheme, t0, h, boundary, if rel >= 0.0 { Some(rel as usize) } else { None }, nz, Vec::new()));
                it = None;
                step = 0;
            }
            "zonalterm" => {
                let z = parse_zonal_term(&mut l, &world.models);
                pending.as_mut().unwrap().6.push(z);
            }
            "nbstep" => {
                if it.is_none() {
                    let (scheme, t0, h, boundary, rel, nz, zonal) = pending.take().unwrap();
                    assert_eq!(zonal.len(), nz);
                    let sch = if scheme == "kl8" { kahan_li_8() } else { Scheme { a: vec![1.0], b: vec![0.5, 0.5] } };
                    let mut i = NBodyIntegrator::new(&world.gm, &world.initial, t0, h, sch, &Physics { zonal, relativity: rel });
                    if boundary != 0.0 {
                        // Resumed: the first record holds the TypeScript's state after importState.
                        let t = l.f();
                        let data = l.fs(12 * n);
                        i.import_state(&data, boundary.abs() * world.layout.chunk_steps as f64);
                        r.cmp(i.t(), t, || format!("{name} resumed t"));
                        i.total_acceleration(&mut acc);
                        let want = l.fs(3 * n);
                        r.cmps(&acc, &want, |k| format!("{name} resumed acc[{k}]"));
                        it = Some(i);
                        continue;
                    }
                    it = Some(i);
                } else {
                    it.as_mut().unwrap().step();
                    step += 1;
                }
                let i = it.as_mut().unwrap();
                let t = l.f();
                r.cmp(i.t(), t, || format!("{name} step {step} t"));
                let want = l.fs(12 * n);
                let got = i.export_state();
                r.cmps(&got, &want, |k| format!("{name} step {step} state[{k}]"));
                i.total_acceleration(&mut acc);
                let want = l.fs(3 * n);
                r.cmps(&acc, &want, |k| format!("{name} step {step} acc[{k}]"));
            }
            "nbend" => {}
            w => panic!("nbody.txt line {}: {w}", l.number),
        }
    }
    r
}

/// Deterministic shuffle (the order chunks are built in must not matter).
fn shuffled(mut v: Vec<i64>, seed: u32) -> Vec<i64> {
    let mut s = seed;
    for i in (1..v.len()).rev() {
        s = s.wrapping_mul(1103515245).wrapping_add(12345);
        let j = (s as usize) % (i + 1);
        v.swap(i, j);
    }
    v
}

fn cmp_chunk(r: &mut Report, what: &str, got: &[f64], want: &[f64]) {
    if got.len() != want.len() {
        r.fail(format!("{what}: length {} vs {}", got.len(), want.len()));
        return;
    }
    r.cmps(got, want, |i| format!("{what} coefficient {i}"));
}

/// chunks.txt + chunkA_<k>.bin (TypeScript, from the asset) + chunk_<k>.bin of phase one (TypeScript, sequential from the epoch).
pub fn chunks(text: &str, world: &World, asset: &[u8], mut bin: impl FnMut(&str) -> Option<Vec<u8>>) -> Report {
    let mut r = Report::new("chunks");
    let a = decode_checkpoint_asset(asset).expect("asset");
    let bases = bases_for(&world.layout);
    let cps: HashMap<i64, Checkpoint> = a.checkpoints.iter().map(|c| (c.boundary, c.clone())).collect();
    let mut ks = Vec::new();
    let mut digests = HashMap::new();
    for mut l in lines(text) {
        match l.word() {
            "chunk" => {
                let k = l.i();
                l.word();
                digests.insert(k, l.word().to_string());
                ks.push(k);
            }
            "asset" => {
                let first = l.i();
                let last = l.i();
                r.checked += 1;
                if a.first != first || a.first + a.checkpoints.len() as i64 - 1 != last {
                    r.fail(format!("asset range {}..{} vs {first}..{last}", a.first, a.first + a.checkpoints.len() as i64 - 1));
                }
            }
            w => panic!("chunks.txt line {}: {w}", l.number),
        }
    }
    // 1. Every chunk of the spread, each from its own asset checkpoint, in a shuffled order.
    for k in shuffled(ks.clone(), 7) {
        let start = if k >= 0 { k } else { k + 1 };
        let (coeffs, end) = build_chunk(&world.layout, &world.gm, &world.nbody, &bases, world.t0, k, &cps[&start]);
        let want = f64s_le(&bin(&format!("chunkA_{k}.bin")).expect("chunkA file"));
        cmp_chunk(&mut r, &format!("chunk {k} (from the asset)"), &coeffs, &want);
        let mut d = Digest::default();
        d.add_all(&coeffs);
        r.checked += 1;
        if d.hex() != digests[&k] {
            r.fail(format!("chunk {k}: digest {} vs {}", d.hex(), digests[&k]));
        }
        if let Some(c) = cps.get(&end.boundary) {
            r.cmps(&end.data, &c.data, |i| format!("chunk {k} end checkpoint {} [{i}]", end.boundary));
        }
    }
    // 2. Sequentially from the epoch, no asset (the lazy builder, extendTo): chunks -4..3
    //    against the TypeScript's asset-built chunks and phase one's sequential TypeScript
    //    chunks; every checkpoint on the way against the asset's (TypeScript, from the epoch).
    let mut b = ChunkBuilder::new(world.layout.clone(), world.gm.clone(), world.nbody.clone(), world.t0, initial_checkpoint(&world.initial));
    let mut built: HashMap<i64, Vec<f64>> = HashMap::new();
    for k in [3i64, -4] {
        b.extend_to(k, &mut built);
    }
    for k in -4..=3i64 {
        let got = &built[&k];
        if let Some(bytes) = bin(&format!("chunkA_{k}.bin")) {
            cmp_chunk(&mut r, &format!("chunk {k} (sequential)"), got, &f64s_le(&bytes));
        }
        if let Some(bytes) = bin(&format!("chunk_{k}.bin")) {
            cmp_chunk(&mut r, &format!("chunk {k} (sequential) vs phase-one file"), got, &f64s_le(&bytes));
        }
    }
    for bnd in -4..=4i64 {
        let got = &b.cps[&bnd];
        r.cmps(&got.data, &cps[&bnd].data, |i| format!("checkpoint {bnd} [{i}] vs asset"));
    }
    r
}
