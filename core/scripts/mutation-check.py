#!/usr/bin/env python3
"""Mutation check: prove the parity suite detects the kinds of change that
break bit-identity (a fused multiply-add, a reordered sum, a "harmless"
algebraic simplification, a lost signed zero).

Copies the crate to a temporary directory, applies one mutation at a time,
runs the native parity suite against the generated fixtures and reports which
sections caught it. Every mutation must be caught by at least one section.

Usage (from the repository root, after `pnpm core:vectors`):
    python3 core/scripts/mutation-check.py [substring ...]   (e.g. nbody.rs)
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

CORE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(CORE, 'fixtures', 'generated')

MUTATIONS = [
    ('FMA in one Chebyshev position sum (positions(), pair loop, x of body a)', 'src/cheb.rs',
     'px += tn * coeffs[o];\n                    py', 'px = tn.mul_add(coeffs[o], px);\n                    py'),
    ('FMA Horner in the dmath sine kernel polynomial', 'src/dmath.rs',
     'let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));', 'let r = z.mul_add(z.mul_add(z.mul_add(z.mul_add(S6, S5), S4), S3), S2);'),
    ('point-mass accelerations summed in reverse body order', 'src/spacecraft.rs',
     'for i in 0..fm.n_bodies {\n            let dx', 'for i in (0..fm.n_bodies).rev() {\n            let dx'),
    ('DOP853 stage sums in reverse coefficient order', 'src/dop853.rs',
     'for q in 0..sp.idx.len() {\n                    sum += sp.val[q] * self.kf[self.k_slot[sp.idx[q]] * n + j];\n                }\n                let v = self.y[j] + h * sum;\n                nan',
     'for q in (0..sp.idx.len()).rev() {\n                    sum += sp.val[q] * self.kf[self.k_slot[sp.idx[q]] * n + j];\n                }\n                let v = self.y[j] + h * sum;\n                nan'),
    ('degree-4 field: 1 * (x0 * v00 - y0 * 0) simplified to x0 * v00', 'src/gravity.rs',
     'let v11 = 1.0 * (x0 * v00 - y0 * 0.0);', 'let v11 = x0 * v00;'),
    ('secular theta reassociated: 90 + (ra + W)', 'src/orientation.rs',
     '90.0 + ra + (self.pm0 + self.rem * d + 360.0 * (nd - nd.floor()) + self.pm2 * d * d)',
     '90.0 + (ra + (self.pm0 + self.rem * d + 360.0 * (nd - nd.floor()) + self.pm2 * d * d))'),
    ('J2 factor reassociated: (5 * (sp * sp)) / r2', 'src/spacecraft.rs',
     'let c1 = 1.0 - (5.0 * sp * sp) / r2;', 'let c1 = 1.0 - (5.0 * (sp * sp)) / r2;'),
    ('atan2 loses the sign of a zero y', 'src/dmath.rs',
     'let y_neg = y < 0.0 || (y == 0.0 && y.is_sign_negative());', 'let y_neg = y < 0.0;'),
    ('Sun 1PN distributed: f * (4 mu / r) - f * v^2', 'src/spacecraft.rs',
     'let cr = f * ((4.0 * mu) / r - (vx * vx + vy * vy + vz * vz));', 'let cr = f * ((4.0 * mu) / r) - f * (vx * vx + vy * vy + vz * vz);'),
    ('FMA in the sine kernel: inner - v * S1 fused', 'src/dmath.rs',
     'x - ((z * (0.5 * y - v * r) - y) - v * S1)', 'x - (-v).mul_add(S1, z * (0.5 * y - v * r) - y)'),
    ('FMA in the Chebyshev recurrence: tn = x2 * t - tPrev fused (positions)', 'src/cheb.rs',
     'let tn = x2 * tc - t_prev;\n                    t_prev = tc;\n                    tc = tn;\n                    px += tn * coeffs[o];',
     'let tn = x2.mul_add(tc, -t_prev);\n                    t_prev = tc;\n                    tc = tn;\n                    px += tn * coeffs[o];'),
    # Layer one (phase two): the massive-body integrator and the chunk fitter.
    ('Kahan v update: compensation term dropped (vc = 0)', 'src/nbody.rs',
     'self.vc[k] = tmp - self.v[k] - y;\n                    self.v[k] = tmp;\n                }\n            }\n            if st == s',
     'self.vc[k] = 0.0;\n                    self.v[k] = tmp;\n                }\n            }\n            if st == s'),
    ('Kahan q update reassociated: qc = tmp - (q + y)', 'src/nbody.rs',
     'self.qc[k] = tmp - self.q[k] - y;\n                self.q[k] = tmp;\n            }\n            let ts = self.stage_time(st);\n            self.forces(ts);\n        }',
     'self.qc[k] = tmp - (self.q[k] + y);\n                self.q[k] = tmp;\n            }\n            let ts = self.stage_time(st);\n            self.forces(ts);\n        }'),
    ('kick coefficient applied as b * (h * a) instead of (b * h) * a', 'src/nbody.rs',
     'let y = kb * self.acc[k] - self.vc[k];', 'let y = self.scheme.b[st] * (h * self.acc[k]) - self.vc[k];'),
    ('composition: kick weights applied in reverse stage order', 'src/nbody.rs',
     'let kb = self.scheme.b[st] * h;', 'let kb = self.scheme.b[s - st] * h;'),
    ('composition: drift weights applied in reverse stage order', 'src/nbody.rs',
     'let ka = self.scheme.a[st] * h;', 'let ka = self.scheme.a[s - 1 - st] * h;'),
    ('composition coefficients: b[i] = w[i-1]/2 + w[i]/2', 'src/nbody.rs',
     'b[i] = (w[i - 1] + w[i]) / 2.0;', 'b[i] = w[i - 1] / 2.0 + w[i] / 2.0;'),
    ('implicit half-kick distributed: v + half a + half apn', 'src/nbody.rs',
     'self.vt[k] = self.v[k] + half * (self.acc[k] + self.apn[k]);', 'self.vt[k] = self.v[k] + half * self.acc[k] + half * self.apn[k];'),
    ('explicit 1PN half-kick distributed: c a + c apn', 'src/nbody.rs',
     'let y = c * (self.acc[k] + self.apn[k]) - self.vc[k];', 'let y = c * self.acc[k] + c * self.apn[k] - self.vc[k];'),
    ('implicit half-kick: one fixed-point iteration fewer', 'src/nbody.rs',
     'for _ in 0..PN_ITERATIONS {', 'for _ in 1..PN_ITERATIONS {'),
    ('Householder reflector factor reassociated: 2 * (dot / vtv)', 'src/chunk.rs',
     'let f = (2.0 * dot) / vtv;\n            a[k * cols + c] -= f * v0;', 'let f = 2.0 * (dot / vtv);\n            a[k * cols + c] -= f * v0;'),
    ('Householder vtv: v0^2 added last', 'src/chunk.rs',
     'let mut vtv = v0 * v0;\n        for i in k + 1..rows {\n            vtv += a[i * cols + k] * a[i * cols + k];\n        }',
     'let mut vtv = 0.0;\n        for i in k + 1..rows {\n            vtv += a[i * cols + k] * a[i * cols + k];\n        }\n        vtv += v0 * v0;'),
    ('Householder: back substitution as multiply by reciprocal of the diagonal', 'src/chunk.rs',
     'y[k] = s / diag[k];', 'y[k] = s * (1.0 / diag[k]);'),
    ('fit: pseudo-inverse dot product in reverse row order', 'src/chunk.rs',
     'for r in 0..rows {\n                    sum += basis.pinv', 'for r in (0..rows).rev() {\n                    sum += basis.pinv'),
    # Layer two: the plan codec and validation.
    ('azimuth corridor end made exclusive', 'src/mission/plan.rs', 'd <= span\n}', 'd < span\n}'),
    ('range check lower bound inclusive where open', 'src/mission/plan.rs',
     'if lo_open { !(v > lo) } else { !(v >= lo) }', 'if lo_open { !(v >= lo) } else { !(v >= lo) }'),
    ('decoder: trailing-byte check dropped', 'src/mission/plan.rs',
     'if self.pos != self.buf.len() {', 'if self.pos > self.buf.len() {'),
    # Layer two: Earth orientation and the launch states.
    ('launch: azimuth corridor end made exclusive', 'src/mission/launch.rs', 'd <= span\n}', 'd < span\n}'),
    ('launch: j2-mean radius term reassociated: eps * s2c2u / 6', 'src/mission/launch.rs',
     'let rr = r0 * (1.0 + (eps / 6.0) * s2c2u);', 'let rr = r0 * (1.0 + eps * s2c2u / 6.0);'),
    ('launch: j2-mean radial speed reassociated: (n * r0)', 'src/mission/launch.rs',
     'let vr = -(eps / 3.0) * n * r0 * s2s2u;', 'let vr = -(eps / 3.0) * (n * r0) * s2s2u;'),
    ('launch: j2 eps reassociated: (re * re) / (r0 * r0)', 'src/mission/launch.rs',
     'let eps = 1.5 * j2 * (re / r0) * (re / r0);', 'let eps = 1.5 * j2 * ((re * re) / (r0 * r0));'),
    ('launch: two-body speed as sqrt(gm) / sqrt(r0)', 'src/mission/launch.rs',
     'let v = (earth.gm / r0).sqrt();', 'let v = earth.gm.sqrt() / r0.sqrt();'),
    ('geodetic: e2 * (sp * sp)', 'src/mission/launch.rs',
     'let n = self.a / (1.0 - e2 * sp * sp).sqrt();', 'let n = self.a / (1.0 - e2 * (sp * sp)).sqrt();'),
    ('earth pole: (90 - dec) * DEG distributed', 'src/mission/launch.rs',
     'sincos((90.0 - dec) * DEG)', 'sincos(90.0 * DEG - dec * DEG)'),
    ('site frame: up as r / |r| instead of r * (1 / |r|)', 'src/mission/launch.rs',
     'let up = scale(&r, 1.0 / norm(&r));', 'let up = { let k = norm(&r); [r[0] / k, r[1] / k, r[2] / k] };'),
    ('pad velocity: omega applied to r before the cross product', 'src/mission/launch.rs',
     'let vp = scale(&cross(&f.pole, &f.r), w);', 'let vp = cross(&f.pole, &scale(&f.r, w));'),
    ('launch: altitude refusal accepts NaN', 'src/mission/launch.rs',
     'if !(spec.altitude_m > 0.0) {', 'if spec.altitude_m <= 0.0 {'),
    ('launch: geocentric added to Earth as geo + e (commutative)', 'src/mission/launch.rs',
     'let state = [e[0] + geo[0],', 'let state = [geo[0] + e[0],'),
    # Layer two: the analytic ascent model.
    ('ascent: drag v * v grouped', 'src/mission/ascent.rs',
     '(0.5 * rho0 * rr * v * v * self.cd_a) / m', '0.5 * rho0 * rr * (v * v) * self.cd_a / m'),
    ('ascent: midpoint half-step as 0.5 * (dt * vdot)', 'src/mission/ascent.rs',
     'let vm = v + 0.5 * dt * out[0];', 'let vm = v + 0.5 * (dt * out[0]);'),
    ('ascent: mass at step start as mdot * i * dt', 'src/mission/ascent.rs',
     'let ma = m_start - mdot * (fi * dt);', 'let ma = m_start - mdot * fi * dt;'),
    ('ascent: stage flow as thrust / isp / g0', 'src/mission/ascent.rs',
     'q += e.thrust / (e.isp * G0);', 'q += e.thrust / e.isp / G0;'),
    ('ascent: massAbove summed from the bottom', 'src/mission/ascent.rs',
     'let mut j = stages.len() as isize - 1;\n    while j > k {\n        m = m + stages[j as usize].wet_mass;\n        j -= 1;\n    }',
     'let mut j = k + 1;\n    while j < stages.len() as isize {\n        m = m + stages[j as usize].wet_mass;\n        j += 1;\n    }'),
    ('ascent: parking kick bisection 49 steps', 'src/mission/ascent.rs',
     'let mut hi = 0.5f64;\n    for _ in 0..50 {', 'let mut hi = 0.5f64;\n    for _ in 0..49 {'),
    ('ascent: direct energy distributed: 0.5 x^2 + 0.5 y^2', 'src/mission/ascent.rs',
     '0.5 * (x * x + y * y) - mu', '0.5 * x * x + 0.5 * y * y - mu'),
    ('ascent: direct cutoff fraction as a reciprocal product', 'src/mission/ascent.rs',
     '(e_goal - e0) / (e1 - e0)', '(e_goal - e0) * (1.0 / (e1 - e0))'),
    ('ascent: drag area exponent as ln * 2 / 3', 'src/mission/ascent.rs',
     'exp((2.0 / 3.0) * ln(m0 / 1000.0)?)?', 'exp(ln(m0 / 1000.0)? * 2.0 / 3.0)?'),
    ('ascent: circularisation shortfall ln(m) - ln(dry)', 'src/mission/ascent.rs',
     'need -= ve * ln(mass / dry)?;', 'need -= ve * (ln(mass)? - ln(dry)?);'),
    ('ascent: non-throttleable flag ignored', 'src/mission/ascent.rs',
     "!s.engines.iter().any(|e| e.throttleable == Some(false))", 'true'),
    # Layer two: events and replay.
    ('events: interior node time as tPrev + h * (i / NODES)', 'src/mission/events.rs',
     't_prev + (h * i as f64) / NODES as f64', 't_prev + h * (i as f64 / NODES as f64)'),
    ('events: minimum bracket made open at b (b > 0)', 'src/mission/events.rs',
     'let is_min = a < 0.0 && b >= 0.0;', 'let is_min = a < 0.0 && b > 0.0;'),
    ('events: bisection midpoint as (lo + hi) * 0.5', 'src/mission/events.rs',
     'let mid = lo + (hi - lo) * 0.5;', 'let mid = (lo + hi) * 0.5;'),
    ('events: bisection capped at 60 iterations', 'src/mission/events.rs',
     'pub const BISECT_MAX: usize = 80;', 'pub const BISECT_MAX: usize = 60;'),
    ('events: bisection capped at 30 iterations', 'src/mission/events.rs',
     'pub const BISECT_MAX: usize = 80;', 'pub const BISECT_MAX: usize = 30;'),
    ('events: speed summed z first', 'src/mission/events.rs',
     'let speed = (r[3] * r[3] + r[4] * r[4] + r[5] * r[5]).sqrt();', 'let speed = (r[5] * r[5] + r[4] * r[4] + r[3] * r[3]).sqrt();'),
    ('events: same-time events not ordered by kind', 'src/mission/events.rs',
     'let d = x.kind.order() - y.kind.order();', 'let d = 0;'),
    ('replay: burn accounting window end exclusive', 'src/mission/replay.rs',
     't <= burns[bi].t_start + burns[bi].duration && m != m_prev', 't < burns[bi].t_start + burns[bi].duration && m != m_prev'),
    ('replay: burn delta-v as ln(m0) - ln(m1)', 'src/mission/replay.rs',
     'let ln = exact_ln(m_start[i] / m_end[i]).expect("exactLn of a burn\'s mass ratio");',
     'let ln = exact_ln(m_start[i]).unwrap() - exact_ln(m_end[i]).unwrap();'),
    ('replay: separation keeps the dropped stage\'s dry mass', 'src/mission/replay.rs',
     'y_start[6] = mass_above(&stages, active as isize);', 'y_start[6] = cutoff(active);'),
    ('replay: staged digest omits the stage reports', 'src/mission/replay.rs',
     'h.f64(s.propellant_used).f64(s.propellant_left).f64(s.delta_v).f64(s.separated_at.unwrap_or(f64::NAN));', 'let _ = s;'),
    ('ascent: climb term as (rP - R) / (R rP)', 'src/mission/ascent.rs',
     'let climb = (v_ins * v_ins + 2.0 * mu * (1.0 / r_ - 1.0 / r_p)).sqrt() - v_ins;', 'let climb = (v_ins * v_ins + 2.0 * mu * ((r_p - r_) / (r_ * r_p))).sqrt() - v_ins;'),
    # Layer two, step five: objectives, conformance, scoring, the leaderboard verdict.
    ('score: delta-v key rounded to nearest', 'src/mission/objectives.rs',
     'pub fn delta_v_key(delta_v: f64) -> f64 {\n    (delta_v * 10.0).ceil()', 'pub fn delta_v_key(delta_v: f64) -> f64 {\n    (delta_v * 10.0).round()'),
    ('score: delta-v key as ceil(dv / 0.1)', 'src/mission/objectives.rs',
     'pub fn delta_v_key(delta_v: f64) -> f64 {\n    (delta_v * 10.0).ceil()', 'pub fn delta_v_key(delta_v: f64) -> f64 {\n    (delta_v / 0.1).ceil()'),
    ('score: time key rounded down', 'src/mission/objectives.rs',
     '    mission_time.ceil()', '    mission_time.floor()'),
    ('score: cost term reassociated: w * (dv / ref)', 'src/mission/objectives.rs',
     '(w.delta_v_weight * dv) / w.delta_v_ref', 'w.delta_v_weight * (dv / w.delta_v_ref)'),
    ('score: !(cost > 0) as cost <= 0 (NaN cost)', 'src/mission/objectives.rs',
     'if !(cost > 0.0) {', 'if cost <= 0.0 {'),
    ('score: dv quantised as key * 0.1', 'src/mission/objectives.rs',
     'let dv = delta_v_key(delta_v) / 10.0;', 'let dv = delta_v_key(delta_v) * 0.1;'),
    ('compareKeys: combined board score ascending', 'src/mission/objectives.rs',
     'Board::Combined => or(or(b.score - a.score,', 'Board::Combined => or(or(a.score - b.score,'),
    ('compareKeys: || treats NaN as a result', 'src/mission/objectives.rs',
     'if x == 0.0 || x.is_nan() { y } else { x }', 'if x == 0.0 { y } else { x }'),
    ('flyby: altitude band open at the top', 'src/mission/objectives.rs',
     'e.altitude >= lo && e.altitude <= hi && e.speed <= vmax', 'e.altitude >= lo && e.altitude < hi && e.speed <= vmax'),
    ('flyby: speed limit strict', 'src/mission/objectives.rs',
     'e.altitude >= lo && e.altitude <= hi && e.speed <= vmax', 'e.altitude >= lo && e.altitude <= hi && e.speed < vmax'),
    ('visit: within strict', 'src/mission/objectives.rs',
     '.find(|e| e.distance <= *within)', '.find(|e| e.distance < *within)'),
    ('return: max altitude strict', 'src/mission/objectives.rs',
     'e.kind == EventKind::AtmosphereEntry || e.altitude <= *max_altitude', 'e.kind == EventKind::AtmosphereEntry || e.altitude < *max_altitude'),
    ('reentry: speed limit inclusive', 'src/mission/objectives.rs',
     'if last.speed > *ms {', 'if last.speed >= *ms {'),
    ('escape: excess speed strict', 'src/mission/objectives.rs',
     'let ok = vinf2 >= min_speed * min_speed;', 'let ok = vinf2 > min_speed * min_speed;'),
    ('escape: r2 summed z first', 'src/mission/objectives.rs',
     'for j in 0..3 {\n                r2 +=', 'for j in (0..3).rev() {\n                r2 +='),
    ('orbit: revolutions reached strictly after', 'src/mission/objectives.rs',
     'if e.t >= need {', 'if e.t > need {'),
    ('orbit: period factor reassociated: rev * (2 pi)', 'src/mission/objectives.rs',
     'need = ext[s].t + revolutions * 2.0 * PI * ((a * a * a) / mu).sqrt();', 'need = ext[s].t + revolutions * (2.0 * PI) * ((a * a * a) / mu).sqrt();'),
    ('orbit: semi-major axis as rp/2 + ra/2', 'src/mission/objectives.rs',
     'let a = 0.5 * (rp + ra);', 'let a = 0.5 * rp + 0.5 * ra;'),
    ('orbit: inclination against the frame axis always', 'src/mission/objectives.rs',
     'if !use_equator || !poles.at(k, e.t, &mut axis) {', 'if true {'),
    ('orbit: next run starts at the failing extremum (s = j)', 'src/mission/objectives.rs',
     '        s = j + 1;\n', '        s = j;\n'),
    ('orbit: periapsis band open at the top', 'src/mission/objectives.rs',
     'if !(e.distance >= band[0] && e.distance <= band[1]) {', 'if !(e.distance >= band[0] && e.distance < band[1]) {'),
    ('evaluate: max-delta-v strict', 'src/mission/objectives.rs',
     'ok: dv <= *max,', 'ok: dv < *max,'),
    ('evaluate: max-time strict', 'src/mission/objectives.rs',
     'ok: goals_ok && mission_time <= *max', 'ok: goals_ok && mission_time < *max'),
    ('evaluate: mission time not relative to the epoch', 'src/mission/objectives.rs',
     '} else { last - epoch };', '} else { last };'),
    ("evaluate: limits not taken from the plan's site", 'src/mission/objectives.rs',
     '        Some(s) => mission_for_site(mission0, s),', '        Some(_) => mission0.clone(),'),
    ('conformance: sameBits as == (signed zero)', 'src/mission/objectives.rs',
     'a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())', 'a == b || (a.is_nan() && b.is_nan())'),
    ('conformance: parking band open at the bottom', 'src/mission/objectives.rs',
     'if !(pn(2) >= v.altitude[0] && pn(2) <= v.altitude[1]) {', 'if !(pn(2) > v.altitude[0] && pn(2) <= v.altitude[1]) {'),
    ('conformance: absent ascent time not defaulted (vehicle rule)', 'src/mission/objectives.rs',
     '} else if let (Some(v), true) = (v_rule, is_launch) {\n            let ascent = p(3).unwrap_or(default_ascent);', '} else if let (Some(v), true) = (v_rule, is_launch) {\n            let ascent = pn(3);'),
    ('conformance: old-version plans also get every other reason', 'src/mission/objectives.rs',
     '        add("start-kind", "start.ascent".into(), OLD_VERSION_MESSAGE.into());\n        return out;', '        add("start-kind", "start.ascent".into(), OLD_VERSION_MESSAGE.into());'),
    ('campaign-sites: loosest limit as min', 'src/mission/objectives.rs',
     '            a = js_max(a, *max_delta_v);', '            a = js_min(a, *max_delta_v);'),
    ('verify: rtol range open at the top', 'src/mission/verify.rs',
     'plan.rtol >= rules.min_rtol && plan.rtol <= rules.max_rtol', 'plan.rtol >= rules.min_rtol && plan.rtol < rules.max_rtol'),
    ('verify: verdict delta-v as key * 0.1', 'src/mission/verify.rs',
     'delta_v: k.delta_v / 10.0', 'delta_v: k.delta_v * 0.1'),
]

# Mutations that are bit-identical by construction or almost never observable,
# kept to document the limits of testing by vectors (see core/README.md).
# The first: a rounding difference in the kernel polynomial r is scaled by
# z * v < 0.5 before it meets the result, so it almost never reaches the last bit.
EXPECTED_INVISIBLE = {
    'FMA Horner in the dmath sine kernel polynomial',
    # EQUIVALENT MUTANT (argued, and every signed-zero case is in the vectors:
    # points with x = +-0, y = +-0 / +-r, z = +-0 / +-r and +-0 accumulators, on
    # a zonal-only degree-4 field where no nonzero term can absorb a zero).
    # x0 * v00 - y0 * 0 differs from x0 * v00 only in the sign of a zero, and
    # only when x0 * v00 = -0 and y0 < 0 (then -0 - (-0) = +0). That flips the
    # sign of v11 only. v11 reaches the output through v22 = 3 (x0 v11 - y0 w11),
    # where y0 w11 != 0 absorbs it, and through the zonal chain v21, v31, v41,
    # v51: with z0 != 0, v31 = a31 v21 - b31 v11 subtracts two zeros of equal
    # sign and is +0 for either sign of v11, and so are v41 and v51; with
    # z0 = +-0 the chain can give v41 = -0, but cz1 * v41 then enters ax as
    # -0 - ... and the accumulated ax is +0 in both forms (worked through
    # above). Any nonzero tesseral term with y != 0 adds a nonzero
    # w-term to ax and absorbs every zero. So no finite input changes a bit.
    'degree-4 field: 1 * (x0 * v00 - y0 * 0) simplified to x0 * v00',
    # EQUIVALENT MUTANTS (layer one). KAHAN_LI_8's drift weights are A_HALF
    # followed by its mirror image, so w[i] and w[n-1-i] are the same float64;
    # b[i] = (w[i-1] + w[i]) / 2 then equals b[n-i] because + is commutative
    # (LEAPFROG, a = [1], b = [1/2, 1/2], is symmetric too). Applying either
    # weight list in reverse stage order therefore uses identical numbers.
    'composition: kick weights applied in reverse stage order',
    'composition: drift weights applied in reverse stage order',
    # Division by 2 and multiplication by 2 are exact for every finite value
    # that neither overflows nor is subnormal (the weights are O(1), dot and
    # vtv are O(1..1e3) Chebyshev sums), so (x + y) / 2 = x / 2 + y / 2 and
    # (2 * dot) / vtv = 2 * (dot / vtv) bit for bit.
    'composition coefficients: b[i] = w[i-1]/2 + w[i]/2',
    'Householder reflector factor reassociated: 2 * (dot / vtv)',
    # NOT OBSERVABLE (not equivalent): the implicit half-kick vt is only the
    # argument of the 1PN acceleration, which is ~1e-8 of the Newtonian one and
    # depends on vt to first order; a 1-ulp change of vt moves apn by ~1e-8 ulp
    # (also with 64-day steps, nbody case rel-long-step). The same arithmetic
    # in the explicit kick (kick(): c * (acc + apn)) IS caught, as is changing
    # the iteration count.
    'implicit half-kick distributed: v + half a + half apn',
    # EQUIVALENT MUTANT (control): IEEE addition is commutative, so e + geo and
    # geo + e are the same float64 for every input, NaN payloads aside (the
    # comparison treats every NaN as equal).
    'launch: geocentric added to Earth as geo + e (commutative)',
    # NOT OBSERVABLE in practice (not equivalent): (eps / 6) s2c2u is ~3e-4 and
    # is added to 1 before it is used, so a 1-ulp change of it (~5e-20) moves
    # 1 + x across a rounding boundary of 1 (ulp 2.2e-16) with probability
    # ~2e-4 per launch; 7,600 j2-mean launches in the vectors expect ~1.5 hits
    # and showed none. The same arithmetic where it is not absorbed (the
    # radial speed vr, eps above) IS caught.
    'launch: j2-mean radius term reassociated: eps * s2c2u / 6',
    # EQUIVALENT MUTANTS (ascent): multiplying by 0.5 is exact for every
    # finite value that is neither subnormal nor overflowing (ascent speeds,
    # times and energies are O(1e-3..1e8)), so (0.5 * dt) * a = 0.5 * (dt * a)
    # and 0.5 * (x^2 + y^2) = 0.5 x^2 + 0.5 y^2 bit for bit. Kept as controls;
    # the non-exact regroupings next to them (mdot * i * dt, the drag v * v,
    # the cutoff reciprocal) are caught.
    'ascent: midpoint half-step as 0.5 * (dt * vdot)',
    'ascent: direct energy distributed: 0.5 x^2 + 0.5 y^2',
    # NOT OBSERVABLE BY CONSTRUCTION (events). Every root is bisected to float
    # resolution (the loop stops when the midpoint is no longer strictly
    # inside the bracket), so the result is the first float at which the
    # predicate fails: the same whatever arithmetic forms the midpoint, and
    # whatever node pair supplied the bracket. Steps are < 2^45 ulps of t, so
    # the loop never reaches 60 iterations (30 IS caught). The half-open
    # bracket and the kind order only matter for g exactly 0 at a node or two
    # events at the same float time, which no trajectory in the corpus has.
    'events: interior node time as tPrev + h * (i / NODES)',
    'events: minimum bracket made open at b (b > 0)',
    'events: bisection midpoint as (lo + hi) * 0.5',
    'events: bisection capped at 60 iterations',
    'events: same-time events not ordered by kind',
    # EQUIVALENT MUTANT (objectives): the run that starts at s stops at the
    # first extremum j that is out of band, so restarting at j instead of
    # j + 1 only re-tests ext[j], which fails again and is skipped.
    'orbit: next run starts at the failing extremum (s = j)',
    # EQUIVALENT: halving is exact (no subnormal or overflowing distances), so
    # 0.5 * (rp + ra) = 0.5 rp + 0.5 ra bit for bit.
    'orbit: semi-major axis as rp/2 + ra/2',
    # NOT OBSERVABLE (not equivalent): the target time `need` changes by an ulp
    # or so, and the result changes only if an extremum's time falls exactly
    # on (>= vs >) or between the two values of need; extremum times are
    # bisected roots, so this needs a coincidence of ~1e-16 relative.
    'orbit: revolutions reached strictly after',
    'orbit: period factor reassociated: rev * (2 pi)',
    # NOT OBSERVABLE in practice: a 1-ulp change of the cost moves
    # floor(10000 / cost) only when 10000 / cost is within ~1e-12 of an
    # integer; with weights 1:1 the regrouping is exact (1 * x = x).
    'score: cost term reassociated: w * (dv / ref)',
}

# Sections a mutated file can affect (others are skipped to save time).
TESTS_FOR = {'src/mission/objectives.rs': ['objectives'], 'src/mission/verify.rs': ['objectives']}


def main() -> int:
    if not os.path.exists(os.path.join(FIXTURES, 'world.txt')):
        print('run `pnpm core:vectors` first', file=sys.stderr)
        return 2
    tmp = tempfile.mkdtemp(prefix='sendit-core-mut-')
    work = os.path.join(tmp, 'core')
    shutil.copytree(CORE, work, ignore=shutil.ignore_patterns('target', 'fixtures'))
    env = dict(os.environ, SENDIT_FIXTURES=FIXTURES, SENDIT_ASSET=os.path.join(CORE, '..', 'src', 'physics', 'data', 'checkpoints-1950-2100.bin'), CARGO_TARGET_DIR=os.path.join(CORE, 'target', 'mutation'))
    only = sys.argv[1:]  # optional substrings of a mutation's name or file: run only those
    failed = 0
    for name, path, old, new in MUTATIONS:
        if only and not any(o in name or o in path for o in only):
            continue
        src = os.path.join(work, path)
        orig = open(src).read()
        if old not in orig:
            print(f'!! {name}: pattern not found (update the mutation)')
            failed += 1
            continue
        open(src, 'w').write(orig.replace(old, new, 1))
        res = subprocess.run(['cargo', 'test', '-j', '4', '--release', '--test', 'parity', '--', '--test-threads=1', *TESTS_FOR.get(path, [])], cwd=work, env=env, capture_output=True, text=True)
        out = res.stdout
        open(src, 'w').write(orig)  # restore before the next mutation, whatever happened
        if res.returncode != 0 and not re.search(r'values compared, [1-9]', out):
            print(f'!! {name}: cargo test failed without a parity mismatch:')
            print('\n'.join((res.stdout + res.stderr).splitlines()[-25:]))
            failed += 1
            continue
        open(src, 'w').write(orig)
        caught = sorted(set(m.group(0) for m in re.finditer(r'^[^\n]*values compared, [1-9]\d* mismatches', out, re.M)))
        if name in EXPECTED_INVISIBLE:
            status = 'caught' if caught else 'not caught (expected: equivalent or not observable; see EXPECTED_INVISIBLE)'
        else:
            status = 'caught' if caught else 'NOT CAUGHT'
            if not caught:
                failed += 1
        print(f'== {name}: {status}')
        for c in caught:
            print('     ' + c)
    shutil.rmtree(tmp)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
