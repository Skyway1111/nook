//! nook's window, settings.json, the file commands, and `main`. Every IPC command registers here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod com;
mod commands;
mod defs;
mod find;
mod git;
mod history;
mod host;
mod ide;
mod index;
mod json;
mod notify;
mod pdf;
#[cfg_attr(not(windows), path = "priority_unix.rs")]
mod priority;
mod pty;
mod replace;
mod search;
mod settings;
#[cfg_attr(not(windows), path = "shell_unix.rs")]
mod shell;
#[cfg(windows)]
mod sys;
mod theme;

use host::{cmd, Run};
use json::object;
use settings::Settings;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::Instant,
};

/// nook's identifier, which names its folders: `dev.nook.app` unless the build set `NOOK_ID`.
const ID: &str = env!("NOOK_ID");
/// The window's title.
const NAME: &str = env!("NOOK_NAME");

/// Edge features the webview keeps off: out-of-process UI for pages and PDFs, and SmartScreen's checks.
#[cfg(windows)]
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Runs a console tool, feeding it `input`, with no console window: without the flag, the release
/// build flashes one for each. Ok is its output; Err is what it said went wrong.
pub fn run(cmd: &mut Command, input: Option<&str>) -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("can't run {}: {e}", Path::new(cmd.get_program()).file_stem().unwrap_or_default().to_string_lossy()))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(input.as_bytes()); // a tool that quit early says why below
    }
    let out = child.wait_with_output().map_err(err)?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    // git's "nothing to commit" and its like go to stdout.
    let said = if out.stderr.is_empty() { &out.stdout } else { &out.stderr };
    Err(String::from_utf8_lossy(said).trim().to_string())
}

const HOME_VAR: &str = if cfg!(windows) { "USERPROFILE" } else { "HOME" };

fn home_dir() -> String {
    std::env::var(HOME_VAR).unwrap_or_else(|_| if cfg!(windows) { "C:\\" } else { "/" }.into())
}

/// A folder Windows keeps for the user, by its known-folder id.
#[cfg(windows)]
fn known(id: u128) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    let mut p = std::ptr::null_mut();
    let hr = unsafe { sys::SHGetKnownFolderPath(&com::guid(id), 0, std::ptr::null_mut(), &mut p) };
    let path = (hr >= 0).then(|| unsafe {
        let len = (0..).take_while(|&i| *p.add(i) != 0).count();
        PathBuf::from(std::ffi::OsString::from_wide(std::slice::from_raw_parts(p, len)))
    });
    unsafe { sys::CoTaskMemFree(p.cast()) };
    path
}

/// An XDG base folder: `var` if it holds an absolute path, else `fallback` in the home folder.
#[cfg(not(windows))]
fn xdg(var: &str, fallback: &str) -> PathBuf {
    std::env::var_os(var).map(PathBuf::from).filter(|d| d.is_absolute()).unwrap_or_else(|| Path::new(&home_dir()).join(fallback))
}

/// Where settings.json, theme.css, and the installed themes live: `%APPDATA%\<id>`, or `~/.config/<id>`.
fn config_dir() -> PathBuf {
    #[cfg(windows)]
    let base = known(0x3eb685db_65f9_4cf6_a03a_e3ef65729f3d).unwrap_or_else(|| std::env::var_os("APPDATA").unwrap_or_default().into());
    #[cfg(not(windows))]
    let base = xdg("XDG_CONFIG_HOME", ".config");
    base.join(ID)
}

/// The webview's profile, localStorage included: `%LOCALAPPDATA%\<id>`, or `~/.local/share/<id>`.
fn data_dir() -> PathBuf {
    #[cfg(windows)]
    let base = local_app_data();
    #[cfg(not(windows))]
    let base = xdg("XDG_DATA_HOME", ".local/share");
    base.join(ID)
}

/// What nook keeps only to be quicker, such as the baked backdrops: `%LOCALAPPDATA%\<id>`, or `~/.cache/<id>`.
pub fn cache_dir() -> PathBuf {
    #[cfg(windows)]
    let base = local_app_data();
    #[cfg(not(windows))]
    let base = xdg("XDG_CACHE_HOME", ".cache");
    base.join(ID)
}

