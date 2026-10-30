//! Zip archives, as themes travel: listing and unpacking one, its files stored or deflated (RFC 1951), and writing
//! one that stores each file as it is. An archive comes from anywhere, so every length in it is checked before it's
//! used, and a name that would land outside the folder it unpacks into refuses the whole archive.
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

/// The most entries an archive may hold, and bytes it may unpack to: far past any theme, far short of a full disk.
const MAX_FILES: usize = 4096;
const MAX_BYTES: u64 = 256 << 20;
const BROKEN: &str = "it isn't a .zip nook can read";

/// An archive to read: a file, or bytes in memory. One copy of the reader serves both.
pub trait Source: Read + Seek {}
impl<T: Read + Seek> Source for T {}

pub struct Entry {
    /// Its path in the archive as `path` makes it.
    pub name: String,
    pub dir: bool,
    method: u16,
    crc: u32,
    packed: u64,
    size: u64,
    /// Where its local header starts.
    at: u64,
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}

fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

fn read_at(r: &mut dyn Source, at: u64, len: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0; len];
    r.seek(SeekFrom::Start(at)).and_then(|_| r.read_exact(&mut buf)).map_err(|_| BROKEN)?;
    Ok(buf)
}

/// A name in an archive as a relative path, its parts joined by `/`, or None when it would leave the folder it
/// unpacks into: absolute, on a drive, through `..` (or `...`, which Windows reads as it), or into a stream (`:`).
pub fn path(name: &str) -> Option<String> {
    if name.starts_with(['/', '\\']) {
        return None;
    }
    let parts: Vec<_> = name.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".").collect();
    let bad = |p: &&str| p.contains(':') || p.trim_end_matches(['.', ' ']).is_empty();
    (!parts.iter().any(bad)).then(|| parts.join("/"))
}

/// Code page 437's upper half, which a name without the UTF-8 flag is in unless it reads as UTF-8.
const CP437: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u{a0}";

fn name(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.into(),
        Err(_) => raw.iter().map(|&b| if b < 0x80 { b as char } else { CP437.chars().nth(b as usize - 0x80).unwrap() }).collect(),
    }
}

/// The archive's entries, from the central directory at its end.
pub fn entries(r: &mut dyn Source) -> Result<Vec<Entry>, String> {
    let len = r.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    let tail = read_at(r, len.saturating_sub(22 + 0xffff), len.min(22 + 0xffff) as usize)?;
    let end = (0..tail.len().saturating_sub(21)).rev().find(|&i| tail[i..].starts_with(b"PK\x05\x06")).ok_or(BROKEN)?;
    let (count, size, offset) = (u16_at(&tail, end + 10) as usize, u32_at(&tail, end + 12) as u64, u32_at(&tail, end + 16) as u64);
    let dir_end = len - (tail.len() - end) as u64;
    if offset + size > dir_end || size > 16 << 20 {
        return Err(BROKEN.into()); // a zip64 archive, which no theme needs, lands here too
    }
    if count > MAX_FILES {
        return Err(format!("it holds over {MAX_FILES} files"));
    }
    let dir = read_at(r, offset, size as usize)?;
    let (mut list, mut at, mut total) = (Vec::with_capacity(count), 0, 0);
    for _ in 0..count {
        let h = dir.get(at..at + 46).filter(|h| h.starts_with(b"PK\x01\x02")).ok_or(BROKEN)?;
        let (n, extra) = (u16_at(h, 28) as usize, u16_at(h, 30) as usize + u16_at(h, 32) as usize);
        let raw = dir.get(at + 46..at + 46 + n).ok_or(BROKEN)?;
        let (flags, packed, size, local) = (u16_at(h, 8), u32_at(h, 20) as u64, u32_at(h, 24) as u64, u32_at(h, 42) as u64);
        at += 46 + n + extra;
        if flags & 1 != 0 {
            return Err("it's encrypted".into());
        }
        let name = path(&name(raw)).ok_or_else(|| format!("{} would unpack outside its folder", String::from_utf8_lossy(raw)))?;
        total += size;
        if total > MAX_BYTES {
            return Err(format!("it unpacks to over {} MB", MAX_BYTES >> 20));
        }
        if local + 30 + packed > offset {
            return Err(BROKEN.into());
        }
        let dir = name.is_empty() || raw.ends_with(b"/") || raw.ends_with(b"\\");
        list.push(Entry { name, dir, method: u16_at(h, 10), crc: u32_at(h, 16), packed, size, at: local });
    }
    Ok(list)
}

