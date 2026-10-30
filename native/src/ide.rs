//! nook as Claude Code's IDE: each Claude tab gets a WebSocket on 127.0.0.1 that tells its Claude what's
//! picked in the file viewer, as Claude Code's editor extensions do. Claude finds it through the lockfile in
//! `~/.claude/ide` and the `CLAUDE_CODE_SSE_PORT` its tab starts with, and then shows "3 lines selected" by
//! its prompt and hands those lines to the model with the next message.
//!
//! An IDE also shows the edits Claude wants a yes for (`openDiff`): Claude's prompt then drops its own diff and
//! says "Opened changes in nook", so each one opens beside the Claude tab, and its Accept or Reject answers
//! Claude as the prompt's own keys do.
//!
//! The lockfile lists no workspace folders, so a Claude outside nook never takes it for its own editor.
use crate::host::emit;
use crate::json::{self, obj, Out, Raw, J, W};
use std::{
    collections::HashMap,
    hash::{BuildHasher, RandomState},
    io::{BufRead, BufReader, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
};

type Writer = Arc<Mutex<TcpStream>>;

/// What a Claude has been told, kept for a Claude that connects after the viewer spoke.
/// The edits shown, by Claude's name for each, wait on the call to answer, by its id's JSON, when one is
/// accepted or rejected.
#[derive(Default)]
struct Shared {
    peers: Vec<Writer>,
    told: Option<String>,
    diffs: HashMap<String, (Writer, String)>,
}

struct Link {
    addr: SocketAddr,
    lock: PathBuf,
    shared: Arc<Mutex<Shared>>,
    closed: Arc<AtomicBool>,
}

fn links() -> &'static Mutex<HashMap<u64, Link>> {
    static LINKS: OnceLock<Mutex<HashMap<u64, Link>>> = OnceLock::new();
    LINKS.get_or_init(Default::default)
}

/// Claude Code's own folder for these lockfiles.
fn lock_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(crate::home_dir()).join(".claude"))
        .join("ide")
}

/// 128 random bits as hex. Each `RandomState` is seeded from the system's randomness.
fn token() -> String {
    (0..2).map(|i| format!("{:016x}", RandomState::new().hash_one(i))).collect()
}

/// Opens session `id`'s link and gives the port its Claude should connect to. None if it couldn't: the tab
/// works as before, without the viewer's selection.
pub fn open(id: u64) -> Option<u16> {
    listen(id, Arc::new(move |e: Event| e.emit(id)))
}

fn listen(id: u64, tell: Arc<dyn Fn(Event) + Send + Sync>) -> Option<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").ok()?;
    let addr = listener.local_addr().ok()?;
    let auth = token();
    let dir = lock_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let lock = dir.join(format!("{}.lock", addr.port()));
    let about = obj! { "authToken": auth, "ideName": "nook", "pid": std::process::id(), "transport": "ws", "workspaceFolders": Raw("[]") };
    std::fs::write(&lock, json::to_string(&about)).ok()?;
    let shared = Arc::new(Mutex::new(Shared::default()));
    let closed = Arc::new(AtomicBool::new(false));
    let (s, c) = (shared.clone(), closed.clone());
    thread::spawn(move || {
        for stream in listener.incoming() {
            if c.load(Ordering::Relaxed) {
                break;
            }
            let (Ok(stream), s, auth, tell) = (stream, s.clone(), auth.clone(), tell.clone()) else { continue };
            thread::spawn(move || serve(stream, &auth, &s, &*tell));
        }
    });
    links().lock().unwrap().insert(id, Link { addr, lock, shared, closed });
    Some(addr.port())
}

