// What the editor's keys do: moves, edits, indentation, comments, brackets, folds and cursors, each a command over
// the editor's view (editor.js). A command returns false when it didn't apply, so the key goes on to the page.
import { inText, inHeading } from './highlight.js'
import { column, offsetAt, sel1, from, to } from './doc.js'

const segmenter = new Intl.Segmenter()
const WORD = /[\p{L}\p{N}_]/u
const SPACE = 0, WORDS = 1, OTHER = 2
const category = (v, ch) => (/\s/.test(ch) ? SPACE : WORD.test(ch) || v.L.word?.includes(ch) ? WORDS : OTHER)
const lead = text => /^\s*/.exec(text)[0]
const unitCols = v => (v.unit === '\t' ? 4 : v.unit.length)
/** Whitespace `cols` columns wide, in tabs when the file indents with them. */
const indentString = (v, cols) => (v.unit === '\t' ? '\t'.repeat(Math.floor(cols / 4)) + ' '.repeat(cols % 4) : ' '.repeat(cols))

/** The offset after the grapheme cluster at `k` in `text`. */
function next(text, k) {
  if (text.charCodeAt(k) < 0x300 && !(text.charCodeAt(k + 1) >= 0x300)) return k + 1
  for (const s of segmenter.segment(text.slice(k, k + 64))) return k + s.segment.length
  return k + 1
}
/** The offset before the grapheme cluster that ends at `k`. */
function prev(text, k) {
  if (text.charCodeAt(k - 1) < 0x300) return k - 1
  const a = Math.max(0, k - 64)
  let at = a
  for (const s of segmenter.segment(text.slice(a, k))) at = a + s.index
  return at
}

const line = (v, pos) => {
  const i = v.doc.lineOf(pos), start = v.doc.start(i)
  return { i, start, text: v.doc.lines[i], k: pos - start }
}

/** Moves every range's head by `f(range)` (an offset or { head, goal }); with `extend`, anchors stay. */
function move(v, f, extend) {
  const ranges = v.ranges.map(r => {
    const m = f(r)
    const head = typeof m === 'number' ? m : m.head
    return sel1(extend ? r.anchor : head, head, typeof m === 'number' ? undefined : m.goal)
  })
  v.dispatch({ sel: { ranges, main: v.main }, kind: 'select' })
  return true
}

function charStep(v, pos, forward) {
  const { i, start, text, k } = line(v, pos)
  if (forward) return k < text.length ? start + next(text, k) : i < v.doc.count - 1 ? pos + 1 : pos
  return k > 0 ? start + prev(text, k) : i > 0 ? pos - 1 : pos
}
/** The end of the group of characters `pos` moves over: a word, a run of punctuation, after any spaces. */
function groupStep(v, pos, forward) {
  let cat = -1, p = pos
  for (;;) {
    const { i, start, text, k } = line(v, p)
    let q, ch
    if (forward ? k === text.length : k === 0) {
      if (forward ? i === v.doc.count - 1 : i === 0) return p
      q = p + (forward ? 1 : -1)
      ch = '\n'
    } else {
      q = start + (forward ? next(text, k) : prev(text, k))
      ch = forward ? text.slice(k, q - start) : text.slice(q - start, k)
    }
    const c = category(v, ch)
    if (cat < 0) cat = c
    else {
      if (cat === SPACE) cat = c
      if (cat !== c) return p
    }
    p = q
  }
}
/** Like groupStep, but a bracket moves over its whole pair. */
function syntaxStep(v, pos, forward) {
  const { text, k, start } = line(v, pos)
  const ch = forward ? text[k] : text[k - 1]
  if (ch && (forward ? '([{' : ')]}').includes(ch)) {
    const m = match(v, forward ? pos : pos - 1)
    if (m != null) return forward ? m + 1 : m
  }
  let p = pos
  if (forward) while (p < start + text.length && /\s/.test(text[p - start])) p++
  else while (p > start && /\s/.test(text[p - start - 1])) p--
  return p !== pos && (forward ? p === start + text.length : p === start) ? p : groupStep(v, p, forward)
}

function smartHome(v, r) {
  const edge = v.rowEdge(r.head, false)
  const { start, text } = line(v, r.head)
  if (edge !== start) return edge
  const space = lead(text).length
  return space && r.head !== start + space ? start + space : start
}

// ---- Deleting

