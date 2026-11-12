//! Where the Claude tabs' sessions live: a keeper, nook started again as `nook --keeper`, so they outlive a window
//! that crashes, restarts, or is closed for an update. A keeper lists itself in `<data>/keeper/<pid>` as
//! `<port> <token>`. A window takes every keeper no window holds, and starts one of its own when it took none. A
//! keeper serves one window at a time, on 127.0.0.1, behind the token.
//!
//! The wire: the window greets with `<token> <VERSION>\n` and hears `<VERSION> <pid> <next>\n`, or `busy`. Then
//! both send frames: an op, a session's id, a length, and a body. The window sends S (start), A (attach), K (keys),
//! Z (size), C (close), L (list), and Q (end every session); the keeper sends R (done) or E (why not) for S, A,
//! and L, O (output), and X (the session's shell exited).
use crate::{err, host::Stream};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    ffi::OsString,
    fmt::Write as _,
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering::Relaxed},
        mpsc::{channel, Receiver, RecvTimeoutError, Sender},
        Arc, Mutex, Once,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg_attr(windows, path = "pty_windows.rs")]
#[cfg_attr(unix, path = "pty_unix.rs")]
mod os;

/// The argument that makes a nook a keeper.
pub const FLAG: &str = "--keeper";
/// A keeper and a window of different versions don't speak: the keeper ends its sessions instead.
const VERSION: u32 = 1;
/// A session's id is its keeper's pid, then its number there in this many bits.
pub const NUMBER: u32 = 20;
/// How much of the normal screen's output a keeper holds for a session's next terminal.
const HISTORY: usize = 1 << 20;
/// How long after its sessions last wrote a keeper no window holds ends them.
const QUIET: Duration = Duration::from_secs(600);
/// The longest an attach waits for a program's redraw one row short before giving it its true size.
const NUDGE: Duration = Duration::from_millis(500);
const ESC: u8 = 0x1b;

fn send(to: &mut impl Write, op: u8, id: u64, body: &[u8]) -> io::Result<()> {
    let mut frame = Vec::with_capacity(13 + body.len());
    frame.push(op);
    frame.extend(id.to_le_bytes());
    frame.extend((body.len() as u32).to_le_bytes());
    frame.extend(body);
    to.write_all(&frame)
}

fn frame(from: &mut impl Read) -> io::Result<(u8, u64, Vec<u8>)> {
    let mut head = [0; 13];
    from.read_exact(&mut head)?;
    let mut body = vec![0; u32::from_le_bytes(head[9..].try_into().unwrap()) as usize];
    from.read_exact(&mut body)?;
    Ok((head[0], u64::from_le_bytes(head[1..9].try_into().unwrap()), body))
}

/// The other side's greeting, a line, given 2 s to come. The wait is set on the handle that reads: Windows keeps
/// it for each handle of a socket, not for the socket.
fn greeting(from: &mut BufReader<TcpStream>) -> io::Result<String> {
    let mut line = String::new();
    from.get_ref().set_read_timeout(Some(Duration::from_secs(2)))?;
    from.read_line(&mut line)?;
    from.get_ref().set_read_timeout(None)?;
    Ok(line)
}

fn size(body: &[u8]) -> (u16, u16) {
    let n = |at: usize| body.get(at..at + 2).map_or(1, |b| u16::from_le_bytes([b[0], b[1]]));
    (n(0), n(2))
}

/// Where keepers list themselves, and on Windows where their program's copy lives.
fn dir() -> PathBuf {
    crate::data_dir().join("keeper")
}

// The keeper's side

/// What a new terminal needs to show a session as its last one did: the normal screen's output, the newest
/// `HISTORY` bytes of it, and the modes its programs left set. The alternate screen's output isn't kept, since a
/// program there draws it all again for a new size.
struct Trail {
    history: VecDeque<u8>,
    /// Whether the history lost its start.
    cut: bool,
    /// Each DEC private mode a program set or reset, as it stands.
    modes: Vec<(u16, bool)>,
    /// The cursor's shape, as the DECSCUSR that set it.
    cursor: Vec<u8>,
    alt: bool,
    /// An escape sequence under way.
    seq: Vec<u8>,
    size: (u16, u16),
    /// The size a program gets once it has redrawn for one a row short.
    nudge: Option<(u16, u16)>,
}

