// The living wallpaper behind Claude tabs, and its picker. A canvas at the bottom of #pane draws a scene from
// wallpapers.js under the terminal, whose background is transparent. theme.css names the scene in
// `--wallpaper`, so a theme can ship one, the user's theme.css overrides it, and every window follows a pick
// within a second. Each role's color, the opacity, and the cell size are theme variables too. A frame copies
// glyphs from an atlas into only the cells that changed since the last one, so a frame costs a few hundred
// small copies, not a full redraw of text.
import { ROLES, SCENES, paint, render, scene } from './wallpapers.js'
import { bytes } from './palette.js'
import { el } from './ui.js'

const FRAME_MS = 100 // ten frames a second. Characters step from cell to cell, so more frames would only cost.
const REST_MS = 600 // after a key or a resize, the wallpaper holds still this long, so their repaints never wait on a frame
const THUMB_PX = 4 // the picker's thumbnails draw their cells this many pixels high
const SETTLE_MS = 100 // while the pane resizes, the last bitmap stretches; it redraws at the new size once this long passes without one, as backdrops.js does
const still = matchMedia('(prefers-reduced-motion: reduce)')

/** Sizes `canvas` to a CSS box of `width` x `height` at the screen's pixel density, and fits cells to it: `size`
 * pixels high in font `family`, each a whole number of device pixels, so a cell's copy never blurs or leaves a
 * seam. Returns `{ ctx, w, h, cols, rows }` in device pixels, the context drawing in them, and `tiles`, a fresh
 * glyph atlas in `colors`. The last column and row may run past the canvas's edge. */
function fit(canvas, width, height, size, family, colors) {
  const dpr = devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(width * dpr))
  canvas.height = Math.max(1, Math.round(height * dpr))
  const ctx = canvas.getContext('2d')
  const font = `${size * dpr}px ${family}`
  ctx.font = font
  const w = Math.max(1, Math.round(ctx.measureText('M').width || size * dpr * 0.6))
  const h = Math.max(1, Math.ceil(size * dpr))
  return { ctx, w, h, cols: Math.ceil(canvas.width / w), rows: Math.ceil(canvas.height / h), tiles: atlas(w, h, font, colors) }
}

const ATLAS_COLS = 32 // tiles a row of the atlas holds
/** A glyph atlas: each character in each role's color, drawn once into its own tile, `w` wide and as high as the
 * font's glyphs reach, at least `h`. `spill` is how far a tile runs below its cell. */
function atlas(w, h, font, colors) {
  let ctx = null
  const where = new Map()
  const probe = el('canvas').getContext('2d')
  probe.font = font
  probe.textBaseline = 'top'
  const reach = probe.measureText('█_gjy|()[]{}')
  const spill = Math.max(0, Math.min(h, Math.ceil(reach.fontBoundingBoxDescent ?? reach.actualBoundingBoxDescent ?? h) - h))
  const tall = h + spill
  const tiles = {
    canvas: el('canvas', { width: w * ATLAS_COLS, height: tall * 4 }),
    spill,
    at(ch, role) {
      const key = role + '\0' + ch
      let at = where.get(key)
      if (at) return at
      const n = where.size
      at = [(n % ATLAS_COLS) * w, Math.floor(n / ATLAS_COLS) * tall]
      if (at[1] + tall > tiles.canvas.height) {
        // Twice the rows, keeping the tiles drawn so far.
        const grown = el('canvas', { width: tiles.canvas.width, height: tiles.canvas.height * 2 })
        grown.getContext('2d').drawImage(tiles.canvas, 0, 0)
        tiles.canvas = grown
        ctx = null
      }
      if (!ctx) {
        ctx = tiles.canvas.getContext('2d')
        ctx.font = font
        ctx.textBaseline = 'top'
      }
      ctx.save()
      ctx.beginPath()
      ctx.rect(at[0], at[1], w, tall)
      ctx.clip()
      ctx.fillStyle = colors[role]
      ctx.fillText(ch, at[0], at[1])
      ctx.restore()
      where.set(key, at)
      return at
    },
  }
  return tiles
}