/// Session `id` ended: its lockfile goes, and its Claude, should it still run, is let go.
pub fn close(id: u64) {
    let Some(link) = links().lock().unwrap().remove(&id) else { return };
    let _ = std::fs::remove_file(&link.lock);
    link.closed.store(true, Ordering::Relaxed);
    let _ = TcpStream::connect(link.addr); // wakes the listener, which sees it's closed
    for peer in link.shared.lock().unwrap().peers.drain(..) {
        let _ = peer.lock().unwrap().shutdown(Shutdown::Both);
    }
}

/// Tells session `id`'s Claude what the viewer shows: `path`, and the lines picked in it, from `start` to
/// `end`, each `[line, character]` counted from 0, with their `text`. No path tells it nothing is shown.
pub fn ide_selection(id: u64, path: Option<String>, start: [u32; 2], end: [u32; 2], text: Option<String>) {
    let (start, end) = (At(start), At(end));
    let selection = obj! { "end": end, "start": start };
    let mut params: Vec<(&str, &dyn W)> = vec![("selection", &selection)];
    if let Some(path) = &path {
        params.insert(0, ("filePath", path));
    }
    if let Some(text) = &text {
        params.push(("text", text));
    }
    let note = json::to_string(&obj! { "jsonrpc": "2.0", "method": "selection_changed", "params": json::Obj(&params) });
    let Some(shared) = links().lock().unwrap().get(&id).map(|l| l.shared.clone()) else { return };
    let mut shared = shared.lock().unwrap();
    shared.peers.retain(|peer| send(&mut peer.lock().unwrap(), &note).is_ok());
    shared.told = Some(note);
}

/// `[line, character]` in a selection.
struct At([u32; 2]);

impl W for At {
    fn w(&self, o: &mut Out) {
        let [line, character] = self.0;
        obj! { "character": character, "line": line }.w(o);
    }
}

/// What a Claude asked nook to show or close, for the page.
enum Event {
    Diff { tab: String, path: String, contents: String },
    Close { tab: Option<String> },
}

impl Event {
    fn emit(self, id: u64) {
        match self {
            Event::Diff { tab, path, contents } => {
                emit("ide-diff", &json::to_string(&obj! { "contents": contents, "id": id, "path": path, "tab": tab }))
            }
            Event::Close { tab } => emit("ide-diff-close", &json::to_string(&obj! { "id": id, "tab": tab })),
        }
    }
}

/// Answers the edit Claude calls `tab` in session `id`: `FILE_SAVED` with the `contents` to write,
/// `DIFF_REJECTED`, or `TAB_CLOSED`, which leaves the answer to Claude's own prompt.
pub fn ide_diff_answer(id: u64, tab: String, outcome: String, contents: Option<String>) {
    let Some(shared) = links().lock().unwrap().get(&id).map(|l| l.shared.clone()) else { return };
    let Some((writer, call)) = shared.lock().unwrap().diffs.remove(&tab) else { return };
    let _ = settle(&writer, &call, &outcome, contents);
}

/// Answers the call whose id is the JSON `call` with `outcome`, and the `contents` to write.
fn settle(writer: &Writer, call: &str, outcome: &str, contents: Option<String>) -> std::io::Result<()> {
    let content: Vec<Text> = std::iter::once(outcome).chain(contents.as_deref()).map(Text).collect();
    send(&mut writer.lock().unwrap(), &reply(call, &obj! { "content": content }))
}

/// A tool result's text part.
struct Text<'a>(&'a str);

impl W for Text<'_> {
    fn w(&self, o: &mut Out) {
        obj! { "text": self.0, "type": "text" }.w(o);
    }
}

/// The JSON-RPC reply to the call whose id is the JSON `call`.
fn reply(call: &str, result: &dyn W) -> String {
    json::to_string(&obj! { "id": Raw(call), "jsonrpc": "2.0", "result": result })
}

/// Settles the edits shown named `tab`, or all of them, as closed: Claude's prompt answered first.
fn close_diffs(shared: &Mutex<Shared>, tab: Option<&str>) {
    let mut shared = shared.lock().unwrap();
    let names: Vec<String> = shared.diffs.keys().filter(|k| tab.is_none_or(|t| t == *k)).cloned().collect();
    for name in names {
        if let Some((writer, call)) = shared.diffs.remove(&name) {
            let _ = settle(&writer, &call, "TAB_CLOSED", None);
        }
    }
}

