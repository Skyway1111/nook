// A terminal without a screen: parses what a program writes, keeps the normal buffer with its scrollback and the
// alternate one, and answers what the program asks. Its behavior is xterm.js's, which Claude Code and ConPTY
// were built against. No DOM: the view reads it through `buffer`.
import { wcwidth } from './wcwidth.js'

// A cell is three words. content: code point | COMBINED | width << 22, where an empty cell has width 1 and the
// right half of a wide character width 0. fg: color | color mode | flags. bg: color | color mode | flags.
export const CP = 0x1fffff
export const COMBINED = 0x200000 // the cell's text is in its line's `comb`: a base and the marks joined to it
export const CONTENT = 0x3fffff
const W1 = 1 << 22 // an empty cell
export const CM = 0x3000000
export const P16 = 0x1000000
export const P256 = 0x2000000
export const RGB = 0x3000000
export const INVERSE = 0x4000000 // fg
export const BOLD = 0x8000000 // fg
export const UNDERLINE = 0x10000000 // fg
export const BLINK = 0x20000000 // fg
export const INVISIBLE = 0x40000000 // fg
export const STRIKE = 0x80000000 // fg
export const ITALIC = 0x4000000 // bg
export const DIM = 0x8000000 // bg
export const EXT = 0x10000000 // bg: the cell's underline style, underline color or link is in its line's `ext`
export const OVERLINE = 0x40000000 // bg
const COLOR = CM | 0xffffff

/** Underline style (0-5), underline color (a color word without flags), link id, and a sixel or iTerm2
 * picture's id and the tile of it the cell shows. Never changed once made. */
class Ext {
  constructor(ul = 0, ulc = 0, url = 0, img = 0, tile = 0) {
    this.ul = ul
    this.ulc = ulc
    this.url = url
    this.img = img
    this.tile = tile
  }
  /** A link's cells are underlined dashed, as xterm has it. */
  get style() { return this.url ? 5 : this.ul }
}
const NO_EXT = new Ext()

/** One row of cells, kept in planes: content, then fg, then bg, each `cap` long. */
class Line {
  constructor(cols, bg = 0, wrapped = false) {
    this.cap = cols
    this.length = cols
    this.d = new Uint32Array(cols * 3)
    this.isWrapped = wrapped
    this.comb = null // Map x -> grapheme, for cells with COMBINED
    this.ext = null // Map x -> Ext, for cells whose bg has EXT
    this.d.fill(W1, 0, cols)
    if (bg) this.d.fill(bg, 2 * cols, 3 * cols)
  }

  /** Empties every cell, keeping `bg` (an erase keeps only the background). */
  fill(bg) {
    const { d, cap: c, length: n } = this
    d.fill(W1, 0, n)
    d.fill(0, c, c + n)
    d.fill(bg, 2 * c, 2 * c + n)
    this.comb = this.ext = null
  }

  /** Empties cells `from` to `to`, keeping `bg`. */
  clear(from, to, bg) {
    const { d, cap: c } = this
    d.fill(W1, from, to)
    d.fill(0, c + from, c + to)
    d.fill(bg, 2 * c + from, 2 * c + to)
  }

  set(x, content, fg, bg, ext) {
    const { d, cap: c } = this
    d[x] = content
    d[c + x] = fg
    d[2 * c + x] = bg
    if (bg & EXT) (this.ext ??= new Map()).set(x, ext)
  }

  width(x) { return this.d[x] >>> 22 }
  hasContent(x) { return this.d[x] & CONTENT }

  /** The cell's text: '' when empty. */
  chars(x) {
    const c = this.d[x]
    return c & COMBINED ? this.comb.get(x) : c & CP ? String.fromCodePoint(c & CP) : ''
  }

  /** Loads cell `x` into `cell`, as xterm's `getCell`. */
  getCell(x, cell = new Cell()) {
    if (x < 0 || x >= this.length) return undefined
    const { d, cap: c } = this
    cell.content = d[x]
    cell.fg = d[c + x]
    cell.bg = d[2 * c + x]
    cell.comb = cell.content & COMBINED ? this.comb.get(x) : ''
    cell.ext = cell.bg & EXT ? this.ext.get(x) : NO_EXT
    return cell
  }

  /** Cells up to the last one with text. */
  getTrimmedLength() {
    const d = this.d
    for (let i = this.length - 1; i >= 0; i--) if (d[i] & CONTENT) return i + (d[i] >>> 22)
    return 0
  }

  /** Cells up to the last one with text or a background color. */
  getNoBgTrimmedLength() {
    const { d, cap: c } = this
    for (let i = this.length - 1; i >= 0; i--) if (d[i] & CONTENT || d[2 * c + i] & CM) return i + (d[i] >>> 22)
    return 0
  }

  /** The row's text; an empty cell reads as a space, and `trim` drops the empty cells at the end. */
  translateToString(trim = false, start = 0, end = this.length) {
    if (trim) end = Math.min(end, this.getTrimmedLength())
    const d = this.d
    let s = ''
    while (start < end) {
      const c = d[start]
      s += c & COMBINED ? this.comb.get(start) : c & CP ? String.fromCodePoint(c & CP) : ' '
      start += c >>> 22 || 1
    }
    return s
  }

  /** Moves cells `from`..`from + n` to `to`, with their graphemes and extras. */
  move(from, to, n) {
    const { d, cap: c } = this
    d.copyWithin(to, from, from + n)
    d.copyWithin(c + to, c + from, c + from + n)
    d.copyWithin(2 * c + to, 2 * c + from, 2 * c + from + n)
    for (const key of ['comb', 'ext']) {
      const map = this[key]
      if (!map) continue
      const moved = new Map()
      for (const [x, v] of map) {
        if (x >= from && x < from + n) moved.set(x - from + to, v)
        else if (x < to || x >= to + n) moved.set(x, v)
      }
      this[key] = moved
    }
  }

  insertCells(pos, n, fg, bg, ext) {
    pos %= this.length
    if (pos && this.width(pos - 1) === 2) this.set(pos - 1, W1, fg, bg, ext)
    if (n < this.length - pos) {
      this.move(pos, pos + n, this.length - pos - n)
      for (let i = 0; i < n; i++) this.set(pos + i, W1, fg, bg, ext)
    } else for (let i = pos; i < this.length; i++) this.set(i, W1, fg, bg, ext)
    if (this.width(this.length - 1) === 2) this.set(this.length - 1, W1, fg, bg, ext)
  }

  deleteCells(pos, n, bg) {
    pos %= this.length
    if (n < this.length - pos) {
      this.move(pos + n, pos, this.length - pos - n)
      this.clear(this.length - n, this.length, bg)
    } else this.clear(pos, this.length, bg)
    if (pos && this.width(pos - 1) === 2) this.set(pos - 1, W1, 0, bg)
    if (this.width(pos) === 0 && !this.hasContent(pos)) this.set(pos, W1, 0, bg)
  }

  /** Empties cells `start` to `end`, and both halves of a wide character cut at either edge. */
  replaceCells(start, end, bg) {
    if (start && this.width(start - 1) === 2) this.set(start - 1, W1, 0, bg)
    if (end < this.length && this.width(end - 1) === 2) this.set(end, W1, 0, bg)
    if (end > this.length) end = this.length
    if (start < end) this.clear(start, end, bg)
  }

  /** Sets the row's width, emptying cells it gains. Room grows in steps of 32 cells, so a dragged window edge
   * doesn't make every line of scrollback copy itself at each step. */
  resize(cols) {
    if (cols > this.cap) {
      const { d, cap: c, length: n } = this
      const cap = cols + 31 & ~31
      const next = new Uint32Array(cap * 3)
      next.set(d.subarray(0, n))
      next.set(d.subarray(c, c + n), cap)
      next.set(d.subarray(2 * c, 2 * c + n), 2 * cap)
      this.d = next
      this.cap = cap
    }
    if (cols > this.length) this.clear(this.length, cols, 0)
    this.length = cols
  }

  /** Copies `n` cells of `src` from `srcCol` to `destCol`. */
  copyCellsFrom(src, srcCol, destCol, n) {
    const { d, cap: c } = this
    const s = src.d
    const sc = src.cap
    if (src === this && destCol > srcCol) {
      for (let k = n - 1; k >= 0; k--) {
        d[destCol + k] = d[srcCol + k]
        d[c + destCol + k] = d[c + srcCol + k]
        d[2 * c + destCol + k] = d[2 * c + srcCol + k]
      }
    } else {
      for (let k = 0; k < n; k++) {
        d[destCol + k] = s[srcCol + k]
        d[c + destCol + k] = s[sc + srcCol + k]
        d[2 * c + destCol + k] = s[2 * sc + srcCol + k]
      }
    }
    if (src.comb) for (const [x, v] of src.comb) if (x >= srcCol && x < srcCol + n) (this.comb ??= new Map()).set(x - srcCol + destCol, v)
    if (src.ext) for (const [x, v] of src.ext) if (x >= srcCol && x < srcCol + n) (this.ext ??= new Map()).set(x - srcCol + destCol, v)
  }
}

