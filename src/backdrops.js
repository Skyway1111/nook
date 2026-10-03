import { SETTLE_MS } from './terminal.js'

// Blink dithers every CSS gradient, and software raster draws a dithered gradient about five times slower than an
// image, so a resize used to repaint each theme's gradients on every frame. Once an element's size settles, its
// gradient layers are baked into bitmaps at that size. While it resizes, the bitmaps stretch in their place, and
// the live CSS returns once the size holds still. A gradient sized in percents stretches into itself.

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

/** A decoded bitmap of one layer as Blink paints it on a w x h box with `cs`'s borders and padding, or on the viewport. */
async function bitmap(cs, layer, w, h, box) {
  const { attachment, ...rest } = layer
  const style = [`width:${w}px`, `height:${h}px`, 'box-sizing:border-box', ...Object.entries(rest).map(([p, v]) => `background-${p}:${v}`),
    ...(box ? ['border-style:solid', 'border-color:transparent', `border-width:${cs.borderWidth}`, `padding:${cs.padding}`] : [])]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="${style.join(';').replaceAll('"', "'")}"></div></foreignObject></svg>`
  const page = new Image()
  page.src = `data:image/svg+xml,${encodeURIComponent(svg)}`
  await page.decode()
  const canvas = new OffscreenCanvas(Math.round(w * devicePixelRatio), Math.round(h * devicePixelRatio))
  canvas.getContext('2d').drawImage(page, 0, 0, canvas.width, canvas.height)
  const img = new Image()
  img.src = URL.createObjectURL(await canvas.convertToBlob())
  await img.decode() // a layer that hasn't loaded paints nothing, so the first stretched frame would drop it
  return img
}

/** The background longhands that draw `el`'s gradient layers as bitmaps of their current paint, or null. */
export async function bake(el) {
  const cs = getComputedStyle(el)
  const key = keyOf(cs), all = layers(cs), w = el.offsetWidth, h = el.offsetHeight
  if (!w || !h || !all.some(l => l.image.includes('gradient('))) return null
  const imgs = await Promise.all(all.map(l => l.image.includes('gradient(')
    && (l.attachment === 'fixed' ? bitmap(cs, l, innerWidth, innerHeight, false) : bitmap(cs, l, w, h, true))))
  const shown = all.map((l, i) => imgs[i]
    ? { ...l, image: `url("${imgs[i].src}")`, position: '0 0', size: '100% 100%', repeat: 'no-repeat', ...(l.attachment === 'fixed' ? {} : { origin: 'border-box', clip: 'border-box' }) }
    : l)
  return { key, imgs: imgs.filter(Boolean), style: PROPS.map(p => [`background-${p}`, shown.map(l => l[p]).join(', ')]) }
}

const forget = baked => baked?.imgs.forEach(img => URL.revokeObjectURL(img.src))

/** Holds each element's gradients still while it resizes. The returned function rebakes after a restyle. */
export function holdBackdrops(elements) {
  const settles = elements.map(el => {
    let baked = null, held = false, timer
    let stale = [] // bakes replaced while one was showing
    const show = on => {
      held = on
      for (const [p, v] of baked.style) on ? el.style.setProperty(p, v) : el.style.removeProperty(p)
    }
    const settle = () => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        if (held) show(false)
        stale.forEach(forget)
        stale = []
        const next = await bake(el)
        if (held) stale.push(baked)
        else forget(baked)
        baked = next
      }, SETTLE_MS)
    }
    new ResizeObserver(() => {
      if (!held && baked?.key === keyOf(getComputedStyle(el))) show(true)
      settle()
    }).observe(el)
    return settle
  })
  return () => settles.forEach(settle => settle())
}
