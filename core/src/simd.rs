//! A two-lane f64 vector with exactly per-lane IEEE-754 operations: separate
//! multiply and add/sub instructions (NEON `fmul`/`fadd` .2d on aarch64,
//! `f64x2.mul`/`f64x2.add` in WebAssembly SIMD128). No fused or relaxed
//! operation is exposed; core/scripts/check-no-fma.sh checks the generated code.

#[cfg(target_arch = "aarch64")]
mod imp {
    use core::arch::aarch64::*;
    #[derive(Clone, Copy)]
    pub struct F64x2(float64x2_t);
    impl F64x2 {
        #[inline(always)]
        pub fn new(a: f64, b: f64) -> Self {
            let arr = [a, b];
            unsafe { F64x2(vld1q_f64(arr.as_ptr())) }
        }
        #[inline(always)]
        pub fn splat(a: f64) -> Self {
            unsafe { F64x2(vdupq_n_f64(a)) }
        }
        #[inline(always)]
        pub fn load(s: &[f64]) -> Self {
            assert!(s.len() >= 2);
            unsafe { F64x2(vld1q_f64(s.as_ptr())) }
        }
        #[inline(always)]
        pub fn add(self, o: Self) -> Self {
            unsafe { F64x2(vaddq_f64(self.0, o.0)) }
        }
        #[inline(always)]
        pub fn mul(self, o: Self) -> Self {
            unsafe { F64x2(vmulq_f64(self.0, o.0)) }
        }
        #[inline(always)]
        pub fn lo(self) -> f64 {
            unsafe { vgetq_lane_f64::<0>(self.0) }
        }
        #[inline(always)]
        pub fn hi(self) -> f64 {
            unsafe { vgetq_lane_f64::<1>(self.0) }
        }
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod imp {
    use core::arch::wasm32::*;
    #[derive(Clone, Copy)]
    pub struct F64x2(v128);
    impl F64x2 {
        #[inline(always)]
        pub fn new(a: f64, b: f64) -> Self {
            F64x2(f64x2(a, b))
        }
        #[inline(always)]
        pub fn splat(a: f64) -> Self {
            F64x2(f64x2_splat(a))
        }
        #[inline(always)]
        pub fn load(s: &[f64]) -> Self {
            F64x2(f64x2(s[0], s[1]))
        }
        #[inline(always)]
        pub fn add(self, o: Self) -> Self {
            F64x2(f64x2_add(self.0, o.0))
        }
        #[inline(always)]
        pub fn mul(self, o: Self) -> Self {
            F64x2(f64x2_mul(self.0, o.0))
        }
        #[inline(always)]
        pub fn lo(self) -> f64 {
            f64x2_extract_lane::<0>(self.0)
        }
        #[inline(always)]
        pub fn hi(self) -> f64 {
            f64x2_extract_lane::<1>(self.0)
        }
    }
}

#[cfg(any(target_arch = "aarch64", all(target_arch = "wasm32", target_feature = "simd128")))]
pub use imp::F64x2;
