//! Find for the search tab: literal text, or a regular expression in regex-lite's syntax with its error texts
//! and leftmost-first matches, run by a PikeVM in time linear in the text. Case folding, `\w`, `\d`, `\s` and
//! `\b` are ASCII only; `^` and `$` match at line ends, `\n` or `\r\n`. Also the search tab's file filter.

/// Groups nested deeper than this are refused.
const NEST: u32 = 50;
/// A pattern whose compiled form passes this many bytes, as regex-lite counts them, is refused.
const SIZE: usize = 1 << 23;
/// What regex-lite counts per state toward SIZE: the size of its `State`.
const STATE_COST: usize = 32;
/// A slot no group has set.
const NONE: usize = usize::MAX;

const ERR_TOO_MUCH_NESTING: &str = "pattern has too much nesting";
const ERR_CLASS_UNCLOSED_AFTER_DASH: &str = "non-empty character class has no closing bracket after dash";
const ERR_CLASS_UNCLOSED: &str = "found unclosed character class";

type R<T> = Result<T, &'static str>;

/// What the search tab looks for, built once per search and shared by its workers.
pub struct Finder(How);

enum How {
    /// An empty literal, which only ever matches empty.
    Never,
    /// Literal text, and whether it must stand as a whole word (`\b` at both ends).
    Lit(Needle, bool),
    Re(Box<Regex>),
}

impl Finder {
    /// `text` as a regular expression or as literal text, matching ASCII letters in either case unless `case`,
    /// and only as a whole word when `word`. The error is regex-lite's, which the search tab shows.
    pub fn new(text: &str, case: bool, word: bool, regex: bool) -> Result<Finder, String> {
        if !regex {
            if text.is_empty() {
                return Ok(Finder(How::Never));
            }
            let fold = |b: u8| if !case && b.is_ascii_alphabetic() { (b | 0x20, 0x20) } else { (b, 0) };
            return Ok(Finder(How::Lit(Needle::new(&text.bytes().map(fold).collect::<Vec<_>>()), word)));
        }
        let text = if word { format!(r"\b(?:{text})\b") } else { text.to_string() };
        let flags = Flags { i: !case, m: true, r: true, ..Flags::default() };
        Ok(Finder(Regex::compile(&text, flags).map_err(str::to_string)?))
    }

    /// The non-empty matches in `text`, as regex-lite's `captures_iter` finds them.
    pub fn matches<'a>(&'a self, text: &'a str) -> Matches<'a> {
        Matches { how: &self.0, h: text.as_bytes(), text, at: 0, last: None, c: Cache::default() }
    }
}

/// The matches of a Finder in one text, in order, as `(start, end)` byte offsets.
pub struct Matches<'a> {
    how: &'a How,
    h: &'a [u8],
    text: &'a str,
    at: usize,
    /// Where the last match, empty ones included, ended.
    last: Option<usize>,
    c: Cache,
}

impl Iterator for Matches<'_> {
    type Item = (usize, usize);

    fn next(&mut self) -> Option<(usize, usize)> {
        let how = self.how;
        match how {
            How::Never => None,
            How::Lit(needle, word) => loop {
                let s = needle.find(self.h, self.at)?;
                let e = s + needle.bytes.len();
                if *word && !(Look::Word.is_match(self.h, s) && Look::Word.is_match(self.h, e)) {
                    self.at = s + 1;
                    continue;
                }
                self.at = e;
                return Some((s, e));
            },
            How::Re(re) => loop {
                // An empty match where the last match ended is tried again a character on.
                let (mut s, mut e) = self.search(re, self.at)?;
                if s >= e && Some(e) == self.last {
                    self.at += decode(self.h, self.at).1.max(1);
                    (s, e) = self.search(re, self.at)?;
                }
                self.at = e;
                self.last = Some(e);
                if s < e {
                    return Some((s, e));
                }
            },
        }
    }
}

impl Matches<'_> {
    fn search(&mut self, re: &Regex, at: usize) -> Option<(usize, usize)> {
        let end = re.run(&mut self.c, self.h, at, self.h.len(), false, 1)?;
        Some((self.c.found[0], end))
    }

    /// `with` for the match at `start..end`, with `$1`, `${name}` and the like filled in from its groups.
    pub fn expand(&mut self, start: usize, end: usize, with: &str) -> String {
        match self.how {
            How::Re(re) if with.contains('$') => {
                re.run(&mut self.c, self.h, start, end, true, 2 * re.groups);
                interpolate(with, self.text, &self.c.found, &re.names)
            }
            _ => interpolate(with, self.text, &[start, end], &[]),
        }
    }
}

/// `with` with each `$ref` replaced by the group it names, as regex-lite's `Captures::expand`: `$$` is `$`,
/// `$name` takes the longest run of `[0-9A-Za-z_]`, `${name}` anything up to `}`, all digits name a group by
/// number, and a group that didn't match, or doesn't exist, is empty.
fn interpolate(with: &str, text: &str, slots: &[usize], names: &[(String, usize)]) -> String {
    let mut out = String::new();
    let mut rep = with;
    while let Some(i) = rep.find('$') {
        out.push_str(&rep[..i]);
        rep = &rep[i..];
        let b = rep.as_bytes();
        if b.get(1) == Some(&b'$') {
            out.push('$');
            rep = &rep[2..];
            continue;
        }
        let name = if b.get(1) == Some(&b'{') {
            b[2..].iter().position(|&c| c == b'}').map(|n| (&rep[2..2 + n], 3 + n))
        } else {
            let n = b[1..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'_').count();
            (n > 0).then(|| (&rep[1..1 + n], 1 + n))
        };
        let Some((name, len)) = name else {
            out.push('$');
            rep = &rep[1..];
            continue;
        };
        rep = &rep[len..];
        let group = name.parse::<usize>().ok().or_else(|| names.iter().find(|n| n.0 == name).map(|n| n.1));
        let span = group.and_then(|g| Some((*slots.get(g.checked_mul(2)?)?, *slots.get(2 * g + 1)?)));
        if let Some((s, e)) = span.filter(|&(s, e)| s != NONE && e != NONE) {
            out.push_str(&text[s..e]);
        }
    }
    out.push_str(rep);
    out
}

/// How common a byte is in source text, from 0 (rare) to 3: a needle is looked for by its two rarest bytes.
const COMMON: [u8; 256] = {
    let mut t = [0; 256];
    let mut i = 0;
    while i < 256 {
        t[i] = match i as u8 {
            b' ' | b'e' | b't' | b'a' | b'o' | b'i' | b'n' | b's' | b'r' => 3,
            b'a'..=b'z' | b'\n' | b'\t' | b'.' | b'(' | b')' | b',' | b';' | b'=' | b'"' | b'_' | b'/' => 2,
            b'0'..=b'9' | b'A'..=b'Z' | b'\r' | b'{' | b'}' | b'\'' | b':' | b'-' => 1,
            _ => 0,
        };
        i += 1;
    }
    t
};

/// A literal to look for: a text byte matches `bytes[i]` once `masks[i]` is ORed into it, so 0x20 matches an
/// ASCII letter in either case.
struct Needle {
    bytes: Vec<u8>,
    masks: Vec<u8>,
    /// The two rarest positions, which a candidate is checked at first.
    rare: (usize, usize),
}

