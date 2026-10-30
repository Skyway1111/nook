// A file tab's editor. It draws only the rows that show, each a flex row of gutter cells and the line, colored by
// highlight.js; selections, cursors and matches are boxes in layers behind and over the text. A hidden textarea at the
// caret takes the keyboard, IME and the clipboard. Commands are edits.js's, find and replace find.js's, and
// completion complete.js's. style.css styles the .cm-* classes.
import { Doc, split, mapPos, column, offsetAt, normal, sel1, from, to } from './doc.js'
import { lexLine, className, plain, textBracket } from './highlight.js'
import { lang } from './langs.js'
import { el } from './ui.js'
import { UNCOMMITTED, runs, ages, since } from './blame.js'
import { lineChanges } from './linediff.js'
import { KEYS, keyName, type, foldRange, foldable, bracketAt, wordAt, groupAt } from './edits.js'
import { startFind } from './find.js'
import { startComplete } from './complete.js'

const PLAIN = { name: 'Plain text', lex: '' }
// Characters drawn as a placeholder: control characters, invisible spaces and marks, and bidi controls.
const SPECIAL = /[\u{0}-\u{8}\u{b}-\u{1f}\u{7f}-\u{9f}\u{ad}\u{61c}\u{200b}\u{200e}\u{200f}\u{2028}\u{2029}\u{202d}\u{202e}\u{2066}\u{2067}\u{2069}\u{feff}\u{fff9}-\u{fffc}]/gu
const SIMPLE = /^[\t\x20-\x7e]*$/ // a line whose caret positions are columns times the character width
const LONG = 1024 // past this many characters an unwrapped line draws only around the viewport
const MAX_W = 3e7 // the widest the text gets, in device pixels: browsers lay out no farther than 2^25
const HUGE = 10_000 // past this many characters a wrapped line draws only the rows around the viewport...
const ROWS = 16 // ...in blocks of this many rows
const INDENT = /^(\t)|^( {2,})(?=\S)/
const BARS = [null, ['add', 'Added since git\'s copy'], ['change', 'Changed since git\'s copy'],
  ['delete', 'Lines taken out above'], ['delete below', 'Lines taken out below']]
const JOINS = new Set(['type', 'delete', 'compose']) // what an undo step joins while typing goes on
const idle = globalThis.requestIdleCallback ?? (f => setTimeout(f, 30))

/** Per-line array `arr` after line edits `edits` (see Doc.apply): of an edit's lines the first keeps its entry, and the
 * lines it put after that one get 0. */
function spliced(arr, edits) {
  let n = arr.length, same = true
  for (const e of edits) { n += e.ins - e.del; same &&= e.ins === e.del }
  if (same) return arr
  const room = arr.buffer.byteLength / arr.BYTES_PER_ELEMENT // the arrays keep spare room, so one edit moves in place
  if (edits.length === 1 && n <= room) {
    const { at, del, ins } = edits[0], all = new arr.constructor(arr.buffer)
    all.copyWithin(at + ins, at + del, arr.length)
    all.fill(0, at + 1, at + ins)
    return all.subarray(0, n)
  }
  const out = new arr.constructor(n + (n >> 3) + 64).subarray(0, n)
  let src = 0, dst = 0
  for (const { at, del, ins } of edits) {
    out.set(arr.subarray(src, at + 1), dst)
    dst += at + 1 - src + ins - 1
    src = at + del
  }
  out.set(arr.subarray(src), dst)
  return out
}
/** Line j after line edits `edits`: a line an edit took out goes to its first line, or with `end`, past its last. */
function lineAfter(edits, j, end = false) {
  let d = 0
  for (const e of edits) {
    if (j < e.at + e.del) return j <= e.at ? j + d : e.at + d + (end ? e.ins : 0)
    d += e.ins - e.del
  }
  return j + d
}

/**
 * An editor holding `text`, in the language its file `name` implies. `changed` hears each change to the text and
 * `picked` each change to the selection, both as they happen. With `status`, a line under the text shows the caret,
 * the language, the indent, `status.eol()` (the file's line ending) and whether long lines wrap.
 */
