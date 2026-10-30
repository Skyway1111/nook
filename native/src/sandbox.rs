//! Workers with as little power as the OS allows, for parsing files nook didn't write (pdf.rs). nook starts its own
//! program again with `WORKER` set, which no start folder can, and each worker talks to nook over a pipe each way in
//! messages: a u32 length, then the bytes. A worker takes one request at a time, and up to `MAX` run at once, so a
//! burst draws in parallel. A worker that dies, or answers nothing within `TIMEOUT`, fails its one request and is
//! ended; one idle for `IDLE` is ended too, and later requests start new ones.
use std::{
    fs::File,
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{channel, Receiver},
        Condvar, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

/// The variable that makes nook a worker.
pub const WORKER: &str = "NOOK_WORKER";
const TIMEOUT: Duration = Duration::from_secs(10);
const IDLE: Duration = Duration::from_secs(60);
/// The longest answer nook takes: a 4096-pixel square page as a PNG that didn't compress.
const MAX_REPLY: u32 = 64 << 20;
/// Workers at once: a burst of 50 pages takes 0.47 s with 4, 0.36 s with 8, and 0.56 s drawn in nook itself.
const MAX: usize = 4;

struct Worker {
    input: File,
    replies: Receiver<io::Result<Vec<u8>>>,
    last: Instant,
    /// Ends the worker when dropped.
    process: os::Process,
}

impl Worker {
    fn reply(&mut self) -> Result<Vec<u8>, String> {
        match self.replies.recv_timeout(TIMEOUT) {
            Ok(r) => r.map_err(|e| if e.kind() == io::ErrorKind::UnexpectedEof { "the sandbox ended".into() } else { e.to_string() }),
            Err(_) => Err(format!("the sandbox answered nothing in {} s", TIMEOUT.as_secs())),
        }
    }
}

struct Pool {
    /// Workers waiting for a request, the one used last at the end.
    idle: Vec<Worker>,
    /// Workers running a request, or starting.
    busy: usize,
}

static POOL: Mutex<Pool> = Mutex::new(Pool { idle: Vec::new(), busy: 0 });
static FREED: Condvar = Condvar::new();
static REAPING: AtomicBool = AtomicBool::new(false);

fn lock() -> MutexGuard<'static, Pool> {
    POOL.lock().unwrap_or_else(|e| e.into_inner())
}

/// A worker's answer to the message `parts` make. A worker that ended while idle can still look alive for a moment;
/// a request that couldn't reach it, so can't have ended it, goes to another.
pub fn ask(parts: &[&[u8]]) -> Result<Vec<u8>, String> {
    let mut retry = true;
    loop {
        let mut w = take()?;
        let sent = write(&mut w.input, parts).map_err(|e| e.to_string());
        let reply = sent.clone().and_then(|()| w.reply());
        let mut pool = lock();
        pool.busy -= 1;
        if reply.is_ok() {
            w.last = Instant::now();
            pool.idle.push(w);
        }
        FREED.notify_one();
        if sent.is_ok() || !std::mem::take(&mut retry) {
            return reply;
        }
    }
}

/// The idle worker used last, or a new one while fewer than `MAX` run; otherwise waits for one.
fn take() -> Result<Worker, String> {
    let mut pool = lock();
    loop {
        while let Some(mut w) = pool.idle.pop() {
            if w.process.alive() {
                pool.busy += 1;
                return Ok(w);
            }
        }
        if pool.busy < MAX {
            pool.busy += 1;
            drop(pool);
            return start().map_err(|e| {
                lock().busy -= 1;
                FREED.notify_one();
                format!("can't start the sandbox: {e}")
            });
        }
        pool = FREED.wait(pool).unwrap_or_else(|e| e.into_inner());
    }
}

fn start() -> io::Result<Worker> {
    let (process, input, mut output) = os::spawn()?;
    let (tx, replies) = channel();
    thread::spawn(move || loop {
        let reply = read(&mut output, MAX_REPLY);
        let end = reply.is_err();
        if tx.send(reply).is_err() || end {
            return;
        }
    });
    if !REAPING.swap(true, Ordering::Relaxed) {
        thread::spawn(reap);
    }
    Ok(Worker { input, replies, last: Instant::now(), process })
}

