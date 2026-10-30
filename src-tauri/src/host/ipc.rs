//! Calls from the page and what goes back to it. The page posts `[id, cmd, args]`, handled in the order posted,
//! and hears `[id, 1, value]` or `[id, 0, error]`, matched by id. An event is `[name, payload]`; events arrive
//! in the order they're sent. A stream's pieces go as each platform carries text best (`send_stream`), numbered,
//! since short and long ones may travel apart.
//! A command whose input or output is bytes is a same-origin `fetch('/__ipc/<cmd>')` instead (assets.rs).
use super::plat;
use crate::json::{self, W};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Where a command runs: inline on the UI thread, in order with the page's other calls, or on a worker, for
/// anything that touches the disk or waits on a process.
pub enum Run {
    Inline,
    Thread,
}

pub struct Args<'a> {
    /// The arguments object, as JSON.
    pub json: &'a str,
    /// A fetch's body.
    pub body: &'a [u8],
}

pub enum Out {
    Json(String),
    Bytes(Vec<u8>),
}

pub type Command = fn(&Args) -> Result<Out, String>;
pub type Commands = fn(&str) -> Option<(Run, Command)>;

/// What a command returns, as the page hears it: a value as JSON, an error as its text, `Bytes` as bytes.
pub trait Reply {
    fn reply(self) -> Result<Out, String>;
}

impl<T: W> Reply for T {
    fn reply(self) -> Result<Out, String> {
        Ok(Out::Json(json::to_string(&self)))
    }
}

impl<T: Reply> Reply for Result<T, String> {
    fn reply(self) -> Result<Out, String> {
        self.and_then(Reply::reply)
    }
}

/// A command's answer in bytes, which reaches the page as an ArrayBuffer.
pub struct Bytes(pub Vec<u8>);

impl Reply for Bytes {
    fn reply(self) -> Result<Out, String> {
        Ok(Out::Bytes(self.0))
    }
}

/// A `Command` that calls `f` with the arguments named, read from the arguments object by name or by the key
/// given (`on_data: "onData"`), each as the type `f` takes, and replies with what it returns. A missing key is an
/// error unless its type is an `Option`. `cmd!(f, @body)` hands `f` a fetch's body instead.
macro_rules! cmd {
    ($f:path, @body) => {
        |a: &$crate::host::Args| $crate::host::Reply::reply($f(a.body))
    };
    ($f:path) => {
        |_: &$crate::host::Args| $crate::host::Reply::reply($f())
    };
    ($f:path $(, $arg:ident $(: $key:literal)?)+) => {
        |_a: &$crate::host::Args| -> Result<$crate::host::Out, String> {
            $(let mut $arg = None;)*
            let mut _p = $crate::json::Reader::new(_a.json);
            _p.map("arguments", |_p, _key| {
                $(if _key == $crate::host::cmd!(@key $arg $($key)?) {
                    $arg = Some($crate::json::Take::take(_p)?);
                    return Ok(());
                })*
                _p.skip()
            })
            .and_then(|()| _p.end())
            .map_err(|e| e.to_string())?;
            $crate::host::Reply::reply($f($($crate::host::ipc::given($arg, $crate::host::cmd!(@key $arg $($key)?))?),*))
        }
    };
    (@key $arg:ident) => { stringify!($arg) };
    (@key $arg:ident $key:literal) => { $key };
}
pub(crate) use cmd;

/// An argument's value, or for a missing key its type's own, if it has one.
pub fn given<T: json::Take>(v: Option<T>, key: &str) -> Result<T, String> {
    v.or_else(T::absent).ok_or_else(|| format!("missing {key}"))
}

static COMMANDS: OnceLock<Commands> = OnceLock::new();

static UI_THREAD: OnceLock<std::thread::ThreadId> = OnceLock::new();

/// Sets the app's command table, and marks this thread as the UI thread.
pub fn init(commands: Commands) {
    let _ = COMMANDS.set(commands);
    let _ = UI_THREAD.set(std::thread::current().id());
}

fn lookup(cmd: &str) -> Option<(Run, Command)> {
    COMMANDS.get().and_then(|c| c(cmd)).or_else(|| builtin(cmd))
}

