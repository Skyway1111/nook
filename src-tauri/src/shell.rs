//! Hands paths to the Windows shell: opening them, Explorer's file operations, and the file clipboard
//! Explorer shares.

use std::{ffi::OsStr, mem::size_of, path::Path, ptr::null_mut};
use tauri::async_runtime::spawn_blocking;
use windows_sys::Win32::{
    Foundation::GlobalFree,
    System::{
        DataExchange::{
            CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
            RegisterClipboardFormatW, SetClipboardData,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
    },
    UI::{
        Shell::{
            DragQueryFileW, SHFileOperationW, ShellExecuteExW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOCONFIRMMKDIR, FOF_RENAMEONCOLLISION,
            FOF_WANTNUKEWARNING, FO_COPY, FO_DELETE, FO_MOVE, FO_RENAME, SEE_MASK_INVOKEIDLIST, SHELLEXECUTEINFOW, SHFILEOPSTRUCTW,
        },
        WindowsAndMessaging::SW_SHOWNORMAL,
    },
};

use crate::err;

const CF_HDROP: u32 = 15;
const DROPEFFECT_COPY: u32 = 1;
const DROPEFFECT_MOVE: u32 = 2;
const DROPEFFECT_LINK: u32 = 4;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

/// Paths as the shell takes a list of them: each ends in a null, and the list in one more.
fn wide_list(paths: &[String]) -> Vec<u16> {
    paths.iter().flat_map(|p| p.encode_utf16().chain([0])).chain([0]).collect()
}

fn in_dir(path: &str, dir: &str) -> bool {
    Path::new(path).parent().is_some_and(|p| p.as_os_str().eq_ignore_ascii_case(OsStr::new(dir)))
}

/// Runs a shell verb on a path: `open` (also a URL), `openas` (the Open with dialog), or `properties`.
#[tauri::command]
pub fn open_path(path: String, verb: Option<String>) {
    let verb = verb.unwrap_or_else(|| "open".into());
    let (verb_w, file) = (wide(&verb), wide(&path));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        // Open with and Properties come from the item's shell menu, not its file type.
        fMask: if verb == "open" { 0 } else { SEE_MASK_INVOKEIDLIST },
        lpVerb: verb_w.as_ptr(),
        lpFile: file.as_ptr(),
        nShow: SW_SHOWNORMAL,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut info) };
}

#[tauri::command]
pub fn reveal(path: String) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("explorer").raw_arg(format!("/select,\"{path}\"")).spawn();
}

/// One of Explorer's file operations, with its progress, conflict, and error dialogs. True when it
/// finished; false after a cancel or an error the shell has already shown.
fn file_op(func: u32, flags: u32, from: &[String], to: &str) -> bool {
    let (from, to) = (wide_list(from), wide_list(&[to.into()]));
    // No owner window: a dialog that owned nook's window would disable it, typing included, until it closed.
    let mut op = SHFILEOPSTRUCTW { wFunc: func, pFrom: from.as_ptr(), pTo: to.as_ptr(), fFlags: flags as u16, ..Default::default() };
    unsafe { SHFileOperationW(&mut op) == 0 && op.fAnyOperationsAborted == 0 }
}

/// Sends a file or folder to the Recycle Bin without asking, as Explorer does. The shell asks first
/// when it would delete outright instead, as on a drive with no Recycle Bin.
#[tauri::command]
pub async fn recycle(path: String) -> Result<bool, String> {
    spawn_blocking(move || file_op(FO_DELETE, FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_WANTNUKEWARNING, &[path], "")).await.map_err(err)
}

/// Renames a file or folder. A name that's taken gets the shell's conflict dialog, never a silent overwrite.
#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<bool, String> {
    spawn_blocking(move || file_op(FO_RENAME, FOF_ALLOWUNDO, &[from], &to)).await.map_err(err)
}

/// Runs `f` with the clipboard open.
fn with_clipboard<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if unsafe { OpenClipboard(null_mut()) } == 0 {
        return Err("the clipboard is busy".into());
    }
    let result = f();
    unsafe { CloseClipboard() };
    result
}

/// Explorer's note beside a file list on the clipboard: whether pasting copies or moves.
fn drop_effect_format() -> u32 {
    unsafe { RegisterClipboardFormatW(wide("Preferred DropEffect").as_ptr()) }
}

