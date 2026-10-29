// Ctrl+Shift+F finds text in a Claude tab: everything Claude wrote, scrollback included, with each match
// marked and the current one ringed. Enter and Shift+Enter step through them, Esc puts the bar away. The
// bar and its search addon load the first time it opens, so a tab that never searches pays nothing for it.
import { el } from './ui.js'
import { bytes } from './palette.js'

const LIMIT = 2000 // matches marked at once; past that the bar counts "2000+"

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

/** A find bar over `host` for `term`. Returns `{ open, close, dispose }`. */
export function startSearch(term, host) {
  let addon // loaded on first use
  let bar, input, count
  let results // the addon's subscription

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
    input.addEventListener('input', () => run(false))
    input.addEventListener('keydown', e => {
      e.stopPropagation() // these keys are the bar's, not Claude's or the window's
      if (e.key === 'Escape') close()
      else if (e.key === 'Enter' || e.key === 'F3') run(!e.shiftKey)
      else if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') input.select()
      else return
      e.preventDefault()
    })
  }

  async function load() {
    const { SearchAddon } = await import('@xterm/addon-search')
    addon = new SearchAddon({ highlightLimit: LIMIT })
    term.loadAddon(addon)
    results = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      count.textContent = !input.value ? ''
        : !resultCount ? 'No results'
        : resultIndex < 0 ? `${LIMIT}+`
        : `${resultIndex + 1} of ${resultCount}`
      bar.classList.toggle('none', !!input.value && !resultCount)
    })
  }

  /** Steps to the next or previous match of what the bar holds. */
  function run(forward) {
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
    if (forward) addon.findNext(query, options)
    else addon.findPrevious(query, options)
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