impl Trail {
    fn new(size: (u16, u16)) -> Trail {
        Trail { history: VecDeque::new(), cut: false, modes: Vec::new(), cursor: Vec::new(), alt: false, seq: Vec::new(), size, nudge: None }
    }

    /// Takes in what the session wrote. Returns the size its program is due, when this holds the redraw a nudge
    /// waited for.
    fn feed(&mut self, mut bytes: &[u8]) -> Option<(u16, u16)> {
        let mut due = None;
        while let Some(&b) = bytes.first() {
            if self.seq.is_empty() {
                let n = bytes.iter().position(|&b| b == ESC).unwrap_or(bytes.len());
                self.keep(&bytes[..n]);
                bytes = &bytes[n..];
                if !bytes.is_empty() {
                    self.seq.push(ESC);
                    bytes = &bytes[1..];
                }
                continue;
            }
            bytes = &bytes[1..];
            // ESC and one byte, or ESC [ and a CSI's parameters up to its final byte. Anything else is no sequence.
            let csi = self.seq.get(1) == Some(&b'[');
            if b == ESC || (csi && !(0x20..=0x7e).contains(&b)) || self.seq.len() > 64 {
                let seq = std::mem::take(&mut self.seq);
                self.keep(&seq);
                if b == ESC { self.seq.push(b) } else { self.keep(&[b]) }
                continue;
            }
            self.seq.push(b);
            if (self.seq.len() == 2 && b == b'[') || (csi && b < 0x40) {
                continue;
            }
            let seq = std::mem::take(&mut self.seq);
            if self.note(&seq) {
                self.keep(&seq);
            }
            if seq == b"\x1b[2J" {
                due = self.nudge.take().or(due);
            }
        }
        due
    }

    /// Notes what a whole sequence changes, and says whether it belongs in the history: a switch of screens doesn't.
    fn note(&mut self, seq: &[u8]) -> bool {
        match seq {
            [ESC, b'c'] => {
                self.modes.clear();
                self.cursor.clear();
                self.alt = false;
                true
            }
            [ESC, b'[', b'?', modes @ .., set @ (b'h' | b'l')] => {
                let (on, mut screens) = (*set == b'h', false);
                for mode in modes.split(|&b| b == b';').filter_map(|m| std::str::from_utf8(m).ok()?.parse().ok()) {
                    match mode {
                        47 | 1047 | 1049 => (self.alt, screens) = (on, true),
                        2026 => {} // a synchronized update, which ends on its own
                        _ => match self.modes.iter().position(|m| m.0 == mode) {
                            Some(known) => self.modes[known].1 = on,
                            None if self.modes.len() < 64 => self.modes.push((mode, on)),
                            None => {}
                        },
                    }
                }
                !screens
            }
            [ESC, b'[', .., b' ', b'q'] => {
                self.cursor = seq.to_vec();
                true
            }
            _ => true,
        }
    }

    fn keep(&mut self, bytes: &[u8]) {
        if self.alt {
            return;
        }
        self.history.extend(bytes);
        if self.history.len() > HISTORY {
            self.history.drain(..self.history.len() - HISTORY);
            self.cut = true;
        }
    }

    /// The history, from a line's start, and the sequences that set the modes again.
    fn replay(&self) -> (Vec<u8>, String) {
        let (a, b) = self.history.as_slices();
        let mut history = [a, b].concat();
        if self.cut {
            history.drain(..history.iter().position(|&b| b == b'\n').map_or(history.len(), |n| n + 1));
        }
        let mut modes = String::from(if self.alt { "\x1b[?1049h" } else { "" });
        for (mode, on) in &self.modes {
            let _ = write!(modes, "\x1b[?{mode}{}", if *on { 'h' } else { 'l' });
        }
        modes.push_str(&String::from_utf8_lossy(&self.cursor));
        (history, modes)
    }
}

