//! nook's Windows installer and uninstaller, one exe. `setup --pack <dir> <out.exe>` appends `<dir>`,
//! LZMS-compressed, to a copy of this exe, and that copy installs it for the current user. The
//! uninstall.exe it leaves is this exe again, carrying the list of installed files instead.
#![no_std]
#![no_main]
#![windows_subsystem = "windows"]

extern crate alloc;

use alloc::vec::Vec;
use core::ptr::{null, null_mut};
use sys::*;

/// Who gets installed. setup/build.rs sets these, so a test build never meets the real install.
macro_rules! name {
    () => {
        env!("NOOK_NAME")
    };
}
macro_rules! id {
    () => {
        env!("NOOK_ID")
    };
}
macro_rules! version {
    () => {
        env!("NOOK_VERSION")
    };
}

/// A NUL-terminated UTF-16 constant from an ASCII literal.
macro_rules! w {
    ($s:expr) => {{
        const S: &str = $s;
        const A: [u16; S.len() + 1] = crate::wide(S);
        &A
    }};
}

const fn wide<const N: usize>(s: &str) -> [u16; N] {
    let (b, mut a, mut i) = (s.as_bytes(), [0; N], 0);
    while i < b.len() {
        assert!(b[i] < 128);
        a[i] = b[i] as u16;
        i += 1;
    }
    a
}

mod sys;
mod ui;

/// A NUL-terminated UTF-16 string.
type W = Vec<u16>;

/// The payload's main binary.
macro_rules! exe {
    () => {
        "nook.exe"
    };
}

const EXE: &[u16] = w!(concat!("\\", exe!()));
const UNINSTALLER: &[u16] = w!("\\uninstall.exe");
const DIR_KEY: &[u16] = w!(concat!("Software\\", name!(), "\\", name!()));
const VENDOR_KEY: &[u16] = w!(concat!("Software\\", name!()));
const UNINSTALL_KEY: &[u16] = w!(concat!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\", name!()));
const MENU_KEYS: [&[u16]; 2] = [
    w!(concat!("Software\\Classes\\Directory\\shell\\", name!())),
    w!(concat!("Software\\Classes\\Directory\\Background\\shell\\", name!())),
];
const LNK: &[u16] = w!(concat!("\\", name!(), ".lnk"));
const WEBVIEW2: &[u16] = w!("\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}");

const LOCAL: Guid = guid(0xF1B32785_6FBA_4FCF_9D55_7B8E7F157091);
const ROAMING: Guid = guid(0x3EB685DB_65F9_4CF6_A03A_E3EF65729F3D);
const PROGRAMS: Guid = guid(0xA77F5D77_2E2B_44C3_A6A2_ABA601054A51);
const DESKTOP: Guid = guid(0xB4BFCC3A_DB2C_424C_B029_7FE99A87C641);

/// A packed exe ends in 24 bytes: the stub's and the index's lengths, the LZMS data's unpacked length,
/// a CRC32 of every byte before it, and its kind. The installer carries the index, then the files
/// LZMS can't shrink as they are, then the rest LZMS-compressed; uninstall.exe only the index.
const DATA: &[u8; 8] = b"nookdata";
const LIST: &[u8; 8] = b"nooklist";

struct Packed<'a> {
    stub: &'a [u8],
    index: &'a [u8],
    data: &'a [u8],
    raw: usize,
    kind: &'static [u8; 8],
}

/// A packed exe's parts, when it ends in a trailer whose CRC holds.
fn parts(exe: &[u8]) -> Option<Packed<'_>> {
    let n = exe.len().checked_sub(24)?;
    let at = |i: usize| u32_at(exe, n + i);
    let kind = [DATA, LIST].into_iter().find(|k| exe[n + 16..] == k[..])?;
    let (stub, index) = (at(0), at(4));
    (crc(0, &exe[..n + 12]) == at(12) as u32).then(|| Packed { stub: &exe[..stub], index: &exe[stub..stub + index], data: &exe[stub + index..n], raw: at(8), kind })
}

/// Writes a packed exe: `body` is the stub, the index, then the data.
fn seal(path: &[u16], body: &[&[u8]], raw: usize, kind: &[u8; 8]) -> bool {
    let mut t = Vec::with_capacity(24);
    for n in [body[0].len(), body[1].len(), raw] {
        t.extend((n as u32).to_le_bytes());
    }
    let c = crc(body.iter().fold(0, |c, b| crc(c, b)), &t);
    t.extend(c.to_le_bytes());
    t.extend(kind);
    write(path, &[body, &[&t]].concat())
}

fn crc(c: u32, b: &[u8]) -> u32 {
    unsafe { RtlComputeCrc32(c, b.as_ptr(), b.len() as u32) }
}

fn u32_at(b: &[u8], i: usize) -> usize {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize
}