export function createEditor(name, text, { changed, picked, status } = {}) {
  const L = lang(name) ?? PLAIN
  const lexes = !!L.lex || L.lex === undefined
  const md = L.lex === 'markdown'
  const doc = new Doc(text)
  let found // the first indented line's indent
  for (let i = 0; i < doc.count && !found; i++) found = INDENT.exec(doc.lines[i])
  const unit = found?.[1] ?? found?.[2] ?? '    '
  let wrap = !!L.prose
  // The text as saved, and the lines changed since, cleanLo to cleanHi, which are all that can differ from it.
  let clean = doc.lines.slice(), cleanLength = doc.length, cleanLo = Infinity, cleanHi = -1

  // ---- DOM
  const dom = el('div', { className: 'cm-editor' })
  const scroller = el('div', { className: 'cm-scroller' })
  const content = el('div', { className: 'cm-content' })
  const rowsBox = el('div', { className: 'cm-rows' })
  const selLayer = el('div', { className: 'cm-selectionLayer' })
  const curLayer = el('div', { className: 'cm-cursorLayer' })
  const probe = el('div', { className: 'cm-probe' })
  const probeText = el('span', { textContent: 'x'.repeat(32) })
  probe.append(probeText)
  const ta = el('textarea', { className: 'cm-input', spellcheck: false, autocomplete: 'off', tabIndex: 0 })
  ta.setAttribute('autocorrect', 'off')
  ta.setAttribute('autocapitalize', 'off')
  ta.setAttribute('aria-label', name)
  const panels = el('div', { className: 'cm-panels cm-panels-bottom' })
  content.append(selLayer, rowsBox, curLayer, probe)
  scroller.append(content)
  dom.append(scroller, panels, ta)
  dom.classList.toggle('cm-lineWrapping', wrap)

  // ---- Metrics, measured while the editor shows; a hidden one is never measured
  let lh = 21, cw = 8, th = 16, padTop = 16, padBottom = 24, padLeft = 6, padRight = 2, lineLeft = 0, textWidth = 600
  // Text wider or taller than MAX_W device pixels scrolls `scaleX` or `scaleY` times faster than its scrollbar, so
  // all of it can show: every row draws `shiftX` pixels left of its place and `shiftY` above it. Column 0 sits at
  // `x0` and line 0's top at `y0`.
  let scaleX = 1, shiftX = 0, x0 = 0, scaleY = 1, shiftY = 0, y0 = 0
  let metrics = true // measure again before the next draw
  let hsFor = [] // the line height and character width the heights were estimated for
  let leftDirty = true // the gutters changed width
  function measure() {
    const r = probe.getBoundingClientRect(), t = probeText.getBoundingClientRect()
    if (!r.height) return false
    lh = r.height
    cw = t.width / 32
    th = t.height
    const cs = getComputedStyle(content)
    padTop = parseFloat(cs.paddingTop)
    y0 = padTop - shiftY
    padBottom = parseFloat(cs.paddingBottom)
    metrics = false
    leftDirty = true
    return true
  }

  // ---- Lexing: each line's start state, right up to line `valid`. Past it, up to `stale`, the states from before the
  // edits in `pend` ([from, to) line spans, sorted, the first live at `pi`): from a line outside them whose relexed
  // state comes out as before, the old states hold up to the next span.
  let states = new Int32Array(lexes ? doc.count + 1 : 0)
  let tb = new Uint8Array(lexes ? doc.count + 1 : 0) // per lexed line: 1 when a bracket sits in its strings or comments
  let valid = 0, stale = 0, pend = [], pi = 0
  const out = []
  /** Lexes ahead until line `target`'s start state is known, or the clock passes `until`. */
  function lexTo(target, until = Infinity) {
    if (!lexes) return
    const lines = doc.lines
    target = Math.min(target, lines.length)
    while (valid < target) {
      const i = valid
      if (!(i & 63) && performance.now() > until) break
      out.length = 0
      const end = lexLine(L, lines[i], states[i], out, lines[i + 1]), j = i + 1
      tb[i] = textBracket(lines[i], out)
      while (pi < pend.length && pend[pi][1] <= j) pi++
      if (j <= stale && (pi === pend.length || pend[pi][0] >= j) && states[j] === end) {
        valid = pi < pend.length ? Math.max(j, Math.min(stale, pend[pi][0])) : stale
        continue
      }
      states[j] = end
      valid = j
    }
    if (stale < valid) stale = valid
  }
  let lexing = false
  function lexLater() {
    if (lexing || !lexes || valid >= doc.count) return
    lexing = true
    idle(() => {
      lexing = false
      if (destroyed) return
      lexTo(doc.count, performance.now() + 5)
      if (guess.size && valid > first) dirty() // rows drawn from a guess get their real colors
      lexLater()
    })
  }
  // Lines past `valid` that show get a state guessed from the 64 lines before them lexed from scratch: right but
  // for a comment or string longer than that, and redrawn once the lexer gets there.
  const guess = new Map()
  function guessFrom(i) {
    let j = Math.max(valid, i - 64), st = j === valid ? states[valid] : 0
    for (; j < i; j++) {
      out.length = 0
      st = lexLine(L, doc.lines[j], st, out, doc.lines[j + 1])
    }
    return st
  }
  /** Line i's tokens: a drawn row's, or lexed from its known or guessed start state. A line past the lexer that isn't
   * drawn has none, so brackets on it count as code, unless `sure` has the lexer catch up first. */
  function tokensOf(i, sure) {
    if (!lexes) return []
    if (sure && i > valid) lexTo(i)
    const st = i <= valid ? states[i] : guess.get(i)
    if (st === undefined) return []
    const row = rows.get(i)
    if (row && row.text === doc.lines[i] && row.state === st) return row.tokens
    out.length = 0
    lexLine(L, doc.lines[i], st, out, doc.lines[i + 1])
    return out.slice()
  }

  // ---- Folds: [start, end] line pairs, sorted; lines start + 1 to end don't show.
  let folds = []
  const foldIn = i => { // the fold hiding line i
    let lo = 0, hi = folds.length - 1
    while (lo <= hi) {
      const m = (lo + hi) >> 1, [s, e] = folds[m]
      if (i <= s) hi = m - 1
      else if (i > e) lo = m + 1
      else return folds[m]
    }
    return null
  }
  const foldAt = i => folds.find(f => f[0] === i)
  /** Folds `next` in place of the folds there are. Only the lines whose folding changed change height. */
  function setFolds(next) {
    const old = folds
    folds = next.sort((a, b) => a[0] - b[0])
    if (!hs || (!wrap && !folds.length)) heights()
    else {
      for (const [s, e] of old) for (let i = s + 1; i <= e; i++) setH(i, wrap ? estimate(i) : lh)
      for (const [s, e] of folds) for (let i = s + 1; i <= e; i++) setH(i, 0)
    }
    dirty()
  }

  // ---- Heights: none while every line is one row tall; else each line's in `hs`, and `total`. `bp[b]` sums the
  // lines before block b (of 1 << B lines), right up to block `bpKnown`; `cp` holds the running sums inside block `cb`.
  const B = 10, BM = (1 << B) - 1
  let hs = null, bp = null, bpKnown = 0, total = 0, cb = -1
  const cp = new Float64Array(BM + 2)
  const estimate = i => {
    const n = doc.lines[i].length
    return n * cw <= textWidth ? lh : lh * Math.ceil((n * cw) / textWidth)
  }
  /** Every line's height from scratch: estimated, or 0 in a fold. */
  function heights() {
    if (!wrap && !folds.length) { hs = null; return }
    const n = doc.count
    hs = new Float32Array(n)
    if (wrap) for (let i = 0; i < n; i++) hs[i] = estimate(i)
    else hs.fill(lh)
    for (const [s, e] of folds) hs.fill(0, s + 1, e + 1)
    sums()
  }
  function sums() {
    total = 0
    for (let i = 0; i < hs.length; i++) total += hs[i]
    bp = new Float64Array((hs.length >> B) + 2)
    bpKnown = 0
    cb = -1
  }
  function setH(i, h) {
    const old = hs[i]
    hs[i] = h
    if (hs[i] === old) return
    total += hs[i] - old
    if (bpKnown > i >> B) bpKnown = i >> B
    if (cb === i >> B) cb = -1
  }
  /** Sums the blocks before block b. */
  function extend(b) {
    for (let k = bpKnown; k < b; k++) {
      let s = 0
      for (let j = k << B, e = Math.min(hs.length, j + BM + 1); j < e; j++) s += hs[j]
      bp[k + 1] = bp[k] + s
    }
    bpKnown = b
  }
  function block(b) {
    cb = b
    for (let j = b << B, k = 0, e = Math.min(hs.length, j + BM + 1); j < e; j++, k++) cp[k + 1] = cp[k] + hs[j]
  }
  const top = i => {
    if (!hs) return i * lh
    if (i >= hs.length) return total
    const b = i >> B
    if (b > bpKnown) extend(b)
    if (cb !== b) block(b)
    return bp[b] + cp[i & BM]
  }
  /** The showing line at `y`, counted from the first line's top. */
  function lineAtY(y) {
    const n = doc.count
    if (!hs) return Math.max(0, Math.min(n - 1, Math.floor(y / lh)))
    let i = n - 1
    if (y < total) {
      const last = (n - 1) >> B
      while (bpKnown < last && bp[bpKnown] <= y) extend(bpKnown + 1)
      let lo = 0, hi = bpKnown
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1
        if (bp[m] <= y) lo = m
        else hi = m - 1
      }
      if (cb !== lo) block(lo)
      const r = y - bp[lo]
      let a = 0, z = Math.min(BM, n - 1 - (lo << B))
      while (a < z) {
        const m = (a + z + 1) >> 1
        if (cp[m] <= r) a = m
        else z = m - 1
      }
      i = (lo << B) + a
    }
    while (i > 0 && !hs[i]) i--
    return i
  }

  // ---- Marks beside the lines: change bars and blame, which follow edits until set again.
  let bars = null // per line: an index into BARS
  let blame = null // per line: an index into blameRuns, plus 1
  let blameRuns = [], blamePick = null
  let layout = 0 // bumped when the set of gutters changes, so rows rebuild their cells

  // ---- Selection and history
  let ranges = [sel1(0)], main = 0
  const hist = { done: [], undone: [], time: 0, kind: '', sealed: false }
  const snapshot = () => ({ ranges, main })
  let closed = [] // offsets of closers closeBrackets typed, which typing over skips

  /** Applies a change: `changes` (a change list), then `sel` ({ ranges, main }), as user action `kind`. */
  function dispatch({ changes, sel, kind = 'other', scroll = true, history = true, assoc = -1, clean: c, done = false }) {
    const before = snapshot()
    const had = ranges
    let docChanged = done
    if (changes?.length) {
      const { inverse, edits } = doc.apply(changes)
      if (edits.length) follow(edits)
      docChanged = true
      closed = closed.map(p => mapPos(p, changes, 1))
      if (history) record(inverse, changes, kind, before)
      if (!sel) sel = { ranges: ranges.map(r => sel1(mapPos(r.anchor, changes, assoc), mapPos(r.head, changes, assoc))), main }
      complete.changed(changes, kind)
    }
    if (sel) {
      const n = normal(sel.ranges.map(r => clamp(r)), sel.main)
      ranges = n.ranges
      main = n.main
      if (closed.length) { // closers typed over are those on the main caret's line
        const i = doc.lineOf(ranges[main].head)
        closed = closed.filter(p => doc.lineOf(p) === i)
      }
      for (const r of ranges) {
        const f = foldIn(doc.lineOf(r.head))
        if (f) setFolds(folds.filter(g => g !== f))
      }
    }
    const moved = ranges !== had && !same(had, ranges)
    if (moved && !docChanged && history && kind !== 'undo') recordSel(before, kind)
    if (scroll && (docChanged || moved)) want = { pos: ranges[main].head }
    if (c) markClean()
    dirty()
    if (docChanged) changed?.()
    if (moved) {
      if (!docChanged) complete.moved()
      picked?.()
    }
  }
  const clamp = r => sel1(Math.max(0, Math.min(r.anchor, doc.length)), Math.max(0, Math.min(r.head, doc.length)), r.goal, r.assoc)
  const same = (a, b) => a.length === b.length && a.every((r, i) => r.anchor === b[i].anchor && r.head === b[i].head)

  /** Moves every per-line cache along with line edits `edits` (see Doc.apply). */
  function follow(edits) {
    const at2 = [] // each edit's first line after the edits
    let d = 0
    for (const e of edits) { at2.push(e.at + d); d += e.ins - e.del }
    const lastLine = at2.at(-1) + edits.at(-1).ins - 1
    if (lexes) {
      states = spliced(states, edits)
      tb = spliced(tb, edits)
      // the spans still to relex, moved along (one walk: they and the edits are sorted), and these edits', merged
      let k = 0, dd = 0
      const map = (j, end) => {
        while (k < edits.length && edits[k].at + edits[k].del <= j) dd += edits[k].ins - edits[k++].del
        const e = edits[k]
        return !e || j <= e.at ? j + dd : e.at + dd + (end ? e.ins : 0)
      }
      const moved = [], spans = []
      for (let n = pi; n < pend.length; n++) moved.push([map(pend[n][0]), map(pend[n][1], true)])
      const adds = edits.map((e, m) => [md ? Math.max(0, at2[m] - 1) : at2[m], at2[m] + e.ins])
      for (let a = 0, b = 0; a < moved.length || b < adds.length;) {
        const sp = b === adds.length || (a < moved.length && moved[a][0] <= adds[b][0]) ? moved[a++] : adds[b++]
        const p = spans.at(-1)
        if (p && sp[0] <= p[1]) p[1] = Math.max(p[1], sp[1])
        else spans.push(sp)
      }
      stale = lineAfter(edits, Math.max(valid, stale))
      pend = spans.filter(sp => sp[0] < stale)
      pi = 0
      valid = Math.min(valid, md ? Math.max(0, at2[0] - 1) : at2[0])
    }
    if (bars) bars = spliced(bars, edits)
    if (blame) blame = spliced(blame, edits)
    let dropped = null // folds the edits went into, as line spans after them
    if (folds.length) {
      const kept = []
      let k = 0, dd = 0
      for (const f of folds) {
        while (k < edits.length && edits[k].at + edits[k].del - 1 < f[0]) dd += edits[k].ins - edits[k++].del
        let ok = true
        for (let m = k; ok && m < edits.length && edits[m].at <= f[1]; m++) ok = edits[m].at === f[0] && edits[m].del === 1 && edits[m].ins === 1
        if (ok) kept.push([f[0] + dd, f[1] + dd])
        else (dropped ??= []).push([lineAfter(edits, f[0]), lineAfter(edits, f[1] + 1, true)])
      }
      folds = kept
    }
    if (hs) {
      for (const e of edits) for (let j = e.at; j < e.at + e.del; j++) total -= hs[j]
      hs = spliced(hs, edits)
      edits.forEach((e, n) => {
        for (let j = at2[n]; j < at2[n] + e.ins; j++) { hs[j] = foldIn(j) ? 0 : wrap ? estimate(j) : lh; total += hs[j] }
      })
      if (bp.length < (hs.length >> B) + 2) { const more = new Float64Array((hs.length >> B) * 2 + 2); more.set(bp); bp = more }
      bpKnown = Math.min(bpKnown, at2[0] >> B)
      bmKnown = Math.min(bmKnown, at2[0] >> B)
      cb = -1
      for (const [s, t] of dropped ?? []) for (let j = s; j < t; j++) if (!hs[j] && !foldIn(j)) setH(j, wrap ? estimate(j) : lh)
    }
    if (d || edits.some(e => e.ins > 1)) {
      const moved = new Map()
      let k = 0, dd = 0
      for (const [i, r] of [...rows].sort((x, y) => x[0] - y[0])) {
        while (k < edits.length && edits[k].at + edits[k].del <= i) dd += edits[k].ins - edits[k++].del
        if (k < edits.length && i > edits[k].at) drop(r)
        else moved.set(i + dd, r)
      }
      rows = moved
    }
    edits.forEach((e, n) => { for (let j = at2[n]; j < at2[n] + e.ins; j++) if (doc.lines[j].length > longest) longest = doc.lines[j].length })
    if (cleanHi >= 0) { cleanLo = lineAfter(edits, cleanLo); cleanHi = lineAfter(edits, cleanHi + 1, true) - 1 }
    cleanLo = Math.min(cleanLo, at2[0])
    cleanHi = Math.max(cleanHi, lastLine)
  }

  /** Records a change for undo. Typing joins the step before when it touches what that step's last change put in
   * (`touched`, its inverse: sorted, as `changes` are, so one walk compares them). */
  function record(inverse, changes, kind, before) {
    const now = Date.now()
    const last = hist.done.at(-1)
    const touches = () => {
      const t = last.touched
      for (let j = 0, k = 0; j < changes.length; j++) {
        while (k < t.length && t[k].to < changes[j].from) k++
        if (k < t.length && t[k].from <= changes[j].to) return true
      }
      return false
    }
    if (last?.inv && !last.sels.length && !hist.sealed && JOINS.has(kind) &&
        ((kind === 'compose' && hist.kind === 'compose') || (now - hist.time < 500 && touches()))) {
      last.inv.push(inverse)
      last.touched = inverse
    } else {
      hist.done.push({ inv: [inverse], sel: before, sels: [], touched: inverse })
      if (hist.done.length > 200) hist.done.shift()
    }
    hist.undone = []
    hist.time = now
    hist.kind = kind
    hist.sealed = false
  }
  function recordSel(before, kind) {
    const now = Date.now()
    let last = hist.done.at(-1)
    if (last?.sels.length && kind === hist.kind && now - hist.time < 500 &&
        before.ranges.length === ranges.length && before.ranges.every((r, i) => (r.anchor === r.head) === (ranges[i].anchor === ranges[i].head))) return
    if (!last) hist.done.push((last = { inv: null, sel: null, sels: [], touched: [] }))
    last.sels.push(before)
    if (last.sels.length > 200) last.sels.shift()
    hist.time = now
    hist.kind = kind
  }
  /** Undoes the last change, or with `onlySel` the last move of the selection; `redo` the other way. */
  function undo(redo = false, onlySel = false) {
    const take = redo ? hist.undone : hist.done, onto = redo ? hist.done : hist.undone
    const ev = take.at(-1)
    if (!ev) return false
    if (onlySel && ev.sels.length) {
      const s = ev.sels.pop()
      const top = onto.at(-1) ?? onto[onto.push({ inv: null, sel: null, sels: [], touched: [] }) - 1]
      top.sels.push(snapshot())
      dispatch({ sel: s, kind: 'undo', history: false })
      return true
    }
    if (!ev.inv) return false
    take.pop()
    const now = snapshot()
    const back = []
    for (let k = ev.inv.length - 1; k >= 0; k--) {
      const { inverse, edits } = doc.apply(ev.inv[k])
      if (edits.length) follow(edits)
      closed = []
      back.push(inverse)
      complete.close()
    }
    onto.push({ inv: back, sel: now, sels: [], touched: [] })
    hist.sealed = true
    dispatch({ sel: ev.sel ?? mapped(now, ev.inv), kind: 'undo', history: false, done: true })
    return true
  }
  const mapped = (s, invs) => ({ ranges: s.ranges.map(r => sel1(invs.reduce((p, c) => mapPos(p, c), r.anchor), invs.reduce((p, c) => mapPos(p, c), r.head))), main: s.main })

  // ---- Rows: one per showing line in and near the viewport, reused while their line stays the same.
  let rows = new Map() // line → row
  const pool = []
  let first = 0, last = -1 // the lines drawn
  let want = null // { pos, center } to scroll into view at the next draw
  let queued = false, destroyed = false, hidden = true
  const dirty = () => { if (!queued) { queued = true; queueMicrotask(draw) } }

  function drop(r) {
    r.el.remove()
    pool.push(r)
  }
  function makeRow() {
    const r = pool.pop() ?? { el: el('div', { className: 'cm-row' }), line: null, cells: null }
    r.text = r.state = r.next = undefined
    r.layout = -1
    return r
  }
  function buildCells(r) {
    const cells = {}
    const parts = []
    if (blame) parts.push((cells.blame = el('div', { className: 'cm-gutterElement cm-blame' })))
    parts.push((cells.num = el('div', { className: 'cm-gutterElement cm-lineNumbers' })))
    if (bars) parts.push((cells.bar = el('div', { className: 'cm-gutterElement cm-changes' })))
    parts.push((cells.fold = el('div', { className: 'cm-gutterElement cm-foldGutter' })))
    r.line ??= el('div', { className: 'cm-line' })
    r.el.replaceChildren(...parts, r.line)
    r.cells = cells
    r.layout = layout
    r.num = r.bar = r.blame = r.fold = r.active = undefined
  }

  /** Writes line i's text and colors into row r, unless they're as drawn. */
  function paintLine(r, i) {
    const text = doc.lines[i]
    const st = !lexes ? 0 : i <= valid ? states[i] : guess.get(i) ?? 0
    const next = md ? doc.lines[i + 1] : undefined
    const shut = !!foldAt(i)
    // A long unwrapped line shows only the stretch around the viewport, in blocks of LONG characters, indented to its
    // place. A huge wrapped one breaks anywhere, so each row holds `per` characters, and shows only the rows around
    // the viewport.
    let s = 0, e = text.length, per = 0
    if (!wrap && e > LONG) {
      const c0 = Math.max(0, (scroller.scrollLeft + shiftX - lineLeft) / cw)
      s = Math.max(0, Math.floor(offsetAt(text, c0) / LONG) * LONG - LONG)
      e = Math.min(text.length, s + 3 * LONG + Math.ceil(scroller.clientWidth / cw))
    } else if (wrap && e > HUGE) {
      per = perRow()
      const block = ROWS * per, at = Math.max(0, scroller.scrollTop - y0 - top(i)) / lh * per
      s = Math.max(0, Math.floor(at / block) * block - block)
      e = Math.min(text.length, s + 3 * block + Math.ceil(scroller.clientHeight / lh) * per)
    }
    const indent = wrap ? 0 : column(text, s) * cw - shiftX
    if (r.indent !== indent) r.line.style.textIndent = (r.indent = indent) ? `${indent}px` : ''
    if (r.text === text && r.state === st && r.next === next && r.shut === shut && r.offset === s && r.end === e &&
      r.per === per) return
    let tokens = r.tokens
    if (!(r.text === text && r.state === st && r.next === next)) {
      out.length = 0
      if (lexes) lexLine(L, text, st, out, next)
      tokens = out.slice()
    }
    if (r.text !== text) r.simple = SIMPLE.test(text)
    Object.assign(r, { text, state: st, next, shut, tokens, offset: s, end: e, per, below: null })
    const line = r.line
    line.classList.toggle('cm-huge', !!per)
    r.nodes = []
    r.at = []
    if (!text && !shut) return line.replaceChildren(el('br'))
    const frag = document.createDocumentFragment()
    if (per && s) {
      const gap = frag.appendChild(el('div', { className: 'cm-gap' }))
      gap.style.height = `${(s / per) * lh}px`
    }
    let k = s
    for (let t = 0; t < tokens.length; t += 3) {
      const a = Math.max(tokens[t], s), b = Math.min(tokens[t + 1], e)
      if (b <= a) continue
      if (a > k) piece(frag, text.slice(k, a), '')
      piece(frag, text.slice(a, b), className(tokens[t + 2]))
      k = b
    }
    if (k < e) piece(frag, text.slice(k, e), '')
    if (per && e < text.length) {
      r.below = frag.appendChild(el('div', { className: 'cm-gap' }))
      r.below.style.height = `${Math.ceil((text.length - e) / per) * lh}px`
    }
    // the text nodes and where each starts, for domAt
    for (let n = frag.firstChild, at = 0; n; n = n.nextSibling) {
      const t = n.nodeType === 3 ? n : n.firstChild
      if (t?.nodeType !== 3 || n.className === 'cm-gap') continue
      r.nodes.push(t)
      r.at.push(at)
      at += t.data.length
    }
    if (shut) frag.append(el('span', { className: 'cm-foldPlaceholder', textContent: '\u{2026}', title: 'Unfold' }))
    line.replaceChildren(frag)
  }
  function piece(frag, s, cls) {
    SPECIAL.lastIndex = 0
    let m, k = 0
    while ((m = SPECIAL.exec(s))) {
      if (m.index > k) span(frag, s.slice(k, m.index), cls)
      const code = s.charCodeAt(m.index)
      frag.append(el('span', { className: 'cm-specialChar', textContent: code < 32 ? String.fromCharCode(0x2400 + code) : '\u{2022}',
        title: `\\u${code.toString(16).padStart(4, '0')}` }))
      k = m.index + 1
    }
    if (k < s.length) span(frag, k ? s.slice(k) : s, cls)
  }
  function span(frag, s, cls) {
    if (!cls) return frag.append(s)
    const n = document.createElement('span')
    n.className = cls
    n.textContent = s
    frag.append(n)
  }

  function paintGutter(r, i, active) {
    if (r.layout !== layout) buildCells(r)
    const c = r.cells
    if (r.num !== i) c.num.textContent = (r.num = i) + 1
    if (r.active !== active) {
      r.active = active
      c.num.classList.toggle('cm-activeLineGutter', active)
      r.line.classList.toggle('cm-activeLine', active)
    }
    const next = doc.lines[i + 1]
    if (r.fText !== r.text || r.fNext !== next) {
      r.fText = r.text
      r.fNext = next
      r.canFold = foldable(view, i, r.tokens)
    }
    const f = foldAt(i) ? 2 : r.canFold ? 1 : 0
    if (r.fold !== f) {
      r.fold = f
      c.fold.replaceChildren(...(f ? [el('i', { className: `icon fold${f === 2 ? ' shut' : ''}`,
        textContent: f === 2 ? '\u{E76C}' : '\u{E70D}', title: f === 2 ? 'Unfold' : 'Fold' })] : []))
    }
    if (bars && r.bar !== bars[i]) {
      r.bar = bars[i]
      const b = BARS[r.bar]
      c.bar.replaceChildren(...(b ? [el('div', { className: `gitbar ${b[0]}`, title: b[1] })] : []))
    }
    if (blame) {
      const id = blame[i], firstOfRun = id && (i === 0 || blame[i - 1] !== id)
      const key = id * 2 + (firstOfRun ? 1 : 0)
      if (r.blame !== key) {
        r.blame = key
        const run = blameRuns[id - 1]
        const d = run ? el('div', { className: firstOfRun ? 'blame first' : 'blame', textContent: firstOfRun ? run.label : '', title: run.title }) : ''
        if (d) d.style.setProperty('--age', run.age)
        c.blame.replaceChildren(d)
      }
    }
  }

  function draw() {
    queued = false
    box = null // the content may have scrolled since it was read
    if (destroyed) return
    if (!scroller.clientHeight || !dom.isConnected) { hidden = true; return }
    if (hidden || metrics) {
      hidden = false
      if (!measure()) return
      if (lh !== hsFor[0] || cw !== hsFor[1]) { hsFor = [lh, cw]; heights() }
    }
    const digits = String(doc.count).length
    if (digits !== shownDigits) {
      dom.style.setProperty('--digits', (shownDigits = digits))
      leftDirty = true
    }
    let rewrapped = false
    for (let pass = 0; pass < 3; pass++) {
      if (want) {
        const { pos, center } = want
        want = null
        reveal(pos, center)
      }
      shiftX = wrap ? 0 : scroller.scrollLeft * (scaleX - 1)
      x0 = lineLeft - shiftX
      shiftY = scroller.scrollTop * (scaleY - 1)
      y0 = padTop - shiftY
      const st = scroller.scrollTop, h = scroller.clientHeight
      const margin = Math.max(h / 2, 200)
      const a = lineAtY(st - y0 - margin), b = lineAtY(st - y0 + h + margin)
      if (b - valid < 2000) lexTo(b + 1, performance.now() + 4) // farther off, the idle lexer catches up
      guess.clear()
      if (lexes && valid < b) {
        let st = guessFrom(Math.max(a, valid))
        for (let i = Math.max(a, valid); i <= b; i++) {
          guess.set(i, st)
          out.length = 0
          st = lexLine(L, doc.lines[i], st, out, doc.lines[i + 1])
        }
      }
      const actives = new Set(ranges.map(r => doc.lineOf(r.head)))
      const next = new Map()
      const order = []
      for (let i = a; i <= b; i++) {
        const f = foldIn(i)
        if (f) { i = f[1]; continue }
        let r = rows.get(i)
        if (r) rows.delete(i)
        else r = makeRow()
        if (r.layout !== layout) buildCells(r)
        paintLine(r, i)
        paintGutter(r, i, actives.has(i))
        next.set(i, r)
        order.push(r)
      }
      for (const r of rows.values()) drop(r)
      rows = next
      let node = rowsBox.firstChild
      for (const r of order) {
        if (r.el !== node) rowsBox.insertBefore(r.el, node)
        else node = node.nextSibling
      }
      first = a
      last = b
      size(a, h)
      if (leftDirty && order.length) {
        leftDirty = false
        const ln = order[0].line
        lineLeft = ln.offsetLeft + padLeft
        x0 = lineLeft - shiftX
        const w = content.clientWidth - lineLeft - padRight
        if (wrap && Math.abs(w - textWidth) > 1 && !rewrapped) {
          rewrapped = true
          rewrap(w)
          pass--
          continue
        }
        textWidth = w
      }
      if (!wrap) {
        const full = Math.ceil(lineLeft + longest * cw + padRight + 1), vw = scroller.clientWidth
        const most = Math.floor(MAX_W / devicePixelRatio)
        const w = `max(100%, ${Math.min(full, most)}px)`
        if (w !== minWidth) content.style.minWidth = minWidth = w
        const k = full > most ? (full - vw) / (most - vw) : 1
        if (k !== scaleX) { scaleX = k; dirty() }
      } else if (minWidth) content.style.minWidth = minWidth = ''
      // Wrapped lines, and lines of other scripts, are as tall as they lay out.
      let moved = 0
      const anchor = lineAtY(st - y0), anchorTop = top(anchor)
      for (const [i, r] of rows) {
        if (!wrap && r.simple) continue
        const ht = r.el.getBoundingClientRect().height
        if (Math.abs(ht - (hs ? hs[i] : lh)) > 0.5) {
          if (!hs) { hs = new Float32Array(doc.count).fill(lh); sums() }
          setH(i, ht)
          moved++
        }
      }
      if (!moved) break
      size(a, h)
      const drift = top(anchor) - anchorTop
      if (drift) scroller.scrollTop = st + drift / scaleY
    }
    layers()
    paintStatus()
    lexLater()
  }
  /** Places the rows from line a down, and makes the content as tall as the text, or MAX_W device pixels; `vh` is
   * the viewport's height. */
  function size(a, vh) {
    const full = padTop + top(doc.count) + padBottom, most = Math.floor(MAX_W / devicePixelRatio)
    rowsBox.style.marginTop = `${top(a) - shiftY}px`
    content.style.height = `${Math.min(full, most)}px`
    const k = full > most ? (full - vh) / (most - vh) : 1
    if (k !== scaleY) { scaleY = k; dirty() }
  }
  /** Wraps at width `w`: a line too short to wrap at either width keeps its height, the rest are estimated again.
   * A block whose longest line (`bm`, right before block `bmKnown`) is that short is passed over whole. */
  function rewrap(w) {
    const one = Math.min(w, textWidth) / cw, lines = doc.lines, nb = ((lines.length - 1) >> B) + 1
    textWidth = w
    if (!hs) return
    if (!(bm?.length >= nb)) { bm = new Uint32Array(nb + (nb >> 3) + 8); bmKnown = 0 }
    for (let b = 0; b < nb; b++) {
      const e = Math.min(lines.length, (b + 1) << B)
      if (b >= bmKnown) {
        let m = 0
        for (let i = b << B; i < e; i++) if (lines[i].length > m) m = lines[i].length
        bm[b] = m
      }
      if (bm[b] > one) for (let i = b << B; i < e; i++) if (lines[i].length > one && hs[i]) setH(i, estimate(i))
    }
    bmKnown = nb
  }
  let bm = null, bmKnown = 0
  // The longest line's length, for the width long lines scroll to. It only grows while editing.
  let longest = doc.lines.reduce((n, l) => Math.max(n, l.length), 0)
  let minWidth = '', shownDigits = 0

  /** Scrolls so offset `pos` shows, in the middle with `center`. */
  function reveal(pos, center) {
    const i = doc.lineOf(pos)
    const h = scroller.clientHeight
    let y = padTop + top(i), y2 = y + (hs ? hs[i] || lh : lh)
    if (y2 - y > h) { y = coords(pos).y + shiftY; y2 = y + lh } // a line taller than the view shows the caret's row
    let st = scroller.scrollTop * scaleY
    if (center) st = (y + y2) / 2 - h / 2
    else if (y < st + 4) st = y - 4 - (i === 0 ? padTop : 0)
    else if (y2 > st + h - 4) st = y2 - h + 4 + (i === doc.count - 1 ? padBottom : 0)
    if (st !== scroller.scrollTop * scaleY) scroller.scrollTop = Math.max(0, st) / scaleY
    if (!wrap) {
      const x = lineLeft + column(doc.lines[i], pos - doc.start(i)) * cw, at = scroller.scrollLeft * scaleX
      const w = scroller.clientWidth
      if (x < at + lineLeft) scroller.scrollLeft = Math.max(0, x - lineLeft - 20) / scaleX
      else if (x > at + w - 20) scroller.scrollLeft = (x - w + 40) / scaleX
    }
  }

  // ---- Coordinates, in the content box's pixels
  let box = null // content's client rect, read once per draw
  const contentBox = () => (box ??= content.getBoundingClientRect())
  /** Line i's text node and offset holding character ch, in row r. */
  function domAt(r, ch) {
    ch -= r.offset
    const at = r.at
    if (ch < 0 || ch > r.end - r.offset || !at.length) return null
    let lo = 0, hi = at.length - 1 // the last node starting before ch, or the first
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1
      if (at[m] < ch) lo = m
      else hi = m - 1
    }
    const t = r.nodes[lo]
    return ch - at[lo] <= t.data.length ? [t, ch - at[lo]] : null
  }
  function charOf(r, node, offset) {
    let k = r.offset
    for (let n = r.line.firstChild; n; n = n.nextSibling) {
      if (n.className === 'cm-foldPlaceholder') return r.text.length
      if (n.className === 'cm-gap') continue
      if (n === node || n.contains(node)) return k + (n.nodeType === 3 || node.nodeType === 3 ? offset : 0)
      k += n.textContent.length
    }
    return r.end
  }
  const range = document.createRange()
  /** The client rects of characters a to b in row r. */
  function domRects(r, a, b) {
    const s = domAt(r, a), e = domAt(r, b)
    if (!s || !e) return []
    range.setStart(s[0], s[1])
    range.setEnd(e[0], e[1])
    return range.getClientRects()
  }
  /** Where offset pos is: { x, y, h }, its row's left, top and height. Where a wrapped line breaks, `side` < 0 puts
   * it at the end of the row above, else at the start of the row below. */
  function coords(pos, side = 0) {
    const i = doc.lineOf(pos), ch = pos - doc.start(i), text = doc.lines[i]
    const y = y0 + top(i)
    const r = rows.get(i)
    // A huge wrapped line's rows that aren't drawn hold `per` characters each.
    if (wrap && text.length > HUGE && (!r || ch < r.offset || ch > r.end || (r.below && ch === r.end))) {
      const per = perRow(), below = r?.below && ch >= r.end, k = below ? ch - r.end : ch
      const y0 = below ? r.below.getBoundingClientRect().top - contentBox().top : y
      const back = side < 0 && k > 0 && k % per === 0 ? 1 : 0
      return { x: lineLeft + (k % per + back * per) * cw, y: y0 + (Math.floor(k / per) - back) * lh, h: lh, i }
    }
    if (!r || (!wrap && r.simple)) return { x: x0 + column(text, ch) * cw, y, h: lh, i }
    const c = contentBox()
    if (!text.length) {
      const lr = r.line.getBoundingClientRect()
      return { x: lr.left - c.left + padLeft, y: lr.top - c.top, h: lh, i }
    }
    const end = ch >= text.length || (wrap && side < 0 && ch > 0)
    const a = end ? ch - 1 - (ch > 1 && isLow(text, ch - 1) ? 1 : 0) : ch
    const b = end ? ch : ch + (isHigh(text, ch) ? 2 : 1)
    const rs = domRects(r, a, b)
    const q = end ? rs[rs.length - 1] : rs[0]
    if (!q) return { x: x0 + column(text, ch) * cw, y, h: lh, i }
    return { x: (end ? q.right : q.left) - c.left, y: q.top - c.top + (q.height - lh) / 2, h: lh, i }
  }
  /** The offset nearest the content point (x, y). */
  function posAt(x, y) {
    const i = lineAtY(y - y0)
    const text = doc.lines[i], start = doc.start(i)
    const r = rows.get(i)
    if (!wrap && (!r || r.simple)) return start + offsetAt(text, (x - x0) / cw)
    if (!r) {
      const up = Math.max(0, Math.floor((y - y0 - top(i)) / lh))
      return start + Math.min(text.length, offsetAt(text, up * perRow() + (x - lineLeft) / cw))
    }
    const c = contentBox()
    const lr = r.line.getBoundingClientRect()
    if (r.per) {
      const cy = c.top + y, col = Math.max(0, Math.min(r.per, Math.round((x - lineLeft) / cw)))
      const below = r.below?.getBoundingClientRect().top ?? Infinity
      const row = Math.floor((cy - lr.top) / lh)
      if (cy < lr.top + (r.offset / r.per) * lh) return start + Math.min(text.length, Math.max(0, row) * r.per + col)
      if (cy >= below) return start + Math.min(text.length, r.end + Math.floor((cy - below) / lh) * r.per + col)
    }
    const cx = Math.max(lr.left + padLeft, Math.min(c.left + x, lr.right - padRight - 1))
    const cy = Math.max(lr.top + 1, Math.min(c.top + y, lr.bottom - 1))
    // The browser finds only what shows: a point scrolled out of view is measured instead.
    const sb = scroller.getBoundingClientRect(), seen = cy >= sb.top && cy < sb.bottom && cx >= sb.left && cx < sb.right
    const hit = seen && (document.caretPositionFromPoint?.(cx, cy) ?? (p => p && { offsetNode: p.startContainer, offset: p.startOffset })(document.caretRangeFromPoint?.(cx, cy)))
    if (hit && r.line.contains(hit.offsetNode)) return start + Math.min(text.length, charOf(r, hit.offsetNode, hit.offset))
    if (wrap) return start + Math.min(text.length, measureAt(r, cx, cy))
    return start + Math.min(text.length, offsetAt(text, (x - x0) / cw))
  }
  /** The offset in drawn row r nearest client point (cx, cy), from its characters' boxes: visual rows run down, and
   * characters across each. */
  function measureAt(r, cx, cy) {
    const box = k => domRects(r, k, k + 1)[0]
    const first = (lo, hi, past) => { while (lo < hi) { const m = (lo + hi) >> 1; if (past(box(m))) hi = m; else lo = m + 1 } return lo }
    const k1 = first(r.offset, r.end, q => !q || q.top > cy) // the first character on a row below the point
    if (k1 === r.offset) return k1
    const top = box(k1 - 1).top
    const k0 = first(r.offset, k1 - 1, q => !q || q.top >= top - 1)
    const k = first(k0, k1, q => !q || (q.left + q.right) / 2 > cx)
    return k < k1 || k1 === r.end ? k : k1 - 1
  }
  const perRow = () => Math.max(1, Math.floor(textWidth / cw))
  const isHigh = (s, k) => (s.charCodeAt(k) & 0xfc00) === 0xd800
  const isLow = (s, k) => (s.charCodeAt(k) & 0xfc00) === 0xdc00

  /** Range r's head moved a row up (dir -1) or down, or by `by` pixels, toward the x `goal`: { head, goal, assoc }. */
  function vertical(r, dir, by = 0) {
    flush()
    const c = coords(r.head, r.assoc)
    const goal = r.goal ?? c.x
    if (!by && !wrap && !folds.length) {
      const i = c.i + dir
      if (i < 0) return { head: 0, goal }
      if (i >= doc.count) return { head: doc.length, goal }
      return { head: doc.start(i) + offsetAt(doc.lines[i], (goal - x0) / cw), goal }
    }
    const y = c.y + dir * (by || lh) + lh / 2
    if (y < y0) return { head: 0, goal }
    if (y >= y0 + top(doc.count)) return { head: doc.length, goal }
    const head = posAt(goal, y)
    return { head, goal, assoc: sideAt(head, y) }
  }
  /** Where a caret at `pos`, put there by a point at content y, draws: -1 when that is a row above the one `pos`
   * starts, as at a wrapped row's end. */
  const sideAt = (pos, y) => (wrap && coords(pos).y > y ? -1 : 0)
  /** The start (or with `forward`, the end) of the row range r's head shows on: { head, assoc }. A head already
   * there goes to its line's start or end. */
  function rowEdge(r, forward) {
    const i = doc.lineOf(r.head), start = doc.start(i), end = start + doc.lines[i].length
    let head = forward ? end : start
    if (wrap && rows.get(i)) {
      flush()
      const y = coords(r.head, r.assoc).y + lh / 2
      const p = posAt(forward ? 1e7 : 0, y)
      if (p !== r.head) head = p
    }
    return { head, assoc: forward ? -1 : 0 }
  }
  function flush() {
    box = null
    if (queued) draw()
  }

  // ---- Layers
  let selKey = '', curKey = ''
  function layers() {
    box = null
    const sels = []
    const cur = []
    // the drawn text, in stretches: whole lines run on, a line drawn in part is its own
    let lo = -1, hi = -1, prev = -2
    const stretch = () => lo >= 0 && find.matches(lo, hi, (a, b, selected) =>
      rects(a, b, selected ? 'cm-searchMatch cm-searchMatch-selected' : 'cm-searchMatch', sels, true))
    for (const [i, r] of rows) {
      const s = doc.start(i), whole = !r.offset && r.end === doc.lines[i].length
      if (!whole || i !== prev + 1) { stretch(); lo = s + r.offset }
      hi = s + r.end
      prev = whole ? i : -2
    }
    stretch()
    selectionMatches(sels)
    brackets(sels)
    for (const r of ranges) if (r.anchor !== r.head) rects(from(r), to(r), 'cm-selectionBackground', sels)
    for (const [k, r] of ranges.entries()) {
      const i = doc.lineOf(r.head)
      if (!rows.has(i)) continue
      const c = coords(r.head, r.assoc)
      cur.push([c.x, c.y + (lh - th) / 2, 0, th, k === main ? 'cm-cursor cm-cursor-primary' : 'cm-cursor'])
    }
    if (drop_ != null && rows.has(doc.lineOf(drop_))) {
      const c = coords(drop_)
      cur.push([c.x, c.y + (lh - th) / 2, 0, th, 'cm-dropCursor'])
    }
    selKey = put(selLayer, sels, selKey)
    const k = put(curLayer, cur, curKey)
    if (k !== curKey) {
      curKey = k
      curLayer.style.animationName = curLayer.style.animationName === 'cm-blink' ? 'cm-blink2' : 'cm-blink'
    }
    placeInput()
  }
  /** Boxes over characters a to b: one per row, those that run past a line's end reaching the right edge. An
   * `inline` box is as tall as the text, as a highlight on the text itself would be; else the whole row. */
  function rects(a, b, cls, list, inline) {
    const dy = inline ? (lh - th) / 2 : 0, h = inline ? th : lh
    const la = Math.max(doc.lineOf(a), first), lb = Math.min(doc.lineOf(b), last)
    for (let i = la; i <= lb; i++) {
      const r = rows.get(i)
      if (!r) continue
      const start = doc.start(i), text = doc.lines[i]
      // A line drawn only in part: the boxes over its drawn stretch, the last reaching the edge if the range goes on.
      const f = Math.max(a, start + r.offset) - start, t = Math.min(b, start + r.end) - start
      const past = b > start + r.end
      if (f > t || (f === t && !past)) continue
      const y = y0 + top(i)
      if (!wrap && r.simple) {
        const x1 = x0 + column(text, f) * cw
        const x2 = past ? 1e6 : x0 + column(text, t) * cw
        if (x2 > x1) list.push([x1, y + dy, x2 - x1, h, cls])
        continue
      }
      const c = contentBox()
      const rs = t > f ? [...domRects(r, f, t)] : []
      const line = r.line.getBoundingClientRect()
      if (!rs.length) {
        if (past) { const p = coords(start + f); list.push([p.x, p.y + dy, 1e6, h, cls]) }
        continue
      }
      // one box per visual row
      const byRow = []
      for (const q of rs) {
        if (!q.width && rs.length > 1) continue
        const last_ = byRow.at(-1)
        if (last_ && Math.abs(last_.top - q.top) < lh / 2) { last_.left = Math.min(last_.left, q.left); last_.right = Math.max(last_.right, q.right) }
        else byRow.push({ top: q.top, left: q.left, right: q.right, h: q.height })
      }
      byRow.forEach((q, n) => {
        const left = n ? line.left + padLeft : q.left
        const right = n < byRow.length - 1 || past ? line.right + 1e6 : q.right
        list.push([left - c.left, q.top - c.top + (q.h - lh) / 2 + dy, right - left, h, cls])
      })
    }
  }
  function put(layer, list, key) {
    const k = list.map(q => q.join()).join(';')
    if (k === key) return key
    while (layer.children.length > list.length) layer.lastChild.remove()
    while (layer.children.length < list.length) layer.append(el('div'))
    list.forEach(([x, y, w, h, cls], n) => {
      const d = layer.children[n]
      if (d.className !== cls) d.className = cls
      d.style.cssText = `left:${x}px;top:${y}px;${w ? `width:${w}px;` : ''}height:${h}px`
    })
    return k
  }
  function selectionMatches(list) {
    if (ranges.length !== 1) return
    const r = ranges[0], f = from(r), t = to(r)
    if (t - f < 1 || t - f > 200) return
    const q = doc.slice(f, t)
    if (q.includes('\n')) return
    const found = []
    for (let i = first; i <= last && i < doc.count; i++) {
      if (!rows.has(i)) continue
      const text = doc.lines[i], start = doc.start(i)
      for (let k = text.indexOf(q); k >= 0; k = text.indexOf(q, k + q.length)) {
        if (start + k >= t || start + k + q.length <= f) found.push(start + k)
        if (found.length > 100) return
      }
    }
    for (const p of found) rects(p, p + q.length, 'cm-selectionMatch', list, true)
  }
  function brackets(list) {
    for (const r of ranges) {
      if (r.anchor !== r.head || !rows.has(doc.lineOf(r.head))) continue
      const m = bracketAt(view, r.head)
      if (!m) continue
      rects(m.at, m.at + 1, m.to == null ? 'cm-nonmatchingBracket' : 'cm-matchingBracket', list, true)
      if (m.to != null) rects(m.to, m.to + 1, 'cm-matchingBracket', list, true)
    }
  }
  function placeInput() {
    if (composing) return
    const r = ranges[main]
    if (!rows.has(doc.lineOf(r.head))) return
    const c = coords(r.head, r.assoc)
    const x = Math.max(0, Math.min(c.x - scroller.scrollLeft, scroller.clientWidth - 2))
    const y = Math.max(0, Math.min(c.y - scroller.scrollTop, scroller.clientHeight - lh))
    ta.style.transform = `translate(${x}px, ${y}px)`
  }

  // ---- Status line
  let statusBar = null
  if (status) {
    const caret = el('span'), ending = el('span')
    const button = el('button', { title: 'Wrap long lines (Alt+Z)', onmousedown: e => e.preventDefault(), onclick: () => toggleWrap() })
    const bar = el('div', { className: 'cm-status' })
    bar.append(caret, el('span', { className: 'fill' }), el('span', { textContent: L.name }),
      el('span', { textContent: unit === '\t' ? 'Tabs' : `Spaces: ${unit.length}` }), ending, button)
    panels.append(bar)
    statusBar = { caret, ending, button }
  }
  const set = (node, s) => node.textContent !== s && (node.textContent = s)
  function paintStatus() {
    if (!statusBar) return
    const r = ranges[main], i = doc.lineOf(r.head)
    const picked = ranges.reduce((n, q) => n + to(q) - from(q), 0)
    set(statusBar.caret, `Ln ${i + 1}, Col ${r.head - doc.start(i) + 1}` + (ranges.length > 1 ? ` · ${ranges.length} cursors` : '') +
      (picked ? ` · ${picked.toLocaleString()} selected` : ''))
    set(statusBar.ending, status.eol() === '\r\n' ? 'CRLF' : 'LF')
    set(statusBar.button, wrap ? 'Wrap' : 'No wrap')
  }
  function toggleWrap() {
    const anchor = lineAtY(scroller.scrollTop - y0)
    wrap = !wrap
    dom.classList.toggle('cm-lineWrapping', wrap)
    if (minWidth) content.style.minWidth = minWidth = ''
    leftDirty = true
    textWidth = content.clientWidth - lineLeft - padRight
    heights()
    draw()
    scroller.scrollTop = (padTop + top(anchor)) / scaleY
    dirty()
    return true
  }

  // ---- Keyboard and text input
  let composing = false, comp = 0 // the composition's length at each cursor
  ta.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return
    const k = keyName(e), b = keyName(e, true)
    if ((k && run(k)) || (b && b !== k && run(b))) e.preventDefault()
  })
  /** Runs the command bound to key name `k`; false when none ran. */
  function run(k) {
    if (complete.key(k)) return true
    if (k === 'Escape' && find.isOpen()) return find.close(), true
    const f = KEYS[k]
    return !!f && f(view) !== false
  }
  ta.addEventListener('beforeinput', e => {
    if (composing || e.isComposing) return
    const t = e.inputType
    if (t === 'insertText' || t === 'insertReplacementText') {
      e.preventDefault()
      if (e.data) type(view, e.data)
    } else if (t === 'insertLineBreak' || t === 'insertParagraph') {
      e.preventDefault()
      KEYS.Enter(view)
    } else if (t.startsWith('delete') || t.startsWith('history') || t.startsWith('format')) e.preventDefault()
  })
  ta.addEventListener('input', () => {
    if (composing) return compose(ta.value)
    if (ta.value) {
      const s = ta.value
      ta.value = ''
      type(view, s)
    }
  })
  ta.addEventListener('compositionstart', () => {
    composing = true
    comp = 0
    complete.close()
  })
  ta.addEventListener('compositionend', e => {
    compose(e.data ?? ta.value)
    composing = false
    ta.value = ''
    dirty()
  })
  /** Puts the composition's text `s` at each cursor in place of what it showed before. */
  function compose(s) {
    let shift = 0
    const changes = [], next = []
    for (const r of ranges) {
      const a = comp || r.anchor === r.head ? r.head - comp : from(r), b = comp || r.anchor === r.head ? r.head : to(r)
      changes.push({ from: a, to: b, insert: s })
      next.push(sel1(a + shift + s.length))
      shift += s.length - (b - a)
    }
    comp = s.length
    dispatch({ changes, sel: { ranges: next, main }, kind: 'compose' })
  }

  // The clipboard: with nothing selected, a copy takes each caret's line, which pastes back as a line above a caret.
  let linewise = null
  function copied(cut) {
    const parts = [], dels = []
    for (const r of ranges) if (r.anchor !== r.head) { parts.push(doc.slice(from(r), to(r))); dels.push({ from: from(r), to: to(r), insert: '' }) }
    linewise = null
    if (!parts.length) {
      for (const r of ranges) {
        const i = doc.lineOf(r.head), a = doc.start(i)
        if (dels.length && doc.lineOf(dels.at(-1).from) === i) continue
        parts.push(doc.lines[i])
        dels.push({ from: a, to: Math.min(doc.length, a + doc.lines[i].length + 1), insert: '' })
      }
      linewise = parts.join('\n')
    }
    if (cut) dispatch({ changes: dels, kind: 'delete.cut' })
    return parts.join('\n')
  }
  ta.addEventListener('copy', e => { e.preventDefault(); e.clipboardData.setData('text/plain', copied(false)) })
  ta.addEventListener('cut', e => { e.preventDefault(); e.clipboardData.setData('text/plain', copied(true)) })
  ta.addEventListener('paste', e => {
    e.preventDefault()
    paste(e.clipboardData.getData('text/plain'))
  })
  function paste(s) {
    s = split(s).join('\n')
    const r = ranges[main]
    if (md && ranges.length === 1 && r.anchor !== r.head && /^(https?:\/\/|mailto:|xmpp:|www\.)/.test(s) && plainAt(from(r), to(r))) {
      // a URL pasted over plain Markdown text links it
      const url = s.startsWith('www.') ? 'https://' + s : s
      return dispatch({ changes: [{ from: from(r), to: from(r), insert: '[' }, { from: to(r), to: to(r), insert: `](${url})` }],
        sel: { ranges: [sel1(r.anchor + 1, r.head + 1)], main: 0 }, kind: 'paste' })
    }
    const parts = s.split('\n')
    if (s === linewise && ranges.every(r => r.anchor === r.head)) {
      const per = parts.length === ranges.length, changes = [], next = []
      let shift = 0, n = 0, at = -1
      for (const r of ranges) {
        const a = doc.start(doc.lineOf(r.head))
        if (a !== at) {
          at = a
          const ins = (per ? parts[n++] : s) + '\n'
          changes.push({ from: a, to: a, insert: ins })
          shift += ins.length
        }
        next.push(sel1(r.head + shift))
      }
      return dispatch({ changes, sel: { ranges: next, main }, kind: 'paste' })
    }
    const per = ranges.length > 1 && parts.length === ranges.length
    const changes = [], next = []
    let shift = 0
    ranges.forEach((r, n) => {
      const ins = per ? parts[n] : s
      changes.push({ from: from(r), to: to(r), insert: ins })
      next.push(sel1(from(r) + shift + ins.length))
      shift += ins.length - (to(r) - from(r))
    })
    dispatch({ changes, sel: { ranges: next, main }, kind: 'paste' })
  }
  /** Whether offsets a to b are Markdown's plain text, inside one line and one token that is no link, URL or code. */
  function plainAt(a, b) {
    const i = doc.lineOf(a), s = doc.start(i)
    if (doc.lineOf(b) !== i) return false
    const t = tokensOf(i)
    for (let n = 0; n < t.length; n += 3) {
      if (t[n + 1] <= a - s || t[n] >= b - s) continue
      return t[n] <= a - s && t[n + 1] >= b - s && plain(t[n + 2])
    }
    return true
  }

  ta.addEventListener('focus', () => { dom.classList.add('cm-focused'); dirty() })
  ta.addEventListener('blur', () => { dom.classList.remove('cm-focused'); complete.close(); dirty() })

  // ---- Mouse
  let drag = null, drop_ = null
  content.addEventListener('mousedown', e => {
    if (e.button !== 0) return
    e.preventDefault()
    if (composing) ta.blur() // ends the composition where it is
    focus()
    const cell = e.target.closest('.cm-gutterElement')
    if (cell) return gutterClick(cell)
    if (e.target.classList.contains('cm-foldPlaceholder')) {
      const i = [...rows].find(([, r]) => r.line.contains(e.target))?.[0]
      if (i != null) setFolds(folds.filter(f => f[0] !== i))
      return
    }
    flush()
    const c = contentBox()
    const pos = posAt(e.clientX - c.left, e.clientY - c.top)
    const n = ((e.detail - 1) % 3) + 1
    if (e.altKey) {
      drag = { mode: 'rect', x: e.clientX - c.left, y: e.clientY - c.top, base: ranges }
      rectangle(e)
    } else if (n === 1 && !e.shiftKey && !e.ctrlKey && ranges.some(r => from(r) < pos && pos < to(r))) {
      drag = { mode: 'move', at: pos, moved: false }
    } else {
      const unit_ = n === 2 ? groupAt(view, pos) : n === 3 ? lineRange(pos) : { from: pos, to: pos }
      const base = e.ctrlKey ? ranges : []
      const side = sideAt(pos, e.clientY - c.top)
      const r = e.shiftKey ? sel1(ranges[main].anchor, pos, undefined, side) : sel1(unit_.from, unit_.to, undefined, n === 1 ? side : 0)
      if (e.ctrlKey && n === 1 && ranges.length > 1 && ranges.some(q => q.anchor === pos && q.head === pos)) {
        dispatch({ sel: { ranges: ranges.filter(q => q.head !== pos), main: 0 }, kind: 'select.pointer' })
        return
      }
      drag = { mode: n === 2 ? 'word' : n === 3 ? 'line' : 'char', unit: unit_, base, anchor: e.shiftKey ? ranges[main].anchor : null }
      dispatch({ sel: { ranges: [...base, r], main: base.length }, kind: 'select.pointer', scroll: false })
    }
    addEventListener('mousemove', dragMove)
    addEventListener('mouseup', dragEnd)
  })
  let autoScroll = 0, lastMove = null
  function dragMove(e) {
    if (!drag) return
    lastMove = e
    const s = scroller.getBoundingClientRect()
    const dy = e.clientY < s.top ? e.clientY - s.top : e.clientY > s.bottom ? e.clientY - s.bottom : 0
    if (dy && !autoScroll) autoScroll = requestAnimationFrame(function step() {
      if (!drag || !lastMove) return (autoScroll = 0)
      const s = scroller.getBoundingClientRect()
      const d = lastMove.clientY < s.top ? lastMove.clientY - s.top : lastMove.clientY > s.bottom ? lastMove.clientY - s.bottom : 0
      if (!d) return (autoScroll = 0)
      scroller.scrollTop += d / 2
      flush()
      track(lastMove)
      autoScroll = requestAnimationFrame(step)
    })
    track(e)
  }
  function track(e) {
    flush()
    const c = contentBox()
    const s = scroller.getBoundingClientRect()
    const x = e.clientX - c.left, y = Math.max(s.top + 1, Math.min(e.clientY, s.bottom - 2)) - c.top
    if (drag.mode === 'rect') return rectangle(e)
    const pos = posAt(x, y)
    if (drag.mode === 'move') {
      drag.moved = true
      drop_ = pos
      return dirty()
    }
    const u = drag.mode === 'word' ? groupAt(view, pos) : drag.mode === 'line' ? lineRange(pos) : { from: pos, to: pos }
    const a = drag.anchor ?? (u.from < drag.unit.from ? drag.unit.to : drag.unit.from)
    const head = drag.anchor != null ? pos : u.from < drag.unit.from ? u.from : Math.max(u.to, drag.unit.to)
    const r = sel1(drag.anchor ?? a, head, undefined, head === pos ? sideAt(pos, y) : 0)
    dispatch({ sel: { ranges: [...drag.base, r], main: drag.base.length }, kind: 'select.pointer', scroll: false })
  }
  function rectangle(e) {
    const c = contentBox()
    const x2 = e.clientX - c.left, y2 = e.clientY - c.top
    const la = lineAtY(drag.y - y0), lb = lineAtY(y2 - y0)
    const ca = Math.max(0, (drag.x - x0) / cw), cb = Math.max(0, (x2 - x0) / cw)
    const out_ = []
    for (let i = Math.min(la, lb); i <= Math.max(la, lb); i++) {
      if (foldIn(i)) continue
      const t = doc.lines[i], s = doc.start(i)
      // a line too short to reach the rectangle gets a cursor at its end
      if (column(t, t.length) < Math.min(ca, cb)) out_.push(sel1(s + t.length))
      else out_.push(sel1(s + offsetAt(t, ca), s + offsetAt(t, cb)))
    }
    if (out_.length) dispatch({ sel: { ranges: out_, main: 0 }, kind: 'select.pointer', scroll: false })
  }
  function dragEnd(e) {
    removeEventListener('mousemove', dragMove)
    removeEventListener('mouseup', dragEnd)
    const d = drag
    drag = null
    lastMove = null
    if (d?.mode !== 'move') return
    const target = drop_
    drop_ = null
    if (!d.moved || target == null) return dispatch({ sel: { ranges: [sel1(d.at)], main: 0 }, kind: 'select.pointer' })
    const r = ranges[main]
    if (!e.ctrlKey && target >= from(r) && target <= to(r)) return dirty()
    const s = doc.slice(from(r), to(r))
    const changes = e.ctrlKey ? [{ from: target, to: target, insert: s }]
      : [{ from: from(r), to: to(r), insert: '' }, { from: target, to: target, insert: s }].sort((a, b) => a.from - b.from)
    const at = e.ctrlKey || target < from(r) ? target : target - s.length
    dispatch({ changes, sel: { ranges: [sel1(at, at + s.length)], main: 0 }, kind: 'move.drop' })
  }
  function lineRange(pos) {
    const i = doc.lineOf(pos), s = doc.start(i)
    return { from: s, to: Math.min(doc.length, s + doc.lines[i].length + 1) }
  }
  function gutterClick(cell) {
    const i = [...rows].find(([, r]) => r.el === cell.parentNode)?.[0]
    if (i == null) return
    if (cell.classList.contains('cm-foldGutter')) {
      const f = foldAt(i)
      if (f) setFolds(folds.filter(g => g !== f))
      else {
        const end = foldRange(view, i)
        if (end != null) setFolds([...folds.filter(g => g[0] < i || g[1] > end), [i, end]])
      }
    } else if (cell.classList.contains('cm-blame') && blame?.[i]) {
      const run = blameRuns[blame[i] - 1]
      if (run.oid !== UNCOMMITTED) blamePick?.(run.oid)
    }
  }
  // While Alt is held over the text, a drag picks a rectangle: the pointer shows a crosshair.
  const cross = e => content.classList.toggle('cm-crosshair', e.altKey)
  content.addEventListener('mousemove', cross)
  content.addEventListener('mouseover', e => dom.classList.toggle('cm-gutterHover', !!e.target.closest('.cm-gutterElement')))
  content.addEventListener('mouseleave', () => dom.classList.remove('cm-gutterHover'))
  ta.addEventListener('keydown', cross)
  ta.addEventListener('keyup', cross)

  scroller.addEventListener('scroll', () => { box = null; draw() })
  const resized = new ResizeObserver(() => { metrics = true; leftDirty = true; dirty() })
  resized.observe(scroller)
  resized.observe(probe)

  const focus = () => ta.focus({ preventScroll: true })

  // ---- What edits.js, find.js and complete.js work with
  const view = {
    doc, L, unit, md,
    get ranges() { return ranges },
    get main() { return main },
    get wrap() { return wrap },
    get closed() { return closed },
    set closed(c) { closed = c },
    dom, scroller, panels, focus,
    dispatch, vertical, rowEdge, coords, flush, contentBox: () => contentBox(), tokensOf, lexTo,
    /** Whether line i is known to have every bracket in code, so its tokens needn't be read to pair them. */
    allCode: i => i < valid && !tb[i],
    redraw: () => dirty(),
    reveal: pos => { want = { pos }; dirty() },
    toggleWrap, undo,
    folds: {
      get list() { return folds },
      at: foldAt,
      set: setFolds,
    },
    find: null, complete: null,
  }
  const find = (view.find = startFind(view))
  const complete = (view.complete = startComplete(view))

  function setSel(s, { center, scroll = true } = {}) {
    const sel = typeof s === 'number' ? { ranges: [sel1(s)], main: 0 } : s
    dispatch({ sel, kind: 'select', scroll: false })
    if (center || scroll) { want = { pos: ranges[main].head, center }; dirty() }
  }

  dirty()
  const info = i => ({ number: i + 1, from: doc.start(i), to: doc.start(i) + doc.lines[i].length, text: doc.lines[i] })
  return {
    dom,
    focus,
    destroy() {
      destroyed = true
      resized.disconnect()
      complete.close()
      removeEventListener('mousemove', dragMove)
      removeEventListener('mouseup', dragEnd)
    },
    get scrollTop() { return scroller.scrollTop },
    set scrollTop(v) { scroller.scrollTop = v; draw() },
    /** The text, lines joined by `sep`. */
    text: (sep = '\n') => doc.text(sep),
    get lines() { return doc.lines },
    get length() { return doc.length },
    get lineCount() { return doc.count },
    /** 1-based line `n`: { number, from, to, text }. */
    line: n => info(n - 1),
    lineAt: pos => info(doc.lineOf(pos)),
    slice: (a, b) => doc.slice(a, b),
    /** Replaces offsets `from` to `to` with `insert` as one undoable change. With `clean`, the result is the text as
     * saved, before anyone hears of the change. */
    replace(a, b, insert, { clean: c } = {}) {
      insert = split(insert).join('\n')
      if (c) hist.sealed = true
      dispatch({ changes: a !== b || insert ? [{ from: a, to: b, insert }] : null, kind: 'other', scroll: false, clean: c, done: c })
    },
    /** Takes the text as it is now for the text as saved. */
    markClean,
    /** Whether the text is as saved, whatever undo or redo took it there. */
    isClean() {
      if (doc.length !== cleanLength || doc.count !== clean.length) return false
      for (let i = cleanLo; i <= cleanHi; i++) if (doc.lines[i] !== clean[i]) return false
      return true
    },
    /** The selection: `main` ({ from, to, head, anchor, empty }) and every range, to give back to `select`. */
    get sel() {
      const all = ranges.map(r => ({ anchor: r.anchor, head: r.head, from: from(r), to: to(r), empty: r.anchor === r.head }))
      return { main: all[main], ranges: all, index: main }
    },
    /** Selects `s`, a `sel` from before or an offset; with `center`, scrolls it to the middle. */
    select: (s, opts) => setSel(typeof s === 'number' ? s : { ranges: s.ranges.map(r => sel1(r.anchor, r.head)), main: s.index ?? 0 }, opts ?? { scroll: false }),
    wordAt: pos => wordAt(view, pos),
    get wrapping() { return wrap },
    set wrapping(on) { if (on !== wrap) toggleWrap() },
    /** Shows `data`, from blame.js's parseBlame, beside the line numbers, or takes it away when null. A click on a
     * commit's lines calls `pick(oid)`. */
    blame(data, pick) {
      blamePick = pick
      if (!data) {
        if (blame) { blame = null; layout++; leftDirty = true; dirty() }
        return
      }
      const age = ages(data.commits)
      blameRuns = []
      const ids = new Int32Array(doc.count)
      for (const run of runs(data.lines)) {
        const c = data.commits.get(run.oid)
        const mine = run.oid === UNCOMMITTED
        blameRuns.push({
          oid: run.oid, age: age.get(run.oid),
          label: mine ? 'Not committed' : `${since(c.time)}  ${c.author}`,
          title: mine ? 'Not committed yet' : `${c.summary}\n${c.author}, ${new Date(c.time * 1000).toLocaleString()}\n${c.oid.slice(0, 10)}`,
        })
        ids.fill(blameRuns.length, run.from - 1, Math.min(run.to, doc.count))
      }
      if (!blame) { layout++; leftDirty = true }
      blame = ids
      for (const r of rows.values()) r.blame = undefined
      dirty()
    },
    /** Marks the lines that differ from `base`, git's copy of the file as lines, or takes the bars away when null. */
    bars(base) {
      if (!base) {
        if (bars) { bars = null; layout++; dirty() }
        return
      }
      const next = new Uint8Array(doc.count)
      for (const c of lineChanges(base, doc.lines)) {
        if (c.kind === 'delete') {
          if (c.at > doc.count) next[doc.count - 1] = 4
          else next[c.at - 1] = 3
        } else next.fill(c.kind === 'add' ? 1 : 2, c.from - 1, c.to)
      }
      if (!bars) layout++
      bars = next
      for (const r of rows.values()) r.bar = undefined
      dirty()
    },
    /** Puts the caret at 1-based `line` and `col` and scrolls that line to the middle. */
    goto(line, col = 1) {
      const i = Math.max(0, Math.min(line, doc.count) - 1)
      setSel(doc.start(i) + Math.min(doc.lines[i].length, Math.max(0, col - 1)), { center: true })
    },
    /** Shows offset `pos` in the middle, with the caret there, without focusing. */
    show: pos => setSel(Math.max(0, Math.min(pos, doc.length)), { center: true }),
  }

  function markClean() {
    clean = doc.lines.slice()
    cleanLength = doc.length
    cleanLo = Infinity
    cleanHi = -1
    hist.sealed = true
  }
}
