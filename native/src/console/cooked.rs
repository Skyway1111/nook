//! A cooked read's line editing, as OpenConsole's readDataCooked.cpp does it: the line, its cursor, insert mode,
//! the program's history, and the redraw that keeps the screen showing them.
use super::input::{Key, LCTRL, RCTRL};
use super::wcwidth::wcwidth;
use super::{cup, lit};

/// One program's command history: OpenConsole's CommandHistory (50 commands, LastDisplayed, CLE_RESET).
#[derive(Default)]
pub struct History {
    cmds: Vec<Vec<u16>>,
    last: isize,
    reset: bool,
}

impl History {
    pub fn add(&mut self, cmd: &[u16]) {
        if cmd.is_empty() {
            return;
        }
        if self.cmds.last().map(Vec::as_slice) != Some(cmd) {
            if self.cmds.len() == 50 {
                self.cmds.remove(0);
                self.last -= 1;
            }
            self.cmds.push(cmd.to_vec());
            if self.last < 0 || self.cmds[self.last as usize] != cmd {
                self.last = self.cmds.len() as isize - 1;
            }
        }
        self.reset = true;
    }

    fn nth(&mut self, i: isize) -> Vec<u16> {
        if self.cmds.is_empty() {
            self.last = 0;
            return Vec::new();
        }
        self.last = i.clamp(0, self.cmds.len() as isize - 1);
        self.cmds[self.last as usize].clone()
    }

    fn at_first(&self) -> bool {
        !self.reset && self.last == 0
    }

    fn at_last(&self) -> bool {
        self.last == self.cmds.len() as isize - 1
    }

    fn prev(&mut self) -> Vec<u16> {
        if !std::mem::take(&mut self.reset) {
            self.last -= 1;
        }
        self.nth(self.last)
    }

    fn next(&mut self) -> Vec<u16> {
        self.nth(self.last + 1)
    }

    fn current(&self) -> &[u16] {
        usize::try_from(self.last).ok().and_then(|i| self.cmds.get(i)).map_or(&[], Vec::as_slice)
    }
}

pub enum Done {
    Enter,
    Wakeup(u16, u32),
}

pub struct Cooked {
    pub buf: Vec<u16>,
    cur: usize,
    /// Where the line starts on screen, taken at the first redraw (the program may write its prompt after reading).
    origin: Option<(i32, i32)>,
    /// Where the drawn line ended, to erase what a shorter one leaves (row, column).
    drawn_end: Option<(i32, i32)>,
    dirty: usize,
    insert: bool,
    /// A resize left the drawn line in disarray: the next redraw erases from the origin down and draws it all.
    clear: bool,
    /// Where each position of the line ends on screen, for the redraw.
    ends: Vec<(i32, i32)>,
}

/// Lays out character `c` from `(row, col)` and writes what draws it to `out`, if any: where it ends.
fn place(c: u32, (mut row, mut col): (i32, i32), cols: i32, mut out: Option<&mut Vec<u16>>) -> (i32, i32) {
    let mut put = |s: &[u16]| {
        if let Some(o) = out.as_deref_mut() {
            o.extend_from_slice(s);
        }
    };
    if c >= 0x20 {
        let w = wcwidth(c) as i32;
        if col + w > cols {
            row += 1;
            col = 0;
        }
        put(char::from_u32(c).unwrap_or(' ').encode_utf16(&mut [0; 2]));
        return (row, col + w);
    }
    if col >= cols {
        row += 1;
        col = 0;
    }
    if c == 9 {
        let n = (8 - (col & 7)).min(cols - col);
        for _ in 0..n {
            put(&[0x20]);
        }
        return (row, col + n);
    }
    if col + 2 > cols {
        for _ in col..cols {
            put(&[0x20]);
        }
        row += 1;
        col = 0;
    }
    put(&[b'^' as u16, c as u16 + 0x40]);
    (row, col + 2)
}

/// The code point at `i` in `buf` and how many units it takes.
fn at(buf: &[u16], i: usize) -> (u32, usize) {
    let c = buf[i] as u32;
    if (0xd800..0xdc00).contains(&c) && buf.get(i + 1).is_some_and(|l| (0xdc00..0xe000).contains(l)) {
        return (0x10000 + ((c - 0xd800) << 10) + (buf[i + 1] as u32 - 0xdc00), 2);
    }
    (c, 1)
}

impl Cooked {
    /// A read that starts with `initial`, which the program has already drawn, ending at `cursor` (row, column).
    pub fn new(initial: Vec<u16>, cursor: (i32, i32), cols: i32) -> Cooked {
        let mut c = Cooked { cur: initial.len(), dirty: usize::MAX, origin: None, drawn_end: None, insert: true, clear: false, buf: initial, ends: Vec::new() };
        if !c.buf.is_empty() {
            // The column the text must start at to end where the cursor is, nearest a first guess.
            let guess = (cursor.1 - (c.buf.len() as i32 % cols) + cols) % cols;
            let mut best = (i32::MAX, 0, 0);
            for d in 0..=2 * cols {
                let start = guess + if d & 1 == 0 { d / 2 } else { -(d / 2 + 1) };
                if !(0..cols).contains(&start) {
                    continue;
                }
                let (rows, end) = c.layout((0, start), cols);
                let end = if end >= cols { (rows + 1, 0) } else { (rows, end) };
                let dist = (end.1 - cursor.1).abs();
                if dist < best.0 {
                    best = (dist, start, end.0);
                }
                if dist == 0 {
                    break;
                }
            }
            c.origin = Some(if cursor.0 - best.2 < 0 { (0, 0) } else { (cursor.0 - best.2, best.1) });
            c.drawn_end = Some(cursor);
        }
        c
    }