/// The files an index lists, as (path relative to the install dir, size), in the order of their bytes.
fn index(b: &[u8]) -> Vec<(W, usize)> {
    let u32_at = |i| u32_at(b, i);
    let (mut at, mut v) = (4, Vec::new());
    for _ in 0..if b.is_empty() { 0 } else { u32_at(0) } {
        let (size, chars) = (u32_at(at), u16::from_le_bytes([b[at + 4], b[at + 5]]) as usize);
        let mut p: W = b[at + 6..at + 6 + 2 * chars].as_chunks::<2>().0.iter().map(|&c| u16::from_le_bytes(c)).collect();
        p.push(0);
        v.push((p, size));
        at += 6 + 2 * chars;
    }
    v
}

/// Why a step failed, and the Win32 error.
pub struct Fail(pub W, pub u32);

impl Fail {
    /// The message, then the error: in decimal, or in hex for an HRESULT.
    pub fn text(&self) -> W {
        let code: W = match self.1 {
            0 => return self.0.clone(),
            c if c >> 31 == 1 => b"0x".iter().chain(&digits(c as usize, 16)).map(|&b| b as u16).collect(),
            c => digits(c as usize, 10).iter().map(|&b| b as u16).collect(),
        };
        cat(&[&self.0, w!(" (error "), &code, w!(")")])
    }
}

/// A silent run's exit code; a failure also goes to stderr, as UTF-8.
fn exit(r: Result<(), Fail>) -> u32 {
    let Err(f) = r else { return 0 };
    let text = f.text();
    let mut out = [0u8; 2048];
    unsafe {
        let n = WideCharToMultiByte(UTF8, 0, text.as_ptr(), text.len() as i32 - 1, out.as_mut_ptr(), 2047, null(), null_mut()) as usize;
        out[n] = b'\n';
        WriteFile(GetStdHandle(STD_ERROR), out.as_ptr(), n as u32 + 1, &mut 0, null_mut());
    }
    2
}

fn fail<T>(what: &[&[u16]]) -> Result<T, Fail> {
    let code = unsafe { GetLastError() };
    Err(Fail(cat(what), code))
}

/// A failure before any work: an error box, or under /S a line on stderr.
fn refuse(silent: bool, f: Fail) -> u32 {
    if !silent {
        ui::error(&f.text());
    }
    exit(Err(f))
}

#[no_mangle]
pub extern "C" fn start() -> ! {
    unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
        ExitProcess(main())
    }
}

fn main() -> u32 {
    let args = args();
    let at = |f: &[u16]| args.iter().position(|a| eq(a, f));
    let (silent, update) = (at(w!("/S")).is_some(), at(w!("/UPDATE")).is_some());
    let (path, exe) = own();
    if let Some(i) = at(w!("--pack")) {
        return match (args.get(i + 1), args.get(i + 2)) {
            (Some(dir), Some(out)) => pack(parts(exe).map_or(exe, |p| p.stub), dir, out),
            _ => 2,
        };
    }
    let Some(p) = parts(exe) else { return refuse(silent, Fail(cat(&[w!("This installer is damaged. Download it again.")]), 0)) };
    if p.kind == DATA {
        let previous = reg(HKCU, UNINSTALL_KEY, w!("UninstallString"));
        return Install { dir: rest(w!(" /D=")).unwrap_or_else(install_dir), p, update, ns: at(w!("/NS")).is_some(), previous }.run(silent);
    }
    let files = index(p.index);
    // NSIS's way to run an uninstaller in place, which an NSIS installer takes on an upgrade.
    if let Some(dir) = rest(w!(" _?=")) {
        return uninstall(&files, &dir, silent, update, true);
    }
    match at(w!("--uninstall")).and_then(|i| args.get(i + 1)) {
        Some(dir) => uninstall(&files, &trim(dir), silent, update, false),
        None => relaunch(&path, exe, silent, update),
    }
}

struct Install<'a> {
    dir: W,
    p: Packed<'a>,
    update: bool,
    ns: bool,
    /// The registered uninstaller of an earlier install.
    previous: Option<W>,
}

