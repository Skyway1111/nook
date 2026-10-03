// Pictures in Claude's transcript, drawn with kitty's graphics protocol. Claude names each picture once,
// `ESC _ G a=T,U=1,t=f,i=<id>,c=<columns>,r=<rows>;<base64 path> ESC \`, then fills its box with U+10EEEE
// cells. A cell's color is the picture's id, and its two diacritics are its row and column in the box.
// nook paints the file over the cells on screen and hides the placeholders under it as xterm draws them.
import { convertFileSrc } from '@tauri-apps/api/core'
import { el } from './ui.js'

const PLACEHOLDER = '\u{10EEEE}'
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
const latin1 = new TextDecoder('latin1')
const utf8 = new TextDecoder()

export function startPictures(term, screen) {
  const layer = screen.appendChild(el('div', { className: 'pictures' }))
  const cell = term.buffer.active.getNullCell()
  const files = new Map() // id -> { url, columns, rows }
  const shown = new Map() // id -> { el, css }
  let seen = false // whether Claude has drawn a picture yet
  let tail = '' // the start of a command the last chunk cut off

  /** Takes the graphics commands from a chunk of output. xterm drops them on its own. */
  function read(bytes) {
    if (!tail && !bytes.includes(0x5f)) return // no `_`, so no command starts here
    const text = tail + latin1.decode(bytes)
    let at = 0
    while ((at = text.indexOf('\x1b_G', at)) !== -1) {
      const end = text.indexOf('\x1b\\', at)
      if (end === -1) break
      run(text.slice(at + 3, end))
      at = end + 2
    }
    // Keep a command the chunk cut off, or an ESC or ESC _ that may start one.
    tail = at !== -1 ? text.slice(at) : text.endsWith('\x1b_') ? '\x1b_' : text.endsWith('\x1b') ? '\x1b' : ''
    if (tail.length > 1 << 20) tail = ''
  }

  function run(command) {
    seen = true
    const [keys, payload = ''] = command.split(';')
    const k = Object.fromEntries(keys.split(',').map(kv => kv.split('=')))
    const id = Number(k.i)
    if (k.a === 'd') files.delete(id)
    // Claude declares a PNG, but the webview decodes whatever the file holds, SVG and JPEG included.
    else if (k.t === 'f') {
      const path = utf8.decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0)))
      files.set(id, { url: convertFileSrc(path), columns: Number(k.c), rows: Number(k.r) })
    }
  }

  /** Paints each picture over its cells on screen. */
  function draw() {
    const b = term.buffer.active
    const boxes = new Map() // id -> the picture's first cell, and its cells on screen
    for (let y = 0; y < term.rows; y++) {
      const line = b.getLine(b.viewportY + y)
      if (!line?.translateToString(true).includes(PLACEHOLDER)) continue
      for (let x = 0; x < term.cols; x++) {
        const chars = line.getCell(x, cell).getChars()
        if (!chars.startsWith(PLACEHOLDER)) continue
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
    for (const [id, pic] of shown) if (!boxes.has(id) || !files.has(id)) { pic.el.remove(); shown.delete(id) }
    for (const [id, { x0, y0, left, right, top, bottom }] of boxes) {
      const file = files.get(id)
      if (!file) continue
      const { columns: c, rows: r } = file
      const pct = (n, of) => `${(n / of) * 100}%`
      const css = `left:${pct(x0, term.cols)};top:${pct(y0, term.rows)};width:${pct(c, term.cols)};height:${pct(r, term.rows)};`
        + `background-image:url("${file.url}");clip-path:inset(${pct(top - y0, r)} ${pct(x0 + c - 1 - right, c)} `
        + `${pct(y0 + r - 1 - bottom, r)} ${pct(left - x0, c)})`
      const pic = shown.get(id) ?? { el: layer.appendChild(el('div')) }
      if (pic.css !== css) pic.el.style.cssText = pic.css = css
      shown.set(id, pic)
    }
  }

  term.onRender(() => seen && draw())
  return {
    read,
    /** Hides the placeholder cells among a row's new spans, under the picture that covers them. */
    hide(spans) {
      if (seen) for (const s of spans) if (s.textContent.startsWith(PLACEHOLDER)) s.style.visibility = 'hidden'
    },
  }
}
