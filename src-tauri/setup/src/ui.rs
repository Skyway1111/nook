//! Setup's one window: a task dialog that asks, shows progress while the work runs on a thread, then
//! shows how it went.

use crate::sys::*;
use crate::Fail;
use core::cell::UnsafeCell;
use core::ptr::{null, null_mut};
use core::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering::Relaxed};

pub struct Flow<'a> {
    pub title: &'a [u16],
    pub heading: &'a [u16],
    pub content: &'a [u16],
    pub go: &'a [u16],
    pub check: &'a [u16],
    pub checked: bool,
    pub busy: &'a [u16],
    pub done: &'a [u16],
    pub done_check: Option<&'a [u16]>,
    pub failed: &'a [u16],
    /// Whether nook is running, asked before the work starts.
    pub running: &'a dyn Fn() -> bool,
    /// The work, given the first page's checkbox.
    pub work: &'a dyn Fn(bool) -> Result<(), Fail>,
}

const GO: i32 = 100;
const IDOK: i32 = 1;
const IDCANCEL: usize = 2;
const OK: u32 = 1;
const CANCEL: u32 = 8;
const CLOSE: u32 = 0x20;
const CANCELABLE: u32 = 8;
const CHECKED: u32 = 0x100;
const PROGRESS: u32 = 0x200;
const OVER_PARENT: u32 = 0x1000;
const NAVIGATED: u32 = 1;
const CLICKED: u32 = 2;
const TOGGLED: u32 = 8;
const NAVIGATE: u32 = 0x465;
const BAR_POS: u32 = 0x46A;
const ENABLE: u32 = 0x46F;
const ERROR_ICON: P = 0xFFFE as P;
const WARNING_ICON: P = 0xFFFF as P;
const APP_ICON: P = 32512 as P;

/// The dialog while it shows the progress bar.
static BAR: AtomicIsize = AtomicIsize::new(0);

/// Moves the progress bar, when there is one.
pub fn progress(percent: usize) {
    let h = BAR.load(Relaxed);
    if h != 0 {
        unsafe { PostMessageW(h, BAR_POS, percent, 0) };
    }
}

struct State<'a> {
    flow: &'a Flow<'a>,
    hwnd: AtomicIsize,
    checked: AtomicBool,
    busy: AtomicBool,
    code: AtomicU32,
    pages: UnsafeCell<[TaskDialog; 3]>,
    text: UnsafeCell<crate::W>,
}

/// Shows the flow; returns the exit code (0 done, 1 cancelled, 2 failed) and the last page's checkbox.
pub fn run(flow: &Flow) -> (u32, bool) {
    let go = [Button(GO, flow.go.as_ptr())];
    let s = State {
        flow,
        hwnd: AtomicIsize::new(0),
        checked: AtomicBool::new(flow.checked),
        busy: AtomicBool::new(false),
        code: AtomicU32::new(1),
        pages: UnsafeCell::new([
            page(flow, flow.busy, w!(""), None, PROGRESS, CANCEL),
            page(flow, flow.done, w!(""), flow.done_check, CANCELABLE | CHECKED, CLOSE),
            page(flow, flow.failed, w!(""), None, CANCELABLE, CLOSE),
        ]),
        text: UnsafeCell::new(crate::W::new()),
    };
    let mut first = page(flow, flow.heading, flow.content, Some(flow.check), CANCELABLE | if flow.checked { CHECKED } else { 0 }, CANCEL);
    first.buttons = 1;
    first.button = go.as_ptr();
    first.default = GO;
    let data = &s as *const State as isize;
    unsafe {
        for p in (*s.pages.get()).iter_mut().chain([&mut first]) {
            p.data = data;
        }
        let (mut button, mut checked) = (0, 0);
        TaskDialogIndirect(&first, &mut button, null_mut(), &mut checked);
        (s.code.load(Relaxed), checked != 0)
    }
}

fn page(flow: &Flow, heading: &[u16], content: &[u16], check: Option<&[u16]>, flags: u32, common: u32) -> TaskDialog {
    TaskDialog {
        size: core::mem::size_of::<TaskDialog>() as u32,
        parent: 0,
        instance: unsafe { GetModuleHandleW(null()) },
        flags,
        common,
        title: flow.title.as_ptr(),
        icon: APP_ICON,
        heading: heading.as_ptr(),
        content: content.as_ptr(),
        buttons: 0,
        button: null(),
        default: 0,
        radios: 0,
        radio: null(),
        default_radio: 0,
        check: check.map_or(null(), |c| c.as_ptr()),
        expanded: null(),
        expand: null(),
        collapse: null(),
        footer_icon: null(),
        footer: null(),
        callback: Some(callback),
        data: 0,
        width: 0,
    }
}

unsafe extern "system" fn callback(h: H, msg: u32, wp: usize, _: isize, data: isize) -> i32 {
    let s = &*(data as *const State);
    s.hwnd.store(h, Relaxed);
    match msg {
        // Navigated: the progress page can't be cancelled.
        NAVIGATED if s.busy.load(Relaxed) => {
            SendMessageW(h, ENABLE, IDCANCEL, 0);
            0
        }
        CLICKED if s.busy.load(Relaxed) => 1,
        CLICKED if wp == GO as usize => {
            if (s.flow.running)() && !ask(s.flow, h) {
                return 1;
            }
            s.busy.store(true, Relaxed);
            SendMessageW(h, NAVIGATE, 0, &(*s.pages.get())[0] as *const TaskDialog as isize);
            BAR.store(h, Relaxed);
            CloseHandle(CreateThread(null_mut(), 0, worker, data as V, 0, null_mut()));
            1
        }
        TOGGLED => {
            s.checked.store(wp != 0, Relaxed);
            0
        }
        _ => 0,
    }
}

unsafe extern "system" fn worker(data: V) -> u32 {
    let s = &*(data as *const State);
    let result = (s.flow.work)(s.checked.load(Relaxed));
    BAR.store(0, Relaxed);
    let pages = &mut *s.pages.get();
    let next = match result {
        Ok(()) => {
            s.code.store(0, Relaxed);
            &pages[1]
        }
        Err(f) => {
            s.code.store(2, Relaxed);
            *s.text.get() = f.text();
            pages[2].content = (*s.text.get()).as_ptr();
            pages[2].icon = ERROR_ICON;
            &pages[2]
        }
    };
    s.busy.store(false, Relaxed);
    SendMessageW(s.hwnd.load(Relaxed), NAVIGATE, 0, next as *const TaskDialog as isize);
    0
}

/// Asks to close the running nook; true to go on.
unsafe fn ask(flow: &Flow, parent: H) -> bool {
    let mut p = page(flow, w!(concat!(name!(), " is running")), w!("Close it to continue?"), None, OVER_PARENT, OK | CANCEL);
    p.parent = parent;
    p.icon = WARNING_ICON;
    p.callback = None;
    let mut button = 0;
    TaskDialogIndirect(&p, &mut button, null_mut(), null_mut());
    button == IDOK
}
