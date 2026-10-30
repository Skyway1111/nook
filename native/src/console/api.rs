//! The console's state and the messages it answers: processes connecting, the objects they open, and the console
//! API, with the reads that wait for input and the output that goes to the terminal.
#[path = "cells.rs"]
mod cells;

use super::cooked::{Cooked, Done, History};
use super::input::{keys, Key, Rec, KEY_EVENT, LALT, LCTRL, SIZE_EVENT};
use super::screen::Screen;
use super::{cup, lit, sgr, window, Desc, Dev, Msg, Reply, Sink, UNION};
use crate::sys::*;
use std::{
    collections::VecDeque,
    mem::{size_of, take},
    ptr::{null, null_mut},
    time::{Duration, Instant},
};

const IO_CONNECT: u32 = 1;
const IO_DISCONNECT: u32 = 2;
const IO_CREATE_OBJECT: u32 = 3;
const IO_CLOSE_OBJECT: u32 = 4;
const IO_RAW_WRITE: u32 = 5;
const IO_RAW_READ: u32 = 6;
const IO_USER_DEFINED: u32 = 7;
const IO_RAW_FLUSH: u32 = 8;

const SUCCESS: i32 = 0;
const ALERTED: i32 = 0x101;
const UNSUCCESSFUL: i32 = 0xC000_0001u32 as i32;
const NOT_IMPLEMENTED: i32 = 0xC000_0002u32 as i32;
const INVALID_HANDLE: i32 = 0xC000_0008u32 as i32;
const INVALID_PARAMETER: i32 = 0xC000_000Du32 as i32;
const ILLEGAL_FUNCTION: i32 = 0xC000_00AFu32 as i32;

const ENABLE_PROCESSED_INPUT: u32 = 0x1;
const ENABLE_LINE_INPUT: u32 = 0x2;
const ENABLE_ECHO_INPUT: u32 = 0x4;
const ENABLE_WINDOW_INPUT: u32 = 0x8;
const ENABLE_MOUSE_INPUT: u32 = 0x10;
const ENABLE_VIRTUAL_TERMINAL_INPUT: u32 = 0x200;
const ENABLE_PROCESSED_OUTPUT: u32 = 0x1;
const ENABLE_WRAP_AT_EOL_OUTPUT: u32 = 0x2;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x4;
const DISABLE_NEWLINE_AUTO_RETURN: u32 = 0x8;

const CTRL_C_EVENT: u32 = 0;
const CTRL_CLOSE_EVENT: u32 = 2;
const UTF8: u32 = 65001;

/// How long a resize waits for the terminal to say where its cursor went.
const RESYNC: Duration = Duration::from_millis(500);
/// The most of a client's write read at once.
const PIECE: u32 = 1 << 16;
/// The largest size the console takes.
const MAX_COLS: u16 = 2048;
const MAX_ROWS: u16 = 1024;

/// The object every input handle names. An output handle names screen buffer `n` as `2n`.
const INPUT: usize = 1;

struct Proc {
    id: usize,
    pid: u32,
    group: u32,
    /// Its program's file name in lower case, which keys its command history.
    exe: String,
    handle: HANDLE,
}

/// The shells whose screen-clearing calls go to the terminal as its own clear, as OpenConsole sends them.
#[derive(Clone, Copy, PartialEq)]
enum Prog {
    Cmd,
    PowerShell,
    Other,
}

#[derive(Clone, Copy, PartialEq)]
enum Obj {
    Input,
    Output(usize),
}

#[derive(Clone, Copy)]
struct ScreenBuf {
    id: usize,
    /// Output handles open on it.
    refs: usize,
    mode: u32,
    attr: u16,
    cursor_size: u32,
    cursor_visible: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum WaitKind {
    /// ReadConsole or a raw read; `raw_io` is ReadFile's, with no body to send back.
    Read { unicode: bool, raw_io: bool, ctrlz: bool, wakeup: u32 },
    /// ReadConsoleInput, waiting for a record.
    Input { unicode: bool },
    /// GetConsoleScreenBufferInfo of buffer `id` while the terminal's cursor is being asked for.
    Info { id: usize },
}

/// A message answered later, once input comes.
struct Wait {
    reply: Reply,
    kind: WaitKind,
    process: usize,
    out_cap: u32,
}

pub(super) struct State {
    dev: Dev,
    event: HANDLE,
    pub sink: Option<Sink>,
    pub closing: bool,
    pub window: HWND,
    screen: Screen,
    cols: i16,
    rows: i16,
    in_mode: u32,
    bufs: Vec<ScreenBuf>,
    active: usize,
    cp_in: u32,
    cp_out: u32,
    input: VecDeque<Rec>,
    waits: VecDeque<Wait>,
    procs: Vec<Proc>,
    next_id: usize,
    title: Vec<u16>,
    original_title: Vec<u16>,
    cooked: Option<Cooked>,
    hist: Vec<(String, History)>,
    /// Text a read finished that the client's buffer didn't hold.
    pending: Vec<u16>,
    /// The start of a UTF-8 character the last write cut off.
    carry: Vec<u8>,
    /// Control events for their thread to send: (a handle of the process's own, event).
    ctrl: VecDeque<(HANDLE, u32)>,
    ctrl_busy: bool,
    /// What goes to the terminal once the message is answered.
    out: Vec<u8>,
    /// A Ctrl+C came: reads waiting end, alerted.
    alert: bool,
    /// After a resize of the normal screen: the cursor when ESC[6n went out, until the terminal answers.
    resync: Option<(i32, i32, Instant)>,
    /// ESC[6n sent for resizes and not answered yet; only the last answer counts.
    dsr_out: u32,
    // Kept between messages, so a steady stream of them allocates nothing.
    data: Vec<u8>,
    reply_out: Vec<u8>,
    text: Vec<u16>,
    line: Vec<u16>,
    seq: Vec<u16>,
    recs: Vec<Rec>,
}

impl Drop for State {
    fn drop(&mut self) {
        for p in &self.procs {
            unsafe { CloseHandle(p.handle) };
        }
        for &(h, _) in &self.ctrl {
            unsafe { CloseHandle(h) };
        }
        unsafe { CloseHandle(self.event) };
    }
}

/// A `T` from `b` at `at`, or its default past `b`'s end.
fn rd<T: Copy + Default>(b: &[u8], at: usize) -> T {
    match b.get(at..at + size_of::<T>()) {
        // SAFETY: as many bytes as T has, and T is plain data.
        Some(s) => unsafe { std::ptr::read_unaligned(s.as_ptr().cast()) },
        None => T::default(),
    }
}

fn wr<T: Copy>(b: &mut [u8], at: usize, v: T) {
    if let Some(s) = b.get_mut(at..at + size_of::<T>()) {
        // SAFETY: as many bytes as T has.
        unsafe { std::ptr::write_unaligned(s.as_mut_ptr().cast(), v) }
    }
}

/// Appends `w` as UTF-16LE bytes.
fn bytes_le(w: &[u16], out: &mut Vec<u8>) {
    out.extend(w.iter().flat_map(|c| c.to_le_bytes()));
}

/// UTF-16LE bytes as units.
fn units(b: &[u8]) -> impl Iterator<Item = u16> + '_ {
    b.as_chunks::<2>().0.iter().map(|&c| u16::from_le_bytes(c))
}

