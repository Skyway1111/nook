// Blink and WebKitGTK dither every CSS gradient, and software raster draws a dithered gradient about five times
// slower than an image: a theme's gradients made each resize repaint slowly, and nook's first frame spent about
// 200 ms on the terminal's backdrop alone. So once an element's size settles, its gradient layers are baked into
// bitmaps at that size, and the bitmaps paint in their place, the same but for one shade of dither. While it
// resizes, they stretch; once the size holds still, they bake again. Each bake is saved, so the next start paints
// its first frame from it. A restyle shows the live CSS at once, until the new look bakes. A gradient sized in
// percents stretches into itself.
import { invoke } from './host.js'

const SETTLE_MS = 100 // how long an element's size holds still before it bakes
const SAVE_MS = 1000 // how long a bake stands before it's saved for the next start
const PROPS = ['image', 'position', 'size', 'repeat', 'origin', 'clip', 'attachment']
const keyOf = cs => PROPS.map(p => cs.getPropertyValue(`background-${p}`)).join('|')

/** A computed comma list's items. Commas inside parentheses or quotes don't split it. */
function items(list) {
  const out = []
  let depth = 0, quote = '', start = 0
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    if (quote) quote = c === quote ? '' : quote
    else if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && !depth) { out.push(list.slice(start, i).trim()); start = i + 1 }
  }
  return [...out, list.slice(start).trim()]
}

/** Each background layer's longhands. A shorter list repeats, as CSS repeats it. */
function layers(cs) {
  const lists = PROPS.map(p => items(cs.getPropertyValue(`background-${p}`)))
  return lists[0].map((_, i) => Object.fromEntries(PROPS.map((p, j) => [p, lists[j][i % lists[j].length]])))
}

