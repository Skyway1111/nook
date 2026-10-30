//! A Windows pseudoconsole, through the conpty.dll beside nook (with its own OpenConsole.exe), or else Windows' own.
use crate::sys::*;
use std::{
    collections::BTreeMap,
    ffi::{c_void, OsStr, OsString},
    fs::File,
    io,
    mem::{size_of, transmute},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    sync::OnceLock,
};

type Create = unsafe extern "system" fn(COORD, HANDLE, HANDLE, u32, *mut HANDLE) -> i32;
type Resize = unsafe extern "system" fn(HANDLE, COORD) -> i32;
type Close = unsafe extern "system" fn(HANDLE);

struct Fns {
    create: Create,
    resize: Resize,
    close: Close,
}

/// The pseudoconsole functions: conpty.dll's when it loads from nook's own folder, else kernel32's.
fn conpty() -> &'static Fns {
    static FNS: OnceLock<Fns> = OnceLock::new();
    FNS.get_or_init(|| {
        let system = Fns { create: CreatePseudoConsole, resize: ResizePseudoConsole, close: ClosePseudoConsole };
        let Ok(exe) = std::env::current_exe() else { return system };
        let dll = wide(exe.with_file_name("conpty.dll").as_os_str());
        // SAFETY: a full path, so no other folder is searched, and these three exports have these signatures.
        unsafe {
            let module = LoadLibraryExW(dll.as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
            if module.is_null() {
                return system;
            }
            let f = |name: &[u8]| GetProcAddress(module, name.as_ptr());
            let (c, r, x) = (f(b"CreatePseudoConsole\0"), f(b"ResizePseudoConsole\0"), f(b"ClosePseudoConsole\0"));
            if c.is_null() || r.is_null() || x.is_null() {
                return system;
            }
            Fns { create: transmute::<*const c_void, Create>(c), resize: transmute::<*const c_void, Resize>(r), close: transmute::<*const c_void, Close>(x) }
        }
    })
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain([0]).collect()
}

fn coord(cols: u16, rows: u16) -> COORD {
    COORD { X: cols as i16, Y: rows as i16 }
}

/// A pseudoconsole. Dropping it closes it, which ends every process attached to it, and can block until its
/// output is read.
pub struct Pty(HANDLE);

// SAFETY: a pseudoconsole handle is used from any thread.
unsafe impl Send for Pty {}
unsafe impl Sync for Pty {}

impl Drop for Pty {
    fn drop(&mut self) {
        unsafe { (conpty().close)(self.0) }
    }
}

impl Pty {
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        match unsafe { (conpty().resize)(self.0, coord(cols, rows)) } {
            0 => Ok(()),
            hr => Err(io::Error::other(format!("failed to resize console to {cols}x{rows}: HRESULT: {hr}"))),
        }
    }
}

/// The shell's process, to wait on.
pub struct Exit(OwnedHandle);

impl Exit {
    pub fn wait(self) {
        unsafe { WaitForSingleObject(self.0.as_raw_handle(), INFINITE) };
    }
}

fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let (mut read, mut write) = (null_mut(), null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (OwnedHandle::from_raw_handle(read), OwnedHandle::from_raw_handle(write)) })
}

