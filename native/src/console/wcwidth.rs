//! Cell widths, from the tables in the page's src/term/wcwidth.js, so the console counts cells as the terminal does.
use std::sync::OnceLock;

const JS: &str = include_str!("../../../src/term/wcwidth.js");
const COMBINING: &str = table(JS.as_bytes(), b"const COMBINING = '");
const WIDE: &str = table(JS.as_bytes(), b"const WIDE = '");

/// The quoted text after `name` in `js`; a build without it fails.
const fn table(js: &'static [u8], name: &[u8]) -> &'static str {
    let mut i = 0;
    'find: while i + name.len() <= js.len() {
        let mut k = 0;
        while k < name.len() {
            if js[i + k] != name[k] {
                i += 1;
                continue 'find;
            }
            k += 1;
        }
        let (_, rest) = js.split_at(i + name.len());
        let mut end = 0;
        while end < rest.len() && rest[end] != b'\'' {
            end += 1;
        }
        match std::str::from_utf8(rest.split_at(end).0) {
            Ok(s) => return s,
            Err(_) => break,
        }
    }
    panic!("src/term/wcwidth.js lost a table")
}

/// Planes 0 and 1 by code point, and the ranges past them.
struct Tables {
    near: Vec<u8>,
    far: Vec<(u32, u32, u8)>,
}

fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
        let mut t = Tables { near: vec![1; 0x20000], far: Vec::new() };
        t.near[..32].fill(0);
        t.near[0x7f..0xa0].fill(0);
        for (ranges, width) in [(COMBINING, 0), (WIDE, 2)] {
            let mut n = ranges.split(',').map(|s| u32::from_str_radix(s, 36).unwrap_or(0));
            let mut end = 0;
            while let (Some(gap), Some(len)) = (n.next(), n.next()) {
                let from = end + gap;
                end = from + len;
                match t.near.get_mut(from as usize..=end as usize) {
                    Some(cells) => cells.fill(width),
                    None => t.far.push((from, end, width)),
                }
            }
        }
        t
    })
}

/// The cells code point `cp` takes: 0, 1 or 2.
pub fn wcwidth(cp: u32) -> u8 {
    let t = tables();
    match t.near.get(cp as usize) {
        Some(&w) => w,
        None => t.far.iter().find(|r| (r.0..=r.1).contains(&cp)).map_or(1, |r| r.2),
    }
}