/** One cell's text and attributes, read by `getCell`; one Cell is reused across reads. */
export class Cell {
  content = W1
  fg = 0
  bg = 0
  comb = ''
  ext = NO_EXT
  getChars() { return this.content & COMBINED ? this.comb : this.content & CP ? String.fromCodePoint(this.content & CP) : '' }
  getCode() { return this.content & COMBINED ? this.comb.charCodeAt(this.comb.length - 1) : this.content & CP }
  getWidth() { return this.content >>> 22 }
  isCombined() { return this.content & COMBINED }
  isBold() { return this.fg & BOLD }
  isInverse() { return this.fg & INVERSE }
  isBlink() { return this.fg & BLINK }
  isInvisible() { return this.fg & INVISIBLE }
  isStrikethrough() { return this.fg & STRIKE }
  isItalic() { return this.bg & ITALIC }
  isDim() { return this.bg & DIM }
  isOverline() { return this.bg & OVERLINE }
  isUnderline() { return this.bg & EXT && this.ext.style ? 1 : this.fg & UNDERLINE }
  getUnderlineStyle() { return this.fg & UNDERLINE ? (this.bg & EXT ? this.ext.style : 1) : 0 }
  /** The underline's color word, or the foreground's when it has none. */
  getUnderlineColorWord() { return this.bg & EXT && this.ext.ulc ? this.ext.ulc : this.fg & COLOR }
  /** The OSC 8 link id, 0 for none. */
  getLink() { return this.bg & EXT ? this.ext.url : 0 }
  getFgColorMode() { return this.fg & CM }
  getBgColorMode() { return this.bg & CM }
  isFgDefault() { return (this.fg & CM) === 0 }
  isBgDefault() { return (this.bg & CM) === 0 }
  isFgRGB() { return (this.fg & CM) === RGB }
  isBgRGB() { return (this.bg & CM) === RGB }
  isFgPalette() { const m = this.fg & CM; return m === P16 || m === P256 }
  isBgPalette() { const m = this.bg & CM; return m === P16 || m === P256 }
  getFgColor() { const m = this.fg & CM; return m === RGB ? this.fg & 0xffffff : m ? this.fg & 0xff : -1 }
  getBgColor() { const m = this.bg & CM; return m === RGB ? this.bg & 0xffffff : m ? this.bg & 0xff : -1 }
  isAttributeDefault() { return this.fg === 0 && this.bg === 0 }
}

/** A ring of lines, as xterm's CircularList: the oldest drop off the front once it holds `max`. */
class Ring {
  constructor(max) {
    this.a = new Array(max)
    this.s = 0 // where index 0 is in `a`
    this.length = 0
    this.max = max
    this.trimmed = 0 // lines ever dropped off the front
  }
  at(i) { i += this.s; return i >= this.max ? i - this.max : i }
  get(i) { return this.a[this.at(i)] }
  set(i, line) { this.a[this.at(i)] = line }
  get full() { return this.length === this.max }
  drop(n) {
    this.s = (this.s + n) % this.max
    this.trimmed += n
  }
  push(line) {
    this.a[this.at(this.length)] = line
    if (this.length === this.max) this.drop(1)
    else this.length++
  }
  /** The oldest line, moved to the end for reuse. Only when full. */
  recycle() {
    this.drop(1)
    return this.a[this.at(this.length - 1)]
  }
  pop() { return this.a[this.at(--this.length)] }
  /** Removes the line at `i`, returning it. */
  remove(i) {
    const line = this.get(i)
    for (; i < this.length - 1; i++) this.set(i, this.get(i + 1))
    this.length--
    return line
  }
  /** Inserts `line` at `i`; when full, the oldest line drops off. */
  insert(i, line) {
    for (let j = this.length - 1; j >= i; j--) this.a[this.at(j + 1)] = this.a[this.at(j)]
    this.set(i, line)
    if (this.length === this.max) this.drop(1)
    else this.length++
  }
  trimStart(n) {
    if (n > this.length) n = this.length
    this.drop(n)
    this.length -= n
  }
  /** Moves `count` lines at `start` by `offset`, as xterm's shiftElements. */
  shift(start, count, offset) {
    if (count <= 0) return
    if (offset > 0) {
      for (let i = count - 1; i >= 0; i--) this.set(start + i + offset, this.get(start + i))
      const grow = start + count + offset - this.length
      if (grow > 0) {
        this.length += grow
        while (this.length > this.max) {
          this.length--
          this.drop(1)
        }
      }
    } else for (let i = 0; i < count; i++) this.set(start + i + offset, this.get(start + i))
  }
  setMax(max) {
    if (max === this.max) return
    const a = new Array(max)
    for (let i = 0; i < Math.min(max, this.length); i++) a[i] = this.get(i)
    this.a = a
    this.max = max
    this.s = 0
  }
}

/** The normal buffer (with scrollback) or the alternate one. Its getters are the read API nook's views use. */
class Buffer {
  constructor(vt, scrollback) {
    this.vt = vt
    this.scrollback = scrollback // 0 for the alternate buffer
    this.lines = new Ring(vt.rows + scrollback)
    this.ydisp = 0 // the line at the view's top
    this.ybase = 0 // the line at the screen's top
    this.x = 0 // can be cols: the next character wraps first
    this.y = 0
    this.scrollTop = 0
    this.scrollBottom = vt.rows - 1
    this.tabs = new Set()
    this.savedX = 0
    this.savedY = 0
    this.savedFg = 0
    this.savedBg = 0
    this.savedCharset = null
    this.setupTabStops()
  }

  get type() { return this.scrollback ? 'normal' : 'alternate' }
  get viewportY() { return this.ydisp }
  get baseY() { return this.ybase }
  get cursorX() { return this.x }
  get cursorY() { return this.y }
  get length() { return this.lines.length }
  /** Lines ever dropped off the scrollback's top, so `trimmed + y` names a line for good. */
  get trimmed() { return this.lines.trimmed }
  getLine(y) { return y >= 0 && y < this.lines.length ? this.lines.get(y) : undefined }
  getNullCell() { return new Cell() }

  /** The screen's row `y`. */
  row(y) { return this.lines.get(this.ybase + y) }

  fillViewportRows(bg = 0) {
    if (this.lines.length) return
    for (let i = this.vt.rows; i--;) this.lines.push(new Line(this.vt.cols, bg))
  }

  clear() {
    this.ydisp = this.ybase = this.x = this.y = 0
    this.lines = new Ring(this.vt.rows + this.scrollback)
    this.scrollTop = 0
    this.scrollBottom = this.vt.rows - 1
    this.setupTabStops()
  }

  setupTabStops(i) {
    const cols = this.vt.cols
    if (i !== undefined) {
      if (!this.tabs.has(i)) i = this.prevStop(i)
    } else {
      this.tabs.clear()
      i = 0
    }
    for (; i < cols; i += 8) this.tabs.add(i)
  }
  prevStop(x = this.x) {
    while (!this.tabs.has(--x) && x > 0);
    const cols = this.vt.cols
    return x >= cols ? cols - 1 : x < 0 ? 0 : x
  }
  nextStop(x = this.x) {
    const cols = this.vt.cols
    while (!this.tabs.has(++x) && x < cols);
    return x >= cols ? cols - 1 : x < 0 ? 0 : x
  }

  /** xterm's Buffer.resize: rows below the cursor go first, then the top scrolls off; a Linux PTY pulls
   * scrollback back down as rows grow, ConPTY gets blank rows. The normal buffer reflows wrapped lines. */
  resize(cols, rows, oldCols, oldRows) {
    const { lines, vt } = this
    const max = rows + this.scrollback
    if (max > lines.max) lines.setMax(max)
    if (lines.length > 0) {
      if (oldCols < cols) for (let i = 0; i < lines.length; i++) lines.get(i).resize(cols)
      let addToY = 0
      if (oldRows < rows) {
        for (let y = oldRows; y < rows; y++) {
          if (lines.length < rows + this.ybase) {
            if (vt.pull && this.ybase > 0 && lines.length <= this.ybase + this.y + addToY + 1) {
              this.ybase--
              addToY++
              if (this.ydisp > 0) this.ydisp--
            } else lines.push(new Line(cols))
          }
        }
      } else {
        for (let y = oldRows; y > rows; y--) {
          if (lines.length > rows + this.ybase) {
            if (lines.length > this.ybase + this.y + 1) lines.pop()
            else {
              this.ybase++
              this.ydisp++
            }
          }
        }
      }
      if (max < lines.max) {
        const trim = lines.length - max
        if (trim > 0) {
          lines.trimStart(trim)
          this.ybase = Math.max(this.ybase - trim, 0)
          this.ydisp = Math.max(this.ydisp - trim, 0)
          this.savedY = Math.max(this.savedY - trim, 0)
        }
        lines.setMax(max)
      }
      this.x = Math.min(this.x, cols - 1)
      this.y = Math.min(this.y, rows - 1)
      if (addToY) this.y += addToY
      this.savedX = Math.min(this.savedX, cols - 1)
      this.scrollTop = 0
    }
    this.scrollBottom = rows - 1
    if (this.scrollback && cols !== oldCols) {
      if (cols > oldCols) this.reflowLarger(cols, rows, oldCols)
      else this.reflowSmaller(cols, rows, oldCols)
    }
    // xterm leaves the alternate buffer's rows long; cutting them keeps text past the edge out of reads.
    if (cols < oldCols) for (let i = 0; i < lines.length; i++) lines.get(i).resize(cols)
  }

  reflowLarger(cols, rows, oldCols) {
    const { lines } = this
    const cursor = this.ybase + this.y
    const toRemove = []
    for (let y = 0; y < lines.length - 1; y++) {
      let i = y
      let next = lines.get(++i)
      if (!next.isWrapped) continue
      const wrapped = [lines.get(y)]
      while (i < lines.length && next.isWrapped) {
        wrapped.push(next)
        next = lines.get(++i)
      }
      if (cursor >= y && cursor < i) {
        y += wrapped.length - 1
        continue
      }
      let destIndex = 0
      let destCol = wrappedLength(wrapped, destIndex, oldCols)
      let srcIndex = 1
      let srcCol = 0
      while (srcIndex < wrapped.length) {
        const srcLength = wrappedLength(wrapped, srcIndex, oldCols)
        const n = Math.min(srcLength - srcCol, cols - destCol)
        wrapped[destIndex].copyCellsFrom(wrapped[srcIndex], srcCol, destCol, n)
        destCol += n
        if (destCol === cols) {
          destIndex++
          destCol = 0
        }
        srcCol += n
        if (srcCol === srcLength) {
          srcIndex++
          srcCol = 0
        }
        if (destCol === 0 && destIndex !== 0 && wrapped[destIndex - 1].width(cols - 1) === 2) {
          wrapped[destIndex].copyCellsFrom(wrapped[destIndex - 1], cols - 1, destCol++, 1)
          wrapped[destIndex - 1].set(cols - 1, W1, 0, 0)
        }
      }
      wrapped[destIndex].replaceCells(destCol, cols, 0)
      let count = 0
      for (let k = wrapped.length - 1; k > 0; k--) {
        if (k > destIndex || wrapped[k].getTrimmedLength() === 0) count++
        else break
      }
      if (count > 0) toRemove.push(y + wrapped.length - count, count)
      y += wrapped.length - 1
    }
    if (!toRemove.length) return
    const layout = []
    let next = 0
    let removed = 0
    for (let i = 0; i < lines.length; i++) {
      if (toRemove[next] === i) {
        const count = toRemove[next + 1]
        i += count - 1
        removed += count
        next += 2
      } else layout.push(lines.get(i))
    }
    for (let i = 0; i < layout.length; i++) lines.set(i, layout[i])
    lines.length = layout.length
    for (let n = removed; n-- > 0;) {
      if (this.ybase === 0) {
        if (this.y > 0) this.y--
        if (lines.length < rows) lines.push(new Line(cols))
      } else {
        if (this.ydisp === this.ybase) this.ydisp--
        this.ybase--
      }
    }
    this.savedY = Math.max(this.savedY - removed, 0)
  }