/** Deletes every range, or where `f(range)` puts the other end of an empty one. */
function deleteBy(v, f, kind = 'delete') {
  const changes = []
  for (const r of v.ranges) {
    let a = from(r), b = to(r)
    if (a === b) {
      const t = f(r)
      a = Math.min(a, t)
      b = Math.max(b, t)
    }
    if (a < b) changes.push({ from: a, to: b, insert: '' })
  }
  if (!changes.length) return false
  const merged = []
  for (const c of changes.sort((x, y) => x.from - y.from)) {
    const last = merged.at(-1)
    if (last && c.from <= last.to) last.to = Math.max(last.to, c.to)
    else merged.push({ ...c })
  }
  v.dispatch({ changes: merged, kind })
  return true
}
function backspace(v) {
  if (deletePair(v) || deleteMarkup(v)) return true
  return deleteBy(v, r => {
    const { start, text, k } = line(v, r.head)
    const before = text.slice(0, k)
    if (k > 0 && k < 200 && !/[^ \t]/.test(before)) {
      if (before.endsWith('\t')) return r.head - 1
      const drop = column(before, k) % unitCols(v) || unitCols(v)
      let p = r.head
      for (let n = 0; n < drop && text[p - start - 1] === ' '; n++) p--
      return p
    }
    return charStep(v, r.head, false)
  })
}
const forwardDelete = v => deleteBy(v, r => charStep(v, r.head, true))
function groupDelete(v, forward) {
  return deleteBy(v, r => {
    const { start, text } = line(v, r.head)
    let p = r.head, cat = -1
    for (;;) {
      const at = p - start
      if (forward ? at === text.length : at === 0) {
        if (p === r.head && (forward ? p < v.doc.length : p > 0)) p += forward ? 1 : -1
        break
      }
      const q = start + (forward ? next(text, at) : prev(text, at))
      const ch = text.slice(Math.min(p, q) - start, Math.max(p, q) - start)
      const c = category(v, ch)
      if (cat >= 0 && c !== cat) break
      if (ch !== ' ' || p !== r.head) cat = c
      p = q
    }
    return p
  })
}
/** Backspace between a pair closeBrackets knows deletes both. */
function deletePair(v) {
  const pairs = closers(v)
  if (!pairs || v.ranges.some(r => r.anchor !== r.head)) return false
  const changes = []
  for (const r of v.ranges) {
    const { text, k } = line(v, r.head)
    if (!k || pairs[text[k - 1]] !== text[k] || text[k] === undefined) return false
    changes.push({ from: r.head - 1, to: r.head + 1, insert: '' })
  }
  v.dispatch({ changes, kind: 'delete' })
  return true
}
/** In Markdown, Backspace right after a list marker or a quote's `>` takes the marker away. */
function deleteMarkup(v) {
  if (!v.md || v.ranges.length > 1 || v.ranges[0].anchor !== v.ranges[0].head) return false
  const r = v.ranges[0], { start, text, k } = line(v, r.head)
  const m = /^(\s*)(?:([-+*]|\d{1,9}[.)])|>)( ?\[[ xX]\])? ?$/.exec(text.slice(0, k))
  if (!m || !markup(v, start, m[1].length)) return false
  // a list item's marker turns to the indent that continues the item; a quote's goes
  const ins = m[2] ? ' '.repeat(k - m[1].length) : ''
  v.dispatch({ changes: [{ from: start + m[1].length, to: r.head, insert: ins }], kind: 'delete' })
  return true
}
/** Whether the Markdown at `pos` is a list marker or quote, not code. */
function markup(v, start, k) {
  const i = v.doc.lineOf(start)
  const t = v.tokensOf(i)
  for (let n = 0; n < t.length; n += 3) if (t[n] <= k && k < t[n + 1]) return !inText(t[n + 2]) && (t[n + 2] & 31) !== 8
  return false
}

// ---- Lines

/** The blocks of whole lines the ranges touch, those that touch or abut merged: { from, to (line numbers), ranges }.
 * A range that ends at a line's start leaves that line out. */
function blocks(v) {
  const out = []
  for (const r of v.ranges) {
    const a = v.doc.lineOf(from(r))
    let b = v.doc.lineOf(to(r))
    if (to(r) > from(r) && to(r) === v.doc.start(b) && b > a) b--
    const last = out.at(-1)
    if (last && a <= last.to + 1) { last.to = Math.max(last.to, b); last.ranges.push(r) }
    else out.push({ from: a, to: b, ranges: [r] })
  }
  return out
}
/** Each line the ranges touch, once. */
function touchedLines(v) {
  const seen = []
  for (const b of blocks(v)) for (let i = b.from; i <= b.to; i++) if (seen.at(-1) !== i) seen.push(i)
  return seen
}
function changeLines(v, f, kind) {
  const changes = []
  for (const i of touchedLines(v)) f(i, v.doc.start(i), v.doc.lines[i], changes)
  if (!changes.length) return false
  v.dispatch({ changes, kind, assoc: 1 })
  return true
}
const indentMore = v => changeLines(v, (i, start, text, c) => c.push({ from: start, to: start, insert: v.unit }), 'indent')
const indentLess = v => changeLines(v, (i, start, text, c) => {
  const space = lead(text)
  if (!space) return
  const ins = indentString(v, Math.max(0, column(space, space.length) - unitCols(v)))
  let keep = 0
  while (keep < space.length && keep < ins.length && space[keep] === ins[keep]) keep++
  c.push({ from: start + keep, to: start + space.length, insert: ins.slice(keep) })
}, 'indent')