fn utf16(b: &[u8]) -> Vec<u16> {
    units(b).collect()
}

fn dup(h: HANDLE) -> HANDLE {
    let mut out = null_mut();
    unsafe { DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), &mut out, 0, 0, DUPLICATE_SAME_ACCESS) };
    out
}

/// Where the last whole UTF-8 sequence in `b` ends.
fn utf8_end(b: &[u8]) -> usize {
    for back in 1..=b.len().min(3) {
        let c = b[b.len() - back];
        if c & 0xc0 == 0x80 {
            continue;
        }
        let need = if c >= 0xf0 { 4 } else if c >= 0xe0 { 3 } else if c >= 0xc0 { 2 } else { 1 };
        return if need > back { b.len() - back } else { b.len() };
    }
    b.len()
}

/// Appends `b` as UTF-16, with U+FFFD for what isn't UTF-8.
fn utf8_lossy(b: &[u8], out: &mut Vec<u16>) {
    for chunk in b.utf8_chunks() {
        out.extend(chunk.valid().encode_utf16());
        if !chunk.invalid().is_empty() {
            out.push(0xfffd);
        }
    }
}

/// Appends `b`, in code page `cp`, as UTF-16.
fn mb_to_wide(cp: u32, b: &[u8], out: &mut Vec<u16>) {
    let Ok(len) = i32::try_from(b.len()) else { return };
    if len == 0 {
        return;
    }
    let n = unsafe { MultiByteToWideChar(cp, 0, b.as_ptr(), len, null_mut(), 0) }.max(0);
    let at = out.len();
    out.resize(at + n as usize, 0);
    unsafe { MultiByteToWideChar(cp, 0, b.as_ptr(), len, out[at..].as_mut_ptr(), n) };
}

/// Appends `w` in code page `cp`.
fn wide_to_mb(cp: u32, w: &[u16], out: &mut Vec<u8>) {
    let Ok(len) = i32::try_from(w.len()) else { return };
    if len == 0 {
        return;
    }
    let n = unsafe { WideCharToMultiByte(cp, 0, w.as_ptr(), len, null_mut(), 0, null(), null_mut()) }.max(0);
    let at = out.len();
    out.resize(at + n as usize, 0);
    unsafe { WideCharToMultiByte(cp, 0, w.as_ptr(), len, out[at..].as_mut_ptr(), n, null(), null_mut()) };
}

/// Character `c` as one byte of code page `cp`: its first.
fn narrow(cp: u32, c: u16) -> u8 {
    let mut b = [0u8; 4];
    unsafe { WideCharToMultiByte(cp, 0, &c, 1, b.as_mut_ptr(), 4, null(), null_mut()) };
    b[0]
}

/// Byte `b` of code page `cp` as a character.
fn widen(cp: u32, b: u8) -> u16 {
    let mut c = 0u16;
    unsafe { MultiByteToWideChar(cp, 0, &b, 1, &mut c, 1) };
    c
}

/// The console's glyph for a control character, as conhost draws it in code page 437.
fn glyph(c: u16) -> u16 {
    const LUT: [u16; 32] = [
        0x20, 0x263A, 0x263B, 0x2665, 0x2666, 0x2663, 0x2660, 0x2022, 0x25D8, 0x25CB, 0x25D9, 0x2642, 0x2640, 0x266A, 0x266B, 0x263C, 0x25BA, 0x25C4, 0x2195,
        0x203C, 0xB6, 0xA7, 0x25AC, 0x21A8, 0x2191, 0x2193, 0x2192, 0x2190, 0x221F, 0x2194, 0x25B2, 0x25BC,
    ];
    match c {
        0..0x20 => LUT[c as usize],
        0x7f => 0x2302,
        _ => c,
    }
}

/// Campbell, the console's default colors, as COLORREFs.
const CAMPBELL: [u32; 16] = [
    0x0C0C0C, 0xDA3700, 0x0EA113, 0xDD963A, 0x1F0FC5, 0x981788, 0x009CC1, 0xCCCCCC, 0x767676, 0xFF783B, 0x0CC616, 0xD6D661, 0x5648E7, 0x9E00B4, 0xA5F1F9,
    0xF2F2F2,
];

impl State {
    pub fn new(dev: Dev, event: HANDLE, cols: u16, rows: u16) -> State {
        let (cols, rows) = (cols.clamp(1, MAX_COLS) as i16, rows.clamp(1, MAX_ROWS) as i16);
        let oem = unsafe { GetOEMCP() };
        // ConPTY's consoles start with VT processing on (srvinit.cpp, SetDefaultVirtTermLevel).
        let mode = ENABLE_PROCESSED_OUTPUT | ENABLE_WRAP_AT_EOL_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING;
        State {
            dev,
            event,
            sink: None,
            closing: false,
            window: null_mut(),
            screen: Screen::new(cols as i32, rows as i32),
            cols,
            rows,
            in_mode: ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_MOUSE_INPUT,
            bufs: vec![ScreenBuf { id: 1, refs: 0, mode, attr: 7, cursor_size: 25, cursor_visible: true }],
            active: 0,
            cp_in: oem,
            cp_out: oem,
            input: VecDeque::new(),
            waits: VecDeque::new(),
            procs: Vec::new(),
            next_id: 1,
            title: Vec::new(),
            original_title: Vec::new(),
            cooked: None,
            hist: Vec::new(),
            pending: Vec::new(),
            carry: Vec::with_capacity(8),
            ctrl: VecDeque::new(),
            ctrl_busy: false,
            out: Vec::new(),
            alert: false,
            resync: None,
            dsr_out: 0,
            data: Vec::new(),
            reply_out: Vec::new(),
            text: Vec::new(),
            line: Vec::new(),
            seq: Vec::new(),
            recs: Vec::new(),
        }
    }

    fn id(&mut self) -> usize {
        self.next_id += 1;
        self.next_id
    }

    fn obj(&self, id: usize) -> Option<Obj> {
        match id {
            INPUT => Some(Obj::Input),
            _ if id.is_multiple_of(2) && self.bufs.iter().any(|b| b.id == id / 2) => Some(Obj::Output(id / 2)),
            _ => None,
        }
    }