/// A message the page posted.
pub fn message(json: &str) {
    let Some((id, cmd, args)) = envelope(json) else { return };
    match lookup(cmd) {
        None => reply(id, Err(format!("no command {cmd}"))),
        Some((Run::Inline, f)) => reply(id, f(&Args { json: args, body: &[] })),
        Some((Run::Thread, f)) => {
            let args = args.to_owned();
            work(move || {
                let text = reply_text(id, f(&Args { json: &args, body: &[] }));
                plat::post(move || plat::send_reply(&text));
            });
        }
    }
}

/// The threads that run commands and requests off the UI thread, and the jobs waiting for one.
struct Workers {
    jobs: std::collections::VecDeque<Box<dyn FnOnce() + Send>>,
    /// How many wait for a job.
    waiting: usize,
}

static WORKERS: Mutex<Workers> = Mutex::new(Workers { jobs: std::collections::VecDeque::new(), waiting: 0 });
static WAKE: std::sync::Condvar = std::sync::Condvar::new();

/// Runs `job` on a worker: one that waits, or else a new one, so a job never waits behind one that blocks. A
/// thread is kept, since starting one costs more than most commands (every DLL in the process hears of it), and
/// leaves after a minute without work.
pub fn work(job: impl FnOnce() + Send + 'static) {
    let mut w = WORKERS.lock().unwrap();
    w.jobs.push_back(Box::new(job));
    if w.jobs.len() > w.waiting {
        drop(w);
        std::thread::spawn(worker);
    } else {
        WAKE.notify_one();
    }
}

fn worker() {
    let mut w = WORKERS.lock().unwrap();
    loop {
        if let Some(job) = w.jobs.pop_front() {
            drop(w);
            job();
            w = WORKERS.lock().unwrap();
            continue;
        }
        w.waiting += 1;
        let (next, wait) = WAKE.wait_timeout(w, std::time::Duration::from_secs(60)).unwrap();
        w = next;
        w.waiting -= 1;
        if wait.timed_out() && w.jobs.is_empty() {
            return;
        }
    }
}

/// Runs `cmd` for a command fetch, on the fetch's worker.
pub fn fetch(cmd: &str, json: &str, body: &[u8]) -> Result<Out, String> {
    let (_, f) = lookup(cmd).ok_or_else(|| format!("no command {cmd}"))?;
    f(&Args { json, body })
}

/// `[id, "cmd", args]` → its parts, `args` as raw JSON. The page's script writes it, so it's well formed.
fn envelope(json: &str) -> Option<(u64, &str, &str)> {
    let s = json.trim().strip_prefix('[')?.strip_suffix(']')?;
    let (id, rest) = s.split_once(',')?;
    let rest = rest.trim_start().strip_prefix('"')?;
    let (cmd, rest) = rest.split_once('"')?;
    let args = rest.trim_start().strip_prefix(',').map_or("null", str::trim);
    Some((id.trim().parse().ok()?, cmd, args))
}

fn reply(id: u64, r: Result<Out, String>) {
    plat::send_reply(&reply_text(id, r));
}

/// A reply as the page hears it. A worker writes its own, so a long one is copied off the UI thread.
fn reply_text(id: u64, r: Result<Out, String>) -> String {
    match r {
        Ok(Out::Json(v)) => [&format!("[{id},1,"), &*v, "]"].concat(), // one copy, sized up front
        Ok(Out::Bytes(_)) => format!("[{id},0,\"bytes come back through fetch\"]"),
        Err(e) => format!("[{id},0,{}]", json::to_string(&e)),
    }
}

/// Sends event `name` with JSON `payload` to the page, from any thread.
pub fn emit(name: &str, payload: &str) {
    let text = format!("[{},{payload}]", json::to_string(name));
    if UI_THREAD.get() == Some(&std::thread::current().id()) {
        plat::send(&text);
    } else {
        plat::post(move || plat::send(&text));
    }
}

/// A stream of UTF-8 to the page's `Channel` with the same id, such as a terminal's output. Bytes pushed from
/// any thread wake the UI thread once until it posts them, so a burst of reads goes out together, in order,
/// its end included. Dropped without `end`, it ends then.
pub struct Stream {
    id: u64,
    /// The next piece's number.
    seq: AtomicU64,
    pending: Mutex<Pending>,
}

