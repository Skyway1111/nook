// Ctrl+Shift+F finds text in a Claude tab: everything Claude wrote, scrollback included, with each match
// marked and the current one ringed. Enter and Shift+Enter step through them, Esc puts the bar away. The
// bar and its search addon load the first time it opens, so a tab that never searches pays nothing for it.
// While Claude runs fullscreen, xterm holds only the screen, so the count is of the matches in view, and a
// step past the last one in view pages Claude's own view until another shows, wrapping at either end.
import { el } from './ui.js'
import { bytes } from './palette.js'
import { startPaging, transcriptEnd } from './turns.js'

const LIMIT = 2000 // matches marked at once; past that the bar counts "2000+"
const PAGES = 400 // the most pages one step turns through Claude's fullscreen view
const TO_TOP = '\x1b[1;5H' // Ctrl+Home
const TO_BOTTOM = '\x1b[1;5F' // Ctrl+End

/** A theme color as #rrggbb, the only form the addon's highlights take, over the terminal's background. */
function hex(color, under = [0, 0, 0, 0]) {
  const [r, g, b, a] = bytes(color)
  const t = a / 255
  const mix = (c, u) => Math.round(c * t + u * (1 - t)).toString(16).padStart(2, '0')
  return `#${mix(r, under[0])}${mix(g, under[1])}${mix(b, under[2])}`
}

/** Highlights in the theme's colors, read when a search runs so a theme change applies at once. */
function colors() {
  const style = getComputedStyle(document.documentElement)
  const v = name => style.getPropertyValue(name).trim()
  const bg = bytes(v('--term-bg') || v('--bg'))
  const accent = hex(v('--accent'), bg)
  return {
    matchBackground: hex(v('--selection'), bg),
    matchOverviewRuler: accent,
    activeMatchBackground: hex(v('--selection'), bg),
    activeMatchBorder: accent,
    activeMatchColorOverviewRuler: accent,
  }
}

