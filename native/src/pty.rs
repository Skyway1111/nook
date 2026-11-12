//! The page's commands on its Claude tabs' sessions, which a keeper holds (keeper.rs), and the files that carry
//! nook's mod's reports and requests.
use std::{
    env::{self, JoinPathsError},
    ffi::{OsStr, OsString},
    path::PathBuf,
};

use crate::{
    err,
    host::Stream,
    json::{self, obj, object},
    keeper::{self, NUMBER},
};

/// Where nook's mod (`mod`) writes session `id`'s model, effort, and context fill: `<keeper's pid>-<number>`. It
/// reads requests from the same path with `.cmd` for an extension.
fn state_file(id: u64) -> PathBuf {
    std::env::temp_dir().join("nook").join(format!("{}-{}.json", id >> NUMBER, id & ((1 << NUMBER) - 1)))
}

/// Session `id` ended: its link to Claude closes, and its files go.
pub fn forget(id: u64) {
    crate::ide::close(id);
    let _ = std::fs::remove_file(state_file(id));
    let _ = std::fs::remove_file(state_file(id).with_extension("cmd"));
}

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
    if command.first().is_none_or(|p| p.trim().is_empty()) {
        return Err("settings.json: the command names no program to run".into());
    }
    let link = keeper::home()?;
    let id = link.id();
    let _ = std::fs::remove_file(state_file(id)); // a report left by a keeper that had this one's pid
    let inherited = std::env::var_os("CLAUDE_CODE_PLUGIN_DIRS").unwrap_or_default();
    let path = |p: PathBuf| p.to_string_lossy().into_owned();
    let mut vars: Vec<(&str, String)> = vec![
        ("TERM", "xterm-256color".into()),
        ("COLORTERM", "truecolor".into()),
        ("FORCE_HYPERLINK", "1".into()), // Claude sends OSC 8 links only to terminals it recognizes
        // Claude draws a mod's Image as kitty graphics only in kitty and Ghostty unless this is set.
        ("CLAUDE_CODE_FORCE_TERMINAL_IMAGES", "1".into()),
        ("CLAUDE_CODE_PLUGIN_DIRS", path(plugin_dirs(&inherited, crate::resource("mod")).map_err(err)?.into())),
        ("NOOK_STATE", path(state_file(id))),
        ("NOOK_CLAUDE_TEMP", path(claude_temp())), // where the mod finds the session's pasted images
    ];
    // Claude connects to nook as its editor. The next window to hold the session opens the same port.
    let ide = crate::ide::open(id, None);
    if let Some((port, _)) = &ide {
        vars.push(("CLAUDE_CODE_SSE_PORT", port.to_string()));
    }
    let (port, token) = ide.unzip();
    let meta = json::to_string(&obj! { "cwd": cwd, "port": port, "token": token });
    let (cols, rows, words) = (cols.to_string(), rows.to_string(), command.len().to_string());
    let head = [&cols[..], &rows, &cwd, &meta, &words].into_iter();
    let body: Vec<&str> = head.chain(command.iter().map(String::as_str)).chain(vars.iter().flat_map(|(k, v)| [*k, &v[..]])).collect();
    if body.iter().any(|part| part.contains('\0')) {
        return Err("settings.json: the command holds a NUL".into());
    }
    link.stream(id, Some(Stream::new(on_data)));
    link.call(b'S', id, body.join("\0").as_bytes(), None).inspect_err(|_| {
        link.stream(id, None);
        forget(id);
    })?;
    let _ = crate::edit_settings(|s| {
        s.last_dir = cwd; // the next launch opens here
        Ok(())
    });
    Ok(id)
}

/// What a session's new terminal shows first: its normal screen's output so far, which the terminal takes
/// without answering, then the modes its programs left set.
pub struct Attached {
    history: String,
    modes: String,
}

object!(Attached { history, modes });

/// Shows session `id`, which outlived its last terminal, in a new one of `cols` by `rows`: its output streams
/// to `on_data` from here on.
pub fn pty_attach(id: u64, cols: u16, rows: u16, on_data: u64) -> Result<Attached, String> {
    let link = keeper::of(id).ok_or("its session has ended")?;
    let reply = link.call(b'A', id, &[cols.to_le_bytes(), rows.to_le_bytes()].concat(), Some(Stream::new(on_data)))?;
    let (len, rest) = reply.split_at_checked(4).ok_or("the keeper's answer is cut short")?;
    let (history, modes) = rest.split_at_checked(u32::from_le_bytes(len.try_into().unwrap()) as usize).ok_or("the keeper's answer is cut short")?;
    Ok(Attached { history: String::from_utf8_lossy(history).into_owned(), modes: String::from_utf8_lossy(modes).into_owned() })
}

fn tell(id: u64, op: u8, body: &[u8]) {
    if let Some(link) = keeper::of(id) {
        link.tell(op, id, body);
    }
}

pub fn pty_write(id: u64, data: String) {
    tell(id, b'K', data.as_bytes());
}

pub fn pty_resize(id: u64, cols: u16, rows: u16) {
    tell(id, b'Z', &[cols.to_le_bytes(), rows.to_le_bytes()].concat());
}

pub fn pty_close(id: u64) {
    if let Some(link) = keeper::of(id) {
        link.tell(b'C', id, &[]);
        link.stream(id, None);
    }
    forget(id);
}

/// A session that outlived the page, or the window before this one.
pub struct Live {
    id: u64,
    cwd: String,
    /// Claude Code's own id for it, once its mod has reported.
    session: Option<String>,
}

object!(Live { id, cwd, session });

/// The sessions the window's keepers hold, each with its link to Claude open again.
pub fn live() -> Vec<Live> {
    let live = |(id, meta): (u64, String)| {
        let [cwd, port, token] = json::fields(&meta, ["cwd", "port", "token"]).ok()?;
        if let (json::J::Num(port), Some(token)) = (&port, token.as_str()) {
            crate::ide::open(id, port.parse().ok().map(|port| (port, token.into())));
        }
        let state = pty_state(id).unwrap_or_default();
        let session = json::fields(&state, ["session"]).ok().and_then(|[s]| s.as_str().map(String::from));
        Some(Live { id, cwd: cwd.as_str()?.into(), session })
    };
    keeper::sessions().into_iter().filter_map(live).collect()
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
