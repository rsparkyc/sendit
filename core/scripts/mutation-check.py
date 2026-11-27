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
}


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
        res = subprocess.run(['cargo', 'test', '-j', '4', '--release', '--test', 'parity', '--', '--test-threads=1'], cwd=work, env=env, capture_output=True, text=True)
        out = res.stdout
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
