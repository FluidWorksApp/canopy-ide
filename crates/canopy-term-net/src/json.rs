//! A small strict JSON parser, so reading the Tailscale CLI's output adds no
//! dependency (and nothing to the lockfile). Strict on purpose: depth capped,
//! trailing data rejected, raw control characters in strings rejected, lone
//! surrogates rejected. It never indexes unchecked and never panics on any
//! input; every failure is a `JsonError`.

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// The number as written. Callers convert with [`Json::as_i64`], so a large
    /// id is never rounded through a float.
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonError(pub &'static str);

const MAX_DEPTH: usize = 64;

pub fn parse(text: &str) -> Result<Json, JsonError> {
    let mut p = Parser {
        b: text.as_bytes(),
        i: 0,
    };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != p.b.len() {
        return Err(JsonError("trailing data"));
    }
    Ok(v)
}

impl Json {
    /// First value for `key` in an object. `None` for other kinds.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Json::Num(n) => n.parse::<i64>().ok(),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    /// Values of an object, in order. Empty for other kinds.
    pub fn object_values(&self) -> Vec<&Json> {
        match self {
            Json::Obj(items) => items.iter().map(|(_, v)| v).collect(),
            _ => Vec::new(),
        }
    }
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> Result<(), JsonError> {
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(JsonError("unexpected character"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, JsonError> {
        if depth > MAX_DEPTH {
            return Err(JsonError("nested too deep"));
        }
        match self.peek() {
            None => Err(JsonError("unexpected end")),
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') => self.literal("true", Json::Bool(true)),
            Some(b'f') => self.literal("false", Json::Bool(false)),
            Some(b'n') => self.literal("null", Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(JsonError("unexpected character")),
        }
    }

    fn literal(&mut self, word: &str, v: Json) -> Result<Json, JsonError> {
        let rest = self.b.get(self.i..).unwrap_or(&[]);
        if rest.starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(JsonError("bad literal"))
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        self.i - start
    }

    fn number(&mut self) -> Result<Json, JsonError> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        if self.digits() == 0 {
            return Err(JsonError("bad number"));
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            if self.digits() == 0 {
                return Err(JsonError("bad number"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if self.digits() == 0 {
                return Err(JsonError("bad number"));
            }
        }
        let text = self.b.get(start..self.i).unwrap_or(&[]);
        Ok(Json::Num(String::from_utf8_lossy(text).into_owned()))
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        let mut v = 0u32;
        for _ in 0..4 {
            let d = self
                .peek()
                .and_then(|c| (c as char).to_digit(16))
                .ok_or(JsonError("bad unicode escape"))?;
            v = v * 16 + d;
            self.i += 1;
        }
        Ok(v)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.eat(b'"')?;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = self.peek().ok_or(JsonError("unterminated string"))?;
            self.i += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = self.peek().ok_or(JsonError("unterminated string"))?;
                    self.i += 1;
                    let ch = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..=0xDBFF).contains(&hi) {
                                self.eat(b'\\')?;
                                self.eat(b'u')?;
                                let lo = self.hex4()?;
                                if !(0xDC00..=0xDFFF).contains(&lo) {
                                    return Err(JsonError("bad surrogate pair"));
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else if (0xDC00..=0xDFFF).contains(&hi) {
                                return Err(JsonError("lone surrogate"));
                            } else {
                                hi
                            };
                            char::from_u32(cp).ok_or(JsonError("bad code point"))?
                        }
                        _ => return Err(JsonError("bad escape")),
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                0..=0x1f => return Err(JsonError("control character in string")),
                _ => out.push(c),
            }
        }
        String::from_utf8(out).map_err(|_| JsonError("invalid utf-8"))
    }

    fn array(&mut self, depth: usize) -> Result<Json, JsonError> {
        self.eat(b'[')?;
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            self.ws();
            items.push(self.value(depth + 1)?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err(JsonError("expected , or ]")),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, JsonError> {
        self.eat(b'{')?;
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Json::Obj(items));
        }
        loop {
            self.ws();
            let key = self.string()?;
            self.ws();
            self.eat(b':')?;
            self.ws();
            let v = self.value(depth + 1)?;
            items.push((key, v));
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Json::Obj(items));
                }
                _ => return Err(JsonError("expected , or }")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_basics() {
        let v = parse(r#" {"a": [1, -2.5e3, true, false, null], "b": {"c": "x"}} "#).unwrap();
        assert_eq!(v.get("a").unwrap().as_array().unwrap().len(), 5);
        assert_eq!(v.get("b").unwrap().get("c").unwrap().as_str(), Some("x"));
        assert_eq!(v.get("missing"), None);
        assert!(v.get("a").unwrap().as_array().unwrap()[4].is_null());
    }

    #[test]
    fn big_ids_stay_exact() {
        let v = parse(r#"{"id": 9007199254740993}"#).unwrap();
        assert_eq!(v.get("id").unwrap().as_i64(), Some(9_007_199_254_740_993));
    }

    #[test]
    fn string_escapes_and_surrogate_pairs() {
        let v = parse(r#""a\n\"\\\/A😀""#).unwrap();
        assert_eq!(v.as_str(), Some("a\n\"\\/A\u{1F600}"));
        assert!(parse(r#""\ud83d""#).is_err());
        assert!(parse(r#""\ude00""#).is_err());
        assert!(parse(r#""\ud83dx""#).is_err());
        assert!(parse(r#""\u12""#).is_err());
        assert!(parse(r#""\q""#).is_err());
    }

    #[test]
    fn rejects_malformed_input_without_panicking() {
        for bad in [
            "",
            "{",
            "[1,]",
            "{\"a\":}",
            "{\"a\" 1}",
            "{,}",
            "tru",
            "01x",
            "-",
            "1.",
            "1e",
            "\"abc",
            "\"a\u{1}b\"",
            "{} x",
            "[] []",
            "nul",
            "{\"a\":1,}",
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn depth_is_capped() {
        let deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
        assert!(parse(&deep).is_err());
        let ok = format!("{}{}", "[".repeat(30), "]".repeat(30));
        assert!(parse(&ok).is_ok());
    }

    #[test]
    fn accessors_are_total() {
        let v = parse("[1]").unwrap();
        assert_eq!(v.get("a"), None);
        assert_eq!(v.as_str(), None);
        assert_eq!(v.as_i64(), None);
        assert!(v.object_values().is_empty());
        assert_eq!(parse("1.5").unwrap().as_i64(), None);
    }
}
