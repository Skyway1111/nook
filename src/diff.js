// A diff tab: what changed under a path, staged and unstaged, in syntax colors, unified or side by side.
// A hunk's buttons stage, unstage, or discard it, or only the lines picked in it, through `git apply`.
// history.js shows a commit's changes with it too, read-only.
import { invoke } from './host.js'
import { el, openMenu, sheet } from './ui.js'
import { ICON, basename } from './files.js'
import { path as paths } from './paths.js'
import { parseDiff, patch, applyArgs, changedRanges } from './patch.js'

await sheet(new URL('./diff.css', import.meta.url))

/** A file with more diff lines than this waits for a click: thousands of rows would stall the tab. */
const LONG = 1500
const SPLIT_KEY = 'nook.diff.split'
const remembered = key => { try { return localStorage.getItem(key) === '1' } catch { return false } }
const remember = (key, on) => { try { localStorage.setItem(key, on ? '1' : '0') } catch {} }

/** What `git show` needs to write a commit's changes as a diff tab reads them; a merge shows what it brought in. */
const SHOW = ['-c', 'core.quotepath=false', 'show', '--format=', '--no-color', '--no-ext-diff', '--no-relative', '-M', '--diff-merges=first-parent', '--src-prefix=a/', '--dst-prefix=b/']

/**
 * Fills `view` with the changes under `rel` in the repository at `root` ('' for all of it). `run(args, input)`
 * runs a git command after any the panel has queued and resolves to true, or to what git said went wrong;
 * `stage(paths, on)` stages or unstages whole files as the panel's checkboxes do, and resolves the same way.
 * Given `commit`, it shows that commit's changes instead, read-only, after `commit.intro`; `show(commit)`
 * moves it to another, and null shows none. Given `only`, a list of paths in the repository, it shows those
 * files alone, and `review(list)` changes the list.
 */
