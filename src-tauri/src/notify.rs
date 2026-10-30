//! A desktop notification when a Claude session in the background needs the user, without a plugin: on
//! Windows the notification area's balloon, which Windows 10 and 11 show as a toast, and elsewhere the
//! desktop's own `notify-send`, or `gdbus` where that isn't installed. Nothing runs until there is one to show.
use tauri::WebviewWindow;

#[tauri::command(async)]
pub fn notify(window: WebviewWindow, title: String, body: String) -> Result<(), String> {
    show(&window, &title, &body)
}

#[cfg(windows)]
fn show(window: &WebviewWindow, title: &str, body: &str) -> Result<(), String> {
    use crate::sys::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Copies `text` into a fixed UTF-16 field, cut to fit with its terminating zero.
    fn put<const N: usize>(field: &mut [u16; N], text: &str) {
        let units: Vec<u16> = text.encode_utf16().take(N - 1).collect();
        field[..units.len()].copy_from_slice(&units);
    }

    // The icon stays a few seconds after its balloon shows; a newer notification keeps it for its own.
    static SHOWN: AtomicU64 = AtomicU64::new(0);
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as _;
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
fn show(_window: &WebviewWindow, title: &str, body: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let quiet = |mut c: Command| c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    let mut send = Command::new("notify-send");
    send.args(["--app-name=nook", "--", title, body]);
    let sent = quiet(send).or_else(|_| {
        let mut call = Command::new("gdbus");
        call
            .args(["call", "--session", "--dest", "org.freedesktop.Notifications"])
            .args(["--object-path", "/org/freedesktop/Notifications"])
            .args(["--method", "org.freedesktop.Notifications.Notify", "--"])
            // Typed, so the call is right even where gdbus can't look up the method's signature.
            .args(["'nook'".into(), "uint32 0".into(), "''".into(), gvariant(title), gvariant(body)])
            .args(["@as []", "@a{sv} {}", "int32 -1"]);
        quiet(call)
    });
    let mut child = sent.map_err(|_| "No notification service: install notify-send (libnotify)".to_string())?;
    child.wait().map_err(|e| e.to_string())?; // reaped here, on the command's own thread
    Ok(())
}

/// `text` as a GVariant string literal, as gdbus reads its arguments.
#[cfg(not(windows))]
fn gvariant(text: &str) -> String {
    let mut out = String::from("'");
    for c in text.chars() {
        match c {
            '\'' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

#[cfg(all(test, not(windows)))]
mod tests {
    #[test]
    fn quotes_text_for_gdbus() {
        assert_eq!(super::gvariant(r"it's a\b"), r"'it\'s a\\b'");
        assert_eq!(super::gvariant("two\nlines"), r"'two\nlines'");
    }
}
