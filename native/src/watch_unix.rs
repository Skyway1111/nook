//! Linux tells of a file or a listing through an inotify watch on its folder, and of a tree through one on every
//! folder in it, which takes a watch for each: a tree of more than `TREE` folders, or one the user's watches run
//! out on, is left to be polled. The numbers are the generic ones x86-64, arm64, and riscv share.
use super::{Event, Kind};
use std::{
    collections::HashMap,
    ffi::{c_char, c_int, c_uint, c_ulong, CString, OsStr, OsString},
    fs::{self, File},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    },
    path::{Path, PathBuf},
    time::Instant,
};

extern "C" {
    fn inotify_init1(flags: c_int) -> c_int;
    fn inotify_add_watch(fd: c_int, path: *const c_char, mask: u32) -> c_int;
    fn inotify_rm_watch(fd: c_int, wd: c_int) -> c_int;
    fn eventfd(initial: c_uint, flags: c_int) -> c_int;
    fn poll(fds: *mut PollFd, count: c_ulong, ms: c_int) -> c_int;
}

#[repr(C)]
struct PollFd {
    fd: c_int,
    events: i16,
    revents: i16,
}

const CLOEXEC: c_int = 0o2000000;
const NONBLOCK: c_int = 0o4000;
const POLLIN: i16 = 1;
const ENOSPC: i32 = 28;
const IN_MODIFY: u32 = 0x2;
const IN_MOVED_FROM: u32 = 0x40;
const IN_MOVED_TO: u32 = 0x80;
const IN_CREATE: u32 = 0x100;
const IN_DELETE: u32 = 0x200;
const IN_DELETE_SELF: u32 = 0x400;
const IN_MOVE_SELF: u32 = 0x800;
const IN_Q_OVERFLOW: u32 = 0x4000;
const IN_IGNORED: u32 = 0x8000;
const IN_ONLYDIR: u32 = 0x0100_0000;
const IN_ISDIR: u32 = 0x4000_0000;
/// A name in the folder was added, removed, or renamed.
const NAMED: u32 = IN_MOVED_FROM | IN_MOVED_TO | IN_CREATE | IN_DELETE;
/// The folder itself went.
const GONE: u32 = IN_DELETE_SELF | IN_MOVE_SELF;
/// The most folders a tree is watched with. Each takes one of the watches the user's programs share, 8192 on
/// some systems.
const TREE: usize = 4096;

/// What an entry watches a folder for: one file's name in it, its listing, or everything, as a tree's top folder
/// or one below it.
#[derive(PartialEq)]
enum Use {
    File(OsString),
    Dir,
    Top,
    Tree,
}

/// A watched folder. Every entry that watches it shares its one inotify watch.
struct Folder {
    path: PathBuf,
    users: Vec<(u64, Use)>,
}

pub struct Watcher {
    inotify: File,
    woken: File,
    /// Each folder by its inotify watch.
    folders: HashMap<c_int, Folder>,
}

/// Wakes `wait` from another thread, through an eventfd.
pub struct Waker(File);

impl Waker {
    pub fn wake(&self) {
        let _ = (&self.0).write(&1u64.to_ne_bytes());
    }
}

fn opened(fd: c_int) -> io::Result<File> {
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a descriptor the kernel just gave, which nothing else owns.
    Ok(unsafe { File::from_raw_fd(fd) })
}

impl Watcher {
    pub fn new() -> io::Result<(Watcher, Waker)> {
        let inotify = opened(unsafe { inotify_init1(CLOEXEC | NONBLOCK) })?;
        let woken = opened(unsafe { eventfd(0, CLOEXEC | NONBLOCK) })?;
        Ok((Watcher { inotify, woken: woken.try_clone()?, folders: HashMap::new() }, Waker(woken)))
    }

    /// Has entry `id` hear of `dir`, as `what`.
    fn watch(&mut self, dir: &Path, id: u64, what: Use) -> io::Result<()> {
        let path = CString::new(dir.as_os_str().as_bytes())?;
        let mask = IN_MODIFY | NAMED | GONE | IN_ONLYDIR;
        let wd = unsafe { inotify_add_watch(self.inotify.as_raw_fd(), path.as_ptr(), mask) };
        if wd < 0 {
            return Err(io::Error::last_os_error());
        }
        let folder = self.folders.entry(wd).or_insert_with(|| Folder { path: dir.into(), users: Vec::new() });
        if !folder.users.iter().any(|(i, u)| *i == id && *u == what) {
            folder.users.push((id, what));
        }
        Ok(())
    }

