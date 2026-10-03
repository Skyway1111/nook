//! One pseudoconsole per Claude tab, and the files that carry nook's mod's reports and requests.
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
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
    let _ = std::fs::remove_file(state_file(id));
    let _ = std::fs::remove_file(state_file(id).with_extension("cmd"));
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

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
    // nook's mod loads beside the user's plugins, never in place of them.
    let nook_mod = app.path().resource_dir().map_err(err)?.join("mod");
    let mut dirs = std::env::var_os("CLAUDE_CODE_PLUGIN_DIRS").filter(|d| !d.is_empty()).unwrap_or_default();
    if !dirs.is_empty() {
        dirs.push(";");
    }
    dirs.push(&nook_mod);
    cmd.env("CLAUDE_CODE_PLUGIN_DIRS", dirs);
    cmd.env("NOOK_STATE", state_file(id));
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
    let _ = crate::update_settings(app, [("lastDir".into(), cwd.into())].into_iter().collect()); // the next launch opens here
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
    let request = serde_json::json!({ "command": command, "args": args, "at": at }); // `at` tells repeats apart
    std::fs::write(file, request.to_string()).map_err(err)
}

/// What nook's mod last reported for session `id`, as JSON; `None` until it reports.
#[tauri::command(async)]
pub fn pty_state(id: u64) -> Option<String> {
    std::fs::read_to_string(state_file(id)).ok()
}

/// The `n`th image pasted into session `id`, in the folder nook's mod reports; `None` until Claude saves it.
#[tauri::command(async)]
pub fn session_image(id: u64, n: u32) -> Option<PathBuf> {
    let state: serde_json::Value = serde_json::from_str(&pty_state(id)?).ok()?;
    let path = PathBuf::from(state["images"].as_str()?).join(format!("{n}.png"));
    path.is_file().then_some(path)
}
