//! Quick open's list of files: every file under a folder, built only when quick open asks for it.
use crate::run;
use crate::json::object;
use std::{
    fs,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

/// More files than anyone scrolls through; past this the list says it stopped.
const LIMIT: usize = 200_000;
/// A walk of a folder outside a repository stops here, so a slow disk never holds quick open for long.
const BUDGET: Duration = Duration::from_secs(4);
/// Folders a walk outside a repository skips: build output and package caches, which a repository's
/// `.gitignore` would hide anyway.
const SKIP: &[&str] = &["node_modules", "target", "__pycache__", "bower_components", "venv"];

pub struct Index {
    /// The folder the paths are relative to: the repository's top folder, or the folder asked about.
    pub(crate) root: String,
    /// Relative paths, with `/` between folders on every system.
    pub(crate) files: Vec<String>,
    /// Whether the list stopped at the limit or the time budget.
    pub(crate) partial: bool,
}

object!(Index { root, files, partial });

/// Every file under `dir`'s repository, as git sees it: tracked files and untracked ones that aren't
/// ignored. Outside a repository, every file under `dir` that the file browser would show.
pub fn index_files(dir: String) -> Result<Index, String> {
    if !Path::new(&dir).is_dir() {
        return Err(format!("{dir} is not a folder"));
    }
    if let Ok(top) = run(Command::new("git").args(["-C", &dir, "rev-parse", "--show-toplevel"]), None) {
        let root = top.trim().to_string();
        let listed = run(
            Command::new("git").args(["-C", &root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
            None,
        );
        if let Ok(out) = listed {
            let mut files: Vec<String> = out.split('\0').filter(|f| !f.is_empty()).map(String::from).collect();
            files.dedup(); // a file with unmerged stages lists once per stage
            let partial = files.len() > LIMIT;
            files.truncate(LIMIT);
            #[cfg(windows)]
            let root = root.replace('/', "\\"); // git prints C:/Users/...
            return Ok(Index { root, files, partial });
        }
    }
    let (files, partial) = walk(Path::new(&dir));
    Ok(Index { root: dir, files, partial })
}

/// Breadth first, so a budget that runs out still has the files nearest the top.
fn walk(top: &Path) -> (Vec<String>, bool) {
    let started = Instant::now();
    let mut files = Vec::new();
    let mut queue = std::collections::VecDeque::from([String::new()]);
    while let Some(rel) = queue.pop_front() {
        if files.len() >= LIMIT || started.elapsed() > BUDGET {
            return (files, true);
        }
        let Ok(entries) = fs::read_dir(top.join(&rel)) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || hidden(&e) {
                continue;
            }
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            // A link to a folder isn't followed, so a loop of links can't hold the walk.
            match e.file_type() {
                Ok(t) if t.is_dir() => {
                    if !SKIP.contains(&name.as_str()) {
                        queue.push_back(path)
                    }
                }
                Ok(_) => files.push(path),
                Err(_) => {}
            }
        }
    }
    (files, false)
}

#[cfg(windows)]
fn hidden(e: &fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;
    e.metadata().is_ok_and(|m| m.file_attributes() & HIDDEN_OR_SYSTEM != 0)
}

#[cfg(not(windows))]
fn hidden(_: &fs::DirEntry) -> bool {
    false // a dot already hid it
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_breadth_first_and_skips_hidden_and_build_folders() {
        let top = std::env::temp_dir().join(format!("nook-index-{}", std::process::id()));
        let _ = fs::remove_dir_all(&top);
        for dir in ["a/b", ".git", "node_modules/x", "c"] {
            fs::create_dir_all(top.join(dir)).unwrap();
        }
        for file in ["top.txt", "a/one.rs", "a/b/two.rs", ".hidden", ".git/HEAD", "node_modules/x/i.js", "c/three.md"] {
            fs::write(top.join(file), "").unwrap();
        }
        let (mut files, partial) = walk(&top);
        assert!(!partial);
        assert_eq!(files[0], "top.txt"); // the top folder's files come before any folder's
        files.sort();
        assert_eq!(files, ["a/b/two.rs", "a/one.rs", "c/three.md", "top.txt"]);
        fs::remove_dir_all(&top).unwrap();
    }
}