/// What a tab sends its PTY.
enum Input {
    Keys(String),
    Size(u16, u16),
}

/// What a session's output passes through on its way to the window.
struct Feed {
    trail: Mutex<Trail>,
    /// Whether a window's terminal shows the session.
    attached: AtomicBool,
    /// To the session's writer, which writes keys and applies sizes in the order they came.
    input: Sender<Input>,
}

impl Feed {
    fn out(&self, id: u64, bytes: &[u8]) {
        let mut trail = self.trail.lock().unwrap();
        if let Some((cols, rows)) = trail.feed(bytes) {
            let _ = self.input.send(Input::Size(cols, rows));
        }
        if self.attached.load(Relaxed) {
            tell(b'O', id, bytes);
        }
        *HEARD.lock().unwrap() = Some(Instant::now());
    }
}

struct Session {
    pty: Arc<os::Pty>,
    feed: Arc<Feed>,
    /// The window's own notes on the session, which the next window reads.
    meta: String,
}

static SESSIONS: Mutex<BTreeMap<u64, Session>> = Mutex::new(BTreeMap::new());
/// The window that holds this keeper.
static WINDOW: Mutex<Option<TcpStream>> = Mutex::new(None);
/// When a session last wrote or a window last left.
static HEARD: Mutex<Option<Instant>> = Mutex::new(None);
/// The next session's number.
static NEXT: AtomicU64 = AtomicU64::new(0);
/// Whether this keeper is a thread of the window's own process, which it mustn't end.
static INSIDE: AtomicBool = AtomicBool::new(false);

