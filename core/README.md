# sendit-core (phase one)

A Rust port of the sendit physics hot path that reproduces the TypeScript's
float64 results **bit for bit**, natively and as WebAssembly. Not yet used by
the product: this phase proves identity and measures speed.

Toolchain: Rust 1.98.0 (pinned in `rust-toolchain.toml`, with the targets
wasm32-unknown-unknown, aarch64-unknown-linux-gnu, x86_64-unknown-linux-gnu).
No crate dependencies. No wasm-bindgen: the module has plain `extern "C"`
exports (`src/wasm.rs`) driven by `scripts/run-wasm.mjs`. It is lighter, and
the API we want (a worker owning WebAssembly memory and reading buffers out
of it) is pointers and lengths anyway.

## What is ported (all proven against TypeScript vectors)

| Layer | Rust | TypeScript | Vectors (values compared) |
|---|---|---|---|
| sin, cos, sincos, atan, atan2, rad; exactLn, exactExp, Hasher | `dmath.rs`, `exact_math.rs` | `physics/dmath.ts`, `mission/exact-math.ts` | 317,785 |
| DOP853, step control, dense output, refresh, stepFixed, error paths | `dop853.rs` | `physics/dop853.ts` | 29,348 |
| Zonal series, full harmonic field (general and unrolled degree 4), addIcrf | `gravity.rs` | `physics/gravity-field.ts` | 64,680 |
| IAU pole and prime meridian, PoleTable, polesAt, BodyFrame, Delta-T, ERA | `orientation.rs` | `physics/orientation.ts`, `earth-rotation.ts` | 837,247 |
| Chebyshev evaluation: positions, evaluate, evaluateBodies, bodyState | `cheb.rs` | `physics/chebyshev-ephemeris.ts` (evaluation) | 884,520 + 25 golden digests |
| Spacecraft derivative | `spacecraft.rs` | `physics/spacecraft.ts` | 29,778 + 28,000 (1PN at up to c/2) |
| `propagate`: burns (inertial, orbital), depletion, step callback, dense output | `spacecraft.rs` | `physics/spacecraft.ts` | 200,484 per-step values, 4 golden digests, determinism `EXPECTED_HEX`, 49 corrector propagations |

The golden digests of `test/ephemeris-golden.test.ts` (all 15 evaluation
digests in 5 orders, and the 4 propagation digests) and `EXPECTED_HEX` of
`src/fixtures/determinism.ts` are reproduced by the Rust and are pinned as
constants in `src/parity.rs`.

