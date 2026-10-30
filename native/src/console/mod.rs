//! nook's console server. Each tab's processes attach to a console that nook serves in-process on a thread of its
//! own, speaking the console driver's protocol (condrv) as OpenConsole does (LICENSES.txt): programs' output goes straight to the
//! tab's stream, and the terminal's keys and sizes come in through `write` and `resize`.
mod api;
mod cooked;
mod input;
mod screen;
mod wcwidth;
mod window;

use crate::sys::*;
use api::State;
use std::{
    ffi::c_void,
    io,
    mem::size_of,
    panic::{catch_unwind, AssertUnwindSafe},
    ptr::{null, null_mut},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

/// Where the console's output goes: the terminal.
pub type Sink = Box<dyn FnMut(&[u8]) + Send>;

const READ_IO: u32 = 0x0050_0006;
const COMPLETE_IO: u32 = 0x0050_000B;
const READ_INPUT: u32 = 0x0050_000F;
const WRITE_OUTPUT: u32 = 0x0050_0013;
const SET_SERVER_INFORMATION: u32 = 0x0050_001F;
const ERROR_IO_PENDING: i32 = 997;
const ERROR_OPERATION_ABORTED: i32 = 995;

/// A message's descriptor, as READ_IO hands it over.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Desc {
    id: [u32; 2],
    process: usize,
    object: usize,
    function: u32,
    input: u32,
    output: u32,
    reserved: u32,
}

#[repr(C)]
struct Buf {
    data: *const c_void,
    size: u32,
    offset: u32,
}

#[repr(C)]
struct Complete {
    id: [u32; 2],
    status: isize,
    information: usize,
    write: Buf,
}

#[repr(C)]
struct Operation {
    id: [u32; 2],
    buffer: Buf,
}

/// What READ_IO hands over past the descriptor: a message's header and body, or a new object's kind.
const UNION: usize = 256;
#[repr(C, align(8))]
struct Msg {
    d: Desc,
    u: [u8; UNION],
}

/// The struct CreateProcess reads through PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE; only `reference` is read.
#[repr(C)]
struct PseudoConsole {
    signal: HANDLE,
    reference: HANDLE,
    process: HANDLE,
}

/// An answer to one message: its status and information, and the body that goes back to the client's offset 0.
/// Output data goes before it, at `out_at`.
#[derive(Clone, Copy)]
struct Reply {
    id: [u32; 2],
    status: i32,
    info: usize,
    body: [u8; UNION],
    body_len: u32,
    out_at: u32,
}

impl Reply {
    fn new(d: &Desc) -> Reply {
        Reply { id: d.id, status: 0, info: 0, body: [0; UNION], body_len: 0, out_at: 0 }
    }

    fn fail(d: &Desc, status: i32) -> Reply {
        Reply { status, ..Reply::new(d) }
    }

    /// The completion the driver takes; it points into this reply's body.
    fn completion(&self) -> Complete {
        let write = Buf { data: self.body.as_ptr().cast(), size: self.body_len, offset: 0 };
        Complete { id: self.id, status: self.status as isize, information: self.info, write }
    }
}

/// The server's handle and the driver's calls on it.
#[derive(Clone, Copy)]
struct Dev(HANDLE);

impl Dev {
    fn ioctl<T>(self, code: u32, input: &T) -> bool {
        let mut n = 0;
        unsafe { DeviceIoControl(self.0, code, (input as *const T).cast(), size_of::<T>() as u32, null_mut(), 0, &mut n, null_mut()) != 0 }
    }

    /// `len` bytes of message `id`'s input from `offset` on, into `buf`.
    fn read_input(self, id: [u32; 2], offset: u32, len: usize, buf: &mut Vec<u8>) -> bool {
        buf.clear();
        buf.resize(len, 0);
        len == 0 || self.ioctl(READ_INPUT, &Operation { id, buffer: Buf { data: buf.as_ptr().cast(), size: len as u32, offset } })
    }

