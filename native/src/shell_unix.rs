//! The file actions shell.rs gives Windows, on Linux, through GIO and the desktop's D-Bus services: opening with the
//! desktop's default app, showing a file in the file manager, the freedesktop trash, renames that never overwrite,
//! and a cut, copy, and paste of files within nook. Desktops share no one file clipboard the way Explorer's apps do,
//! so nook keeps its own.

use std::{
    ffi::{c_char, c_int, c_uint, CStr, CString},
    fs, io,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    sync::Mutex,
};

use crate::err;
use crate::host::gtk::{
    bus_call, error_text, g_app_info_launch_default_for_uri, g_file_new_for_path, g_file_trash, g_filename_to_uri, g_free,
    g_object_unref, g_variant_new,
};

extern "C" {
    fn renameat2(from_dir: c_int, from: *const c_char, to_dir: c_int, to: *const c_char, flags: c_uint) -> c_int;
}
const AT_FDCWD: c_int = -100;
const RENAME_NOREPLACE: c_uint = 1;
const EINVAL: i32 = 22;

/// The files Cut or Copy put on nook's clipboard, and whether they were cut.
static CLIPBOARD: Mutex<Option<(Vec<String>, bool)>> = Mutex::new(None);

fn in_dir(path: &str, dir: &str) -> bool {
    Path::new(path).parent().is_some_and(|p| p == Path::new(dir))
}

/// `path` as a URI: file:// for an absolute path, and a URL as it is.
fn uri(path: &str) -> Option<CString> {
    let path = CString::new(path).ok()?;
    if !path.as_bytes().starts_with(b"/") {
        return Some(path);
    }
    unsafe {
        let uri = g_filename_to_uri(path.as_ptr(), null(), null_mut());
        if uri.is_null() {
            return None;
        }
        let owned = CStr::from_ptr(uri).to_owned();
        g_free(uri.cast());
        Some(owned)
    }
}

/// Opens `uri` with the desktop's default app for it.
fn launch(uri: &CStr) {
    unsafe { g_app_info_launch_default_for_uri(uri.as_ptr(), null_mut(), null_mut()) };
}

/// Opens a path or URL with the desktop's default app. Linux has no shared Open with dialog or Properties sheet, so
/// the file browser offers neither, and any other verb opens too. Finding the app reads the file and the desktop's
/// list of apps, so that happens on a thread of its own.
pub fn open_path(path: String, verb: Option<String>) {
    let _ = verb;
    std::thread::spawn(move || {
        if let Some(uri) = uri(&path) {
            launch(&uri);
        }
    });
}

/// Shows `path` selected in its folder, through the file manager's freedesktop interface, or where no file manager
/// answers there, opens the folder. The file manager may have to start first, so this waits on a thread of its own.
pub fn reveal(path: String) {
    std::thread::spawn(move || {
        let Some(file) = uri(&path) else { return };
        let items = [file.as_ptr(), null()];
        let shown = bus_call(c"org.freedesktop.FileManager1", c"/org/freedesktop/FileManager1", c"ShowItems", || unsafe {
            g_variant_new(c"(^ass)".as_ptr(), items.as_ptr(), c"".as_ptr())
        });
        if shown.is_err() {
            let dir = Path::new(&path).parent().unwrap_or(Path::new("/"));
            if let Some(dir) = uri(&dir.to_string_lossy()) {
                launch(&dir);
            }
        }
    });
}

/// Moves a file or folder to the trash, where the file manager can restore it. Never deletes outright: where there's
/// no trash, as on a system mount, it fails and says so.
pub fn recycle(path: String) -> Result<bool, String> {
    let path = CString::new(path).map_err(err)?;
    unsafe {
        let file = g_file_new_for_path(path.as_ptr());
        let mut error = null_mut();
        let trashed = g_file_trash(file, null_mut(), &mut error) != 0;
        g_object_unref(file);
        if trashed {
            Ok(true)
        } else {
            Err(format!("nook can't move it to the trash: {}", error_text(error)))
        }
    }
}

/// Renames `from` to `to` unless `to` is taken: the kernel checks as it renames, or on a file system that can't
/// (EINVAL, which glibc also says for a kernel without renameat2), nook checks first.
fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    let c = |p: &Path| CString::new(p.as_os_str().as_bytes()).map_err(io::Error::from);
    let (a, b) = (c(from)?, c(to)?);
    if unsafe { renameat2(AT_FDCWD, a.as_ptr(), AT_FDCWD, b.as_ptr(), RENAME_NOREPLACE) } == 0 {
        return Ok(());
    }
    match io::Error::last_os_error() {
        e if e.raw_os_error() != Some(EINVAL) => Err(e),
        _ if fs::symlink_metadata(to).is_ok() => Err(io::ErrorKind::AlreadyExists.into()),
        _ => fs::rename(from, to),
    }
}

/// Renames a file or folder. A name that's taken fails instead of replacing what has it.
pub fn rename_path(from: String, to: String) -> Result<bool, String> {
    match rename_new(Path::new(&from), Path::new(&to)) {
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            let name = Path::new(&to).file_name().unwrap_or_default().to_string_lossy();
            Err(format!("“{name}” is already there"))
        }
        renamed => renamed.map(|()| true).map_err(err),
    }
}

/// Puts files on nook's clipboard, as Copy does, or as Cut, whose paste moves them.
pub fn copy_files(paths: Vec<String>, cut: bool) -> Result<(), String> {
    *CLIPBOARD.lock().unwrap() = Some((paths, cut));
    Ok(())
}