/// Hands `bytes` to the open clipboard as `format`.
fn set_clipboard(format: u32, bytes: &[u8]) -> Result<(), String> {
    unsafe {
        let mem = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        if mem.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), GlobalLock(mem).cast(), bytes.len());
        GlobalUnlock(mem);
        if SetClipboardData(format, mem).is_null() {
            GlobalFree(mem);
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

/// Puts files on the clipboard as Explorer's Copy does, or its Cut, whose paste moves them.
#[tauri::command]
pub fn copy_files(paths: Vec<String>, cut: bool) -> Result<(), String> {
    // DROPFILES: where the list starts, a drop point, and two flags, the second marking UTF-16 names.
    let mut files: Vec<u8> = [20u32, 0, 0, 0, 1].iter().flat_map(|n| n.to_le_bytes()).collect();
    files.extend(wide_list(&paths).iter().flat_map(|c| c.to_le_bytes()));
    let effect = if cut { DROPEFFECT_MOVE } else { DROPEFFECT_COPY | DROPEFFECT_LINK };
    with_clipboard(|| {
        unsafe { EmptyClipboard() };
        set_clipboard(CF_HDROP, &files)?;
        set_clipboard(drop_effect_format(), &effect.to_le_bytes())
    })
}

#[tauri::command]
pub fn can_paste() -> bool {
    unsafe { IsClipboardFormatAvailable(CF_HDROP) != 0 }
}

/// The clipboard's files, and whether they were cut.
fn clipboard_files() -> Result<(Vec<String>, bool), String> {
    with_clipboard(|| unsafe {
        let list = GetClipboardData(CF_HDROP);
        if list.is_null() {
            return Ok((Vec::new(), false));
        }
        let paths = (0..DragQueryFileW(list, u32::MAX, null_mut(), 0))
            .map(|i| {
                let mut name = vec![0u16; DragQueryFileW(list, i, null_mut(), 0) as usize + 1];
                let len = DragQueryFileW(list, i, name.as_mut_ptr(), name.len() as u32);
                String::from_utf16_lossy(&name[..len as usize])
            })
            .collect();
        let effect = GetClipboardData(drop_effect_format());
        let cut = !effect.is_null() && {
            let e = GlobalLock(effect).cast::<u32>().read_unaligned();
            GlobalUnlock(effect);
            e & DROPEFFECT_MOVE != 0
        };
        Ok((paths, cut))
    })
}

/// Pastes the clipboard's files into `dir`: copies, or after a cut, moves them. True when it finished.
#[tauri::command]
pub async fn paste_files(dir: String) -> Result<bool, String> {
    spawn_blocking(move || {
        let seq = unsafe { GetClipboardSequenceNumber() };
        let (mut paths, cut) = clipboard_files()?;
        if cut {
            paths.retain(|p| !in_dir(p, &dir)); // already there
        }
        if paths.is_empty() {
            return Ok(false);
        }
        let flags = FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR;
        let done = if cut {
            file_op(FO_MOVE, flags, &paths, &dir)
        } else {
            // A copy into its own folder becomes "name - Copy", as Explorer's paste makes it.
            let beside = if paths.iter().any(|p| in_dir(p, &dir)) { FOF_RENAMEONCOLLISION } else { 0 };
            file_op(FO_COPY, flags | beside, &paths, &dir)
        };
        // A cut pastes once, as in Explorer, unless something else took the clipboard meanwhile.
        if done && cut && unsafe { GetClipboardSequenceNumber() } == seq {
            with_clipboard(|| {
                unsafe { EmptyClipboard() };
                Ok(())
            })?;
        }
        Ok(done)
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::{file_op, in_dir, FOF_ALLOWUNDO, FOF_NOCONFIRMMKDIR, FOF_RENAMEONCOLLISION, FO_COPY, FO_MOVE, FO_RENAME};
    use std::fs;
    use windows_sys::Win32::UI::Shell::FOF_NOERRORUI;

    #[test]
    fn matches_a_parent_folder_in_any_case() {
        assert!(in_dir(r"C:\Users\a.txt", r"c:\users"));
        assert!(in_dir(r"C:\a.txt", r"C:\"));
        assert!(!in_dir(r"C:\Users\x\a.txt", r"C:\Users"));
    }

    #[test]
    fn copies_renames_and_moves_through_the_shell() {
        let root = std::env::temp_dir().join(format!("nook-shell-{}", std::process::id()));
        let (a, b) = (root.join("a"), root.join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let at = |p: &std::path::Path| p.to_string_lossy().into_owned();
        let flags = FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR;
        fs::write(a.join("one.txt"), "1").unwrap();
        fs::write(a.join("two.txt"), "2").unwrap();

        // Two paths in one list, and a copy beside itself.
        let both = [at(&a.join("one.txt")), at(&a.join("two.txt"))];
        assert!(file_op(FO_COPY, flags, &both, &at(&b)));
        assert!(file_op(FO_COPY, flags | FOF_RENAMEONCOLLISION, &both[..1], &at(&a)));
        assert!(a.join("one - Copy.txt").exists());

        assert!(file_op(FO_RENAME, FOF_ALLOWUNDO, &[at(&b.join("one.txt"))], &at(&b.join("uno.txt"))));
        // A taken name fails the rename instead of replacing the file. The app shows the shell's error.
        assert!(!file_op(FO_RENAME, FOF_ALLOWUNDO | FOF_NOERRORUI, &[at(&b.join("uno.txt"))], &at(&b.join("two.txt"))));
        assert_eq!(fs::read_to_string(b.join("two.txt")).unwrap(), "2");
        assert!(file_op(FO_MOVE, flags, &[at(&b.join("uno.txt"))], &at(&a)));
        assert_eq!(fs::read_to_string(a.join("uno.txt")).unwrap(), "1");
        assert!(!b.join("uno.txt").exists() && b.join("two.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