/** Draws the wallpaper in `pane`. `button` opens the picker, `save(id)` keeps a pick by setting
 * `--wallpaper` in the user's theme.css, and `onClose` hears the picker close. */
export function startWallpaper(pane, { button, save, onClose }) {
  const canvas = pane.insertBefore(el('canvas', { className: 'wallpaper', hidden: true }), pane.firstChild)
  const started = performance.now()
  let look = { id: 'none', size: 14, family: 'monospace', colors: {} } // theme.css's, at the last restyle
  let previewing = null // a scene the picker shows before it's kept
  let showing = true // false while a file tab is in front
  let focused = document.hasFocus() // the wallpaper moves only while nook's window has focus
  let cells = null // the canvas's context, cells, and glyph atlas, from fit, while a scene shows
  let onCanvas = null, spare = null // the grid on the canvas, and one to draw the next frame into
  let lastInput = -Infinity, lastFrame = -Infinity, raf = 0
  let picker = null // the open picker's { focus, restyle, tick, close }

  const id = () => previewing ?? look.id
  const shown = () => !!scene(id()) && showing
  const live = () => shown() && focused && !document.hidden

  function measure() {
    onCanvas = spare = null // a new bitmap starts blank
    if (!shown()) {
      // A hidden canvas keeps no bitmap the size of the pane.
      canvas.width = canvas.height = 1
      cells = null
      return
    }
    const { width, height } = pane.getBoundingClientRect()
    cells = fit(canvas, width, height, look.size, look.family, look.colors)
  }

  /** Draws the frame at `now`, touching only the cells that changed since the last one. */
  function draw(now = performance.now()) {
    lastFrame = now
    const { ctx, w, h, cols, rows, tiles } = cells
    const g = render(id(), cols, rows, (now - started) / 1000, spare)
    paint(ctx, g, w, h, tiles, onCanvas)
    spare = onCanvas
    onCanvas = g
  }

  // One loop serves the pane and the picker's thumbnails. It stops while nothing moves, and rests after a key.
  // A timer wakes it once a frame, and the frame draws in the next animation frame, so the page isn't asked
  // for an animation frame sixty times a second to draw ten.
  let timer = 0
  function schedule() {
    if (timer || raf || (!live() && !picker) || still.matches) return
    const now = performance.now()
    const wait = Math.max(0, FRAME_MS - (now - lastFrame), REST_MS - (now - lastInput))
    timer = setTimeout(() => {
      timer = 0
      if (!raf) raf = requestAnimationFrame(frame)
    }, wait)
  }
  function frame(now) {
    raf = 0
    if (!live() && !picker) return
    if (now - lastFrame >= FRAME_MS - 4 && now - lastInput >= REST_MS) {
      lastFrame = now
      if (live()) draw(now)
      picker?.tick(now - started)
    }
    schedule()
  }

  /** Shows or hides the canvas for what's in front, and runs the loop while anything moves. */
  function update() {
    canvas.hidden = !shown()
    if (shown() !== !!cells) measure()
    if (shown()) draw()
    schedule()
  }

  /** Reads the scene, colors, and cell size from theme.css. */
  function restyle() {
    const style = getComputedStyle(document.documentElement)
    const v = name => style.getPropertyValue(name).trim()
    const rgba = color => {
      const [r, g, b, a] = bytes(color)
      return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
    }
    look = {
      id: v('--wallpaper') || 'none',
      size: parseFloat(v('--wallpaper-font-size')) || 14,
      family: v('--font-term') || 'monospace',
      colors: Object.fromEntries(ROLES.map(r => [r, rgba(v(`--wallpaper-${r}`) || v('--ink-3'))])),
    }
    if (previewing === look.id) previewing = null // a kept pick has reached theme.css
    measure()
    update()
    picker?.restyle()
  }

  let settle = 0
  new ResizeObserver(() => {
    if (!cells) return
    lastInput = performance.now() // and holds still, as after a key
    clearTimeout(settle)
    settle = setTimeout(() => { measure(); if (shown()) draw() }, SETTLE_MS)
  }).observe(pane)
  addEventListener('keydown', () => { if (!picker) lastInput = performance.now() }, true)
  document.addEventListener('visibilitychange', update)
  addEventListener('focus', () => { focused = true; update() })
  addEventListener('blur', () => { focused = false; update() })
  still.addEventListener('change', update)

  /** Opens the picker over the top of the pane: a live thumbnail of each scene. Arrows and the pointer
   * preview a scene in the pane, Enter or a click keeps it, and Escape puts back the one that was there. */
  function open() {
    const kept = look.id
    const ids = ['none', ...SCENES.map(s => s.id)]
    let at = Math.max(0, ids.indexOf(id()))
    const box = el('div', { className: 'wallpapers', tabIndex: -1 })
    const head = el('header')
    head.append(el('b', { textContent: 'Wallpaper' }), el('span', { textContent: '← → to look · ↵ to keep · esc to close' }))
    const strip = el('div', { className: 'cards' })
    const cards = ids.map((sid, i) => {
      const name = scene(sid)?.name ?? 'None'
      const card = el('button', { className: 'card', title: name, onclick: () => keep(i) })
      card.onpointerenter = () => point(i)
      const thumb = el('canvas')
      card.append(thumb, el('span', { textContent: name }))
      return { card, thumb, sid }
    })
    strip.append(...cards.map(c => c.card))
    box.append(head, strip)
    pane.append(box)

    /** Moves the picker to card `i` and previews its scene in the pane. */
    function point(i) {
      at = (i + ids.length) % ids.length
      cards.forEach((c, j) => c.card.classList.toggle('at', j === at))
      cards[at].card.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      previewing = ids[at] === kept ? null : ids[at]
      update()
    }
    async function keep(i) {
      point(i)
      const pick = ids[at]
      close(false)
      if (pick === kept) return
      previewing = pick // until theme.css names it, so the pane doesn't flash back to the old one
      try {
        await save(pick)
      } catch (e) {
        previewing = null
        update()
        throw e
      }
    }
    function close(revert = true) {
      if (picker !== api) return
      picker = null
      box.remove()
      removeEventListener('pointerdown', outside, true)
      if (revert) previewing = null
      update()
      onClose()
    }
    const outside = e => { if (!box.contains(e.target) && !button.contains(e.target)) close() }
    addEventListener('pointerdown', outside, true)
    box.onkeydown = e => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Tab: e.shiftKey ? -1 : 1 }[e.key]
      if (step) point(at + step)
      else if (e.key === 'Home' || e.key === 'End') point(e.key === 'Home' ? 0 : ids.length - 1)
      else if (e.key === 'Enter') keep(at)
      else if (e.key === 'Escape') close()
      else return
      e.preventDefault()
      e.stopPropagation()
    }

    let thumbs = [] // each card's context and grid, at the current theme
    const api = {
      focus: () => box.focus(),
      restyle() {
        thumbs = cards.map(({ thumb }) => {
          const { width, height } = thumb.getBoundingClientRect()
          return { ...fit(thumb, width, height, THUMB_PX, look.family, look.colors), last: null, spare: null }
        })
        api.tick(performance.now() - started)
      },
      tick(ms) {
        cards.forEach(({ sid }, i) => {
          const th = thumbs[i]
          const g = render(sid, th.cols, th.rows, ms / 1000, th.spare)
          paint(th.ctx, g, th.w, th.h, th.tiles, th.last)
          th.spare = th.last
          th.last = g
        })
      },
      close,
    }
    picker = api
    api.restyle()
    point(at)
    box.focus()
  }

  button.onclick = () => (picker ? picker.close() : open())

  return {
    restyle,
    /** Whether a Claude tab is in front, the only kind the wallpaper shows behind. */
    show(claude) {
      showing = claude
      update()
    },
  }
}
