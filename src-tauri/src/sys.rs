//! Every Win32 function, struct, and constant nook calls, imported straight from the system DLLs.
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals, clippy::upper_case_acronyms)]

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

// The sizes Windows checks, on x64 and arm64.
const _: () = assert!(size_of::<STARTUPINFOEXW>() == 112);
const _: () = assert!(size_of::<PROCESS_INFORMATION>() == 24);
const _: () = assert!(size_of::<WIN32_FIND_DATAW>() == 592);
const _: () = assert!(size_of::<PROCESSENTRY32W>() == 568);
const _: () = assert!(size_of::<NOTIFYICONDATAW>() == 976);
const _: () = assert!(size_of::<SHELLEXECUTEINFOW>() == 112);
const _: () = assert!(size_of::<SHFILEOPSTRUCTW>() == 56);

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
zeroed!(STARTUPINFOEXW, PROCESS_INFORMATION, WIN32_FIND_DATAW, PROCESSENTRY32W, NOTIFYICONDATAW, SHELLEXECUTEINFOW, SHFILEOPSTRUCTW);

/// `s` as Windows takes a string: UTF-16, ending in a NUL.
pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain([0]).collect()
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
}

#[link(name = "ntdll.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    pub fn RtlUpcaseUnicodeChar(c: u16) -> u16;
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
}

#[link(name = "shell32.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    pub fn Shell_NotifyIconW(message: u32, data: *const NOTIFYICONDATAW) -> BOOL;
    pub fn ShellExecuteExW(info: *mut SHELLEXECUTEINFOW) -> BOOL;
    pub fn SHFileOperationW(op: *mut SHFILEOPSTRUCTW) -> i32;
    pub fn DragQueryFileW(drop: HANDLE, index: u32, file: PWSTR, len: u32) -> u32;
}