export function startDiff(view, { root, rel, openFile, run, stage, commit, only }) {
  view.tabIndex = -1 // focusable, so the keyboard scrolls it
  const fixed = commit !== undefined
  let shown // the diffs' text last painted
  let split = remembered(SPLIT_KEY)
  let hunks = [] // every hunk on screen: { file, hunk, staged, el, cells: Map(line index → [cell]) }
  let picked = null // { k, set, anchor }: lines picked in hunk k
  let undo = null // the last discard's patch, to put back
  let failed = '' // what git said when the last write failed
  let paint = 0 // counts renders, so a late highlight for an old one is dropped
  const collapsed = new Set() // files folded away, by section and path
  const opened = new Set() // long files the user asked to see
  // A file's lines are built, then colored, only as it nears the screen: a diff of every change can run to
  // thousands of lines, and most of them are never scrolled to.
  let near = null
  const lineHeight = () => parseFloat(getComputedStyle(view).fontSize) * 1.5 || 21

  let loaded = null // the commit shown: its changes never change, so it reads them once
  async function refresh(force) {
    if (fixed) {
      const at = commit
      if (!at || (at === loaded && !force)) return
      const text = await invoke('git', { dir: root, args: [...SHOW, at.oid, '--', ...(rel ? [rel] : [])] }).catch(e => `\\ nook ${e}`)
      if (at !== commit) return
      loaded = at
      shown = text
      return render([[null, parseDiff(text), false]])
    }
    const [staged, unstaged] = await Promise.all([true, false].map(s => invoke('git_diff', { root, path: rel, paths: only, staged: s }).catch(e => `\\ nook ${e}`)))
    const text = staged + '\0' + unstaged
    if (text === shown && !force) return
    if (text !== shown) picked = null
    shown = text
    const top = view.scrollTop
    render([['Staged', parseDiff(staged), true], ['Changes', parseDiff(unstaged), false]])
    view.scrollTop = top
  }

  /** Shows another commit's changes, from the top. */
  function show(next) {
    commit = next
    loaded = null
    view.scrollTop = 0
    if (next) return refresh()
    paint++
    view.replaceChildren()
  }

  /** `sections` are `[title, files, staged]`; a commit's one section has no title. */
  function render(sections) {
    paint++
    hunks = []
    near?.disconnect()
    near = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) near.unobserve(e.target), e.target.fill()
    }, { root: view, rootMargin: '1200px 0px' })
    view.classList.add('diff')
    view.classList.toggle('sides', split)
    const all = sections.flatMap(([, files]) => files)
    const bar = el('header', { className: 'diff-bar' })
    const sum = el('span', { className: 'sum' })
    const add = all.reduce((n, f) => n + f.added, 0)
    const del = all.reduce((n, f) => n + f.removed, 0)
    sum.innerHTML = `<b class="add">+${add}</b> <b class="del">−${del}</b>`
    const count = new Set(all.map(f => f.path)).size
    sum.prepend(`${count} file${count === 1 ? '' : 's'} `)
    const mode = el('span', { className: 'seg' })
    for (const [label, on] of [['Unified', false], ['Split', true]]) {
      mode.append(el('button', { textContent: label, className: split === on ? 'on' : '', onclick: () => setSplit(on) }))
    }
    const error = failed && el('span', { className: 'error', textContent: failed, title: 'Dismiss', onclick: () => error.remove() })
    bar.append(sum, ...(error ? [error] : []), ...(undo ? [el('button', { className: 'pill', textContent: 'Undo discard', onclick: putBack })] : []), mode)
    const out = [...(commit?.intro ?? []), bar]
    if (!all.length) out.push(el('p', { className: 'none', textContent: fixed ? 'No changes to files' : 'No changes' }))
    for (const [title, files, isStaged] of sections) {
      if (!files.length) continue
      if (title) out.push(el('h2', { textContent: `${title} · ${files.length}` }))
      for (const f of files) out.push(file(f, isStaged))
      for (const n of files.notes) out.push(el('p', { className: 'meta', textContent: n }))
    }
    view.replaceChildren(...out)
  }

  function setSplit(on) {
    split = on
    remember(SPLIT_KEY, on)
    refresh(true)
  }

  function file(f, isStaged) {
    const key = `${isStaged ? 's' : 'u'}:${f.path}`
    const box = el('section', { className: collapsed.has(key) ? 'file collapsed' : 'file' })
    const h = el('h3')
    const name = basename(f.path)
    h.innerHTML = '<i class="icon chevron"></i><span class="name"></span><span class="dir"></span><span class="count"></span><span class="tools"></span>'
    h.children[1].textContent = f.from ? `${basename(f.from)} → ${name}` : name
    h.children[2].textContent = f.path.slice(0, -name.length).replace(/\/$/, '')
    h.children[3].innerHTML = [f.added && `<b class="add">+${f.added}</b>`, f.removed && `<b class="del">−${f.removed}</b>`].filter(Boolean).join(' ')
    const deleted = f.header.some(l => l.startsWith('deleted file mode'))
    h.children[4].append(
      ...(fixed ? [] : [el('button', { textContent: isStaged ? 'Unstage file' : 'Stage file', onclick: e => (e.stopPropagation(), wrote(stage([f.path, ...(f.from ? [f.from] : [])], !isStaged))) })]),
      ...(deleted ? [] : [el('button', { className: 'icon', title: 'Open file', innerHTML: ICON.open, onclick: e => (e.stopPropagation(), openFile(paths.fromSlashes(root, f.path))) })]),
    )
    h.onclick = () => {
      if (!collapsed.delete(key)) collapsed.add(key)
      box.classList.toggle('collapsed', collapsed.has(key))
    }
    box.append(h)
    for (const n of f.notes) box.append(el('p', { className: 'meta', textContent: n }))
    const size = f.hunks.reduce((n, h) => n + h.lines.length, 0)
    if (size > LONG && !opened.has(key)) {
      box.append(el('p', { className: 'meta', textContent: `${size.toLocaleString()} changed lines. ` }))
      box.lastChild.append(el('button', { className: 'pill', textContent: 'Show them', onclick: () => (opened.add(key), refresh(true)) }))
      return box
    }
    // Until it fills, a file holds the space its lines will take, so the scrollbar and scrollTop stay true.
    const body = el('div', { className: 'body' })
    body.style.height = `${f.hunks.reduce((n, h) => n + h.lines.length + 1.6, 0) * lineHeight()}px`
    body.fill = () => {
      const n = paint
      // Each side's lines in order, highlighted together once the language loads.
      const sides = { old: [], new: [], cells: [], name: f.path }
      body.append(...f.hunks.map(hunk => hunkEl(f, hunk, isStaged, sides)))
      body.style.height = ''
      highlight(sides, n)
    }
    near.observe(body)
    box.append(body)
    return box
  }

  function hunkEl(f, hunk, isStaged, sides) {
    const k = hunks.length
    const wrap = el('div', { className: 'hunk' })
    wrap.dataset.k = k
    const entry = { file: f, hunk, staged: isStaged, el: wrap, cells: new Map() }
    hunks.push(entry)
    const head = el('div', { className: 'hunk-head' })
    head.append(el('span', { className: 'title', textContent: hunk.title }), el('span', { className: 'tools' }))
    wrap.append(head)
    tools(entry)

    let a = hunk.oldStart
    let b = hunk.newStart
    const marks = changedRanges(hunk.lines)
    /** A line's cell: its numbers, then its text, read as part of `side` when the colors come. */
    const cell = (i, side, ...nums) => {
      const l = hunk.lines[i]
      const c = el('div', { className: `cell ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}` })
      c.dataset.i = i
      const code = el('span', { className: 'src', textContent: l.text })
      c.append(...nums.map(n => el('i', { textContent: n })), code)
      sides.cells.push({ code, side, n: sides[side].length, text: l.text, mark: marks.get(i) })
      sides[side].push(l.text)
      if (l.t !== ' ') entry.cells.set(i, [...(entry.cells.get(i) ?? []), c])
      return c
    }
    const blank = () => el('div', { className: 'cell blank' })
    const row = (...cells) => {
      const r = el('div', { className: 'ln' })
      r.append(...cells)
      wrap.append(r)
    }
    const eol = () => row(el('div', { className: 'cell eol', textContent: 'No newline at end of file' }))
    const { lines } = hunk
    for (let i = 0; i < lines.length; ) {
      const l = lines[i]
      if (l.t === '\\') {
        eol()
        i++
      } else if (!split) {
        if (l.t === ' ') {
          sides.old.push(l.text) // the old side reads context too, so its colors stay in step
          row(cell(i, 'new', a++, b++))
        } else row(l.t === '-' ? cell(i, 'old', a++, '') : cell(i, 'new', '', b++))
        i++
      } else if (l.t === ' ') {
        row(cell(i, 'old', a++), cell(i, 'new', b++))
        i++
      } else {
        // Side by side: a run of removals beside the additions that follow it.
        const dels = []
        const adds = []
        while (lines[i]?.t === '-') dels.push(i++)
        const delEol = lines[i]?.t === '\\' && dels.length ? i++ : -1
        while (lines[i]?.t === '+') adds.push(i++)
        for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
          row(j < dels.length ? cell(dels[j], 'old', a++) : blank(), j < adds.length ? cell(adds[j], 'new', b++) : blank())
        }
        if (delEol >= 0) eol()
      }
    }
    return wrap
  }

  /** The hunk's buttons, worded for what's picked in it. */
  function tools(entry) {
    const k = hunks.indexOf(entry)
    const n = picked?.k === k ? picked.set.size : 0
    const what = n ? `${n} line${n > 1 ? 's' : ''}` : 'hunk'
    const box = entry.el.querySelector('.hunk-head .tools')
    if (fixed) return
    const untracked = entry.file.header.some(l => l.startsWith('new file mode'))
    box.replaceChildren(
      el('button', { textContent: `${entry.staged ? 'Unstage' : 'Stage'} ${what}`, onclick: () => apply(k, entry.staged ? 'unstage' : 'stage') }),
      ...(entry.staged || untracked ? [] : [el('button', { className: 'danger', textContent: `Discard ${what}`, onclick: e => confirmDiscard(e, k) })]),
    )
  }

  function confirmDiscard(e, k) {
    const n = picked?.k === k ? picked.set.size : 0
    openMenu(e, [[n ? `Discard ${n} line${n > 1 ? 's' : ''} from the file` : 'Discard this hunk from the file', ICON.delete, () => apply(k, 'discard')]])
  }

  async function apply(k, kind) {
    const { file: f, hunk } = hunks[k]
    const pick = picked?.k === k && picked.set.size ? i => picked.set.has(i) : undefined
    const reverse = kind !== 'stage'
    const text = patch(f, hunk, pick, reverse)
    if (!text) return
    if ((await wrote(run(applyArgs(text, { cached: kind !== 'discard', reverse }), text))) && kind === 'discard') undo = text
    picked = null
  }

  async function putBack() {
    const text = undo
    undo = null
    await wrote(run(applyArgs(text), text))
  }

  /** Repaints once a write is done, with what git said if it failed. Resolves to whether it worked. */
  async function wrote(result) {
    const r = await result
    failed = r === true ? '' : String(r)
    await refresh(true)
    return r === true
  }

  // Picking lines: press on a changed line and drag, Shift extends, Ctrl adds or removes one.
  function setPicked(next) {
    const before = picked
    picked = next && next.set.size ? next : null
    for (const p of [before, picked]) {
      if (!p || !hunks[p.k]) continue
      const mine = picked?.k === p.k
      for (const [i, cells] of hunks[p.k].cells) for (const c of cells) c.classList.toggle('picked', mine && picked.set.has(i))
      hunks[p.k].el.classList.toggle('picking', mine)
      tools(hunks[p.k])
    }
  }
  const at = target => {
    const c = fixed ? null : target.closest?.('.cell[data-i]')
    const wrap = c?.closest('.hunk')
    if (!c || !wrap || !view.contains(wrap)) return null
    const k = +wrap.dataset.k
    const i = +c.dataset.i
    return hunks[k]?.cells.has(i) ? { k, i } : null
  }
  const range = (k, from, to) => new Set([...hunks[k].cells.keys()].filter(i => i >= Math.min(from, to) && i <= Math.max(from, to)))
  view.addEventListener('pointerdown', e => {
    const hit = e.button === 0 && at(e.target)
    if (!hit) return
    e.preventDefault() // no text selection: the drag picks lines
    view.focus({ preventScroll: true }) // so s, d, and Escape reach it
    const { k, i } = hit
    if (e.ctrlKey && picked?.k === k) {
      const set = new Set(picked.set)
      if (!set.delete(i)) set.add(i)
      return setPicked({ k, set, anchor: i })
    }
    if (e.shiftKey && picked?.k === k) return setPicked({ ...picked, set: range(k, picked.anchor, i) })
    if (picked?.k === k && picked.set.size === 1 && picked.set.has(i)) return setPicked(null)
    setPicked({ k, set: new Set([i]), anchor: i })
    const move = e => {
      const over = at(document.elementFromPoint(e.clientX, e.clientY) ?? view)
      if (over?.k === k && picked) setPicked({ ...picked, set: range(k, picked.anchor, over.i) })
    }
    const up = () => removeEventListener('pointermove', move) || removeEventListener('pointerup', up)
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  })

  // Keys: n and p move between hunks, s stages or unstages what's picked, d discards it, Escape lets go.
  view.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    if (e.key === 'n' || e.key === 'p') {
      // In the order they show, files not yet filled standing in for their hunks.
      const all = [...view.querySelectorAll('.hunk, .body:empty')]
      const top = view.getBoundingClientRect().top + 80
      const y = h => h.getBoundingClientRect().top - top
      const next = e.key === 'n' ? all.find(h => y(h) > 1) : all.findLast(h => y(h) < -1)
      if (next) view.scrollTop += next.getBoundingClientRect().top - top
    } else if (e.key === 's' && picked) apply(picked.k, hunks[picked.k].staged ? 'unstage' : 'stage')
    else if (e.key === 'd' && picked && !hunks[picked.k].staged) {
      const r = hunks[picked.k].el.querySelector('.danger')?.getBoundingClientRect()
      if (r) confirmDiscard({ clientX: r.left, clientY: r.bottom }, picked.k)
    } else if (e.key === 'Escape') setPicked(null)
    else return
    e.preventDefault()
  })

  /** Syntax colors for one file's lines, after its plain text shows. */
  async function highlight(sides, n) {
    const { tokenize } = await import('./highlight.js')
    if (n !== paint) return
    const [old, now] = [sides.old, sides.new].map(lines => tokenize(lines.join('\n'), sides.name))
    for (const c of sides.cells) {
      const tokens = (c.side === 'old' ? old : now)?.[c.n]
      if (tokens?.length || c.mark) colorize(c.code, c.text, tokens ?? [], c.mark)
    }
  }

  /** Shows another list of files, from the top. */
  function review(list) {
    only = list
    view.scrollTop = 0
    return refresh(true)
  }

  return { refresh, show, review }
}

/** Rebuilds `code` as `text` in token spans, with the changed characters `mark` set apart. */
export function colorize(code, text, tokens, mark) {
  const cuts = new Set([0, text.length, ...tokens.flatMap(([a, b]) => [a, b]), ...(mark ?? [])])
  const at = [...cuts].sort((a, b) => a - b)
  const parts = []
  for (let j = 0; j < at.length - 1; j++) {
    const [from, to] = [at[j], at[j + 1]]
    if (from === to) continue
    const token = tokens.find(([a, b]) => a <= from && to <= b)
    const marked = mark && mark[0] <= from && to <= mark[1]
    const cls = [token?.[2], marked ? 'mark' : ''].filter(Boolean).join(' ')
    parts.push(cls ? el('span', { className: cls, textContent: text.slice(from, to) }) : text.slice(from, to))
  }
  code.replaceChildren(...parts)
}
