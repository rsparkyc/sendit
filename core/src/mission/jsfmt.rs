//! JavaScript number formatting, so the mission layer's messages and details
//! read exactly as the TypeScript's: `String(x)` (Number::toString, the
//! shortest round-trip digits in JavaScript's layout) and `x.toFixed(f)`
//! (exact decimal value, ties rounded up in magnitude).

/// `String(x)` for a JavaScript number.
pub fn num(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return "0".into();
    }
    let neg = x < 0.0;
    // Rust's `{:e}` gives the shortest round-trip digits: "d.ddde[-]X".
    let e = format!("{:e}", x.abs());
    let (mant, exp) = e.split_once('e').unwrap();
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap() + 1; // value = 0.digits * 10^n
    let mut s = String::new();
    if neg {
        s.push('-');
    }
    if k <= n && n <= 21 {
        s.push_str(&digits);
        for _ in 0..(n - k) {
            s.push('0');
        }
    } else if 0 < n && n <= 21 {
        s.push_str(&digits[..n as usize]);
        s.push('.');
        s.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        s.push_str("0.");
        for _ in 0..(-n) {
            s.push('0');
        }
        s.push_str(&digits);
    } else {
        let e = n - 1;
        s.push_str(&digits[..1]);
        if k > 1 {
            s.push('.');
            s.push_str(&digits[1..]);
        }
        s.push('e');
        s.push(if e < 0 { '-' } else { '+' });
        s.push_str(&e.abs().to_string());
    }
    s
}

/// `x.toFixed(f)` for a JavaScript number (0 <= f <= 100).
pub fn fixed(x: f64, f: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.abs() >= 1e21 {
        return num(x);
    }
    let neg = x < 0.0;
    // The exact decimal expansion (a double has at most 1074 fractional digits).
    let exact = format!("{:.1100}", x.abs());
    let (ip, fp) = exact.split_once('.').unwrap();
    let mut digits: Vec<u8> = ip.bytes().chain(fp.bytes().take(f)).map(|b| b - b'0').collect();
    let round_up = fp.as_bytes().get(f).is_some_and(|&d| d >= b'5');
    if round_up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, 1);
                break;
            }
            i -= 1;
            if digits[i] == 9 {
                digits[i] = 0;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let int_len = digits.len() - f;
    let mut s = String::new();
    if neg {
        s.push('-');
    }
    for d in &digits[..int_len] {
        s.push((b'0' + d) as char);
    }
    if f > 0 {
        s.push('.');
        for d in &digits[int_len..] {
            s.push((b'0' + d) as char);
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn to_string() {
        for (x, s) in [(1e21, "1e+21"), (1e20, "100000000000000000000"), (1e-7, "1e-7"), (1.5e-6, "0.0000015"), (123.456, "123.456"), (-0.0, "0"), (5e-324, "5e-324"), (5e-324 * 2.0, "1e-323"), (1.2345e25, "1.2345e+25"), (40.0 * 365.25 * 86400.0, "1262304000"), (1e-13, "1e-13"), (0.1, "0.1")] {
            assert_eq!(num(x), s, "{x:e}");
        }
    }
    #[test]
    fn to_fixed() {
        for (x, f, s) in [(0.25, 1, "0.3"), (-0.25, 1, "-0.3"), (1.005, 2, "1.00"), (2.5, 0, "3"), (-0.001, 1, "-0.0"), (-0.0, 1, "0.0"), (123.456, 0, "123"), (9.99, 1, "10.0"), (1e21, 2, "1e+21")] {
            assert_eq!(fixed(x, f), s, "{x} {f}");
        }
    }
}
