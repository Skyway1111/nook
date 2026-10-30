//! COM by hand: calls through vtable slots, an owning pointer, and the one callback object every WebView2
//! completion and event handler shares. Slots are numbered in the interface's declaration order: IUnknown's three
//! from 0, then IInspectable's three for a WinRT interface.
use crate::sys::{CoTaskMemAlloc, CoTaskMemFree};
use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicU32, Ordering};

pub type P = *mut c_void;

pub const S_OK: i32 = 0;
pub const S_FALSE: i32 = 1;
pub const E_NOTIMPL: i32 = 0x8000_4001_u32 as i32;
pub const E_NOINTERFACE: i32 = 0x8000_4002_u32 as i32;
pub const E_POINTER: i32 = 0x8000_4003_u32 as i32;

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Guid(u32, u16, u16, [u8; 8]);

/// A GUID written as one number: `guid(0x76eceacb_0462_4d94_ac83_423a6793775e)`.
pub const fn guid(u: u128) -> Guid {
    Guid((u >> 96) as u32, (u >> 80) as u16, (u >> 64) as u16, (u as u64).to_be_bytes())
}

pub const IID_IUNKNOWN: Guid = guid(0x00000000_0000_0000_c000_000000000046);
pub const IID_IAGILEOBJECT: Guid = guid(0x94ea2b94_e9cc_49e0_c0ff_ee64ca8f5b90);

/// Calls slot `$n` of COM object `$o`, a method that returns an HRESULT: `call!(obj, 5, arg => Type, …)`.
macro_rules! call {
    ($o:expr, $n:expr $(, $a:expr => $t:ty)*) => {{
        let o = $o as *mut ::std::ffi::c_void;
        let f: unsafe extern "system" fn(*mut ::std::ffi::c_void $(, $t)*) -> i32 =
            ::std::mem::transmute(*(*(o as *const *const usize)).add($n));
        f(o $(, $a)*)
    }};
}
pub(crate) use call;

/// An HRESULT as a Result.
pub fn ok(hr: i32) -> Result<(), i32> {
    if hr < 0 { Err(hr) } else { Ok(()) }
}

/// One reference to a COM object, released on drop.
pub struct Com(pub P);

impl Com {
    /// Takes a reference handed out through an out-parameter; E_POINTER for null.
    pub fn new(p: P) -> Result<Com, i32> {
        if p.is_null() { Err(E_POINTER) } else { Ok(Com(p)) }
    }

    pub fn query(&self, iid: &Guid) -> Result<Com, i32> {
        query(self.0, iid)
    }

    /// What the getter in slot `n` gives, an interface.
    pub fn get(&self, n: usize) -> Result<Com, i32> {
        get(self.0, n)
    }

    /// The method in slot `n`, as an `F`, for one whose signature `call!` can't name.
    pub unsafe fn at<F: Copy>(&self, n: usize) -> F {
        unsafe { *(*(self.0 as *const *const F)).add(n) }
    }

    /// What the getter in slot `n` gives, a plain value.
    pub unsafe fn value<T>(&self, n: usize) -> Result<T, i32> {
        let mut out: T = unsafe { std::mem::zeroed() };
        ok(unsafe { call!(self.0, n, &mut out => *mut T) })?;
        Ok(out)
    }

    /// The object the method in slot `n` makes from `arg`.
    pub unsafe fn make<A>(&self, n: usize, arg: A) -> Result<Com, i32> {
        let mut out = null_mut();
        ok(unsafe { call!(self.0, n, arg => A, &mut out => *mut P) })?;
        Com::new(out)
    }

    /// The raw pointer, keeping its reference: for state that lives as long as the app.
    pub fn leak(self) -> P {
        let p = self.0;
        std::mem::forget(self);
        p
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        unsafe { call!(self.0, 2) };
    }
}

/// Object `p` as interface `iid`, if it has it.
pub fn query(p: P, iid: &Guid) -> Result<Com, i32> {
    let mut out = null_mut();
    ok(unsafe { call!(p, 0, iid => *const Guid, &mut out => *mut P) })?;
    Com::new(out)
}

/// Calls getter slot `n` of `p`, of the form `get_X(out *mut P)`.
pub fn get(p: P, n: usize) -> Result<Com, i32> {
    let mut out = null_mut();
    ok(unsafe { call!(p, n, &mut out => *mut P) })?;
    Com::new(out)
}

/// Adds a reference to `p`, for a borrowed pointer a callback wants to keep.
pub fn add_ref(p: P) -> Com {
    unsafe { call!(p, 1) };
    Com(p)
}

/// A string a COM call returned through `*mut PWSTR`, freed.
pub fn take_string(p: *mut u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = unsafe {
        String::from_utf16_lossy(std::slice::from_raw_parts(p, (0..).take_while(|&i| *p.add(i) != 0).count()))
    };
    unsafe { CoTaskMemFree(p.cast()) };
    s
}

/// `s` (NUL-terminated UTF-16) copied into task memory, for a getter to return.
pub fn task_string(s: &[u16]) -> *mut u16 {
    let p = unsafe { CoTaskMemAlloc(s.len() * 2) } as *mut u16;
    if !p.is_null() {
        unsafe { std::ptr::copy_nonoverlapping(s.as_ptr(), p, s.len()) };
    }
    p
}

/// A completion or event handler: every WebView2 handler interface is IUnknown plus `Invoke(this, a, b)`.
/// For a completion `a` is the HRESULT and `b` the result; for an event, `a` is the sender and `b` the args.
/// Both are borrowed for the call.
#[repr(C)]
struct Handler {
    vt: &'static HandlerVt,
    refs: AtomicU32,
    iid: Guid,
    f: Box<dyn FnMut(usize, P) -> i32>,
}

#[repr(C)]
struct HandlerVt {
    query: unsafe extern "system" fn(*mut Handler, *const Guid, *mut P) -> i32,
    add_ref: unsafe extern "system" fn(*mut Handler) -> u32,
    release: unsafe extern "system" fn(*mut Handler) -> u32,
    invoke: unsafe extern "system" fn(*mut Handler, usize, P) -> i32,
}

static HANDLER_VT: HandlerVt = HandlerVt { query: h_query, add_ref: h_add_ref, release: h_release, invoke: h_invoke };

unsafe extern "system" fn h_query(this: *mut Handler, iid: *const Guid, out: *mut P) -> i32 {
    if *iid == IID_IUNKNOWN || *iid == (*this).iid {
        h_add_ref(this);
        *out = this.cast();
        S_OK
    } else {
        *out = null_mut();
        E_NOINTERFACE
    }
}

unsafe extern "system" fn h_add_ref(this: *mut Handler) -> u32 {
    (*this).refs.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn h_release(this: *mut Handler) -> u32 {
    let left = (*this).refs.fetch_sub(1, Ordering::Release) - 1;
    if left == 0 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this));
    }
    left
}

unsafe extern "system" fn h_invoke(this: *mut Handler, a: usize, b: P) -> i32 {
    ((*this).f)(a, b)
}

/// A handler object for interface `iid` that runs `f`. It runs on the UI thread, as WebView2 calls it there.
pub fn handler(iid: Guid, f: impl FnMut(usize, P) -> i32 + 'static) -> Com {
    let h = Box::new(Handler { vt: &HANDLER_VT, refs: AtomicU32::new(1), iid, f: Box::new(f) });
    Com(Box::into_raw(h).cast())
}

/// The HRESULT a completion handler got in `a`.
pub fn hresult(a: usize) -> i32 {
    a as u32 as i32
}
