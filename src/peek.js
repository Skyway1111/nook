// Resting the mouse on a file's path in a Claude tab shows the lines it points at: a card with the file's
// name, a dozen lines around the line named (or the file's first lines), in the theme's syntax colors once
// highlight.js loads. It reads only those lines, and only after the mouse has rested, so a pass over a row
// of paths costs nothing.
import { invoke } from './host.js'
import { el, place, sheet } from './ui.js'
import { path as paths } from './paths.js'

await sheet(new URL('./peek.css', import.meta.url))

const REST_MS = 300 // how long the mouse rests on a path before its card shows
const LINES = 12
const ABOVE = 4 // lines shown above the one named

let card // shared by every tab
let timer
let wanted // the peek the mouse is on, so a late answer for another is dropped

/** The card for `path`, at `line` if given, near (x, y) once the mouse has rested. `hint` is its footer. */
export function peek(path, line, x, y, hint) {
  hidePeek()
  const key = (wanted = {})
  timer = setTimeout(async () => {
    const from = line ? Math.max(1, line - ABOVE) : 1
    // A file that isn't text, or is empty, gets the card's name and hint alone.
    const lines = await invoke('peek_lines', { path, from, count: LINES }).catch(() => [])
    if (wanted !== key) return
    show(path, from, line, lines, hint, x, y, key)
  }, REST_MS)
}

export function hidePeek() {
  clearTimeout(timer)
  wanted = null
  if (card) card.hidden = true
}

function show(path, from, line, lines, hint, x, y, key) {
  card ??= document.body.appendChild(el('div', { className: 'peek', hidden: true }))
  const name = el('div', { className: 'name' })
  name.append(el('b', { textContent: paths.basename(path) }), el('span', { textContent: paths.parent(path) ?? '' }))
  const codes = lines.map(text => el('code', { textContent: text || ' ' }))
  const rows = codes.map((code, i) => {
    const row = el('div', { className: from + i === line ? 'row at' : 'row' })
    row.append(el('span', { className: 'n', textContent: from + i }), code)
    return row
  })
  const body = el('div', { className: 'lines' })
  body.append(...rows)
  card.replaceChildren(name, ...(rows.length ? [body] : []), el('div', { className: 'hint', textContent: hint }))
  card.hidden = false
  place(card, x, y)
  if (!rows.length) return
  // Colors follow when highlight.js loads; the card shows plain text until then.
  import('./highlight.js').then(({ tokenize }) => tokenize(lines.join('\n'), paths.basename(path))).then(tokens => {
    if (wanted !== key || !tokens) return
    codes.forEach((code, i) => {
      const text = lines[i]
      const parts = []
      let at = 0
      for (const [a, b, cls] of tokens[i] ?? []) {
        if (a > at) parts.push(text.slice(at, a))
        parts.push(el('span', { className: cls, textContent: text.slice(a, b) }))
        at = b
      }
      if (parts.length) code.replaceChildren(...parts, text.slice(at))
    })
  }, () => {})
}
