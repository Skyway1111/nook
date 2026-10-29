// Quick open (Ctrl+P) and the command palette (F1): one box over the top of the window.
// Loaded on the first Ctrl+P, so it adds nothing to cold open or to an idle window. Typed text finds files in the active tab's repository, or its folder outside one. `>` finds commands,
// `:` goes to a line in the open file, `@` to a symbol in it, and `%` finds text inside the files. Nothing is indexed until the box first opens, and each later open shows the last index at once while a fresh one builds behind it.
import { invoke } from '@tauri-apps/api/core'
import { $, el } from './ui.js'
import { rank } from './fuzzy.js'
import { kind, ICON } from './files.js'
import { path as paths } from './paths.js'
import { recentFiles, opened, RECENT_MAX } from './recent.js'

/** An index older than this rebuilds in the background when the box opens. */
const STALE_MS = 5000

/** A symbol's kind as a letter in its own color, and as a word. */
const KINDS = {
  function: ['f', 'Function'], method: ['m', 'Method'], class: ['C', 'Class'], struct: ['S', 'Struct'],
  interface: ['I', 'Interface'], trait: ['T', 'Trait'], impl: ['i', 'Implementation'], enum: ['E', 'Enum'],
  type: ['T', 'Type'], module: ['N', 'Module'], constant: ['K', 'Constant'], variable: ['v', 'Variable'],
  field: ['p', 'Field'], heading: ['#', 'Heading'], rule: ['{', 'Rule'], key: ['k', 'Key'],
}

/**
 * `dir()` is the folder to search: the active tab's. `commands()` lists `{ title, keys, run }`. `gotoLine(line,
 * col)` moves the open file's caret and returns false when no file is open. `outline()` is the open file's
 * symbols, from viewer.js, or null with no file open. `openFile` and `insertPath` take an absolute path; `reveal`
 * shows one in the file browser. `onClose` returns focus to the tab.
 */
