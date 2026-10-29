// File tabs' richer views, loaded the first time one opens: a table for CSV and TSV, a picture that zooms and
// pans, SVG and HTML drawn from the editor's text, audio and video, and PDF.
import { convertFileSrc } from '@tauri-apps/api/core'
import { el } from './ui.js'
import { path as paths } from './paths.js'
import { parse, separator, numeric, compareFields } from './delimited.js'
import { pageUrl } from './pictures.js'

const AUDIO = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus)$/i

// ——— Pictures ———

/**
 * A picture that fits the tab until you zoom: the wheel zooms around the pointer, a drag pans, a double-click
 * swaps fitting for actual size, and 0, 1, + and - do the same from the keyboard. `src` is a URL.
 */
export function picture(src) {
  const box = el('div', { className: 'zoom', tabIndex: -1 })
  const img = el('img', { alt: '', draggable: false })
  const badge = el('span', { className: 'badge' })
  box.append(img, badge)
  let fit = true
  let scale = 1
  let x = 0
  let y = 0
  let w = 0
  let h = 0

  const fitScale = () => Math.min(1, (box.clientWidth - 48) / w, (box.clientHeight - 48) / h) || 1
  function place() {
    if (!w) return
    if (fit) {
      scale = fitScale()
      x = (box.clientWidth - w * scale) / 2
      y = (box.clientHeight - h * scale) / 2
    }
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    // Past 200% the pixels show as squares, as an image editor shows them.
    img.classList.toggle('pixels', scale >= 2)
    badge.textContent = `${w} × ${h} · ${Math.round(scale * 100)}%${fit ? ' · fit' : ''}`
  }

  /** Zooms to `next`, keeping the picture's point under (px, py) where it is. */
  function zoom(next, px = box.clientWidth / 2, py = box.clientHeight / 2) {
    next = Math.min(32, Math.max(0.02, next))
    x = px - ((px - x) * next) / scale
    y = py - ((py - y) * next) / scale
    scale = next
    fit = false
    place()
  }

  img.onload = () => {
    ;[w, h] = [img.naturalWidth || 300, img.naturalHeight || 150]
    place()
  }
  img.onerror = () => { badge.textContent = "nook can't draw this picture" }
  img.src = src

  box.addEventListener('wheel', e => {
    e.preventDefault()
    const r = box.getBoundingClientRect()
    zoom(scale * Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 33 : 1)), e.clientX - r.left, e.clientY - r.top)
  }, { passive: false })
  box.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    box.setPointerCapture(e.pointerId)
    const [x0, y0, sx, sy] = [e.clientX, e.clientY, x, y]
    box.onpointermove = m => {
      fit = false
      x = sx + m.clientX - x0
      y = sy + m.clientY - y0
      place()
    }
    box.onlostpointercapture = () => { box.onpointermove = null }
  })
  box.addEventListener('dblclick', e => {
    if (fit || Math.abs(scale - fitScale()) > 0.001) { fit = true; place() } else {
      const r = box.getBoundingClientRect()
      zoom(1, e.clientX - r.left, e.clientY - r.top)
    }
  })
  box.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey) return
    if (e.key === '0') { fit = true; place() } else if (e.key === '1') zoom(1)
    else if (e.key === '+' || e.key === '=') zoom(scale * 1.25)
    else if (e.key === '-') zoom(scale / 1.25)
    else return
    e.preventDefault()
  })
  // Fitting follows the tab's size. Nothing is observed while the tab is hidden, since its size doesn't change.
  new ResizeObserver(() => fit && place()).observe(box)
  return {
    el: box,
    /** Shows another URL in place, keeping the zoom, as an edited SVG redraws. */
    set(next) { if (img.src !== next) img.src = next },
  }
}

/** SVG drawn from `text`. In an <img>, an SVG runs no script and loads nothing. */
export function svg() {
  let url = ''
  const view = picture('')
  return {
    el: view.el,
    update(text) {
      const was = url
      url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
      view.set(url)
      if (was) setTimeout(() => URL.revokeObjectURL(was), 1000)
    },
    close: () => url && URL.revokeObjectURL(url),
  }
}

/** An HTML page drawn from the editor's text, so unsaved edits show, in a frame that runs no script, sends no
 * form, and opens nothing. A <base> put first points its relative links beside the file at `path`. */
export function html(path) {
  const frame = el('iframe', { title: paths.basename(path) })
  frame.setAttribute('sandbox', '') // set before the page, so it loads sandboxed
  const base = `<base href="${pageUrl(path)}">` // pageUrl encodes every quote and angle bracket
  return {
    el: frame,
    update(text) {
      const page = text.replace(/^(\s*<!doctype[^>]*>)?/i, (doctype = '') => doctype + base)
      if (frame.srcdoc !== page) frame.srcdoc = page
    },
  }
}

// ——— Audio, video, and PDF ———

/** Above this, a file on Linux isn't read into memory to play; see media(). */
const BLOB_MAX = 256 << 20

/**
 * Audio or video with the webview's controls. WebKitGTK's GStreamer can't read Tauri's asset:// scheme, so on
 * Linux the file is read once and played from memory, up to BLOB_MAX. WebView2 plays the asset URL directly.
 */
