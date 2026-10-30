// A terminal on the page: a Vt's screen drawn as DOM rows, and keys, the mouse, and the clipboard turned into
// what the program reads. It behaves as xterm.js did for nook (its DOM renderer and the addons nook loaded),
// with the classes nook's CSS and benches use: .xterm, .xterm-screen, .xterm-rows, .xterm-cursor,
// .xterm-helper-textarea. Each frame compares every row with what it drew last and rewrites only the rows that
// changed. Colors are classes bound to theme variables, so a theme change redraws nothing.
import { Vt, CP, COMBINED, CM, RGB, INVERSE, BOLD, UNDERLINE, INVISIBLE, STRIKE, ITALIC, DIM, EXT, OVERLINE } from './vt.js'
import { keyData } from './keys.js'
import { slotVar, bytes } from '../palette.js'
import { WINDOWS } from '../paths.js'

const SCROLLBAR = 14 // px the scrollbar takes beside the screen
const SLICE_MS = 12 // the longest one parse runs before the page gets a turn
const HOLD_MS = 1000 // the longest a synchronized update (DEC 2026) holds the frame
const SEPARATORS = ' ()[]{}\',"`' // what ends a double-clicked word
const CURSORS = { block: 'xterm-cursor xterm-cursor-block', bar: 'xterm-cursor xterm-cursor-bar', underline: 'xterm-cursor xterm-cursor-underline' }
const OUTLINE = 'xterm-cursor xterm-cursor-outline' // the cursor while the terminal has no focus
const PLACEHOLDER = 0x10eeee // a picture's cell (pictures.js): drawn as a blank, as no font has it
const COLOR = CM | 0xffffff
const W = 'W'

/** Palette slot `n` as CSS: its theme variable, or xterm's own color for a slot the theme doesn't name. */
function slot(n) {
  const v = slotVar(n)
  if (v) return `var(${v})`
  const cube = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff]
  const rgb = n < 232 ? [cube[((n - 16) / 36 | 0) % 6], cube[((n - 16) / 6 | 0) % 6], cube[(n - 16) % 6]] : Array(3).fill(8 + 10 * (n - 232))
  return '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('')
}
const PALETTE = Array.from({ length: 256 }, (_, n) => slot(n))
const hex = c => '#' + (c & 0xffffff).toString(16).padStart(6, '0')
/** A color word (mode and value) as CSS, with bold's brightening of the first 8 palette colors. */
const css = (c, bold) => ((c & CM) === RGB ? hex(c) : PALETTE[(c & 0xff) + (bold && (c & 0xff) < 8 ? 8 : 0)])

let styled = false
/** The palette's classes, once per page: fN colors text with slot N, bN its background, 257 is inverse's default. */
function palette() {
  if (styled) return
  styled = true
  const half = c => `color-mix(in srgb,${c} 50%,transparent)`
  let s = `.xterm-rows .dim{color:${half('var(--term-fg)')}}`
  PALETTE.forEach((c, n) => { s += `.xterm-rows .f${n}{color:${c}}.xterm-rows .f${n}.dim{color:${half(c)}}.xterm-rows .b${n}{background-color:${c}}` })
  s += '.xterm-rows .f257{color:#000}.xterm-rows .f257.dim{color:#0008}.xterm-rows .b257{background-color:var(--term-fg)}'
  document.head.prepend(Object.assign(document.createElement('style'), { textContent: s }))
}

const on = (list, fn) => {
  list.push(fn)
  return { dispose: () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1) } }
}
const cancel = e => {
  e.preventDefault()
  e.stopPropagation()
}

/** The terminal in `host`. Hooks: `osc(id, data)`, `apc(data)`, `dcs(ident, params)` as Vt's, and `link(uri)`
 * for an OSC 8 hyperlink clicked; `keys(e)` sees each keydown first and returns false to keep it from the
 * program; `pull` grows rows from scrollback, as on Linux. */
export class Term {
  constructor(host, { scrollback = 10000, pull = false, osc, apc, dcs, link, keys } = {}) {
    palette()
    this.host = host
    this.keys = keys
    this.listeners = { data: [], resize: [], title: [], render: [], parsed: [] }
    this.vt = new Vt(80, 24, {
      reply: s => this.emit('data', s),
      title: s => this.emit('title', s),
      osc, apc, dcs,
      pixels: () => ({ cellW: this.cellW, cellH: this.cellH, width: this.canvasW, height: this.canvasH }),
      colors: () => {
        const style = getComputedStyle(this.element)
        const rgb = name => bytes(style.getPropertyValue(name)).slice(0, 3)
        return [rgb('--term-fg'), [0, 0, 0], rgb('--cursor')] // the background is transparent: dark
      },
    }, { scrollback, pull })
    this.decoder = new TextDecoder()

    const root = this.element = document.createElement('div')
    root.className = 'terminal xterm'
    root.innerHTML = '<div class="xterm-screen"><div class="xterm-marks"></div><div class="xterm-selection"></div>'
      + '<div class="xterm-rows"></div></div><div class="scrollbar vertical"><div class="slider"></div></div>'
      + '<div class="xterm-helpers"><textarea class="xterm-helper-textarea" aria-label="Terminal input" autocorrect="off"'
      + ' autocapitalize="off" spellcheck="false" tabindex="0"></textarea><div class="composition-view"></div>'
      + '<div class="xterm-width-cache-measure-container"></div></div>'
    host.appendChild(root)
    this.screen = root.firstChild
    ;[this.marks, this.selLayer, this.rowsEl] = this.screen.children
    this.bar = root.children[1]
    this.slider = this.bar.firstChild
    this.helpers = root.lastChild
    ;[this.textarea, this.compView, this.measureBox] = this.helpers.children
    this.rowEls = []

    // What each row shows: its cells' words, its graphemes and extras, its cursor and selection, and its HTML.
    this.snaps = []
    this.sigs = []
    this.html = []
    this.state = new Int32Array(0)
    this.force = true
    // Glyph widths, measured in the DOM in batches: printable Latin-1 in a flat table, anything else by text.
    this.flat = new Float32Array(256).fill(NaN)
    this.widths = new Map()
    this.pending = new Map() // key -> [chars, bold, italic], waiting to be measured
    this.unmeasured = false // the row being built met a glyph not measured yet

    this.queue = [] // chunks and their callbacks, in pairs
    this.at = 0
    this.typed = false // the next write follows user input, so it parses at once, for a quicker echo
    this.frame = 0
    this.holdTimer = 0
    this.paused = false
    this.focused = false
    this.mouseMode = 'none'
    this.shownBuffer = this.vt.buffer
    this.drawnTop = -1 // the view's first line, as `trimmed + ydisp`, when marks and selection were placed
    this.selKey = ''
    this.barKey = ''
    this.areaKey = ''
    this.pos = 0 // the scroll position in px, as the wheel moves it between whole rows
    this.partial = 0 // the wheel's part of a line not yet reported
    this.lastReport = null
    this.over = false // the pointer is over the terminal: the scrollbar shows
    this.barTimer = 0

    // Selection, as xterm's model, its lines counted from the first line the buffer ever had (`trimmed + y`).
    this.sel = { start: null, end: null, len: 0, mode: 0 } // mode: 0 cells, 1 words, 2 lines
    this.dragScroll = 0
    this.dragTimer = 0
    this.downAt = 0

    // Links: providers in rank order, the one under the pointer, and the replies for its line.
    this.providers = [{ provideLinks: (y, cb) => cb(this.hyperlinks(y)) }]
    this.link = null
    this.downLink = null
    this.lastMove = null
    this.lastCell = null
    this.replies = null
    this.linkLine = -1
    this.mouseOut = true
    this.linkResized = false
    this.hover = null // the hovered link's cells: { y1, x1, y2, x2 }, end exclusive
    this.openLink = link

    this.marksList = new Set()
    this.cellRead = this.vt.buffer.getNullCell()
    this.missed = false // a frame was asked for while off screen
    this.linkView = -1
    this.barDrag = false
    this.ratio = 0
    this.disposed = false
    this.seen = null

    // Keys and IME composition.
    this.keyDownHandled = false
    this.keyDownSeen = false
    this.keyPressHandled = false
    this.deadKey = false
    this.composing = false
    this.sendingComposition = false
    this.compStart = 0
    this.compEnd = 0
    this.alreadySent = ''

    this.ctx = new OffscreenCanvas(1, 1).getContext('2d')
    this.measureFont()
    this.resizeRows()
    this.dims()
    this.bind()
  }

