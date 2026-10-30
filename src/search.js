// Ctrl+Shift+F finds text in a Claude tab: everything Claude wrote, scrollback included, with each match
// marked and the current one ringed. Enter and Shift+Enter step through them, Esc puts the bar away. The
// bar loads the first time it opens, so a tab that never searches pays nothing for it. While Claude runs
// fullscreen, the terminal holds only the screen, so the count is of the matches in view, and a step past
// the last one in view pages Claude's own view until another shows, wrapping at either end.
import { el } from './ui.js'
import { startPaging, transcriptEnd } from './turns.js'

const LIMIT = 2000 // matches marked at once; past that only the current one is
const PAGES = 400 // the most pages one step turns through Claude's fullscreen view
const QUIET_MS = 200 // how long output pauses before the matches are found again
const TO_TOP = '\x1b[1;5H' // Ctrl+Home
const TO_BOTTOM = '\x1b[1;5F' // Ctrl+End

/** Every match of `query` among buffer `b`'s lines, as [line, x, cells] triples in reading order; a line that
 * wraps reads as one with the rows it wraps onto, and lines are counted for good (`b.trimmed + y`). */
export function findAll(b, query, matchCase) {
  const hits = []
  const q = matchCase ? query : query.toLowerCase()
  const cell = b.getNullCell()
  const n = b.length
  for (let y = 0, end; y < n; y = end) {
    end = y + 1
    while (end < n && b.getLine(end).isWrapped) end++
    let text = ''
    for (let i = y; i < end; i++) text += rowText(b, i, i === end - 1, cell)
    if (!text) continue
    const t = matchCase ? text : text.toLowerCase()
    for (let at = t.indexOf(q); at !== -1; at = t.indexOf(q, at + q.length)) {
      const [sy, sx] = locate(b, y, end, at, cell)
      const [ey, ex] = locate(b, sy, end, at + q.length, cell, sx, at)
      hits.push(b.trimmed + sy, sx, (ey - sy) * b.getLine(sy).length + ex - sx)
    }
  }
  return hits
}

/** Row `i`'s text as a wrapped line reads it: the last row trimmed, and no blank where a wide character didn't
 * fit at the row's end. */
function rowText(b, i, last, cell) {
  const line = b.getLine(i)
  const s = line.translateToString(last)
  return !last && skips(b, i, cell) ? s.slice(0, -1) : s
}

/** Whether row `i` ends in the blank a wide character left, wrapping to the next row. */
function skips(b, i, cell) {
  const line = b.getLine(i)
  const c = line.getCell(line.length - 1, cell)
  return !c.getChars() && c.getWidth() === 1 && b.getLine(i + 1)?.getCell(0, cell)?.getWidth() === 2
}

/** The cell where character `n` of the line rows `y` to `end` read as starts, as [row, x]; past the text, the
 * cell after it. From cell `x` of row `y`, which character `from` starts, when given. */
function locate(b, y, end, n, cell, x = 0, from = 0) {
  n -= from
  for (let i = y; i < end; i++, x = 0) {
    const line = b.getLine(i)
    const stop = i === end - 1 ? line.getTrimmedLength() : line.length - (skips(b, i, cell) ? 1 : 0)
    for (; x < stop; x += cell.getWidth() || 1) {
      if (n <= 0) return [i, x]
      n -= line.getCell(x, cell).getChars().length || 1
    }
    if (n <= 0 && i === end - 1) return [i, x]
  }
  return [end - 1, b.getLine(end - 1).getTrimmedLength()]
}