    /// `data` into message `id`'s output buffer at `offset`.
    fn write_output(self, id: [u32; 2], offset: u32, data: &[u8]) -> bool {
        data.is_empty() || self.ioctl(WRITE_OUTPUT, &Operation { id, buffer: Buf { data: data.as_ptr().cast(), size: data.len() as u32, offset } })
    }

    /// Answers a message outside the IO loop: one that waited for input.
    fn complete(self, r: &Reply) {
        self.ioctl(COMPLETE_IO, &r.completion());
    }
}

struct Shared {
    dev: Dev,
    st: Mutex<State>,
}

// SAFETY: the handles in it are used from any thread; the state is behind its lock.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

impl Drop for Shared {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.dev.0) };
    }
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Runs `f` on the state, then sends what it drew to the terminal and the control events it raised to their
    /// processes. A panic, a bug, ends every attached process, so the tab closes instead of hanging.
    fn with<R>(self: &Arc<Self>, f: impl FnOnce(&mut State) -> R) -> Option<R> {
        let r = catch_unwind(AssertUnwindSafe(|| {
            let mut st = self.lock();
            let r = f(&mut st);
            st.settle();
            let start = st.ctrl_start();
            drop(st);
            if start {
                let sh = self.clone();
                if thread::Builder::new().name("console-ctrl".into()).spawn(move || send_ctrl(&sh)).is_err() {
                    self.lock().ctrl_drop();
                }
            }
            r
        }));
        r.map_err(|_| self.lock().end()).ok()
    }
}

/// Sends the control events the console raised, in order, on a thread of its own while there are any:
/// ConsoleControl waits while a process holds one off.
fn send_ctrl(sh: &Shared) {
    while let Some((process, event)) = sh.lock().ctrl_next() {
        ctrl(process, event);
        unsafe { CloseHandle(process) };
    }
}

/// Sends a control event as OpenConsole does, through user32's ConsoleControl(ConsoleEndTask): Windows runs the
/// process's handlers, and ends a process that holds off a close for 5 s. Should that fail while the process lives,
/// kernelbase's CtrlRoutine runs in it on a thread of ours, as Windows would run it, unless the process is 32-bit.
fn ctrl(process: HANDLE, event: u32) {
    #[repr(C)]
    struct EndTask {
        pid: usize,
        hwnd: usize,
        event: u32,
        flags: u32,
    }
    let pid = unsafe { GetProcessId(process) };
    let mut t = EndTask { pid: pid as usize, hwnd: 0, event, flags: [1, 2, 4][event.min(2) as usize] };
    if unsafe { ConsoleControl(7, (&mut t as *mut EndTask).cast(), size_of::<EndTask>() as u32) } >= 0 || unsafe { WaitForSingleObject(process, 0) } == WAIT_OBJECT_0 {
        return;
    }
    let (mut machine, mut native) = (0u16, 0u16);
    if unsafe { IsWow64Process2(process, &mut machine, &mut native) } == 0 || machine != 0 {
        return;
    }
    let routine = unsafe { GetProcAddress(GetModuleHandleW(wide("kernelbase.dll").as_ptr()), c"CtrlRoutine".as_ptr().cast()) };
    if !routine.is_null() {
        let t = unsafe { CreateRemoteThread(process, null(), 0, routine, event as usize as *const c_void, 0, null_mut()) };
        if !t.is_null() {
            unsafe { CloseHandle(t) };
        }
    }
}

fn nt_open(name: &str, root: HANDLE, access: u32, options: u32) -> io::Result<HANDLE> {
    let w: Vec<u16> = name.encode_utf16().collect();
    let name = UNICODE_STRING { Length: (w.len() * 2) as u16, MaximumLength: (w.len() * 2) as u16, Buffer: w.as_ptr() };
    let oa = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: root,
        ObjectName: &name,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let (mut h, mut iosb) = (null_mut(), IO_STATUS_BLOCK::default());
    let status = unsafe { NtOpenFile(&mut h, access, &oa, &mut iosb, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, options) };
    match status {
        0.. => Ok(h),
        _ => Err(io::Error::other(format!("can't open the console driver's {name}: NTSTATUS {status:#x}", name = String::from_utf16_lossy(&w)))),
    }
}

