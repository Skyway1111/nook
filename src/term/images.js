// Sixel and iTerm2 pictures (OSC 1337 File= with inline=1), loaded the first time output holds one. A
// picture covers cells from the cursor, and each cell keeps its tile in its
// extras, so text written over it, an erase, or a scroll takes the picture's cells with it. Pictures draw
// over the text where their cells show. A terminal keeps 32 MB of pixels, oldest dropped first.
import { bytes } from '../palette.js'
import { PALETTE } from './view.js'
import { CM, RGB, INVERSE } from './vt.js'

const BUDGET = 8e6 // pixels kept: 32 MB
const MAX_PIXELS = 4096 * 4096 // the largest picture
const SIXEL_MAX = 25e6 // sixel data taken, in characters
const FILE_MAX = 20e6 // an iTerm2 file's size
const CELL = [7, 14] // a cell's size in px while the terminal has none

// A VT340's 16 colors, in percent, then xterm's 256-color cube and grays: the sixel color registers' defaults.
const VT340 = [0, 0, 0, 20, 20, 80, 80, 13, 13, 20, 80, 20, 80, 20, 80, 20, 80, 80, 80, 80, 20, 53, 53, 53,
  26, 26, 26, 33, 33, 60, 60, 26, 26, 33, 60, 33, 60, 33, 60, 33, 60, 60, 60, 60, 33, 80, 80, 80]
const pack = (r, g, b) => (r | g << 8 | b << 16 | 0xff000000) >>> 0 // RGBA bytes as one little-endian word
const pct = v => Math.round((Math.min(v, 100) / 100) * 255)
function defaults() {
  const p = new Uint32Array(256)
  for (let i = 0; i < 16; i++) p[i] = pack(pct(VT340[i * 3]), pct(VT340[i * 3 + 1]), pct(VT340[i * 3 + 2]))
  const cube = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff]
  for (let i = 16; i < 232; i++) p[i] = pack(cube[(i - 16) / 36 | 0], cube[(i - 16) / 6 % 6 | 0], cube[(i - 16) % 6])
  for (let i = 232; i < 256; i++) p[i] = pack(8 + 10 * (i - 232), 8 + 10 * (i - 232), 8 + 10 * (i - 232))
  return p
}

/** DEC's HLS (blue at 0°), in degrees and percent, as a packed color. */
function hls(h, l, s) {
  h = ((h + 240) % 360) / 360
  l /= 100
  s /= 100
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const c = t => {
    t = ((t % 1) + 1) % 1
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p
    return Math.round(Math.min(Math.max(v, 0), 1) * 255)
  }
  return s ? pack(c(h + 1 / 3), c(h), c(h - 1 / 3)) : pack(Math.round(l * 255), Math.round(l * 255), Math.round(l * 255))
}

/** A sixel picture decoded as its data arrives, into bands of six pixel rows. `palette` is the terminal's color
 * registers, which a picture's definitions change for the next. Unset pixels end as `fill`. */
class Sixel {
  constructor(palette, fill) {
    this.palette = palette
    this.fill = fill
    this.color = 0xffffffff // white until a color is picked
    this.x = 0
    this.band = 0
    this.width = 0 // the furthest a sixel reached
    this.height = 0 // below the lowest pixel set
    this.bands = [] // Uint32Array(cap * 6) each, 0 where unset
    this.cap = 0
    this.raster = false // whether raster attributes gave the picture's size, which cuts what's past it
    this.rw = 0
    this.rh = 0
    this.state = 0 // 0 data, or the command whose numbers are coming: # ! "
    this.params = []
    this.repeat = 1
    this.size = 0
    this.failed = false
  }

