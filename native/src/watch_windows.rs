//! Windows tells of a tree through a `ReadDirectoryChangesW` handle on its folder, read overlapped on one
//! completion port. A handle on a folder keeps Windows from renaming the folders above it, so only a tree gets
//! one: a file or a listing would hold its folder inside someone's checkout.
use super::{Event, Kind};
use crate::sys::*;
use std::{
    collections::HashMap,
    ffi::OsString,
    io,
    os::windows::ffi::OsStringExt,
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    time::Instant,
};

/// A read's buffer in bytes, the most a network share fills.
const BUFFER: usize = 64 << 10;
const FILTER: u32 = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE;

struct Tree {
    /// Its entry, or None once removed, while its last read is still to come back.
    id: Option<u64>,
    handle: HANDLE,
    root: PathBuf,
    over: OVERLAPPED,
    buffer: Vec<u32>,
}

impl Tree {
    /// Asks for the next changes, which come to the port.
    fn read(&mut self) -> bool {
        // SAFETY: the buffer and `over` live in a Box until the read comes back.
        unsafe { ReadDirectoryChangesW(self.handle, self.buffer.as_mut_ptr().cast(), BUFFER as u32, 1, FILTER, null_mut(), &mut self.over, null()) != 0 }
    }

    /// The changes a read returned in `bytes` of the buffer: records of the next one's offset, an action, a
    /// name's length in bytes, and the name. None is more changes than the buffer held.
    fn changes(&self, bytes: u32, id: u64, out: &mut Vec<Event>) {
        let words = &self.buffer[..(bytes as usize).div_ceil(4).min(self.buffer.len())];
        if words.is_empty() {
            return out.push(Event { id, path: None, named: true, lost: false });
        }
        let mut at = 0;
        while let Some(&[next, action, len]) = words.get(at..at + 3) {
            let Some(name) = words.get(at + 3..at + 3 + (len as usize).div_ceil(4)) else { break };
            // SAFETY: `name` holds `len` bytes of UTF-16.
            let name = unsafe { std::slice::from_raw_parts(name.as_ptr().cast::<u16>(), len as usize / 2) };
            out.push(Event { id, path: Some(self.root.join(OsString::from_wide(name))), named: action != FILE_ACTION_MODIFIED, lost: false });
            if next == 0 {
                break;
            }
            at += next as usize / 4;
        }
    }
}

pub struct Watcher {
    port: HANDLE,
    /// Each tree by its key on the port.
    trees: HashMap<usize, Box<Tree>>,
    next: usize,
}

/// Wakes `wait` from another thread.
pub struct Waker(usize);

impl Waker {
    pub fn wake(&self) {
        unsafe { PostQueuedCompletionStatus(self.0 as HANDLE, 0, 0, null_mut()) };
    }
}

impl Watcher {
    pub fn new() -> io::Result<(Watcher, Waker)> {
        let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1) };
        if port.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok((Watcher { port, trees: HashMap::new(), next: 1 }, Waker(port as usize)))
    }

    /// Starts telling of entry `id`. False for a file or a listing, and for a folder that won't open.
    pub fn add(&mut self, id: u64, kind: Kind, path: &Path) -> bool {
        if kind != Kind::Tree {
            return false;
        }
        let share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
        let flags = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED;
        let handle = unsafe { CreateFileW(wide(path).as_ptr(), FILE_LIST_DIRECTORY, share, null(), OPEN_EXISTING, flags, null_mut()) };
        if handle == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut tree = Box::new(Tree { id: Some(id), handle, root: path.into(), over: OVERLAPPED::default(), buffer: vec![0; BUFFER / 4] });
        if unsafe { CreateIoCompletionPort(handle, self.port, self.next, 0) }.is_null() || !tree.read() {
            unsafe { CloseHandle(handle) };
            return false;
        }
        self.trees.insert(self.next, tree);
        self.next += 1;
        true
    }

    /// Stops telling of entry `id`. Closing the handle ends its read, which comes back to `wait` to free the tree.
    pub fn remove(&mut self, id: u64) {
        for tree in self.trees.values_mut().filter(|t| t.id == Some(id)) {
            tree.id = None;
            unsafe { CloseHandle(tree.handle) };
        }
    }

    /// Waits until `until` for a change or a wake, then adds what changed to `out`.
    pub fn wait(&mut self, until: Option<Instant>, out: &mut Vec<Event>) {
        let mut ms = until.map_or(INFINITE, |t| (t.saturating_duration_since(Instant::now()).as_millis() as u32).saturating_add(1).min(INFINITE - 1));
        loop {
            let (mut bytes, mut key, mut over) = (0, 0, null_mut());
            let ok = unsafe { GetQueuedCompletionStatus(self.port, &mut bytes, &mut key, &mut over, ms) } != 0;
            if over.is_null() {
                return; // the time is up, or a wake
            }
            ms = 0; // and whatever else has come
            let Some(tree) = self.trees.get_mut(&key) else { continue };
            let Some(id) = tree.id else {
                self.trees.remove(&key);
                continue;
            };
            if ok {
                tree.changes(bytes, id, out);
            }
            if !ok || !tree.read() {
                unsafe { CloseHandle(tree.handle) };
                self.trees.remove(&key);
                out.push(Event { id, path: None, named: true, lost: true });
            }
        }
    }
}
