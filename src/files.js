// The file browser: anywhere on disk, not scoped to the session's folder.
import { invoke } from '@tauri-apps/api/core'
import { $, el, openMenu, showPreview, hidePreview, dragPath } from './ui.js'
import { path as paths } from './paths.js'

const { SEP, TOP, isRoot, join, parent, normalize, within: under } = paths
export const ICON = {
  dir: '', file: '', image: '', code: '', doc: '', drive: '', diff: '±',
  claude: '', pin: '', unpin: '', add: '', copy: '', open: '', explorer: '',
  cut: '', paste: '', rename: '', delete: '', folder: '', openWith: '', properties: '',
  theme: '', play: '', history: '', worktree: '',
  prompt: '', send: '', save: '', split: '', close: '',
}
export const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i
const CODE = /\.(js|mjs|cjs|ts|tsx|jsx|py|ipynb|rs|go|c|h|cpp|hpp|cs|java|kt|rb|lua|gd|sh|ps1|bat|css|scss|html|json|jsonc|toml|ya?ml|xml|sql)$/i
/** Prose: wraps in the editor. */
export const DOC = /\.(md|markdown|txt)$/i
export const kind = e => (e.dir ? 'dir' : IMAGE.test(e.name) ? 'image' : DOC.test(e.name) ? 'doc' : CODE.test(e.name) ? 'code' : 'file')
const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare
/** A folder's entries, folders first, in Explorer's order. */
const listing = path => invoke('list_dir', { path }).then(es => es.sort((a, b) => b.dir - a.dir || compare(a.name, b.name)))

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
  const [list, pinList, crumbs, status] = [$('list'), $('pinned'), $('crumbs'), $('status')]
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
    if (path !== cur) picked.clear()
    cur = path
    say('')
    render(entries)
    renderCrumbs()
    renderPins()
    list.scrollTop = 0
    return true
  }

  function render(entries) {
    shown = JSON.stringify(entries)
    hidePreview()
    const rows = entries.map(e => row(join(cur, e.name), cur === '' ? 'drive' : kind(e), e.name))
    if (!rows.length) rows.push(el('li', { className: 'empty', textContent: 'Empty folder' }))
    list.replaceChildren(...rows)
    paintPicked()
    mark(marked)
    markClaude()
    syncNav()
  }

  const byClaude = path => claude.some(t => same(t, path))
  /** Marks each listed file Claude wrote, and each folder that holds one. */
  function markClaude() {
    for (const r of list.children) {
      const path = r.dataset.path
      if (!path) continue
      const file = byClaude(path)
      r.classList.toggle('claude-file', file)
      r.classList.toggle('claude-dir', !file && r.matches('.dir, .drive') && claude.some(t => under(t, path)))
      r.title = file ? `${path}\nChanged by Claude` : ''
    }
  }

  /** Shows the picked rows, and forgets picks that left the folder. */
  function paintPicked() {
    const here = new Set()
    for (const r of list.children) {
      const on = picked.has(r.dataset.path)
      r.classList.toggle('picked', on)
      if (on) here.add(r.dataset.path)
    }
    picked = here
  }

  /** Ctrl+click adds or drops a row. Shift+click picks every row from the last one picked to this one. */
  function pick(r, range) {
    const rows = [...list.querySelectorAll('.row')]
    const from = rows.findIndex(x => x.dataset.path === anchor)
    if (range && from >= 0) {
      const to = rows.indexOf(r)
      picked = new Set(rows.slice(Math.min(from, to), Math.max(from, to) + 1).map(x => x.dataset.path))
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

  let editing = false // a name box is open, so the listing holds still
  /** Swaps a row's label for a name box: Enter or a click elsewhere commits, Escape cancels. */
  function nameBox(li, name, commit) {
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

  function rename(li) {
    const path = li.dataset.path
    nameBox(li, basename(path), async name => {
      const to = join(parent(path), name)
      if (await invoke('rename_path', { from: path, to })) moved(path, to)
    })
  }

  /** A name box atop the folders for a new folder, or atop the files for a new file. */
  function create(dir) {
    const at = cur
    const li = row('', dir ? 'dir' : 'file', '')
    list.querySelector('.empty')?.remove()
    list.insertBefore(li, dir ? list.firstChild : list.querySelector('.row:not(.dir)'))
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

  let hovered = null
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

  /** Rereads the open folder and repaints it if it changed, or always when `force`. */
  async function sync(force = false) {
    if (editing || !cur) return
    try {
      const entries = await listing(cur)
      if (force || JSON.stringify(entries) !== shown) render(entries)
    } catch {}
  }
  // Pick up files created while you work (by Claude, or anything else).
  setInterval(() => document.hidden || sync(), 2000)

  /** Opens the folder that holds `path` and points at its row. */
  async function reveal(path) {
    document.body.classList.remove('files-hidden')
    if (!(await go(parent(path)))) return
    const r = [...list.children].find(r => same(r.dataset.path ?? '', path))
    r?.scrollIntoView({ block: 'center' })
    r?.animate([{ background: 'var(--accent)' }, {}], { duration: 900, easing: 'ease-out' })
  }

  go(start)
  return {
    current: () => cur,
    go,
    mark,
    reveal,
    create,
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
