//! The WebView2 in the window: its environment and controller are created without blocking the message
//! loop, set up as nook needs, and their events routed. Every call here is on the UI thread.
use super::{drop, loader, serve, window};
use crate::com::{add_ref, call, get, guid, handler, hresult, query, take_string, Com, Guid, S_OK};
use crate::host::{assets, ipc, Config};
use crate::sys::*;
use std::cell::Cell;
use std::ffi::c_void;
use std::ptr::null_mut;

const IID_ENVIRONMENT10: Guid = guid(0xee0eb9df_6f12_46ce_b53f_3f47b9c928e0);
const IID_ENVIRONMENT12: Guid = guid(0xf503db9b_739f_48dd_b151_fdfcf253f54e);
const IID_WEBVIEW17: Guid = guid(0x702e75d4_fd44_434d_9d70_1a68a6b1192a);
const IID_CONTROLLER_DONE: Guid = guid(0x6c4819f3_c9b7_4260_8127_c9f5bde7f68c);
const IID_CONTROLLER_OPTIONS3: Guid = guid(0xb32b191a_8998_57ca_b7cb_e04617e4ce4a);
const IID_CONTROLLER2: Guid = guid(0xc979903e_d4ca_4228_92eb_47ee3fa96eab);
const IID_CONTROLLER4: Guid = guid(0x97d418d5_a426_4e49_a151_e1a10f327d9e);
const IID_WEBVIEW13: Guid = guid(0xf75f09a8_667e_4983_88d6_c8773f315e84);
const IID_WEBVIEW22: Guid = guid(0xdb75dfc7_a857_4632_a398_6969dde26c0a);
const IID_SETTINGS5: Guid = guid(0x183e7052_1d03_43a0_ab99_98e043b66b39);
const IID_SETTINGS6: Guid = guid(0x11cb3acd_9bc8_43b8_83bf_f40753714f87);
const IID_NAVIGATION_STARTING: Guid = guid(0x9adbe429_f36d_432b_9ddc_f8881fbd76e3);
const IID_NAVIGATION_COMPLETED: Guid = guid(0xd33a35bf_1c49_4f98_93ab_006e0533fe1c);
const IID_WEB_MESSAGE: Guid = guid(0x57213f19_00e6_49fa_8e07_898ea01ecbd2);
const IID_WEB_RESOURCE: Guid = guid(0xab00b74c_15f1_4646_80e8_e76341d25d71);
const IID_PERMISSION: Guid = guid(0x15e1c6a3_c72a_4df3_91d7_d097fbec6bfd);
const IID_NEW_WINDOW: Guid = guid(0xd4c185fe_c81c_4989_97af_2d3fa7ab5651);
const IID_FULLSCREEN: Guid = guid(0xe45d98b1_afef_45be_8baf_6c7728867f73);
const IID_SCRIPT_ADDED: Guid = guid(0xb99369f3_9b11_47b5_bc6f_8e7895fcea17);
const IID_PROCESS_FAILED: Guid = guid(0x79e0aea4_990b_42d9_aa1d_0fcc2e5bc7f1);
#[cfg(debug_assertions)]
const IID_SCRIPT_RAN: Guid = guid(0x49511172_cc67_4bca_9923_137112f4c4cc);

struct Web {
    env: Cell<*mut c_void>,
    /// ICoreWebView2Environment12 and ICoreWebView2_17, for shared buffers.
    env12: Cell<*mut c_void>,
    webview17: Cell<*mut c_void>,
    controller: Cell<*mut c_void>,
    webview: Cell<*mut c_void>,
    /// The page has posted since its last navigation started and its process hasn't failed since, so it's
    /// there to answer a close.
    alive: Cell<bool>,
}

struct WebCell(Web);
// SAFETY: only the UI thread reads or writes it.
unsafe impl Sync for WebCell {}
static WEB: WebCell = WebCell(Web {
    env: Cell::new(null_mut()),
    env12: Cell::new(null_mut()),
    webview17: Cell::new(null_mut()),
    controller: Cell::new(null_mut()),
    webview: Cell::new(null_mut()),
    alive: Cell::new(false),
});

fn web() -> &'static Web {
    &WEB.0
}

pub fn env() -> *mut c_void {
    web().env.get()
}

/// Starts the environment; the controller, settings, and navigation follow as each step completes.
pub fn start(cfg: Config) -> Result<(), String> {
    unsafe { OleInitialize(null_mut()) };
    let (user_data, args) = (cfg.data_dir.clone(), cfg.browser_args.clone());
    loader::start(&user_data, &args, move |env| match env {
        Ok(env) => create_controller(env, cfg),
        Err(e) => fail(&e),
    })
}

fn fail(e: &str) {
    unsafe { MessageBoxW(window::hwnd(), wide(e).as_ptr(), wide("nook").as_ptr(), MB_ICONERROR) };
    window::destroy();
}