/// One Claude's connection: the WebSocket handshake, then MCP's. Claude's `ide_connected` note makes it one that
/// hears the selection; its `openDiff` call shows an edit and waits for its answer; its other calls get an
/// empty one.
fn serve(stream: TcpStream, auth: &str, shared: &Mutex<Shared>, tell: &dyn Fn(Event)) -> Option<()> {
    // A Claude that stops reading must not hold the viewer's next note up for long.
    stream.set_write_timeout(Some(std::time::Duration::from_secs(2))).ok()?;
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let (mut key, mut allowed) = (None, false);
    loop {
        let mut line = String::new();
        if reader.by_ref().take(8192).read_line(&mut line).ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "sec-websocket-key" => key = Some(value.trim().to_owned()),
                "x-claude-code-ide-authorization" => allowed = value.trim() == auth,
                _ => {}
            }
        }
    }
    let writer = Arc::new(Mutex::new(stream));
    let (Some(key), true) = (key, allowed) else {
        let _ = writer.lock().unwrap().write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        return None;
    };
    let accept = base64(&sha1(format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes()));
    let hello = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: mcp\r\n\r\n");
    writer.lock().unwrap().write_all(hello.as_bytes()).ok()?;
    let mut message = Vec::new();
    loop {
        let (fin, op, payload) = frame(&mut reader)?;
        match op {
            0x8 => {
                let _ = write_frame(&mut writer.lock().unwrap(), 0x8, &[]);
                return None;
            }
            0x9 => write_frame(&mut writer.lock().unwrap(), 0xA, &payload).ok()?,
            0x0..=0x2 => {
                message.extend(payload);
                if !fin {
                    continue;
                }
                let text = std::mem::take(&mut message);
                let m = std::str::from_utf8(&text).ok().and_then(|t| json::parse(t).ok()).unwrap_or(J::Null);
                answer(&m, &writer, shared, tell)?;
            }
            _ => {}
        }
    }
}

fn answer(m: &J, writer: &Writer, shared: &Mutex<Shared>, tell: &dyn Fn(Event)) -> Option<()> {
    let method = m["method"].as_str().unwrap_or_default();
    if method == "ide_connected" {
        let mut shared = shared.lock().unwrap();
        if let Some(told) = &shared.told {
            send(&mut writer.lock().unwrap(), told).ok()?;
        }
        shared.peers.push(writer.clone());
        return Some(());
    }
    if m["id"].is_null() || method.is_empty() {
        return Some(()); // a note, or an answer to nothing nook asked
    }
    let call = json::to_string(&m["id"]);
    let args = &m["params"]["arguments"];
    if method == "tools/call" {
        let tab = args["tab_name"].as_str().map(str::to_owned);
        match m["params"]["name"].as_str().unwrap_or_default() {
            "openDiff" => {
                let (Some(tab), Some(path), Some(contents)) = (tab, args["new_file_path"].as_str(), args["new_file_contents"].as_str()) else {
                    return settle(writer, &call, "TAB_CLOSED", None).ok();
                };
                shared.lock().unwrap().diffs.insert(tab.clone(), (writer.clone(), call));
                tell(Event::Diff { tab, path: path.to_owned(), contents: contents.to_owned() });
                return Some(()); // answered once the edit is accepted, rejected, or closed
            }
            "close_tab" => {
                close_diffs(shared, tab.as_deref());
                tell(Event::Close { tab });
            }
            "closeAllDiffTabs" => {
                close_diffs(shared, None);
                tell(Event::Close { tab: None });
            }
            _ => {}
        }
    }
    let out = match method {
        "initialize" => reply(&call, &obj! {
            "capabilities": obj! { "tools": obj! {} },
            "protocolVersion": m["params"]["protocolVersion"],
            "serverInfo": obj! { "name": "nook", "version": env!("CARGO_PKG_VERSION") },
        }),
        "tools/list" => reply(&call, &obj! { "tools": Raw("[]") }),
        "tools/call" => reply(&call, &obj! { "content": Raw("[]") }),
        _ => reply(&call, &obj! {}),
    };
    send(&mut writer.lock().unwrap(), &out).ok()
}

