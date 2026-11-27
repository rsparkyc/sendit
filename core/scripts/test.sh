#!/bin/sh
# The core's full test command: static no-FMA check, native parity suite,
# WebAssembly parity (scalar and SIMD128). Needs `pnpm core:vectors` first.
# From the repository root: sh core/scripts/test.sh
set -eu
cd "$(dirname "$0")/.."
sh scripts/check-no-fma.sh
cargo test -j 4 --release
sh scripts/build.sh
node scripts/run-wasm.mjs parity
node scripts/run-wasm.mjs parity target/wasm-simd/wasm32-unknown-unknown/release/sendit_core.wasm --simd