  put(s) {
    if (this.failed || (this.size += s.length) > SIXEL_MAX) return void (this.failed = true)
    const p = this.params
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (this.state) {
        if (c >= 48 && c <= 57) {
          p[p.length - 1] = Math.min(p[p.length - 1] * 10 + c - 48, 1e7)
          continue
        }
        if (c === 59) {
          p.push(0)
          continue
        }
        this.command()
      }
      if (c >= 63 && c <= 126) this.six(c - 63)
      else if (c === 35 || c === 33 || c === 34) { // # ! "
        this.state = c
        p.length = 0
        p.push(0)
      } else if (c === 36) this.x = 0 // $: back to the band's start
      else if (c === 45) { // -: the next band, and the picture is at least as tall as this one
        this.x = 0
        if (++this.band * 6 > this.height) this.height = this.band * 6
      }
    }
  }

  command() {
    const p = this.params
    if (this.state === 33) this.repeat = p[0] || 1
    else if (this.state === 35) {
      const n = p[0] % 256
      if (p.length >= 5 && (p[1] === 1 || p[1] === 2)) this.palette[n] = p[1] === 1 ? hls(p[2], p[3], p[4]) : pack(pct(p[2]), pct(p[3]), pct(p[4]))
      this.color = this.palette[n]
    } else if (!this.bands.length && p.length >= 4) {
      this.raster = true
      this.rw = p[2]
      this.rh = p[3]
      if (p[2] * p[3] > MAX_PIXELS) this.failed = true
      else if (p[2]) this.grow(p[2])
    }
    this.state = 0
  }

  /** One sixel, `repeat` times: bit n paints row n of the band. */
  six(bits) {
    const x0 = this.x
    const x1 = this.raster ? Math.min(x0 + this.repeat, this.rw) : x0 + this.repeat
    this.x += this.repeat
    this.repeat = 1
    if (x1 > this.width) this.width = x1
    if (!bits || x1 <= x0 || this.failed || (this.raster && this.band * 6 >= this.rh)) return
    if (x1 > this.cap && !this.grow(x1)) return
    let band = this.bands[this.band]
    if (!band) {
      if (this.cap * (this.band + 1) * 6 > MAX_PIXELS) return void (this.failed = true)
      band = this.bands[this.band] = new Uint32Array(this.cap * 6)
    }
    const bottom = this.band * 6 + 32 - Math.clz32(bits)
    if (bottom > this.height) this.height = bottom
    for (let r = 0; r < 6; r++) if (bits & 1 << r) band.fill(this.color, r * this.cap + x0, r * this.cap + x1)
  }

  /** Room for `w` pixels a row; false past the size a picture may have. */
  grow(w) {
    const cap = Math.max(w, this.cap * 2, 64)
    if (cap * (this.band + 1) * 6 > MAX_PIXELS) return !(this.failed = true)
    for (let i = 0; i < this.bands.length; i++) {
      const old = this.bands[i]
      if (!old) continue
      const band = new Uint32Array(cap * 6)
      for (let r = 0; r < 6; r++) band.set(old.subarray(r * this.cap, (r + 1) * this.cap), r * cap)
      this.bands[i] = band
    }
    this.cap = cap
    return true
  }

  /** The picture as ImageData, or its height alone when it has no pixels. */
  end() {
    if (this.state) this.command()
    const last = this.bands.length
    const w = this.raster ? this.rw : this.width
    const h = this.raster ? this.rh : this.height
    if (this.failed || w * h > MAX_PIXELS || !w || !h) return { height: this.failed ? 0 : h }
    const out = new Uint32Array(w * h)
    if (this.fill) out.fill(this.fill)
    for (let b = 0; b < last; b++) {
      const band = this.bands[b]
      if (!band) continue
      for (let r = 0; r < 6 && b * 6 + r < h; r++) {
        const from = r * this.cap
        const at = (b * 6 + r) * w
        const n = Math.min(w, this.cap)
        if (!this.fill) out.set(band.subarray(from, from + n), at)
        else for (let x = 0; x < n; x++) if (band[from + x]) out[at + x] = band[from + x]
      }
    }
    return { height: h, data: new ImageData(new Uint8ClampedArray(out.buffer), w, h) }
  }
}

