//! Reader for the parity fixtures written by core/ts/export-vectors.vec.ts:
//! text, one record per line, whitespace-separated tokens; a number is 16 hex
//! digits (the big-endian bytes of its float64), anything else is a word.

use crate::cheb::Layout;
use crate::gravity::TesseralTerm;
use crate::orientation::{IauRotation, Nutation, PrimeMeridianKind};
use crate::spacecraft::BodyField;

pub struct Line<'a> {
    toks: Vec<&'a str>,
    pos: usize,
    pub number: usize,
}

impl<'a> Line<'a> {
    pub fn word(&mut self) -> &'a str {
        let t = self.toks.get(self.pos).copied().unwrap_or_else(|| panic!("line {}: missing token {}", self.number, self.pos));
        self.pos += 1;
        t
    }
    pub fn peek(&self) -> Option<&'a str> {
        self.toks.get(self.pos).copied()
    }
    pub fn f(&mut self) -> f64 {
        let t = self.word();
        let bits = u64::from_str_radix(t, 16).unwrap_or_else(|_| panic!("line {}: bad number {t:?}", self.number));
        f64::from_bits(bits)
    }
    pub fn n(&mut self) -> usize {
        let v = self.f();
        assert!(v >= 0.0 && v.floor() == v, "line {}: not a count: {v}", self.number);
        v as usize
    }
    pub fn i(&mut self) -> i64 {
        self.f() as i64
    }
    pub fn fs(&mut self, n: usize) -> Vec<f64> {
        (0..n).map(|_| self.f()).collect()
    }
    pub fn rest(&self) -> usize {
        self.toks.len() - self.pos
    }
    pub fn is_err(&mut self) -> bool {
        if self.peek() == Some("ERR") {
            self.pos += 1;
            true
        } else {
            false
        }
    }
}

pub fn lines(text: &str) -> impl Iterator<Item = Line<'_>> {
    text.lines().enumerate().filter(|(_, l)| !l.trim().is_empty()).map(|(i, l)| Line { toks: l.split_ascii_whitespace().collect(), pos: 0, number: i + 1 })
}

/// world.txt: rotation models, ephemeris layout, force model.
pub struct World {
    pub models: Vec<IauRotation>,
    pub layout: Layout,
    pub gm: Vec<f64>,
    pub t0: f64,
    pub body_ids: Vec<String>,
    pub fields: Vec<Option<BodyField>>,
    pub relativity: Option<usize>,
    pub chunks: Vec<i64>,
    /// Massive-body physics (zonal terms and the Sun's 1PN), for the chunk builder.
    pub nbody: crate::nbody::Physics,
    /// Initial states [x,y,z,vx,vy,vz] per body at the epoch.
    pub initial: Vec<f64>,
}

/// Parse a `zonalterm` record (after its keyword); rotation models are resolved by id.
pub fn parse_zonal_term(l: &mut Line<'_>, models: &[IauRotation]) -> crate::nbody::ZonalTerm {
    let body = l.n();
    let j2 = l.f();
    let has_j4 = l.word() == "j4";
    let j4v = l.f();
    let has_jn = l.word() == "jn";
    let njn = l.n();
    let jn = l.fs(njn);
    let has_tess = l.word() == "tess";
    let nt = l.n();
    let tess: Vec<TesseralTerm> = (0..nt).map(|_| (l.f() as u32, l.f() as u32, l.f(), l.f())).collect();
    let pm = l.word();
    let radius = l.f();
    let pole = [l.f(), l.f(), l.f()];
    let rot = l.word();
    let pole_spacing = l.f();
    let ntg = l.n();
    let targets = (0..ntg).map(|_| l.n()).collect();
    crate::nbody::ZonalTerm {
        body,
        j2,
        j4: if has_j4 { Some(j4v) } else { None },
        jn: if has_jn { Some(jn) } else { None },
        tesseral: if has_tess { Some(tess) } else { None },
        prime_meridian: if pm == "earth-rotation-angle" { PrimeMeridianKind::EarthRotationAngle } else { PrimeMeridianKind::Iau },
        radius,
        pole,
        rotation: if rot == "none" { None } else { Some(models.iter().find(|m| m.id == rot).unwrap_or_else(|| panic!("no model {rot}")).clone()) },
        pole_spacing,
        targets,
    }
}

impl World {
    pub fn model(&self, id: &str) -> &IauRotation {
        self.models.iter().find(|m| m.id == id).unwrap_or_else(|| panic!("no model {id}"))
    }
    pub fn body(&self, id: &str) -> usize {
        self.body_ids.iter().position(|b| b == id).unwrap_or_else(|| panic!("no body {id}"))
    }

