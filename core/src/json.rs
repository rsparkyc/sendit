//! A small JSON reader (no dependencies) for the generated data files and the
//! checkpoint asset header. Numbers are parsed with `str::parse::<f64>`, which
//! is correctly rounded, so a number written by JavaScript's shortest
//! round-trip formatting comes back with the same bits ("-0" included).
//! Object key order is kept.

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    pub fn get(&self, k: &str) -> Option<&Value> {
        match self {
            Value::Obj(v) => v.iter().find(|(kk, _)| kk == k).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Num(x) => Some(*x),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn as_array(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Arr(a) => Some(a),
            _ => None,
        }
    }
    pub fn as_object(&self) -> Option<&Vec<(String, Value)>> {
        match self {
            Value::Obj(o) => Some(o),
            _ => None,
        }
    }
    /// Field `k` as a number; panics with the key if absent (generated data only).
    pub fn num(&self, k: &str) -> f64 {
        self.get(k).and_then(|v| v.as_f64()).unwrap_or_else(|| panic!("json: no number {k}"))
    }
    pub fn str_of(&self, k: &str) -> &str {
        self.get(k).and_then(|v| v.as_str()).unwrap_or_else(|| panic!("json: no string {k}"))
    }
    pub fn arr(&self, k: &str) -> &Vec<Value> {
        self.get(k).and_then(|v| v.as_array()).unwrap_or_else(|| panic!("json: no array {k}"))
    }
    pub fn nums(&self) -> Vec<f64> {
        self.as_array().expect("json: not an array").iter().map(|v| v.as_f64().expect("json: not a number")).collect()
    }
}

struct P<'a> {
    s: &'a [u8],
    i: usize,
}

pub fn parse(text: &str) -> Result<Value, String> {
    let mut p = P { s: text.as_bytes(), i: 0 };
    let v = p.value()?;
    p.ws();
    if p.i != p.s.len() {
        return Err(format!("trailing characters at {}", p.i));
    }
    Ok(v)
}

impl P<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\n' | b'\r' | b'\t') {
            self.i += 1;
        }
    }
    fn eat(&mut self, c: u8) -> Result<(), String> {
        self.ws();
        if self.i < self.s.len() && self.s[self.i] == c {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected '{}' at {}", c as char, self.i))
        }
    }
    fn value(&mut self) -> Result<Value, String> {
        self.ws();
        let c = *self.s.get(self.i).ok_or("unexpected end")?;
        match c {
            b'{' => {
                self.i += 1;
                let mut o = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Value::Obj(o));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    self.eat(b':')?;
                    let v = self.value()?;
                    o.push((k, v));
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Obj(o));
                        }
                        _ => return Err(format!("expected ',' or '}}' at {}", self.i)),
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut a = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Value::Arr(a));
                }
                loop {
                    a.push(self.value()?);
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Arr(a));
                        }
                        _ => return Err(format!("expected ',' or ']' at {}", self.i)),
                    }
                }
            }
            b'"' => Ok(Value::Str(self.string()?)),
            b't' if self.s[self.i..].starts_with(b"true") => {
                self.i += 4;
                Ok(Value::Bool(true))
            }
            b'f' if self.s[self.i..].starts_with(b"false") => {
                self.i += 5;
                Ok(Value::Bool(false))
            }
            b'n' if self.s[self.i..].starts_with(b"null") => {
                self.i += 4;
                Ok(Value::Null)
            }
            _ => {
                let st = self.i;
                while self.i < self.s.len() && matches!(self.s[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                    self.i += 1;
                }
                let t = std::str::from_utf8(&self.s[st..self.i]).unwrap();
                t.parse::<f64>().map(Value::Num).map_err(|_| format!("bad number {t:?} at {st}"))
            }
        }
    }
    fn hex4(&mut self) -> Result<u32, String> {
        let t = std::str::from_utf8(self.s.get(self.i..self.i + 4).ok_or("bad escape")?).map_err(|_| "bad escape")?;
        self.i += 4;
        u32::from_str_radix(t, 16).map_err(|_| "bad escape".to_string())
    }
    fn string(&mut self) -> Result<String, String> {
        self.ws();
        if self.s.get(self.i) != Some(&b'"') {
            return Err(format!("expected string at {}", self.i));
        }
        self.i += 1;
        let mut out = String::new();
        loop {
            let c = *self.s.get(self.i).ok_or("unterminated string")?;
            self.i += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let e = *self.s.get(self.i).ok_or("bad escape")?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let mut u = self.hex4()?;
                            if (0xd800..0xdc00).contains(&u) && self.s.get(self.i) == Some(&b'\\') && self.s.get(self.i + 1) == Some(&b'u') {
                                self.i += 2;
                                let lo = self.hex4()?;
                                u = 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00);
                            }
                            out.push(char::from_u32(u).unwrap_or('\u{fffd}'));
                        }
                        _ => return Err("bad escape".into()),
                    }
                }
                _ => {
                    // Copy the UTF-8 sequence through.
                    let st = self.i - 1;
                    let len = if c < 0x80 { 1 } else if c >= 0xf0 { 4 } else if c >= 0xe0 { 3 } else { 2 };
                    self.i = st + len;
                    out.push_str(std::str::from_utf8(&self.s[st..st + len]).map_err(|_| "bad utf-8")?);
                }
            }
        }
    }
}
