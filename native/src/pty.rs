//! One console (a pseudoterminal on Linux) per Claude tab, and the files that carry nook's mod's reports and requests.
use std::{
    collections::BTreeMap,
    env::{self, JoinPathsError},
    ffi::{OsStr, OsString},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{channel, Receiver, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread,
    time::Instant,
};

use crate::{err, host::Stream};

#[cfg_attr(windows, path = "pty_windows.rs")]
#[cfg_attr(unix, path = "pty_unix.rs")]
mod os;

/// What a tab sends its PTY.
enum Input {
    Keys(String),
    Size(u16, u16),
}

struct Session {
    pty: Arc<os::Pty>,
    /// To the session's writer, which writes keys and applies sizes in the order they came.
    input: Sender<Input>,
}

/// Writes a session's keys and applies its sizes, in order, on a thread of its own: a terminal that stops reading
/// holds up only this. While the console waits on the terminal's answer to a resize, it ticks the console when
/// the wait is up. It ends once the session has and its queue is empty, or a write fails.
fn writer(pty: Arc<os::Pty>, queue: Receiver<Input>) {
    loop {
        let m = match pty.due() {
            Some(due) => match queue.recv_timeout(due.saturating_duration_since(Instant::now())) {
                Err(RecvTimeoutError::Timeout) => {
                    pty.tick();
                    continue;
                }
                m => m.ok(),
            },
            None => queue.recv().ok(),
        };
        match m {
            None => return,
            Some(Input::Keys(keys)) if pty.write(&keys).is_err() => return,
            Some(Input::Keys(_)) => {}
            Some(Input::Size(cols, rows)) => pty.resize(cols, rows),
        }
    }
}

/// Closing the console ends every process attached to it, and can block meanwhile.
fn end(session: Session) {
    thread::spawn(move || session.pty.close());
}

/// One pseudoconsole per Claude tab, keyed by the id `pty_spawn` returns.
pub struct Sessions(Mutex<BTreeMap<u64, Session>>);

pub static SESSIONS: Sessions = Sessions(Mutex::new(BTreeMap::new()));

impl Sessions {
    /// Ends session `id`; false if it had already ended.
    fn close(&self, id: u64) -> bool {
        let session = self.0.lock().unwrap().remove(&id);
        forget(id);
        session.map(end).is_some()
    }

    /// The window closed or its page reloaded: no tab is left to own a session.
    pub fn close_all(&self) {
        let all = std::mem::take(&mut *self.0.lock().unwrap());
        for (id, s) in all {
            forget(id);
            end(s);
        }
    }

    /// Queues `m` for session `id`'s PTY. A session that ended takes no more: its tab is closing, and the
    /// terminal's own focus-out report can still arrive after the shell exited.
    fn send(&self, id: u64, m: Input) {
        if let Some(s) = self.0.lock().unwrap().get(&id) {
            let _ = s.input.send(m);
        }
    }
}

/// Where nook's mod (`mod`) writes session `id`'s model, effort, and context fill. It reads
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

/// The user's plugin folders, then nook's mod, which loads beside them, never in place of them. A nook
/// started from inside a nook session inherits that nook's mod, the `mod` beside its `nook` program, or in a
/// debug build's repository beside `Cargo.toml`, and the first `nook` would load in place of this one.
fn plugin_dirs(inherited: &OsStr, nook_mod: PathBuf) -> Result<OsString, JoinPathsError> {
    let nooks = |d: &std::path::Path| [NOOK_EXE, "Cargo.toml"].iter().any(|f| d.with_file_name(f).is_file());
    let theirs = env::split_paths(inherited).filter(|d| !d.as_os_str().is_empty() && !(d.ends_with("mod") && nooks(d)));
    env::join_paths(theirs.chain([nook_mod]))
}

/// Starts `command` in `cwd` in a console of `cols` by `rows`, whose output streams to the page's channel
/// `on_data` as text. The channel hears empty text when the shell exits.
pub fn pty_spawn(command: Vec<String>, cwd: String, cols: u16, rows: u16, on_data: u64) -> Result<u64, String> {
    let Some((program, args)) = command.split_first().filter(|(p, _)| !p.trim().is_empty()) else {
        return Err("settings.json: the command names no program to run".into());
    };
    let console = os::open(cols, rows).map_err(err)?; // it starts up while the rest is built
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let inherited = std::env::var_os("CLAUDE_CODE_PLUGIN_DIRS").unwrap_or_default();
    let mut vars: Vec<(&str, OsString)> = vec![
        ("TERM", "xterm-256color".into()),
        ("COLORTERM", "truecolor".into()),
        ("FORCE_HYPERLINK", "1".into()), // Claude sends OSC 8 links only to terminals it recognizes
        // Claude draws a mod's Image as kitty graphics only in kitty and Ghostty unless this is set.
        ("CLAUDE_CODE_FORCE_TERMINAL_IMAGES", "1".into()),
        ("CLAUDE_CODE_PLUGIN_DIRS", plugin_dirs(&inherited, crate::resource("mod")).map_err(err)?),
        ("NOOK_STATE", state_file(id).into()),
        ("NOOK_CLAUDE_TEMP", claude_temp().into()), // where the mod finds the session's pasted images
    ];
    if let Some(port) = crate::ide::open(id) {
        vars.push(("CLAUDE_CODE_SSE_PORT", port.to_string().into())); // Claude connects to nook as its editor
    }
    let (pty, exit) = console.spawn(program, args, &cwd, &vars).map_err(|e| {
        forget(id);
        e.to_string()
    })?;
    let out = Stream::new(on_data);
    let exited = out.clone();
    pty.output(Box::new(move |b: &[u8]| out.push(b)));
    let pty = Arc::new(pty);
    let (queue, keys) = channel();
    let shared = pty.clone();
    thread::spawn(move || writer(shared, keys));
    SESSIONS.0.lock().unwrap().insert(id, Session { pty, input: queue });
    // The shell exited: the stream's end tells its tab to close.
    thread::spawn(move || {
        exit.wait();
        if SESSIONS.close(id) {
            exited.end();
        }
    });
    let _ = crate::edit_settings(|s| {
        s.last_dir = cwd; // the next launch opens here
        Ok(())
    });
    Ok(id)
}

pub fn pty_write(id: u64, data: String) {
    SESSIONS.send(id, Input::Keys(data));
}

pub fn pty_resize(id: u64, cols: u16, rows: u16) {
    SESSIONS.send(id, Input::Size(cols, rows));
}

pub fn pty_close(id: u64) {
    SESSIONS.close(id);
}

/// Asks nook's mod to run `/command args` in session `id`, as the composer's model and effort menus do.
/// The mod runs only `/model` and `/effort`, once the session is idle.
pub fn pty_command(id: u64, command: String, args: String) -> Result<(), String> {
    let file = state_file(id).with_extension("cmd");
    std::fs::create_dir_all(file.parent().unwrap()).map_err(err)?;
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let request = crate::json::to_string(&crate::json::obj! { "args": args, "at": at, "command": command }); // `at` tells repeats apart
    std::fs::write(file, request).map_err(err)
}

/// What nook's mod last reported for session `id`, as JSON; `None` until it reports.
pub fn pty_state(id: u64) -> Option<String> {
    std::fs::read_to_string(state_file(id)).ok()
}

/// What nook's mod last reported for each of `ids`, in order, read in one call so the tab strip follows
/// every session for one IPC round trip.
pub fn pty_states(ids: Vec<u64>) -> Vec<Option<String>> {
    ids.into_iter().map(pty_state).collect()
}

/// The `n`th image pasted into session `id`, in the folder nook's mod reports; `None` until Claude saves it.
pub fn session_image(id: u64, n: u32) -> Option<PathBuf> {
    let state = pty_state(id)?;
    let [images] = crate::json::fields(&state, ["images"]).ok()?;
    let path = PathBuf::from(images.as_str()?).join(format!("{n}.png"));
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
