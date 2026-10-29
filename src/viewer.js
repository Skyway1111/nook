// A file tab: a picture, audio or video, a PDF, or text in an editor. Markdown, CSV and TSV, SVG, and HTML
// with no script open rendered and toggle to their source. previews.js draws all but Markdown, and loads when one first opens.
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { IMAGE, basename } from './files.js'
import { el, openMenu } from './ui.js'
import { path as paths } from './paths.js'

const SCHEME = /^[a-z][\w+.-]*:/i
// The only links that leave nook. ShellExecute on any other scheme from a file on disk can run anything.
const WEB = /^(https?|mailto):/i
// This page can call pty_write, so Markdown from disk passes the browser's sanitizer, which removes
// every script and event handler. The extra removals keep a file from restyling nook, navigating it,
// or shadowing a `document` method with a named element. A browser without one, as WebKitGTK is,
// gets sanitize.js's list of what Markdown writes, and nothing else.
const SANITIZE = { sanitizer: { removeElements: ['style', 'meta', 'link', 'form'], removeAttributes: ['style', 'id', 'name'] } }

/** `href` relative to the file at `from`, as a path. */
const resolve = (href, from) => paths.fromUrl(new URL(href, paths.toUrl(from)).pathname)

// Loaded on first use, so a Claude tab never waits on CodeMirror.
const editing = () => import('./editor.js')
const previews = () => import('./previews.js')

/** Text files that open rendered, by how they're drawn. */
const RENDERED = [[/\.(md|markdown)$/i, 'markdown'], [/\.(csv|tsv)$/i, 'sheet'], [/\.svg$/i, 'svg'], [/\.html?$/i, 'html']]
// Shown without reading them as text. Kept here, beside IMAGE, so a Claude tab's code loads no more.
const MEDIA = /\.(mp4|webm|mov|m4v|ogv|mp3|wav|ogg|oga|flac|m4a|aac|opus)$/i
const PDF = /\.pdf$/i

async function markdown(text, path) {
  const [{ marked }, { highlight }, { clean }] = await Promise.all([import('marked'), editing(), import('./sanitize.js')])
  // An inert document: nothing loads until the relative image paths point at the disk.
  const doc = Document.parseHTML ? Document.parseHTML(marked.parse(text), SANITIZE)
    : clean(new DOMParser().parseFromString(marked.parse(text), 'text/html'))
  for (const img of doc.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src')
    if (!SCHEME.test(src)) img.src = convertFileSrc(resolve(src, path))
  }
  for (const code of doc.querySelectorAll('pre > code[class^="language-"]')) {
    const colored = await highlight(code.textContent, code.className.slice('language-'.length))
    if (colored) code.replaceChildren(colored)
  }
  const article = el('article')
  article.append(...doc.body.childNodes)
  return article
}

const button = (html, onclick) => el('button', { innerHTML: html, onclick })

// Blame is on or off for every file tab at once, and stays as it was left. Alt+B, or the gutter's menu, turns it.
const BLAME_KEY = 'nook.blame'
let blameOn = (() => { try { return localStorage.getItem(BLAME_KEY) === '1' } catch { return false } })()
function setBlameOn(on) {
  blameOn = on
  try { localStorage.setItem(BLAME_KEY, on ? '1' : '0') } catch {}
  dispatchEvent(new Event('nook-blame'))
}

const note = (path, error) => [
  el('p', { textContent: `nook can't show ${basename(path)}: ${error}.` }),
  button('Open with default app', () => invoke('open_path', { path })),
]

/** The one change that turns `a` into `b`: whatever lies between their common prefix and suffix. */
function change(a, b) {
  let from = 0
  const end = Math.min(a.length, b.length)
  while (from < end && a[from] === b[from]) from++
  let k = 0
  while (k < end - from && a[a.length - 1 - k] === b[b.length - 1 - k]) k++
  return { from, to: a.length - k, insert: b.slice(from, b.length - k) }
}

/** `onText` hears the editor's text after each load and edit. `autosave` saves a moment after each edit.
 * `onPick` hears a moment after the selection changes, so it can ask `pick()` what it is. */