/// Ends each worker once it has been idle for `IDLE`, and itself once no worker is left.
fn reap() {
    let mut wait = IDLE;
    loop {
        thread::sleep(wait);
        let mut pool = lock();
        pool.idle.retain(|w| w.last.elapsed() < IDLE);
        if pool.idle.is_empty() && pool.busy == 0 {
            REAPING.store(false, Ordering::Relaxed);
            return;
        }
        wait = pool.idle.iter().map(|w| IDLE - w.last.elapsed()).min().unwrap_or(IDLE);
    }
}

/// The worker's side: answers each message with `answer`, until nook closes the pipe.
pub fn serve(mut answer: impl FnMut(Vec<u8>) -> Vec<u8>) {
    let (mut input, mut output) = os::enter();
    while let Ok(message) = read(&mut input, u32::MAX) {
        if write(&mut output, &[&answer(message)]).is_err() {
            return;
        }
    }
}

fn read(from: &mut impl Read, max: u32) -> io::Result<Vec<u8>> {
    let mut len = [0; 4];
    from.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len);
    if len > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "an answer too long"));
    }
    let mut message = vec![0; len as usize];
    from.read_exact(&mut message)?;
    Ok(message)
}

fn write(to: &mut impl Write, parts: &[&[u8]]) -> io::Result<()> {
    let len = u32::try_from(parts.iter().map(|p| p.len()).sum::<usize>()).map_err(|_| io::ErrorKind::InvalidInput)?;
    to.write_all(&len.to_le_bytes())?;
    parts.iter().try_for_each(|p| to.write_all(p))?;
    to.flush()
}

/// Windows: an AppContainer with no capabilities, built on a token with every privilege but one removed, so it reads
/// and writes only what's open to every app package (System32, not the user's files), reaches no network, and runs
/// at low integrity. Its job lets it start no process, touch no other window or the clipboard, or use over 1 GiB,
/// and ends it when nook's handle closes, as it does when nook exits.
#[cfg(windows)]
mod os {
    use crate::sys::*;
    use std::{
        ffi::c_void,
        fs::File,
        io,
        mem::size_of,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr::{null, null_mut},
    };

    /// S-1-15-2-…, what DeriveAppContainerSidFromAppContainerName gives for `nook.pdf`.
    #[rustfmt::skip]
    static CONTAINER: [u8; 40] = sid([2, 1960141305, 3500055989, 3476970580, 3134125239, 3008388048, 686267592, 1260196293]);

    const fn sid(subs: [u32; 8]) -> [u8; 40] {
        let mut s = [0; 40];
        (s[0], s[1], s[7]) = (1, 8, 15); // revision, count, SECURITY_APP_PACKAGE_AUTHORITY
        let mut i = 0;
        while i < 8 {
            let b = subs[i].to_le_bytes();
            (s[8 + 4 * i], s[9 + 4 * i], s[10 + 4 * i], s[11 + 4 * i]) = (b[0], b[1], b[2], b[3]);
            i += 1;
        }
        s
    }

    /// Exploit mitigations: no legacy extension DLLs, DLLs only from System32 and signed by Microsoft, none from a
    /// share or with a low label, strict handles, ASLR forced, and the heap ends the process on corruption.
    const MITIGATIONS: u64 = 1 << 8 | 1 << 12 | 1 << 16 | 1 << 20 | 1 << 24 | 1 << 32 | 1 << 44 | 1 << 52 | 1 << 56 | 1 << 60;

    /// Closing `job` ends the worker.
    pub struct Process {
        _job: OwnedHandle,
        process: OwnedHandle,
    }

