//! One pseudoconsole per Claude tab, and the files that carry nook's mod's reports and requests.
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    env::{self, JoinPathsError},
    ffi::{OsStr, OsString},
    io::{Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    path::PathBuf,
    thread,
};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Manager, State,
};

use crate::err;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

/// Dropping the master closes the pseudoconsole, which ends every process attached to it.
fn end(session: Session) {
    thread::spawn(move || drop(session));
}

/// One pseudoconsole per Claude tab, keyed by the id `pty_spawn` returns.
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<u64, Session>>);

impl Sessions {
    /// Ends session `id`; false if it had already ended.
    fn close(&self, id: u64) -> bool {
        let session = self.0.lock().unwrap().remove(&id);
        forget(id);
        session.map(end).is_some()
    }

    /// The window closed or its page reloaded: no tab is left to own a session.
    pub fn close_all(&self) {
        for (id, s) in self.0.lock().unwrap().drain() {
            forget(id);
            end(s);
        }
    }
}

/// Where nook's mod (`src-tauri/mod`) writes session `id`'s model, effort, and context fill. It reads
/// requests from the same path with `.cmd` for an extension.
fn state_file(id: u64) -> PathBuf {
    std::env::temp_dir().join("nook").join(format!("{}-{id}.json", std::process::id()))
}

fn forget(id: u64) {
    crate::ide::close(id);
    let _ = std::fs::remove_file(state_file(id));
    let _ = std::fs::remove_file(state_file(id).with_extension("cmd"));
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// The user's plugin folders, then nook's mod, which loads beside them, never in place of them. A nook
/// started from inside a nook session inherits that nook's mod, the `mod` beside its `nook` program, and
/// the first `nook` would load in place of this one.
/// Where Claude Code keeps its sessions' temporary files, pasted images among them: `claude` in the temp
/// folder on Windows, and elsewhere `claude-<uid>`, so users who share /tmp don't share it.
fn claude_temp() -> PathBuf {
    #[cfg(windows)]
    let name = "claude".to_string();
    #[cfg(not(windows))]
    let name = {
        use std::os::unix::fs::MetadataExt;
        format!("claude-{}", std::fs::metadata("/proc/self").map_or(0, |m| m.uid()))
    };
    std::env::temp_dir().join(name)
}

const NOOK_EXE: &str = if cfg!(windows) { "nook.exe" } else { "nook" };

fn plugin_dirs(inherited: &OsStr, nook_mod: PathBuf) -> Result<OsString, JoinPathsError> {
    let theirs = env::split_paths(inherited).filter(|d| {
        !d.as_os_str().is_empty() && !(d.ends_with("mod") && d.with_file_name(NOOK_EXE).is_file())
    });
    env::join_paths(theirs.chain([nook_mod]))
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { cols, rows, pixel_width: 0, pixel_height: 0 }
}

#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    command: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    let (program, args) = command.split_first().ok_or("settings.json: command is empty")?;
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(err)?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("FORCE_HYPERLINK", "1"); // Claude sends OSC 8 links only to terminals it recognizes
    // Claude draws a mod's Image as kitty graphics only in kitty and Ghostty unless this is set.
    cmd.env("CLAUDE_CODE_FORCE_TERMINAL_IMAGES", "1");
    let nook_mod = app.path().resource_dir().map_err(err)?.join("mod");
    let inherited = std::env::var_os("CLAUDE_CODE_PLUGIN_DIRS").unwrap_or_default();
    cmd.env("CLAUDE_CODE_PLUGIN_DIRS", plugin_dirs(&inherited, nook_mod).map_err(err)?);
    cmd.env("NOOK_STATE", state_file(id));
    cmd.env("NOOK_CLAUDE_TEMP", claude_temp()); // where the mod finds the session's pasted images
    if let Some(port) = crate::ide::open(&app, id) {
        cmd.env("CLAUDE_CODE_SSE_PORT", port.to_string()); // Claude connects to nook as its editor
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;

    let exited = on_data.clone();
    thread::spawn(move || {
        let mut buf = vec![0; 1 << 16];
        // Keep draining after the webview is gone: an undrained pipe can stall ClosePseudoConsole.
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            let _ = on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec()));
        }
    });
    sessions.0.lock().unwrap().insert(id, Session { master: pair.master, writer });
    // The shell exited: an empty chunk tells its tab to close.
    let handle = app.clone();
    thread::spawn(move || {
        let _ = child.wait();
        if handle.state::<Sessions>().close(id) {
            let _ = exited.send(InvokeResponseBody::Raw(Vec::new()));
        }
    });
    let _ = crate::edit_settings(&app, |s| {
        s.last_dir = cwd; // the next launch opens here
        Ok(())
    });
    Ok(id)
}

