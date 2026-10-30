// The file browser: anywhere on disk, not scoped to the session's folder.
import { invoke } from './host.js'
import { $, el, openMenu, showPreview, hidePreview, dragPath } from './ui.js'
import { path as paths } from './paths.js'
import { sortEntries } from './order.js'
import { gitMarks } from './gitmarks.js'

const { SEP, TOP, isRoot, join, parent, normalize, within: under } = paths
export const ICON = {
  dir: '', file: '', image: '', code: '', doc: '', drive: '', diff: '±', review: '±',
  claude: '', pin: '', unpin: '', add: '', copy: '', open: '', explorer: '',
  cut: '', paste: '', rename: '', delete: '', folder: '', openWith: '', properties: '',
  theme: '', play: '', history: '', worktree: '', merge: '', stash: '±',
  prompt: '', send: '', save: '', split: '', close: '', search: '',
}
export const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i
const CODE = /\.(js|mjs|cjs|ts|tsx|jsx|py|ipynb|rs|go|c|h|cpp|hpp|cs|java|kt|rb|lua|gd|sh|ps1|bat|css|scss|html|json|jsonc|toml|ya?ml|xml|sql)$/i
/** Prose: wraps in the editor. */
export const DOC = /\.(md|markdown|txt)$/i
export const kind = e => (e.dir ? 'dir' : IMAGE.test(e.name) ? 'image' : DOC.test(e.name) ? 'doc' : CODE.test(e.name) ? 'code' : 'file')
/** A folder's entries as the disk lists them; render() puts them in Explorer's order. */
const listing = path => invoke('list_dir', { path })

export const quote = p => (/\s/.test(p) ? `"${p}"` : p)
export const { same, basename } = paths

function row(path, entryKind, label) {
  const li = el('li', { className: `row ${entryKind}`, innerHTML: `<i class="icon">${ICON[entryKind]}</i><span></span>` })
  li.dataset.path = path
  li.lastChild.textContent = label
  return li
}

/** Whether `path` holds a nook theme: a folder with a theme.css, or a .zip with one. */
const holdsTheme = (path, dir) => dir
  ? invoke('list_dir', { path }).then(es => es.some(e => e.name.toLowerCase() === 'theme.css'), () => false)
  : /\.zip$/i.test(path) && invoke('zip_holds_theme', { path })