  get cols() { return this.vt.cols }
  get rows() { return this.vt.rows }

  emit(kind, ...args) { for (const fn of this.listeners[kind]) fn(...args) }
  onData(fn) { return on(this.listeners.data, fn) }
  onResize(fn) { return on(this.listeners.resize, fn) }
  onTitleChange(fn) { return on(this.listeners.title, fn) }
  /** After each frame's DOM update. */
  onRender(fn) { return on(this.listeners.render, fn) }
  /** After each slice of parsing. */
  onWriteParsed(fn) { return on(this.listeners.parsed, fn) }

  // ---- metrics

  /** Reads the font from the theme and measures a cell, as xterm does: 'W' on a canvas. */
  measureFont() {
    const style = getComputedStyle(this.host)
    const v = name => style.getPropertyValue(name).trim()
    const family = v('--font-term') || 'monospace'
    const size = parseFloat(v('--term-font-size')) || 14
    const lineHeight = parseFloat(v('--term-line-height')) || 1
    if (family === this.fontFamily && size === this.fontSize && lineHeight === this.lineHeight && this.charW) return false
    this.fontFamily = family
    this.fontSize = size
    this.lineHeight = lineHeight
    this.element.style.fontFamily = family
    this.element.style.fontSize = `${size}px`
    this.ctx.font = `${size}px ${family}`
    const m = this.ctx.measureText(W)
    this.charW = m.width
    this.charH = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent
    this.flat.fill(NaN)
    this.widths.clear()
    return true
  }

  /** The screen's size from the cell's, with xterm's rounding to device pixels. */
  dims() {
    const dpr = devicePixelRatio
    const { cols, rows } = this.vt
    this.devCellH = Math.floor(Math.ceil(this.charH * dpr) * this.lineHeight)
    this.canvasW = Math.round(this.charW * dpr * cols / dpr)
    this.canvasH = Math.round(this.devCellH * rows / dpr)
    this.cellW = this.canvasW / cols
    this.cellH = this.canvasH / rows
    const s = this.screen.style
    s.width = `${this.canvasW}px`
    s.height = `${this.canvasH}px`
    this.element.style.setProperty('--cell-h', `${this.cellH}px`)
    this.setSpacing()
  }

  /** The letter spacing that fits 'W' to a cell, for every glyph as wide; until 'W' is measured, the canvas's. */
  setSpacing() {
    const w = this.flat[87]
    this.spacing = this.cellW - (w === w ? w : this.charW)
    this.rowsEl.style.letterSpacing = `${this.spacing}px`
    this.force = true
  }

  /** Re-reads the theme's font: a change measures again and redraws every row. */
  restyle() {
    if (!this.measureFont()) return
    this.dims()
    this.refresh()
  }

  /** The size that fills the host, as xterm's fit addon proposes it, or undefined while a cell has no size. */
  fit() {
    if (!this.cellW || !this.cellH || !this.element.parentElement) return undefined
    const style = getComputedStyle(this.host)
    const width = Math.max(0, parseInt(style.width)) - SCROLLBAR
    return { cols: Math.max(2, Math.floor(width / this.cellW)), rows: Math.max(1, Math.floor(parseInt(style.height) / this.cellH)) }
  }

  /** A glyph's width in px, measured if new: -1 then, and the row is built again once it is. */
  widthOf(chars, bold, italic) {
    if (!bold && !italic && chars.length === 1) {
      const code = chars.charCodeAt(0)
      if (code < 256) {
        const w = this.flat[code]
        if (w === w) return w
      }
    }
    const key = bold || italic ? chars + (bold ? 'B' : '') + (italic ? 'I' : '') : chars
    const w = this.widths.get(key)
    if (w !== undefined) return w
    this.pending.set(key, [chars, bold, italic])
    this.unmeasured = true
    return -1
  }

  /** Measures glyphs, each as 32 copies in a span, with one layout for the lot. */
  measure(list) {
    const box = this.measureBox
    const spans = list.map(([chars, bold, italic]) => {
      const s = document.createElement('span')
      if (bold) s.style.fontWeight = 'bold'
      if (italic) s.style.fontStyle = 'italic'
      s.textContent = chars.repeat(32)
      return box.appendChild(s)
    })
    const widths = spans.map(s => s.offsetWidth / 32)
    box.textContent = ''
    if (!box.offsetParent) return // hidden: nothing measures
    list.forEach(([chars, bold, italic], i) => {
      const code = chars.length === 1 && !bold && !italic ? chars.charCodeAt(0) : 256
      if (code < 256) this.flat[code] = widths[i]
      else this.widths.set(bold || italic ? chars + (bold ? 'B' : '') + (italic ? 'I' : '') : chars, widths[i])
    })
  }

  // ---- size

  /** Sets the size; the same size does nothing. As xterm's DOM renderer did, the rows repaint at once, even
   * while a synchronized update holds the frame, and onRender waits for the frame after the hold. */
  resize(cols, rows) {
    if (!this.vt.resize(cols, rows)) return
    this.resizeRows()
    this.dims()
    this.clearSelection()
    this.clearLink()
    this.linkResized = true
    if (!this.paused) this.paint()
    this.emit('resize', { cols: this.vt.cols, rows: this.vt.rows })
    this.refresh()
  }

  /** One row element per screen row, added or removed at the end, and what each row last showed. */
  resizeRows() {
    const { cols, rows } = this.vt
    while (this.rowEls.length < rows) this.rowEls.push(this.rowsEl.appendChild(document.createElement('div')))
    while (this.rowEls.length > rows) this.rowEls.pop().remove()
    if (this.snaps[0]?.length !== cols * 3) this.snaps.length = 0
    for (let y = this.snaps.length; y < rows; y++) this.snaps.push(new Uint32Array(cols * 3))
    this.snaps.length = rows
    this.sigs.length = this.html.length = rows
    const state = new Int32Array(rows * 5).fill(-2)
    this.state = state
    this.force = true
  }

  // ---- writing

  /** Queues output, a string or UTF-8 bytes, parsed in slices; `cb` runs once its chunk is parsed. */
  write(data, cb) {
    if (typeof data !== 'string') data = this.decoder.decode(data, { stream: true })
    this.queue.push(data, cb)
    if (this.queue.length !== 2) return
    if (this.typed) {
      this.typed = false
      return this.drain()
    }
    setTimeout(this.drain)
  }

  drain = () => {
    const q = this.queue
    const start = performance.now()
    while (this.at < q.length) {
      const i = this.at
      this.vt.write(q[i])
      this.at = i + 2
      q[i + 1]?.()
      if (performance.now() - start >= SLICE_MS) break
    }
    if (this.at < q.length) {
      if (this.at > 100) {
        q.splice(0, this.at)
        this.at = 0
      }
      setTimeout(this.drain)
    } else {
      q.length = 0
      this.at = 0
    }
    this.parsed()
    this.emit('parsed')
  }

  /** What parsing changed beyond the cells: the mouse mode, the buffer in use, and a frame to draw. */
  parsed() {
    const vt = this.vt
    if (vt.mouse !== this.mouseMode) {
      if (this.mouseMode === 'none') this.clearSelection()
      this.mouseMode = vt.mouse
      this.element.classList.toggle('enable-mouse-events', vt.mouse !== 'none')
    }
    if (vt.buffer !== this.shownBuffer) {
      this.shownBuffer = vt.buffer
      this.clearSelection()
      this.clearLink()
      this.force = true
    }
    if (vt.changed) this.refresh()
  }