#[cfg(windows)]
fn local_app_data() -> PathBuf {
    known(0xf1b32785_6fba_4fcf_9d55_7b8e7f157091).unwrap_or_else(|| std::env::var_os("LOCALAPPDATA").unwrap_or_default().into())
}

/// The user's Downloads folder, wherever they moved it.
#[cfg(windows)]
pub fn downloads_dir() -> PathBuf {
    known(0x374de290_123f_4565_9164_39c4925e467b).unwrap_or_else(|| Path::new(&home_dir()).join("Downloads"))
}

/// The user's Downloads folder: XDG's `XDG_DOWNLOAD_DIR` from user-dirs.dirs, or `Downloads` in the home folder.
#[cfg(not(windows))]
pub fn downloads_dir() -> PathBuf {
    let home = PathBuf::from(home_dir());
    let dirs = fs::read_to_string(xdg("XDG_CONFIG_HOME", ".config").join("user-dirs.dirs")).unwrap_or_default();
    let named = dirs.lines().find_map(|line| {
        let value = line.trim().strip_prefix("XDG_DOWNLOAD_DIR=")?.trim().strip_prefix('"')?.strip_suffix('"')?;
        let value = value.replace('\\', "");
        match value.strip_prefix("$HOME/") {
            Some("") => None, // pointed at the home folder: none
            Some(rest) => Some(home.join(rest)),
            None => value.starts_with('/').then(|| value.into()),
        }
    });
    named.unwrap_or_else(|| home.join("Downloads"))
}

/// A file nook ships beside its program: `mod`, `themes`, `conpty.dll`, `OpenConsole.exe`. A debug build finds
/// them where they live in the repository.
pub fn resource(name: &str) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let root = Path::new(host::ROOT);
        match name {
            "conpty.dll" | "OpenConsole.exe" => root.join("native").join("conpty").join(name),
            _ => root.join(name),
        }
    }
    #[cfg(not(debug_assertions))]
    std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.join(name))).unwrap_or_else(|| name.into())
}

/// settings.json over the defaults, or the defaults when there's none. A byte-order mark, as Notepad once saved,
/// is no part of the JSON.
fn read_settings() -> Result<Settings, String> {
    match fs::read_to_string(config_dir().join("settings.json")) {
        Ok(s) => Settings::parse(s.strip_prefix('\u{feff}').unwrap_or(&s)).map_err(|e| format!("settings.json: {e}")),
        Err(_) => Ok(Settings::default()),
    }
}

/// What the page starts from.
struct Boot {
    settings: Settings,
    /// Why settings.json couldn't be read, when it couldn't.
    error: Option<String>,
    config_dir: PathBuf,
    home: String,
}

object!(Boot { settings, error, config_dir: "configDir", home });

/// A (re)loaded page starts with no tabs, so sessions from before a reload end here.
fn boot() -> Boot {
    pty::SESSIONS.close_all();
    let (mut settings, error) = match read_settings() {
        Ok(s) => (s, None),
        Err(e) => (Settings::default(), Some(e)),
    };
    settings.sessions.retain(|s| Path::new(&s.dir).is_dir()); // a folder since moved or deleted reopens nothing
    Boot { settings, error, config_dir: config_dir(), home: std::env::var(HOME_VAR).unwrap_or_default() }
}

/// settings.json as it is now, for the settings drawer.
fn settings() -> Result<Settings, String> {
    read_settings()
}

/// Held across each read-check-write of a file, so two commands on workers can't interleave one.
static WRITING: Mutex<()> = Mutex::new(());

/// Sets `patch`'s keys in settings.json. Fails on a value of the wrong type.
fn update_settings(patch: json::Text) -> Result<(), String> {
    edit_settings(|s| s.merge(&patch.0))
}

/// Rewrites settings.json with `edit` made. Read-modify-write, so windows never clobber each other's
/// changes. Fails rather than overwrite a file that was hand-edited into invalid JSON.
pub fn edit_settings(edit: impl FnOnce(&mut Settings) -> Result<(), String>) -> Result<(), String> {
    let _writing = WRITING.lock().unwrap();
    let mut settings = read_settings()?;
    edit(&mut settings)?;
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(err)?;
    fs::write(dir.join("settings.json"), json::pretty(&settings)).map_err(err)
}

struct Entry {
    name: String,
    dir: bool,
}

object!(Entry { name, dir });