  reflowSmaller(cols, rows, oldCols) {
    const { lines } = this
    const toInsert = []
    let countToInsert = 0
    for (let y = lines.length - 1; y >= 0; y--) {
      let next = lines.get(y)
      if (!next || (!next.isWrapped && next.getTrimmedLength() <= cols)) continue
      const wrapped = [next]
      while (next.isWrapped && y > 0) {
        next = lines.get(--y)
        wrapped.unshift(next)
      }
      const cursor = this.ybase + this.y
      if (cursor >= y && cursor < y + wrapped.length) continue
      const lastLength = wrapped[wrapped.length - 1].getTrimmedLength()
      const destLengths = newLineLengths(wrapped, oldCols, cols)
      const linesToAdd = destLengths.length - wrapped.length
      const trimmedLines = this.ybase === 0 && this.y !== lines.length - 1
        ? Math.max(0, this.y - lines.max + linesToAdd)
        : Math.max(0, lines.length - lines.max + linesToAdd)
      const added = []
      for (let i = 0; i < linesToAdd; i++) added.push(new Line(cols, 0, true))
      if (added.length) {
        toInsert.push({ start: y + wrapped.length + countToInsert, lines: added })
        countToInsert += added.length
      }
      wrapped.push(...added)
      let destIndex = destLengths.length - 1
      let destCol = destLengths[destIndex]
      if (destCol === 0) destCol = destLengths[--destIndex]
      let srcIndex = wrapped.length - linesToAdd - 1
      let srcCol = lastLength
      while (srcIndex >= 0) {
        const n = Math.min(srcCol, destCol)
        if (wrapped[destIndex] === undefined) break
        wrapped[destIndex].copyCellsFrom(wrapped[srcIndex], srcCol - n, destCol - n, n)
        destCol -= n
        if (destCol === 0) destCol = destLengths[--destIndex]
        srcCol -= n
        if (srcCol === 0) {
          srcIndex--
          srcCol = wrappedLength(wrapped, Math.max(srcIndex, 0), oldCols)
        }
      }
      for (let i = 0; i < wrapped.length; i++) if (destLengths[i] < cols) wrapped[i].set(destLengths[i], W1, 0, 0)
      for (let n = linesToAdd - trimmedLines; n-- > 0;) {
        if (this.ybase === 0) {
          if (this.y < rows - 1) {
            this.y++
            lines.pop()
          } else {
            this.ybase++
            this.ydisp++
          }
        } else if (this.ybase < Math.min(lines.max, lines.length + countToInsert) - rows) {
          if (this.ybase === this.ydisp) this.ydisp++
          this.ybase++
        }
      }
      this.savedY = Math.min(this.savedY + linesToAdd, this.ybase + rows - 1)
    }
    if (!toInsert.length) return
    const original = []
    for (let i = 0; i < lines.length; i++) original.push(lines.get(i))
    const originalLength = lines.length
    let originalIndex = originalLength - 1
    let nextIndex = 0
    let next = toInsert[nextIndex]
    lines.length = Math.min(lines.max, lines.length + countToInsert)
    let inserted = 0
    for (let i = Math.min(lines.max - 1, originalLength + countToInsert - 1); i >= 0; i--) {
      if (next && next.start > originalIndex + inserted) {
        // xterm goes on past index 0 here, and its ring wraps those writes onto the newest lines
        for (let k = next.lines.length - 1; k >= 0 && i >= 0; k--) lines.set(i--, next.lines[k])
        i++
        inserted += next.lines.length
        next = toInsert[++nextIndex]
      } else lines.set(i, original[originalIndex--])
    }
    lines.trimmed += Math.max(0, originalLength + countToInsert - lines.max)
  }
}

/** The cells line `i` of a wrapped run gives the run: all of them, but one less where a wide character
 * didn't fit at its end. */
function wrappedLength(lines, i, cols) {
  if (i === lines.length - 1) return lines[i].getTrimmedLength()
  const endsInNull = !lines[i].hasContent(cols - 1) && lines[i].width(cols - 1) === 1
  return endsInNull && lines[i + 1].width(0) === 2 ? cols - 1 : cols
}

function newLineLengths(wrapped, oldCols, cols) {
  const lengths = []
  let needed = 0
  for (let i = 0; i < wrapped.length; i++) needed += wrappedLength(wrapped, i, oldCols)
  let srcCol = 0
  let srcLine = 0
  let available = 0
  while (available < needed) {
    if (needed - available < cols) {
      lengths.push(needed - available)
      break
    }
    srcCol += cols
    const old = wrappedLength(wrapped, srcLine, oldCols)
    if (srcCol > old) {
      srcCol -= old
      srcLine++
    }
    const wide = wrapped[srcLine].width(srcCol - 1) === 2
    if (wide) srcCol--
    const length = wide ? cols - 1 : cols
    lengths.push(length)
    available += length
  }
  return lengths
}

// The parser's states and actions: xterm's port of Paul Williams' DEC parser.
const GROUND = 0
const ESCAPE = 1
const ESCAPE_INTERMEDIATE = 2
const CSI_ENTRY = 3
const CSI_PARAM = 4
const CSI_INTERMEDIATE = 5
const CSI_IGNORE = 6
const STRING = 7 // SOS, PM and APC
const OSC_STRING = 8
const DCS_ENTRY = 9
const DCS_PARAM = 10
const DCS_IGNORE = 11
const DCS_INTERMEDIATE = 12
const DCS_PASSTHROUGH = 13
const IGNORE = 0
const PRINT = 2
const EXECUTE = 3
const OSC_START = 4
const OSC_PUT = 5
const OSC_END = 6
const CSI_DISPATCH = 7
const PARAM = 8
const COLLECT = 9
const ESC_DISPATCH = 10
const CLEAR = 11
const DCS_HOOK = 12
const DCS_PUT = 13
const DCS_UNHOOK = 14