export function media(path) {
  const player = el(AUDIO.test(path) ? 'audio' : 'video', { controls: true, preload: 'metadata' })
  const box = el('div', { className: 'media' })
  const note = el('p', { className: 'note', hidden: true })
  box.append(player, note)
  let url = ''
  let closed = false
  const src = convertFileSrc(path)
  if (paths.windows) player.src = src
  else {
    fetch(src).then(r => {
      if (+r.headers.get('content-length') > BLOB_MAX) throw new Error('it is too large to play here')
      return r.blob()
    }).then(b => { if (!closed) player.src = url = URL.createObjectURL(b) }, e => {
      note.textContent = `nook can't play this file: ${e.message ?? e}`
      note.hidden = false
    })
  }
  return {
    el: box,
    close() {
      closed = true
      player.pause()
      player.removeAttribute('src')
      player.load()
      if (url) URL.revokeObjectURL(url)
    },
  }
}

/** The webview's own PDF viewer, in a frame that runs no script of the file's. The tab focuses the box around
 * the frame, so nook's keys work until a click goes into the PDF, whose own keys then apply, as in a browser. */
export function pdf(path) {
  const box = el('div', { className: 'pdf-frame', tabIndex: -1 })
  box.append(el('iframe', { src: convertFileSrc(path), title: 'PDF' }))
  return { el: box }
}

// ——— Tables ———

const ROW = 26 // px, as .sheet's rows are drawn
const OVERSCAN = 12

/** CSV or TSV as a table: a fixed header, numbers right-aligned, a click on a heading sorts by it. Only the
 * rows on screen exist, so a file of 100,000 rows scrolls as one of 100 does. */
export function sheet() {
  const box = el('div', { className: 'sheet', tabIndex: -1 })
  const head = el('div', { className: 'head' })
  const body = el('div', { className: 'body' })
  const rowsEl = el('div', { className: 'rows' })
  const foot = el('div', { className: 'foot' })
  body.append(rowsEl)
  box.append(head, body, foot)
  let rows = []
  let order = [] // indexes into rows, in the order shown
  let sort = { col: -1, dir: 0 }
  let template = ''
  let drawn = [-1, -1]

  function draw(force = false) {
    const top = Math.max(0, Math.floor((box.scrollTop - head.offsetHeight) / ROW) - OVERSCAN)
    const end = Math.min(order.length, top + Math.ceil(box.clientHeight / ROW) + 2 * OVERSCAN)
    if (!force && top === drawn[0] && end === drawn[1]) return
    drawn = [top, end]
    const frag = document.createDocumentFragment()
    for (let i = top; i < end; i++) {
      const r = rows[order[i]]
      const line = el('div', { className: 'row' })
      line.append(el('span', { className: 'n', textContent: order[i] }))
      for (let c = 0; c < cols.length; c++) line.append(el('span', { textContent: r[c] ?? '' }))
      frag.append(line)
    }
    rowsEl.replaceChildren(frag)
    rowsEl.style.transform = `translateY(${top * ROW}px)`
  }

  let cols = []
  function headings() {
    head.replaceChildren(el('span', { className: 'n' }), ...cols.map((c, i) => {
      const b = el('button', { textContent: c.name, title: `Sort by ${c.name}` })
      if (sort.col === i) b.dataset.sort = sort.dir > 0 ? '▲' : '▼'
      b.onclick = () => {
        sort = sort.col !== i ? { col: i, dir: 1 } : sort.dir > 0 ? { col: i, dir: -1 } : { col: -1, dir: 0 }
        reorder()
      }
      return b
    }))
  }

  function reorder() {
    order = Array.from({ length: rows.length - 1 }, (_, i) => i + 1)
    if (sort.dir) order.sort((a, b) => sort.dir * compareFields(rows[a][sort.col], rows[b][sort.col]) || a - b)
    headings()
    draw(true)
  }

  let queued = false
  box.addEventListener('scroll', () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; draw() })
  }, { passive: true })
  new ResizeObserver(() => draw()).observe(box)

  return {
    el: box,
    update(text, name) {
      const sep = separator(name, text)
      rows = parse(text, sep)
      if (!rows.length) rows = [[]]
      const sample = rows.slice(0, 300)
      const width = sample.reduce((m, r) => Math.max(m, r.length), 0)
      cols = Array.from({ length: width }, (_, i) => {
        const chars = sample.reduce((m, r) => Math.max(m, Math.min(48, (r[i] ?? '').length)), 4)
        return { name: rows[0][i] || `Column ${i + 1}`, chars, number: numeric(rows, i) }
      })
      const digits = String(rows.length).length
      const next = `calc(${digits}ch + 20px) ` + cols.map(c => `calc(${Math.min(48, c.chars + 2)}ch + 16px)`).join(' ')
      if (next !== template) box.style.setProperty('--columns', (template = next))
      box.style.setProperty('--rows', rows.length - 1)
      numberStyle(box, cols)
      foot.textContent = `${(rows.length - 1).toLocaleString()} rows · ${cols.length} columns · ${{ '\t': 'tab', ';': 'semicolon' }[sep] ?? 'comma'} separated`
      if (sort.col >= cols.length) sort = { col: -1, dir: 0 }
      reorder()
    },
  }
}

let sheets = 0
/** Right-aligns the number columns, through one rule for this sheet alone. */
function numberStyle(box, cols) {
  box.dataset.sheet ||= ++sheets
  let style = box.querySelector('style')
  if (!style) box.append((style = el('style')))
  const scope = `.sheet[data-sheet="${box.dataset.sheet}"]`
  const nth = cols.map((c, i) => (c.number ? `${scope} :is(.row, .head) > :nth-child(${i + 2})` : '')).filter(Boolean)
  style.textContent = nth.length ? `${nth.join(', ')} { text-align: right; font-variant-numeric: tabular-nums; }` : ''
}
