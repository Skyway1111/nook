//! Linux: a GTK 3 window around a WebKitGTK 4.1 webview (2.40 or later), through the bindings below. Everything
//! here runs on GTK's main loop; other threads reach it through `post`.
//!
//! The window is undecorated: the page draws its title bar, a press on a drag region moves the window
//! (`drag`), and the 5 px at each edge resize it. The page's origin is `tauri://localhost`, and files on disk
//! are at `asset://localhost/<percent-encoded path>`; both schemes are secure contexts that allow CORS.
#![allow(non_upper_case_globals)]
use super::assets::{self, Body, Reply, Route};
use super::{ipc, Config};
use std::cell::{Cell, RefCell};
use std::ffi::{c_char, c_int, c_uint, c_void, CStr, CString};
use std::ptr::{null, null_mut};

type Ptr = *mut c_void;
type Callback = unsafe extern "C" fn();
type Notify = Option<unsafe extern "C" fn(Ptr)>;
type SourceFn = unsafe extern "C" fn(Ptr) -> c_int;
type Ready = unsafe extern "C" fn(Ptr, Ptr, Ptr);

#[repr(C)]
struct Rgba(f64, f64, f64, f64);

#[repr(C)]
struct Geometry {
    min_width: c_int,
    min_height: c_int,
    max_width: c_int,
    max_height: c_int,
    base_width: c_int,
    base_height: c_int,
    width_inc: c_int,
    height_inc: c_int,
    min_aspect: f64,
    max_aspect: f64,
    win_gravity: c_int,
}

#[repr(C)]
struct EventButton {
    kind: c_int,
    window: Ptr,
    send_event: i8,
    time: u32,
    x: f64,
    y: f64,
    axes: *mut f64,
    state: c_uint,
    button: c_uint,
    device: Ptr,
    x_root: f64,
    y_root: f64,
}

#[repr(C)]
struct EventMotion {
    kind: c_int,
    window: Ptr,
    send_event: i8,
    time: u32,
    x: f64,
    y: f64,
}

#[repr(C)]
struct EventWindowState {
    kind: c_int,
    window: Ptr,
    send_event: i8,
    changed_mask: c_uint,
    new_window_state: c_uint,
}

const GDK_BUTTON_PRESS: c_int = 4;
const GDK_WINDOW_STATE_MAXIMIZED: c_uint = 4;
const GDK_WINDOW_STATE_FULLSCREEN: c_uint = 16;
const GDK_HINT_MIN_SIZE: c_uint = 2;
const GDK_POINTER_MOTION_MASK: c_int = 4;
const GDK_BUTTON_PRESS_MASK: c_int = 256;
const GDK_BUTTON_RELEASE_MASK: c_int = 512;
const WEBKIT_LOAD_STARTED: c_int = 0;
const WEBKIT_LOAD_FINISHED: c_int = 3;
const SOUP_MESSAGE_HEADERS_RESPONSE: c_int = 1;
const G_BUS_TYPE_SESSION: c_int = 2;

#[link(name = "gtk-3")]
extern "C" {
    fn gtk_init_check(argc: *mut c_int, argv: *mut Ptr) -> c_int;
    fn gtk_main();
    fn gtk_main_quit();
    fn gtk_window_new(kind: c_int) -> Ptr;
    fn gtk_window_set_title(w: Ptr, title: *const c_char);
    fn gtk_window_set_default_size(w: Ptr, width: c_int, height: c_int);
    fn gtk_window_set_geometry_hints(w: Ptr, widget: Ptr, g: *const Geometry, mask: c_uint);
    fn gtk_window_set_decorated(w: Ptr, on: c_int);
    fn gtk_window_set_titlebar(w: Ptr, titlebar: Ptr);
    fn gtk_window_set_icon(w: Ptr, pixbuf: Ptr);
    fn gtk_window_iconify(w: Ptr);
    fn gtk_window_maximize(w: Ptr);
    fn gtk_window_unmaximize(w: Ptr);
    fn gtk_window_is_maximized(w: Ptr) -> c_int;
    fn gtk_window_is_active(w: Ptr) -> c_int;
    fn gtk_window_set_urgency_hint(w: Ptr, on: c_int);
    fn gtk_window_begin_move_drag(w: Ptr, button: c_int, x: c_int, y: c_int, time: u32);
    fn gtk_window_begin_resize_drag(w: Ptr, edge: c_int, button: c_int, x: c_int, y: c_int, time: u32);
    fn gtk_event_box_new() -> Ptr;
    fn gtk_container_add(c: Ptr, child: Ptr);
    fn gtk_widget_show(w: Ptr);
    fn gtk_widget_show_all(w: Ptr);
    fn gtk_widget_destroy(w: Ptr);
    fn gtk_widget_add_events(w: Ptr, mask: c_int);
    fn gtk_widget_get_allocated_width(w: Ptr) -> c_int;
    fn gtk_widget_get_allocated_height(w: Ptr) -> c_int;
    fn gtk_widget_get_scale_factor(w: Ptr) -> c_int;
    fn gtk_settings_get_default() -> Ptr;
    fn gtk_selection_data_get_uris(data: Ptr) -> *mut *mut c_char;
    fn gtk_drag_finish(ctx: Ptr, success: c_int, del: c_int, time: u32);
}