impl Needle {
    fn new(lit: &[(u8, u8)]) -> Needle {
        let mut order: Vec<usize> = (0..lit.len()).collect();
        order.sort_by_key(|&i| COMMON[lit[i].0 as usize]);
        let (a, b) = (order[0], *order.get(1).unwrap_or(&order[0]));
        Needle { bytes: lit.iter().map(|l| l.0).collect(), masks: lit.iter().map(|l| l.1).collect(), rare: (a.min(b), a.max(b)) }
    }

    fn is_at(&self, h: &[u8], p: usize) -> bool {
        h[p..p + self.bytes.len()].iter().zip(&self.bytes).zip(&self.masks).all(|((&c, &v), &m)| c | m == v)
    }

    /// Where the needle first occurs in `h` at or after `from`.
    fn find(&self, h: &[u8], from: usize) -> Option<usize> {
        let last = h.len().checked_sub(self.bytes.len())?;
        let (i, j) = self.rare;
        let (vi, mi, vj, mj) = (self.bytes[i], self.masks[i], self.bytes[j], self.masks[j]);
        let mut p = from;
        // Sixteen candidates at a time: both rare bytes compared at once, then each hit checked in full.
        #[cfg(target_arch = "x86_64")]
        unsafe {
            use std::arch::x86_64::*;
            let (vi8, mi8, vj8, mj8) = (_mm_set1_epi8(vi as i8), _mm_set1_epi8(mi as i8), _mm_set1_epi8(vj as i8), _mm_set1_epi8(mj as i8));
            while p + 16 <= last + 1 {
                let a = _mm_loadu_si128(h.as_ptr().add(p + i) as *const __m128i);
                let b = _mm_loadu_si128(h.as_ptr().add(p + j) as *const __m128i);
                let hit = _mm_and_si128(_mm_cmpeq_epi8(_mm_or_si128(a, mi8), vi8), _mm_cmpeq_epi8(_mm_or_si128(b, mj8), vj8));
                let mut bits = _mm_movemask_epi8(hit) as u32;
                while bits != 0 {
                    let q = p + bits.trailing_zeros() as usize;
                    if self.is_at(h, q) {
                        return Some(q);
                    }
                    bits &= bits - 1;
                }
                p += 16;
            }
        }
        while p <= last {
            if h[p + i] | mi == vi && h[p + j] | mj == vj && self.is_at(h, p) {
                return Some(p);
            }
            p += 1;
        }
        None
    }
}

/// The character at `at` in valid UTF-8 and its length, or a length of 0 at the end.
fn decode(h: &[u8], at: usize) -> (u32, usize) {
    let c = |k: usize| h[at + k] as u32 & 0x3F;
    match h.get(at) {
        None => (0xFFFD, 0),
        Some(&b) if b < 0x80 => (b as u32, 1),
        Some(&b) if b < 0xE0 => ((b as u32 & 0x1F) << 6 | c(1), 2),
        Some(&b) if b < 0xF0 => ((b as u32 & 0x0F) << 12 | c(1) << 6 | c(2), 3),
        Some(&b) => ((b as u32 & 0x07) << 18 | c(1) << 12 | c(2) << 6 | c(3), 4),
    }
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

#[derive(Clone, Copy, PartialEq)]
enum Look {
    Start,
    End,
    StartLF,
    EndLF,
    StartCRLF,
    EndCRLF,
    Word,
    WordNegate,
    WordStart,
    WordEnd,
    WordStartHalf,
    WordEndHalf,
}

impl Look {
    fn is_match(self, h: &[u8], at: usize) -> bool {
        let before = at > 0 && is_word(h[at - 1]);
        let after = at < h.len() && is_word(h[at]);
        match self {
            Look::Start => at == 0,
            Look::End => at == h.len(),
            Look::StartLF => at == 0 || h[at - 1] == b'\n',
            Look::EndLF => at == h.len() || h[at] == b'\n',
            Look::StartCRLF => at == 0 || h[at - 1] == b'\n' || (h[at - 1] == b'\r' && (at >= h.len() || h[at] != b'\n')),
            Look::EndCRLF => at == h.len() || h[at] == b'\r' || (h[at] == b'\n' && (at == 0 || h[at - 1] != b'\r')),
            Look::Word => before != after,
            Look::WordNegate => before == after,
            Look::WordStart => !before && after,
            Look::WordEnd => before && !after,
            Look::WordStartHalf => !before,
            Look::WordEndHalf => !after,
        }
    }
}

// The pattern's tree, as regex-lite's parser builds it.

/// Sorted, merged ranges of codepoints.
type Ranges = Vec<(u32, u32)>;

enum Node {
    Empty,
    Char(char),
    Class(Ranges),
    Look(Look),
    /// min, max, greedy.
    Rep(u32, Option<u32>, bool, Box<Hir>),
    /// The group's index, what its name costs toward SIZE, and what it holds.
    Cap(u32, usize, Box<Hir>),
    Concat(Vec<Hir>),
    Alt(Vec<Hir>),
    /// Something nested past NEST: an error, unless a `{0}` drops it.
    Deep,
}

struct Hir {
    node: Node,
    /// Can match the empty string.
    empty: bool,
    /// How deep its nodes nest.
    height: u32,
}

impl Hir {
    fn leaf(node: Node, empty: bool) -> Hir {
        Hir { node, empty, height: 0 }
    }

    fn parent(node: Node, below: u32, empty: bool) -> Hir {
        match below + 1 {
            h if h > NEST => Hir { node: Node::Deep, empty, height: NEST + 1 },
            height => Hir { node, empty, height },
        }
    }

    fn empty() -> Hir {
        Hir::leaf(Node::Empty, true)
    }

    fn char(c: char) -> Hir {
        Hir::leaf(Node::Char(c), false)
    }

    fn class(mut r: Ranges) -> Hir {
        canon(&mut r);
        Hir::leaf(Node::Class(r), false)
    }

    fn look(l: Look) -> Hir {
        Hir::leaf(Node::Look(l), true)
    }

    fn rep(min: u32, max: Option<u32>, greedy: bool, sub: Hir) -> Hir {
        match (min, max) {
            (0, Some(0)) => Hir::empty(),
            (1, Some(1)) => sub,
            _ => {
                let (h, empty) = (sub.height, min == 0 || sub.empty);
                Hir::parent(Node::Rep(min, max, greedy, Box::new(sub)), h, empty)
            }
        }
    }

    fn cap(index: u32, name: usize, sub: Hir) -> Hir {
        let (h, empty) = (sub.height, sub.empty);
        Hir::parent(Node::Cap(index, name, Box::new(sub)), h, empty)
    }

    fn concat(mut subs: Vec<Hir>) -> Hir {
        match subs.len() {
            0 => Hir::empty(),
            1 => subs.pop().unwrap(),
            _ => {
                let (h, empty) = (subs.iter().map(|s| s.height).max().unwrap(), subs.iter().all(|s| s.empty));
                Hir::parent(Node::Concat(subs), h, empty)
            }
        }
    }

    fn alt(mut subs: Vec<Hir>) -> Hir {
        match subs.len() {
            1 => subs.pop().unwrap(),
            _ => {
                let (h, empty) = (subs.iter().map(|s| s.height).max().unwrap(), subs.iter().any(|s| s.empty));
                Hir::parent(Node::Alt(subs), h, empty)
            }
        }
    }
}

fn canon(r: &mut Ranges) {
    r.sort_unstable();
    let mut out: Ranges = Vec::with_capacity(r.len());
    for &(s, e) in r.iter() {
        match out.last_mut() {
            Some(last) if s.max(last.0) <= e.min(last.1).saturating_add(1) => *last = (s.min(last.0), e.max(last.1)),
            _ => out.push((s, e)),
        }
    }
    *r = out;
}

/// The other case of the ASCII letters in `(s, e)`: of the lowercase ones if it has any, else the uppercase.
fn fold_range((s, e): (u32, u32)) -> Option<(u32, u32)> {
    let (a, z) = (s.max('a' as u32), e.min('z' as u32));
    if a <= z {
        return Some((a - 32, z - 32));
    }
    let (a, z) = (s.max('A' as u32), e.min('Z' as u32));
    (a <= z).then_some((a + 32, z + 32))
}

fn fold(r: &mut Ranges) {
    for i in 0..r.len() {
        if let Some(f) = fold_range(r[i]) {
            r.push(f);
        }
    }
    canon(r);
}

/// Every codepoint `r` leaves out, stepping over the surrogates as regex-lite does.
fn negate(r: &mut Ranges) {
    let next = |c: u32| if c == 0xD7FF { 0xE000 } else { c + 1 };
    let prev = |c: u32| if c == 0xE000 { 0xD7FF } else { c - 1 };
    let mut out = Vec::new();
    match (r.first(), r.last()) {
        (Some(&(first, _)), Some(&(_, last))) => {
            if first > 0 {
                out.push((0, prev(first)));
            }
            out.extend(r.windows(2).map(|w| (next(w[0].1), prev(w[1].0))));
            if last < 0x10FFFF {
                out.push((next(last), 0x10FFFF));
            }
        }
        _ => out.push((0, 0x10FFFF)),
    }
    *r = out;
}

fn posix(name: &str) -> Option<Ranges> {
    let r: &[(u8, u8)] = match name {
        "alnum" => &[(b'0', b'9'), (b'A', b'Z'), (b'a', b'z')],
        "alpha" => &[(b'A', b'Z'), (b'a', b'z')],
        "ascii" => &[(0, 0x7F)],
        "blank" => &[(b'\t', b'\t'), (b' ', b' ')],
        "cntrl" => &[(0, 0x1F), (0x7F, 0x7F)],
        "digit" => &[(b'0', b'9')],
        "graph" => &[(b'!', b'~')],
        "lower" => &[(b'a', b'z')],
        "print" => &[(b' ', b'~')],
        "punct" => &[(b'!', b'/'), (b':', b'@'), (b'[', b'`'), (b'{', b'~')],
        "space" => &[(b'\t', b'\r'), (b' ', b' ')],
        "upper" => &[(b'A', b'Z')],
        "word" => &[(b'0', b'9'), (b'A', b'Z'), (b'_', b'_'), (b'a', b'z')],
        "xdigit" => &[(b'0', b'9'), (b'A', b'F'), (b'a', b'f')],
        _ => return None,
    };
    let mut r = r.iter().map(|&(s, e)| (s as u32, e as u32)).collect();
    canon(&mut r);
    Some(r)
}

#[derive(Clone, Copy, Default)]
struct Flags {
    i: bool,
    m: bool,
    s: bool,
    /// Swap greed.
    u: bool,
    /// CRLF line ends.
    r: bool,
    x: bool,
}

/// A port of regex-lite's parser, check for check, so a pattern fails with the same error.
struct Parser<'a> {
    pat: &'a str,
    pos: usize,
    flags: Flags,
    depth: u32,
    caps: u32,
    names: Vec<(String, usize)>,
}

