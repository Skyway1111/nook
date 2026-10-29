// The living wallpaper behind Claude tabs, and its picker. A canvas at the bottom of #pane draws a scene from
// wallpapers.js under the terminal, whose background is transparent. theme.css names the scene in
// `--wallpaper`, so a theme can ship one, the user's theme.css overrides it, and every window follows a pick
// within a second. Each role's color, the opacity, and the cell size are theme variables too.
import { ROLES, SCENES, paint, render, scene } from './wallpapers.js'
import { bytes } from './palette.js'
import { el } from './ui.js'

const FRAME_MS = 100 // ten frames a second. Characters step from cell to cell, so more frames would only cost.
const REST_MS = 600 // after a key, the wallpaper holds still this long, so a keystroke's repaint never waits on a frame
const THUMB_PX = 4 // the picker's thumbnails draw their cells this many pixels high
const still = matchMedia('(prefers-reduced-motion: reduce)')

/** Sizes `canvas` to its CSS box at the screen's pixel density. Returns its context, set to draw in CSS pixels. */
function fit(canvas, width, height, font) {
  const dpr = devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(width * dpr))
  canvas.height = Math.max(1, Math.round(height * dpr))
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.font = font
  ctx.textBaseline = 'top'
  return ctx
}

/** Draws the wallpaper in `pane`. `button` opens the picker, `save(id)` keeps a pick by setting
 * `--wallpaper` in the user's theme.css, and `onClose` hears the picker close. */
export function startWallpaper(pane, { button, save, onClose }) {
  const canvas = pane.insertBefore(el('canvas', { className: 'wallpaper', hidden: true }), pane.firstChild)
  const started = performance.now()
  let look = { id: 'none', size: 14, family: 'monospace', colors: {} } // theme.css's, at the last restyle
  let previewing = null // a scene the picker shows before it's kept
  let showing = true // false while a file tab is in front
  let ctx, cell, cols = 0, rows = 0
  let lastKey = -Infinity, lastFrame = -Infinity, raf = 0
  let picker = null // the open picker's { focus, restyle, tick, close }

  const id = () => previewing ?? look.id
  const live = () => !!scene(id()) && showing && !document.hidden

  function measure() {
    const { width, height } = pane.getBoundingClientRect()
    ctx = fit(canvas, width, height, `${look.size}px ${look.family}`)
    cell = { w: ctx.measureText('M').width || look.size * 0.6, h: Math.ceil(look.size) }
    cols = Math.ceil(width / cell.w)
    rows = Math.ceil(height / cell.h)
  }

  function draw(now = performance.now()) {
    lastFrame = now
    paint(ctx, render(id(), cols, rows, (now - started) / 1000), cell.w, cell.h, look.colors)
  }

  // One loop serves the pane and the picker's thumbnails. It stops while nothing moves, and rests after a key.
  function frame(now) {
    raf = 0
    if (!live() && !picker) return
    if (now - lastFrame >= FRAME_MS && now - lastKey >= REST_MS) {
      if (live()) draw(now)
      else lastFrame = now
      picker?.tick(now - started)
    }
    if (!still.matches) raf = requestAnimationFrame(frame)
  }

  /** Shows or hides the canvas for what's in front, and runs the loop while anything moves. */
  function update() {
    canvas.hidden = !live()
    if (live()) draw()
    if ((live() || picker) && !raf) raf = requestAnimationFrame(frame)
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

  new ResizeObserver(() => { measure(); if (live()) draw() }).observe(pane)
  addEventListener('keydown', () => { if (!picker) lastKey = performance.now() }, true)
  document.addEventListener('visibilitychange', update)
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
          const ctx = fit(thumb, width, height, `${THUMB_PX}px ${look.family}`)
          const w = ctx.measureText('M').width || THUMB_PX * 0.6
          return { ctx, w, cols: Math.ceil(width / w), rows: Math.ceil(height / THUMB_PX) }
        })
        api.tick(performance.now() - started)
      },
      tick(ms) {
        cards.forEach(({ sid }, i) => {
          const { ctx, w, cols, rows } = thumbs[i]
          paint(ctx, render(sid, cols, rows, ms / 1000), w, THUMB_PX, look.colors)
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
