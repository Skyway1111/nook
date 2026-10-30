//! A Linux pseudoterminal from /dev/ptmx, through the few libc calls std doesn't wrap. The ioctl and signal
//! numbers are the generic ones x86-64, arm64, and riscv share.
use std::{
    ffi::{c_char, c_int, c_long, c_ulong, CStr, OsStr, OsString},
    fs::{File, OpenOptions},
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStringExt, fs::OpenOptionsExt, process::CommandExt},
    },
    path::Path,
    process::{Child, Command},
};

extern "C" {
    fn ioctl(fd: c_int, request: c_ulong, ...) -> c_int;
    fn setsid() -> c_int;
    fn signal(signal: c_int, handler: usize) -> usize;
    fn kill(pid: c_int, signal: c_int) -> c_int;
    fn syscall(number: c_long, ...) -> c_long;
    fn getuid() -> u32;
    fn getpwuid_r(uid: u32, pwd: *mut Passwd, buf: *mut c_char, len: usize, result: *mut *mut Passwd) -> c_int;
    fn access(path: *const c_char, mode: c_int) -> c_int;
}

#[repr(C)]
struct Passwd {
    name: *mut c_char,
    passwd: *mut c_char,
    uid: u32,
    gid: u32,
    gecos: *mut c_char,
    dir: *mut c_char,
    shell: *mut c_char,
}

#[repr(C)]
struct Winsize {
    rows: u16,
    cols: u16,
    x: u16,
    y: u16,
}

const O_RDWR: c_int = 0o2;
const O_NOCTTY: c_int = 0o400;
const O_CLOEXEC: c_int = 0o2000000;
const TIOCSCTTY: c_ulong = 0x540E;
const TIOCGPGRP: c_ulong = 0x540F;
const TIOCSWINSZ: c_ulong = 0x5414;
const TIOCSPTLCK: c_ulong = 0x4004_5431;
const TIOCGPTPEER: c_ulong = 0x5441;
const SYS_CLOSE_RANGE: c_long = 436;
const CLOSE_RANGE_CLOEXEC: c_ulong = 4;
const SIGHUP: c_int = 1;
const SIG_DFL: usize = 0;
/// The signals a parent may have ignored, which a child would otherwise keep ignoring: hangup, interrupt,
/// quit, alarm, terminate, child.
const RESET: [c_int; 6] = [1, 2, 3, 14, 15, 17];

fn check(rc: c_int) -> io::Result<c_int> {
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(rc)
    }
}

fn set_size(fd: c_int, cols: u16, rows: u16) -> io::Result<()> {
    let size = Winsize { rows, cols, x: 0, y: 0 };
    check(unsafe { ioctl(fd, TIOCSWINSZ, &size) }).map(drop)
}

/// The pseudoterminal's master side and the session it leads. Dropping it hangs the session up, as closing a
/// terminal window does: the reader still holds the master open, so the kernel wouldn't.
pub struct Pty {
    master: File,
    pid: c_int,
}

impl Drop for Pty {
    fn drop(&mut self) {
        let mut fg: c_int = 0;
        unsafe {
            // A job an interactive shell runs in the foreground has a group of its own.
            if ioctl(self.master.as_raw_fd(), TIOCGPGRP, &mut fg) == 0 && fg > 0 && fg != self.pid {
                kill(-fg, SIGHUP);
            }
            kill(-self.pid, SIGHUP);
        }
    }
}

impl Pty {
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        set_size(self.master.as_raw_fd(), cols, rows)
    }
}

/// The shell's process, to wait on.
pub struct Exit(Child);

impl Exit {
    pub fn wait(mut self) {
        let _ = self.0.wait();
    }
}

/// The user's login shell from the password database, when it can run; else /bin/sh.
fn login_shell() -> OsString {
    let mut pwd: Passwd = unsafe { std::mem::zeroed() };
    let mut buf = [0 as c_char; 4096];
    let mut found = std::ptr::null_mut();
    unsafe {
        if getpwuid_r(getuid(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut found) == 0
            && !found.is_null()
            && !pwd.shell.is_null()
            && access(pwd.shell, 1) == 0
        {
            return OsString::from_vec(CStr::from_ptr(pwd.shell).to_bytes().to_vec());
        }
    }
    "/bin/sh".into()
}

/// A pseudoterminal yet to run its process: both sides.
pub struct Console {
    master: File,
    slave: File,
}

/// Opens a pseudoterminal of `cols` by `rows`.
pub fn open(cols: u16, rows: u16) -> io::Result<Console> {
    let master = OpenOptions::new().read(true).write(true).custom_flags(O_NOCTTY).open("/dev/ptmx")?;
    let m = master.as_raw_fd();
    check(unsafe { ioctl(m, TIOCSPTLCK, &0 as *const c_int) })?;
    let slave = unsafe { File::from_raw_fd(check(ioctl(m, TIOCGPTPEER, O_RDWR | O_NOCTTY | O_CLOEXEC))?) };
    set_size(m, cols, rows)?;
    Ok(Console { master, slave })
}

impl Console {
    /// Starts `program` with `args` on the terminal, as the leader of its own session: the terminal, its input,
    /// its output, and the process. The process gets nook's environment with `vars` over it.
    pub fn spawn(self, program: &str, args: &[String], cwd: &str, vars: &[(&str, OsString)]) -> io::Result<(Pty, File, File, Exit)> {
        let Console { master, slave } = self;
        let mut cmd = Command::new(program);
        cmd.args(args).envs(vars.iter().map(|(k, v)| (k, v)));
        if std::env::var_os("SHELL").is_none() {
            cmd.env("SHELL", login_shell());
        }
        let home = std::env::var_os("HOME").unwrap_or_else(|| "/".into());
        cmd.current_dir(if Path::new(cwd).is_dir() { OsStr::new(cwd) } else { &home });
        cmd.stdin(slave.try_clone()?).stdout(slave.try_clone()?).stderr(slave);
        // SAFETY: only async-signal-safe calls, between fork and exec. stdin is the terminal by now.
        unsafe {
            cmd.pre_exec(|| {
                for s in RESET {
                    signal(s, SIG_DFL);
                }
                check(setsid())?;
                check(ioctl(0, TIOCSCTTY, 0 as c_ulong))?;
                // nook's descriptors close at exec; std's own error pipe already does.
                syscall(SYS_CLOSE_RANGE, 3 as c_ulong, c_ulong::from(u32::MAX), CLOSE_RANGE_CLOEXEC);
                Ok(())
            });
        }
        let child = cmd.spawn().map_err(|e| io::Error::other(format!("can't run {program}: {e}")))?;
        drop(cmd); // its copies of the terminal side, so the output ends when the session's processes do
        let pid = child.id() as c_int;
        Ok((Pty { master: master.try_clone()?, pid }, master.try_clone()?, master, Exit(child)))
    }
}