/** A PNG, JPEG or GIF's type and size from its first bytes, or null. */
function imageType(d) {
  if (d.length < 24) return null
  if (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47 && d[12] === 0x49 && d[13] === 0x48 && d[14] === 0x44 && d[15] === 0x52) {
    return ['image/png', (d[16] << 24 | d[17] << 16 | d[18] << 8 | d[19]) >>> 0, (d[20] << 24 | d[21] << 16 | d[22] << 8 | d[23]) >>> 0]
  }
  if (d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) {
    // The first frame header (SOF0 or SOF2) holds the size.
    for (let i = 4 + (d[4] << 8 | d[5]); i + 8 < d.length && d[i] === 0xff; i += 2 + (d[i + 2] << 8 | d[i + 3])) {
      if (d[i + 1] === 0xc0 || d[i + 1] === 0xc2) return ['image/jpeg', d[i + 7] << 8 | d[i + 8], d[i + 5] << 8 | d[i + 6]]
    }
    return null
  }
  if (d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x38 && (d[4] === 0x37 || d[4] === 0x39) && d[5] === 0x61) {
    return ['image/gif', d[7] << 8 | d[6], d[9] << 8 | d[8]]
  }
  return null
}

const SIZE = /^(auto|\d+(px|%)?)$/

/** Sixel and iTerm2 pictures in `term`. Returns the hooks its parser calls: `sixel(params)` for a DCS q,
 * `iterm(data)` for an OSC 1337, and `dispose()`. */
