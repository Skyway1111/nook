// The composer: a card nook paints over Claude's prompt. It draws the draft Claude draws between its two
// prompt rules and never takes input. Keys go to xterm, and a click on the card becomes a click on the
// cell under the same character. It hides whenever the screen stops matching the prompt's shape.
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { el, openMenu } from './ui.js'
import { slotVar } from './palette.js'

const CHECK = ''
const esc = s => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)

/** A full-width prompt rule as its label, such as the session's name; '' for none, null for any other row. */
function ruleLabel(s, cols) {
  const m = s.length >= cols - 1 && /^─{3,}(?: (.+?) ─+)?$/.exec(s)
  return m ? (m[1] ?? '') : null
}

const capital = s => s[0].toUpperCase() + s.slice(1)

/** A cell color as CSS: Claude's RGB, a theme palette color, or '' for the default. */
function color(none, rgb, c) {
  if (none) return ''
  if (rgb) return '#' + c.toString(16).padStart(6, '0')
  const name = slotVar(c)
  return name ? `var(${name})` : ''
}
const fg = cell => color(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor())
const bg = cell => color(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor()) // such as Claude's selection

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

/** The model and effort menus and the context ring, from what nook's mod reports (`src-tauri/mod`). */
function chipsHtml({ model, effort, context }) {
  if (!model) return ''
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model) // claude-opus-5-5[1m] is Opus 5.5
  const name = m ? `${capital(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : model
  const words = `<button data-menu="model">${esc(name)}</button><button data-menu="effort">${esc(effort ?? 'effort')}</button>`
  if (!context?.window) return words
  const { tokens = 0, percent = 0 } = context // a new or cleared session has no tokens yet
  const arc = percent ? `<circle cx="10" cy="10" r="7.5" pathLength="100" stroke-dasharray="${percent} 100"/>` : ''
  const title = `${tokens.toLocaleString()} of ${context.window.toLocaleString()} tokens`
  return words + `<svg class="ring" viewBox="0 0 20 20"><title>${title}</title>`
    + `<circle cx="10" cy="10" r="7.5"/>${arc}</svg>`
}

export function startComposer(term, host, id) {
  const card = host.appendChild(el('div', { className: 'composer', hidden: true }))
  card.innerHTML = '<div class="frame"><div class="thumbs"></div><div class="draft"></div><div class="foot"><div class="hints"></div><div class="chips"></div></div></div>'
  const frame = card.firstChild
  // Each part repaints only when its own HTML changes, so a keystroke leaves the menus and thumbnails be.
  const parts = Object.fromEntries(['thumbs', 'draft', 'hints', 'chips'].map(k => [k, frame.querySelector(`.${k}`)]))
  const screen = host.querySelector('.xterm-screen')
  const rows = host.querySelector('.xterm-rows')
  // xterm's input textarea and IME text leave the screen, which moves and is a layer of its own, so they stay
  // above the card. `follow` lines them up with the card's caret, so composing text shows there.
  const helpers = term.element.appendChild(host.querySelector('.xterm-helpers'))
  const cell = term.buffer.active.getNullCell()
  const line = y => term.buffer.active.getLine(term.buffer.active.viewportY + y)
  const images = new Map() // [Image #N] -> its file, once found
  let imageKey = ''
  let shown = {} // what each part of the card shows
  let geo = null // the screen's box inside the host, measured on resize
  let held = null // the rows of the frame xterm holds while a resize waits for Claude's redraw
  let tall = 0 // the card's height as last laid out, 0 while it or its tab is hidden
  let report = '' // the mod's last report, as JSON
  let state = {} // ...and parsed
  let chips = ''

  /** The cell after the last one that draws anything: a character, or unless `text`, a styled blank. */
  function end(l, from, text = false) {
    let x = term.cols
    while (x > from && !(l.getCell(x - 1, cell).getChars().trim() || (!text && !cell.isAttributeDefault()))) x--
    return x
  }

  /** A draft row's text in cells: its length, the cells its first and last words take, and the look of the
   * cell after it, which Claude paints when its selection runs on to the next row. */
  function words(l) {
    const len = end(l, 2, true) - 2
    let first = len
    let last = len
    for (let x = 2; x < len + 2; x++) {
      if (!l.getCell(x, cell).getWidth() || cell.getChars().trim()) continue
      if (first === len) first = x - 2
      last = len + 1 - x
    }
    const after = len + 2 < term.cols && bg(l.getCell(len + 2, cell))
    return { len, first, last, after }
  }

  /** How Claude broke the draft between rows `a` and `b`: null at a newline the user typed, ' ' where it
   * wrapped at a space, which it drops, or '' inside a word longer than a row, which it splits. Claude
   * wraps the draft at `cols - 4` cells, so any break the next word would have fit before is a newline. */
  function joint(a, b) {
    const room = term.cols - 4
    if (!a.len || !b.len || a.len + 1 + b.first <= room) return null
    return a.len >= room - 1 && a.last + b.first > room ? '' : ' '
  }

  /** Cells `from` up to `last` as styled runs, with the caret before cell `caret`. Each run's `data-x` is its
   * first cell, for clicks. */
  function runs(l, from, last, caret = -1) {
    let html = ''
    let style = null
    let text = ''
    let start = from
    const flush = () => {
      if (text) html += `<span data-x="${start}" class="${style[0]}" style="${style[1]}">${esc(text)}</span>`
      text = ''
    }
    for (let x = from; x <= last; x++) {
      // A zero-width non-joiner gives the caret the line's height and, as a combining mark, no break of its own.
      if (x === caret) { flush(); style = null; html += '<i class="caret">&zwnj;</i>' }
      if (x === last) break
      l.getCell(x, cell)
      if (!cell.getWidth()) continue // the right half of a wide character
      const cls = (cell.isBold() ? 'b ' : '') + (cell.isItalic() ? 'i ' : '') + (cell.isDim() ? 'd ' : '')
        + (cell.isUnderline() ? 'u ' : '') + (cell.isInverse() ? 'v' : '')
      const look = `color:${fg(cell)};background:${bg(cell)}`
      if (!style || cls !== style[0] || look !== style[1]) { flush(); style = [cls, look]; start = x }
      text += cell.getChars() || ' '
    }
    flush()
    return html
  }

  /** The prompt block at the bottom of Claude's fullscreen view, as the HTML of each part of the card, or null. */
  function read() {
    const b = term.buffer.active
    if (b.type !== 'alternate') return null
    const text = y => line(y)?.translateToString(true) ?? ''
    const rule = y => ruleLabel(text(y), term.cols)
    let bottom = term.rows - 1
    while (bottom > 1 && rule(bottom) == null) bottom--
    let top = bottom - 1
    while (top >= 0 && rule(top) == null) top--
    // Claude writes a no-break space after the marker, so \s and not ' '.
    if (top < 0 || bottom - top < 2 || !/^\S(\s|$)/.test(text(top + 1))) return null
    for (let y = top + 2; y < bottom; y++) if (!/^(\s{2}|$)/.test(text(y))) return null

    const mark = line(top + 1).getCell(0, cell).getChars()
    const name = rule(top)
    const color = fg(line(top).getCell(0, cell)) || 'var(--line)'
    // Claude's rows join back into the lines the user typed, and the card wraps them at its own width. Each
    // row's runs sit in a span with its `data-y`, for clicks.
    const lines = []
    let all = ''
    for (let y = top + 1; y < bottom; y++) {
      const l = line(y)
      const caret = y === b.cursorY ? b.cursorX : -1
      const row = words(l)
      lines.push({ y, ...row, html: runs(l, 2, Math.max(row.len + 2, caret), caret) })
      all += text(y)
    }
    let draft = `<div>${mark !== '❯' ? `<b class="mark">${esc(mark)}</b>` : ''}`
    lines.forEach((r, i) => {
      const next = lines[i + 1]
      const join = next ? joint(r, next) : null
      const gap = join && `<span data-x="${r.len + 2}"${r.after ? ` style="background:${r.after}"` : ''}>${join}</span>`
      draft += `<span data-y="${r.y}">${r.html}${gap || ''}</span>`
      if (next && join == null) draft += '</div><div>'
    })
    draft += '</div>'
    const foot = []
    for (let y = bottom + 1; y < term.rows; y++) {
      const s = text(y)
      const from = s.length - s.trimStart().length
      if (s.trim()) foot.push(`<div>${runs(line(y), from, end(line(y), from))}</div>`)
    }
    const nums = [...new Set(Array.from(all.matchAll(/\[Image #(\d+)\]/g), m => Number(m[1])))]
    findImages(nums)
    const thumbs = nums.filter(n => images.has(n)).map(n => `<img data-n="${n}" src="${convertFileSrc(images.get(n))}" alt="">`)
    return {
      block: term.rows - top,
      rule: color,
      thumbs: thumbs.join(''),
      draft,
      hints: foot.join(''),
      chips: (name ? `<span>${esc(name)}</span>` : '') + chips,
    }
  }

  /** Looks up the image files the draft names, once for each set of numbers. Claude can draw [Image #N] a
   * moment before it writes the file, so a miss looks again, for up to 3 s. */
  function findImages(nums) {
    const key = nums.join()
    if (key === imageKey) return
    imageKey = key
    const find = (n, tries) => invoke('session_image', { id, n }).then(path => {
      if (imageKey !== key) return
      if (path) {
        images.set(n, path)
        render()
      } else if (tries) setTimeout(find, 100, n, tries - 1)
    })
    for (const n of nums) find(n, 30)
  }

  /** Repaints the card from the screen. `moved` lays it out again even when nothing in it changed. */
  function render(moved = false) {
    if (held != null) return // the card shows the prompt of the frame xterm holds
    const next = read()
    if (!next) {
      if (!card.hidden || moved) {
        card.hidden = true
        layout()
      }
      return
    }
    let changed = moved || card.hidden || next.block !== shown.block
    for (const k in parts) {
      if (next[k] === shown[k]) continue
      parts[k].innerHTML = next[k]
      changed = true
    }
    if (next.rule !== shown.rule) frame.style.setProperty('--rule', next.rule)
    const typed = next.draft !== shown.draft
    shown = next
    card.hidden = false
    if (!changed) return
    if (typed) reveal()
    layout()
  }

  /** Hides Claude's prompt block under the card, which sits on the terminal's bottom edge, and moves the screen
   * by the card's height less that block, so Claude's rows above the prompt, such as the slash menu, sit right
   * above the card. A frame xterm holds through a resize keeps its bottom row on the screen's bottom row. */
  function layout() {
    if (!geo) return
    if (card.offsetHeight !== tall) {
      tall = card.offsetHeight
      card.dispatchEvent(new Event('nook-card', { bubbles: true })) // the wallpaper stands its scene on the card
    }
    const h = geo.height / term.rows
    const snap = px => Math.round(px * devicePixelRatio) / devicePixelRatio
    const hold = held == null ? 0 : snap((term.rows - held) * h)
    rows.style.transform = hold ? `translateY(${hold}px)` : ''
    if (card.hidden) {
      rows.style.clipPath = ''
      screen.style.transform = helpers.style.transform = ''
      return
    }
    const below = shown.block * h
    rows.style.clipPath = `inset(0 0 ${below + hold}px 0)`
    const shift = snap(tall - below)
    screen.style.transform = shift ? `translateY(${-shift}px)` : ''
    follow()
  }

  /** Moves xterm's textarea, which sits at Claude's cursor cell, to the card's caret. */
  function follow() {
    const caret = !card.hidden && parts.draft.querySelector('.caret')
    if (!caret) return void (helpers.style.transform = '')
    const at = caret.getBoundingClientRect()
    const box = host.getBoundingClientRect()
    const b = term.buffer.active
    const x = at.left - box.left - geo.left - (b.cursorX * geo.width) / term.cols
    const y = at.top - box.top - geo.top - (b.cursorY * geo.height) / term.rows
    helpers.style.transform = `translate(${x}px, ${y}px)`
  }

  /** Scrolls a draft taller than the card so the caret shows. */
  function reveal() {
    const d = parts.draft
    const caret = d.scrollHeight > d.clientHeight && d.querySelector('.caret')
    if (!caret) return
    const box = d.getBoundingClientRect()
    const at = caret.getBoundingClientRect()
    if (at.top < box.top) d.scrollTop -= box.top - at.top
    else if (at.bottom > box.bottom) d.scrollTop += at.bottom - box.bottom
  }

  term.onRender(() => {
    const moved = held != null // the held frame gives way to the redraw
    held = null
    render(moved)
  })
  /** Where `e` sits inside the host as laid out, before any shift. */
  function offset(e) {
    let left = 0
    let top = 0
    for (; e && e !== host; e = e.offsetParent) { left += e.offsetLeft; top += e.offsetTop }
    return { left, top }
  }
  // The screen's box as laid out, before the shift. The card's own size moves the screen too, as when a font
  // changes or a thumbnail loads. `layout` sizes nothing, so this never loops.
  // The card sits on the terminal's bottom edge, from its left edge to the scrollbar, and takes at most 70% of
  // its height. CSS anchor positioning did this, but WebKit then laid out the whole page on each keystroke,
  // a fifth of the CPU that typing took.
  const gutter = host.querySelector('.xterm .scrollbar.vertical')
  const measure = new ResizeObserver(() => {
    geo = { ...offset(screen), width: screen.offsetWidth, height: screen.offsetHeight }
    const box = term.element
    const at = offset(box)
    const style = {
      left: `${at.left}px`,
      bottom: `${host.clientHeight - at.top - box.offsetHeight}px`,
      right: `${host.clientWidth - (gutter ? offset(gutter).left : at.left + box.offsetWidth)}px`,
      maxHeight: `${box.offsetHeight * 0.7}px`,
    }
    for (const k in style) if (card.style[k] !== style[k]) card.style[k] = style[k]
    layout()
  })
  measure.observe(host)
  measure.observe(screen)
  measure.observe(card)
  if (gutter) measure.observe(gutter)

  /** Sends xterm a left-button event at the middle of cell `at`, which reaches Claude's mouse tracking. */
  function send(type, at) {
    const s = screen.getBoundingClientRect()
    screen.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      buttons: type === 'mouseup' ? 0 : 1,
      clientX: s.left + ((at.x + 0.5) * s.width) / term.cols,
      clientY: s.top + ((at.y + 0.5) * s.height) / term.rows,
    }))
  }

  // A press on the draft lands on the cell under the same character, where Claude puts its caret. A drag
  // from there selects through Claude, which copies the selection on release.
  card.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.thumbs, .chips')) return
    e.preventDefault() // the focus stays in xterm
    term.focus()
    const from = hit(e.clientX, e.clientY)
    if (!from) return
    send('mousedown', from)
    // xterm reads the drag from the document. Over the card, each real event stops at the window and goes on
    // as the cell under its character. Off the card, xterm's own reading is right.
    const drag = m => {
      if (m.isTrusted && card.contains(m.target)) {
        m.stopPropagation()
        const d = parts.draft.getBoundingClientRect()
        const to = hit(clamp(m.clientX, d.left, d.right - 1), clamp(m.clientY, d.top, d.bottom - 1)) ?? from
        // Claude selects both end cells, so a forward drag ends on the character before the pointer.
        const ahead = to.y > from.y || (to.y === from.y && to.x > from.x)
        send(m.type, ahead ? { x: to.x - 1, y: to.y } : to)
      }
      if (m.type === 'mouseup') {
        window.removeEventListener('mousemove', drag, true)
        window.removeEventListener('mouseup', drag, true)
      }
    }
    window.addEventListener('mousemove', drag, true)
    window.addEventListener('mouseup', drag, true)
  })

  // The wheel scrolls Claude's transcript, as it does over Claude's own prompt.
  card.addEventListener('wheel', e => {
    e.preventDefault()
    screen.dispatchEvent(new WheelEvent('wheel', e))
  }, { passive: false })

  /** The buffer cell under the card's character at (x, y), or null off the draft. */
  function hit(x, y) {
    const pos = document.caretPositionFromPoint(x, y)
    const node = pos?.offsetNode
    const at = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node
    const row = at?.closest?.('[data-y]')
    if (!row || !card.contains(row)) return null
    const ry = Number(row.dataset.y)
    const l = line(ry)
    const run = at.closest('[data-x]')
    if (!run) return { x: end(l, 2, true), y: ry } // beside the text: its end
    let cx = Number(run.dataset.x)
    for (let n = pos.offset; n > 0 && cx < term.cols; cx++) {
      if (l.getCell(cx, cell).getWidth()) n -= cell.getChars().length || 1
    }
    return { x: cx, y: ry }
  }

  card.addEventListener('click', e => {
    const path = images.get(Number(e.target.dataset?.n))
    if (path) invoke('open_path', { path })
    const menu = e.target.closest('[data-menu]')?.dataset.menu
    if (!menu) return
    // The mod runs the pick as /model or /effort once Claude is idle, and the draft stays as typed.
    const pick = (command, args) => () => { invoke('pty_command', { id, command, args }); term.focus() }
    const family = /^claude-([a-z]+)/.exec(state.model)?.[1] // the alias that names the model in use
    openMenu(e, menu === 'model'
      ? (state.models ?? []).map(a => [capital(a), a === family ? CHECK : '', pick('model', a)])
      : (state.efforts ?? []).map(l => [l, l === state.effort ? CHECK : '', pick('effort', l)]))
  })

  // A Run pressed under a shell block in Claude's reply: typed as Claude's ! command, without Enter. One the
  // tab reported before this poll first read it is old, and isn't typed again; nor is an old Review.
  let ran
  let reviewed
  const poll = setInterval(async () => {
    if (!host.offsetWidth) return
    const text = await invoke('pty_state', { id })
    if (!text || text === report) return
    try {
      state = JSON.parse(text)
      chips = chipsHtml(state)
    } catch {
      return // caught mid-write; the next poll reads it whole
    }
    const run = state.run
    if (report && run?.at && run.at !== ran && typeof run.command === 'string') {
      term.input('!')
      term.paste(run.command)
      term.focus()
    }
    ran = run?.at
    // The band's Review, after a turn that edited files: nook opens those files' changes.
    const review = state.review
    if (report && review?.at && review.at !== reviewed && Array.isArray(review.files)) {
      dispatchEvent(new CustomEvent('nook-review', { detail: { root: state.root, files: review.files } }))
    }
    reviewed = review?.at
    report = text
    render()
  }, 500)

  return {
    /** xterm holds its last frame, `n` rows tall, until Claude redraws for the new size. */
    hold(n) {
      held = n
      layout()
    },
    close: () => clearInterval(poll),
  }
}
