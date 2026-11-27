//! Port of src/mission/exact-math.ts: exactLn, exactExp (fixed term counts,
//! fixed order) and the two-lane 32-bit Hasher.

const LN2: f64 = 0.6931471805599453;
const SQRT2: f64 = 1.4142135623730951;

/// ln(x) for finite x > 0; None where the TypeScript throws.
pub fn exact_ln(x: f64) -> Option<f64> {
    if !(x > 0.0) || x == f64::INFINITY {
        return None;
    }
    let mut e = 0.0f64;
    let mut m = x;
    while m >= 4294967296.0 {
        m *= 2.3283064365386963e-10;
        e += 32.0;
    }
    while m < 2.3283064365386963e-10 {
        m *= 4294967296.0;
        e -= 32.0;
    }
    while m >= SQRT2 {
        m *= 0.5;
        e += 1.0;
    }
    while m < SQRT2 / 2.0 {
        m *= 2.0;
        e -= 1.0;
    }
    let z = (m - 1.0) / (m + 1.0);
    let z2 = z * z;
    let mut s = 1.0 / 41.0;
    let mut k = 19i32;
    while k >= 0 {
        s = 1.0 / (2.0 * k as f64 + 1.0) + z2 * s;
        k -= 1;
    }
    Some(e * LN2 + 2.0 * z * s)
}

/// e^x for |x| <= 700; None where the TypeScript throws.
pub fn exact_exp(x: f64) -> Option<f64> {
    if !(x >= -700.0 && x <= 700.0) {
        return None;
    }
    let k = (x / LN2 + 0.5).floor();
    let r = x - k * 0.6931471803691238 - k * 1.9082149292705877e-10;
    // (The TypeScript also runs an unused loop into `s`; it has no effect.)
    let mut t = 1.0 / 2432902008176640000.0;
    let mut f = 2432902008176640000.0f64;
    let mut n = 19i32;
    while n >= 0 {
        f = f / (n as f64 + 1.0);
        t = 1.0 / f + r * t;
        n -= 1;
    }
    let mut y = t;
    let mut e = k;
    while e >= 32.0 {
        y *= 4294967296.0;
        e -= 32.0;
    }
    while e <= -32.0 {
        y *= 2.3283064365386963e-10;
        e += 32.0;
    }
    while e > 0.0 {
        y *= 2.0;
        e -= 1.0;
    }
    while e < 0.0 {
        y *= 0.5;
        e += 1.0;
    }
    Some(y)
}

/// Incremental 64-bit hash (two 32-bit FNV-1a-style lanes), as exact-math.ts Hasher.
#[derive(Clone)]
pub struct Hasher {
    a: i32,
    b: i32,
}

impl Default for Hasher {
    fn default() -> Self {
        Self::new()
    }
}

impl Hasher {
    pub fn new() -> Self {
        Hasher { a: 0x811c9dc5u32 as i32, b: 0x9747b28cu32 as i32 }
    }
    pub fn byte(&mut self, v: u32) -> &mut Self {
        let v = (v & 0xff) as i32;
        self.a = (self.a ^ v).wrapping_mul(0x01000193);
        self.b = (self.b ^ v).wrapping_mul(0x5bd1e995);
        self.b ^= ((self.b as u32) >> 15) as i32;
        self
    }
    pub fn f64(&mut self, v: f64) -> &mut Self {
        for byte in v.to_le_bytes() {
            self.byte(byte as u32);
        }
        self
    }
    pub fn u32(&mut self, v: u32) -> &mut Self {
        for i in 0..4 {
            self.byte((v >> (8 * i)) & 0xff);
        }
        self
    }
    /// A string as UTF-16 code units (JavaScript's charCodeAt).
    pub fn str_utf16(&mut self, s: &[u16]) -> &mut Self {
        self.u32(s.len() as u32);
        for &c in s {
            self.byte((c & 0xff) as u32).byte((c >> 8) as u32);
        }
        self
    }
    pub fn hex(&self) -> String {
        format!("{:08x}{:08x}", self.a as u32, self.b as u32)
    }
    pub fn u32_value(&self) -> u32 {
        self.a as u32
    }
}
