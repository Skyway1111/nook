// A history tab: a repository's commits as a graph, newest first, read a page at a time as the list nears its
// end. Only the rows on screen exist. The commit picked shows its message and changes beside the list, drawn
// by diff.js; its menu checks it out, branches from it, cherry-picks or reverts it.
import { invoke } from './host.js'
import { el, flag, openMenu, openPicker, sheet } from './ui.js'
import { ICON } from './files.js'
import { LOG_FORMAT, parseLog, layout } from './graph.js'
import { startDiff } from './diff.js'

await sheet(new URL('./history.css', import.meta.url))

// Commits read at a time: a first page that shows at once, then larger ones. Without a commit-graph file git
// reads every commit to sort them, children before parents, for each page; with one it reads only those shown.
const FIRST = 400
const PAGE = 3000
const ROW = 28 // px per commit
const LANE = 14 // px per lane of the graph
const LANES = 14 // lanes drawn; a repository with more branches than this clips the rest
const COLORS = ['blue', 'magenta', 'green', 'yellow', 'cyan', 'red'].map(c => `var(--ansi-${c})`)
const [allKept, keepAll] = flag('nook.history.all', true)

const SVG = 'http://www.w3.org/2000/svg'
const svg = (tag, attrs) => {
  const node = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}
const x = lane => LANE / 2 + 2 + lane * LANE
const color = lane => COLORS[lane % COLORS.length]

/** "5m", "3h", "2d", "Oct 12", or "Dec 2024": short enough for a column. */
function ago(seconds) {
  const s = Date.now() / 1000 - seconds
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  const d = new Date(seconds * 1000)
  const thisYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' })
}
const when = seconds => new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** A circle with someone's initials, in a hue their email picks. */
function avatar(name, email) {
  let h = 0
  for (const ch of email || name) h = (h * 31 + ch.charCodeAt(0)) % 360
  const initials = name.split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase()
  return el('b', { className: 'avatar', textContent: initials || '?', style: `--hue: ${h}` })
}

function chips(refs) {
  return refs.map(r => el('span', { className: `ref ${r.kind}`, textContent: r.name, title: r.kind === 'remote' ? `Remote branch ${r.name}` : r.kind === 'tag' ? `Tag ${r.name}` : r.name }))
}

/**
 * Fills `view` with the history of `rel` ('' for all of it) in the repository at `root`. `run(args)` runs a git
 * command after any the git panel has queued and resolves to true, or to what git said went wrong.
 */