**Not ported:** the massive-body integrator (`nbody.ts`) and the chunk builder
(the Householder fit, ChunkFitter, checkpoints). The Rust loads chunk
coefficients the TypeScript built. Porting them needs: the Kahan-Li 8
composition with Kahan-compensated q and v, the generalised Stormer-Verlet
1PN kick (implicit in v', fixed iteration count), the massive-body zonal and
harmonic pair forces with their reactions, the stage-time construction
`(t0 + n h) + c_i h`, and `exportState`/`importState`. The proof would be the
checkpoint asset's bytes (`src/physics/data/checkpoints-1950-2100.bin`) and the
chunk coefficients of chunks -3..2, compared bit for bit. Also not ported:
the mission layer (plan, ascent, events, replay, objectives), so the pinned
mission replays (`src/fixtures/model2-replay.ts`, `staged-replay.ts`) are not
yet reproduced.

## Running

```sh
pnpm core:vectors                 # TypeScript -> core/fixtures/generated/ (~25 s, ~60 MB, gitignored)
sh core/scripts/test.sh           # no-FMA check, native parity, wasm parity (scalar + SIMD)
python3 core/scripts/mutation-check.py   # every non-equivalent mutant must be caught
cargo run --release --bin bench   # (in core/) native benchmark
node core/scripts/run-wasm.mjs bench [module.wasm] [--simd]
```

### Fixtures

`core/ts/export-vectors.vec.ts` (vitest, with its own config so it is not part
of `pnpm test`) runs the TypeScript and writes text records, one per line,
with every number as 16 hex digits of its float64 bits. Chunk coefficients are
raw little-endian files. The exporter wraps `Dop853` and `propagate` with
`vi.mock` (without changing their arithmetic) to record derivative calls and
the corrector's propagations. The fixtures are generated on demand and not
checked in: they are a pure function of the sources, and the golden digests
that pin them are checked in on both sides. A mismatch report names the record
line, the inputs (in hex) and the first differing values.

## How contraction and reassociation are guarded

1. **Source rules** (`src/lib.rs`): only + - * / sqrt abs floor and
   comparisons. No `mul_add`, no libm, every expression in the TypeScript's
   order, sums as explicit loops in the TypeScript's order. Rust/LLVM never
   fuse a separate multiply and add and never reassociate floats without
   fast-math flags, which Rust does not expose on stable. Constant folding is
   IEEE-exact, the same as the TypeScript's literal parsing.
2. **Static check** (`scripts/check-no-fma.sh`, part of `test.sh`): compiles
   the whole program (fat LTO, bench binary) to assembly for aarch64-apple-darwin,
   aarch64-unknown-linux-gnu (the ARM Lambda) and x86_64-unknown-linux-gnu, and
   the wasm module scalar and SIMD128. It fails on any fmadd/fmsub/fnmadd/fnmsub/fmla/fmls,
   vfmadd*/vfnmadd*/..., or relaxed-simd madd. A positive control (a `mul_add`)
   must be detected for each native target. Result: no fused instruction in
   ~81k-92k native and ~135k wasm instructions.
3. **Build flags**: no `target-cpu=native` and no `+fma`. The only feature ever
   enabled is wasm `simd128`, never `relaxed-simd`.
4. **Mutation check** (`scripts/mutation-check.py`): 11 deliberate breakages.
   9 are caught. The 2 left are documented:
   - FMA in the sine kernel polynomial: a rounding change there is scaled by
     z*v < 0.5 before it meets the result, so vectors essentially never see
     it. This is why the static check exists.
   - `1 * (x0*v00 - y0*0)` simplified to `x0*v00` in the degree-4 field: an
     equivalent mutant, argued in the script and covered by exhaustive
     signed-zero vectors.

### Where bit-identity was fragile (what the mutation check shows)

- A single fused multiply-add in one Chebyshev sum changes only **21 of
  884,520** evaluated coordinates (one in 42,000). A spot check would miss it.
  The golden digests and the propagations (9,202 differing step values) catch
  it.
- A rounding change in the Sun's 1PN term never survives the force sum at
  solar-system speeds (it is ~1e-8 of the acceleration). Vectors at
  relativistic craft speeds (one body, v up to c/2) were needed to see a
  distributed `f*(a-b)` at all, and even there it shows in only 14 of 28,000
  values.
- Signed zeros: `atan2` with a lost zero sign shows in 5 of 318k vectors (the
  special cases), and the degree-4 field needed axis and plane points with ±0
  accumulators before the analysis could be checked.
- Two harness bugs, both on the export side: chunk -3 was needed (the golden
  boundary times include -2C - h/7), and a record count was off. No arithmetic
  mismatch had to be tracked down in the port itself: transcribing each
  expression with its parentheses was enough.

### Layer one of phase two (n-body integrator, chunk builder)

Proven natively and as WebAssembly (scalar and SIMD128), zero mismatches:
the integrator over nine configurations (60,780 values: every step's state
with its compensation terms and the total acceleration; Newtonian, leapfrog,
zonal backward, tesseral/Jn/J4 terms, with and without 1PN, resumed from a
checkpoint in both directions, and 64-day steps), and the chunks
(5,435,339 values: 16 chunks built from the checkpoint asset in shuffled
order, chunks -4..3 built lazily from the epoch, checkpoints -4..4 against
the asset). Mutation check (`python3 scripts/mutation-check.py nbody.rs
chunk.rs`): 9 of 14 mutants caught (Kahan q and v updates, kick
coefficient order, the explicit 1PN kick, the PN iteration count, Householder
vtv order, reciprocal back substitution, the fit's dot-product order); four
are equivalent (reversed stage order of a symmetric scheme, exact halving and
doubling) and one is not observable (the implicit half-kick's argument to the
1PN term); the script gives the reasons. core/data is regenerated and diffed
by scripts/test.sh.

### Layer two: Earth orientation and launch states (`src/mission/launch.rs`)

Ported: earth-orientation.ts (bodyToIcrf, poleAt, spinRate,
geodeticToBodyFixed, siteIcrf with EARTH_ROTATION) and the replay path of
launch.ts (azimuthAllowed, siteFrame, launchPlane, launchGeometry,
launchState in j2-mean / two-body / default modes with its refusals,
directInjectionState). The planning helpers (Math.atan2, Math.asin) are not
ported. Earth's barycentric state is a callback (`earth_state(t, out)`); the
vectors (core/ts/export-launch.vec.ts) record what a fake ephemeris returned
and the time it was asked for, since the Chebyshev evaluation is proven on its
own. 298,740 values over every site x 29 azimuths (corridor limits, one ulp
and 1e-9 deg outside, wrapped by +-360, NaN) x parking altitudes (limits, 0,
-0, negative, NaN) x epochs 1949-2101, 10,500 dense valid launches and 20,000
geodetic points: 0 mismatches natively, scalar and SIMD wasm. Mutation check
(`python3 scripts/mutation-check.py launch.rs geodetic "earth pole" "site frame" "pad velocity"`):
10 of 12 caught; `e + geo` reordered is equivalent (commutative), and the
j2-mean radius term `(eps / 6) s2c2u` reassociated is practically not
observable (absorbed by `1 + x`, ~2e-4 chance per launch; the same change in
the radial speed is caught). The bench binary has a `mission` mode so this
code is in the native no-FMA scan.

## TypeScript behaviours reproduced deliberately

- nbody.ts `fieldOf`: a zonal term whose `tesseral` list is present but
  empty (or holds only zero terms) and which has no `jn` builds neither a
  zonal series nor a full field, and the TypeScript then fails when the term
  is used. The Rust panics at the same point (`field_of` in src/nbody.rs)
  rather than inventing a fallback; no production term has that shape.
- The Earth rotation model (src/physics/earth-rotation.ts) carries no
  `ra0`/`ra1`/`dec0`/`dec1`; the TypeScript reads the pole from the IAU Earth
  model where needed. The Rust takes those four numbers from the generated
  `earthRotation` record of core/data/mission-data.json (written by
  ts/gen-data.vec.ts from the TypeScript's own tables), never from a
  hand-copied constant.

## Benchmarks (Apple M-series, aarch64, Node 22.22.3)

Each block was measured in one sitting, with the 1-minute load average next to
it (12 cores, other agents active).

| Workload | TypeScript (V8), load 7.9 | Rust native, load 5.9 | Wasm in Node, load 6.2 | Wasm SIMD128, load 5.5 |
|---|---|---|---|---|
| positions(), random | 695 ns | 411 ns (f64x2: 427) | 520 ns | 585 ns |
| positions(), sequential | 680 ns | 393 ns (f64x2: 407) | 507 ns | 564 ns |
| evaluate pos+vel | 965 ns | 562 ns | 740 ns | 766 ns |
| bodyState(sun) / (io) | 63 / 321 ns | 31 / 134 ns | - | - |
| LEO 30 d (12,390 steps) | 201.6 ms | 99.0 ms | 128.8 ms | - |
| heliocentric 1 yr | 0.7 ms | 0.3 ms | 0.4 ms | - |
| corrector workload (49 propagations) | 111 ms (incl. planning code) | 54 ms | 74 ms | - |

Spread was small everywhere: the IQR is within ±2% except where noted in the
raw output. **SIMD gives no gain, and is 4-12% slower.** Chebyshev evaluation
is latency-bound on the recurrence `T_{k+1} = 2x T_k - T_{k-1}` (a multiply
and a subtract in series per term), which two lanes do not shorten. Pairs of
bodies already share it in the scalar code. The lane packing only adds
shuffles. A real gain would need independent recurrences interleaved
(several segment lengths at once), which is legal (each lane keeps its own
order) but not done.

**JavaScript-to-WebAssembly boundary:** one `positions()` call per JS call
costs about 4 ns more than looping inside wasm (524 vs 520 ns). A JS callback
per accepted step (`env.on_step`, reading the state through a memory view)
adds 0.8 ms over 12,390 steps, about **65 ns per step**: negligible against
the ~10 µs a step costs. Buffering per-step samples inside wasm and copying
once costs the same as the crossings would. The 173.8 ms in the bench
includes the three extra derivative evaluations of the dense sample per
step, so it is not boundary cost. So the per-step callback is not the
bottleneck. The design below still avoids it, because a browser worker
should not call back per step across a `postMessage`.

Not measured: WebAssembly in a browser engine (Chromium, Firefox, WebKit),
and native on Graviton.

## Design note for the next phases

**Boundary.** Keep the mission layer in TypeScript for now, calling the core
through a narrow API, and move it across in this order:
1. events and sampling, the per-step consumers;
2. replay and the ascent model (`exactExp`, `exactLn` and the trig are already
   ported);
3. objectives and scoring, and plan decoding, last. Plan decoding is
   string-heavy and cheap; it can stay in TypeScript and hand the core a typed
   burn list.

The leaderboard verifier needs the full replay in Rust before the Lambda can
drop Node.

**Browser API.** One worker owns the WebAssembly instance and its memory:
- **Chunks:** coefficients are fetched or built and written once into wasm
  memory (`add_chunk`). The main thread never holds them.
- **Calls:** `propagate(plan) -> handle` runs to completion inside wasm. Step
  records (t, y, and whatever samples and event-detection state the game
  needs) go into a growable wasm buffer. The worker then transfers one
  `Float64Array` slice per request (or per progress slice, via the existing
  "return false to stop" contract, which maps to a step budget per call).
- **Events:** event detection (closest approach, SOI crossings, impact) runs
  inside the core using dense output, so nothing crosses per step.
- **Ephemeris queries** for drawing are batched: N times in, one buffer out.

**Lambda (ARM).** Build `aarch64-unknown-linux-gnu` (or `-musl` for a static
binary) as a `provided.al2023` custom runtime: a small Rust binary reading
the submission JSON, running the replay, and writing the score and digest.
The chunk coefficients the replay needs come from the checkpoint asset. That
needs the chunk builder in Rust, or shipping prebuilt coefficients, which are
about 1 MB per 128 days. `check-no-fma.sh` already covers that target's code
generation. Run the parity suite on Graviton in CI (an ARM runner) before
trusting it.

**Keeping both identical while both exist.**
- CI job 1: `pnpm core:vectors`, then `core/scripts/test.sh` on the
  checked-out commit (x86_64 runner plus an ARM runner).
- CI job 2: run the wasm parity in Playwright's three browsers. The
  `run-wasm.mjs` logic is plain JS and can be loaded in a page.
- One shared set of golden digests: the TypeScript tests' constants are
  duplicated in `src/parity.rs`. Next step: move them to one JSON file both
  read.
- Any change to TypeScript physics arithmetic must come with the same change
  in Rust in the same PR. Otherwise the vectors diverge and CI fails.

**Retiring the TypeScript physics** needs: the nbody integrator and chunk
builder ported and proven (checkpoint asset bytes and chunk digests); the
replay pinned fixtures reproduced; wasm parity in all three browsers in CI;
the worker API above replacing the in-thread calls; then delete
`src/physics/*` except data, keeping the TypeScript exporter only as long as
the vectors are needed (or freezing the vectors as checked-in artifacts at the
switch-over).

**Risks.**
- Browser wasm engines are exact for f64 per spec, but unverified here.
- A future toolchain could change codegen. The static check catches FMA, but
  not, for example, a libm call sneaking in. Grep the wasm imports, and in
  CI, add a test that the module imports only `env.on_step`.
- Accidental `f64::sin` etc. in new code: add a clippy `disallowed_methods`
  list.
- Performance: native is only about 2x V8. The hot paths are latency-bound,
  not throughput-bound, so the large gains would come from restructuring
  (interleaved recurrences, fewer ephemeris calls per step), and that must
  keep each value's operation sequence.
- Fixture size: about 60 MB generated, fine on demand, too big to check in.

**Estimate of remaining work.**
- nbody plus chunk builder with proof: 3-5 days.
- Mission layer (ascent, events, replay, objectives, scoring) with pinned
  replays: 1-2 weeks.
- Worker API and front-end integration: about 1 week.
- Lambda runtime and ARM CI: 2-3 days.
- Browser parity CI: 1-2 days.
- Total: roughly 4-6 weeks of focused work.
