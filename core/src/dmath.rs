//! Deterministic sin, cos, sincos, atan, atan2: an operation-for-operation port
//! of src/physics/dmath.ts (fdlibm algorithms, Cody-Waite reduction by pi/2).
//!
//! Only correctly rounded IEEE-754 binary64 operations are used (+ - * /,
//! comparisons, abs, floor), each written as a separate Rust expression in the
//! TypeScript's evaluation order. Rust never contracts `a * b + c` into a fused
//! multiply-add unless `mul_add` is called (it is not, anywhere in this crate;
//! core/scripts/check-no-fma.sh checks the generated code), and never
//! reassociates floating-point expressions. Literal constants are the same
//! decimal strings as in the TypeScript; both languages parse them to the
//! nearest double.

const INV_PIO2: f64 = 6.36619772367581382433e-1;
const PIO2_1: f64 = 1.57079632673412561417e0;
const PIO2_1T: f64 = 6.07710050650619224932e-11;
const PIO2_2: f64 = 6.07710050630396597660e-11;
const PIO2_2T: f64 = 2.02226624879595063154e-21;
const PIO2_3: f64 = 2.02226624871116645580e-21;
const PIO2_3T: f64 = 8.47842766036889956997e-32;
const PIO4: f64 = 7.85398163397448278999e-1;
const MAX_REDUCE: f64 = 823549.6654067;

const S1: f64 = -1.66666666666666324348e-1;
const S2: f64 = 8.33333333332248946124e-3;
const S3: f64 = -1.98412698298579493134e-4;
const S4: f64 = 2.75573137070700676789e-6;
const S5: f64 = -2.50507602534068634195e-8;
const S6: f64 = 1.58969099521155010221e-10;

const C1: f64 = 4.16666666666666019037e-2;
const C2: f64 = -1.38888888888741095749e-3;
const C3: f64 = 2.48015872894767294178e-5;
const C4: f64 = -2.75573143513906633035e-7;
const C5: f64 = 2.08757232129817482790e-9;
const C6: f64 = -1.13596475577881948265e-11;

pub const PI: f64 = 3.141592653589793;
pub const HALF_PI: f64 = 1.5707963267948966;
/// PI / 180, as the TypeScript computes it (one correctly rounded division).
pub const DEG: f64 = PI / 180.0;

/// The argument was outside |x| <= 2^19 pi/2 (the TypeScript throws a RangeError).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RangeError(pub f64);

#[inline(always)]
fn k_sin(x: f64, y: f64) -> f64 {
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    x - ((z * (0.5 * y - v * r) - y) - v * S1)
}

#[inline(always)]
fn k_cos(x: f64, y: f64) -> f64 {
    let z = x * x;
    let w = z * z;
    let r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
    let hz = 0.5 * z;
    let one = 1.0 - hz;
    one + (((1.0 - one) - hz) + (z * r - x * y))
}

/// x = n pi/2 + (hi + lo); returns (n mod 4, hi, lo).
#[inline(always)]
fn reduce(x: f64) -> Result<(u32, f64, f64), RangeError> {
    let ax = x.abs();
    if ax <= PIO4 {
        return Ok((0, x, 0.0));
    }
    if !(ax <= MAX_REDUCE) {
        if ax != ax {
            return Ok((0, f64::NAN, 0.0));
        }
        return Err(RangeError(x));
    }
    let fn_ = if x >= 0.0 { (x * INV_PIO2 + 0.5).floor() } else { -((-x * INV_PIO2 + 0.5).floor()) };
    let mut r = x - fn_ * PIO2_1;
    let mut t = r;
    // The TypeScript computes `w = fn * PIO2_1T` and overwrites it unused.
    let mut w = fn_ * PIO2_2;
    r = t - w;
    let w2 = fn_ * PIO2_2T - ((t - r) - w);
    let _ = w2; // fdlibm's first-round tail, overwritten before use (as in the TypeScript)
    t = r;
    w = fn_ * PIO2_3;
    r = t - w;
    w = fn_ * PIO2_3T - ((t - r) - w);
    let _ = PIO2_1T;
    let y0 = r - w;
    let lo = (r - y0) - w;
    let n = fn_ - 4.0 * (fn_ / 4.0).floor();
    Ok((n as u32, y0, lo))
}

pub fn try_sin(x: f64) -> Result<f64, RangeError> {
    let (n, a, b) = reduce(x)?;
    Ok(match n {
        0 => k_sin(a, b),
        1 => k_cos(a, b),
        2 => -k_sin(a, b),
        _ => -k_cos(a, b),
    })
}

pub fn try_cos(x: f64) -> Result<f64, RangeError> {
    let (n, a, b) = reduce(x)?;
    Ok(match n {
        0 => k_cos(a, b),
        1 => -k_sin(a, b),
        2 => -k_cos(a, b),
        _ => k_sin(a, b),
    })
}

