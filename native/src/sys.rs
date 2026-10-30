//! Every Win32 function, struct, and constant nook calls, imported straight from the system DLLs.
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals, clippy::upper_case_acronyms)]

use crate::com::Guid;
use std::ffi::{c_void, OsStr};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;

pub type BOOL = i32;
pub type HANDLE = *mut c_void;
pub type HWND = HANDLE;
pub type HKEY = HANDLE;
pub type PCWSTR = *const u16;
pub type PWSTR = *mut u16;

pub const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;
pub const INFINITE: u32 = u32::MAX;

// Processes and pseudoconsoles
pub const TH32CS_SNAPPROCESS: u32 = 0x2;
pub const PROCESS_SET_INFORMATION: u32 = 0x200;
pub const ABOVE_NORMAL_PRIORITY_CLASS: u32 = 0x8000;
pub const STARTF_USESTDHANDLES: u32 = 0x100;
pub const CREATE_UNICODE_ENVIRONMENT: u32 = 0x400;
pub const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x8_0000;
pub const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x2_0016;
pub const PSEUDOCONSOLE_INHERIT_CURSOR: u32 = 0x1;
pub const PSEUDOCONSOLE_RESIZE_QUIRK: u32 = 0x2;
pub const PSEUDOCONSOLE_WIN32_INPUT_MODE: u32 = 0x4;
pub const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x100;
pub const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x800;
pub const FindExInfoBasic: i32 = 1;
pub const FindExSearchNameMatch: i32 = 0;
pub const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;

// The registry's environment
pub const HKEY_CURRENT_USER: HKEY = 0x8000_0001u32 as i32 as isize as HKEY;
pub const HKEY_LOCAL_MACHINE: HKEY = 0x8000_0002u32 as i32 as isize as HKEY;
pub const KEY_READ: u32 = 0x2_0019;
pub const REG_SZ: u32 = 1;
pub const REG_EXPAND_SZ: u32 = 2;
pub const REG_MULTI_SZ: u32 = 7;
pub const ERROR_MORE_DATA: u32 = 234;

// Notifications
pub const NIM_ADD: u32 = 0;
pub const NIM_MODIFY: u32 = 1;
pub const NIM_DELETE: u32 = 2;
pub const NIF_ICON: u32 = 0x2;
pub const NIF_TIP: u32 = 0x4;
pub const NIF_INFO: u32 = 0x10;
pub const NIIF_INFO: u32 = 0x1;
pub const NIIF_RESPECT_QUIET_TIME: u32 = 0x80;
pub const WM_GETICON: u32 = 0x7F;
pub const ICON_SMALL2: usize = 2;
pub const IDI_APPLICATION: PCWSTR = 32512 as PCWSTR;

// The shell and its clipboard
pub const SEE_MASK_INVOKEIDLIST: u32 = 0xC;
pub const SW_SHOWNORMAL: i32 = 1;
pub const FO_MOVE: u32 = 1;
pub const FO_COPY: u32 = 2;
pub const FO_DELETE: u32 = 3;
pub const FO_RENAME: u32 = 4;
pub const FOF_RENAMEONCOLLISION: u16 = 0x8;
pub const FOF_NOCONFIRMATION: u16 = 0x10;
pub const FOF_ALLOWUNDO: u16 = 0x40;
pub const FOF_NOCONFIRMMKDIR: u16 = 0x200;
#[cfg(test)]
pub const FOF_NOERRORUI: u16 = 0x400;
pub const FOF_WANTNUKEWARNING: u16 = 0x4000;
pub const GMEM_MOVEABLE: u32 = 0x2;
pub const CF_HDROP: u32 = 15;
pub const DROPEFFECT_COPY: u32 = 1;
pub const DROPEFFECT_MOVE: u32 = 2;
pub const DROPEFFECT_LINK: u32 = 4;