/// The IO loop: each READ_IO hands the driver the last reply and takes the next message, until every client is
/// gone and the reference closed, or `close` cancels it.
fn serve(sh: Arc<Shared>) {
    let mut msg = Box::new(Msg { d: Desc::default(), u: [0; UNION] });
    let mut reply: Option<Reply> = None;
    while !sh.lock().closing {
        let c = reply.as_ref().map(Reply::completion);
        let (inb, inl) = c.as_ref().map_or((null(), 0), |c| ((c as *const Complete).cast(), size_of::<Complete>() as u32));
        let mut n = 0;
        let out = (&mut *msg as *mut Msg).cast();
        let mut ok = unsafe { DeviceIoControl(sh.dev.0, READ_IO, inb, inl, out, size_of::<Msg>() as u32, &mut n, null_mut()) } != 0;
        if !ok {
            match io::Error::last_os_error().raw_os_error() {
                Some(ERROR_IO_PENDING) => ok = unsafe { WaitForSingleObject(sh.dev.0, INFINITE) } == WAIT_OBJECT_0,
                // The driver refused the last reply (its client went away): the next read goes without it.
                Some(e) if reply.is_some() && e != ERROR_PIPE_NOT_CONNECTED as i32 && e != ERROR_OPERATION_ABORTED => {
                    reply = None;
                    continue;
                }
                _ => break,
            }
        }
        reply = if ok { sh.with(|st| st.dispatch(&msg)).flatten() } else { None };
    }
}

/// A console, served by nook.
pub struct Console {
    shared: Arc<Shared>,
    hpc: Box<PseudoConsole>,
    io: Mutex<Option<thread::JoinHandle<()>>>,
}

// SAFETY: the reference handle is touched only through `&mut`; the rest is Send and Sync.
unsafe impl Send for Console {}
unsafe impl Sync for Console {}

impl Console {
    /// A console of `cols` by `rows`, ready for its first process.
    pub fn open(cols: u16, rows: u16) -> io::Result<Console> {
        let server = nt_open(r"\Device\ConDrv\Server", null_mut(), GENERIC_ALL, 0)?;
        let dev = Dev(server);
        let reference = match nt_open(r"\Reference", server, GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE, FILE_SYNCHRONOUS_IO_NONALERT) {
            Ok(r) => r,
            Err(e) => {
                unsafe { CloseHandle(server) };
                return Err(e);
            }
        };
        let hpc = Box::new(PseudoConsole { signal: null_mut(), reference, process: null_mut() });
        // Set while input waits, so a client waiting on its input handle wakes.
        let event = unsafe { CreateEventW(null(), 1, 0, null()) };
        let shared = Arc::new(Shared { dev, st: Mutex::new(State::new(dev, event, cols, rows)) });
        let mut console = Console { shared, hpc, io: Mutex::new(None) };
        if event.is_null() || !dev.ioctl(SET_SERVER_INFORMATION, &event) {
            return Err(io::Error::other(format!("can't start a console: {}", io::Error::last_os_error())));
        }
        let sh = console.shared.clone();
        let io = thread::Builder::new().name("console".into()).spawn(move || serve(sh))?;
        console.io = Mutex::new(Some(io));
        Ok(console)
    }

    /// The value CreateProcess takes for PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE.
    pub fn attribute(&self) -> *const c_void {
        (&*self.hpc as *const PseudoConsole).cast()
    }

    /// Sends what programs write to `sink`, from the first byte they wrote.
    pub fn output(&self, sink: Sink) {
        let mut st = self.shared.lock();
        st.sink = Some(sink);
        st.flush();
    }

    /// The first process started with its own reference, so nook's goes: the console ends with its last process.
    pub fn started(&mut self) {
        unsafe { CloseHandle(std::mem::replace(&mut self.hpc.reference, null_mut())) };
    }

    /// What the terminal sends: keys as VT, and its answers.
    pub fn write(&self, keys: &str) {
        self.shared.with(|st| st.keys(keys));
    }

