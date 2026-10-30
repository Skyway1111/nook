//! Where things are defined: across a repository for quick open's `#` and a file tab's F12, and in one file for
//! `@`'s outline. A line scanner, not a parser, reads the declarations each language starts a line with (`fn`,
//! `def`, `class`, `func`, a JavaScript `const f = () =>`, a C function's head), skipping strings and comments,
//! and nests them by braces or indentation. For `#` it reads quick open's file list, keeping each file's
//! definitions with its change time and size, so a second search rereads only the files that changed.
use crate::search::list;
use crate::json::object;
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

/// A file bigger than this is data or a build product, not something people write definitions in.
const MAX_FILE: u64 = 1 << 20;
/// Definitions sent at most, and how long a first scan of a huge repository may take.
const MAX_DEFS: usize = 200_000;
const BUDGET: Duration = Duration::from_secs(5);

/// Kinds as quick open's symbol badges name them. `#` finds the first 11; the rest show only in an outline.
const KINDS: [&str; 16] = [
    "function", "method", "class", "struct", "interface", "trait", "enum", "type", "module", "constant", "heading", "impl", "variable", "field", "rule",
    "key",
];
const FUNCTION: u8 = 0;
const METHOD: u8 = 1;
const CLASS: u8 = 2;
const STRUCT: u8 = 3;
const INTERFACE: u8 = 4;
const TRAIT: u8 = 5;
const ENUM: u8 = 6;
const TYPE: u8 = 7;
const MODULE: u8 = 8;
const CONSTANT: u8 = 9;
const HEADING: u8 = 10;
const IMPL: u8 = 11;
const VARIABLE: u8 = 12;
const FIELD: u8 = 13;
const RULE: u8 = 14;
const KEY: u8 = 15;
/// Items an outline lists at most.
const MAX_ITEMS: usize = 5000;

#[derive(Clone, Debug, PartialEq)]
struct Def {
    name: String,
    kind: u8,
    line: u32,
    /// 1-based, in UTF-16 units as the editor counts: where the name starts on its line.
    col: u32,
    /// How many definitions hold this one, and the nearest's index.
    depth: u32,
    parent: Option<u32>,
}

/// Each file read so far: its stamp (change time and size) and its definitions.
type Cache = HashMap<String, (String, Arc<Vec<Def>>)>;
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

pub struct Symbols {
    root: String,
    /// Files, relative to the root with `/` between folders, that `defs` point into.
    files: Vec<String>,
    /// `[name, kind, file, line, col]`: a definition, its kind in `kinds`, its file in `files`, and where its name
    /// starts, 1-based.
    defs: Vec<(String, u8, u32, u32, u32)>,
    kinds: &'static [&'static str],
    /// Stopped early: at MAX_DEFS, at the time budget, or with the file list cut short.
    partial: bool,
}

object!(Symbols { root, files, defs, kinds, partial });

/// The language family a file's extension names, or None for one with nothing to scan.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Lang {
    Js,
    Python,
    Rust,
    Go,
    /// Java, C#, Kotlin, Swift, Dart, Scala: classes, and methods by their heads.
    Jvm,
    C,
    Ruby,
    /// Lua, PHP, GDScript, shell: `function name` or `func name`.
    Script,
    Markdown,
    /// Only outlined: CSS, Sass and Less rules, and JSON and YAML keys.
    Css,
    Json,
    Yaml,
}

/// The language `#` scans a file of, by its extension, lowercase.
fn lang(ext: &str) -> Option<Lang> {
    Some(match ext {
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" | "vue" | "svelte" => Lang::Js,
        "py" | "pyi" => Lang::Python,
        "rs" => Lang::Rust,
        "go" => Lang::Go,
        "java" | "cs" | "kt" | "kts" | "swift" | "dart" | "scala" => Lang::Jvm,
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" | "m" | "mm" => Lang::C,
        "rb" => Lang::Ruby,
        "lua" | "php" | "gd" | "sh" | "bash" | "zsh" | "ps1" => Lang::Script,
        "md" | "markdown" | "mkd" | "mdx" => Lang::Markdown,
        _ => return None,
    })
}

/// A file's extension, lowercase.
fn ext(path: &str) -> String {
    path.rsplit_once('.').map_or(String::new(), |(_, e)| e.to_ascii_lowercase())
}

/// Words that can come before a declaration's keyword without changing what it declares.
const MODIFIERS: &[&str] = &[
    "export", "default", "declare", "async", "static", "public", "private", "protected", "internal", "final", "abstract",
    "sealed", "open", "override", "virtual", "readonly", "unsafe", "extern", "inline", "pub", "partial", "data", "suspend",
    "synchronized", "native", "transient", "volatile", "strictfp", "local", "mutating", "nonmutating", "fileprivate",
    "required", "convenience", "lazy", "companion", "inner", "operator", "infix", "tailrec", "external", "const",
];
/// Words a line starting with an identifier and `(` can't be a definition after.
const NOT_NAMES: &[&str] = &[
    "if", "for", "while", "switch", "catch", "return", "else", "new", "sizeof", "delete", "throw", "do", "case", "await",
    "typeof", "function", "super", "this", "with", "using", "lock", "foreach", "elif", "until", "unless", "assert",
    "yield", "defined", "when", "match", "try", "finally", "import", "require", "print", "echo", "loop", "constructor",
];

