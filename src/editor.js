// A file tab's editor. It draws only the rows that show, each a flex row of gutter cells and the line, colored by
// highlight.js; selections, cursors and matches are boxes in layers behind and over the text. A hidden textarea at the
// caret takes the keyboard, IME and the clipboard. Commands are edits.js's, find and replace find.js's, and
// completion complete.js's. style.css styles the .cm-* classes.
import { Doc, split, mapPos, column, offsetAt, normal, sel1, from, to } from './doc.js'
import { lexLine, className } from './highlight.js'
import { lang } from './langs.js'
import { el } from './ui.js'
import { UNCOMMITTED, runs, ages, since } from './blame.js'
import { lineChanges } from './linediff.js'
import { KEYS, keyName, type, foldRange, foldable, cursor, wordAt, groupAt } from './edits.js'
import { startFind } from './find.js'
import { startComplete } from './complete.js'

const PLAIN = { name: 'Plain text', lex: '' }
// Characters drawn as a placeholder dot, as CodeMirror's highlightSpecialChars does by default.
const SPECIAL = /[\u{0}-\u{8}\u{b}-\u{1f}\u{7f}-\u{9f}\u{ad}\u{61c}\u{200b}\u{200e}\u{200f}\u{2028}\u{2029}\u{202d}\u{202e}\u{2066}\u{2067}\u{2069}\u{feff}\u{fff9}-\u{fffc}]/gu
const SIMPLE = /^[\t\x20-\x7e]*$/ // a line whose caret positions are columns times the character width
const LONG = 4096 // past this many characters an unwrapped line draws only around the viewport
const BARS = [null, ['add', 'Added since git\'s copy'], ['change', 'Changed since git\'s copy'],
  ['delete', 'Lines taken out above'], ['delete below', 'Lines taken out below']]
const JOINS = new Set(['type', 'delete', 'compose']) // what an undo step joins while typing goes on
const idle = globalThis.requestIdleCallback ?? (f => setTimeout(f, 30))