// The window, its webview, and drops
pub const WM_DESTROY: u32 = 0x0002;
pub const WM_MOVE: u32 = 0x0003;
pub const WM_SIZE: u32 = 0x0005;
pub const WM_ACTIVATE: u32 = 0x0006;
pub const WM_SETFOCUS: u32 = 0x0007;
pub const WM_CLOSE: u32 = 0x0010;
pub const WM_ERASEBKGND: u32 = 0x0014;
pub const WM_GETMINMAXINFO: u32 = 0x0024;
pub const WM_SETICON: u32 = 0x0080;
pub const WM_NCCALCSIZE: u32 = 0x0083;
pub const WM_NCHITTEST: u32 = 0x0084;
pub const WM_NCLBUTTONDOWN: u32 = 0x00A1;
pub const WM_TIMER: u32 = 0x0113;
pub const WM_MOVING: u32 = 0x0216;
pub const WM_DPICHANGED: u32 = 0x02E0;
pub const WM_APP: u32 = 0x8000;
pub const HTCAPTION: isize = 2;
pub const HTTOP: isize = 12;
pub const SW_SHOW: i32 = 5;
pub const SW_MAXIMIZE: i32 = 3;
pub const SW_MINIMIZE: i32 = 6;
pub const SW_RESTORE: i32 = 9;
pub const SIZE_MINIMIZED: usize = 1;
pub const WA_INACTIVE: usize = 0;
pub const WS_CAPTION: u32 = 0x00C0_0000;
pub const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
pub const WS_SYSMENU: u32 = 0x0008_0000;
pub const WS_SIZEBOX: u32 = 0x0004_0000;
pub const WS_MAXIMIZEBOX: u32 = 0x0001_0000;
pub const WS_MINIMIZEBOX: u32 = 0x0002_0000;
pub const WS_CHILD: u32 = 0x4000_0000;
pub const WS_VISIBLE: u32 = 0x1000_0000;
pub const WS_EX_WINDOWEDGE: u32 = 0x100;
pub const WS_EX_ACCEPTFILES: u32 = 0x10;
pub const WS_EX_APPWINDOW: u32 = 0x40000;
pub const CW_USEDEFAULT: i32 = 0x8000_0000_u32 as i32;
pub const SWP_NOSIZE: u32 = 0x1;
pub const SWP_NOMOVE: u32 = 0x2;
pub const SWP_NOZORDER: u32 = 0x4;
pub const SWP_NOACTIVATE: u32 = 0x10;
pub const SWP_FRAMECHANGED: u32 = 0x20;
pub const SM_CXSIZEFRAME: i32 = 32;
pub const SM_CYFRAME: i32 = 33;
pub const SM_CXICON: i32 = 11;
pub const SM_CXSMICON: i32 = 49;
pub const SM_CXPADDEDBORDER: i32 = 92;
pub const MONITOR_DEFAULTTONULL: u32 = 0;
pub const MONITOR_DEFAULTTONEAREST: u32 = 2;
pub const ABM_GETAUTOHIDEBAR: u32 = 7;
pub const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: HANDLE = -4isize as HANDLE;
pub const FLASHW_TRAY: u32 = 2;
pub const IDC_ARROW: PCWSTR = 32512 as PCWSTR;
pub const IMAGE_ICON: u32 = 1;
pub const MB_ICONERROR: u32 = 0x10;
pub const RRF_RT_REG_SZ: u32 = 0x2;

#[repr(C)]
pub struct COORD {
    pub X: i16,
    pub Y: i16,
}

#[repr(C)]
pub struct STARTUPINFOEXW {
    pub cb: u32,
    pub lpReserved: PWSTR,
    pub lpDesktop: PWSTR,
    pub lpTitle: PWSTR,
    pub dwX: u32,
    pub dwY: u32,
    pub dwXSize: u32,
    pub dwYSize: u32,
    pub dwXCountChars: u32,
    pub dwYCountChars: u32,
    pub dwFillAttribute: u32,
    pub dwFlags: u32,
    pub wShowWindow: u16,
    pub cbReserved2: u16,
    pub lpReserved2: *mut u8,
    pub hStdInput: HANDLE,
    pub hStdOutput: HANDLE,
    pub hStdError: HANDLE,
    pub lpAttributeList: *mut c_void,
}

#[repr(C)]
pub struct PROCESS_INFORMATION {
    pub hProcess: HANDLE,
    pub hThread: HANDLE,
    pub dwProcessId: u32,
    pub dwThreadId: u32,
}

#[repr(C)]
pub struct WIN32_FIND_DATAW {
    pub dwFileAttributes: u32,
    pub times_and_size: [u32; 10], // three FILETIMEs, the size, two reserved
    pub cFileName: [u16; 260],
    pub cAlternateFileName: [u16; 14],
}