impl Parser<'_> {
    fn done(&self) -> bool {
        self.pos == self.pat.len()
    }

    fn ch(&self) -> char {
        self.pat[self.pos..].chars().next().expect("a character")
    }

    fn cur(&self) -> Option<char> {
        self.pat[self.pos..].chars().next()
    }

    fn bump(&mut self) -> bool {
        if self.done() {
            return false;
        }
        self.pos += self.ch().len_utf8();
        !self.done()
    }

    fn bump_if(&mut self, s: &str) -> bool {
        let yes = self.pat[self.pos..].starts_with(s);
        if yes {
            self.pos += s.len();
        }
        yes
    }

    fn bump_space(&mut self) -> bool {
        if !self.bump() {
            return false;
        }
        self.space();
        !self.done()
    }

    /// Skips whitespace and `#` comments under `(?x)`.
    fn space(&mut self) {
        while self.flags.x && !self.done() {
            if self.ch().is_whitespace() {
                self.bump();
            } else if self.ch() == '#' {
                while self.cur().is_some() {
                    let c = self.ch();
                    self.bump();
                    if c == '\n' {
                        break;
                    }
                }
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<char> {
        let c = self.cur()?;
        self.pat[self.pos + c.len_utf8()..].chars().next()
    }

    fn peek_space(&self) -> Option<char> {
        if !self.flags.x {
            return self.peek();
        }
        let mut start = self.pos + self.cur()?.len_utf8();
        let mut comment = false;
        for (i, c) in self.pat[start..].char_indices() {
            if c.is_whitespace() {
                continue;
            } else if !comment && c == '#' {
                comment = true;
            } else {
                start += i;
                break;
            }
        }
        self.pat[start..].chars().next()
    }

    fn parse(&mut self) -> R<Hir> {
        if self.depth > NEST {
            return Err(ERR_TOO_MUCH_NESTING);
        }
        let top = self.depth == 0;
        self.depth += 1;
        let mut alts = Vec::new();
        let mut concat = Vec::new();
        loop {
            self.space();
            let Some(c) = self.cur() else { break };
            match c {
                '(' => {
                    let flags = self.flags;
                    if let Some(sub) = self.group()? {
                        concat.push(sub);
                        self.flags = flags;
                    }
                    if self.cur() != Some(')') {
                        return Err("found open group without closing ')'");
                    }
                    self.bump();
                }
                ')' if top => return Err("found closing ')' without matching '('"),
                ')' => break,
                '|' => {
                    alts.push(Hir::concat(std::mem::take(&mut concat)));
                    self.bump();
                }
                '[' => concat.push(self.class()?),
                '?' | '*' | '+' => {
                    let sub = concat.pop().ok_or("uncounted repetition operator must be applied to a sub-expression")?;
                    let (min, max) = match c {
                        '?' => (0, Some(1)),
                        '*' => (0, None),
                        _ => (1, None),
                    };
                    let mut greedy = true;
                    if self.bump() && self.ch() == '?' {
                        greedy = false;
                        self.bump();
                    }
                    concat.push(Hir::rep(min, max, greedy != self.flags.u, sub));
                }
                '{' => {
                    let sub = concat.pop().ok_or("counted repetition operator must be applied to a sub-expression")?;
                    concat.push(self.counted(sub)?);
                }
                _ => concat.push(self.primitive()?),
            }
        }
        self.depth -= 1;
        alts.push(Hir::concat(concat));
        Ok(Hir::alt(alts))
    }

    fn counted(&mut self, sub: Hir) -> R<Hir> {
        if !self.bump_space() {
            return Err("found unclosed counted repetition operator");
        }
        let min = self.decimal()?;
        let mut max = Some(min);
        if self.done() {
            return Err("found incomplete and unclosed counted repetition operator");
        }
        if self.ch() == ',' {
            if !self.bump_space() {
                return Err("found counted repetition operator with a comma that is unclosed");
            }
            max = if self.ch() != '}' { Some(self.decimal()?) } else { None };
            if self.done() {
                return Err("found counted repetition with min and max that is unclosed");
            }
        }
        if self.ch() != '}' {
            return Err("expected closing brace for counted repetition, but got something else");
        }
        let mut greedy = true;
        if self.bump_space() && self.ch() == '?' {
            greedy = false;
            self.bump();
        }
        if max.is_some_and(|max| min > max) {
            return Err("found counted repetition with a min bigger than its max");
        }
        Ok(Hir::rep(min, max, greedy != self.flags.u, sub))
    }

    fn decimal(&mut self) -> R<u32> {
        while self.cur().is_some_and(char::is_whitespace) {
            self.bump();
        }
        let mut digits = String::new();
        while let Some(c @ '0'..='9') = self.cur() {
            digits.push(c);
            self.bump_space();
        }
        while self.cur().is_some_and(char::is_whitespace) {
            self.bump_space();
        }
        if digits.is_empty() {
            return Err("expected decimal number, but found no digits");
        }
        digits.parse().map_err(|_| "got invalid decimal number")
    }

    /// A group after its `(`, or None for a flag directive such as `(?i)`.
    fn group(&mut self) -> R<Option<Hir>> {
        self.bump_space();
        if self.bump_if("?=") || self.bump_if("?!") || self.bump_if("?<=") || self.bump_if("?<!") {
            return Err("look-around is not supported");
        }
        if self.bump_if("?P<") || self.bump_if("?<") {
            self.caps += 1;
            let index = self.caps;
            let name = self.capture_name()?;
            let cost = name.len() + 4;
            self.names.push((name, index as usize));
            return Ok(Some(Hir::cap(index, cost, self.parse()?)));
        }
        if self.bump_if("?") {
            if self.done() {
                return Err("expected closing ')', but got end of pattern");
            }
            let start = self.pos;
            self.flags = self.inline_flags()?;
            if self.ch() == ')' {
                return if self.pos == start { Err("empty flag directive '(?)' is not allowed") } else { Ok(None) };
            }
            self.bump();
            return self.parse().map(Some);
        }
        self.caps += 1;
        let index = self.caps;
        Ok(Some(Hir::cap(index, 0, self.parse()?)))
    }

    fn capture_name(&mut self) -> R<String> {
        if self.done() {
            return Err("expected capture group name, but got end of pattern");
        }
        let start = self.pos;
        loop {
            let c = self.ch();
            if c == '>' {
                break;
            }
            let ok = if self.pos == start { c == '_' || c.is_alphabetic() } else { c == '_' || c == '.' || c == '[' || c == ']' || c.is_alphanumeric() };
            if !ok {
                return Err("invalid group name");
            }
            if !self.bump() {
                break;
            }
        }
        let end = self.pos;
        if self.done() {
            return Err("expected end of capture group name, but got end of pattern");
        }
        self.bump();
        let name = &self.pat[start..end];
        if name.is_empty() {
            return Err("empty capture group names are not allowed");
        }
        if self.names.iter().any(|n| n.0 == name) {
            return Err("duplicate capture group name");
        }
        Ok(name.to_string())
    }

    fn inline_flags(&mut self) -> R<Flags> {
        let mut flags = self.flags;
        let (mut negate, mut dangling) = (false, false);
        let mut seen = [false; 128];
        while self.ch() != ':' && self.ch() != ')' {
            dangling = self.ch() == '-';
            if dangling {
                if negate {
                    return Err("inline flag negation cannot be repeated");
                }
                negate = true;
            } else {
                let c = self.ch();
                match c {
                    'i' => flags.i = !negate,
                    'm' => flags.m = !negate,
                    's' => flags.s = !negate,
                    'U' => flags.u = !negate,
                    'R' => flags.r = !negate,
                    'x' => flags.x = !negate,
                    'u' => {}
                    _ => return Err("unrecognized inline flag"),
                }
                if std::mem::replace(&mut seen[c as usize], true) {
                    return Err("duplicate inline flag is not allowed");
                }
            }
            if !self.bump() {
                return Err("expected ':' or ')' to end inline flags, but got end of pattern");
            }
        }
        if dangling {
            return Err("inline flags cannot end with negation directive");
        }
        Ok(flags)
    }

    fn primitive(&mut self) -> R<Hir> {
        let c = self.ch();
        self.bump();
        Ok(match c {
            '\\' => return self.escape(),
            '.' if self.flags.s => Hir::class(vec![(0, 0x10FFFF)]),
            '.' if self.flags.r => Hir::class(vec![(0, 9), (0xB, 0xC), (0xE, 0x10FFFF)]),
            '.' => Hir::class(vec![(0, 9), (0xB, 0x10FFFF)]),
            '^' => Hir::look(match (self.flags.m, self.flags.r) {
                (false, _) => Look::Start,
                (true, false) => Look::StartLF,
                (true, true) => Look::StartCRLF,
            }),
            '$' => Hir::look(match (self.flags.m, self.flags.r) {
                (false, _) => Look::End,
                (true, false) => Look::EndLF,
                (true, true) => Look::EndCRLF,
            }),
            c => self.char(c),
        })
    }

    /// A literal character, as a class of both cases under `(?i)`.
    fn char(&self, c: char) -> Hir {
        match fold_range((c as u32, c as u32)) {
            Some(f) if self.flags.i => Hir::class(vec![(c as u32, c as u32), f]),
            _ => Hir::char(c),
        }
    }

    /// What follows a `\`.
    fn escape(&mut self) -> R<Hir> {
        let c = self.cur().ok_or("saw start of escape sequence, but saw end of pattern before it finished")?;
        match c {
            '0'..='9' => return Err("backreferences are not supported"),
            'p' | 'P' => return Err("Unicode character classes are not supported"),
            'x' | 'u' | 'U' => return self.hex(),
            'd' | 's' | 'w' | 'D' | 'S' | 'W' => {
                self.bump();
                let mut r = posix(match c.to_ascii_lowercase() {
                    'd' => "digit",
                    's' => "space",
                    _ => "word",
                })
                .unwrap();
                if c.is_ascii_uppercase() {
                    negate(&mut r);
                }
                return Ok(Hir::class(r));
            }
            _ => {}
        }
        self.bump();
        let meta = matches!(c, '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$' | '#' | '&' | '-' | '~');
        if meta || (c.is_ascii() && !c.is_ascii_alphanumeric() && c != '<' && c != '>') {
            return Ok(self.char(c));
        }
        Ok(match c {
            'a' => self.char('\x07'),
            'f' => self.char('\x0C'),
            't' => self.char('\t'),
            'n' => self.char('\n'),
            'r' => self.char('\r'),
            'v' => self.char('\x0B'),
            'A' => Hir::look(Look::Start),
            'z' => Hir::look(Look::End),
            'b' if self.cur() == Some('{') => Hir::look(self.special_word()?.unwrap_or(Look::Word)),
            'b' => Hir::look(Look::Word),
            'B' => Hir::look(Look::WordNegate),
            '<' => Hir::look(Look::WordStart),
            '>' => Hir::look(Look::WordEnd),
            _ => return Err("unrecognized escape sequence"),
        })
    }

    /// `\b{start}` and its kin, or None to leave the `{` to a counted repetition.
    fn special_word(&mut self) -> R<Option<Look>> {
        let start = self.pos;
        if !self.bump_space() {
            return Err("found start of special word boundary or repetition without an end");
        }
        let valid = |c: char| c.is_ascii_alphabetic() || c == '-';
        if !valid(self.ch()) {
            self.pos = start;
            return Ok(None);
        }
        let mut name = String::new();
        while let Some(c) = self.cur().filter(|&c| valid(c)) {
            name.push(c);
            self.bump_space();
        }
        if self.cur() != Some('}') {
            return Err("special word boundary assertion is unclosed or has an invalid character");
        }
        self.bump();
        Ok(Some(match name.as_str() {
            "start" => Look::WordStart,
            "end" => Look::WordEnd,
            "start-half" => Look::WordStartHalf,
            "end-half" => Look::WordEndHalf,
            _ => return Err("special word boundary assertion is unrecognized"),
        }))
    }

    fn hex(&mut self) -> R<Hir> {
        let len = match self.ch() {
            'x' => 2,
            'u' => 4,
            _ => 8,
        };
        if !self.bump_space() {
            return Err("expected hexadecimal number, but saw end of pattern first");
        }
        let mut digits = String::new();
        let (bad, c) = if self.ch() == '{' {
            while self.bump_space() && self.ch() != '}' {
                if !self.ch().is_ascii_hexdigit() {
                    return Err("expected hexadecimal number in braces, but got non-hex digit");
                }
                digits.push(self.ch());
            }
            if self.done() {
                return Err("expected hexadecimal number, but saw end of pattern before closing brace");
            }
            self.bump_space();
            if digits.is_empty() {
                return Err("expected hexadecimal number in braces, but got no digits");
            }
            ("got invalid hexadecimal number in braces", u32::from_str_radix(&digits, 16))
        } else {
            for i in 0..len {
                if i > 0 && !self.bump_space() {
                    return Err("expected fixed length hexadecimal number, but saw end of pattern first");
                }
                if !self.ch().is_ascii_hexdigit() {
                    return Err("expected fixed length hexadecimal number, but got non-hex digit");
                }
                digits.push(self.ch());
            }
            self.bump_space();
            ("got invalid fixed length hexadecimal number", u32::from_str_radix(&digits, 16))
        };
        c.ok().and_then(char::from_u32).map(|c| self.char(c)).ok_or(bad)
    }

    /// A bracketed class, from its `[`.
    fn class(&mut self) -> R<Hir> {
        let mut union = Vec::new();
        if !self.bump_space() {
            return Err(ERR_CLASS_UNCLOSED);
        }
        let negated = self.ch() == '^';
        if negated && !self.bump_space() {
            return Err("negated character class has no closing bracket");
        }
        while self.ch() == '-' {
            union.push(('-' as u32, '-' as u32));
            if !self.bump_space() {
                return Err(ERR_CLASS_UNCLOSED_AFTER_DASH);
            }
        }
        if union.is_empty() && self.ch() == ']' {
            union.push((']' as u32, ']' as u32));
            if !self.bump_space() {
                return Err("character class begins with literal ']' but has no closing bracket");
            }
        }
        loop {
            self.space();
            let c = self.cur().ok_or(ERR_CLASS_UNCLOSED)?;
            match c {
                '[' => match self.posix_class() {
                    Some(r) => union.extend(r),
                    None => return Err("nested character classes are not supported"),
                },
                ']' => {
                    self.bump();
                    canon(&mut union);
                    if self.flags.i {
                        fold(&mut union);
                    }
                    if negated {
                        negate(&mut union);
                    }
                    return Ok(Hir::class(union));
                }
                '&' if self.peek() == Some('&') => return Err("character class intersection is not supported"),
                '-' if self.peek() == Some('-') => return Err("character class difference is not supported"),
                '~' if self.peek() == Some('~') => return Err("character class symmetric difference is not supported"),
                _ => self.class_range(&mut union)?,
            }
        }
    }

    fn class_range(&mut self, union: &mut Ranges) -> R<()> {
        let first = self.class_item()?;
        self.space();
        if self.done() {
            return Err("non-empty character class has no closing bracket");
        }
        if self.ch() != '-' || matches!(self.peek_space(), Some(']' | '-')) {
            match first.node {
                Node::Char(c) => union.push((c as u32, c as u32)),
                Node::Class(r) => union.extend(r),
                _ => return Err("invalid escape sequence in character class"),
            }
            return Ok(());
        }
        if !self.bump_space() {
            return Err(ERR_CLASS_UNCLOSED_AFTER_DASH);
        }
        let last = self.class_item()?;
        let (Node::Char(s), Node::Char(e)) = (first.node, last.node) else { return Err("character class ranges must start and end with a single character") };
        if s > e {
            return Err("invalid range in character class");
        }
        union.push((s as u32, e as u32));
        Ok(())
    }

    fn class_item(&mut self) -> R<Hir> {
        let c = self.ch();
        self.bump();
        if c == '\\' {
            self.escape()
        } else {
            Ok(Hir::char(c))
        }
    }

    /// `[:name:]` or `[:^name:]` inside a class, or None with the parser back at its `[`.
    fn posix_class(&mut self) -> Option<Ranges> {
        let start = self.pos;
        let r = (|| {
            if !self.bump() || self.ch() != ':' || !self.bump() {
                return None;
            }
            let negated = self.ch() == '^';
            if negated && !self.bump() {
                return None;
            }
            let name_start = self.pos;
            while self.ch() != ':' && self.bump() {}
            if self.done() {
                return None;
            }
            let name = &self.pat[name_start..self.pos];
            if !self.bump_if(":]") {
                return None;
            }
            let mut r = posix(name)?;
            if negated {
                negate(&mut r);
            }
            Some(r)
        })();
        if r.is_none() {
            self.pos = start;
        }
        r
    }
}

// The pattern compiled to a Thompson NFA, state for state as regex-lite compiles it, so threads keep its
// priorities and a pattern too big for it is too big here.

enum Inst {
    /// The character, and where a thread goes on it.
    Char(u32, u32),
    /// The class's index, and where a thread goes on one of its characters.
    Class(u32, u32),
    /// Targets in priority order, last first when reversed.
    Split(Vec<u32>, bool),
    Goto(u32),
    Look(Look, u32),
    Save(u32, u32),
    Fail,
    Match,
}

struct Compiler {
    insts: Vec<Inst>,
    classes: Vec<Class>,
    groups: usize,
    /// regex-lite's count of bytes beyond the states themselves.
    extra: usize,
}

impl Compiler {
    fn add(&mut self, i: Inst) -> R<u32> {
        if let Inst::Class(k, _) = i {
            self.extra += self.classes[k as usize].ranges.len() * 8;
        }
        self.insts.push(i);
        self.check()?;
        Ok(self.insts.len() as u32 - 1)
    }

    fn check(&self) -> R<()> {
        match self.insts.len() * STATE_COST + self.groups * 16 + self.extra > SIZE {
            true => Err("compiled regex exceeded size limit"),
            false => Ok(()),
        }
    }

    fn patch(&mut self, from: u32, to: u32) -> R<()> {
        match &mut self.insts[from as usize] {
            Inst::Char(_, t) | Inst::Class(_, t) | Inst::Goto(t) | Inst::Look(_, t) | Inst::Save(_, t) => *t = to,
            Inst::Split(ts, _) => {
                ts.push(to);
                self.extra += 4;
                self.check()?;
            }
            Inst::Fail | Inst::Match => {}
        }
        Ok(())
    }

    fn one(&mut self, i: Inst) -> R<(u32, u32)> {
        let id = self.add(i)?;
        Ok((id, id))
    }

    fn empty(&mut self) -> R<u32> {
        self.add(Inst::Goto(0))
    }

    fn splits(&mut self, greedy: bool) -> R<u32> {
        self.add(Inst::Split(Vec::new(), !greedy))
    }

    fn c(&mut self, h: &Hir) -> R<(u32, u32)> {
        match &h.node {
            Node::Empty => self.one(Inst::Goto(0)),
            Node::Char(c) => self.one(Inst::Char(*c as u32, 0)),
            Node::Class(r) if r.is_empty() => self.one(Inst::Fail),
            Node::Class(r) => {
                self.classes.push(Class::new(r.clone()));
                self.one(Inst::Class(self.classes.len() as u32 - 1, 0))
            }
            Node::Look(l) => self.one(Inst::Look(*l, 0)),
            Node::Rep(0, Some(1), greedy, sub) => {
                let splits = self.splits(*greedy)?;
                let (s, e) = self.c(sub)?;
                let empty = self.empty()?;
                self.patch(splits, s)?;
                self.patch(splits, empty)?;
                self.patch(e, empty)?;
                Ok((splits, empty))
            }
            Node::Rep(0, None, greedy, sub) if !sub.empty => {
                let splits = self.splits(*greedy)?;
                let (s, e) = self.c(sub)?;
                self.patch(splits, s)?;
                self.patch(e, splits)?;
                Ok((splits, splits))
            }
            Node::Rep(0, None, greedy, sub) => {
                let (s, e) = self.c(sub)?;
                let plus = self.splits(*greedy)?;
                self.patch(e, plus)?;
                self.patch(plus, s)?;
                let question = self.splits(*greedy)?;
                let empty = self.empty()?;
                self.patch(question, s)?;
                self.patch(question, empty)?;
                self.patch(plus, empty)?;
                Ok((question, empty))
            }
            Node::Rep(1, None, greedy, sub) => {
                let (s, e) = self.c(sub)?;
                let splits = self.splits(*greedy)?;
                self.patch(e, splits)?;
                self.patch(splits, s)?;
                Ok((s, splits))
            }
            Node::Rep(n, None, greedy, sub) => {
                let (start, end) = self.c_seq(std::iter::repeat_n(&**sub, *n as usize - 1))?;
                let (s, e) = self.c(sub)?;
                let splits = self.splits(*greedy)?;
                self.patch(end, s)?;
                self.patch(e, splits)?;
                self.patch(splits, s)?;
                Ok((start, splits))
            }
            Node::Rep(min, Some(max), _, sub) if min == max => self.c_seq(std::iter::repeat_n(&**sub, *min as usize)),
            Node::Rep(min, Some(max), greedy, sub) => {
                let (start, mut end) = self.c_seq(std::iter::repeat_n(&**sub, *min as usize))?;
                let empty = self.empty()?;
                for _ in *min..*max {
                    let splits = self.splits(*greedy)?;
                    let (s, e) = self.c(sub)?;
                    self.patch(end, splits)?;
                    self.patch(splits, s)?;
                    self.patch(splits, empty)?;
                    end = e;
                }
                self.patch(end, empty)?;
                Ok((start, empty))
            }
            Node::Cap(index, name, sub) => self.c_cap(*index, *name, sub),
            Node::Concat(subs) => self.c_seq(subs.iter()),
            Node::Alt(subs) => {
                let first = self.c(&subs[0])?;
                let second = self.c(&subs[1])?;
                let splits = self.splits(true)?;
                let end = self.empty()?;
                self.patch(splits, first.0)?;
                self.patch(first.1, end)?;
                self.patch(splits, second.0)?;
                self.patch(second.1, end)?;
                for sub in &subs[2..] {
                    let (s, e) = self.c(sub)?;
                    self.patch(splits, s)?;
                    self.patch(e, end)?;
                }
                Ok((splits, end))
            }
            Node::Deep => self.one(Inst::Fail),
        }
    }

    fn c_seq<'h>(&mut self, mut subs: impl Iterator<Item = &'h Hir>) -> R<(u32, u32)> {
        let Some(first) = subs.next() else { return self.one(Inst::Goto(0)) };
        let (start, mut end) = self.c(first)?;
        for sub in subs {
            let (s, e) = self.c(sub)?;
            self.patch(end, s)?;
            end = e;
        }
        Ok((start, end))
    }

    fn c_cap(&mut self, index: u32, name: usize, sub: &Hir) -> R<(u32, u32)> {
        if index as usize >= self.groups {
            self.groups = index as usize + 1;
            self.extra += name;
        }
        let start = self.add(Inst::Save(index * 2, 0))?;
        let (s, e) = self.c(sub)?;
        let end = self.add(Inst::Save(index * 2 + 1, 0))?;
        self.patch(start, s)?;
        self.patch(e, end)?;
        Ok((start, end))
    }
}

struct Class {
    ascii: u128,
    ranges: Box<[(u32, u32)]>,
}

impl Class {
    fn new(ranges: Ranges) -> Class {
        let ranges = ranges.into_boxed_slice();
        let ascii = (0..128).filter(|&c| in_ranges(&ranges, c)).fold(0, |m, c| m | 1u128 << c);
        Class { ascii, ranges }
    }

    fn has(&self, c: u32) -> bool {
        if c < 128 {
            self.ascii >> c & 1 == 1
        } else {
            in_ranges(&self.ranges, c)
        }
    }
}

fn in_ranges(r: &[(u32, u32)], c: u32) -> bool {
    r.iter().take_while(|&&(s, _)| s <= c).any(|&(_, e)| c <= e)
}

/// A literal, as `(byte, mask)` pairs: see Needle.
type Lit = Vec<(u8, u8)>;

/// What every match of `h` starts with, whether that is all a match can be, and the longest literal every
/// match holds.
fn lits(h: &Hir) -> (Lit, bool, Lit) {
    let char = |c: char| c.to_string().bytes().map(|b| (b, 0)).collect::<Lit>();
    match &h.node {
        Node::Empty | Node::Look(_) => (Vec::new(), true, Vec::new()),
        Node::Char(c) => (char(*c), true, char(*c)),
        Node::Class(r) => match r[..] {
            [(s, e)] if s == e => {
                let c = char::from_u32(s).map_or_else(Vec::new, char);
                (c.clone(), !c.is_empty(), c)
            }
            [(u, u2), (l, l2)] if u == u2 && l == l2 && (b'A' as u32..=b'Z' as u32).contains(&u) && l == u + 32 => {
                (vec![(l as u8, 0x20)], true, vec![(l as u8, 0x20)])
            }
            _ => (Vec::new(), false, Vec::new()),
        },
        Node::Rep(0, ..) | Node::Deep => (Vec::new(), false, Vec::new()),
        Node::Rep(_, _, _, sub) => {
            let (p, _, m) = lits(sub);
            (p, false, m)
        }
        Node::Cap(_, _, sub) => lits(sub),
        Node::Concat(subs) => {
            let (mut prefix, mut exact, mut must, mut run) = (Vec::new(), true, Vec::new(), Vec::new());
            for sub in subs {
                let (p, e, m) = lits(sub);
                if m.len() > must.len() {
                    must = m;
                }
                if exact {
                    prefix.extend_from_slice(&p);
                }
                run.extend(p);
                if !e {
                    exact = false;
                    if run.len() > must.len() {
                        must = std::mem::take(&mut run);
                    }
                    run.clear();
                }
            }
            if run.len() > must.len() {
                must = run;
            }
            (prefix, exact, must)
        }
        Node::Alt(subs) => {
            let all: Vec<_> = subs.iter().map(lits).collect();
            let first = &all[0].0;
            let common = all.iter().map(|l| first.iter().zip(&l.0).take_while(|(a, b)| a == b).count()).min().unwrap_or(0);
            let exact = all.iter().all(|l| l.1 && l.0 == *first);
            (first[..common].to_vec(), exact, first[..common].to_vec())
        }
    }
}

/// Whether `h` matches exactly one literal, with no groups or assertions.
fn pure(h: &Hir) -> bool {
    match &h.node {
        Node::Char(_) => true,
        Node::Class(_) => lits(h).1,
        Node::Concat(subs) => subs.iter().all(pure),
        _ => false,
    }
}

/// A compiled pattern and what lets a search skip text no match can start in.
struct Regex {
    insts: Vec<Inst>,
    classes: Vec<Class>,
    start: u32,
    groups: usize,
    names: Vec<(String, usize)>,
    /// A literal every match holds.
    must: Option<Needle>,
    /// A literal every match starts with.
    prefix: Option<Needle>,
    /// The bytes a match can start with.
    first: Option<Box<[bool; 256]>>,
    /// No match spans a `\n`.
    line_local: bool,
}

impl Regex {
    fn compile(pattern: &str, flags: Flags) -> R<How> {
        let mut p = Parser { pat: pattern, pos: 0, flags, depth: 0, caps: 0, names: Vec::new() };
        let hir = p.parse()?;
        if hir.height > NEST {
            return Err(ERR_TOO_MUCH_NESTING);
        }
        let mut c = Compiler { insts: Vec::new(), classes: Vec::new(), groups: 0, extra: 0 };
        let (start, end) = c.c_cap(0, 0, &hir)?;
        let matched = c.add(Inst::Match)?;
        c.patch(end, matched)?;
        let (prefix, _, must) = lits(&hir);
        if pure(&hir) && !prefix.is_empty() {
            return Ok(How::Lit(Needle::new(&prefix), false));
        }
        let line_local = c.insts.iter().all(|i| match *i {
            Inst::Char(ch, _) => ch != '\n' as u32,
            Inst::Class(k, _) => !c.classes[k as usize].has('\n' as u32),
            _ => true,
        });
        let mut re = Regex { insts: c.insts, classes: c.classes, start, groups: c.groups, names: p.names, must: None, prefix: None, first: None, line_local };
        re.first = re.first_bytes();
        re.must = (must.len() > prefix.len()).then(|| Needle::new(&must));
        re.prefix = (!prefix.is_empty()).then(|| Needle::new(&prefix));
        Ok(How::Re(Box::new(re)))
    }

    /// The first bytes of the characters a match can start with, or None when that's every byte or a match
    /// can be empty.
    fn first_bytes(&self) -> Option<Box<[bool; 256]>> {
        let lead = |c: u32| match c {
            0..=0x7F => c,
            0x80..=0x7FF => 0xC0 | c >> 6,
            0x800..=0xFFFF => 0xE0 | c >> 12,
            _ => 0xF0 | c >> 18,
        } as usize;
        let mut set = Box::new([false; 256]);
        let mut seen = vec![false; self.insts.len()];
        let mut stack = vec![self.start];
        while let Some(sid) = stack.pop() {
            if std::mem::replace(&mut seen[sid as usize], true) {
                continue;
            }
            match &self.insts[sid as usize] {
                Inst::Char(c, _) => set[lead(*c)] = true,
                Inst::Class(k, _) => {
                    for &(s, e) in self.classes[*k as usize].ranges.iter() {
                        for (lo, hi) in [(0, 0x7F), (0x80, 0x7FF), (0x800, 0xFFFF), (0x10000, 0x10FFFF)] {
                            let (a, b) = (s.max(lo), e.min(hi));
                            if a <= b {
                                set[lead(a)..=lead(b)].fill(true);
                            }
                        }
                    }
                }
                Inst::Split(ts, _) => stack.extend(ts),
                Inst::Goto(t) | Inst::Look(_, t) | Inst::Save(_, t) => stack.push(*t),
                Inst::Fail => {}
                Inst::Match => return None,
            }
        }
        (!set.iter().all(|&b| b)).then_some(set)
    }

    /// The leftmost-first match in `h` that starts at or after `start` and ends by `end`, as regex-lite's PikeVM
    /// finds it: where it ends, with the winner's first `n` slots left in `c.found`. An anchored search starts
    /// threads at `start` only.
    fn run(&self, c: &mut Cache, h: &[u8], start: usize, end: usize, anchored: bool, n: usize) -> Option<usize> {
        if start > end {
            return None;
        }
        c.curr.reset(self.insts.len(), n);
        c.next.reset(self.insts.len(), n);
        c.blank.clear();
        c.blank.resize(n, NONE);
        c.found.clear();
        c.found.resize(n, NONE);
        let mut matched = None;
        let mut at = start;
        loop {
            if c.curr.list.is_empty() {
                if matched.is_some() || (anchored && at > start) {
                    break;
                }
                // States passed at the last position no longer hold anything once the search jumps ahead.
                if !anchored {
                    at = self.skip(c, h, at)?;
                    c.curr.clear();
                }
            }
            if matched.is_none() && (!anchored || at == start) {
                self.closure(h, at, self.start, &mut c.blank, &mut c.curr, &mut c.stack);
            }
            let (ch, len) = decode(h, at);
            let Cache { curr, next, stack, found, .. } = &mut *c;
            for i in 0..curr.list.len() {
                let sid = curr.list[i] as usize;
                let row = sid * n;
                let to = match self.insts[sid] {
                    Inst::Match => {
                        found.copy_from_slice(&curr.slots[row..row + n]);
                        matched = Some(at);
                        break;
                    }
                    Inst::Char(x, t) if len > 0 && x == ch => t,
                    Inst::Class(k, t) if len > 0 && self.classes[k as usize].has(ch) => t,
                    _ => continue,
                };
                self.closure(h, at + len, to, &mut curr.slots[row..row + n], next, stack);
            }
            if len == 0 {
                break;
            }
            std::mem::swap(curr, next);
            next.clear();
            at += len;
            if at > end {
                break;
            }
        }
        matched
    }

    /// The first place at or after `at` a match could start, by the literals and bytes every match needs.
    fn skip(&self, c: &mut Cache, h: &[u8], mut at: usize) -> Option<usize> {
        if let Some(must) = &self.must {
            let line = match c.must {
                Some((from, r)) if from <= at && r.is_none_or(|(r, _)| r >= at) => r,
                _ => {
                    let r = must.find(h, at).map(|r| (r, at + h[at..r].iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1)));
                    c.must = Some((at, r));
                    r
                }
            }?;
            // A match that can't span lines and holds the literal starts on the literal's line.
            if self.line_local {
                at = at.max(line.1);
            }
        }
        match (&self.prefix, &self.first) {
            (Some(p), _) => p.find(h, at),
            (None, Some(first)) => h[at..].iter().position(|&b| first[b as usize]).map(|i| at + i),
            (None, None) => Some(at),
        }
    }

    /// Adds the thread at `sid`, and every state it reaches without consuming a character, to `to`, in
    /// priority order, skipping states a thread of higher priority holds.
    fn closure(&self, h: &[u8], at: usize, sid: u32, slots: &mut [usize], to: &mut Threads, stack: &mut Vec<Frame>) {
        let n = slots.len();
        stack.push(Frame::Explore(sid));
        while let Some(frame) = stack.pop() {
            let mut sid = match frame {
                Frame::Explore(sid) => sid,
                Frame::Restore(k, v) => {
                    slots[k as usize] = v;
                    continue;
                }
            };
            loop {
                if to.seen[sid as usize] == to.gen {
                    break;
                }
                to.seen[sid as usize] = to.gen;
                sid = match &self.insts[sid as usize] {
                    Inst::Char(..) | Inst::Class(..) | Inst::Match => {
                        to.list.push(sid);
                        let row = sid as usize * n;
                        to.slots[row..row + n].copy_from_slice(slots);
                        break;
                    }
                    Inst::Fail => break,
                    Inst::Goto(t) => *t,
                    Inst::Look(l, t) if l.is_match(h, at) => *t,
                    Inst::Look(..) => break,
                    Inst::Split(ts, rev) => {
                        let Some((&first, rest)) = (if *rev { ts.split_last() } else { ts.split_first() }) else { break };
                        if *rev {
                            stack.extend(rest.iter().map(|&t| Frame::Explore(t)));
                        } else {
                            stack.extend(rest.iter().rev().map(|&t| Frame::Explore(t)));
                        }
                        first
                    }
                    Inst::Save(k, t) => {
                        if let Some(s) = slots.get_mut(*k as usize) {
                            stack.push(Frame::Restore(*k, *s));
                            *s = at;
                        }
                        *t
                    }
                };
            }
        }
    }
}