    fn buf(&mut self, id: usize) -> Option<&mut ScreenBuf> {
        self.bufs.iter_mut().find(|b| b.id == id)
    }

    fn active_id(&self) -> usize {
        self.bufs[self.active].id
    }

    /// The input event says whether input waits; what was drawn goes to the terminal.
    pub fn settle(&mut self) {
        unsafe {
            if self.input.is_empty() {
                ResetEvent(self.event);
            } else {
                SetEvent(self.event);
            }
        }
        self.flush();
    }

    /// Sends what was drawn to the terminal; until there's a sink, it waits.
    pub fn flush(&mut self) {
        if let Some(sink) = self.sink.as_mut().filter(|_| !self.out.is_empty()) {
            sink(&self.out);
            self.out.clear();
        }
    }

    /// Whether control events wait with no thread sending them, which the caller then starts.
    pub fn ctrl_start(&mut self) -> bool {
        !self.ctrl.is_empty() && !std::mem::replace(&mut self.ctrl_busy, true)
    }

    /// The next control event to send, or none, and then its thread ends.
    pub fn ctrl_next(&mut self) -> Option<(HANDLE, u32)> {
        let next = self.ctrl.pop_front();
        self.ctrl_busy = next.is_some();
        next
    }

    /// No thread could start to send the control events.
    pub fn ctrl_drop(&mut self) {
        for (h, _) in self.ctrl.drain(..) {
            unsafe { CloseHandle(h) };
        }
        self.ctrl_busy = false;
    }

    /// The server failed: every attached process ends, so the tab closes.
    pub fn end(&mut self) {
        for p in &self.procs {
            unsafe { TerminateProcess(p.handle, 1) };
        }
    }

    /// Each attached process gets CTRL_CLOSE_EVENT, newest first: handles of their own to wait on, in that order.
    pub fn close(&mut self) -> Vec<HANDLE> {
        let procs: Vec<HANDLE> = self.procs.iter().rev().map(|p| dup(p.handle)).collect();
        self.ctrl.extend(procs.iter().map(|&h| (dup(h), CTRL_CLOSE_EVENT)));
        procs
    }

    pub fn due(&self) -> Option<Instant> {
        self.resync.map(|r| r.2 + RESYNC)
    }

    pub fn tick(&mut self) {
        self.resync_overdue();
        self.service();
    }

    /// What the terminal sends: its answers to the console's own questions, then keys.
    pub fn keys(&mut self, keys: &str) {
        let mut text = take(&mut self.text);
        text.clear();
        text.extend(keys.encode_utf16());
        self.take_reports(&mut text);
        self.take_input(&text);
        self.text = text;
        self.service();
    }

    pub fn dispatch(&mut self, m: &Msg) -> Option<Reply> {
        self.resync_overdue();
        let d = m.d;
        Some(match d.function {
            IO_CONNECT => self.connect(&d),
            IO_DISCONNECT => {
                if let Some(i) = self.procs.iter().position(|p| p.id == d.process) {
                    unsafe { CloseHandle(self.procs.remove(i).handle) };
                }
                // A line being read goes with its read, so the next program's read starts its own where it is.
                if self.waits.iter().any(|w| w.process == d.process && matches!(w.kind, WaitKind::Read { .. })) {
                    self.cooked = None;
                }
                self.waits.retain(|w| w.process != d.process);
                Reply::new(&d)
            }
            IO_CREATE_OBJECT => {
                let (mut kind, access): (u32, u32) = (rd(&m.u, 0), rd(&m.u, 8));
                if kind == 4 {
                    // A generic handle: input or output by its access.
                    kind = match access & (GENERIC_READ | GENERIC_WRITE) {
                        GENERIC_READ => 1,
                        GENERIC_WRITE => 2,
                        _ => 0,
                    };
                }
                let value = match kind {
                    1 => INPUT,
                    2 | 3 => {
                        let id = if kind == 2 { self.active_id() } else { self.id() };
                        if kind == 3 {
                            self.bufs.push(ScreenBuf { id, refs: 0, ..self.bufs[self.active] });
                        }
                        if let Some(b) = self.buf(id) {
                            b.refs += 1;
                        }
                        id * 2
                    }
                    _ => return Some(Reply::fail(&d, INVALID_PARAMETER)),
                };
                Reply { info: value, ..Reply::new(&d) }
            }
            IO_CLOSE_OBJECT => {
                if let Some(Obj::Output(id)) = self.obj(d.object) {
                    let active = self.active_id();
                    if let Some(b) = self.buf(id) {
                        b.refs = b.refs.saturating_sub(1);
                        // A buffer of its own goes once nothing names it.
                        if b.refs == 0 && id != active && id != 1 {
                            self.bufs.retain(|x| x.id != id);
                            self.active = self.bufs.iter().position(|x| x.id == active).unwrap_or(0);
                        }
                    }
                }
                Reply::new(&d)
            }
            IO_RAW_WRITE => {
                let Some(Obj::Output(b)) = self.obj(d.object) else { return Some(Reply::fail(&d, INVALID_HANDLE)) };
                if !self.write_from(d.id, 0, d.input, false, b) {
                    return Some(Reply::fail(&d, UNSUCCESSFUL));
                }
                Reply { info: d.input as usize, ..Reply::new(&d) }
            }
            IO_RAW_READ => {
                if self.obj(d.object) != Some(Obj::Input) {
                    return Some(Reply::fail(&d, INVALID_HANDLE));
                }
                let kind = WaitKind::Read { unicode: false, raw_io: true, ctrlz: true, wakeup: 0 };
                return self.read_or_wait(Wait { reply: Reply::new(&d), kind, process: d.process, out_cap: d.output });
            }
            IO_RAW_FLUSH => {
                self.input.clear();
                Reply::new(&d)
            }
            IO_USER_DEFINED => return self.api(m),
            _ => Reply::fail(&d, UNSUCCESSFUL),
        })
    }

