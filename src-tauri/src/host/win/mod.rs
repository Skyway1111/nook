//! Windows: a Win32 window around WebView2, both by hand. WebView2 calls back on the UI thread, whose
//! message loop runs everything here; other threads reach it through `post`.
mod drop;
mod loader;
mod serve;
mod webview;
mod window;

use super::Config;
use crate::sys;
#[cfg(debug_assertions)]
pub use webview::{eval, reload};
pub use window::{attention, destroy, drag, hwnd, maximized, minimize, post, set_title, toggle_maximize};

/// Text longer than this goes to the page as a shared buffer, not a web message. A message costs this thread
/// about 9 µs plus 11 ns a character, and a buffer about 25 µs and a copy, but the page has a message sooner.
const SHORT: usize = 4 << 10;

pub fn run(cfg: Config) -> Result<(), String> {
    window::create(&cfg);
    webview::start(cfg).inspect_err(|e| unsafe {
        sys::MessageBoxW(window::hwnd(), sys::wide(e).as_ptr(), sys::wide("nook").as_ptr(), sys::MB_ICONERROR);
    })?;
    window::run();
    Ok(())
}

/// Sends JSON `text` to the page, in order with the other messages.
pub fn send(text: &str) {
    webview::post_json(text);
}

/// Sends a reply's JSON `text`. A long one goes as a buffer marked `[0]`, which may pass other messages: replies
/// match by id.
pub fn send_reply(text: &str) {
    if text.len() <= SHORT {
        webview::post_json(text);
    } else {
        webview::post_buffer(text.as_bytes(), "[0]");
    }
}

/// Sends piece `seq` of stream `id`, whole characters, and whether the stream ends with it: a short piece as the
/// string `<id> <seq> <end>|<text>`, a long one as a buffer marked `[id, seq, end]`.
pub fn send_stream(id: u64, seq: u64, bytes: &[u8], end: bool) {
    let end = end as u8;
    if bytes.len() <= SHORT {
        let mut s = format!("{id} {seq} {end}|");
        s.push_str(&String::from_utf8_lossy(bytes));
        webview::post_string(&s);
    } else {
        webview::post_buffer(bytes, &format!("[{id},{seq},{end}]"));
    }
}

/// The color the window and the webview show where the page hasn't painted.
pub fn set_background(rgb: [u8; 3]) {
    window::set_background(rgb);
    webview::set_background(rgb);
}