/// An entry's bytes, unpacked and checked against its CRC.
pub fn read(r: &mut dyn Source, e: &Entry) -> Result<Vec<u8>, String> {
    let head = read_at(r, e.at, 30)?;
    if !head.starts_with(b"PK\x03\x04") {
        return Err(BROKEN.into());
    }
    let data = read_at(r, e.at + 30 + u16_at(&head, 26) as u64 + u16_at(&head, 28) as u64, e.packed as usize)?;
    let bytes = match e.method {
        0 if e.packed == e.size => data,
        8 => inflate(&data, e.size as usize).map_err(|why| format!("{}: {why}", e.name))?,
        0 => return Err(BROKEN.into()),
        m => return Err(format!("{} is packed in a way nook doesn't read ({m})", e.name)),
    };
    if crc32(&bytes) != e.crc {
        return Err(format!("{} is damaged", e.name));
    }
    Ok(bytes)
}

/// Unpacks every entry into the folder `to`.
pub fn extract(r: &mut dyn Source, to: &Path) -> Result<(), String> {
    for e in entries(r)? {
        let path = to.join(&e.name);
        let bytes = if e.dir { None } else { Some(read(r, &e)?) };
        let made = match bytes {
            None => fs::create_dir_all(&path),
            Some(bytes) => fs::create_dir_all(path.parent().unwrap()).and_then(|()| fs::write(&path, bytes)),
        };
        made.map_err(|err| format!("{}: {err}", e.name))?;
    }
    Ok(())
}

/// Writes a zip of `files`, each its name in the archive and the file on disk, storing each as it is: a theme's
/// pictures and fonts are packed already.
pub fn write(out: &mut dyn Write, files: &[(String, PathBuf)]) -> Result<(), String> {
    let too_big = || "it's over 4 GB".to_string();
    let (mut at, mut dir) = (0u64, Vec::new());
    for (name, path) in files {
        let data = fs::read(path).map_err(|e| format!("{name}: {e}"))?;
        let size = u32::try_from(data.len()).map_err(|_| too_big())?;
        // version 2.0, UTF-8 names, stored, at midnight on 1 January 1980
        let common = [(20, 2), (0x800, 2), (0, 2), (0, 2), (0x21, 2), (crc32(&data), 4), (size, 4), (size, 4), (name.len() as u32, 2), (0, 2)];
        let mut local = Vec::with_capacity(30 + name.len());
        fields(&mut local, &[(0x0403_4b50, 4)]);
        fields(&mut local, &common);
        local.extend_from_slice(name.as_bytes());
        out.write_all(&local).and_then(|()| out.write_all(&data)).map_err(|e| e.to_string())?;
        fields(&mut dir, &[(0x0201_4b50, 4), (20, 2)]);
        fields(&mut dir, &common);
        fields(&mut dir, &[(0, 2), (0, 2), (0, 2), (0, 4), (u32::try_from(at).map_err(|_| too_big())?, 4)]);
        dir.extend_from_slice(name.as_bytes());
        at += (local.len() + data.len()) as u64;
    }
    let count = u16::try_from(files.len()).map_err(|_| "it holds too many files")? as u32;
    let mut end = Vec::with_capacity(22);
    fields(&mut end, &[(0x0605_4b50, 4), (0, 2), (0, 2), (count, 2), (count, 2), (dir.len() as u32, 4), (u32::try_from(at).map_err(|_| too_big())?, 4), (0, 2)]);
    out.write_all(&dir).and_then(|()| out.write_all(&end)).map_err(|e| e.to_string())
}