    fn connect(&mut self, d: &Desc) -> Reply {
        // CONSOLE_SERVER_MSG: 1340 bytes, its strings' lengths in bytes.
        let mut info = take(&mut self.data);
        if !self.dev.read_input(d.id, 0, 1340, &mut info) {
            self.data = info;
            return Reply::fail(d, UNSUCCESSFUL);
        }
        let group: u32 = rd(&info, 28);
        let title = utf16(&info[36..36 + (rd::<u16>(&info, 34) as usize).min(522)]);
        let exe = String::from_utf16_lossy(&utf16(&info[560..560 + (rd::<u16>(&info, 558) as usize).min(256)])).to_lowercase();
        self.data = info;
        let pid = d.process as u32;
        let id = self.id();
        if self.procs.is_empty() && self.title.is_empty() {
            self.original_title.clone_from(&title);
            self.title = title;
        }
        self.procs.push(Proc { id, pid, group, exe, handle: unsafe { OpenProcess(MAXIMUM_ALLOWED, 0, pid) } });
        let output = self.active_id();
        self.bufs[self.active].refs += 1;
        let mut r = Reply { info: 24, body_len: 24, ..Reply::new(d) };
        wr(&mut r.body, 0, id);
        wr(&mut r.body, 8, INPUT);
        wr(&mut r.body, 16, output * 2);
        r
    }

    /// The scratch buffer for a reply's output data, empty.
    fn scratch(&mut self) -> Vec<u8> {
        let mut out = take(&mut self.reply_out);
        out.clear();
        out
    }

    /// Writes the reply's output data and sets its information to match: the status.
    fn send(&mut self, r: &mut Reply, out: Vec<u8>) -> i32 {
        let ok = self.dev.write_output(r.id, r.out_at, &out);
        r.info = out.len();
        self.reply_out = out;
        if ok {
            SUCCESS
        } else {
            UNSUCCESSFUL
        }
    }