export function startImages(term) {
  term.vt.images = true // DA1 now says sixel, and CSI 18 t answers
  const layer = term.screen.appendChild(document.createElement('div'))
  layer.className = 'pictures'
  const pics = new Map() // id -> { el, url, w, h, cw, ch, cols, buffer, end, css }, oldest first
  const palette = defaults()
  const cell = term.vt.buffer.getNullCell()
  let next = 1
  let pixels = 0

  const cellSize = () => (term.cellW && term.cellH ? [term.cellW, term.cellH] : CELL)

  /** The color unset sixel pixels take: none when the picture asks (P2 = 1), else the cell background in use. */
  function background(params) {
    if (params[1] === 1) return 0
    const { fg, bg } = term.vt
    const c = fg & INVERSE ? fg : bg
    const m = c & CM
    if (m === RGB) return pack(c >> 16 & 255, c >> 8 & 255, c & 255)
    const css = m ? PALETTE[c & 255] : fg & INVERSE ? 'var(--term-fg)' : ''
    if (!css) return 0 // the theme's background is the backdrop's, see-through
    const [r, g, b, a] = bytes(css.startsWith('var(') ? getComputedStyle(term.element).getPropertyValue(css.slice(4, -1)) : css)
    return a ? pack(r, g, b) : 0
  }

  function sixel(params) {
    const dec = new Sixel(palette, background(params))
    return {
      put: s => dec.put(s),
      end(ok) {
        if (!ok) return
        const { height, data } = dec.end()
        if (data) {
          const canvas = document.createElement('canvas')
          canvas.width = data.width
          canvas.height = data.height
          canvas.getContext('2d').putImageData(data, 0, 0)
          place(canvas, null, data.width, data.height)
        } else if (height) {
          // Only a height: the cursor moves past it, as a picture's would.
          for (let i = Math.ceil(height / cellSize()[1]); i > 1; i--) term.vt.lineFeed()
        }
      },
    }
  }

  function iterm(data) {
    const colon = data.indexOf(':')
    if (!data.startsWith('File=') || colon < 0) return
    const args = {}
    for (const kv of data.slice(5, colon).split(';')) {
      const i = kv.indexOf('=')
      if (i > 0) args[kv.slice(0, i)] = kv.slice(i + 1)
    }
    const size = Number(args.size)
    if (args.inline !== '1' || !(size > 0) || size > FILE_MAX || !SIZE.test(args.width ?? 'auto') || !SIZE.test(args.height ?? 'auto')) return
    let text
    try {
      text = atob(data.slice(colon + 1))
    } catch {
      return
    }
    if (text.length !== size) return
    const d = new Uint8Array(size)
    for (let i = 0; i < size; i++) d[i] = text.charCodeAt(i)
    const type = imageType(d)
    if (!type || !type[1] || !type[2] || type[1] * type[2] >= MAX_PIXELS) return
    const [w, h] = fit(type[1], type[2], args).map(Math.floor)
    if (!w || !h || w * h >= MAX_PIXELS) return
    const url = URL.createObjectURL(new Blob([d], { type: type[0] }))
    const img = document.createElement('img')
    img.decoding = 'async'
    img.src = url
    place(img, url, w, h)
  }

  /** An iTerm2 picture's size in px: as its width and height ask, in cells, px or percent of the screen, or
   * its own, made smaller to fit the screen. */
  function fit(w, h, args) {
    const [cw, ch] = cellSize()
    const width = term.canvasW || cw * term.cols
    const height = term.canvasH || ch * term.rows
    const dim = (s = 'auto', total, cell) => s === 'auto' ? 0 : s.endsWith('%') ? parseInt(s) * total / 100 : s.endsWith('px') ? parseInt(s) : parseInt(s) * cell
    const rw = dim(args.width, width, cw)
    const rh = dim(args.height, height, ch)
    if (!rw && !rh) {
      const f = Math.min(width / w, (height - ch) / h)
      return f < 1 ? [w * f, h * f] : [w, h]
    }
    if (!rw) return [w * rh / h, rh]
    return args.preserveAspectRatio !== '0' || !rh ? [rw, h * rw / w] : [rw, rh]
  }

  /** Covers cells from the cursor with picture `el`, `w` by `h` px at the cell size it was made for. */
  function place(el, url, w, h) {
    while (pixels + w * h > BUDGET && pics.size) drop(pics.keys().next().value)
    const [cw, ch] = cellSize()
    const cols = Math.ceil(w / cw)
    const id = next++
    const vt = term.vt
    vt.picture(id, cols, Math.ceil(h / ch))
    const b = vt.buffer
    pics.set(id, { el, url, w, h, cw, ch, cols, buffer: b, end: b.trimmed + b.ybase + b.y, css: '' })
    pixels += w * h
    el.style.display = 'none'
    layer.appendChild(el)
  }

  function drop(id) {
    const p = pics.get(id)
    p.el.remove()
    if (p.url) URL.revokeObjectURL(p.url)
    pixels -= p.w * p.h
    pics.delete(id)
  }

  /** Each picture over its cells on screen; one whose cells are gone for good goes. */
  function draw() {
    if (!pics.size) return
    const vt = term.vt
    const b = vt.buffer
    for (const [id, p] of pics) if (p.buffer === vt.alt ? b !== vt.alt : p.end < p.buffer.trimmed) drop(id)
    const { cols, rows } = term
    const boxes = new Map() // id -> its first cell, and its cells on screen
    for (let y = 0; y < rows; y++) {
      const line = b.getLine(b.ydisp + y)
      if (!line?.ext) continue
      for (const x of line.ext.keys()) {
        const e = x < cols && line.getCell(x, cell).ext
        const p = e?.img && pics.get(e.img)
        if (!p) continue
        const box = boxes.get(e.img)
        if (box) {
          box.left = Math.min(box.left, x)
          box.right = Math.max(box.right, x)
          box.bottom = y
        } else boxes.set(e.img, { x0: x - e.tile % p.cols, y0: y - (e.tile / p.cols | 0), left: x, right: x, top: y, bottom: y })
      }
    }
    for (const [id, p] of pics) {
      const box = boxes.get(id)
      if (!box && p.buffer === vt.alt) {
        drop(id) // the alternate screen keeps no history
        continue
      }
      let css = 'display:none'
      if (box) {
        const { x0, y0, left, right, top, bottom } = box
        const [w, h] = [p.w / p.cw, p.h / p.ch] // in cells
        const at = (n, of) => `${(n / of) * 100}%`
        const inset = (n, of) => at(Math.max(n, 0), of)
        css = `position:absolute;left:${at(x0, cols)};top:${at(y0, rows)};width:${at(w, cols)};height:${at(h, rows)};`
          + `clip-path:inset(${inset(top - y0, h)} ${inset(x0 + w - right - 1, w)} ${inset(y0 + h - bottom - 1, h)} ${inset(left - x0, w)})`
      }
      if (css !== p.css) p.el.style.cssText = p.css = css
    }
  }
  const rendered = term.onRender(draw)

  return {
    sixel,
    iterm,
    dispose() {
      rendered.dispose()
      for (const id of [...pics.keys()]) drop(id)
      layer.remove()
    },
  }
}