impl Install<'_> {
    fn run(&self, silent: bool) -> u32 {
        if silent {
            return exit(self.install(self.previous.is_none() && !self.ns && !self.update));
        }
        let files = binaries(&self.dir, &index(self.p.index));
        let flow = ui::Flow {
            title: w!(concat!(name!(), " Setup")),
            heading: w!(concat!("Install ", name!(), " ", version!())),
            content: &self.dir,
            go: w!("Install"),
            check: w!("Create a desktop shortcut"),
            checked: true,
            busy: w!(concat!("Installing ", name!())),
            done: w!(concat!(name!(), " is installed")),
            // Run elevated, nook would be too, and Explorer couldn't drop files on it.
            done_check: (!elevated()).then_some(w!(concat!("Run ", name!()))),
            failed: w!(concat!(name!(), " wasn't installed")),
            running: &|| running(&files),
            work: &|desktop| self.install(desktop),
        };
        let (code, run) = ui::run(&flow);
        if code == 0 && run {
            let exe = cat(&[&self.dir, EXE]);
            spawn(&exe, &quote(&exe), &self.dir);
        }
        code
    }

    fn install(&self, desktop: bool) -> Result<(), Fail> {
        if !self.update {
            webview2()?;
        }
        let files = index(self.p.index);
        let total: usize = files.iter().map(|f| f.1).sum();
        let (plain, packed) = self.p.data.split_at(total - self.p.raw);
        let mut data = Vec::with_capacity(self.p.raw);
        let (mut h, mut n) = (0, 0);
        let unpacked = self.p.raw == 0
            || unsafe {
                CreateDecompressor(LZMS, null_mut(), &mut h) != 0
                    && Decompress(h, packed.as_ptr(), packed.len(), data.as_mut_ptr(), self.p.raw, &mut n) != 0
                    && n == self.p.raw
            };
        if !unpacked {
            return fail(&[w!("This installer is damaged.")]);
        }
        unsafe { data.set_len(n) };
        ui::progress(20);
        close(&binaries(&self.dir, &files))?;
        let old = cat(&[&self.dir, UNINSTALLER]);
        let before = read(&old).map_or(Vec::new(), |exe| match parts(&exe) {
            Some(Packed { kind: LIST, index: i, .. }) => index(i),
            // The NSIS install registered here: its own uninstaller removes what it put there and keeps the shortcuts.
            _ if self.previous.as_ref().is_some_and(|u| eq(u, &quote(&old))) => {
                let cmd = cat(&[&quote(&old), w!(" /S /UPDATE _?="), &self.dir]);
                spawn(&old, &cmd, &self.dir).map(wait);
                Vec::new()
            }
            _ => Vec::new(),
        });
        dirs(&cat(&[&self.dir, w!("\\")]), 3);
        let mut at = 0;
        for (path, size) in &files {
            let full = cat(&[&self.dir, w!("\\"), path]);
            dirs(&full, self.dir.len());
            let bytes = if at < plain.len() { &plain[at..at + size] } else { &data[at - plain.len()..][..*size] };
            if !write(&full, &[bytes]) {
                return fail(&[w!("Couldn't write "), &full]);
            }
            at += size;
            ui::progress(20 + 70 * at / total.max(1));
        }
        let gone: Vec<_> = before.into_iter().filter(|(p, _)| !files.iter().any(|(q, _)| eq(p, q))).collect();
        remove(&self.dir, &gone);
        let (stub, list) = (self.p.stub, self.p.index);
        if !seal(&old, &[stub, list], 0, LIST) {
            return fail(&[w!("Couldn't write "), &old]);
        }
        self.register((total + stub.len() + list.len() + 24) / 1024)?;
        let exe = cat(&[&self.dir, EXE]);
        if !self.ns && !self.update {
            lnk(&cat(&[&known(&PROGRAMS), LNK]), &exe, &self.dir);
        }
        if desktop {
            lnk(&cat(&[&known(&DESKTOP), LNK]), &exe, &self.dir);
        }
        ui::progress(100);
        Ok(())
    }

    /// The install dir, the Apps entry, and "Open with nook" on folders, under the keys earlier
    /// installs used.
    fn register(&self, kb: usize) -> Result<(), Fail> {
        let exe = cat(&[&self.dir, EXE]);
        set(DIR_KEY, &[(w!(""), Val::Str(&self.dir))])?;
        set(
            UNINSTALL_KEY,
            &[
                (w!("MainBinaryName"), Val::Str(w!(exe!()))),
                (w!("DisplayName"), Val::Str(w!(name!()))),
                (w!("DisplayIcon"), Val::Str(&quote(&exe))),
                (w!("DisplayVersion"), Val::Str(w!(version!()))),
                (w!("Publisher"), Val::Str(w!(name!()))),
                (w!("InstallLocation"), Val::Str(&quote(&self.dir))),
                (w!("UninstallString"), Val::Str(&quote(&cat(&[&self.dir, UNINSTALLER])))),
                (w!("NoModify"), Val::Dword(1)),
                (w!("NoRepair"), Val::Dword(1)),
                (w!("EstimatedSize"), Val::Dword(kb as u32)),
            ],
        )?;
        for k in MENU_KEYS {
            set(k, &[(w!(""), Val::Str(w!(concat!("Open with ", name!())))), (w!("Icon"), Val::Str(&exe))])?;
            set(&cat(&[k, w!("\\command")]), &[(w!(""), Val::Str(&cat(&[&quote(&exe), w!(" \"%V\"")])))])?;
        }
        Ok(())
    }
}

/// What follows ` <flag>` on the command line, to its end, as NSIS reads `/D=` and `_?=`.
fn rest(flag: &[u16]) -> Option<W> {
    let line = unsafe { core::slice::from_raw_parts(GetCommandLineW(), len(GetCommandLineW())) };
    let f = &flag[..flag.len() - 1];
    line.windows(f.len()).position(|s| s == f).map(|i| trim(&line[i + f.len()..]))
}