/// Appends each value, little-endian, in the number of bytes given.
fn fields(v: &mut Vec<u8>, list: &[(u32, usize)]) {
    for &(x, n) in list {
        v.extend_from_slice(&x.to_le_bytes()[..n]);
    }
}

const CRC: [u32; 256] = {
    let mut table = [0; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 == 1 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
};

pub fn crc32(bytes: &[u8]) -> u32 {
    !bytes.iter().fold(!0, |c, &b| CRC[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8))
}

/// DEFLATE's input, read from its low bits up.
struct Bits<'a> {
    data: &'a [u8],
    /// The next byte not yet in `bits`.
    at: usize,
    bits: u64,
    n: u32,
}

impl Bits<'_> {
    /// Tops `bits` up to 56 or more, or with all that's left. Called once every few codes, so it stays one copy.
    #[inline(never)]
    fn fill(&mut self) {
        if let Some(word) = self.data.get(self.at..self.at + 8) {
            // Bits past `n` already hold the next byte's low bits, the same ones this puts there.
            self.bits |= u64::from_le_bytes(word.try_into().unwrap()) << self.n;
            self.at += (63 - self.n as usize) >> 3;
            self.n |= 56;
        } else {
            while self.n <= 56 && self.at < self.data.len() {
                self.bits |= (self.data[self.at] as u64) << self.n;
                self.at += 1;
                self.n += 8;
            }
        }
    }

    fn take(&mut self, k: u32) -> Result<u32, &'static str> {
        if self.n < k {
            self.fill();
            if self.n < k {
                return Err("it ends early");
            }
        }
        let v = (self.bits & ((1 << k) - 1)) as u32;
        self.bits >>= k;
        self.n -= k;
        Ok(v)
    }

    fn decode(&mut self, h: &Huffman) -> Result<usize, &'static str> {
        if self.n < 15 {
            self.fill();
        }
        let e = h.table[(self.bits & ((1 << h.bits) - 1)) as usize] as u32;
        let len = e & 15;
        if len == 0 || len > self.n {
            return Err(if len == 0 { "it holds a code its table lacks" } else { "it ends early" });
        }
        self.bits >>= len;
        self.n -= len;
        Ok((e >> 4) as usize)
    }
}

/// A canonical Huffman code as a table of every `bits`-bit input: its symbol and its code's length, `sym << 4 | len`.
/// 0 is no code.
#[derive(Default)]
struct Huffman {
    table: Vec<u16>,
    bits: u32,
}

impl Huffman {
    fn new(lens: &[u8]) -> Result<Huffman, &'static str> {
        let mut count = [0u32; 16];
        for &l in lens {
            count[l as usize] += 1;
        }
        count[0] = 0;
        let mut left = 1i32;
        for &c in &count[1..] {
            left = left * 2 - c as i32;
            if left < 0 {
                return Err("its codes overflow");
            }
        }
        let bits = (1..16).rev().find(|&l| count[l] != 0).unwrap_or(1) as u32;
        let mut next = [0u32; 16];
        for l in 1..16 {
            next[l] = (next[l - 1] + count[l - 1]) << 1;
        }
        let mut table = vec![0u16; 1 << bits];
        for (sym, &l) in lens.iter().enumerate().filter(|(_, &l)| l != 0) {
            let code = next[l as usize].reverse_bits() >> (32 - l);
            next[l as usize] += 1;
            for i in (code as usize..table.len()).step_by(1 << l) {
                table[i] = (sym << 4) as u16 | l as u16;
            }
        }
        Ok(Huffman { table, bits })
    }
}

