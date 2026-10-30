//! JSON as nook reads and writes it (RFC 8259, no BOM). `parse` builds a tree that borrows its text: a string
//! is copied only when it holds an escape, and a number stays as its text. A `Reader` reads typed values
//! straight off the text instead. `to_string` writes compact JSON, `pretty` indented.
use std::{
    borrow::Cow,
    fmt::{self, Write},
    path::PathBuf,
};

/// A JSON value. An object keeps its keys in the text's order, repeats included.
#[derive(Debug, PartialEq)]
pub enum J<'a> {
    Null,
    Bool(bool),
    Num(&'a str),
    Str(Cow<'a, str>),
    Arr(Vec<J<'a>>),
    Obj(Vec<(Cow<'a, str>, J<'a>)>),
}

static NULL: J = J::Null;

impl<'a> std::ops::Index<&str> for J<'a> {
    type Output = J<'a>;

    /// The value under `key`, the last one should it repeat; Null when there's none.
    fn index(&self, key: &str) -> &J<'a> {
        match self {
            J::Obj(m) => m.iter().rev().find(|(k, _)| k == key).map_or(&NULL, |(_, v)| v),
            _ => &NULL,
        }
    }
}

impl J<'_> {
    pub fn as_str(&self) -> Option<&str> {
        if let J::Str(s) = self { Some(s) } else { None }
    }

    pub fn as_bool(&self) -> Option<bool> {
        if let J::Bool(b) = self { Some(*b) } else { None }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, J::Null)
    }
}

impl PartialEq<&str> for J<'_> {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == Some(*other)
    }
}

impl PartialEq<bool> for J<'_> {
    fn eq(&self, other: &bool) -> bool {
        self.as_bool() == Some(*other)
    }
}

/// Why a text isn't the JSON asked for, and where.
#[derive(Debug)]
pub struct Error {
    what: Cow<'static, str>,
    line: usize,
    column: usize,
}

impl Error {
    /// What went wrong, without where.
    pub fn what(&self) -> &str {
        &self.what
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{} at line {} column {}", self.what, self.line, self.column)
    }
}

/// Parses all of `text` as one value.
pub fn parse(text: &str) -> Result<J<'_>, Error> {
    let mut p = Reader::new(text);
    let v = p.value::<true>()?;
    p.end().map(|()| v)
}

/// The values of `keys` in `text`'s outer object, Null where missing, once all of `text` checks out as JSON.
/// Every other value is checked but never built, so a line that doesn't matter costs no allocation.
pub fn fields<'a, const N: usize>(text: &'a str, keys: [&str; N]) -> Result<[J<'a>; N], Error> {
    let mut p = Reader::new(text);
    let mut out = [const { J::Null }; N];
    if p.ws() == Some(b'{') {
        p.object::<true>(|p, key| {
            match keys.iter().position(|k| *k == key) {
                Some(n) => out[n] = p.value::<true>()?,
                None => p.skip()?,
            }
            Ok(())
        })?;
    } else {
        p.skip()?;
    }
    p.end().map(|()| out)
}

const EOF_LIST: &str = "EOF while parsing a list";
const EOF_OBJECT: &str = "EOF while parsing an object";
const EOF_STRING: &str = "EOF while parsing a string";
const EOF_VALUE: &str = "EOF while parsing a value";

/// Reads JSON a value at a time. An error points at the last byte read, or at the byte ahead when it was only
/// peeked at, and a value of the wrong type is refused past its end.
pub struct Reader<'a> {
    text: &'a str,
    s: &'a [u8],
    i: usize,
    depth: u32,
    /// Where a string with escapes is unescaped, before it's copied out at its own size.
    scratch: String,
}

impl<'a> Reader<'a> {
    pub fn new(text: &'a str) -> Self {
        Reader { text, s: text.as_bytes(), i: 0, depth: 0, scratch: String::new() }
    }

    /// Refuses anything but whitespace after the value read.
    pub fn end(&mut self) -> Result<(), Error> {
        match self.ws() {
            Some(_) => Err(self.peek_err("trailing characters")),
            None => Ok(()),
        }
    }