/// The identifier at the start of `s` (letters, digits, `_` and `$`), and what follows it.
fn ident(s: &str) -> Option<(&str, &str)> {
    let end = s.find(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$')).unwrap_or(s.len());
    let first = s.chars().next()?;
    (end > 0 && !first.is_ascii_digit()).then(|| (&s[..end], &s[end..]))
}

/// `s` without its leading modifier words, and Rust's `pub(crate)` and `extern "C"`. A `const` or Rust `static`
/// that binds a name (`const MAX = 3`, `static CACHE: …`) stays, since there it is the declaration's keyword.
fn strip_modifiers(mut s: &str, lang: Lang) -> &str {
    loop {
        let Some((word, rest)) = ident(s) else { return s };
        if !MODIFIERS.contains(&word) || !rest.starts_with([' ', '\t', '(']) {
            return s;
        }
        let binds = matches!((word, lang), ("const", Lang::Js | Lang::Rust | Lang::Go) | ("static", Lang::Rust));
        // Rust's `const fn` and `const unsafe fn` are functions; JavaScript's and Go's `const` always binds.
        let rust_fn = lang == Lang::Rust && ident(rest.trim_start()).is_some_and(|(next, _)| keyword(next, lang).is_some() || MODIFIERS.contains(&next));
        if binds && !rust_fn {
            return s;
        }
        let mut rest = rest;
        if rest.starts_with('(') {
            // pub(crate), pub(super)
            match rest.find(')') {
                Some(i) if word == "pub" => rest = &rest[i + 1..],
                _ => return s,
            }
        }
        rest = rest.trim_start();
        if word == "extern" && rest.starts_with('"') {
            rest = rest[1..].split_once('"').map_or("", |(_, r)| r).trim_start();
        }
        s = rest;
    }
}

/// What the keyword `word` declares, in `lang`.
fn keyword(word: &str, lang: Lang) -> Option<u8> {
    Some(match word {
        "function" | "fn" | "def" | "func" | "fun" => FUNCTION,
        "class" | "record" | "object" => CLASS,
        "struct" | "union" => STRUCT,
        "interface" | "protocol" => INTERFACE,
        "trait" => TRAIT,
        "enum" => ENUM,
        "type" | "typedef" if lang != Lang::Python => TYPE,
        "mod" | "module" | "namespace" | "package" if lang != Lang::Go => MODULE,
        "class_name" if lang == Lang::Script => CLASS,
        _ => return None,
    })
}

/// The definition one line of `lang` starts, if any. `indent` counts the line's leading whitespace.
fn scan_line(line: &str, lang: Lang) -> Option<(String, u8)> {
    let body = line.trim_start();
    let indent = line.len() - body.len();
    if lang == Lang::Markdown {
        let level = body.bytes().take_while(|&b| b == b'#').count();
        let title = body[level..].trim().trim_end_matches('#').trim();
        return (indent < 4 && (1..=6).contains(&level) && body[level..].starts_with(' ') && !title.is_empty())
            .then(|| (title.to_string(), HEADING));
    }
    if lang == Lang::C {
        if let Some(rest) = body.strip_prefix('#') {
            let (word, rest) = ident(rest.trim_start())?;
            // #define F(x) is a function; #define N 1 a constant.
            return (word == "define").then(|| ident(rest.trim_start()).map(|(n, after)| (n.to_string(), if after.starts_with('(') { FUNCTION } else { CONSTANT }))).flatten();
        }
    }
    let mut s = strip_modifiers(body, lang);
    if s.starts_with('<') && matches!(lang, Lang::Jvm | Lang::C) {
        s = strip_modifiers(s[generics_end(s)?..].trim_start(), lang); // public <T> T[] toArray(
    }
    let (word, rest) = ident(s)?;
    let rest = rest.trim_start();
    if lang == Lang::Rust && word == "macro_rules" {
        return ident(rest.strip_prefix('!')?.trim_start()).map(|(n, _)| (n.to_string(), FUNCTION));
    }
    if let Some(kind) = keyword(word, lang) {
        let mut rest = rest;
        // Go's methods name their receiver first: func (s *Server) Serve(
        let mut kind = kind;
        if lang == Lang::Go && word == "func" && rest.starts_with('(') {
            rest = rest[rest.find(')')? + 1..].trim_start();
            kind = METHOD;
        }
        rest = rest.trim_start_matches(['*', ' ']); // function* gen
        if lang == Lang::Ruby {
            rest = rest.strip_prefix("self.").unwrap_or(rest);
        }
        let (name, after) = ident(rest)?;
        if matches!(name, "struct" | "enum" | "union" | "class") {
            return None; // typedef struct { … } name;
        }
        if kind == TYPE && lang == Lang::Go {
            let shape = after.trim_start();
            kind = if shape.starts_with("struct") { STRUCT } else if shape.starts_with("interface") { INTERFACE } else { TYPE };
        }
        if kind == FUNCTION && indent > 0 && matches!(lang, Lang::Python | Lang::Rust | Lang::Ruby | Lang::Jvm) {
            kind = METHOD;
        }
        if lang == Lang::C && kind != TYPE && after.trim_start().starts_with(';') {
            return None; // a forward declaration: struct Foo;
        }
        // Ruby's predicate and bang methods keep their mark; Lua's function M.load and M:load their table.
        let name = if lang == Lang::Ruby && after.starts_with(['?', '!']) {
            format!("{name}{}", &after[..1])
        } else if lang == Lang::Script && after.starts_with(['.', ':']) {
            rest[..rest.find(|c: char| !(c.is_alphanumeric() || c == '_' || c == '.' || c == ':')).unwrap_or(rest.len())].to_string()
        } else {
            name.to_string()
        };
        return Some((name, kind));
    }
    match lang {
        Lang::Js => js_binding(word, rest, indent),
        Lang::Rust if matches!(word, "const" | "static") => {
            ident(rest.strip_prefix("mut ").unwrap_or(rest).trim_start()).map(|(n, _)| (n.to_string(), CONSTANT))
        }
        Lang::Rust => None,
        Lang::Go if matches!(word, "const" | "var") && indent == 0 => ident(rest).map(|(n, _)| (n.to_string(), CONSTANT)),
        Lang::Python if indent == 0 => {
            // NAME = ... at the top, in capitals: a module constant.
            let (name, after) = (word, rest);
            (after.starts_with('=') && !after.starts_with("==") && name.len() > 1 && name.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'))
                .then(|| (name.to_string(), CONSTANT))
        }
        Lang::Jvm | Lang::C => head(s, indent, lang),
        Lang::Script if word.ends_with("()") || rest.starts_with("()") => {
            // name() { in shell
            (indent == 0 && rest.trim_start_matches("()").trim_start().starts_with('{')).then(|| (word.to_string(), FUNCTION))
        }
        _ => None,
    }
}

/// A JavaScript or TypeScript line that binds a name: `const f = (…) =>`, `let g = function`, an exported constant,
/// or, indented, a class's method `name(…) {`.
fn js_binding(word: &str, rest: &str, indent: usize) -> Option<(String, u8)> {
    if matches!(word, "const" | "let" | "var") {
        let (name, after) = ident(rest)?;
        let mut value = after.trim_start();
        if let Some(annotated) = value.strip_prefix(':') {
            value = &annotated[annotated.find('=')? + 1..]; // a TypeScript annotation: const f: Handler = …
        } else {
            value = value.strip_prefix('=')?;
        }
        let value = value.trim_start();
        let value = value.strip_prefix("async").map_or(value, str::trim_start);
        let arrow = value.starts_with("function")
            || (value.starts_with('(') && value.contains("=>"))
            || ident(value).is_some_and(|(_, r)| r.trim_start().starts_with("=>"));
        if arrow {
            return Some((name.to_string(), FUNCTION));
        }
        let constant = indent == 0 && name.len() > 1 && name.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
        return constant.then(|| (name.to_string(), CONSTANT));
    }
    // A method: indented, `name(…) {` or `get name() {`, never a call or a control statement.
    if indent == 0 || NOT_NAMES.contains(&word) {
        return None;
    }
    let (word, rest) = match word {
        "get" | "set" if ident(rest).is_some() => ident(rest)?,
        _ => (word, rest),
    };
    let rest = rest.trim_start().trim_start_matches(['?', '!']);
    let rest = if rest.starts_with('<') { &rest[rest.find('>')? + 1..] } else { rest };
    (rest.starts_with('(') && signature_ends(rest, false)).then(|| (word.to_string(), METHOD))
}

/// Whether a line's `(…)` part ends as a definition's head does: with `{`, or a type annotation and `{`. With
/// `allman`, a head may end the line and open its body on the next one, as C and Java often do; JavaScript can't
/// allow that, since a call needs no `;` there.
fn signature_ends(rest: &str, allman: bool) -> bool {
    let line = rest.trim_end();
    let close = match rest.rfind(')') {
        Some(i) => i,
        None => return false,
    };
    let after = rest[close + 1..].trim();
    after.starts_with('{')
        || (line.ends_with('{') && (after.starts_with(':') || after.starts_with("->") || after.starts_with("throws")))
        || allman && after.is_empty() && !line.ends_with(';') && !line.ends_with(',')
}

/// A C-like function or method head: return type words, then a name and `(`, at an indent a definition sits at,
/// and not ending in `;` as a declaration or a call does.
fn head(s: &str, indent: usize, lang: Lang) -> Option<(String, u8)> {
    let runs_on = lang == Lang::C && indent == 0 && s.matches('(').count() > s.matches(')').count();
    if indent > 8 || s.ends_with(';') || (s.ends_with(',') && !runs_on) || s.starts_with(['(', '}', '=', '.', '"', '\'']) {
        return None;
    }
    let paren = s.find('(')?;
    let before = s[..paren].trim_end();
    if before.contains('=') || before.contains("::") && lang != Lang::C {
        return None;
    }
    let name_start = before.rfind(|c: char| !(c.is_alphanumeric() || c == '_' || c == '~' || c == ':')).map_or(0, |i| i + before[i..].chars().next().map_or(1, char::len_utf8));
    let name = &before[name_start..];
    let short = name.rsplit("::").next().unwrap_or(name).trim_start_matches('~');
    let types = before[..name_start].trim();
    // A head has a return type before its name (Kotlin and Swift lead with fun and func, caught above), except a
    // constructor in a class body.
    if short.is_empty() || NOT_NAMES.contains(&short) || short.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    if types.is_empty() && !(lang == Lang::Jvm && indent > 0 && short.starts_with(|c: char| c.is_uppercase())) {
        return None;
    }
    if types.split_whitespace().any(|w| NOT_NAMES.contains(&w) || w == "return" || w == "else") {
        return None;
    }
    let rest = &s[paren..];
    if !signature_ends(rest, true) && !runs_on && !(lang == Lang::C && indent == 0 && !rest.trim_end().ends_with(';')) {
        return None;
    }
    let kind = if indent > 0 || name.contains("::") { METHOD } else { FUNCTION };
    Some((name.to_string(), kind))
}

/// What a line starts inside, carried over from the line before.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Open {
    Code,
    /// A block comment, this many deep (Rust's nest).
    Comment(u8),
    /// A JavaScript template string's text. Each `${}` it's inside holds its open braces on the walk's stack.
    Template,
    /// A string running across lines to this quote: Rust's "…", Go's `…`.
    Quote(u8),
    /// Rust's r#"…"#, with this many #.
    Raw(u8),
    /// A triple-quoted string: Python's, Kotlin's, Java's text blocks.
    Triple(u8),
}

/// How a language writes comments and strings, which a definition can't start inside and whose braces don't count.
#[derive(Default)]
struct Syntax {
    slashes: bool,
    hash: bool,
    /// The block comment's opener and closer.
    block: Option<(&'static [u8], &'static [u8])>,
    nest: bool,
    template: bool,
    /// Rust: strings run across lines, r#"raw"#, and 'a is a lifetime, not a quote.
    rust: bool,
    /// Go's raw `strings`, which run across lines.
    raw_ticks: bool,
    triple: bool,
    /// A shell: # starts a comment only at a word's start, and '…' has no escapes.
    shell: bool,
    lua: bool,
    /// Blocks nest by indentation, not braces.
    indented: bool,
}

fn syntax(lang: Lang, ext: &str) -> Syntax {
    const C: Option<(&[u8], &[u8])> = Some((b"/*", b"*/"));
    match lang {
        Lang::Js => Syntax { slashes: true, block: C, template: true, ..Default::default() },
        Lang::Rust => Syntax { slashes: true, block: C, nest: true, rust: true, ..Default::default() },
        Lang::Go => Syntax { slashes: true, block: C, raw_ticks: true, ..Default::default() },
        Lang::Jvm => Syntax { slashes: true, block: C, triple: true, ..Default::default() },
        Lang::C => Syntax { slashes: true, block: C, ..Default::default() },
        Lang::Python => Syntax { hash: true, triple: true, indented: true, ..Default::default() },
        Lang::Ruby => Syntax { hash: true, indented: true, ..Default::default() },
        Lang::Script => match ext {
            "php" => Syntax { slashes: true, hash: true, block: C, ..Default::default() },
            "lua" => Syntax { lua: true, block: Some((b"--[[", b"]]")), indented: true, ..Default::default() },
            "gd" => Syntax { hash: true, triple: true, indented: true, ..Default::default() },
            "ps1" => Syntax { hash: true, block: Some((b"<#", b"#>")), ..Default::default() },
            _ => Syntax { hash: true, shell: true, ..Default::default() },
        },
        _ => Syntax::default(),
    }
}

/// Walks one line's code from `open`, the state the line before ended in, calling `brace(opens)` for each brace
/// outside strings and comments. Returns the state the line ends in. `nest` holds, for each template string's
/// `${}` the walk is inside, the braces open in it.
fn walk(line: &[u8], sx: &Syntax, mut open: Open, nest: &mut Vec<u8>, brace: &mut impl FnMut(bool)) -> Open {
    let n = line.len();
    let at = |i: usize, s: &[u8]| line[i..].starts_with(s);
    let mut i = 0;
    while i < n {
        let c = line[i];
        match open {
            Open::Comment(d) => {
                let (start, end) = sx.block.unwrap_or((b"/*", b"*/"));
                if at(i, end) {
                    i += end.len();
                    open = if d > 1 { Open::Comment(d - 1) } else { Open::Code };
                } else if sx.nest && at(i, start) {
                    i += start.len();
                    open = Open::Comment(d + 1);
                } else {
                    i += 1;
                }
                continue;
            }
            Open::Template => {
                match c {
                    b'\\' => i += 1,
                    b'`' => open = Open::Code,
                    b'$' if line.get(i + 1) == Some(&b'{') => {
                        nest.push(0);
                        open = Open::Code;
                        i += 1;
                    }
                    _ => {}
                }
                i += 1;
                continue;
            }
            Open::Quote(q) => {
                if c == b'\\' && q != b'`' {
                    i += 1;
                } else if c == q {
                    open = Open::Code;
                }
                i += 1;
                continue;
            }
            Open::Raw(h) => {
                if c == b'"' && line[i + 1..].iter().take(h as usize).filter(|&&b| b == b'#').count() == h as usize {
                    open = Open::Code;
                    i += h as usize;
                }
                i += 1;
                continue;
            }
            Open::Triple(q) => {
                if c == b'\\' {
                    i += 1;
                } else if at(i, &[q, q, q]) {
                    open = Open::Code;
                    i += 2;
                }
                i += 1;
                continue;
            }
            Open::Code => {}
        }
        // Code: at the top level, or inside a template's ${ }.
        if (sx.slashes && at(i, b"//")) || (sx.lua && at(i, b"--") && !at(i, b"--[[")) {
            break;
        }
        // A # comment: in a shell only at a word's start, and never PHP's #[attribute]
        let word_start = !(sx.shell && i > 0 && !line[i - 1].is_ascii_whitespace() && line[i - 1] != b';');
        if sx.hash && c == b'#' && word_start && !(sx.slashes && line.get(i + 1) == Some(&b'[')) {
            break;
        }
        if let Some((start, _)) = sx.block {
            if at(i, start) {
                open = Open::Comment(1);
                i += start.len();
                continue;
            }
        }
        match c {
            b'{' => match nest.last_mut() {
                Some(k) => *k += 1,
                None => brace(true),
            },
            b'}' => match nest.last_mut() {
                Some(0) => {
                    nest.pop();
                    open = Open::Template;
                }
                Some(k) => *k -= 1,
                None => brace(false),
            },
            b'`' if sx.template => open = Open::Template,
            b'`' if sx.raw_ticks => match line[i + 1..].iter().position(|&b| b == b'`') {
                Some(e) => i += e + 1,
                None => return Open::Quote(b'`'),
            },
            b'"' | b'\'' if sx.triple && at(i, &[c, c, c]) => {
                match line[i + 3..].windows(3).position(|w| w == [c, c, c]) {
                    Some(e) => i += e + 5,
                    None => return Open::Triple(c),
                }
            }
            b'r' if sx.rust && (i == 0 || !is_word(line[i - 1]) || (line[i - 1] == b'b' && (i == 1 || !is_word(line[i - 2])))) => {
                let h = line[i + 1..].iter().take_while(|&&b| b == b'#').count();
                if line.get(i + 1 + h) == Some(&b'"') {
                    open = Open::Raw(h as u8);
                    i += h + 1;
                }
            }
            b'\'' if sx.rust => {
                // 'x' and '\n' are chars; 'a alone is a lifetime.
                let close = if line.get(i + 1) == Some(&b'\\') { line[i + 2..].iter().take(10).position(|&b| b == b'\'').map(|p| i + 2 + p) } else { char_end(line, i + 1) };
                if let Some(e) = close {
                    i = e;
                }
            }
            b'"' | b'\'' => {
                let raw = sx.shell && c == b'\'';
                let mut k = i + 1;
                while k < n && line[k] != c {
                    k += if line[k] == b'\\' && !raw { 2 } else { 1 };
                }
                if k >= n && sx.rust {
                    return Open::Quote(b'"');
                }
                i = k;
            }
            _ => {}
        }
        i += 1;
    }
    open
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Where a Rust char literal that starts at `i` (after its quote) closes, if it's one: one character, then `'`.
fn char_end(line: &[u8], i: usize) -> Option<usize> {
    let len = match *line.get(i)? {
        b if b < 0x80 => 1,
        b if b >= 0xf0 => 4,
        b if b >= 0xe0 => 3,
        _ => 2,
    };
    (line.get(i + len) == Some(&b'\'')).then_some(i + len)
}

/// Kinds whose functions are methods.
fn holds_methods(kind: u8) -> bool {
    matches!(kind, CLASS | STRUCT | INTERFACE | TRAIT | IMPL | ENUM)
}

/// Kinds whose block holds other definitions.
fn holds(kind: u8) -> bool {
    matches!(kind, FUNCTION | METHOD | CLASS | STRUCT | INTERFACE | TRAIT | IMPL | ENUM | MODULE)
}

/// Every definition in `text`, a file in `lang` with extension `ext`, in order, each with what holds it. The
/// outline adds kinds `#` leaves out: impls, variables, fields, CSS rules, and JSON and YAML keys.
fn scan(text: &str, lang: Lang, ext: &str, outline: bool) -> Vec<Def> {
    match lang {
        Lang::Markdown => return markdown(text),
        Lang::Css => return css(text, ext != "css"),
        Lang::Json => return json(text),
        Lang::Yaml => return yaml(text),
        _ => {}
    }
    let sx = syntax(lang, ext);
    let mut defs: Vec<Def> = Vec::new();
    let mut open = Open::Code;
    let mut nest = Vec::new(); // template strings' ${}s open
    let mut depth = 0i32; // braces open
    // Open definitions: each one's index, and the brace depth inside its body or, by indentation, its line's indent.
    let mut stack: Vec<(usize, i32)> = Vec::new();
    let mut pending: Option<(usize, u8)> = None; // a definition whose body opens on a later line, and lines left to
    let mut group = None; // Go's const ( … ) and var ( … ): the kind each line inside declares
    for (i, line) in text.lines().enumerate() {
        let t = line.trim_start();
        let indent = (line.len() - t.len()) as i32;
        let mut found = None;
        if open == Open::Code && nest.is_empty() && !t.is_empty() {
            if sx.indented {
                while stack.last().is_some_and(|&(_, ind)| ind >= indent) {
                    stack.pop();
                }
            }
            let top = stack.last().map(|&(d, body)| (defs[d].kind, depth == body || sx.indented));
            let hit = if let (Some(kind), true) = (group, outline) {
                if t.starts_with(')') {
                    group = None;
                    None
                } else {
                    ident(t).map(|(n, _)| (n.to_string(), kind))
                }
            } else {
                let level0 = if sx.indented { indent == 0 } else { depth == 0 };
                code_line(t, &sx).then(|| detect(line, lang, outline, top, level0)).flatten()
            };
            if lang == Lang::Go && outline && indent == 0 && (t.starts_with("const (") || t.starts_with("var (")) {
                group = Some(if t.starts_with('c') { CONSTANT } else { VARIABLE });
            }
            if let Some((name, mut kind)) = hit {
                let parent = stack.last().map(|&(d, _)| d);
                let container_kind = parent.map(|d| defs[d].kind);
                if kind == FUNCTION && container_kind.is_some_and(holds_methods) {
                    kind = METHOD;
                } else if kind == METHOD && matches!(lang, Lang::Rust | Lang::Python) && !container_kind.is_some_and(holds_methods) {
                    kind = FUNCTION;
                }
                let key = name.trim_end_matches(['?', '!']);
                let col = line.find(key).map_or(1, |b| line[..b].encode_utf16().count() as u32 + 1);
                defs.push(Def { name, kind, line: i as u32 + 1, col, depth: stack.len() as u32, parent: parent.map(|p| p as u32) });
                found = Some(defs.len() - 1);
                // let a, b, c
                let list = strip_modifiers(t, lang).strip_prefix("let ").or_else(|| strip_modifiers(t, lang).strip_prefix("var "));
                if let (Lang::Js, true, Some(list)) = (lang, outline, list.filter(|l| !l.contains('='))) {
                    for name in list.split(',').skip(1).filter_map(|n| ident(n.trim()).map(|(n, _)| n)) {
                        let col = line.find(name).map_or(1, |b| line[..b].encode_utf16().count() as u32 + 1);
                        defs.push(Def { name: name.to_string(), kind, line: i as u32 + 1, col, depth: stack.len() as u32, parent: parent.map(|p| p as u32) });
                    }
                }
                if sx.indented && holds(kind) {
                    stack.push((defs.len() - 1, indent));
                }
            }
        }
        if sx.indented {
            open = walk(line.as_bytes(), &sx, open, &mut nest, &mut |_| {});
            continue;
        }
        // Braces: a definition whose line leaves a brace open holds what's inside it.
        let mut low = depth;
        open = walk(line.as_bytes(), &sx, open, &mut nest, &mut |opens| {
            if opens {
                depth += 1;
            } else {
                depth -= 1;
                low = low.min(depth);
                while stack.last().is_some_and(|&(_, body)| body > depth) {
                    stack.pop();
                }
            }
        });
        let opener = found.or(pending.map(|p| p.0));
        pending = pending.filter(|&(_, left)| found.is_none() && !t.ends_with(';') && left > 0).map(|(d, left)| (d, left - 1));
        match opener {
            // A function or a type holds its block; a constant or a variable an object it's set to.
            Some(d) if depth > low && (holds(defs[d].kind) || (found == Some(d) && t.contains("= {"))) => {
                stack.push((d, low + 1));
                pending = None;
            }
            // Its parameters run on, or its body opens on the next line, as C and Java's often do.
            Some(d) if found == Some(d) && holds(defs[d].kind) && (t.matches('(').count() > t.matches(')').count() || (lang != Lang::Js && !t.ends_with([';', ',', '}', '=', '>']))) => {
                pending = Some((d, 8))
            }
            _ => {}
        }
    }
    defs
}

/// Whether a trimmed line can hold a definition: it isn't a comment line, or a Python decorator.
fn code_line(t: &str, sx: &Syntax) -> bool {
    !((sx.slashes && (t.starts_with("//") || t.starts_with("* ") || t == "*" || t.starts_with("*/")))
        || (sx.hash && t.starts_with('#') && !t.starts_with("#define") && !t.starts_with("#["))
        || (sx.lua && t.starts_with("--"))
        || t.starts_with('@'))
}

/// The definition a code line starts, if any: `#`'s kinds, a Rust impl, which makes its functions methods, and
/// with `outline` the kinds only an outline shows. `top` is the innermost open definition's kind, and whether the
/// line sits directly in its body; `level0`, whether the line is outside every block.
fn detect(line: &str, lang: Lang, outline: bool, top: Option<(u8, bool)>, level0: bool) -> Option<(String, u8)> {
    let found = scan_line(line, lang);
    let t = line.trim_start();
    if found.is_some() || lang == Lang::Rust {
        return found.or_else(|| rust_impl(t));
    }
    if !outline {
        return None;
    }
    let top_level = top.is_none() && level0;
    match lang {
        Lang::Js => {
            let s = strip_modifiers(t, lang);
            let (word, rest) = ident(s)?;
            if matches!(word, "let" | "var" | "const") && top_level {
                let (name, _) = ident(rest.trim_start())?;
                return Some((name.to_string(), if word == "const" { CONSTANT } else { VARIABLE }));
            }
            // An object's property holding a function, `name: (a) => …`, unless a function builds the object as it
            // runs: its callbacks are noise.
            let value = rest.trim_start().strip_prefix(':').map(str::trim_start);
            if let Some(v) = value.filter(|_| !matches!(top, Some((FUNCTION | METHOD, _)))) {
                let v = v.strip_prefix("async").map_or(v, str::trim_start);
                let arrow = v.starts_with("function") || (v.starts_with('(') && v.contains("=>")) || ident(v).is_some_and(|(_, r)| r.trim_start().starts_with("=>"));
                return arrow.then(|| (word.to_string(), METHOD));
            }
            // A class's field: name = value, name;, name: Type
            if top != Some((CLASS, true)) || NOT_NAMES.contains(&word) {
                return None;
            }
            let (name, rest) = if word == "static" || word == "readonly" { ident(rest.trim_start())? } else { (word, rest) };
            let after = rest.trim_start().trim_start_matches(['?', '!']);
            (after.is_empty() || after.starts_with(['=', ';', ':'])).then(|| (name.to_string(), FIELD))
        }
        Lang::Python if top_level => {
            // name = value, name: Type = value
            let (name, rest) = ident(t)?;
            let rest = rest.trim_start();
            let value = rest.strip_prefix(':').map_or(rest, |r| r.split_once('=').map_or("", |(_, v)| v));
            (rest.starts_with('=') && !rest.starts_with("==") || (rest.starts_with(':') && !value.is_empty())).then(|| (name.to_string(), VARIABLE))
        }
        _ => None,
    }
}

/// A Rust impl's head, `Trait for Type`, from its line.
fn rust_impl(t: &str) -> Option<(String, u8)> {
    let rest = t.strip_prefix("unsafe ").unwrap_or(t).strip_prefix("impl")?;
    if !rest.starts_with([' ', '<']) {
        return None;
    }
    let mut rest = rest.trim_start();
    if rest.starts_with('<') {
        rest = rest[generics_end(rest)?..].trim_start();
    }
    let head = rest.split(['{', ';']).next()?.split(" where").next()?.trim();
    (!head.is_empty()).then(|| (head.split_whitespace().collect::<Vec<_>>().join(" "), IMPL))
}

/// The index just past the `<…>` that `s` starts with, nested ones included.
fn generics_end(s: &str) -> Option<usize> {
    let mut d = 0;
    for (k, c) in s.char_indices() {
        match c {
            '<' => d += 1,
            '>' => {
                d -= 1;
                if d == 0 {
                    return Some(k + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// Markdown's headings, `#` to `######` and underlined with `=` or `-`, nested by level. Code fences and HTML
/// comments hold none; a heading inside a quote or a list item counts.
fn markdown(text: &str) -> Vec<Def> {
    let mut defs: Vec<Def> = Vec::new();
    let mut levels: Vec<(usize, usize)> = Vec::new(); // open headings: level, index
    let mut fence: Option<(char, usize)> = None;
    let mut comment = false;
    let mut para: Option<(u32, &str, usize)> = None; // the paragraph line before: number, text, its byte offset
    let mut add = |defs: &mut Vec<Def>, level: usize, name: &str, line: u32, col: u32| {
        while levels.last().is_some_and(|&(l, _)| l >= level) {
            levels.pop();
        }
        let parent = levels.last().map(|&(_, d)| d as u32);
        defs.push(Def { name: name.to_string(), kind: HEADING, line, col, depth: levels.len() as u32, parent });
        levels.push((level, defs.len() - 1));
    };
    for (i, line) in text.lines().enumerate() {
        let n = i as u32 + 1;
        // A quote's > marks and a list item's marker
        let mut s = line;
        loop {
            let t = s.trim_start_matches(' ');
            if s.len() - t.len() > 3 {
                break;
            }
            if let Some(r) = t.strip_prefix('>') {
                s = r.strip_prefix(' ').unwrap_or(r);
            } else if let Some(r) = list_marker(t) {
                s = r;
            } else {
                break;
            }
        }
        let t = s.trim_start_matches(' ');
        let indent = s.len() - t.len();
        let fenced = |c: char| t.chars().take_while(|&x| x == c).count();
        if let Some((c, len)) = fence {
            if indent < 4 && fenced(c) >= len && t.trim_start_matches(c).trim().is_empty() {
                fence = None;
            }
            continue;
        }
        if comment {
            comment = !line.contains("-->");
            continue;
        }
        if indent < 4 && (fenced('`') >= 3 || fenced('~') >= 3) {
            let c = t.chars().next().unwrap_or('`');
            fence = Some((c, fenced(c)));
            para = None;
            continue;
        }
        if t.starts_with("<!--") {
            comment = !t.contains("-->");
            para = None;
            continue;
        }
        let level = t.bytes().take_while(|&b| b == b'#').count();
        if indent < 4 && (1..=6).contains(&level) && (t.len() == level || t[level..].starts_with([' ', '\t'])) {
            let body = t[level..].trim();
            let title = body.trim_end_matches('#');
            // Closing #s count only after a space.
            let title = if title.len() < body.len() && (title.is_empty() || title.ends_with([' ', '\t'])) { title.trim() } else { body };
            if !title.is_empty() {
                let at = line.len() - t.len() + level + t[level..].find(|c: char| !c.is_whitespace()).unwrap_or(0);
                add(&mut defs, level, title, n, line[..at].encode_utf16().count() as u32 + 1);
            }
            para = None;
            continue;
        }
        let rule = t.trim_end();
        if let Some((pn, ptext, at)) = para {
            if indent < 4 && !rule.is_empty() && (rule.bytes().all(|b| b == b'=') || rule.bytes().all(|b| b == b'-')) {
                let level = if rule.starts_with('=') { 1 } else { 2 };
                add(&mut defs, level, ptext.trim(), pn, at as u32 + 1);
                para = None;
                continue;
            }
        }
        // A paragraph's line, which an underline below makes a heading
        para = (!t.trim().is_empty() && (para.is_some() || indent < 4) && s.len() == line.len())
            .then(|| (n, t, line[..line.len() - t.len()].encode_utf16().count()));
    }
    defs
}

/// The rest of a line after its list item's marker (`- `, `* `, `+ `, `1. `, `1) `), if it starts with one.
fn list_marker(t: &str) -> Option<&str> {
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    let rest = if digits > 0 && digits < 10 { t[digits..].strip_prefix(['.', ')'])? } else { t.strip_prefix(['-', '*', '+'])? };
    rest.strip_prefix([' ', '\t']).or_else(|| rest.is_empty().then_some(rest))
}

/// CSS's rules, Sass's and Less's nested ones inside them, and at-rules with a block: each named by its selector
/// or its at-rule's head.
fn css(text: &str, slashes: bool) -> Vec<Def> {
    let b = text.as_bytes();
    let mut defs: Vec<Def> = Vec::new();
    let mut stack: Vec<Option<usize>> = Vec::new();
    let mut sel = String::new(); // the selector so far, comments left out
    let mut at = (0u32, 0u32); // where it starts
    let (mut line, mut line_start) = (1u32, 0usize);
    let mut parens = 0;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'\n' {
            line += 1;
            line_start = i + 1;
        }
        if c == b'/' && b.get(i + 1) == Some(&b'*') {
            let e = text[i + 2..].find("*/").map_or(b.len(), |e| i + 4 + e);
            if let Some(nl) = text[i..e].rfind('\n') {
                line += text[i..e].matches('\n').count() as u32;
                line_start = i + nl + 1;
            }
            i = e;
            continue;
        }
        parens += (c == b'(') as i32 - (c == b')') as i32;
        if c == b'/' && b.get(i + 1) == Some(&b'/') && slashes && parens == 0 {
            i = text[i..].find('\n').map_or(b.len(), |e| i + e);
            continue;
        }
        match c {
            b'"' | b'\'' => {
                let mut k = i + 1;
                while k < b.len() && b[k] != c && b[k] != b'\n' {
                    k += if b[k] == b'\\' { 2 } else { 1 };
                }
                if sel.is_empty() {
                    at = (line, text[line_start..i].encode_utf16().count() as u32 + 1);
                }
                sel.push_str(&text[i..(k + 1).min(b.len())]);
                i = k + 1;
                continue;
            }
            b'#' if b.get(i + 1) == Some(&b'{') => {
                // #{interpolation} in Sass
                let e = text[i..].find('}').map_or(b.len(), |e| i + e + 1);
                sel.push_str(&text[i..e]);
                i = e;
                continue;
            }
            b'{' => {
                let name = sel.split_whitespace().collect::<Vec<_>>().join(" ");
                if name.is_empty() {
                    stack.push(None);
                } else {
                    let parent = stack.iter().rev().flatten().next().map(|&p| p as u32);
                    let depth = stack.iter().flatten().count() as u32;
                    defs.push(Def { name: name.chars().take(120).collect(), kind: RULE, line: at.0, col: at.1, depth, parent });
                    stack.push(Some(defs.len() - 1));
                }
                sel.clear();
                parens = 0;
            }
            b'}' => {
                stack.pop();
                sel.clear();
            }
            b';' => sel.clear(),
            _ => {
                if sel.is_empty() && !c.is_ascii_whitespace() {
                    at = (line, text[line_start..i].encode_utf16().count() as u32 + 1);
                }
                if !sel.is_empty() || !c.is_ascii_whitespace() {
                    let e = i + text[i..].chars().next().map_or(1, char::len_utf8);
                    sel.push_str(&text[i..e]);
                    i = e;
                    continue;
                }
            }
        }
        i += 1;
    }
    defs
}

/// A JSON file's keys two deep: the top object's, and those of the objects they hold.
fn json(text: &str) -> Vec<Def> {
    let b = text.as_bytes();
    let mut defs: Vec<Def> = Vec::new();
    // Open objects and arrays: whether it's an object, how deep its keys sit, and the key holding it.
    let mut stack: Vec<(bool, u32, Option<usize>)> = Vec::new();
    let mut key: Option<(u32, Option<usize>)> = None; // the last key, for the value after it: its level and item
    let (mut line, mut line_start) = (1u32, 0usize);
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        match c {
            b'\n' => {
                line += 1;
                line_start = i + 1;
            }
            b'/' if b.get(i + 1) == Some(&b'/') => {
                i = text[i..].find('\n').map_or(b.len(), |e| i + e);
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                let e = text[i + 2..].find("*/").map_or(b.len(), |e| i + 4 + e);
                line += text[i..e].matches('\n').count() as u32;
                line_start = text[..e].rfind('\n').map_or(line_start, |p| p + 1);
                i = e;
                continue;
            }
            b'"' => {
                let mut k = i + 1;
                while k < b.len() && b[k] != b'"' && b[k] != b'\n' {
                    k += if b[k] == b'\\' { 2 } else { 1 };
                }
                let colon = text[(k + 1).min(b.len())..].trim_start().starts_with(':');
                if let (Some(&(true, level, parent)), true) = (stack.last(), colon) {
                    let item = (level < 2).then(|| {
                        let col = text[line_start..i + 1].encode_utf16().count() as u32 + 1;
                        defs.push(Def { name: text[i + 1..k.min(b.len())].to_string(), kind: KEY, line, col, depth: level, parent: parent.map(|p| p as u32) });
                        defs.len() - 1
                    });
                    key = Some((level, item));
                }
                i = k + 1;
                continue;
            }
            b'{' | b'[' => {
                let (level, holder) = match key.take() {
                    Some((level, item)) => (level + 1, item),
                    None => stack.last().map_or((0, None), |&(_, l, h)| (l, h)),
                };
                stack.push((c == b'{', level, holder));
            }
            b'}' | b']' => {
                stack.pop();
                key = None;
            }
            b',' => key = None,
            _ => {}
        }
        i += 1;
    }
    defs
}

/// A YAML file's keys two deep, nested by indentation. A list item's keys sit inside the key holding the list.
fn yaml(text: &str) -> Vec<Def> {
    let mut defs: Vec<Def> = Vec::new();
    let mut stack: Vec<(usize, Option<usize>)> = Vec::new(); // open keys: indent, item
    let mut scalar: Option<usize> = None; // inside a block scalar deeper than this indent
    for (i, line) in text.lines().enumerate() {
        let t = line.trim_start();
        let mut indent = line.len() - t.len();
        if let Some(ind) = scalar {
            if t.is_empty() || indent > ind {
                continue;
            }
            scalar = None;
        }
        if t.is_empty() || t.starts_with('#') || t.starts_with("---") || t.starts_with("...") || t.starts_with('%') {
            continue;
        }
        // - key: value, its key indented past the dash
        let mut s = t;
        while let Some(r) = s.strip_prefix("- ") {
            let r2 = r.trim_start();
            indent += 2 + r.len() - r2.len();
            s = r2;
        }
        let Some((name, rest)) = yaml_key(s) else { continue };
        while stack.last().is_some_and(|&(ind, _)| ind >= indent) {
            stack.pop();
        }
        let level = stack.len();
        let parent = stack.iter().rev().find_map(|e| e.1).map(|p| p as u32);
        let item = (level < 2).then(|| {
            let col = line[..line.len() - s.len()].encode_utf16().count() as u32 + 1;
            defs.push(Def { name, kind: KEY, line: i as u32 + 1, col, depth: level as u32, parent });
            defs.len() - 1
        });
        stack.push((indent, item));
        let value = rest.split(" #").next().unwrap_or("").trim();
        if value.starts_with(['|', '>']) {
            scalar = Some(indent);
        }
    }
    defs
}

/// A YAML line's key, plain or quoted, and what follows its colon.
fn yaml_key(s: &str) -> Option<(String, &str)> {
    if let Some(q) = s.chars().next().filter(|&c| c == '"' || c == '\'') {
        let end = s[1..].find(q)? + 1;
        let rest = s[end + 1..].trim_start().strip_prefix(':')?;
        return (rest.is_empty() || rest.starts_with([' ', '\t'])).then(|| (s[1..end].to_string(), rest));
    }
    if s.starts_with(['[', '{', '&', '*', '!', '|', '>', '#', '?']) {
        return None;
    }
    let colon = s.match_indices(':').find(|&(k, _)| s[k + 1..].is_empty() || s[k + 1..].starts_with([' ', '\t']))?.0;
    let key = s[..colon].trim_end();
    (!key.is_empty() && !key.contains(" #")).then(|| (key.to_string(), &s[colon + 1..]))
}

/// `#`'s definitions in a file: its scan without the kinds only an outline shows.
fn found(text: &str, lang: Lang, ext: &str) -> Vec<Def> {
    let mut defs = scan(text, lang, ext, false);
    defs.retain(|d| d.kind <= HEADING);
    defs
}

/// A file's change time and size: equal stamps, unchanged as far as a definition list goes.
fn stamp(path: &Path) -> Option<(String, u64)> {
    let meta = fs::metadata(path).ok()?;
    meta.is_file().then(|| (format!("{:?} {}", meta.modified().ok(), meta.len()), meta.len()))
}

/// One line of a file's outline.
pub struct Item {
    name: String,
    kind: &'static str,
    line: u32,
    /// 1-based, in UTF-16 units: where the name starts.
    col: u32,
    /// How many items hold it, and the nearest one's name.
    depth: u32,
    container: String,
}

object!(Item { name, kind, line, col, depth, container });

pub struct Outline {
    items: Vec<Item>,
    /// Stopped at MAX_ITEMS.
    partial: bool,
}

object!(Outline { items, partial });

/// Quick open's `@`: the definitions in `text`, the unsaved text of a file named `name`, in order and nested.
pub fn outline(name: String, text: String) -> Outline {
    let ext = ext(&name);
    let lang = lang(&ext).or(match ext.as_str() {
        "css" | "scss" | "sass" | "less" => Some(Lang::Css),
        "json" | "jsonc" | "json5" => Some(Lang::Json),
        "yaml" | "yml" => Some(Lang::Yaml),
        _ => None,
    });
    let defs = lang.map_or_else(Vec::new, |lang| scan(&text, lang, &ext, true));
    let items = defs
        .iter()
        .take(MAX_ITEMS)
        .map(|d| Item {
            name: d.name.clone(),
            kind: KINDS[d.kind as usize],
            line: d.line,
            col: d.col,
            depth: d.depth,
            container: d.parent.map_or_else(String::new, |p| defs[p as usize].name.clone()),
        })
        .collect();
    Outline { items, partial: defs.len() > MAX_ITEMS }
}

/// Every definition under `dir`'s repository, or `dir` outside one, in quick open's file order.
pub fn workspace_symbols(dir: String) -> Result<Symbols, String> {
    let (root, files, list_partial) = list(&dir)?;
    let started = Instant::now();
    let wanted: Vec<(usize, &String, Lang, String)> = files.iter().enumerate().filter_map(|(i, f)| lang(&ext(f)).map(|l| (i, f, l, ext(f)))).collect();
    let cache = CACHE.lock().map_err(|e| e.to_string())?.clone().unwrap_or_default();
    let next = AtomicUsize::new(0);
    let workers = thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let mut read: Vec<(usize, String, String, Arc<Vec<Def>>)> = thread::scope(|s| {
        let jobs: Vec<_> = (0..workers)
            .map(|_| {
                s.spawn(|| {
                    let mut mine = Vec::new();
                    loop {
                        let from = next.fetch_add(32, Ordering::Relaxed);
                        if from >= wanted.len() || started.elapsed() > BUDGET {
                            break;
                        }
                        for (i, rel, lang, ext) in wanted.iter().skip(from).take(32) {
                            let (i, lang) = (*i, *lang);
                            let path = Path::new(&root).join(rel);
                            let Some((stamp, len)) = stamp(&path) else { continue };
                            let key = path.to_string_lossy().into_owned();
                            if let Some((was, defs)) = cache.get(&key) {
                                if *was == stamp {
                                    mine.push((i, key, stamp, defs.clone()));
                                    continue;
                                }
                            }
                            let defs = if len > MAX_FILE {
                                Vec::new()
                            } else {
                                match fs::read(&path) {
                                    Ok(b) if !b[..b.len().min(8192)].contains(&0) => found(&String::from_utf8_lossy(&b), lang, ext),
                                    _ => Vec::new(),
                                }
                            };
                            mine.push((i, key, stamp, Arc::new(defs)));
                        }
                    }
                    mine
                })
            })
            .collect();
        jobs.into_iter().flat_map(|j| j.join().unwrap_or_default()).collect()
    });
    read.sort_by_key(|r| r.0);
    let scanned_all = next.load(Ordering::Relaxed) >= wanted.len();
    let mut out = Symbols { root, files: Vec::new(), defs: Vec::new(), kinds: &KINDS[..=HEADING as usize], partial: list_partial || !scanned_all };
    let mut fresh: Cache = HashMap::with_capacity(read.len());
    for (i, key, stamp, defs) in read {
        if !defs.is_empty() && out.defs.len() < MAX_DEFS {
            let file = out.files.len() as u32;
            out.files.push(files[i].clone());
            for d in defs.iter().take(MAX_DEFS - out.defs.len()) {
                out.defs.push((d.name.clone(), d.kind, file, d.line, d.col));
            }
            if out.defs.len() >= MAX_DEFS {
                out.partial = true;
            }
        }
        fresh.insert(key, (stamp, defs));
    }
    // The cache holds this list's files: a file gone from it, or another folder's, isn't kept.
    *CACHE.lock().map_err(|e| e.to_string())? = Some(fresh);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(text: &str, lang: Lang) -> Vec<Def> {
        found(text, lang, "")
    }
    fn defs(text: &str, lang: Lang) -> Vec<(String, &'static str, u32)> {
        scan(text, lang).into_iter().map(|d| (d.name, KINDS[d.kind as usize], d.line)).collect()
    }
    fn names(text: &str, lang: Lang) -> Vec<String> {
        scan(text, lang).into_iter().map(|d| d.name).collect()
    }

    #[test]
    fn javascript_and_typescript() {
        let src = r#"
import { x } from './x.js'
export function startViewer(view, path) {
  if (a) {
  for (const x of y) {
  const inner = () => 1
  foo(bar)
  return thing(a)
}
export default async function* gen() {}
export const DEFAULT_SIZE = 12
const small = 3
export const run = async (a, b) => {
let handler = function () {}
const typed: Handler = (e) => e
export class Tabs extends Base {
  constructor(a) {
  get size() {
  async load(path) {
  static from(x) {
  render() { return 1 }
  private save(): boolean {
}
export interface Props { a: string }
type Id = string
export enum Mode { A }
// function commented() {}
/* class Hidden {} */
"#;
        assert_eq!(
            defs(src, Lang::Js),
            [
                ("startViewer".into(), "function", 3),
                ("inner".into(), "function", 6),
                ("gen".into(), "function", 10),
                ("DEFAULT_SIZE".into(), "constant", 11),
                ("run".into(), "function", 13),
                ("handler".into(), "function", 14),
                ("typed".into(), "function", 15),
                ("Tabs".into(), "class", 16),
                ("size".into(), "method", 18),
                ("load".into(), "method", 19),
                ("from".into(), "method", 20),
                ("render".into(), "method", 21),
                ("save".into(), "method", 22),
                ("Props".into(), "interface", 24),
                ("Id".into(), "type", 25),
                ("Mode".into(), "enum", 26),
            ]
        );
    }

    #[test]
    fn python_rust_go() {
        let py = "MAX_HITS = 3\nclass Model(Base):\n    def forward(self, x):\n        return x\nasync def main():\n    pass\nx = 1\n";
        assert_eq!(
            defs(py, Lang::Python),
            [("MAX_HITS".into(), "constant", 1), ("Model".into(), "class", 2), ("forward".into(), "method", 3), ("main".into(), "function", 5)]
        );
        let py2 = "def outer():\n    def inner():\n        pass\n@dataclass\nclass P:\n    @property\n    def x(self):\n";
        assert_eq!(defs(py2, Lang::Python), [("outer".into(), "function", 1), ("inner".into(), "function", 2), ("P".into(), "class", 5), ("x".into(), "method", 7)]);
        let rs = "pub(crate) fn list(dir: &str) {}\npub struct Hit {\nimpl Hit {\n    pub async fn new() -> Self {\n}\nconst MAX: usize = 3;\nmacro_rules! make {\nextern \"C\" fn cb() {}\npub enum Lang {\ntrait Draw {\nmod tests {\nstatic CACHE: u8 = 0;\n";
        assert_eq!(names(rs, Lang::Rust), ["list", "Hit", "new", "MAX", "make", "cb", "Lang", "Draw", "tests", "CACHE"]);
        assert_eq!(scan(rs, Lang::Rust)[2].kind, METHOD);
        let nested = "mod tests {\n    fn finds_it() {\n}\nimpl Hit {\n    #[inline]\n    fn len(&self) {\n}\n";
        assert_eq!(defs(nested, Lang::Rust), [("tests".into(), "module", 1), ("finds_it".into(), "function", 2), ("len".into(), "method", 6)]);
        let go = "package main\nfunc main() {\nfunc (s *Server) Serve(l net.Listener) error {\ntype Server struct {\ntype Handler interface {\ntype ID string\nconst Max = 3\n";
        assert_eq!(
            defs(go, Lang::Go),
            [
                ("main".into(), "function", 2),
                ("Serve".into(), "method", 3),
                ("Server".into(), "struct", 4),
                ("Handler".into(), "interface", 5),
                ("ID".into(), "type", 6),
                ("Max".into(), "constant", 7),
            ]
        );
    }

    #[test]
    fn c_family_and_others() {
        let c = "#include <x.h>\n#define BUF 64\nstatic int count_lines(const char *s) {\nint main(int argc, char **argv)\n{\nvoid declared(int a);\nstruct node {\nstruct node;\n  if (x) {\n  call(a);\nvoid Widget::paint(Painter &p) {\n";
        assert_eq!(names(c, Lang::C), ["BUF", "count_lines", "main", "node", "Widget::paint"]);
        let java = "public class Store {\n    public Store(int n) {\n    private static List<String> names(int a) throws IOException {\n        if (a) {\n        return names(1);\n    }\n    void run();\n}\n";
        assert_eq!(names(java, Lang::Jvm), ["Store", "Store", "names"]);
        let kt = "data class Point(val x: Int)\nsuspend fun load(): Int {\n";
        assert_eq!(names(kt, Lang::Jvm), ["Point", "load"]);
        let rb = "module Shop\n  class Cart\n    def self.empty?\n    def add(item)\n";
        assert_eq!(names(rb, Lang::Ruby), ["Shop", "Cart", "empty?", "add"]);
        let sh = "build() {\nfunction deploy {\n";
        assert_eq!(names(sh, Lang::Script), ["build", "deploy"]);
        let md = "# Title\n\n```js\n# not a heading\n```\n## Install nook ##\n#nospace\n";
        assert_eq!(names(md, Lang::Markdown), ["Title", "Install nook"]);
        assert_eq!(scan(md, Lang::Markdown)[0].kind, HEADING);
        let cols: Vec<u32> = scan("export function één() {}\n  get size() {\n", Lang::Js).iter().map(|d| d.col).collect();
        assert_eq!(cols, [17, 7]);
    }

    #[test]
    fn lists_a_folder_and_reuses_unchanged_files() {
        let dir = std::env::temp_dir().join(format!("nook-defs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.js"), "export function one() {}\n").unwrap();
        fs::write(dir.join("b.py"), "def two():\n    pass\n").unwrap();
        fs::write(dir.join("c.txt"), "function three() {}\n").unwrap();
        let found = workspace_symbols(dir.to_string_lossy().into_owned()).unwrap();
        let mut got: Vec<_> = found.defs.iter().map(|d| (d.0.as_str(), found.files[d.2 as usize].as_str(), d.3)).collect();
        got.sort();
        assert_eq!(got, [("one", "a.js", 1), ("two", "b.py", 1)]);
        assert!(CACHE.lock().unwrap().as_ref().unwrap().len() == 2);
        fs::remove_dir_all(&dir).unwrap();
    }
}
