//! Quick open's text search, `%` in the box: the lines under quick open's folder that hold the text typed.
//! It reads the files quick open lists, on every core, and stops at a few hundred lines, after a few
//! seconds, or as soon as a newer search starts.
use crate::index::index_files;
use serde::Serialize;
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

/// More lines than anyone reads through.
const MAX_HITS: usize = 300;
/// A file bigger than this is data or a build product, not something to search line by line.
const MAX_FILE: u64 = 2 << 20;
const BUDGET: Duration = Duration::from_secs(3);
/// The file list is reused for searches this close together, as typing makes them.
const LIST_FRESH: Duration = Duration::from_secs(5);
/// A shown line is cut to about this many characters around its match.
const SHOWN: usize = 160;

/// The newest search; an older one stops when it sees this move.
static LATEST: AtomicU64 = AtomicU64::new(0);
/// The last file list: the folder asked about, when, its root, and its files.
type List = (String, Instant, String, Arc<Vec<String>>);
static LIST: Mutex<Option<List>> = Mutex::new(None);

#[derive(Serialize, Debug)]
pub struct Hit {
    /// Relative to the root, with `/` between folders.
    file: String,
    line: u32,
    /// 1-based, in characters.
    pub(crate) col: u32,
    /// The line, trimmed and cut to about SHOWN characters.
    pub(crate) text: String,
    /// Where the match starts in `text`, and how long it is, in characters.
    pub(crate) at: u32,
    pub(crate) len: u32,
}

#[derive(Serialize)]
pub struct Found {
    root: String,
    hits: Vec<Hit>,
    /// Files read.
    searched: usize,
    /// Whether it stopped early: at MAX_HITS, at the time budget, or because the file list did.
    partial: bool,
    /// A newer search started, so this one's result is to be dropped.
    stale: bool,
}

/// The lines under `dir`'s repository, or `dir` outside one, that hold `query`. A query with a capital letter
/// matches case exactly; one without ignores the case of ASCII letters.
#[tauri::command(async)]
pub fn search_text(dir: String, query: String) -> Result<Found, String> {
    let id = LATEST.fetch_add(1, Ordering::SeqCst) + 1;
    let (root, files, list_partial) = list(&dir)?;
    let started = Instant::now();
    let fold = !query.chars().any(char::is_uppercase);
    let needle = if fold { query.to_ascii_lowercase() } else { query.clone() };
    let found = AtomicUsize::new(0);
    let next = AtomicUsize::new(0);
    let searched = AtomicUsize::new(0);
    let workers = thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let stop = || LATEST.load(Ordering::Relaxed) != id || started.elapsed() > BUDGET || found.load(Ordering::Relaxed) >= MAX_HITS;
    let mut hits: Vec<(usize, Hit)> = thread::scope(|s| {
        let jobs: Vec<_> = (0..workers)
            .map(|_| {
                s.spawn(|| {
                    let mut mine = Vec::new();
                    // Files are taken in small runs, in index order, so the first files fill first.
                    loop {
                        let from = next.fetch_add(16, Ordering::Relaxed);
                        if from >= files.len() || stop() {
                            break;
                        }
                        for (i, rel) in files.iter().enumerate().skip(from).take(16) {
                            let got = search_file(&Path::new(&root).join(rel), &needle, fold);
                            searched.fetch_add(1, Ordering::Relaxed);
                            found.fetch_add(got.len(), Ordering::Relaxed);
                            mine.extend(got.into_iter().map(|mut h| {
                                h.file = rel.clone();
                                (i, h)
                            }));
                        }
                    }
                    mine
                })
            })
            .collect();
        jobs.into_iter().flat_map(|j| j.join().unwrap_or_default()).collect()
    });
    hits.sort_by_key(|(i, h)| (*i, h.line));
    let partial = list_partial || hits.len() >= MAX_HITS || next.load(Ordering::Relaxed) < files.len();
    hits.truncate(MAX_HITS);
    Ok(Found {
        root,
        hits: hits.into_iter().map(|(_, h)| h).collect(),
        searched: searched.into_inner(),
        partial,
        stale: LATEST.load(Ordering::SeqCst) != id,
    })
}