    /// `what`, placed where the reader is: past the value it just read.
    pub fn here(&self, what: impl Into<Cow<'static, str>>) -> Error {
        self.fail(what, self.i)
    }

    /// `what`, placed on the colon of the key whose value is next.
    pub fn at_key(&self, what: impl Into<Cow<'static, str>>) -> Error {
        self.fail(what, self.i - 1)
    }

    /// Checks one value and moves past it.
    pub fn skip(&mut self) -> Result<(), Error> {
        self.value::<false>().map(drop)
    }

    pub fn bool(&mut self) -> Result<bool, Error> {
        match self.ws() {
            Some(b't') => self.word(b"true", true),
            Some(b'f') => self.word(b"false", false),
            next => Err(self.wrong(next, "a boolean")),
        }
    }

    pub fn str(&mut self) -> Result<Cow<'a, str>, Error> {
        match self.ws() {
            Some(b'"') => {
                self.i += 1;
                self.string::<true>()
            }
            next => Err(self.wrong(next, "a string")),
        }
    }

    /// A number that reads as a `T`, which `what` names in an error: for an integer type, any other number is
    /// refused, a fraction or exponent included.
    pub fn num<T: std::str::FromStr>(&mut self, what: &str) -> Result<T, Error> {
        match self.ws() {
            Some(b'-' | b'0'..=b'9') => {
                let n = self.number()?;
                n.parse().map_err(|_| self.here(format!("invalid value: {n}, expected {what}")))
            }
            next => Err(self.wrong(next, what)),
        }
    }

    /// The text of the value ahead, checked as JSON.
    pub fn raw(&mut self) -> Result<&'a str, Error> {
        self.ws();
        let from = self.i;
        self.skip()?;
        Ok(&self.text[from..self.i])
    }

    /// Reads a `null` if one is next, and says whether it did.
    pub fn null(&mut self) -> Result<bool, Error> {
        match self.ws() {
            Some(b'n') => self.word(b"null", true),
            _ => Ok(false),
        }
    }

    /// An array: `each` reads every element.
    pub fn list(&mut self, each: impl FnMut(&mut Self) -> Result<(), Error>) -> Result<(), Error> {
        match self.ws() {
            Some(b'[') => self.array(each),
            next => Err(self.wrong(next, "a sequence")),
        }
    }

    /// An object, refused as not `what` should it be anything else: `each` gets every key, and reads its value.
    pub fn map(&mut self, what: &str, each: impl FnMut(&mut Self, Cow<'a, str>) -> Result<(), Error>) -> Result<(), Error> {
        match self.ws() {
            Some(b'{') => self.object::<true>(each),
            next => Err(self.wrong(next, what)),
        }
    }

    /// The object ahead as `what`, handing `set` the index in `keys` of each key it holds, with the reader at its
    /// value. Any other key's value is skipped, and a key twice is refused, placed on its colon.
    pub fn known(&mut self, what: &str, keys: &[&str], mut set: impl FnMut(&mut Self, usize) -> Result<(), Error>) -> Result<(), Error> {
        let mut seen = 0u64;
        self.map(what, |p, key| match keys.iter().position(|k| *k == key) {
            Some(i) if seen & 1 << i != 0 => Err(p.at_key(format!("duplicate field `{key}`"))),
            Some(i) => {
                seen |= 1 << i;
                set(p, i)
            }
            None => p.skip(),
        })
    }

    /// `field`'s value, or the error for its absence, placed past the object.
    pub fn needs<T>(&self, value: Option<T>, field: &str) -> Result<T, Error> {
        value.ok_or_else(|| self.here(format!("missing field `{field}`")))
    }

    /// The value ahead, `next`, isn't `expected`: says what it is, placed past it if it's a scalar.
    #[cold]
    fn wrong(&mut self, next: Option<u8>, expected: &str) -> Error {
        match self.found(next) {
            Ok(found) => self.here(format!("invalid type: {found}, expected {expected}")),
            Err(e) => e,
        }
    }

    fn found(&mut self, next: Option<u8>) -> Result<String, Error> {
        Ok(match next {
            None => return Err(self.peek_err(EOF_VALUE)),
            Some(b'n') => self.word(b"null", "null".into())?,
            Some(b't') => self.word(b"true", "boolean `true`".into())?,
            Some(b'f') => self.word(b"false", "boolean `false`".into())?,
            Some(b'-' | b'0'..=b'9') => format!("number {}", self.number()?),
            Some(b'"') => {
                self.i += 1;
                format!("string {:?}", self.string::<true>()?)
            }
            Some(b'[') => "sequence".into(),
            Some(b'{') => "map".into(),
            Some(_) => return Err(self.peek_err("expected value")),
        })
    }

    #[cold]
    fn peek_err(&self, what: &'static str) -> Error {
        self.fail(what, (self.i + 1).min(self.s.len()))
    }

    /// `what` at byte `i`. Lines count from 1, and the column is the bytes from the line's start.
    #[cold]
    fn fail(&self, what: impl Into<Cow<'static, str>>, i: usize) -> Error {
        let start = self.s[..i].iter().rposition(|&b| b == b'\n').map_or(0, |n| n + 1);
        let line = 1 + self.s[..start].iter().filter(|&&b| b == b'\n').count();
        Error { what: what.into(), line, column: i - start }
    }

    fn peek(&self) -> u8 {
        self.s.get(self.i).copied().unwrap_or(0)
    }

    /// The next byte past whitespace, not consumed.
    fn ws(&mut self) -> Option<u8> {
        while let Some(&c) = self.s.get(self.i) {
            if !matches!(c, b' ' | b'\n' | b'\t' | b'\r') {
                return Some(c);
            }
            self.i += 1;
        }
        None
    }

    /// One value. Unless `B`, it is only checked, and comes back Null.
    fn value<const B: bool>(&mut self) -> Result<J<'a>, Error> {
        let Some(c) = self.ws() else { return Err(self.peek_err(EOF_VALUE)) };
        Ok(match c {
            b'"' => {
                self.i += 1;
                let s = self.string::<B>()?;
                if B { J::Str(s) } else { J::Null }
            }
            b'{' => {
                let mut m = Vec::new();
                self.object::<B>(|p, key| {
                    let v = p.value::<B>()?;
                    if B {
                        m.push((key, v));
                    }
                    Ok(())
                })?;
                J::Obj(m)
            }
            b'[' => {
                let mut items = Vec::new();
                self.array(|p| {
                    let v = p.value::<B>()?;
                    if B {
                        items.push(v);
                    }
                    Ok(())
                })?;
                J::Arr(items)
            }
            b't' => self.word(b"true", J::Bool(true))?,
            b'f' => self.word(b"false", J::Bool(false))?,
            b'n' => self.word(b"null", J::Null)?,
            b'-' | b'0'..=b'9' => J::Num(self.number()?),
            _ => return Err(self.peek_err("expected value")),
        })
    }

    /// One more level of nesting, past its bracket: the 128th is refused, so the stack can't overflow.
    fn enter(&mut self) -> Result<(), Error> {
        self.depth += 1;
        if self.depth == 128 {
            return Err(self.peek_err("recursion limit exceeded"));
        }
        self.i += 1;
        Ok(())
    }

    /// An object, from its `{`: `each` gets every key once its colon is past, and reads the value. Unless `B`,
    /// the keys are only checked.
    fn object<const B: bool>(&mut self, mut each: impl FnMut(&mut Self, Cow<'a, str>) -> Result<(), Error>) -> Result<(), Error> {
        self.enter()?;
        match self.ws() {
            Some(b'}') => {}
            Some(b'"') => loop {
                self.i += 1;
                let key = self.string::<B>()?;
                match self.ws() {
                    Some(b':') => self.i += 1,
                    Some(_) => return Err(self.peek_err("expected `:`")),
                    None => return Err(self.peek_err(EOF_OBJECT)),
                }
                each(self, key)?;
                match self.ws() {
                    Some(b',') => {
                        self.i += 1;
                        match self.ws() {
                            Some(b'"') => {}
                            Some(b'}') => return Err(self.peek_err("trailing comma")),
                            Some(_) => return Err(self.peek_err("key must be a string")),
                            None => return Err(self.peek_err(EOF_VALUE)),
                        }
                    }
                    Some(b'}') => break,
                    Some(_) => return Err(self.peek_err("expected `,` or `}`")),
                    None => return Err(self.peek_err(EOF_OBJECT)),
                }
            },
            Some(_) => return Err(self.peek_err("key must be a string")),
            None => return Err(self.peek_err(EOF_OBJECT)),
        }
        self.i += 1;
        self.depth -= 1;
        Ok(())
    }

    /// An array, from its `[`: `each` reads every element.
    fn array(&mut self, mut each: impl FnMut(&mut Self) -> Result<(), Error>) -> Result<(), Error> {
        self.enter()?;
        match self.ws() {
            Some(b']') => {}
            Some(_) => loop {
                each(self)?;
                match self.ws() {
                    Some(b',') => {
                        self.i += 1;
                        match self.ws() {
                            Some(b']') => return Err(self.peek_err("trailing comma")),
                            Some(_) => {}
                            None => return Err(self.peek_err(EOF_VALUE)),
                        }
                    }
                    Some(b']') => break,
                    Some(_) => return Err(self.peek_err("expected `,` or `]`")),
                    None => return Err(self.peek_err(EOF_LIST)),
                }
            },
            None => return Err(self.peek_err(EOF_LIST)),
        }
        self.i += 1;
        self.depth -= 1;
        Ok(())
    }

    /// `true`, `false`, or `null`, from its first letter, read as `v`.
    fn word<T>(&mut self, word: &[u8], v: T) -> Result<T, Error> {
        self.i += 1;
        for &want in &word[1..] {
            let Some(&c) = self.s.get(self.i) else { return Err(self.here(EOF_VALUE)) };
            self.i += 1;
            if c != want {
                return Err(self.here("expected ident"));
            }
        }
        Ok(v)
    }

    fn digits(&mut self) -> usize {
        let from = self.i;
        while self.peek().is_ascii_digit() {
            self.i += 1;
        }
        self.i - from
    }

    /// A number's text.
    fn number(&mut self) -> Result<&'a str, Error> {
        let start = self.i;
        if self.s[start] == b'-' {
            self.i += 1;
        }
        let Some(&first) = self.s.get(self.i) else { return Err(self.here(EOF_VALUE)) };
        self.i += 1;
        match first {
            b'0' if self.peek().is_ascii_digit() => return Err(self.peek_err("invalid number")),
            b'0' => {}
            b'1'..=b'9' => {
                self.digits();
            }
            _ => return Err(self.here("invalid number")),
        }
        if self.peek() == b'.' {
            self.i += 1;
            if self.digits() == 0 {
                return Err(self.peek_err(if self.i < self.s.len() { "invalid number" } else { EOF_VALUE }));
            }
        }
        if matches!(self.peek(), b'e' | b'E') {
            self.i += 1;
            if matches!(self.peek(), b'+' | b'-') {
                self.i += 1;
            }
            let Some(&c) = self.s.get(self.i) else { return Err(self.here(EOF_VALUE)) };
            self.i += 1;
            if !c.is_ascii_digit() {
                return Err(self.here("invalid number"));
            }
            self.digits();
        }
        Ok(&self.text[start..self.i])
    }

    /// Moves to the next `"`, `\`, or control character in a string, eight bytes at a time.
    fn plain(&mut self) {
        const ONES: u64 = u64::MAX / 255;
        let s = self.s;
        let mut i = self.i;
        while let Some(chunk) = s.get(i..i + 8) {
            let c = u64::from_le_bytes(chunk.try_into().unwrap());
            let (quote, slash) = (c ^ (ONES * b'"' as u64), c ^ (ONES * b'\\' as u64));
            let control = c.wrapping_sub(ONES * 0x20) & !c;
            let hits = (control | quote.wrapping_sub(ONES) & !quote | slash.wrapping_sub(ONES) & !slash) & (ONES << 7);
            if hits != 0 {
                self.i = i + hits.trailing_zeros() as usize / 8;
                return;
            }
            i += 8;
        }
        while i < s.len() && !matches!(s[i], b'"' | b'\\' | 0..=0x1F) {
            i += 1;
        }
        self.i = i;
    }

    /// A string's contents, from just past its opening quote. Unless `B`, they are only checked.
    fn string<const B: bool>(&mut self) -> Result<Cow<'a, str>, Error> {
        let (text, mut from, mut escaped) = (self.text, self.i, false);
        loop {
            self.plain();
            match self.s.get(self.i) {
                Some(b'"') => {
                    let rest = &text[from..self.i];
                    self.i += 1;
                    if !escaped {
                        return Ok(Cow::Borrowed(rest));
                    }
                    if !B {
                        return Ok(Cow::Borrowed(""));
                    }
                    self.scratch.push_str(rest);
                    return Ok(Cow::Owned(self.scratch.as_str().into()));
                }
                Some(b'\\') => {
                    if B {
                        if !escaped {
                            self.scratch.clear();
                        }
                        self.scratch.push_str(&text[from..self.i]);
                    }
                    self.i += 1;
                    let c = self.escape()?;
                    if B {
                        self.scratch.push(c);
                    }
                    (from, escaped) = (self.i, true);
                }
                Some(_) => {
                    self.i += 1;
                    return Err(self.here("control character (\\u0000-\\u001F) found while parsing a string"));
                }
                None => return Err(self.here(EOF_STRING)),
            }
        }
    }

    /// The character an escape stands for, from just past its backslash.
    fn escape(&mut self) -> Result<char, Error> {
        let Some(&c) = self.s.get(self.i) else { return Err(self.here(EOF_STRING)) };
        self.i += 1;
        Ok(match c {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'b' => '\x08',
            b'f' => '\x0c',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            b'u' => return self.unicode(),
            _ => return Err(self.here("invalid escape")),
        })
    }

    /// A `\u` escape, or two for a character past U+FFFF. A lone surrogate is refused.
    fn unicode(&mut self) -> Result<char, Error> {
        let lone = "lone leading surrogate in hex escape";
        let high = self.hex()?;
        if (0xDC00..0xE000).contains(&high) {
            return Err(self.here(lone));
        }
        if !(0xD800..0xDC00).contains(&high) {
            return Ok(char::from_u32(high).unwrap());
        }
        for want in *b"\\u" {
            let Some(&c) = self.s.get(self.i) else { return Err(self.here(EOF_STRING)) };
            self.i += 1;
            if c != want {
                return Err(self.here("unexpected end of hex escape"));
            }
        }
        let low = self.hex()?;
        if !(0xDC00..0xE000).contains(&low) {
            return Err(self.here(lone));
        }
        Ok(char::from_u32(0x10000 + ((high - 0xD800) << 10 | (low - 0xDC00))).unwrap())
    }

    fn hex(&mut self) -> Result<u32, Error> {
        let Some(digits) = self.s.get(self.i..self.i + 4) else {
            self.i = self.s.len();
            return Err(self.here(EOF_STRING));
        };
        self.i += 4;
        let n = digits.iter().try_fold(0, |n, &d| Some(n << 4 | (d as char).to_digit(16)?));
        n.ok_or_else(|| self.here("invalid escape"))
    }
}