/// Starts `program` with `args` in a new pseudoconsole of `cols` by `rows`: the console, its input, its output, and the
/// process. The process gets the environment a new login would, Windows' variables read fresh from the
/// registry, with `vars` over them.
pub fn spawn(program: &str, args: &[String], cwd: &str, vars: &[(&str, OsString)], cols: u16, rows: u16) -> io::Result<(Pty, File, File, Exit)> {
    let (con_in, to_con) = pipe()?;
    let (from_con, con_out) = pipe()?;
    let mut hpc = null_mut();
    let flags = PSEUDOCONSOLE_INHERIT_CURSOR | PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE;
    let hr = unsafe { (conpty().create)(coord(cols, rows), con_in.as_raw_handle(), con_out.as_raw_handle(), flags, &mut hpc) };
    if hr != 0 {
        return Err(io::Error::other(format!("failed to create a console: HRESULT {hr}")));
    }
    let pty = Pty(hpc);
    // The console holds its own copies of its ends: with ours closed, the output ends when the console does.
    drop((con_in, con_out));
    // The console starts up while the rest is built.

    let (env, block) = environment(vars);
    let get = |key: &str| env.get(key).map(|(_, v)| v.as_os_str());
    let exe = resolve(program, get("PATH"), get("PATHEXT"));
    let mut line = Vec::new();
    quote(exe.as_os_str().encode_wide(), &mut line);
    for arg in args {
        if arg.contains('\0') {
            return Err(io::Error::other(format!("a command argument holds a NUL: {arg:?}")));
        }
        line.push(b' ' as u16);
        quote(arg.encode_utf16(), &mut line);
    }
    line.push(0);
    let dir = [Some(OsStr::new(cwd)), get("USERPROFILE")].into_iter().flatten().find(|d| Path::new(d).is_dir()).map(wide);

    let mut size = 0;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
    let mut buf = vec![0usize; size.div_ceil(size_of::<usize>())];
    let list = buf.as_mut_ptr().cast::<c_void>();
    // SAFETY: the list is as large as Windows asked, and outlives CreateProcessW.
    unsafe {
        if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0 {
            return Err(io::Error::last_os_error());
        }
        let ok = UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc, size_of::<HANDLE>(), null_mut(), null());
        let mut info = PROCESS_INFORMATION::default();
        let started = ok != 0 && {
            let si = STARTUPINFOEXW {
                cb: size_of::<STARTUPINFOEXW>() as u32,
                // No std handles of nook's: the console gives the process its own.
                dwFlags: STARTF_USESTDHANDLES,
                hStdInput: INVALID_HANDLE_VALUE,
                hStdOutput: INVALID_HANDLE_VALUE,
                hStdError: INVALID_HANDLE_VALUE,
                lpAttributeList: list,
                ..Default::default()
            };
            let app = wide(exe.as_os_str());
            let flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
            let dir = dir.as_ref().map_or(null(), |d| d.as_ptr());
            CreateProcessW(app.as_ptr(), line.as_mut_ptr(), null(), null(), 0, flags, block.as_ptr().cast(), dir, &si, &mut info) != 0
        };
        let error = io::Error::last_os_error();
        DeleteProcThreadAttributeList(list);
        if !started {
            return Err(io::Error::other(format!("can't run {}: {error}", exe.display())));
        }
        CloseHandle(info.hThread);
        Ok((pty, File::from(to_con), File::from(from_con), Exit(OwnedHandle::from_raw_handle(info.hProcess))))
    }
}

/// Variables keyed by their name in capitals, as Windows compares them: each holds its own spelling and its value.
type Env = BTreeMap<String, (OsString, OsString)>;

fn put(env: &mut Env, key: OsString, value: OsString) {
    env.insert(key.to_string_lossy().to_uppercase(), (key, value));
}

/// nook's environment, then the machine's and the user's variables from the registry, then `vars`; and that,
/// as CreateProcessW takes it: `key=value` each ending in a NUL, sorted, and one more NUL.
fn environment(vars: &[(&str, OsString)]) -> (Env, Vec<u16>) {
    let mut env = Env::new();
    for (k, v) in std::env::vars_os() {
        put(&mut env, k, v);
    }
    registry(&mut env, HKEY_LOCAL_MACHINE, r"System\CurrentControlSet\Control\Session Manager\Environment");
    registry(&mut env, HKEY_CURRENT_USER, "Environment");
    for (k, v) in vars {
        put(&mut env, k.into(), v.clone());
    }
    let mut block = Vec::new();
    for (k, v) in env.values() {
        block.extend(k.encode_wide().chain([b'=' as u16]).chain(v.encode_wide()).chain([0]));
    }
    block.push(0);
    (env, block)
}