/** One layer as Blink paints it on a w x h box with `read`'s borders and padding, or on the viewport, as a PNG. */
async function bitmap(read, layer, w, h, box) {
  const { attachment, ...rest } = layer
  const style = [`width:${w}px`, `height:${h}px`, 'box-sizing:border-box', ...Object.entries(rest).map(([p, v]) => `background-${p}:${v}`),
    ...(box ? ['border-style:solid', 'border-color:transparent', `border-width:${read.borderWidth}`, `padding:${read.padding}`] : [])]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="${style.join(';').replaceAll('"', "'")}"></div></foreignObject></svg>`
  const page = new Image()
  page.src = `data:image/svg+xml,${encodeURIComponent(svg)}`
  await page.decode()
  const canvas = new OffscreenCanvas(Math.round(w * devicePixelRatio), Math.round(h * devicePixelRatio))
  canvas.getContext('2d').drawImage(page, 0, 0, canvas.width, canvas.height)
  return canvas.convertToBlob()
}

/** `el`'s own background and size, read from under the bitmaps standing in for it. `id` names the look a bake
 * of it has: its layers, its size, the window's, and the pixel ratio. */
function live(el, standIn) {
  if (standIn) for (const [p] of standIn.style) el.style.removeProperty(p)
  const cs = getComputedStyle(el)
  const read = { key: keyOf(cs), all: layers(cs), borderWidth: cs.borderWidth, padding: cs.padding, w: el.offsetWidth, h: el.offsetHeight }
  if (standIn) for (const [p, v] of standIn.style) el.style.setProperty(p, v)
  return { ...read, id: `${read.key}|${read.w}x${read.h}|${innerWidth}x${innerHeight}@${devicePixelRatio}` }
}

/** Bitmaps of `read`'s gradient layers, or null when it has none. */
async function bake(read) {
  const { all, w, h } = read
  if (!w || !h || !all.some(l => l.image.includes('gradient('))) return null
  const pngs = await Promise.all(all.map(l => l.image.includes('gradient(')
    ? (l.attachment === 'fixed' ? bitmap(read, l, innerWidth, innerHeight, false) : bitmap(read, l, w, h, true))
    : null))
  return standIn(read, pngs)
}

/** The background longhands that paint `pngs`, one per layer of `read` or null to keep that layer live. */
async function standIn(read, pngs) {
  const imgs = await Promise.all(pngs.map(async png => {
    if (!png) return null
    const img = new Image()
    img.src = URL.createObjectURL(png)
    await img.decode() // a layer that hasn't loaded paints nothing, so its first frame would drop it
    return img
  }))
  const shown = read.all.map((l, i) => imgs[i]
    ? { ...l, image: `url("${imgs[i].src}")`, position: '0 0', size: '100% 100%', repeat: 'no-repeat', ...(l.attachment === 'fixed' ? {} : { origin: 'border-box', clip: 'border-box' }) }
    : l)
  return { id: read.id, pngs, imgs: imgs.filter(Boolean), style: PROPS.map(p => [`background-${p}`, shown.map(l => l[p]).join(', ')]) }
}

const forget = baked => baked?.imgs.forEach(img => URL.revokeObjectURL(img.src))

// A saved bake: its id, a NUL, then each layer's PNG as its length in 4 bytes, little-endian, and its bytes.
async function save(name, baked) {
  const pngs = await Promise.all(baked.pngs.map(async png => new Uint8Array(png ? await png.arrayBuffer() : 0)))
  const head = new TextEncoder().encode(`${name}\0${baked.id}\0`)
  const body = new Uint8Array(head.length + pngs.reduce((n, png) => n + 4 + png.length, 0))
  body.set(head)
  let at = head.length
  for (const png of pngs) {
    new DataView(body.buffer).setUint32(at, png.length, true)
    body.set(png, at + 4)
    at += 4 + png.length
  }
  await invoke('save_backdrop', body)
}

async function saved(name) {
  const body = new Uint8Array(await invoke('saved_backdrop', { name }))
  const end = body.indexOf(0)
  if (end < 0) return null
  const pngs = []
  for (let at = end + 1; at + 4 <= body.length;) {
    const n = new DataView(body.buffer).getUint32(at, true)
    pngs.push(n ? new Blob([body.subarray(at + 4, at + 4 + n)], { type: 'image/png' }) : null)
    at += 4 + n
  }
  return { id: new TextDecoder().decode(body.subarray(0, end)), pngs }
}

/** Paints each element's gradients from bitmaps, as the header says. `restyle` shows the live CSS after a
 * restyle and bakes it again; `restore` paints from the bakes the last start saved, where the look is the same,
 * and resolves once they're shown. */
export function holdBackdrops(elements) {
  const holds = elements.map(el => {
    const name = el.id || el.localName
    const kept = saved(name).catch(() => null) // read at once, so it's in hand by the first frame
    let baked = null, timer, saving, version = 0
    const show = next => {
      const old = baked
      if (old) for (const [p] of old.style) el.style.removeProperty(p)
      if (next) for (const [p, v] of next.style) el.style.setProperty(p, v)
      baked = next
      forget(old)
    }
    const settle = () => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        const read = live(el, baked)
        if (baked?.id === read.id) return
        const v = ++version
        const next = await bake(read).catch(() => null)
        if (v !== version) return forget(next) // a later bake or restyle took its place
        show(next)
        clearTimeout(saving)
        if (next) saving = setTimeout(() => baked === next && save(name, next).catch(() => {}), SAVE_MS)
      }, SETTLE_MS)
    }
    new ResizeObserver(settle).observe(el)
    return {
      restyle() {
        if (baked && live(el, baked).id === baked.id) return // its gradients didn't change
        version++
        show(null)
        settle()
      },
      async restore() {
        const last = await kept
        const read = live(el, baked)
        if (baked || last?.id !== read.id || last.pngs.length !== read.all.length) return
        const v = version
        const next = await standIn(read, last.pngs).catch(() => null)
        if (v !== version || baked) return forget(next)
        show(next)
      },
    }
  })
  return {
    restyle: () => holds.forEach(h => h.restyle()),
    restore: () => Promise.all(holds.map(h => h.restore())),
  }
}
