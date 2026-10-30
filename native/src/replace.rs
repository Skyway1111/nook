//! The search tab's find and replace across files: every match under a folder, with case, whole words and
//! regular expressions as asked, and the replacing of the matches the tab keeps, which it can undo.
//! A file is rewritten only while it still holds what the search read, so an edit made since is never lost.
use crate::find::{Filter, Finder};
use crate::json::{object, Error, Reader, Take};
use crate::search::{list, shown};
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    fs,
    hash::Hasher,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

/// Matches shown at most: past this, a search asks to be narrowed.
const MAX_MATCHES: usize = 5000;
/// A file bigger than this is data or a build product, as quick open's search treats it.
const MAX_FILE: u64 = 2 << 20;
const BUDGET: Duration = Duration::from_secs(8);
const BOM: &str = "\u{FEFF}";

static LATEST: AtomicU64 = AtomicU64::new(0);
/// What the last replace changed: each file, what it held before, and the stamp of what it holds after.
static UNDO: Mutex<Vec<(PathBuf, Vec<u8>, String)>> = Mutex::new(Vec::new());

#[derive(Clone)]
pub struct Query {
    text: String,
    /// Match case exactly. Without it, ASCII letters match either case, as in quick open's search.
    case: bool,
    /// Match whole words only.
    word: bool,
    /// `text` is a regular expression, and a replacement's `$1` or `${name}` takes what a group matched.
    regex: bool,
    /// Which files, by path, as `Filter` reads it. Empty for every file.
    files: String,
}

impl Take for Query {
    fn take(p: &mut Reader) -> Result<Self, Error> {
        let (mut text, mut flags, mut files) = (None, [None; 3], String::new());
        p.known("struct Query", &["text", "case", "word", "regex", "files"], |p, i| {
            match i {
                0 => text = Some(String::take(p)?),
                4 => files = String::take(p)?,
                _ => flags[i - 1] = Some(bool::take(p)?),
            }
            Ok(())
        })?;
        let [case, word, regex] = flags;
        Ok(Query { text: p.needs(text, "text")?, case: p.needs(case, "case")?, word: p.needs(word, "word")?, regex: p.needs(regex, "regex")?, files })
    }
}

pub struct Match {
    line: u32,
    col: u32,
    /// The line, trimmed and cut around the match, and where the match sits in it, in characters.
    text: String,
    at: u32,
    len: u32,
    /// Where the match starts in the file's text, in bytes: what a replace is told to skip.
    start: usize,
    /// What it becomes, when a replacement was given.
    to: Option<String>,
}

object!(Match { line, col, text, at, len, start, to });

pub struct FileMatches {
    /// Relative to the root, with `/` between folders.
    file: String,
    /// Names what the file held when read: a replace leaves the file alone once it changes.
    stamp: String,
    matches: Vec<Match>,
}

object!(FileMatches { file, stamp, matches });

pub struct Found {
    root: String,
    files: Vec<FileMatches>,
    /// Files read.
    searched: usize,
    /// Stopped early: at MAX_MATCHES, at the time budget, or with the file list cut short.
    partial: bool,
    /// A newer search started, so this one's result is to be dropped.
    stale: bool,
}

object!(Found { root, files, searched, partial, stale });

/// What `q` looks for. The error says why a regular expression is not one.
fn pattern(q: &Query) -> Result<Finder, String> {
    Finder::new(&q.text, q.case, q.word, q.regex)
}

/// A stamp of a file's bytes: equal stamps, the same bytes, to anything short of a deliberate collision.
fn stamp(bytes: &[u8]) -> String {
    let mut h = DefaultHasher::new();
    h.write(bytes);
    format!("{:016x}{:x}", h.finish(), bytes.len())
}

/// A file's text to search or replace in, without its BOM, or None when it's big, binary, or not UTF-8,
/// which a rewrite could garble.
fn text_of(bytes: &[u8]) -> Option<&str> {
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    Some(text.strip_prefix(BOM).unwrap_or(text))
}

