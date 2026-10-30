//! The console's screen, kept by reading what goes to the terminal as vt.js reads it: the cursor, the modes, and
//! each cell's character and legacy attributes, for the APIs that read cells or change them in place.
use super::wcwidth::wcwidth;

/// The second cell of a wide character.
pub const TRAIL: u32 = u32::MAX;
const DEC: [char; 32] = [
    '◆', '▒', '␉', '␌', '␍', '␊', '°', '±', '␤', '␋', '┘', '┐', '┌', '└', '┼', '⎺', '⎻', '─', '⎼', '⎽', '├', '┤', '┴', '┬', '│', '≤', '≥', 'π', '≠', '£',
    '·', ' ',
];
const REVERSE: u16 = 0x4000;
const UNDERSCORE: u16 = 0x8000;

#[derive(Clone, Copy, Default)]
struct Cur {
    x: i32, // == cols while a wrap is pending, as xterm keeps it
    y: i32,
    attr: u16,
}

#[derive(PartialEq, Clone, Copy)]
enum St {
    Ground,
    Esc,
    EscInter,
    Csi,
    Str,    // OSC, DCS, APC, PM, SOS: to ST or BEL
    StrEsc, // ESC inside a string
}

/// One buffer's cells, code points (0 for none, TRAIL after a wide one) and legacy attributes, row by row. Row
/// `y` is stored at `base + y`, wrapping, so a whole-screen scroll moves no cells.
#[derive(Clone)]
pub struct Grid {
    cells: Vec<u32>,
    attrs: Vec<u16>,
    cols: usize,
    rows: usize,
    base: usize,
}

impl Grid {
    fn new(cols: i32, rows: i32) -> Grid {
        let n = (cols * rows) as usize;
        Grid { cells: vec![0; n], attrs: vec![7; n], cols: cols as usize, rows: rows as usize, base: 0 }
    }

    /// Where row `y` starts.
    fn row(&self, y: i32) -> usize {
        (self.base + y as usize) % self.rows * self.cols
    }

    pub fn cell(&self, x: i32, y: i32) -> (u32, u16) {
        let i = self.row(y) + x as usize;
        (self.cells[i], self.attrs[i])
    }

    pub fn set(&mut self, x: i32, y: i32, (c, a): (u32, u16)) {
        let i = self.row(y) + x as usize;
        self.cells[i] = c;
        self.attrs[i] = a;
    }

    fn copy_row(&mut self, from: i32, to: i32) {
        let (f, t) = (self.row(from), self.row(to));
        self.cells.copy_within(f..f + self.cols, t);
        self.attrs.copy_within(f..f + self.cols, t);
    }
}

pub struct Screen {
    pub cols: i32,
    pub rows: i32,
    cur: Cur,
    saved: [Cur; 2],
    pub alt: bool,
    grids: [Grid; 2],
    top: i32,
    bottom: i32,
    wrap: bool,
    origin: bool,
    insert: bool,
    charsets: [bool; 4], // which of G0..G3 is DEC's line drawing set
    gl: usize,
    st: St,
    params: [i32; 16],
    np: usize,
    prefix: u32, // private marker and intermediates of a CSI, shifted in
    esc_inter: u32,
    last: u32, // the last printed character, for REP
    pub attr: u16, // legacy attributes from SGR
}

impl Screen {
    pub fn new(cols: i32, rows: i32) -> Screen {
        Screen {
            cols,
            rows,
            cur: Cur { attr: 7, ..Cur::default() },
            saved: [Cur { attr: 7, ..Cur::default() }; 2],
            alt: false,
            grids: [Grid::new(cols, rows), Grid::new(cols, rows)],
            top: 0,
            bottom: rows - 1,
            wrap: true,
            origin: false,
            insert: false,
            charsets: [false; 4],
            gl: 0,
            st: St::Ground,
            params: [0; 16],
            np: 0,
            prefix: 0,
            esc_inter: 0,
            last: 0,
            attr: 7,
        }
    }

    /// The cursor as the console API reports it: never in the pending-wrap column.
    pub fn cursor(&self) -> (i32, i32) {
        (self.cur.x.min(self.cols - 1), self.cur.y)
    }

    /// The cursor's column, `cols` while a wrap is pending.
    pub fn raw_x(&self) -> i32 {
        self.cur.x
    }

    /// The buffer on screen.
    pub fn grid(&self) -> &Grid {
        &self.grids[self.alt as usize]
    }