#[link(name = "gdk-3")]
extern "C" {
    fn gdk_display_get_default() -> Ptr;
    fn gdk_display_get_default_seat(d: Ptr) -> Ptr;
    fn gdk_seat_get_pointer(seat: Ptr) -> Ptr;
    fn gdk_device_get_position(device: Ptr, screen: *mut Ptr, x: *mut c_int, y: *mut c_int);
    fn gdk_cursor_new_for_display(d: Ptr, kind: c_int) -> Ptr;
    fn gdk_window_set_cursor(w: Ptr, cursor: Ptr);
}

#[link(name = "gdk_pixbuf-2.0")]
extern "C" {
    fn gdk_pixbuf_new_from_stream(stream: Ptr, cancellable: Ptr, error: *mut Ptr) -> Ptr;
}

#[link(name = "gobject-2.0")]
extern "C" {
    fn g_object_new(kind: usize, first: *const c_char, ...) -> Ptr;
    fn g_object_set(obj: Ptr, first: *const c_char, ...);
    fn g_object_ref(obj: Ptr) -> Ptr;
    pub(crate) fn g_object_unref(obj: Ptr);
    fn g_signal_connect_data(obj: Ptr, signal: *const c_char, f: Callback, data: Ptr, notify: Ptr, flags: c_int)
        -> u64;
    fn g_type_name_from_instance(instance: Ptr) -> *const c_char;
}

#[link(name = "glib-2.0")]
extern "C" {
    fn g_idle_add_full(priority: c_int, f: SourceFn, data: Ptr, notify: Notify) -> c_uint;
    fn g_timeout_add(ms: c_uint, f: SourceFn, data: Ptr) -> c_uint;
    pub(crate) fn g_free(p: Ptr);
    fn g_strfreev(v: *mut *mut c_char);
    fn g_filename_from_uri(uri: *const c_char, host: *mut *mut c_char, error: *mut Ptr) -> *mut c_char;
    pub(crate) fn g_filename_to_uri(path: *const c_char, host: *const c_char, error: *mut Ptr) -> *mut c_char;
    fn g_error_free(error: Ptr);
    fn g_bytes_new_with_free_func(data: *const u8, size: usize, free: Notify, user: Ptr) -> Ptr;
    fn g_bytes_unref(b: Ptr);
    pub(crate) fn g_variant_new(format: *const c_char, ...) -> Ptr;
    fn g_variant_unref(v: Ptr);
    fn g_variant_get_child_value(v: Ptr, i: usize) -> Ptr;
    fn g_variant_get_variant(v: Ptr) -> Ptr;
    fn g_variant_is_of_type(v: Ptr, kind: *const c_char) -> c_int;
    fn g_variant_get_uint32(v: Ptr) -> u32;
    fn g_variant_get_string(v: Ptr, len: *mut usize) -> *const c_char;
}

#[link(name = "gio-2.0")]
extern "C" {
    fn g_memory_input_stream_new() -> Ptr;
    fn g_memory_input_stream_new_from_data(data: *const u8, len: isize, destroy: Notify) -> Ptr;
    fn g_memory_input_stream_new_from_bytes(bytes: Ptr) -> Ptr;
    fn g_unix_input_stream_new(fd: c_int, close: c_int) -> Ptr;
    fn g_input_stream_read(s: Ptr, buf: *mut u8, n: usize, cancellable: Ptr, error: *mut Ptr) -> isize;
    fn g_bus_get(kind: c_int, cancellable: Ptr, done: Ready, data: Ptr);
    fn g_bus_get_finish(res: Ptr, error: *mut Ptr) -> Ptr;
    fn g_bus_get_sync(kind: c_int, cancellable: Ptr, error: *mut Ptr) -> Ptr;
    fn g_dbus_connection_call_sync(
        bus: Ptr,
        name: *const c_char,
        path: *const c_char,
        iface: *const c_char,
        method: *const c_char,
        params: Ptr,
        reply: *const c_char,
        flags: c_int,
        timeout: c_int,
        cancellable: Ptr,
        error: *mut Ptr,
    ) -> Ptr;
    pub(crate) fn g_file_new_for_path(path: *const c_char) -> Ptr;
    pub(crate) fn g_file_trash(file: Ptr, cancellable: Ptr, error: *mut Ptr) -> c_int;
    pub(crate) fn g_app_info_launch_default_for_uri(uri: *const c_char, context: Ptr, error: *mut Ptr) -> c_int;
    fn g_dbus_connection_call(
        bus: Ptr,
        name: *const c_char,
        path: *const c_char,
        iface: *const c_char,
        method: *const c_char,
        params: Ptr,
        reply: *const c_char,
        flags: c_int,
        timeout: c_int,
        cancellable: Ptr,
        done: Ready,
        data: Ptr,
    );
    fn g_dbus_connection_call_finish(bus: Ptr, res: Ptr, error: *mut Ptr) -> Ptr;
    fn g_dbus_connection_signal_subscribe(
        bus: Ptr,
        sender: *const c_char,
        iface: *const c_char,
        member: *const c_char,
        path: *const c_char,
        arg0: *const c_char,
        flags: c_int,
        f: Callback,
        data: Ptr,
        notify: Notify,
    ) -> c_uint;
}