    /// Has tree `id` hear of every folder under `top`, but git's objects, which only git writes. False when the
    /// tree has more than `TREE` folders or the watches ran out.
    fn grow(&mut self, id: u64, top: &Path) -> bool {
        let mut todo = vec![top.to_path_buf()];
        let mut count = 0;
        while let Some(dir) = todo.pop() {
            for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
                if !e.file_type().is_ok_and(|t| t.is_dir()) || (e.file_name() == "objects" && dir.ends_with(".git")) {
                    continue;
                }
                let path = e.path();
                match self.watch(&path, id, Use::Tree) {
                    Ok(()) => todo.push(path),
                    Err(e) if e.raw_os_error() == Some(ENOSPC) => return false,
                    Err(_) => {} // gone since it was listed, or not ours to read
                }
                count += 1;
                if count > TREE {
                    return false;
                }
            }
        }
        true
    }

    /// Starts telling of entry `id`. False when its folder can't be watched, or all of its tree can't.
    pub fn add(&mut self, id: u64, kind: Kind, path: &Path) -> bool {
        let ok = match (kind, path.parent(), path.file_name()) {
            (Kind::File, Some(dir), Some(name)) => self.watch(dir, id, Use::File(name.into())).is_ok(),
            (Kind::File, ..) => false,
            (Kind::Dir, ..) => self.watch(path, id, Use::Dir).is_ok(),
            (Kind::Tree, ..) => self.watch(path, id, Use::Top).is_ok() && self.grow(id, path),
        };
        if !ok {
            self.remove(id);
        }
        ok
    }

    /// Stops telling of entry `id`.
    pub fn remove(&mut self, id: u64) {
        self.forget(id, Path::new(""), |_| true);
    }

    /// Takes entry `id`'s uses that `which` picks off every folder at or under `top`, and unwatches a folder
    /// nobody uses.
    fn forget(&mut self, id: u64, top: &Path, which: fn(&Use) -> bool) {
        let fd = self.inotify.as_raw_fd();
        self.folders.retain(|&wd, folder| {
            if folder.path.starts_with(top) {
                folder.users.retain(|(i, u)| *i != id || !which(u));
            }
            if folder.users.is_empty() {
                unsafe { inotify_rm_watch(fd, wd) };
            }
            !folder.users.is_empty()
        });
    }

    /// Waits until `until` for a change or a wake, then adds what changed to `out`.
    pub fn wait(&mut self, until: Option<Instant>, out: &mut Vec<Event>) {
        let ms = until.map_or(-1, |t| (t.saturating_duration_since(Instant::now()).as_millis() + 1).min(i32::MAX as u128) as c_int);
        let mut fds = [self.inotify.as_raw_fd(), self.woken.as_raw_fd()].map(|fd| PollFd { fd, events: POLLIN, revents: 0 });
        // SAFETY: two descriptors this owns, in an array of two.
        unsafe { poll(fds.as_mut_ptr(), 2, ms) };
        let _ = (&self.woken).read(&mut [0; 8]);
        let mut buffer = [0u8; 16 << 10];
        while let Ok(n @ 1..) = (&self.inotify).read(&mut buffer) {
            // Each event is a watch, a mask, a cookie, and a name's length, 4 bytes each, then the name, padded with NULs.
            let mut rest = &buffer[..n];
            while let Some((head, tail)) = rest.split_at_checked(16) {
                let word = |i: usize| u32::from_ne_bytes(head[i..i + 4].try_into().unwrap());
                let Some((name, tail)) = tail.split_at_checked(word(12) as usize) else { break };
                rest = tail;
                let name = name.split(|&b| b == 0).next().unwrap_or_default();
                self.event(word(0) as c_int, word(4), OsStr::from_bytes(name), out);
            }
        }
    }

    fn event(&mut self, wd: c_int, mask: u32, name: &OsStr, out: &mut Vec<Event>) {
        if mask & IN_Q_OVERFLOW != 0 {
            // The kernel dropped events: anything may have changed, for everyone.
            let mut ids: Vec<u64> = self.folders.values().flat_map(|f| f.users.iter().map(|(id, _)| *id)).collect();
            ids.sort_unstable();
            ids.dedup();
            return out.extend(ids.into_iter().map(|id| Event { id, path: None, named: true, lost: false }));
        }
        if mask & IN_IGNORED != 0 {
            self.folders.remove(&wd); // the kernel dropped the watch with its folder
            return;
        }
        let Some(folder) = self.folders.get(&wd) else { return };
        let path = if name.is_empty() { folder.path.clone() } else { folder.path.join(name) };
        let (named, gone) = (mask & (NAMED | GONE) != 0, mask & GONE != 0);
        let (mut lost, mut trees) = (Vec::new(), Vec::new());
        for (id, what) in &folder.users {
            let hears = match what {
                Use::Tree if gone => false, // the folder above tells of it
                Use::Tree => true,
                _ if gone => {
                    lost.push(*id);
                    false
                }
                Use::File(file) => file == name,
                Use::Dir => named,
                Use::Top => true,
            };
            if hears {
                out.push(Event { id: *id, path: Some(path.clone()), named, lost: false });
            }
            if matches!(what, Use::Top | Use::Tree) && mask & IN_ISDIR != 0 && mask & NAMED != 0 {
                trees.push(*id);
            }
        }
        // A folder that left a tree takes its watches along, and one that came is watched with all it holds.
        for id in trees {
            if mask & (IN_MOVED_FROM | IN_DELETE) != 0 {
                self.forget(id, &path, |u| *u == Use::Tree);
                continue;
            }
            let watched = self.watch(&path, id, Use::Tree);
            if watched.as_ref().is_err_and(|e| e.raw_os_error() == Some(ENOSPC)) || (watched.is_ok() && !self.grow(id, &path)) {
                lost.push(id);
            }
        }
        for id in lost {
            self.remove(id);
            out.push(Event { id, path: None, named: true, lost: true });
        }
    }
}
