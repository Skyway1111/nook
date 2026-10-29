//! The git panel's commands. They run the git CLI, so hooks, signing, and credential helpers
//! behave as in a terminal. Each runs on a blocking worker: on the main thread, a status call
//! would hold up the keystrokes queued behind it.
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    thread,
};
use tauri::async_runtime::spawn_blocking;

use crate::err;

/// A diff shows this many untracked files; an unignored build folder would be thousands.
const UNTRACKED_SHOWN: usize = 100;

/// Runs git in `dir`, feeding it `input`. Ok is its output; Err is what it said went wrong.
fn run(dir: &Path, args: &[impl AsRef<OsStr>], input: Option<&str>) -> Result<String, String> {
    // Nobody can answer a hidden prompt: fail, don't hang. An editor of ":" is one git never opens, so
    // continuing a merge or rebase keeps the message git wrote.
    crate::run(Command::new("git").current_dir(dir).args(args).env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", ":"), input)
}

/// Any git command in `dir`: staging, commits, branches, sync, and GitHub sign-in through
/// Git Credential Manager, which keeps the token to itself.
#[tauri::command]
pub async fn git(dir: String, args: Vec<String>, input: Option<String>) -> Result<String, String> {
    spawn_blocking(move || run(Path::new(&dir), &args, input.as_deref())).await.map_err(err)?
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    root: String,
    /// None while HEAD is detached.
    branch: Option<String>,
    /// None before the first commit.
    oid: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    /// Where a branch without an upstream would publish.
    remote: Option<String>,
    /// The last commit's subject.
    subject: String,
    /// What git is in the middle of: merge, rebase, cherry-pick, revert, or am.
    operation: Option<&'static str>,
    /// Stashed changes, newest first.
    stashes: Vec<Stash>,
    changes: Vec<Change>,
}

#[derive(Serialize, Debug, PartialEq)]
struct Stash {
    oid: String,
    /// As `git stash list` words it: "WIP on main: 1a2b3c4 Subject", or "On main: " and the name given.
    message: String,
    /// Seconds since 1970.
    time: u64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Change {
    /// Relative to the root with `/`, as git writes it. An untracked folder ends in `/`.
    path: String,
    /// A rename's old path.
    from: Option<String>,
    /// M modified, A added, D deleted, R renamed, U conflicted, ? untracked.
    kind: char,
    staged: Staged,
    added: u32,
    removed: u32,
}

#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Staged {
    Off,
    Mixed,
    On,
}

/// The repository holding `path`, found by its `.git` (a folder, or a file in worktrees and submodules).
fn repo_root(path: &Path) -> Option<&Path> {
    if !path.is_absolute() {
        return None;
    }
    path.ancestors().find(|p| p.join(".git").exists())
}

/// The repository holding `path`, or None outside one.
#[tauri::command]
pub async fn git_status(path: String) -> Result<Option<Status>, String> {
    spawn_blocking(move || {
        let Some(root) = repo_root(Path::new(&path)) else { return Ok(None) };
        // Claude may run git in this repo meanwhile: reads take no locks.
        let read = |args: &[&str]| run(root, &[&["--no-optional-locks"], args].concat(), None);
        let (status, numstat, remotes) = thread::scope(|s| {
            let numstat = s.spawn(|| read(&["diff", "HEAD", "--numstat", "-z"]));
            let remotes = s.spawn(|| read(&["remote"]));
            let status = read(&["status", "--porcelain=v2", "-z", "--branch"]);
            (status, numstat.join().unwrap(), remotes.join().unwrap())
        });
        let mut s = parse_status(&status?, &numstat.unwrap_or_default());
        s.root = root.to_string_lossy().into_owned();
        let remotes = remotes.unwrap_or_default();
        s.remote = remotes.lines().find(|r| *r == "origin").or(remotes.lines().next()).map(String::from);
        if let Some(oid) = &s.oid {
            s.subject = subject(root, oid);
        }
        let dir = git_dir(root);
        s.operation = operation(&dir);
        // A worktree's git folder names the one it shares stashes with.
        let common = std::fs::read_to_string(dir.join("commondir")).map_or(dir.clone(), |c| dir.join(c.trim()));
        s.stashes = std::fs::read_to_string(common.join("logs/refs/stash")).map(|log| parse_stashes(&log)).unwrap_or_default();
        Ok(Some(s))
    })
    .await
    .map_err(err)?
}

/// The git folder of the repository at `root`. In a worktree or submodule, `.git` is a file that names it.
fn git_dir(root: &Path) -> PathBuf {
    let dot = root.join(".git");
    match std::fs::read_to_string(&dot) {
        Ok(file) => file.strip_prefix("gitdir:").map_or(dot, |dir| root.join(dir.trim())),
        Err(_) => dot,
    }
}

/// What git is in the middle of, from the files it keeps in its git folder `dir` meanwhile: a few file
/// checks, no process.
fn operation(dir: &Path) -> Option<&'static str> {
    let has = |name: &str| dir.join(name).exists();
    if has("rebase-merge") {
        Some("rebase")
    } else if has("rebase-apply") {
        Some(if has("rebase-apply/applying") { "am" } else { "rebase" })
    } else if has("MERGE_HEAD") {
        Some("merge")
    } else if has("CHERRY_PICK_HEAD") {
        Some("cherry-pick")
    } else if has("REVERT_HEAD") {
        Some("revert")
    } else {
        None
    }
}

