// The composer: a card nook paints over Claude's prompt. It draws the rows Claude draws between its two
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

/** A `/model` alias as the menu shows it: opus[1m] is Opus 1M. */
const aliasLabel = a => a[0].toUpperCase() + a.slice(1).replace('[1m]', ' 1M')

/** A cell's foreground as CSS: Claude's RGB, a theme palette color, or '' for the default. */
function fg(cell) {
  if (cell.isFgDefault()) return ''
  const c = cell.getFgColor()
  if (cell.isFgRGB()) return '#' + c.toString(16).padStart(6, '0')
  const name = slotVar(c)
  return name ? `var(${name})` : ''
}

/** The model and effort menus and the context ring, from what nook's mod reports (`src-tauri/mod`). */
function chipsHtml({ model, effort, context }) {
  if (!model) return ''
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model) // claude-opus-5-5[1m] is Opus 5.5
  const name = m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : model
  const words = `<button data-menu="model">${esc(name)}</button><button data-menu="effort">${esc(effort ?? 'effort')}</button>`
  if (context?.percent == null) return words
  const title = `${(context.tokens ?? 0).toLocaleString()} of ${context.window.toLocaleString()} tokens`
  return words + `<svg class="ring" viewBox="0 0 20 20"><title>${title}</title><circle cx="10" cy="10" r="7.5"/>`
    + `<circle cx="10" cy="10" r="7.5" pathLength="100" stroke-dasharray="${context.percent} 100"/></svg>`
}

