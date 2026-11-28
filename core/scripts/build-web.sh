#!/bin/sh
# Builds the core as WebAssembly (scalar: SIMD128 gives no gain, see README.md)
# and copies it to public/core/sendit_core.wasm, where the site serves it
# (check.html, and the replay worker behind the ?core=shadow flag). Not checked
# in: CI builds it before `pnpm build`. Run from anywhere.
set -eu
cd "$(dirname "$0")/.."
cargo rustc -j 4 --release --lib --crate-type cdylib --target wasm32-unknown-unknown --target-dir target/wasm
mkdir -p ../public/core
cp target/wasm/wasm32-unknown-unknown/release/sendit_core.wasm ../public/core/sendit_core.wasm
ls -l ../public/core/sendit_core.wasm
