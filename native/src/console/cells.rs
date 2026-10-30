//! The APIs that read or change cells in place, answered from the screen's cells and drawn on the terminal as
//! OpenConsole draws them.
use super::super::screen::{Grid, TRAIL};
use super::super::wcwidth::wcwidth;
use super::super::{cup, lit, num, sgr, UNION};
use super::{bytes_le, glyph, mb_to_wide, narrow, rd, utf16, wide_to_mb, widen, wr, Prog, State, INVALID_PARAMETER, SUCCESS};

/// A run of cells to draw: its first column, its row, and each cell's character and attributes.
type Run = (i32, i32, Vec<(u32, u16)>);

impl State {
    /// FillConsoleOutput, ScrollConsoleScreenBuffer, Read/WriteConsoleOutputString and Read/WriteConsoleOutput on
    /// the screen on show: the body changed in place, and the reply's output data in `out`.
    pub(super) fn cells(&mut self, api: u32, b: &mut [u8; UNION], input: &[u8], out_cap: usize, shell: Prog, out: &mut Vec<u8>) -> i32 {
        let (cols, rows) = (self.screen.cols, self.screen.rows);
        // Cells from (x, y) on, row after row, `n` of them at most: the rows' spans (row, column, length).
        let spans = |[x, y]: [i16; 2], n: usize| {
            let (mut x, mut y, mut left) = (x as i32, y as i32, n.min(i32::MAX as usize) as i32);
            std::iter::from_fn(move || {
                if left <= 0 || y >= rows || x < 0 || y < 0 || x >= cols {
                    return None;
                }
                let k = left.min(cols - x);
                let span = (y, x, k);
                left -= k;
                x = 0;
                y += 1;
                Some(span)
            })
        };
        match api {
            0x0200_0000 => {
                // FillConsoleOutput: an attribute or a character over `len` cells.
                let (at, kind, elem, len): ([i16; 2], u32, u16, u32) = (rd(b, 0), rd(b, 4), rd(b, 8), rd(b, 12));
                let ch = if kind == 1 { widen(self.cp_out, elem as u8) } else { elem };
                let whole = len as i64 == cols as i64 * rows as i64 && at == [0, 0];
                if shell == Prog::PowerShell && whole && kind != 3 && ch == 0x20 {
                    // Clear-Host: the terminal's scrollback goes too.
                    self.emit_with(|s| lit(s, "\x1b[H\x1b[2J\x1b[3J"));
                    return SUCCESS;
                }
                if shell == Prog::PowerShell && whole && kind == 3 && elem == 7 {
                    return SUCCESS;
                }
                let g = self.screen.grid();
                let mut n = 0;
                let runs: Vec<Run> = spans(at, len as usize)
                    .map(|(y, x, k)| {
                        n += k;
                        (x, y, (x..x + k).map(|i| g.cell(i, y)).map(|(c, a)| if kind == 3 { (c, elem) } else { (ch as u32, a) }).collect())
                    })
                    .collect();
                self.draw(&runs);
                wr(b, 12, n as u32);
                SUCCESS
            }
            0x0200_0012 => {
                // WriteConsoleOutputString: characters or attributes from a cell on.
                let (at, kind): ([i16; 2], u32) = (rd(b, 0), rd(b, 4));
                let mut items = Vec::new();
                if kind == 1 {
                    mb_to_wide(self.cp_out, input, &mut items);
                } else {
                    items = utf16(input);
                }
                let g = self.screen.grid();
                let mut n = 0usize;
                let runs: Vec<Run> = spans(at, items.len())
                    .map(|(y, x, k)| {
                        let row = (x..x + k).map(|i| (g.cell(i, y), items[n + (i - x) as usize])).map(|((c, a), v)| if kind == 3 { (c, v) } else { (v as u32, a) }).collect();
                        n += k as usize;
                        (x, y, row)
                    })
                    .collect();
                self.draw(&runs);
                wr(b, 8, n as u32);
                SUCCESS
            }
            0x0200_000F => {
                // ReadConsoleOutputString
                let (at, kind): ([i16; 2], u32) = (rd(b, 0), rd(b, 4));
                let unit = if kind == 1 { 1 } else { 2 };
                let g = self.screen.grid();
                let mut w: Vec<u16> = Vec::new();
                for (y, x, k) in spans(at, out_cap / unit) {
                    for i in x..x + k {
                        let (c, a) = g.cell(i, y);
                        if kind == 3 {
                            w.push(a);
                        } else if c != TRAIL {
                            w.push(if c == 0 { 0x20 } else { u16::try_from(c).unwrap_or(0xfffd) });
                        }
                    }
                }
                if kind == 1 {
                    wide_to_mb(self.cp_out, &w, out);
                } else {
                    bytes_le(&w, out);
                }
                wr(b, 8, (out.len() / unit) as u32);
                SUCCESS
            }
            0x0200_0011 | 0x0200_0013 => {
                // Write/ReadConsoleOutput: a rectangle of CHAR_INFOs, clipped to the screen.
                let r: [i16; 4] = rd(b, 0);
                let unicode = rd::<u8>(b, 8) != 0;
                let w = (r[2] as i32 - r[0] as i32 + 1).max(0);
                let (l, t, rr, bb) = ((r[0] as i32).max(0), (r[1] as i32).max(0), (r[2] as i32).min(cols - 1), (r[3] as i32).min(rows - 1));
                if l > rr || t > bb {
                    wr(b, 0, [r[0], r[1], r[0].wrapping_sub(1), r[1].wrapping_sub(1)]);
                    return SUCCESS;
                }
                wr(b, 0, [l as i16, t as i16, rr as i16, bb as i16]);
                let idx = |x: i32, y: i32| ((y - r[1] as i32) as usize * w as usize + (x - r[0] as i32) as usize) * 4;
                let g = self.screen.grid();
                if api == 0x0200_0013 {
                    let h = (r[3] as i32 - r[1] as i32 + 1).max(0);
                    let size = w as usize * h as usize * 4;
                    if size > out_cap {
                        return INVALID_PARAMETER;
                    }
                    out.resize(size, 0);
                    for y in t..=bb {
                        for x in l..=rr {
                            let (c, a) = g.cell(x, y);
                            let (ch, flag) = match c {
                                TRAIL => (if x > 0 { g.cell(x - 1, y).0 } else { 0x20 }, 0x200),
                                0 => (0x20, 0),
                                c if wcwidth(c) == 2 => (c, 0x100),
                                c => (c, 0),
                            };
                            let ch = u16::try_from(ch).unwrap_or(0xfffd);
                            let ch = if unicode { ch } else { narrow(self.cp_out, ch) as u16 };
                            let i = idx(x, y);
                            out[i..i + 2].copy_from_slice(&ch.to_le_bytes());
                            out[i + 2..i + 4].copy_from_slice(&(a & 0xfcff | flag).to_le_bytes());
                        }
                    }
                    return SUCCESS;
                }
                let runs: Vec<Run> = (t..=bb)
                    .map(|y| {
                        let row = (l..=rr).map(|x| {
                            let (c, a): (u16, u16) = (rd(input, idx(x, y)), rd(input, idx(x, y) + 2));
                            let c = if unicode { c } else { widen(self.cp_out, c as u8) };
                            (if a & 0x200 != 0 { TRAIL } else { c as u32 }, a & !0x300)
                        });
                        (l, y, row.collect())
                    })
                    .collect();
                self.draw(&runs);
                SUCCESS
            }
            _ => self.scroll(b, shell),
        }
    }

