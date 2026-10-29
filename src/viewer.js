// A file tab: an image, or text in an editor. Markdown opens rendered and toggles to its source.
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { IMAGE, basename } from './files.js'
import { el } from './ui.js'
import { path as paths } from './paths.js'

const SCHEME = /^[a-z][\w+.-]*:/i
// The only links that leave nook. ShellExecute on any other scheme from a file on disk can run anything.
const WEB = /^(https?|mailto):/i
// This page can call pty_write, so Markdown from disk passes the browser's sanitizer, which removes
// every script and event handler. The extra removals keep a file from restyling nook, navigating it,
// or shadowing a `document` method with a named element.
const SANITIZE = { sanitizer: { removeElements: ['style', 'meta', 'link', 'form'], removeAttributes: ['style', 'id', 'name'] } }

/** `href` relative to the file at `from`, as a path. */
const resolve = (href, from) => paths.fromUrl(new URL(href, paths.toUrl(from)).pathname)

// Loaded on first use, so a Claude tab never waits on CodeMirror.
const editing = () => import('./editor.js')

async function markdown(text, path) {
  const [{ marked }, { highlight }] = await Promise.all([import('marked'), editing()])
  // An inert document: nothing loads until the relative image paths point at the disk.
  const doc = Document.parseHTML(marked.parse(text), SANITIZE)
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

/** `onText` hears the editor's text after each load and edit. `autosave` saves a moment after each edit. */
export function startViewer(view, path, { openFile, onDirty, onText, autosave }) {
  view.tabIndex = -1 // focusable, so the keyboard scrolls it
  const name = basename(path)
  let shown, failed // on disk at the last read or write: the file's text, or why it can't be shown
  let stamp // the file's change time and size at the last read, so a poll rereads it only after a change
  let eol // the file's line ending. The editor holds \n and saves with this.
  let editor, saved // the editor, and its text as last read or written
  let dirty = false
  let target // { line, col } to show once the text has loaded
  const bar = el('p', { className: 'bar', hidden: true })
  // Markdown's rendered page, and the button that swaps it for the source.
  const page = /\.(md|markdown)$/i.test(path) && el('div', { className: 'markdown', tabIndex: -1 })
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

  let pending // an autosave's timer
  function changed() {
    const now = !editor.state.doc.eq(saved)
    if (now !== dirty) onDirty((dirty = now))
    onText?.(editor.state.doc.toString())
    if (autosave && dirty) {
      clearTimeout(pending)
      pending = setTimeout(save, 300)
    }
  }

  async function render() {
    if (!previewing) return
    const article = await markdown(editor.state.doc.toString(), path)
    const top = page.scrollTop
    page.replaceChildren(article)
    page.scrollTop = top
  }

  function preview(on) {
    previewing = on
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
      return render()
    }
    const { createEditor } = await editing()
    editor = createEditor(name, text, changed)
    saved = editor.state.doc
    changed()
    paint('text', [editor.dom, ...(page ? [page, toggle] : []), bar])
    if (page) preview(previewing && !target)
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

  /** Rereads the file. A buffer with unsaved edits stays as it is unless `discard`. */
  const refresh = (discard = false) => serial(async () => {
    if (IMAGE.test(path)) {
      if (!shown) paint('picture', [Object.assign(new Image(), { src: convertFileSrc(path) })])
      shown = path
      return
    }
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

  const focus = () => (!editor ? view : previewing ? page : editor).focus()

  view.addEventListener('keydown', e => {
    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 's') save()
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
    /** Replaces the text with `f(text)` as one edit, once the file has loaded. */
    edit: f => serial(() => {
      const text = editor?.state.doc.toString()
      if (editor) editor.dispatch({ changes: change(text, f(text)) })
    }),
    focus,
    close: () => editor?.destroy(),
  }
}
