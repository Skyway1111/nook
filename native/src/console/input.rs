//! What the terminal sends, as the console's input records: keys.js's sequences, and plain text.
use crate::sys::{MapVirtualKeyW, VkKeyScanW};

pub const SHIFT: u32 = 0x10;
pub const LCTRL: u32 = 0x08;
pub const RCTRL: u32 = 0x04;
pub const LALT: u32 = 0x02;
const ENHANCED: u32 = 0x100;

/// A KEY_EVENT_RECORD.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Key {
    pub down: i32,
    pub repeat: u16,
    pub vk: u16,
    pub scan: u16,
    pub ch: u16,
    pub state: u32,
}

/// An INPUT_RECORD: a key, or a new size.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Rec {
    pub kind: u16,
    pad: u16,
    pub ev: [u8; 16],
}

pub const KEY_EVENT: u16 = 1;
pub const SIZE_EVENT: u16 = 4;

impl Rec {
    pub fn key(k: Key) -> Rec {
        // SAFETY: Key is 16 bytes of plain data.
        Rec { kind: KEY_EVENT, pad: 0, ev: unsafe { std::mem::transmute::<Key, [u8; 16]>(k) } }
    }

    pub fn size(cols: i16, rows: i16) -> Rec {
        let mut ev = [0; 16];
        ev[..2].copy_from_slice(&cols.to_le_bytes());
        ev[2..4].copy_from_slice(&rows.to_le_bytes());
        Rec { kind: SIZE_EVENT, pad: 0, ev }
    }

    /// A record as a client wrote it: its kind, then the event.
    pub fn from_bytes(b: &[u8; 20]) -> Rec {
        let mut ev = [0; 16];
        ev.copy_from_slice(&b[4..]);
        Rec { kind: u16::from_le_bytes([b[0], b[1]]), pad: 0, ev }
    }

    pub fn as_key(&self) -> Option<Key> {
        // SAFETY: a key event's 16 bytes are a Key, and any bytes are a valid Key.
        (self.kind == KEY_EVENT).then(|| unsafe { std::mem::transmute::<[u8; 16], Key>(self.ev) })
    }
}

fn press(vk: u16, ch: u16, state: u32, out: &mut Vec<Rec>) {
    let scan = unsafe { MapVirtualKeyW(vk as u32, 0) } as u16;
    let k = Key { down: 1, repeat: 1, vk, scan, ch, state };
    out.push(Rec::key(k));
    out.push(Rec::key(Key { down: 0, ..k }));
}

/// A character typed: the key that makes it on the user's layout, with the modifiers that layout needs.
fn type_char(ch: u16, extra: u32, out: &mut Vec<Rec>) {
    let scan = unsafe { VkKeyScanW(ch) };
    let (vk, state) = if scan == -1 {
        (0, 0)
    } else {
        let m = (scan >> 8) as u32;
        ((scan & 0xff) as u16, (if m & 1 != 0 { SHIFT } else { 0 }) | (if m & 2 != 0 { LCTRL } else { 0 }) | (if m & 4 != 0 { LALT } else { 0 }))
    };
    press(vk, ch, state | extra, out);
}

/// Modifiers from xterm's parameter: 1 + shift 1, alt 2, ctrl 4.
fn mods(p: u32) -> u32 {
    let m = p.saturating_sub(1);
    (if m & 1 != 0 { SHIFT } else { 0 }) | (if m & 2 != 0 { LALT } else { 0 }) | (if m & 4 != 0 { LCTRL } else { 0 })
}