#[repr(C)]
pub struct PROCESSENTRY32W {
    pub dwSize: u32,
    pub cntUsage: u32,
    pub th32ProcessID: u32,
    pub th32DefaultHeapID: usize,
    pub th32ModuleID: u32,
    pub cntThreads: u32,
    pub th32ParentProcessID: u32,
    pub pcPriClassBase: i32,
    pub dwFlags: u32,
    pub szExeFile: [u16; 260],
}

#[repr(C)]
pub struct NOTIFYICONDATAW {
    pub cbSize: u32,
    pub hWnd: HWND,
    pub uID: u32,
    pub uFlags: u32,
    pub uCallbackMessage: u32,
    pub hIcon: HANDLE,
    pub szTip: [u16; 128],
    pub dwState: u32,
    pub dwStateMask: u32,
    pub szInfo: [u16; 256],
    pub uVersion: u32,
    pub szInfoTitle: [u16; 64],
    pub dwInfoFlags: u32,
    pub guidItem: [u32; 4],
    pub hBalloonIcon: HANDLE,
}

#[repr(C)]
pub struct SHELLEXECUTEINFOW {
    pub cbSize: u32,
    pub fMask: u32,
    pub hwnd: HWND,
    pub lpVerb: PCWSTR,
    pub lpFile: PCWSTR,
    pub lpParameters: PCWSTR,
    pub lpDirectory: PCWSTR,
    pub nShow: i32,
    pub hInstApp: HANDLE,
    pub lpIDList: *mut c_void,
    pub lpClass: PCWSTR,
    pub hkeyClass: HKEY,
    pub dwHotKey: u32,
    pub hIcon: HANDLE,
    pub hProcess: HANDLE,
}

#[repr(C)]
pub struct SHFILEOPSTRUCTW {
    pub hwnd: HWND,
    pub wFunc: u32,
    pub pFrom: PCWSTR,
    pub pTo: PCWSTR,
    pub fFlags: u16,
    pub fAnyOperationsAborted: BOOL,
    pub hNameMappings: *mut c_void,
    pub lpszProgressTitle: PCWSTR,
}

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct RECT {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq)]
pub struct POINT {
    pub x: i32,
    pub y: i32,
}

#[repr(C)]
pub struct MSG {
    pub hwnd: HWND,
    pub message: u32,
    pub wParam: usize,
    pub lParam: isize,
    pub time: u32,
    pub pt: POINT,
    pub lPrivate: u32,
}

pub type WNDPROC = unsafe extern "system" fn(HWND, u32, usize, isize) -> isize;

#[repr(C)]
pub struct WNDCLASSEXW {
    pub cbSize: u32,
    pub style: u32,
    pub lpfnWndProc: WNDPROC,
    pub cbClsExtra: i32,
    pub cbWndExtra: i32,
    pub hInstance: HANDLE,
    pub hIcon: HANDLE,
    pub hCursor: HANDLE,
    pub hbrBackground: HANDLE,
    pub lpszMenuName: PCWSTR,
    pub lpszClassName: PCWSTR,
    pub hIconSm: HANDLE,
}

#[repr(C)]
pub struct NCCALCSIZE_PARAMS {
    pub rgrc: [RECT; 3],
    pub lppos: *mut c_void,
}

#[repr(C)]
pub struct MINMAXINFO {
    pub ptReserved: POINT,
    pub ptMaxSize: POINT,
    pub ptMaxPosition: POINT,
    pub ptMinTrackSize: POINT,
    pub ptMaxTrackSize: POINT,
}

#[repr(C)]
pub struct MONITORINFO {
    pub cbSize: u32,
    pub rcMonitor: RECT,
    pub rcWork: RECT,
    pub dwFlags: u32,
}

#[repr(C)]
pub struct APPBARDATA {
    pub cbSize: u32,
    pub hWnd: HWND,
    pub uCallbackMessage: u32,
    pub uEdge: u32,
    pub rc: RECT,
    pub lParam: isize,
}

#[repr(C)]
pub struct FLASHWINFO {
    pub cbSize: u32,
    pub hwnd: HWND,
    pub dwFlags: u32,
    pub uCount: u32,
    pub dwTimeout: u32,
}

