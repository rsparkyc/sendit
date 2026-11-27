//! sendit-core, phase one: a bit-identical Rust port of the sendit physics hot
//! path (deterministic elementary functions, DOP853 with dense output, gravity
//! fields, body orientation and Earth rotation, Chebyshev ephemeris
//! evaluation, spacecraft dynamics and `propagate`). See core/README.md.
//!
//! BIT-IDENTITY RULES (enforced by review, by core/scripts/check-no-fma.sh on
//! the generated code, and by the parity suite in src/parity.rs):
//!  - only + - * / sqrt abs floor and comparisons on f64; no `mul_add`, no
//!    libm (`sin`, `exp`, `powf`, `hypot`, ...), no fast-math intrinsics;
//!  - every expression in the TypeScript's evaluation order (left to right,
//!    same parenthesisation); sums as explicit loops in the same order, never
//!    iterator `sum()` or reductions the compiler could reorder (it does not
//!    reorder floats, but the order must be the TypeScript's);
//!  - no target feature or flag that permits contraction (`-C target-feature`
//!    is not used; Rust emits separate fmul and fadd and LLVM may not fuse
//!    them without fast-math flags, which Rust never sets);
//!  - signed zeros and NaN follow the TypeScript (e.g. `y0 * 0` is kept).

pub mod cheb;
pub mod chunk;
pub mod dmath;
pub mod dop853;
mod dop853_coefficients;
pub mod exact_math;
pub mod fixture;
pub mod gravity;
pub mod json;
pub mod nbody;
pub mod orientation;
pub mod data;
pub mod parity;
pub mod parity2;
pub mod simd;
pub mod spacecraft;
#[cfg(target_arch = "wasm32")]
pub mod wasm;
