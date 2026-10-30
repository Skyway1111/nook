//! A desktop notification when a Claude session in the background needs the user, without a plugin: on
//! Windows the notification area's balloon, which Windows 10 and 11 show as a toast, and on Linux the desktop's
//! freedesktop notification service, over D-Bus.

pub fn notify(title: String, body: String) -> Result<(), String> {
    show(&title, &body)
}

#[cfg(windows)]
fn show(title: &str, body: &str) -> Result<(), String> {
    use crate::sys::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Copies `text` into a fixed UTF-16 field, cut to fit with its terminating zero.
    fn put<const N: usize>(field: &mut [u16; N], text: &str) {
        let units: Vec<u16> = text.encode_utf16().take(N - 1).collect();
        field[..units.len()].copy_from_slice(&units);
    }

    // The icon stays a few seconds after its balloon shows; a newer notification keeps it for its own.
    static SHOWN: AtomicU64 = AtomicU64::new(0);
    let hwnd = crate::host::hwnd();
    let icon = |hwnd| NOTIFYICONDATAW { cbSize: size_of::<NOTIFYICONDATAW>() as u32, hWnd: hwnd, uID: 1, ..Default::default() };
    // SAFETY: plain Win32 calls on nook's own window.
    unsafe {
        let mut data = icon(hwnd);
        data.uFlags = NIF_ICON | NIF_TIP | NIF_INFO;
        data.hIcon = SendMessageW(hwnd, WM_GETICON, ICON_SMALL2, 0) as _;
        if data.hIcon.is_null() {
            data.hIcon = LoadIconW(std::ptr::null_mut(), IDI_APPLICATION);
        }
        data.dwInfoFlags = NIIF_INFO | NIIF_RESPECT_QUIET_TIME;
        put(&mut data.szTip, "nook");
        put(&mut data.szInfoTitle, title);
        put(&mut data.szInfo, body);
        if Shell_NotifyIconW(NIM_MODIFY, &data) == 0 && Shell_NotifyIconW(NIM_ADD, &data) == 0 {
            return Err("Windows didn't show the notification".into());
        }
        let mine = SHOWN.fetch_add(1, Ordering::SeqCst) + 1;
        let hwnd = hwnd as usize;
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(10));
            if SHOWN.load(Ordering::SeqCst) == mine {
                Shell_NotifyIconW(NIM_DELETE, &icon(hwnd as _));
            }
        });
    }
    Ok(())
}

#[cfg(not(windows))]
fn show(title: &str, body: &str) -> Result<(), String> {
    use crate::host::gtk::{bus_call, cstring, g_variant_new};
    use std::ptr::null;
    let (title, body) = (cstring(title), cstring(body));
    // Notify(app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout); a null array is empty.
    bus_call(c"org.freedesktop.Notifications", c"/org/freedesktop/Notifications", c"Notify", || unsafe {
        let none = null::<u8>();
        g_variant_new(c"(susssasa{sv}i)".as_ptr(), c"nook".as_ptr(), 0u32, c"".as_ptr(), title.as_ptr(), body.as_ptr(), none, none, -1i32)
    })
}