/// One search's threads: the states they're in, in priority order, and each one's slots.
#[derive(Default)]
struct Threads {
    /// `seen[state] == gen` once a thread has reached the state at this step.
    seen: Vec<u32>,
    gen: u32,
    list: Vec<u32>,
    slots: Vec<usize>,
}

impl Threads {
    fn reset(&mut self, states: usize, slots: usize) {
        if self.seen.len() < states {
            self.seen.resize(states, 0);
        }
        if self.slots.len() < states * slots {
            self.slots.resize(states * slots, NONE);
        }
        self.clear();
    }

    fn clear(&mut self) {
        self.list.clear();
        self.gen = self.gen.wrapping_add(1);
        if self.gen == 0 {
            self.seen.fill(0);
            self.gen = 1;
        }
    }
}

enum Frame {
    Explore(u32),
    Restore(u32, usize),
}

/// What a search reuses from one match to the next.
#[derive(Default)]
struct Cache {
    stack: Vec<Frame>,
    curr: Threads,
    next: Threads,
    /// Slots for a thread that starts: none set.
    blank: Vec<usize>,
    /// The winning thread's slots.
    found: Vec<usize>,
    /// Where `must` was last looked for, and where it was next found and the line there starts.
    must: Option<(usize, Option<(usize, usize)>)>,
}