    impl Process {
        pub fn alive(&mut self) -> bool {
            unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) == WAIT_TIMEOUT }
        }
    }

    fn check(ok: BOOL) -> io::Result<()> {
        if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }

    fn owned(h: HANDLE) -> io::Result<OwnedHandle> {
        if h.is_null() || h == INVALID_HANDLE_VALUE { Err(io::Error::last_os_error()) } else { Ok(unsafe { OwnedHandle::from_raw_handle(h) }) }
    }

    /// nook's own token, less every privilege but traverse checking, which nothing starts without, as an
    /// AppContainer's.
    fn token() -> io::Result<OwnedHandle> {
        unsafe {
            let (mut own, mut restricted, mut boxed) = (null_mut(), null_mut(), null_mut());
            check(OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &mut own))?;
            let own = owned(own)?;
            check(CreateRestrictedToken(own.as_raw_handle(), DISABLE_MAX_PRIVILEGE, 0, null(), 0, null(), 0, null(), &mut restricted))?;
            let restricted = owned(restricted)?;
            let status = NtCreateLowBoxToken(&mut boxed, restricted.as_raw_handle(), TOKEN_ALL_ACCESS, null(), CONTAINER.as_ptr(), 0, null(), 0, null());
            if status < 0 {
                return Err(io::Error::other(format!("NtCreateLowBoxToken: {status:#010x}")));
            }
            owned(boxed)
        }
    }

    fn job() -> io::Result<OwnedHandle> {
        unsafe {
            let job = owned(CreateJobObjectW(null(), null()))?;
            let limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                    | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                    | JOB_OBJECT_LIMIT_PROCESS_MEMORY,
                ActiveProcessLimit: 1,
                ProcessMemoryLimit: 1 << 30,
                ..Default::default()
            };
            let set = |class, info: *const c_void, len: usize| check(SetInformationJobObject(job.as_raw_handle(), class, info, len as u32));
            set(JobObjectExtendedLimitInformation, (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())?;
            set(JobObjectBasicUIRestrictions, (&JOB_OBJECT_UILIMIT_ALL as *const u32).cast(), 4)?;
            Ok(job)
        }
    }

    /// A pipe whose `inherited` end (0 read, 1 write) the worker may inherit.
    fn pipe(inherited: usize) -> io::Result<[OwnedHandle; 2]> {
        let (mut r, mut w) = (null_mut(), null_mut());
        check(unsafe { CreatePipe(&mut r, &mut w, null(), 0) })?;
        let ends = [owned(r)?, owned(w)?];
        check(unsafe { SetHandleInformation(ends[inherited].as_raw_handle(), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) })?;
        Ok(ends)
    }

    /// Starts the worker: its process, the pipe nook writes to it, and the pipe it answers on.
    pub fn spawn() -> io::Result<(Process, File, File)> {
        let [their_in, to_them] = pipe(0)?;
        let [from_them, their_out] = pipe(1)?;
        let (token, job) = (token()?, job()?);
        let exe = wide(std::env::current_exe()?);
        // Only what Windows' own DLLs look for.
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let env = wide(format!("{}=1\0SystemRoot={root}\0", super::WORKER));
        let inherited = [their_in.as_raw_handle(), their_out.as_raw_handle()];
        let jobs = [job.as_raw_handle()];
        let child_policy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
        let attributes: [(usize, *const c_void, usize); 4] = [
            (PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.as_ptr().cast(), size_of::<[HANDLE; 2]>()),
            (PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs.as_ptr().cast(), size_of::<HANDLE>()),
            (PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, (&MITIGATIONS as *const u64).cast(), 8),
            (PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, (&child_policy as *const u32).cast(), 4),
        ];
        unsafe {
            let mut size = 0;
            InitializeProcThreadAttributeList(null_mut(), attributes.len() as u32, 0, &mut size);
            let mut list = vec![0u64; size.div_ceil(8)];
            check(InitializeProcThreadAttributeList(list.as_mut_ptr().cast(), attributes.len() as u32, 0, &mut size))?;
            let made = attributes.iter().try_for_each(|&(attribute, value, len)| {
                check(UpdateProcThreadAttribute(list.as_mut_ptr().cast(), 0, attribute, value, len, null_mut(), null()))
            });
            let si = STARTUPINFOEXW {
                cb: size_of::<STARTUPINFOEXW>() as u32,
                dwFlags: STARTF_USESTDHANDLES,
                hStdInput: inherited[0],
                hStdOutput: inherited[1],
                lpAttributeList: list.as_mut_ptr().cast(),
                ..Default::default()
            };
            let mut pi = PROCESS_INFORMATION::default();
            // No console at all, not even a hidden one: its host would be a process outside the sandbox.
            let flags = DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
            let started = made.and_then(|()| {
                check(CreateProcessAsUserW(token.as_raw_handle(), exe.as_ptr(), null_mut(), null(), null(), 1, flags, env.as_ptr().cast(), null(), &si, &mut pi))
            });
            DeleteProcThreadAttributeList(list.as_mut_ptr().cast());
            started?;
            CloseHandle(pi.hThread);
            let process = Process { _job: job, process: owned(pi.hProcess)? };
            Ok((process, File::from(to_them), File::from(from_them)))
        }
    }

    /// The worker's pipes, its standard input and output.
    pub fn enter() -> (File, File) {
        let take = |h: std::os::windows::io::RawHandle| unsafe { File::from_raw_handle(h) };
        (take(io::stdin().as_raw_handle()), take(io::stdout().as_raw_handle()))
    }
}