/** `arr` with `del` entries at `at` replaced by `ins` zeros. */
function spliced(arr, at, del, ins) {
  if (del === ins) return arr
  const out = new arr.constructor(arr.length - del + ins)
  out.set(arr.subarray(0, at))
  out.set(arr.subarray(at + del), at + ins)
  return out
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
  const found = /^(\t)|^( {2,})(?=\S)/m.exec(text) // the first indented line's indent
  const unit = found?.[1] ?? found?.[2] ?? '    '
  const doc = new Doc(text)
  let wrap = !!L.prose
  let version = 0
  let clean = doc.lines.slice(), cleanLength = doc.length

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
  let metrics = true // measure again before the next draw
  let leftDirty = true // the gutters changed width
  function measure() {
    const r = probe.getBoundingClientRect(), t = probeText.getBoundingClientRect()
    if (!r.height) return false
    lh = r.height
    cw = t.width / 32
    th = t.height
    const cs = getComputedStyle(content)
    padTop = parseFloat(cs.paddingTop)
    padBottom = parseFloat(cs.paddingBottom)
    metrics = false
    leftDirty = true
    return true
  }

  // ---- Lexing: each line's start state, valid up to `valid`; past it, up to `stale`, states from before an edit
  // that hold again once a relex comes out the same at a line at or past `editEnd`.
  let states = new Int32Array(doc.count + 1)
  let valid = 0, stale = 0, editEnd = 0
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
      const end = lexLine(L, lines[i], states[i], out, lines[i + 1])
      if (i + 1 >= editEnd && i + 1 <= stale && states[i + 1] === end) {
        valid = stale
        editEnd = 0
        continue
      }
      states[i + 1] = end
      valid = i + 1
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
  /** Line i's start state, known or guessed. */
  function stateOf(i) {
    if (!lexes) return 0
    if (i > valid) lexTo(i, performance.now() + 4)
    return i <= valid ? states[i] : guess.get(i) ?? guessFrom(i)
  }
  function tokensOf(i) {
    const st = stateOf(i)
    const row = rows.get(i)
    if (row && row.text === doc.lines[i] && row.state === st) return row.tokens
    out.length = 0
    if (lexes) lexLine(L, doc.lines[i], st, out, doc.lines[i + 1])
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
  function setFolds(next) {
    folds = next.sort((a, b) => a[0] - b[0])
    heights()
    dirty()
  }

  // ---- Heights: none while every line is one row tall; else each line's, and their running sums up to `ysKnown`.
  let hs = null, ys = null, ysKnown = 0
  const estimate = i => {
    const n = doc.lines[i].length
    return n * cw <= textWidth ? lh : lh * Math.ceil((n * cw) / textWidth)
  }
  function heights() {
    if (!wrap && !folds.length) { hs = ys = null; return }
    const n = doc.count
    hs = new Float32Array(n)
    for (let i = 0; i < n; i++) hs[i] = wrap ? estimate(i) : lh
    for (const [s, e] of folds) hs.fill(0, s + 1, e + 1)
    ys = new Float64Array(n + 1)
    ysKnown = 0
  }
  function sumTo(i) {
    let k = ysKnown
    for (; k < i; k++) ys[k + 1] = ys[k] + hs[k]
    ysKnown = k
  }
  const top = i => {
    if (!hs) return i * lh
    if (i > ysKnown) sumTo(i)
    return ys[i]
  }
  /** The showing line at `y`, counted from the first line's top. */
  function lineAtY(y) {
    const n = doc.count
    if (!hs) return Math.max(0, Math.min(n - 1, Math.floor(y / lh)))
    sumTo(n)
    let lo = 0, hi = n - 1
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1
      if (ys[m] <= y) lo = m
      else hi = m - 1
    }
    while (lo > 0 && !hs[lo]) lo--
    return lo
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
      for (const e of edits) follow(e)
      version++
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
  const clamp = r => sel1(Math.max(0, Math.min(r.anchor, doc.length)), Math.max(0, Math.min(r.head, doc.length)), r.goal)
  const same = (a, b) => a.length === b.length && a.every((r, i) => r.anchor === b[i].anchor && r.head === b[i].head)

  /** Moves every per-line cache along with a line edit. */
  function follow({ at, del, ins }) {
    states = spliced(states, at + 1, del - 1, ins - 1)
    const oldStale = Math.max(valid, stale)
    stale = oldStale >= at + del ? oldStale + ins - del : Math.min(oldStale, at)
    editEnd = Math.max(editEnd >= at + del ? editEnd + ins - del : 0, at + ins)
    valid = Math.min(valid, md ? Math.max(0, at - 1) : at)
    if (bars) bars = spliced(bars, at + 1, del - 1, ins - 1)
    if (blame) blame = spliced(blame, at + 1, del - 1, ins - 1)
    if (hs) {
      hs = spliced(hs, at, del, ins)
      ys = spliced(ys, at + 1, del, ins)
      for (let i = at; i < at + ins; i++) hs[i] = wrap ? estimate(i) : lh
      ysKnown = Math.min(ysKnown, at)
    }
    if (folds.length) {
      const kept = []
      for (const f of folds) {
        if (at + del - 1 < f[0] || (at === f[0] && del === 1 && ins === 1)) kept.push(at + del - 1 < f[0] ? [f[0] + ins - del, f[1] + ins - del] : f)
        else if (at > f[1]) kept.push(f)
      }
      if (kept.length !== folds.length) { folds = kept; heights() } else folds = kept
    }
    if (del !== ins || ins > 1) {
      const moved = new Map()
      for (const [i, r] of rows) {
        if (i < at) moved.set(i, r)
        else if (i >= at + del) moved.set(i + ins - del, r)
        else if (i === at) moved.set(i, r)
        else drop(r)
      }
      rows = moved
    }
    for (let i = at; i < at + ins; i++) if (doc.lines[i].length > longest) longest = doc.lines[i].length
  }

  function record(inverse, changes, kind, before) {
    const now = Date.now()
    const last = hist.done.at(-1)
    const touches = () => changes.some(c => last.touched.some(([f, t]) => c.to >= f && c.from <= t))
    if (last?.inv && !last.sels.length && !hist.sealed && JOINS.has(kind) &&
        ((kind === 'compose' && hist.kind === 'compose') || (now - hist.time < 500 && touches()))) {
      last.inv.push(inverse)
      last.touched = [...last.touched.map(([f, t]) => [mapPos(f, changes, -1), mapPos(t, changes, 1)]),
        ...inverse.map(c => [c.from, c.to])]
    } else {
      hist.done.push({ inv: [inverse], sel: before, sels: [], touched: inverse.map(c => [c.from, c.to]) })
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
    const from = redo ? hist.undone : hist.done, onto = redo ? hist.done : hist.undone
    const ev = from.at(-1)
    if (!ev) return false
    if (onlySel && ev.sels.length) {
      const s = ev.sels.pop()
      const top = onto.at(-1) ?? onto[onto.push({ inv: null, sel: null, sels: [], touched: [] }) - 1]
      top.sels.push(snapshot())
      dispatch({ sel: s, kind: 'undo', history: false })
      return true
    }
    if (!ev.inv) return false
    from.pop()
    const now = snapshot()
    const back = []
    for (let k = ev.inv.length - 1; k >= 0; k--) {
      const { inverse, edits } = doc.apply(ev.inv[k])
      for (const e of edits) follow(e)
      closed = []
      back.push(inverse)
      complete.close()
    }
    version++
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
    // A long unwrapped line shows only the stretch around the viewport, in blocks of LONG characters.
    let s = 0, e = text.length
    if (!wrap && e > LONG) {
      const c0 = Math.max(0, (scroller.scrollLeft - lineLeft) / cw)
      s = Math.max(0, Math.floor(offsetAt(text, c0) / LONG) * LONG - LONG)
      e = Math.min(text.length, s + 3 * LONG + Math.ceil(scroller.clientWidth / cw))
    }
    if (r.text === text && r.state === st && r.next === next && r.shut === shut && r.offset === s && r.end === e) return
    let tokens = r.tokens
    if (!(r.text === text && r.state === st && r.next === next)) {
      out.length = 0
      if (lexes) lexLine(L, text, st, out, next)
      tokens = out.slice()
    }
    if (r.text !== text) r.simple = SIMPLE.test(text)
    Object.assign(r, { text, state: st, next, shut, tokens, offset: s, end: e })
    const line = r.line
    if (!text && !shut) return line.replaceChildren(el('br'))
    const frag = document.createDocumentFragment()
    if (s) {
      const gap = el('span', { className: 'cm-gap' })
      gap.style.width = `${column(text, s) * cw}px`
      frag.append(gap)
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
    if (destroyed) return
    if (!scroller.clientHeight || !dom.isConnected) { hidden = true; return }
    if (hidden || metrics) {
      hidden = false
      if (!measure()) return
      heights()
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
      const st = scroller.scrollTop, h = scroller.clientHeight
      const margin = Math.max(h / 2, 200)
      const a = lineAtY(st - padTop - margin), b = lineAtY(st - padTop + h + margin)
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
      rowsBox.style.paddingTop = `${top(a)}px`
      content.style.height = `${padTop + top(doc.count) + padBottom}px`
      if (leftDirty && order.length) {
        leftDirty = false
        const ln = order[0].line
        lineLeft = ln.offsetLeft + padLeft
        const w = content.clientWidth - lineLeft - padRight
        if (wrap && Math.abs(w - textWidth) > 1 && !rewrapped) {
          rewrapped = true
          textWidth = w
          heights()
          pass--
          continue
        }
        textWidth = w
      }
      if (!wrap) {
        const w = `max(100%, ${Math.ceil(lineLeft + longest * cw + padRight + 1)}px)`
        if (w !== minWidth) content.style.minWidth = minWidth = w
      } else if (minWidth) content.style.minWidth = minWidth = ''
      // Wrapped lines, and lines of other scripts, are as tall as they lay out.
      let moved = 0
      const anchor = lineAtY(st - padTop), anchorTop = top(anchor)
      for (const [i, r] of rows) {
        if (!wrap && r.simple) continue
        const ht = r.el.getBoundingClientRect().height
        if (Math.abs(ht - (hs ? hs[i] : lh)) > 0.5) {
          if (!hs) { hsAll(); }
          hs[i] = ht
          ysKnown = Math.min(ysKnown, i)
          moved++
        }
      }
      if (!moved) break
      rowsBox.style.paddingTop = `${top(a)}px`
      content.style.height = `${padTop + top(doc.count) + padBottom}px`
      const shift = top(anchor) - anchorTop
      if (shift) scroller.scrollTop = st + shift
    }
    layers()
    paintStatus()
    lexLater()
  }
  function hsAll() {
    hs = new Float32Array(doc.count).fill(lh)
    for (const [s, e] of folds) hs.fill(0, s + 1, e + 1)
    ys = new Float64Array(doc.count + 1)
    ysKnown = 0
  }
  // The longest line's length, for the width long lines scroll to. It only grows while editing.
  let longest = doc.lines.reduce((n, l) => Math.max(n, l.length), 0)
  let minWidth = '', shownDigits = 0

  /** Scrolls so offset `pos` shows, in the middle with `center`. */
  function reveal(pos, center) {
    const i = doc.lineOf(pos)
    const h = scroller.clientHeight
    const y = padTop + top(i), y2 = y + (hs ? hs[i] || lh : lh)
    let st = scroller.scrollTop
    if (center) st = (y + y2) / 2 - h / 2
    else if (y < st + 4) st = y - 4 - (i === 0 ? padTop : 0)
    else if (y2 > st + h - 4) st = y2 - h + 4 + (i === doc.count - 1 ? padBottom : 0)
    if (st !== scroller.scrollTop) scroller.scrollTop = Math.max(0, st)
    if (!wrap) {
      const x = lineLeft + column(doc.lines[i], pos - doc.start(i)) * cw
      const w = scroller.clientWidth
      if (x < scroller.scrollLeft + lineLeft) scroller.scrollLeft = Math.max(0, x - lineLeft - 20)
      else if (x > scroller.scrollLeft + w - 20) scroller.scrollLeft = x - w + 40
    }
  }

  // ---- Coordinates, in the content box's pixels
  let box = null // content's client rect, read once per draw
  const contentBox = () => (box ??= content.getBoundingClientRect())
  /** Line i's text node and offset holding character ch, in row r. */
  function domAt(r, ch) {
    ch -= r.offset
    if (ch < 0 || ch > r.end - r.offset) return null
    let k = 0
    for (let n = r.line.firstChild; n; n = n.nextSibling) {
      const t = n.nodeType === 3 ? n : n.firstChild
      if (!t || t.nodeType !== 3 || n.className === 'cm-foldPlaceholder' || n.className === 'cm-gap') continue
      const len = t.data.length
      if (ch <= k + len) return [t, ch - k]
      k += len
    }
    return null
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
  /** Where offset pos is: { x, y, h }, its row's left, top and height. */
  function coords(pos) {
    const i = doc.lineOf(pos), ch = pos - doc.start(i), text = doc.lines[i]
    const y = padTop + top(i)
    const r = rows.get(i)
    if (!r || (!wrap && r.simple)) return { x: lineLeft + column(text, ch) * cw, y, h: lh, i }
    const c = contentBox()
    if (!text.length) {
      const lr = r.line.getBoundingClientRect()
      return { x: lr.left - c.left + padLeft, y: lr.top - c.top, h: lh, i }
    }
    const end = ch >= text.length
    const a = end ? ch - 1 - (ch > 1 && isLow(text, ch - 1) ? 1 : 0) : ch
    const b = end ? ch : ch + (isHigh(text, ch) ? 2 : 1)
    const rs = domRects(r, a, b)
    const q = end ? rs[rs.length - 1] : rs[0]
    if (!q) return { x: lineLeft + column(text, ch) * cw, y, h: lh, i }
    return { x: (end ? q.right : q.left) - c.left, y: q.top - c.top + (q.height - lh) / 2, h: lh, i }
  }
  /** The offset nearest the content point (x, y). */
  function posAt(x, y) {
    const i = lineAtY(y - padTop)
    const text = doc.lines[i], start = doc.start(i)
    const r = rows.get(i)
    if (!wrap && (!r || r.simple)) return start + offsetAt(text, (x - lineLeft) / cw)
    if (!r) {
      const up = Math.max(0, Math.floor((y - padTop - top(i)) / lh)), perRow = Math.max(1, Math.floor(textWidth / cw))
      return start + Math.min(text.length, offsetAt(text, up * perRow + (x - lineLeft) / cw))
    }
    const c = contentBox()
    const lr = r.line.getBoundingClientRect()
    const cx = Math.max(lr.left + padLeft, Math.min(c.left + x, lr.right - padRight - 1))
    const cy = Math.max(lr.top + 1, Math.min(c.top + y, lr.bottom - 1))
    const hit = document.caretPositionFromPoint?.(cx, cy) ?? (p => p && { offsetNode: p.startContainer, offset: p.startOffset })(document.caretRangeFromPoint?.(cx, cy))
    if (hit && r.line.contains(hit.offsetNode)) return start + Math.min(text.length, charOf(r, hit.offsetNode, hit.offset))
    return start + Math.min(text.length, offsetAt(text, (x - lineLeft) / cw))
  }
  const isHigh = (s, k) => (s.charCodeAt(k) & 0xfc00) === 0xd800
  const isLow = (s, k) => (s.charCodeAt(k) & 0xfc00) === 0xdc00

  /** Offset `pos` moved a row up (dir -1) or down, or by `by` pixels, toward the x `goal`. */
  function vertical(r, dir, by = 0) {
    flush()
    const c = coords(r.head)
    const goal = r.goal ?? c.x
    if (!by && !wrap && !folds.length) {
      const i = c.i + dir
      if (i < 0) return { head: 0, goal }
      if (i >= doc.count) return { head: doc.length, goal }
      return { head: doc.start(i) + offsetAt(doc.lines[i], (goal - lineLeft) / cw), goal }
    }
    const y = c.y + dir * (by || lh) + lh / 2
    if (y < padTop) return { head: 0, goal }
    if (y >= padTop + top(doc.count)) return { head: doc.length, goal }
    return { head: posAt(goal, y), goal }
  }
  /** The start (or with `forward`, the end) of the row that offset pos shows on. */
  function rowEdge(pos, forward) {
    const i = doc.lineOf(pos), start = doc.start(i), end = start + doc.lines[i].length
    if (!wrap || !rows.get(i)) return forward ? end : start
    flush()
    const c = coords(pos)
    return forward ? posAt(1e7, c.y + lh / 2) : posAt(0, c.y + lh / 2)
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
    const lo = doc.start(first), hi = doc.start(Math.min(last, doc.count - 1)) + doc.lines[Math.min(last, doc.count - 1)].length
    find.matches(lo, hi, (a, b, selected) => rects(a, b, selected ? 'cm-searchMatch cm-searchMatch-selected' : 'cm-searchMatch', sels, true))
    selectionMatches(lo, hi, sels)
    brackets(sels)
    for (const r of ranges) if (r.anchor !== r.head) rects(from(r), to(r), 'cm-selectionBackground', sels)
    for (const [k, r] of ranges.entries()) {
      const i = doc.lineOf(r.head)
      if (!rows.has(i)) continue
      const c = coords(r.head)
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
      const f = Math.max(a, start) - start, t = Math.min(b, start + text.length) - start
      const past = b > start + text.length
      const y = padTop + top(i)
      if (!wrap && r.simple) {
        const x1 = lineLeft + column(text, f) * cw
        const x2 = past ? 1e6 : lineLeft + column(text, t) * cw
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
  function selectionMatches(lo, hi, list) {
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
      if (r.anchor !== r.head) continue
      const m = cursor.bracket(view, r.head)
      if (!m) continue
      rects(m.at, m.at + 1, m.to == null ? 'cm-nonmatchingBracket' : 'cm-matchingBracket', list, true)
      if (m.to != null) rects(m.to, m.to + 1, 'cm-matchingBracket', list, true)
    }
  }
  function placeInput() {
    if (composing) return
    const r = ranges[main]
    if (!rows.has(doc.lineOf(r.head))) return
    const c = coords(r.head)
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
    const anchor = lineAtY(scroller.scrollTop - padTop)
    wrap = !wrap
    dom.classList.toggle('cm-lineWrapping', wrap)
    leftDirty = true
    textWidth = content.clientWidth - lineLeft - padRight
    heights()
    for (const r of rows.values()) r.simple = r.simple // rows keep their text; heights are measured on draw
    draw()
    scroller.scrollTop = padTop + top(anchor)
    dirty()
    return true
  }

  // ---- Keyboard and text input
  let composing = false, comp = 0 // the composition's length at each cursor
  ta.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return
    const k = keyName(e)
    if (k && run(k)) e.preventDefault()
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

  // The clipboard: an empty selection copies its whole line, which pastes back as a line above the cursor.
  let linewise = null
  function copied(cut) {
    const any = ranges.some(r => r.anchor !== r.head)
    let s
    if (any) s = ranges.filter(r => r.anchor !== r.head).map(r => doc.slice(from(r), to(r))).join('\n')
    else {
      const lines = [...new Set(ranges.map(r => doc.lineOf(r.head)))]
      s = lines.map(i => doc.lines[i] + '\n').join('')
      linewise = s
    }
    if (cut) {
      if (any) KEYS.Backspace(view)
      else {
        const lines = [...new Set(ranges.map(r => doc.lineOf(r.head)))].sort((a, b) => a - b)
        const changes = lines.map(i => {
          const a = doc.start(i), b = a + doc.lines[i].length
          return b < doc.length ? { from: a, to: b + 1, insert: '' } : { from: Math.max(0, a - 1), to: b, insert: '' }
        })
        dispatch({ changes, kind: 'delete.cut' })
      }
    }
    return s
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
    if (md && ranges.length === 1 && r.anchor !== r.head && /^(https?:\/\/|mailto:)\S+$/.test(s.trim())) {
      s = `[${doc.slice(from(r), to(r))}](${s.trim()})`
    }
    const parts = s.split('\n')
    const empty = ranges.every(r => r.anchor === r.head)
    if (s === linewise && empty) {
      const lines = s.slice(0, -1).split('\n')
      const per = lines.length === ranges.length
      const changes = ranges.map((r, n) => ({ from: doc.start(doc.lineOf(r.head)), to: doc.start(doc.lineOf(r.head)), insert: per ? lines[n] + '\n' : s }))
      return dispatch({ changes: dedupe(changes), kind: 'paste' })
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
  const dedupe = changes => changes.filter((c, n) => !n || c.from !== changes[n - 1].from)

  ta.addEventListener('focus', () => { dom.classList.add('cm-focused'); dirty() })
  ta.addEventListener('blur', () => { dom.classList.remove('cm-focused'); complete.close(); dirty() })

  // ---- Mouse
  let drag = null, drop_ = null
  content.addEventListener('mousedown', e => {
    if (e.button !== 0) return
    e.preventDefault()
    if (composing) { ta.blur(); }
    focus()
    const cell = e.target.closest('.cm-gutterElement')
    if (cell) return gutterClick(cell, e)
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
      const r = e.shiftKey ? sel1(ranges[main].anchor, pos) : sel1(unit_.from, unit_.to)
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
    dispatch({ sel: { ranges: [...drag.base, sel1(drag.anchor ?? a, head)], main: drag.base.length }, kind: 'select.pointer', scroll: false })
  }
  function rectangle(e) {
    const c = contentBox()
    const x2 = e.clientX - c.left, y2 = e.clientY - c.top
    const la = lineAtY(drag.y - padTop), lb = lineAtY(y2 - padTop)
    const ca = Math.max(0, (drag.x - lineLeft) / cw), cb = Math.max(0, (x2 - lineLeft) / cw)
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
  function gutterClick(cell, e) {
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
    get version() { return version },
    get lineHeight() { return lh },
    dom, scroller, panels, ta, focus,
    dispatch, vertical, rowEdge, coords, posAt, flush, contentBox: () => contentBox(), tokensOf, lexTo,
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
    isClean: () => doc.length === cleanLength && doc.count === clean.length && doc.lines.every((l, i) => l === clean[i]),
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
    run, // for checks: runs the command a key name is bound to
    view,
  }

  function markClean() {
    clean = doc.lines.slice()
    cleanLength = doc.length
    hist.sealed = true
  }
}