#[link(name = "webkit2gtk-4.1")]
extern "C" {
    fn webkit_web_view_get_type() -> usize;
    fn webkit_website_data_manager_new(first: *const c_char, ...) -> Ptr;
    fn webkit_web_context_new_with_website_data_manager(m: Ptr) -> Ptr;
    fn webkit_web_context_set_use_system_appearance_for_scrollbars(c: Ptr, on: c_int);
    fn webkit_web_context_register_uri_scheme(
        c: Ptr,
        scheme: *const c_char,
        f: unsafe extern "C" fn(Ptr, Ptr),
        data: Ptr,
        notify: Notify,
    );
    fn webkit_web_context_get_security_manager(c: Ptr) -> Ptr;
    fn webkit_security_manager_register_uri_scheme_as_secure(m: Ptr, scheme: *const c_char);
    fn webkit_security_manager_register_uri_scheme_as_cors_enabled(m: Ptr, scheme: *const c_char);
    fn webkit_user_content_manager_new() -> Ptr;
    fn webkit_user_content_manager_register_script_message_handler(m: Ptr, name: *const c_char) -> c_int;
    fn webkit_user_content_manager_add_script(m: Ptr, script: Ptr);
    fn webkit_user_script_new(src: *const c_char, frames: c_int, when: c_int, allow: Ptr, block: Ptr) -> Ptr;
    fn webkit_user_script_unref(script: Ptr);
    fn webkit_javascript_result_get_js_value(r: Ptr) -> Ptr;
    fn webkit_web_view_get_settings(wv: Ptr) -> Ptr;
    fn webkit_settings_set_enable_developer_extras(s: Ptr, on: c_int);
    fn webkit_web_view_get_input_method_context(wv: Ptr) -> Ptr;
    fn webkit_input_method_context_set_enable_preedit(c: Ptr, on: c_int);
    fn webkit_web_view_set_background_color(wv: Ptr, rgba: *const Rgba);
    fn webkit_web_view_load_uri(wv: Ptr, uri: *const c_char);
    #[cfg(debug_assertions)]
    fn webkit_web_view_reload(wv: Ptr);
    fn webkit_web_view_get_uri(wv: Ptr) -> *const c_char;
    fn webkit_web_view_stop_loading(wv: Ptr);
    fn webkit_web_view_evaluate_javascript(
        wv: Ptr,
        script: *const c_char,
        len: isize,
        world: *const c_char,
        source: *const c_char,
        cancellable: Ptr,
        done: Option<Ready>,
        data: Ptr,
    );
    fn webkit_uri_scheme_request_get_uri(r: Ptr) -> *const c_char;
    fn webkit_uri_scheme_request_get_http_method(r: Ptr) -> *const c_char;
    fn webkit_uri_scheme_request_get_http_headers(r: Ptr) -> Ptr;
    fn webkit_uri_scheme_request_get_http_body(r: Ptr) -> Ptr;
    fn webkit_uri_scheme_request_finish_with_response(r: Ptr, response: Ptr);
    fn webkit_uri_scheme_response_new(stream: Ptr, len: i64) -> Ptr;
    fn webkit_uri_scheme_response_set_status(r: Ptr, status: c_uint, reason: *const c_char);
    fn webkit_uri_scheme_response_set_content_type(r: Ptr, kind: *const c_char);
    fn webkit_uri_scheme_response_set_http_headers(r: Ptr, headers: Ptr);
}

#[link(name = "javascriptcoregtk-4.1")]
extern "C" {
    fn jsc_value_to_string(v: Ptr) -> *mut c_char;
}

#[link(name = "soup-3.0")]
extern "C" {
    fn soup_message_headers_new(kind: c_int) -> Ptr;
    fn soup_message_headers_append(h: Ptr, name: *const c_char, value: *const c_char);
    fn soup_message_headers_get_one(h: Ptr, name: *const c_char) -> *const c_char;
}

/// Where a drag from another app stands.
#[derive(Clone, Copy, PartialEq)]
enum Drag {
    Away,
    /// Files are over the page.
    Over,
    /// GTK said the drag left, which it also says right before a drop.
    Leaving,
}

/// State only the main thread touches.
struct Ui {
    window: Cell<Ptr>,
    webview: Cell<Ptr>,
    /// The page has posted since its last load started, and its process is alive, so it answers a close.
    alive: Cell<bool>,
    shown: Cell<bool>,
    maximized: Cell<bool>,
    fullscreen: Cell<bool>,
    focused: Cell<bool>,
    /// The resize edge the pointer is on, or -1.
    edge: Cell<c_int>,
    cursors: [Cell<Ptr>; 8],
    drag: Cell<Drag>,
    drag_at: Cell<(c_int, c_int)>,
    /// The dragged files, as a JSON list.
    drag_paths: RefCell<String>,
}

struct UiCell(Ui);
// SAFETY: only the main thread reads or writes it.
unsafe impl Sync for UiCell {}
static UI: UiCell = UiCell(Ui {
    window: Cell::new(null_mut()),
    webview: Cell::new(null_mut()),
    alive: Cell::new(false),
    shown: Cell::new(false),
    maximized: Cell::new(false),
    fullscreen: Cell::new(false),
    focused: Cell::new(false),
    edge: Cell::new(-1),
    cursors: [const { Cell::new(null_mut()) }; 8],
    drag: Cell::new(Drag::Away),
    drag_at: Cell::new((0, 0)),
    drag_paths: RefCell::new(String::new()),
});

fn ui() -> &'static Ui {
    &UI.0
}

pub(crate) fn cstring(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap_or_default()
}

fn text(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }
}

/// Connects handler `f`, whose signature is the signal's, to `obj`'s `signal`.
unsafe fn connect(obj: Ptr, signal: &CStr, f: *const ()) {
    g_signal_connect_data(
        obj,
        signal.as_ptr(),
        std::mem::transmute::<*const (), Callback>(f),
        null_mut(),
        null_mut(),
        0,
    );
}

