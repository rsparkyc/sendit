#!/bin/sh
# Builds the core natively (release) and as WebAssembly, scalar and with SIMD128.
# Run from anywhere; outputs under core/target/.
#
# Flags: none that permit floating-point contraction. The only target feature
# ever enabled is wasm `simd128` (exact per-lane f64x2 arithmetic); never
# `relaxed-simd` (its relaxed_madd may fuse), and never x86 `fma`/`+fma` or
# `-C target-cpu=native` (harmless in Rust today, which never contracts, but it
# makes FMA instructions available to any future code path that asks).
set -eu
cd "$(dirname "$0")/.."
cargo build -j 4 --release
cargo rustc -j 4 --release --lib --crate-type cdylib --target wasm32-unknown-unknown --target-dir target/wasm
RUSTFLAGS="-C target-feature=+simd128" cargo rustc -j 4 --release --lib --crate-type cdylib --target wasm32-unknown-unknown --target-dir target/wasm-simd
ls -l target/wasm/wasm32-unknown-unknown/release/sendit_core.wasm target/wasm-simd/wasm32-unknown-unknown/release/sendit_core.wasm
