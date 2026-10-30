//! The top-level window, frameless: the system's shadow and side and bottom resize edges come from a non-client
//! inset, and a strip of child window over the webview resizes from the top.
//! It also runs the UI thread's message loop, which every other thread reaches through `post`.
use super::webview;
use crate::host::{ipc, Config};
use crate::sys::*;
use std::cell::Cell;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicIsize, AtomicPtr, Ordering};

/// A boxed `FnOnce` to run on the UI thread, in lParam.
const WM_RUN: u32 = WM_APP;
const SHOW_TIMER: usize = 1;

/// The window, for any thread to post to. Zero once it's destroyed, so a late post is dropped.
static HWND_: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(null_mut());

/// State only the UI thread touches.
struct Ui {
    strip: Cell<HWND>,
    brush: Cell<HANDLE>,
    min: Cell<(i32, i32)>,
    maximized: Cell<bool>,
    active: Cell<bool>,
    shown: Cell<bool>,
    /// Where the window was before the page went fullscreen, while it is.
    fullscreen: Cell<Option<WINDOWPLACEMENT>>,
}

struct UiCell(Ui);
// SAFETY: only the UI thread reads or writes it.
unsafe impl Sync for UiCell {}
static UI: UiCell = UiCell(Ui {
    strip: Cell::new(null_mut()),
    brush: Cell::new(null_mut()),
    min: Cell::new((0, 0)),
    maximized: Cell::new(false),
    active: Cell::new(false),
    shown: Cell::new(false),
    fullscreen: Cell::new(None),
});

fn ui() -> &'static Ui {
    &UI.0
}

pub fn hwnd() -> HWND {
    HWND_.load(Ordering::Relaxed)
}

/// Creates the window, hidden until the page loads or 3 s pass.
pub fn create(cfg: &Config) -> HWND {
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let inst = GetModuleHandleW(null());
        let class = wide("nook");
        RegisterClassExW(&WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: proc_,
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: inst,
            hIcon: null_mut(),
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            hbrBackground: null_mut(),
            lpszMenuName: null(),
            lpszClassName: class.as_ptr(),
            hIconSm: null_mut(),
        });
        let strip_class = wide("nook-edge");
        RegisterClassExW(&WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: strip_proc,
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: inst,
            hIcon: null_mut(),
            hCursor: null_mut(),
            hbrBackground: null_mut(),
            lpszMenuName: null(),
            lpszClassName: strip_class.as_ptr(),
            hIconSm: null_mut(),
        });
        set_background(cfg.background);
        ui().min.set(cfg.min);
        let style = WS_CAPTION | WS_CLIPSIBLINGS | WS_SYSMENU | WS_SIZEBOX | WS_MAXIMIZEBOX | WS_MINIMIZEBOX;
        let h = CreateWindowExW(
            WS_EX_WINDOWEDGE | WS_EX_ACCEPTFILES | WS_EX_APPWINDOW,
            class.as_ptr(),
            wide(cfg.title).as_ptr(),
            style,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            null_mut(),
            null_mut(),
            inst,
            null_mut(),
        );
        HWND_.store(h, Ordering::Relaxed);
        // Sized for the monitor it opened on, and SWP_FRAMECHANGED applies the frameless WM_NCCALCSIZE.
        let dpi = GetDpiForWindow(h);
        let i = insets(dpi);
        let (w, ht) = (scale(cfg.size.0, dpi) + i.left + i.right, scale(cfg.size.1, dpi) + i.top + i.bottom);
        SetWindowPos(h, null_mut(), 0, 0, w, ht, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        for (which, metric) in [(1, SM_CXICON), (0, SM_CXSMICON)] {
            let px = GetSystemMetricsForDpi(metric, dpi);
            let icon = LoadImageW(inst, 32512 as PCWSTR, IMAGE_ICON, px, px, 0);
            if !icon.is_null() {
                SendMessageW(h, WM_SETICON, which, icon as isize);
            }
        }
        SetTimer(h, SHOW_TIMER, 3000, null());
        h
    }
}

