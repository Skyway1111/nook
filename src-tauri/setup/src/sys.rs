//! The Win32 calls setup makes, the heap, and the process entry.
#![allow(non_snake_case, clippy::upper_case_acronyms)]

use core::ffi::c_void;

pub type H = isize;
pub type P = *const u16;
pub type V = *mut c_void;

#[repr(C)]
pub struct Guid(pub u32, pub u16, pub u16, pub [u8; 8]);

/// A GUID written as one hex number, `0x00021401_0000_0000_C000_000000000046`.
pub const fn guid(v: u128) -> Guid {
    Guid((v >> 96) as u32, (v >> 80) as u16, (v >> 64) as u16, (v as u64).to_be_bytes())
}

#[repr(C)]
pub struct StartupInfo {
    pub cb: u32,
    _r: [usize; 12],
}
pub const STARTUP: StartupInfo = StartupInfo { cb: core::mem::size_of::<StartupInfo>() as u32, _r: [0; 12] };

#[repr(C)]
#[derive(Default)]
pub struct ProcessInfo {
    pub process: H,
    pub thread: H,
    pub ids: [u32; 2],
}

#[repr(C)]
pub struct FindData {
    pub attributes: u32,
    _times: [u32; 6],
    _size: [u32; 2],
    _r: [u32; 2],
    pub name: [u16; 260],
    _alt: [u16; 14],
}

#[link(name = "kernel32", kind = "raw-dylib")]
extern "system" {
    pub fn GetCommandLineW() -> P;
    pub fn GetModuleHandleW(name: P) -> H;
    pub fn GetStdHandle(which: u32) -> H;
    pub fn GetModuleFileNameW(m: H, buf: *mut u16, n: u32) -> u32;
    pub fn GetTempPathW(n: u32, buf: *mut u16) -> u32;
    pub fn CreateFileW(p: P, access: u32, share: u32, sa: V, disp: u32, flags: u32, t: H) -> H;
    pub fn ReadFile(h: H, b: *mut u8, n: u32, read: *mut u32, o: V) -> i32;
    pub fn WriteFile(h: H, b: *const u8, n: u32, wrote: *mut u32, o: V) -> i32;
    pub fn GetFileSizeEx(h: H, size: *mut i64) -> i32;
    pub fn CloseHandle(h: H) -> i32;
    pub fn CreateDirectoryW(p: P, sa: V) -> i32;
    pub fn RemoveDirectoryW(p: P) -> i32;
    pub fn DeleteFileW(p: P) -> i32;
    pub fn FindFirstFileW(p: P, d: *mut FindData) -> H;
    pub fn FindNextFileW(h: H, d: *mut FindData) -> i32;
    pub fn FindClose(h: H) -> i32;
    pub fn CompareStringOrdinal(a: P, an: i32, b: P, bn: i32, ignore_case: i32) -> i32;
    pub fn CreateProcessW(app: P, cmd: *mut u16, pa: V, ta: V, inherit: i32, flags: u32, env: V, dir: P, si: *const StartupInfo, pi: *mut ProcessInfo) -> i32;
    pub fn WaitForSingleObject(h: H, ms: u32) -> u32;
    pub fn GetExitCodeProcess(h: H, code: *mut u32) -> i32;
    pub fn CreateThread(sa: V, stack: usize, f: unsafe extern "system" fn(V) -> u32, arg: V, flags: u32, id: *mut u32) -> H;
    pub fn GetLastError() -> u32;
    pub fn GetProcessHeap() -> H;
    pub fn HeapAlloc(h: H, flags: u32, n: usize) -> V;
    pub fn HeapReAlloc(h: H, flags: u32, p: V, n: usize) -> V;
    pub fn HeapFree(h: H, flags: u32, p: V) -> i32;
    pub fn Sleep(ms: u32);
    pub fn ExitProcess(code: u32) -> !;
}

#[link(name = "advapi32", kind = "raw-dylib")]
extern "system" {
    pub fn RegCreateKeyExW(k: H, sub: P, r: u32, class: P, opt: u32, sam: u32, sa: V, out: *mut H, disp: *mut u32) -> u32;
    pub fn RegSetValueExW(k: H, name: P, r: u32, kind: u32, data: *const u8, n: u32) -> u32;
    pub fn RegGetValueW(k: H, sub: P, name: P, flags: u32, kind: *mut u32, data: V, n: *mut u32) -> u32;
    pub fn RegDeleteTreeW(k: H, sub: P) -> u32;
    pub fn RegDeleteKeyW(k: H, sub: P) -> u32;
    pub fn RegCloseKey(k: H) -> u32;
}

