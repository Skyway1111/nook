// The living wallpaper behind Claude tabs, and its picker. A canvas at the bottom of #pane draws a scene from
// wallpapers.js, which loads with the first scene other than none, under the terminal, whose background is
// transparent. theme.css names the scene in `--wallpaper`, so a theme can ship one, the user's theme.css overrides
// it, and every window follows a pick within a second. Each role's color, the opacity, and the cell size are theme
// variables too. A frame copies tiles from an atlas into only the cells that changed since the last one, each over
// its own ground, so a frame costs a few hundred small copies, not a full redraw.
import { bytes } from './palette.js'
import { el } from './ui.js'
import { SETTLE_MS } from './backdrops.js'

const FRAME_MS = 100 // ten frames a second. Characters step from cell to cell, so more frames would only cost.
const SPEEDS = [.25, 3] // --wallpaper-speed's range. Below 1 the frames slow with the scene, so a slower scene costs less.
const ECHO_MS = 50 // after a key, a frame waits this long at most for the key's echo, and draws in the animation frame after it
const THUMB_PX = 4 // the picker's thumbnails draw their cells this many pixels high
const still = matchMedia('(prefers-reduced-motion: reduce)')

/** Sizes `canvas` to a CSS box of `width` x `height` at the screen's pixel density, and fits cells to it: `size`
 * pixels high and `aspect` times narrower, each a whole number of device pixels, so a cell's copy never blurs or
 * leaves a seam. The last row ends `floor` CSS pixels above the bottom edge. Returns `{ ctx, w, h, top, cols, rows }`
 * in device pixels, `top` where the first row starts. The last column may run past the canvas's edge. */
function fit(canvas, width, height, size, aspect, floor = 0) {
  const dpr = devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(width * dpr))
  canvas.height = Math.max(1, Math.round(height * dpr))
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false // the ground stretches a pixel a cell
  const h = Math.max(2, Math.round(size * dpr))
  const w = Math.max(1, Math.round(h / aspect))
  const base = canvas.height - Math.round(floor * dpr)
  const rows = Math.max(1, Math.floor(base / h))
  return { ctx, w, h, top: base - rows * h, cols: Math.ceil(canvas.width / w), rows }
}

/** Draws the wallpaper in `pane`. `button` opens the picker, `save(id)` keeps a pick by setting
 * `--wallpaper` in the user's theme.css, `tune(name, value)` sets another of its variables, and `onClose`
 * hears the picker close. */