/// Where an earlier install went, or `%LOCALAPPDATA%\nook`.
fn install_dir() -> W {
    reg(HKCU, DIR_KEY, w!("")).map_or_else(|| cat(&[&known(&LOCAL), w!(concat!("\\", name!()))]), |d| trim(&d))
}

/// Installs the WebView2 runtime through Microsoft's bootstrapper when no copy is registered.
fn webview2() -> Result<(), Fail> {
    let has = |root, base: &[u16]| reg(root, &cat(&[base, WEBVIEW2]), w!("pv")).is_some_and(|v| v[0] != 0 && !eq(&v, w!("0.0.0.0")));
    if has(HKLM, w!("SOFTWARE\\WOW6432Node")) || has(HKCU, w!("Software")) {
        return Ok(());
    }
    let file = cat(&[&temp(), w!("MicrosoftEdgeWebview2Setup.exe")]);
    let url = w!("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
    let hr = unsafe { URLDownloadToFileW(null_mut(), url.as_ptr(), file.as_ptr(), 0, null_mut()) };
    if hr != 0 {
        return Err(Fail(cat(&[w!("Couldn't download WebView2.")]), hr as u32));
    }
    let code = spawn(&file, &cat(&[&quote(&file), w!(" /silent /install")]), &temp()).map_or_else(|| unsafe { GetLastError() }, wait);
    unsafe { DeleteFileW(file.as_ptr()) };
    match code {
        0 => Ok(()),
        c => Err(Fail(cat(&[w!("WebView2 didn't install.")]), c)),
    }
}

/// From the uninstall.exe in the install dir: runs a copy from %TEMP%, so this file can go too. The
/// copy stays there; Windows 11 refuses every way an exe could delete itself. A copy elsewhere, such
/// as that one, finds no install beside it and stops.
fn relaunch(path: &[u16], exe: &[u8], silent: bool, update: bool) -> u32 {
    let dir = &path[..path.iter().rposition(|&c| c == b'\\' as u16).unwrap_or(0)];
    let ours = |u: W| eq(&u, &quote(path));
    if unsafe { GetFileAttributesW(cat(&[dir, EXE]).as_ptr()) } == u32::MAX && !reg(HKCU, UNINSTALL_KEY, w!("UninstallString")).is_some_and(ours) {
        return refuse(silent, Fail(cat(&[w!(concat!(name!(), " isn't installed in ")), dir]), 0));
    }
    let copy = cat(&[&temp(), w!(concat!(name!(), "-uninstall.exe"))]);
    let flags: &[u16] = match (silent, update) {
        (true, true) => w!(" /S /UPDATE"),
        (true, false) => w!(" /S"),
        (false, true) => w!(" /UPDATE"),
        _ => w!(""),
    };
    let cmd = cat(&[&quote(&copy), w!(" --uninstall "), &quote(dir), flags]);
    if !write(&copy, &[exe]) || spawn(&copy, &cmd, &temp()).is_none() {
        return refuse(silent, Fail(cat(&[w!("Couldn't start "), &copy]), unsafe { GetLastError() }));
    }
    0
}

/// Uninstalls from `dir`. Run in place, this file stays, as NSIS's `_?=` leaves its own.
fn uninstall(files: &[(W, usize)], dir: &W, silent: bool, update: bool, in_place: bool) -> u32 {
    let held = binaries(dir, files);
    let work = |data: bool| -> Result<(), Fail> {
        close(&held)?;
        remove(dir, files);
        ui::progress(50);
        if !in_place {
            // The uninstall.exe that started this copy may still be exiting.
            let me = cat(&[dir, UNINSTALLER]);
            for _ in 0..50 {
                if unsafe { DeleteFileW(me.as_ptr()) != 0 || GetLastError() == 2 } {
                    break;
                }
                unsafe { Sleep(100) };
            }
        }
        unsafe { RemoveDirectoryW(dir.as_ptr()) };
        if !update {
            let exe = cat(&[dir, EXE]);
            for at in [&PROGRAMS, &DESKTOP] {
                let l = cat(&[&known(at), LNK]);
                if lnk_target(&l).is_some_and(|t| eq(&t, &exe)) {
                    unpin(&l);
                    unsafe { DeleteFileW(l.as_ptr()) };
                }
            }
        }
        unsafe {
            RegDeleteTreeW(HKCU, UNINSTALL_KEY.as_ptr());
            for k in MENU_KEYS {
                RegDeleteTreeW(HKCU, k.as_ptr());
            }
            if data && !update {
                RegDeleteTreeW(HKCU, DIR_KEY.as_ptr());
                RegDeleteKeyW(HKCU, VENDOR_KEY.as_ptr());
                // The WebView2 processes of a nook just closed hold its profile for a moment longer.
                for at in [&ROAMING, &LOCAL] {
                    let mut d = cat(&[&known(at), w!(concat!("\\", id!()))]);
                    d.push(0);
                    for _ in 0..50 {
                        let mut op = FileOp { hwnd: 0, func: FO_DELETE, from: d.as_ptr(), to: null(), flags: FOF_NO_UI, aborted: 0, mappings: null_mut(), title: null() };
                        SHFileOperationW(&mut op);
                        if GetFileAttributesW(d.as_ptr()) == u32::MAX {
                            break;
                        }
                        Sleep(100);
                    }
                }
            }
        }
        ui::progress(100);
        Ok(())
    };
    if silent {
        return exit(work(false));
    }
    let flow = ui::Flow {
        title: w!(concat!(name!(), " Uninstall")),
        heading: w!(concat!("Uninstall ", name!())),
        content: dir,
        go: w!("Uninstall"),
        check: w!("Delete app data"),
        checked: false,
        busy: w!(concat!("Uninstalling ", name!())),
        done: w!(concat!(name!(), " is uninstalled")),
        done_check: None,
        failed: w!(concat!(name!(), " wasn't uninstalled")),
        running: &|| running(&held),
        work: &work,
    };
    ui::run(&flow).0
}

/// The payload's programs and libraries under `dir`: the files a running nook holds open.
fn binaries(dir: &[u16], files: &[(W, usize)]) -> Vec<W> {
    let binary = |p: &W| eq(&p[p.len() - 5..], w!(".exe")) || eq(&p[p.len() - 5..], w!(".dll"));
    files.iter().map(|(p, _)| cat(&[dir, w!("\\"), p])).filter(binary).collect()
}

/// Deletes the files, and each folder above one that it leaves empty, up to `dir`.
fn remove(dir: &[u16], files: &[(W, usize)]) {
    for (p, _) in files {
        let mut path = cat(&[dir, w!("\\"), p]);
        unsafe { DeleteFileW(path.as_ptr()) };
        while let Some(i) = path.iter().rposition(|&c| c == b'\\' as u16).filter(|&i| i >= dir.len()) {
            path.truncate(i);
            path.push(0);
            if unsafe { RemoveDirectoryW(path.as_ptr()) } == 0 {
                break;
            }
        }
    }
}

/// `setup --pack <dir> <out.exe>`: the stub, the index of every file under `dir`, the files whose
/// first 256 KB LZMS can't shrink by 1% as they are, then the rest LZMS-compressed as one block, then
/// the trailer.
fn pack(stub: &[u8], dir: &[u16], out: &[u16]) -> u32 {
    let root = trim(dir);
    let mut paths = Vec::new();
    walk(&root, &[0], &mut paths);
    paths.sort_unstable();
    let mut files = Vec::new();
    for p in paths {
        let Some(bytes) = read(&cat(&[&root, w!("\\"), &p])) else { return 2 };
        files.push((p, bytes));
    }
    let mut h = 0;
    let block = files.iter().map(|f| f.1.len()).sum::<usize>().max(1 << 20) as u32;
    if unsafe { CreateCompressor(LZMS, null_mut(), &mut h) == 0 || SetCompressorInformation(h, BLOCK_SIZE, &block as *const u32 as V, 4) == 0 } {
        return 2;
    }
    let lzms = |raw: &[u8]| {
        let (mut out, mut n) = (Vec::with_capacity(raw.len() + raw.len() / 2 + 65536), 0);
        (raw.is_empty() || unsafe { Compress(h, raw.as_ptr(), raw.len(), out.as_mut_ptr(), out.capacity(), &mut n) } != 0).then(|| {
            unsafe { out.set_len(n) };
            out
        })
    };
    let n = files.len();
    let (stored, shrunk): (Vec<_>, Vec<_>) = files.into_iter().partition(|f| {
        let head = &f.1[..f.1.len().min(1 << 18)];
        lzms(head).is_none_or(|c| 100 * c.len() >= 99 * head.len())
    });
    let (mut list, mut plain, mut raw) = (Vec::new(), Vec::new(), Vec::new());
    list.extend((n as u32).to_le_bytes());
    for (data, files) in [(&mut plain, stored), (&mut raw, shrunk)] {
        for (p, bytes) in files {
            list.extend((bytes.len() as u32).to_le_bytes());
            list.extend(((p.len() - 1) as u16).to_le_bytes());
            list.extend(p[..p.len() - 1].iter().flat_map(|c| c.to_le_bytes()));
            data.extend(bytes);
        }
    }
    let Some(packed) = lzms(&raw) else { return 2 };
    unsafe { CloseCompressor(h) };
    if !seal(&trim(out), &[stub, &list, &plain, &packed], raw.len(), DATA) {
        return 2;
    }
    let mut line = Vec::new();
    let exe = stub.len() + list.len() + plain.len() + packed.len() + 24;
    for (s, v) in [(&b"files "[..], n), (b", stored ", plain.len()), (b", raw ", raw.len()), (b", packed ", packed.len()), (b", exe ", exe)] {
        line.extend_from_slice(s);
        line.extend(digits(v, 10));
    }
    line.push(b'\n');
    unsafe { WriteFile(GetStdHandle(STD_OUTPUT), line.as_ptr(), line.len() as u32, &mut 0, null_mut()) };
    0
}

/// Relative paths of the files under `root\rel`, recursively.
fn walk(root: &[u16], rel: &[u16], out: &mut Vec<W>) {
    let mut d = unsafe { core::mem::zeroed::<FindData>() };
    let h = unsafe { FindFirstFileW(cat(&[root, w!("\\"), rel, w!("*")]).as_ptr(), &mut d) };
    if h == INVALID {
        return;
    }
    loop {
        let name = &d.name[..len(d.name.as_ptr())];
        if name != [b'.' as u16] && name != [b'.' as u16, b'.' as u16] {
            let p = cat(&[rel, name]);
            if d.attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
                walk(root, &cat(&[&p, w!("\\")]), out);
            } else {
                out.push(p);
            }
        }
        if unsafe { FindNextFileW(h, &mut d) } == 0 {
            break;
        }
    }
    unsafe { FindClose(h) };
}

