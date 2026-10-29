//! nook's window, settings.json, the file commands, and `run`. Every IPC command registers here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod git;
mod history;
mod index;
#[cfg_attr(not(windows), path = "priority_unix.rs")]
mod priority;
mod pty;
#[cfg_attr(not(windows), path = "shell_unix.rs")]
mod shell;
mod theme;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{
    webview::{PageLoadEvent, PermissionKind, PermissionResponse},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

/// wry's defaults, which `additional_browser_args` replaces rather than extends.
const WRY_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

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

#[derive(Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    /// What each Claude tab runs in its terminal.
    command: Vec<String>,
    /// Off: the UI renders on the CPU, so a saturated GPU can't delay typing.
    gpu: bool,
    pinned: Vec<String>,
    last_dir: String,
    /// The file browser's and git panel's dragged widths. None: the theme's `--sidebar-width`.
    files_width: Option<u32>,
    git_width: Option<u32>,
    /// The installed theme in use, a folder in `themes`. None: nook's defaults.
    theme: Option<String>,
    /// Whether picking a theme also sets Claude's own theme to nook's.
    claude_follows: bool,
    /// Claude's theme before nook set it, for when Claude stops following.
    claude_theme: Option<String>,
    /// Quick prompts, which Ctrl+Shift+P pastes into Claude's prompt. `{file}` is the file open last,
    /// `{folder}` the file browser's folder.
    prompts: Vec<Prompt>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Prompt {
    name: String,
    text: String,
}

/// The quick prompts nook starts with.
const PROMPTS: [(&str, &str); 6] = [
    ("Review my changes", "Review my uncommitted changes for bugs, and for anything I'd regret shipping."),
    ("Explain this file", "Explain {file}: what it does, how it fits in, and anything surprising."),
    ("Write tests", "Write tests for {file} that cover its edge cases, then run them."),
    ("Fix the failing tests", "Run the tests, find why the failing ones fail, and fix the cause rather than the test."),
    ("Plan first", "Before changing anything, write a short plan and wait for my go-ahead: "),
    ("Commit", "Commit the staged changes with a message that says why, not just what."),
];

impl Default for Settings {
    fn default() -> Self {
        let home = home_dir();
        let under = |d: &str| Path::new(&home).join(d).to_string_lossy().into_owned();
        Self {
            command: DEFAULT_COMMAND.map(String::from).into(),
            gpu: false,
            pinned: vec![under("Desktop"), under("Downloads"), under("Documents"), home.clone()],
            last_dir: home,
            files_width: None,
            git_width: None,
            theme: None,
            claude_follows: true,
            claude_theme: None,
            prompts: PROMPTS.iter().map(|(name, text)| Prompt { name: name.to_string(), text: text.to_string() }).collect(),
        }
    }
}

/// What a Claude tab runs until settings.json says otherwise: Claude, then the shell it ran in.
#[cfg(windows)]
const DEFAULT_COMMAND: [&str; 5] = ["powershell", "-NoLogo", "-NoExit", "-Command", "claude"];
#[cfg(not(windows))]
const DEFAULT_COMMAND: [&str; 3] = ["bash", "-lc", "claude; exec bash -l"];

const HOME_VAR: &str = if cfg!(windows) { "USERPROFILE" } else { "HOME" };

fn home_dir() -> String {
    std::env::var(HOME_VAR).unwrap_or_else(|_| if cfg!(windows) { "C:\\" } else { "/" }.into())
}

fn config_dir(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().expect("no config dir")
}

fn read_settings(app: &AppHandle) -> Result<Settings, String> {
    match fs::read_to_string(config_dir(app).join("settings.json")) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("settings.json: {e}")),
        Err(_) => Ok(Settings::default()),
    }
}

