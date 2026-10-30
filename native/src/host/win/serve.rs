//! WebView2's requests for nook's own scheme and files, answered from assets.rs. Every request from every
//! frame and worker comes here, on the UI thread. App files are answered inline from static memory; files on
//! disk and command fetches are deferred to a worker. Bodies are streams over the bytes, with no copy.
use super::webview;
use crate::com::{
    add_ref, call, get, guid, take_string, Com, Guid, E_NOINTERFACE, E_NOTIMPL, IID_IAGILEOBJECT, IID_IUNKNOWN, S_FALSE, S_OK,
};
use crate::host::assets::{self, Body, Reply, Route};
use crate::host::ipc;
use crate::sys::wide;
use std::ffi::c_void;
use std::os::windows::fs::FileExt;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

const IID_ISEQUENTIALSTREAM: Guid = guid(0x0c733a30_2a1c_11ce_ade5_00aa0044773d);
const IID_ISTREAM: Guid = guid(0x0000000c_0000_0000_c000_000000000046);

/// A COM pointer moved to another thread and back. Only the UI thread calls through it.
struct Ui(Com);
// SAFETY: see above.
unsafe impl Send for Ui {}

impl Ui {
    fn ptr(&self) -> *mut c_void {
        self.0 .0
    }
}

/// A WebResourceRequested event's args.
pub fn request(args: *mut c_void) {
    let Ok(req) = get(args, 3) else { return };
    match assets::route(&text(req.0, 3)) {
        Some(Route::App(path)) => send(args, assets::app(&path)),
        Some(Route::File(path)) => {
            let head = text(req.0, 5) == "HEAD";
            let range = header(req.0, "Range");
            later(args, move || assets::file(&path, head, range.as_deref()));
        }
        Some(Route::Ipc(cmd)) if assets::may_call(&text(req.0, 5), header(req.0, "Origin").as_deref()) => {
            let (json, body) = assets::command_args(header(req.0, "Content-Type").as_deref(), body(&req));
            later(args, move || assets::command_reply(ipc::fetch(&cmd, &json, &body)));
        }
        Some(Route::Ipc(_)) => send(args, assets::forbidden()),
        None => {}
    }
}

/// Answers with what `f` returns on a worker.
fn later(args: *mut c_void, f: impl FnOnce() -> Reply + Send + 'static) {
    let Ok(deferral) = get(args, 6) else { return };
    let (args, deferral) = (Ui(add_ref(args)), Ui(deferral));
    ipc::work(move || {
        let reply = f();
        super::post(move || {
            send(args.ptr(), reply);
            unsafe { call!(deferral.ptr(), 3) };
        });
    });
}

/// A string getter at slot `n` of `p`.
fn text(p: *mut c_void, n: usize) -> String {
    let mut s = null_mut();
    unsafe { call!(p, n, &mut s => *mut *mut u16) };
    take_string(s)
}

/// Request header `name`, if sent.
fn header(req: *mut c_void, name: &str) -> Option<String> {
    let headers = get(req, 9).ok()?;
    let mut s = null_mut();
    let hr = unsafe { call!(headers.0, 3, wide(name).as_ptr() => *const u16, &mut s => *mut *mut u16) };
    (hr >= 0).then(|| take_string(s))
}

/// The request's body.
fn body(req: &Com) -> Vec<u8> {
    let mut body = Vec::new();
    if let Ok(stream) = get(req.0, 7) {
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let mut n = 0u32;
            let hr =
                unsafe { call!(stream.0, 3, buf.as_mut_ptr() => *mut u8, buf.len() as u32 => u32, &mut n => *mut u32) };
            body.extend_from_slice(&buf[..n as usize]);
            if hr != S_OK || n == 0 {
                break;
            }
        }
    }
    body
}

/// Answers the request whose event args are `args`.
fn send(args: *mut c_void, r: Reply) {
    let body = r.body.map(stream);
    let mut resp = null_mut();
    unsafe {
        call!(webview::env(), 4,
            body.as_ref().map_or(null_mut(), |b| b.0) => *mut c_void,
            r.status as i32 => i32,
            wide(r.reason).as_ptr() => *const u16,
            wide(&r.headers).as_ptr() => *const u16,
            &mut resp => *mut *mut c_void);
        if let Ok(resp) = Com::new(resp) {
            call!(args, 5, resp.0 => *mut c_void);
        }
    }
}

/// An IStream over a body, which WebView2 may read on any thread.
#[repr(C)]
struct Stream {
    vt: &'static StreamVt,
    refs: AtomicU32,
    pos: AtomicU64,
    len: u64,
    body: Body,
}