export function startHistory(view, { root, rel, openFile, run }) {
  view.classList.add('history')
  let all = allKept()
  let query = ''
  let commits = []
  let lanes // the graph's state below the last page laid out
  let more = true // git may have older commits than those read
  let loading = null
  let error = ''
  let picked = -1
  let width = 1 // lanes the graph is drawn for
  let refs = '' // the branch, tag, and HEAD positions last read, so a poll that finds them moved reloads
  let generation = 0 // counts reloads, so a page read for an old one is dropped
  const made = new Map() // row index → its element, while near the screen

  const search = el('input', { className: 'search', placeholder: rel ? `Search the history of ${rel}` : 'Search messages, or @author', spellcheck: false })
  const scope = el('span', { className: 'seg' })
  const count = el('span', { className: 'count' })
  const failed = el('span', { className: 'error', title: 'Dismiss', onclick: () => say('') })
  const bar = el('header', { className: 'history-bar' })
  bar.append(search, failed, count, scope)
  const list = el('div', { className: 'commits', tabIndex: 0 })
  const space = el('div', { className: 'space' })
  const rows = el('div', { className: 'rows' })
  space.append(rows)
  list.append(space)
  const details = el('div', { className: 'view details' })
  const box = el('div', { className: 'history-box' })
  box.append(bar, list, details)
  view.replaceChildren(box)
  const diff = startDiff(details, { root, rel: '', openFile, commit: null })

  const say = text => Object.assign(failed, { textContent: text, hidden: !text })
  say('')

  function paintScope() {
    scope.replaceChildren(...[['This branch', false], ['All branches', true]].map(([label, on]) =>
      el('button', { textContent: label, className: all === on ? 'on' : '', onclick: () => { all = on; keepAll(on); paintScope(); reload() } })))
  }
  paintScope()

  function args() {
    const filter = query.startsWith('@') ? [`--author=${query.slice(1)}`] : query ? [`--grep=${query}`] : []
    return [
      '-c', 'log.showSignature=false', 'log', '--no-color', `--format=${LOG_FORMAT}`, '--decorate=full', '--parents', '--date-order',
      '--regexp-ignore-case', '--fixed-strings', ...filter, `-n${commits.length ? PAGE : FIRST}`, `--skip=${commits.length}`,
      ...(all ? ['--branches', '--remotes', '--tags', 'HEAD'] : ['HEAD']), '--', ...(rel ? [rel] : []),
    ]
  }

  function load() {
    if (loading || !more) return loading
    const n = generation
    const size = commits.length ? PAGE : FIRST
    loading = invoke('git', { dir: root, args: args() })
      .then(text => {
        if (n !== generation) return
        const page = parseLog(text)
        more = page.length === size
        // A search's matches aren't joined by their parents, so they get dots without lines.
        if (query) for (const c of page) Object.assign(c, { col: 0, edges: [], width: 1 })
        else lanes = layout(page, lanes)
        commits.push(...page)
        width = Math.min(LANES, Math.max(width, ...page.map(c => c.width)))
        list.style.setProperty('--graph', `${width * LANE + 4}px`)
      })
      .catch(e => {
        if (n !== generation) return
        more = false
        const text = String(e)
        if (!commits.length) error = /does not have any commits|bad default revision|unknown revision/.test(text) ? 'No commits yet' : text
      })
      .finally(() => {
        if (n !== generation) return
        loading = null
        space.style.height = `${commits.length * ROW}px`
        count.textContent = commits.length ? `${commits.length.toLocaleString()}${more ? '+' : ''} commit${commits.length === 1 ? '' : 's'}` : ''
        draw(true)
      })
    return loading
  }

  /** Reads the history again from the top, keeping the commit picked if it's still there. */
  async function reload() {
    const keep = commits[picked]?.oid
    generation++
    commits = []
    lanes = undefined
    more = true
    loading = null
    error = ''
    width = 1
    made.clear()
    picked = -1
    await load()
    const i = keep ? commits.findIndex(c => c.oid === keep) : -1
    pick(i >= 0 ? i : commits.length ? 0 : -1, { scroll: i >= 0 })
    if (i < 0) list.scrollTop = 0
  }

  // Only the rows near the screen exist; scrolling swaps them, and reads the next page as the end nears.
  let queued = false
  function draw(force) {
    if (queued && !force) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      const top = list.scrollTop
      const from = Math.max(0, Math.floor(top / ROW) - 12)
      const to = Math.min(commits.length, Math.ceil((top + list.clientHeight) / ROW) + 12)
      for (const i of made.keys()) if (i < from || i >= to) made.delete(i)
      const shown = []
      for (let i = from; i < to; i++) {
        if (!made.has(i)) made.set(i, row(i))
        shown.push(made.get(i))
      }
      if (!commits.length) shown.push(el('p', { className: 'none', textContent: error || (loading ? '' : query ? 'No commits match' : 'No commits') }))
      rows.replaceChildren(...shown)
      rows.style.transform = `translateY(${from * ROW}px)`
      if (to > commits.length - 60) load()
    })
  }
  list.addEventListener('scroll', () => draw())

  function row(i) {
    const c = commits[i]
    const r = el('div', { className: i === picked ? 'commit on' : 'commit' })
    r.dataset.i = i
    const g = svg('svg', { class: 'graph', height: ROW })
    for (const [x1, y1, x2, y2, lane] of c.edges) {
      if (Math.min(x1, x2) >= LANES) continue
      const [a, b] = [(y1 * ROW) / 2, (y2 * ROW) / 2]
      const d = x1 === x2 ? `M${x(x1)} ${a}V${b}` : `M${x(x1)} ${a}C${x(x1)} ${(a + b) / 2} ${x(x2)} ${(a + b) / 2} ${x(x2)} ${b}`
      g.append(svg('path', { d, stroke: color(lane) }))
    }
    if (c.col < LANES) {
      const head = c.refs.some(r => r.kind === 'head' || r.kind === 'detached')
      g.append(svg('circle', { cx: x(c.col), cy: ROW / 2, r: head ? 4.5 : 3.5, fill: head ? 'var(--bg)' : color(c.col), stroke: color(c.col), 'stroke-width': head ? 2.5 : 0 }))
    }
    const subject = el('span', { className: 'subject' })
    subject.append(...chips(c.refs), el('span', { textContent: c.subject }))
    r.append(
      g,
      subject,
      el('span', { className: 'author', textContent: c.author, title: c.email }),
      el('span', { className: 'time', textContent: ago(c.time), title: when(c.time) }),
      el('span', { className: 'hash', textContent: c.oid.slice(0, 7) }),
    )
    return r
  }

  // The commit picked: its message and who wrote it, then its changes.
  let showing = 0
  function pick(i, { scroll = true, wait = 0 } = {}) {
    made.get(picked)?.classList.remove('on')
    picked = i
    made.get(i)?.classList.add('on')
    if (scroll && i >= 0) {
      const y = i * ROW
      if (y < list.scrollTop) list.scrollTop = y
      else if (y + ROW > list.scrollTop + list.clientHeight) list.scrollTop = y + ROW - list.clientHeight
    }
    const n = ++showing
    // Held down, the arrow keys pass over commits faster than their changes could be read.
    setTimeout(() => n === showing && describe(commits[i]), wait)
  }

  function describe(c) {
    if (!c) return diff.show(null)
    const head = el('header', { className: 'commit-head' })
    const body = el('p', { className: 'body' })
    const who = el('div', { className: 'who' })
    who.append(avatar(c.author, c.email), el('span', { className: 'name', textContent: c.author, title: c.email }), el('span', { textContent: when(c.time) }))
    const ids = el('div', { className: 'ids' })
    const copy = el('button', { className: 'hash', textContent: c.oid.slice(0, 10), title: 'Copy the full hash', onclick: () => {
      navigator.clipboard.writeText(c.oid)
      copy.textContent = 'Copied'
      setTimeout(() => (copy.textContent = c.oid.slice(0, 10)), 1200)
    } })
    ids.append(copy)
    if (c.parents.length) {
      ids.append(el('span', { textContent: c.parents.length > 1 ? 'Merge of' : 'Parent' }))
      for (const p of c.parents) ids.append(el('button', { className: 'hash', textContent: p.slice(0, 7), title: 'Show this commit', onclick: () => goTo(p) }))
    }
    ids.append(...chips(c.refs))
    head.append(el('h1', { textContent: c.subject }), body, who, ids)
    // The full message, and who committed it when someone else did.
    invoke('git', { dir: root, args: ['-c', 'log.showSignature=false', 'show', '-s', '--format=%b%x1f%cn%x1f%ct', c.oid] }).then(text => {
      const [message, committer, time] = text.replace(/\n$/, '').split('\x1f')
      body.textContent = message.trim()
      if (committer && committer !== c.author) who.append(el('span', { textContent: `committed by ${committer}`, title: when(+time) }))
    }, () => {})
    diff.show({ oid: c.oid, intro: [head] })
  }

  /** Picks a commit by its hash, reading older pages until it shows up. */
  async function goTo(oid) {
    await poll() // the first page, if it's still being read
    let i
    while ((i = commits.findIndex(c => c.oid === oid)) < 0 && more) await load()
    if (i >= 0) pick(i)
  }

  list.addEventListener('pointerdown', e => {
    const r = e.target.closest('.commit')
    if (!r || e.button > 0) return
    pick(+r.dataset.i)
    list.focus({ preventScroll: true })
  })
  list.addEventListener('contextmenu', e => {
    const r = e.target.closest('.commit')
    if (!r) return
    e.preventDefault()
    pick(+r.dataset.i)
    menu(e, commits[+r.dataset.i])
  })
  list.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const page = Math.max(1, Math.floor(list.clientHeight / ROW) - 1)
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1, PageDown: page, PageUp: -page, Home: -Infinity, End: Infinity }[e.key]
    if (step === undefined || !commits.length) return
    e.preventDefault()
    pick(Math.max(0, Math.min(commits.length - 1, picked + step)), { wait: 90 })
  })

  let typing = 0
  search.addEventListener('input', () => {
    clearTimeout(typing)
    typing = setTimeout(() => {
      query = search.value.trim()
      reload()
    }, 250)
  })
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape' && search.value) (search.value = ''), search.dispatchEvent(new Event('input'))
    else if (e.key === 'ArrowDown' || e.key === 'Enter') (e.preventDefault(), list.focus())
  })

  function menu(e, c) {
    const short = c.oid.slice(0, 7)
    const local = c.refs.filter(r => r.kind === 'branch' || r.kind === 'head')
    const act = args => run(args).then(r => (r === true ? say('') : say(r), poll()))
    openMenu(e, [
      ['Copy hash', ICON.copy, () => navigator.clipboard.writeText(c.oid)],
      ['Copy message', ICON.copy, () => navigator.clipboard.writeText(c.subject)],
      null,
      ...local.filter(r => r.kind !== 'head').map(r => [`Switch to ${r.name}`, ICON.history, () => act(['switch', r.name])]),
      ...(local.some(r => r.kind === 'head') ? [] : [[`Check out ${short} (detached)`, ICON.history, () => act(['switch', '--detach', c.oid])]]),
      ['Create branch here…', ICON.add, () => openPicker(e, `New branch at ${short}`, name =>
        name ? [[`Create and switch to ${name}`, ICON.add, () => act(['switch', '-c', name, c.oid])]] : [])],
      null,
      ['Cherry-pick onto the current branch', ICON.paste, () => act(['cherry-pick', ...(c.parents.length > 1 ? ['-m', '1'] : []), c.oid])],
      ['Revert in a new commit', '\uE7A7', () => act(['revert', '--no-edit', ...(c.parents.length > 1 ? ['-m', '1'] : []), c.oid])],
    ])
  }

  /** Reloads when a branch, tag, or HEAD moved: a commit, a pull, a switch, here or in a terminal. */
  let checking = null
  const poll = () => (checking ??= check().finally(() => (checking = null)))
  async function check() {
    const now = await Promise.all([
      invoke('git', { dir: root, args: ['for-each-ref', '--format=%(HEAD)%(objectname) %(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'] }),
      invoke('git', { dir: root, args: ['rev-parse', '-q', '--verify', 'HEAD'] }).catch(() => ''),
    ]).then(r => r.join('\n'), () => refs)
    if (now === refs) return
    refs = now
    return reload()
  }

  return { refresh: poll, goTo }
}