/** The transition table, indexed by state << 8 | code, with codes from 0xa0 up as 0xa0: action << 4 | next. */
const TABLE = (() => {
  const t = new Uint8Array(14 << 8).fill(1 << 4 | GROUND) // anything unlisted is an error, back to ground
  const r = (a, b) => Array.from({ length: b - a }, (_, i) => a + i)
  const add = (codes, state, action, next) => { for (const c of codes) t[state << 8 | c] = action << 4 | next }
  const PRINTABLES = r(0x20, 0x7f)
  const EXECUTABLES = [...r(0, 0x18), 0x19, ...r(0x1c, 0x20)]
  for (let s = GROUND; s <= DCS_PASSTHROUGH; s++) {
    add([0x18, 0x1a, 0x99, 0x9a], s, EXECUTE, GROUND)
    add(r(0x80, 0x98), s, EXECUTE, GROUND)
    add([0x9c], s, IGNORE, GROUND)
    add([0x1b], s, CLEAR, ESCAPE)
    add([0x9d], s, OSC_START, OSC_STRING)
    add([0x98, 0x9e, 0x9f], s, IGNORE, STRING)
    add([0x9b], s, CLEAR, CSI_ENTRY)
    add([0x90], s, CLEAR, DCS_ENTRY)
  }
  add(PRINTABLES, GROUND, PRINT, GROUND)
  add(EXECUTABLES, GROUND, EXECUTE, GROUND)
  add(EXECUTABLES, ESCAPE, EXECUTE, ESCAPE)
  add([0x7f], ESCAPE, IGNORE, ESCAPE)
  add(EXECUTABLES, OSC_STRING, IGNORE, OSC_STRING)
  add(EXECUTABLES, CSI_ENTRY, EXECUTE, CSI_ENTRY)
  add([0x7f], CSI_ENTRY, IGNORE, CSI_ENTRY)
  add(EXECUTABLES, CSI_PARAM, EXECUTE, CSI_PARAM)
  add([0x7f], CSI_PARAM, IGNORE, CSI_PARAM)
  add(EXECUTABLES, CSI_IGNORE, EXECUTE, CSI_IGNORE)
  add(EXECUTABLES, CSI_INTERMEDIATE, EXECUTE, CSI_INTERMEDIATE)
  add([0x7f], CSI_INTERMEDIATE, IGNORE, CSI_INTERMEDIATE)
  add(EXECUTABLES, ESCAPE_INTERMEDIATE, EXECUTE, ESCAPE_INTERMEDIATE)
  add([0x7f], ESCAPE_INTERMEDIATE, IGNORE, ESCAPE_INTERMEDIATE)
  add([0x5d], ESCAPE, OSC_START, OSC_STRING)
  add(PRINTABLES, OSC_STRING, OSC_PUT, OSC_STRING)
  add([0x7f], OSC_STRING, OSC_PUT, OSC_STRING)
  add([0x9c, 0x1b, 0x18, 0x1a, 0x07], OSC_STRING, OSC_END, GROUND)
  add(r(0x1c, 0x20), OSC_STRING, IGNORE, OSC_STRING)
  add([0x58, 0x5e, 0x5f], ESCAPE, IGNORE, STRING)
  add(PRINTABLES, STRING, IGNORE, STRING)
  add(EXECUTABLES, STRING, IGNORE, STRING)
  add([0x9c], STRING, IGNORE, GROUND)
  add([0x7f], STRING, IGNORE, STRING)
  add([0x5b], ESCAPE, CLEAR, CSI_ENTRY)
  add(r(0x40, 0x7f), CSI_ENTRY, CSI_DISPATCH, GROUND)
  add(r(0x30, 0x3c), CSI_ENTRY, PARAM, CSI_PARAM)
  add([0x3c, 0x3d, 0x3e, 0x3f], CSI_ENTRY, COLLECT, CSI_PARAM)
  add(r(0x30, 0x3c), CSI_PARAM, PARAM, CSI_PARAM)
  add(r(0x40, 0x7f), CSI_PARAM, CSI_DISPATCH, GROUND)
  add([0x3c, 0x3d, 0x3e, 0x3f], CSI_PARAM, IGNORE, CSI_IGNORE)
  add(r(0x20, 0x40), CSI_IGNORE, IGNORE, CSI_IGNORE)
  add([0x7f], CSI_IGNORE, IGNORE, CSI_IGNORE)
  add(r(0x40, 0x7f), CSI_IGNORE, IGNORE, GROUND)
  add(r(0x20, 0x30), CSI_ENTRY, COLLECT, CSI_INTERMEDIATE)
  add(r(0x20, 0x30), CSI_INTERMEDIATE, COLLECT, CSI_INTERMEDIATE)
  add(r(0x30, 0x40), CSI_INTERMEDIATE, IGNORE, CSI_IGNORE)
  add(r(0x40, 0x7f), CSI_INTERMEDIATE, CSI_DISPATCH, GROUND)
  add(r(0x20, 0x30), CSI_PARAM, COLLECT, CSI_INTERMEDIATE)
  add(r(0x20, 0x30), ESCAPE, COLLECT, ESCAPE_INTERMEDIATE)
  add(r(0x20, 0x30), ESCAPE_INTERMEDIATE, COLLECT, ESCAPE_INTERMEDIATE)
  add(r(0x30, 0x7f), ESCAPE_INTERMEDIATE, ESC_DISPATCH, GROUND)
  add(r(0x30, 0x50), ESCAPE, ESC_DISPATCH, GROUND)
  add(r(0x51, 0x58), ESCAPE, ESC_DISPATCH, GROUND)
  add([0x59, 0x5a, 0x5c], ESCAPE, ESC_DISPATCH, GROUND)
  add(r(0x60, 0x7f), ESCAPE, ESC_DISPATCH, GROUND)
  add([0x50], ESCAPE, CLEAR, DCS_ENTRY)
  add(EXECUTABLES, DCS_ENTRY, IGNORE, DCS_ENTRY)
  add([0x7f], DCS_ENTRY, IGNORE, DCS_ENTRY)
  add(r(0x1c, 0x20), DCS_ENTRY, IGNORE, DCS_ENTRY)
  add(r(0x20, 0x30), DCS_ENTRY, COLLECT, DCS_INTERMEDIATE)
  add(r(0x30, 0x3c), DCS_ENTRY, PARAM, DCS_PARAM)
  add([0x3c, 0x3d, 0x3e, 0x3f], DCS_ENTRY, COLLECT, DCS_PARAM)
  add(EXECUTABLES, DCS_IGNORE, IGNORE, DCS_IGNORE)
  add(r(0x20, 0x80), DCS_IGNORE, IGNORE, DCS_IGNORE)
  add(r(0x1c, 0x20), DCS_IGNORE, IGNORE, DCS_IGNORE)
  add(EXECUTABLES, DCS_PARAM, IGNORE, DCS_PARAM)
  add([0x7f], DCS_PARAM, IGNORE, DCS_PARAM)
  add(r(0x1c, 0x20), DCS_PARAM, IGNORE, DCS_PARAM)
  add(r(0x30, 0x3c), DCS_PARAM, PARAM, DCS_PARAM)
  add([0x3c, 0x3d, 0x3e, 0x3f], DCS_PARAM, IGNORE, DCS_IGNORE)
  add(r(0x20, 0x30), DCS_PARAM, COLLECT, DCS_INTERMEDIATE)
  add(EXECUTABLES, DCS_INTERMEDIATE, IGNORE, DCS_INTERMEDIATE)
  add([0x7f], DCS_INTERMEDIATE, IGNORE, DCS_INTERMEDIATE)
  add(r(0x1c, 0x20), DCS_INTERMEDIATE, IGNORE, DCS_INTERMEDIATE)
  add(r(0x20, 0x30), DCS_INTERMEDIATE, COLLECT, DCS_INTERMEDIATE)
  add(r(0x30, 0x40), DCS_INTERMEDIATE, IGNORE, DCS_IGNORE)
  add(r(0x40, 0x7f), DCS_INTERMEDIATE, DCS_HOOK, DCS_PASSTHROUGH)
  add(r(0x40, 0x7f), DCS_PARAM, DCS_HOOK, DCS_PASSTHROUGH)
  add(r(0x40, 0x7f), DCS_ENTRY, DCS_HOOK, DCS_PASSTHROUGH)
  add(EXECUTABLES, DCS_PASSTHROUGH, DCS_PUT, DCS_PASSTHROUGH)
  add(PRINTABLES, DCS_PASSTHROUGH, DCS_PUT, DCS_PASSTHROUGH)
  add([0x7f], DCS_PASSTHROUGH, IGNORE, DCS_PASSTHROUGH)
  add([0x1b, 0x9c, 0x18, 0x1a], DCS_PASSTHROUGH, DCS_UNHOOK, GROUND)
  add([0xa0], GROUND, PRINT, GROUND)
  add([0xa0], OSC_STRING, OSC_PUT, OSC_STRING)
  add([0xa0], CSI_IGNORE, IGNORE, CSI_IGNORE)
  add([0xa0], DCS_IGNORE, IGNORE, DCS_IGNORE)
  add([0xa0], DCS_PASSTHROUGH, DCS_PUT, DCS_PASSTHROUGH)
  return t
})()

const LIMIT = 10000000 // the longest OSC, DCS or APC string taken
const IIP_LIMIT = 26700000 // an iTerm2 picture's OSC 1337: 20 MB in base64
// DEC Special Graphics, for ` to ~ while G0 or G1 holds it: the line-drawing set.
const DEC = '◆▒␉␌␍␊°±␤␋┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│≤≥π≠£·'
const GLEVEL = { 0x28: 0, 0x29: 1, 0x2a: 2, 0x2b: 3, 0x2d: 1, 0x2e: 2 } // ( ) * + - .
const NATIONAL = new Set('AB4C5RQKYE6ZH7='.split('').map(c => c.charCodeAt(0))) // sets xterm knows; all print as ASCII here
const MOUSE = { 9: 'x10', 1000: 'vt200', 1002: 'drag', 1003: 'any' }
const RANK = { none: 0, x10: 1, vt200: 2, drag: 3, any: 4 }

/**
 * The terminal. `h` holds what it calls out to, each optional:
 * - `reply(s)`: an answer to the program (DA, DSR, DECRQM, DECRQSS, OSC 10-12, CSI t, focus reports)
 * - `title(s)`: OSC 0 and 2
 * - `osc(id, data)`: any other complete OSC, such as 7, 52 and 1337
 * - `apc(data)`: a complete APC string (kitty graphics)
 * - `dcs(ident, params)`: a DCS other than DECRQSS starts; returns `{ put(s), end(ok) }` to take it, or nothing
 * - `pixels()`: `{ cellW, cellH, width, height }` in CSS px for CSI 16 t and 14 t, or nothing
 * - `colors()`: `[fg, bg, cursor]` as [r, g, b] for OSC 10, 11 and 12 queries
 * `pull` makes rows that grow take lines back from scrollback, as on Linux; ConPTY gets blank rows instead.
 */
export class Vt {
  constructor(cols, rows, h = {}, { scrollback = 10000, pull = false } = {}) {
    this.changed = true // set by every write, resize and scroll; the view clears it
    this.cursorHidden = false
    this.cursorInit = false // whether the cursor shows yet: after a focus, a key or a buffer switch
    this.blink = false // DECSET 12, an option a reset keeps
    this.plen = this.sublen = this.collect = 0
    this.rejectDigits = this.rejectSub = this.digitIsSub = false
    this.cols = Math.max(cols, 2)
    this.rows = Math.max(rows, 1)
    this.h = h
    this.pull = pull
    this.images = false // the image module's answers: DA1 with sixel, and CSI 18 t
    this.normal = new Buffer(this, scrollback)
    this.normal.fillViewportRows()
    this.alt = new Buffer(this, 0)
    this.buffer = this.normal
    this.focused = false
    this.title = ''
    this.userScrolling = false
    this.links = new Map() // id -> { uri, key }
    this.linkKeys = new Map() // `${id};;${uri}` -> link id, for links an OSC 8 names with id=
    this.nextLink = 1
    this.high = '' // a high surrogate that ended the last chunk
    this.state = GROUND
    this.params = new Int32Array(32)
    this.sub = new Int32Array(32)
    this.subIdx = new Uint16Array(32)
    this.clearParams()
    this.osc = null // the OSC being read: { id, parts, length, state }
    this.dcs = null // the DCS being read: { ident, sink, parts, length }
    this.apc = null // the APC being read: { parts, length }, or null for SOS and PM
    this.reset()
  }