/// A file's filter on the search tab: comma-separated parts, each text a path holds or, with `*` (any run of
/// characters but `/`) or `**` (any run but a line break), a pattern the path's end matches from a name's
/// start. `!` before a part leaves out what it matches. ASCII letters match in either case; `\` is `/`.
pub struct Filter {
    keep: Vec<Glob>,
    drop: Vec<Glob>,
}

struct Glob {
    toks: Vec<Tok>,
    star: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Tok {
    Byte(u8),
    Star,
    Any,
}

impl Filter {
    pub fn new(files: &str) -> Filter {
        let mut f = Filter { keep: Vec::new(), drop: Vec::new() };
        for part in files.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let (list, part) = match part.strip_prefix('!') {
                Some(p) => (&mut f.drop, p.trim()),
                None => (&mut f.keep, part),
            };
            let b = part.as_bytes();
            let mut toks = Vec::new();
            let mut i = 0;
            while i < b.len() {
                toks.push(match b[i] {
                    b'*' if b.get(i + 1) == Some(&b'*') => {
                        i += 1;
                        Tok::Any
                    }
                    b'*' => Tok::Star,
                    b'\\' => Tok::Byte(b'/'),
                    c => Tok::Byte(c.to_ascii_lowercase()),
                });
                i += 1;
            }
            list.push(Glob { toks, star: part.contains('*') });
        }
        f
    }

