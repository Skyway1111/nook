// The search tab: find text across a folder's files, every match listed under its file, and replace them all
// at once, but those dropped from the list. Matching runs in Rust (replace.rs) once typing pauses, with case,
// whole words and regular expressions as toggled. A replace rewrites only files that still hold what the
// search read and that have no unsaved edits in a tab, and Undo puts back what it changed.
import { invoke } from './host.js'
import { el, letter, sheet } from './ui.js'
import { ICON } from './files.js'
import { path as paths } from './paths.js'

await sheet(new URL('./replace.css', import.meta.url))

const OPTIONS_KEY = 'nook.replace.options'
const remembered = () => { try { return JSON.parse(localStorage.getItem(OPTIONS_KEY)) ?? {} } catch { return {} } }
const remember = options => { try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(options)) } catch {} }
const plural = (n, word, words = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : words}`
const matches = n => plural(n, 'match', 'matches')

/** `text` with characters `at` to `at + len` marked, and `to` beside them when a replacement is shown. */
function line(text, at, len, to) {
  const chars = Array.from(text)
  const span = el('span', { className: 'text' })
  span.append(chars.slice(0, at).join(''))
  const hit = el('mark', { textContent: chars.slice(at, at + len).join('') })
  if (to == null) span.append(hit)
  else {
    hit.className = 'gone'
    span.append(hit, el('ins', { textContent: to }))
  }
  span.append(chars.slice(at + len).join(''))
  return span
}

/**
 * Fills `view` with a search over `dir`'s files: `openFile(path, line, col)` opens a match, `unsaved()` lists
 * paths with unsaved edits in a tab, and `refresh()` has open tabs reread their files after a replace.
 */
export function startReplace(view, { dir, openFile, unsaved, refresh }) {
  view.classList.add('replace')
  const options = { case: false, word: false, regex: false, ...remembered() }
  const input = (cls, placeholder) => el('input', { className: cls, placeholder, spellcheck: false, autocomplete: 'off' })
  const find = input('text', 'Find')
  const toggle = (key, label, title) => {
    const b = el('button', { className: `opt${options[key] ? ' on' : ''}`, textContent: label, title, tabIndex: -1 })
    b.onclick = () => {
      options[key] = !options[key]
      b.classList.toggle('on', options[key])
      remember(options)
      run()
    }
    return b
  }
  const opts = el('div', { className: 'opts' })
  opts.append(toggle('case', 'Aa', 'Match case'), toggle('word', 'ab', 'Whole words'), toggle('regex', '.*', 'Regular expression ($1 in the replacement takes a group)'))
  const replace = input('with', 'Replace')
  const all = el('button', { className: 'go', textContent: 'Replace all', disabled: true, tabIndex: -1 })
  const files = input('files', 'In files: *.js, src/, !test')
  const status = el('div', { className: 'status' })
  const list = el('div', { className: 'results', tabIndex: -1 })
  const bar = el('div', { className: 'replace-bar' })
  bar.append(el('div', { className: 'line' }), el('div', { className: 'line' }), el('div', { className: 'line' }))
  bar.children[0].append(find, opts)
  bar.children[1].append(replace, all)
  bar.children[2].append(files)
  view.append(bar, status, list)

  let found = null // the last search's result, with `dropped`: a Set of "file\0start" for matches taken out
  let asked = null // the search running, so an older answer is dropped
  let timer = 0
  let notice = null // what the last replace or undo did, `{ text, actions }`, shown until the search changes

  const key = (file, start) => `${file}\0${start}`
  const query = () => ({ text: find.value, case: options.case, word: options.word, regex: options.regex, files: files.value })

  function say(text, ...actions) {
    status.replaceChildren(el('span', { textContent: text }))
    for (const [label, act] of actions) {
      const b = el('button', { className: 'link', textContent: label })
      b.onclick = act
      status.append(b)
    }
  }

  /** The matches a replace would change: every one shown but those dropped. */
  function kept() {
    if (!found) return []
    return found.files.map(f => ({ f, matches: f.matches.filter(m => !found.dropped.has(key(f.file, m.start))) })).filter(k => k.matches.length)
  }

  function summary() {
    if (!found) return notice && say(notice.text, ...notice.actions)
    const k = kept()
    const n = k.reduce((s, x) => s + x.matches.length, 0)
    const total = found.files.reduce((s, f) => s + f.matches.length, 0)
    const where = paths.basename(found.root) || found.root
    all.disabled = !n
    all.textContent = n ? `Replace ${matches(n)}` : 'Replace all'
    const shown = `${matches(total)} in ${plural(found.files.length, 'file')} under ${where}`
    const more = found.partial ? ' (stopped there; narrow the search or the files)' : ''
    if (notice) say(notice.text, ...notice.actions)
    else say(total ? `${shown}${more}` : `No matches in ${plural(found.searched, 'file')} under ${where}`)
  }

  function render() {
    list.replaceChildren()
    if (!found) return summary()
    for (const f of found.files) {
      const group = el('section', { className: 'file' })
      const head = el('div', { className: 'head', title: paths.fromSlashes(found.root, f.file) })
      const slash = f.file.lastIndexOf('/')
      head.append(
        el('i', { className: 'icon', textContent: ICON.file }),
        el('b', { textContent: f.file.slice(slash + 1) }),
        el('span', { className: 'dir', textContent: slash > 0 ? f.file.slice(0, slash) : '' }),
        el('span', { className: 'count', textContent: f.matches.length }),
        el('button', { className: 'icon drop', textContent: ICON.close, title: 'Leave this file out' }),
      )
      head.lastChild.onclick = e => {
        e.stopPropagation()
        const out = f.matches.every(m => found.dropped.has(key(f.file, m.start)))
        for (const m of f.matches) found.dropped[out ? 'delete' : 'add'](key(f.file, m.start))
        group.classList.toggle('out', !out)
        group.querySelectorAll('.match').forEach(r => r.classList.toggle('out', !out))
        summary()
      }
      head.onclick = () => group.classList.toggle('shut')
      group.append(head)
      for (const m of f.matches) {
        const row = el('div', { className: 'match', title: `Line ${m.line}` })
        if (found.dropped.has(key(f.file, m.start))) row.classList.add('out')
        row.append(el('span', { className: 'num', textContent: m.line }), line(m.text, m.at, m.len, m.to),
          el('button', { className: 'icon drop', textContent: ICON.close, title: 'Leave this match as it is' }))
        row.onclick = e => {
          const k = key(f.file, m.start)
          if (e.target.closest('.drop')) {
            if (!found.dropped.delete(k)) found.dropped.add(k)
            row.classList.toggle('out', found.dropped.has(k))
            group.classList.toggle('out', f.matches.every(x => found.dropped.has(key(f.file, x.start))))
            return summary()
          }
          openFile(paths.fromSlashes(found.root, f.file), m.line, m.col)
        }
        group.append(row)
      }
      if (f.matches.every(m => found.dropped.has(key(f.file, m.start)))) group.classList.add('out')
      list.append(group)
    }
    summary()
  }

  /** Searches again, now or after `wait` ms, keeping matches dropped from the last list dropped. */
  function run(wait = 0) {
    clearTimeout(timer)
    const q = query()
    if (!q.text) {
      asked = null
      found = null
      all.disabled = true
      list.replaceChildren()
      return notice ? say(notice.text, ...notice.actions) : say('Type to find text in every file under the folder')
    }
    timer = setTimeout(() => {
      const me = (asked = {})
      if (!found && !notice) say('Searching…')
      invoke('find_in_files', { dir, query: q, with: replace.value || null }).then(result => {
        if (asked !== me || result.stale) return
        const dropped = new Set()
        if (found) for (const f of result.files) for (const m of f.matches) if (found.dropped.has(key(f.file, m.start))) dropped.add(key(f.file, m.start))
        found = { ...result, dropped }
        render()
      }, e => {
        if (asked !== me) return
        found = null
        list.replaceChildren()
        all.disabled = true
        say(`Can't search: ${e}`)
      })
    }, wait)
  }

  async function replaceAll() {
    const k = kept()
    if (!k.length || !found) return
    const open = unsaved()
    const left = []
    const picks = []
    for (const { f } of k) {
      const abs = paths.fromSlashes(found.root, f.file)
      if (open.some(p => paths.same(p, abs))) {
        left.push(`${f.file}: unsaved in a tab`)
        continue
      }
      picks.push({ file: f.file, stamp: f.stamp, skip: f.matches.filter(m => found.dropped.has(key(f.file, m.start))).map(m => m.start) })
    }
    all.disabled = true
    try {
      const done = await invoke('replace_in_files', { root: found.root, query: query(), with: replace.value, files: picks })
      left.push(...done.skipped.map(s => `${s.file}: ${s.why}`))
      const text = `Replaced ${matches(done.replaced)} in ${plural(done.files, 'file')}.`
        + (left.length ? ` Left alone: ${left.join('; ')}.` : '')
      notice = { text, actions: done.files ? [['Undo', undoAll]] : [] }
      refresh()
      all.disabled = true // until the search below reads the files as they are now
      run()
      summary()
    } catch (e) {
      say(`Can't replace: ${e}`)
      all.disabled = false
    }
  }

  async function undoAll() {
    notice = null
    const done = await invoke('undo_replace')
    refresh()
    run()
    const left = done.skipped.map(s => `${paths.basename(s.file)}: ${s.why}`)
    notice = { text: `Put back ${plural(done.files, 'file')}.${left.length ? ` Left alone: ${left.join('; ')}.` : ''}`, actions: [] }
    summary()
  }

  find.oninput = () => { notice = null; run(200) }
  files.oninput = () => { notice = null; run(300) }
  replace.oninput = () => { notice = null; run(200) }
  all.onclick = replaceAll
  for (const box of [find, replace, files]) {
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.ctrlKey) (e.preventDefault(), replaceAll())
      else if (e.key === 'Enter') (e.preventDefault(), run())
      else if (e.altKey && /^[cwr]$/.test(letter(e))) {
        // Alt+C, Alt+W and Alt+R toggle case, whole words and regular expressions, as in VS Code.
        e.preventDefault()
        opts.children['cwr'.indexOf(letter(e))].click()
      }
    })
  }
  say('Type to find text in every file under the folder')

  // A tab's refresh runs when it's shown and every few seconds while it's in front: search again only when the
  // tab comes back, so files changed meanwhile show, and never on the timer.
  let away = false
  new MutationObserver(() => { if (view.hidden) away = true }).observe(view, { attributes: true, attributeFilter: ['hidden'] })

  return {
    /** Shows the tab with `text` to find, and the Replace box focused when `replacing`. */
    open(text, replacing) {
      if (text && text !== find.value) {
        find.value = text
        notice = null
        run()
      }
      const box = replacing && find.value ? replace : find
      setTimeout(() => (box.focus(), box.select()))
    },
    refresh() {
      if (!away) return
      away = false
      if (found) run()
    },
    focus: () => find.focus(),
  }
}