/// `settings` with `patch`'s keys replaced. Fails on a value of the wrong type.
fn merge(settings: Settings, patch: Map<String, Value>) -> Result<Settings, String> {
    let mut json = serde_json::to_value(settings).map_err(err)?;
    json.as_object_mut().expect("settings serialize to an object").extend(patch);
    serde_json::from_value(json).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Boot {
    settings: Settings,
    error: Option<String>,
    config_dir: PathBuf,
    home: String,
}

/// A (re)loaded page starts with no tabs, so sessions from before a reload end here.
#[tauri::command(async)]
fn boot(app: AppHandle) -> Boot {
    app.state::<pty::Sessions>().close_all();
    let (settings, error) = match read_settings(&app) {
        Ok(s) => (s, None),
        Err(e) => (Settings::default(), Some(e)),
    };
    let home = std::env::var(HOME_VAR).unwrap_or_default();
    Boot { settings, error, config_dir: config_dir(&app), home }
}

/// settings.json as it is now, for the settings drawer.
#[tauri::command(async)]
fn settings(app: AppHandle) -> Result<Settings, String> {
    read_settings(&app)
}

/// Held across each read-check-write of a file, so two commands on workers can't interleave one.
static WRITING: Mutex<()> = Mutex::new(());

/// Sets `patch`'s keys in settings.json. Read-modify-write, so windows never clobber each other's
/// changes. Fails rather than overwrite a file that was hand-edited into invalid JSON.
#[tauri::command(async)]
fn update_settings(app: AppHandle, patch: Map<String, Value>) -> Result<(), String> {
    let _writing = WRITING.lock().unwrap();
    let settings = merge(read_settings(&app)?, patch)?;
    let dir = config_dir(&app);
    fs::create_dir_all(&dir).map_err(err)?;
    fs::write(dir.join("settings.json"), serde_json::to_string_pretty(&settings).map_err(err)?).map_err(err)
}

#[derive(Serialize)]
struct Entry {
    name: String,
    dir: bool,
}

/// Directory listing; `""` lists drive roots, or on Linux the root. Skips what the file manager hides:
/// on Windows the hidden and system attributes, and on Linux names that start with a dot.
#[tauri::command(async)]
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

/// A file's text as a file tab holds it: UTF-8 without the BOM.
fn decode(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(bytes.strip_prefix(BOM).unwrap_or(bytes))
}

/// A file's text for a file tab. Refuses binary files and files over 4 MiB.
#[tauri::command(async)]
fn read_text(path: String) -> Result<String, String> {
    if fs::metadata(&path).map_err(err)?.len() > 4 << 20 {
        return Err("it's over 4 MiB".into());
    }
    let bytes = fs::read(&path).map_err(err)?;
    if bytes.contains(&0) {
        return Err("it isn't text".into());
    }
    Ok(decode(&bytes).into_owned())
}

/// When a file last changed, and its size. A file tab rereads the file only when this changes.
#[tauri::command(async)]
fn file_stamp(path: String) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    Some(format!("{:?} {}", meta.modified().ok()?, meta.len()))
}

/// What each path names: 0 nothing, 1 a file, 2 a folder. A Claude tab asks about the paths in a row
/// of its text once the mouse rests on it, and links those that exist.
#[tauri::command(async)]
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

/// Saves a file tab and keeps the file's BOM. Writes nothing and returns false when the file no
/// longer holds `base`, the text the tab last read; with no `base` it overwrites.
#[tauri::command(async)]
fn write_text(path: String, text: String, base: Option<String>) -> Result<bool, String> {
    let _writing = WRITING.lock().unwrap();
    let old = match fs::read(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        read => read.map_err(err)?,
    };
    if std::str::from_utf8(&old).is_err() {
        return Err("it isn't UTF-8, and saving would garble it".into());
    }
    if base.is_some_and(|b| decode(&old) != b) {
        return Ok(false);
    }
    let bom = if old.starts_with(BOM) { BOM } else { b"" };
    fs::write(&path, [bom, text.as_bytes()].concat()).map_err(err)?;
    Ok(true)
}

/// Makes an empty file, or a folder. Fails rather than touch one that exists.
#[tauri::command(async)]
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
/// `--disable-gpu`. It reads settings.json from where Tauri keeps it, before any thread exists to read the
/// environment it sets. Software compositing costs far more: on Xvfb, a third of the memory and CPU go.
#[cfg(target_os = "linux")]
fn render_on_the_cpu_unless_gpu() {
    const VAR: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| Path::new(&h).join(".config")));
    let gpu = config
        .and_then(|dir| fs::read_to_string(dir.join("dev.nook.app").join("settings.json")).ok())
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .is_some_and(|s| s.gpu);
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
#[tauri::command]
fn bench(event: String, ms: Option<f64>) {
    let now = STARTED.get().map_or(0.0, |t| t.elapsed().as_secs_f64() * 1000.0);
    println!("bench {event} {:.1} {now:.1}", ms.unwrap_or(now));
}