/// Lays the variables under `key` over `env`, expanding `%name%` against nook's own. The machine's USERNAME
/// is SYSTEM, so it's skipped, and the user's Path goes after the machine's.
fn registry(env: &mut Env, root: HKEY, key: &str) {
    let mut h = null_mut();
    if unsafe { RegOpenKeyExW(root, wide(OsStr::new(key)).as_ptr(), 0, KEY_READ, &mut h) } != 0 {
        return;
    }
    let mut name = vec![0u16; 16384];
    let mut data = vec![0u16; 4096];
    let mut i = 0;
    loop {
        let (mut name_len, mut kind, mut bytes) = (name.len() as u32, 0, (data.len() * 2) as u32);
        let rc = unsafe { RegEnumValueW(h, i, name.as_mut_ptr(), &mut name_len, null_mut(), &mut kind, data.as_mut_ptr().cast(), &mut bytes) };
        if rc == ERROR_MORE_DATA {
            data.resize(bytes as usize / 2 + 1, 0);
            continue;
        }
        if rc != 0 {
            break;
        }
        i += 1;
        let mut value = &data[..bytes as usize / 2];
        while let [rest @ .., 0] = value {
            value = rest;
        }
        let value = match kind {
            REG_SZ | REG_MULTI_SZ => OsString::from_wide(value),
            REG_EXPAND_SZ => expand(value),
            _ => continue,
        };
        let key = OsString::from_wide(&name[..name_len as usize]);
        let upper = key.to_string_lossy().to_uppercase();
        if root == HKEY_LOCAL_MACHINE && upper == "USERNAME" {
            continue;
        }
        let value = match env.get(&upper) {
            Some((_, path)) if root == HKEY_CURRENT_USER && upper == "PATH" => {
                let mut both = path.clone();
                both.push(";");
                both.push(value);
                both
            }
            _ => value,
        };
        env.insert(upper, (key, value));
    }
    unsafe { RegCloseKey(h) };
}

fn expand(value: &[u16]) -> OsString {
    let source: Vec<u16> = value.iter().copied().chain([0]).collect();
    let len = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), null_mut(), 0) };
    let mut out = vec![0u16; len as usize];
    unsafe { ExpandEnvironmentStringsW(source.as_ptr(), out.as_mut_ptr(), len) };
    while out.last() == Some(&0) {
        out.pop();
    }
    OsString::from_wide(&out)
}

/// Where `program` is on the child's PATH: as named when it has an extension, then with each of PATHEXT's.
/// Unfound, it stays as named.
fn resolve(program: &str, path: Option<&OsStr>, pathext: Option<&OsStr>) -> PathBuf {
    let exts = pathext.unwrap_or(OsStr::new(".EXE"));
    let named = Path::new(program).extension().is_some();
    for dir in std::env::split_paths(path.unwrap_or_default()).filter(|d| !d.as_os_str().is_empty()) {
        let exe = dir.join(program);
        if named && exe.is_file() {
            return exe;
        }
        for ext in std::env::split_paths(exts) {
            let mut with = exe.clone().into_os_string();
            with.push(ext);
            if Path::new(&with).is_file() {
                return with.into();
            }
        }
    }
    program.into()
}

/// Appends `arg` to a command line as the C runtime splits one: quoted when empty or holding a space, tab,
/// newline, vertical tab, or quote, with backslashes doubled before a quote.
fn quote(arg: impl Iterator<Item = u16> + Clone, line: &mut Vec<u16>) {
    let plain = arg.clone().next().is_some() && !arg.clone().any(|c| matches!(c, 0x20 | 0x09 | 0x0A | 0x0B | 0x22));
    if plain {
        line.extend(arg);
        return;
    }
    let slash = b'\\' as u16;
    line.push(b'"' as u16);
    let mut slashes = 0;
    for c in arg {
        if c == slash {
            slashes += 1;
            continue;
        }
        let n = if c == b'"' as u16 { slashes * 2 + 1 } else { slashes };
        line.extend(std::iter::repeat_n(slash, n));
        line.push(c);
        slashes = 0;
    }
    line.extend(std::iter::repeat_n(slash, slashes * 2));
    line.push(b'"' as u16);
}