/** A find bar over `host` for `term`, whose keys go to Claude through `send`. Returns `{ open, close, dispose }`. */
export function startSearch(term, host, send) {
  let bar, input, count
  const paging = startPaging(term, send)
  let busy = false // a step through Claude's fullscreen view is under way
  const fullscreen = () => term.vt.buffer === term.vt.alt
  let hits = [] // the query's matches in the buffer in use: [line, x, cells] triples
  let found = '' // the query and case the hits are for, and their buffer
  let current = null // the match the bar is on: { line, x, cells }
  const marked = new Map() // `${line},${x},${cells}` -> its marks
  let ring = [] // the current match's marks
  let timer = 0
  let watching = null // output and resizes, while the bar is open

  function build() {
    input = el('input', { type: 'text', placeholder: 'Find', spellcheck: false, ariaLabel: 'Find in terminal' })
    count = el('span', { className: 'count' })
    const button = (text, title, act) => {
      const b = el('button', { textContent: text, title, tabIndex: -1 })
      b.addEventListener('mousedown', e => e.preventDefault()) // the input keeps focus
      b.addEventListener('click', act)
      return b
    }
    bar = el('div', { className: 'find', hidden: true })
    bar.append(input, count, button('↑', 'Previous (Shift+Enter)', () => run(false)), button('↓', 'Next (Enter)', () => run(true)), button('×', 'Close (Esc)', close))
    host.appendChild(bar)
    // As you type, the match nearest the bottom, where Claude's newest output is. Each letter narrows the
    // match it is on before looking further up.
    input.addEventListener('input', () => run(false, false))
    input.addEventListener('keydown', e => {
      e.stopPropagation() // these keys are the bar's, not Claude's or the window's
      if (e.key === 'Escape') close()
      else if (e.key === 'Enter' || e.key === 'F3') run(!e.shiftKey)
      else if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') input.select()
      else return
      e.preventDefault()
    })
  }

  /** Finds the bar's query again, in the buffer as it is now. */
  function search() {
    const query = input.value
    const matchCase = query !== query.toLowerCase() // smart case, as in an editor: a capital letter matches case
    hits = query ? findAll(term.vt.buffer, query, matchCase) : []
    found = query && `${matchCase}${fullscreen()}${query}`
  }

  /** The index of the match at or past `pos` (`{ line, x }`) going up or down, wrapping round; -1 for none. */
  function near(pos, up, inclusive) {
    const n = hits.length / 3
    if (!n) return -1
    const cmp = i => hits[i * 3] - pos.line || hits[i * 3 + 1] - pos.x
    if (up) {
      for (let i = n - 1; i >= 0; i--) if (inclusive ? cmp(i) <= 0 : cmp(i) < 0) return i
      return n - 1
    }
    for (let i = 0; i < n; i++) if (inclusive ? cmp(i) >= 0 : cmp(i) > 0) return i
    return 0
  }

  /** Marks `cells` cells from cell `x` of `line`, running on across rows. */
  function boxes(line, x, cells, className) {
    const b = term.vt.buffer
    const cols = term.cols
    const out = []
    for (let y = line - b.trimmed; cells > 0; y++, x = 0) {
      const width = Math.min(cells, cols - x)
      out.push(term.mark(y, { x, width, className }))
      cells -= width
    }
    return out
  }

  function paint() {
    const keep = hits.length / 3 <= LIMIT
    const next = new Map()
    if (keep) {
      for (let i = 0; i < hits.length; i += 3) {
        const key = `${hits[i]},${hits[i + 1]},${hits[i + 2]}`
        next.set(key, marked.get(key) ?? boxes(hits[i], hits[i + 1], hits[i + 2], 'find-hit'))
      }
    }
    for (const [key, list] of marked) if (!next.has(key)) for (const m of list) m.dispose()
    marked.clear()
    for (const [key, list] of next) marked.set(key, list)
    for (const m of ring) m.dispose()
    ring = current ? boxes(current.line, current.x, current.cells, 'find-hit current') : []
    const n = hits.length / 3
    const where = fullscreen() ? ' in view' : ''
    const i = current ? index(current) : -1
    count.textContent = !input.value ? ''
      : !n ? (where ? 'None in view' : 'No results')
      : i < 0 ? `${n} found${where}`
      : `${i + 1} of ${n}${where}`
    bar.classList.toggle('none', !!input.value && !n && !where)
  }

  const index = pos => {
    for (let i = 0; i < hits.length; i += 3) if (hits[i] === pos.line && hits[i + 1] === pos.x) return i / 3
    return -1
  }
  const at = i => (i < 0 ? null : { line: hits[i * 3], x: hits[i * 3 + 1], cells: hits[i * 3 + 2] })

  /** Puts the bar on match `i`: selected and scrolled into view on the normal screen. */
  function land(i) {
    current = at(i)
    if (current && !fullscreen()) {
      const b = term.vt.buffer
      const y = current.line - b.trimmed
      term.select(current.x, y, current.cells)
      if (y < b.viewportY || y >= b.viewportY + term.rows) term.scrollLines(y - b.viewportY - (term.rows >> 1))
    }
    paint()
  }

  /** Steps to the next or previous match of what the bar holds; on Claude's fullscreen view a step, unlike
   * typing, pages on past the matches in view. */
  function run(forward, step = true) {
    if (!input.value) {
      hits = []
      current = null
      return paint()
    }
    if (fullscreen() && step) return paged(!forward)
    search()
    if (fullscreen()) return land(near({ line: Infinity, x: 0 }, true, true))
    if (!current) return land(near({ line: Infinity, x: 0 }, true, true))
    land(step ? near(current, !forward, false) : near(current, true, true))
  }

  /** The match in view past screen position `from` (y * cols + x) going up or down, on a row of Claude's
   * transcript (not its pinned prompt or input box), or -1. */
  function past(from, up) {
    const cols = term.cols
    const end = transcriptEnd(paging.screen())
    const t = term.vt.buffer.trimmed
    let best = -1
    let bestAt = 0
    for (let i = 0; i < hits.length / 3; i++) {
      const y = hits[i * 3] - t
      const p = y * cols + hits[i * 3 + 1]
      if (y < 1 || y >= end || (up ? p >= from : p <= from)) continue
      if (best < 0 || (up ? p > bestAt : p < bestAt)) [best, bestAt] = [i, p]
    }
    return best
  }

  async function paged(up) {
    if (busy) return
    busy = true
    try {
      search()
      const cols = term.cols
      const t = term.vt.buffer.trimmed
      let from = current ? (current.line - t) * cols + current.x : up ? Infinity : -Infinity
      let wrapped = false
      for (let page = 0; page < PAGES; page++) {
        const i = past(from, up)
        if (i >= 0) return land(i)
        const { shift } = await paging.page(up)
        current = null
        search()
        if (shift === null) return paint()
        if (shift === 0) {
          // The view's end: go round once, from the other end.
          if (wrapped) break
          wrapped = true
          send(up ? TO_BOTTOM : TO_TOP)
          await paging.redrawn()
          search()
          from = up ? Infinity : -Infinity
          continue
        }
        from += shift * cols
      }
      hits = []
      paint()
      count.textContent = 'No results'
      bar.classList.add('none')
    } finally {
      busy = false
    }
  }

  /** Output changed the buffer: once it pauses, the marks follow it, and the bar stays on its match. */
  function changed() {
    clearTimeout(timer)
    if (!input.value || busy) return
    timer = setTimeout(() => {
      if (busy || bar.hidden) return
      const was = found
      search()
      if (found !== was) current = null
      paint()
    }, QUIET_MS)
  }

  async function open() {
    if (!bar) build()
    const selected = term.getSelection()
    if (selected && !selected.includes('\n')) input.value = selected
    bar.hidden = false
    input.focus()
    input.select()
    watching ??= [term.onWriteParsed(changed), term.onResize(changed)]
    if (input.value) run(false)
  }

  function close() {
    if (!bar || bar.hidden) return
    bar.hidden = true
    clearTimeout(timer)
    for (const w of watching ?? []) w.dispose()
    watching = null
    hits = []
    current = null
    paint()
    term.focus()
  }

  return {
    open,
    close,
    get opened() { return !!bar && !bar.hidden },
    dispose() {
      close()
      bar?.remove()
    },
  }
}