struct Pending {
    bytes: Vec<u8>,
    woken: bool,
    ended: bool,
}

impl Stream {
    pub fn new(id: u64) -> Arc<Stream> {
        let pending = Mutex::new(Pending { bytes: Vec::new(), woken: false, ended: false });
        Arc::new(Stream { id, seq: AtomicU64::new(0), pending })
    }

    pub fn push(self: &Arc<Self>, bytes: &[u8]) {
        let mut p = self.pending.lock().unwrap();
        if p.ended {
            return;
        }
        p.bytes.extend_from_slice(bytes);
        let wake = !std::mem::replace(&mut p.woken, true);
        drop(p);
        if wake {
            self.wake();
        }
    }

    /// Ends the stream after what was pushed: the page hears empty text.
    pub fn end(self: &Arc<Self>) {
        let mut p = self.pending.lock().unwrap();
        if std::mem::replace(&mut p.ended, true) {
            return;
        }
        let wake = !std::mem::replace(&mut p.woken, true);
        drop(p);
        if wake {
            self.wake();
        }
    }

    fn wake(self: &Arc<Self>) {
        let s = self.clone();
        plat::post(move || s.flush());
    }

    /// Posts what's pending as whole characters, in pieces so the page takes in one while the next is copied,
    /// then the end once it has ended. A character split across pushes waits for its rest.
    fn flush(&self) {
        const PIECE: usize = 1 << 20;
        let (bytes, ended) = {
            let mut p = self.pending.lock().unwrap();
            p.woken = false;
            let whole = if p.ended { p.bytes.len() } else { whole_chars(&p.bytes) };
            let rest = p.bytes.split_off(whole);
            (std::mem::replace(&mut p.bytes, rest), p.ended)
        };
        let mut rest = &bytes[..];
        while !rest.is_empty() {
            let n = rest.len().min(PIECE);
            let n = if n < rest.len() { whole_chars(&rest[..n]) } else { n };
            let (piece, tail) = rest.split_at(n);
            rest = tail;
            plat::send_stream(self.id, self.seq.fetch_add(1, Ordering::Relaxed), piece, ended && rest.is_empty());
        }
        if ended && bytes.is_empty() {
            plat::send_stream(self.id, self.seq.fetch_add(1, Ordering::Relaxed), &[], true);
        }
    }
}

impl Drop for Stream {
    /// No flush is queued once the last reference goes, since each holds one; what's left goes with the end.
    fn drop(&mut self) {
        let p = self.pending.get_mut().unwrap();
        if !p.ended {
            let (id, seq, bytes) = (self.id, *self.seq.get_mut(), std::mem::take(&mut p.bytes));
            plat::post(move || plat::send_stream(id, seq, &bytes, true));
        }
    }
}

/// The length of `b` without a UTF-8 sequence cut off at its end.
fn whole_chars(b: &[u8]) -> usize {
    for back in 1..=b.len().min(3) {
        let c = b[b.len() - back];
        if c & 0xc0 != 0x80 {
            let need = if c >= 0xf0 {
                4
            } else if c >= 0xe0 {
                3
            } else if c >= 0xc0 {
                2
            } else {
                1
            };
            return if need > back { b.len() - back } else { b.len() };
        }
    }
    b.len()
}

fn set_title(title: String) {
    plat::set_title(&title);
}

/// The window's own commands. A press on a drag region (host.js) sends `win_drag`.
fn builtin(cmd: &str) -> Option<(Run, Command)> {
    let f: Command = match cmd {
        "win_minimize" => cmd!(plat::minimize),
        "win_toggle_maximize" => cmd!(plat::toggle_maximize),
        "win_maximized" => cmd!(plat::maximized),
        "win_destroy" => cmd!(plat::destroy),
        "win_title" => cmd!(set_title, title),
        "win_attention" => cmd!(plat::attention),
        "win_background" => cmd!(plat::set_background, rgb),
        "win_drag" => cmd!(plat::drag),
        _ => return None,
    };
    Some((Run::Inline, f))
}