export function startQuickOpen({ dir, commands, gotoLine, outline, openFile, insertPath, reveal, onClose }) {
  const box = el('div', { id: 'quick', hidden: true })
  const input = el('input', { spellcheck: false, autocomplete: 'off' })
  const list = el('ul')
  const foot = el('footer')
  box.append(input, list, foot)
  document.body.append(box)

  const indexes = new Map() // a folder asked about → { root, files, lower, at, partial, building }
  let results = []
  let at = 0 // the highlighted row
  let index = null // the index the box shows
  let asked = '' // the folder it was asked for

  /** The index for `folder`, building one if there's none or it's stale. Repaints when a build lands. */
  function indexFor(folder) {
    let entry = indexes.get(folder)
    if (!entry) indexes.set(folder, (entry = { root: folder, files: [], lower: [], at: -Infinity, partial: false }))
    if (!entry.building && performance.now() - entry.at > STALE_MS) {
      entry.building = invoke('index_files', { dir: folder }).then(
        ({ root, files, partial }) => {
          Object.assign(entry, { root, files, partial, lower: files.map(f => f.toLowerCase()), at: performance.now(), error: '' })
        },
        e => { entry.error = String(e); entry.at = performance.now() },
      ).finally(() => {
        entry.building = null
        if (!box.hidden && index === entry) render()
      })
    }
    return entry
  }

  const absolute = (root, rel) => paths.fromSlashes(root, rel)

  /** A label with the letters at `positions` (offsets into `text` from `offset`) in bold. */
  function marked(text, positions, offset = 0) {
    const span = el('span')
    let last = 0
    for (const p of positions) {
      const i = p - offset
      if (i < 0 || i >= text.length) continue
      if (i > last) span.append(text.slice(last, i))
      span.append(el('b', { textContent: text[i] }))
      last = i + 1
    }
    span.append(text.slice(last))
    return span
  }

  function fileRow(rel, positions, root) {
    const slash = rel.lastIndexOf('/')
    const name = rel.slice(slash + 1)
    const folder = slash < 0 ? '' : rel.slice(0, slash)
    const k = kind({ name })
    const li = el('li', { className: `row ${k}` })
    const where = el('small')
    where.append(marked(folder, positions))
    li.append(el('i', { className: 'icon', textContent: ICON[k] }), marked(name, positions, slash + 1), where)
    li.title = absolute(root, rel)
    return li
  }

  /** A line that holds the text searched for, with the match in bold, and where it is under that. */
  function hitRow(hit) {
    const k = kind({ name: hit.file })
    const li = el('li', { className: `row hit ${k}` })
    const where = el('small', { textContent: `${hit.file}:${hit.line}` })
    li.append(el('i', { className: 'icon', textContent: ICON[k] }), marked(hit.text, Array.from({ length: hit.len }, (_, i) => hit.at + i)), where)
    return li
  }

  // Text search runs in Rust once typing pauses; the box shows the last search's lines until the next lands.
  let search = { query: null, found: null, error: '', running: false }
  let searchTimer = 0
  function searchFor(query) {
    if (query === search.query) return
    search = { ...search, query, running: query.length >= 2 }
    clearTimeout(searchTimer)
    if (!search.running) return
    const folder = asked
    searchTimer = setTimeout(() => invoke('search_text', { dir: folder, query }).then(found => {
      if (found.stale || search.query !== query) return
      search = { query, found, error: '', running: false }
    }, e => {
      if (search.query === query) search = { query, found: null, error: String(e), running: false }
    }).finally(() => { if (!box.hidden && input.value.startsWith('%')) render() }), 150)
  }

  // The open file's symbols, read when `@` is first typed in this opening of the box.
  let symbols = null // { file: viewer.js's outline or null, items, partial, error }
  function symbolsFor() {
    if (symbols) return symbols
    const file = outline()
    symbols = { file, items: null, partial: false, error: '' }
    const mine = symbols
    file?.read.then(({ items, partial }) => Object.assign(mine, { items, partial }), e => { mine.error = String(e) })
      .finally(() => { if (symbols === mine && !box.hidden && input.value.startsWith('@')) render() })
    return symbols
  }

  function symbolRow(symbol, positions, indent) {
    const [letter, word] = KINDS[symbol.kind] ?? ['·', symbol.kind]
    const li = el('li', { className: 'row symbol' })
    const badge = el('i', { className: `kind ${symbol.kind}`, textContent: letter, title: word })
    if (indent) badge.style.marginLeft = `${Math.min(symbol.depth, 8) * 14}px`
    li.append(badge, marked(symbol.name, positions),
      el('small', { textContent: `${symbol.container && !indent ? `${symbol.container} · ` : ''}line ${symbol.line}` }))
    return li
  }

  function commandRow(command, positions) {
    const li = el('li', { className: 'row command' })
    li.append(el('i', { className: 'icon', textContent: command.icon ?? '' }), marked(command.title, positions))
    if (command.keys) li.append(el('kbd', { textContent: command.keys }))
    return li
  }

  /** What the box offers for `query`, as `{ rows, act, hint }`. `act(i, how)` runs row i. */
  function offer(query) {
    if (query.startsWith('>')) {
      const found = rank(query.slice(1), commands().filter(c => !c.when || c.when()), { text: c => c.title, limit: 100 })
      return {
        rows: found.map(r => commandRow(r.item, r.positions)),
        act: i => found[i].item.run(),
        hint: found.length ? 'Enter runs the command' : 'No command matches',
        count: found.length,
      }
    }
    if (query.startsWith('%')) {
      const text = query.slice(1)
      searchFor(text)
      const { found, error, running } = search
      const hits = found && search.query === text ? found.hits : []
      const n = hits.length
      return {
        rows: hits.map(hitRow),
        act: (i, how) => {
          const file = absolute(found.root, hits[i].file)
          if (how === 'prompt') return insertPath(file)
          if (how === 'reveal') return reveal(file)
          openFile(file, hits[i].line, hits[i].col)
        },
        hint: error ? `Can't search: ${error}`
          : text.length < 2 ? 'Type at least two letters to find them inside files'
          : running ? 'Searching…'
          : `${n ? n.toLocaleString() : 'No'} line${n === 1 ? '' : 's'}${found?.partial ? ' (stopped there)' : ''} in ${found?.searched.toLocaleString()} files`,
        keys: n ? 'Enter open at the line · Shift+Enter add to prompt · Alt+Enter show in files' : '',
        count: n,
      }
    }
    if (query.startsWith('@')) {
      const { file, items, partial, error } = symbolsFor()
      const text = query.slice(1)
      const all = items ?? []
      // In the file's order, nested under what holds them, until a letter is typed; then best first.
      const found = text.trim()
        ? rank(text, all, { text: s => s.name, limit: 100, boost: s => -s.line / 1e7 })
        : all.slice(0, 2000).map(item => ({ item, positions: [] }))
      const n = all.length
      return {
        rows: found.map(r => symbolRow(r.item, r.positions, !text.trim())),
        act: i => file.go(found[i].item),
        look: i => found[i] && file.look(found[i].item),
        hint: !file ? 'Open a code or text file to go to its symbols'
          : error ? `Can't read the outline: ${error}`
          : !items ? 'Reading the outline…'
          : !n ? 'No symbols in this file'
          : `${n.toLocaleString()} symbol${n === 1 ? '' : 's'}${partial ? ' (stopped there)' : ''}${text.trim() ? `, ${found.length.toLocaleString()} match` : ''}`,
        keys: found.length ? 'Enter go to it · Esc go back' : '',
        count: found.length,
      }
    }
    if (query.startsWith(':')) {
      const [line, col] = query.slice(1).split(/[:,]/).map(n => parseInt(n, 10))
      const ok = Number.isFinite(line)
      return {
        rows: [],
        act: () => ok && gotoLine(line, Number.isFinite(col) ? col : 1),
        hint: ok ? `Enter goes to line ${line}${Number.isFinite(col) ? `, column ${col}` : ''}` : 'Type a line number, or line:column',
        count: 0,
        enter: ok,
      }
    }
    const root = index.root
    const recentHere = new Map()
    recentFiles().forEach((p, i) => {
      if (paths.within(p, root) && !paths.same(p, root)) recentHere.set(p.slice(root.length + (root.endsWith(paths.SEP) ? 0 : 1)).replaceAll(paths.SEP, '/'), RECENT_MAX - i)
    })
    // Files opened lately come first on an empty query, and lead their ties on a typed one.
    const items = query.trim() || !recentHere.size ? index.files : [...recentHere.keys(), ...index.files.filter(f => !recentHere.has(f))]
    const lowers = new Map()
    if (items === index.files) items.forEach((f, i) => lowers.set(f, index.lower[i]))
    const found = rank(query, items, {
      lower: f => lowers.get(f) ?? f.toLowerCase(),
      boost: f => (recentHere.has(f) ? 4 + recentHere.get(f) / 10 : 0),
      limit: 60,
    })
    const n = index.files.length.toLocaleString()
    const status = index.error ? `Can't list files: ${index.error}`
      : index.building && index.at < 0 ? 'Listing files…'
      : `${n} files${index.partial ? ' (stopped there)' : ''} in ${paths.basename(root)}${index.building ? ', refreshing…' : ''}`
    return {
      rows: found.map(r => fileRow(r.item, r.positions, root)),
      act: (i, how) => {
        const file = absolute(root, found[i].item)
        if (how === 'prompt') return insertPath(file)
        if (how === 'reveal') return reveal(file)
        openFile(file)
      },
      hint: status,
      keys: found.length ? 'Enter open · Shift+Enter add to prompt · Alt+Enter show in files' : '',
      count: found.length,
    }
  }

  let current = null
  function render() {
    if (!input.value.startsWith('@')) symbols?.file?.back() // the caret goes back where it was when `@` is erased
    current = offer(input.value)
    list.replaceChildren(...current.rows)
    at = Math.min(at, Math.max(0, current.rows.length - 1))
    highlight(/^@./.test(input.value.trim()))
    foot.replaceChildren(el('span', { textContent: current.hint }), ...(current.keys ? [el('span', { textContent: current.keys })] : []))
  }

  /** Marks the row at `at`; with `look`, the editor shows its symbol too. */
  function highlight(look = false) {
    list.querySelector('.at')?.classList.remove('at')
    const row = list.children[at]
    row?.classList.add('at')
    row?.scrollIntoView({ block: 'nearest' })
    if (look) current?.look?.(at)
  }

  // Typing repaints once a frame at most, so a fast typist never waits on a ranking per key.
  let queued = false
  input.oninput = () => {
    at = 0
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; render() })
  }

  function act(how) {
    if (queued) { queued = false; render() }
    if (!current || (!current.count && !current.enter)) return
    const run = current.act
    close(false, true)
    run(at, how)
  }

  input.onkeydown = e => {
    const move = d => { e.preventDefault(); at = Math.max(0, Math.min(list.children.length - 1, at + d)); highlight(true) }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) move(1)
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p' && !e.shiftKey)) move(-1)
    else if (e.key === 'PageDown') move(10)
    else if (e.key === 'PageUp') move(-10)
    else if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'Enter') { e.preventDefault(); act(e.shiftKey ? 'prompt' : e.altKey ? 'reveal' : 'open') }
  }
  list.addEventListener('mousedown', e => e.preventDefault()) // keep the caret in the box
  list.addEventListener('click', e => {
    const row = e.target.closest('li')
    if (!row) return
    at = [...list.children].indexOf(row)
    act('open')
  })
  list.addEventListener('mousemove', e => {
    const row = e.target.closest('li')
    const i = row ? [...list.children].indexOf(row) : -1
    if (i >= 0 && i !== at) { at = i; highlight() }
  })
  input.onblur = () => setTimeout(() => { if (!box.hidden && document.activeElement !== input) close() })

  function open(prefix = '') {
    asked = dir()
    index = indexFor(asked)
    box.hidden = false
    input.value = prefix
    input.placeholder = prefix.startsWith('>') ? 'Run a command'
      : prefix.startsWith('%') ? 'Find text inside the files'
      : prefix.startsWith('@') ? 'Go to a symbol in the file'
      : 'Find a file by name · > for commands · : for a line · @ for a symbol · % for text in files'
    search = { query: null, found: null, error: '', running: false }
    symbols = null
    at = 0
    render()
    input.focus()
  }

  /** Hides the box; unless a row was `acted` on, a symbol it showed gives way to where the caret was. */
  function close(refocus = true, acted = false) {
    if (!acted) symbols?.file?.back()
    symbols = null
    box.hidden = true
    list.replaceChildren() // nothing to hold on to while hidden
    current = null
    if (refocus) onClose()
  }

  return {
    open,
    /** Ctrl+P's, F1's and Ctrl+Shift+O's: closes the box when it shows that mode, and opens it otherwise. */
    toggle(prefix, typed = '') {
      const mode = v => (v[0] === '>' || v[0] === '@' ? v[0] : '')
      if (!box.hidden && mode(input.value) === prefix) close()
      else open(prefix + typed)
    },
  }
}
