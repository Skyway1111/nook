//! A tab's console, which nook serves itself (`console`), and the process started in it.
use crate::{console, sys::*};
use std::{
    collections::BTreeMap,
    ffi::{c_void, OsStr, OsString},
    io,
    mem::size_of,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    time::Instant,
};

/// A console with its process running.
pub struct Pty(console::Console);

impl Pty {
    /// Sends what programs write to `output`, from the first byte they wrote.
    pub fn output(&self, output: console::Sink) {
        self.0.output(output)
    }

    /// The tab's keys, and the terminal's answers.
    pub fn write(&self, keys: &str) -> io::Result<()> {
        self.0.write(keys);
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        self.0.resize(cols, rows)
    }

    /// When `tick` is next due: while the console waits on the terminal's answer to a resize.
    pub fn due(&self) -> Option<Instant> {
        self.0.due()
    }

    pub fn tick(&self) {
        self.0.tick()
    }

    /// Ends every process attached to the console, and blocks meanwhile.
    pub fn close(&self) {
        self.0.close()
    }
}

/// The shell's process, to wait on.
pub struct Exit(OwnedHandle);

impl Exit {
    pub fn wait(self) {
        unsafe { WaitForSingleObject(self.0.as_raw_handle(), INFINITE) };
    }
}

/// A console yet to run its process.
pub struct Console(console::Console);

/// Opens a console of `cols` by `rows`.
pub fn open(cols: u16, rows: u16) -> io::Result<Console> {
    // A parent's "ignore Ctrl+C" would pass on to every process in it.
    unsafe { SetConsoleCtrlHandler(null(), 0) };
    console::Console::open(cols, rows).map(Console)
}

impl Console {
    /// Starts `program` with `args` in the console: the console, and the process. The process gets the environment
    /// a new login would, Windows' variables read fresh from the registry, with `vars` over them.
    pub fn spawn(mut self, program: &str, args: &[String], cwd: &str, vars: &[(&str, OsString)]) -> io::Result<(Pty, Exit)> {
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
        // SAFETY: the list is as large as Windows asked, and outlives CreateProcessW, as does the console it names.
        unsafe {
            if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0 {
                return Err(io::Error::last_os_error());
            }
            let ok = UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, self.0.attribute(), size_of::<HANDLE>(), null_mut(), null());
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
                let app = wide(&exe);
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
            self.0.started();
            Ok((Pty(self.0), Exit(OwnedHandle::from_raw_handle(info.hProcess))))
        }
    }
}

/// Variables keyed by their name in capitals, as Windows compares them: each holds its own spelling and its value.
type Env = BTreeMap<String, (OsString, OsString)>;

/// A name in capitals as Windows compares names: through its own table, one UTF-16 unit for one.
fn upper(name: impl Iterator<Item = u16>) -> String {
    char::decode_utf16(name.map(|c| unsafe { RtlUpcaseUnicodeChar(c) })).map(|c| c.unwrap_or('\u{FFFD}')).collect()
}

fn put(env: &mut Env, key: OsString, value: OsString) {
    env.insert(upper(key.encode_wide()), (key, value));
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
    if unsafe { RegOpenKeyExW(root, wide(key).as_ptr(), 0, KEY_READ, &mut h) } != 0 {
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
        let caps = upper(name[..name_len as usize].iter().copied());
        if root == HKEY_LOCAL_MACHINE && caps == "USERNAME" {
            continue;
        }
        let key = OsString::from_wide(&name[..name_len as usize]);
        let value = match env.get(&caps) {
            Some((_, path)) if root == HKEY_CURRENT_USER && caps == "PATH" => {
                let mut both = path.clone();
                both.push(";");
                both.push(value);
                both
            }
            _ => value,
        };
        env.insert(caps, (key, value));
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
/// Unfound, it stays as named. Each folder is read once, for the names that start with `program`.
fn resolve(program: &str, path: Option<&OsStr>, pathext: Option<&OsStr>) -> PathBuf {
    let exts = pathext.map_or(".EXE".into(), OsStr::to_string_lossy);
    let named = Path::new(program).extension().map(|_| program.to_string());
    let names: Vec<String> = named.into_iter().chain(exts.split(';').filter(|e| !e.is_empty()).map(|e| format!("{program}{e}"))).collect();
    let keys: Vec<String> = names.iter().map(|n| upper(Path::new(n).file_name().unwrap_or_default().encode_wide())).collect();
    for dir in std::env::split_paths(path.unwrap_or_default()).filter(|d| !d.as_os_str().is_empty()) {
        let files = files(&dir.join(format!("{program}*")));
        if let Some(i) = keys.iter().position(|k| files.contains(k)) {
            return dir.join(&names[i]);
        }
    }
    program.into()
}

/// The names, in capitals, of the files (not folders) `pattern` matches.
fn files(pattern: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut data = WIN32_FIND_DATAW::default();
    // SAFETY: `data` is the struct Windows fills, and the search is closed once.
    unsafe {
        let find = FindFirstFileExW(wide(pattern).as_ptr(), FindExInfoBasic, &mut data, FindExSearchNameMatch, null(), 0);
        if find == INVALID_HANDLE_VALUE {
            return found;
        }
        loop {
            if data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
                let len = data.cFileName.iter().position(|&c| c == 0).unwrap_or(data.cFileName.len());
                found.push(upper(data.cFileName[..len].iter().copied()));
            }
            if FindNextFileW(find, &mut data) == 0 {
                break;
            }
        }
        FindClose(find);
    }
    found
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