    /// ScrollConsoleScreenBuffer: the source's cells move, and what they leave takes the fill, all within the clip.
    fn scroll(&mut self, b: &mut [u8; UNION], shell: Prog) -> i32 {
        let (cols, rows) = (self.screen.cols, self.screen.rows);
        let (src, clip, use_clip, dest, fill_ch, fill_attr): ([i16; 4], [i16; 4], u8, [i16; 2], u16, u16) = (rd(b, 0), rd(b, 8), rd(b, 16), rd(b, 18), rd(b, 22), rd(b, 24));
        let fill_attr = if fill_ch == 0 && fill_attr == 0 { self.screen.attr } else { fill_attr };
        let fill_ch = if fill_ch == 0 { 0x20 } else { fill_ch };
        let s = [(src[0] as i32).max(0), (src[1] as i32).max(0), (src[2] as i32).min(cols - 1), (src[3] as i32).min(rows - 1)];
        let screen = [0, 0, cols - 1, rows - 1];
        if shell == Prog::Cmd && s == screen && src[0] <= 0 && src[1] <= 0 && dest[0] == 0 && dest[1] as i32 <= -rows && use_clip == 0 && fill_ch == 0x20 {
            // cmd's cls: the terminal's scrollback goes too.
            self.emit_with(|s| lit(s, "\x1b[H\x1b[2J\x1b[3J"));
            return SUCCESS;
        }
        if s[0] > s[2] || s[1] > s[3] {
            return INVALID_PARAMETER;
        }
        let clip = if use_clip != 0 { [(clip[0] as i32).max(0), (clip[1] as i32).max(0), (clip[2] as i32).min(cols - 1), (clip[3] as i32).min(rows - 1)] } else { screen };
        let (dx, dy) = (dest[0] as i32 - src[0] as i32, dest[1] as i32 - src[1] as i32);
        if s == screen && dx == 0 && fill_ch == 0x20 && clip == screen {
            // The whole screen up or down: DL or IL, as OpenConsole does.
            self.emit_with(|o| {
                lit(o, "\x1b7");
                sgr(o, fill_attr);
                lit(o, "\x1b[H\x1b[");
                num(o, dy.abs().min(rows));
                lit(o, if dy < 0 { "M\x1b8" } else { "L\x1b8" });
            });
            return SUCCESS;
        }
        let g: &Grid = self.screen.grid();
        let inside = |x: i32, y: i32| x >= clip[0] && x <= clip[2] && y >= clip[1] && y <= clip[3];
        let mut next = g.clone();
        for y in s[1]..=s[3] {
            for x in (s[0]..=s[2]).filter(|&x| inside(x, y)) {
                next.set(x, y, (fill_ch as u32, fill_attr));
            }
        }
        for y in s[1]..=s[3] {
            for x in s[0]..=s[2] {
                let (tx, ty) = (x + dx, y + dy);
                if tx >= 0 && ty >= 0 && tx < cols && ty < rows && inside(tx, ty) {
                    next.set(tx, ty, g.cell(x, y));
                }
            }
        }
        let runs: Vec<Run> = (0..rows)
            .filter_map(|y| {
                let changed = |x: &i32| next.cell(*x, y) != g.cell(*x, y);
                let first = (0..cols).find(changed)?;
                let last = (0..cols).rev().find(changed)?;
                Some((first, y, (first..=last).map(|x| next.cell(x, y)).collect()))
            })
            .collect();
        self.draw(&runs);
        SUCCESS
    }

    /// Draws cells as OpenConsole's WriteInfos does: the cursor and attributes saved, each run at its place, an
    /// SGR where the attributes change, a wide character's second cell left to the first.
    fn draw(&mut self, runs: &[Run]) {
        if runs.is_empty() {
            return;
        }
        self.emit_with(|s| {
            lit(s, "\x1b7");
            for (x, y, cells) in runs {
                cup(s, (*y, *x));
                let mut attr = None;
                for (i, &(c, a)) in cells.iter().enumerate() {
                    let wide = c != TRAIL && c != 0 && wcwidth(c) == 2;
                    let c = match c {
                        TRAIL if i == 0 => 0x20,
                        TRAIL => continue,
                        _ if wide && i + 1 == cells.len() => 0x20,
                        0 => 0x20,
                        0..0x20 | 0x7f => glyph(c as u16) as u32,
                        0x80..0xa0 => '?' as u32,
                        c => c,
                    };
                    if attr != Some(a) {
                        attr = Some(a);
                        sgr(s, a);
                    }
                    s.extend_from_slice(char::from_u32(c).unwrap_or('\u{fffd}').encode_utf16(&mut [0; 2]));
                }
            }
            lit(s, "\x1b8");
        });
    }
}