/// Runs the message loop until the window is destroyed.
pub fn run() {
    let mut msg: MSG = unsafe { std::mem::zeroed() };
    while unsafe { GetMessageW(&mut msg, null_mut(), 0, 0) } > 0 {
        unsafe {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Runs `f` on the UI thread, and says whether it will: it's dropped if the window is gone or its queue is full.
pub fn post(f: impl FnOnce() + Send + 'static) -> bool {
    let f: *mut Box<dyn FnOnce()> = Box::into_raw(Box::new(Box::new(f)));
    let posted = unsafe { PostMessageW(hwnd(), WM_RUN, 0, f as isize) } != 0;
    if !posted {
        drop(unsafe { Box::from_raw(f) });
    }
    posted
}

/// Shows the window, once.
pub fn show() {
    if !ui().shown.replace(true) {
        unsafe {
            KillTimer(hwnd(), SHOW_TIMER);
            ShowWindow(hwnd(), SW_SHOW);
        }
    }
}

/// The strip goes over the webview's own window, so it's made once the webview has one.
pub fn webview_ready() {
    let strip = unsafe {
        CreateWindowExW(
            0,
            wide("nook-edge").as_ptr(),
            null(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            hwnd(),
            null_mut(),
            GetModuleHandleW(null()),
            null_mut(),
        )
    };
    ui().strip.set(strip);
    let mut r = RECT::default();
    unsafe { GetClientRect(hwnd(), &mut r) };
    resized(r.right, r.bottom);
}

/// The color the window paints where the page hasn't yet.
pub fn set_background([r, g, b]: [u8; 3]) {
    let old = ui().brush.replace(unsafe { CreateSolidBrush(r as u32 | (g as u32) << 8 | (b as u32) << 16) });
    if !old.is_null() {
        unsafe {
            DeleteObject(old);
            InvalidateRect(hwnd(), null(), 1);
            UpdateWindow(hwnd());
        }
    }
}

pub fn maximized() -> bool {
    unsafe { IsZoomed(hwnd()) != 0 }
}

pub fn minimize() {
    unsafe { ShowWindow(hwnd(), SW_MINIMIZE) };
}

pub fn toggle_maximize() {
    unsafe { ShowWindow(hwnd(), if maximized() { SW_RESTORE } else { SW_MAXIMIZE }) };
}

/// Moves the window with the pointer, whose button is down on a drag region, as the system moves a window by its
/// caption, snapping included.
pub fn drag() {
    let mut p = POINT::default();
    unsafe {
        GetCursorPos(&mut p);
        ReleaseCapture();
        let at = (p.y as u16 as u32) << 16 | p.x as u16 as u32;
        PostMessageW(hwnd(), WM_NCLBUTTONDOWN, HTCAPTION as usize, at as isize);
    }
}

pub fn set_title(title: &str) {
    unsafe { SetWindowTextW(hwnd(), wide(title).as_ptr()) };
}

/// Flashes the taskbar button, unless the window is in front.
pub fn attention() {
    unsafe {
        if GetForegroundWindow() == hwnd() && IsIconic(hwnd()) == 0 {
            return;
        }
        let f = FLASHWINFO {
            cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
            hwnd: hwnd(),
            dwFlags: FLASHW_TRAY,
            uCount: 4,
            dwTimeout: 0,
        };
        FlashWindowEx(&f);
    }
}

/// The page's fullscreen, a video's button: the window covers its monitor with no insets, then goes back.
pub fn set_fullscreen(on: bool) {
    let h = hwnd();
    if ui().fullscreen.get().is_some() == on {
        return;
    }
    unsafe {
        if on {
            let mut was: WINDOWPLACEMENT = std::mem::zeroed();
            was.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
            GetWindowPlacement(h, &mut was);
            ui().fullscreen.set(Some(was));
            if maximized() {
                // A maximized window stays where it is; its client grows to the monitor (WM_NCCALCSIZE).
                SetWindowPos(h, null_mut(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
            } else {
                let mut mi: MONITORINFO = std::mem::zeroed();
                mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mut mi);
                let r = mi.rcMonitor;
                SetWindowPos(h, null_mut(), r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_FRAMECHANGED);
            }
        } else if let Some(was) = ui().fullscreen.take() {
            SetWindowPlacement(h, &was);
            SetWindowPos(h, null_mut(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
        }
    }
}

pub fn destroy() {
    unsafe { DestroyWindow(hwnd()) };
}

fn scale(px: i32, dpi: u32) -> i32 {
    (px as i64 * dpi as i64 / 96) as i32
}

fn win11() -> bool {
    static BUILD: AtomicIsize = AtomicIsize::new(-1);
    let mut b = BUILD.load(Ordering::Relaxed);
    if b < 0 {
        let mut v: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
        v.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
        unsafe { RtlGetVersion(&mut v) };
        b = v.dwBuildNumber as isize;
        BUILD.store(b, Ordering::Relaxed);
    }
    b >= 22000
}

/// The non-client inset on each side. On Windows 10 the top must be 0, or Windows draws a title bar; on
/// Windows 11 a 1 px top keeps the top rows of the client from being covered.
fn insets(dpi: u32) -> RECT {
    let frame = unsafe { GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi) };
    let top = if win11() { (dpi as f32 / 96.0).round() as i32 } else { 0 };
    RECT { left: frame, top, right: frame, bottom: frame }
}

fn top_edge(h: HWND) -> i32 {
    unsafe { GetSystemMetricsForDpi(SM_CYFRAME, GetDpiForWindow(h)) }
}

/// The client is now `w` by `h`: the webview fills it, the strip spans its top unless maximized, and the
/// page hears whether it's maximized.
fn resized(w: i32, h: i32) {
    webview::set_bounds(RECT { left: 0, top: 0, right: w, bottom: h });
    let max = maximized();
    let strip = ui().strip.get();
    if !strip.is_null() {
        let (sw, sh) = if max || ui().fullscreen.get().is_some() { (0, 0) } else { (w, top_edge(hwnd())) };
        unsafe { SetWindowPos(strip, null_mut(), 0, 0, sw, sh, SWP_NOACTIVATE) };
    }
    if ui().maximized.replace(max) != max {
        ipc::emit("maximized", if max { "true" } else { "false" });
    }
}

unsafe extern "system" fn proc_(h: HWND, msg: u32, wp: usize, lp: isize) -> isize {
    match msg {
        WM_NCCALCSIZE if wp != 0 => {
            let p = &mut *(lp as *mut NCCALCSIZE_PARAMS);
            let full = ui().fullscreen.get().is_some();
            if IsZoomed(h) != 0 {
                // Maximized, the client is the monitor's work area, less 1 px on each edge with an auto-hide
                // taskbar so the taskbar can still be summoned there; fullscreen, the whole monitor.
                let mut mi: MONITORINFO = std::mem::zeroed();
                mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                let m = MonitorFromRect(&p.rgrc[0], MONITOR_DEFAULTTONULL);
                if !m.is_null() && GetMonitorInfoW(m, &mut mi) != 0 {
                    let mut r = if full { mi.rcMonitor } else { mi.rcWork };
                    let hidden = |edge| {
                        let mut d: APPBARDATA = std::mem::zeroed();
                        d.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
                        d.uEdge = edge;
                        !full && SHAppBarMessage(ABM_GETAUTOHIDEBAR, &mut d) != 0
                    };
                    r.left += hidden(0) as i32;
                    r.top += hidden(1) as i32;
                    r.right -= hidden(2) as i32;
                    r.bottom -= hidden(3) as i32;
                    p.rgrc[0] = r;
                }
            } else if !full {
                let i = insets(GetDpiForWindow(h));
                let r = &mut p.rgrc[0];
                r.left += i.left;
                r.top += i.top;
                r.right -= i.right;
                r.bottom -= i.bottom;
            }
            return 0;
        }
        WM_NCHITTEST if IsZoomed(h) == 0 && ui().fullscreen.get().is_none() => {
            let mut pt = POINT { x: lp as i16 as i32, y: (lp >> 16) as i16 as i32 };
            let mut r = RECT::default();
            ScreenToClient(h, &mut pt);
            GetClientRect(h, &mut r);
            if (0..=top_edge(h)).contains(&pt.y) && (0..=r.right).contains(&pt.x) {
                return HTTOP;
            }
        }
        WM_GETMINMAXINFO => {
            let dpi = GetDpiForWindow(h);
            let (i, (w, ht)) = (insets(dpi), ui().min.get());
            (*(lp as *mut MINMAXINFO)).ptMinTrackSize =
                POINT { x: scale(w, dpi) + i.left + i.right, y: scale(ht, dpi) + i.top + i.bottom };
            return 0;
        }
        WM_DPICHANGED => {
            let r = &*(lp as *const RECT);
            SetWindowPos(h, null_mut(), r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOACTIVATE);
            return 0;
        }
        WM_ERASEBKGND => {
            let mut r = RECT::default();
            GetClientRect(h, &mut r);
            FillRect(wp as HANDLE, &r, ui().brush.get());
            return 1;
        }
        WM_SIZE if wp != SIZE_MINIMIZED => resized((lp & 0xffff) as i32, ((lp >> 16) & 0xffff) as i32),
        WM_MOVE | WM_MOVING => webview::moved(),
        WM_SETFOCUS => webview::focus(),
        WM_ACTIVATE => {
            let on = wp & 0xffff != WA_INACTIVE;
            if ui().active.replace(on) != on {
                ipc::emit("focus", if on { "true" } else { "false" });
            }
        }
        // A page that's listening decides, and may keep the window open for an unsaved file.
        WM_CLOSE => {
            if webview::page_alive() {
                ipc::emit("close", "null");
            } else {
                DestroyWindow(h);
            }
            return 0;
        }
        WM_DESTROY => {
            HWND_.store(null_mut(), Ordering::Relaxed);
            webview::close();
            PostQuitMessage(0);
            return 0;
        }
        WM_TIMER if wp == SHOW_TIMER => show(),
        WM_RUN => {
            Box::from_raw(lp as *mut Box<dyn FnOnce()>)();
            return 0;
        }
        _ => {}
    }
    DefWindowProcW(h, msg, wp, lp)
}

/// The top strip: a hit there resizes the window from its top edge.
unsafe extern "system" fn strip_proc(h: HWND, msg: u32, wp: usize, lp: isize) -> isize {
    match msg {
        WM_NCHITTEST => HTTOP,
        WM_NCLBUTTONDOWN => {
            PostMessageW(hwnd(), WM_NCLBUTTONDOWN, HTTOP as usize, lp);
            0
        }
        _ => DefWindowProcW(h, msg, wp, lp),
    }
}
