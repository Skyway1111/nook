// A merge tab: a conflicted file's conflicts, each with its two sides next to each other and buttons that settle
// it by taking one side or both. Each one settled rewrites the file; "Mark resolved" stages it for the commit
// that finishes the merge. conflicts.js reads the markers.
import './merge.css'
import { invoke } from '@tauri-apps/api/core'
import { el } from './ui.js'
import { parseConflicts, isConflict, resolve } from './conflicts.js'
import { colorize } from './diff.js'

/** Lines of settled text shown around each conflict. */
const CONTEXT = 3

/**
 * Fills `view` with the conflicts in the file at `path`, `rel` in its repository. `run(args)` runs a git
 * command after any the panel has queued and resolves to true, or to what git said went wrong.
 */
export function startMerge(view, { root, path, rel, name, run, openFile }) {
  view.tabIndex = -1
  view.classList.add('diff', 'sides', 'merge')
  let text // the file as last read; null when it can't be read as text
  let unread = '' // why not
  let markers = null // whether the file had conflict markers when the tab opened
  let sides = null // without them, which versions git has: stage 2 is the current one, 3 the incoming
  let failed = '' // what the last write said went wrong
  let resolved = false
  let busy = false
  let paint = 0

  async function refresh(force) {
    const [next, why] = await invoke('read_text', { path }).then(t => [t, ''], e => [null, String(e)])
    if (!force && next === text && why === unread) return
    ;[text, unread] = [next, why]
    markers ??= text !== null && parseConflicts(text).some(isConflict)
    if (!markers && !sides) {
      const out = await invoke('git', { dir: root, args: ['ls-files', '-u', '--', rel] }).catch(() => '')
      sides = new Set(out.split('\n').map(l => l.split(/\s+/)[2]).filter(Boolean))
    }
    render()
  }

  /** Writes `next` over the file, unless it changed since the tab read it. */
  async function write(next) {
    if (busy) return
    busy = true
    try {
      const ok = await invoke('write_text', { path, text: next, base: text })
      failed = ok ? '' : 'The file changed meanwhile: this is it now.'
    } catch (e) {
      failed = String(e)
    }
    busy = false
    await refresh(true)
  }

  /** Runs each git command in turn until one fails, then shows what it said. */
  async function git(...commands) {
    for (const args of commands) {
      const r = await run(args)
      failed = r === true ? '' : String(r)
      if (failed) break
      if (args[0] === 'add' || args[0] === 'rm') resolved = true
    }
    await refresh(true)
  }

  function render() {
    const n = ++paint
    const parts = text == null ? [] : parseConflicts(text)
    const conflicts = parts.filter(isConflict)
    const left = conflicts.length
    const top = view.scrollTop

    const bar = el('header', { className: 'diff-bar' })
    const sum = el('span', {
      className: 'sum',
      textContent: resolved ? `${name} is resolved` : left ? `${left} conflict${left > 1 ? 's' : ''} in ${name}` : markers ? `No conflicts left in ${name}` : name,
    })
    const button = (label, onclick, className = '') => el('button', { textContent: label, onclick, className })
    const error = failed && el('span', { className: 'error', textContent: failed, title: 'Dismiss', onclick: () => error.remove() })
    bar.append(sum, ...(error ? [error] : []))
    if (left > 1) bar.append(button('All current', () => write(resolve(parts, 'ours'))), button('All incoming', () => write(resolve(parts, 'theirs'))))
    if (text != null) bar.append(button('Open file', () => openFile(path)))
    const mark = button('Mark resolved', () => git(['add', '--', rel]), 'pill')
    mark.disabled = left > 0 || resolved
    mark.title = left ? 'Settle every conflict first' : 'Stage the file for the commit that finishes this'
    bar.append(mark)
    const items = [bar]

    if (!markers) {
      // Git couldn't merge it line by line: changed on one side and deleted on the other, or not text.
      const ours = sides?.has('2')
      const theirs = sides?.has('3')
      const why = resolved ? 'Staged. Once every file is resolved, Continue in the git panel finishes it.'
        : ours && !theirs ? 'Changed on the current branch, deleted on the incoming one.'
        : theirs && !ours ? 'Deleted on the current branch, changed on the incoming one.'
        : text == null ? `nook can't show this file: ${unread}.`
        : 'Both sides changed this file, and it isn’t text git can merge line by line.'
      items.push(el('p', { className: 'meta', textContent: why }))
      if (!resolved) {
        const keep = el('div', { className: 'keep' })
        if (ours) keep.append(button('Keep current', () => git(['checkout', '--ours', '--', rel], ['add', '--', rel]), 'pill'))
        if (theirs) keep.append(button('Keep incoming', () => git(['checkout', '--theirs', '--', rel], ['add', '--', rel]), 'pill'))
        keep.append(button('Delete file', () => git(['rm', '-q', '--', rel]), 'pill danger'))
        items.push(keep)
      }
      mark.hidden = true // keeping a side resolves it
      return view.replaceChildren(...items)
    }

    if (!left) {
      items.push(el('p', { className: 'meta', textContent: resolved ? 'Staged. Once every file is resolved, Continue in the git panel finishes it.' : 'Every conflict is settled: mark the file resolved to stage it.' }))
      return view.replaceChildren(...items)
    }

    // Line numbers in each side's version of the file, for colors that read them in context.
    const lines = { old: [], new: [] }
    const cells = []
    const cell = (line, cls, ...sides) => {
      const c = el('div', { className: `cell ${cls}` })
      const code = el('span', { className: 'src', textContent: line })
      c.append(code)
      for (const side of sides) cells.push({ code, side, n: lines[side].length, text: line }), lines[side].push(line)
      return c
    }
    const row = (...cs) => {
      const r = el('div', { className: 'ln' })
      r.append(...cs)
      return r
    }
    let box = null // the hunk the next lines go in
    const open = () => (box = el('div', { className: 'hunk' }))
    let k = -1
    for (const [i, p] of parts.entries()) {
      if (!isConflict(p)) {
        let ls = p.lines
        if (i === parts.length - 1 && ls.at(-1) === '') ls = ls.slice(0, -1) // the end of the last line
        const before = i > 0
        const after = i < parts.length - 1
        const keep = (before ? CONTEXT : 0) + (after ? CONTEXT : 0)
        const shown = ls.length <= keep + 1 ? ls.map((l, j) => [l, j]) : [
          ...(before ? ls.slice(0, CONTEXT).map((l, j) => [l, j]) : []),
          null,
          ...(after ? ls.slice(-CONTEXT).map((l, j) => [l, ls.length - CONTEXT + j]) : []),
        ]
        let at = 0
        for (const s of shown) {
          if (s === null) {
            const skip = ls.length - (before ? CONTEXT : 0) - (after ? CONTEXT : 0)
            const skipped = ls.slice(at, at + skip)
            for (const l of skipped) lines.old.push(l), lines.new.push(l)
            at += skip
            if (before) box = null
            if (after) items.push(open())
            continue
          }
          if (!box) items.push(open())
          box.append(row(cell(s[0], 'ctx', 'old', 'new')))
          at++
        }
        continue
      }
      k++
      const which = k
      if (!box) items.push(open())
      box.classList.add('conflict')
      const head = el('div', { className: 'hunk-head' })
      const tools = el('span', { className: 'tools' })
      tools.append(
        button('Take current', () => write(resolve(parts, 'ours', which))),
        button('Take incoming', () => write(resolve(parts, 'theirs', which))),
        button('Take both', () => write(resolve(parts, 'both', which))),
        ...(p.base ? [button('Take original', () => write(resolve(parts, 'base', which)))] : []),
      )
      head.append(el('span', { className: 'title', textContent: `Conflict ${k + 1} of ${left} · line ${p.line}` }), tools)
      const label = (side, ref) => el('div', { className: `cell side ${side}`, textContent: ref ? `${side === 'ours' ? 'Current' : 'Incoming'} · ${ref}` : side === 'ours' ? 'Current' : 'Incoming' })
      box.append(head, row(label('ours', p.oursLabel), label('theirs', p.theirsLabel)))
      for (let j = 0; j < Math.max(p.ours.length, p.theirs.length); j++) {
        box.append(row(
          j < p.ours.length ? cell(p.ours[j], 'ours', 'old') : el('div', { className: 'cell blank' }),
          j < p.theirs.length ? cell(p.theirs[j], 'theirs', 'new') : el('div', { className: 'cell blank' }),
        ))
      }
    }
    view.replaceChildren(...items)
    view.scrollTop = top
    highlight(lines, cells, n)
  }

  async function highlight(lines, cells, n) {
    const { tokenize } = await import('./editor.js')
    const [old, now] = await Promise.all([lines.old, lines.new].map(ls => tokenize(ls.join('\n'), name).catch(() => null)))
    if (n !== paint) return
    for (const c of cells) {
      const tokens = (c.side === 'old' ? old : now)?.[c.n]
      if (tokens?.length) colorize(c.code, c.text, tokens)
    }
  }

  refresh()
  return { refresh: () => refresh() }
}
