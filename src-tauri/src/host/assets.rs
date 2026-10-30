//! What the page loads, the same on both platforms: nook's own files, compiled into the exe (read from disk in a
//! debug build), files on disk at `<FILES><percent-encoded path>`, and fetches of byte-carrying commands at
//! `/__ipc/<cmd>`. Each platform hands requests here and turns a `Reply` into its own response.
use super::ipc::Out;
use super::mime::mime;
use std::fs::File;

// Debug: `ROOT`, the repository, whose files the page loads. Release: `ASSETS`, the page's files.
include!(concat!(env!("OUT_DIR"), "/assets.rs"));

/// The page's origin; it reads files cross-origin.
#[cfg(windows)]
const ORIGIN: &str = "http://tauri.localhost";
#[cfg(windows)]
const FILES: &str = "http://asset.localhost/";
#[cfg(target_os = "linux")]
const ORIGIN: &str = "tauri://localhost";
#[cfg(target_os = "linux")]
const FILES: &str = "asset://localhost/";
/// The most of a file one ranged response carries; media asks again for the rest.
const RANGE_MAX: u64 = 1000 * 1024;

pub enum Route {
    /// An app file, by path.
    App(String),
    /// A command, by name.
    Ipc(String),
    /// A file on disk, by path.
    File(String),
}

/// The URL of app file `path`.
pub fn url(path: &str) -> String {
    format!("{ORIGIN}/{path}")
}

/// Whether `url` is one of the app's own pages.
pub fn ours(url: &str) -> bool {
    url.strip_prefix(ORIGIN).is_some_and(|p| p.starts_with('/'))
}

pub fn route(uri: &str) -> Option<Route> {
    if let Some(path) = uri.strip_prefix(ORIGIN).and_then(|p| p.strip_prefix('/')) {
        let path = decode(path);
        Some(match path.strip_prefix("__ipc/") {
            Some(cmd) => Route::Ipc(cmd.into()),
            None => Route::App(path),
        })
    } else {
        uri.strip_prefix(FILES).map(|path| Route::File(decode(path)))
    }
}

pub struct Reply {
    pub status: u16,
    pub reason: &'static str,
    /// `Name: value` lines, joined by CRLF.
    pub headers: String,
    pub body: Option<Body>,
}