/// A value read straight off JSON text, as a typed field of settings.json or a command's argument.
pub trait Take: Sized {
    fn take(p: &mut Reader) -> Result<Self, Error>;

    /// The value when its key is missing, for a type that may be.
    fn absent() -> Option<Self> {
        None
    }
}

impl Take for bool {
    fn take(p: &mut Reader) -> Result<Self, Error> {
        p.bool()
    }
}

impl Take for String {
    fn take(p: &mut Reader) -> Result<Self, Error> {
        p.str().map(String::from)
    }
}

macro_rules! numbers {
    ($($t:ident)*) => {$(
        impl Take for $t {
            fn take(p: &mut Reader) -> Result<Self, Error> {
                p.num(stringify!($t))
            }
        }
    )*};
}
numbers!(u8 u16 u32 u64 usize f64);

impl<T: Take> Take for Option<T> {
    fn take(p: &mut Reader) -> Result<Self, Error> {
        if p.null()? { Ok(None) } else { T::take(p).map(Some) }
    }

    fn absent() -> Option<Self> {
        Some(None)
    }
}

impl<T: Take> Take for Vec<T> {
    fn take(p: &mut Reader) -> Result<Self, Error> {
        let mut items = Vec::new();
        p.list(|p| T::take(p).map(|v| items.push(v)))?;
        Ok(items)
    }
}