    /// The terminal's new size.
    pub fn resize(&self, cols: u16, rows: u16) {
        self.shared.with(|st| st.resize(cols, rows));
    }

    /// When `tick` is due: while the console waits for the terminal to say where its cursor is after a resize.
    pub fn due(&self) -> Option<Instant> {
        self.shared.lock().due()
    }

    pub fn tick(&self) {
        self.shared.with(|st| st.tick());
    }

    /// Ends the console: each attached process gets CTRL_CLOSE_EVENT, newest first, and any still running 3 s
    /// later is ended. Blocks meanwhile.
    pub fn close(&self) {
        let Some(io) = self.io.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
        let procs = self.shared.with(|st| st.close()).unwrap_or_default();
        let until = Instant::now() + Duration::from_secs(3);
        for &h in &procs {
            let left = until.saturating_duration_since(Instant::now()).as_millis() as u32;
            if unsafe { WaitForSingleObject(h, left) } != WAIT_OBJECT_0 {
                unsafe { TerminateProcess(h, 0xC000_013A) };
            }
            unsafe { CloseHandle(h) };
        }
        self.shared.lock().closing = true;
        for _ in 0..200 {
            unsafe { CancelIoEx(self.shared.dev.0, null_mut()) };
            if io.is_finished() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        if io.is_finished() {
            let _ = io.join();
        }
        let mut st = self.shared.lock();
        st.flush();
        window::destroy(std::mem::replace(&mut st.window, null_mut()));
    }
}

impl Drop for Console {
    fn drop(&mut self) {
        if !self.hpc.reference.is_null() {
            self.started();
        }
        self.close();
    }
}

/// Appends `s`, ASCII, as UTF-16.
fn lit(out: &mut Vec<u16>, s: &str) {
    out.extend(s.bytes().map(u16::from));
}

/// Appends `n` in decimal.
fn num(out: &mut Vec<u16>, n: i32) {
    if n < 0 {
        out.push(b'-' as u16);
    }
    let n = n.unsigned_abs();
    let digits = n.checked_ilog10().unwrap_or(0) + 1;
    for k in (0..digits).rev() {
        out.push(b'0' as u16 + (n / 10u32.pow(k) % 10) as u16);
    }
}

/// Appends the CUP that puts the cursor at `(row, col)`.
fn cup(out: &mut Vec<u16>, (row, col): (i32, i32)) {
    lit(out, "\x1b[");
    num(out, row + 1);
    out.push(b';' as u16);
    num(out, col + 1);
    out.push(b'H' as u16);
}

/// Appends the moves from `from` to `to` (row, column): rows relative, so lines the terminal reflowed above
/// both, or reflows while this is on its way, don't move the target; the column absolute, which also ends a
/// pending wrap.
fn go(out: &mut Vec<u16>, from: (i32, i32), to: (i32, i32)) {
    let dy = to.0 - from.0;
    if dy != 0 {
        lit(out, "\x1b[");
        num(out, dy.abs());
        out.push(if dy < 0 { b'A' } else { b'B' } as u16);
    }
    if dy != 0 || from.1 != to.1 {
        lit(out, "\x1b[");
        num(out, to.1 + 1);
        out.push(b'G' as u16);
    }
}

/// Appends legacy attributes `a` as OpenConsole writes them: SGR 0, reverse, then the colors, white on black being
/// the terminal's own.
fn sgr(out: &mut Vec<u16>, a: u16) {
    const SGR: [i32; 16] = [30, 34, 32, 36, 31, 35, 33, 37, 90, 94, 92, 96, 91, 95, 93, 97];
    lit(out, "\x1b[0");
    if a & 0x4000 != 0 {
        lit(out, ";7");
    }
    if a & 0x0f != 7 {
        out.push(b';' as u16);
        num(out, SGR[(a & 0x0f) as usize]);
    }
    if a & 0xf0 != 0 {
        out.push(b';' as u16);
        num(out, SGR[(a >> 4 & 0x0f) as usize] + 10);
    }
    out.push(b'm' as u16);
}