pub fn run(cfg: Config) -> Result<(), String> {
    unsafe {
        if gtk_init_check(null_mut(), null_mut()) == 0 {
            return Err("GTK couldn't open a display".into());
        }
        let w = gtk_window_new(0);
        ui().window.set(w);
        gtk_window_set_title(w, cstring(cfg.title).as_ptr());
        gtk_window_set_default_size(w, cfg.size.0, cfg.size.1);
        let min = Geometry {
            min_width: cfg.min.0,
            min_height: cfg.min.1,
            max_width: 0,
            max_height: 0,
            base_width: 0,
            base_height: 0,
            width_inc: 0,
            height_inc: 0,
            min_aspect: 0.0,
            max_aspect: 0.0,
            win_gravity: 0,
        };
        gtk_window_set_geometry_hints(w, null_mut(), &min, GDK_HINT_MIN_SIZE);
        gtk_window_set_decorated(w, 0);
        // On Wayland, a titlebar of its own makes GTK draw the window's frame, so the compositor draws none.
        if text(g_type_name_from_instance(gdk_display_get_default())) == "GdkWaylandDisplay" {
            gtk_window_set_titlebar(w, gtk_event_box_new());
        }
        if !cfg.icon.is_empty() {
            let s = g_memory_input_stream_new_from_data(cfg.icon.as_ptr(), cfg.icon.len() as isize, None);
            let icon = gdk_pixbuf_new_from_stream(s, null_mut(), null_mut());
            if !icon.is_null() {
                gtk_window_set_icon(w, icon);
                g_object_unref(icon);
            }
            g_object_unref(s);
        }
        connect(w, c"delete-event", delete as *const ());
        connect(w, c"destroy", destroyed as *const ());
        connect(w, c"window-state-event", window_state as *const ());
        connect(w, c"focus-in-event", focus_in as *const ());
        connect(w, c"focus-out-event", focus_out as *const ());

        // The profile keeps localStorage, so its folder is the one nook has always used.
        let dir = cstring(&cfg.data_dir);
        let data = webkit_website_data_manager_new(
            c"base-data-directory".as_ptr(),
            dir.as_ptr(),
            c"base-cache-directory".as_ptr(),
            dir.as_ptr(),
            null::<c_char>(),
        );
        let context = webkit_web_context_new_with_website_data_manager(data);
        webkit_web_context_set_use_system_appearance_for_scrollbars(context, 0);
        let security = webkit_web_context_get_security_manager(context);
        for scheme in [c"tauri", c"asset"] {
            webkit_web_context_register_uri_scheme(context, scheme.as_ptr(), scheme_request, null_mut(), None);
            webkit_security_manager_register_uri_scheme_as_secure(security, scheme.as_ptr());
            webkit_security_manager_register_uri_scheme_as_cors_enabled(security, scheme.as_ptr());
        }
        let content = webkit_user_content_manager_new();
        connect(content, c"script-message-received::ipc", message as *const ());
        webkit_user_content_manager_register_script_message_handler(content, c"ipc".as_ptr());
        let script = webkit_user_script_new(cstring(&cfg.init_script).as_ptr(), 0, 0, null_mut(), null_mut());
        webkit_user_content_manager_add_script(content, script);
        webkit_user_script_unref(script);

        let wv = g_object_new(
            webkit_web_view_get_type(),
            c"web-context".as_ptr(),
            context,
            c"user-content-manager".as_ptr(),
            content,
            null::<c_char>(),
        );
        ui().webview.set(wv);
        if cfg!(debug_assertions) {
            webkit_settings_set_enable_developer_extras(webkit_web_view_get_settings(wv), 1);
        }
        // An input method composes in its own window, not inline in the page.
        let im = webkit_web_view_get_input_method_context(wv);
        if !im.is_null() {
            webkit_input_method_context_set_enable_preedit(im, 0);
        }
        set_background(cfg.background);
        connect(wv, c"load-changed", load_changed as *const ());
        connect(wv, c"web-process-terminated", page_died as *const ());
        connect(wv, c"drag-motion", drag_motion as *const ());
        connect(wv, c"drag-data-received", drag_data as *const ());
        connect(wv, c"drag-leave", drag_leave as *const ());
        connect(wv, c"drag-drop", drag_drop as *const ());
        connect(wv, c"motion-notify-event", pointer_moved as *const ());
        connect(wv, c"button-press-event", pressed as *const ());
        connect(wv, c"button-release-event", released as *const ());
        gtk_widget_add_events(wv, GDK_POINTER_MOTION_MASK | GDK_BUTTON_PRESS_MASK | GDK_BUTTON_RELEASE_MASK);
        gtk_container_add(w, wv);
        gtk_widget_show(wv);

        // Hidden until the page has loaded: shown sooner, WebKitGTK waits out a 500 ms timeout for the first
        // frame. Should the page never load, it shows anyway.
        g_timeout_add(3000, show_late, null_mut());
        webkit_web_view_load_uri(wv, cstring(&assets::page()).as_ptr());
        (cfg.on_webview)();
        g_bus_get(G_BUS_TYPE_SESSION, null_mut(), bus_ready, null_mut());
        gtk_main();
    }
    Ok(())
}

/// Runs `f` on the main thread; always will.
pub fn post(f: impl FnOnce() + Send + 'static) -> bool {
    unsafe extern "C" fn run_once(p: Ptr) -> c_int {
        Box::from_raw(p as *mut Box<dyn FnOnce()>)();
        0
    }
    let f: Box<Box<dyn FnOnce()>> = Box::new(Box::new(f));
    unsafe { g_idle_add_full(0, run_once, Box::into_raw(f).cast(), None) };
    true
}

