// Positive control for check-no-fma.sh: this must compile to a fused
// multiply-add, proving the instruction patterns would catch one.
#[unsafe(no_mangle)]
pub extern "C" fn control(a: f64, b: f64, c: f64) -> f64 {
    a.mul_add(b, c)
}