function moveLines(v, down) {
  const changes = [], ranges = []
  for (const b of blocks(v)) {
    if (down ? b.to === v.doc.count - 1 : b.from === 0) continue
    const a = v.doc.start(b.from), e = v.doc.start(b.to) + v.doc.lines[b.to].length
    const other = v.doc.lines[down ? b.to + 1 : b.from - 1]
    const size = other.length + 1
    if (down) changes.push({ from: a, to: a, insert: other + '\n' }, { from: e, to: e + size, insert: '' })
    else changes.push({ from: a - size, to: a, insert: '' }, { from: e, to: e, insert: '\n' + other })
    for (const r of b.ranges) ranges.push(sel1(r.anchor + (down ? size : -size), r.head + (down ? size : -size)))
  }
  if (!changes.length) return false
  v.dispatch({ changes: changes.sort((x, y) => x.from - y.from || x.to - y.to), sel: { ranges, main: v.main }, kind: 'move.line' })
  return true
}
function copyLines(v, down) {
  const changes = [], ranges = []
  let shift = 0
  for (const b of blocks(v)) {
    const a = v.doc.start(b.from), e = v.doc.start(b.to) + v.doc.lines[b.to].length
    const s = v.doc.slice(a, e)
    if (down) changes.push({ from: a, to: a, insert: s + '\n' })
    else changes.push({ from: e, to: e, insert: '\n' + s })
    for (const r of b.ranges) ranges.push(sel1(r.anchor + shift + (down ? s.length + 1 : 0), r.head + shift + (down ? s.length + 1 : 0)))
    shift += s.length + 1
  }
  v.dispatch({ changes, sel: { ranges, main: v.main }, kind: 'copyline' })
  return true
}
function deleteLines(v) {
  const changes = [], ranges = []
  let shift = 0
  for (const b of blocks(v)) {
    let a = v.doc.start(b.from), e = v.doc.start(b.to) + v.doc.lines[b.to].length
    if (a > 0) a--
    else if (e < v.doc.length) e++
    changes.push({ from: a, to: e, insert: '' })
    for (const r of b.ranges) {
      // the caret goes to the line after, at the same column
      const nl = b.to + 1 < v.doc.count ? b.to + 1 : Math.max(0, b.from - 1)
      const { text, k } = line(v, r.head)
      const target = v.doc.start(nl) + offsetAt(v.doc.lines[nl], column(text, k))
      ranges.push(sel1((target > e ? target - (e - a) : Math.min(target, a)) - shift))
    }
    shift += e - a
  }
  v.dispatch({ changes, sel: { ranges, main: Math.min(v.main, ranges.length - 1) }, kind: 'delete.line' })
  return true
}

/** Enter: a new line indented as this one, one level more after an opener, and `{|}` split around an indented line.
 * In Markdown a list or quote goes on. With `below`, the new line goes under the line, wherever the caret is. */
function newline(v, below = false) {
  if (!below && v.md && continueMarkup(v)) return true
  const changes = [], ranges = []
  let shift = 0
  for (const r of v.ranges) {
    let a = from(r), b = to(r)
    const { start, text } = line(v, a)
    if (below) a = b = start + text.length
    const k = a - start
    const explode = !below && a === b && /^(\(\)|\[\]|\{\})$/.test(text.slice(k - 1, k + 1))
    const base = lead(text)
    const opens = !below ? v.L.indent?.test(text.slice(0, k)) : v.L.indent?.test(text)
    const indent = opens || explode ? base + v.unit : base.slice(0, Math.min(base.length, below ? base.length : k))
    const end = line(v, b)
    while (b < end.start + end.text.length && /\s/.test(end.text[b - end.start])) b++
    if (!below && a > start && k < 100 && !/\S/.test(text.slice(0, k))) a = start
    const ins = '\n' + indent + (explode ? '\n' + base : '')
    changes.push({ from: a, to: b, insert: ins })
    ranges.push(sel1(a + shift + 1 + indent.length))
    shift += ins.length - (b - a)
  }
  v.dispatch({ changes, sel: { ranges, main: v.main }, kind: 'input' })
  return true
}
/** Markdown's Enter in a list item or quote: the next item, renumbered; on an empty one, the list ends. */
function continueMarkup(v) {
  if (v.ranges.length > 1 || v.ranges[0].anchor !== v.ranges[0].head) return false
  const pos = v.ranges[0].head
  const { i, start, text, k } = line(v, pos)
  const m = /^(\s*)(?:([-+*])|(\d{1,9})([.)])|(>))(\s*)(\[[ xX]\]\s)?/.exec(text)
  if (!m || k < m[0].length || !markup(v, start, m[1].length)) return false
  const [all, indent, bullet, num, delim, quote, space, task] = m
  if (all.length === text.length && !text.slice(all.length).trim()) {
    v.dispatch({ changes: [{ from: start, to: start + text.length, insert: '' }], kind: 'input' })
    return true
  }
  const n = num ? +num + 1 : 0
  const marker = indent + (quote ? '>' : bullet ?? `${n}${delim}`) + (space || ' ') + (task ? '[ ] ' : '')
  const changes = [{ from: pos, to: pos, insert: '\n' + marker }]
  if (num) {
    // the items after this one count on from the new one
    let want = n
    for (let j = i + 1; j < v.doc.count; j++) {
      const t = v.doc.lines[j], mm = /^(\s*)(\d{1,9})([.)])/.exec(t)
      if (!mm) { if (!t.trim() || t.startsWith(indent + ' ')) continue; break }
      if (mm[1] !== indent || mm[3] !== delim) { if (mm[1].length > indent.length) continue; break }
      if (+mm[2] !== want) break
      want++
      const s = v.doc.start(j) + mm[1].length
      changes.push({ from: s, to: s + mm[2].length, insert: String(want) })
    }
  }
  v.dispatch({ changes, sel: { ranges: [sel1(pos + 1 + marker.length)], main: 0 }, kind: 'input' })
  return true
}