#[repr(C)]
pub struct OSVERSIONINFOW {
    pub dwOSVersionInfoSize: u32,
    pub dwMajorVersion: u32,
    pub dwMinorVersion: u32,
    pub dwBuildNumber: u32,
    pub dwPlatformId: u32,
    pub szCSDVersion: [u16; 128],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct WINDOWPLACEMENT {
    pub length: u32,
    pub flags: u32,
    pub showCmd: u32,
    pub ptMinPosition: POINT,
    pub ptMaxPosition: POINT,
    pub rcNormalPosition: RECT,
}

// The sizes Windows checks, on x64 and arm64.
const _: () = assert!(size_of::<STARTUPINFOEXW>() == 112);
const _: () = assert!(size_of::<PROCESS_INFORMATION>() == 24);
const _: () = assert!(size_of::<WIN32_FIND_DATAW>() == 592);
const _: () = assert!(size_of::<PROCESSENTRY32W>() == 568);
const _: () = assert!(size_of::<NOTIFYICONDATAW>() == 976);
const _: () = assert!(size_of::<SHELLEXECUTEINFOW>() == 112);
const _: () = assert!(size_of::<SHFILEOPSTRUCTW>() == 56);
const _: () = assert!(size_of::<MSG>() == 48);
const _: () = assert!(size_of::<WNDCLASSEXW>() == 80);
const _: () = assert!(size_of::<APPBARDATA>() == 48);
const _: () = assert!(size_of::<FLASHWINFO>() == 32);
const _: () = assert!(size_of::<OSVERSIONINFOW>() == 276);
const _: () = assert!(size_of::<WINDOWPLACEMENT>() == 44);

/// Each struct starts all zeros: null pointers, no flags.
macro_rules! zeroed {
    ($($t:ty),*) => {$(
        impl Default for $t {
            fn default() -> Self {
                // SAFETY: plain C data, for which all zeros is a valid value.
                unsafe { std::mem::zeroed() }
            }
        }
    )*};
}
zeroed!(
    STARTUPINFOEXW, PROCESS_INFORMATION, WIN32_FIND_DATAW, PROCESSENTRY32W, NOTIFYICONDATAW, SHELLEXECUTEINFOW, SHFILEOPSTRUCTW,
    MSG, MONITORINFO, APPBARDATA, OSVERSIONINFOW, WINDOWPLACEMENT
);

/// `s` as Windows takes a string: UTF-16, ending in a NUL.
pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    let s = s.as_ref();
    let mut w = Vec::with_capacity(s.len() + 1); // never more units than UTF-8 has bytes
    w.extend(s.encode_wide());
    w.push(0);
    w
}

#[link(name = "kernel32.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    pub fn CloseHandle(handle: HANDLE) -> BOOL;
    pub fn GetCurrentProcessId() -> u32;
    pub fn OpenProcess(access: u32, inherit: BOOL, pid: u32) -> HANDLE;
    pub fn SetPriorityClass(process: HANDLE, class: u32) -> BOOL;
    pub fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> HANDLE;
    pub fn Process32FirstW(snapshot: HANDLE, entry: *mut PROCESSENTRY32W) -> BOOL;
    pub fn Process32NextW(snapshot: HANDLE, entry: *mut PROCESSENTRY32W) -> BOOL;
    pub fn GlobalAlloc(flags: u32, bytes: usize) -> HANDLE;
    pub fn GlobalLock(mem: HANDLE) -> *mut c_void;
    pub fn GlobalUnlock(mem: HANDLE) -> BOOL;
    pub fn GlobalFree(mem: HANDLE) -> HANDLE;
    pub fn CreatePipe(read: *mut HANDLE, write: *mut HANDLE, attributes: *const c_void, size: u32) -> BOOL;
    pub fn CreatePseudoConsole(size: COORD, input: HANDLE, output: HANDLE, flags: u32, console: *mut HANDLE) -> i32;
    pub fn ResizePseudoConsole(console: HANDLE, size: COORD) -> i32;
    pub fn ClosePseudoConsole(console: HANDLE);
    pub fn InitializeProcThreadAttributeList(list: *mut c_void, count: u32, flags: u32, size: *mut usize) -> BOOL;
    pub fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *const c_void,
        size: usize,
        previous: *mut c_void,
        returned: *const usize,
    ) -> BOOL;
    pub fn DeleteProcThreadAttributeList(list: *mut c_void);
    pub fn CreateProcessW(
        application: PCWSTR,
        command_line: PWSTR,
        process_attributes: *const c_void,
        thread_attributes: *const c_void,
        inherit: BOOL,
        flags: u32,
        environment: *const c_void,
        directory: PCWSTR,
        startup: *const STARTUPINFOEXW,
        info: *mut PROCESS_INFORMATION,
    ) -> BOOL;
    pub fn WaitForSingleObject(handle: HANDLE, ms: u32) -> u32;
    pub fn LoadLibraryExW(file: PCWSTR, reserved: HANDLE, flags: u32) -> HANDLE;
    pub fn GetProcAddress(module: HANDLE, name: *const u8) -> *const c_void;
    pub fn ExpandEnvironmentStringsW(source: PCWSTR, out: PWSTR, size: u32) -> u32;
    pub fn FindFirstFileExW(name: PCWSTR, level: i32, data: *mut WIN32_FIND_DATAW, op: i32, filter: *const c_void, flags: u32) -> HANDLE;
    pub fn FindNextFileW(find: HANDLE, data: *mut WIN32_FIND_DATAW) -> BOOL;
    pub fn FindClose(find: HANDLE) -> BOOL;
    pub fn GetModuleHandleW(name: PCWSTR) -> HANDLE;
    pub fn GetUserDefaultUILanguage() -> u16;
    pub fn LCIDToLocaleName(lcid: u32, name: PWSTR, len: i32, flags: u32) -> i32;
}