    fn g(&mut self) -> &mut Grid {
        &mut self.grids[self.alt as usize]
    }

    /// The terminal takes a new size: rows keep their cells from the left, the cursor keeps its row unless it
    /// falls off the bottom, where the screen scrolls up. The rows lost off the top.
    pub fn resize(&mut self, cols: i32, rows: i32) -> i32 {
        let lost = if !self.alt && self.cur.y >= rows { self.cur.y - rows + 1 } else { 0 };
        for (gi, g) in self.grids.iter_mut().enumerate() {
            let skip = if gi == 0 { lost } else { 0 };
            let mut n = Grid::new(cols, rows);
            for y in 0..rows.min(self.rows - skip) {
                for x in 0..cols.min(self.cols) {
                    n.set(x, y, g.cell(x, y + skip));
                }
                // A wide character cut in half at the new edge goes.
                let (c, a) = n.cell(cols - 1, y);
                if cols < self.cols && c != TRAIL && c != 0 && wcwidth(c) == 2 {
                    n.set(cols - 1, y, (0, a));
                }
            }
            *g = n;
        }
        self.cur.y -= lost;
        self.cols = cols;
        self.rows = rows;
        self.top = 0;
        self.bottom = rows - 1;
        self.cur.x = self.cur.x.min(cols - 1);
        self.cur.y = self.cur.y.clamp(0, rows - 1);
        lost
    }

    /// The terminal has the cursor `dx`, `dy` from where this screen has it, after its own reflow: the cells
    /// and the cursor follow it.
    pub fn offset(&mut self, dx: i32, dy: i32) {
        if dy != 0 {
            self.shift(0, self.rows - 1, -dy);
        }
        self.cur.y = (self.cur.y + dy).clamp(0, self.rows - 1);
        self.cur.x = (self.cur.x + dx).clamp(0, self.cols - 1);
    }

    fn restrict(&mut self, max_col: i32) {
        self.cur.x = self.cur.x.clamp(0, max_col);
        self.cur.y = if self.origin { self.cur.y.clamp(self.top, self.bottom) } else { self.cur.y.clamp(0, self.rows - 1) };
    }

    fn goto(&mut self, x: i32, y: i32) {
        self.cur.x = x;
        self.cur.y = if self.origin { self.top.saturating_add(y) } else { y };
        self.restrict(self.cols - 1);
    }

    fn move_by(&mut self, dx: i32, dy: i32) {
        self.restrict(self.cols - 1);
        self.cur.x = self.cur.x.saturating_add(dx);
        self.cur.y = self.cur.y.saturating_add(dy);
        self.restrict(self.cols - 1);
    }

    /// Erases cells `from..to` of row `y`: no character, the current background.
    fn clear(&mut self, y: i32, from: i32, to: i32) {
        let (cols, a) = (self.cols, self.attr & 0xf0 | 7);
        let (from, to) = (from.clamp(0, cols) as usize, to.clamp(0, cols) as usize);
        if from >= to {
            return;
        }
        let g = self.g();
        let row = g.row(y);
        g.cells[row + from..row + to].fill(0);
        g.attrs[row + from..row + to].fill(a);
        // Half a wide character is none.
        if from > 0 && g.cells[row + from - 1] != TRAIL && wcwidth(g.cells[row + from - 1]) == 2 {
            g.cells[row + from - 1] = 0;
        }
        if to < cols as usize && g.cells[row + to] == TRAIL {
            g.cells[row + to] = 0;
        }
    }

    /// Moves rows `top..=bottom` up by `n` (down for negative), blanking the rows that come in.
    fn shift(&mut self, top: i32, bottom: i32, n: i32) {
        let k = n.unsigned_abs().min((bottom - top + 1) as u32) as i32;
        let whole = top == 0 && bottom == self.rows - 1;
        let g = self.g();
        if whole {
            g.base = (g.base + if n > 0 { k } else { g.rows as i32 - k } as usize) % g.rows;
        } else if n > 0 {
            for y in top..=bottom - k {
                g.copy_row(y + k, y);
            }
        } else {
            for y in (top + k..=bottom).rev() {
                g.copy_row(y - k, y);
            }
        }
        let fresh = if n > 0 { bottom - k + 1..=bottom } else { top..=top + k - 1 };
        for y in fresh {
            self.clear(y, 0, self.cols);
        }
    }