// ---- Typing

/** Brackets and quotes typing closes, as { opener: closer }. Prose closes none. */
function closers(v) {
  if (v.L.prose) return null
  const s = v.L.close ?? '()[]{}\'\'""'
  const out = {}
  for (let k = 0; k < s.length; k += 2) out[s[k]] = s[k + 1]
  return out
}
const AFTER = /[\s)\]}:;>]/

/** Types `s` at every range: closing brackets and quotes as it goes, and reindenting a line that should dedent. */
export function type(v, s) {
  const pairs = closers(v)
  const main = v.ranges[v.main]
  v.closed = v.closed.filter(p => v.doc.lineOf(p) === v.doc.lineOf(main.head))
  if (s.length === 1 && pairs && closeBrackets(v, s, pairs)) return dedent(v)
  const changes = [], ranges = []
  let shift = 0
  for (const r of v.ranges) {
    changes.push({ from: from(r), to: to(r), insert: s })
    ranges.push(sel1(from(r) + shift + s.length))
    shift += s.length - (to(r) - from(r))
  }
  v.dispatch({ changes, sel: { ranges, main: v.main }, kind: 'type' })
  dedent(v)
}
function closeBrackets(v, ch, pairs) {
  const isClose = Object.values(pairs).includes(ch), isOpen = ch in pairs
  if (!isClose && !isOpen) return false
  const at = r => { const { text, k } = line(v, r.head); return text[k] }
  if (!isOpen) { // a closer: over the one closeBrackets put after the main caret, and the same at every caret
    if (!v.closed.includes(from(v.ranges[v.main])) || v.ranges.some(r => r.anchor !== r.head || at(r) !== ch)) return false
    v.dispatch({ sel: { ranges: v.ranges.map(r => sel1(r.head + 1)), main: v.main }, kind: 'type' })
    return true
  }
  const changes = [], ranges = [], closed = []
  let shift = 0
  for (const r of v.ranges) {
    const a = from(r), b = to(r)
    const { text, k } = line(v, b)
    const after = text[k], before = text[k - 1]
    if (a !== b && isOpen) { // wrap the selection
      changes.push({ from: a, to: a, insert: ch }, { from: b, to: b, insert: pairs[ch] })
      ranges.push(sel1(r.anchor + shift + 1, r.head + shift + 1))
      shift += 2
      continue
    }
    if (a !== b) return false
    if (after === ch && v.closed.includes(b)) { // type over the quote we put there
      ranges.push(sel1(b + shift + 1))
      continue
    }
    const quote = pairs[ch] === ch
    if ((after !== undefined && !AFTER.test(after)) ||
        (quote && before !== undefined && (WORD.test(before) || before === ch))) return false
    changes.push({ from: a, to: a, insert: ch + pairs[ch] })
    ranges.push(sel1(a + shift + 1))
    closed.push(a + shift + 1)
    shift += 2
  }
  v.dispatch({ changes, sel: { ranges, main: v.main }, kind: 'type' })
  v.closed = [...v.closed, ...closed]
  return true
}
/** Reindents a line whose typed text matches the language's dedent rule. */
function dedent(v) {
  const rule = v.L.dedent
  if (!rule) return
  const changes = []
  for (const r of v.ranges) {
    const { i, start, text, k } = line(v, r.head)
    if (k > 200 || !rule.test(text.slice(0, k))) continue
    const want = indentFor(v, i, text)
    const have = lead(text)
    if (want != null && want !== have) changes.push({ from: start, to: start + have.length, insert: want })
  }
  if (changes.length) v.dispatch({ changes, kind: 'type' })
}
function indentFor(v, i, text) {
  const t = text.trimStart()
  const start = v.doc.start(i) + (text.length - t.length)
  if (/^[)\]}]/.test(t)) {
    const m = match(v, start)
    return m == null ? null : lead(v.doc.lines[v.doc.lineOf(m)])
  }
  const prevLine = () => { for (let j = i - 1; j >= 0; j--) if (v.doc.lines[j].trim()) return v.doc.lines[j]; return '' }
  const cols = s => column(s, s.length)
  if (/^(case |default:)/.test(t)) {
    for (let j = i - 1; j >= Math.max(0, i - 500); j--) {
      const l = v.doc.lines[j]
      if (/^\s*(case |default:)/.test(l)) return lead(l)
      if (/\{\s*$/.test(l)) return lead(l) + v.unit
    }
    return null
  }
  if (/^(else|elif|except|finally)\b/.test(t)) {
    const now = cols(lead(text))
    for (let j = i - 1; j >= Math.max(0, i - 500); j--) {
      const l = v.doc.lines[j]
      if (!l.trim()) continue
      const s = lead(l)
      if (cols(s) < now && /^\s*(if|elif|else|for|while|try|except|with)\b/.test(l)) return s
      if (cols(s) < now - unitCols(v) * 2) break
    }
    return null
  }
  if (/^<\//.test(t)) {
    const p = prevLine()
    return v.L.indent?.test(p) ? lead(p) : indentString(v, Math.max(0, cols(lead(p)) - unitCols(v)))
  }
  if (t === '{') return lead(prevLine())
  return null
}