fn main() {
    STARTED.get_or_init(Instant::now);
    for key in INHERITED_SESSION_MARKERS {
        std::env::remove_var(key); // before any thread exists
    }
    #[cfg(target_os = "linux")]
    render_on_the_cpu_unless_gpu();
    tauri::Builder::default()
        .manage(pty::Sessions::default())
        .setup(|app| {
            let bench = std::env::var_os("NOOK_BENCH").is_some();
            if bench {
                self::bench("mark:setup".into(), None);
            }
            let settings = read_settings(app.handle()).unwrap_or_default();
            priority::keep_typing_path_elevated(settings.command.first().map_or("", String::as_str));
            // `nook <dir>` opens there; otherwise in the last session's folder.
            let start = std::env::args()
                .nth(1)
                .as_deref()
                .and_then(dir_arg)
                .or(Some(settings.last_dir).filter(|d| Path::new(d).is_dir()))
                .unwrap_or_else(|| Settings::default().last_dir);
            // Browser args, and on Linux the compositing mode, are fixed when the webview starts: a change
            // to `gpu` takes a restart.
            let gpu = if settings.gpu { "" } else { " --disable-gpu" };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("nook")
                .inner_size(1280.0, 820.0)
                .min_inner_size(520.0, 320.0)
                .decorations(false)
                // The window shows once its page has loaded. Shown sooner, it asks the webview for a frame
                // before the web process can draw one: WebKitGTK then holds both processes for its 500 ms
                // timeout, which every open waited out at first, and two in five still did when the window
                // showed as the page started to load.
                .visible(false)
                .on_page_load(|window, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        let _ = window.show();
                    }
                })
                .background_color(tauri::window::Color(20, 18, 28, 255))
                .additional_browser_args(&format!("{WRY_ARGS}{gpu}"))
                .initialization_script(format!(
                    "window.NOOK_CWD = {}; window.NOOK_BENCH = {};",
                    serde_json::to_string(&start)?,
                    bench
                ))
                // The settings drawer's font pickers list installed fonts through queryLocalFonts().
                .on_permission_request(|_, kind| match kind {
                    PermissionKind::LocalFonts => PermissionResponse::Allow,
                    _ => PermissionResponse::Default,
                })
                .build()?;
            // Should the page never start, the window shows anyway.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                if let Some(window) = handle.get_webview_window("main").filter(|w| matches!(w.is_visible(), Ok(false))) {
                    let _ = window.show();
                }
            });
            if bench {
                self::bench("mark:window".into(), None);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                window.state::<pty::Sessions>().close_all();
            }
        })
        // A command without `async` runs on the main thread, where it would hold up the keystrokes queued
        // behind it. Only the PTY's writes, resizes, and closes and the shell's quick calls stay there.
        .invoke_handler(tauri::generate_handler![
            bench,
            boot,
            settings,
            update_settings,
            theme::read_theme,
            theme::install_theme,
            theme::install_theme_zip,
            theme::zip_holds_theme,
            list_dir,
            index::index_files,
            file_stamp,
            path_kinds,
            read_text,
            write_text,
            create_path,
            shell::open_path,
            shell::reveal,
            shell::recycle,
            shell::rename_path,
            shell::copy_files,
            shell::can_paste,
            shell::copied_paths,
            shell::paste_files,
            shell::drop_files,
            git::git,
            git::git_status,
            git::git_diff,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_state,
            pty::pty_states,
            history::claude_sessions,
            commands::claude_commands,
            pty::pty_command,
            pty::session_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nook");
}

#[cfg(test)]
mod tests {
    use super::{dir_arg, merge, read_text, write_text, Settings};
    use serde_json::json;
    use std::fs;

    #[test]
    fn merges_a_patch_and_refuses_a_wrong_type() {
        let patch = |v: serde_json::Value| v.as_object().unwrap().clone();
        let s = merge(Settings::default(), patch(json!({ "gpu": true, "gitWidth": 300 }))).unwrap();
        assert!(s.gpu);
        assert_eq!((s.git_width, s.files_width), (Some(300), None));
        assert!(merge(Settings::default(), patch(json!({ "command": "claude" }))).is_err());
    }

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