// A session that ended takes no more input or resizes: its tab is closing, and the
// terminal's own focus-out report can still arrive after the shell exited.

#[tauri::command]
pub fn pty_write(sessions: State<Sessions>, id: u64, data: String) -> Result<(), String> {
    let mut map = sessions.0.lock().unwrap();
    let Some(s) = map.get_mut(&id) else { return Ok(()) };
    s.writer.write_all(data.as_bytes()).map_err(err)
}

#[tauri::command]
pub fn pty_resize(sessions: State<Sessions>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let map = sessions.0.lock().unwrap();
    let Some(s) = map.get(&id) else { return Ok(()) };
    s.master.resize(size(cols, rows)).map_err(err)
}

#[tauri::command]
pub fn pty_close(sessions: State<Sessions>, id: u64) {
    sessions.close(id);
}

/// Asks nook's mod to run `/command args` in session `id`, as the composer's model and effort menus do.
/// The mod runs only `/model` and `/effort`, once the session is idle.
#[tauri::command(async)]
pub fn pty_command(id: u64, command: String, args: String) -> Result<(), String> {
    let file = state_file(id).with_extension("cmd");
    std::fs::create_dir_all(file.parent().unwrap()).map_err(err)?;
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let request = crate::json::to_string(&crate::json::obj! { "args": args, "at": at, "command": command }); // `at` tells repeats apart
    std::fs::write(file, request).map_err(err)
}

/// What nook's mod last reported for session `id`, as JSON; `None` until it reports.
#[tauri::command(async)]
pub fn pty_state(id: u64) -> Option<String> {
    std::fs::read_to_string(state_file(id)).ok()
}

/// What nook's mod last reported for each of `ids`, in order, read in one call so the tab strip follows
/// every session for one IPC round trip.
#[tauri::command(async)]
pub fn pty_states(ids: Vec<u64>) -> Vec<Option<String>> {
    ids.into_iter().map(pty_state).collect()
}

/// The `n`th image pasted into session `id`, in the folder nook's mod reports; `None` until Claude saves it.
#[tauri::command(async)]
pub fn session_image(id: u64, n: u32) -> Option<PathBuf> {
    let state = pty_state(id)?;
    let path = PathBuf::from(crate::json::parse(&state).ok()?["images"].as_str()?).join(format!("{n}.png"));
    path.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::plugin_dirs;
    use std::{ffi::OsStr, fs};

    #[test]
    fn keeps_the_users_plugins_and_drops_another_nooks_mod() {
        let other = std::env::temp_dir().join(format!("nook-plugin-dirs-{}", std::process::id()));
        fs::create_dir_all(other.join("mod")).unwrap();
        fs::write(other.join(super::NOOK_EXE), b"").unwrap();
        let (mine, ours, sep) = if cfg!(windows) { (r"C:\plugins\mine", r"C:\nook\mod", ";") } else { ("/plugins/mine", "/nook/mod", ":") };
        let inherited = format!("{mine}{sep}{sep}{}", other.join("mod").display());
        let dirs = plugin_dirs(OsStr::new(&inherited), ours.into()).unwrap();
        assert_eq!(dirs, OsStr::new(&format!("{mine}{sep}{ours}")));
        assert_eq!(plugin_dirs(OsStr::new(""), ours.into()).unwrap(), OsStr::new(ours));
        fs::remove_dir_all(other).unwrap();
    }
}