    /// A user-defined message: an API call with its header, its body, and its buffers.
    fn api(&mut self, m: &Msg) -> Option<Reply> {
        let d = m.d;
        let (api, size): (u32, u32) = (rd(&m.u, 0), rd(&m.u, 4));
        let mut r = Reply::new(&d);
        if d.input < 8 || size as usize > UNION - 8 || size > d.input - 8 {
            return Some(Reply::fail(&d, ILLEGAL_FUNCTION));
        }
        r.body[..size as usize].copy_from_slice(&m.u[8..8 + size as usize]);
        r.body_len = size;
        r.out_at = size;
        let read_at = size + 8;
        let in_len = d.input - read_at;
        let out_cap = d.output.saturating_sub(size);
        let obj = self.obj(d.object);
        let b = &mut r.body;
        let status = match (api, obj) {
            // GetConsoleCP
            (0x0100_0000, _) => {
                let cp = if rd::<u8>(b, 4) != 0 { self.cp_out } else { self.cp_in };
                wr(b, 0, cp);
                SUCCESS
            }
            // GetConsoleMode
            (0x0100_0001, Some(Obj::Input)) => {
                wr(b, 0, self.in_mode);
                SUCCESS
            }
            (0x0100_0001, Some(Obj::Output(id))) => {
                wr(b, 0, self.buf(id).map_or(0, |x| x.mode));
                SUCCESS
            }
            // SetConsoleMode
            (0x0100_0002, Some(Obj::Input)) => {
                self.in_mode = rd(b, 0);
                SUCCESS
            }
            (0x0100_0002, Some(Obj::Output(id))) => {
                let mode: u32 = rd(b, 0);
                if let Some(x) = self.buf(id) {
                    x.mode = mode & 0x1f;
                }
                if mode & !0x1f != 0 {
                    INVALID_PARAMETER
                } else {
                    SUCCESS
                }
            }
            // GetNumberOfConsoleInputEvents: fails on an output handle, which is how libuv tells stdin from stdout.
            (0x0100_0003, Some(Obj::Input)) => {
                wr(b, 0, self.input.len() as u32);
                SUCCESS
            }
            // GetConsoleInput: ReadConsoleInput and PeekConsoleInput
            (0x0100_0004, Some(Obj::Input)) => {
                let (flags, unicode): (u16, bool) = (rd(b, 4), rd::<u8>(b, 6) != 0);
                let n = self.input.len().min(out_cap as usize / 20);
                if n == 0 && flags & 2 == 0 {
                    return self.read_or_wait(Wait { reply: r, kind: WaitKind::Input { unicode }, process: d.process, out_cap });
                }
                let mut out = self.scratch();
                for i in 0..n {
                    self.put_record(i, unicode, &mut out);
                }
                if flags & 1 == 0 {
                    self.input.drain(..n);
                }
                wr(b, 0, n as u32);
                self.send(&mut r, out)
            }
            // ReadConsole
            (0x0100_0005, Some(Obj::Input)) => {
                let unicode = rd::<u8>(b, 0) != 0;
                let ctrlz = rd::<u8>(b, 1) != 0 && self.in_mode & ENABLE_PROCESSED_INPUT != 0;
                let exe_len = (rd::<u16>(b, 2) as u32 * 2).min(in_len);
                let initial = rd::<u32>(b, 4).min(in_len - exe_len);
                let wakeup: u32 = rd(b, 8);
                let mut data = take(&mut self.data);
                if initial > 0 && self.cooked.is_none() && self.in_mode & ENABLE_LINE_INPUT != 0 && self.dev.read_input(d.id, read_at + exe_len, initial as usize, &mut data) {
                    let (x, y) = self.screen.cursor();
                    let mut init = Vec::new();
                    if unicode {
                        init = utf16(&data);
                    } else {
                        mb_to_wide(self.cp_in, &data, &mut init);
                    }
                    self.cooked = Some(Cooked::new(init, (y, x), self.cols as i32));
                }
                self.data = data;
                return self.read_or_wait(Wait { reply: r, kind: WaitKind::Read { unicode, raw_io: false, ctrlz, wakeup }, process: d.process, out_cap });
            }
            // WriteConsole
            (0x0100_0006, Some(Obj::Output(id))) => {
                let unicode = rd::<u8>(b, 4) != 0;
                if self.write_from(d.id, read_at, in_len, unicode, id) {
                    wr(b, 0, in_len);
                    r.info = in_len as usize;
                    SUCCESS
                } else {
                    UNSUCCESSFUL
                }
            }
            // GetConsoleLangId
            (0x0100_0008, _) => {
                wr(b, 0, unsafe { GetUserDefaultLangID() });
                SUCCESS
            }
            // GenerateConsoleCtrlEvent
            (0x0200_0001, _) => {
                let (event, group): (u32, u32) = (rd(b, 0), rd(b, 4));
                for p in self.procs.iter().rev().filter(|p| group == 0 || p.group == group) {
                    self.ctrl.push_back((dup(p.handle), event));
                }
                SUCCESS
            }
            // SetConsoleActiveScreenBuffer
            (0x0200_0002, Some(Obj::Output(id))) => {
                self.active = self.bufs.iter().position(|x| x.id == id).unwrap_or(self.active);
                SUCCESS
            }
            // FlushConsoleInputBuffer
            (0x0200_0003, Some(Obj::Input)) => {
                self.input.clear();
                SUCCESS
            }
            // SetConsoleCP
            (0x0200_0004, _) => {
                let cp: u32 = rd(b, 0);
                if rd::<u8>(b, 4) != 0 {
                    self.cp_out = cp;
                } else {
                    self.cp_in = cp;
                }
                SUCCESS
            }
            // GetConsoleCursorInfo
            (0x0200_0005, Some(Obj::Output(id))) => {
                let x = self.buf(id).copied().unwrap_or(self.bufs[0]);
                wr(b, 0, x.cursor_size);
                wr(b, 4, x.cursor_visible as u8);
                SUCCESS
            }
            // SetConsoleCursorInfo
            (0x0200_0006, Some(Obj::Output(id))) => {
                let (size, visible): (u32, u8) = (rd(b, 0), rd(b, 4));
                if let Some(x) = self.buf(id) {
                    x.cursor_size = size;
                    x.cursor_visible = visible != 0;
                }
                SUCCESS
            }
            // GetConsoleScreenBufferInfo: until the terminal says where its cursor went after a resize, it waits.
            (0x0200_0007, Some(Obj::Output(id))) if self.resync.is_some() => {
                return self.read_or_wait(Wait { reply: r, kind: WaitKind::Info { id }, process: d.process, out_cap });
            }
            (0x0200_0007, Some(Obj::Output(id))) => {
                self.screen_info(id, b);
                SUCCESS
            }
            // SetConsoleScreenBufferInfo, SetConsoleScreenBufferSize, SetConsoleWindowInfo: the terminal sets the size.
            (0x0200_0008 | 0x0200_0009 | 0x0200_000E, Some(Obj::Output(_))) => SUCCESS,
            // SetConsoleCursorPosition
            (0x0200_000A, Some(Obj::Output(_))) => {
                let [x, y]: [i16; 2] = rd(b, 0);
                if x < 0 || y < 0 || x >= self.cols || y >= self.rows {
                    INVALID_PARAMETER
                } else {
                    self.emit_with(|s| cup(s, (y as i32, x as i32)));
                    SUCCESS
                }
            }
            // GetLargestConsoleWindowSize
            (0x0200_000B, _) => {
                wr(b, 0, [self.cols, self.rows]);
                SUCCESS
            }
            // SetConsoleTextAttribute
            (0x0200_000D, Some(Obj::Output(id))) => {
                let a: u16 = rd(b, 0);
                if let Some(x) = self.buf(id) {
                    x.attr = a;
                }
                if id == self.active_id() {
                    self.emit_with(|s| sgr(s, a));
                }
                SUCCESS
            }
            // The APIs that read or change cells: FillConsoleOutput, ScrollConsoleScreenBuffer,
            // Read/WriteConsoleOutputString, Read/WriteConsoleOutput, on the buffer on screen.
            (0x0200_0000 | 0x0200_000C | 0x0200_000F | 0x0200_0011..=0x0200_0013, Some(Obj::Output(id))) => {
                if id != self.active_id() {
                    SUCCESS
                } else if matches!(api, 0x0200_0011 | 0x0200_0012) && !self.dev.read_input(d.id, read_at, in_len.min(4 * MAX_COLS as u32 * MAX_ROWS as u32) as usize, &mut self.data) {
                    UNSUCCESSFUL
                } else {
                    let input = take(&mut self.data);
                    let shell = match self.procs.iter().find(|p| p.id == d.process).map(|p| p.exe.as_str()) {
                        Some("cmd.exe") => Prog::Cmd,
                        Some("powershell.exe" | "pwsh.exe") => Prog::PowerShell,
                        _ => Prog::Other,
                    };
                    let mut out = self.scratch();
                    let status = self.cells(api, b, &input, out_cap as usize, shell, &mut out);
                    self.data = input;
                    match status {
                        SUCCESS => self.send(&mut r, out),
                        s => {
                            self.reply_out = out;
                            s
                        }
                    }
                }
            }
            // WriteConsoleInput: records into the queue, at its end or (Append false) its front.
            (0x0200_0010, Some(Obj::Input)) => {
                let (unicode, append) = (rd::<u8>(b, 4) != 0, rd::<u8>(b, 5) != 0);
                let mut data = take(&mut self.data);
                let status = if !self.dev.read_input(d.id, read_at, in_len.min(20 << 16) as usize, &mut data) {
                    UNSUCCESSFUL
                } else {
                    let recs = data.as_chunks::<20>().0.iter().map(|c| {
                        let mut rec = Rec::from_bytes(c);
                        if !unicode && rec.kind == KEY_EVENT {
                            let ch = widen(self.cp_in, rec.ev[10]);
                            rec.ev[10..12].copy_from_slice(&ch.to_le_bytes());
                        }
                        rec
                    });
                    let n = recs.len();
                    if append {
                        self.input.extend(recs);
                    } else {
                        for (i, rec) in recs.enumerate() {
                            self.input.insert(i, rec);
                        }
                    }
                    wr(b, 0, n as u32);
                    SUCCESS
                };
                self.data = data;
                self.service();
                status
            }
            // GetConsoleTitle: a count of characters (or bytes), and as much of the text as fits with a NUL.
            (0x0200_0014, _) => {
                let (unicode, original) = (rd::<u8>(b, 4) != 0, rd::<u8>(b, 5) != 0);
                let mut out = self.scratch();
                let t = if original { &self.original_title } else { &self.title };
                if unicode {
                    bytes_le(t, &mut out);
                } else {
                    wide_to_mb(self.cp_out, t, &mut out);
                }
                let unit = if unicode { 2 } else { 1 };
                wr(b, 0, (out.len() / unit) as u32);
                if out.len() >= out_cap as usize {
                    out.truncate((out_cap as usize / unit).saturating_sub(1) * unit);
                    out.extend_from_slice(&[0; 2][..unit.min(out_cap as usize)]);
                }
                self.send(&mut r, out)
            }
            // SetConsoleTitle, shown as OSC 0 with control characters as spaces.
            (0x0200_0015, _) => {
                let unicode = rd::<u8>(b, 0) != 0;
                let mut data = take(&mut self.data);
                let status = if !self.dev.read_input(d.id, read_at, in_len.min(1 << 16) as usize, &mut data) {
                    UNSUCCESSFUL
                } else {
                    self.title.clear();
                    if unicode {
                        self.title.extend(units(&data));
                    } else {
                        mb_to_wide(self.cp_out, &data, &mut self.title);
                    }
                    self.out.extend_from_slice(b"\x1b]0;");
                    for c in char::decode_utf16(self.title.iter().copied()) {
                        let c = c.map_or('\u{fffd}', |c| if c.is_control() { ' ' } else { c });
                        self.out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes());
                    }
                    self.out.extend_from_slice(b"\x1b\\");
                    SUCCESS
                };
                self.data = data;
                status
            }
            // GetConsoleMouseInfo: buttons
            (0x0300_0001, _) => {
                wr(b, 0, 5u32);
                SUCCESS
            }
            // GetCurrentConsoleFont: an 8 by 16 Consolas, as a console window would have.
            (0x0300_0004, Some(Obj::Output(_))) => {
                wr(b, 4, 0u32);
                wr(b, 8, [8i16, 16]);
                wr(b, 12, 0x36u32);
                wr(b, 16, 400u32);
                for (i, c) in "Consolas".encode_utf16().chain([0]).enumerate() {
                    wr(b, 20 + i * 2, c);
                }
                SUCCESS
            }
            // GetConsoleDisplayMode
            (0x0300_0011, _) => {
                wr(b, 0, 0u32);
                SUCCESS
            }
            // GetConsoleWindow: a hidden window of the console's own, made the first time it's asked for.
            (0x0300_001F, _) => {
                if self.window.is_null() {
                    self.window = window::create();
                }
                wr(b, 0, self.window as usize);
                SUCCESS
            }
            // GetConsoleProcessList, newest first, when they fit.
            (0x0300_0029, _) => {
                let n = self.procs.len();
                let mut out = self.scratch();
                if n <= out_cap as usize / 4 {
                    out.extend(self.procs.iter().rev().flat_map(|p| p.pid.to_le_bytes()));
                }
                wr(b, 0, n as u32);
                self.send(&mut r, out)
            }
            (
                0x0100_0001..=0x0100_0006 | 0x0200_0000 | 0x0200_0002 | 0x0200_0003 | 0x0200_0005..=0x0200_000A | 0x0200_000C..=0x0200_0013 | 0x0300_0004,
                _,
            ) => INVALID_HANDLE,
            _ => NOT_IMPLEMENTED,
        };
        r.status = status;
        Some(r)
    }

    /// GetConsoleScreenBufferInfo's body for buffer `id`.
    fn screen_info(&mut self, id: usize, b: &mut [u8]) {
        let attr = if id == self.active_id() { self.screen.attr } else { self.buf(id).map_or(7, |x| x.attr) };
        let (x, y) = self.screen.cursor();
        let size = [self.cols, self.rows];
        wr(b, 0, size);
        wr(b, 4, [x as i16, y as i16]);
        wr(b, 8, [0i16, 0]);
        wr(b, 12, attr);
        wr(b, 14, size);
        wr(b, 18, size);
        wr(b, 22, 0xf5u16);
        wr(b, 24, 0u8);
        for (i, c) in CAMPBELL.iter().enumerate() {
            wr(b, 28 + i * 4, *c);
        }
    }

    /// Writes `len` bytes of message `id`'s input from `offset` on to buffer `buf`, a piece at a time, each sent to
    /// the terminal as it's done: UTF-16 text when `unicode`, else bytes in the output code page.
    fn write_from(&mut self, id: [u32; 2], offset: u32, len: u32, unicode: bool, buf: usize) -> bool {
        if buf != self.active_id() {
            return true; // a buffer not on screen: nothing shows
        }
        let (mut data, mut text) = (take(&mut self.data), take(&mut self.text));
        let mut at = 0;
        let mut ok = true;
        while at < len {
            let mut n = (len - at).min(PIECE);
            if unicode {
                n &= !1;
                if n == 0 {
                    break;
                }
            }
            if !self.dev.read_input(id, offset + at, n as usize, &mut data) {
                ok = false;
                break;
            }
            text.clear();
            if unicode {
                text.extend(units(&data));
                // A surrogate pair cut in two waits for the next piece.
                if at + n < len && text.len() > 1 && (0xd800..0xdc00).contains(&text[text.len() - 1]) {
                    text.pop();
                    n -= 2;
                }
            } else if self.cp_out == UTF8 {
                let mut bytes = &data[..];
                // The character the last write or piece cut off takes the bytes it lacks.
                if let Some(&lead) = self.carry.first() {
                    let need = match lead {
                        0xf0.. => 4,
                        0xe0.. => 3,
                        _ => 2,
                    };
                    let k = (need - self.carry.len().min(need)).min(bytes.len());
                    self.carry.extend_from_slice(&bytes[..k]);
                    bytes = &bytes[k..];
                    if self.carry.len() >= need {
                        utf8_lossy(&self.carry, &mut text);
                        self.carry.clear();
                    }
                }
                let end = utf8_end(bytes);
                utf8_lossy(&bytes[..end], &mut text);
                self.carry.extend_from_slice(&bytes[end..]);
            } else {
                mb_to_wide(self.cp_out, &data, &mut text);
            }
            self.write_text(&text);
            self.flush();
            at += n;
        }
        self.data = data;
        self.text = text;
        ok
    }

    /// What a program writes, as ConPTY passes it on: VT as is, with a CR before each bare LF unless the program
    /// asked for none; without VT, control characters as the console handles them, and a CRLF where a row fills,
    /// since the console moves to the next row there.
    fn write_text(&mut self, text: &[u16]) {
        let mode = self.bufs[self.active].mode;
        let vt = ENABLE_VIRTUAL_TERMINAL_PROCESSING | ENABLE_PROCESSED_OUTPUT;
        if mode & vt != vt {
            return self.write_plain(text, mode);
        }
        if mode & DISABLE_NEWLINE_AUTO_RETURN != 0 {
            return self.emit(text);
        }
        // A CR before each run of CRs and LFs that starts with a bare LF (VtIo's WriteUTF16TranslateCRLF).
        let mut from = 0;
        for i in 0..text.len() {
            if text[i] == 0x0a && (i == 0 || text[i - 1] != 0x0d && text[i - 1] != 0x0a) {
                self.emit(&text[from..i]);
                self.emit(&[0x0d]);
                from = i;
            }
        }
        self.emit(&text[from..]);
    }

    fn write_plain(&mut self, text: &[u16], mode: u32) {
        let processed = mode & ENABLE_PROCESSED_OUTPUT != 0;
        let wrap = mode & ENABLE_WRAP_AT_EOL_OUTPUT != 0;
        let (mut from, mut i) = (0, 0);
        while i < text.len() {
            let c = text[i];
            let pair = (0xd800..0xdc00).contains(&c) && text.get(i + 1).is_some_and(|l| (0xdc00..0xe000).contains(l));
            let n = 1 + pair as usize;
            let control = c < 0x20 || c == 0x7f;
            if !control && !wrap {
                i += n;
                continue;
            }
            self.emit(&text[from..i]);
            match c {
                _ if !control => self.print(&text[i..i + n], wrap),
                _ if !processed => self.print(&[0x20], wrap),
                0 => self.print(&[0x20], wrap),
                7 | 8 | 0x0d => self.emit(&[c]),
                9 => {
                    let x = self.screen.cursor().0;
                    for _ in 0..(8 - (x & 7)).min(self.cols as i32 - x).max(0) {
                        self.print(&[0x20], wrap);
                    }
                }
                0x0a if mode & DISABLE_NEWLINE_AUTO_RETURN == 0 && (i == 0 || text[i - 1] != 0x0d) => self.emit(&[0x0d, 0x0a]),
                0x0a => self.emit(&[0x0a]),
                _ => self.print(&[glyph(c)], wrap),
            }
            i += n;
            from = i;
        }
        self.emit(&text[from..]);
    }

    /// One character, and with `wrap` a CRLF once it fills the row.
    fn print(&mut self, c: &[u16], wrap: bool) {
        self.emit(c);
        if wrap && self.screen.raw_x() >= self.cols as i32 {
            self.emit(&[0x0d, 0x0a]);
        }
    }

    /// Sends `text` to the terminal, and the screen follows it.
    fn emit(&mut self, text: &[u16]) {
        self.screen.feed(text);
        self.out.reserve(text.len());
        for c in char::decode_utf16(text.iter().copied()) {
            match c {
                Ok(c) if c.is_ascii() => self.out.push(c as u8),
                c => self.out.extend_from_slice(c.unwrap_or('\u{fffd}').encode_utf8(&mut [0; 4]).as_bytes()),
            }
        }
    }

    /// Emits what `f` writes.
    fn emit_with(&mut self, f: impl FnOnce(&mut Vec<u16>)) {
        let mut s = take(&mut self.seq);
        s.clear();
        f(&mut s);
        self.emit(&s);
        self.seq = s;
    }

    /// The terminal's new size. The screen takes it at once. On the normal screen the terminal reflowed its lines,
    /// which this one doesn't, so it asks the terminal where the cursor went (ESC[6n, as OpenConsole does) and tells
    /// programs of the size once it knows; on the alternate screen it tells them now.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let (cols, rows) = (cols.clamp(1, MAX_COLS) as i16, rows.clamp(1, MAX_ROWS) as i16);
        if (cols, rows) == (self.cols, self.rows) {
            return;
        }
        self.cols = cols;
        self.rows = rows;
        let lost = self.screen.resize(cols as i32, rows as i32);
        if let Some(c) = &mut self.cooked {
            c.resized(lost, cols as i32);
        }
        if self.screen.alt {
            self.resized();
        } else {
            let (x, y) = self.screen.cursor();
            self.resync = Some((x, y, Instant::now()));
            self.dsr_out += 1;
            self.emit_with(|s| lit(s, "\x1b[6n"));
        }
        self.service();
    }

    /// The terminal answered ESC[6n with its cursor (`at`, or none after too long a wait): the screen moves to
    /// match, then a cooked read draws its line again and programs hear of the size.
    fn resynced(&mut self, at: Option<(i32, i32)>) {
        let Some((x0, y0, _)) = self.resync.take() else { return };
        if let Some((x, y)) = at {
            self.screen.offset(x - x0, y - y0);
            if let Some(c) = &mut self.cooked {
                c.offset(y - y0);
            }
        }
        self.resized();
    }

    fn resized(&mut self) {
        let (cols, rows) = (self.cols, self.rows);
        if self.in_mode & ENABLE_ECHO_INPUT != 0 {
            if let Some(mut c) = self.cooked.take() {
                let at = self.screen.cursor();
                self.emit_with(|s| c.redraw((at.1, at.0), cols as i32, rows as i32, s));
                self.cooked = Some(c);
            }
        }
        if self.in_mode & ENABLE_WINDOW_INPUT != 0 {
            let rec = Rec::size(cols, rows);
            match self.input.back_mut() {
                Some(last) if last.kind == SIZE_EVENT => *last = rec,
                _ => self.input.push_back(rec),
            }
        }
    }

    /// Takes the answers to the console's own ESC[6n out of the terminal's text: ESC [ row ; col R.
    fn take_reports(&mut self, text: &mut Vec<u16>) {
        let mut i = 0;
        while self.dsr_out > 0 && i < text.len() {
            let Some(at) = text[i..].windows(2).position(|w| w == [0x1b, b'[' as u16]) else { break };
            let start = i + at;
            let mut j = start + 2;
            let (mut n, mut k) = ([0i32; 2], 0);
            while let Some(&c) = text.get(j) {
                match c {
                    0x30..=0x39 => n[k] = n[k].saturating_mul(10).saturating_add((c - 0x30) as i32),
                    0x3b if k == 0 => k = 1,
                    _ => break,
                }
                j += 1;
            }
            if k == 1 && text.get(j) == Some(&(b'R' as u16)) && n[0] > 0 && n[1] > 0 {
                text.drain(start..=j);
                self.dsr_out -= 1;
                if self.dsr_out == 0 {
                    self.resynced(Some((n[1] - 1, n[0] - 1)));
                }
                i = start;
            } else {
                i = start + 2;
            }
        }
    }

    /// A terminal that never answers: after RESYNC the screen keeps its own guess.
    fn resync_overdue(&mut self) {
        if self.resync.is_some_and(|r| r.2.elapsed() >= RESYNC) {
            self.dsr_out = 0;
            self.resynced(None);
        }
    }

    /// Takes the terminal's text as key events, or as characters for a program that reads VT. Ctrl+C, while the
    /// console processes input, goes to the processes as CTRL_C_EVENT instead.
    fn take_input(&mut self, text: &[u16]) {
        let mut recs = take(&mut self.recs);
        recs.clear();
        if self.in_mode & ENABLE_VIRTUAL_TERMINAL_INPUT != 0 {
            for &ch in text {
                let k = Key { down: 1, repeat: 1, vk: 0, scan: 0, ch, state: 0 };
                recs.extend([Rec::key(k), Rec::key(Key { down: 0, ..k })]);
            }
        } else {
            keys(text, &mut recs);
        }
        for &r in &recs {
            if let Some(k) = r.as_key() {
                let ctrl_c = k.ch == 3 && (k.vk == 0 || k.state & LCTRL != 0 && k.state & LALT == 0);
                if ctrl_c && self.in_mode & ENABLE_PROCESSED_INPUT != 0 {
                    if k.down != 0 {
                        self.ctrl_c();
                    }
                    continue;
                }
            }
            self.input.push_back(r);
        }
        self.recs = recs;
    }

    /// Ctrl+C: every attached process gets CTRL_C_EVENT, newest first, and a read in progress ends, alerted.
    fn ctrl_c(&mut self) {
        for p in self.procs.iter().rev() {
            self.ctrl.push_back((dup(p.handle), CTRL_C_EVENT));
        }
        self.cooked = None;
        self.alert = true;
    }

    /// Answers the waits the input now satisfies, oldest first.
    fn service(&mut self) {
        let alert = take(&mut self.alert);
        for _ in 0..self.waits.len() {
            let Some(mut w) = self.waits.pop_front() else { break };
            if let (true, WaitKind::Read { raw_io, .. }) = (alert, w.kind) {
                // Nothing read: the request's own NumBytes would hand the client its buffer back as a line.
                if !raw_io {
                    wr(&mut w.reply.body, 12, 0u32);
                    wr(&mut w.reply.body, 16, 0u32);
                }
                self.dev.complete(&Reply { status: ALERTED, ..w.reply });
                continue;
            }
            if self.read(&mut w) {
                self.dev.complete(&w.reply);
            } else {
                self.waits.push_back(w);
            }
        }
    }

    fn read_or_wait(&mut self, mut w: Wait) -> Option<Reply> {
        if self.read(&mut w) {
            return Some(w.reply);
        }
        self.waits.push_back(w);
        None
    }

    /// Appends input record `i` as INPUT_RECORD, its character in the input code page unless `unicode`.
    fn put_record(&self, i: usize, unicode: bool, out: &mut Vec<u8>) {
        let rec = self.input[i];
        out.extend_from_slice(&rec.kind.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(&rec.ev);
        if !unicode && rec.kind == KEY_EVENT {
            let at = out.len() - 6;
            let ch = narrow(self.cp_in, u16::from_le_bytes([out[at], out[at + 1]]));
            out[at..at + 2].copy_from_slice(&[ch, 0]);
        }
    }

    /// Edits the cooked read's line with the input there is, and draws it. The line once Enter or a wakeup
    /// character ends it, with the key state.
    fn cooked_read(&mut self, process: usize, wakeup: u32) -> Option<(Vec<u16>, u32)> {
        let echo = self.in_mode & ENABLE_ECHO_INPUT != 0;
        let processed = self.in_mode & ENABLE_PROCESSED_INPUT != 0;
        let exe = self.procs.iter().find(|p| p.id == process).map_or("", |p| p.exe.as_str());
        let hi = match self.hist.iter().position(|h| h.0 == exe) {
            Some(i) => i,
            None => {
                self.hist.push((exe.to_string(), History::default()));
                self.hist.len() - 1
            }
        };
        let cols = self.cols as i32;
        let mut c = self.cooked.take().unwrap_or_else(|| Cooked::new(Vec::new(), (0, 0), cols));
        let mut done = None;
        while let Some(rec) = self.input.pop_front() {
            let Some(k) = rec.as_key().filter(|k| k.down != 0) else { continue };
            for _ in 0..k.repeat.max(1) {
                done = c.key(&k, wakeup, processed, &mut self.hist[hi].1);
                if done.is_some() {
                    break;
                }
            }
            if done.is_some() {
                break;
            }
        }
        // While the terminal's cursor is being asked for, the line waits: `resized` draws it all once it's known.
        if echo && self.resync.is_none() {
            let (x, y) = self.screen.cursor();
            let x = if self.screen.raw_x() >= cols { cols } else { x };
            let rows = self.rows as i32;
            self.emit_with(|s| c.redraw((y, x), cols, rows, s));
        }
        match done {
            None => {
                self.cooked = Some(c);
                None
            }
            Some(Done::Enter) => {
                let mut line = c.buf;
                if echo {
                    self.hist[hi].1.add(&line);
                    self.write_text(&[0x0d, 0x0a]);
                }
                line.extend_from_slice(if processed { &[0x0d, 0x0a][..] } else { &[0x0d][..] });
                Some((line, 0))
            }
            Some(Done::Wakeup(ch, state)) => {
                let mut line = c.buf;
                line.push(ch);
                Some((line, state))
            }
        }
    }

    /// Tries a read: whether the input held enough to answer it, in `w.reply`.
    fn read(&mut self, w: &mut Wait) -> bool {
        let ready = match w.kind {
            WaitKind::Info { .. } => self.resync.is_none(),
            WaitKind::Input { .. } => !self.input.is_empty(),
            WaitKind::Read { .. } => true,
        };
        if !ready {
            return false;
        }
        let mut out = self.scratch();
        let r = &mut w.reply;
        match w.kind {
            WaitKind::Info { id } => self.screen_info(id, &mut r.body),
            WaitKind::Input { unicode } => {
                let n = self.input.len().min(w.out_cap as usize / 20);
                for i in 0..n {
                    self.put_record(i, unicode, &mut out);
                }
                self.input.drain(..n);
                wr(&mut r.body, 0, n as u32);
            }
            WaitKind::Read { unicode, raw_io, ctrlz, wakeup } => {
                let mut keystate = 0;
                let mut text = if !self.pending.is_empty() {
                    take(&mut self.pending)
                } else if self.in_mode & ENABLE_LINE_INPUT != 0 {
                    match self.cooked_read(w.process, wakeup) {
                        Some((line, state)) => {
                            keystate = state;
                            line
                        }
                        None => {
                            self.reply_out = out;
                            return false;
                        }
                    }
                } else {
                    let mut text = take(&mut self.line);
                    text.clear();
                    let room = if unicode { w.out_cap as usize / 2 } else { w.out_cap as usize };
                    while text.len() < room {
                        let Some(rec) = self.input.pop_front() else { break };
                        if let Some(k) = rec.as_key().filter(|k| k.down != 0 && k.ch != 0) {
                            text.push(k.ch);
                        }
                    }
                    if text.is_empty() {
                        self.line = text;
                        self.reply_out = out;
                        return false;
                    }
                    text
                };
                // As much as the client's buffer holds; the rest waits for the next read.
                if unicode {
                    bytes_le(&text, &mut out);
                } else {
                    wide_to_mb(self.cp_in, &text, &mut out);
                }
                let cap = w.out_cap as usize;
                if out.len() > cap {
                    let fits = if unicode { cap / 2 } else { cap }; // ANSI: one byte a character, the common case
                    self.pending = text[fits.min(text.len())..].to_vec();
                    out.truncate(if unicode { fits * 2 } else { fits });
                }
                if ctrlz && out.first() == Some(&0x1a) {
                    out.clear();
                }
                if !raw_io {
                    wr(&mut r.body, 12, keystate);
                    wr(&mut r.body, 16, out.len() as u32);
                }
                text.clear();
                self.line = text;
            }
        }
        w.reply.status = self.send(&mut w.reply, out);
        true
    }
}
