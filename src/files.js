// The file browser: anywhere on disk, not scoped to the session's folder.
import { invoke } from '@tauri-apps/api/core'
import { $, el, openMenu, showPreview, hidePreview, dragPath } from './ui.js'

const SEP = '\\'
export const ICON = {
  dir: '', file: '', image: '', code: '', doc: '', drive: '', diff: '±',
  claude: '', pin: '', unpin: '', add: '', copy: '', open: '', explorer: '',
  cut: '', paste: '', rename: '', delete: '', folder: '', openWith: '', properties: '',
  theme: '',
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
export const same = (a, b) => a.toLowerCase() === b.toLowerCase()
const isRoot = p => /^[a-z]:\\$/i.test(p)
const under = (p, dir) => same(p, dir) || p.toLowerCase().startsWith(dir.toLowerCase() + SEP)
const join = (dir, name) => (dir === '' ? name : dir.endsWith(SEP) ? dir + name : dir + SEP + name)
export const basename = p => (p === '' ? 'This PC' : isRoot(p) ? p.slice(0, 2) : p.slice(p.lastIndexOf(SEP) + 1))
/** Parent folder; drive roots lead to '' (the drive list), which has no parent. */
function parent(p) {
  if (p === '') return null
  if (isRoot(p)) return ''
  const i = p.lastIndexOf(SEP)
  return i === 2 ? p.slice(0, 3) : p.slice(0, i)
}
function normalize(p) {
  p = p.trim().replace(/^"(.*)"$/, '$1').replaceAll('/', SEP).replace(/\\+$/, '').replace(/^[a-z]:/, d => d.toUpperCase())
  return /^[A-Z]:$/.test(p) ? p + SEP : p
}

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

export function startFiles({ start, home, pinned, newSession, openFile, insertPath, installTheme }) {
  const [list, pinList, crumbs, status] = [$('list'), $('pinned'), $('crumbs'), $('status')]
  let cur = null
  let shown = ''
  let marked = '' // the open file tab's path, highlighted in the listing
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
      say(`Can't open ${path || 'This PC'}: ${e}`)
      return false
    }
    if (from === 'nav' && cur !== null && path !== cur) {
      back.push(cur)
      forward.length = 0
    }
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
    mark(marked)
    syncNav()
  }

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
    if (cur === '') parts.push(['This PC', ''])
    else {
      const underHome = home && under(cur, home)
      base = underHome ? home : cur.slice(0, 3)
      parts.push([underHome ? '~' : cur.slice(0, 2), base])
      for (const seg of cur.slice(base.length).split(SEP).filter(Boolean)) parts.push([seg, (base = join(base, seg))])
    }
    crumbs.replaceChildren(...parts.flatMap(([label, path], i) => {
      const b = el('button', { textContent: label, title: i < parts.length - 1 ? path || 'This PC' : 'Type a path' })
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
    input.onkeydown = e => (e.key === 'Enter' ? finish(true) : e.key === 'Escape' && finish(false))
    // Explorer refuses these as they're typed.
    input.addEventListener('beforeinput', e => {
      if (/[\\/:*?"<>|]/.test(e.data ?? '')) {
        e.preventDefault()
        say('A name can\'t contain \\ / : * ? " < > |')
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
    const properties = ['Properties', ICON.properties, () => invoke('open_path', { path, verb: 'properties' })]
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
        ...edits,
        ['Open with default app', ICON.open, () => invoke('open_path', { path })],
        ['Open with…', ICON.openWith, () => invoke('open_path', { path, verb: 'openas' })], add, null,
        copy, ['Show in Explorer', ICON.explorer, () => invoke('reveal', { path })], properties,
      ]
    }
    const isPinned = pins.some(p => same(p, path))
    return [
      ...edits,
      ['New Claude session here', ICON.claude, () => newSession(path)],
      [isPinned ? 'Unpin' : 'Pin to sidebar', isPinned ? ICON.unpin : ICON.pin, () => togglePin(path)],
      ...(pasteable ? [['Paste', ICON.paste, () => paste(path)]] : []), null,
      add, copy, ['Open in Explorer', ICON.explorer, () => invoke('open_path', { path })], properties,
    ]
  }

  // Shared row behavior for the pinned list and the folder listing. A row with a name box takes no clicks or drags.
  const rowAt = e => {
    const r = e.target.closest('.row')
    return r?.querySelector('input') ? null : r
  }
  for (const ul of [list, pinList]) {
    ul.addEventListener('click', e => {
      const r = rowAt(e)
      if (r) (r.matches('.dir, .drive') ? go : openFile)(r.dataset.path)
    })
    ul.addEventListener('contextmenu', async e => {
      const r = e.target.closest('.row')
      if (editing || (!r && (ul !== list || cur === ''))) return
      const isDir = r?.matches('.dir, .drive')
      const [pasteable, theme] = await Promise.all([invoke('can_paste'), r && holdsTheme(r.dataset.path, isDir)])
      if (r) openMenu(e, menuFor(r.dataset.path, isDir, ul === list && cur !== '' && r, pasteable, theme))
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
      if (r && e.button === 0) dragPath(e, r.dataset.path, target => target?.closest('#pane') && insertPath(r.dataset.path))
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

  go(start)
  return { current: () => cur, go, mark }
}