impl<T: Take, const N: usize> Take for [T; N] {
    fn take(p: &mut Reader) -> Result<Self, Error> {
        let items = Vec::<T>::take(p)?;
        let n = items.len();
        items.try_into().map_err(|_| p.here(format!("invalid length {n}, expected an array of length {N}")))
    }
}

/// A value kept as its JSON text.
pub struct Text(pub String);

impl Take for Text {
    fn take(p: &mut Reader) -> Result<Self, Error> {
        p.raw().map(|t| Text(t.into()))
    }
}

/// JSON being written: compact, or pretty, two spaces a level and `[]` or `{}` when empty.
pub struct Out {
    s: String,
    pretty: bool,
    depth: usize,
}

/// A value nook writes as JSON.
pub trait W {
    fn w(&self, o: &mut Out);
}

/// `v` as compact JSON.
pub fn to_string(v: &(impl W + ?Sized)) -> String {
    write(v, false)
}

/// `v` as JSON indented two spaces a level, with no newline at the end.
pub fn pretty(v: &(impl W + ?Sized)) -> String {
    write(v, true)
}

fn write(v: &(impl W + ?Sized), pretty: bool) -> String {
    let mut o = Out { s: String::with_capacity(128), pretty, depth: 0 };
    v.w(&mut o);
    o.s
}