fn send(stream: &mut TcpStream, text: &str) -> std::io::Result<()> {
    write_frame(stream, 0x1, text.as_bytes())
}

/// A whole, unmasked frame: a server's frames carry no mask.
fn write_frame(stream: &mut TcpStream, op: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut out = vec![0x80 | op];
    match payload.len() {
        n @ 0..=125 => out.push(n as u8),
        n @ 126..=0xFFFF => out.extend([&[126][..], &(n as u16).to_be_bytes()].concat()),
        n => out.extend([&[127][..], &(n as u64).to_be_bytes()].concat()),
    }
    out.extend_from_slice(payload);
    stream.write_all(&out)
}

/// The next frame: whether it ends its message, its opcode, and its payload, unmasked.
fn frame(r: &mut impl Read) -> Option<(bool, u8, Vec<u8>)> {
    let mut head = [0; 2];
    r.read_exact(&mut head).ok()?;
    let mut len = u64::from(head[1] & 0x7F);
    if len == 126 {
        let mut n = [0; 2];
        r.read_exact(&mut n).ok()?;
        len = u16::from_be_bytes(n).into();
    } else if len == 127 {
        let mut n = [0; 8];
        r.read_exact(&mut n).ok()?;
        len = u64::from_be_bytes(n);
    }
    if len > 64 << 20 {
        return None; // no message of Claude's comes near this
    }
    let mut mask = [0; 4];
    if head[1] & 0x80 != 0 {
        r.read_exact(&mut mask).ok()?;
    }
    let mut payload = vec![0; len as usize];
    r.read_exact(&mut payload).ok()?;
    payload.iter_mut().enumerate().for_each(|(i, b)| *b ^= mask[i & 3]);
    Some((head[0] & 0x80 != 0, head[0] & 0x0F, payload))
}