    pub fn parse(text: &str) -> World {
        let mut models = Vec::new();
        let mut arrays: std::collections::HashMap<String, Vec<f64>> = Default::default();
        let mut head = None;
        let mut bodies: Vec<(String, Option<BodyField>)> = Vec::new();
        let mut relativity = None;
        let mut chunks = Vec::new();
        let mut zonal = Vec::new();
        let mut nbody_rel = None;
        let mut initial = Vec::new();
        let mut pending: Vec<(usize, String, String)> = Vec::new(); // body, rotation id, prime meridian
        for mut l in lines(text) {
            match l.word() {
                "model" => {
                    let id = l.word().to_string();
                    let naif_id = l.f() as i32;
                    let ra = [l.f(), l.f(), l.f()];
                    let dec = [l.f(), l.f(), l.f()];
                    let pm = [l.f(), l.f(), l.f()];
                    let nn = l.n();
                    let nut = (0..nn).map(|_| Nutation { angle: [l.f(), l.f(), l.f()], ra: l.f(), dec: l.f(), pm: l.f() }).collect();
                    models.push(IauRotation { id, naif_id, ra, dec, pm, nut });
                }
                "layout" => head = Some((l.n(), l.f(), l.n(), l.f(), l.f(), l.n())),
                "array" => {
                    let name = l.word().to_string();
                    let n = l.n();
                    arrays.insert(name, l.fs(n));
                }
                "body" => {
                    let id = l.word().to_string();
                    let idx = l.n();
                    assert_eq!(idx, bodies.len());
                    if l.word() == "none" {
                        bodies.push((id, None));
                        continue;
                    }
                    let j2 = l.f();
                    let j4v = l.f();
                    let j4 = if l.word() == "j4" { Some(j4v) } else { None };
                    let radius = l.f();
                    let pole = [l.f(), l.f(), l.f()];
                    let rot = l.word().to_string();
                    let pmk = l.word().to_string();
                    let has_taper = l.word() == "taper";
                    let tp = (l.f(), l.f());
                    let njn = l.n();
                    let jn = l.fs(njn);
                    let nt = l.n();
                    let tesseral: Vec<TesseralTerm> = (0..nt).map(|_| (l.f() as u32, l.f() as u32, l.f(), l.f())).collect();
                    pending.push((idx, rot, pmk.clone()));
                    bodies.push((
                        id,
                        Some(BodyField {
                            j2,
                            j4,
                            jn: if njn > 0 { Some(jn) } else { None },
                            tesseral,
                            prime_meridian: if pmk == "earth-rotation-angle" { PrimeMeridianKind::EarthRotationAngle } else { PrimeMeridianKind::Iau },
                            taper: if has_taper { Some(tp) } else { None },
                            radius,
                            pole,
                            rotation: None,
                        }),
                    ));
                }
                "relativity" => {
                    let r = l.f();
                    relativity = if r >= 0.0 { Some(r as usize) } else { None };
                }
                "chunks" => {
                    let n = l.n();
                    chunks = (0..n).map(|_| l.i()).collect();
                }
                "zonalterm" => zonal.push(parse_zonal_term(&mut l, &models)),
                "nbodyrelativity" => {
                    let r = l.f();
                    nbody_rel = if r >= 0.0 { Some(r as usize) } else { None };
                }
                "initial" => {
                    let n = l.n();
                    initial = l.fs(6 * n);
                }
                w => panic!("world.txt line {}: unknown record {w}", l.number),
            }
        }
        for (idx, rot, _) in pending {
            if rot != "none" {
                let m = models.iter().find(|m| m.id == rot).unwrap().clone();
                bodies[idx].1.as_mut().unwrap().rotation = Some(m);
            }
        }
        let (count, h, chunk_steps, chunk_span, t0, chunk_length) = head.expect("no layout");
        let a = |n: &str| arrays.get(n).unwrap_or_else(|| panic!("no array {n}")).clone();
        let u = |n: &str| a(n).into_iter().map(|v| v as usize).collect::<Vec<_>>();
        let s = |n: &str| a(n).into_iter().map(|v| v as i32).collect::<Vec<_>>();
        let layout = Layout {
            count,
            h,
            chunk_steps,
            chunk_span,
            chunk_length,
            seg_len: a("segLen"),
            two_over_len: a("twoOverLen"),
            seg_count: u("segCount"),
            offset: u("offset"),
            stride3: u("stride3"),
            degree: u("degree"),
            center: s("center"),
            weight: a("weight"),
            sys_planet: u("sysPlanet"),
            sys_start: u("sysStart"),
            sys_moons: u("sysMoons"),
            system_of: s("systemOf"),
            samples: u("samples"),
            sample_stride: u("sampleStride"),
        };
        World { models, layout, gm: a("gm"), t0, body_ids: bodies.iter().map(|b| b.0.clone()).collect(), fields: bodies.into_iter().map(|b| b.1).collect(), relativity, chunks, nbody: crate::nbody::Physics { zonal, relativity: nbody_rel }, initial }
    }
}

/// Little-endian float64 bytes -> Vec<f64>.
pub fn f64s_le(bytes: &[u8]) -> Vec<f64> {
    assert!(bytes.len() % 8 == 0);
    bytes.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect()
}