    fn line_feed(&mut self) {
        self.cur.y += 1;
        if self.cur.y == self.bottom + 1 {
            self.cur.y -= 1;
            self.shift(self.top, self.bottom, 1);
        } else if self.cur.y >= self.rows {
            self.cur.y = self.rows - 1;
        }
        if self.cur.x >= self.cols {
            self.cur.x -= 1;
        }
    }

    fn index(&mut self) {
        self.restrict(self.cols - 1);
        self.line_feed();
        self.restrict(self.cols - 1);
    }

    /// Puts a character of width `w` at the cursor's cell.
    fn put(&mut self, c: u32, w: i32) {
        let (x, y, cols, a) = (self.cur.x, self.cur.y, self.cols, self.attr);
        let g = self.g();
        let i = g.row(y) + x as usize;
        if g.cells[i] == TRAIL && x > 0 {
            g.cells[i - 1] = 0;
        }
        if x + w < cols && g.cells[i + w as usize] == TRAIL {
            g.cells[i + w as usize] = 0;
        }
        g.cells[i] = c;
        g.attrs[i] = a;
        if w == 2 {
            g.cells[i + 1] = TRAIL;
            g.attrs[i + 1] = a;
        }
    }

    fn print(&mut self, mut c: u32) {
        if (0x60..0x7f).contains(&c) && self.charsets[self.gl] {
            c = DEC[(c - 0x60) as usize] as u32;
        }
        let mut w = wcwidth(c) as i32;
        if w == 0 {
            return; // joins the last cell
        }
        if self.cur.x + w > self.cols {
            if self.wrap {
                if self.cur.x == self.cols - 1 {
                    self.clear(self.cur.y, self.cur.x, self.cols);
                }
                self.cur.x = 0;
                self.cur.y += 1;
                if self.cur.y == self.bottom + 1 {
                    self.cur.y -= 1;
                    self.shift(self.top, self.bottom, 1);
                } else if self.cur.y >= self.rows {
                    self.cur.y = self.rows - 1;
                }
            } else {
                self.cur.x = self.cols - 1;
                if w == 2 {
                    return;
                }
                w = 1;
            }
        }
        if w > self.cols {
            return; // a wide character on a screen one cell wide
        }
        if self.insert {
            self.insert_cells(w);
        }
        self.put(c, w);
        self.cur.x += w;
        self.last = c;
    }

    fn insert_cells(&mut self, n: i32) {
        let (x, y, cols) = (self.cur.x.min(self.cols - 1), self.cur.y, self.cols);
        let n = n.min(cols - x);
        let g = self.g();
        let row = g.row(y);
        g.cells.copy_within(row + x as usize..row + (cols - n) as usize, row + (x + n) as usize);
        g.attrs.copy_within(row + x as usize..row + (cols - n) as usize, row + (x + n) as usize);
        self.clear(y, x, x + n);
    }

    fn delete_cells(&mut self, n: i32) {
        let (x, y, cols) = (self.cur.x.min(self.cols - 1), self.cur.y, self.cols);
        let n = n.min(cols - x);
        let g = self.g();
        let row = g.row(y);
        g.cells.copy_within(row + (x + n) as usize..row + cols as usize, row + x as usize);
        g.attrs.copy_within(row + (x + n) as usize..row + cols as usize, row + x as usize);
        self.clear(y, cols - n, cols);
    }

    /// Follows `text` as the terminal will read it.
    pub fn feed(&mut self, text: &[u16]) {
        let mut i = 0;
        while i < text.len() {
            if self.st == St::Ground && (0x20..0x7f).contains(&text[i]) && self.cur.x < self.cols && !self.insert && !self.charsets[self.gl] {
                // A run of ASCII within the row: one cell each, stored at once.
                let (x, cols, a) = (self.cur.x as usize, self.cols as usize, self.attr);
                let n = text[i..].iter().take(cols - x).take_while(|&&c| (0x20..0x7f).contains(&c)).count();
                let y = self.cur.y;
                let g = self.g();
                let at = g.row(y) + x;
                if x > 0 && g.cells[at] == TRAIL {
                    g.cells[at - 1] = 0;
                }
                if x + n < cols && g.cells[at + n] == TRAIL {
                    g.cells[at + n] = 0;
                }
                for (cell, &c) in g.cells[at..at + n].iter_mut().zip(&text[i..i + n]) {
                    *cell = c as u32;
                }
                g.attrs[at..at + n].fill(a);
                self.cur.x += n as i32;
                self.last = text[i + n - 1] as u32;
                i += n;
                continue;
            }
            let mut c = text[i] as u32;
            i += 1;
            if (0xd800..0xdc00).contains(&c) && i < text.len() && (0xdc00..0xe000).contains(&text[i]) {
                c = 0x10000 + ((c - 0xd800) << 10) + (text[i] as u32 - 0xdc00);
                i += 1;
            }
            self.step(c);
        }
    }