/// COREWEBVIEW2_COLOR {A, R, G, B} as the 4-byte value it's passed as.
fn color([r, g, b]: [u8; 3]) -> u32 {
    0xff | (r as u32) << 8 | (g as u32) << 16 | (b as u32) << 24
}

fn create_controller(env: Com, cfg: Config) {
    let bg = color(cfg.background);
    let mut cfg = Some(cfg);
    let done = handler(IID_CONTROLLER_DONE, move |hr, controller| {
        match cfg.take() {
            Some(_) if hresult(hr) < 0 || controller.is_null() => fail(&format!("WebView2 failed: {:#x}", hr as u32)),
            Some(cfg) => set_up(controller, cfg),
            None => {}
        }
        S_OK
    });
    let hwnd = window::hwnd();
    web().env.set(add_ref(env.0).leak());
    unsafe {
        // With options, the webview's first frame is already the background color.
        match env.query(&IID_ENVIRONMENT10).and_then(|e| Ok((e.get(20)?, e))) {
            Ok((options, env10)) => {
                if let Ok(o3) = options.query(&IID_CONTROLLER_OPTIONS3) {
                    call!(o3.0, 10, bg => u32);
                }
                call!(env10.0, 21, hwnd => HWND, options.0 => *mut c_void, done.0 => *mut c_void);
            }
            Err(_) => {
                call!(env.0, 3, hwnd => HWND, done.0 => *mut c_void);
            }
        }
    }
}

/// Adds handler `f` for the event whose `add_` method is slot `slot` of `obj`.
fn on(obj: *mut c_void, slot: usize, iid: Guid, f: impl FnMut(usize, *mut c_void) -> i32 + 'static) {
    let h = handler(iid, f);
    let mut token = 0i64;
    unsafe { call!(obj, slot, h.0 => *mut c_void, &mut token => *mut i64) };
}

fn set_up(controller: *mut c_void, cfg: Config) {
    unsafe {
        call!(controller, 1);
        web().controller.set(controller);
        let Ok(wv) = get(controller, 25).map(Com::leak) else { return fail("WebView2 has no webview") };
        web().webview.set(wv);
        match (query(env(), &IID_ENVIRONMENT12), query(wv, &IID_WEBVIEW17)) {
            (Ok(e12), Ok(w17)) => {
                web().env12.set(e12.leak());
                web().webview17.set(w17.leak());
            }
            _ => return fail("This WebView2 is too old for nook: update Microsoft Edge WebView2."),
        }
        if query(controller, &IID_CONTROLLER_OPTIONS3).is_err() {
            set_background(cfg.background);
        }
        // Files dropped from Explorer go to drop.rs, not to the page as navigations or file inputs.
        if let Ok(c4) = query(controller, &IID_CONTROLLER4) {
            call!(c4.0, 37, 0 => i32);
        }

        // Settings nook changes from WebView2's defaults. Browser accelerator keys stay on: the page sees
        // keys first and cancels the ones it uses.
        if let Ok(s) = get(wv, 3) {
            call!(s.0, 10, 0 => i32); // status bar
            call!(s.0, 18, 0 => i32); // Ctrl+wheel and Ctrl+/- zoom
            call!(s.0, 12, cfg!(debug_assertions) as i32 => i32);
            if let Ok(s5) = s.query(&IID_SETTINGS5) {
                call!(s5.0, 30, 0 => i32); // pinch zoom
            }
            if let Ok(s6) = s.query(&IID_SETTINGS6) {
                call!(s6.0, 32, 0 => i32); // swipe to go back
            }
        }
        // prefers-color-scheme follows the system as it changes. It's set, not left at the default, since a
        // profile keeps a scheme set to light or dark, and nook's existing profiles may have one.
        if let Ok(profile) = query(wv, &IID_WEBVIEW13).and_then(|w| w.get(105)) {
            call!(profile.0, 9, 0 => i32);
        }

        on(wv, 7, IID_NAVIGATION_STARTING, |_, _| {
            web().alive.set(false);
            S_OK
        });
        on(wv, 15, IID_NAVIGATION_COMPLETED, |_, _| {
            window::show();
            // WebView2 may have made new windows for the page, and each needs nook's drop target.
            drop::register(window::hwnd());
            S_OK
        });
        // Only the page's own process ending, or hanging, leaves no page to answer a close; a GPU, network, or
        // frame process can go and the page goes on.
        on(wv, 25, IID_PROCESS_FAILED, |_, args| {
            let mut kind = -1i32;
            call!(args, 3, &mut kind => *mut i32);
            if (0..=2).contains(&kind) {
                web().alive.set(false);
            }
            S_OK
        });
        // Only nook's own page calls commands, whatever document the main frame shows.
        on(wv, 34, IID_WEB_MESSAGE, |_, args| {
            let mut source = null_mut();
            call!(args, 3, &mut source => *mut *mut u16);
            if !assets::ours(&take_string(source)) {
                return S_OK;
            }
            let mut p = null_mut();
            call!(args, 4, &mut p => *mut *mut u16);
            web().alive.set(true);
            ipc::message(&take_string(p));
            S_OK
        });
        on(wv, 55, IID_WEB_RESOURCE, |_, args| {
            serve::request(args);
            S_OK
        });
        on(wv, 23, IID_PERMISSION, |_, args| {
            let mut kind = 0i32;
            call!(args, 4, &mut kind => *mut i32);
            if kind == 10 {
                call!(args, 7, 1 => i32); // queryLocalFonts() for the font pickers: allow
            }
            S_OK
        });
        on(wv, 52, IID_FULLSCREEN, |sender, _| {
            let mut on = 0i32;
            call!(sender, 54, &mut on => *mut i32);
            window::set_fullscreen(on != 0);
            S_OK
        });
        // Popups never open: links go to the system browser through nook's own code.
        on(wv, 44, IID_NEW_WINDOW, |_, args| {
            call!(args, 6, 1 => i32);
            S_OK
        });

        // nook's pages and the files they show, from every frame and worker.
        let w22 = query(wv, &IID_WEBVIEW22);
        for uri in ["http://tauri.localhost/*", "http://asset.localhost/*"] {
            let uri = wide(uri);
            match &w22 {
                Ok(w) => call!(w.0, 123, uri.as_ptr() => *const u16, 0 => i32, 0xffff_ffff_u32 => u32),
                Err(_) => call!(wv, 57, uri.as_ptr() => *const u16, 0 => i32),
            };
        }

        let added = handler(IID_SCRIPT_ADDED, |_, _| S_OK);
        call!(wv, 27, wide(&cfg.init_script).as_ptr() => *const u16, added.0 => *mut c_void);
        let mut r = RECT::default();
        GetClientRect(window::hwnd(), &mut r);
        set_bounds(r);
        call!(controller, 4, 1 => i32);
        call!(wv, 5, wide(assets::page()).as_ptr() => *const u16);
    }
    window::webview_ready();
    drop::register(window::hwnd());
    (cfg.on_webview)();
    // Shown before the webview was ready, the window took the focus the webview should have.
    if unsafe { GetFocus() } == window::hwnd() {
        focus();
    }
}