/// Directory listing; `""` lists drive roots, or on Linux the root. Skips what the file manager hides:
/// on Windows the hidden and system attributes, and on Linux names that start with a dot.
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    if path.is_empty() {
        if cfg!(not(windows)) {
            return Ok(vec![Entry { name: "/".into(), dir: true }]);
        }
        let drives = ('C'..='Z').map(|c| format!("{c}:\\")).filter(|d| Path::new(d).exists());
        return Ok(drives.map(|name| Entry { name, dir: true }).collect());
    }
    let entries = fs::read_dir(&path).map_err(err)?.flatten().filter_map(|e| {
        Some(Entry { dir: shown_dir(&e)?, name: e.file_name().to_string_lossy().into_owned() })
    });
    Ok(entries.collect())
}

/// Whether a listed entry is a folder, or None if it's hidden. On Windows the listing already carries each
/// entry's attributes, so its metadata costs nothing.
#[cfg(windows)]
fn shown_dir(e: &fs::DirEntry) -> Option<bool> {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;
    let meta = e.metadata().ok()?;
    (meta.file_attributes() & HIDDEN_OR_SYSTEM == 0).then(|| meta.is_dir() || (meta.is_symlink() && e.path().is_dir()))
}

/// Whether a listed entry is a folder, or None if its name starts with a dot. The entry's type comes with the
/// listing, so only a symlink costs a stat, to see what it points at.
#[cfg(not(windows))]
fn shown_dir(e: &fs::DirEntry) -> Option<bool> {
    if e.file_name().as_encoded_bytes().starts_with(b".") {
        return None;
    }
    let kind = e.file_type().ok()?;
    Some(kind.is_dir() || (kind.is_symlink() && e.path().is_dir()))
}

const BOM: &[u8] = b"\xEF\xBB\xBF";

/// A file's text as a file tab holds it: UTF-8 without the BOM. Text that is UTF-8 keeps its buffer.
fn decode(mut bytes: Vec<u8>) -> String {
    if bytes.starts_with(BOM) {
        bytes.drain(..BOM.len());
    }
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// A file's text for a file tab. Refuses binary files and files over 4 MiB.
fn read_text(path: String) -> Result<String, String> {
    if fs::metadata(&path).map_err(err)?.len() > 4 << 20 {
        return Err("it's over 4 MiB".into());
    }
    let bytes = fs::read(&path).map_err(err)?;
    if bytes.contains(&0) {
        return Err("it isn't text".into());
    }
    Ok(decode(bytes))
}

/// When a file last changed, and its size. A file tab rereads the file only when this changes.
fn file_stamp(path: String) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    Some(format!("{:?} {}", meta.modified().ok()?, meta.len()))
}

/// What each path names: 0 nothing, 1 a file, 2 a folder. A Claude tab asks about the paths in a row
/// of its text once the mouse rests on it, and links those that exist.
fn path_kinds(paths: Vec<String>) -> Vec<u8> {
    paths
        .iter()
        .map(|p| match fs::metadata(p) {
            Ok(m) if m.is_dir() => 2,
            Ok(_) => 1,
            Err(_) => 0,
        })
        .collect()
}

/// Up to `count` lines of a text file from line `from` (1-based), each cut at 400 characters: what a
/// Claude tab shows when the mouse rests on a path. Reads no further than the last line it returns.
fn peek_lines(path: String, from: usize, count: usize) -> Result<Vec<String>, String> {
    use std::io::{BufRead, BufReader};
    let mut reader = BufReader::new(fs::File::open(&path).map_err(err)?);
    let (from, count) = (from.max(1), count.min(200));
    let mut lines = Vec::with_capacity(count);
    let mut buf = Vec::new();
    for n in 1..from + count {
        buf.clear();
        if reader.read_until(b'\n', &mut buf).map_err(err)? == 0 {
            break;
        }
        if buf.contains(&0) {
            return Err("it isn't text".into());
        }
        if n < from {
            continue;
        }
        let bytes = if n == 1 { buf.strip_prefix(BOM).unwrap_or(&buf) } else { &buf[..] };
        let text = String::from_utf8_lossy(bytes);
        let text = text.trim_end_matches(['\n', '\r']);
        lines.push(text.chars().take(400).collect());
    }
    Ok(lines)
}