// ---- Comments

function toggleComment(v) {
  const token = v.L.line?.split(' ')[0]
  if (!token) return toggleBlock(v, true)
  const blocks_ = blocks(v)
  const changes = []
  for (const b of blocks_) {
    const lines = []
    let min = Infinity, all = true, empty = true
    for (let i = b.from; i <= b.to; i++) {
      const t = v.doc.lines[i], s = lead(t).length
      if (s === t.length && b.from !== b.to) continue
      empty = false
      min = Math.min(min, s)
      if (!t.startsWith(token, s)) all = false
      lines.push(i)
    }
    if (empty) continue
    for (const i of lines) {
      const t = v.doc.lines[i], st = v.doc.start(i), s = lead(t).length
      if (all) changes.push({ from: st + s, to: st + s + token.length + (t[s + token.length] === ' ' ? 1 : 0), insert: '' })
      else changes.push({ from: st + min, to: st + min, insert: token + ' ' })
    }
  }
  if (!changes.length) return false
  v.dispatch({ changes, kind: 'comment', assoc: 1 })
  return true
}
/** Wraps each range in a block comment, or unwraps it; `byLine` takes whole lines. */
function toggleBlock(v, byLine = false) {
  if (!v.L.block) return false
  const [open, close] = v.L.block.split(' ')
  const changes = [], ranges = []
  let shift = 0
  for (const r of byLine ? blocks(v).map(b => {
    const t = v.doc.lines[b.from]
    return sel1(v.doc.start(b.from) + lead(t).length, v.doc.start(b.to) + v.doc.lines[b.to].trimEnd().length)
  }) : v.ranges) {
    const a = from(r), b = to(r)
    const inner = v.doc.slice(a, b)
    const o = new RegExp(`^${esc(open)} ?`).exec(inner), c = new RegExp(` ?${esc(close)}$`).exec(inner)
    if (o && c && o[0].length + c[0].length <= inner.length) {
      changes.push({ from: a, to: a + o[0].length, insert: '' }, { from: b - c[0].length, to: b, insert: '' })
      ranges.push(sel1(a + shift, b + shift - o[0].length - c[0].length))
      shift -= o[0].length + c[0].length
    } else {
      changes.push({ from: a, to: a, insert: open + ' ' }, { from: b, to: b, insert: ' ' + close })
      ranges.push(sel1(a + shift + open.length + 1, b + shift + open.length + 1))
      shift += open.length + close.length + 2
    }
  }
  v.dispatch({ changes, sel: byLine ? undefined : { ranges, main: v.main }, kind: 'comment' })
  return true
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- Brackets

/** Whether character `k` of line i sits in a comment or a string: its class, or 0 for code. */
function textClass(tokens, k) {
  for (let n = 0; n < tokens.length; n += 3) {
    if (tokens[n] > k) return 0
    if (k < tokens[n + 1]) return inText(tokens[n + 2]) ? tokens[n + 2] & 31 : 0
  }
  return 0
}
const OPEN = '([{', CLOSE = ')]}'
/** The offset of the bracket that pairs with the one at `at`, scanning at most `limit` characters; null when none
 * does, undefined when `at` holds no bracket. */
export function match(v, at, limit = 10_000) {
  const i0 = v.doc.lineOf(at), k0 = at - v.doc.start(i0)
  const ch = v.doc.lines[i0][k0]
  const o = OPEN.indexOf(ch), c = CLOSE.indexOf(ch)
  if (o < 0 && c < 0) return undefined
  const kind = textClass(v.tokensOf(i0), k0)
  const dir = o >= 0 ? 1 : -1
  let depth = 0, seen = 0
  for (let i = i0; i >= 0 && i < v.doc.count; i += dir) {
    const text = v.doc.lines[i], toks = v.tokensOf(i)
    for (let k = i === i0 ? k0 + dir : dir > 0 ? 0 : text.length - 1; k >= 0 && k < text.length; k += dir) {
      if (++seen > limit) return null
      const x = text[k]
      const same = dir > 0 ? OPEN.indexOf(x) : CLOSE.indexOf(x), other = dir > 0 ? CLOSE.indexOf(x) : OPEN.indexOf(x)
      if (same < 0 && other < 0) continue
      if (textClass(toks, k) !== kind) continue
      if (same >= 0) depth++
      else if (depth) depth--
      else return other === (o >= 0 ? o : c) ? v.doc.start(i) + k : null
    }
  }
  return null
}
/** The bracket beside a caret at `pos` and its partner: { at, to }, to null when nothing pairs with it. */
export function bracketAt(v, pos) {
  const { text, k } = line(v, pos)
  for (const at of [pos - 1, pos]) {
    const x = text[at - pos + k]
    if (x === undefined || (!OPEN.includes(x) && !CLOSE.includes(x))) continue
    const m = match(v, at)
    if (m !== undefined) return { at, to: m }
  }
  return null
}
function matchingBracket(v, extend) {
  return move(v, r => {
    const b = bracketAt(v, r.head)
    if (!b || b.to == null) return r.head
    return b.at === r.head ? b.to + 1 : b.to
  }, extend)
}
/** The innermost bracket pair around a..b that's wider than it: [open, close], or null. */
function around(v, a, b) {
  let depth = 0
  for (let p = a - 1, seen = 0; p >= 0 && seen < 100_000; p--, seen++) {
    const { text, k, i } = line(v, p)
    if (k === text.length) continue
    const x = text[k]
    if (!OPEN.includes(x) && !CLOSE.includes(x)) continue
    if (textClass(v.tokensOf(i), k)) continue
    if (CLOSE.includes(x)) { depth++; continue }
    if (depth) { depth--; continue }
    const m = match(v, p, 1e6)
    if (m != null && m >= b) return [p, m]
  }
  return null
}
/** Ctrl+I: the word at an empty range, then each wider bracketed group, then everything. */
function selectParent(v) {
  const ranges = v.ranges.map(r => {
    const a = from(r), b = to(r)
    const w = a === b && wordAt(v, a)
    if (w) return sel1(w.from, w.to)
    for (let p = a, q = b; ;) {
      const pair = around(v, p, q)
      if (!pair) return sel1(0, v.doc.length)
      if (pair[0] < a || pair[1] + 1 > b) return sel1(pair[0], pair[1] + 1)
      p = pair[0]
      q = pair[1] + 1
    }
  })
  v.dispatch({ sel: { ranges, main: v.main }, kind: 'select' })
  return true
}

// ---- Words and occurrences

/** The word at `pos`: { from, to }, or null when no word character touches it. */
export function wordAt(v, pos) {
  const { start, text, k } = line(v, pos)
  let a = k, b = k
  while (a > 0 && category(v, text[a - 1]) === WORDS) a--
  while (b < text.length && category(v, text[b]) === WORDS) b++
  return a === b ? null : { from: start + a, to: start + b }
}
/** What a double click at `pos` picks: its word, its run of spaces, or its character. */
export function groupAt(v, pos) {
  const { start, text, k } = line(v, pos)
  const at = k < text.length ? k : k - 1
  if (at < 0) return { from: pos, to: pos }
  const cat = category(v, text[at])
  if (cat === OTHER) return { from: start + at, to: start + at + 1 }
  let a = at, b = at + 1
  while (a > 0 && category(v, text[a - 1]) === cat) a--
  while (b < text.length && category(v, text[b]) === cat) b++
  return { from: start + a, to: start + b }
}
function selectNext(v) {
  const rs = v.ranges
  if (rs.some(r => r.anchor === r.head)) {
    const ranges = rs.map(r => { const w = wordAt(v, r.head); return w ? sel1(w.from, w.to) : r })
    v.dispatch({ sel: { ranges, main: v.main }, kind: 'select' })
    return true
  }
  const q = v.doc.slice(from(rs[0]), to(rs[0]))
  if (rs.some(r => v.doc.slice(from(r), to(r)) !== q)) return false
  const m = rs[v.main], w = wordAt(v, m.head)
  const whole = w && w.from === from(m) && w.to === to(m)
  const text = v.doc.text()
  const ok = p => !rs.some(r => from(r) === p) && (!whole || ((p === 0 || category(v, text[p - 1]) !== WORDS) &&
    category(v, text[p + q.length] ?? ' ') !== WORDS))
  let p = text.indexOf(q, to(rs.at(-1)))
  while (p >= 0 && !ok(p)) p = text.indexOf(q, p + 1)
  if (p < 0) {
    p = text.indexOf(q)
    while (p >= 0 && p < from(rs.at(-1)) && !ok(p)) p = text.indexOf(q, p + 1)
    if (p < 0 || p >= from(rs.at(-1))) return false
  }
  v.dispatch({ sel: { ranges: [...rs, sel1(p, p + q.length)], main: v.main }, kind: 'select' })
  v.reveal(p + q.length)
  return true
}
function selectMatches(v) {
  if (v.ranges.length > 1 || v.ranges[0].anchor === v.ranges[0].head) return false
  const r = v.ranges[0], q = v.doc.slice(from(r), to(r))
  const text = v.doc.text()
  const ranges = []
  let main = 0
  for (let p = text.indexOf(q); p >= 0; p = text.indexOf(q, p + q.length)) {
    if (ranges.length > 1000) return false
    if (p === from(r)) main = ranges.length
    ranges.push(sel1(p, p + q.length))
  }
  v.dispatch({ sel: { ranges, main }, kind: 'select' })
  return true
}

function addCursor(v, down) {
  const ranges = [...v.ranges]
  for (const r of v.ranges) {
    const i = v.doc.lineOf(r.head)
    if (down ? i === v.doc.count - 1 : i === 0) continue
    const m = v.vertical(r, down ? 1 : -1)
    if (!ranges.some(q => q.head === m.head)) ranges.push(sel1(m.head, m.head, m.goal))
  }
  if (ranges.length === v.ranges.length) return false
  v.dispatch({ sel: { ranges, main: ranges.length - 1 }, kind: 'select' })
  return true
}
function simplify(v) {
  const m = v.ranges[v.main]
  if (v.ranges.length > 1) v.dispatch({ sel: { ranges: [m], main: 0 }, kind: 'select' })
  else if (m.anchor !== m.head) v.dispatch({ sel: { ranges: [sel1(m.head)], main: 0 }, kind: 'select' })
  else return false
  return true
}
function selectLine(v) {
  const ranges = blocks(v).map(b => sel1(v.doc.start(b.from), Math.min(v.doc.length, v.doc.start(b.to) + v.doc.lines[b.to].length + 1)))
  v.dispatch({ sel: { ranges, main: 0 }, kind: 'select' })
  return true
}
function page(v, down, extend) {
  const by = v.scroller.clientHeight
  move(v, r => v.vertical(r, down ? 1 : -1, by), extend)
  v.scroller.scrollTop += down ? by : -by
  return true
}

// ---- Folds

/** Whether line i starts a block that folds, judged from the line alone and the next. */
export function foldable(v, i, tokens) {
  const text = v.doc.lines[i]
  switch (v.L.fold) {
    case 'brace': return unclosed(text, tokens) >= 0
    case 'indent': {
      if (!text.trim()) return false
      const n = column(lead(text), lead(text).length)
      for (let j = i + 1; j < Math.min(v.doc.count, i + 50); j++) {
        const t = v.doc.lines[j]
        if (t.trim()) return column(lead(t), lead(t).length) > n
      }
      return false
    }
    case 'heading': return /^#{1,6}(\s|$)/.test(text) && tokens.length > 2 && tokens[0] === 0 && inHeading(tokens[2])
  }
  return false
}
/** The last opening bracket of `text` left open at its end, outside strings and comments, or -1. */
function unclosed(text, tokens) {
  const stack = []
  let t = 0
  for (let k = 0, end = Math.min(text.length, 10_000); k < end; k++) {
    const x = text.charCodeAt(k)
    if (x !== 40 && x !== 41 && x !== 91 && x !== 93 && x !== 123 && x !== 125) continue
    while (t < tokens.length && tokens[t + 1] <= k) t += 3
    if (t < tokens.length && tokens[t] <= k && inText(tokens[t + 2])) continue
    if (x === 40 || x === 91 || x === 123) stack.push(k)
    else stack.pop()
  }
  return stack.length ? stack.at(-1) : -1
}
/** The last line a fold starting at line i hides, or null when nothing would hide. */
export function foldRange(v, i) {
  const lines = v.doc.lines
  let end = null
  switch (v.L.fold) {
    case 'brace': {
      const k = unclosed(lines[i], v.tokensOf(i))
      if (k < 0) return null
      const m = match(v, v.doc.start(i) + k, Infinity)
      if (m == null) return null
      const j = v.doc.lineOf(m)
      end = lines[j].slice(0, m - v.doc.start(j)).trim() ? j : j - 1
      break
    }
    case 'indent': {
      const n = column(lead(lines[i]), lead(lines[i]).length)
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue
        if (column(lead(lines[j]), lead(lines[j]).length) <= n) break
        end = j
      }
      break
    }
    case 'heading': {
      const level = /^#{1,6}/.exec(lines[i])?.[0].length
      if (!level) return null
      let j = i + 1
      for (; j < lines.length; j++) {
        const h = /^#{1,6}(?=\s|$)/.exec(lines[j])
        if (h && h[0].length <= level) {
          const t = v.tokensOf(j)
          if (t.length > 2 && t[0] === 0 && inHeading(t[2])) break
        }
      }
      end = j - 1
      while (end > i && !lines[end].trim()) end--
      break
    }
  }
  return end != null && end > i ? end : null
}
function foldHere(v) {
  let any = false
  for (const i of new Set(v.ranges.map(r => v.doc.lineOf(r.head)))) {
    const end = foldRange(v, i)
    if (end == null) continue
    v.folds.set([...v.folds.list.filter(f => f[0] < i || f[1] > end), [i, end]])
    any = true
  }
  return any
}
function unfoldHere(v) {
  const lines = new Set(v.ranges.map(r => v.doc.lineOf(r.head)))
  const rest = v.folds.list.filter(f => !lines.has(f[0]))
  if (rest.length === v.folds.list.length) return false
  v.folds.set(rest)
  return true
}
function foldAll(v) {
  v.lexTo(v.doc.count)
  const out = []
  for (let i = 0; i < v.doc.count; i++) {
    if (!foldable(v, i, v.tokensOf(i))) continue
    const end = foldRange(v, i)
    if (end == null) continue
    out.push([i, end])
    i = end
  }
  v.folds.set(out)
  return true
}

