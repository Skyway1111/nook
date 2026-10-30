//! Files dragged in from Explorer: one OLE drop target on every window of the webview, in place of WebView2's
//! own, so a drop anywhere on the page, frames included, reaches it. The page hears `drop` events: `over` and
//! `leave`, then `drop` with the paths, in CSS pixels from the client's top left. Other drags (text, the
//! page's own) are refused.
//!
//! Most of those windows belong to WebView2's browser process. OLE finds a drop target by the window under
//! the pointer, so registering on them is what makes drops over the page work.
use super::window;
use crate::com::{call, guid, Guid, E_NOINTERFACE, IID_IUNKNOWN, S_OK};
use crate::host::ipc;
use crate::json;
use crate::sys::*;
use std::cell::Cell;
use std::ffi::c_void;
use std::ptr::null_mut;

const IID_IDROPTARGET: Guid = guid(0x00000122_0000_0000_c000_000000000046);

#[repr(C)]
#[derive(Clone, Copy, PartialEq)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
struct FormatEtc {
    format: u16,
    device: *mut c_void,
    aspect: u32,
    index: i32,
    tymed: u32,
}

const HDROP: FormatEtc = FormatEtc { format: CF_HDROP as u16, device: null_mut(), aspect: 1, index: -1, tymed: 1 };

#[repr(C)]
struct StgMedium {
    tymed: u32,
    handle: HANDLE,
    release: *mut c_void,
}

#[repr(C)]
struct Target {
    vt: &'static TargetVt,
    /// The drag over the window carries files.
    files: Cell<bool>,
    last: Cell<Point>,
}

#[repr(C)]
struct TargetVt {
    query: unsafe extern "system" fn(*mut Target, *const Guid, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut Target) -> u32,
    release: unsafe extern "system" fn(*mut Target) -> u32,
    enter: unsafe extern "system" fn(*mut Target, *mut c_void, u32, Point, *mut u32) -> i32,
    over: unsafe extern "system" fn(*mut Target, u32, Point, *mut u32) -> i32,
    leave: unsafe extern "system" fn(*mut Target) -> i32,
    drop: unsafe extern "system" fn(*mut Target, *mut c_void, u32, Point, *mut u32) -> i32,
}

static TARGET_VT: TargetVt = TargetVt { query, add_ref, release, enter, over, leave, drop };

struct TargetCell(Target);
// SAFETY: OLE calls a target on the thread that registered it, the UI thread.
unsafe impl Sync for TargetCell {}
/// One target for the app's life: it's never freed, so it counts no references.
static TARGET: TargetCell =
    TargetCell(Target { vt: &TARGET_VT, files: Cell::new(false), last: Cell::new(Point { x: -1, y: -1 }) });

fn target() -> *mut Target {
    &TARGET.0 as *const Target as *mut Target
}

/// Takes drops on every window under `hwnd`, again for any WebView2 made since.
pub fn register(hwnd: HWND) {
    unsafe { EnumChildWindows(hwnd, each, 0) };
}

unsafe extern "system" fn each(child: HWND, _: isize) -> BOOL {
    RevokeDragDrop(child);
    RegisterDragDrop(child, target().cast());
    1
}

unsafe extern "system" fn query(this: *mut Target, iid: *const Guid, out: *mut *mut c_void) -> i32 {
    let ok = *iid == IID_IUNKNOWN || *iid == IID_IDROPTARGET;
    *out = if ok { this.cast() } else { null_mut() };
    if ok {
        S_OK
    } else {
        E_NOINTERFACE
    }
}

unsafe extern "system" fn add_ref(_: *mut Target) -> u32 {
    1
}

unsafe extern "system" fn release(_: *mut Target) -> u32 {
    1
}

unsafe extern "system" fn enter(this: *mut Target, data: *mut c_void, _: u32, at: Point, effect: *mut u32) -> i32 {
    let files = call!(data, 5, &HDROP => *const FormatEtc) == S_OK;
    (*this).files.set(files);
    (*this).last.set(Point { x: -1, y: -1 });
    over(this, 0, at, effect)
}

unsafe extern "system" fn over(this: *mut Target, _: u32, at: Point, effect: *mut u32) -> i32 {
    let t = &*this;
    *effect = if t.files.get() { DROPEFFECT_COPY } else { 0 };
    if t.files.get() && t.last.replace(at) != at {
        send("over", at, "[]");
    }
    S_OK
}

unsafe extern "system" fn leave(this: *mut Target) -> i32 {
    if (*this).files.replace(false) {
        send("leave", Point { x: 0, y: 0 }, "[]");
    }
    S_OK
}

unsafe extern "system" fn drop(this: *mut Target, data: *mut c_void, _: u32, at: Point, effect: *mut u32) -> i32 {
    *effect = 0;
    if !(*this).files.replace(false) {
        return S_OK;
    }
    let mut m = StgMedium { tymed: 0, handle: null_mut(), release: null_mut() };
    if call!(data, 3, &HDROP => *const FormatEtc, &mut m => *mut StgMedium) != S_OK {
        return S_OK;
    }
    let mut paths = String::from("[");
    for i in 0..DragQueryFileW(m.handle, u32::MAX, null_mut(), 0) {
        let mut buf = vec![0u16; DragQueryFileW(m.handle, i, null_mut(), 0) as usize + 1];
        let n = DragQueryFileW(m.handle, i, buf.as_mut_ptr(), buf.len() as u32) as usize;
        if i > 0 {
            paths.push(',');
        }
        paths += &json::to_string(&String::from_utf16_lossy(&buf[..n]));
    }
    paths.push(']');
    ReleaseStgMedium(&mut m as *mut StgMedium as *mut c_void);
    *effect = DROPEFFECT_COPY;
    send("drop", at, &paths);
    S_OK
}

/// A drop event at screen point `at`, sent in CSS pixels from the client's top left.
fn send(kind: &str, at: Point, paths: &str) {
    let h = window::hwnd();
    let mut p = POINT { x: at.x, y: at.y };
    let scale = unsafe {
        ScreenToClient(h, &mut p);
        GetDpiForWindow(h) as f64 / 96.0
    };
    let (x, y) = (p.x as f64 / scale, p.y as f64 / scale);
    ipc::emit("drop", &format!(r#"{{"type":"{kind}","x":{x},"y":{y},"paths":{paths}}}"#));
}