/// Sends the window a frame. A window that can't take it is let go, and its reader hears of that.
fn tell(op: u8, id: u64, body: &[u8]) {
    if let Some(window) = &mut *WINDOW.lock().unwrap() {
        if send(window, op, id, body).is_err() {
            let _ = window.shutdown(Shutdown::Both);
        }
    }
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

/// Starts session `id` from an S frame's body, NUL between its parts: the size, the folder, the window's notes,
/// how many words the command has and each one, then each variable's name and value.
fn start(id: u64, body: &[u8]) -> Result<(), String> {
    let text = String::from_utf8_lossy(body);
    let parts: Vec<&str> = text.split('\0').collect();
    let [cols, rows, cwd, meta, words, rest @ ..] = &parts[..] else { return Err("a session needs a command".into()) };
    let size = (cols.parse().unwrap_or(80), rows.parse().unwrap_or(24));
    let (command, vars) = rest.split_at(words.parse::<usize>().unwrap_or(0).min(rest.len()));
    let vars: Vec<(&str, OsString)> = vars.as_chunks().0.iter().map(|[name, value]| (*name, value.into())).collect();
    let Some((program, args)) = command.split_first() else { return Err("a session needs a command".into()) };
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let (pty, exit) = os::open(size.0, size.1).and_then(|console| console.spawn(program, &args, cwd, &vars)).map_err(err)?;
    let pty = Arc::new(pty);
    let (input, keys) = channel();
    let feed = Arc::new(Feed { trail: Mutex::new(Trail::new(size)), attached: AtomicBool::new(true), input });
    let out = feed.clone();
    pty.output(Box::new(move |bytes: &[u8]| out.out(id, bytes)));
    let shared = pty.clone();
    thread::spawn(move || writer(shared, keys));
    NEXT.fetch_max((id & ((1 << NUMBER) - 1)) + 1, Relaxed);
    SESSIONS.lock().unwrap().insert(id, Session { pty, feed, meta: meta.to_string() });
    // The shell exited: its tab closes.
    thread::spawn(move || {
        exit.wait();
        if close(id).is_some() {
            tell(b'X', id, &[]);
        }
        rest_or_leave();
    });
    Ok(())
}

/// Shows session `id` to the window's new terminal, of the size in `body`: the reply is the history's length, the
/// history, then the modes, and the session's output follows it. A program on the alternate screen draws only
/// what changed, so it gets a size to draw everything for: the terminal's, or when it has that already, one a
/// row short and then the terminal's, once it has redrawn (ESC [ 2 J) or `NUDGE` has passed.
fn attach(id: u64, body: &[u8]) {
    let Some(feed) = SESSIONS.lock().unwrap().get(&id).map(|s| s.feed.clone()) else { return tell(b'E', id, b"its session has ended") };
    let (cols, rows) = size(body);
    let mut trail = feed.trail.lock().unwrap();
    let (history, modes) = trail.replay();
    tell(b'R', id, &[&(history.len() as u32).to_le_bytes(), &history[..], modes.as_bytes()].concat());
    feed.attached.store(true, Relaxed);
    let same = std::mem::replace(&mut trail.size, (cols, rows)) == (cols, rows);
    if !(trail.alt && same) {
        let _ = feed.input.send(Input::Size(cols, rows));
        return;
    }
    trail.nudge = Some((cols, rows));
    let _ = feed.input.send(Input::Size(cols, if rows > 1 { rows - 1 } else { 2 }));
    drop(trail);
    thread::spawn(move || {
        thread::sleep(NUDGE);
        if let Some((cols, rows)) = feed.trail.lock().unwrap().nudge.take() {
            let _ = feed.input.send(Input::Size(cols, rows));
        }
    });
}

/// Ends session `id`, on a thread of its own, since closing a console ends every process attached to it and can
/// block meanwhile. None if it had ended.
fn close(id: u64) -> Option<thread::JoinHandle<()>> {
    let session = SESSIONS.lock().unwrap().remove(&id)?;
    Some(thread::spawn(move || session.pty.close()))
}

/// Ends every session and waits for each: on Windows the keeper serves their consoles, and their processes would
/// outlive it. Then the keeper has nothing left to keep.
fn end_sessions() {
    let all = std::mem::take(&mut *SESSIONS.lock().unwrap());
    let ends: Vec<_> = all.into_values().map(|s| thread::spawn(move || s.pty.close())).collect();
    for end in ends {
        let _ = end.join();
    }
    rest_or_leave();
}

/// Leaves once there's no session to keep and no window to start one.
fn rest_or_leave() {
    if !SESSIONS.lock().unwrap().is_empty() || WINDOW.lock().unwrap().is_some() || INSIDE.load(Relaxed) {
        return;
    }
    let _ = fs::remove_file(dir().join(std::process::id().to_string()));
    std::process::exit(0);
}

/// One window's connection, from its greeting until it goes.
fn serve_window(socket: TcpStream, token: &str, quiet: Duration) -> Option<()> {
    socket.set_nodelay(true).ok()?;
    let mut from = BufReader::new(socket.try_clone().ok()?);
    let hello = greeting(&mut from).ok()?;
    let version = hello.trim_end().strip_prefix(token)?.strip_prefix(' ')?;
    let mut window = WINDOW.lock().unwrap();
    if window.is_some() {
        return (&socket).write_all(b"busy\n").ok();
    }
    (&socket).write_all(format!("{VERSION} {} {}\n", std::process::id(), NEXT.load(Relaxed)).as_bytes()).ok()?;
    if version != VERSION.to_string() {
        drop(window);
        end_sessions(); // a nook that can't hold these sessions: they end rather than wait for none
        return None;
    }
    *window = Some(socket);
    drop(window);
    while let Ok((op, id, body)) = frame(&mut from) {
        let feed = || SESSIONS.lock().unwrap().get(&id).map(|s| s.feed.clone());
        match op {
            b'S' => match start(id, &body) {
                Ok(()) => tell(b'R', id, &[]),
                Err(e) => tell(b'E', id, e.as_bytes()),
            },
            b'A' => attach(id, &body),
            b'K' => drop(feed().map(|f| f.input.send(Input::Keys(String::from_utf8_lossy(&body).into_owned())))),
            b'Z' => drop(feed().map(|f| {
                let (cols, rows) = size(&body);
                f.trail.lock().unwrap().size = (cols, rows);
                f.input.send(Input::Size(cols, rows))
            })),
            b'C' => drop(close(id)),
            b'L' => {
                let all = SESSIONS.lock().unwrap();
                let list: Vec<u8> = all.iter().flat_map(|(id, s)| [&id.to_le_bytes()[..], &(s.meta.len() as u32).to_le_bytes(), s.meta.as_bytes()].concat()).collect();
                drop(all);
                tell(b'R', id, &list);
            }
            b'Q' => {
                end_sessions();
                break;
            }
            _ => {}
        }
    }
    // The window went. Sessions it didn't end wait for the next one, their output kept in their trails.
    *WINDOW.lock().unwrap() = None;
    for s in SESSIONS.lock().unwrap().values() {
        s.feed.attached.store(false, Relaxed);
    }
    *HEARD.lock().unwrap() = Some(Instant::now());
    if quiet.is_zero() {
        end_sessions();
    }
    rest_or_leave();
    Some(())
}

/// Serves windows on `listener`. With no window, the sessions end once they've been quiet for `quiet`: a session
/// at work finishes its turn, and none waits forever for a nook that never comes.
fn serve(listener: TcpListener, token: String, quiet: Duration) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(5));
        let heard = *HEARD.lock().unwrap();
        if WINDOW.lock().unwrap().is_none() && heard.is_none_or(|t| t.elapsed() > quiet) {
            end_sessions();
        }
    });
    for socket in listener.incoming().flatten() {
        let token = token.clone();
        thread::spawn(move || serve_window(socket, &token, quiet));
    }
}

