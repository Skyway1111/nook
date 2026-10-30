// Pictures in Claude's transcript, drawn with kitty's graphics protocol. Claude names each picture once,
// `ESC _ G a=T,U=1,t=f,i=<id>,c=<columns>,r=<rows>;<base64 path> ESC \`, or sends the picture itself as
// base64 with t=d, PNG (f=100) or raw RGB(A) pixels (f=24, f=32), split into chunks while m=1. Then it
// fills the picture's box with U+10EEEE cells. A cell's color is the picture's id, and its two diacritics
// are its row and column in the box. nook paints the picture over the cells on screen, which the terminal
// draws as blanks. A query (a=q) learns which ways of sending nook takes.
import { convertFileSrc } from './host.js'
import { el } from './ui.js'

// kitty's row and column diacritics, in order: the nth marks row or column n.
const MARKS = [0x305, [0x30d, 0x30e], 0x310, 0x312, [0x33d, 0x33f], 0x346, [0x34a, 0x34c], [0x350, 0x352], 0x357,
  0x35b, [0x363, 0x36f], [0x483, 0x487], [0x592, 0x595], [0x597, 0x599], [0x59c, 0x5a1], [0x5a8, 0x5a9], [0x5ab, 0x5ac],
  0x5af, 0x5c4, [0x610, 0x617], [0x657, 0x65b], [0x65d, 0x65e], [0x6d6, 0x6dc], [0x6df, 0x6e2], 0x6e4, [0x6e7, 0x6e8],
  [0x6eb, 0x6ec], 0x730, [0x732, 0x733], [0x735, 0x736], 0x73a, 0x73d, [0x73f, 0x741], 0x743, 0x745, 0x747,
  [0x749, 0x74a], [0x7eb, 0x7f1], 0x7f3, [0x816, 0x819], [0x81b, 0x823], [0x825, 0x827], [0x829, 0x82d], 0x951,
  [0x953, 0x954], [0xf82, 0xf83], [0xf86, 0xf87], [0x135d, 0x135f], 0x17dd, 0x193a, 0x1a17, [0x1a75, 0x1a7c], 0x1b6b,
  [0x1b6d, 0x1b73], [0x1cd0, 0x1cd2], [0x1cda, 0x1cdb], 0x1ce0, [0x1dc0, 0x1dc1], [0x1dc3, 0x1dc9], [0x1dcb, 0x1dcc],
  [0x1dd1, 0x1de6], 0x1dfe, [0x20d0, 0x20d1], [0x20d4, 0x20d7], [0x20db, 0x20dc], 0x20e1, 0x20e7, 0x20e9, 0x20f0,
  [0x2cef, 0x2cf1], [0x2de0, 0x2dff], 0xa66f, [0xa67c, 0xa67d], [0xa6f0, 0xa6f1], [0xa8e0, 0xa8f1], 0xaab0,
  [0xaab2, 0xaab3], [0xaab7, 0xaab8], [0xaabe, 0xaabf], 0xaac1, [0xfe20, 0xfe26], 0x10a0f, 0x10a38, [0x1d185, 0x1d189],
  [0x1d1aa, 0x1d1ad], [0x1d242, 0x1d244]]
const INDEX = new Map(MARKS.flatMap(m => (typeof m === 'number' ? [m] : Array.from({ length: m[1] - m[0] + 1 }, (_, i) => m[0] + i)))
  .map((c, i) => [c, i]))
const utf8 = new TextDecoder()

const MAX_PICTURES = 64 // sent pictures kept, oldest dropped first
const PAGE = 1280 // the width an HTML page lays out at, in CSS pixels, before it's scaled into its box
const MAX_BASE64 = 64 << 20 // the largest picture sent in chunks, in base64

/** The asset URL of an HTML file with its folders kept as the URL's own, so the page's relative links (its
 * stylesheet, its pictures) resolve beside it. `convertFileSrc` encodes the whole path as one segment. */
export function pageUrl(path) {
  return convertFileSrc('').replace(/\/$/, '') + '/' + path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
}

/** The folder of `path`, with forward slashes and a slash at its end. */
const folder = path => path.replace(/\\/g, '/').replace(/[^/]*$/, '')