/// (sin x, cos x) with one reduction; identical bits to sin(x), cos(x).
#[inline]
pub fn try_sincos(x: f64) -> Result<(f64, f64), RangeError> {
    let (n, a, b) = reduce(x)?;
    let s = k_sin(a, b);
    let c = k_cos(a, b);
    Ok(match n {
        0 => (s, c),
        1 => (c, -s),
        2 => (-s, -c),
        _ => (-c, s),
    })
}

/// Panics outside the supported range, as the TypeScript throws.
#[inline]
pub fn sin(x: f64) -> f64 {
    try_sin(x).expect("dmath: argument outside |x| <= 2^19*pi/2")
}
#[inline]
pub fn cos(x: f64) -> f64 {
    try_cos(x).expect("dmath: argument outside |x| <= 2^19*pi/2")
}
#[inline]
pub fn sincos(x: f64) -> (f64, f64) {
    try_sincos(x).expect("dmath: argument outside |x| <= 2^19*pi/2")
}

const ATAN_HI: [f64; 4] = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800e0];
const ATAN_LO: [f64; 4] = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT: [f64; 11] = [
    3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.11111104054623557880e-1,
    9.09088713343650656196e-2, -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2,
    4.97687799461593236017e-2, -3.65315727442169155270e-2, 1.62858201153657823623e-2,
];

pub fn atan(x: f64) -> f64 {
    if x != x {
        return x;
    }
    let neg = x < 0.0;
    let mut ax = if neg { -x } else { x };
    if ax >= 1.8014398509481984e16 {
        return if neg { -ATAN_HI[3] - ATAN_LO[3] } else { ATAN_HI[3] + ATAN_LO[3] };
    }
    let id: i32;
    if ax < 0.4375 {
        if ax < 7.450580596923828e-9 {
            return x;
        }
        id = -1;
    } else if ax < 0.6875 {
        id = 0;
        ax = (2.0 * ax - 1.0) / (2.0 + ax);
    } else if ax < 1.1875 {
        id = 1;
        ax = (ax - 1.0) / (ax + 1.0);
    } else if ax < 2.4375 {
        id = 2;
        ax = (ax - 1.5) / (1.0 + 1.5 * ax);
    } else {
        id = 3;
        ax = -1.0 / ax;
    }
    let z = ax * ax;
    let w = z * z;
    let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    if id < 0 {
        let r = ax - ax * (s1 + s2);
        return if neg { -r } else { r };
    }
    let i = id as usize;
    let r = ATAN_HI[i] - ((ax * (s1 + s2) - ATAN_LO[i]) - ax);
    if neg { -r } else { r }
}

const PI_LO: f64 = 1.2246467991473531772e-16;

/// atan2(y, x) in (-pi, pi], fdlibm's special cases for signed zeros and infinities.
pub fn atan2(y: f64, x: f64) -> f64 {
    if x != x || y != y {
        return f64::NAN;
    }
    // `1 / y < 0` in the TypeScript is the sign bit of a zero.
    let y_neg = y < 0.0 || (y == 0.0 && y.is_sign_negative());
    if y == 0.0 {
        let x_neg = x < 0.0 || (x == 0.0 && x.is_sign_negative());
        if !x_neg {
            return y;
        }
        return if y_neg { -PI } else { PI };
    }
    if x == 0.0 {
        return if y_neg { -HALF_PI } else { HALF_PI };
    }
    let x_inf = x == f64::INFINITY || x == f64::NEG_INFINITY;
    let y_inf = y == f64::INFINITY || y == f64::NEG_INFINITY;
    if x_inf {
        if y_inf {
            let a = if x > 0.0 { PIO4 } else { 3.0 * PIO4 };
            return if y_neg { -a } else { a };
        }
        let a = if x > 0.0 { 0.0 } else { PI };
        return if y_neg { -a } else { a };
    }
    if y_inf {
        return if y_neg { -HALF_PI } else { HALF_PI };
    }
    let ay = y.abs();
    let ax = x.abs();
    let z;
    if ay > 1.8014398509481984e16 * ax {
        return if y_neg { -HALF_PI } else { HALF_PI };
    } else if x < 0.0 && ay < 5.551115123125783e-17 * ax {
        z = 0.0;
    } else {
        z = atan(ay / ax);
    }
    if x > 0.0 {
        return if y_neg { -z } else { z };
    }
    let r = PI - (z - PI_LO);
    if y_neg { -r } else { r }
}

/// Degrees to radians (one correctly rounded multiplication).
#[inline]
pub fn rad(deg: f64) -> f64 {
    deg * DEG
}