    fn step(&mut self, c: u32) {
        match self.st {
            St::Ground => match c {
                0x1b => self.st = St::Esc,
                0x08 => {
                    self.restrict(self.cols - 1);
                    if self.cur.x > 0 {
                        self.cur.x -= 1;
                    }
                }
                0x09 => {
                    if self.cur.x < self.cols {
                        self.cur.x = ((self.cur.x / 8 + 1) * 8).min(self.cols - 1);
                    }
                }
                0x0a..=0x0c => self.line_feed(),
                0x0d => self.cur.x = 0,
                0x0e => self.gl = 1,
                0x0f => self.gl = 0,
                0x84 => self.index(),
                0x85 => {
                    self.cur.x = 0;
                    self.index()
                }
                0x9b => self.csi_start(),
                0x90 | 0x9d | 0x9e | 0x9f | 0x98 => self.st = St::Str,
                0..=0x1f | 0x7f..=0x9f | 0xfeff => {}
                _ => self.print(c),
            },
            St::Esc => {
                self.st = St::Ground;
                match c {
                    0x5b => self.csi_start(),                              // [
                    0x5d | 0x50 | 0x5f | 0x5e | 0x58 => self.st = St::Str, // ] P _ ^ X
                    0x20..=0x2f => {
                        self.esc_inter = c;
                        self.st = St::EscInter;
                    }
                    0x37 => self.save(),
                    0x38 => self.restore(),
                    0x44 => self.index(),
                    0x45 => {
                        self.cur.x = 0;
                        self.index()
                    }
                    0x4d => self.reverse_index(),
                    0x63 => *self = Screen::new(self.cols, self.rows),
                    _ => {}
                }
            }
            St::EscInter => {
                if !(0x20..=0x2f).contains(&c) {
                    self.st = St::Ground;
                    if let Some(g) = [0x28, 0x29, 0x2a, 0x2b].iter().position(|&i| i == self.esc_inter) {
                        self.charsets[g] = c == 0x30;
                    }
                }
            }
            St::Csi => match c {
                0x30..=0x39 => {
                    let p = &mut self.params[self.np];
                    *p = p.saturating_mul(10).saturating_add(c as i32 - 0x30);
                }
                0x3b | 0x3a => {
                    if self.np < 15 {
                        self.np += 1;
                        self.params[self.np] = 0;
                    }
                }
                0x3c..=0x3f | 0x20..=0x2f => self.prefix = self.prefix << 8 | c,
                0x40..=0x7e => {
                    self.st = St::Ground;
                    self.csi(c);
                }
                0x1b => self.st = St::Esc,
                _ => {}
            },
            St::Str => match c {
                0x07 | 0x9c => self.st = St::Ground,
                0x1b => self.st = St::StrEsc,
                _ => {}
            },
            St::StrEsc => self.st = if c == 0x5c { St::Ground } else { St::Str },
        }
    }

    fn csi_start(&mut self) {
        self.st = St::Csi;
        self.params = [0; 16];
        self.np = 0;
        self.prefix = 0;
    }

    fn save(&mut self) {
        self.saved[self.alt as usize] = Cur { attr: self.attr, ..self.cur };
    }

    fn restore(&mut self) {
        let s = self.saved[self.alt as usize];
        self.cur = s;
        self.attr = s.attr;
        self.restrict(self.cols - 1);
    }

    fn reverse_index(&mut self) {
        self.restrict(self.cols - 1);
        if self.cur.y == self.top {
            self.shift(self.top, self.bottom, -1);
        } else {
            self.cur.y -= 1;
            self.restrict(self.cols - 1);
        }
    }