#[link(name = "shell32", kind = "raw-dylib")]
extern "system" {
    pub fn CommandLineToArgvW(cmd: P, n: *mut i32) -> *mut *mut u16;
    pub fn SHGetKnownFolderPath(id: *const Guid, flags: u32, t: H, out: *mut *mut u16) -> i32;
    pub fn SHCreateItemFromParsingName(p: P, bc: V, iid: *const Guid, out: *mut V) -> i32;
    pub fn SHFileOperationW(op: *mut FileOp) -> i32;
}

#[repr(C)]
pub struct FileOp {
    pub hwnd: H,
    pub func: u32,
    pub from: P,
    pub to: P,
    pub flags: u16,
    pub aborted: i32,
    pub mappings: V,
    pub title: P,
}

#[link(name = "ole32", kind = "raw-dylib")]
extern "system" {
    pub fn CoInitializeEx(r: V, model: u32) -> i32;
    pub fn CoCreateInstance(clsid: *const Guid, outer: V, ctx: u32, iid: *const Guid, out: *mut V) -> i32;
    pub fn CoTaskMemFree(p: V);
}

#[link(name = "user32", kind = "raw-dylib")]
extern "system" {
    pub fn SendMessageW(w: H, msg: u32, wp: usize, lp: isize) -> isize;
    pub fn PostMessageW(w: H, msg: u32, wp: usize, lp: isize) -> i32;
}

#[link(name = "comctl32", kind = "raw-dylib")]
extern "system" {
    pub fn TaskDialogIndirect(c: *const TaskDialog, button: *mut i32, radio: *mut i32, checked: *mut i32) -> i32;
}

#[link(name = "cabinet", kind = "raw-dylib")]
extern "system" {
    pub fn CreateCompressor(alg: u32, alloc: V, out: *mut H) -> i32;
    pub fn SetCompressorInformation(h: H, class: u32, v: *const c_void, n: usize) -> i32;
    pub fn Compress(h: H, src: *const u8, n: usize, dst: *mut u8, cap: usize, out: *mut usize) -> i32;
    pub fn CreateDecompressor(alg: u32, alloc: V, out: *mut H) -> i32;
    pub fn Decompress(h: H, src: *const u8, n: usize, dst: *mut u8, cap: usize, out: *mut usize) -> i32;
}

#[link(name = "rstrtmgr", kind = "raw-dylib")]
extern "system" {
    pub fn RmStartSession(h: *mut u32, flags: u32, key: *mut u16) -> u32;
    pub fn RmRegisterResources(h: u32, n: u32, files: *const P, na: u32, a: V, ns: u32, s: V) -> u32;
    pub fn RmGetList(h: u32, need: *mut u32, n: *mut u32, info: V, reasons: *mut u32) -> u32;
    pub fn RmShutdown(h: u32, flags: u32, cb: V) -> u32;
    pub fn RmEndSession(h: u32) -> u32;
}

#[link(name = "urlmon", kind = "raw-dylib")]
extern "system" {
    pub fn URLDownloadToFileW(caller: V, url: P, file: P, r: u32, cb: V) -> i32;
}

/// TASKDIALOGCONFIG, which commctrl.h packs to 1 byte.
#[repr(C, packed(1))]
pub struct TaskDialog {
    pub size: u32,
    pub parent: H,
    pub instance: H,
    pub flags: u32,
    pub common: u32,
    pub title: P,
    pub icon: P,
    pub heading: P,
    pub content: P,
    pub buttons: u32,
    pub button: *const Button,
    pub default: i32,
    pub radios: u32,
    pub radio: *const Button,
    pub default_radio: i32,
    pub check: P,
    pub expanded: P,
    pub expand: P,
    pub collapse: P,
    pub footer_icon: P,
    pub footer: P,
    pub callback: Option<unsafe extern "system" fn(H, u32, usize, isize, isize) -> i32>,
    pub data: isize,
    pub width: u32,
}

#[repr(C, packed(1))]
pub struct Button(pub i32, pub P);

pub const HKCU: H = 0x8000_0001u32 as i32 as H;
pub const HKLM: H = 0x8000_0002u32 as i32 as H;
pub const INVALID: H = -1;

struct Heap;

unsafe impl core::alloc::GlobalAlloc for Heap {
    unsafe fn alloc(&self, l: core::alloc::Layout) -> *mut u8 {
        HeapAlloc(GetProcessHeap(), 0, l.size()) as *mut u8
    }
    unsafe fn dealloc(&self, p: *mut u8, _: core::alloc::Layout) {
        HeapFree(GetProcessHeap(), 0, p as V);
    }
    unsafe fn realloc(&self, p: *mut u8, _: core::alloc::Layout, n: usize) -> *mut u8 {
        HeapReAlloc(GetProcessHeap(), 0, p as V, n) as *mut u8
    }
}

/// The process heap hands out 16-byte aligned blocks, all any type here needs.
#[global_allocator]
static HEAP: Heap = Heap;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unsafe { ExitProcess(3) }
}
