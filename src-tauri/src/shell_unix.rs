//! The file actions shell.rs gives Windows, on Linux: opening with the desktop's default app, the
//! freedesktop trash through `gio`, renames that never overwrite, and a cut, copy, and paste of files
//! within nook. Desktops share no one file clipboard the way Explorer's apps do, so nook keeps its own.

use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};
use tauri::async_runtime::spawn_blocking;

use crate::err;

/// The files Cut or Copy put on nook's clipboard, and whether they were cut.
static CLIPBOARD: Mutex<Option<(Vec<String>, bool)>> = Mutex::new(None);

fn in_dir(path: &str, dir: &str) -> bool {
    Path::new(path).parent().is_some_and(|p| p == Path::new(dir))
}

/// Starts `program` on `args` without waiting for it, and with nothing of nook's on its stdio.
fn launch(program: &str, args: &[&str]) -> Result<(), String> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
        .map_err(|e| format!("can't run {program}: {e}"))
}

/// Opens a path or URL with the desktop's default app. Linux has no shared Open with dialog or
/// Properties sheet, so the file browser offers neither, and any other verb opens too.
#[tauri::command]
pub fn open_path(path: String, verb: Option<String>) {
    let _ = verb;
    let _ = launch("xdg-open", &[&path]);
}

/// Shows the folder that holds `path` in the file manager.
#[tauri::command]
pub fn reveal(path: String) {
    let dir = Path::new(&path).parent().unwrap_or(Path::new("/"));
    let _ = launch("xdg-open", &[&dir.to_string_lossy()]);
}

/// Moves a file or folder to the trash, where the file manager can restore it. Never deletes outright:
/// without `gio`, it fails and says so.
#[tauri::command]
pub async fn recycle(path: String) -> Result<bool, String> {
    spawn_blocking(move || {
        let mut cmd = Command::new("gio");
        cmd.args(["trash", "--"]).arg(&path);
        crate::run(&mut cmd, None).map(|_| true).map_err(|e| format!("nook can't move it to the trash: {e}"))
    })
    .await
    .map_err(err)?
}

/// Renames a file or folder. A name that's taken fails instead of replacing what has it.
#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<bool, String> {
    spawn_blocking(move || {
        if fs::symlink_metadata(&to).is_ok() {
            let name = Path::new(&to).file_name().unwrap_or_default().to_string_lossy();
            return Err(format!("“{name}” is already there"));
        }
        fs::rename(&from, &to).map(|()| true).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Puts files on nook's clipboard, as Copy does, or as Cut, whose paste moves them.
#[tauri::command]
pub fn copy_files(paths: Vec<String>, cut: bool) -> Result<(), String> {
    *CLIPBOARD.lock().unwrap() = Some((paths, cut));
    Ok(())
}

#[tauri::command]
pub fn can_paste() -> bool {
    CLIPBOARD.lock().unwrap().as_ref().is_some_and(|(paths, _)| !paths.is_empty())
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

/// Moves `from` to `to`: a rename, or across file systems, a copy and then a delete of the original.
fn move_path(from: &Path, to: &Path) -> io::Result<()> {
    match fs::rename(from, to) {
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
#[tauri::command]
pub async fn paste_files(dir: String) -> Result<bool, String> {
    let Some((paths, cut)) = CLIPBOARD.lock().unwrap().clone() else { return Ok(false) };
    let done = spawn_blocking(move || paste(&paths, cut, &dir)).await.map_err(err)??;
    if done && cut {
        *CLIPBOARD.lock().unwrap() = None; // a cut pastes once
    }
    Ok(done)
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