    fn csi(&mut self, f: u32) {
        let n = self.np + 1;
        let p0 = self.params[0];
        let p1 = if n > 1 { self.params[1] } else { 0 };
        let one = |p: i32| if p == 0 { 1 } else { p };
        let cols = self.cols;
        match (self.prefix, f) {
            (0, 0x41) => {
                let up = if self.cur.y >= self.top { (self.cur.y - self.top).min(one(p0)) } else { one(p0) };
                self.move_by(0, -up)
            }
            (0, 0x42) => {
                let down = if self.bottom >= self.cur.y { (self.bottom - self.cur.y).min(one(p0)) } else { one(p0) };
                self.move_by(0, down)
            }
            (0, 0x43) | (0, 0x61) => self.move_by(one(p0), 0),
            (0, 0x44) => self.move_by(-one(p0), 0),
            (0, 0x45) | (0, 0x46) => {
                self.prefix = 0;
                self.csi(if f == 0x45 { 0x42 } else { 0x41 });
                self.cur.x = 0
            }
            (0, 0x47) | (0, 0x60) => {
                let y = if self.origin { self.cur.y - self.top } else { self.cur.y };
                self.goto(one(p0) - 1, y)
            }
            (0, 0x48) | (0, 0x66) => self.goto(if n >= 2 { one(p1) - 1 } else { 0 }, one(p0) - 1),
            (0, 0x49) => {
                if self.cur.x < self.cols {
                    for _ in 0..one(p0).min(self.cols) {
                        self.cur.x = ((self.cur.x / 8 + 1) * 8).min(self.cols - 1);
                    }
                }
            }
            (0, 0x5a) => {
                if self.cur.x < self.cols {
                    for _ in 0..one(p0).min(self.cols) {
                        self.cur.x = if self.cur.x <= 0 { 0 } else { (self.cur.x - 1) / 8 * 8 };
                    }
                }
            }
            (0, 0x4a) | (0x3f, 0x4a) => {
                self.restrict(self.cols);
                let (x, y) = (self.cur.x, self.cur.y);
                let (rows, line) = match p0 {
                    0 => (y + 1..self.rows, (x, cols)),
                    1 => (0..y, (0, x + 1)),
                    2 => (0..self.rows, (0, 0)),
                    _ => return,
                };
                self.clear(y, line.0, line.1);
                for r in rows {
                    self.clear(r, 0, cols);
                }
            }
            (0, 0x4b) | (0x3f, 0x4b) => {
                self.restrict(self.cols);
                let (x, y) = (self.cur.x, self.cur.y);
                match p0 {
                    0 => self.clear(y, x, cols),
                    1 => self.clear(y, 0, x + 1),
                    2 => self.clear(y, 0, cols),
                    _ => {}
                }
            }
            (0, 0x4c) | (0, 0x4d) => {
                self.restrict(self.cols - 1);
                if self.cur.y <= self.bottom && self.cur.y >= self.top {
                    let k = one(p0).min(self.rows);
                    self.shift(self.cur.y, self.bottom, if f == 0x4c { -k } else { k });
                    self.cur.x = 0;
                }
            }
            (0, 0x40) => {
                self.restrict(self.cols - 1);
                self.insert_cells(one(p0));
            }
            (0, 0x50) => {
                self.restrict(self.cols - 1);
                self.delete_cells(one(p0));
            }
            (0, 0x58) => {
                self.restrict(self.cols - 1);
                let (x, y) = (self.cur.x, self.cur.y);
                self.clear(y, x, x.saturating_add(one(p0)));
            }
            (0, 0x53) => self.shift(self.top, self.bottom, one(p0).min(self.rows)),
            (0, 0x54) if n == 1 => self.shift(self.top, self.bottom, -one(p0).min(self.rows)),
            (0, 0x62) => {
                if self.last != 0 {
                    for _ in 0..one(p0).min(65536) {
                        self.print(self.last);
                    }
                }
            }
            (0, 0x64) => self.goto(self.cur.x, one(p0) - 1),
            (0, 0x65) => self.move_by(0, one(p0)),
            (0, 0x72) => {
                let top = one(p0);
                let bottom = if n < 2 || p1 > self.rows || p1 == 0 { self.rows } else { p1 };
                if bottom > top {
                    self.top = top - 1;
                    self.bottom = bottom - 1;
                    self.goto(0, 0);
                }
            }
            (0, 0x73) => self.save(),
            (0, 0x75) => self.restore(),
            (0, 0x6d) => self.sgr(n),
            (0, 0x68) | (0, 0x6c) => {
                if self.params[..n].contains(&4) {
                    self.insert = f == 0x68;
                }
            }
            (0x3f, 0x68) | (0x3f, 0x6c) => {
                for i in 0..n {
                    self.private(self.params[i], f == 0x68);
                }
            }
            (0x21, 0x70) => {
                // DECSTR
                self.top = 0;
                self.bottom = self.rows - 1;
                self.origin = false;
                self.wrap = true;
                self.insert = false;
                self.saved[self.alt as usize] = Cur { attr: 7, ..Cur::default() };
                self.attr = 7;
            }
            _ => {}
        }
    }

