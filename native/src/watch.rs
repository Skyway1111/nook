//! Says when what the page, or nook itself, watches on disk has changed, so nothing polls for it. An entry is a
//! file (written, made, or gone), a folder's listing (a child added, removed, or renamed), or a tree (anything
//! under a folder). One thread follows them all, and tells of a burst of changes once, 50 ms after its first.
//!
//! The OS tells of an entry where it can (`os`), and a file or listing inside a tree it tells of hears through
//! that tree. The rest are polled: a file or listing twice a second, by its modified time and size, and a tree,
//! which has no stats of its own, by counting as changed every 2 s.
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf, MAIN_SEPARATOR as SEP},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime},
};

#[cfg_attr(windows, path = "watch_windows.rs")]
#[cfg_attr(unix, path = "watch_unix.rs")]
mod os;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Tree,
}

/// What the OS told of entry `id`.
struct Event {
    id: u64,
    /// What changed, or None when the OS lost count and anything may have.
    path: Option<PathBuf>,
    /// A name was added, removed, or renamed, rather than a file written.
    named: bool,
    /// The OS stopped telling, as when the folder went.
    lost: bool,
}

/// Hears what changed under an entry nook itself watches: each path, or None when anything may have.
pub type Heard = fn(Option<&[PathBuf]>);

const SETTLE: Duration = Duration::from_millis(50);
const POLL: Duration = Duration::from_millis(500);
/// A polled tree counts as changed every this many polls.
const TREE_POLLS: u32 = 4;
/// A second write within a modified time's resolution keeps a file's stats, so one written this lately counts as
/// changed at every poll.
const FRESH: Duration = Duration::from_secs(2);

/// How an entry is followed: not yet, by the OS, through a tree the OS tells of, or by polling.
#[derive(PartialEq)]
enum By {
    New,
    Os,
    Tree,
    Poll,
}

struct Entry {
    kind: Kind,
    path: PathBuf,
    /// The path as entries compare (`norm`).
    key: String,
    /// The page's name for it, which `changed` gives back. nook's own has `heard` instead.
    name: String,
    heard: Option<Heard>,
    by: By,
    /// Polled: its modified time and size at the last poll.
    stat: Option<(SystemTime, u64)>,
    /// It wasn't there for the OS to watch, so the OS is asked again once it is.
    missing: bool,
}

/// What the page watches next, until the thread takes it.
static PAGE: Mutex<Option<Vec<String>>> = Mutex::new(None);
static WAKE: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// Replaces what the page watches. Each entry is `file:`, `dir:`, or `tree:` and a path, and the `changed` event
/// names the ones that changed.
pub fn page(set: Vec<String>) {
    *PAGE.lock().unwrap() = Some(set);
    if let Some(wake) = WAKE.get() {
        wake();
    }
}

/// Starts the thread, with what nook itself watches.
pub fn start(own: Vec<(Kind, PathBuf, Heard)>) {
    thread::spawn(move || {
        let (os, wake): (_, Box<dyn Fn() + Send + Sync>) = match os::Watcher::new() {
            Ok((os, waker)) => (Some(os), Box::new(move || waker.wake())),
            // Nothing to ask, as when inotify's instances have run out: every entry is polled.
            Err(_) => {
                let me = thread::current();
                (None, Box::new(move || me.unpark()))
            }
        };
        let _ = WAKE.set(wake);
        let mut watch = Watch { os, entries: BTreeMap::new(), next: 0, marks: HashMap::new() };
        for (kind, path, heard) in own {
            watch.add(kind, path, String::new(), Some(heard));
        }
        watch.run();
    });
}

struct Watch {
    os: Option<os::Watcher>,
    entries: BTreeMap<u64, Entry>,
    next: u64,
    /// The entries that changed since `tell`, nook's own with the paths, or None when anything may have.
    marks: HashMap<u64, Option<Vec<PathBuf>>>,
}