    /// Lays the line out from `origin` (row, col) into `ends`, where each position ends: the line's end.
    fn layout(&mut self, origin: (i32, i32), cols: i32) -> (i32, i32) {
        self.ends.clear();
        self.ends.resize(self.buf.len() + 1, origin);
        let mut p = origin;
        let mut i = 0;
        while i < self.buf.len() {
            let (c, n) = at(&self.buf, i);
            p = place(c, p, cols, None);
            self.ends[i + 1..=i + n].fill(p);
            i += n;
        }
        p
    }

    fn replace(&mut self, at: usize, remove: usize, text: &[u16]) {
        let at = at.min(self.buf.len());
        let remove = remove.min(self.buf.len() - at);
        if remove == 0 && text.is_empty() {
            return;
        }
        self.buf.splice(at..at + remove, text.iter().copied());
        self.cur = at + text.len();
        self.dirty = self.dirty.min(at);
    }

    fn set(&mut self, line: Vec<u16>) {
        self.buf = line;
        self.cur = self.buf.len();
        self.dirty = 0;
    }

    fn next_char(&self, i: usize) -> usize {
        let mut j = i + at(&self.buf, i).1;
        while j < self.buf.len() && wcwidth(at(&self.buf, j).0) == 0 && self.buf[j] >= 0x20 {
            j += at(&self.buf, j).1;
        }
        j
    }

    fn prev_char(&self, i: usize) -> usize {
        let (mut j, mut last) = (0, 0);
        while j < i {
            last = j;
            j = self.next_char(j);
        }
        last
    }

    fn word_prev(&self, mut i: usize) -> usize {
        while i > 0 && self.buf[i - 1] == 0x20 {
            i -= 1;
        }
        while i > 0 && self.buf[i - 1] != 0x20 {
            i -= 1;
        }
        i
    }

    fn word_next(&self, mut i: usize) -> usize {
        while i < self.buf.len() && self.buf[i] != 0x20 {
            i += 1;
        }
        while i < self.buf.len() && self.buf[i] == 0x20 {
            i += 1;
        }
        i
    }

    /// One key, pressed. `processed` is ENABLE_PROCESSED_INPUT; `wakeup` the read's control-character mask.
    pub fn key(&mut self, k: &Key, wakeup: u32, processed: bool, hist: &mut History) -> Option<Done> {
        let ctrl = k.state & (LCTRL | RCTRL) != 0;
        if k.ch == 0 || k.vk == 0x1b {
            let len = self.buf.len();
            match k.vk {
                0x1b => self.replace(0, usize::MAX, &[]),
                0x24 if self.cur > 0 => {
                    if ctrl {
                        self.replace(0, self.cur, &[]);
                    }
                    self.cur = 0;
                    self.dirty = self.dirty.min(len);
                }
                0x23 if self.cur < len => {
                    if ctrl {
                        self.replace(self.cur, usize::MAX, &[]);
                    }
                    self.cur = self.buf.len();
                    self.dirty = self.dirty.min(len);
                }
                0x25 if self.cur > 0 => {
                    self.cur = if ctrl { self.word_prev(self.cur) } else { self.prev_char(self.cur) };
                    self.dirty = self.dirty.min(len);
                }
                0x27 | 0x70 if self.cur < len => {
                    self.cur = if ctrl && k.vk == 0x27 { self.word_next(self.cur) } else { self.next_char(self.cur) };
                    self.dirty = self.dirty.min(len);
                }
                0x27 | 0x70 => {
                    // At the end: the next character of the last command.
                    let last = hist.current().to_vec();
                    let (mut i, mut j) = (0, 0);
                    while j < last.len() {
                        let n = j + at(&last, j).1;
                        if i >= len {
                            self.replace(usize::MAX, 0, &last[j..n]);
                            break;
                        }
                        i = self.next_char(i);
                        j = n;
                    }
                }
                0x2d => self.insert = !self.insert,
                0x2e if self.cur < len => {
                    let (at, end) = (self.cur, self.next_char(self.cur));
                    self.replace(at, end - at, &[]);
                    self.cur = at;
                }
                0x26 | 0x74 if !hist.at_first() => {
                    let l = hist.prev();
                    self.set(l)
                }
                0x28 if !hist.at_last() => {
                    let l = hist.next();
                    self.set(l)
                }
                0x21 if !hist.at_first() => {
                    let l = hist.nth(0);
                    self.set(l)
                }
                0x22 if !hist.at_last() => {
                    let l = hist.nth(isize::MAX);
                    self.set(l)
                }
                0x72 => {
                    let at = self.cur;
                    if let Some(rest) = hist.current().get(at..).filter(|r| !r.is_empty()).map(<[u16]>::to_vec) {
                        self.replace(at, usize::MAX, &rest);
                    }
                }
                0x75 => return self.key(&Key { ch: 0x1a, vk: 0x5a, ..*k }, wakeup, processed, hist),
                _ => {}
            }
            return None;
        }
        let ch = k.ch;
        if ch < 0x20 && wakeup & (1 << ch) != 0 {
            let at = self.cur;
            self.replace(at, usize::MAX, &[]);
            self.dirty = self.dirty.min(at);
            return Some(Done::Wakeup(ch, k.state));
        }
        match ch {
            0x0d => {
                self.cur = self.buf.len();
                self.dirty = self.dirty.min(self.buf.len());
                return Some(Done::Enter);
            }
            0x08 | 0x7f if processed => {
                let at = self.cur;
                let from = if ch == 0x7f { self.word_prev(at) } else if at > 0 { self.prev_char(at) } else { 0 };
                self.replace(from, at - from, &[]);
                self.dirty = self.dirty.min(from);
                return None;
            }
            _ => {}
        }
        let at = self.cur;
        let remove = if self.insert || at >= self.buf.len() { 0 } else { self.next_char(at) - at };
        self.replace(at, remove, &[ch]);
        None
    }

