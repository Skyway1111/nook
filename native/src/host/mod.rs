//! nook's native host: one window around one webview, the page's calls into Rust, and the files it loads.
//! Windows draws it with Win32 and WebView2, Linux with GTK 3 and WebKitGTK 4.1, both through hand-written
//! bindings, and both speak the same protocol to the page (ipc.rs, and host.js on the page's side).
mod assets;
#[cfg(debug_assertions)]
mod dev;
pub mod ipc;
mod mime;

#[cfg(target_os = "linux")]
pub(crate) mod gtk;
#[cfg(target_os = "linux")]
use gtk as plat;
#[cfg(windows)]
mod win;
#[cfg(windows)]
use win as plat;

#[cfg(debug_assertions)]
pub use assets::ROOT;
pub(crate) use ipc::cmd;
pub use ipc::{emit, Args, Bytes, Command, Commands, Out, Reply, Run, Stream};
#[cfg(windows)]
pub use win::{hwnd, post};

pub struct Config {
    pub title: &'static str,
    /// Client size and minimum client size, in logical pixels.
    pub size: (i32, i32),
    pub min: (i32, i32),
    /// What shows where the page hasn't painted.
    pub background: [u8; 3],
    /// The webview's profile: WebView2's user data folder, or WebKit's data and cache folder.
    pub data_dir: String,
    /// WebView2's browser arguments; these replace its defaults.
    #[cfg(windows)]
    pub browser_args: String,
    /// Runs before the page's own scripts, in every frame.
    pub init_script: String,
    /// Runs once the webview exists and has been asked for the page.
    pub on_webview: fn(),
    /// The window icon, a PNG. Windows takes resource 32512 of the exe instead.
    #[cfg(target_os = "linux")]
    pub icon: &'static [u8],
    /// The paths under the app's folder whose edits apply live (dev.rs).
    #[cfg(debug_assertions)]
    pub watch: &'static [&'static str],
}

/// Opens the window and runs until it's closed. `commands` is the app's command table.
pub fn run(cfg: Config, commands: Commands) -> Result<(), String> {
    ipc::init(commands);
    #[cfg(debug_assertions)]
    dev::watch(cfg.watch);
    plat::run(cfg)
}