pub enum Body {
    #[cfg_attr(debug_assertions, allow(dead_code))]
    Static(&'static [u8]),
    Owned(Vec<u8>),
    /// A file's bytes from an offset, for a length.
    File(File, u64, u64),
}

impl Body {
    pub fn len(&self) -> u64 {
        match self {
            Body::Static(s) => s.len() as u64,
            Body::Owned(v) => v.len() as u64,
            Body::File(_, _, n) => *n,
        }
    }
}

fn reply(status: u16, reason: &'static str, headers: String, body: Option<Body>) -> Reply {
    Reply { status, reason, headers, body }
}

/// The path of a URL's path: query and fragment dropped, percent-decoded.
fn decode(path: &str) -> String {
    let b = path.split(['?', '#']).next().unwrap_or("").as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        match (b[i], b.get(i + 1).and_then(|&c| hex(c)), b.get(i + 2).and_then(|&c| hex(c))) {
            (b'%', Some(h), Some(l)) => {
                out.push((h * 16 + l) as u8);
                i += 3;
            }
            (c, ..) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// An app file. A debug build reads it from disk each time, so an edit shows on reload.
pub fn app(path: &str) -> Reply {
    let path = if path.is_empty() { "index.html" } else { path };
    #[cfg(debug_assertions)]
    let found = std::fs::read(format!("{ROOT}/{path}")).ok().map(|b| (mime(path), Body::Owned(b), "\r\nCache-Control: no-store"));
    #[cfg(not(debug_assertions))]
    let found = ASSETS.binary_search_by(|(p, ..)| (*p).cmp(path)).ok().map(|i| (ASSETS[i].1, Body::Static(ASSETS[i].2), ""));
    match found {
        Some((mime, body, cache)) => reply(200, "OK", format!("Content-Type: {mime}{cache}"), Some(body)),
        None => not_found(),
    }
}

pub fn not_found() -> Reply {
    reply(404, "Not Found", String::new(), None)
}

/// Whether a request to `/__ipc/` may run its command: a POST from the app's own origin, which the browser
/// sets and no page can. An `<img>`, a link, or a form in a file nook shows can't.
pub fn may_call(method: &str, origin: Option<&str>) -> bool {
    method == "POST" && origin == Some(ORIGIN)
}

pub fn forbidden() -> Reply {
    reply(403, "Forbidden", String::new(), None)
}

/// A file on disk: the whole file, its length for a HEAD, or one `Range`. Run off the UI thread.
pub fn file(path: &str, head: bool, range: Option<&str>) -> Reply {
    let cors = || format!("Access-Control-Allow-Origin: {ORIGIN}");
    if path.split(['/', '\\']).any(|c| c == "..") {
        return reply(403, "Forbidden", cors(), None);
    }
    let Ok((file, len)) = File::open(path).and_then(|f| Ok((f.metadata()?.len(), f))).map(|(l, f)| (f, l)) else {
        return reply(404, "Not Found", cors(), None);
    };
    let base = format!("Content-Type: {}\r\n{}\r\nAccept-Ranges: bytes", mime(path), cors());
    match range.and_then(|r| ranged(r, len)) {
        Some(Some((first, last))) => {
            let last = last.min(first + RANGE_MAX - 1);
            let n = last - first + 1;
            let headers = format!(
                "{base}\r\nContent-Length: {n}\r\nContent-Range: bytes {first}-{last}/{len}\r\nAccess-Control-Expose-Headers: content-range"
            );
            reply(206, "Partial Content", headers, Some(Body::File(file, first, n)))
        }
        Some(None) => reply(416, "Range Not Satisfiable", format!("{base}\r\nContent-Range: bytes */{len}"), None),
        None => {
            reply(200, "OK", format!("{base}\r\nContent-Length: {len}"), (!head).then(|| Body::File(file, 0, len)))
        }
    }
}

/// A single `bytes=` range of a `len`-byte file, as first and last byte; `Some(None)` if it can't be met,
/// and `None` (the whole file) for anything else.
fn ranged(h: &str, len: u64) -> Option<Option<(u64, u64)>> {
    let (a, b) = h.trim().strip_prefix("bytes=").filter(|s| !s.contains(','))?.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    let end = len.saturating_sub(1);
    let (first, last) = if a.is_empty() {
        (len.saturating_sub(b.parse().ok()?), end)
    } else {
        (a.parse().ok()?, if b.is_empty() { end } else { b.parse::<u64>().ok()?.min(end) })
    };
    Some((len > 0 && first <= last).then_some((first, last)))
}

/// A command fetch's arguments: the body as JSON if it was sent as JSON, otherwise as bytes.
pub fn command_args(content_type: Option<&str>, body: Vec<u8>) -> (String, Vec<u8>) {
    if content_type.is_some_and(|t| t.starts_with("application/json")) {
        (String::from_utf8(body).unwrap_or_default(), Vec::new())
    } else {
        ("null".into(), body)
    }
}

/// A command fetch's answer: bytes, JSON, or a 500 with the error's text.
pub fn command_reply(r: Result<Out, String>) -> Reply {
    match r {
        Ok(Out::Bytes(b)) => reply(200, "OK", "Content-Type: application/octet-stream".into(), Some(Body::Owned(b))),
        Ok(Out::Json(j)) => {
            reply(200, "OK", "Content-Type: application/json".into(), Some(Body::Owned(j.into_bytes())))
        }
        Err(e) => {
            reply(500, "Error", "Content-Type: text/plain; charset=utf-8".into(), Some(Body::Owned(e.into_bytes())))
        }
    }
}