impl Watch {
    fn run(&mut self) {
        self.settle();
        let mut due = None; // when to tell of the marks
        let (mut poll, mut polls) = (Instant::now(), 0);
        let mut events = Vec::new();
        loop {
            if let Some(set) = PAGE.lock().unwrap().take() {
                self.page(set);
            }
            let polled = self.entries.values().any(|e| e.by == By::Poll);
            let until = [due, polled.then_some(poll)].into_iter().flatten().min();
            match &mut self.os {
                Some(os) => os.wait(until, &mut events),
                None => until.map_or_else(thread::park, |t| thread::park_timeout(t.saturating_duration_since(Instant::now()))),
            }
            for event in events.drain(..) {
                self.take(event);
            }
            let now = Instant::now();
            if polled && now >= poll {
                polls += 1;
                self.poll(polls % TREE_POLLS == 0);
                poll = now + POLL;
            }
            match due {
                None if !self.marks.is_empty() => due = Some(now + SETTLE),
                Some(t) if now >= t => {
                    self.tell();
                    due = None;
                }
                _ => {}
            }
        }
    }

    fn add(&mut self, kind: Kind, path: PathBuf, name: String, heard: Option<Heard>) {
        let entry = Entry { kind, key: norm(&path), path, name, heard, by: By::New, stat: None, missing: false };
        self.entries.insert(self.next, entry);
        self.next += 1;
    }

    fn page(&mut self, set: Vec<String>) {
        let gone: Vec<u64> = self.entries.iter().filter(|(_, e)| e.heard.is_none() && !set.contains(&e.name)).map(|(&id, _)| id).collect();
        for id in gone {
            if self.entries.remove(&id).is_some_and(|e| e.by == By::Os) {
                self.os.as_mut().unwrap().remove(id);
            }
            self.marks.remove(&id);
        }
        for name in set {
            let kind = match name.split_once(':') {
                Some(("file", _)) => Kind::File,
                Some(("dir", _)) => Kind::Dir,
                Some(("tree", _)) => Kind::Tree,
                _ => continue,
            };
            if !self.entries.values().any(|e| e.name == name) {
                self.add(kind, name[name.find(':').unwrap() + 1..].into(), name, None);
            }
        }
        self.settle();
    }

    /// Decides how each entry is followed, trees first, since a file or listing hears through a tree that holds
    /// it. A polled one that has turned up, which the OS is asked about again, counts as changed.
    fn settle(&mut self) {
        let ids: Vec<u64> = self.entries.keys().copied().collect();
        for trees in [true, false] {
            for &id in &ids {
                let e = &self.entries[&id];
                if (e.kind == Kind::Tree) != trees {
                    continue;
                }
                let held = !trees && self.entries.values().any(|t| t.kind == Kind::Tree && t.by == By::Os && under(&e.key, &t.key));
                let (was, exists) = (e.by == By::Poll, e.path.exists());
                let by = match (&e.by, held) {
                    (By::Os, false) | (By::Tree, true) => continue,
                    (By::Poll, false) if !(e.missing && exists) => continue,
                    (By::Os, true) => {
                        self.os.as_mut().unwrap().remove(id);
                        By::Tree
                    }
                    (_, true) => By::Tree,
                    (_, false) if self.os.as_mut().is_some_and(|os| os.add(id, e.kind, &e.path)) => By::Os,
                    (_, false) => By::Poll,
                };
                if was && !held {
                    self.mark(id, None);
                }
                let e = self.entries.get_mut(&id).unwrap();
                (e.stat, e.missing, e.by) = (stat(&e.path), !exists, by);
            }
        }
    }

    fn mark(&mut self, id: u64, path: Option<&Path>) {
        let own = self.entries.get(&id).is_some_and(|e| e.heard.is_some());
        let mark = self.marks.entry(id).or_insert_with(|| Some(Vec::new()));
        match (mark.as_mut(), path) {
            (Some(paths), Some(path)) if own => paths.push(path.into()),
            (Some(_), None) => *mark = None,
            _ => {}
        }
    }