/// The stash's reflog, oldest first, as stashes newest first. Each line is the old and new id, who and
/// when, a tab, and the message.
fn parse_stashes(log: &str) -> Vec<Stash> {
    log.lines()
        .rev()
        .filter_map(|line| {
            let (head, message) = line.split_once('\t')?;
            let oid = head.split(' ').nth(1)?.to_string();
            // `name <email> time zone`: the time is the next-to-last field.
            let time = head.rsplit(' ').nth(1)?.parse().ok()?;
            Some(Stash { oid, message: message.into(), time })
        })
        .collect()
}

/// Commit subjects by id. A commit never changes, so an entry never goes stale.
static SUBJECTS: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

fn subject(root: &Path, oid: &str) -> String {
    if let Some(s) = SUBJECTS.lock().unwrap().get(oid) {
        return s.clone();
    }
    let s = run(root, &["log", "-1", "--format=%s", oid], None).unwrap_or_default().trim().to_string();
    SUBJECTS.lock().unwrap().insert(oid.into(), s.clone());
    s
}

/// Parses `status --porcelain=v2 -z --branch`, with line counts from `diff --numstat -z`.
fn parse_status(status: &str, numstat: &str) -> Status {
    let counts = parse_numstat(numstat);
    let mut s = Status::default();
    let mut records = status.split('\0');
    while let Some(record) = records.next() {
        let Some((tag, rest)) = record.split_once(' ') else { continue };
        let (path, from, kind, staged) = match tag {
            "#" => {
                match rest.split_once(' ') {
                    Some(("branch.oid", oid)) => s.oid = (oid != "(initial)").then(|| oid.into()),
                    Some(("branch.head", head)) => s.branch = (head != "(detached)").then(|| head.into()),
                    Some(("branch.upstream", up)) => s.upstream = Some(up.into()),
                    Some(("branch.ab", ab)) => {
                        let mut n = ab.split(' ').map(|n| n.get(1..).and_then(|n| n.parse().ok()).unwrap_or(0));
                        (s.ahead, s.behind) = (n.next().unwrap_or(0), n.next().unwrap_or(0));
                    }
                    _ => {}
                }
                continue;
            }
            "?" => (rest, None, '?', Staged::Off),
            "1" | "2" | "u" => {
                // Fields before the path: XY and 6 more, then a rename score, or 8 for a conflict.
                let before = match tag { "1" => 7, "2" => 8, _ => 9 };
                let fields: Vec<&str> = rest.splitn(before + 1, ' ').collect();
                let (Some(xy), Some(path)) = (fields.first(), fields.get(before)) else { continue };
                let &[x, y] = xy.as_bytes() else { continue };
                let kind = match tag {
                    "2" => 'R',
                    "u" => 'U',
                    _ if xy.contains('D') => 'D',
                    _ if xy.contains('A') => 'A',
                    _ => 'M',
                };
                let staged = match (x, y) {
                    _ if tag == "u" => Staged::Off,
                    (b'.', _) => Staged::Off,
                    (_, b'.') => Staged::On,
                    _ => Staged::Mixed,
                };
                let from = (tag == "2").then(|| records.next().unwrap_or_default().to_string());
                (*path, from, kind, staged)
            }
            _ => continue,
        };
        let (added, removed) = counts.get(path).copied().unwrap_or_default();
        s.changes.push(Change { path: path.into(), from, kind, staged, added, removed });
    }
    s
}