export function startWallpaper(pane, { button, save, tune, onClose }) {
  let art = null, loading = null // wallpapers.js, once a scene or the picker needs it
  const load = () => (loading ??= import('./wallpapers.js').then(m => { art = m; restyle() }))
  const canvas = pane.insertBefore(el('canvas', { className: 'wallpaper', hidden: true }), pane.firstChild)
  let speed = 1, since = performance.now(), before = 0 // the scene's clock runs at `speed` from `since`, when it read `before`
  let resting = false // with `--wallpaper-motion: working`, the scene holds still, its clock stopped, while no Claude session works
  let motion = 'always', working = false // theme.css's `--wallpaper-motion`, and whether a session in this window works
  const clock = now => before + (now - since) * (resting ? 0 : speed) / 1000 // seconds, in the scene's time
  /** Changes the clock's pace with `change`, the scene going on from where it is. */
  const rebase = change => {
    const now = performance.now()
    before = clock(now)
    since = now
    change()
  }
  const frameMs = () => FRAME_MS / Math.min(1, speed)
  let look = { id: 'none', size: 14, family: 'monospace', colors: {} } // theme.css's, at the last restyle
  let previewing = null // a scene the picker shows before it's kept
  let showing = true // false while a file tab is in front
  let focused = document.hasFocus() // the wallpaper moves only while nook's window has focus
  let cells = null // the canvas's context and cells, from fit, its tile atlas, and its scene's ground, while a scene shows
  let onCanvas = null, spare = null // the grid on the canvas, and one to draw the next frame into
  let floor = 0 // the scene stands this many CSS pixels above the pane's bottom, on the composer card
  let quiet = -Infinity, lastFrame = -Infinity, raf = 0 // no frame draws before `quiet`, while the pane resizes
  let typed = -Infinity // when the last key went down; until a terminal paints its echo, no frame draws on its own
  let picker = null // the open picker's { focus, restyle, tick, close }
  const held = new Map() // a picker slider's value, by variable, shown until theme.css carries it

  const id = () => previewing ?? look.id
  let faded = false // at no strength at all, the scene isn't drawn
  const shown = () => !!art?.scene(id()) && showing && !faded
  const live = () => shown() && focused && !document.hidden && !resting

  function measure() {
    onCanvas = spare = null // a new bitmap starts blank
    if (!shown()) {
      // A hidden canvas keeps no bitmap the size of the pane.
      canvas.width = canvas.height = 1
      cells = null
      return
    }
    const { width, height } = pane.getBoundingClientRect()
    floor = stand()
    cells = fit(canvas, width, height, look.size, art.ASPECT, floor)
    cells.tiles = art.atlas(cells.w, cells.h, look.family, look.colors)
    cells.sky = null // the scene whose ground `cells.ground` holds
  }

  /** Scene `sid`'s ground over `cols` x `rows` cells, on a canvas a pixel a cell. */
  function ground(sid, cols, rows) {
    const c = el('canvas', { width: cols, height: rows })
    c.getContext('2d').putImageData(new ImageData(art.ground(art.scene(sid), cols, rows, look.colors), cols, rows), 0, 0)
    return c
  }

  /** The top of the tallest composer card showing, above the pane's bottom. While none shows, as in Claude's
   * menus, the scene stands where it stood. */
  function stand() {
    let top = Infinity
    for (const card of pane.querySelectorAll('.composer')) if (card.offsetHeight) top = Math.min(top, card.getBoundingClientRect().top)
    return top < Infinity ? Math.max(0, Math.round(pane.getBoundingClientRect().bottom - top)) : floor
  }

  /** Draws the frame at `now`, touching only the cells that changed since the last one. */
  function draw(now = performance.now()) {
    lastFrame = now
    const c = cells
    if (c.sky !== id()) {
      c.ground = ground(id(), c.cols, c.rows)
      c.sky = id()
      onCanvas = spare = null
    }
    const g = art.render(id(), c.cols, c.rows, clock(now), spare)
    art.paint(c.ctx, g, c, c.tiles, c.ground, onCanvas)
    spare = onCanvas
    onCanvas = g
  }

  // One loop serves the pane and the picker's thumbnails. It stops while nothing moves. A timer wakes it once a
  // frame, and the frame draws in the next animation frame, so the page isn't asked for an animation frame sixty
  // times a second to draw ten. A frame that comes due while a key waits for its echo draws in the animation
  // frame after a terminal paints, so the echo never waits on it, and a held key never stops the scene.
  let timer = 0
  const due = now => now - lastFrame >= frameMs() - 4 && now >= quiet
  function schedule() {
    if (timer || raf || (!live() && !picker) || still.matches) return
    const now = performance.now()
    const wait = Math.max(0, frameMs() - (now - lastFrame), quiet - now, typed + ECHO_MS - now)
    timer = setTimeout(() => {
      timer = 0
      if (!raf) raf = requestAnimationFrame(frame)
    }, wait)
  }
  function frame(now) {
    raf = 0
    if (!live() && !picker) return
    if (due(now) && now - typed >= ECHO_MS) {
      lastFrame = now
      if (live()) draw(now)
      picker?.tick(clock(now))
    }
    schedule()
  }
  pane.addEventListener('nook-render', () => {
    if (typed === -Infinity) return
    typed = -Infinity // the echo painted
    if (!timer && !raf) return
    clearTimeout(timer)
    cancelAnimationFrame(raf) // one that would share the echo's paint
    timer = raf = 0
    if (due(performance.now() + 16)) raf = requestAnimationFrame(frame)
    else schedule()
  })

  /** Shows or hides the canvas for what's in front, and runs the loop while anything moves. */
  function update() {
    if (!art && id() !== 'none') load()
    const rest = motion === 'working' && !working && !picker && previewing == null // a scene being picked moves
    if (rest !== resting) rebase(() => { resting = rest })
    canvas.hidden = !shown()
    if (shown() !== !!cells) measure()
    if (shown()) draw()
    schedule()
  }

  /** Sets the scene's pace from a `--wallpaper-speed` value. */
  function retime(value) {
    const pace = Math.min(SPEEDS[1], Math.max(SPEEDS[0], parseFloat(value) || 1))
    if (pace !== speed) rebase(() => { speed = pace })
  }

  /** Reads the scene, colors, and cell size from theme.css. */
  function restyle() {
    const style = getComputedStyle(document.documentElement)
    const v = name => style.getPropertyValue(name).trim()
    look = {
      id: v('--wallpaper') || 'none',
      size: parseFloat(v('--wallpaper-font-size')) || 14,
      family: v('--font-term') || 'monospace',
      colors: Object.fromEntries((art?.ROLES ?? []).map(r => [r, bytes(v(`--wallpaper-${r}`) || v('--ink-3'))])),
    }
    for (const [name, value] of held) if (v(name) === value || parseFloat(v(name)) === parseFloat(value)) held.delete(name)
    motion = held.get('--wallpaper-motion') ?? v('--wallpaper-motion')
    retime(held.get('--wallpaper-speed') ?? v('--wallpaper-speed'))
    const strength = held.get('--wallpaper-opacity')
    canvas.style.opacity = strength ?? ''
    faded = parseFloat(strength ?? v('--wallpaper-opacity')) === 0
    if (previewing === look.id) previewing = null // a kept pick has reached theme.css
    measure()
    update()
    picker?.restyle()
  }

  // While the pane resizes, the last bitmap stretches; it redraws at the new size once SETTLE_MS passes without one.
  let settle = 0
  const resettle = () => {
    clearTimeout(settle)
    settle = setTimeout(() => { measure(); if (shown()) draw() }, SETTLE_MS)
  }
  new ResizeObserver(() => {
    if (!cells) return
    quiet = performance.now() + SETTLE_MS // the scene moves on from the redraw at the settled size
    resettle()
  }).observe(pane)
  pane.addEventListener('nook-card', () => { if (cells && stand() !== floor) resettle() })
  addEventListener('keydown', () => { if (!picker) typed = performance.now() }, true)
  document.addEventListener('visibilitychange', update)
  addEventListener('focus', () => { focused = true; update() })
  addEventListener('blur', () => { focused = false; update() })
  still.addEventListener('change', update)

  /** Opens the picker over the top of the pane: a live thumbnail of each scene. Arrows and the pointer
   * preview a scene in the pane, Enter or a click keeps it, and Escape puts back the one that was there. */
  function open() {
    if (picker) return
    const kept = look.id
    const ids = ['none', ...art.SCENES.map(s => s.id)]
    let at = Math.max(0, ids.indexOf(id()))
    const box = el('div', { className: 'wallpapers', tabIndex: -1 })
    const head = el('header')
    head.append(el('b', { textContent: 'Wallpaper' }), el('span', { textContent: '← → to look · ↵ to keep · esc to close' }))
    const strip = el('div', { className: 'cards' })
    const cards = ids.map((sid, i) => {
      const name = art.scene(sid)?.name ?? 'None'
      const card = el('button', { className: 'card', title: name, onclick: () => keep(i) })
      card.onpointerenter = () => point(i)
      const thumb = el('canvas')
      card.append(thumb, el('span', { textContent: name }))
      return { card, thumb, sid }
    })
    strip.append(...cards.map(c => c.card))
    box.append(head, strip)
    // How strongly and how fast the wallpaper shows, live while a slider moves, kept where it's let go.
    if (tune) {
      const style = getComputedStyle(document.documentElement)
      const sliders = [['--wallpaper-opacity', 'Strength', 0, 1, .05], ['--wallpaper-speed', 'Speed', SPEEDS[0], SPEEDS[1], .25]]
      const foot = box.appendChild(el('footer'))
      foot.append(...sliders.map(([name, label, min, max, step]) => {
        const input = el('input', { type: 'range', min, max, step, className: 'strength' })
        input.value = held.get(name) ?? (style.getPropertyValue(name).trim() || 1)
        input.oninput = () => {
          held.set(name, input.value)
          if (name === '--wallpaper-speed') retime(input.value)
          else {
            canvas.style.opacity = input.value
            faded = parseFloat(input.value) === 0
            update()
          }
        }
        input.onchange = () => tune(name, input.value).catch(e => { held.delete(name); restyle(); throw e })
        const row = el('label')
        row.append(el('span', { textContent: label }), input)
        return row
      }))
      // Still while Claude rests: the wallpaper moves only while a session in this window works, so it shows
      // when Claude is busy and costs nothing while it isn't.
      const toggle = el('input', { type: 'checkbox', checked: motion === 'working' })
      toggle.onchange = () => {
        const value = toggle.checked ? 'working' : 'always'
        held.set('--wallpaper-motion', value)
        motion = value
        tune('--wallpaper-motion', toggle.checked ? value : null).catch(e => { held.delete('--wallpaper-motion'); restyle(); throw e })
      }
      const row = el('label', { title: 'Hold still while no Claude session in this window is working' })
      row.append(toggle, el('span', { textContent: 'Move only while Claude works' }))
      box.appendChild(el('footer', { className: 'motion' })).append(row)
    }
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
      if (pick !== kept) await use(pick)
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
      if (e.target.type === 'range' && e.key !== 'Escape') return // its arrows move the slider
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
        let tiles = null // one atlas serves every thumbnail, all one size
        thumbs = cards.map(({ thumb, sid }) => {
          const { width, height } = thumb.getBoundingClientRect()
          const c = fit(thumb, width, height, THUMB_PX, art.ASPECT)
          tiles ??= art.atlas(c.w, c.h, look.family, look.colors)
          return { ...c, tiles, ground: ground(sid, c.cols, c.rows), last: null, spare: null }
        })
        api.tick(clock(performance.now()))
      },
      tick(t) {
        cards.forEach(({ sid }, i) => {
          const th = thumbs[i]
          const g = art.render(sid, th.cols, th.rows, t, th.spare)
          art.paint(th.ctx, g, th, th.tiles, th.ground, th.last)
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

  /** Keeps scene `sid`, showing it until theme.css names it, so the pane doesn't flash back to the old one. */
  async function use(sid) {
    previewing = sid === look.id ? null : sid
    update()
    try {
      await save(sid)
    } catch (e) {
      previewing = null
      update()
      throw e
    }
  }

  button.onclick = () => (picker ? picker.close() : load().then(open))
  button.onpointerenter = load // the picker's scenes load as the pointer reaches its button

  return {
    restyle,
    /** Loads the scenes, which `scenes` lists from then on. */
    load,
    /** Every scene's id and name, none first. */
    scenes: () => [['none', 'None'], ...(art?.SCENES ?? []).map(s => [s.id, s.name])],
    /** Shows scene `sid` in the pane until `unpeek`, as the picker's arrows do. */
    peek(sid) {
      if (picker) return
      previewing = sid === look.id ? null : sid
      update()
    },
    unpeek() {
      if (picker || previewing == null) return
      previewing = null
      update()
    },
    use,
    /** Whether any Claude session in this window is working, which moves a wallpaper set to `working`. */
    working(on) {
      if (on === working) return
      working = on
      update()
    },
    /** Whether a Claude tab is in front, the only kind the wallpaper shows behind. */
    show(claude) {
      showing = claude
      update()
    },
  }
}