export function startComposer(term, host, cwd, id) {
  const card = host.appendChild(el('div', { className: 'composer', hidden: true }))
  card.innerHTML = '<div class="frame"><div class="thumbs"></div><div class="draft"></div><div class="foot"><div class="hints"></div><div class="chips"></div></div></div>'
  const frame = card.firstChild
  // Each part repaints only when its own HTML changes, so a keystroke leaves the menus and thumbnails be.
  const parts = Object.fromEntries(['thumbs', 'draft', 'hints', 'chips'].map(k => [k, frame.querySelector(`.${k}`)]))
  const screen = host.querySelector('.xterm-screen')
  const rows = host.querySelector('.xterm-rows')
  const cell = term.buffer.active.getNullCell()
  const line = y => term.buffer.active.getLine(term.buffer.active.viewportY + y)
  const images = new Map() // [Image #N] -> its file, once found
  let imageKey = ''
  let shown = {} // what each part of the card shows
  let geo = null // the screen's box inside the host, measured on resize
  let report = '' // the mod's last report, as JSON
  let state = {} // ...and parsed
  let chips = ''

  /** The cell after the last one that draws anything. */
  function end(l, from) {
    let x = term.cols
    while (x > from && !(l.getCell(x - 1, cell).getChars().trim() || !cell.isAttributeDefault())) x--
    return x
  }

  /** Cells `from` on as styled runs. Each run's `data-x` is its first cell, for clicks. */
  function runs(l, from, caret = -1) {
    const last = Math.max(end(l, from), caret + 1)
    let html = ''
    let style = null
    let text = ''
    let start = from
    const flush = () => {
      if (text) html += `<span data-x="${start}" class="${style[0]}" style="color:${style[1]}">${esc(text)}</span>`
      text = ''
    }
    for (let x = from; x < last; x++) {
      l.getCell(x, cell)
      if (x === caret) { flush(); style = null; html += '<i class="caret"></i>' }
      if (!cell.getWidth()) continue // the right half of a wide character
      const cls = (cell.isBold() ? 'b ' : '') + (cell.isItalic() ? 'i ' : '') + (cell.isDim() ? 'd ' : '')
        + (cell.isUnderline() ? 'u ' : '') + (cell.isInverse() ? 'v' : '')
      const color = fg(cell)
      if (!style || cls !== style[0] || color !== style[1]) { flush(); style = [cls, color]; start = x }
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
    const draft = []
    let all = ''
    for (let y = top + 1; y < bottom; y++) {
      const badge = y === top + 1 && mark !== '❯' ? `<b class="mark">${esc(mark)}</b>` : ''
      draft.push(`<div data-y="${y}">${badge}${runs(line(y), 2, y === b.cursorY ? b.cursorX : -1)}</div>`)
      all += text(y)
    }
    const foot = []
    for (let y = bottom + 1; y < term.rows; y++) {
      const s = text(y)
      if (s.trim()) foot.push(`<div>${runs(line(y), s.length - s.trimStart().length)}</div>`)
    }
    const nums = [...new Set(Array.from(all.matchAll(/\[Image #(\d+)\]/g), m => Number(m[1])))]
    findImages(nums)
    const thumbs = nums.filter(n => images.has(n)).map(n => `<img data-n="${n}" src="${convertFileSrc(images.get(n))}" alt="">`)
    return {
      block: term.rows - top,
      rule: color,
      thumbs: thumbs.join(''),
      draft: draft.join(''),
      hints: foot.join(''),
      chips: (name ? `<span>${esc(name)}</span>` : '') + chips,
    }
  }

  /** Looks up the image files the draft names, once for each set of numbers. */
  function findImages(nums) {
    const key = nums.join()
    if (key === imageKey) return
    imageKey = key
    for (const n of nums) {
      invoke('session_image', { cwd, n }).then(path => {
        if (imageKey !== key || !path) return
        images.set(n, path)
        render()
      })
    }
  }

  function render() {
    const next = read()
    if (!next) {
      if (!card.hidden) { card.hidden = true; place() }
      return
    }
    for (const k in parts) if (next[k] !== shown[k]) parts[k].innerHTML = next[k]
    if (next.rule !== shown.rule) frame.style.setProperty('--rule', next.rule)
    const moved = card.hidden || next.block !== shown.block
    shown = next
    card.hidden = false
    if (moved) place()
  }

  /** Lines the card up with the screen's bottom rows, and hides Claude's own prompt under it. */
  function place() {
    if (card.hidden || !geo) { rows.style.clipPath = ''; return }
    const { block } = shown
    const below = (block * geo.height) / term.rows
    Object.assign(card.style, {
      left: `${geo.left}px`,
      width: `${geo.width}px`,
      bottom: `${geo.bottom}px`,
      minHeight: `${below}px`,
    })
    card.style.setProperty('--row', `${geo.height / term.rows}px`) // a line per row, so the card fits
    rows.style.clipPath = `inset(0 0 ${below}px 0)`
  }

  term.onRender(render)
  const measure = new ResizeObserver(() => {
    const h = host.getBoundingClientRect()
    const s = screen.getBoundingClientRect()
    geo = { left: s.left - h.left, width: s.width, height: s.height, bottom: h.bottom - s.bottom }
    place()
  })
  measure.observe(host)
  measure.observe(screen)

  // A click on the card lands on the cell under the same character, where Claude puts its caret.
  card.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.thumbs, .chips')) return
    e.preventDefault() // the focus stays in xterm
    term.focus()
    const target = hit(e.clientX, e.clientY)
    if (!target) return
    const s = screen.getBoundingClientRect()
    const at = {
      bubbles: true,
      clientX: s.left + ((target.x + 0.5) * s.width) / term.cols,
      clientY: s.top + ((target.y + 0.5) * s.height) / term.rows,
    }
    screen.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }))
    screen.dispatchEvent(new MouseEvent('mouseup', at))
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
    if (!run) return { x: end(l, 2), y: ry } // beside the text: its end
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
    openMenu(e, menu === 'model'
      ? (state.models ?? []).map(a => [aliasLabel(a), a === state.alias ? CHECK : '', pick('model', a)])
      : (state.efforts ?? []).map(l => [l, l === state.effort ? CHECK : '', pick('effort', l)]))
  })

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
    report = text
    render()
  }, 500)

  return { close: () => clearInterval(poll) }
}
