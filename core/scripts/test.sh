#!/bin/sh
# The core's full test command: static no-FMA check, native parity suite,
# WebAssembly parity (scalar and SIMD128). Needs `pnpm core:vectors` first.
# From the repository root: sh core/scripts/test.sh
set -eu
cd "$(dirname "$0")/.."
# Data drift: core/data (embedded by the crate) must equal a fresh generation
# from the TypeScript and JSON sources.
(cd .. && node_modules/.bin/vitest run --config core/ts/vitest.config.ts core/ts/gen-data.vec.ts >/dev/null)
git diff --exit-code -- data
test -z "$(git status --porcelain -- data)" || { git status --porcelain -- data; echo "core/data: untracked generated files"; exit 1; }
sh scripts/check-no-fma.sh
cargo test -j 4 --release
sh scripts/build.sh
node scripts/run-wasm.mjs parity
node scripts/run-wasm.mjs parity target/wasm-simd/wasm32-unknown-unknown/release/sendit_core.wasm --simd