/** A sent picture as a URL the page can show: PNG bytes as they are, raw pixels drawn into a PNG. */
async function pictureUrl(k, base64) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  const format = k.f ?? '32'
  if (format === '100') return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
  const [w, h] = [Number(k.s), Number(k.v)]
  const step = format === '24' ? 3 : 4
  if (!(w > 0 && h > 0) || bytes.length < w * h * step) throw new Error('bad size')
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0, j = 0; i < w * h; i++, j += step) {
    rgba.set(bytes.subarray(j, j + 3), i * 4)
    rgba[i * 4 + 3] = step === 4 ? bytes[j + 3] : 255
  }
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h })
  canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0)
  return URL.createObjectURL(await new Promise(done => canvas.toBlob(done)))
}

/** `reply(text)` answers a query on the terminal's input, as kitty does. */
export function startPictures(term, reply = () => {}) {
  const screen = term.screen
  const layer = screen.appendChild(el('div', { className: 'pictures' }))
  const cell = term.vt.buffer.getNullCell()
  // id -> { url, columns, rows, blob, left, page: an HTML page's folder, path: a named file's, math: a formula's
  // element, size: its own size in font sizes }, oldest first
  const files = new Map()
  let sending = null // a picture arriving in chunks: { keys, parts, size }
  const shown = new Map() // id -> { el, css }
  let seen = false // whether Claude has drawn a picture yet
  let size = [0, 0] // the screen's size, kept here so fitting a formula never waits on layout
  new ResizeObserver(([e]) => {
    size = [e.contentRect.width, e.contentRect.height]
    if (seen) draw()
  }).observe(screen)

  /** An APC string from the terminal, in order with the output around it: a graphics command starts with G. */
  function apc(data) {
    if (data.charCodeAt(0) === 0x47) run(data.slice(1))
  }

  function run(command) {
    seen = true
    const at = command.indexOf(';')
    const [keys, payload] = at < 0 ? [command, ''] : [command.slice(0, at), command.slice(at + 1)]
    const k = Object.fromEntries(keys.split(',').map(kv => kv.split('=')))
    // While a picture arrives in chunks, each command carries its next chunk.
    if (sending) {
      sending.parts.push(payload)
      sending.size += payload.length
      if (sending.size > MAX_BASE64) sending = null
      else if (k.m !== '1') finish(sending.keys, sending.parts.join('')), (sending = null)
      return
    }
    const id = Number(k.i)
    const medium = k.t ?? 'd'
    const answer = message => {
      if (k.i && k.q !== '2' && !(message === 'OK' && k.q === '1')) reply(`\x1b_Gi=${k.i};${message}\x1b\\`)
    }
    if (k.a === 'q') return answer(medium === 'd' || medium === 'f' ? 'OK' : 'EINVAL:only direct and file pictures')
    if (k.a === 'd') {
      if (!k.d || k.d === 'a' || k.d === 'A') for (const id of [...files.keys()]) drop(id)
      else if (k.d.toLowerCase() === 'i') drop(id)
      return
    }
    if (k.a && k.a !== 't' && k.a !== 'T') return
    if (medium === 'f') {
      // Claude declares a PNG, but the webview decodes whatever the file holds, SVG and JPEG included.
      const path = utf8.decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0)))
      if (/\.tex$/i.test(path)) {
        // A formula the mod saved, as MathML the page lays out: in the theme's ink, at the box's left, since
        // its size there is the mod's guess.
        const [columns, rows] = [Number(k.c), Number(k.r)]
        import('./math.js').then(m => m.formula(path)).then(math => {
          keep(id, { math, columns, rows })
          answer('OK')
          draw()
        }, () => answer("EBADPNG:can't read the formula"))
        return
      }
      if (/\.mmd$/i.test(path)) {
        // A diagram the mod saved: drawn at the box's left, since its size there is the mod's guess.
        const [columns, rows] = [Number(k.c), Number(k.r)]
        const made = import('./diagrams.js').then(d => d.diagramUrl(path, boxSize(columns, rows)))
        made.then(url => {
          keep(id, { url, columns, rows, blob: true, left: true })
          answer('OK')
          draw()
        }, () => answer("EBADPNG:can't draw the picture"))
        return
      }
      if (/\.pdf$/i.test(path)) {
        // A PDF Claude read or a command saved: its first page, drawn by the OS at the box's size.
        const [columns, rows] = [Number(k.c), Number(k.r)]
        import('./pdfpage.js').then(m => m.pdfUrl(path, boxSize(columns, rows))).then(url => {
          keep(id, { url, columns, rows, blob: true, path })
          answer('OK')
          draw()
        }, () => answer("EBADPNG:can't draw the PDF"))
        return
      }
      // An HTML page Claude wrote shows as the page itself, laid out wide and scaled into its box.
      const page = /\.html?$/i.test(path)
      keep(id, { url: page ? pageUrl(path) : convertFileSrc(path), columns: Number(k.c), rows: Number(k.r), page: page && folder(path), path })
      answer('OK')
    } else if (medium === 'd') {
      if (k.m === '1') sending = { keys: k, parts: [payload], size: payload.length }
      else finish(k, payload)
    } else answer('EINVAL:only direct and file pictures')
  }

  /** A picture sent whole: shown once it decodes. */
  function finish(k, base64) {
    const id = Number(k.i)
    pictureUrl(k, base64).then(url => {
      keep(id, { url, columns: Number(k.c), rows: Number(k.r), blob: true })
      if (k.i && k.q !== '1' && k.q !== '2') reply(`\x1b_Gi=${k.i};OK\x1b\\`)
      draw()
    }, () => k.i && k.q !== '2' && reply(`\x1b_Gi=${k.i};EBADPNG:can't decode the picture\x1b\\`))
  }

  /** A box of cells' size in pixels, and the terminal's font size, which caps a diagram's text. */
  function boxSize(columns, rows) {
    const { fontSize } = term
    // A tab that isn't showing has no size yet; a cell is then about 0.6 by 1.2 of the font's size.
    const [w, h] = size[0] ? [size[0] / term.cols, size[1] / term.rows] : [fontSize * 0.6, fontSize * 1.2]
    return { width: columns * w, height: rows * h, fontSize }
  }

  function keep(id, file) {
    drop(id)
    files.set(id, file)
    if (files.size > MAX_PICTURES) drop(files.keys().next().value)
  }

  function drop(id) {
    const file = files.get(id)
    if (file?.blob) URL.revokeObjectURL(file.url)
    files.delete(id)
  }

  /** Paints each picture over its cells on screen. */
  function draw() {
    const b = term.vt.buffer
    const boxes = new Map() // id -> the picture's first cell, and its cells on screen
    for (let y = 0; y < term.rows; y++) {
      // A picture's cell carries its row and column as marks, so it is among the row's graphemes.
      const line = b.getLine(b.ydisp + y)
      if (!line?.comb) continue
      for (const x of line.comb.keys()) {
        const chars = x < term.cols ? line.getCell(x, cell).getChars() : ''
        if (chars.codePointAt(0) !== 0x10eeee) continue
        const id = cell.getFgColor()
        const box = boxes.get(id)
        if (box) {
          box.left = Math.min(box.left, x)
          box.right = Math.max(box.right, x)
          box.bottom = y
        } else {
          const x0 = x - (INDEX.get(chars.codePointAt(3)) ?? 0)
          const y0 = y - (INDEX.get(chars.codePointAt(2)) ?? 0)
          boxes.set(id, { x0, y0, left: x, right: x, top: y, bottom: y })
        }
      }
    }
    for (const [id, pic] of shown) {
      if (boxes.has(id) && files.has(id)) continue
      if (!pic.math || pic.math !== files.get(id)?.math) pic.el.remove(), shown.delete(id)
      else if (pic.css) (pic.el.style.contentVisibility = 'hidden'), (pic.css = '') // a formula keeps its layout for when it scrolls back
    }
    for (const [id, { x0, y0, left, right, top, bottom }] of boxes) {
      const file = files.get(id)
      if (!file) continue
      const { columns: c, rows: r } = file
      const pct = (n, of) => `${(n / of) * 100}%`
      const lift = term.lift(top) // raised rows carry their pictures; one's rows are all raised or none
      const css = `left:${pct(x0, term.cols)};top:${pct(y0, term.rows)};width:${pct(c, term.cols)};height:${pct(r, term.rows)};`
        + (lift ? `translate:0 ${-lift}px;` : '')
        + (file.page || file.math ? '' : `background-image:url("${file.url}");${file.left ? 'background-position:left center;' : ''}`)
        + `clip-path:inset(${pct(top - y0, r)} ${pct(x0 + c - 1 - right, c)} ${pct(y0 + r - 1 - bottom, r)} ${pct(left - x0, c)})`
      const pic = shown.get(id) ?? { el: layer.appendChild(el('div')) }
      if (pic.css !== css) pic.el.style.cssText = pic.css = css
      if (pic.math && pic.math !== file.math) pic.math.remove(), (pic.math = null), (pic.el.className = '') // the id now names another
      if (file.page) frame(pic, file, c, r)
      else if (pic.frame) pic.frame.remove(), (pic.frame = null), (pic.el.className = '') // the id now names a picture
      if (file.math) fit(pic, file, c, r)
      shown.set(id, pic)
    }
  }

  /** An HTML page in its box: a frame that runs no script, sends no form and opens nothing, laid out PAGE
   * pixels wide and scaled to the box's width, as tall as the box's shape gives it. The mouse passes through. */
  function frame(pic, file, columns, rows) {
    if (pic.frame?.dataset.url !== file.url) {
      pic.frame?.remove()
      pic.frame = document.createElement('iframe')
      pic.frame.setAttribute('sandbox', '') // set before src, so the page loads sandboxed
      Object.assign(pic.frame, { tabIndex: -1, title: 'page Claude wrote' })
      pic.frame.dataset.url = pic.frame.src = file.url
      pic.el.className = 'page'
      pic.el.append(pic.frame)
      pic.style = ''
    }
    const width = (size[0] * columns) / term.cols
    const height = (size[1] * rows) / term.rows
    if (!width || !height) return
    const style = `height:${Math.round((PAGE * height) / width)}px;transform:scale(${(width / PAGE).toFixed(4)})`
    if (pic.style !== style) pic.frame.style.cssText = pic.style = style
  }

  /** A formula in its box: at its own size, or smaller to fit, from the box's left and centered top to bottom.
   * Its own size is measured once, in the terminal's font sizes, which its text follows. */
  function fit(pic, file, columns, rows) {
    if (!pic.math) {
      pic.el.className = 'math'
      pic.el.append((pic.math = file.math))
      pic.fit = file.math.style.cssText // a scale from a box it showed in before
    }
    const { fontSize } = term
    if (!file.size) {
      const { width, height } = file.math.getBoundingClientRect()
      if (width) file.size = [width / fontSize, height / fontSize]
    }
    const [width, height] = [(size[0] * columns) / term.cols, (size[1] * rows) / term.rows]
    if (!file.size || !width) return
    const scale = Math.min(1, width / (file.size[0] * fontSize), height / (file.size[1] * fontSize))
    const css = scale < 1 ? `transform:scale(${scale.toFixed(4)})` : ''
    if (pic.fit !== css) file.math.style.cssText = pic.fit = css
  }

  /** Reloads each page on screen once Claude writes a file in its folder or under it, so a page written before
   * its stylesheet shows with it. `paths` is every file the session wrote, newest last. */
  let written = []
  function wrote(paths) {
    const at = paths.findIndex((p, i) => written[i] !== p)
    const fresh = (at < 0 ? [] : paths.slice(at)).map(p => p.replace(/\\/g, '/'))
    written = paths
    if (!fresh.length) return
    for (const [id, pic] of shown) {
      const dir = pic.frame && files.get(id)?.page
      if (dir && fresh.some(p => p.startsWith(dir))) pic.frame.src = pic.frame.dataset.url
    }
  }

  term.onRender(() => seen && draw())
  term.onRaise(() => seen && draw())
  return {
    apc,
    wrote,
    /** The file a picture on screen was named by, or undefined for one sent whole or drawn by nook. */
    pathOf: id => files.get(id)?.path,
  }
}