const sides = (base, f) => ({ [base]: v => f(v, false), [base.replace(/^(Ctrl-)?(Alt-)?/, '$1$2Shift-')]: v => f(v, true) })

/** Key names and their commands. */
export const KEYS = {
  ...sides('ArrowLeft', (v, x) => move(v, r => (!x && r.anchor !== r.head ? from(r) : charStep(v, r.head, false)), x)),
  ...sides('ArrowRight', (v, x) => move(v, r => (!x && r.anchor !== r.head ? to(r) : charStep(v, r.head, true)), x)),
  ...sides('Ctrl-ArrowLeft', (v, x) => move(v, r => groupStep(v, r.head, false), x)),
  ...sides('Ctrl-ArrowRight', (v, x) => move(v, r => groupStep(v, r.head, true), x)),
  ...sides('Alt-ArrowLeft', (v, x) => move(v, r => syntaxStep(v, r.head, false), x)),
  ...sides('Alt-ArrowRight', (v, x) => move(v, r => syntaxStep(v, r.head, true), x)),
  ...sides('ArrowUp', (v, x) => move(v, r => v.vertical(r, -1), x)),
  ...sides('ArrowDown', (v, x) => move(v, r => v.vertical(r, 1), x)),
  ...sides('Home', (v, x) => move(v, r => smartHome(v, r), x)),
  ...sides('End', (v, x) => move(v, r => v.rowEdge(r.head, true), x)),
  ...sides('Ctrl-Home', (v, x) => move(v, () => 0, x)),
  ...sides('Ctrl-End', (v, x) => move(v, () => v.doc.length, x)),
  ...sides('PageUp', (v, x) => page(v, false, x)),
  ...sides('PageDown', (v, x) => page(v, true, x)),
  'Alt-ArrowUp': v => moveLines(v, false),
  'Alt-ArrowDown': v => moveLines(v, true),
  'Alt-Shift-ArrowUp': v => copyLines(v, false),
  'Alt-Shift-ArrowDown': v => copyLines(v, true),
  'Ctrl-Alt-ArrowUp': v => addCursor(v, false),
  'Ctrl-Alt-ArrowDown': v => addCursor(v, true),
  Enter: v => newline(v),
  'Shift-Enter': v => newline(v),
  'Ctrl-Enter': v => newline(v, true),
  Backspace: backspace,
  'Shift-Backspace': backspace,
  Delete: forwardDelete,
  'Ctrl-Backspace': v => groupDelete(v, false),
  'Ctrl-Delete': v => groupDelete(v, true),
  'Ctrl-Shift-k': deleteLines,
  Tab: indentMore,
  'Shift-Tab': indentLess,
  'Ctrl-]': indentMore,
  'Ctrl-[': indentLess,
  'Ctrl-/': toggleComment,
  'Alt-Shift-a': v => toggleBlock(v),
  Escape: simplify,
  'Ctrl-a': v => (v.dispatch({ sel: { ranges: [sel1(0, v.doc.length)], main: 0 }, kind: 'select', scroll: false }), true),
  'Alt-l': selectLine,
  'Ctrl-i': selectParent,
  'Ctrl-Shift-\\': v => matchingBracket(v, false),
  'Ctrl-d': selectNext,
  'Ctrl-Shift-l': selectMatches,
  'Ctrl-f': v => v.find.open(false),
  'Ctrl-h': v => v.find.open(true),
  F3: v => v.find.step(1),
  'Shift-F3': v => v.find.step(-1),
  'Ctrl-g': v => v.find.step(1),
  'Ctrl-Shift-g': v => v.find.step(-1),
  'Ctrl-z': v => v.undo(false),
  'Ctrl-y': v => v.undo(true),
  'Ctrl-Shift-z': v => v.undo(true),
  'Ctrl-u': v => v.undo(false, true),
  'Alt-u': v => v.undo(true, true),
  'Ctrl-Shift-[': foldHere,
  'Ctrl-Shift-]': unfoldHere,
  'Ctrl-Alt-[': foldAll,
  'Ctrl-Alt-]': v => (v.folds.set([]), true),
  'Alt-z': v => v.toggleWrap(),
  'Ctrl-Space': v => v.complete.open(true),
}

const CODES = { BracketLeft: '[', BracketRight: ']', Backslash: '\\', Slash: '/', Period: '.', Comma: ',', Semicolon: ';',
  Quote: '\'', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space' }
/** A key event as a name like 'Ctrl-Shift-k' or 'Alt-ArrowUp'. Shortcuts name the key by its place on the keyboard,
 * so they hold on any layout; a key AltGr types with is no shortcut. */
export function keyName(e) {
  let k = e.key
  if (k === ' ') k = 'Space'
  else if (k.length === 1 || k === 'Dead' || k === 'Unidentified') {
    if (e.getModifierState?.('AltGraph')) return null
    if (!e.ctrlKey && !e.altKey) return null
    k = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.code.startsWith('Digit') ? e.code.slice(5) : CODES[e.code] ?? k.toLowerCase()
  }
  return (e.ctrlKey ? 'Ctrl-' : '') + (e.altKey ? 'Alt-' : '') + (e.shiftKey ? 'Shift-' : '') + k
}