  /** Text the user typed or pasted, a key, or a mouse report, to the program: the view follows it to the
   * bottom, the selection goes, and the program's answer parses as soon as it comes. */
  input(data) {
    const b = this.vt.buffer
    if (b.ybase !== b.ydisp) this.scrollToBottom()
    if (this.hasSelection()) this.clearSelection()
    this.typed = true
    this.emit('data', data)
  }

  /** Pastes `text` as the program reads a paste: line ends as Enter, bracketed when it asked. */
  paste(text) {
    text = text.replace(/\r?\n/g, '\r')
    this.input(this.vt.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text)
    this.textarea.value = ''
  }

  // ---- frames

  /** Asks for a frame. A synchronized update holds it, up to HOLD_MS; a terminal off screen draws once it shows. */
  refresh() {
    if (this.vt.sync) {
      this.holdTimer ||= setTimeout(() => {
        this.holdTimer = 0
        this.vt.sync = false
        this.refresh()
      }, HOLD_MS)
      return
    }
    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = 0
    }
    if (this.paused) return void (this.missed = true)
    this.frame ||= requestAnimationFrame(this.draw)
  }

  draw = () => {
    this.frame = 0
    if (this.paused || this.vt.sync) return
    this.paint()
    this.emit('render')
  }

  /** Brings every row, the selection, marks, scrollbar and textarea up to date with the screen. */
  paint() {
    const vt = this.vt
    if (this.flat[87] !== this.flat[87]) {
      this.measure([[W, 0, 0]])
      this.setSpacing()
    }
    const b = vt.buffer
    const { cols, rows } = vt
    const top = b.ydisp
    const force = this.force
    this.force = false
    let cy = -1
    let cx = -1
    let look = 0
    if (!vt.cursorHidden && vt.cursorInit) {
      cy = b.ybase + b.y - top
      cx = Math.min(b.x, cols - 1)
      look = this.focused ? (vt.cursorStyle === 'bar' ? 2 : vt.cursorStyle === 'underline' ? 3 : 1) : 4
    }
    const curClass = look === 4 ? OUTLINE : CURSORS[vt.cursorStyle] ?? CURSORS.block
    const range = this.selRange()
    const [sx, sy, ex, ey] = range ?? [0, -1, 0, -1]
    const view = b.trimmed + top
    const state = this.state
    const hover = this.hover
    const dirty = []
    let rebuilt = false
    for (let y = 0; y < rows; y++) {
      const line = b.lines.get(top + y)
      if (!line) continue
      const cur = y === cy ? cx : -1
      let s0 = 0
      let s1 = 0
      if (range) {
        const abs = view + y
        if (abs > sy && abs < ey) s1 = cols
        else if (abs === sy && sy === ey) [s0, s1] = [sx, ex]
        else if (abs === ey && sy < ey) s1 = ex
        else if (abs === sy && sy < ey) [s0, s1] = [sx, cols]
      }
      let h0 = 0
      let h1 = 0
      if (hover) {
        const abs = top + y
        if (abs >= hover.y1 && abs <= hover.y2) [h0, h1] = [abs === hover.y1 ? hover.x1 : 0, abs === hover.y2 ? hover.x2 : cols]
      }
      const k = y * 5
      const curState = cur < 0 ? -1 : cur * 8 + look
      let changed = force | +(state[k] !== curState) | +(state[k + 1] !== s0) | +(state[k + 2] !== s1) | +(state[k + 3] !== h0) | +(state[k + 4] !== h1)
      state[k] = curState
      state[k + 1] = s0
      state[k + 2] = s1
      state[k + 3] = h0
      state[k + 4] = h1
      let cells = copy(line, this.snaps[y], cols)
      if (line.comb || line.ext || this.sigs[y]) {
        const sig = extras(line, cols)
        if (sig !== this.sigs[y]) {
          this.sigs[y] = sig
          cells = true
        }
      }
      if (cells && this.link && top + y >= this.link.range.start.y - 1 && top + y <= this.link.range.end.y - 1) rebuilt = true
      if (changed || cells) dirty.push(y, line, cur, s0, s1, h0, h1)
    }
    const built = []
    let again = null
    const html = i => this.rowHtml(dirty[i + 1], dirty[i + 2], curClass, dirty[i + 3], dirty[i + 4], dirty[i + 5], dirty[i + 6])
    for (let i = 0; i < dirty.length; i += 7) {
      this.unmeasured = false
      built.push(html(i))
      if (this.unmeasured) (again ??= []).push(i)
    }
    if (again) {
      this.measure([...this.pending.values()])
      this.pending.clear()
      for (const i of again) built[i / 7] = html(i)
    }
    for (let i = 0; i < built.length; i++) {
      const y = dirty[i * 7]
      if (built[i] === this.html[y]) continue
      this.html[y] = built[i]
      this.rowEls[y].innerHTML = built[i]
    }
    vt.changed = false
    this.place(view, range, force)
    this.updateBar()
    this.syncTextarea(b.ybase + b.y - top, Math.min(b.x, cols - 1))
    // A link under the pointer whose rows changed, or that scrolled, is asked for again.
    if (this.link && (rebuilt || view !== this.linkView)) this.reaskLink()
    this.linkView = view
  }

  /** Row cells as HTML: cells that draw alike merged into one span, up to the last cell that draws anything.
   * Cells `s0` to `s1` are selected, `h0` to `h1` a hovered link's. */
  rowHtml(line, cur, curClass, s0, s1, h0, h1) {
    const { d, cap: c } = line
    const cols = this.vt.cols
    let n = Math.min(line.getNoBgTrimmedLength(), cols)
    if (cur >= n) n = cur + 1
    const cellW = this.cellW
    const base = this.spacing
    const flat = this.flat
    let out = ''
    let text = ''
    let head = ''
    let open = false
    let pfg = 0
    let pbg = 0
    let pul = 0
    let psp = 0
    let psel = false
    let phov = false
    for (let x = 0; x < n; x++) {
      const content = d[x]
      const w = content >>> 22
      if (!w) continue
      let fg = d[c + x]
      const bg = d[2 * c + x]
      let ch
      let code = content & CP
      if (content & COMBINED) {
        ch = line.comb.get(x)
        if (ch.charCodeAt(0) === 0xdbfb && ch.charCodeAt(1) === 0xdeee) {
          ch = ' '
          fg = 0
        }
        code = -1
      } else if (!code) {
        ch = ' '
        code = 32
      } else if (code === PLACEHOLDER) {
        ch = ' '
        code = 32
        fg = 0
      } else ch = code < 0x10000 ? String.fromCharCode(code) : String.fromCodePoint(code)
      if (fg & INVISIBLE) {
        ch = ' '
        code = 32
      }
      const ext = bg & EXT ? line.ext.get(x) : null
      const uls = ext ? ext.style : 0
      const underline = uls || fg & UNDERLINE
      if (code === 32 && (underline || bg & OVERLINE)) {
        ch = '\xa0'
        code = 0xa0
      }
      const bold = fg & BOLD
      const italic = bg & ITALIC
      let g
      if (code >= 0 && code < 256 && !bold && !italic) {
        g = flat[code]
        if (g !== g) g = this.widthOf(ch, 0, 0)
      } else g = this.widthOf(ch, bold, italic)
      const sp = g < 0 ? base : w * cellW - g
      const sel = x >= s0 && x < s1
      const hov = x >= h0 && x < h1
      const ul = underline ? uls * 0x4000000 + (ext ? ext.ulc : 0) + 1 : 0
      const t = code === 60 ? '&lt;' : code === 38 ? '&amp;' : code === -1 && (ch.includes('<') || ch.includes('&')) ? ch.replace(/&/g, '&amp;').replace(/</g, '&lt;') : ch
      if (open && x !== cur && sel === psel && (sel || bg === pbg) && fg === pfg && ul === pul && sp === psp && hov === phov) {
        text += t
        continue
      }
      if (open) out += head ? head + text + '</span>' : text
      open = x !== cur
      pfg = fg
      pbg = bg
      pul = ul
      psp = sp
      psel = sel
      phov = hov
      let cls = x === cur ? curClass : ''
      let st = ''
      if (bold) cls += ' bold'
      if (italic) cls += ' italic'
      if (bg & DIM) cls += ' dim'
      if (underline) {
        cls += ' u' + uls
        const color = ext?.ulc || (fg & CM ? fg & COLOR : 0)
        if (color) st += `text-decoration-color:${(color & CM) === RGB ? `rgb(${color >> 16 & 255},${color >> 8 & 255},${color & 255})` : css(color, bold)};`
      }
      if (bg & OVERLINE) cls += ' over'
      if (fg & STRIKE) cls += ' strike'
      if (hov) st += 'text-decoration:underline;'
      let f = fg
      let k = bg
      if (fg & INVERSE) {
        f = bg
        k = fg
      }
      if (!sel) {
        const m = k & CM
        if (m === RGB) st += `background-color:${hex(k)};`
        else if (m) cls += ' b' + (k & 0xff)
        else if (fg & INVERSE) cls += ' b257'
      }
      const m = f & CM
      if (m === RGB) st += `color:${hex(f)};`
      else if (m) cls += ' f' + ((f & 0xff) + (bold && (f & 0xff) < 8 ? 8 : 0))
      else if (fg & INVERSE) cls += ' f257'
      if (sp !== base) st += `letter-spacing:${sp}px;`
      if (cls.charCodeAt(0) === 32) cls = cls.slice(1)
      head = cls || st ? `<span${cls ? ` class="${cls}"` : ''}${st ? ` style="${st}"` : ''}>` : ''
      text = t
      if (!open) {
        out += head + text + '</span>'
        text = ''
      }
    }
    if (open) out += head ? head + text + '</span>' : text
    return out
  }

  /** Places what sits under the rows: the selection's boxes and the marks, at the view's first line. */
  place(view, range, force) {
    const { cols, rows } = this.vt
    const { cellW, cellH } = this
    const key = range ? `${range}|${view}|${cellW}|${cellH}` : ''
    if (key !== this.selKey) {
      this.selKey = key
      let html = ''
      if (range) {
        const [sx, sy, ex, ey] = range
        const start = sy - view
        const end = ey - view
        const first = Math.max(start, 0)
        const last = Math.min(end, rows - 1)
        const box = (row, from, to, n = 1) => {
          if (n <= 0) return
          const left = from * cellW
          const width = Math.min(cellW * (to - from), this.canvasW - left)
          html += `<div style="top:${row * cellH}px;left:${left}px;width:${width}px;height:${n * cellH}px"></div>`
        }
        if (first < rows && last >= 0 && (sx !== ex || sy !== ey)) {
          box(first, start === first ? sx : 0, first === end ? ex : cols)
          box(first + 1, 0, cols, last - first - 1)
          if (first !== last) box(last, 0, end === last ? ex : cols)
        }
      }
      this.selLayer.innerHTML = html
    }
    if (view !== this.drawnTop || force) {
      this.drawnTop = view
      for (const m of this.marksList) this.placeMark(m, view)
    }
  }

  // ---- marks

  /** A box over `width` cells of buffer line `y` from cell `x`, under the text, in the buffer now in use; it
   * keeps to its line as the view scrolls. Returns `{ el, dispose }`. */
  mark(y, { x = 0, width = this.vt.cols, className = '' } = {}) {
    const b = this.vt.buffer
    const el = this.marks.appendChild(document.createElement('div'))
    el.className = className
    const m = { el, buffer: b, line: b.trimmed + y, x, width, dispose: () => { el.remove(); this.marksList.delete(m) } }
    this.marksList.add(m)
    this.placeMark(m, b.trimmed + b.ydisp)
    return m
  }

  placeMark(m, view) {
    const y = m.line - view
    const shown = m.buffer === this.vt.buffer && y >= 0 && y < this.vt.rows
    m.el.style.cssText = shown ? `top:${y * this.cellH}px;left:${m.x * this.cellW}px;width:${m.width * this.cellW}px;height:${this.cellH}px` : 'display:none'
  }

  // ---- scrolling

  scrollLines(n) {
    const vt = this.vt
    const before = vt.buffer.ydisp
    vt.scrollLines(n)
    if (vt.buffer.ydisp !== before) {
      this.revealBar()
      this.refresh()
    }
  }

  scrollToBottom() { this.scrollLines(this.vt.buffer.ybase - this.vt.buffer.ydisp) }

  /** The scrollbar's slider, sized and placed as VS Code's: at least 20 px. */
  updateBar() {
    const b = this.vt.buffer
    const visible = this.canvasH
    const total = this.cellH * b.lines.length
    const need = b.ybase > 0
    if (Math.round(this.pos / this.cellH) !== b.ydisp) this.pos = b.ydisp * this.cellH
    let size = 0
    let at = 0
    if (need) {
      size = Math.round(Math.max(20, Math.floor(visible * visible / total)))
      this.ratio = (visible - size) / (total - visible)
      at = Math.round(this.pos * this.ratio)
    }
    const key = need ? `${size}|${at}` : ''
    if (key === this.barKey) return
    this.barKey = key
    this.bar.classList.toggle('need', need)
    if (!need) return
    this.slider.style.cssText = `top:${at}px;height:${size}px`
    this.revealBar() // as VS Code's scrollbar, which nook's xterm had: it shows while the view or its length moves
  }

  revealBar() {
    this.bar.classList.add('on')
    clearTimeout(this.barTimer)
    if (!this.over && !this.barDrag) this.barTimer = setTimeout(() => this.bar.classList.remove('on'), 500)
  }

  /** The wheel over the normal buffer scrolls its scrollback, as VS Code's scrollable element: 50 px a notch,
   * five times that with Alt; Shift turns it sideways, which scrolls nothing. */
  wheelScroll(e) {
    const b = this.vt.buffer
    if (e.shiftKey) return
    let dy = e.wheelDeltaY !== undefined ? e.wheelDeltaY / 120 : e.deltaMode === 1 ? -e.deltaY : -e.deltaY / 40
    if (e.altKey) dy *= 5
    if (!dy) return
    if (Math.round(this.pos / this.cellH) !== b.ydisp) this.pos = b.ydisp * this.cellH
    const delta = 50 * dy
    const pos = Math.max(0, Math.min(b.ybase * this.cellH, this.pos - (delta < 0 ? Math.floor(delta) : Math.ceil(delta))))
    if (pos === this.pos) return
    cancel(e)
    this.scrollTo(pos)
  }

  /** Scrolls to `pos` px, the view landing on the nearest row. */
  scrollTo(pos) {
    this.pos = pos
    const row = Math.round(pos / this.cellH)
    const diff = row - this.vt.buffer.ydisp
    if (diff) this.scrollLines(diff)
    else this.revealBar()
    this.pos = pos
    this.barKey = ''
    this.updateBar()
  }

  // ---- input

  focus() { this.textarea.focus({ preventScroll: true }) }

  /** The cursor shows from the first focus, key, or buffer switch. */
  showCursor() {
    if (this.vt.cursorInit) return
    this.vt.cursorInit = true
    this.refresh()
  }

  /** The textarea sits on the cursor's cell, so an IME opens there. */
  syncTextarea(cy, cx) {
    if (this.composing || cy < 0 || cy >= this.vt.rows) return
    const b = this.vt.buffer
    const line = b.lines.get(b.ybase + b.y)
    const w = (line?.getCell(cx)?.getWidth() ?? 1) * this.cellW
    const key = `${cx}|${cy}|${w}|${this.cellH}`
    if (key === this.areaKey) return
    this.areaKey = key
    const s = this.textarea.style
    s.left = `${cx * this.cellW}px`
    s.top = `${cy * this.cellH}px`
    s.width = `${w}px`
    s.height = s.lineHeight = `${this.cellH}px`
    s.zIndex = '-5'
  }

  keydown = e => {
    this.keyDownHandled = false
    this.keyDownSeen = true
    if (this.keys?.(e) === false) return
    if (!this.compositionKey(e)) {
      const b = this.vt.buffer
      if (b.ybase !== b.ydisp) this.scrollToBottom()
      return
    }
    if (e.key === 'Dead' || e.key === 'AltGraph') this.deadKey = true
    const { key, cancel: stop, page } = keyData(e, this.vt.appCursor)
    if (page) {
      this.scrollLines(page * (this.vt.rows - 1))
      return cancel(e)
    }
    if (thirdLevel(e) && (!e.keyCode || e.keyCode > 47)) return
    if (stop) cancel(e)
    if (!key) return
    // A–Z wait for keypress, which has Caps Lock's case.
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1 && e.key >= 'A' && e.key <= 'Z') return
    if (this.deadKey) {
      this.deadKey = false
      return
    }
    if (key === '\x03' || key === '\r') this.textarea.value = ''
    this.showCursor()
    this.input(key)
    cancel(e)
  }

  keypress = e => {
    this.keyPressHandled = false
    if (this.keyDownHandled) return
    const code = e.charCode
    if (!code || ((e.altKey || e.ctrlKey || e.metaKey) && !thirdLevel(e))) return
    this.showCursor()
    this.input(String.fromCharCode(code))
    this.keyPressHandled = true
    this.deadKey = false
  }

  keyup = e => {
    this.keyDownSeen = false
    if (e.keyCode !== 16 && e.keyCode !== 17 && e.keyCode !== 18) this.focus()
    this.keyPressHandled = false
  }

  /** Typed text the keys didn't send: emoji panel, dead keys, AltGr. */
  inputEvent = e => {
    if (!e.data || e.inputType !== 'insertText' || (e.composed && this.keyDownSeen) || this.keyPressHandled) return
    this.deadKey = false
    this.input(e.data)
  }

  // IME composition, as xterm's CompositionHelper: the composing text shows at the cursor and goes out whole.
  compositionstart = () => {
    this.composing = true
    this.compStart = this.textarea.value.length
    this.compView.textContent = ''
    this.alreadySent = ''
    this.compView.classList.add('active')
  }

  compositionupdate = e => {
    this.compView.textContent = e.data
    this.placeComposition()
    setTimeout(() => { this.compEnd = this.textarea.value.length })
  }

  compositionend = () => this.finishComposition(true)

  /** Whether a keydown goes on to the key table; false for keys the IME takes. */
  compositionKey(e) {
    if (this.composing || this.sendingComposition) {
      if (e.keyCode === 20 || e.keyCode === 229 || e.keyCode === 16 || e.keyCode === 17 || e.keyCode === 18) return false
      this.finishComposition(false)
    }
    if (e.keyCode !== 229) return true
    // An IME key outside a composition: send what it changed in the textarea.
    const old = this.textarea.value
    setTimeout(() => {
      if (this.composing) return
      const now = this.textarea.value
      const diff = now.replace(old, '')
      this.alreadySent = diff
      if (now.length > old.length) this.input(diff)
      else if (now.length < old.length) this.input('\x7f')
      else if (now !== old) this.input(now)
    })
    return false
  }

  finishComposition(later) {
    this.compView.classList.remove('active')
    this.composing = false
    const ta = this.textarea
    if (!later) {
      this.sendingComposition = false
      this.input(ta.value.substring(this.compStart, this.compEnd))
      return
    }
    const from = this.compStart
    this.sendingComposition = true
    setTimeout(() => {
      if (!this.sendingComposition) return
      this.sendingComposition = false
      const start = from + this.alreadySent.length
      const text = this.composing ? ta.value.substring(start, this.compStart) : ta.value.substring(start)
      if (text) this.input(text)
    })
  }

  placeComposition(again) {
    if (!this.composing) return
    const b = this.vt.buffer
    const y = b.ybase + b.y - b.ydisp
    if (y >= 0 && y < this.vt.rows) {
      const left = `${Math.min(b.x, this.vt.cols - 1) * this.cellW}px`
      const top = `${y * this.cellH}px`
      const v = this.compView.style
      Object.assign(v, { left, top, height: `${this.cellH}px`, lineHeight: `${this.cellH}px` })
      const box = this.compView.getBoundingClientRect()
      Object.assign(this.textarea.style, { left, top, width: `${Math.max(box.width, 1)}px`, height: `${Math.max(box.height, 1)}px`, lineHeight: `${box.height}px` })
    }
    if (!again) setTimeout(() => this.placeComposition(true))
  }

  // ---- mouse

  /** Where the client point (x, y) lands on the screen, in px from its corner. The composer replaces this to
   * send a point over the rows it raised to the rows they are. */
  mapPoint(x, y) { return [x, y] }

  point(e) {
    const [x, y] = this.mapPoint(e.clientX, e.clientY)
    const r = this.screen.getBoundingClientRect()
    return [x - r.left, y - r.top]
  }

  /** The 1-based cell under `e`, as xterm's getCoords; `half` rounds to the nearer cell edge, for selections. */
  cell(e, half = false) {
    if (!this.cellW) return null
    const [px, py] = this.point(e)
    const x = Math.ceil((px + (half ? this.cellW / 2 : 0)) / this.cellW)
    const y = Math.ceil(py / this.cellH)
    return [Math.min(Math.max(x, 1), this.vt.cols + (half ? 1 : 0)), Math.min(Math.max(y, 1), this.vt.rows)]
  }

  /** Reports a mouse event to the program as SGR, under xterm's rules for each tracking mode. */
  report(e, type) {
    const vt = this.vt
    if (vt.mouse === 'none' || vt.mouseEncoding === 'default') return
    let [px, py] = this.point(e)
    px = Math.min(Math.max(px, 0), this.canvasW - 1)
    py = Math.min(Math.max(py, 0), this.canvasH - 1)
    const col = Math.floor(px / this.cellW)
    const row = Math.floor(py / this.cellH)
    const x = Math.floor(px)
    const y = Math.floor(py)
    let button
    let action // 0 up, 1 down, 32 move
    if (type === 'move') {
      action = 32
      button = e.buttons & 1 ? 0 : e.buttons & 4 ? 1 : e.buttons & 2 ? 2 : 3
    } else if (type === 'wheel') {
      button = 4
      action = e.deltaY < 0 ? 0 : 1
    } else {
      action = type === 'down' ? 1 : 0
      button = e.button < 3 ? e.button : 3
      if (button === 3) return
    }
    let mods = (e.ctrlKey ? 16 : 0) | (e.shiftKey ? 4 : 0) | (e.altKey ? 8 : 0)
    const pixels = vt.mouseEncoding === 'sgr-pixels'
    const last = this.lastReport
    if (action === 32 && last && last.button === button && last.action === 32 && last.mods === mods
      && (pixels ? last.x === x && last.y === y : last.col === col && last.row === row)) return
    const mode = vt.mouse
    if (mode === 'x10') {
      if (button === 4 || action !== 1) return
      mods = 0
    } else if (mode === 'vt200') {
      if (action === 32) return
    } else if (mode === 'drag' && action === 32 && button === 3) return
    const code = mods | (button === 4 ? 64 | action : (button & 3) | (action === 32 ? 32 : 0))
    const end = action === 0 && button !== 4 ? 'm' : 'M'
    this.lastReport = { col, row, x, y, button, action, mods }
    this.input(`\x1b[<${code};${pixels ? `${x};${y}` : `${col + 1};${row + 1}`}${end}`)
  }

  /** The wheel's lines for one event, as xterm counts them for the program: a part of a line waits. */
  wheelLines(e) {
    if (!e.deltaY || e.shiftKey) return 0
    let n = e.deltaY * (e.altKey || e.ctrlKey ? 5 : 1)
    if (e.deltaMode === 0) {
      n /= this.devCellH / devicePixelRatio
      if (Math.abs(e.deltaY) < 50) n *= 0.3
      this.partial += n
      n = Math.trunc(this.partial)
      this.partial %= 1
    } else if (e.deltaMode === 2) n *= this.vt.rows
    return n
  }

  /** A wheel turn: to the program while it tracks the mouse, as arrow keys on the alternate screen, or scrolling
   * the scrollback. The composer hands over the turns over its card. */
  wheel(e) {
    const vt = this.vt
    if (vt.mouse !== 'none' && vt.mouse !== 'x10') {
      if (this.wheelLines(e)) this.report(e, 'wheel')
      return cancel(e)
    }
    if (vt.buffer === vt.alt) {
      if (!e.deltaY) return
      if (this.wheelLines(e)) this.input(`\x1b${vt.appCursor ? 'O' : '['}${e.deltaY < 0 ? 'A' : 'B'}`)
      return cancel(e)
    }
    this.wheelScroll(e)
  }

  mousedown = e => {
    if (this.bar.contains(e.target)) return
    this.selectDown(e)
    e.preventDefault()
    this.focus()
    if (this.vt.mouse === 'none' || e.shiftKey) return
    this.report(e, 'down')
    // The press goes on outside the terminal.
    document.addEventListener('mouseup', this.reportUp)
    document.addEventListener('mousemove', this.reportDrag)
  }

  reportUp = e => {
    this.report(e, 'up')
    if (e.buttons) return
    document.removeEventListener('mouseup', this.reportUp)
    document.removeEventListener('mousemove', this.reportDrag)
  }

  reportDrag = e => { if (e.buttons) this.report(e, 'move') }

  mousemove = e => {
    if (this.vt.mouse === 'any' && !e.buttons) this.report(e, 'move')
  }

  // ---- selection

  hasSelection() {
    const s = this.selEnds()
    return !!s && (s[0] !== s[2] || s[1] !== s[3])
  }

  /** The selection's ends, ordered, as [startX, startLine, endX, endLine] with lines counted for good, or null. */
  selEnds() {
    const { start, end, len } = this.sel
    if (!start) return null
    const cols = this.vt.cols
    const reversed = end && (start[1] > end[1] || (start[1] === end[1] && start[0] > end[0]))
    const from = end && reversed ? end : start
    if (!end || reversed) {
      const reach = start[0] + len
      if (reach > cols) {
        if (reach % cols === 0) return [...from, cols, start[1] + reach / cols - 1]
        return [...from, reach % cols, start[1] + Math.floor(reach / cols)]
      }
      return [...from, reach, start[1]]
    }
    if (len && end[1] === start[1]) {
      const reach = start[0] + len
      if (reach > cols) return [...from, reach % cols, start[1] + Math.floor(reach / cols)]
      return [...from, Math.max(reach, end[0]), end[1]]
    }
    return [...from, ...end]
  }

  /** The selection to draw: its ends, or null when it selects nothing. */
  selRange() {
    const s = this.selEnds()
    return s && (s[0] !== s[2] || s[1] !== s[3]) ? s : null
  }

  getSelection() {
    const s = this.selRange()
    if (!s) return ''
    const b = this.vt.buffer
    const t = b.trimmed
    const [sx, sy, ex, ey] = s
    const text = (y, from, to) => b.getLine(y - t)?.translateToString(true, from, to) ?? ''
    const out = [text(sy, sx, sy === ey ? ex : undefined)]
    for (let y = sy + 1; y <= ey; y++) {
      const part = y === ey ? text(y, 0, ex) : text(y)
      if (b.getLine(y - t)?.isWrapped) out[out.length - 1] += part
      else out.push(part)
    }
    return out.map(l => l.replace(/\xa0/g, ' ')).join(WINDOWS ? '\r\n' : '\n')
  }

  /** The selection in buffer lines, end exclusive, as xterm's getSelectionPosition. */
  getSelectionPosition() {
    const s = this.selRange()
    if (!s) return undefined
    const t = this.vt.buffer.trimmed
    return { start: { x: s[0], y: s[1] - t }, end: { x: s[2], y: s[3] - t } }
  }

  /** Selects `len` cells from cell `col` of buffer line `row`, running on across rows. */
  select(col, row, len) {
    this.stopSelecting()
    this.sel = { start: [col, this.vt.buffer.trimmed + row], end: null, len, mode: 0 }
    this.refresh()
  }

  clearSelection() {
    this.stopSelecting()
    if (!this.sel.start) return
    this.sel = { start: null, end: null, len: 0, mode: 0 }
    this.refresh()
  }

  /** The cell under `e` for a selection, as [x, line counted for good]. */
  selCell(e) {
    const c = this.cell(e, true)
    if (!c) return null
    const b = this.vt.buffer
    return [c[0] - 1, b.trimmed + b.ydisp + c[1] - 1]
  }

  selectDown(e) {
    this.downAt = e.timeStamp
    if (e.button !== 0) return
    const tracking = this.vt.mouse !== 'none'
    if (tracking) {
      if (!e.shiftKey) return
      e.stopPropagation()
    }
    e.preventDefault()
    this.dragScroll = 0
    const s = this.sel
    if (!tracking && e.shiftKey) {
      if (s.start) s.end = this.selCell(e)
    } else if (e.detail === 2) this.selectWordAt(e)
    else if (e.detail === 3) {
      const at = this.selCell(e)
      if (at) this.selectLineAt(at[1])
    } else {
      const at = this.selCell(e)
      this.sel = { start: at, end: null, len: 0, mode: 0 }
      if (at) {
        const line = this.lineAt(at[1])
        if (line && at[0] < line.length && line.getCell(at[0]).getWidth() === 0) at[0]++
      }
    }
    document.addEventListener('mousemove', this.selectMove)
    document.addEventListener('mouseup', this.selectUp)
    this.dragTimer = setInterval(this.selectScroll, 50)
    this.refresh()
  }

  stopSelecting() {
    document.removeEventListener('mousemove', this.selectMove)
    document.removeEventListener('mouseup', this.selectUp)
    clearInterval(this.dragTimer)
    this.dragTimer = 0
  }

  lineAt(abs) { return this.vt.buffer.getLine(abs - this.vt.buffer.trimmed) }

  selectMove = e => {
    e.stopImmediatePropagation()
    const s = this.sel
    if (!s.start) return
    const before = s.end && s.end.join()
    s.end = this.selCell(e)
    if (!s.end) return this.refresh()
    const cols = this.vt.cols
    if (s.mode === 2) s.end[0] = s.end[1] < s.start[1] ? 0 : cols
    else if (s.mode === 1) this.selectToWord(s.end)
    // Past the screen's top or bottom edge, the view scrolls, faster the further out the pointer is.
    const py = this.point(e)[1]
    let off = py < 0 ? py : py > this.canvasH ? py - this.canvasH : 0
    if (off) {
      off = Math.min(Math.max(off, -50), 50) / 50
      this.dragScroll = Math.sign(off) + Math.round(off * 14)
      s.end[0] = this.dragScroll > 0 ? cols : 0
    } else this.dragScroll = 0
    const line = this.lineAt(s.end[1])
    if (line && s.end[0] < line.length && line.getCell(s.end[0]).getWidth() === 0 && s.end[0] < cols) s.end[0]++
    if (s.end.join() !== before) this.refresh()
  }

  selectScroll = () => {
    const s = this.sel
    if (!s.start || !s.end || !this.dragScroll) return
    this.scrollLines(this.dragScroll)
    const b = this.vt.buffer
    if (this.dragScroll > 0) s.end = [this.vt.cols, b.trimmed + Math.min(b.ydisp + this.vt.rows, b.lines.length - 1)]
    else s.end = [0, b.trimmed + b.ydisp]
    this.refresh()
  }

  selectUp = e => {
    const elapsed = e.timeStamp - this.downAt
    this.stopSelecting()
    // Alt+click moves the prompt's cursor to the cell, with arrow keys.
    const b = this.vt.buffer
    if (this.getSelection().length <= 1 && elapsed < 500 && e.altKey && b.ybase === b.ydisp) {
      const c = this.cell(e)
      if (c) this.input(this.moveTo(c[0] - 1, c[1] - 1))
    }
  }

  /** Arrow keys that move the cursor to cell (x, y) of the screen, along the text as a shell's line editor does. */
  moveTo(x, y) {
    const b = this.vt.buffer
    const arrow = d => `\x1b${this.vt.appCursor ? 'O' : '['}${d}`
    if (y === b.y) return arrow(b.x > x ? 'D' : 'C').repeat(Math.abs(b.x - x))
    const up = b.y > y
    const n = this.vt.cols - (up ? x : b.x) + (Math.abs(b.y - y) - 1) * this.vt.cols + 1 + (up ? b.x : x) - 1
    return arrow(up ? 'D' : 'C').repeat(Math.max(0, n))
  }

  /** Whether `cell` ends a word: a separator, or an empty cell. */
  separates(line, x) {
    const c = line.getCell(x)
    return !!c && c.getWidth() !== 0 && SEPARATORS.includes(c.getChars())
  }

  /** The word at cell `x` of line `abs`, as { start, length } in cells, following wrapped rows; start may be
   * negative, reaching into the rows above. A run of blanks is a word when `blanks`. */
  wordAt(x, abs, blanks, above = true, below = true) {
    const cols = this.vt.cols
    const line = this.lineAt(abs)
    if (x >= cols || !line) return null
    const blank = i => !(line.getCell(i)?.getChars().trim())
    let start = x
    let end = x
    if (blank(x) && line.getCell(x).getWidth()) {
      while (start > 0 && blank(start - 1) && line.getCell(start - 1).getWidth()) start--
      while (end + 1 < line.length && blank(end + 1)) end++
    } else {
      if (line.getCell(start).getWidth() === 0) start--
      while (start > 0 && !this.separates(line, start - 1)) start--
      while (end + 1 < line.length && !this.separates(line, end + 1)) end++
    }
    let length = Math.min(cols, end + 1 - start)
    if (!blanks && !line.translateToString(false, start, end + 1).trim()) return null
    if (above && start === 0 && line.isWrapped && line.getCell(0).getChars() !== ' ') {
      const prev = this.lineAt(abs - 1)
      if (prev && prev.getCell(cols - 1)?.getChars() !== ' ') {
        const w = this.wordAt(cols - 1, abs - 1, false, true, false)
        if (w) {
          start -= cols - w.start
          length += cols - w.start
        }
      }
    }
    if (below && start + length === cols && line.getCell(cols - 1)?.getChars() !== ' ') {
      const next = this.lineAt(abs + 1)
      if (next?.isWrapped && next.getCell(0).getChars() !== ' ') {
        const w = this.wordAt(0, abs + 1, false, false, true)
        if (w) length += w.length
      }
    }
    return { start, length }
  }

  selectWordAt(e) {
    const r = this.link?.range
    if (r) {
      const cols = this.vt.cols
      const t = this.vt.buffer.trimmed
      this.sel = { start: [r.start.x - 1, t + r.start.y - 1], end: null, len: (r.end.y - r.start.y) * cols + r.end.x - r.start.x + 1, mode: 1 }
      return
    }
    const at = this.selCell(e)
    const w = at && this.wordAt(at[0], at[1], true)
    if (!w) return
    let y = at[1]
    while (w.start < 0) {
      w.start += this.vt.cols
      y--
    }
    this.sel = { start: [w.start, y], end: null, len: w.length, mode: 1 }
  }

  selectToWord(end) {
    const w = this.wordAt(end[0], end[1], true)
    if (!w) return
    const s = this.sel
    const cols = this.vt.cols
    let y = end[1]
    while (w.start < 0) {
      w.start += cols
      y--
    }
    const reversed = y < s.start[1] || (y === s.start[1] && w.start < s.start[0])
    if (!reversed) {
      while (w.start + w.length > cols) {
        w.length -= cols
        y++
      }
    }
    s.end = [reversed ? w.start : w.start + w.length, y]
  }

  /** Selects line `abs` with the rows it wraps onto and from. */
  selectLineAt(abs) {
    let first = abs
    let last = abs
    while (this.lineAt(first)?.isWrapped && first > 0) first--
    while (this.lineAt(last + 1)?.isWrapped) last++
    this.sel = { start: [0, first], end: null, len: (last - first + 1) * this.vt.cols, mode: 2 }
  }

  // ---- links

  /** Registers a provider of links, `{ provideLinks(y, cb) }` with `y` the 1-based buffer line, ranked below
   * those before it. Returns `{ dispose }`. */
  registerLinkProvider(provider) {
    this.providers.push(provider)
    return { dispose: () => { const i = this.providers.indexOf(provider); if (i >= 0) this.providers.splice(i, 1) } }
  }

  /** The OSC 8 hyperlinks on 1-based buffer line `y`. */
  hyperlinks(y) {
    const vt = this.vt
    const line = vt.buffer.getLine(y - 1)
    if (!line) return undefined
    const links = []
    const n = line.getTrimmedLength()
    const cell = this.cellRead
    let id = 0
    let from = -1
    for (let x = 0; x <= n; x++) {
      const at = x < n ? line.getCell(x, cell).getLink() : 0
      if (at === id) continue
      const uri = id && vt.linkUri(id)
      if (uri) {
        const range = { start: { x: from + 1, y }, end: { x, y } }
        links.push({ text: uri, range, activate: () => this.openLink?.(uri) })
      }
      id = at
      from = x
    }
    return links
  }

  linkMove = e => {
    this.lastMove = e
    const c = this.cell(e)
    if (!c) return
    this.mouseOut = false
    const pos = { x: c[0], y: c[1] + this.vt.buffer.ydisp }
    if (this.lastCell && pos.x === this.lastCell.x && pos.y === this.lastCell.y) return
    this.lastCell = pos
    if (this.linkLine !== pos.y || this.linkResized) {
      this.clearLink()
      this.askLink(pos, false)
      this.linkResized = false
    } else if (!(this.link && inLink(this.link, pos, this.vt.cols))) {
      this.clearLink()
      this.askLink(pos, true)
    }
  }

  linkLeave = () => {
    this.mouseOut = true
    this.clearLink()
  }

  /** Asks each provider for links on the pointer's line, or uses the replies it has; the highest-ranked link
   * under the pointer wins, and lower-ranked links that overlap a higher one are dropped. */
  askLink(pos, cached) {
    if (!this.replies || !cached) {
      this.replies = new Map()
      this.linkLine = pos.y
    }
    const replies = this.replies
    const providers = [...this.providers]
    let found = false
    providers.forEach((p, i) => {
      if (cached) {
        if (replies.get(i)) found = this.checkLinks(i, pos, found, providers.length)
        return
      }
      p.provideLinks(pos.y, links => {
        if (this.mouseOut || this.replies !== replies) return
        replies.set(i, links)
        found = this.checkLinks(i, pos, found, providers.length)
        if (replies.size === providers.length) dropOverlaps(pos.y, replies, this.vt.cols)
      })
    })
  }

  checkLinks(i, pos, found, count) {
    const replies = this.replies
    const cols = this.vt.cols
    let before = false
    for (let j = 0; j < i; j++) if (!replies.has(j) || replies.get(j)) before = true
    const links = replies.get(i)
    if (!before && links) {
      const hit = links.find(l => inLink(l, pos, cols))
      if (hit) {
        found = true
        this.hoverLink(hit)
      }
    }
    if (replies.size === count && !found) {
      for (let j = 0; j < count; j++) {
        const hit = replies.get(j)?.find(l => inLink(l, pos, cols))
        if (hit) {
          found = true
          this.hoverLink(hit)
          break
        }
      }
    }
    return found
  }

  hoverLink(link) {
    const e = this.lastMove
    if (!e) return
    const c = this.cell(e)
    if (!c || !inLink(link, { x: c[0], y: c[1] + this.vt.buffer.ydisp }, this.vt.cols)) return
    this.link = link
    const deco = link.decorations
    link.state = deco ? { underline: deco.underline, pointer: deco.pointerCursor } : { underline: true, pointer: true }
    if (link.state.underline) this.setHover(link)
    if (link.state.pointer) this.screen.classList.add('xterm-cursor-pointer')
    link.hover?.(e, link.text)
  }

  clearLink() {
    const link = this.link
    if (!link) return
    this.link = null
    this.setHover(null)
    if (link.state?.pointer) this.screen.classList.remove('xterm-cursor-pointer')
    link.leave?.(this.lastMove, link.text)
  }

  /** The hovered link's rows changed, or the view moved: it leaves, and the pointer's line is asked again. */
  reaskLink() {
    this.clearLink()
    if (!this.lastMove || this.mouseOut) return
    const c = this.cell(this.lastMove)
    if (c) this.askLink({ x: c[0], y: c[1] + this.vt.buffer.ydisp }, false)
  }

  /** Underlines a link's cells, as text; null takes it away. */
  setHover(link) {
    if (!link && !this.hover) return
    const r = link?.range
    this.hover = r ? { y1: r.start.y - 1, x1: r.start.x - 1, y2: r.end.y - 1, x2: r.end.x } : null
    this.refresh()
  }

  linkDown = () => { this.downLink = this.link }

  linkUp = e => {
    const link = this.link
    if (!link || !this.downLink || !sameLink(this.downLink, link)) return
    const c = this.cell(e)
    if (c && inLink(link, { x: c[0], y: c[1] + this.vt.buffer.ydisp }, this.vt.cols)) link.activate(e, link.text)
  }

  // ---- wiring

  bind() {
    const ta = this.textarea
    const el = this.element
    ta.addEventListener('keydown', this.keydown, true)
    ta.addEventListener('keypress', this.keypress, true)
    ta.addEventListener('keyup', this.keyup, true)
    ta.addEventListener('input', this.inputEvent, true)
    ta.addEventListener('compositionstart', this.compositionstart)
    ta.addEventListener('compositionupdate', this.compositionupdate)
    ta.addEventListener('compositionend', this.compositionend)
    ta.addEventListener('focus', () => {
      this.focused = true
      el.classList.add('focus')
      this.vt.focus(true)
      this.showCursor()
      this.refresh()
    })
    ta.addEventListener('blur', () => {
      this.focused = false
      ta.value = ''
      this.vt.focus(false)
      el.classList.remove('focus')
      this.refresh()
    })
    const paste = e => {
      e.stopPropagation()
      e.preventDefault()
      if (e.clipboardData) this.paste(e.clipboardData.getData('text/plain'))
    }
    ta.addEventListener('paste', paste)
    el.addEventListener('paste', paste)
    el.addEventListener('copy', e => {
      if (!this.hasSelection()) return
      e.clipboardData.setData('text/plain', this.getSelection())
      e.preventDefault()
    })
    el.addEventListener('mousedown', this.mousedown)
    el.addEventListener('mousemove', this.mousemove)
    el.addEventListener('wheel', e => this.wheel(e), { passive: false })
    el.addEventListener('mouseover', () => {
      this.over = true
      if (this.bar.classList.contains('need')) this.revealBar()
    })
    el.addEventListener('mouseleave', () => {
      this.over = false
      if (!this.barDrag) this.revealBar()
    })
    const s = this.screen
    s.addEventListener('mousemove', this.linkMove)
    s.addEventListener('mouseleave', this.linkLeave)
    s.addEventListener('mousedown', this.linkDown)
    s.addEventListener('mouseup', this.linkUp)
    this.bar.addEventListener('mousedown', this.barDown)
    this.seen = new IntersectionObserver(entries => {
      this.paused = !entries.at(-1).isIntersecting
      if (!this.paused && this.missed) {
        this.missed = false
        this.force = true
        this.refresh()
      }
    })
    this.seen.observe(s)
    this.watchDpr()
  }

  /** Dragging the slider scrolls; a press beside it jumps there first. */
  barDown = e => {
    if (e.button !== 0 || !this.bar.classList.contains('need')) return
    cancel(e)
    const top = this.bar.getBoundingClientRect().top
    if (e.target !== this.slider) {
      const size = this.slider.offsetHeight
      this.scrollTo(this.clampPos(Math.round((e.clientY - top - size / 2) / this.ratio)))
    }
    const from = e.clientY
    const start = this.pos
    this.barDrag = true
    this.slider.classList.add('active')
    const move = m => this.scrollTo(this.clampPos(start + (m.clientY - from) / this.ratio))
    const up = () => {
      this.barDrag = false
      this.slider.classList.remove('active')
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      this.revealBar()
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  clampPos(pos) { return Math.max(0, Math.min(this.vt.buffer.ybase * this.cellH, pos)) }

  /** A change of device pixel ratio, as when the window moves to another screen, measures again. */
  watchDpr() {
    const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
    const change = () => {
      if (this.disposed) return
      this.flat.fill(NaN)
      this.widths.clear()
      this.dims()
      this.refresh()
      this.watchDpr()
    }
    query.addEventListener('change', change, { once: true })
  }

  dispose() {
    this.disposed = true
    this.stopSelecting()
    document.removeEventListener('mouseup', this.reportUp)
    document.removeEventListener('mousemove', this.reportDrag)
    clearTimeout(this.holdTimer)
    clearTimeout(this.barTimer)
    cancelAnimationFrame(this.frame)
    this.seen.disconnect()
    this.queue.length = 0
    this.element.remove()
  }
}

/** Whether the Windows AltGr (Ctrl+Alt) is down: the browser types the character. */
const thirdLevel = e => WINDOWS && ((e.altKey && e.ctrlKey && !e.metaKey) || e.getModifierState('AltGraph'))

/** Copies `line`'s cells into `snap` when they differ from it; returns whether they did. */
function copy(line, snap, cols) {
  const { d, cap: c } = line
  const n = Math.min(line.length, cols)
  let x = 0
  while (x < n && d[x] === snap[x] && d[c + x] === snap[cols + x] && d[2 * c + x] === snap[2 * cols + x]) x++
  if (x === cols) return false
  snap.set(d.subarray(0, n))
  snap.set(d.subarray(c, c + n), cols)
  snap.set(d.subarray(2 * c, 2 * c + n), 2 * cols)
  if (n < cols) {
    snap.fill(1 << 22, n, cols)
    snap.fill(0, cols + n, 2 * cols)
    snap.fill(0, 2 * cols + n, 3 * cols)
  }
  return true
}

/** A row's graphemes and extras as one string, to see a change the cells' words don't show. */
function extras(line, cols) {
  let s = ''
  if (line.comb) for (const [x, v] of line.comb) if (x < cols) s += x + v + '\0'
  if (line.ext) for (const [x, e] of line.ext) if (x < cols) s += `${x},${e.ul},${e.ulc},${e.url};`
  return s
}

function inLink(link, pos, cols) {
  const { start, end } = link.range
  const at = pos.y * cols + pos.x
  return start.y * cols + start.x <= at && at <= end.y * cols + end.x
}

function sameLink(a, b) {
  const [p, q] = [a.range, b.range]
  return a.text === b.text && p.start.x === q.start.x && p.start.y === q.start.y && p.end.x === q.end.x && p.end.y === q.end.y
}

/** Drops each link that overlaps one ranked above it. */
function dropOverlaps(y, replies, cols) {
  const taken = new Set()
  for (let i = 0; i < replies.size; i++) {
    const links = replies.get(i)
    if (!links) continue
    for (let k = 0; k < links.length; k++) {
      const { start, end } = links[k].range
      const from = start.y < y ? 0 : start.x
      const to = end.y > y ? cols : end.x
      for (let x = from; x <= to; x++) {
        if (taken.has(x)) {
          links.splice(k--, 1)
          break
        }
        taken.add(x)
      }
    }
  }
}