/// Saves a file tab and keeps the file's BOM. Writes nothing and returns false when the file no
/// longer holds `base`, the text the tab last read; with no `base` it overwrites.
fn write_text(path: String, text: String, base: Option<String>) -> Result<bool, String> {
    let _writing = WRITING.lock().unwrap();
    let old = match fs::read(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        read => read.map_err(err)?,
    };
    if std::str::from_utf8(&old).is_err() {
        return Err("it isn't UTF-8, and saving would garble it".into());
    }
    if base.is_some_and(|b| old.strip_prefix(BOM).unwrap_or(&old) != b.as_bytes()) {
        return Ok(false);
    }
    let bom = if old.starts_with(BOM) { BOM } else { b"" };
    fs::write(&path, [bom, text.as_bytes()].concat()).map_err(err)?;
    Ok(true)
}

/// Makes an empty file, or a folder. Fails rather than touch one that exists.
fn create_path(path: String, dir: bool) -> Result<(), String> {
    if dir { fs::create_dir(&path) } else { fs::File::create_new(&path).map(|_| ()) }.map_err(err)
}

/// A folder passed on the command line, as Explorer's "Open with nook" does.
fn dir_arg(arg: &str) -> Option<String> {
    // Explorer quotes a drive root as "C:\", whose backslash escapes the closing quote: C:"
    // plus whatever followed it on the command line.
    let arg = arg.trim_end_matches(['"', ' ']);
    let arg = if arg.ends_with(':') { format!("{arg}\\") } else { arg.to_string() };
    let dir = std::path::absolute(arg).ok()?;
    dir.is_dir().then(|| dir.to_string_lossy().into_owned())
}

/// What a Claude Code session sets for its children. Launched from inside one, nook would
/// otherwise start every session as a "child", with transcript saving off.
const INHERITED_SESSION_MARKERS: [&str; 10] = [
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
];

/// WebKitGTK composites with the GPU, and with `gpu` off nook renders on the CPU, as WebView2 does with
/// `--disable-gpu`. It runs before any thread exists to read the environment it sets. Software compositing costs
/// far more: on Xvfb, a third of the memory and CPU go.
#[cfg(target_os = "linux")]
fn render_on_the_cpu_unless_gpu(gpu: bool) {
    const VAR: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";
    if gpu {
        return;
    }
    // Without compositing nothing needs DMA-BUF, and the renderer for it still sets up EGL and Mesa in the UI
    // process: about 28 MB on Xvfb.
    for var in [VAR, "WEBKIT_DISABLE_DMABUF_RENDERER"] {
        if std::env::var_os(var).is_none() {
            std::env::set_var(var, "1");
        }
    }
}

/// When nook started, for `bench`.
static STARTED: OnceLock<Instant> = OnceLock::new();

/// Prints a timing for `bench/linux.mjs`, which starts nook with `NOOK_BENCH` set: `ms`, or without it, the
/// milliseconds since nook started, and then the milliseconds since nook started either way.
fn bench(event: String, ms: Option<f64>) {
    let now = STARTED.get().map_or(0.0, |t| t.elapsed().as_secs_f64() * 1000.0);
    println!("bench {event} {:.1} {now:.1}", ms.unwrap_or(now));
}

fn main() {
    STARTED.get_or_init(Instant::now);
    for key in INHERITED_SESSION_MARKERS {
        std::env::remove_var(key); // before any thread exists
    }
    let settings = read_settings().unwrap_or_default();
    #[cfg(target_os = "linux")]
    render_on_the_cpu_unless_gpu(settings.gpu);
    let bench = std::env::var_os("NOOK_BENCH").is_some();
    if bench {
        self::bench("mark:setup".into(), None);
    }
    priority::keep_typing_path_elevated(settings.command.first().map_or("", String::as_str));
    std::thread::spawn(ide::sweep);
    // `nook <dir>` opens there; otherwise in the last session's folder.
    let asked = std::env::args().nth(1).as_deref().and_then(dir_arg);
    // A folder asked for opens a new session there instead of reopening the last ones.
    let reopen = asked.is_none() && settings.reopen_sessions;
    let start = asked.or_else(|| Some(settings.last_dir).filter(|d| Path::new(d).is_dir())).unwrap_or_else(|| Settings::default().last_dir);
    let cfg = host::Config {
        title: NAME,
        size: (1280, 820),
        min: (520, 320),
        background: [20, 18, 28],
        data_dir: data_dir().to_string_lossy().into_owned(),
        // Browser arguments, and on Linux the compositing mode, are fixed when the webview starts: a change to
        // `gpu` takes a restart.
        #[cfg(windows)]
        browser_args: format!("{BROWSER_ARGS}{}", if settings.gpu { "" } else { " --disable-gpu" }),
        init_script: format!("window.NOOK_CWD = {}; window.NOOK_REOPEN = {reopen}; window.NOOK_BENCH = {bench};", json::to_string(&start)),
        on_webview: if bench { || self::bench("mark:window".into(), None) } else { || {} },
        #[cfg(target_os = "linux")]
        icon: include_bytes!("../icons/32x32.png"),
        #[cfg(debug_assertions)]
        watch: &["src", "index.html", "mod/themes"],
    };
    if let Err(e) = host::run(cfg, commands) {
        eprintln!("{e}");
    }
    pty::SESSIONS.close_all(); // the window is gone, and no tab is left to own a session
}

