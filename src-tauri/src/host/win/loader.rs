//! Finds the WebView2 runtime and starts an environment from it, as Microsoft's WebView2Loader does.
use crate::com::{self, add_ref, guid, handler, hresult, task_string, Com, Guid, E_NOINTERFACE, E_NOTIMPL, S_OK};
use crate::sys::*;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};

const CLIENT: &str = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const ARCH: &str = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
/// The SDK version WebView2 is told the app was built against; it turns some behavior on by it.
const TARGET_VERSION: &str = "145.0.3800.47";
const IID_ENVIRONMENT_DONE: Guid = guid(0x4e8a3389_c9d8_4bd2_b6b5_124fee6cc14d);
const IID_OPTIONS: Guid = guid(0x2fde08a8_1e9a_4766_8c05_95a9ceb9d1c5);

/// Starts the environment for `user_data` with `args` added to the browser's command line, and calls
/// `done` with it on this thread's message loop. `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` picks a fixed-version
/// runtime and `WEBVIEW2_USER_DATA_FOLDER` overrides `user_data`; the runtime itself reads
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`.
pub fn start(user_data: &str, args: &str, done: impl FnOnce(Result<Com, String>) + 'static) -> Result<(), String> {
    let (dll, fixed) = client_dll().ok_or("WebView2 isn't installed")?;
    let module = unsafe { LoadLibraryExW(wide(&dll).as_ptr(), std::ptr::null_mut(), 0) };
    if module.is_null() {
        return Err(format!("couldn't load {dll}"));
    }
    let create = unsafe { GetProcAddress(module, c"CreateWebViewEnvironmentWithOptionsInternal".as_ptr().cast()) };
    if create.is_null() {
        return Err(format!("{dll} has no CreateWebViewEnvironmentWithOptionsInternal"));
    }
    type Create = unsafe extern "system" fn(i32, i32, *const u16, *mut c_void, *mut c_void) -> i32;
    let create: Create = unsafe { std::mem::transmute(create) };
    let user_data = var("WEBVIEW2_USER_DATA_FOLDER").unwrap_or_else(|| user_data.into());
    let mut done = Some(done);
    let handler = handler(IID_ENVIRONMENT_DONE, move |hr, env| {
        if let Some(done) = done.take() {
            done(if hresult(hr) < 0 || env.is_null() {
                Err(format!("WebView2 failed: {:#x}", hr as u32))
            } else {
                Ok(add_ref(env))
            })
        }
        S_OK
    });
    let options = options(args);
    let hr = unsafe { create(1, fixed as i32, wide(&user_data).as_ptr(), options.0, handler.0) };
    if hr < 0 {
        return Err(format!("WebView2 failed to start: {:#x}", hr as u32));
    }
    Ok(())
}

/// EmbeddedBrowserWebView.dll's path, and whether it's a fixed-version runtime.
fn client_dll() -> Option<(String, bool)> {
    if let Some(dir) = var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER") {
        return Some((format!(r"{dir}\EBWebView\{ARCH}\EmbeddedBrowserWebView.dll"), true));
    }
    [
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\"),
        (HKEY_CURRENT_USER, r"Software\"),
    ]
    .into_iter()
    .find_map(|(root, prefix)| {
        let key = format!("{prefix}{CLIENT}");
        let pv = reg(root, &key, "pv").filter(|v| !v.is_empty() && v != "0.0.0.0")?;
        let path = format!(r"{}\{pv}\EBWebView\{ARCH}\EmbeddedBrowserWebView.dll", reg(root, &key, "location")?);
        std::path::Path::new(&path).is_file().then_some((path, false))
    })
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// A string value from the registry.
fn reg(root: HKEY, key: &str, value: &str) -> Option<String> {
    let mut buf = [0u16; 512];
    let mut len = std::mem::size_of_val(&buf) as u32;
    let (key, value) = (wide(key), wide(value));
    let r = unsafe {
        RegGetValueW(
            root,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut len,
        )
    };
    (r == 0).then(|| String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]))
}

/// ICoreWebView2EnvironmentOptions: the browser arguments, the UI language, and the SDK version. The runtime
/// asks for the newer option interfaces too, and their defaults are what nook wants.
#[repr(C)]
struct Options {
    vt: &'static OptionsVt,
    refs: AtomicU32,
    args: Vec<u16>,
    language: Vec<u16>,
    version: Vec<u16>,
}

type Getter = unsafe extern "system" fn(*mut Options, *mut *mut u16) -> i32;
type Putter = unsafe extern "system" fn(*mut Options, usize) -> i32;

#[repr(C)]
struct OptionsVt {
    query: unsafe extern "system" fn(*mut Options, *const Guid, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut Options) -> u32,
    release: unsafe extern "system" fn(*mut Options) -> u32,
    args: Getter,
    set_args: Putter,
    language: Getter,
    set_language: Putter,
    version: Getter,
    set_version: Putter,
    sso: unsafe extern "system" fn(*mut Options, *mut i32) -> i32,
    set_sso: Putter,
}

static OPTIONS_VT: OptionsVt = OptionsVt {
    query: o_query,
    add_ref: o_add_ref,
    release: o_release,
    args: o_args,
    set_args: o_put,
    language: o_language,
    set_language: o_put,
    version: o_version,
    set_version: o_put,
    sso: o_sso,
    set_sso: o_put,
};

fn options(args: &str) -> Com {
    let mut language = [0u16; 85];
    let n = unsafe { LCIDToLocaleName(GetUserDefaultUILanguage() as u32, language.as_mut_ptr(), 85, 0x0800_0000) };
    let language = language[..n.max(1) as usize].to_vec();
    let o = Box::new(Options {
        vt: &OPTIONS_VT,
        refs: AtomicU32::new(1),
        args: wide(args),
        language,
        version: wide(TARGET_VERSION),
    });
    Com(Box::into_raw(o).cast())
}

unsafe extern "system" fn o_args(o: *mut Options, out: *mut *mut u16) -> i32 {
    *out = task_string(&(*o).args);
    S_OK
}

unsafe extern "system" fn o_language(o: *mut Options, out: *mut *mut u16) -> i32 {
    *out = task_string(&(*o).language);
    S_OK
}

unsafe extern "system" fn o_version(o: *mut Options, out: *mut *mut u16) -> i32 {
    *out = task_string(&(*o).version);
    S_OK
}

unsafe extern "system" fn o_sso(_: *mut Options, out: *mut i32) -> i32 {
    *out = 0;
    S_OK
}

unsafe extern "system" fn o_put(_: *mut Options, _: usize) -> i32 {
    E_NOTIMPL
}

unsafe extern "system" fn o_query(this: *mut Options, iid: *const Guid, out: *mut *mut c_void) -> i32 {
    if *iid == com::IID_IUNKNOWN || *iid == IID_OPTIONS {
        o_add_ref(this);
        *out = this.cast();
        S_OK
    } else {
        *out = std::ptr::null_mut();
        E_NOINTERFACE
    }
}

unsafe extern "system" fn o_add_ref(this: *mut Options) -> u32 {
    (*this).refs.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn o_release(this: *mut Options) -> u32 {
    let left = (*this).refs.fetch_sub(1, Ordering::Release) - 1;
    if left == 0 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this));
    }
    left
}