pub fn set_bounds(r: RECT) {
    let c = web().controller.get();
    if !c.is_null() {
        unsafe { call!(c, 6, r => RECT) };
    }
}

pub fn moved() {
    let c = web().controller.get();
    if !c.is_null() {
        unsafe { call!(c, 23) };
    }
}

pub fn focus() {
    let c = web().controller.get();
    if !c.is_null() {
        unsafe { call!(c, 12, 0 => i32) };
    }
}

/// The color the webview paints where the page hasn't.
pub fn set_background(rgb: [u8; 3]) {
    let c = web().controller.get();
    if c.is_null() {
        return;
    }
    if let Ok(c2) = query(c, &IID_CONTROLLER2) {
        unsafe { call!(c2.0, 27, color(rgb) => u32) };
    }
}

pub fn page_alive() -> bool {
    web().alive.get()
}

/// Posts string `s` to the page.
pub fn post_string(s: &str) {
    let wv = web().webview.get();
    if !wv.is_null() {
        unsafe { call!(wv, 33, wide(s).as_ptr() => *const u16) };
    }
}

/// Debug builds: runs `script` in the page.
#[cfg(debug_assertions)]
pub fn eval(script: &str) {
    let wv = web().webview.get();
    if !wv.is_null() {
        let done = handler(IID_SCRIPT_RAN, |_, _| S_OK);
        unsafe { call!(wv, 29, wide(script).as_ptr() => *const u16, done.0 => *mut c_void) };
    }
}

/// Debug builds: loads the page again.
#[cfg(debug_assertions)]
pub fn reload() {
    let wv = web().webview.get();
    if !wv.is_null() {
        unsafe { call!(wv, 31) };
    }
}

/// Posts `bytes` to the page as a shared buffer, with JSON `meta` as its additionalData.
pub fn post_buffer(bytes: &[u8], meta: &str) {
    let (env12, wv17) = (web().env12.get(), web().webview17.get());
    if wv17.is_null() {
        return;
    }
    let mut buf = null_mut();
    unsafe {
        call!(env12, 24, bytes.len().max(1) as u64 => u64, &mut buf => *mut *mut c_void);
        let Ok(buf) = Com::new(buf) else { return };
        let mut p = null_mut::<u8>();
        call!(buf.0, 4, &mut p => *mut *mut u8);
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        call!(wv17, 116, buf.0 => *mut c_void, 0 => i32, wide(meta).as_ptr() => *const u16);
        call!(buf.0, 7); // the page keeps its own mapping
    }
}

pub fn close() {
    web().webview17.set(null_mut());
    let c = web().controller.replace(null_mut());
    web().webview.set(null_mut());
    if !c.is_null() {
        unsafe { call!(c, 24) };
    }
}