/** A find bar over `host` for `term`, whose keys go to Claude through `send`. Returns `{ open, close, dispose }`. */
export function startSearch(term, host, send) {
  let addon // loaded on first use
  let bar, input, count
  let results // the addon's subscription
  const paging = startPaging(term, send)
  let busy = false // a step through Claude's fullscreen view is under way
  const fullscreen = () => term.buffer.active.type === 'alternate'

  function build() {
    input = el('input', { type: 'text', placeholder: 'Find', spellcheck: false, ariaLabel: 'Find in terminal' })
    count = el('span', { className: 'count' })
    const button = (text, title, act) => {
      const b = el('button', { textContent: text, title, tabIndex: -1 })
      b.addEventListener('mousedown', e => e.preventDefault()) // the input keeps focus
      b.addEventListener('click', act)
      return b
    }
    bar = el('div', { className: 'find', hidden: true })
    bar.append(input, count, button('↑', 'Previous (Shift+Enter)', () => run(false)), button('↓', 'Next (Enter)', () => run(true)), button('×', 'Close (Esc)', close))
    host.appendChild(bar)
    // As you type, the match nearest the bottom, where Claude's newest output is. Each letter narrows the
    // match it is on before looking further up.
    input.addEventListener('input', () => run(false, false))
    input.addEventListener('keydown', e => {
      e.stopPropagation() // these keys are the bar's, not Claude's or the window's
      if (e.key === 'Escape') close()
      else if (e.key === 'Enter' || e.key === 'F3') run(!e.shiftKey)
      else if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') input.select()
      else return
      e.preventDefault()
    })
  }

  let Addon // the addon's class, once loaded

  async function load() {
    ;({ SearchAddon: Addon } = await import('@xterm/addon-search'))
    renew()
  }

  /** A new addon in place of the old one. The addon keeps the lines it read for 15 s, until a line feed or a
   * cursor move; each of Claude's fullscreen redraws leaves the cursor where it was, so there every search
   * starts with a new one, which reads the screen as it is. */
  function renew() {
    results?.dispose()
    addon?.dispose()
    addon = new Addon({ highlightLimit: LIMIT })
    term.loadAddon(addon)
    results = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      const where = fullscreen() ? ' in view' : ''
      count.textContent = !input.value ? ''
        : !resultCount ? (where ? 'None in view' : 'No results')
        : resultIndex < 0 ? `${LIMIT}+${where}`
        : `${resultIndex + 1} of ${resultCount}${where}`
      bar.classList.toggle('none', !!input.value && !resultCount && !where)
    })
  }

  /** Steps to the next or previous match of what the bar holds; on Claude's fullscreen view a step, unlike
   * typing, pages on past the matches in view. */
  function run(forward, step = true) {
    if (!addon) return
    const query = input.value
    if (!query) {
      addon.clearDecorations()
      count.textContent = ''
      bar.classList.remove('none')
      return
    }
    // Smart case, as in an editor: a capital letter makes the search match case.
    const options = { caseSensitive: query !== query.toLowerCase(), decorations: colors() }
    if (fullscreen()) {
      if (step) return paged(!forward, query, options)
      renew()
      current = null
      return void findOnce(true, query, options)
    }
    if (forward) addon.findNext(query, options)
    else addon.findPrevious(query, options)
  }

  // On Claude's fullscreen view the match the bar is on is kept here, not as xterm's selection: with the
  // selection left on, the word under it vanished from Claude's view, so each step clears it again.
  let current = null // { x, y, size }

  /** One of the addon's steps from `current`, up or down: the match's place on the screen as one number in
   * reading order, or null. */
  function findOnce(up, query, options) {
    if (current) term.select(current.x, current.y, current.size)
    const found = up ? addon.findPrevious(query, options) : addon.findNext(query, options)
    const p = found && term.getSelectionPosition()
    term.clearSelection()
    current = p ? { x: p.start.x, y: p.start.y, size: (p.end.y - p.start.y) * term.cols + p.end.x - p.start.x } : null
    return current && current.y * term.cols + current.x
  }

  /** The match in view past `from` going up or down, or null: the addon's own steps until one lands past
   * it, on a row of Claude's transcript (not its pinned prompt or input box), before they come round. */
  function past(from, up, query, options) {
    const end = transcriptEnd(paging.screen()) * term.cols
    const seen = new Set()
    for (;;) {
      const found = findOnce(up, query, options)
      if (found === null || seen.has(found)) return null
      seen.add(found)
      if (found >= term.cols && found < end && (up ? found < from : found > from)) return found
    }
  }

  async function paged(up, query, options) {
    if (busy) return
    busy = true
    try {
      renew()
      let from = current ? current.y * term.cols + current.x : up ? Infinity : -Infinity
      let wrapped = false
      for (let page = 0; page < PAGES; page++) {
        if (past(from, up, query, options) !== null) return
        const { shift } = await paging.page(up)
        current = null
        renew()
        if (shift === null) return
        if (shift === 0) {
          // The view's end: go round once, from the other end.
          if (wrapped) break
          wrapped = true
          send(up ? TO_BOTTOM : TO_TOP)
          await paging.redrawn()
          renew()
          from = up ? Infinity : -Infinity
          continue
        }
        from += shift * term.cols
      }
      count.textContent = 'No results'
      bar.classList.add('none')
    } finally {
      busy = false
    }
  }
  async function open() {
    if (!bar) build()
    const selected = term.getSelection()
    if (selected && !selected.includes('\n')) input.value = selected
    bar.hidden = false
    input.focus()
    input.select()
    if (!addon) await load()
    if (input.value) run(false)
  }

  function close() {
    if (!bar || bar.hidden) return
    bar.hidden = true
    current = null
    addon?.clearDecorations()
    term.focus()
  }

  return {
    open,
    close,
    get opened() { return !!bar && !bar.hidden },
    dispose() {
      results?.dispose()
      addon?.dispose()
      bar?.remove()
    },
  }
}
