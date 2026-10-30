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

const EXE: &[u16] = w!("\\nook.exe");
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

/// A packed exe ends in 20 bytes: the stub's and the index's lengths, the files' unpacked length, and
/// its kind. The installer carries the index then the files' bytes LZMS-compressed; uninstall.exe
/// only the index.
const DATA: &[u8; 8] = b"nookdata";
const LIST: &[u8; 8] = b"nooklist";

struct Packed<'a> {
    stub: &'a [u8],
    index: &'a [u8],
    data: &'a [u8],
    raw: usize,
    kind: Option<&'a [u8; 8]>,
}

fn parts(exe: &[u8]) -> Packed<'_> {
    let t = &exe[exe.len().saturating_sub(20)..];
    let at = |i: usize| u32::from_le_bytes([t[i], t[i + 1], t[i + 2], t[i + 3]]) as usize;
    let kind = [DATA, LIST].into_iter().find(|k| t.len() == 20 && &t[12..] == *k);
    let (stub, index) = if kind.is_some() { (at(0), at(4)) } else { (exe.len(), 0) };
    let end = exe.len() - if kind.is_some() { 20 } else { 0 };
    Packed { stub: &exe[..stub], index: &exe[stub..stub + index], data: &exe[stub + index..end], raw: at(8), kind }
}

fn tail(stub: usize, index: usize, raw: usize, kind: &[u8; 8]) -> Vec<u8> {
    let mut t = Vec::with_capacity(20);
    for n in [stub, index, raw] {
        t.extend((n as u32).to_le_bytes());
    }
    t.extend(kind);
    t
}

/// The files an index lists, as (path relative to the install dir, size), in the order of their bytes.
fn index(b: &[u8]) -> Vec<(W, usize)> {
    let u32_at = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize;
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

fn fail<T>(what: &[&[u16]]) -> Result<T, Fail> {
    let code = unsafe { GetLastError() };
    Err(Fail(cat(what), code))
}

#[no_mangle]
pub extern "C" fn start() -> ! {
    unsafe { ExitProcess(main()) }
}

fn main() -> u32 {
    let args = args();
    let at = |f: &[u16]| args.iter().position(|a| eq(a, f));
    let (silent, update) = (at(w!("/S")).is_some(), at(w!("/UPDATE")).is_some());
    let (path, exe) = own();
    let p = parts(&exe);
    if let Some(i) = at(w!("--pack")) {
        return match (args.get(i + 1), args.get(i + 2)) {
            (Some(dir), Some(out)) => pack(p.stub, dir, out),
            _ => 2,
        };
    }
    match (p.kind, at(w!("--uninstall")).and_then(|i| args.get(i + 1))) {
        (Some(LIST), Some(dir)) => uninstall(&index(p.index), &trim(dir), silent, update),
        (Some(LIST), None) => relaunch(&path, &exe, silent, update),
        (Some(DATA), _) => {
            let fresh = reg(HKCU, UNINSTALL_KEY, w!("UninstallString")).is_none();
            Install { dir: install_dir(), p, update, ns: at(w!("/NS")).is_some(), fresh }.run(silent)
        }
        _ => 2,
    }
}

struct Install<'a> {
    dir: W,
    p: Packed<'a>,
    update: bool,
    ns: bool,
    fresh: bool,
}

