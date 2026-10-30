// Paths in a Claude tab's text become links. Hovering one that names a file or folder on disk underlines
// it, an image previews, a text file shows the lines it points at (`peek.js`, loaded on the first hover),
// and Ctrl+click opens it in nook: a file in a tab at its line, a folder in the file browser. Claude names
// files in tool calls, `Update(src/main.js)`, in prose, `src/main.js:42`, and in grep output. `findPaths`
// reads candidates from a row's text, and only those on disk become links, so a link provider asks Rust
// about a row once, on hover, and costs nothing while the mouse is still.
import { invoke } from './host.js'
import { IMAGE } from './files.js'
import { findPaths, candidates, diffLine, editedPath } from './linkify.js'
import { showPreview, hidePreview, el } from './ui.js'

let peeks // peek.js, imported the first time the mouse is on a file's path
const loadPeek = () => (peeks ??= import('./peek.js'))
const hidePeek = () => peeks?.then(m => m.hidePeek())

/** The text of `line` as one string, and the cell each of its UTF-16 units starts in, so a match in the
 * string maps to cells when wide characters take two. */
export function cells(line, cols, cell) {
  let text = ''
  const xs = []
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x, cell)
    if (!c) break
    if (!c.getWidth()) continue // the second half of a wide character
    const chars = c.getChars() || ' '
    for (let k = 0; k < chars.length; k++) xs.push(x)
    text += chars
  }
  return { text, xs }
}

const TTL = 3000 // how long an answer about a path holds
const KIND = [null, 'file', 'dir']
const known = new Map() // path -> { kind, at }

/** The kind of each path: 'file', 'dir', or null where nothing is. One trip to Rust for those not known. */
async function kinds(list) {
  const now = performance.now()
  const ask = [...new Set(list.filter(p => !(known.get(p)?.at > now - TTL)))]
  if (ask.length) {
    const answers = await invoke('path_kinds', { paths: ask }).catch(() => ask.map(() => 0))
    ask.forEach((p, i) => known.set(p, { kind: KIND[answers[i]] ?? null, at: now }))
    if (known.size > 2000) for (const [p, k] of known) if (k.at < now - TTL) known.delete(p)
  }
  return list.map(p => known.get(p)?.kind ?? null)
}

let hint // the "Ctrl+click" line that follows a hovered link, shared by every tab
function showHint(text, x, y) {
  hint ??= document.body.appendChild(el('div', { className: 'link-hint', hidden: true }))
  hint.textContent = text
  hint.hidden = false
  hint.style.left = `${x + 12}px`
  hint.style.top = `${y + 16}px`
}
const hideHint = () => { if (hint) hint.hidden = true }

const PLACEHOLDER = '\u{10EEEE}' // a picture's cell, colored with its id; see pictures.js

/** Links every path on disk in `term`'s rows, and each picture that names a file. `where()` gives
 * `{ cwd, home }`; `open(path, kind, line, col)` opens one; `pathOf(id)` is the file of picture `id`. */
export function startLinks(term, where, open, pathOf = () => undefined) {
  const cell = term.vt.buffer.getNullCell()
  /** The file of the edit whose diff holds row `y`: the nearest `Update(...)` above, unless another of
   * Claude's messages starts between them. */
  function editOver(y) {
    const b = term.vt.buffer
    for (let i = y - 1; i >= Math.max(0, y - 400); i--) {
      const text = b.getLine(i)?.translateToString(true) ?? ''
      const path = editedPath(text)
      if (path) return path
      if (/^\s*[⏺●>]/.test(text)) return null
    }
    return null
  }
  /** A link over each picture's cells in `line`, row `y`, that opens the file it shows. */
  function pictureLinks(line, y) {
    const runs = new Map() // id -> [first x, last x]
    for (let x = 0; x < term.cols; x++) {
      if (!line.getCell(x, cell)?.getChars().startsWith(PLACEHOLDER)) continue
      const id = cell.getFgColor()
      const run = runs.get(id)
      if (run) run[1] = x
      else runs.set(id, [x, x])
    }
    const links = []
    for (const [id, [first, last]] of runs) {
      const path = pathOf(id)
      if (!path) continue
      links.push({
        text: path,
        range: { start: { x: first + 1, y }, end: { x: last + 1, y } },
        decorations: { underline: false, pointerCursor: true },
        hover: e => showHint('Ctrl+click to open in nook', e.clientX, e.clientY),
        leave: hideHint,
        activate(e) {
          if (!e.ctrlKey && !e.metaKey) return
          hideHint()
          open(path, 'file')
        },
      })
    }
    return links
  }

  const provider = term.registerLinkProvider({
    async provideLinks(y, callback) {
      const line = term.vt.buffer.getLine(y - 1)
      if (!line) return callback(undefined)
      if (line.translateToString(true).includes(PLACEHOLDER)) {
        const links = pictureLinks(line, y)
        return callback(links.length ? links : undefined)
      }
      const { text, xs } = cells(line, term.cols, cell)
      const found = findPaths(text)
      const diff = !found.length && diffLine(text)
      if (diff) {
        const path = editOver(y - 1)
        if (path) found.push({ ...diff, path })
      }
      if (!found.length) return callback(undefined)
      const options = found.map(f => candidates(f.path, where()))
      const answers = await kinds(options.flat())
      const links = []
      let k = 0
      found.forEach((f, i) => {
        const at = options[i].findIndex((_, j) => answers[k + j])
        const target = at < 0 ? null : options[i][at]
        const kind = at < 0 ? null : answers[k + at]
        k += options[i].length
        if (!target) return
        const last = xs[f.end - 1]
        links.push({
          text: text.slice(f.start, f.end),
          range: { start: { x: xs[f.start] + 1, y }, end: { x: last + line.getCell(last, cell).getWidth(), y } },
          decorations: { underline: true, pointerCursor: true },
          hover(e) {
            const hint = `Ctrl+click to open ${kind === 'dir' ? 'folder' : f.line ? `at line ${f.line}` : 'in nook'}`
            if (kind === 'file' && IMAGE.test(target)) showPreview(target, e.clientX, e.clientY)
            else if (kind === 'file') loadPeek().then(m => m.peek(target, f.line, e.clientX, e.clientY, hint))
            else showHint(hint, e.clientX, e.clientY)
          },
          leave() { hidePreview(); hidePeek(); hideHint() },
          activate(e) {
            if (!e.ctrlKey && !e.metaKey) return
            hidePreview()
            hidePeek()
            hideHint()
            open(target, kind, f.line, f.col)
          },
        })
      })
      callback(links.length ? links : undefined)
    },
  })
  return { dispose: () => { provider.dispose(); hidePeek(); hideHint() } }
}