#[link(name = "ntdll.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    pub fn RtlUpcaseUnicodeChar(c: u16) -> u16;
    pub fn RtlGetVersion(v: *mut OSVERSIONINFOW) -> i32;
}

#[link(name = "advapi32.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    pub fn RegOpenKeyExW(key: HKEY, subkey: PCWSTR, options: u32, access: u32, out: *mut HKEY) -> u32;
    pub fn RegEnumValueW(
        key: HKEY,
        index: u32,
        name: PWSTR,
        name_len: *mut u32,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        data_len: *mut u32,
    ) -> u32;
    pub fn RegCloseKey(key: HKEY) -> u32;
    pub fn RegGetValueW(key: HKEY, sub: PCWSTR, value: PCWSTR, flags: u32, kind: *mut u32, data: *mut c_void, len: *mut u32) -> u32;
}

#[link(name = "user32.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    pub fn SendMessageW(hwnd: HWND, msg: u32, wparam: usize, lparam: isize) -> isize;
    pub fn LoadIconW(instance: HANDLE, name: PCWSTR) -> HANDLE;
    pub fn OpenClipboard(owner: HWND) -> BOOL;
    pub fn CloseClipboard() -> BOOL;
    pub fn EmptyClipboard() -> BOOL;
    pub fn GetClipboardData(format: u32) -> HANDLE;
    pub fn SetClipboardData(format: u32, mem: HANDLE) -> HANDLE;
    pub fn IsClipboardFormatAvailable(format: u32) -> BOOL;
    pub fn RegisterClipboardFormatW(name: PCWSTR) -> u32;
    pub fn GetClipboardSequenceNumber() -> u32;
    pub fn RegisterClassExW(class: *const WNDCLASSEXW) -> u16;
    pub fn CreateWindowExW(
        ex: u32,
        class: PCWSTR,
        name: PCWSTR,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: HWND,
        menu: HANDLE,
        instance: HANDLE,
        param: *mut c_void,
    ) -> HWND;
    pub fn DefWindowProcW(hwnd: HWND, msg: u32, wparam: usize, lparam: isize) -> isize;
    pub fn DestroyWindow(hwnd: HWND) -> BOOL;
    pub fn ShowWindow(hwnd: HWND, cmd: i32) -> BOOL;
    pub fn GetMessageW(msg: *mut MSG, hwnd: HWND, min: u32, max: u32) -> BOOL;
    pub fn TranslateMessage(msg: *const MSG) -> BOOL;
    pub fn DispatchMessageW(msg: *const MSG) -> isize;
    pub fn PostMessageW(hwnd: HWND, msg: u32, wparam: usize, lparam: isize) -> BOOL;
    pub fn PostQuitMessage(code: i32);
    pub fn SetWindowPos(hwnd: HWND, after: HWND, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> BOOL;
    pub fn GetClientRect(hwnd: HWND, rect: *mut RECT) -> BOOL;
    pub fn ScreenToClient(hwnd: HWND, point: *mut POINT) -> BOOL;
    pub fn SetWindowTextW(hwnd: HWND, text: PCWSTR) -> BOOL;
    pub fn LoadCursorW(instance: HANDLE, name: PCWSTR) -> HANDLE;
    pub fn LoadImageW(instance: HANDLE, name: PCWSTR, kind: u32, cx: i32, cy: i32, flags: u32) -> HANDLE;
    pub fn SetTimer(hwnd: HWND, id: usize, ms: u32, f: *const c_void) -> usize;
    pub fn KillTimer(hwnd: HWND, id: usize) -> BOOL;
    pub fn FillRect(dc: HANDLE, rect: *const RECT, brush: HANDLE) -> i32;
    pub fn GetSystemMetricsForDpi(index: i32, dpi: u32) -> i32;
    pub fn GetDpiForWindow(hwnd: HWND) -> u32;
    pub fn SetProcessDpiAwarenessContext(context: HANDLE) -> BOOL;
    pub fn MonitorFromRect(rect: *const RECT, flags: u32) -> HANDLE;
    pub fn MonitorFromWindow(hwnd: HWND, flags: u32) -> HANDLE;
    pub fn GetMonitorInfoW(monitor: HANDLE, info: *mut MONITORINFO) -> BOOL;
    pub fn IsZoomed(hwnd: HWND) -> BOOL;
    pub fn IsIconic(hwnd: HWND) -> BOOL;
    pub fn GetForegroundWindow() -> HWND;
    pub fn GetFocus() -> HWND;
    pub fn GetCursorPos(point: *mut POINT) -> BOOL;
    pub fn ReleaseCapture() -> BOOL;
    pub fn FlashWindowEx(info: *const FLASHWINFO) -> BOOL;
    pub fn InvalidateRect(hwnd: HWND, rect: *const RECT, erase: BOOL) -> BOOL;
    pub fn UpdateWindow(hwnd: HWND) -> BOOL;
    pub fn MessageBoxW(hwnd: HWND, text: PCWSTR, caption: PCWSTR, kind: u32) -> i32;
    pub fn GetWindowPlacement(hwnd: HWND, placement: *mut WINDOWPLACEMENT) -> BOOL;
    pub fn SetWindowPlacement(hwnd: HWND, placement: *const WINDOWPLACEMENT) -> BOOL;
    pub fn EnumChildWindows(hwnd: HWND, f: unsafe extern "system" fn(HWND, isize) -> BOOL, lparam: isize) -> BOOL;
}