/// A Restart Manager session over a set of files.
struct Rm(u32);

impl Rm {
    fn over(files: &[W]) -> Option<Rm> {
        let (mut h, mut key) = (0, [0u16; 33]);
        if unsafe { RmStartSession(&mut h, 0, key.as_mut_ptr()) } != 0 {
            return None;
        }
        let rm = Rm(h);
        let ptrs: Vec<P> = files.iter().map(|f| f.as_ptr()).collect();
        (unsafe { RmRegisterResources(h, ptrs.len() as u32, ptrs.as_ptr(), 0, null_mut(), 0, null_mut()) } == 0).then_some(rm)
    }

    /// Whether some process has one of the files open.
    fn busy(&self) -> bool {
        let (mut need, mut n, mut why) = (0, 0, 0);
        unsafe { RmGetList(self.0, &mut need, &mut n, null_mut(), &mut why) == ERROR_MORE_DATA }
    }
}

fn running(files: &[W]) -> bool {
    Rm::over(files).is_some_and(|rm| rm.busy())
}

/// Closes every process that has one of the files open, forcing any that don't respond. A console
/// host the Restart Manager can't close goes on its own once nook has, so this waits up to 5 s, asking
/// fresh sessions: one that has shut processes down goes on listing them.
fn close(files: &[W]) -> Result<(), Fail> {
    let Some(rm) = Rm::over(files).filter(Rm::busy) else { return Ok(()) };
    let code = unsafe { RmShutdown(rm.0, RM_FORCE_SHUTDOWN, null_mut()) };
    for _ in 0..50 {
        if !running(files) {
            return Ok(());
        }
        unsafe { Sleep(100) };
    }
    Err(Fail(cat(&[w!(concat!("Couldn't close ", name!(), "."))]), code))
}