export function startFiles({ start, home, pinned, newSession, openFile, insertPath, installTheme, showChanges }) {
  const [list, pinList, crumbs, status, filter] = [$('list'), $('pinned'), $('crumbs'), $('status'), $('filter')]
  let cur = null
  let shown = ''
  let marked = '' // the open file tab's path, highlighted in the listing
  let claude = [] // the files Claude wrote in any open session, marked in the listing
  let picked = new Set() // rows picked with Ctrl+click or Shift+click, which a drag or the menu acts on together
  let anchor = '' // where a Shift+click range starts
  const back = []
  const forward = []
  let pins = [...pinned]

  function say(message) {
    status.textContent = message
    status.hidden = !message
  }

  async function go(path, from = 'nav') {
    path = normalize(path)
    let entries
    try {
      entries = await listing(path)
    } catch (e) {
      say(`Can't open ${path || TOP}: ${e}`)
      return false
    }
    if (from === 'nav' && cur !== null && path !== cur) {
      back.push(cur)
      forward.length = 0
    }
    if (path !== cur) {
      picked.clear()
      filter.value = ''
    }
    // Up a level, the cursor lands on the folder you came from, as in Explorer; anywhere else, on the first row.
    if (path !== cur) [cursor, cursorAt] = [cur && same(parent(cur) ?? '', path) ? cur : '', 0]
    cur = path
    say('')
    list.scrollTop = 0
    render(entries)
    renderCrumbs()
    renderPins()
    return true
  }

  // Only the rows near the screen exist, so a folder of 100,000 files opens and scrolls as one of 100 does. A
  // spacer above and below them keeps the scrollbar true to the whole folder.
  const ROW = 26 // px, as style.css draws .row
  const WHOLE = 400 // a folder of up to this many entries is drawn whole
  const OVERSCAN = 20
  const [above, below] = [el('li', { className: 'spacer' }), el('li', { className: 'spacer' })]
  let all = [] // the open folder's rows, in order: { path, kind, name }
  let items = [] // the rows shown: all of them, or those the filter leaves
  let drawn = [-1, -1]

  function render(listed) {
    // The listing as it came is kept to spot changes, so an unchanged folder is never sorted again.
    shown = JSON.stringify(listed)
    const entries = sortEntries(listed)
    hidePreview()
    all = entries.map(e => ({ path: join(cur, e.name), kind: cur === '' ? 'drive' : kind(e), name: e.name }))
    const here = new Set(all.map(i => i.path))
    picked = new Set([...picked].filter(p => here.has(p)))
    narrow()
  }

  /** Shows the rows of `all` whose names hold the filter's text, keeping the cursor on its row where it can. */
  function narrow() {
    const want = filter.value.trim().toLowerCase()
    items = want ? all.filter(i => i.name.toLowerCase().includes(want)) : all
    filter.classList.toggle('on', !!want)
    // A cursor whose row went away moves to the row now in its place.
    const at = items.findIndex(i => same(i.path, cursor))
    cursor = items[at >= 0 ? at : Math.min(cursorAt, items.length - 1)]?.path ?? ''
    cursorAt = Math.max(0, items.findIndex(i => i.path === cursor))
    drawn = [-1, -1]
    draw()
    syncNav()
  }

  /** Puts the rows of the open folder that are on screen, or near it, in the list. */
  function draw() {
    if (editing) return
    let [start, end] = [0, items.length]
    if (items.length > WHOLE) {
      start = Math.max(0, Math.floor(list.scrollTop / ROW) - OVERSCAN)
      end = Math.min(items.length, Math.ceil((list.scrollTop + list.clientHeight) / ROW) + OVERSCAN)
    }
    if (start === drawn[0] && end === drawn[1]) return
    drawn = [start, end]
    hovered = null
    const rows = items.slice(start, end).map(i => paint(row(i.path, i.kind, i.name)))
    if (!items.length) rows.push(el('li', { className: 'empty', textContent: all.length ? 'No names hold that text' : 'Empty folder' }))
    above.style.height = `${start * ROW}px`
    below.style.height = `${(items.length - end) * ROW}px`
    list.replaceChildren(above, ...rows, below)
  }
  let queued = false
  list.addEventListener('scroll', () => {
    if (queued || items.length <= WHOLE) return
    queued = true
    requestAnimationFrame(() => { queued = false; draw() })
  }, { passive: true })
  new ResizeObserver(() => draw()).observe(list)

  /** Scrolls the row at `index` into view, drawn, and returns it. */
  function showRow(index, block = 'center') {
    if (index < 0 || index >= items.length) return null
    const top = index * ROW
    if (block === 'nearest') list.scrollTop = Math.min(top, Math.max(list.scrollTop, top + ROW - list.clientHeight))
    else if (top < list.scrollTop || top + ROW > list.scrollTop + list.clientHeight)
      list.scrollTop = block === 'start' ? top : top - (list.clientHeight - ROW) / 2
    draw()
    return [...list.children].find(r => r.dataset.path === items[index].path) ?? null
  }

  /** Gives a newly drawn row the marks of its path: the open file, picked, and Claude's. */
  function paint(r) {
    const path = r.dataset.path
    if (marked && same(path, marked)) r.classList.add('selected')
    if (picked.has(path)) r.classList.add('picked')
    if (path === cursor) r.classList.add('cursor')
    claudeMark(r)
    gitMark(r)
    return r
  }

  // Changed files take git's colors, and folders holding one a fainter tint, in the open tab's repository.
  let gitOf = () => ''
  const GIT = { M: 'Modified', A: 'Added', R: 'Renamed', U: 'Conflicted', '?': 'Untracked', dir: 'Holds changes' }
  function gitMark(r) {
    const mark = r.dataset.path ? gitOf(r.dataset.path) : ''
    if (mark) r.dataset.git = mark === '?' ? 'new' : mark.toLowerCase()
    else delete r.dataset.git
    if (mark && !r.title) r.title = `${r.dataset.path}\n${GIT[mark]}`
  }

  // ——— Keys ———
  // Ctrl+Shift+E puts the keys in the list: arrows, Home, End, and the page keys move a cursor, Shift picks the
  // rows passed, Ctrl moves without dropping picks, and Space picks or drops the cursor's row. Enter opens,
  // Ctrl+Enter adds to Claude's prompt, Backspace goes up, and typing a name's first letters jumps to it. F2,
  // Delete, and Ctrl+C, X, V, and A do what they do in Explorer. Escape gives the keys back to the tab.
  let cursor = '' // the path of the row the keys act on
  let cursorAt = 0 // its index in items
  list.tabIndex = -1

  /** Moves the cursor to row `index`. `how`: 'extend' picks the rows from the anchor to it, 'keep' leaves the
   * picks as they are, and anything else drops them, as a plain click does. */
  function moveTo(index, how = '') {
    if (!items.length) return
    index = Math.max(0, Math.min(items.length - 1, index))
    if (how === 'extend' && cur !== '') {
      let from = items.findIndex(i => i.path === anchor)
      if (from < 0) [from, anchor] = [cursorAt, cursor]
      picked = new Set(items.slice(Math.min(from, index), Math.max(from, index) + 1).map(i => i.path))
    } else if (how !== 'keep') {
      anchor = items[index].path
      picked.clear()
    }
    ;[cursor, cursorAt] = [items[index].path, index]
    showRow(index, 'nearest')
    for (const r of list.children) {
      r.classList.toggle('cursor', r.dataset.path === cursor)
      r.classList.toggle('picked', picked.has(r.dataset.path))
    }
  }
  const cursorRow = () => [...list.children].find(r => r.dataset.path === cursor) ?? showRow(cursorAt)

  let typed = ''
  let typedAt = 0
  /** Jumps to the next row whose name starts with what was typed in the last second. A letter pressed again
   * and again steps through the names that start with it. */
  function seek(key) {
    const now = Date.now()
    typed = (now - typedAt < 1000 ? typed : '') + key.toLowerCase()
    typedAt = now
    const repeat = [...typed].every(c => c === typed[0])
    const want = repeat ? typed[0] : typed
    const from = repeat ? cursorAt + 1 : cursorAt
    for (let k = 0; k < items.length; k++) {
      const i = (from + k) % items.length
      if (items[i].name.toLowerCase().startsWith(want)) return moveTo(i)
    }
  }

  /** Clears the filter, showing every row. */
  function unfilter() {
    if (!filter.value) return
    filter.value = ''
    narrow()
  }
  filter.addEventListener('input', () => {
    list.scrollTop = 0
    narrow()
  })
  // Down or Enter takes the keys into the list; Enter on the only row left opens it. Esc clears, then leaves.
  filter.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || (e.key === 'Enter' && items.length !== 1)) {
      list.classList.add('keys')
      list.focus({ preventScroll: true })
      if (items.length) moveTo(0)
    } else if (e.key === 'Enter' && items.length === 1) (items[0].kind === 'dir' || items[0].kind === 'drive' ? go : openFile)(items[0].path)
    else if (e.key === 'Escape' && filter.value) unfilter()
    else if (e.key === 'Escape') filter.blur()
    else return
    e.preventDefault()
    e.stopPropagation()
  })

  list.addEventListener('keydown', e => {
    if (editing || e.target !== list) return
    const ctrl = e.ctrlKey || e.metaKey
    const page = Math.max(1, Math.floor(list.clientHeight / ROW) - 1)
    const r = () => cursorRow()
    const many = () => (r() ? actOn(r()) : [])
    const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }
    const how = e.shiftKey ? 'extend' : ctrl ? 'keep' : ''
    if (e.key in steps && !e.altKey) moveTo(cursorAt + steps[e.key], how)
    else if (e.key === 'Home' || e.key === 'End') moveTo(e.key === 'Home' ? 0 : items.length - 1, how)
    else if (e.key === ' ' && r() && cur !== '') pick(r(), false)
    else if (e.key === 'Enter' && ctrl) many().forEach(insertPath)
    else if (e.key === 'Enter' && r()) (r().matches('.dir, .drive') ? go : openFile)(cursor)
    else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) parent(cur) !== null && go(parent(cur))
    else if (e.altKey && e.key === 'ArrowLeft') goBack()
    else if (e.altKey && e.key === 'ArrowRight') goForward()
    else if (e.key === 'F2' && r() && cur !== '') rename(r(), true)
    else if (e.key === 'Delete' && r() && cur !== '') {
      const doomed = many()
      ;(async () => {
        for (const path of doomed) if (await invoke('recycle', { path }).catch(say)) moved(path, null)
        sync(true)
      })()
    } else if (ctrl && /^[cx]$/i.test(e.key) && r() && cur !== '') invoke('copy_files', { paths: many(), cut: /x/i.test(e.key) }).catch(say)
    else if (ctrl && /^v$/i.test(e.key) && cur !== '') paste(cur)
    else if (ctrl && /^a$/i.test(e.key) && cur !== '') {
      picked = new Set(items.map(i => i.path))
      paintPicked()
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const b = r()?.getBoundingClientRect()
      b && r().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 40, clientY: b.bottom - 4 }))
    } else if (e.key === 'Escape') {
      if (picked.size) { picked.clear(); paintPicked() } else if (filter.value) unfilter()
      else list.blur()
    } else if ((ctrl && /^f$/i.test(e.key)) || e.key === '/') {
      filter.focus()
      filter.select()
    } else if (e.key.length === 1 && !ctrl && !e.altKey && e.key !== ' ') seek(e.key)
    else return
    e.preventDefault()
    e.stopPropagation()
  })
  list.addEventListener('blur', () => list.classList.remove('keys'))

  const byClaude = path => claude.some(t => same(t, path))
  function claudeMark(r) {
    const path = r.dataset.path
    if (!path) return
    const file = claude.length > 0 && byClaude(path)
    r.classList.toggle('claude-file', file)
    r.classList.toggle('claude-dir', !file && claude.length > 0 && r.matches('.dir, .drive') && claude.some(t => under(t, path)))
    r.title = file ? `${path}\nChanged by Claude` : ''
  }
  /** Marks each listed file Claude wrote, and each folder that holds one. */
  const markClaude = () => { for (const r of list.children) claudeMark(r) }

  /** Shows the picked rows. */
  function paintPicked() {
    for (const r of list.children) r.classList.toggle('picked', picked.has(r.dataset.path))
  }

  /** Ctrl+click adds or drops a row. Shift+click picks every row from the last one picked to this one. */
  function pick(r, range) {
    const from = items.findIndex(i => i.path === anchor)
    if (range && from >= 0) {
      const to = items.findIndex(i => i.path === r.dataset.path)
      picked = new Set(items.slice(Math.min(from, to), Math.max(from, to) + 1).map(i => i.path))
    } else {
      const p = r.dataset.path
      if (!picked.delete(p)) picked.add(p)
      anchor = p
    }
    paintPicked()
  }

  /** The paths a drag or a menu on row `r` acts on: every picked row if `r` is one of them, else `r` alone. */
  const actOn = r => (picked.size > 1 && picked.has(r.dataset.path) ? [...picked] : [r.dataset.path])

  function mark(path) {
    marked = path
    for (const r of list.children) r.classList.toggle('selected', !!path && same(r.dataset.path ?? '', path))
  }

  function syncNav() {
    $('back').disabled = !back.length
    $('forward').disabled = !forward.length
    $('up').disabled = parent(cur) === null
  }

  function renderCrumbs() {
    const parts = []
    let base
    if (cur === '') parts.push([TOP, ''])
    else {
      const underHome = home && under(cur, home)
      base = underHome ? home : paths.root(cur)
      parts.push([underHome ? '~' : basename(base), base])
      for (const seg of cur.slice(base.length).split(SEP).filter(Boolean)) parts.push([seg, (base = join(base, seg))])
    }
    crumbs.replaceChildren(...parts.flatMap(([label, path], i) => {
      const b = el('button', { textContent: label, title: i < parts.length - 1 ? path || TOP : 'Type a path' })
      b.dataset.path = path // a drop target
      // The current folder's crumb falls through to the path bar's click: edit the path.
      if (i < parts.length - 1) b.onclick = e => { e.stopPropagation(); go(path) }
      return i ? [el('i', { className: 'icon sep', textContent: '' }), b] : [b]
    }))
  }

  function renderPins() {
    pinList.replaceChildren(...pins.map(p => {
      const r = row(p, isRoot(p) ? 'drive' : 'dir', home && same(p, home) ? 'Home' : basename(p))
      r.classList.toggle('current', same(p, cur))
      r.title = p
      return r
    }))
  }

  function setPins(next) {
    if (next.join('|') === pins.join('|')) return
    pins = next
    renderPins()
    invoke('update_settings', { patch: { pinned: pins } }).catch(say)
  }
  const togglePin = path => setPins(pins.some(p => same(p, path)) ? pins.filter(p => !same(p, path)) : [...pins, path])
  /** Keeps the pins on a folder that was renamed to `to`, or deleted. */
  const moved = (from, to) => setPins(pins.flatMap(p => (!under(p, from) ? [p] : to ? [to + p.slice(from.length)] : [])))

  let hovered = null
  let editing = false // a name box is open, so the listing holds still
  /** Swaps a row's label for a name box: Enter or a click elsewhere commits, Escape cancels. `back`: the keys
   * return to the list after, as they came from it. */
  function nameBox(li, name, commit, back = false) {
    editing = true
    const input = el('input', { value: name, spellcheck: false })
    li.lastChild.replaceWith(input)
    input.focus()
    const dot = name.lastIndexOf('.')
    input.setSelectionRange(0, li.matches('.dir') || dot < 1 ? name.length : dot) // the stem, as Explorer selects
    let done = false
    const finish = async keep => {
      if (done) return
      done = true
      editing = false
      removeEventListener('pointerdown', outside, true)
      input.blur() // a removed input would leave focus nowhere, not back in the tab
      if (back) {
        list.classList.add('keys')
        list.focus({ preventScroll: true })
      }
      say('')
      const value = input.value.trim()
      if (keep && value && value !== name) await commit(value)
      sync(true)
    }
    const outside = e => e.target !== input && finish(true)
    addEventListener('pointerdown', outside, true)
    input.onblur = () => finish(true)
    // A handler property that returns false cancels the key, so this one returns nothing.
    input.onkeydown = e => { if (e.key === 'Enter' || e.key === 'Escape') finish(e.key === 'Enter') }
    // The file system refuses these, so they're refused as they're typed.
    input.addEventListener('beforeinput', e => {
      if (paths.badName.test(e.data ?? '')) {
        e.preventDefault()
        say(paths.badNameMessage)
      }
    })
  }

  function rename(li, back = false) {
    const path = li.dataset.path
    nameBox(li, basename(path), async name => {
      const to = join(parent(path), name)
      if (await invoke('rename_path', { from: path, to })) {
        moved(path, to)
        if (cursor === path) cursor = to
      }
    }, back)
  }

  /** A name box atop the folders for a new folder, or atop the files for a new file. */
  function create(dir) {
    unfilter()
    const at = cur
    const li = row('', dir ? 'dir' : 'file', '')
    list.querySelector('.empty')?.remove()
    // Atop the folders, or atop the files: the first row that isn't a folder, or the end.
    const index = dir ? 0 : items.findIndex(i => i.kind !== 'dir')
    if (index < 0) {
      list.scrollTop = list.scrollHeight
      draw()
    }
    list.insertBefore(li, showRow(index, 'start') ?? below)
    nameBox(li, '', name => invoke('create_path', { path: join(at, name), dir }).catch(say))
  }

  async function remove(path) {
    if (await invoke('recycle', { path })) moved(path, null)
    sync(true)
  }

  const paste = dir => invoke('paste_files', { dir }).catch(say).finally(() => sync(true))

  /** `row` is the listing's row for `path`, which can be cut, renamed, and deleted. `theme`: it holds a theme. */
  function menuFor(path, isDir, row, pasteable, theme) {
    const copy = ['Copy path', ICON.copy, () => navigator.clipboard.writeText(path)]
    const add = ['Add to prompt', ICON.add, () => insertPath(path)]
    // Linux has no shared Properties sheet or Open with dialog to show.
    const properties = paths.windows ? [['Properties', ICON.properties, () => invoke('open_path', { path, verb: 'properties' })]] : []
    const explorer = paths.fileManager
    const edits = [
      ...(row ? [[
        ['Cut', ICON.cut, () => invoke('copy_files', { paths: [path], cut: true }).catch(say)],
        ['Copy', ICON.copy, () => invoke('copy_files', { paths: [path], cut: false }).catch(say)],
        ['Rename', ICON.rename, () => rename(row)],
        ['Delete', ICON.delete, () => remove(path)],
      ]] : []),
      ...(theme ? [['Install theme', ICON.theme, () => installTheme(path)]] : []),
    ]
    if (!isDir) {
      return [
        ...(byClaude(path) ? [["Claude's changes", ICON.diff, () => showChanges(path)], null] : []),
        ...edits,
        ['Open with default app', ICON.open, () => invoke('open_path', { path })],
        ...(paths.windows ? [['Open with…', ICON.openWith, () => invoke('open_path', { path, verb: 'openas' })]] : []), add, null,
        copy, [`Show in ${explorer}`, ICON.explorer, () => invoke('reveal', { path })], ...properties,
      ]
    }
    const isPinned = pins.some(p => same(p, path))
    return [
      ...edits,
      ['New Claude session here', ICON.claude, () => newSession(path)],
      [isPinned ? 'Unpin' : 'Pin to sidebar', isPinned ? ICON.unpin : ICON.pin, () => togglePin(path)],
      ...(pasteable ? [['Paste', ICON.paste, () => paste(path)]] : []), null,
      add, copy, [`Open in ${explorer}`, ICON.explorer, () => invoke('open_path', { path })], ...properties,
    ]
  }

  /** The menu for several picked rows. */
  function menuForMany(many) {
    const n = `${many.length} items`
    return [
      [`Cut ${n}`, ICON.cut, () => invoke('copy_files', { paths: many, cut: true }).catch(say)],
      [`Copy ${n}`, ICON.copy, () => invoke('copy_files', { paths: many, cut: false }).catch(say)],
      [`Delete ${n}`, ICON.delete, async () => {
        for (const path of many) if (await invoke('recycle', { path }).catch(say)) moved(path, null)
        sync(true)
      }], null,
      ['Add to prompt', ICON.add, () => many.forEach(insertPath)],
      ['Copy paths', ICON.copy, () => navigator.clipboard.writeText(many.join('\n'))],
    ]
  }

  /** The folder a drop on `target` goes into: a folder row, a pinned folder, or a crumb of the path bar. Never
   * one of the dragged folders or a folder inside one. */
  const DROP = '#list .row:is(.dir, .drive), #pinned .row, #crumbs button'
  function folderAt(target, dragged = []) {
    const r = target?.closest?.(DROP)
    const dir = r?.dataset.path
    return dir && !dragged.some(d => same(d, dir) || under(dir, d)) ? r : null
  }
  let dropOn = null // the folder row a drag is over
  function hoverDrop(r) {
    if (r === dropOn) return
    dropOn?.classList.remove('drop')
    ;(dropOn = r)?.classList.add('drop')
  }

  /** Moves `paths` into `dir`, or copies them there. */
  async function dropInto(paths, dir, copy) {
    try {
      if ((await invoke('drop_files', { paths, dir, copy })) && !copy) {
        for (const p of paths) moved(p, join(dir, basename(p)))
        picked.clear()
      }
    } catch (e) {
      say(String(e))
    }
    sync(true)
  }

  // Shared row behavior for the pinned list and the folder listing. A row with a name box takes no clicks or drags.
  const rowAt = e => {
    const r = e.target.closest('.row')
    return r?.querySelector('input') ? null : r
  }
  for (const ul of [list, pinList]) {
    ul.addEventListener('click', e => {
      const r = rowAt(e)
      const pickable = ul === list && cur !== ''
      if (r && ul === list) moveCursor(r)
      if (r && pickable && (e.ctrlKey || e.metaKey || e.shiftKey)) return pick(r, e.shiftKey)
      if (pickable && picked.size) { picked.clear(); paintPicked() }
      if (r) (r.matches('.dir, .drive') ? go : openFile)(r.dataset.path)
    })
    ul.addEventListener('contextmenu', async e => {
      const r = e.target.closest('.row')
      if (editing || (!r && (ul !== list || cur === ''))) return
      const isDir = r?.matches('.dir, .drive')
      const [pasteable, theme] = await Promise.all([invoke('can_paste'), r && holdsTheme(r.dataset.path, isDir)])
      const many = ul === list && r ? actOn(r) : []
      if (many.length > 1) openMenu(e, menuForMany(many))
      else if (r) openMenu(e, menuFor(r.dataset.path, isDir, ul === list && cur !== '' && r, pasteable, theme))
      else {
        openMenu(e, [
          ['New file', ICON.file, () => create(false)],
          ['New folder', ICON.folder, () => create(true)], null,
          ...menuFor(cur, true, null, pasteable),
        ])
      }
    })
    ul.addEventListener('pointerdown', e => {
      const r = rowAt(e)
      if (!r || e.button !== 0) return
      // A drag from the listing moves its rows into a folder it's dropped on, or copies them with Ctrl held. A
      // pinned folder only drags into the prompt, so a pin can't be moved by accident.
      const files = ul === list && cur !== ''
      const many = files ? actOn(r) : [r.dataset.path]
      dragPath(e, r.dataset.path, (target, up) => {
        if (target?.closest('#pane')) return many.forEach(insertPath)
        const into = files && folderAt(target, many)
        if (into) dropInto(many, into.dataset.path, up.ctrlKey)
      }, {
        label: many.length > 1 ? `${many.length} items` : undefined,
        over: target => hoverDrop(files ? folderAt(target, many) : null),
      })
    })
  }

  list.addEventListener('mouseover', e => {
    const r = e.target.closest('.row')
    if (r === hovered) return
    hovered = r
    hidePreview()
    if (r?.classList.contains('image')) showPreview(r.dataset.path, e.clientX, e.clientY)
  })
  list.addEventListener('mouseleave', () => { hovered = null; hidePreview() })
  list.addEventListener('scroll', hidePreview, { passive: true })

  // A folder that no longer opens drops out of history instead of desyncing it.
  async function travel(from, to) {
    if (!from.length) return
    const prev = cur
    if (await go(from.pop(), 'history')) to.push(prev)
    syncNav()
  }
  /** Puts the cursor on row `r`, as a click does. */
  function moveCursor(r) {
    cursor = r.dataset.path
    cursorAt = Math.max(0, items.findIndex(i => i.path === cursor))
    for (const x of list.children) x.classList.toggle('cursor', x === r)
  }
  const goBack = () => travel(back, forward)
  const goForward = () => travel(forward, back)
  $('back').onclick = goBack
  $('forward').onclick = goForward
  $('up').onclick = () => parent(cur) !== null && go(parent(cur))
  $('files').addEventListener('mouseup', e => (e.button === 3 ? goBack() : e.button === 4 && goForward()))

  // Click the path bar's empty space to type a path.
  crumbs.addEventListener('click', () => {
    if (crumbs.querySelector('input')) return
    const input = el('input', { value: cur, spellcheck: false })
    crumbs.replaceChildren(input)
    input.select()
    input.onkeydown = async e => {
      if (e.key === 'Enter' && (await go(input.value))) input.blur()
      if (e.key === 'Escape') input.blur()
    }
    input.onblur = renderCrumbs
  })

  // The poll rereads the folder only when its change time moves, which adding, removing, or renaming an entry
  // does, and for a few seconds after, since some file systems keep that time to the nearest 2 s. A full reread
  // every 20 s catches what leaves the time alone, as a file turning hidden does.
  let stamp = ''
  let stampMoved = 0
  let reread = 0
  /** Rereads the open folder and repaints it if it changed, or always when `force`. */
  async function sync(force = false) {
    if (editing || !cur) return
    const at = cur
    try {
      const now = Date.now()
      const next = force ? '' : await invoke('file_stamp', { path: at })
      if (next !== stamp) [stamp, stampMoved] = [next, now]
      if (!force && next && now - stampMoved > 4500 && now - reread < 20_000) return
      reread = now
      const listed = await listing(at)
      if (at === cur && !editing && (force || JSON.stringify(listed) !== shown)) render(listed)
    } catch {}
  }
  // Pick up files created while you work (by Claude, or anything else).
  setInterval(() => document.hidden || sync(), 2000)

  /** Opens the folder that holds `path` and points at its row. */
  async function reveal(path) {
    document.body.classList.remove('files-hidden')
    if (!(await go(parent(path)))) return
    if (!items.some(i => same(i.path, path))) unfilter()
    const r = showRow(items.findIndex(i => same(i.path, path)))
    r?.scrollIntoView({ block: 'center' })
    r?.animate([{ background: 'var(--accent)' }, {}], { duration: 900, easing: 'ease-out' })
  }

  go(start)
  return {
    current: () => cur,
    go,
    /** Gives the keys to the file list, showing it if it's hidden. */
    focus() {
      document.body.classList.remove('files-hidden')
      list.classList.add('keys')
      list.focus({ preventScroll: true })
      if (items.length) moveTo(cursorAt)
    },
    mark,
    reveal,
    create,
    /** Colors the rows git counts as changed, from the git panel's status, or none when `status` is null. */
    git(status) {
      gitOf = gitMarks(status, paths)
      for (const r of list.children) gitMark(r)
    },
    /** Puts the keys in the filter box, showing the file browser if it's hidden. */
    filter() {
      document.body.classList.remove('files-hidden')
      filter.focus()
      filter.select()
    },
    pins: () => pins,
    /** For files dragged in from another app: the drop folder under (x, y), shown as the target, or null. */
    dropFolder(x, y) {
      const r = x == null ? null : folderAt(document.elementFromPoint(x, y))
      hoverDrop(r)
      return r?.dataset.path ?? null
    },
    /** Copies files dragged in from another app into `dir`. */
    receive: (paths, dir) => dropInto(paths, dir, true),
    /** The files Claude wrote in any open session, as its mod reports them. */
    claude(touched) {
      claude = touched.map(normalize)
      markClaude()
    },
  }
}