impl Install<'_> {
    fn run(&self, silent: bool) -> u32 {
        if silent {
            return self.install(self.fresh && !self.ns && !self.update).map_or(2, |_| 0);
        }
        let files = within(&self.dir, &index(self.p.index));
        let flow = ui::Flow {
            title: w!(concat!(name!(), " Setup")),
            heading: w!(concat!("Install ", name!(), " ", version!())),
            content: &self.dir,
            go: w!("Install"),
            check: w!("Create a desktop shortcut"),
            checked: true,
            busy: w!(concat!("Installing ", name!())),
            done: w!(concat!(name!(), " is installed")),
            done_check: Some(w!(concat!("Run ", name!()))),
            failed: w!(concat!(name!(), " wasn't installed")),
            running: &|| Rm::over(&files).is_some(),
            work: &|desktop| self.install(desktop),
        };
        let (code, run) = ui::run(&flow);
        if code == 0 && run {
            let exe = cat(&[&self.dir, EXE]);
            spawn(&exe, &cat(&[w!("\""), &exe, w!("\"")]), &self.dir);
        }
        code
    }

    fn install(&self, desktop: bool) -> Result<(), Fail> {
        if !self.update {
            webview2()?;
        }
        let mut data = Vec::with_capacity(self.p.raw);
        let (mut h, mut n) = (0, 0);
        let unpacked = unsafe {
            CreateDecompressor(5, null_mut(), &mut h) != 0
                && Decompress(h, self.p.data.as_ptr(), self.p.data.len(), data.as_mut_ptr(), self.p.raw, &mut n) != 0
                && n == self.p.raw
        };
        if !unpacked {
            return fail(&[w!("This installer is damaged.")]);
        }
        unsafe { data.set_len(n) };
        ui::progress(20);
        let files = index(self.p.index);
        if let Some(rm) = Rm::over(&within(&self.dir, &files)) {
            if !rm.close() {
                return fail(&[w!(concat!("Couldn't close ", name!(), "."))]);
            }
        }
        let old = cat(&[&self.dir, UNINSTALLER]);
        let before = read(&old).map_or(Vec::new(), |exe| match parts(&exe) {
            Packed { kind: Some(LIST), index: i, .. } => index(i),
            _ => {
                // An NSIS install: its own uninstaller removes what it put there and keeps the shortcuts.
                let cmd = cat(&[w!("\""), &old, w!("\" /S /UPDATE _?="), &self.dir]);
                spawn(&old, &cmd, &self.dir).map(wait);
                Vec::new()
            }
        });
        dirs(&cat(&[&self.dir, w!("\\")]), 3);
        let mut at = 0;
        for (path, size) in &files {
            let full = cat(&[&self.dir, w!("\\"), path]);
            dirs(&full, self.dir.len());
            if !write(&full, &[&data[at..at + size]]) {
                return fail(&[w!("Couldn't write "), &full]);
            }
            at += size;
            ui::progress(20 + 70 * at / n.max(1));
        }
        let gone: Vec<W> = before.into_iter().map(|(p, _)| p).filter(|p| !files.iter().any(|(q, _)| eq(p, q))).collect();
        remove(&self.dir, &gone);
        let (stub, list) = (self.p.stub, self.p.index);
        if !write(&old, &[stub, list, &tail(stub.len(), list.len(), 0, LIST)]) {
            return fail(&[w!("Couldn't write "), &old]);
        }
        self.register((n + stub.len() + list.len() + 20) / 1024)?;
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

    /// The keys an NSIS install wrote: the install dir, the Apps entry, and "Open with nook" on folders.
    fn register(&self, kb: usize) -> Result<(), Fail> {
        let exe = cat(&[&self.dir, EXE]);
        let quoted = |s: &[u16]| cat(&[w!("\""), s, w!("\"")]);
        let ok = set(DIR_KEY, &[(w!(""), Val::Str(&self.dir))])
            && set(
                UNINSTALL_KEY,
                &[
                    (w!("MainBinaryName"), Val::Str(w!("nook.exe"))),
                    (w!("DisplayName"), Val::Str(w!(name!()))),
                    (w!("DisplayIcon"), Val::Str(&quoted(&exe))),
                    (w!("DisplayVersion"), Val::Str(w!(version!()))),
                    (w!("Publisher"), Val::Str(w!(name!()))),
                    (w!("InstallLocation"), Val::Str(&quoted(&self.dir))),
                    (w!("UninstallString"), Val::Str(&quoted(&cat(&[&self.dir, UNINSTALLER])))),
                    (w!("NoModify"), Val::Dword(1)),
                    (w!("NoRepair"), Val::Dword(1)),
                    (w!("EstimatedSize"), Val::Dword(kb as u32)),
                ],
            )
            && MENU_KEYS.iter().all(|k| {
                set(k, &[(w!(""), Val::Str(w!(concat!("Open with ", name!())))), (w!("Icon"), Val::Str(&exe))])
                    && set(&cat(&[k, w!("\\command")]), &[(w!(""), Val::Str(&cat(&[&quoted(&exe), w!(" \"%V\"")])))])
            });
        if ok {
            Ok(())
        } else {
            fail(&[w!("Couldn't write the registry.")])
        }
    }
}