impl Drop for Rm {
    fn drop(&mut self) {
        unsafe { RmEndSession(self.0) };
    }
}

type Com = *mut core::ffi::c_void;

/// Calls method `i` of a COM object's vtable.
macro_rules! com {
    ($o:expr, $i:expr $(, $a:expr => $t:ty)*) => {
        core::mem::transmute::<usize, unsafe extern "system" fn(Com $(, $t)*) -> i32>(*(*($o.0 as *const *const usize)).add($i))($o.0 $(, $a)*)
    };
}

/// A COM interface, released when dropped.
struct Obj(Com);

impl Drop for Obj {
    fn drop(&mut self) {
        unsafe { com!(self, 2) };
    }
}

/// The interface a call puts in its out-parameter, when it succeeds.
fn out(call: impl FnOnce(*mut Com) -> i32) -> Option<Obj> {
    let mut o = null_mut();
    (call(&mut o) >= 0 && !o.is_null()).then(|| Obj(o))
}

fn create(clsid: &Guid, iid: &Guid) -> Option<Obj> {
    out(|o| unsafe {
        CoInitializeEx(null_mut(), COINIT_APARTMENTTHREADED);
        CoCreateInstance(clsid, null_mut(), CLSCTX_INPROC_SERVER, iid, o)
    })
}

const SHELL_LINK: Guid = guid(0x00021401_0000_0000_C000_000000000046);
const ISHELL_LINK: Guid = guid(0x000214F9_0000_0000_C000_000000000046);
const IPERSIST_FILE: Guid = guid(0x0000010B_0000_0000_C000_000000000046);
const IPERSIST_STREAM: Guid = guid(0x00000109_0000_0000_C000_000000000046);
const IPROPERTY_STORE: Guid = guid(0x886D8EEB_8CF2_4446_8D02_CDBA1DBDCF99);
const START_PIN: Guid = guid(0xA2A9545D_A0C2_42B4_9708_A0B2BADD77C8);
const IPINNED_LIST: Guid = guid(0x4CD19ADA_25A5_4A32_B3B7_347BEE5BE36B);
const ISHELL_ITEM: Guid = guid(0x43826D1E_E718_42EE_BC55_A1E261C37BFE);

#[repr(C)]
struct PropKey(Guid, u32);
const AUMID: PropKey = PropKey(guid(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3), 5);