/// SHA-1, which the WebSocket handshake asks for and nothing else in nook does.
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend((data.len() as u64 * 8).to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(chunk[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.into_iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(wi);
            (e, d, c, b, a) = (d, c, b.rotate_left(30), a, t);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0; 20];
    for (i, x) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&x.to_be_bytes());
    }
    out
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = u32::from(c[0]) << 16 | u32::from(*c.get(1).unwrap_or(&0)) << 8 | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..4 {
            out.push(if i <= c.len() { ABC[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_the_handshake_as_rfc_6455_shows() {
        let key = "dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        assert_eq!(base64(&sha1(key.as_bytes())), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"a"), "YQ==");
    }

    #[test]
    fn reads_a_masked_frame_and_writes_a_long_one() {
        let text = b"{\"method\":\"ide_connected\"}";
        let mask = [1, 2, 3, 4];
        let mut wire = vec![0x81, 0x80 | text.len() as u8];
        wire.extend(mask);
        wire.extend(text.iter().enumerate().map(|(i, b)| b ^ mask[i & 3]));
        assert_eq!(frame(&mut &wire[..]), Some((true, 1, text.to_vec())));

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut out = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let mut back = listener.accept().unwrap().0;
        let long = "x".repeat(70_000);
        send(&mut out, &long).unwrap();
        let (fin, op, payload) = frame(&mut back).unwrap();
        assert!(fin && op == 1 && payload == long.as_bytes());
    }

    #[test]
    fn a_link_tells_a_connected_claude_what_is_picked() {
        let dir = std::env::temp_dir().join(format!("nook-ide-{}", std::process::id()));
        std::env::set_var("CLAUDE_CONFIG_DIR", &dir);
        let shown = Arc::new(Mutex::new(Vec::new()));
        let seen = shown.clone();
        let port = listen(7_000_001, Arc::new(move |e| if let Event::Diff { tab, .. } = e { seen.lock().unwrap().push(tab) })).unwrap();
        let lock = std::fs::read_to_string(dir.join(format!("ide/{port}.lock"))).unwrap();
        let lock = json::parse(&lock).unwrap();
        assert_eq!(lock["transport"], "ws");
        assert_eq!(lock["workspaceFolders"], J::Arr(Vec::new()));

        let mut claude = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let auth = lock["authToken"].as_str().unwrap();
        write!(claude, "GET / HTTP/1.1\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nX-Claude-Code-Ide-Authorization: {auth}\r\n\r\n").unwrap();
        let mut reader = BufReader::new(claude.try_clone().unwrap());
        let mut status = String::new();
        reader.read_line(&mut status).unwrap();
        assert!(status.contains("101"), "{status}");
        while { let mut l = String::new(); reader.read_line(&mut l).unwrap(); l != "\r\n" } {}
        send(&mut claude, r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}"#).unwrap();
        let (_, _, init) = frame(&mut reader).unwrap();
        let version = env!("CARGO_PKG_VERSION");
        let server = format!(r#""serverInfo":{{"name":"nook","version":"{version}"}}"#);
        let want = format!(r#"{{"id":0,"jsonrpc":"2.0","result":{{"capabilities":{{"tools":{{}}}},"protocolVersion":"2025-11-25",{server}}}}}"#);
        assert_eq!(String::from_utf8(init).unwrap(), want);
        send(&mut claude, r#"{"jsonrpc":"2.0","method":"ide_connected","params":{"pid":1}}"#).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));

        ide_selection(7_000_001, Some("/a/b.txt".into()), [1, 0], [2, 5], Some("beta\ngamma".into()));
        let (_, _, note) = frame(&mut reader).unwrap();
        let selection = r#""selection":{"end":{"character":5,"line":2},"start":{"character":0,"line":1}}"#;
        let want = format!(r#"{{"jsonrpc":"2.0","method":"selection_changed","params":{{"filePath":"/a/b.txt",{selection},"text":"beta\ngamma"}}}}"#);
        assert_eq!(String::from_utf8(note).unwrap(), want);

        // An edit to show waits for its answer, which carries the contents to write.
        send(&mut claude, r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"openDiff","arguments":{"old_file_path":"/a/b.txt","new_file_path":"/a/b.txt","new_file_contents":"new","tab_name":"t1"}}}"#).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(*shown.lock().unwrap(), ["t1"]);
        ide_diff_answer(7_000_001, "t1".into(), "FILE_SAVED".into(), Some("new!".into()));
        let (_, _, saved) = frame(&mut reader).unwrap();
        let want = r#"{"id":5,"jsonrpc":"2.0","result":{"content":[{"text":"FILE_SAVED","type":"text"},{"text":"new!","type":"text"}]}}"#;
        assert_eq!(saved, want.as_bytes());

        // One Claude's prompt answered first: closing the tab settles it as closed.
        send(&mut claude, r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"openDiff","arguments":{"new_file_path":"/a/b.txt","new_file_contents":"x","tab_name":"t2"}}}"#).unwrap();
        send(&mut claude, r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"close_tab","arguments":{"tab_name":"t2"}}}"#).unwrap();
        let (_, _, closed) = frame(&mut reader).unwrap();
        assert_eq!(closed, br#"{"id":6,"jsonrpc":"2.0","result":{"content":[{"text":"TAB_CLOSED","type":"text"}]}}"#);

        close(7_000_001);
        assert!(!dir.join(format!("ide/{port}.lock")).exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