export function startViewer(view, path, { openFile, onDirty, onText, autosave, mention: toPrompt, onPick }) {
  view.tabIndex = -1 // focusable, so the keyboard scrolls it
  const name = basename(path)
  let shown, failed // on disk at the last read or write: the file's text, or why it can't be shown
  let stamp // the file's change time and size at the last read, so a poll rereads it only after a change
  let eol // the file's line ending. The editor holds \n and saves with this.
  let editor, saved // the editor, and its text as last read or written
  let dirty = false
  let target // { line, col } to show once the text has loaded
  const bar = el('p', { className: 'bar', hidden: true })
  // The rendered page, and the button that swaps it for the source.
  const drawn = RENDERED.find(([test]) => test.test(path))?.[1]
  const page = drawn && el('div', { className: drawn === 'markdown' ? 'markdown' : 'rendered', tabIndex: -1 })
  let drawing // previews.js's view of a sheet, an SVG, or a page, once it has drawn one
  let player // previews.js's view of audio, video, or a PDF
  const toggle = page && Object.assign(button('', () => { preview(!previewing); focus() }), { className: 'mode' })
  let previewing = !!page

  // A read that lands after a save would revert the editor, so disk work runs one call at a time.
  let last = Promise.resolve()
  const serial = f => (last = last.catch(() => {}).then(f))

  function paint(mode, nodes) {
    view.className = `view ${mode}`
    view.replaceChildren(...nodes)
  }

  let told = ''
  /** A line under the text, with buttons: `[label, action]` pairs. No message hides it. */
  function tell(message = '', ...actions) {
    if (message === told) return
    told = message
    bar.hidden = !message
    bar.replaceChildren(message, ...actions.map(([label, action]) => button(label, action)))
  }
  const conflict = () => tell(`${name} changed on disk.`, ['Overwrite', () => save(true)], ['Reload', () => refresh(true)])

  // Blame asks git about the editor's own text, so it holds for unsaved edits too: a while after the last one.
  let blaming = 0 // counts blame runs, so an old one's answer is dropped
  let reblame
  async function blame() {
    clearTimeout(reblame)
    const n = ++blaming
    if (!editor) return
    const { showBlame } = await editing()
    if (!blameOn) return showBlame(editor, null)
    const text = editor.state.doc.toString()
    const args = ['blame', '--porcelain', '--contents', '-', '--', name]
    const out = await invoke('git', { dir: paths.parent(path), args, input: text }).catch(() => null)
    if (n !== blaming || !editor) return
    const { parseBlame } = await import('./blame.js')
    // Outside a repository, or not yet committed: no gutter.
    showBlame(editor, out && parseBlame(out), oid => dispatchEvent(new CustomEvent('nook-history', { detail: { path, oid } })))
  }
  const onBlame = () => blame()
  addEventListener('nook-blame', onBlame)

  // Change bars: the editor's lines against the copy of the file in git's index, so they show what the git
  // panel's unstaged diff would, unsaved edits included. Read again when the index file changes.
  let base = null // that copy's lines, or null outside a repository or for a file git doesn't track
  let index // the index file, once known, and its stamp at the last read
  let indexStamp
  let basing = 0 // counts reads, so an old one's answer is dropped
  let barring // the timer that redraws the bars a moment after an edit
  async function rebase() {
    const n = ++basing
    const dir = paths.parent(path)
    if (index === undefined) {
      const gitDir = await invoke('git', { dir, args: ['rev-parse', '--absolute-git-dir'] }).catch(() => '')
      index = gitDir.trim() ? paths.join(paths.normalize(gitDir.trim()), 'index') : null
    }
    if (!index) return
    indexStamp = await invoke('file_stamp', { path: index }).catch(() => null)
    const text = await invoke('git', { dir, args: ['show', `:./${name}`] }).catch(() => null)
    if (n !== basing || !editor) return
    base = text === null ? null : text.replace(/\r\n?/g, '\n').split('\n')
    bars()
  }
  async function bars() {
    clearTimeout(barring)
    if (!editor) return
    const { showChanges } = await editing()
    if (editor) showChanges(editor, base)
  }

  let pending // an autosave's timer
  function changed() {
    const now = !editor.state.doc.eq(saved)
    if (now !== dirty) onDirty((dirty = now))
    onText?.(editor.state.doc.toString())
    if (base) {
      // A pause in typing redraws them; in a long file, where that's tens of milliseconds, a longer one.
      clearTimeout(barring)
      barring = setTimeout(bars, editor.state.doc.lines > 20_000 ? 1500 : 250)
    }
    if (blameOn) {
      clearTimeout(reblame)
      reblame = setTimeout(blame, 1500)
    }
    if (autosave && dirty) {
      clearTimeout(pending)
      pending = setTimeout(save, 300)
    }
  }

  async function render() {
    if (!previewing) return
    if (drawn !== 'markdown') {
      const text = editor.state.doc.toString()
      if (!drawing) {
        drawing = (await previews())[drawn](path)
        page.replaceChildren(drawing.el)
      }
      return drawing.update(text, name)
    }
    const article = await markdown(editor.state.doc.toString(), path)
    const top = page.scrollTop
    page.replaceChildren(article)
    page.scrollTop = top
  }

  function preview(on) {
    previewing = on
    picked()
    page.hidden = !on
    editor.dom.hidden = on
    toggle.innerHTML = on ? '<i class="icon">&#xE70F;</i>Edit' : '<i class="icon">&#xE890;</i>Preview'
    render()
  }

  async function load(text) {
    shown = text
    eol = text.includes('\r\n') ? '\r\n' : '\n'
    if (editor) {
      const tr = editor.state.update({ changes: change(editor.state.doc.toString(), text.replace(/\r\n?/g, '\n')) })
      saved = tr.newDoc
      editor.dispatch(tr)
      rebase()
      return render()
    }
    const { createEditor } = await editing()
    editor = createEditor(name, text, changed, { picked, ...(autosave ? {} : { status: { eol: () => eol } }) })
    saved = editor.state.doc
    changed()
    paint('text', [editor.dom, ...(page ? [page, toggle] : []), bar])
    if (blameOn) blame()
    rebase()
    // A page with a script opens on its source: drawn with scripts off, it would mostly be blank.
    if (page) preview(previewing && !target && !(drawn === 'html' && /<script\b/i.test(text)))
    if (document.activeElement === view) focus()
    if (target) reveal(target)
  }

  /** Shows `line` and `col` in the source, now or once the text loads. */
  async function reveal({ line, col }) {
    target = { line, col }
    if (!editor) return
    target = null
    if (previewing) preview(false)
    const { goto } = await editing()
    goto(editor, line, col)
    editor.focus()
  }

  /**
   * For quick open's `@`: `read`, the file's outline from editor.js; `look(item)` to show one while the box rests on
   * it, without taking the keys; `back()` to put the caret and the scroll back as they were before the first look;
   * and `go(item)` to go there. A heading of a rendered Markdown page shows on the page.
   */
  function outline() {
    let items = []
    let mod // editor.js, once loaded, so a look and a back run in the order they're asked for
    let before = null
    const heading = item => previewing && drawn === 'markdown' && item.kind === 'heading'
      && page.querySelectorAll('h1, h2, h3, h4, h5, h6')[items.filter(i => i.kind === 'heading').indexOf(item)]
    return {
      read: editing().then(m => {
        mod = m
        const found = editor ? m.outline(editor) : { items: [], partial: false }
        items = found.items
        return found
      }),
      look(item) {
        if (!editor || !mod) return
        before ??= { selection: editor.state.selection, top: editor.scrollDOM.scrollTop, page: page?.scrollTop }
        const h = heading(item)
        if (h) h.scrollIntoView({ block: 'start' })
        else if (!previewing && item.from <= editor.state.doc.length) mod.show(editor, item.from)
      },
      back() {
        if (!before || !editor) return
        const { selection, top, page: pageTop } = before
        before = null
        if (selection.main.to <= editor.state.doc.length) editor.dispatch({ selection })
        editor.scrollDOM.scrollTop = top
        if (page) page.scrollTop = pageTop
      },
      go(item) {
        before = null
        if (!editor) return
        const h = heading(item)
        if (h) return h.scrollIntoView({ block: 'start' }), page.focus()
        const at = Math.min(item.from, editor.state.doc.length)
        const line = editor.state.doc.lineAt(at)
        reveal({ line: line.number, col: at - line.from + 1 })
      },
    }
  }

  /** Rereads the file. A buffer with unsaved edits stays as it is unless `discard`. */
  const refresh = (discard = false) => serial(async () => {
    if (MEDIA.test(path) || PDF.test(path) || (IMAGE.test(path) && drawn !== 'svg')) {
      if (shown) return
      shown = path
      const p = await previews()
      player = MEDIA.test(path) ? p.media(path) : PDF.test(path) ? p.pdf(path) : p.picture(convertFileSrc(path))
      paint(MEDIA.test(path) ? 'media' : PDF.test(path) ? 'pdf' : 'picture', [player.el])
      if (document.activeElement === view) player.el.focus()
      return
    }
    // A commit, a stage or a checkout, from the panel or a terminal, writes the index: the bars follow it.
    if (index && editor) invoke('file_stamp', { path: index }).then(s => s !== indexStamp && rebase(), () => {})
    const now = await invoke('file_stamp', { path })
    if (now && now === stamp && !discard) return
    stamp = now
    const [text, error] = await invoke('read_text', { path }).then(t => [t, ''], e => [null, String(e)])
    if (text === shown && error === failed) return
    if (dirty && !discard) return conflict()
    failed = error
    tell()
    if (!error) return load(text)
    shown = null
    editor?.destroy()
    editor = null
    if (dirty) onDirty((dirty = false))
    paint('note', note(path, error))
  })

  /** Writes the editor's text. False when nothing was written: an error, or the file changed since it was read. */
  const save = (force = false) => serial(async () => {
    if (!dirty) return true
    const doc = editor.state.doc
    const text = doc.sliceString(0, doc.length, eol)
    try {
      if (!(await invoke('write_text', { path, text, base: force ? null : shown }))) return conflict(), false
    } catch (e) {
      tell(`nook can't save ${name}: ${e}.`)
      return false
    }
    shown = text
    saved = doc
    tell()
    changed()
    return true
  })

  const focus = () => (!editor ? player?.el ?? view : previewing ? page : editor).focus()

  /** Names the picked lines, or the file when none are picked, in Claude's prompt. A pick that ends at the start
   * of a line leaves that line out, as a drag over whole lines does. */
  function mention() {
    if (!toPrompt) return
    const { from, to, empty } = editor?.state.selection.main ?? { empty: true }
    if (empty) return toPrompt(null)
    const doc = editor.state.doc
    const first = doc.lineAt(from).number
    const end = doc.lineAt(to)
    toPrompt([first, Math.max(first, end.number - (end.from === to ? 1 : 0))])
  }

  /** The lines picked in the source, for Claude: `{ start, end, text }`, each end `[line, character]` counted
   * from 0. Null when nothing is picked or the page shows instead. */
  function pick() {
    const { from, to, empty } = editor?.state.selection.main ?? { empty: true }
    if (empty || previewing) return null
    const at = pos => {
      const line = editor.state.doc.lineAt(pos)
      return [line.number - 1, pos - line.from]
    }
    return { start: at(from), end: at(to), text: editor.state.sliceDoc(from, to) }
  }
  let picking // a pause in a drag or in the caret's moves tells onPick, not each step
  function picked() {
    clearTimeout(picking)
    picking = setTimeout(() => onPick?.(), 150)
  }

  view.addEventListener('keydown', e => {
    // Ctrl+Alt+K, as in Claude's own editor extensions.
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'k') (e.preventDefault(), mention())
    else if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 's') save()
    else if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'b' && editor) (e.preventDefault(), setBlameOn(!blameOn))
  })
  view.addEventListener('contextmenu', e => {
    if (!editor || !e.target.closest('.cm-gutters')) return
    e.preventDefault()
    openMenu(e, [[blameOn ? 'Hide blame' : 'Show blame', '\uE81C', () => setBlameOn(!blameOn)]])
  })

  function follow(e) {
    const a = e.target.closest('a[href]')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href')
    if (WEB.test(href)) invoke('open_path', { path: href })
    else if (!SCHEME.test(href) && !href.startsWith('#')) openFile(resolve(href, path))
  }
  view.addEventListener('click', follow)
  view.addEventListener('auxclick', follow)

  return {
    refresh: () => refresh(),
    save: () => save(),
    dirty: () => dirty,
    reveal,
    /** Quick open's `@`, or null before the text has loaded. */
    outline: () => (editor ? outline() : null),
    /** The text selected in the editor, or ''. */
    selection: () => (editor ? editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to) : ''),
    /** Replaces the text with `f(text)` as one edit, once the file has loaded. */
    edit: f => serial(() => {
      const text = editor?.state.doc.toString()
      if (editor) editor.dispatch({ changes: change(text, f(text)) })
    }),
    focus,
    mention,
    pick,
    close: () => {
      clearTimeout(picking)
      removeEventListener('nook-blame', onBlame)
      clearTimeout(reblame)
      clearTimeout(barring)
      editor?.destroy(); drawing?.close?.(); player?.close?.()
    },
  }
}
