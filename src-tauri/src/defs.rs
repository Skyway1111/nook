//! Where things are defined across a repository: quick open's `#` and a file tab's F12. A line scanner, not a
//! parser, reads the declarations each language starts a line with (`fn`, `def`, `class`, `func`, a JavaScript
//! `const f = () =>`, a C function's head) from quick open's file list. Each file's are kept with its change
//! time and size, so a second search rereads only the files that changed.
use crate::search::list;
use serde::Serialize;
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

/// Kinds as quick open's symbol badges name them.
const KINDS: [&str; 11] = ["function", "method", "class", "struct", "interface", "trait", "enum", "type", "module", "constant", "heading"];
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

#[derive(Clone, Debug, PartialEq)]
struct Def {
    name: String,
    kind: u8,
    line: u32,
    /// 1-based, in characters: where the name starts on its line.
    col: u32,
}

/// Each file read so far: its stamp (change time and size) and its definitions.
type Cache = HashMap<String, (String, Arc<Vec<Def>>)>;
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

#[derive(Serialize)]
pub struct Symbols {
    root: String,
    /// Files, relative to the root with `/` between folders, that `defs` point into.
    files: Vec<String>,
    /// `[name, kind, file, line, col]`: a definition, its kind in `kinds`, its file in `files`, and where its name
    /// starts, 1-based.
    defs: Vec<(String, u8, u32, u32, u32)>,
    kinds: [&'static str; 11],
    /// Stopped early: at MAX_DEFS, at the time budget, or with the file list cut short.
    partial: bool,
}

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
}

fn lang(path: &str) -> Option<Lang> {
    let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" | "vue" | "svelte" => Lang::Js,
        "py" | "pyi" => Lang::Python,
        "rs" => Lang::Rust,
        "go" => Lang::Go,
        "java" | "cs" | "kt" | "kts" | "swift" | "dart" | "scala" => Lang::Jvm,
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" | "m" | "mm" => Lang::C,
        "rb" => Lang::Ruby,
        "lua" | "php" | "gd" | "sh" | "bash" | "zsh" | "ps1" => Lang::Script,
        "md" | "markdown" => Lang::Markdown,
        _ => return None,
    })
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
            return (word == "define").then(|| ident(rest.trim_start()).map(|(n, _)| (n.to_string(), CONSTANT))).flatten();
        }
    }
    let s = strip_modifiers(body, lang);
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
        // Ruby's predicate and bang methods keep their mark.
        let name = if lang == Lang::Ruby && after.starts_with(['?', '!']) { format!("{name}{}", &after[..1]) } else { name.to_string() };
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
    if indent > 8 || s.ends_with(';') || s.ends_with(',') || s.starts_with(['(', '}', '=', '.', '"', '\'']) {
        return None;
    }
    let paren = s.find('(')?;
    let before = s[..paren].trim_end();
    if before.contains('=') || before.contains("::") && lang != Lang::C {
        return None;
    }
    let name_start = before.rfind(|c: char| !(c.is_alphanumeric() || c == '_' || c == '~' || c == ':')).map_or(0, |i| i + 1);
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
    if !signature_ends(rest, true) && !(lang == Lang::C && indent == 0 && !rest.trim_end().ends_with(';')) {
        return None;
    }
    let kind = if indent > 0 || name.contains("::") { METHOD } else { FUNCTION };
    Some((name.to_string(), kind))
}

/// Every definition in `text`, a file in `lang`, in order.
fn scan(text: &str, lang: Lang) -> Vec<Def> {
    let mut defs = Vec::new();
    let mut fence = false; // inside a Markdown code fence
    let mut comment = false; // inside a C-style block comment
    // Whether the last line at the left edge opened a Rust impl or trait or a Python class: a `fn` or `def` indented
    // under one is a method, and under anything else (a test module, another function) a function.
    let mut in_type = false;
    for (i, line) in text.lines().enumerate() {
        let t = line.trim_start();
        if lang == Lang::Markdown && (t.starts_with("```") || t.starts_with("~~~")) {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        if lang != Lang::Markdown && lang != Lang::Python && lang != Lang::Ruby {
            if comment {
                comment = !t.contains("*/");
                continue;
            }
            if t.starts_with("/*") {
                comment = !t.contains("*/");
                continue;
            }
            if t.starts_with("//") || t.starts_with('*') {
                continue;
            }
        }
        if t.starts_with('#') && lang != Lang::Markdown && lang != Lang::C {
            continue;
        }
        if t.len() == line.len() && !t.is_empty() && !t.starts_with('@') {
            let s = strip_modifiers(t, lang);
            in_type = match lang {
                Lang::Rust => ident(s).is_some_and(|(w, _)| w == "impl" || w == "trait"),
                Lang::Python => ident(s).is_some_and(|(w, _)| w == "class"),
                _ => false,
            };
        }
        if let Some((name, mut kind)) = scan_line(line, lang) {
            if kind == METHOD && matches!(lang, Lang::Rust | Lang::Python) && !in_type {
                kind = FUNCTION;
            }
            let col = line.find(name.trim_end_matches(['?', '!'])).map_or(1, |b| line[..b].chars().count() as u32 + 1);
            defs.push(Def { name, kind, line: i as u32 + 1, col });
        }
    }
    defs
}

/// A file's change time and size: equal stamps, unchanged as far as a definition list goes.
fn stamp(path: &Path) -> Option<(String, u64)> {
    let meta = fs::metadata(path).ok()?;
    meta.is_file().then(|| (format!("{:?} {}", meta.modified().ok(), meta.len()), meta.len()))
}

/// Every definition under `dir`'s repository, or `dir` outside one, in quick open's file order.
#[tauri::command(async)]
pub fn workspace_symbols(dir: String) -> Result<Symbols, String> {
    let (root, files, list_partial) = list(&dir)?;
    let started = Instant::now();
    let wanted: Vec<(usize, &String, Lang)> = files.iter().enumerate().filter_map(|(i, f)| lang(f).map(|l| (i, f, l))).collect();
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
                        for &(i, rel, lang) in wanted.iter().skip(from).take(32) {
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
                                    Ok(b) if !b[..b.len().min(8192)].contains(&0) => scan(&String::from_utf8_lossy(&b), lang),
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
    let mut out = Symbols { root, files: Vec::new(), defs: Vec::new(), kinds: KINDS, partial: list_partial || !scanned_all };
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