    pub fn keeps(&self, path: &str) -> bool {
        (self.keep.is_empty() || self.keep.iter().any(|g| g.matches(path))) && !self.drop.iter().any(|g| g.matches(path))
    }
}

impl Glob {
    fn matches(&self, path: &str) -> bool {
        let (p, toks, n) = (path.as_bytes(), &self.toks, self.toks.len());
        let byte = |t: &Tok, c: u8| *t == Tok::Byte(c.to_ascii_lowercase());
        if !self.star {
            return n == 0 || p.windows(n).any(|w| w.iter().zip(toks).all(|(&c, t)| byte(t, c)));
        }
        // Which tokens are matched up to here, from each start: the path's, or just after a `/`.
        let (mut on, mut next) = (vec![false; n + 1], vec![false; n + 1]);
        for i in 0..=p.len() {
            on[0] |= i == 0 || p[i - 1] == b'/';
            for k in 0..n {
                on[k + 1] |= on[k] && !matches!(toks[k], Tok::Byte(_));
            }
            if i == p.len() {
                break;
            }
            next.fill(false);
            for k in (0..n).filter(|&k| on[k]) {
                match toks[k] {
                    Tok::Byte(_) => next[k + 1] |= byte(&toks[k], p[i]),
                    Tok::Star => next[k] |= p[i] != b'/',
                    Tok::Any => next[k] |= p[i] != b'\n',
                }
            }
            std::mem::swap(&mut on, &mut next);
        }
        on[n]
    }
}