#[link(name = "gdi32.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    pub fn CreateSolidBrush(color: u32) -> HANDLE;
    pub fn DeleteObject(object: HANDLE) -> BOOL;
}

#[link(name = "ole32.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    pub fn OleInitialize(reserved: *mut c_void) -> i32;
    pub fn CoTaskMemAlloc(bytes: usize) -> *mut c_void;
    pub fn CoTaskMemFree(p: *mut c_void);
    pub fn RegisterDragDrop(hwnd: HWND, target: *mut c_void) -> i32;
    pub fn RevokeDragDrop(hwnd: HWND) -> i32;
    pub fn ReleaseStgMedium(medium: *mut c_void);
}

#[link(name = "shell32.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    pub fn Shell_NotifyIconW(message: u32, data: *const NOTIFYICONDATAW) -> BOOL;
    pub fn ShellExecuteExW(info: *mut SHELLEXECUTEINFOW) -> BOOL;
    pub fn SHFileOperationW(op: *mut SHFILEOPSTRUCTW) -> i32;
    pub fn DragQueryFileW(drop: HANDLE, index: u32, file: PWSTR, len: u32) -> u32;
    pub fn SHAppBarMessage(msg: u32, data: *mut APPBARDATA) -> usize;
    pub fn SHGetKnownFolderPath(id: *const Guid, flags: u32, token: HANDLE, path: *mut PWSTR) -> i32;
}

#[link(name = "combase.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    pub fn CoIncrementMTAUsage(cookie: *mut HANDLE) -> i32;
    pub fn CoCreateInstance(class: *const Guid, outer: HANDLE, context: u32, iid: *const Guid, out: *mut HANDLE) -> i32;
    pub fn WindowsCreateStringReference(s: PCWSTR, len: u32, header: *mut [u64; 3], out: *mut HANDLE) -> i32;
    pub fn RoGetActivationFactory(class: HANDLE, iid: *const Guid, out: *mut HANDLE) -> i32;
}

#[link(name = "shcore.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    pub fn CreateRandomAccessStreamOnFile(path: PCWSTR, mode: u32, iid: *const Guid, out: *mut HANDLE) -> i32;
    pub fn SHCreateMemStream(init: *const u8, len: u32) -> HANDLE;
}