pub fn can_paste() -> bool {
    CLIPBOARD.lock().unwrap().as_ref().is_some_and(|(paths, _)| !paths.is_empty())
}

/// The files on nook's clipboard, for a paste into a Claude tab.
pub fn copied_paths() -> Vec<String> {
    CLIPBOARD.lock().unwrap().as_ref().map(|(paths, _)| paths.clone()).unwrap_or_default()
}

/// `name` in `dir`, or when that's taken, "name - Copy", then "name - Copy (2)", and so on, as Explorer names
/// a copy beside its original.
fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if fs::symlink_metadata(&first).is_err() {
        return first;
    }
    let path = Path::new(name);
    let (stem, ext) = match (path.file_stem(), path.extension()) {
        (Some(stem), Some(ext)) if !name.starts_with('.') || stem != name => (stem.to_string_lossy(), format!(".{}", ext.to_string_lossy())),
        _ => (name.into(), String::new()),
    };
    (1..)
        .map(|n| dir.join(if n == 1 { format!("{stem} - Copy{ext}") } else { format!("{stem} - Copy ({n}){ext}") }))
        .find(|p| fs::symlink_metadata(p).is_err())
        .unwrap()
}

/// Copies a file, a link, or a folder and everything in it.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        std::os::unix::fs::symlink(fs::read_link(from)?, to)
    } else if meta.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        fs::set_permissions(to, meta.permissions())
    } else {
        fs::copy(from, to).map(drop)
    }
}

/// Moves `from` to a free name `to`: a rename, which fails rather than replace a file made there since, or across file
/// systems, a copy and then a delete of the original.
fn move_path(from: &Path, to: &Path) -> io::Result<()> {
    match rename_new(from, to) {
        Err(e) if e.raw_os_error() == Some(18) => {
            // EXDEV: another file system
            copy_tree(from, to)?;
            if fs::symlink_metadata(from)?.is_dir() { fs::remove_dir_all(from) } else { fs::remove_file(from) }
        }
        moved => moved,
    }
}

/// Pastes `paths` into `dir`: copies them, or moves them when `cut`. A taken name gets a " - Copy" name
/// instead of being overwritten.
fn paste(paths: &[String], cut: bool, dir: &str) -> Result<bool, String> {
    let paths: Vec<_> = paths.iter().filter(|p| !(cut && in_dir(p, dir))).collect(); // a cut file already there stays
    for path in &paths {
        let from = Path::new(path);
        let name = from.file_name().ok_or_else(|| format!("{path} has no name"))?.to_string_lossy();
        let to = free_name(Path::new(dir), &name);
        if to.starts_with(from) {
            return Err(format!("“{name}” can't go inside itself"));
        }
        if cut { move_path(from, &to) } else { copy_tree(from, &to) }.map_err(|e| format!("{name}: {e}"))?;
    }
    Ok(!paths.is_empty())
}

/// Pastes nook's clipboard into `dir`: copies, or after a cut, moves the files. True when it pasted any.
pub fn paste_files(dir: String) -> Result<bool, String> {
    let Some((paths, cut)) = CLIPBOARD.lock().unwrap().clone() else { return Ok(false) };
    let done = paste(&paths, cut, &dir)?;
    if done && cut {
        *CLIPBOARD.lock().unwrap() = None; // a cut pastes once
    }
    Ok(done)
}

/// Moves or copies files dropped on a folder in nook's file browser into `dir`. A taken name gets a free one
/// beside it, as a paste does, and a move of a file already there does nothing.
pub fn drop_files(paths: Vec<String>, dir: String, copy: bool) -> Result<bool, String> {
    paste(&paths, !copy, &dir)
}

#[cfg(test)]
mod tests {
    use super::{free_name, in_dir, paste};
    use std::fs;

    #[test]
    fn matches_a_parent_folder() {
        assert!(in_dir("/home/a.txt", "/home"));
        assert!(in_dir("/a.txt", "/"));
        assert!(!in_dir("/home/x/a.txt", "/home"));
        assert!(!in_dir("/Home/a.txt", "/home"));
    }

    #[test]
    fn copies_beside_itself_and_moves_without_overwriting() {
        let root = std::env::temp_dir().join(format!("nook-shell-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (a, b) = (root.join("a"), root.join("b"));
        fs::create_dir_all(a.join("sub")).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("one.txt"), "1").unwrap();
        fs::write(a.join("sub").join("deep.txt"), "d").unwrap();
        fs::write(b.join("one.txt"), "taken").unwrap();
        let at = |p: &std::path::Path| p.to_string_lossy().into_owned();

        assert!(paste(&[at(&a.join("one.txt")), at(&a.join("sub"))], false, &at(&b)).unwrap());
        assert_eq!(fs::read_to_string(b.join("one.txt")).unwrap(), "taken");
        assert_eq!(fs::read_to_string(b.join("one - Copy.txt")).unwrap(), "1");
        assert_eq!(fs::read_to_string(b.join("sub").join("deep.txt")).unwrap(), "d");
        assert_eq!(free_name(&b, "one.txt"), b.join("one - Copy (2).txt"));
        assert_eq!(free_name(&b, ".env"), b.join(".env"));

        // A cut into its own folder does nothing; elsewhere it moves.
        assert!(!paste(&[at(&a.join("one.txt"))], true, &at(&a)).unwrap());
        assert!(paste(&[at(&a.join("one.txt"))], true, &at(&b)).unwrap());
        assert!(!a.join("one.txt").exists());
        assert_eq!(fs::read_to_string(b.join("one - Copy (2).txt")).unwrap(), "1");
        assert!(paste(&[at(&a.join("sub"))], false, &at(&a.join("sub"))).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