impl Out {
    /// `items` between `open` and `close`, each on its own line when pretty; `each` writes one.
    fn list<T>(&mut self, open: char, close: char, items: impl IntoIterator<Item = T>, mut each: impl FnMut(&mut Out, T)) {
        self.s.push(open);
        self.depth += 1;
        let mut empty = true;
        for item in items {
            if !empty {
                self.s.push(',');
            }
            empty = false;
            self.line();
            each(self, item);
        }
        self.depth -= 1;
        if !empty {
            self.line();
        }
        self.s.push(close);
    }

    fn line(&mut self) {
        if self.pretty {
            self.s.push('\n');
            for _ in 0..self.depth {
                self.s.push_str("  ");
            }
        }
    }

    fn entry(&mut self, key: &str, v: &(impl W + ?Sized)) {
        key.w(self);
        self.s.push_str(if self.pretty { ": " } else { ":" });
        v.w(self);
    }
}

/// An object of `(key, value)` pairs, in order. `obj!` writes one.
pub struct Obj<'a>(pub &'a [(&'a str, &'a dyn W)]);

impl W for Obj<'_> {
    fn w(&self, o: &mut Out) {
        o.list('{', '}', self.0, |o, (k, v)| o.entry(k, *v));
    }
}

/// An object of `"key": value` pairs, written in the order given.
macro_rules! obj {
    ($($k:literal: $v:expr),* $(,)?) => {
        $crate::json::Obj(&[$(($k, &$v as &dyn $crate::json::W)),*])
    };
}
pub(crate) use obj;