  /** Modes and attributes as a fresh terminal has them. */
  reset() {
    this.fg = 0
    this.bg = 0
    this.ext = NO_EXT
    this.insert = false
    this.appCursor = false
    this.appKeypad = false
    this.bracketedPaste = false
    this.origin = false
    this.reverseWrap = false
    this.sendFocus = false
    this.sync = false
    this.wrap = true
    this.cursorStyle = undefined
    this.cursorBlink = undefined
    this.mouse = 'none' // 'none' | 'x10' | 'vt200' | 'drag' | 'any'
    this.mouseEncoding = 'default' // 'default' | 'sgr' | 'sgr-pixels'
    this.charsets = [null, null, null, null]
    this.glevel = 0
    this.charset = null
    this.join = 0 // the last printed character's width << 1 | joined, for marks that join it
  }

  /** Parses `s`. A chunk may end anywhere, even inside a sequence or a surrogate pair. */
  write(s) {
    if (this.high) {
      s = this.high + s
      this.high = ''
    }
    let n = s.length
    if (n) {
      const last = s.charCodeAt(n - 1)
      if (last >= 0xd800 && last <= 0xdbff) {
        this.high = s[n - 1]
        n--
      }
    }
    let state = this.state
    for (let i = 0; i < n; i++) {
      let code = s.charCodeAt(i)
      if (state === STRING) {
        let j = i
        while (j < n && (code = s.charCodeAt(j)) < 0x80 && code !== 0x1b && code !== 0x18 && code !== 0x1a) j++
        if (j > i && this.apc && this.apc.length <= LIMIT) {
          this.apc.parts.push(s.slice(i, j))
          this.apc.length += j - i
        }
        if (j === n) break
        i = j
      }
      let t = TABLE[state << 8 | (code < 0xa0 ? code : 0xa0)]
      switch (t >> 4) {
        case PRINT: {
          let j = i + 1
          while (j < n && ((code = s.charCodeAt(j)) >= 0x20 && code < 0x7f || code >= 0xa0)) j++
          this.print(s, i, j)
          i = j - 1
          break
        }
        case EXECUTE:
          this.execute(code)
          this.join = 0
          break
        case CSI_DISPATCH:
          this.csi(this.collect << 8 | code)
          this.join = 0
          break
        case PARAM:
          do {
            if (code === 0x3b) this.addParam(0)
            else if (code === 0x3a) this.addSubParam(-1)
            else this.addDigit(code - 48)
          } while (++i < n && (code = s.charCodeAt(i)) > 0x2f && code < 0x3c)
          i--
          break
        case COLLECT:
          this.collect = this.collect << 8 | code
          break
        case ESC_DISPATCH:
          this.esc(this.collect << 8 | code)
          this.join = 0
          break
        case CLEAR:
          this.clearParams()
          break
        case DCS_HOOK:
          this.dcsHook(this.collect << 8 | code)
          break
        case DCS_PUT: {
          let j = i + 1
          while (j < n && (code = s.charCodeAt(j)) !== 0x18 && code !== 0x1a && code !== 0x1b && !(code > 0x7f && code < 0xa0)) j++
          this.dcsPut(s.slice(i, j))
          i = j - 1
          break
        }
        case DCS_UNHOOK:
          this.dcsEnd(code !== 0x18 && code !== 0x1a)
          if (code === 0x1b) t |= ESCAPE
          this.clearParams()
          this.join = 0
          break
        case OSC_START:
          this.osc = { id: -1, parts: [], length: 0, state: 1 }
          break
        case OSC_PUT: {
          let j = i + 1
          while (j < n && (code = s.charCodeAt(j)) >= 0x20 && !(code > 0x7f && code < 0xa0)) j++
          this.oscPut(s, i, j)
          i = j - 1
          break
        }
        case OSC_END:
          this.oscEnd(code !== 0x18 && code !== 0x1a)
          if (code === 0x1b) t |= ESCAPE
          this.clearParams()
          this.join = 0
          break
      }
      const next = t & 15
      if (state === STRING && next !== STRING) this.apcEnd(code === 0x1b || code === 0x9c)
      else if (next === STRING && state !== STRING) this.apc = code === 0x5f || code === 0x9f ? { parts: [], length: 0 } : null
      state = next
    }
    this.state = state
    if (n) this.changed = true
  }

  // Params, as xterm's: up to 32, each with up to 32 colon subparams shared, -1 for an empty subparam.
  clearParams() {
    this.plen = 0
    this.sublen = 0
    this.rejectDigits = false
    this.rejectSub = false
    this.digitIsSub = false
    this.collect = 0
    this.addParam(0)
  }
  addParam(v) {
    this.digitIsSub = false
    if (this.plen >= 32) {
      this.rejectDigits = true
      return
    }
    this.subIdx[this.plen] = this.sublen << 8 | this.sublen
    this.params[this.plen++] = v
  }
  addSubParam(v) {
    this.digitIsSub = true
    if (!this.plen) return
    if (this.rejectDigits || this.sublen >= 32) {
      this.rejectSub = true
      return
    }
    this.sub[this.sublen++] = v
    this.subIdx[this.plen - 1]++
  }
  addDigit(v) {
    const length = this.digitIsSub ? this.sublen : this.plen
    if (this.rejectDigits || !length || (this.digitIsSub && this.rejectSub)) return
    const store = this.digitIsSub ? this.sub : this.params
    const cur = store[length - 1]
    store[length - 1] = ~cur ? Math.min(cur * 10 + v, 0x7fffffff) : v
  }
  hasSub(i) { return (this.subIdx[i] & 0xff) - (this.subIdx[i] >> 8) > 0 }
  getSub(i) { return this.sub.subarray(this.subIdx[i] >> 8, this.subIdx[i] & 0xff) }
  /** The params as xterm's `toArray`: a number each, then an array of its subparams if it has any. */
  paramArray() {
    const out = []
    for (let i = 0; i < this.plen; i++) {
      out.push(this.params[i])
      if (this.hasSub(i)) out.push([...this.getSub(i)])
    }
    return out
  }

