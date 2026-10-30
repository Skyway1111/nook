//! The window GetConsoleWindow names: hidden, one per console, made on nook's UI thread and owned by its window, as
//! OpenConsole's PseudoConsoleWindow. Programs (MSYS's runtime among them) take a console without one for none.
use crate::sys::*;
use std::{
    ptr::{null, null_mut},
    sync::{mpsc::sync_channel, OnceLock},
    time::Duration,
};

/// A new hidden window, or null if the UI thread doesn't make one within 2 s.
pub fn create() -> HWND {
    let (tx, rx) = sync_channel(1);
    let posted = crate::host::post(move || {
        static CLASS: OnceLock<usize> = OnceLock::new();
        let class = *CLASS.get_or_init(|| {
            let name = wide("PseudoConsoleWindow");
            let class = WNDCLASSEXW {
                cbSize: size_of::<WNDCLASSEXW>() as u32,
                style: 0,
                lpfnWndProc: DefWindowProcW,
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: null_mut(),
                hIcon: null_mut(),
                hCursor: null_mut(),
                hbrBackground: null_mut(),
                lpszMenuName: null(),
                lpszClassName: name.as_ptr(),
                hIconSm: null_mut(),
            };
            unsafe { RegisterClassExW(&class) as usize }
        });
        let ex = WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_NOREDIRECTIONBITMAP;
        let owner = crate::host::hwnd();
        let h = unsafe { CreateWindowExW(ex, class as PCWSTR, null(), WS_POPUP, 0, 0, 0, 0, owner, null_mut(), null_mut(), null_mut()) };
        let _ = tx.send(h as usize);
    });
    if !posted {
        return null_mut();
    }
    rx.recv_timeout(Duration::from_secs(2)).map_or(null_mut(), |h| h as HWND)
}

pub fn destroy(h: HWND) {
    if !h.is_null() {
        unsafe { PostMessageW(h, WM_CLOSE, 0, 0) };
    }
}
