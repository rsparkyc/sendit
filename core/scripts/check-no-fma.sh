#!/bin/sh
# Static guard against floating-point contraction: compiles the whole program
# (the bench binary, fat LTO, so every monomorphised physics function and the
# std code it pulls in) to assembly for the native targets that matter, and
# the WebAssembly module (scalar and SIMD128), and fails if any fused
# multiply-add instruction appears:
#   aarch64 (macOS dev machines, the ARM Lambda): fmadd fmsub fnmadd fnmsub, vector fmla fmls
#   x86_64: vfmadd* vfmsub* vfnmadd* vfnmsub* (and FMA4 vfmaddsd...)
#   wasm32: f64x2.relaxed_madd / relaxed_nmadd (relaxed-simd), any *.fma
# The parity vectors cannot prove absence of contraction (some fused forms are
# almost never observable, see scripts/mutation-check.py); this check can.
# Emits assembly only (no linking), so cross targets need just their rust-std.
set -eu
cd "$(dirname "$0")/.."
J="${CARGO_JOBS:-4}"
fail=0
check() { # file, pattern, label
  if [ ! -s "$1" ]; then echo "FAIL $3: no assembly produced"; fail=1; return; fi
  n=$(grep -Eic "$2" "$1" || true)
  insns=$(grep -Ec '^\s+[a-z]' "$1" || true)
  if [ "$insns" -lt 1000 ]; then
    echo "FAIL $3: only $insns instructions in $1 (not the whole program?)"; fail=1
  elif [ "$n" -ne 0 ]; then
    echo "FAIL $3: $n fused multiply-add instructions"; grep -Ein "$2" "$1" | head -5; fail=1
  else
    echo "ok   $3: no fused multiply-add in $insns instructions"
  fi
}
control() { # target, pattern, extra rustc flags: the control must match the pattern
  o=target/asm/control-$1.s; mkdir -p target/asm
  rustc -O --edition 2024 --crate-type lib --target "$1" $3 --emit=asm -o "$o" scripts/fma-control.rs
  if grep -Eiq "$2" "$o"; then echo "ok   $1: positive control (mul_add) is detected"; else echo "FAIL $1: positive control not detected"; fail=1; fi
}
for T in aarch64-apple-darwin aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu; do
  case $T in
    aarch64*) control $T '^\s+(fmadd|fmsub|fnmadd|fnmsub|fmla|fmls)\s' "" ;;
    x86_64*) control $T '^\s+v?fn?m(add|sub)[0-9a-z]*\s' "-C target-feature=+fma" ;;
  esac
  touch src/lib.rs # force codegen so the .s is regenerated
  # Cross targets have no linker here; only the assembly is needed, so the link step is a no-op.
  CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=true CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=true \
    cargo rustc -q -j "$J" --release --bin bench --target "$T" --target-dir target/asm -- --emit=asm
  f=$(ls -t target/asm/$T/release/deps/bench-*.s | head -1)
  case $T in
    aarch64*) check "$f" '^\s+(fmadd|fmsub|fnmadd|fnmsub|fmla|fmls)\s' "$T" ;;
    x86_64*) check "$f" '^\s+v?fn?m(add|sub)[0-9a-z]*\s' "$T" ;;
  esac
done
for V in scalar simd; do
  if [ $V = simd ]; then RF="-C target-feature=+simd128"; else RF=""; fi
  touch src/lib.rs
  RUSTFLAGS="$RF" cargo rustc -q -j "$J" --release --lib --crate-type cdylib --target wasm32-unknown-unknown --target-dir target/asm-wasm-$V -- --emit=asm
  f=$(ls -t target/asm-wasm-$V/wasm32-unknown-unknown/release/deps/sendit_core*.s | head -1)
  check "$f" '(relaxed_n?madd|\.fma\b|relaxed)' "wasm32 ($V)"
done
exit $fail