/// The matches of `re` in one file, at most `room` of them, with what each becomes when `with` is given: its
/// groups filled in for a regular expression, else `with` as it is.
fn find_in(path: &Path, q: &Query, re: &Finder, with: Option<&str>, room: usize) -> Option<(String, Vec<Match>)> {
    if room == 0 || fs::metadata(path).map_or(true, |m| !m.is_file() || m.len() > MAX_FILE) {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let text = text_of(&bytes)?;
    let mut matches = Vec::new();
    // The line the last match was on: its number, start, end and the match's column, which the next match on
    // it counts on from, so a long line is read once, not once a match.
    let (mut line, mut start, mut end, mut col, mut counted) = (1u32, 0, 0, 1, 0);
    let mut found = re.matches(text, with.is_some_and(|w| w.contains('$')));
    while let Some((m, m_end)) = found.next() {
        let gap = &text.as_bytes()[counted..m];
        let breaks = gap.iter().filter(|&&b| b == b'\n').count();
        if breaks > 0 {
            line += breaks as u32;
            start = counted + gap.iter().rposition(|&b| b == b'\n').unwrap() + 1;
            col = 1;
            counted = start;
        }
        col += text[counted..m].chars().count() as u32;
        counted = m;
        // A match across lines shows its first.
        if m > end || matches.is_empty() {
            end = text[m..].find(['\r', '\n']).map_or(text.len(), |i| m + i);
        }
        let hit = shown(&text[start..end], m - start, m_end.min(end) - m, line, col);
        let to = with.map(|w| if q.regex { found.expand(m, m_end, w) } else { w.to_string() });
        matches.push(Match { line, col: hit.col, text: hit.text, at: hit.at, len: hit.len, start: m, to });
        if matches.len() >= room {
            break;
        }
    }
    (!matches.is_empty()).then(|| (stamp(&bytes), matches))
}

/// Every match of `query` under `dir`'s repository, or `dir` outside one, in quick open's file order, with
/// what each becomes when `with` is given.
pub fn find_in_files(dir: String, query: Query, with: Option<String>) -> Result<Found, String> {
    let id = LATEST.fetch_add(1, Ordering::SeqCst) + 1;
    let re = pattern(&query)?;
    let keep = Filter::new(&query.files);
    let (root, files, list_partial) = list(&dir)?;
    let files: Vec<(usize, &String)> = files.iter().enumerate().filter(|(_, f)| keep.keeps(f)).collect();
    let started = Instant::now();
    let found = AtomicUsize::new(0);
    let next = AtomicUsize::new(0);
    let searched = AtomicUsize::new(0);
    let workers = thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let stop = || LATEST.load(Ordering::Relaxed) != id || started.elapsed() > BUDGET || found.load(Ordering::Relaxed) >= MAX_MATCHES;
    let mut hits: Vec<(usize, FileMatches)> = thread::scope(|s| {
        let jobs: Vec<_> = (0..workers)
            .map(|_| {
                s.spawn(|| {
                    let mut mine = Vec::new();
                    loop {
                        let from = next.fetch_add(16, Ordering::Relaxed);
                        if from >= files.len() || stop() {
                            break;
                        }
                        for &(i, rel) in files.iter().skip(from).take(16) {
                            let room = MAX_MATCHES.saturating_sub(found.load(Ordering::Relaxed));
                            searched.fetch_add(1, Ordering::Relaxed);
                            if let Some((stamp, matches)) = find_in(&Path::new(&root).join(rel), &query, &re, with.as_deref(), room) {
                                found.fetch_add(matches.len(), Ordering::Relaxed);
                                mine.push((i, FileMatches { file: rel.clone(), stamp, matches }));
                            }
                        }
                    }
                    mine
                })
            })
            .collect();
        jobs.into_iter().flat_map(|j| j.join().unwrap_or_default()).collect()
    });
    hits.sort_by_key(|(i, _)| *i);
    // Workers racing for the last room can overshoot the cap a little: cut back to it, in file order.
    let mut left = MAX_MATCHES;
    let mut out = Vec::new();
    for (_, mut f) in hits {
        if left == 0 {
            break;
        }
        f.matches.truncate(left);
        left -= f.matches.len();
        out.push(f);
    }
    let partial = list_partial || left == 0 || next.load(Ordering::Relaxed) < files.len();
    Ok(Found { root, files: out, searched: searched.into_inner(), partial, stale: LATEST.load(Ordering::SeqCst) != id })
}

pub struct Pick {
    file: String,
    /// The stamp the search read: a file that no longer has it is left alone.
    stamp: String,
    /// Starts of matches the tab dropped, which stay as they are.
    skip: Vec<usize>,
}

impl Take for Pick {
    fn take(p: &mut Reader) -> Result<Self, Error> {
        let (mut file, mut stamp, mut skip) = (None, None, Vec::new());
        p.known("struct Pick", &["file", "stamp", "skip"], |p, i| {
            match i {
                0 => file = Some(String::take(p)?),
                1 => stamp = Some(String::take(p)?),
                _ => skip = Vec::take(p)?,
            }
            Ok(())
        })?;
        Ok(Pick { file: p.needs(file, "file")?, stamp: p.needs(stamp, "stamp")?, skip })
    }
}

pub struct Left {
    file: String,
    why: String,
}

object!(Left { file, why });

#[derive(Default)]
pub struct Replaced {
    /// Matches replaced, and the files they were in.
    replaced: usize,
    files: usize,
    /// Files left as they were, and why.
    skipped: Vec<Left>,
}

object!(Replaced { replaced, files, skipped });

/// `text` with each match of `re` replaced, but those starting at a byte in `skip`; and how many were.
fn replace_text(text: &str, q: &Query, re: &Finder, with: &str, skip: &HashSet<usize>) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let (mut last, mut n) = (0, 0);
    let mut found = re.matches(text, with.contains('$'));
    while let Some((start, end)) = found.next() {
        if skip.contains(&start) {
            continue;
        }
        out.push_str(&text[last..start]);
        if q.regex {
            out.push_str(&found.expand(start, end, with));
        } else {
            out.push_str(with);
        }
        last = end;
        n += 1;
    }
    out.push_str(&text[last..]);
    (out, n)
}