/// Runs `script` in the page.
pub fn eval(script: &str) {
    let wv = ui().webview.get();
    if !wv.is_null() {
        unsafe {
            webkit_web_view_evaluate_javascript(
                wv,
                script.as_ptr().cast(),
                script.len() as isize,
                null(),
                null(),
                null_mut(),
                None,
                null_mut(),
            )
        };
    }
}

/// Debug builds: loads the page again.
#[cfg(debug_assertions)]
pub fn reload() {
    let wv = ui().webview.get();
    if !wv.is_null() {
        unsafe { webkit_web_view_reload(wv) };
    }
}

/// Sends JSON `text` to the page.
pub fn send(text: &str) {
    if page_is_ours() {
        eval(&format!("__nook.receive({text})"));
    }
}

pub use send as send_reply;

/// Sends piece `seq` of stream `id`, whole characters, and whether the stream ends with it, as a JS string
/// literal: runs of plain text are copied as they are, and only quotes, backslashes, and controls escaped.
pub fn send_stream(id: u64, seq: u64, bytes: &[u8], end: bool) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    if !page_is_ours() {
        return;
    }
    let text = String::from_utf8_lossy(bytes);
    let mut script = String::with_capacity(text.len() + text.len() / 8 + 32);
    script += &format!("__nook.text({id},{seq},\"");
    let mut run = 0;
    for (i, &b) in text.as_bytes().iter().enumerate() {
        if b >= 0x20 && b != b'"' && b != b'\\' {
            continue;
        }
        script += &text[run..i];
        run = i + 1;
        match b {
            b'"' => script += "\\\"",
            b'\\' => script += "\\\\",
            b'\n' => script += "\\n",
            b'\r' => script += "\\r",
            b => {
                script += "\\x";
                script.push(HEX[b as usize >> 4] as char);
                script.push(HEX[b as usize & 15] as char);
            }
        }
    }
    script += &text[run..];
    script += if end { "\",1)" } else { "\")" };
    eval(&script);
}

fn show() {
    if !ui().shown.replace(true) {
        unsafe { gtk_widget_show_all(ui().window.get()) };
    }
}

unsafe extern "C" fn show_late(_: Ptr) -> c_int {
    if !ui().window.get().is_null() {
        show();
    }
    0
}

pub fn minimize() {
    unsafe { gtk_window_iconify(ui().window.get()) };
}

pub fn maximized() -> bool {
    unsafe { gtk_window_is_maximized(ui().window.get()) != 0 }
}

pub fn toggle_maximize() {
    let w = ui().window.get();
    unsafe {
        if maximized() {
            gtk_window_unmaximize(w)
        } else {
            gtk_window_maximize(w)
        }
    }
}

pub fn destroy() {
    let w = ui().window.get();
    if !w.is_null() {
        unsafe { gtk_widget_destroy(w) };
    }
}

pub fn set_title(title: &str) {
    unsafe { gtk_window_set_title(ui().window.get(), cstring(title).as_ptr()) };
}

/// Marks the window urgent until it's focused, unless it's in front.
pub fn attention() {
    let w = ui().window.get();
    unsafe {
        if gtk_window_is_active(w) == 0 {
            gtk_window_set_urgency_hint(w, 1);
        }
    }
}

/// The color the webview shows where the page hasn't painted.
pub fn set_background([r, g, b]: [u8; 3]) {
    let c = Rgba(r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0, 1.0);
    unsafe { webkit_web_view_set_background_color(ui().webview.get(), &c) };
}

/// Moves the window with the pointer, whose button is down on a drag region.
pub fn drag() {
    let (mut x, mut y) = (0, 0);
    unsafe {
        let pointer = gdk_seat_get_pointer(gdk_display_get_default_seat(gdk_display_get_default()));
        gdk_device_get_position(pointer, null_mut(), &mut x, &mut y);
        gtk_window_begin_move_drag(ui().window.get(), 1, x, y, 0);
    }
}

// The window

/// A page that's listening decides, and may keep the window open for an unsaved file.
unsafe extern "C" fn delete(_: Ptr, _: Ptr, _: Ptr) -> c_int {
    if ui().alive.get() {
        ipc::emit("close", "null");
        1
    } else {
        0
    }
}

unsafe extern "C" fn destroyed(_: Ptr, _: Ptr) {
    ui().webview.set(null_mut());
    ui().window.set(null_mut());
    gtk_main_quit();
}

unsafe extern "C" fn window_state(_: Ptr, e: *const EventWindowState, _: Ptr) -> c_int {
    let state = (*e).new_window_state;
    ui().fullscreen.set(state & GDK_WINDOW_STATE_FULLSCREEN != 0);
    let max = state & GDK_WINDOW_STATE_MAXIMIZED != 0;
    if ui().maximized.replace(max) != max {
        ipc::emit("maximized", if max { "true" } else { "false" });
    }
    0
}

unsafe extern "C" fn focus_in(w: Ptr, _: Ptr, _: Ptr) -> c_int {
    gtk_window_set_urgency_hint(w, 0);
    focused(true)
}

unsafe extern "C" fn focus_out(_: Ptr, _: Ptr, _: Ptr) -> c_int {
    focused(false)
}