/// A keeper's whole life. It lists itself, whole at once and for the user alone, for the window that started it
/// and the ones after.
pub fn run() {
    let token = crate::ide::token();
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else { return };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else { return };
    let (listing, part) = (dir().join(std::process::id().to_string()), dir().join(format!("{}.part", std::process::id())));
    let listed = fs::create_dir_all(dir()).and_then(|()| {
        let mut file = fs::OpenOptions::new();
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut file, 0o600);
        file.write(true).create(true).truncate(true).open(&part)?.write_all(format!("{port} {token}").as_bytes())?;
        fs::rename(&part, &listing)
    });
    if listed.is_err() {
        return;
    }
    crate::priority::keep_typing_path_elevated(crate::read_settings().unwrap_or_default().command.first().map_or("", String::as_str));
    // A bench ends its nook by force, and its sessions with it.
    let quiet = if std::env::var_os("NOOK_BENCH").is_some() { Duration::ZERO } else { QUIET };
    serve(listener, token, quiet);
}

// The window's side

/// A call waiting on its R or E, with the stream an attach takes up once its history is in.
type Wait = (Sender<Result<Vec<u8>, String>>, Option<Arc<Stream>>);

/// A window's connection to one keeper.
pub struct Link {
    /// The keeper's pid, which its sessions' ids start with.
    pid: u32,
    next: AtomicU64,
    socket: TcpStream,
    /// Frames for the thread that writes them, so the UI thread never waits on the socket.
    out: Sender<Vec<u8>>,
    waits: Mutex<HashMap<u64, Wait>>,
    /// Each session's stream to its tab.
    streams: Mutex<HashMap<u64, Arc<Stream>>>,
    reader: Mutex<Option<thread::JoinHandle<()>>>,
}

static LINKS: Mutex<Vec<Arc<Link>>> = Mutex::new(Vec::new());
/// Whether the window is going, and its tabs with it: a link that ends then closes no tab.
static LEAVING: AtomicBool = AtomicBool::new(false);

impl Link {
    /// A new session's id.
    pub fn id(&self) -> u64 {
        u64::from(self.pid) << NUMBER | self.next.fetch_add(1, Relaxed)
    }

    pub fn tell(&self, op: u8, id: u64, body: &[u8]) {
        let mut frame = Vec::new();
        let _ = send(&mut frame, op, id, body);
        let _ = self.out.send(frame);
    }