/// The sequence at the start of `s`, if it is one the terminal sends: (length, vk, ch, state). A vk of 0 is a
/// sequence that makes no key, such as a focus report, a mouse report, or a paste's brackets.
fn sequence(s: &[u16]) -> Option<(usize, u16, u16, u32)> {
    let ss3 = s.get(1) == Some(&(b'O' as u16));
    if s.first() != Some(&0x1b) || s.get(1) != Some(&(b'[' as u16)) && !ss3 {
        return None;
    }
    if !ss3 && s.get(2) == Some(&(b'<' as u16)) {
        // An SGR mouse report, which a program that left mouse tracking on makes the terminal send.
        let end = 3 + s[3..].iter().take_while(|&&c| c == 0x3b || (0x30..=0x39).contains(&c)).count();
        return matches!(s.get(end), Some(&0x4d | &0x6d)).then_some((end + 1, 0, 0, 0)); // M, m
    }
    let mut i = 2;
    let mut params = [0u32; 4];
    let mut n = 0;
    while let Some(&c) = s.get(i) {
        match c {
            0x30..=0x39 => params[n] = params[n].saturating_mul(10).saturating_add((c - 0x30) as u32),
            0x3b => n = (n + 1).min(3),
            _ => break,
        }
        i += 1;
    }
    let f = *s.get(i)?;
    let len = i + 1;
    let state = if n >= 1 { mods(params[1]) } else { 0 };
    let arrow = |vk: u16| Some((len, vk, 0, state | ENHANCED));
    match f {
        0x41 => arrow(0x26), // A
        0x42 => arrow(0x28),
        0x43 => arrow(0x27),
        0x44 => arrow(0x25),
        0x48 => arrow(0x24), // H
        0x46 => arrow(0x23), // F
        0x5a if !ss3 => Some((len, 0x09, 9, SHIFT)),
        0x50 => Some((len, 0x70, 0, state)), // P: F1
        0x51 => Some((len, 0x71, 0, state)),
        0x52 if ss3 || n >= 1 && params[0] == 1 => Some((len, 0x72, 0, state)),
        0x53 => Some((len, 0x73, 0, state)),
        0x49 | 0x4f if !ss3 => Some((len, 0, 0, 0)), // I, O: focus in and out
        0x7e => {
            let vk = match params[0] {
                1 | 7 => 0x24,
                2 => 0x2d,
                3 => 0x2e,
                4 | 8 => 0x23,
                5 => 0x21,
                6 => 0x22,
                15 => 0x74,
                17..=21 => 0x75 + (params[0] - 17) as u16,
                23 => 0x7a,
                24 => 0x7b,
                _ => 0,
            };
            Some((len, vk, 0, state | if (1..=6).contains(&params[0]) { ENHANCED } else { 0 }))
        }
        _ => None,
    }
}

/// The key events for `text` from the terminal.
pub fn keys(text: &[u16], out: &mut Vec<Rec>) {
    let mut i = 0;
    while i < text.len() {
        let c = text[i];
        if c == 0x1b {
            if let Some((len, vk, ch, state)) = sequence(&text[i..]) {
                if vk != 0 {
                    press(vk, ch, state, out);
                }
                i += len;
                continue;
            }
            let Some(&next) = text.get(i + 1) else {
                press(0x1b, 0x1b, 0, out);
                break;
            };
            // Alt and the next key
            i += 2;
            match next {
                0x0d => press(0x0d, 0x0d, LALT, out),
                0x7f => press(0x08, 0x08, LALT, out),
                0x1b => press(0x1b, 0x1b, LALT, out),
                _ => type_char(next, LALT, out),
            }
            continue;
        }
        i += 1;
        match c {
            0x0d => press(0x0d, 0x0d, 0, out),
            0x7f => press(0x08, 0x08, 0, out),
            0x08 => press(0x08, 0x7f, LCTRL, out),
            0x09 => press(0x09, 0x09, 0, out),
            0x00 => press(0x20, 0, LCTRL, out),
            0x01..=0x1a => press(0x40 + c, c, LCTRL, out),
            0x1c..=0x1f => press([0xdc, 0xdd, 0x36, 0xbd][(c - 0x1c) as usize], c, LCTRL, out),
            _ => type_char(c, 0, out),
        }
    }
}