fn focused(on: bool) -> c_int {
    if ui().focused.replace(on) != on {
        ipc::emit("focus", if on { "true" } else { "false" });
    }
    0
}

// The page

/// The main frame shows nook's page and nothing else, since whatever it shows hears every reply, event, and
/// terminal's text: a load of anything else (a link dropped on the window) stops as it starts.
unsafe extern "C" fn load_changed(wv: Ptr, event: c_int, _: Ptr) {
    match event {
        WEBKIT_LOAD_STARTED if !page_is_ours() => webkit_web_view_stop_loading(wv),
        WEBKIT_LOAD_STARTED => ui().alive.set(false),
        WEBKIT_LOAD_FINISHED => show(),
        _ => {}
    }
}

unsafe extern "C" fn page_died(_: Ptr, _: c_int, _: Ptr) {
    ui().alive.set(false);
}

/// Whether the main frame shows, or is loading, nook's own page: only it hears the app or calls it.
fn page_is_ours() -> bool {
    let wv = ui().webview.get();
    let uri = if wv.is_null() { null() } else { unsafe { webkit_web_view_get_uri(wv) } };
    !uri.is_null() && unsafe { CStr::from_ptr(uri) }.to_str().is_ok_and(assets::ours)
}

unsafe extern "C" fn message(_: Ptr, result: Ptr, _: Ptr) {
    if !page_is_ours() {
        return;
    }
    let s = jsc_value_to_string(webkit_javascript_result_get_js_value(result));
    ui().alive.set(true);
    ipc::message(&text(s));
    g_free(s.cast());
}

// Resizing from the edges, and the mouse's back and forward buttons

/// The window edge (GdkWindowEdge) at point (x, y) of the webview, if the window can be resized there.
unsafe fn edge(wv: Ptr, x: f64, y: f64) -> Option<c_int> {
    if ui().maximized.get() || ui().fullscreen.get() {
        return None;
    }
    let (w, h) = (gtk_widget_get_allocated_width(wv) as f64, gtk_widget_get_allocated_height(wv) as f64);
    let inset = 5.0 * gtk_widget_get_scale_factor(wv) as f64;
    let (left, right, top, bottom) = (x < inset, x >= w - inset, y < inset, y >= h - inset);
    Some(match (top, bottom, left, right) {
        (true, _, true, _) => 0,
        (true, _, _, true) => 2,
        (true, ..) => 1,
        (_, true, true, _) => 5,
        (_, true, _, true) => 7,
        (_, true, ..) => 6,
        (.., true, _) => 3,
        (.., true) => 4,
        _ => return None,
    })
}

unsafe extern "C" fn pointer_moved(wv: Ptr, e: *const EventMotion, _: Ptr) -> c_int {
    let e = &*e;
    let at = edge(wv, e.x, e.y);
    let was = ui().edge.replace(at.unwrap_or(-1));
    match at {
        Some(at) => {
            // GdkCursorType for each GdkWindowEdge, NW to SE.
            const CURSORS: [c_int; 8] = [134, 138, 136, 70, 96, 12, 16, 14];
            let cell = &ui().cursors[at as usize];
            if cell.get().is_null() {
                cell.set(gdk_cursor_new_for_display(gdk_display_get_default(), CURSORS[at as usize]));
            }
            gdk_window_set_cursor(e.window, cell.get());
            1
        }
        None => {
            if was >= 0 {
                gdk_window_set_cursor(e.window, null_mut());
            }
            0
        }
    }
}

unsafe extern "C" fn pressed(wv: Ptr, e: *const EventButton, _: Ptr) -> c_int {
    let e = &*e;
    if e.kind != GDK_BUTTON_PRESS {
        return 0;
    }
    match e.button {
        1 => match edge(wv, e.x, e.y) {
            Some(at) => {
                gtk_window_begin_resize_drag(ui().window.get(), at, 1, e.x_root as c_int, e.y_root as c_int, e.time);
                1
            }
            None => 0,
        },
        8 | 9 => side_button(e, "mousedown"),
        _ => 0,
    }
}

unsafe extern "C" fn released(_: Ptr, e: *const EventButton, _: Ptr) -> c_int {
    let e = &*e;
    match e.button {
        8 | 9 => side_button(e, "mouseup"),
        _ => 0,
    }
}

/// WebKitGTK gives the page no events for the back and forward buttons, so they're made here, as buttons 3
/// and 4, as other browsers send them.
fn side_button(e: &EventButton, kind: &str) -> c_int {
    let (x, y, button) = (e.x, e.y, e.button - 5);
    eval(&format!(
        "document.elementFromPoint({x},{y})?.dispatchEvent(new MouseEvent('{kind}', \
         {{ button: {button}, clientX: {x}, clientY: {y}, bubbles: true, cancelable: true, view: window }}))"
    ));
    1
}

// Files dragged in from other apps. WebKit asks for the drag's data as the pointer comes over, which says
// whether it holds files. GTK reports a leave right before a drop, so a leave is only sent once idle.

unsafe extern "C" fn drag_motion(_: Ptr, _: Ptr, x: c_int, y: c_int, _: c_uint, _: Ptr) -> c_int {
    ui().drag_at.set((x, y));
    if ui().drag.get() == Drag::Over {
        send_drop("over", x, y, "[]");
    }
    0
}