#[repr(C)]
struct StreamVt {
    query: unsafe extern "system" fn(*mut Stream, *const Guid, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut Stream) -> u32,
    release: unsafe extern "system" fn(*mut Stream) -> u32,
    read: unsafe extern "system" fn(*mut Stream, *mut u8, u32, *mut u32) -> i32,
    write: unsafe extern "system" fn(*mut Stream) -> i32,
    seek: unsafe extern "system" fn(*mut Stream, i64, u32, *mut u64) -> i32,
    set_size: unsafe extern "system" fn(*mut Stream) -> i32,
    copy_to: unsafe extern "system" fn(*mut Stream) -> i32,
    commit: unsafe extern "system" fn(*mut Stream) -> i32,
    revert: unsafe extern "system" fn(*mut Stream) -> i32,
    lock_region: unsafe extern "system" fn(*mut Stream) -> i32,
    unlock_region: unsafe extern "system" fn(*mut Stream) -> i32,
    stat: unsafe extern "system" fn(*mut Stream, *mut u8, u32) -> i32,
    clone: unsafe extern "system" fn(*mut Stream) -> i32,
}

static STREAM_VT: StreamVt = StreamVt {
    query: s_query,
    add_ref: s_add_ref,
    release: s_release,
    read: s_read,
    write: s_none,
    seek: s_seek,
    set_size: s_none,
    copy_to: s_none,
    commit: s_none,
    revert: s_none,
    lock_region: s_none,
    unlock_region: s_none,
    stat: s_stat,
    clone: s_none,
};

fn stream(body: Body) -> Com {
    let s = Box::new(Stream { vt: &STREAM_VT, refs: AtomicU32::new(1), pos: AtomicU64::new(0), len: body.len(), body });
    Com(Box::into_raw(s).cast())
}

unsafe extern "system" fn s_query(this: *mut Stream, iid: *const Guid, out: *mut *mut c_void) -> i32 {
    if [IID_IUNKNOWN, IID_ISEQUENTIALSTREAM, IID_ISTREAM, IID_IAGILEOBJECT].contains(&*iid) {
        s_add_ref(this);
        *out = this.cast();
        S_OK
    } else {
        *out = null_mut();
        E_NOINTERFACE
    }
}

unsafe extern "system" fn s_add_ref(this: *mut Stream) -> u32 {
    (*this).refs.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn s_release(this: *mut Stream) -> u32 {
    let left = (*this).refs.fetch_sub(1, Ordering::Release) - 1;
    if left == 0 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this));
    }
    left
}

unsafe extern "system" fn s_read(this: *mut Stream, to: *mut u8, cb: u32, read: *mut u32) -> i32 {
    let s = &*this;
    let pos = s.pos.load(Ordering::Relaxed);
    let n = (cb as u64).min(s.len.saturating_sub(pos)) as usize;
    let to = std::slice::from_raw_parts_mut(to, n);
    let got = match &s.body {
        Body::Static(b) => {
            to.copy_from_slice(&b[pos as usize..][..n]);
            n
        }
        Body::Owned(v) => {
            to.copy_from_slice(&v[pos as usize..][..n]);
            n
        }
        Body::File(f, start, _) => {
            let mut got = 0;
            while got < n {
                match f.seek_read(&mut to[got..], start + pos + got as u64) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => got += k,
                }
            }
            got
        }
    };
    s.pos.store(pos + got as u64, Ordering::Relaxed);
    if !read.is_null() {
        *read = got as u32;
    }
    if got < cb as usize {
        S_FALSE
    } else {
        S_OK
    }
}

unsafe extern "system" fn s_seek(this: *mut Stream, by: i64, origin: u32, to: *mut u64) -> i32 {
    let s = &*this;
    let from = match origin {
        0 => 0,
        1 => s.pos.load(Ordering::Relaxed) as i64,
        _ => s.len as i64,
    };
    let at = (from + by).max(0) as u64;
    s.pos.store(at, Ordering::Relaxed);
    if !to.is_null() {
        *to = at;
    }
    S_OK
}

/// Fills a STATSTG: type STGTY_STREAM and the size.
unsafe extern "system" fn s_stat(this: *mut Stream, stat: *mut u8, _: u32) -> i32 {
    std::ptr::write_bytes(stat, 0, 80);
    *(stat.add(8) as *mut u32) = 2;
    *(stat.add(16) as *mut u64) = (*this).len;
    S_OK
}

unsafe extern "system" fn s_none(_: *mut Stream) -> i32 {
    E_NOTIMPL
}
