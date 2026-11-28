//! Port of src/app/replay-options.ts sandboxSpheres: the sphere of influence
//! (Laplace radius a (m/M)^(2/5)) of every body that orbits another, used by
//! sandbox replays (replayOptions(null)). Exactly defined arithmetic only:
//! a = sqrt(dx*dx + dy*dy + dz*dz) in that order, r = a * exactExp(0.4 *
//! exactLn(m / M)); kept when r > radius * 1.5; body-table order; the parent
//! is deriveMeta's (generated into mission-data.json).

use crate::exact_math::{exact_exp, exact_ln};
use crate::mission::mdata::MissionData;

/// `state0`: the bodies' barycentric J2000 states, 6 per body in table order
/// (world.txt `initial`, which is J2000_BODIES' `state`).
pub fn sandbox_spheres(d: &MissionData, state0: &[f64]) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    for (i, b) in d.bodies.iter().enumerate() {
        let p = b.parent;
        if p < 0 {
            continue;
        }
        let p = p as usize;
        let s = &state0[6 * i..6 * i + 6];
        let q = &state0[6 * p..6 * p + 6];
        let dx = s[0] - q[0];
        let dy = s[1] - q[1];
        let dz = s[2] - q[2];
        let a = (dx * dx + dy * dy + dz * dz).sqrt();
        let ln = exact_ln(b.gm / d.bodies[p].gm).expect("exactLn of a mass ratio");
        let r = a * exact_exp(0.4 * ln).expect("exactExp of a mass-ratio power");
        if r > b.radius * 1.5 {
            out.push((b.id.clone(), r));
        }
    }
    out
}

/// The bits pinned by src/app/replay-options.test.ts (PINNED), same order.
pub const PINNED: [(&str, u64); 27] = [
    ("mercury", 0x41a025ddd2ae1a96), ("venus", 0x41c2498c4d3eac58), ("earth", 0x41cb18e15e7fc881), ("moon", 0x419085266882f040),
    ("mars", 0x41bf6a0679364e5d), ("jupiter", 0x42256c3abe36229b), ("saturn", 0x422875ba609fa30c), ("uranus", 0x422906c052fe2c78),
    ("neptune", 0x423435b62ff9b5fd), ("pluto", 0x41e1f225aafdcf59), ("io", 0x415dc82e28287045), ("europa", 0x416260a5d5518dd9),
    ("ganymede", 0x417738407f2f8f41), ("callisto", 0x4181f53d68f199f9), ("tethys", 0x4132818f7129157c), ("dione", 0x413dc0216521712d),
    ("rhea", 0x414c1039f7660c6f), ("titan", 0x418539d54d39c496), ("iapetus", 0x4176025a801013d3), ("enceladus", 0x411da1c75146df74),
    ("ariel", 0x4140e0bc878e5705), ("umbriel", 0x4147b35c44ffdd6e), ("titania", 0x415c8164cb7f927c), ("oberon", 0x4162c761f214612b),
    ("miranda", 0x411b79bb88ace69a), ("triton", 0x4166d2951b2ac3a3), ("charon", 0x41601dc9a732b8b6),
];