    /// Draws what changed: the line from its first changed character, what a shorter line leaves erased, and the
    /// cursor where it belongs. `term` is the terminal's cursor (row, column; column `cols` while a wrap is pending).
    pub fn redraw(&mut self, mut term: (i32, i32), cols: i32, rows: i32, out: &mut Vec<u16>) {
        let origin = *self.origin.get_or_insert((term.0, term.1.min(cols - 1)));
        if self.dirty == usize::MAX {
            return;
        }
        if std::mem::take(&mut self.clear) {
            cup(out, origin);
            lit(out, "\x1b[J");
            term = origin;
        }
        let end = self.layout(origin, cols);
        let ends = std::mem::take(&mut self.ends);
        // Start where the terminal can be put: not a pending wrap, so back up a character there.
        let mut d = self.dirty.min(self.buf.len());
        while d > 0 && ends[d].1 >= cols {
            d = self.prev_char(d);
        }
        let start = if d == 0 { origin } else { ends[d] };
        if term != start {
            cup(out, start);
        }
        let mut p = start;
        let mut i = d;
        while i < self.buf.len() {
            let (c, n) = at(&self.buf, i);
            p = place(c, p, cols, Some(out));
            i += n;
        }
        let mut max_row = p.0;
        // Erase what's left of a longer line: spaces for a short tail, as OpenConsole does, else EL.
        let old = self.drawn_end.unwrap_or(origin);
        if old > end {
            let tail = if old.0 == end.0 { old.1 - end.1 } else { cols - end.1 };
            if end.1 < cols && tail > 0 {
                if tail <= 16 {
                    out.extend(std::iter::repeat_n(0x20, tail as usize));
                    p = (end.0, end.1 + tail);
                } else {
                    lit(out, "\x1b[K");
                }
            }
            for r in end.0 + 1..=old.0.min(rows - 1) {
                cup(out, (r, 0));
                lit(out, "\x1b[K");
                p = (r, 0);
            }
        }
        // The cursor: past a full row it shows on the next, which a space and CR make the terminal scroll to.
        let mut want = ends[self.cur.min(self.buf.len())];
        if want.1 >= cols {
            want = (want.0 + 1, 0);
            if self.cur >= self.buf.len() {
                if p != (want.0 - 1, cols) {
                    let from = self.prev_char(self.buf.len());
                    let s = if from == 0 { origin } else { ends[from] };
                    let s = if s.1 >= cols { (s.0 + 1, 0) } else { s };
                    cup(out, s);
                    place(at(&self.buf, from).0, s, cols, Some(out));
                }
                lit(out, " \r");
                p = want;
                max_row = max_row.max(want.0);
            }
        }
        self.ends = ends;
        // Rows past the bottom scrolled the screen: the line moved up with it.
        let over = (max_row - (rows - 1)).max(0);
        if p != want {
            cup(out, (want.0 - over, want.1));
        }
        self.origin = Some((origin.0 - over, origin.1));
        self.drawn_end = Some((end.0 - over, end.1));
        self.dirty = usize::MAX;
    }

    /// The screen took a new size and lost `lost` rows off its top: the line is drawn again whole, as
    /// OpenConsole's RedrawAfterResize does.
    pub fn resized(&mut self, lost: i32, cols: i32) {
        let Some(o) = self.origin else { return };
        self.origin = Some(((o.0 - lost).max(0), o.1.min(cols - 1)));
        self.drawn_end = None;
        self.clear = !self.buf.is_empty();
        self.dirty = if self.clear { 0 } else { usize::MAX };
    }

    /// The terminal laid the screen out `dy` rows from where the console guessed.
    pub fn offset(&mut self, dy: i32) {
        if let Some(o) = self.origin {
            self.origin = Some(((o.0 + dy).max(0), o.1));
        }
    }
}