const LEN_BASE: [u16; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE: [u16; 30] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA: [u8; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/// The order a dynamic block lists its code-length code's lengths in.
const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/// Raw DEFLATE `data`, which must unpack to exactly `size` bytes.
pub fn inflate(data: &[u8], size: usize) -> Result<Vec<u8>, &'static str> {
    const TOO_BIG: &str = "it unpacks to more than it says";
    // No deflate stream grows past 1032 times its size, so a size it lies about allocates no more than that.
    let mut out = Vec::with_capacity(size.min(data.len().saturating_mul(1032)));
    let mut b = Bits { data, at: 0, bits: 0, n: 0 };
    loop {
        let last = b.take(1)?;
        let (lit, dist) = match b.take(2)? {
            0 => {
                // Stored: from the next whole byte, which may be in `bits` already.
                b.bits = 0;
                b.at -= (b.n / 8) as usize;
                b.n = 0;
                let head = data.get(b.at..b.at + 4).ok_or("it ends early")?;
                let len = u16_at(head, 0) as usize;
                if u16_at(head, 2) != !(len as u16) {
                    return Err("a stored block's length is damaged");
                }
                let bytes = data.get(b.at + 4..b.at + 4 + len).ok_or("it ends early")?;
                if out.len() + len > size {
                    return Err(TOO_BIG);
                }
                out.extend_from_slice(bytes);
                b.at += 4 + len;
                if last == 1 {
                    break;
                }
                continue;
            }
            1 => {
                let mut lens = [8u8; 288];
                lens[144..256].fill(9);
                lens[256..280].fill(7);
                (Huffman::new(&lens)?, Huffman::new(&[5; 30])?)
            }
            2 => {
                let (lits, dists, codes) = (b.take(5)? as usize + 257, b.take(5)? as usize + 1, b.take(4)? as usize + 4);
                if lits > 286 || dists > 30 {
                    return Err("a block's header is damaged");
                }
                let mut code_lens = [0u8; 19];
                for &i in &ORDER[..codes] {
                    code_lens[i] = b.take(3)? as u8;
                }
                let code = Huffman::new(&code_lens)?;
                let mut lens = [0u8; 316];
                let mut i = 0;
                while i < lits + dists {
                    let (len, repeat) = match b.decode(&code)? {
                        16 if i > 0 => (lens[i - 1], 3 + b.take(2)?),
                        16 => return Err("a block's header is damaged"),
                        17 => (0, 3 + b.take(3)?),
                        18 => (0, 11 + b.take(7)?),
                        len => (len as u8, 1),
                    };
                    let to = i + repeat as usize;
                    lens.get_mut(i..to).ok_or("a block's header is damaged")?.fill(len);
                    i = to;
                }
                if i != lits + dists {
                    return Err("a block's header is damaged");
                }
                (Huffman::new(&lens[..lits])?, Huffman::new(&lens[lits..i])?)
            }
            _ => return Err("it holds a block of no known kind"),
        };
        loop {
            let sym = b.decode(&lit)?;
            if sym < 256 {
                if out.len() == size {
                    return Err(TOO_BIG);
                }
                out.push(sym as u8);
                continue;
            }
            if sym == 256 {
                break;
            }
            let i = sym - 257;
            if i >= 29 {
                return Err("it holds a length of no known kind");
            }
            let len = LEN_BASE[i] as usize + b.take(LEN_EXTRA[i] as u32)? as usize;
            let d = b.decode(&dist)?;
            if d >= 30 {
                return Err("it holds a distance of no known kind");
            }
            let d = DIST_BASE[d] as usize + b.take(DIST_EXTRA[d] as u32)? as usize;
            if d > out.len() {
                return Err("it reaches back before its start");
            }
            if out.len() + len > size {
                return Err(TOO_BIG);
            }
            let from = out.len() - d;
            if d >= len {
                out.extend_from_within(from..from + len);
            } else {
                for k in from..from + len {
                    out.push(out[k]);
                }
            }
        }
        if last == 1 {
            break;
        }
    }
    if out.len() != size {
        return Err("it unpacks to less than it says");
    }
    Ok(out)
}