    fn private(&mut self, mode: i32, on: bool) {
        match mode {
            6 => {
                self.origin = on;
                self.goto(0, 0)
            }
            7 => self.wrap = on,
            1048 if on => self.save(),
            1048 => self.restore(),
            1049 | 47 | 1047 if on => {
                if mode == 1049 {
                    self.save()
                }
                if !self.alt {
                    self.alt = true;
                    if mode != 47 {
                        for r in 0..self.rows {
                            self.clear(r, 0, self.cols);
                        }
                    }
                }
            }
            1049 | 47 | 1047 => {
                self.alt = false;
                if mode == 1049 {
                    self.restore()
                }
            }
            _ => {}
        }
    }

    /// Legacy attributes from SGR: the 16 colors, extended ones by their nearest, reverse and underline.
    fn sgr(&mut self, n: usize) {
        const MAP: [u16; 8] = [0, 4, 2, 6, 1, 5, 3, 7]; // ANSI order to the console's BGR bits
        let mut i = 0;
        while i < n {
            let p = self.params[i];
            let mut a = self.attr;
            match p {
                0 => a = 7,
                1 => a |= 0x08,
                22 => a &= !0x08,
                4 => a |= UNDERSCORE,
                24 => a &= !UNDERSCORE,
                7 => a |= REVERSE,
                27 => a &= !REVERSE,
                30..=37 => a = a & !0x07 | MAP[(p - 30) as usize],
                39 => a = a & !0x0f | 7,
                40..=47 => a = a & !0x70 | MAP[(p - 40) as usize] << 4,
                49 => a &= !0xf0,
                90..=97 => a = a & !0x0f | MAP[(p - 90) as usize] | 8,
                100..=107 => a = a & !0xf0 | (MAP[(p - 100) as usize] | 8) << 4,
                38 | 48 => {
                    let q = &self.params[i + 1..n];
                    let (color, used) = match q {
                        [5, c, ..] => (Some(nearest256(*c)), 2),
                        [2, r, g, b, ..] => (Some(nearest(*r, *g, *b)), 4),
                        _ => (None, 0),
                    };
                    if let Some(c) = color {
                        let c = MAP[(c & 7) as usize] | (c & 8);
                        a = if p == 38 { a & !0x0f | c } else { a & !0xf0 | c << 4 };
                    }
                    i += used;
                }
                _ => {}
            }
            self.attr = a;
            i += 1;
        }
    }
}

/// The nearest of the 16 ANSI colors (ANSI order) to a 256-color index.
fn nearest256(c: i32) -> u16 {
    match c {
        0..=15 => c as u16,
        16..=231 => {
            let v = |k: i32| if k == 0 { 0 } else { 55 + k * 40 };
            let k = c - 16;
            nearest(v(k / 36), v(k / 6 % 6), v(k % 6))
        }
        _ => {
            let g = 8 + (c.clamp(232, 255) - 232) * 10;
            nearest(g, g, g)
        }
    }
}

/// The nearest of the 16 ANSI colors (Campbell, ANSI order) to an RGB color.
fn nearest(r: i32, g: i32, b: i32) -> u16 {
    const RGB: [(i32, i32, i32); 16] = [
        (12, 12, 12), (197, 15, 31), (19, 161, 14), (193, 156, 0), (0, 55, 218), (136, 23, 152), (58, 150, 221), (204, 204, 204),
        (118, 118, 118), (231, 72, 86), (22, 198, 12), (249, 241, 165), (59, 120, 255), (180, 0, 158), (97, 214, 214), (242, 242, 242),
    ];
    let d = |(cr, cg, cb): (i32, i32, i32)| (cr - r.clamp(0, 255)).pow(2) + (cg - g.clamp(0, 255)).pow(2) + (cb - b.clamp(0, 255)).pow(2);
    (0..16).min_by_key(|&i| d(RGB[i])).unwrap_or(7) as u16
}