/// Linux: nook's program again, with no environment, every inherited descriptor but its pipes closed, and no way to
/// gain privileges. On x86-64 a seccomp filter also refuses sockets, starting programs or processes, opening files
/// to write, changing the file system, and signalling or tracing any other process.
#[cfg(not(windows))]
mod os {
    use std::{
        ffi::{c_int, c_long, c_ulong},
        fs::File,
        io,
        os::fd::{FromRawFd, OwnedFd},
        process::{Child, Command, Stdio},
    };

    extern "C" {
        fn prctl(option: c_int, ...) -> c_int;
        fn syscall(number: c_long, ...) -> c_long;
        fn getpid() -> c_int;
        fn getppid() -> c_int;
    }

    pub struct Process(Child);

    impl Process {
        pub fn alive(&mut self) -> bool {
            matches!(self.0.try_wait(), Ok(None))
        }
    }

    impl Drop for Process {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    pub fn spawn() -> io::Result<(Process, File, File)> {
        let mut child = Command::new(std::env::current_exe()?)
            .env_clear()
            .env(super::WORKER, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let input = File::from(OwnedFd::from(child.stdin.take().ok_or(io::ErrorKind::BrokenPipe)?));
        let output = File::from(OwnedFd::from(child.stdout.take().ok_or(io::ErrorKind::BrokenPipe)?));
        Ok((Process(child), input, output))
    }

    const PR_SET_NO_NEW_PRIVS: c_int = 38;
    const PR_SET_SECCOMP: c_int = 22;
    const SECCOMP_MODE_FILTER: c_ulong = 2;
    const SYS_CLOSE_RANGE: c_long = 436;

