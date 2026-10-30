// The editor's text: lines, with UTF-16 offsets counted as if '\n' joined them. A change list is
// `[{ from, to, insert }]`, sorted and apart, in offsets of the text before it; `insert` holds '\n' line breaks.

/** `text` as lines, split at \r\n, \r or \n. */
export const split = text => (text.includes('\r') ? text.split(/\r\n?|\n/) : text.split('\n'))

export class Doc {
  constructor(text) {
    this.lines = split(text)
    this.starts = new Int32Array(this.lines.length + 1) // each line's offset, correct up to `known`
    this.known = 0
    this.length = this.lines.reduce((n, l) => n + l.length + 1, -1)
  }

  get count() { return this.lines.length }

  /** Line `i`'s offset. */
  start(i) {
    if (i > this.known) this.index(i)
    return this.starts[i]
  }

  index(upTo) {
    const s = this.starts, lines = this.lines
    let k = this.known
    for (; k < upTo; k++) s[k + 1] = s[k] + lines[k].length + 1
    this.known = k
  }

  /** The line holding offset `pos`. */
  lineOf(pos) {
    const s = this.starts, last = this.lines.length - 1
    if (pos >= s[this.known]) {
      // extend the known offsets just past `pos`
      while (this.known < last && s[this.known] <= pos) this.index(Math.min(last, this.known + 256))
      if (s[this.known] <= pos) return this.known
    }
    let lo = 0, hi = this.known
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (s[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** The text between offsets `from` and `to`, lines joined by `sep`. */
  slice(from, to, sep = '\n') {
    const a = this.lineOf(from), b = this.lineOf(to)
    const fa = from - this.start(a), tb = to - this.start(b)
    if (a === b) return this.lines[a].slice(fa, tb)
    const out = [this.lines[a].slice(fa)]
    for (let i = a + 1; i < b; i++) out.push(this.lines[i])
    out.push(this.lines[b].slice(0, tb))
    return out.join(sep)
  }

  text(sep = '\n') { return this.lines.join(sep) }

  /** The text in pieces of whole lines, `size` characters or a little more each, from line i down, or with `back`
   * from line i up: [offset, text] pairs. A search for what can't span lines needs no more of the text joined. */
  *pieces(i, back = false, size = 65536) {
    const lines = this.lines
    while (back ? i >= 0 : i < lines.length) {
      let j = i, n = 0
      if (back) {
        while (j >= 0 && n < size) n += lines[j--].length + 1
        yield [this.start(j + 1), i === j + 1 ? lines[i] : lines.slice(j + 1, i + 1).join('\n')]
      } else {
        while (j < lines.length && n < size) n += lines[j++].length + 1
        yield [this.start(i), j === i + 1 ? lines[i] : lines.slice(i, j).join('\n')]
      }
      i = j
    }
  }

  /**
   * Applies `changes`. Returns their inverse, a change list for the text after them, and the line edits they made,
   * `{ at, del, ins }`: lines `at` to `at + del - 1` became `ins` lines. The edits are ascending and apart, in line
   * numbers from before the changes; changes that share a line make one edit.
   */
  apply(changes) {
    const inverse = new Array(changes.length), edits = [], parts = [], lines = this.lines
    let shift = 0
    for (let k = 0; k < changes.length; k++) {
      const { from, to, insert } = changes[k]
      inverse[k] = { from: from + shift, to: from + shift + insert.length, insert: this.slice(from, to) }
      shift += insert.length - (to - from)
    }
    if (!changes.length) return { inverse, edits }
    for (let k = 0; k < changes.length;) {
      const a = this.lineOf(changes[k].from)
      let b = a, end = changes[k].from, s = lines[a].slice(0, end - this.start(a))
      do { // this change, and each after it that starts on the line the last one ended on
        const { from, to, insert } = changes[k++]
        const bs = this.start(b)
        s += lines[b].slice(end - bs, from - bs) + insert
        b = this.lineOf(to)
        end = to
      } while (k < changes.length && this.lineOf(changes[k].from) === b)
      const p = (s + lines[b].slice(end - this.start(b))).split('\n')
      edits.push({ at: a, del: b - a + 1, ins: p.length })
      parts.push(p)
    }
    this.length += shift
    const first = edits[0].at
    if (edits.length === 1 && edits[0].del === 1 && parts[0].length === 1) lines[first] = parts[0][0]
    else if (edits.length === 1 && parts[0].length < 5000) lines.splice(first, edits[0].del, ...parts[0])
    else {
      const pieces = []
      let line = 0
      edits.forEach((e, n) => { pieces.push(lines.slice(line, e.at), parts[n]); line = e.at + e.del })
      pieces.push(lines.slice(line))
      this.lines = [].concat(...pieces)
    }
    const n = this.lines.length
    if (n + 1 > this.starts.length) {
      const s = new Int32Array(n + 1 + (n >> 3) + 64)
      s.set(this.starts.subarray(0, first + 1))
      this.starts = s
    }
    this.known = Math.min(this.known, first)
    return { inverse, edits }
  }
}

/** Where offset `pos` lands after `changes`. Inside a replaced range, or at an insertion, `assoc` < 0 keeps it before
 * the new text and > 0 puts it after. */
export function mapPos(pos, changes, assoc = -1) {
  let shift = 0
  for (const { from, to, insert } of changes) {
    if (pos < from || (pos === from && assoc < 0)) break
    if (pos > to || (pos === to && from < to && pos > from)) {
      shift += insert.length - (to - from)
      continue
    }
    return from + shift + (assoc < 0 ? 0 : insert.length)
  }
  return pos + shift
}

// The last line searched for a tab and where its first one is, so a long line is searched once per change.
let tabText = '', tabAt = -1
const firstTab = text => (text === tabText ? tabAt : (tabAt = (tabText = text).indexOf('\t')))

/** The visual column of offset `ch` in `text`, tabs stopping every 4. */
export function column(text, ch) {
  const t = firstTab(text)
  if (t < 0 || t >= ch) return ch
  let c = 0
  for (let k = 0; k < ch; k++) c = text.charCodeAt(k) === 9 ? c + 4 - (c % 4) : c + 1
  return c
}

/** The offset in `text` nearest visual column `col`. */
export function offsetAt(text, col) {
  if (col <= 0) return 0
  const t = firstTab(text)
  if (t < 0 || t > col) return Math.min(Math.round(col), text.length)
  let c = 0
  for (let k = 0; k < text.length; k++) {
    const next = text.charCodeAt(k) === 9 ? c + 4 - (c % 4) : c + 1
    if (next > col) return col - c < next - col ? k : k + 1
    c = next
  }
  return text.length
}

/** A selection range: `anchor` stays put while `head` moves; `goal` is the x a vertical move aims for; `assoc` < 0
 * draws a head where a wrapped line breaks at the end of the row above. */
export const sel1 = (anchor, head = anchor, goal, assoc = 0) => ({ anchor, head, goal, assoc })
export const from = r => Math.min(r.anchor, r.head)
export const to = r => Math.max(r.anchor, r.head)

/** `ranges` sorted, those that overlap merged, with `main` following its range. */
export function normal(ranges, main = ranges.length - 1) {
  if (ranges.length === 1) return { ranges, main: 0 }
  const keep = ranges[main]
  const sorted = [...ranges].sort((a, b) => from(a) - from(b))
  const out = []
  let m = 0
  for (const r of sorted) {
    const prev = out.at(-1)
    if (prev && (from(r) === to(r) ? from(r) <= to(prev) : from(r) < to(prev))) {
      const f = Math.min(from(prev), from(r)), t = Math.max(to(prev), to(r))
      out[out.length - 1] = r.anchor > r.head ? sel1(t, f) : sel1(f, t)
      if (r === keep) m = out.length - 1
    } else {
      if (r === keep) m = out.length
      out.push(r)
    }
  }
  return { ranges: out, main: m }
}
