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
    pub fn GetFileAttributesW(p: P) -> u32;
    pub fn FindFirstFileW(p: P, d: *mut FindData) -> H;
    pub fn FindNextFileW(h: H, d: *mut FindData) -> i32;
    pub fn FindClose(h: H) -> i32;
    pub fn WideCharToMultiByte(cp: u32, flags: u32, w: P, wn: i32, b: *mut u8, bn: i32, d: *const u8, used: *mut i32) -> i32;
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
    pub fn SetDefaultDllDirectories(flags: u32) -> i32;
    pub fn LoadLibraryExW(name: P, file: H, flags: u32) -> H;
    pub fn GetProcAddress(m: H, name: *const u8) -> V;
    pub fn CreateFileMappingW(h: H, sa: V, protect: u32, hi: u32, lo: u32, name: P) -> H;
    pub fn MapViewOfFile(h: H, access: u32, hi: u32, lo: u32, n: usize) -> V;
}

// What the compiler calls to copy, fill and compare memory, from ntdll rather than a C runtime, and CRC32.
#[allow(dead_code)]
#[link(name = "ntdll", kind = "raw-dylib")]
extern "C" {
    pub fn memcpy(d: V, s: *const c_void, n: usize) -> V;
    pub fn memmove(d: V, s: *const c_void, n: usize) -> V;
    pub fn memset(d: V, c: i32, n: usize) -> V;
    pub fn memcmp(a: *const c_void, b: *const c_void, n: usize) -> i32;
    pub fn RtlComputeCrc32(crc: u32, b: *const u8, n: u32) -> u32;
}

#[link(name = "advapi32", kind = "raw-dylib")]
extern "system" {
    pub fn RegCreateKeyExW(k: H, sub: P, r: u32, class: P, opt: u32, sam: u32, sa: V, out: *mut H, disp: *mut u32) -> u32;
    pub fn RegSetValueExW(k: H, name: P, r: u32, kind: u32, data: *const u8, n: u32) -> u32;
    pub fn RegGetValueW(k: H, sub: P, name: P, flags: u32, kind: *mut u32, data: V, n: *mut u32) -> u32;
    pub fn RegDeleteTreeW(k: H, sub: P) -> u32;
    pub fn RegDeleteKeyW(k: H, sub: P) -> u32;
    pub fn RegCloseKey(k: H) -> u32;
    pub fn OpenProcessToken(p: H, access: u32, t: *mut H) -> i32;
    pub fn GetTokenInformation(t: H, class: u32, info: V, n: u32, need: *mut u32) -> i32;
}

#[link(name = "shell32", kind = "raw-dylib")]
extern "system" {
    pub fn CommandLineToArgvW(cmd: P, n: *mut i32) -> *mut *mut u16;
    pub fn SHGetKnownFolderPath(id: *const Guid, flags: u32, t: H, out: *mut *mut u16) -> i32;
    pub fn SHCreateItemFromParsingName(p: P, bc: V, iid: *const Guid, out: *mut V) -> i32;
    pub fn SHFileOperationW(op: *mut FileOp) -> i32;
    pub fn SHChangeNotify(event: i32, flags: u32, a: P, b: P);
}

#[link(name = "shlwapi", kind = "raw-dylib")]
extern "system" {
    pub fn SHCreateStreamOnFileEx(p: P, mode: u32, attributes: u32, create: i32, template: V, out: *mut V) -> i32;
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

/// Imports from DLLs outside the KnownDLLs, loaded from System32 when called. The loader looks for a
/// static import beside the exe first, and an installer's folder is Downloads.
macro_rules! system32 {
    ($dll:literal $(fn $f:ident($($a:ident: $t:ty),*) -> $r:ty;)*) => {$(
        pub unsafe fn $f($($a: $t),*) -> $r {
            let f = GetProcAddress(LoadLibraryExW(w!($dll).as_ptr(), 0, LOAD_LIBRARY_SEARCH_SYSTEM32), concat!(stringify!($f), "\0").as_ptr());
            core::mem::transmute::<V, Option<unsafe extern "system" fn($($t),*) -> $r>>(f).unwrap()($($a),*)
        }
    )*};
}

system32! { "cabinet.dll"
    fn CreateCompressor(alg: u32, alloc: V, out: *mut H) -> i32;
    fn SetCompressorInformation(h: H, class: u32, v: *const c_void, n: usize) -> i32;
    fn Compress(h: H, src: *const u8, n: usize, dst: *mut u8, cap: usize, out: *mut usize) -> i32;
    fn CreateDecompressor(alg: u32, alloc: V, out: *mut H) -> i32;
    fn Decompress(h: H, src: *const u8, n: usize, dst: *mut u8, cap: usize, out: *mut usize) -> i32;
    fn CloseCompressor(h: H) -> i32;
}

system32! { "rstrtmgr.dll"
    fn RmStartSession(h: *mut u32, flags: u32, key: *mut u16) -> u32;
    fn RmRegisterResources(h: u32, n: u32, files: *const P, na: u32, a: V, ns: u32, s: V) -> u32;
    fn RmGetList(h: u32, need: *mut u32, n: *mut u32, info: V, reasons: *mut u32) -> u32;
    fn RmShutdown(h: u32, flags: u32, cb: V) -> u32;
    fn RmEndSession(h: u32) -> u32;
}

system32! { "urlmon.dll"
    fn URLDownloadToFileW(caller: V, url: P, file: P, r: u32, cb: V) -> i32;
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

pub const GENERIC_READ: u32 = 0x8000_0000;
pub const GENERIC_WRITE: u32 = 0x4000_0000;
pub const SHARE_READ: u32 = 1;
pub const SHARE_READ_DELETE: u32 = 5;
pub const CREATE_ALWAYS: u32 = 2;
pub const OPEN_EXISTING: u32 = 3;
pub const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
pub const STD_OUTPUT: u32 = -11i32 as u32;
pub const STD_ERROR: u32 = -12i32 as u32;
pub const UTF8: u32 = 65001;
pub const KEY_SET_VALUE: u32 = 2;
pub const RRF_RT_REG_SZ: u32 = 2;
pub const REG_SZ: u32 = 1;
pub const REG_DWORD: u32 = 4;
pub const LZMS: u32 = 5;
pub const BLOCK_SIZE: u32 = 1;
pub const ERROR_MORE_DATA: u32 = 234;
pub const RM_FORCE_SHUTDOWN: u32 = 1;
pub const FO_DELETE: u32 = 3;
pub const FOF_NO_UI: u16 = 0x614;
pub const COINIT_APARTMENTTHREADED: u32 = 2;
pub const CLSCTX_INPROC_SERVER: u32 = 1;
pub const VT_LPWSTR: u16 = 31;
pub const STGM_CREATE_WRITE: u32 = 0x1001;
pub const SHCNE_CREATE: i32 = 2;
pub const SHCNF_PATHW: u32 = 5;
pub const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x800;
pub const TOKEN_QUERY: u32 = 8;
pub const TOKEN_ELEVATION: u32 = 20;
pub const PAGE_READONLY: u32 = 2;
pub const FILE_MAP_READ: u32 = 4;
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