    /// Sends a frame and waits for its answer. An attach's `stream` hears the session from that answer on.
    pub fn call(&self, op: u8, id: u64, body: &[u8], stream: Option<Arc<Stream>>) -> Result<Vec<u8>, String> {
        let (answer, wait) = channel();
        self.waits.lock().unwrap().insert(id, (answer, stream));
        self.tell(op, id, body);
        wait.recv().unwrap_or_else(|_| Err("nook's session keeper stopped".into()))
    }

    /// Session `id`'s output goes to `stream`, or with none, nowhere.
    pub fn stream(&self, id: u64, stream: Option<Arc<Stream>>) {
        let mut streams = self.streams.lock().unwrap();
        match stream {
            Some(s) => streams.insert(id, s),
            None => streams.remove(&id),
        };
    }

    /// Hears the keeper until it goes, and then closes its sessions' tabs.
    fn hear(self: Arc<Self>, mut from: BufReader<TcpStream>) {
        while let Ok((op, id, body)) = frame(&mut from) {
            match op {
                b'O' => drop(self.streams.lock().unwrap().get(&id).map(|s| s.push(&body))),
                b'X' => self.ended(id),
                b'R' | b'E' => {
                    let Some((answer, stream)) = self.waits.lock().unwrap().remove(&id) else { continue };
                    if op == b'R' && stream.is_some() {
                        self.stream(id, stream);
                    }
                    let _ = answer.send(if op == b'R' { Ok(body) } else { Err(String::from_utf8_lossy(&body).into_owned()) });
                }
                _ => {}
            }
        }
        self.waits.lock().unwrap().clear();
        LINKS.lock().unwrap().retain(|l| !Arc::ptr_eq(l, &self));
        if !LEAVING.load(Relaxed) {
            let ids: Vec<u64> = self.streams.lock().unwrap().keys().copied().collect();
            ids.into_iter().for_each(|id| self.ended(id));
        }
    }

    fn ended(&self, id: u64) {
        if let Some(stream) = self.streams.lock().unwrap().remove(&id) {
            stream.end();
        }
        crate::pty::forget(id);
    }
}

/// Greets the keeper on `port`. None if another window holds it; an error if nothing there is a keeper this nook
/// can hold.
fn connect(port: u16, token: &str) -> io::Result<Option<Arc<Link>>> {
    let socket = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(100))?;
    socket.set_nodelay(true)?;
    (&socket).write_all(format!("{token} {VERSION}\n").as_bytes())?;
    let mut from = BufReader::new(socket.try_clone()?);
    let hello = greeting(&mut from)?;
    if hello.trim_end() == "busy" {
        return Ok(None);
    }
    let said: Vec<u64> = hello.split_whitespace().filter_map(|n| n.parse().ok()).collect();
    let [version, pid, next] = said[..] else { return Err(io::Error::other("no keeper answered")) };
    if version != u64::from(VERSION) {
        return Err(io::Error::other("a keeper of another nook"));
    }
    let (out, frames) = channel::<Vec<u8>>();
    let mut to = socket.try_clone()?;
    thread::spawn(move || frames.into_iter().try_for_each(|f| to.write_all(&f)));
    let link = Arc::new(Link { pid: pid as u32, next: next.into(), socket, out, waits: Default::default(), streams: Default::default(), reader: Mutex::new(None) });
    let hears = link.clone();
    *link.reader.lock().unwrap() = Some(thread::spawn(move || hears.hear(from)));
    Ok(Some(link))
}

/// Where keeper `pid` listens, and its token.
fn listing(pid: u32) -> Option<(u16, String)> {
    let listing = fs::read_to_string(dir().join(pid.to_string())).ok()?;
    let (port, token) = listing.split_once(' ')?;
    Some((port.parse().ok()?, token.into()))
}

/// Every keeper no window holds, taken. A listing whose keeper is gone is deleted.
fn adopt() -> Vec<Arc<Link>> {
    let mut found = Vec::new();
    for entry in fs::read_dir(dir()).into_iter().flatten().flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse().ok()) else { continue };
        match listing(pid).filter(|_| crate::ide::running(pid)).map(|(port, token)| connect(port, &token)) {
            Some(Ok(Some(link))) => found.push(link),
            Some(Ok(None)) => {}
            _ => drop(fs::remove_file(entry.path())),
        }
    }
    found
}