#[repr(C)]
struct PropVariant(u16, [u16; 3], P, usize);

/// Saves a shortcut to `target` that starts in `dir` and carries nook's AppUserModelID, which
/// taskbar pins match on. It saves through a stream: IPersistFile::Save would open the target, and
/// Defender holds a new nook.exe a moment while it scans it.
fn lnk(path: &[u16], target: &[u16], dir: &[u16]) -> bool {
    let Some(sl) = create(&SHELL_LINK, &ISHELL_LINK) else { return false };
    unsafe {
        com!(sl, 20, target.as_ptr() => P);
        com!(sl, 9, dir.as_ptr() => P);
        com!(sl, 18, path.as_ptr() => P, 0 => u32);
        let id = PropVariant(VT_LPWSTR, [0; 3], w!(id!()).as_ptr(), 0);
        let saved = out(|o| com!(sl, 0, &IPROPERTY_STORE => *const Guid, o => *mut Com)).is_some_and(|ps| com!(ps, 6, &AUMID => *const PropKey, &id => *const PropVariant) >= 0 && com!(ps, 7) >= 0)
            && out(|o| com!(sl, 0, &IPERSIST_STREAM => *const Guid, o => *mut Com)).is_some_and(|ps| {
                out(|o| SHCreateStreamOnFileEx(path.as_ptr(), STGM_CREATE_WRITE, 0, 1, null_mut(), o)).is_some_and(|st| com!(ps, 6, st.0 => Com, 1 => i32) >= 0)
            });
        if saved {
            SHChangeNotify(SHCNE_CREATE, SHCNF_PATHW, path.as_ptr(), null());
        }
        saved
    }
}

/// Where a shortcut points.
fn lnk_target(path: &[u16]) -> Option<W> {
    let sl = create(&SHELL_LINK, &ISHELL_LINK)?;
    let mut buf = [0u16; 260];
    unsafe {
        let pf = out(|o| com!(sl, 0, &IPERSIST_FILE => *const Guid, o => *mut Com))?;
        (com!(pf, 5, path.as_ptr() => P, 0 => u32) >= 0 && com!(sl, 3, buf.as_mut_ptr() => *mut u16, 260 => i32, null_mut::<u8>() => *mut u8, 4 => u32) == 0).then(|| cat(&[&buf]))
    }
}

/// Takes a shortcut off the Start menu's and the taskbar's pins.
fn unpin(path: &[u16]) {
    let Some(pins) = create(&START_PIN, &IPINNED_LIST) else { return };
    unsafe {
        if let Some(item) = out(|o| SHCreateItemFromParsingName(path.as_ptr(), null_mut(), &ISHELL_ITEM, o)) {
            com!(pins, 3, item.0 => Com);
        }
    }
}

/// Whether setup runs elevated, so a nook it started would too.
fn elevated() -> bool {
    let (mut t, mut e) = (0, 0u32);
    unsafe {
        let ok = OpenProcessToken(-1, TOKEN_QUERY, &mut t) != 0 && GetTokenInformation(t, TOKEN_ELEVATION, &mut e as *mut u32 as V, 4, &mut 0) != 0;
        CloseHandle(t);
        ok && e != 0
    }
}

enum Val<'a> {
    Str(&'a [u16]),
    Dword(u32),
}

/// Writes values under an HKCU key, creating it.
fn set(key: &[u16], values: &[(&[u16], Val)]) -> Result<(), Fail> {
    let mut h = 0;
    let mut code = unsafe { RegCreateKeyExW(HKCU, key.as_ptr(), 0, null(), 0, KEY_SET_VALUE, null_mut(), &mut h, null_mut()) };
    for (name, v) in values {
        let (kind, data, n) = match v {
            Val::Str(s) => (REG_SZ, s.as_ptr() as *const u8, 2 * (len(s.as_ptr()) + 1)),
            Val::Dword(d) => (REG_DWORD, d as *const u32 as *const u8, 4),
        };
        if code == 0 {
            code = unsafe { RegSetValueExW(h, name.as_ptr(), 0, kind, data, n as u32) };
        }
    }
    unsafe { RegCloseKey(h) };
    match code {
        0 => Ok(()),
        c => Err(Fail(cat(&[w!("Couldn't write HKCU\\"), key]), c)),
    }
}

/// A string value, if the key has it.
fn reg(root: H, key: &[u16], name: &[u16]) -> Option<W> {
    let mut buf = [0u16; 1024];
    let mut n = 2048;
    (unsafe { RegGetValueW(root, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, null_mut(), buf.as_mut_ptr() as V, &mut n) } == 0).then(|| cat(&[&buf]))
}

fn known(id: &Guid) -> W {
    let mut p = null_mut();
    unsafe {
        SHGetKnownFolderPath(id, 0, 0, &mut p);
        let w = cat(&[core::slice::from_raw_parts(p, len(p))]);
        CoTaskMemFree(p as V);
        w
    }
}