/// `/D=<dir>`, which takes the rest of the line, or where an earlier install went, or `%LOCALAPPDATA%\nook`.
fn install_dir() -> W {
    let line = unsafe { core::slice::from_raw_parts(GetCommandLineW(), len(GetCommandLineW())) };
    if let Some(i) = line.windows(4).position(|s| s == [b' ' as u16, b'/' as u16, b'D' as u16, b'=' as u16]) {
        return trim(&line[i + 4..]);
    }
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
    if unsafe { URLDownloadToFileW(null_mut(), url.as_ptr(), file.as_ptr(), 0, null_mut()) } != 0 {
        return fail(&[w!("Couldn't download WebView2.")]);
    }
    let code = spawn(&file, &cat(&[w!("\""), &file, w!("\" /silent /install")]), &temp()).map(wait);
    unsafe { DeleteFileW(file.as_ptr()) };
    if code == Some(0) {
        Ok(())
    } else {
        fail(&[w!("WebView2 didn't install.")])
    }
}

/// From the uninstall.exe in the install dir: runs a copy from %TEMP%, so this file can go too. The
/// copy stays there, as NSIS's does; Windows 11 refuses every way an exe could delete itself.
fn relaunch(path: &[u16], exe: &[u8], silent: bool, update: bool) -> u32 {
    let dir = &path[..path.iter().rposition(|&c| c == b'\\' as u16).unwrap_or(0)];
    let copy = cat(&[&temp(), w!(concat!(name!(), "-uninstall.exe"))]);
    let flags: &[u16] = match (silent, update) {
        (true, true) => w!(" /S /UPDATE"),
        (true, false) => w!(" /S"),
        (false, true) => w!(" /UPDATE"),
        _ => w!(""),
    };
    let cmd = cat(&[w!("\""), &copy, w!("\" --uninstall \""), dir, w!("\""), flags]);
    if write(&copy, &[exe]) && spawn(&copy, &cmd, &temp()).is_some() {
        0
    } else {
        2
    }
}

fn uninstall(files: &[(W, usize)], dir: &W, silent: bool, update: bool) -> u32 {
    let full = within(dir, files);
    let work = |data: bool| -> Result<(), Fail> {
        if let Some(rm) = Rm::over(&full) {
            if !rm.close() {
                return fail(&[w!(concat!("Couldn't close ", name!(), "."))]);
            }
        }
        let paths: Vec<W> = files.iter().map(|(p, _)| p.clone()).collect();
        remove(dir, &paths);
        ui::progress(50);
        // The uninstall.exe that started this copy may still be exiting.
        let me = cat(&[dir, UNINSTALLER]);
        for _ in 0..50 {
            if unsafe { DeleteFileW(me.as_ptr()) != 0 || GetLastError() == 2 } {
                break;
            }
            unsafe { Sleep(100) };
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
                for at in [&ROAMING, &LOCAL] {
                    let mut d = cat(&[&known(at), w!(concat!("\\", id!()))]);
                    d.push(0);
                    let mut op = FileOp { hwnd: 0, func: 3, from: d.as_ptr(), to: null(), flags: 0x614, aborted: 0, mappings: null_mut(), title: null() };
                    SHFileOperationW(&mut op);
                }
            }
        }
        ui::progress(100);
        Ok(())
    };
    if silent {
        return work(false).map_or(2, |_| 0);
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
        running: &|| Rm::over(&full).is_some(),
        work: &work,
    };
    ui::run(&flow).0
}

fn within(dir: &[u16], files: &[(W, usize)]) -> Vec<W> {
    files.iter().map(|(p, _)| cat(&[dir, w!("\\"), p])).collect()
}

/// Deletes the files, then each folder they leave empty, deepest first.
fn remove(dir: &[u16], paths: &[W]) {
    let mut dirs: Vec<W> = Vec::new();
    for p in paths {
        unsafe { DeleteFileW(cat(&[dir, w!("\\"), p]).as_ptr()) };
        for (i, _) in p.iter().enumerate().filter(|(_, &c)| c == b'\\' as u16) {
            let d = cat(&[dir, w!("\\"), &p[..i]]);
            if !dirs.iter().any(|e| eq(e, &d)) {
                dirs.push(d);
            }
        }
    }
    dirs.sort_unstable_by_key(|d| usize::MAX - d.len());
    for d in dirs {
        unsafe { RemoveDirectoryW(d.as_ptr()) };
    }
}