/// The program a keeper runs. On Windows it's a copy of nook's, which Windows locks while it runs: an update or a
/// rebuild replaces nook.exe while a keeper still holds sessions. Copies of other builds go once none runs.
fn program() -> io::Result<PathBuf> {
    let own = std::env::current_exe()?;
    if cfg!(not(windows)) {
        return Ok(own);
    }
    let meta = fs::metadata(&own)?;
    let build = format!("{}-{}", meta.len(), meta.modified()?.duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()));
    for entry in fs::read_dir(dir()).into_iter().flatten().flatten() {
        if entry.path().is_dir() && entry.file_name() != build[..] {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    let copy = dir().join(build).join(own.file_name().unwrap_or_default());
    if !copy.exists() {
        fs::create_dir_all(copy.parent().unwrap())?;
        let part = copy.with_extension(std::process::id().to_string());
        fs::copy(&own, &part)?;
        if fs::rename(&part, &copy).is_err() {
            let _ = fs::remove_file(&part); // another window's copy got there first
        }
    }
    Ok(copy)
}

/// Starts `exe` as a keeper and gives its pid. It gets none of the window's handles, which it would hold for as
/// long as it outlives the window, and no console.
#[cfg(windows)]
fn detached(exe: &std::path::Path) -> io::Result<u32> {
    use crate::sys::*;
    let mut line = OsString::from("\"");
    line.push(exe);
    line.push(format!("\" {FLAG}"));
    let cb = (size_of::<STARTUPINFOEXW>() - size_of::<usize>()) as u32; // a STARTUPINFOW: no attribute list
    let (startup, mut started) = (STARTUPINFOEXW { cb, ..Default::default() }, PROCESS_INFORMATION::default());
    let (app, mut line, dir) = (wide(exe), wide(line), wide(dir()));
    // SAFETY: every pointer is to a NUL-ended string or a struct that outlives the call.
    unsafe {
        if CreateProcessW(app.as_ptr(), line.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 0, DETACHED_PROCESS, std::ptr::null(), dir.as_ptr(), &startup, &mut started) == 0 {
            return Err(io::Error::last_os_error());
        }
        CloseHandle(started.hThread);
        CloseHandle(started.hProcess);
    }
    Ok(started.dwProcessId)
}

/// Starts `exe` as a keeper and gives its pid. It gets none of the window's descriptors, and a session of its own,
/// so a terminal nook was started from can't hang it up.
#[cfg(unix)]
fn detached(exe: &std::path::Path) -> io::Result<u32> {
    use std::{ffi::{c_int, c_long, c_ulong}, os::unix::process::CommandExt, process::{Command, Stdio}};
    extern "C" {
        fn setsid() -> c_int;
        fn syscall(number: c_long, ...) -> c_long;
    }
    let mut keeper = Command::new(exe);
    keeper.arg(FLAG).current_dir(dir()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: only async-signal-safe calls, between fork and exec: setsid, and close_range with CLOSE_RANGE_CLOEXEC.
    unsafe {
        keeper.pre_exec(|| {
            setsid();
            syscall(436, 3 as c_ulong, c_ulong::from(u32::MAX), 4 as c_ulong);
            Ok(())
        });
    }
    let mut child = keeper.spawn()?;
    let pid = child.id();
    thread::spawn(move || child.wait());
    Ok(pid)
}

/// Starts a keeper and takes it, once it has listed itself.
fn launch() -> io::Result<Arc<Link>> {
    fs::create_dir_all(dir())?;
    let pid = detached(&program()?)?;
    for _ in 0..1000 {
        thread::sleep(Duration::from_millis(5));
        if let Some((port, token)) = listing(pid) {
            return connect(port, &token)?.ok_or_else(|| io::Error::other("the new keeper is taken"));
        }
        if !crate::ide::running(pid) {
            break;
        }
    }
    Err(io::Error::other("the keeper didn't start"))
}

/// A keeper on a thread of this process, for when none can start: its sessions end with the window, as they would
/// without keepers.
fn inside() -> io::Result<Arc<Link>> {
    INSIDE.store(true, Relaxed);
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let (port, token) = (listener.local_addr()?.port(), crate::ide::token());
    let theirs = token.clone();
    thread::spawn(move || serve(listener, theirs, QUIET));
    connect(port, &token)?.ok_or_else(|| io::Error::other("the keeper is taken"))
}

/// The window's keepers, the ones it found waiting first.
fn links() -> Vec<Arc<Link>> {
    static FOUND: Once = Once::new();
    FOUND.call_once(|| {
        let found = adopt();
        LINKS.lock().unwrap().extend(found);
    });
    LINKS.lock().unwrap().clone()
}

/// The keeper new sessions start in: the first the window holds, or a new one.
pub fn home() -> Result<Arc<Link>, String> {
    if let Some(link) = links().first() {
        return Ok(link.clone());
    }
    let mut all = LINKS.lock().unwrap();
    if all.is_empty() {
        all.push(launch().or_else(|_| inside()).map_err(err)?);
    }
    Ok(all[0].clone())
}

/// The keeper that holds session `id`.
pub fn of(id: u64) -> Option<Arc<Link>> {
    links().into_iter().find(|l| u64::from(l.pid) == id >> NUMBER)
}

/// Every session the window's keepers hold, each with the notes its window left.
pub fn sessions() -> Vec<(u64, String)> {
    let mut all = Vec::new();
    for link in links() {
        let list = link.call(b'L', 0, &[], None).unwrap_or_default();
        let mut rest = &list[..];
        while let Some((head, tail)) = rest.split_at_checked(12) {
            let len = u32::from_le_bytes(head[8..].try_into().unwrap()) as usize;
            let Some((meta, tail)) = tail.split_at_checked(len) else { break };
            all.push((u64::from_le_bytes(head[..8].try_into().unwrap()), String::from_utf8_lossy(meta).into_owned()));
            rest = tail;
        }
    }
    all
}

/// The page loaded again: no tab is left to hear a session until its new tab attaches.
pub fn unstream() {
    for link in LINKS.lock().unwrap().iter() {
        link.streams.lock().unwrap().clear();
    }
}

/// The window closed: its sessions end, and this waits until they have.
pub fn end() {
    LEAVING.store(true, Relaxed);
    let all = std::mem::take(&mut *LINKS.lock().unwrap());
    for link in &all {
        link.tell(b'Q', 0, &[]);
    }
    for link in all {
        let reader = link.reader.lock().unwrap().take();
        let _ = reader.map(thread::JoinHandle::join);
    }
}

/// The window is going without ending its sessions: they stay with their keepers for the next window.
pub fn leave() {
    LEAVING.store(true, Relaxed);
    for link in std::mem::take(&mut *LINKS.lock().unwrap()) {
        let _ = link.socket.shutdown(Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::Trail;

    #[test]
    fn a_trail_keeps_the_normal_screen_and_the_modes_left_set() {
        let mut t = Trail::new((80, 24));
        t.nudge = Some((80, 24));
        // Sequences split between writes; the alternate screen's output and the switch to it stay out.
        for piece in ["one\r\n\x1b[?2004h\x1b[?10", "49h\x1b[?1000;1006hdrawn", "\x1b[?25l\x1b[2 q\x1b[", "2Jagain"] {
            let due = t.feed(piece.as_bytes());
            assert_eq!(due.is_some(), piece.ends_with("again"));
        }
        let (history, modes) = t.replay();
        assert_eq!(history, b"one\r\n\x1b[?2004h");
        assert_eq!(modes, "\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?25l\x1b[2 q");
        t.feed(b"\x1b[?1049l\x1b[?1000ltwo");
        let (history, modes) = t.replay();
        assert_eq!(history, b"one\r\n\x1b[?2004h\x1b[?1000ltwo");
        assert_eq!(modes, "\x1b[?2004h\x1b[?1000l\x1b[?1006h\x1b[?25l\x1b[2 q");
    }
}