/// %TEMP%, ending in a backslash.
fn temp() -> W {
    let mut buf = [0u16; 261];
    unsafe { GetTempPathW(261, buf.as_mut_ptr()) };
    cat(&[&buf])
}

/// This exe's path, and its bytes mapped read-only.
fn own() -> (W, &'static [u8]) {
    let mut buf = [0u16; 1024];
    unsafe {
        GetModuleFileNameW(0, buf.as_mut_ptr(), 1024);
        let path = cat(&[&buf]);
        let (h, mut size) = (CreateFileW(path.as_ptr(), GENERIC_READ, SHARE_READ_DELETE, null_mut(), OPEN_EXISTING, 0, 0), 0);
        GetFileSizeEx(h, &mut size);
        let at = MapViewOfFile(CreateFileMappingW(h, null_mut(), PAGE_READONLY, 0, 0, null()), FILE_MAP_READ, 0, 0, 0);
        (path, if at.is_null() { &[] } else { core::slice::from_raw_parts(at as *const u8, size as usize) })
    }
}

fn args() -> Vec<W> {
    let mut n = 0;
    unsafe {
        let v = CommandLineToArgvW(GetCommandLineW(), &mut n);
        (1..n as usize).map(|i| cat(&[core::slice::from_raw_parts(*v.add(i), len(*v.add(i)))])).collect()
    }
}

fn read(path: &[u16]) -> Option<Vec<u8>> {
    unsafe {
        let h = CreateFileW(path.as_ptr(), GENERIC_READ, SHARE_READ_DELETE, null_mut(), OPEN_EXISTING, 0, 0);
        if h == INVALID {
            return None;
        }
        let mut size = 0;
        GetFileSizeEx(h, &mut size);
        let mut v: Vec<u8> = Vec::with_capacity(size as usize);
        let mut n = 0;
        let ok = ReadFile(h, v.as_mut_ptr(), size as u32, &mut n, null_mut()) != 0 && n as i64 == size;
        CloseHandle(h);
        ok.then(|| {
            v.set_len(n as usize);
            v
        })
    }
}

fn write(path: &[u16], parts: &[&[u8]]) -> bool {
    unsafe {
        let h = CreateFileW(path.as_ptr(), GENERIC_WRITE, SHARE_READ, null_mut(), CREATE_ALWAYS, 0, 0);
        if h == INVALID {
            return false;
        }
        let ok = parts.iter().all(|p| WriteFile(h, p.as_ptr(), p.len() as u32, &mut 0, null_mut()) != 0);
        CloseHandle(h) != 0 && ok
    }
}

/// Creates each folder above `path` from its `from`th character on.
fn dirs(path: &[u16], from: usize) {
    for (i, _) in path.iter().enumerate().skip(from).filter(|(_, &c)| c == b'\\' as u16) {
        unsafe { CreateDirectoryW(cat(&[&path[..i]]).as_ptr(), null_mut()) };
    }
}

fn spawn(app: &[u16], cmd: &[u16], dir: &[u16]) -> Option<H> {
    let mut cmd = cat(&[cmd]);
    let mut pi = ProcessInfo::default();
    unsafe {
        (CreateProcessW(app.as_ptr(), cmd.as_mut_ptr(), null_mut(), null_mut(), 0, 0, null_mut(), dir.as_ptr(), &STARTUP, &mut pi) != 0).then(|| {
            CloseHandle(pi.thread);
            pi.process
        })
    }
}

/// Waits for a process and returns its exit code.
fn wait(p: H) -> u32 {
    let mut code = 1;
    unsafe {
        WaitForSingleObject(p, u32::MAX);
        GetExitCodeProcess(p, &mut code);
        CloseHandle(p);
    }
    code
}

/// Joins strings, each up to its NUL, and ends the result with one.
fn cat(parts: &[&[u16]]) -> W {
    let mut v = W::new();
    for p in parts {
        v.extend(p.iter().take_while(|&&c| c != 0));
    }
    v.push(0);
    v
}

fn quote(s: &[u16]) -> W {
    cat(&[w!("\""), s, w!("\"")])
}

/// A path without trailing slashes or spaces.
fn trim(p: &[u16]) -> W {
    let mut v = cat(&[p]);
    v.pop();
    while v.last().is_some_and(|&c| c == b'\\' as u16 || c == b'/' as u16 || c == b' ' as u16) {
        v.pop();
    }
    v.push(0);
    v
}

fn len(p: P) -> usize {
    let mut n = 0;
    while unsafe { *p.add(n) } != 0 {
        n += 1;
    }
    n
}

/// Equal ignoring case, as Windows compares paths.
fn eq(a: &[u16], b: &[u16]) -> bool {
    unsafe { CompareStringOrdinal(a.as_ptr(), -1, b.as_ptr(), -1, 1) == 2 }
}

fn digits(mut n: usize, base: usize) -> Vec<u8> {
    let mut v = Vec::new();
    loop {
        v.insert(0, b"0123456789ABCDEF"[n % base]);
        n /= base;
        if n == 0 {
            return v;
        }
    }
}