/// Every command the page calls, and where it runs. A command that reads or writes a file or waits on a process
/// runs on a worker: on the UI thread it would hold up the keystrokes behind it. Only the PTY's writes, resizes,
/// and closes and the shell's quick calls run there, in the order the page sent them. `pdf_page` and the theme
/// and backdrop commands carry bytes, and come by fetch (host.js).
fn commands(name: &str) -> Option<(Run, host::Command)> {
    use Run::{Inline, Thread};
    Some(match name {
        "pty_write" => (Inline, cmd!(pty::pty_write, id, data)),
        "pty_resize" => (Inline, cmd!(pty::pty_resize, id, cols, rows)),
        "pty_close" => (Inline, cmd!(pty::pty_close, id)),
        "bench" => (Inline, cmd!(bench, event, ms)),
        "open_path" => (Inline, cmd!(shell::open_path, path, verb)),
        "reveal" => (Inline, cmd!(shell::reveal, path)),
        "copy_files" => (Inline, cmd!(shell::copy_files, paths, cut)),
        "can_paste" => (Inline, cmd!(shell::can_paste)),
        "copied_paths" => (Inline, cmd!(shell::copied_paths)),
        "pty_spawn" => (Thread, cmd!(pty::pty_spawn, command, cwd, cols, rows, on_data: "onData")),
        "pty_state" => (Thread, cmd!(pty::pty_state, id)),
        "pty_states" => (Thread, cmd!(pty::pty_states, ids)),
        "pty_command" => (Thread, cmd!(pty::pty_command, id, command, args)),
        "session_image" => (Thread, cmd!(pty::session_image, id, n)),
        "notify" => (Thread, cmd!(notify::notify, title, body)),
        "boot" => (Thread, cmd!(boot)),
        "settings" => (Thread, cmd!(settings)),
        "update_settings" => (Thread, cmd!(update_settings, patch)),
        "read_theme" => (Thread, cmd!(theme::read_theme)),
        "install_theme" => (Thread, cmd!(theme::install_theme, path)),
        "install_theme_zip" => (Thread, cmd!(theme::install_theme_zip, @body)),
        "save_theme_zip" => (Thread, cmd!(theme::save_theme_zip, @body)),
        "zip_holds_theme" => (Thread, cmd!(theme::zip_holds_theme, path)),
        "saved_backdrop" => (Thread, cmd!(theme::saved_backdrop, name)),
        "save_backdrop" => (Thread, cmd!(theme::save_backdrop, @body)),
        "list_dir" => (Thread, cmd!(list_dir, path)),
        "index_files" => (Thread, cmd!(index::index_files, dir)),
        "search_text" => (Thread, cmd!(search::search_text, dir, query)),
        "find_in_files" => (Thread, cmd!(replace::find_in_files, dir, query, with)),
        "replace_in_files" => (Thread, cmd!(replace::replace_in_files, root, query, with, files)),
        "undo_replace" => (Thread, cmd!(replace::undo_replace)),
        "workspace_symbols" => (Thread, cmd!(defs::workspace_symbols, dir)),
        "outline" => (Thread, cmd!(defs::outline, name, text)),
        "file_stamp" => (Thread, cmd!(file_stamp, path)),
        "path_kinds" => (Thread, cmd!(path_kinds, paths)),
        "peek_lines" => (Thread, cmd!(peek_lines, path, from, count)),
        "read_text" => (Thread, cmd!(read_text, path)),
        "write_text" => (Thread, cmd!(write_text, path, text, base)),
        "create_path" => (Thread, cmd!(create_path, path, dir)),
        "recycle" => (Thread, cmd!(shell::recycle, path)),
        "rename_path" => (Thread, cmd!(shell::rename_path, from, to)),
        "paste_files" => (Thread, cmd!(shell::paste_files, dir)),
        "drop_files" => (Thread, cmd!(shell::drop_files, paths, dir, copy)),
        "git" => (Thread, cmd!(git::git, dir, args, input)),
        "git_status" => (Thread, cmd!(git::git_status, path)),
        "git_progress" => (Thread, cmd!(git::git_progress, dir, args, progress)),
        "git_diff" => (Thread, cmd!(git::git_diff, root, path, staged, paths)),
        "claude_sessions" => (Thread, cmd!(history::claude_sessions, dir)),
        "claude_commands" => (Thread, cmd!(commands::claude_commands, dir)),
        "pdf_page" => (Thread, cmd!(pdf::pdf_page, path, width, height)),
        "ide_selection" => (Thread, cmd!(ide::ide_selection, id, path, start, end, text)),
        "ide_diff_answer" => (Thread, cmd!(ide::ide_diff_answer, id, tab, outcome, contents)),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::{dir_arg, peek_lines, read_text, write_text};
    use std::fs;

    #[test]
    fn opens_a_folder_explorer_passes() {
        let here = if cfg!(windows) { env!("CARGO_MANIFEST_DIR").replace('/', "\\") } else { env!("CARGO_MANIFEST_DIR").into() };
        assert_eq!(dir_arg(&here), Some(here.clone()));
    }

    #[test]
    #[cfg(windows)]
    fn repairs_a_drive_root_whose_quote_was_escaped() {
        assert_eq!(dir_arg("C:\""), Some("C:\\".into()));
        assert_eq!(dir_arg("C:\" "), Some("C:\\".into()));
    }

    #[test]
    fn rejects_a_missing_folder() {
        assert_eq!(dir_arg(r"C:\does\not\exist"), None);
        assert_eq!(dir_arg("/does/not/exist"), None);
    }

    #[test]
    fn peeks_at_lines_and_refuses_binary() {
        let file = std::env::temp_dir().join(format!("nook-peek-{}.txt", std::process::id()));
        let path = file.to_string_lossy().into_owned();
        fs::write(&file, b"\xEF\xBB\xBFone\r\ntwo\nthree\n").unwrap();
        assert_eq!(peek_lines(path.clone(), 1, 2).unwrap(), ["one", "two"]);
        assert_eq!(peek_lines(path.clone(), 3, 10).unwrap(), ["three"]);
        assert!(peek_lines(path.clone(), 9, 3).unwrap().is_empty());
        fs::remove_file(&file).unwrap();
        let here = env!("CARGO_MANIFEST_DIR");
        assert!(peek_lines(format!("{here}/icons/icon.ico"), 1, 5).is_err());
    }

    #[test]
    fn reads_text_and_refuses_binary() {
        let here = env!("CARGO_MANIFEST_DIR");
        assert!(read_text(format!("{here}/Cargo.toml")).unwrap().starts_with("[package]"));
        assert!(read_text(format!("{here}/icons/icon.ico")).is_err());
    }

    #[test]
    fn saves_only_over_the_text_it_read_and_keeps_the_bom() {
        let file = std::env::temp_dir().join(format!("nook-write-text-{}.txt", std::process::id()));
        let path = file.to_string_lossy().into_owned();
        fs::write(&file, b"\xEF\xBB\xBFone\r\n").unwrap();
        assert_eq!(read_text(path.clone()).unwrap(), "one\r\n");
        assert_eq!(write_text(path.clone(), "two\r\n".into(), Some("stale".into())), Ok(false));
        assert_eq!(write_text(path.clone(), "two\r\n".into(), Some("one\r\n".into())), Ok(true));
        assert_eq!(fs::read(&file).unwrap(), b"\xEF\xBB\xBFtwo\r\n");
        fs::write(&file, b"caf\xE9").unwrap();
        assert!(write_text(path, "x".into(), None).is_err());
        fs::remove_file(file).unwrap();
    }
}