/// Quick open's file list for `dir`, reused while it's fresh.
pub(crate) fn list(dir: &str) -> Result<(String, Arc<Vec<String>>, bool), String> {
    let mut cached = LIST.lock().map_err(|e| e.to_string())?;
    if let Some((asked, at, root, files)) = cached.as_ref() {
        if asked == dir && at.elapsed() < LIST_FRESH {
            return Ok((root.clone(), files.clone(), false));
        }
    }
    let index = index_files(dir.to_string())?;
    let files = Arc::new(index.files);
    *cached = Some((dir.to_string(), Instant::now(), index.root.clone(), files.clone()));
    Ok((index.root, files, index.partial))
}

/// The lines of one file that hold `needle`, each once, at its first match. Skips big and binary files.
fn search_file(path: &Path, needle: &str, fold: bool) -> Vec<Hit> {
    let mut hits = Vec::new();
    if needle.is_empty() || fs::metadata(path).map_or(true, |m| !m.is_file() || m.len() > MAX_FILE) {
        return hits;
    }
    let Ok(bytes) = fs::read(path) else { return hits };
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return hits; // binary
    }
    let text = String::from_utf8_lossy(&bytes);
    // ASCII case folding keeps every byte offset, so a match in `hay` is the same span of `text`.
    let hay = if fold { std::borrow::Cow::Owned(text.to_ascii_lowercase()) } else { text.clone() };
    let (mut line, mut counted, mut last_line) = (1u32, 0usize, 0u32);
    for (at, _) in hay.match_indices(needle) {
        line += hay[counted..at].bytes().filter(|&b| b == b'\n').count() as u32;
        counted = at;
        if line == last_line {
            continue;
        }
        last_line = line;
        let start = text[..at].rfind('\n').map_or(0, |i| i + 1);
        let end = text[at..].find('\n').map_or(text.len(), |i| at + i);
        hits.push(shown(&text[start..end], at - start, needle.len(), line, text[start..at].chars().count() as u32 + 1));
        if hits.len() >= MAX_HITS {
            break;
        }
    }
    hits
}

/// A hit for the match at byte `at` of `line`, `len` bytes long, at column `col`, with the line trimmed and cut
/// around it.
pub(crate) fn shown(line: &str, at: usize, len: usize, number: u32, col: u32) -> Hit {
    let lead = line.len() - line.trim_start().len();
    let body = line.trim();
    let start = at.saturating_sub(lead).min(body.len());
    let end = (at + len).saturating_sub(lead).min(body.len());
    // A long line keeps a little of what comes before its match.
    let from = body[..start].char_indices().rev().nth(SHOWN / 3 - 1).map_or(0, |(i, _)| i);
    let cut: String = body[from..].chars().take(SHOWN).collect();
    let mark = body[from..start].chars().count() + usize::from(from > 0);
    Hit {
        file: String::new(),
        line: number,
        col,
        text: if from > 0 { format!("…{cut}") } else { cut },
        at: mark as u32,
        len: body[start..end].chars().count() as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_each_line_once_with_its_column() {
        let dir = std::env::temp_dir().join(format!("nook-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, "one Needle needle\n  two\r\n\tthe needle é\nnone\n").unwrap();
        let hits = search_file(&file, "needle", true);
        assert_eq!(hits.iter().map(|h| (h.line, h.col)).collect::<Vec<_>>(), [(1, 5), (3, 6)]);
        assert_eq!((hits[1].text.as_str(), hits[1].at, hits[1].len), ("the needle é", 4, 6));
        // A capital letter matches case exactly.
        assert_eq!(search_file(&file, "Needle", false).len(), 1);
        fs::write(&file, b"needle\0binary").unwrap();
        assert!(search_file(&file, "needle", true).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cuts_a_long_line_around_its_match() {
        let line = format!("{}needle{}", "x".repeat(500), "y".repeat(500));
        let hit = shown(&line, 500, 6, 7, 501);
        assert_eq!(hit.col, 501);
        assert!(hit.text.starts_with('…'));
        assert_eq!(hit.text.chars().count(), SHOWN + 1);
        let marked: String = hit.text.chars().skip(hit.at as usize).take(hit.len as usize).collect();
        assert_eq!(marked, "needle");
    }
}