unsafe extern "C" fn drag_data(_: Ptr, _: Ptr, _: c_int, _: c_int, data: Ptr, _: c_uint, _: c_uint, _: Ptr) {
    let uris = gtk_selection_data_get_uris(data);
    if uris.is_null() {
        return;
    }
    let mut paths = Vec::new();
    let mut i = 0;
    while !(*uris.add(i)).is_null() {
        let path = g_filename_from_uri(*uris.add(i), null_mut(), null_mut());
        if !path.is_null() {
            paths.push(crate::json::to_string(&text(path)));
            g_free(path.cast());
        }
        i += 1;
    }
    g_strfreev(uris);
    if paths.is_empty() {
        return;
    }
    *ui().drag_paths.borrow_mut() = format!("[{}]", paths.join(","));
    if ui().drag.replace(Drag::Over) != Drag::Over {
        let (x, y) = ui().drag_at.get();
        send_drop("over", x, y, "[]");
    }
}

unsafe extern "C" fn drag_leave(_: Ptr, _: Ptr, _: c_uint, _: Ptr) {
    unsafe extern "C" fn left(_: Ptr) -> c_int {
        if ui().drag.get() == Drag::Leaving {
            ui().drag.set(Drag::Away);
            send_drop("leave", 0, 0, "[]");
        }
        0
    }
    if ui().drag.get() == Drag::Over {
        ui().drag.set(Drag::Leaving);
        g_idle_add_full(0, left, null_mut(), None);
    }
}

unsafe extern "C" fn drag_drop(_: Ptr, ctx: Ptr, x: c_int, y: c_int, time: c_uint, _: Ptr) -> c_int {
    if ui().drag.get() != Drag::Leaving {
        return 0;
    }
    ui().drag.set(Drag::Away);
    gtk_drag_finish(ctx, 1, 0, time);
    send_drop("drop", x, y, &ui().drag_paths.borrow());
    1
}

/// A drop event in CSS pixels, which are GTK's.
fn send_drop(kind: &str, x: c_int, y: c_int, paths: &str) {
    ipc::emit("drop", &format!(r#"{{"type":"{kind}","x":{x},"y":{y},"paths":{paths}}}"#));
}

// nook's files: tauri://localhost and asset://localhost

/// A request's pointer, sent to a thread and back. Only the main thread touches it.
struct Request(Ptr);
// SAFETY: see above.
unsafe impl Send for Request {}

impl Request {
    fn ptr(&self) -> Ptr {
        self.0
    }
}

unsafe extern "C" fn scheme_request(req: Ptr, _: Ptr) {
    let header = |name: &CStr| {
        let v = soup_message_headers_get_one(webkit_uri_scheme_request_get_http_headers(req), name.as_ptr());
        (!v.is_null()).then(|| text(v))
    };
    let method = text(webkit_uri_scheme_request_get_http_method(req));
    match assets::route(&text(webkit_uri_scheme_request_get_uri(req))) {
        Some(Route::App(path)) => respond(req, assets::app(&path)),
        Some(Route::File(path)) => {
            let (head, range) = (method == "HEAD", header(c"Range"));
            later(req, move || in_memory(assets::file(&path, head, range.as_deref())));
        }
        Some(Route::Ipc(cmd)) if assets::may_call(&method, header(c"Origin").as_deref()) => {
            let (json, body) = assets::command_args(header(c"Content-Type").as_deref(), body(req));
            later(req, move || assets::command_reply(ipc::fetch(&cmd, &json, &body)));
        }
        Some(Route::Ipc(_)) => respond(req, assets::forbidden()),
        None => respond(req, assets::not_found()),
    }
}

/// Answers with what `f` returns on a worker.
fn later(req: Ptr, f: impl FnOnce() -> Reply + Send + 'static) {
    let req = Request(unsafe { g_object_ref(req) });
    ipc::work(move || {
        let reply = f();
        post(move || unsafe {
            respond(req.ptr(), reply);
            g_object_unref(req.ptr());
        });
    });
}

/// A part of a file, read here; the whole of one is streamed from its descriptor.
fn in_memory(mut r: Reply) -> Reply {
    use std::os::unix::fs::FileExt;
    if let Some(Body::File(f, at, n)) = &r.body {
        if r.status == 206 {
            let mut v = vec![0; *n as usize];
            let mut got = 0;
            while got < v.len() {
                match f.read_at(&mut v[got..], at + got as u64) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => got += k,
                }
            }
            v.truncate(got);
            r.body = Some(Body::Owned(v));
        }
    }
    r
}

unsafe fn body(req: Ptr) -> Vec<u8> {
    let s = webkit_uri_scheme_request_get_http_body(req);
    let mut out = Vec::new();
    if s.is_null() {
        return out;
    }
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = g_input_stream_read(s, buf.as_mut_ptr(), buf.len(), null_mut(), null_mut());
        if n <= 0 {
            break;
        }
        out.extend_from_slice(&buf[..n as usize]);
    }
    g_object_unref(s);
    out
}