  print(s, start, end) {
    const b = this.buffer
    const { cols, fg, bg, ext, charset, insert } = this
    let line = b.row(b.y)
    let d = line.d
    let c = line.cap
    let x = b.x
    if (x && end > start && line.width(x - 1) === 2) line.set(x - 1, W1, fg, bg, ext)
    let join = this.join
    for (let pos = start; pos < end; pos++) {
      let code = s.charCodeAt(pos)
      if (code < 0x7f && x < cols && !insert && (code < 0x60 || !charset)) { // ASCII: one cell, never joins
        d[x] = code | W1
        d[c + x] = fg
        d[2 * c + x] = bg
        if (bg & EXT) (line.ext ??= new Map()).set(x, ext)
        x++
        join = 2
        continue
      }
      if (code >= 0xd800 && code <= 0xdbff && pos + 1 < end) {
        const low = s.charCodeAt(pos + 1)
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = (code - 0xd800) * 0x400 + low - 0xdc00 + 0x10000
          pos++
        }
      } else if (code === 0xfeff) continue // a byte order mark
      else if (code < 127 && charset && code >= 0x60) code = charset.charCodeAt(code - 0x60)
      let width = wcwidth(code)
      const oldWidth = join >> 1 & 3
      const joins = width === 0 && oldWidth !== 0
      if (joins) width = oldWidth
      join = width << 1 | (joins ? 1 : 0)
      const back = joins ? oldWidth : 0
      if (x + width - back > cols) {
        if (this.wrap) {
          const oldRow = line
          let oldCol = x - back
          x = back
          b.y++
          if (b.y === b.scrollBottom + 1) {
            b.y--
            this.scroll(true)
          } else {
            if (b.y >= this.rows) b.y = this.rows - 1
            b.row(b.y).isWrapped = true
          }
          line = b.row(b.y)
          d = line.d
          c = line.cap
          if (back > 0) line.copyCellsFrom(oldRow, oldCol, 0, back)
          for (; oldCol < cols; oldCol++) oldRow.set(oldCol, W1, fg, bg, ext)
        } else {
          x = cols - 1
          if (width === 2) continue
        }
      }
      if (joins && x) {
        const at = x - (line.width(x - 1) ? 1 : 2)
        if (at >= 0) {
          let cell = d[at]
          if (cell & COMBINED) line.comb.set(at, line.comb.get(at) + String.fromCodePoint(code))
          else if (cell & CP) {
            (line.comb ??= new Map()).set(at, String.fromCodePoint(cell & CP, code))
            cell = cell & ~CP | COMBINED
          } else cell = code | W1
          d[at] = cell & ~(3 << 22) | width << 22
        }
        continue
      }
      if (insert) {
        line.insertCells(x, width - back, fg, bg, ext)
        if (line.width(cols - 1) === 2) line.set(cols - 1, W1, fg, bg, ext)
      }
      if (x < cols) line.set(x, code | width << 22, fg, bg, ext)
      x++
      while (width-- > 1) {
        if (x < cols) line.set(x, 0, fg, bg, ext)
        x++
      }
    }
    b.x = x
    this.join = join
    if (x < cols && end > start && line.width(x) === 0 && !line.hasContent(x)) line.set(x, W1, fg, bg, ext)
  }

  execute(code) {
    switch (code) {
      case 0x0a: case 0x0b: case 0x0c: return this.lineFeed()
      case 0x0d: this.buffer.x = 0; return
      case 0x08: return this.backspace()
      case 0x09: {
        const b = this.buffer
        if (b.x < this.cols) b.x = b.nextStop()
        return
      }
      case 0x0e: return this.setgLevel(1)
      case 0x0f: return this.setgLevel(0)
      case 0x84: return this.index()
      case 0x85: this.buffer.x = 0; return this.index()
      case 0x88: this.buffer.tabs.add(this.buffer.x)
    }
  }

  /** The attributes an erase leaves: the background color, nothing else. */
  get eraseBg() { return this.bg & COLOR }

  /** Scrolls the region up a line: off the top into scrollback when the region starts at the top. */
  scroll(wrapped = false) {
    const b = this.buffer
    const lines = b.lines
    const bg = this.eraseBg
    const top = b.ybase + b.scrollTop
    const bottom = b.ybase + b.scrollBottom
    if (b.scrollTop === 0) {
      const full = lines.full
      if (bottom === lines.length - 1) {
        if (full) blank(lines.recycle(), this.cols, bg, wrapped)
        else lines.push(new Line(this.cols, bg, wrapped))
      } else lines.insert(bottom + 1, new Line(this.cols, bg, wrapped))
      if (!full) {
        b.ybase++
        if (!this.userScrolling) b.ydisp++
      } else if (this.userScrolling) b.ydisp = Math.max(b.ydisp - 1, 0)
    } else {
      const line = lines.get(top)
      lines.shift(top + 1, bottom - top, -1)
      lines.set(bottom, blank(line, this.cols, bg, wrapped))
    }
    if (!this.userScrolling) b.ydisp = b.ybase
  }

  /** Scrolls the view `n` lines, down for positive. */
  scrollLines(n) {
    const b = this.buffer
    if (n < 0) {
      if (b.ydisp === 0) return
      this.userScrolling = true
    } else if (n + b.ydisp >= b.ybase) this.userScrolling = false
    const before = b.ydisp
    b.ydisp = Math.max(Math.min(b.ydisp + n, b.ybase), 0)
    if (b.ydisp !== before) this.changed = true
  }
  scrollToBottom() { this.scrollLines(this.buffer.ybase - this.buffer.ydisp) }

  lineFeed() {
    const b = this.buffer
    b.y++
    if (b.y === b.scrollBottom + 1) {
      b.y--
      this.scroll()
    } else if (b.y >= this.rows) b.y = this.rows - 1
    else b.row(b.y).isWrapped = false
    if (b.x >= this.cols) b.x--
  }

  backspace() {
    const b = this.buffer
    if (!this.reverseWrap) {
      this.restrictCursor()
      if (b.x > 0) b.x--
      return
    }
    this.restrictCursor(this.cols)
    if (b.x > 0) b.x--
    else if (b.x === 0 && b.y > b.scrollTop && b.y <= b.scrollBottom && b.row(b.y)?.isWrapped) {
      b.row(b.y).isWrapped = false
      b.y--
      b.x = this.cols - 1
      const line = b.row(b.y)
      if (line.width(b.x) && !line.hasContent(b.x)) b.x--
    }
    this.restrictCursor()
  }

  restrictCursor(maxCol = this.cols - 1) {
    const b = this.buffer
    b.x = Math.min(maxCol, Math.max(0, b.x))
    b.y = this.origin ? Math.min(b.scrollBottom, Math.max(b.scrollTop, b.y)) : Math.min(this.rows - 1, Math.max(0, b.y))
  }
  setCursor(x, y) {
    const b = this.buffer
    b.x = x
    b.y = this.origin ? b.scrollTop + y : y
    this.restrictCursor()
  }
  moveCursor(x, y) {
    this.restrictCursor()
    this.setCursor(this.buffer.x + x, this.buffer.y + y)
  }

  index() {
    const b = this.buffer
    this.restrictCursor()
    b.y++
    if (b.y === b.scrollBottom + 1) {
      b.y--
      this.scroll()
    } else if (b.y >= this.rows) b.y = this.rows - 1
    this.restrictCursor()
  }

  reverseIndex() {
    const b = this.buffer
    this.restrictCursor()
    if (b.y === b.scrollTop) {
      const at = b.ybase + b.y
      const bottom = b.ybase + b.scrollBottom
      const line = b.lines.get(bottom)
      b.lines.shift(at, b.scrollBottom - b.scrollTop, 1)
      b.lines.set(at, blank(line, this.cols, this.eraseBg))
      } else {
      b.y--
      this.restrictCursor()
    }
  }

  setgLevel(g) {
    this.glevel = g
    this.charset = this.charsets[g]
  }
  setgCharset(g, set) {
    this.charsets[g] = set
    if (this.glevel === g) this.charset = set
  }

  saveCursor() {
    const b = this.buffer
    b.savedX = b.x
    b.savedY = b.ybase + b.y
    b.savedFg = this.fg
    b.savedBg = this.bg
    b.savedCharset = this.charset
  }
  restoreCursor() {
    const b = this.buffer
    b.x = b.savedX || 0
    b.y = Math.max(b.savedY - b.ybase, 0)
    this.fg = b.savedFg
    this.bg = b.savedBg
    this.charset = b.savedCharset
    this.restrictCursor()
  }

  esc(ident) {
    switch (ident) {
      case 0x37: return this.saveCursor() // 7
      case 0x38: return this.restoreCursor() // 8
      case 0x44: return this.index() // D
      case 0x45: this.buffer.x = 0; return this.index() // E
      case 0x48: this.buffer.tabs.add(this.buffer.x); return // H
      case 0x4d: return this.reverseIndex() // M
      case 0x3d: this.appKeypad = true; return // =
      case 0x3e: this.appKeypad = false; return // >
      case 0x63: return this.fullReset() // c
      case 0x6e: case 0x7d: return this.setgLevel(2) // n }
      case 0x6f: case 0x7c: return this.setgLevel(3) // o |
      case 0x7e: return this.setgLevel(1) // ~
      case 0x2540: case 0x2547: // %@ %G
        this.setgLevel(0)
        return this.setgCharset(0, null)
    }
    const g = GLEVEL[ident >> 8]
    const final = ident & 0xff
    if (ident > 0xff && ident < 0x10000 && g !== undefined && (final === 0x30 || NATIONAL.has(final))) this.setgCharset(g, final === 0x30 ? DEC : null)
  }

  fullReset() {
    this.clearParams()
    this.normal = new Buffer(this, this.normal.scrollback)
    this.normal.fillViewportRows()
    this.alt = new Buffer(this, 0)
    this.buffer = this.normal
    this.userScrolling = false
    this.reset()
  }

  csi(ident) {
    const p = this.params
    const p0 = p[0]
    const b = this.buffer
    switch (ident) {
      case 0x40: // @ ICH
        this.restrictCursor()
        b.row(b.y).insertCells(b.x, p0 || 1, 0, this.eraseBg, NO_EXT)
        break
      case 0x41: // A CUU
        this.moveCursor(0, -(b.y - b.scrollTop >= 0 ? Math.min(b.y - b.scrollTop, p0 || 1) : p0 || 1))
        break
      case 0x42: // B CUD
        this.moveCursor(0, b.scrollBottom - b.y >= 0 ? Math.min(b.scrollBottom - b.y, p0 || 1) : p0 || 1)
        break
      case 0x43: case 0x61: this.moveCursor(p0 || 1, 0); break // C CUF, a HPR
      case 0x44: this.moveCursor(-(p0 || 1), 0); break // D CUB
      case 0x45: // E CNL
        this.csi(0x42)
        b.x = 0
        break
      case 0x46: // F CPL
        this.csi(0x41)
        b.x = 0
        break
      case 0x47: case 0x60: this.setCursor((p0 || 1) - 1, b.y); break // G CHA, ` HPA
      case 0x48: case 0x66: this.setCursor(this.plen >= 2 ? (p[1] || 1) - 1 : 0, (p0 || 1) - 1); break // H CUP, f HVP
      case 0x49: // I CHT
        if (b.x < this.cols) for (let n = p0 || 1; n--;) b.x = b.nextStop()
        break
      case 0x4a: case 0x3f4a: this.eraseInDisplay(p0); break // J ED, ?J DECSED
      case 0x4b: case 0x3f4b: this.eraseInLine(p0); break // K EL, ?K DECSEL
      case 0x4c: this.insertLines(p0 || 1); break // L IL
      case 0x4d: this.deleteLines(p0 || 1); break // M DL
      case 0x50: // P DCH
        this.restrictCursor()
        b.row(b.y).deleteCells(b.x, p0 || 1, this.eraseBg)
        break
      case 0x53: // S SU
        for (let n = p0 || 1; n--;) {
          const line = b.lines.remove(b.ybase + b.scrollTop)
          b.lines.insert(b.ybase + b.scrollBottom, blank(line, this.cols, this.eraseBg))
        }
        break
      case 0x54: // T SD
        for (let n = p0 || 1; n--;) {
          const line = b.lines.remove(b.ybase + b.scrollBottom)
          b.lines.insert(b.ybase + b.scrollTop, blank(line, this.cols, 0))
        }
        break
      case 0x58: // X ECH
        this.restrictCursor()
        b.row(b.y).replaceCells(b.x, b.x + (p0 || 1), this.eraseBg)
        break
      case 0x5a: // Z CBT
        if (b.x < this.cols) for (let n = p0 || 1; n--;) b.x = b.prevStop()
        break
      case 0x62: this.repeat(p0 || 1); break // b REP
      case 0x63: // c DA1
        if (p0 <= 0) this.reply(this.images ? '\x1b[?62;4;9;22c' : '\x1b[?1;2c')
        break
      case 0x3e63: // >c DA2
        if (p0 <= 0) this.reply('\x1b[>0;276;0c')
        break
      case 0x64: this.setCursor(b.x, (p0 || 1) - 1); break // d VPA
      case 0x65: this.moveCursor(0, p0 || 1); break // e VPR
      case 0x67: // g TBC
        if (p0 === 0) b.tabs.delete(b.x)
        else if (p0 === 3) b.tabs.clear()
        break
      case 0x68: case 0x6c: // h SM, l RM
        for (let i = 0; i < this.plen; i++) if (p[i] === 4) this.insert = ident === 0x68
        break
      case 0x3f68: // ?h DECSET
        // Claude sets mouse tracking again after each press, as ?1000h ?1002h ?1003h: a lone mode below the one
        // in force is ignored, so tracking never passes through 1000, which reports no drags.
        if (this.plen === 1 && RANK[MOUSE[p0]] < RANK[this.mouse]) break
        for (let i = 0; i < this.plen; i++) this.setPrivate(p[i], true)
        break
      case 0x3f6c: for (let i = 0; i < this.plen; i++) this.setPrivate(p[i], false); break // ?l DECRST
      case 0x6d: this.sgr(); break // m SGR
      case 0x6e: // n DSR
        if (p0 === 5) this.reply('\x1b[0n')
        else if (p0 === 6) this.reply(`\x1b[${b.y + 1};${b.x + 1}R`)
        break
      case 0x3f6e: // ?n DECDSR
        if (p0 === 6) this.reply(`\x1b[?${b.y + 1};${b.x + 1}R`)
        break
      case 0x2170: this.softReset(); break // !p DECSTR
      case 0x2071: { // SP q DECSCUSR
        const style = this.plen === 0 ? 1 : p0
        if (style === 0) this.cursorStyle = this.cursorBlink = undefined
        else {
          if (style <= 2) this.cursorStyle = 'block'
          else if (style <= 4) this.cursorStyle = 'underline'
          else if (style <= 6) this.cursorStyle = 'bar'
          this.cursorBlink = style % 2 === 1
        }
        break
      }
      case 0x72: { // r DECSTBM
        const top = p0 || 1
        let bottom = p[1]
        if (this.plen < 2 || bottom > this.rows || bottom === 0) bottom = this.rows
        if (bottom > top) {
          b.scrollTop = top - 1
          b.scrollBottom = bottom - 1
          this.setCursor(0, 0)
        }
        break
      }
      case 0x73: this.saveCursor(); break // s
      case 0x74: this.windowOps(p0, this.plen > 1 ? p[1] : 0); break // t
      case 0x75: this.restoreCursor(); break // u
      case 0x2470: this.requestMode(p0, true); break // $p DECRQM, ANSI modes
      case 0x3f2470: this.requestMode(p0, false); break // ?$p DECRQM, DEC modes
    }
  }

  reply(s) { this.h.reply?.(s) }

  eraseInDisplay(mode) {
    const b = this.buffer
    const bg = this.eraseBg
    this.restrictCursor(this.cols)
    if (mode === 0) {
      b.row(b.y).replaceCells(b.x, this.cols, bg)
      if (b.x === 0) b.row(b.y).isWrapped = false
      for (let y = b.y + 1; y < this.rows; y++) this.resetLine(y, bg)
    } else if (mode === 1) {
      b.row(b.y).replaceCells(0, b.x + 1, bg)
      b.row(b.y).isWrapped = false
      // xterm unwraps line y + 1 counted from the scrollback's top, not the screen's
      if (b.x + 1 >= this.cols && b.y + 1 < this.rows) b.row(b.y + 1).isWrapped = false
      for (let y = b.y; y--;) this.resetLine(y, bg)
    } else if (mode === 2) {
      for (let y = this.rows; y--;) this.resetLine(y, bg)
    } else if (mode === 3) {
      const extra = b.lines.length - this.rows
      if (extra > 0) {
        b.lines.trimStart(extra)
        b.ybase = Math.max(b.ybase - extra, 0)
        b.ydisp = Math.max(b.ydisp - extra, 0)
      }
    }
  }
  resetLine(y, bg) {
    const line = this.buffer.row(y)
    if (!line) return
    line.fill(bg)
    line.isWrapped = false
  }

  eraseInLine(mode) {
    const b = this.buffer
    const line = b.row(b.y)
    this.restrictCursor(this.cols)
    if (mode === 0) {
      line.replaceCells(b.x, this.cols, this.eraseBg)
      if (b.x === 0) line.isWrapped = false
    } else if (mode === 1) line.replaceCells(0, b.x + 1, this.eraseBg)
    else if (mode === 2) {
      line.replaceCells(0, this.cols, this.eraseBg)
      line.isWrapped = false
    }
  }

  insertLines(n) {
    const b = this.buffer
    this.restrictCursor()
    if (b.y > b.scrollBottom || b.y < b.scrollTop) return
    const row = b.ybase + b.y
    const bottom = b.ybase + b.scrollBottom
    while (n--) {
      const line = b.lines.remove(bottom)
      b.lines.insert(row, blank(line, this.cols, this.eraseBg))
    }
    b.x = 0
  }

  deleteLines(n) {
    const b = this.buffer
    this.restrictCursor()
    if (b.y > b.scrollBottom || b.y < b.scrollTop) return
    const row = b.ybase + b.y
    const bottom = b.ybase + b.scrollBottom
    while (n--) {
      const line = b.lines.remove(row)
      b.lines.insert(bottom, blank(line, this.cols, this.eraseBg))
    }
    b.x = 0
  }

  /** REP: prints the last printed character `n` more times. */
  repeat(n) {
    const join = this.join
    if (!join) return
    const b = this.buffer
    const text = b.row(b.y).chars(b.x - (join >> 1 & 3))
    const s = text.repeat(Math.min(n, 65536))
    this.print(s, 0, s.length)
  }

  setPrivate(mode, on) {
    const b = this.buffer
    switch (mode) {
      case 1: this.appCursor = on; break
      case 2:
        if (on) for (let g = 0; g < 4; g++) this.setgCharset(g, null)
        break
      case 6:
        this.origin = on
        this.setCursor(0, 0)
        break
      case 7: this.wrap = on; break
      case 12: this.blink = on; break
      case 45: this.reverseWrap = on; break
      case 66: this.appKeypad = on; break
      case 9: case 1000: case 1002: case 1003: this.mouse = on ? MOUSE[mode] : 'none'; break
      case 1004:
        this.sendFocus = on
        if (on) this.reply(this.focused ? '\x1b[I' : '\x1b[O')
        break
      case 1006: this.mouseEncoding = on ? 'sgr' : 'default'; break
      case 1016: this.mouseEncoding = on ? 'sgr-pixels' : 'default'; break
      case 25: this.cursorHidden = !on; break
      case 1048: on ? this.saveCursor() : this.restoreCursor(); break
      case 1049: case 47: case 1047:
        if (on) {
          if (mode === 1049) this.saveCursor()
          if (b === this.alt) break
          this.alt.fillViewportRows(this.eraseBg)
          this.alt.x = this.normal.x
          this.alt.y = this.normal.y
          this.buffer = this.alt
        } else {
          if (b !== this.normal) {
            this.normal.x = this.alt.x
            this.normal.y = this.alt.y
            this.alt.clear()
            this.buffer = this.normal
          }
          if (mode === 1049) this.restoreCursor()
        }
        this.cursorInit = true
        break
      case 2004: this.bracketedPaste = on; break
      case 2026: this.sync = on; break
    }
  }

  softReset() {
    const b = this.buffer
    this.cursorHidden = false
    b.scrollTop = 0
    b.scrollBottom = this.rows - 1
    this.fg = this.bg = 0
    this.ext = NO_EXT
    this.insert = this.appCursor = this.appKeypad = this.bracketedPaste = this.origin = false
    this.reverseWrap = this.sendFocus = this.sync = false
    this.wrap = true
    this.cursorStyle = this.cursorBlink = undefined
    this.charsets = [null, null, null, null]
    this.glevel = 0
    this.charset = null
    b.savedX = 0
    b.savedY = b.ybase
    b.savedFg = b.savedBg = 0
    b.savedCharset = null
  }

  requestMode(m, ansi) {
    const v = on => (on ? 1 : 2)
    let value = 0
    if (ansi) value = m === 2 ? 4 : m === 4 ? v(this.insert) : m === 12 ? 3 : m === 20 ? 2 : 0
    else {
      switch (m) {
        case 1: value = v(this.appCursor); break
        case 6: value = v(this.origin); break
        case 7: value = v(this.wrap); break
        case 8: value = 3; break
        case 9: value = v(this.mouse === 'x10'); break
        case 12: value = v(this.blink); break
        case 25: value = v(!this.cursorHidden); break
        case 45: value = v(this.reverseWrap); break
        case 66: value = v(this.appKeypad); break
        case 67: value = 4; break
        case 1000: value = v(this.mouse === 'vt200'); break
        case 1002: value = v(this.mouse === 'drag'); break
        case 1003: value = v(this.mouse === 'any'); break
        case 1004: value = v(this.sendFocus); break
        case 1005: value = 4; break
        case 1006: value = v(this.mouseEncoding === 'sgr'); break
        case 1015: value = 4; break
        case 1016: value = v(this.mouseEncoding === 'sgr-pixels'); break
        case 1048: value = 1; break
        case 47: case 1047: case 1049: value = v(this.buffer === this.alt); break
        case 2004: value = v(this.bracketedPaste); break
        case 2026: value = v(this.sync); break
      }
    }
    this.reply(`\x1b[${ansi ? '' : '?'}${m};${value}$y`)
  }

  windowOps(op, second) {
    if (op === 14 || op === 16) {
      const px = this.h.pixels?.()
      if (!px) return
      if (op === 16) this.reply(`\x1b[6;${px.cellH.toFixed(0)};${px.cellW.toFixed(0)}t`)
      else if (second !== 2) this.reply(`\x1b[4;${px.height.toFixed(0)};${px.width.toFixed(0)}t`)
    } else if (op === 18 && this.images) this.reply(`\x1b[8;${this.rows};${this.cols}t`)
  }

  sgr() {
    const p = this.params
    if (this.plen === 1 && p[0] === 0) return this.sgr0()
    for (let i = 0; i < this.plen; i++) {
      const n = p[i]
      if (n >= 30 && n <= 37) this.fg = this.fg & ~(CM | 0xff) | P16 | (n - 30)
      else if (n >= 40 && n <= 47) this.bg = this.bg & ~(CM | 0xff) | P16 | (n - 40)
      else if (n >= 90 && n <= 97) this.fg = this.fg & ~(CM | 0xff) | P16 | (n - 90) | 8
      else if (n >= 100 && n <= 107) this.bg = this.bg & ~(CM | 0xff) | P16 | (n - 100) | 8
      else if (n === 0) this.sgr0()
      else if (n === 1) this.fg |= BOLD
      else if (n === 3) this.bg |= ITALIC
      else if (n === 4) {
        this.fg |= UNDERLINE
        this.underline(this.hasSub(i) ? this.getSub(i)[0] : 1)
      } else if (n === 5) this.fg |= BLINK
      else if (n === 7) this.fg |= INVERSE
      else if (n === 8) this.fg |= INVISIBLE
      else if (n === 9) this.fg |= STRIKE
      else if (n === 2) this.bg |= DIM
      else if (n === 21) this.underline(2)
      else if (n === 22) {
        this.fg &= ~BOLD
        this.bg &= ~DIM
      } else if (n === 23) this.bg &= ~ITALIC
      else if (n === 24) {
        this.fg &= ~UNDERLINE
        this.underline(0)
      } else if (n === 25) this.fg &= ~BLINK
      else if (n === 27) this.fg &= ~INVERSE
      else if (n === 28) this.fg &= ~INVISIBLE
      else if (n === 29) this.fg &= ~STRIKE
      else if (n === 39) this.fg &= ~COLOR
      else if (n === 49) this.bg &= ~COLOR
      else if (n === 38 || n === 48 || n === 58) i += this.extractColor(i)
      else if (n === 53) this.bg |= OVERLINE
      else if (n === 55) this.bg &= ~OVERLINE
      else if (n === 59) this.setExt(this.ext.ul, 0x3ffffff, this.ext.url) // xterm's -1: white, not the fg
    }
  }
  sgr0() {
    this.fg = 0
    this.bg = 0
    this.setExt(0, 0, this.ext.url)
  }
  underline(style) {
    if (!~style || style > 5) style = 1
    this.fg |= UNDERLINE
    if (style === 0) this.fg &= ~UNDERLINE
    this.setExt(style, this.ext.ulc, this.ext.url)
  }
  /** Sets the current extras, and EXT in bg by whether there are any. */
  setExt(ul, ulc, url, flag = true) {
    this.ext = ul || ulc || url ? new Ext(ul, ulc, url) : NO_EXT
    if (!flag) return
    if (!ul && !url) this.bg &= ~EXT
    else this.bg |= EXT
  }

  /** SGR 38, 48 or 58 at param `pos`, with ; or : between its parts. Returns the params it took past `pos`. */
  extractColor(pos) {
    const p = this.params
    const accu = [0, 0, -1, 0, 0, 0]
    let cSpace = 0
    let advance = 0
    do {
      accu[advance + cSpace] = p[pos + advance]
      if (this.hasSub(pos + advance)) {
        const sub = this.getSub(pos + advance)
        let i = 0
        do {
          if (accu[1] === 5) cSpace = 1
          accu[advance + i + 1 + cSpace] = sub[i]
        } while (++i < sub.length && i + advance + 1 + cSpace < accu.length)
        break
      }
      if ((accu[1] === 5 && advance + cSpace >= 2) || (accu[1] === 2 && advance + cSpace >= 5)) break
      if (accu[1]) cSpace = 1
    } while (++advance + pos < this.plen && advance + cSpace < accu.length)
    for (let i = 2; i < accu.length; i++) if (accu[i] === -1) accu[i] = 0
    const color = c => {
      if (accu[1] === 2) return c & ~0xffffff | RGB | (accu[3] & 255) << 16 | (accu[4] & 255) << 8 | accu[5] & 255
      if (accu[1] === 5) return c & ~(CM | 0xff) | P256 | accu[3] & 0xff
      return c
    }
    if (accu[0] === 38) this.fg = color(this.fg)
    else if (accu[0] === 48) this.bg = color(this.bg)
    else if (accu[0] === 58) this.setExt(this.ext.ul, color(this.ext.ulc) & COLOR, this.ext.url, false)
    return advance
  }

  dcsHook(ident) {
    this.dcs = ident === 0x2471 // $q DECRQSS
      ? { ident, sink: null, parts: [], length: 0 }
      : { ident, sink: this.h.dcs?.(ident, this.paramArray()) ?? null }
  }
  dcsPut(s) {
    const d = this.dcs
    if (!d) return
    if (d.sink) d.sink.put(s)
    else if (d.parts && d.length <= LIMIT) {
      d.parts.push(s)
      d.length += s.length
    }
  }
  dcsEnd(ok) {
    const d = this.dcs
    this.dcs = null
    if (!d) return
    if (d.sink) d.sink.end(ok)
    else if (d.parts && ok && d.length <= LIMIT) this.requestStatus(d.parts.join(''))
  }
  /** DECRQSS: the settings xterm reports; anything else is invalid. */
  requestStatus(data) {
    const b = this.buffer
    const ok = { '"q': '0"q', '"p': '61;1"p', r: `${b.scrollTop + 1};${b.scrollBottom + 1}r`, m: '0m', ' q': `${2 - (this.blink ? 1 : 0)} q` }[data]
    this.reply(ok ? `\x1bP1$r${ok}\x1b\\` : '\x1bP0$r\x1b\\')
  }

  oscPut(s, start, end) {
    const o = this.osc
    if (!o || o.state === 3) return
    if (o.state === 1) {
      while (start < end) {
        const code = s.charCodeAt(start++)
        if (code === 0x3b) {
          o.state = 2
          break
        }
        if (code < 0x30 || code > 0x39) {
          o.state = 3
          return
        }
        o.id = (o.id === -1 ? 0 : o.id) * 10 + code - 48
      }
    }
    if (o.state === 2 && end > start && o.length <= (o.id === 1337 ? IIP_LIMIT : LIMIT)) {
      o.parts.push(s.slice(start, end))
      o.length += end - start
    }
  }
  oscEnd(ok) {
    const o = this.osc
    this.osc = null
    if (!o || o.state === 3 || !ok || o.length > (o.id === 1337 ? IIP_LIMIT : LIMIT)) return
    const data = o.parts.join('')
    switch (o.id) {
      case 0: case 2:
        this.title = data
        this.h.title?.(data)
        break
      case 1: case 4: case 104: case 110: case 111: case 112: break
      case 8: this.hyperlink(data); break
      case 10: case 11: case 12: {
        const slots = data.split(';')
        for (let i = 0, k = o.id - 10; i < slots.length && k < 3; i++, k++) {
          if (slots[i] !== '?') continue
          const rgb = this.h.colors?.()[k]
          if (rgb) this.reply(`\x1b]${10 + k};rgb:${rgb.map(c => c.toString(16).padStart(2, '0').repeat(2)).join('/')}\x1b\\`)
        }
        break
      }
      default: if (o.id >= 0) this.h.osc?.(o.id, data)
    }
  }

  /** OSC 8: `params;uri` starts a link, an empty uri ends it. Links with the same id= and uri are one. */
  hyperlink(data) {
    const at = data.indexOf(';')
    if (at === -1) return
    const params = data.slice(0, at).trim()
    const uri = data.slice(at + 1)
    if (!uri) {
      if (!params) this.setExt(this.ext.ul, this.ext.ulc, 0)
      return
    }
    const named = params.split(':').find(e => e.startsWith('id='))?.slice(3)
    let link = 0
    if (named) {
      const key = `${named};;${uri}`
      link = this.linkKeys.get(key) ?? 0
      if (!link) this.linkKeys.set(key, link = this.addLink(uri, key))
    } else link = this.addLink(uri, null)
    this.setExt(this.ext.ul, this.ext.ulc, link)
  }
  addLink(uri, key) {
    if (this.links.size >= 4096) this.sweepLinks()
    const link = this.nextLink++
    this.links.set(link, { uri, key })
    return link
  }
  /** Forgets links no cell holds any more. */
  sweepLinks() {
    const live = new Set([this.ext.url])
    for (const b of [this.normal, this.alt]) {
      for (let i = 0; i < b.lines.length; i++) {
        const ext = b.lines.get(i).ext
        if (ext) for (const e of ext.values()) live.add(e.url)
      }
    }
    for (const [link, { key }] of this.links) {
      if (live.has(link)) continue
      this.links.delete(link)
      if (key) this.linkKeys.delete(key)
    }
  }
  /** The uri of link `id`, as a cell's `getLink` gives it. */
  linkUri(id) { return this.links.get(id)?.uri }

  /** Covers `cols` x `rows` cells from the cursor with the tiles of picture `id`, as xterm's image addon did:
   * the cursor ends on the picture's last row, in the column it started. */
  picture(id, cols, rows) {
    const b = this.buffer
    const x0 = Math.min(b.x, this.cols - 1)
    for (let r = 0; r < rows; r++) {
      const line = b.row(b.y)
      const at = 2 * line.cap
      for (let c = 0; c < cols && x0 + c < this.cols; c++) {
        const x = x0 + c
        const old = line.d[at + x] & EXT ? line.ext.get(x) : NO_EXT
        line.d[at + x] |= EXT
        ;(line.ext ??= new Map()).set(x, new Ext(old.ul, old.ulc, old.url, id, r * cols + c))
      }
      if (r < rows - 1) this.lineFeed()
      b.x = x0
    }
    this.changed = true
  }

  apcEnd(ok) {
    const a = this.apc
    this.apc = null
    if (a && ok && a.length <= LIMIT) this.h.apc?.(a.parts.join(''))
  }

  /** Focus moves to or from the terminal: reported with 1004 on. */
  focus(on) {
    this.focused = on
    if (this.sendFocus) this.reply(on ? '\x1b[I' : '\x1b[O')
  }

  /** Sets the size; a no-op when it's the same. Returns whether it changed. */
  resize(cols, rows) {
    cols = Math.max(cols, 2)
    rows = Math.max(rows, 1)
    if (cols === this.cols && rows === this.rows) return false
    const [oldCols, oldRows] = [this.cols, this.rows]
    this.cols = cols
    this.rows = rows
    this.normal.resize(cols, rows, oldCols, oldRows)
    this.alt.resize(cols, rows, oldCols, oldRows)
    this.normal.setupTabStops(cols)
    this.alt.setupTabStops(cols)
    this.changed = true
    return true
  }
}

/** Empties `line` for reuse as a new row of `cols`. */
function blank(line, cols, bg, wrapped = false) {
  if (line.length !== cols) {
    line.length = Math.min(line.length, cols)
    line.resize(cols)
  }
  line.fill(bg)
  line.isWrapped = wrapped
  return line
}