/// Replaces, in each picked file under `root`, the matches of `query` it held when searched, but those it
/// skips, with `with`. Keeps each file's BOM. The last replace can be undone with `undo_replace`.
pub fn replace_in_files(root: String, query: Query, with: String, files: Vec<Pick>) -> Result<Replaced, String> {
    let re = pattern(&query)?;
    let _writing = crate::WRITING.lock().unwrap();
    let mut undo = Vec::new();
    let mut done = Replaced::default();
    for pick in files {
        let path = Path::new(&root).join(&pick.file);
        let left = |why: &str| Left { file: pick.file.clone(), why: why.into() };
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                done.skipped.push(left(&e.to_string()));
                continue;
            }
        };
        if stamp(&bytes) != pick.stamp {
            done.skipped.push(left("it changed since the search"));
            continue;
        }
        let Some(text) = text_of(&bytes) else { continue };
        let (out, n) = replace_text(text, &query, &re, &with, &pick.skip.into_iter().collect());
        if n == 0 {
            continue;
        }
        let bom = if bytes.starts_with(BOM.as_bytes()) { BOM } else { "" };
        let new = [bom.as_bytes(), out.as_bytes()].concat();
        if let Err(e) = fs::write(&path, &new) {
            done.skipped.push(left(&e.to_string()));
            continue;
        }
        undo.push((path, bytes, stamp(&new)));
        done.replaced += n;
        done.files += 1;
    }
    *UNDO.lock().unwrap() = undo;
    Ok(done)
}

pub struct Restored {
    files: usize,
    /// Files changed again since the replace, which keep their newer text.
    skipped: Vec<Left>,
}

object!(Restored { files, skipped });