/// `diff --numstat -z`: lines added and removed by path. A rename names old and new paths
/// in the two records after its own; binary files count as zero.
fn parse_numstat(out: &str) -> HashMap<&str, (u32, u32)> {
    let mut counts = HashMap::new();
    let mut records = out.split('\0');
    while let Some(record) = records.next() {
        let mut f = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (f.next(), f.next(), f.next()) else { continue };
        let path = if path.is_empty() { records.nth(1).unwrap_or_default() } else { path };
        counts.insert(path, (added.parse().unwrap_or(0), removed.parse().unwrap_or(0)));
    }
    counts
}

/// What changed under `path`, as a unified diff; `""` is the whole repo. Staged: the index against the last
/// commit. Unstaged: the working tree against the index, with untracked files as added.
#[tauri::command]
pub async fn git_diff(root: String, path: String, staged: bool) -> Result<String, String> {
    spawn_blocking(move || {
        let root = Path::new(&root);
        let spec = if path.is_empty() { "." } else { &path };
        // The user's diff settings can't change the shape git.js parses: no external tool, color, or odd prefixes.
        let read = |args: &[&str]| {
            let options = ["--no-optional-locks", "-c", "core.quotepath=false", "-c", "diff.noprefix=false"];
            run(root, &[&options[..], args, &["--", spec]].concat(), None)
        };
        let diff = ["diff", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
        if staged {
            return read(&[&diff[..], &["--cached"]].concat());
        }
        let (tracked, untracked) = thread::scope(|s| {
            let untracked = s.spawn(|| read(&["ls-files", "--others", "--exclude-standard", "-z"]));
            (read(&diff), untracked.join().unwrap())
        });
        let mut diff = tracked?;
        let untracked = untracked?;
        let files: Vec<&str> = untracked.split('\0').filter(|f| !f.is_empty()).collect();
        for file in files.iter().take(UNTRACKED_SHOWN) {
            let full = root.join(file);
            diff += &new_file(file, executable(&full), crate::read_text(full.to_string_lossy().into_owned()));
        }
        if files.len() > UNTRACKED_SHOWN {
            diff += &format!("\\ nook left out {} more untracked files\n", files.len() - UNTRACKED_SHOWN);
        }
        Ok(diff)
    })
    .await
    .map_err(err)?
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}
#[cfg(not(unix))]
fn executable(_: &Path) -> bool {
    false
}

/// An untracked file as git would diff it once added, so a patch of some of its lines stages them.
/// A `\` line says why it can't be shown.
fn new_file(path: &str, executable: bool, text: Result<String, String>) -> String {
    let mode = if executable { "100755" } else { "100644" };
    let mut out = format!("diff --git a/{path} b/{path}\nnew file mode {mode}\n--- /dev/null\n+++ b/{path}\n");
    match text {
        Ok(text) if text.is_empty() => {}
        Ok(text) => {
            out += &format!("@@ -0,0 +1,{} @@\n", text.lines().count());
            for line in text.lines() {
                out += "+";
                out += line;
                out += "\n";
            }
            if !text.ends_with('\n') {
                out += "\\ No newline at end of file\n";
            }
        }
        Err(e) => out += &format!("\\ nook can't show this file: {e}\n"),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(path: &str, kind: char, staged: Staged, added: u32, removed: u32) -> Change {
        Change { path: path.into(), from: None, kind, staged, added, removed }
    }

    #[test]
    fn parses_branch_state_and_every_kind_of_change() {
        let status = [
            "# branch.oid e228a7209d80f6d6f3de45ce8c52857d3c04aeff",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaa aaa to-do.md",
            "1 A. N... 000000 100644 100644 000 bbb new file.md",
            "1 MM N... 100644 100644 100644 ccc ddd src/both.rs",
            "1 .D N... 100644 100644 000000 eee eee gone.txt",
            "2 R. N... 100644 100644 100644 fff fff R100 docs/after.md",
            "docs/before.md",
            "u UU N... 100644 100644 100644 100644 g1 g2 g3 conflict.rs",
            "? test.md",
            "? build/",
            "",
        ]
        .join("\0");
        let numstat = ["1\t1\tto-do.md", "3\t0\tnew file.md", "-\t-\tsrc/both.rs", "0\t0\t", "docs/before.md", "docs/after.md", ""].join("\0");
        let s = parse_status(&status, &numstat);
        assert_eq!(
            (s.branch.as_deref(), s.upstream.as_deref(), s.ahead, s.behind),
            (Some("main"), Some("origin/main"), 2, 1)
        );
        assert_eq!(s.oid.as_deref(), Some("e228a7209d80f6d6f3de45ce8c52857d3c04aeff"));
        let renamed = Change { from: Some("docs/before.md".into()), ..change("docs/after.md", 'R', Staged::On, 0, 0) };
        assert_eq!(
            s.changes,
            [
                change("to-do.md", 'M', Staged::Off, 1, 1),
                change("new file.md", 'A', Staged::On, 3, 0),
                change("src/both.rs", 'M', Staged::Mixed, 0, 0),
                change("gone.txt", 'D', Staged::Off, 0, 0),
                renamed,
                change("conflict.rs", 'U', Staged::Off, 0, 0),
                change("test.md", '?', Staged::Off, 0, 0),
                change("build/", '?', Staged::Off, 0, 0),
            ]
        );
    }

    #[test]
    fn reads_a_repo_with_no_commits_and_a_detached_head() {
        let s = parse_status("# branch.oid (initial)\0# branch.head main\0", "");
        assert_eq!((s.oid, s.branch.as_deref()), (None, Some("main")));
        assert_eq!(parse_status("# branch.oid abc\0# branch.head (detached)\0", "").branch, None);
    }

    #[test]
    fn an_untracked_file_diffs_as_all_added() {
        let head = "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n";
        assert_eq!(new_file("a.txt", false, Ok("one\ntwo\n".into())), format!("{head}@@ -0,0 +1,2 @@\n+one\n+two\n"));
        assert!(new_file("run.sh", true, Ok("x".into())).contains("new file mode 100755"));
        assert!(new_file("a.txt", false, Ok("one".into())).ends_with("+one\n\\ No newline at end of file\n"));
        assert_eq!(new_file("a.txt", false, Ok(String::new())), head);
        assert!(new_file("a.png", false, Err("it isn't text".into())).ends_with("\\ nook can't show this file: it isn't text\n"));
    }

    #[test]
    fn finds_the_repo_above_a_file_and_none_for_a_relative_path() {
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        let file = here.join("src").join("git.rs");
        let root = repo_root(&file).unwrap();
        assert!(root.join(".git").exists() && here.starts_with(root));
        assert_eq!(repo_root(Path::new("src")), None);
    }

    /// Stages through stdin, commits, then edits: what the panel does, against real git.
    #[test]
    fn stages_commits_and_reports_against_real_git() {
        let dir = std::env::temp_dir().join(format!("nook-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str], input: Option<&str>| run(&dir, args, input);
        git(&["init", "-q", "-b", "main"], None).unwrap();
        std::fs::write(dir.join("a b.txt"), "one\n").unwrap();
        git(&["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], Some("a b.txt")).unwrap();
        let read = |args: &[&str]| run(&dir, args, None).unwrap();
        let s = parse_status(&read(&["status", "--porcelain=v2", "-z", "--branch"]), "");
        assert_eq!(s.changes, [change("a b.txt", 'A', Staged::On, 0, 0)]);

        let id = ["-c", "user.name=nook", "-c", "user.email=nook@example.com"];
        git(&[&id[..], &["commit", "-q", "-F", "-"]].concat(), Some("First\n\nBody")).unwrap();
        std::fs::write(dir.join("a b.txt"), "uno\n").unwrap();
        let numstat = read(&["diff", "HEAD", "--numstat", "-z"]);
        let s = parse_status(&read(&["status", "--porcelain=v2", "-z", "--branch"]), &numstat);
        assert_eq!(s.changes, [change("a b.txt", 'M', Staged::Off, 1, 1)]);
        assert_eq!(subject(&dir, s.oid.as_deref().unwrap()), "First");
        assert!(git(&["commit", "-q", "-m", "x"], None).is_err()); // nothing staged

        // A merge that conflicts, then carries on once settled, with the message git wrote.
        assert_eq!(operation(&git_dir(&dir)), None);
        git(&[&id[..], &["commit", "-qam", "Spanish"]].concat(), None).unwrap();
        git(&["switch", "-qc", "french", "HEAD~1"], None).unwrap();
        std::fs::write(dir.join("a b.txt"), "un\n").unwrap();
        git(&[&id[..], &["commit", "-qam", "French"]].concat(), None).unwrap();
        git(&["switch", "-q", "main"], None).unwrap();
        assert!(git(&[&id[..], &["merge", "french"]].concat(), None).is_err());
        assert_eq!(operation(&git_dir(&dir)), Some("merge"));
        let s = parse_status(&read(&["status", "--porcelain=v2", "-z", "--branch"]), "");
        assert_eq!(s.changes, [change("a b.txt", 'U', Staged::Off, 0, 0)]);
        std::fs::write(dir.join("a b.txt"), "uno, un\n").unwrap();
        git(&["add", "a b.txt"], None).unwrap();
        git(&[&id[..], &["commit", "--no-edit"]].concat(), None).unwrap();
        assert_eq!(operation(&git_dir(&dir)), None);
        assert_eq!(subject(&dir, read(&["rev-parse", "HEAD"]).trim()), "Merge branch 'french'");

        // Stashes, newest first, as `git stash list` has them.
        let stashes = || parse_stashes(&std::fs::read_to_string(git_dir(&dir).join("logs/refs/stash")).unwrap_or_default());
        assert_eq!(stashes(), []);
        std::fs::write(dir.join("a b.txt"), "dos\n").unwrap();
        git(&[&id[..], &["stash", "push", "-q"]].concat(), None).unwrap();
        std::fs::write(dir.join("a b.txt"), "tres\n").unwrap();
        git(&[&id[..], &["stash", "push", "-q", "-m", "Three"]].concat(), None).unwrap();
        let list = stashes();
        let messages: Vec<&str> = list.iter().map(|s| s.message.as_str()).collect();
        assert_eq!(messages[0], "On main: Three");
        assert!(messages[1].starts_with("WIP on main: "), "{}", messages[1]);
        assert_eq!(list[0].oid, read(&["rev-parse", "stash@{0}"]).trim());
        assert!(list[0].time > 1_700_000_000);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