/// `setup --pack <dir> <out.exe>`: the stub, the index of every file under `dir`, then their bytes
/// LZMS-compressed as one block, then the trailer.
fn pack(stub: &[u8], dir: &[u16], out: &[u16]) -> u32 {
    let root = trim(dir);
    let mut paths = Vec::new();
    walk(&root, &[0], &mut paths);
    paths.sort_unstable();
    let mut list = Vec::new();
    list.extend((paths.len() as u32).to_le_bytes());
    let mut raw = Vec::new();
    for p in &paths {
        let Some(bytes) = read(&cat(&[&root, w!("\\"), p])) else { return 2 };
        list.extend((bytes.len() as u32).to_le_bytes());
        list.extend(((p.len() - 1) as u16).to_le_bytes());
        list.extend(p[..p.len() - 1].iter().flat_map(|c| c.to_le_bytes()));
        raw.extend(bytes);
    }
    let mut packed: Vec<u8> = Vec::with_capacity(raw.len() + raw.len() / 2 + 65536);
    let (mut h, mut n) = (0, 0);
    let block = raw.len().max(1 << 20) as u32;
    let ok = unsafe {
        CreateCompressor(5, null_mut(), &mut h) != 0
            && SetCompressorInformation(h, 1, &block as *const u32 as V, 4) != 0
            && Compress(h, raw.as_ptr(), raw.len(), packed.as_mut_ptr(), packed.capacity(), &mut n) != 0
    };
    if !ok {
        return 2;
    }
    unsafe { packed.set_len(n) };
    if !write(&trim(out), &[stub, &list, &packed, &tail(stub.len(), list.len(), raw.len(), DATA)]) {
        return 2;
    }
    let mut line = Vec::new();
    for (s, v) in [(&b"files "[..], paths.len()), (b", raw ", raw.len()), (b", packed ", n), (b", exe ", stub.len() + list.len() + n + 20)] {
        line.extend_from_slice(s);
        line.extend(dec(v));
    }
    line.push(b'\n');
    unsafe { WriteFile(GetStdHandle(-11i32 as u32), line.as_ptr(), line.len() as u32, &mut 0, null_mut()) };
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
            if d.attributes & 0x10 != 0 {
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

/// A Restart Manager session over files some process has open.
struct Rm(u32);

impl Rm {
    fn over(files: &[W]) -> Option<Rm> {
        let (mut h, mut key) = (0, [0u16; 33]);
        if unsafe { RmStartSession(&mut h, 0, key.as_mut_ptr()) } != 0 {
            return None;
        }
        let rm = Rm(h);
        let ptrs: Vec<P> = files.iter().map(|f| f.as_ptr()).collect();
        let (mut need, mut n, mut why) = (0, 0, 0);
        unsafe {
            (RmRegisterResources(h, ptrs.len() as u32, ptrs.as_ptr(), 0, null_mut(), 0, null_mut()) == 0
                && RmGetList(h, &mut need, &mut n, null_mut(), &mut why) == 234)
                .then_some(rm)
        }
    }

    /// Closes those processes, forcing any that don't respond.
    fn close(&self) -> bool {
        unsafe { RmShutdown(self.0, 1, null_mut()) == 0 }
    }
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
        core::mem::transmute::<usize, unsafe extern "system" fn(Com $(, $t)*) -> i32>(*(*($o as *const *const usize)).add($i))($o $(, $a)*)
    };
}

const SHELL_LINK: Guid = guid(0x00021401_0000_0000_C000_000000000046);
const ISHELL_LINK: Guid = guid(0x000214F9_0000_0000_C000_000000000046);
const IPERSIST_FILE: Guid = guid(0x0000010B_0000_0000_C000_000000000046);
const IPROPERTY_STORE: Guid = guid(0x886D8EEB_8CF2_4446_8D02_CDBA1DBDCF99);
const START_PIN: Guid = guid(0xA2A9545D_A0C2_42B4_9708_A0B2BADD77C8);
const IPINNED_LIST: Guid = guid(0x4CD19ADA_25A5_4A32_B3B7_347BEE5BE36B);
const ISHELL_ITEM: Guid = guid(0x43826D1E_E718_42EE_BC55_A1E261C37BFE);

#[repr(C)]
struct PropKey(Guid, u32);
const AUMID: PropKey = PropKey(guid(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3), 5);

#[repr(C)]
struct PropVariant(u16, [u16; 3], P, usize);

fn create(clsid: &Guid, iid: &Guid) -> Option<Com> {
    let mut o = null_mut();
    unsafe {
        CoInitializeEx(null_mut(), 2);
        (CoCreateInstance(clsid, null_mut(), 1, iid, &mut o) >= 0).then_some(o)
    }
}

/// Saves a shortcut to `target` that starts in `dir` and carries nook's AppUserModelID, which
/// taskbar pins match on.
fn lnk(path: &[u16], target: &[u16], dir: &[u16]) -> bool {
    let Some(sl) = create(&SHELL_LINK, &ISHELL_LINK) else { return false };
    unsafe {
        com!(sl, 20, target.as_ptr() => P);
        com!(sl, 9, dir.as_ptr() => P);
        let (mut ps, mut pf) = (null_mut(), null_mut());
        let mut ok = com!(sl, 0, &IPROPERTY_STORE => *const Guid, &mut ps => *mut Com) >= 0;
        if ok {
            let id = PropVariant(31, [0; 3], w!(id!()).as_ptr(), 0);
            ok = com!(ps, 6, &AUMID => *const PropKey, &id => *const PropVariant) >= 0 && com!(ps, 7) >= 0;
            com!(ps, 2);
        }
        if ok && com!(sl, 0, &IPERSIST_FILE => *const Guid, &mut pf => *mut Com) >= 0 {
            ok = com!(pf, 6, path.as_ptr() => P, 1 => i32) >= 0;
            com!(pf, 2);
        }
        com!(sl, 2);
        ok
    }
}

/// Where a shortcut points.
fn lnk_target(path: &[u16]) -> Option<W> {
    let sl = create(&SHELL_LINK, &ISHELL_LINK)?;
    let mut buf = [0u16; 260];
    unsafe {
        let mut pf = null_mut();
        let ok = com!(sl, 0, &IPERSIST_FILE => *const Guid, &mut pf => *mut Com) >= 0 && {
            let ok = com!(pf, 5, path.as_ptr() => P, 0 => u32) >= 0 && com!(sl, 3, buf.as_mut_ptr() => *mut u16, 260 => i32, null_mut::<u8>() => *mut u8, 4 => u32) == 0;
            com!(pf, 2);
            ok
        };
        com!(sl, 2);
        ok.then(|| cat(&[&buf]))
    }
}

/// Takes a shortcut off the Start menu's and the taskbar's pins.
fn unpin(path: &[u16]) {
    let Some(pins) = create(&START_PIN, &IPINNED_LIST) else { return };
    unsafe {
        let mut item = null_mut();
        if SHCreateItemFromParsingName(path.as_ptr(), null_mut(), &ISHELL_ITEM, &mut item) >= 0 {
            com!(pins, 3, item => Com);
            com!(item, 2);
        }
        com!(pins, 2);
    }
}

enum Val<'a> {
    Str(&'a [u16]),
    Dword(u32),
}

/// Writes values under an HKCU key, creating it.
fn set(key: &[u16], values: &[(&[u16], Val)]) -> bool {
    let mut h = 0;
    if unsafe { RegCreateKeyExW(HKCU, key.as_ptr(), 0, null(), 0, 0x2, null_mut(), &mut h, null_mut()) } != 0 {
        return false;
    }
    let ok = values.iter().all(|(name, v)| {
        let (kind, data, n) = match v {
            Val::Str(s) => (1, s.as_ptr() as *const u8, 2 * (len(s.as_ptr()) + 1)),
            Val::Dword(d) => (4, d as *const u32 as *const u8, 4),
        };
        unsafe { RegSetValueExW(h, name.as_ptr(), 0, kind, data, n as u32) == 0 }
    });
    unsafe { RegCloseKey(h) };
    ok
}

/// A string value, if the key has it.
fn reg(root: H, key: &[u16], name: &[u16]) -> Option<W> {
    let mut buf = [0u16; 1024];
    let mut n = 2048;
    (unsafe { RegGetValueW(root, key.as_ptr(), name.as_ptr(), 0x2, null_mut(), buf.as_mut_ptr() as V, &mut n) } == 0).then(|| cat(&[&buf]))
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

/// This exe's path and bytes.
fn own() -> (W, Vec<u8>) {
    let mut buf = [0u16; 1024];
    unsafe { GetModuleFileNameW(0, buf.as_mut_ptr(), 1024) };
    let path = cat(&[&buf]);
    let bytes = read(&path).unwrap_or_default();
    (path, bytes)
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
        let h = CreateFileW(path.as_ptr(), 0x8000_0000, 5, null_mut(), 3, 0, 0);
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
        let h = CreateFileW(path.as_ptr(), 0x4000_0000, 0, null_mut(), 2, 0x80, 0);
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

fn dec(mut n: usize) -> Vec<u8> {
    let mut v = Vec::new();
    loop {
        v.insert(0, b'0' + (n % 10) as u8);
        n /= 10;
        if n == 0 {
            return v;
        }
    }
}