    /// Closes what the worker inherited by mistake, locks it down, and returns its standard input and output. A
    /// thread ends it if nook does mid-page, when the pipe can't tell it.
    pub fn enter() -> (File, File) {
        unsafe {
            if syscall(SYS_CLOSE_RANGE, 3 as c_ulong, c_ulong::MAX, 0 as c_ulong) != 0 {
                (3..1024).for_each(|fd| drop(OwnedFd::from_raw_fd(fd)));
            }
            if prctl(PR_SET_NO_NEW_PRIVS, 1 as c_ulong, 0 as c_ulong, 0 as c_ulong, 0 as c_ulong) != 0 {
                std::process::exit(1);
            }
            #[cfg(target_arch = "x86_64")]
            {
                let filter = filter(getpid() as u32);
                let program = Program { len: filter.len() as u16, filter: filter.as_ptr() };
                if prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program as *const Program) != 0 {
                    std::process::exit(1);
                }
            }
            let parent = getppid();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                if getppid() != parent {
                    std::process::exit(0);
                }
            });
            (File::from_raw_fd(0), File::from_raw_fd(1))
        }
    }

    #[cfg(target_arch = "x86_64")]
    use seccomp::{filter, Program};

    #[cfg(target_arch = "x86_64")]
    mod seccomp {
        #[repr(C)]
        pub struct Insn {
            code: u16,
            jt: u8,
            jf: u8,
            k: u32,
        }

        #[repr(C)]
        pub struct Program {
            pub len: u16,
            pub filter: *const Insn,
        }

        const LOAD: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
        const JEQ: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
        const JGE: u16 = 0x35; // BPF_JMP | BPF_JGE | BPF_K
        const JSET: u16 = 0x45; // BPF_JMP | BPF_JSET | BPF_K
        const RET: u16 = 0x06; // BPF_RET | BPF_K
        const ALLOW: u32 = 0x7fff_0000;
        const KILL: u32 = 0x8000_0000; // the whole process
        const ERRNO: u32 = 0x0005_0000;
        const EPERM: u32 = 1;
        const EACCES: u32 = 13;
        const ENOSYS: u32 = 38;
        /// `struct seccomp_data`: the call's number, its architecture, then its arguments from offset 16.
        const NR: u32 = 0;
        const ARCH: u32 = 4;
        const fn arg(n: u32) -> u32 {
            16 + 8 * n
        }
        const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
        const X32: u32 = 0x4000_0000;
        /// O_WRONLY, O_RDWR, O_CREAT, O_TRUNC.
        const WRITES: u32 = 0o1 | 0o2 | 0o100 | 0o1000;
        const CLONE_THREAD: u32 = 0x10000;

        /// x86-64 calls refused outright: sockets, programs and processes, tracing, the file system's changes, namespaces,
        /// io_uring (whose work no filter sees), and the kernel's riskier corners.
        #[rustfmt::skip]
        const REFUSED: &[u32] = &[
            41, 42, 43, 49, 50, 53, 288,            // socket connect accept bind listen socketpair accept4
            57, 58, 59, 322,                        // fork vfork execve execveat
            101, 310, 311, 129, 297, 424, 434, 200, // ptrace process_vm_readv/writev rt_(tg)sigqueueinfo pidfd_send_signal pidfd_open tkill
            76, 77, 82, 83, 84, 85, 86, 87, 88,     // truncate ftruncate rename mkdir rmdir creat link unlink symlink
            90, 91, 92, 93, 94, 132, 133, 235,      // chmod fchmod chown fchown lchown utime mknod utimes
            258, 259, 260, 261, 263, 264, 265, 266, // mkdirat mknodat fchownat futimesat unlinkat renameat linkat symlinkat
            268, 280, 316, 452,                     // fchmodat utimensat renameat2 fchmodat2
            188, 189, 190, 197, 198, 199,           // setxattr lsetxattr fsetxattr removexattr lremovexattr fremovexattr
            303, 304,                               // name_to_handle_at open_by_handle_at
            155, 161, 165, 166, 272, 308,           // pivot_root chroot mount umount2 unshare setns
            425, 426, 427,                          // io_uring_setup io_uring_enter io_uring_register
            248, 249, 250, 298, 321, 323,           // add_key request_key keyctl perf_event_open bpf userfaultfd
        ];

        pub fn filter(pid: u32) -> Vec<Insn> {
            let op = |code, k, jt, jf| Insn { code, jt, jf, k };
            let mut f = vec![op(LOAD, ARCH, 0, 0), op(JEQ, AUDIT_ARCH_X86_64, 1, 0), op(RET, KILL, 0, 0), op(LOAD, NR, 0, 0)];
            f.extend([op(JGE, X32, 0, 1), op(RET, KILL, 0, 0)]);
            for &nr in REFUSED {
                f.extend([op(JEQ, nr, 0, 1), op(RET, ERRNO | EPERM, 0, 0)]);
            }
            // clone3 and openat2 take their flags by pointer, which no filter reads: glibc falls back to clone and openat.
            for nr in [435, 437] {
                f.extend([op(JEQ, nr, 0, 1), op(RET, ERRNO | ENOSYS, 0, 0)]);
            }
            // A thread may start, nothing else.
            f.extend([op(JEQ, 56, 0, 4), op(LOAD, arg(0), 0, 0), op(JSET, CLONE_THREAD, 1, 0), op(RET, ERRNO | EPERM, 0, 0), op(RET, ALLOW, 0, 0)]);
            // open and openat only to read.
            for (nr, flags) in [(2, arg(1)), (257, arg(2))] {
                f.extend([op(JEQ, nr, 0, 4), op(LOAD, flags, 0, 0), op(JSET, WRITES, 0, 1), op(RET, ERRNO | EACCES, 0, 0), op(RET, ALLOW, 0, 0)]);
            }
            // kill and tgkill only to itself, as abort() does.
            for nr in [62, 234] {
                f.extend([op(JEQ, nr, 0, 4), op(LOAD, arg(0), 0, 0), op(JEQ, pid, 1, 0), op(RET, ERRNO | EPERM, 0, 0), op(RET, ALLOW, 0, 0)]);
            }
            f.push(op(RET, ALLOW, 0, 0));
            f
        }
    }
}