    fn take(&mut self, event: Event) {
        let Some(e) = self.entries.get_mut(&event.id) else { return };
        if event.lost {
            (e.by, e.missing) = (By::Poll, true);
            self.mark(event.id, None);
            return self.settle();
        }
        if e.kind != Kind::Tree {
            return self.mark(event.id, event.path.as_deref());
        }
        let root = e.key.clone();
        let key = event.path.as_deref().map(norm);
        // What the tree holds hears through it: a file of its own writes, and either of a name above or beside it.
        let hears = |c: &Entry| match &key {
            None => true,
            Some(k) if c.kind == Kind::File => *k == c.key || (event.named && under(&c.key, k)),
            Some(k) => event.named && (parent(k) == c.key || under(&c.key, k)),
        };
        let inside: Vec<u64> = self.entries.iter().filter(|(_, c)| c.by == By::Tree && under(&c.key, &root) && hears(c)).map(|(&id, _)| id).collect();
        for id in inside {
            self.mark(id, None);
        }
        if key.is_none_or(|k| !noise(&k)) {
            self.mark(event.id, event.path.as_deref());
        }
    }

    fn poll(&mut self, trees: bool) {
        let (mut changed, mut found) = (Vec::new(), false);
        for (&id, e) in self.entries.iter_mut().filter(|(_, e)| e.by == By::Poll) {
            found |= e.missing && e.path.exists();
            if e.kind == Kind::Tree {
                if trees && !e.missing {
                    changed.push(id);
                }
                continue;
            }
            let now = stat(&e.path);
            if now != e.stat || now.is_some_and(|(at, _)| at.elapsed().is_ok_and(|d| d < FRESH)) {
                changed.push(id);
            }
            e.stat = now;
        }
        for id in changed {
            self.mark(id, None);
        }
        if found {
            self.settle();
        }
    }

    /// Tells the page of its entries that changed, by name, and nook's own listeners of theirs.
    fn tell(&mut self) {
        let mut names = Vec::new();
        for (id, paths) in std::mem::take(&mut self.marks) {
            let Some(e) = self.entries.get(&id) else { continue };
            match e.heard {
                Some(heard) => heard(paths.as_deref()),
                None => names.push(e.name.as_str()),
            }
        }
        if !names.is_empty() {
            crate::host::emit("changed", &crate::json::to_string(&names));
        }
    }
}

fn stat(path: &Path) -> Option<(SystemTime, u64)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok()?, if m.is_dir() { 0 } else { m.len() }))
}

/// A path as entries compare: with no separator at its end, and on Windows in one case with one kind of slash.
fn norm(path: &Path) -> String {
    let s = path.to_string_lossy();
    #[cfg(windows)]
    let s = s.replace('/', "\\").to_lowercase();
    s.trim_end_matches(SEP).to_string()
}

/// Whether `path` is `dir` or inside it.
fn under(path: &str, dir: &str) -> bool {
    path.strip_prefix(dir).is_some_and(|rest| rest.is_empty() || rest.starts_with(SEP))
}

fn parent(path: &str) -> &str {
    path.rsplit_once(SEP).map_or("", |(dir, _)| dir)
}

/// Whether a change at `path` is git's own bookkeeping: an object written or a lock taken in a git folder, or the
/// folder's own time moving as they are. A tree that counted them would have the git panel run git for each thing
/// git does.
fn noise(path: &str) -> bool {
    let mut git = path.split(SEP).skip_while(|part| *part != ".git");
    git.next().is_some() && git.next().is_none_or(|first| first == "objects" || path.ends_with(".lock"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_paths_and_knows_gits_own_writes() {
        let p = |s: &str| norm(Path::new(&s.replace('/', std::path::MAIN_SEPARATOR_STR)));
        assert!(under(&p("/a/b/c.txt"), &p("/a/b/")) && under(&p("/a/b"), &p("/a/b")) && !under(&p("/a/bc"), &p("/a/b")));
        assert_eq!(parent(&p("/a/b/c.txt")), p("/a/b"));
        assert!(noise(&p("/r/.git/objects/ab/cdef")) && noise(&p("/r/.git/index.lock")) && noise(&p("/r/.git/worktrees/w/index.lock")) && noise(&p("/r/.git")));
        assert!(!noise(&p("/r/.git/index")) && !noise(&p("/r/.git/refs/heads/main")) && !noise(&p("/r/objects/a.rs")) && !noise(&p("/r/Cargo.lock")));
    }
}