/// Writes struct `T` as an object of the fields named, in order, each under its own name or the key given:
/// `object!(T { path, is_dir: "isDir" })`.
macro_rules! object {
    ($t:ty { $($f:ident $(: $k:literal)?),* $(,)? }) => {
        impl $crate::json::W for $t {
            fn w(&self, o: &mut $crate::json::Out) {
                $crate::json::Obj(&[$(($crate::json::object!(@key $f $($k)?), &self.$f as &dyn $crate::json::W)),*]).w(o);
            }
        }
    };
    (@key $f:ident) => { stringify!($f) };
    (@key $f:ident $k:literal) => { $k };
}
pub(crate) use object;

/// Text that is already JSON, written as it is.
pub struct Raw<'a>(pub &'a str);

impl W for Raw<'_> {
    fn w(&self, o: &mut Out) {
        o.s.push_str(self.0);
    }
}

impl W for J<'_> {
    fn w(&self, o: &mut Out) {
        match self {
            J::Null => o.s.push_str("null"),
            J::Bool(b) => b.w(o),
            J::Num(n) => o.s.push_str(n),
            J::Str(s) => s.w(o),
            J::Arr(a) => a.w(o),
            J::Obj(m) => o.list('{', '}', m, |o, (k, v)| o.entry(k, v)),
        }
    }
}