/// Puts back what the last replace changed, in each file that still holds what the replace wrote.
pub fn undo_replace() -> Restored {
    let _writing = crate::WRITING.lock().unwrap();
    let mut done = Restored { files: 0, skipped: Vec::new() };
    for (path, before, after) in std::mem::take(&mut *UNDO.lock().unwrap()) {
        let file = path.to_string_lossy().into_owned();
        match fs::read(&path) {
            Ok(now) if stamp(&now) == after => match fs::write(&path, before) {
                Ok(()) => done.files += 1,
                Err(e) => done.skipped.push(Left { file, why: e.to_string() }),
            },
            Ok(_) => done.skipped.push(Left { file, why: "it changed since the replace".into() }),
            Err(e) => done.skipped.push(Left { file, why: e.to_string() }),
        }
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(text: &str, case: bool, word: bool, regex: bool) -> Query {
        Query { text: text.into(), case, word, regex, files: String::new() }
    }

    #[test]
    fn patterns_follow_case_words_and_regex() {
        let text = "Foo foo food a.b axb";
        let count = |q: Query| pattern(&q).unwrap().matches(text, false).count();
        assert_eq!(count(q("foo", false, false, false)), 3);
        assert_eq!(count(q("foo", true, false, false)), 2);
        assert_eq!(count(q("foo", false, true, false)), 2);
        assert_eq!(count(q("a.b", false, false, false)), 1); // literal dot
        assert_eq!(count(q("a.b", false, false, true)), 2);
        assert!(pattern(&q("(", false, false, true)).is_err());
        // CRLF lines end before the \r.
        assert_eq!(pattern(&q("b$", false, false, true)).unwrap().matches("ab\r\nb\n", false).count(), 2);
    }

    #[test]
    fn replaces_with_groups_and_skips() {
        let re = pattern(&q(r"(\w+)@(\w+)", false, false, true)).unwrap();
        let (out, n) = replace_text("a@b c@d e@f", &q("", false, false, true), &re, "$2@$1", &[4].into());
        assert_eq!((out.as_str(), n), ("b@a c@d f@e", 2));
        // Without a regex, `$1` is plain text.
        let re = pattern(&q("x", false, false, false)).unwrap();
        assert_eq!(replace_text("x-x", &q("x", false, false, false), &re, "$1", &HashSet::new()).0, "$1-$1");
    }

    #[test]
    fn filters_paths() {
        let f = Filter::new("*.js, docs/, !test");
        assert!(f.keeps("src/app.js"));
        assert!(f.keeps("docs/readme.md"));
        assert!(!f.keeps("src/app.ts"));
        assert!(!f.keeps("src/app.test.js"));
        assert!(!f.keeps("test/app.js"));
        let f = Filter::new("src/**/*.rs");
        assert!(f.keeps("src/a/b/c.rs") && !f.keeps("lib/c.rs"));
        assert!(Filter::new("").keeps("anything"));
    }

    #[test]
    fn finds_replaces_and_undoes_only_unchanged_files() {
        let dir = std::env::temp_dir().join(format!("nook-replace-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        fs::write(&a, "\u{FEFF}old one\r\nold two old\n").unwrap();
        fs::write(&b, "old\n").unwrap();
        let query = q("old", false, true, false);
        let re = pattern(&query).unwrap();
        let (sa, ma) = find_in(&a, &query, &re, Some("new"), 100).unwrap();
        assert_eq!(ma.iter().map(|m| (m.line, m.col)).collect::<Vec<_>>(), [(1, 1), (2, 1), (2, 9)]);
        assert_eq!(ma[0].to.as_deref(), Some("new"));
        let (sb, _) = find_in(&b, &query, &re, None, 100).unwrap();
        fs::write(&b, "old, edited since\n").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let picks = vec![
            Pick { file: "a.txt".into(), stamp: sa, skip: vec![ma[1].start] },
            Pick { file: "b.txt".into(), stamp: sb, skip: vec![] },
        ];
        let done = replace_in_files(root, query, "new".into(), picks).unwrap();
        assert_eq!((done.replaced, done.files, done.skipped.len()), (2, 1, 1));
        assert_eq!(fs::read_to_string(&a).unwrap(), "\u{FEFF}new one\r\nold two new\n");
        assert_eq!(fs::read_to_string(&b).unwrap(), "old, edited since\n");
        let undone = undo_replace();
        assert_eq!((undone.files, undone.skipped.len()), (1, 0));
        assert_eq!(fs::read_to_string(&a).unwrap(), "\u{FEFF}old one\r\nold two old\n");
        fs::remove_dir_all(&dir).unwrap();
    }
}