unsafe fn respond(req: Ptr, r: Reply) {
    unsafe extern "C" fn free_vec(p: Ptr) {
        drop(Box::from_raw(p as *mut Vec<u8>));
    }
    let len = r.body.as_ref().map_or(0, Body::len);
    let stream = match r.body {
        None => g_memory_input_stream_new(),
        Some(Body::Static(s)) => g_memory_input_stream_new_from_data(s.as_ptr(), s.len() as isize, None),
        Some(Body::Owned(v)) => {
            let ptr = v.as_ptr();
            let bytes = g_bytes_new_with_free_func(ptr, v.len(), Some(free_vec), Box::into_raw(Box::new(v)).cast());
            let s = g_memory_input_stream_new_from_bytes(bytes);
            g_bytes_unref(bytes);
            s
        }
        Some(Body::File(f, ..)) => {
            use std::os::fd::IntoRawFd;
            g_unix_input_stream_new(f.into_raw_fd(), 1)
        }
    };
    let resp = webkit_uri_scheme_response_new(stream, len as i64);
    webkit_uri_scheme_response_set_status(resp, r.status as c_uint, cstring(r.reason).as_ptr());
    let headers = soup_message_headers_new(SOUP_MESSAGE_HEADERS_RESPONSE);
    for (name, value) in r.headers.split("\r\n").filter_map(|l| l.split_once(": ")) {
        let value = cstring(value);
        if name == "Content-Type" {
            webkit_uri_scheme_response_set_content_type(resp, value.as_ptr());
        }
        soup_message_headers_append(headers, cstring(name).as_ptr(), value.as_ptr());
    }
    webkit_uri_scheme_response_set_http_headers(resp, headers);
    webkit_uri_scheme_request_finish_with_response(req, resp);
    g_object_unref(resp);
    g_object_unref(stream);
}

// Light or dark: the desktop's color-scheme setting, read from its portal and followed as it changes, is
// GTK's preference, which WebKit gives the page as prefers-color-scheme.

const PORTAL: &CStr = c"org.freedesktop.portal.Desktop";
const PORTAL_PATH: &CStr = c"/org/freedesktop/portal/desktop";
const SETTINGS: &CStr = c"org.freedesktop.portal.Settings";
const APPEARANCE: &CStr = c"org.freedesktop.appearance";

unsafe extern "C" fn bus_ready(_: Ptr, res: Ptr, _: Ptr) {
    let bus = g_bus_get_finish(res, null_mut());
    if bus.is_null() {
        return;
    }
    g_dbus_connection_signal_subscribe(
        bus,
        PORTAL.as_ptr(),
        SETTINGS.as_ptr(),
        c"SettingChanged".as_ptr(),
        PORTAL_PATH.as_ptr(),
        APPEARANCE.as_ptr(),
        0,
        std::mem::transmute::<*const (), Callback>(setting_changed as *const ()),
        null_mut(),
        None,
    );
    let args = g_variant_new(c"(ss)".as_ptr(), APPEARANCE.as_ptr(), c"color-scheme".as_ptr());
    g_dbus_connection_call(
        bus,
        PORTAL.as_ptr(),
        PORTAL_PATH.as_ptr(),
        SETTINGS.as_ptr(),
        c"Read".as_ptr(),
        args,
        null(),
        0,
        -1,
        null_mut(),
        scheme_read,
        null_mut(),
    );
}

unsafe extern "C" fn scheme_read(bus: Ptr, res: Ptr, _: Ptr) {
    let reply = g_dbus_connection_call_finish(bus, res, null_mut());
    if !reply.is_null() {
        apply_scheme(g_variant_get_child_value(reply, 0));
        g_variant_unref(reply);
    }
}

unsafe extern "C" fn setting_changed(_: Ptr, _: Ptr, _: Ptr, _: Ptr, _: Ptr, params: Ptr, _: Ptr) {
    let key = g_variant_get_child_value(params, 1);
    if text(g_variant_get_string(key, null_mut())) == "color-scheme" {
        apply_scheme(g_variant_get_child_value(params, 2));
    }
    g_variant_unref(key);
}

/// Takes `v`, a color-scheme value inside any number of variants: 1 prefers dark, 0 and 2 don't.
unsafe fn apply_scheme(mut v: Ptr) {
    while g_variant_is_of_type(v, c"v".as_ptr()) != 0 {
        let inner = g_variant_get_variant(v);
        g_variant_unref(v);
        v = inner;
    }
    if g_variant_is_of_type(v, c"u".as_ptr()) != 0 {
        let dark = (g_variant_get_uint32(v) == 1) as c_int;
        g_object_set(gtk_settings_get_default(), c"gtk-application-prefer-dark-theme".as_ptr(), dark, null::<c_char>());
    }
    g_variant_unref(v);
}

// The desktop's services, for the file actions (shell_unix.rs) and notifications (notify.rs). These wait for an
// answer, so they run off the main thread.

/// A GError's message. Frees the error.
pub(crate) unsafe fn error_text(error: Ptr) -> String {
    #[repr(C)]
    struct GError {
        domain: u32,
        code: c_int,
        message: *const c_char,
    }
    if error.is_null() {
        return "it failed".into();
    }
    let message = text((*(error as *const GError)).message);
    g_error_free(error);
    message
}

/// Calls `method` of a freedesktop service on the session bus, on the interface named as the service is, and waits for
/// its reply. `args` makes the call's arguments, a new GVariant tuple, which the call takes.
pub(crate) fn bus_call(service: &CStr, path: &CStr, method: &CStr, args: impl FnOnce() -> Ptr) -> Result<(), String> {
    unsafe {
        let mut error = null_mut();
        let bus = g_bus_get_sync(G_BUS_TYPE_SESSION, null_mut(), &mut error);
        if bus.is_null() {
            return Err(error_text(error));
        }
        let (name, path, method) = (service.as_ptr(), path.as_ptr(), method.as_ptr());
        let reply = g_dbus_connection_call_sync(bus, name, path, name, method, args(), null(), 0, -1, null_mut(), &mut error);
        g_object_unref(bus);
        if reply.is_null() {
            return Err(error_text(error));
        }
        g_variant_unref(reply);
    }
    Ok(())
}