/// For each byte, the letter of its escape: 0 for none, `u` for `\u00xx`.
static ESCAPE: [u8; 256] = {
    let mut table = [0; 256];
    let mut b = 0;
    while b < 0x20 {
        table[b] = b'u';
        b += 1;
    }
    (table[0x08], table[0x0C], table[b'\n' as usize], table[b'\r' as usize], table[b'\t' as usize]) = (b'b', b'f', b'n', b'r', b't');
    (table[b'"' as usize], table[b'\\' as usize]) = (b'"', b'\\');
    table
};

impl W for str {
    /// Escapes `"`, `\`, and control characters, `\u00xx` in lowercase hex when they have no short form.
    fn w(&self, o: &mut Out) {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let s = &mut o.s;
        s.push('"');
        let mut from = 0;
        for (i, &b) in self.as_bytes().iter().enumerate() {
            let e = ESCAPE[b as usize];
            if e == 0 {
                continue;
            }
            s.push_str(&self[from..i]);
            s.extend(['\\', e as char]);
            if e == b'u' {
                s.extend(['0', '0', HEX[(b >> 4) as usize] as char, HEX[(b & 15) as usize] as char]);
            }
            from = i + 1;
        }
        s.push_str(&self[from..]);
        s.push('"');
    }
}

impl W for String {
    fn w(&self, o: &mut Out) {
        self.as_str().w(o);
    }
}

impl W for PathBuf {
    fn w(&self, o: &mut Out) {
        self.to_string_lossy().w(o);
    }
}

impl W for bool {
    fn w(&self, o: &mut Out) {
        o.s.push_str(if *self { "true" } else { "false" });
    }
}

macro_rules! integers {
    ($($t:ident)*) => {$(
        impl W for $t {
            fn w(&self, o: &mut Out) {
                let _ = write!(o.s, "{self}");
            }
        }
    )*};
}
integers!(u8 u16 u32 u64 u128 usize);

impl W for char {
    fn w(&self, o: &mut Out) {
        self.encode_utf8(&mut [0; 4]).w(o);
    }
}

impl W for () {
    fn w(&self, o: &mut Out) {
        o.s.push_str("null");
    }
}

impl<A: W, B: W, C: W, D: W, E: W> W for (A, B, C, D, E) {
    fn w(&self, o: &mut Out) {
        let (a, b, c, d, e) = self;
        o.list('[', ']', [a as &dyn W, b, c, d, e], |o, v| v.w(o));
    }
}

impl<T: W> W for Option<T> {
    fn w(&self, o: &mut Out) {
        match self {
            Some(v) => v.w(o),
            None => o.s.push_str("null"),
        }
    }
}

impl<T: W> W for [T] {
    fn w(&self, o: &mut Out) {
        o.list('[', ']', self, |o, v| v.w(o));
    }
}

impl<T: W> W for Vec<T> {
    fn w(&self, o: &mut Out) {
        self.as_slice().w(o);
    }
}

impl<T: W + ?Sized> W for &T {
    fn w(&self, o: &mut Out) {
        (**self).w(o);
    }
}
