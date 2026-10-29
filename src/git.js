// The git panel: the active tab's repository, its changes, branch, and commit box. Every action
// is a git command run by git.rs, so hooks and credential helpers behave as in a terminal. diff.js
// draws the diff tabs it opens, history.js the history tabs, and merge.js a conflicted file's tab.
import { invoke } from '@tauri-apps/api/core'
import { $, el, openMenu, openPicker, dragPath } from './ui.js'
import { ICON, basename } from './files.js'
import { path as paths } from './paths.js'

const panel = $('git')
const list = $('git-list')
const message = $('git-message')
const commitButton = $('git-commit')
const syncButton = $('git-sync')

const STATUS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', U: 'conflict', '?': 'added' }
const VERB = { A: 'Create', '?': 'Create', D: 'Delete', R: 'Rename' }
const GROUPS = [
  ['Conflicts', c => c.kind === 'U'],
  ['Tracked', c => c.kind !== 'U' && c.kind !== '?'],
  ['Untracked', c => c.kind === '?'],
]
const SYNC = {
  fetch: ['Fetch', 'Fetching', ''],
  pull: ['Pull', 'Pulling', ''],
  push: ['Push', 'Pushing', ''],
  publish: ['Publish', 'Publishing', ''],
}
// Paths go over stdin, NUL-separated: no command-line limit, and no file name read as a flag.
const PATHSPEC = ['--pathspec-from-file=-', '--pathspec-file-nul']
/** What git is in the middle of: how the panel says it, and the commands that finish it or call it off. */
const OPERATION = {
  merge: ['Merging', ['commit', '--no-edit'], ['merge', '--abort']],
  rebase: ['Rebasing', ['rebase', '--continue'], ['rebase', '--abort']],
  'cherry-pick': ['Cherry-picking', ['cherry-pick', '--continue'], ['cherry-pick', '--abort']],
  revert: ['Reverting', ['revert', '--continue'], ['revert', '--abort']],
  am: ['Applying patches', ['am', '--continue'], ['am', '--abort']],
}
/** The last segment of a git path; an untracked folder keeps its trailing slash. */
const leaf = rel => rel.slice(rel.lastIndexOf('/', rel.length - 2) + 1)
/** A git path as a path under `root`. */
const abs = (root, rel) => paths.fromSlashes(root, rel)
/** A path under `root` as a git path. */
const relative = (root, path) => path.slice(root.length).replace(/^[\\/]/, '').replaceAll(paths.SEP, '/')

export function startGit({ openView, openFile, insertPath }) {
  let want = null // the active tab's path
  let s = null // the repository on screen, or null outside one
  let shown = '' // its status as JSON, so a poll that finds nothing new touches nothing
  const cache = new Map() // tab path → its last status, painted at once when the tab comes back
  const drafts = new Map() // root → its unsent commit message
  const collapsed = new Set()
  const rows = new Map() // path → its row, for instant checkbox feedback
  let syncing = null // { root, label } while a fetch, pull, or push runs
  let committing = false
  let commitAll = false // nothing staged: commit every tracked change
  let suggestion = '' // the message a one-file commit gets when none is typed

  const say = text => Object.assign($('git-error'), { textContent: text, hidden: !text })
  $('git-error').onclick = () => say('')
  function setDraft(root, text) {
    drafts.set(root, text)
    if (s?.root === root) message.value = text
  }

  // One status call at a time; the tab showing when it returns is the one painted.
  let loading = false
  let again = false
  async function refresh() {
    if (loading) return void (again = true)
    loading = true
    try {
      do {
        again = false
        const path = want
        if (path === null || document.body.classList.contains('git-hidden')) break
        const status = await invoke('git_status', { path }).catch(e => ({ error: String(e) }))
        cache.set(path, status)
        if (path === want) paint(status)
      } while (again)
    } finally {
      loading = false
    }
  }

  function paint(status) {
    const json = JSON.stringify(status)
    if (json === shown) return
    shown = json
    if (status?.root !== s?.root) {
      say('')
      message.value = drafts.get(status?.root) ?? ''
    }
    s = status?.root ? status : null
    panel.classList.toggle('none', !s)
    if (s) render()
    else $('git-none').textContent = status?.error ?? 'Not in a git repository'
  }

  function render() {
    const { changes } = s
    const n = changes.length
    $('git-repo').textContent = basename(s.root) + (n ? ` · ${n} change${n > 1 ? 's' : ''}` : '')
    $('git-repo').title = s.root
    const added = changes.reduce((sum, c) => sum + c.added, 0)
    const removed = changes.reduce((sum, c) => sum + c.removed, 0)
    $('git-diff').disabled = !n
    $('git-diff').lastChild.innerHTML = added || removed ? `<b class="add">+${added}</b> <b class="del">−${removed}</b>` : ''
    Object.assign($('git-stage-all'), { hidden: !n, textContent: changes.some(c => c.staged !== 'on') ? 'Stage all' : 'Unstage all' })

    rows.clear()
    const items = GROUPS.flatMap(([name, test]) => {
      const group = changes.filter(test)
      if (!group.length) return []
      return [header(name, group), ...(collapsed.has(name) ? [] : group.map(row))]
    })
    if (!items.length) items.push(el('li', { className: 'empty', textContent: 'No changes' }))
    list.replaceChildren(...items)

    const op = OPERATION[s.operation]
    const conflicts = changes.filter(c => c.kind === 'U').length
    $('git-op').hidden = !op
    if (op) {
      $('git-op-text').textContent = conflicts ? `${op[0]} \u00b7 ${conflicts} conflict${conflicts > 1 ? 's' : ''}` : `${op[0]} \u00b7 ready to continue`
      Object.assign($('git-continue'), { disabled: conflicts > 0, title: conflicts ? 'Settle the conflicts first' : `git ${op[1].join(' ')}` })
      $('git-abort').title = `git ${op[2].join(' ')}: back to where you started`
    }

    $('git-branch-name').textContent = s.branch ?? `detached at ${s.oid?.slice(0, 7)}`
    const next = nextSync()
    $('git-sync-group').hidden = !next
    if (next) {
      const [kind, count] = next
      const [label, , glyph] = SYNC[kind]
      const busy = syncing?.root === s.root
      syncButton.firstChild.textContent = glyph
      syncButton.lastChild.textContent = busy ? `${syncing.label}…` : count ? `${label} ${count}` : label
      syncButton.disabled = $('git-sync-more').disabled = busy
    }

    const staged = changes.filter(c => c.staged !== 'off')
    const target = staged.length ? staged : changes.filter(c => c.kind !== '?' && c.kind !== 'U')
    commitAll = !staged.length
    suggestion = !op && target.length === 1 ? `${VERB[target[0].kind] ?? 'Update'} ${leaf(target[0].path)}` : ''
    message.placeholder = op ? (s.operation === 'merge' ? 'Merge commit message' : `${op[0]}: Continue finishes it`) : suggestion || 'Commit message'
    commitButton.textContent = commitAll && target.length ? 'Commit tracked' : 'Commit'
    // Mid-merge a commit with your own message finishes it; mid-rebase and the like, only Continue does.
    commitButton.disabled = !target.length || committing || (op && (conflicts > 0 || s.operation !== 'merge'))

    $('git-last').hidden = !s.oid
    $('git-subject').textContent = $('git-subject').title = s.subject
    $('git-undo').hidden = !!s.upstream && !s.ahead // pushed: undoing it would rewrite shared history
  }

  function header(name, group) {
    const li = el('li', { className: collapsed.has(name) ? 'group collapsed' : 'group' })
    li.dataset.group = name
    const states = new Set(group.map(c => c.staged))
    li.innerHTML = `<i class="icon chevron"></i><span></span><i class="check" data-state="${states.size > 1 ? 'mixed' : [...states][0]}"></i>`
    li.children[1].textContent = name
    return li
  }

  function row(c) {
    const li = el('li', { className: 'change', title: c.from ? `${c.from} → ${c.path}` : c.path })
    li.dataset.path = c.path
    li.innerHTML = `<i class="st ${STATUS[c.kind]}"></i><span class="name"></span><span class="dir"></span><span class="count"></span><i class="check" data-state="${c.staged}"></i>`
    const name = leaf(c.path)
    li.children[1].textContent = name
    li.children[2].textContent = c.path.slice(0, -name.length).replace(/\/$/, '')
    if (c.added || c.removed) li.children[3].innerHTML = `<b class="add">+${c.added}</b> <b class="del">−${c.removed}</b>`
    rows.set(c.path, li)
    return li
  }

  // Writes run one at a time: two at once collide on the index lock.
  let queue = Promise.resolve()
  let said = '' // what the last write that failed said
  /** Runs a write in `dir`, the panel's repository unless given. Resolves to whether it worked. */
  function act(args, input, dir = s.root) {
    const done = queue
      .then(() => invoke('git', { dir, args, input }))
      .then(() => (say(''), true), e => (say((said = String(e))), false))
    queue = done
    done.then(refresh)
    return done
  }

  function stage(items, on) {
    items = items.filter(c => c.staged !== (on ? 'on' : 'off'))
    if (!items.length) return
    for (const c of items) {
      const box = rows.get(c.path)?.querySelector('.check')
      if (box) box.dataset.state = on ? 'on' : 'off'
    }
    const paths = items.flatMap(c => (c.from ? [c.path, c.from] : [c.path]))
    const args = on ? ['add', '-A'] : s.oid ? ['restore', '--staged'] : ['rm', '--cached', '-r', '-q']
    act([...args, ...PATHSPEC], paths.join('\0'))
  }

  /** A diff tab of what changed under `rel` in the repository `status` describes; '' is all of it. */
  function openDiff(status, rel) {
    const { root } = status
    const path = rel ? abs(root, rel) : root
    // A diff tab's writes go through the same queue, in its own repository. It shows what a failure said.
    const run = (args, input) => act(args, input, root).then(ok => ok || said)
    const stage = (paths, on) => {
      const args = on ? ['add', '-A'] : status.oid ? ['restore', '--staged'] : ['rm', '--cached', '-r', '-q']
      return run([...args, ...PATHSPEC], paths.join('\0'))
    }
    openView('diff', rel ? leaf(rel) : `${basename(root)} changes`, path, view => {
      // Loaded on first use, so it costs nothing at startup.
      const diff = import('./diff.js').then(m => m.startDiff(view, { root, rel, openFile, run, stage }))
      return { refresh: () => diff.then(d => d.refresh()) }
    })
  }

  /** A conflicted file's tab, to settle its conflicts and mark it resolved. */
  function openMerge(status, rel) {
    const { root } = status
    const path = abs(root, rel)
    const run = args => act(args, undefined, root).then(ok => ok || said)
    openView('merge', leaf(rel), path, view => {
      const merge = import('./merge.js').then(m => m.startMerge(view, { root, path, rel, name: leaf(rel), run, openFile }))
      return { refresh: () => merge.then(m => m.refresh()) }
    })
  }

  /** A history tab of `rel` in the repository `status` describes ('' is all of it), at the commit `oid` if given. */
  function openHistory(status, rel, oid) {
    const { root } = status
    const run = args => act(args, undefined, root).then(ok => ok || said)
    const tab = openView('history', rel ? `${leaf(rel)} history` : `${basename(root)} history`, rel ? abs(root, rel) : root, view => {
      const history = import('./history.js').then(m => m.startHistory(view, { root, rel, openFile, run }))
      return { refresh: () => history.then(h => h.refresh()), goTo: oid => history.then(h => h.goTo(oid)) }
    })
    if (oid) tab.viewer.goTo(oid)
  }
  // A click in a file's blame: its history, at that commit.
  addEventListener('nook-history', async ({ detail: { path, oid } }) => {
    const status = await invoke('git_status', { path }).catch(() => null)
    if (status?.root && paths.within(path, status.root)) openHistory(status, relative(status.root, path), oid)
  })

  list.addEventListener('click', e => {
    const li = e.target.closest('li')
    if (!s || !li || li.classList.contains('empty')) return
    const { group, path } = li.dataset
    const test = group ? GROUPS.find(([name]) => name === group)[1] : c => c.path === path
    const box = e.target.closest('.check')
    if (box) {
      const on = box.dataset.state !== 'on'
      box.dataset.state = on ? 'on' : 'off'
      stage(s.changes.filter(test), on)
    } else if (group) {
      if (!collapsed.delete(group)) collapsed.add(group)
      render()
    } else if (s.changes.find(c => c.path === path)?.kind === 'U') openMerge(s, path)
    else openDiff(s, path)
  })
  list.addEventListener('contextmenu', e => {
    const li = e.target.closest('li.change')
    if (!li) return
    const c = s.changes.find(c => c.path === li.dataset.path)
    const path = abs(s.root, c.path)
    const openable = c.kind !== 'D' && !c.path.endsWith('/')
    openMenu(e, [
      ...(openable ? [['Open file', ICON.open, () => openFile(path)]] : []),
      ['Add to prompt', ICON.add, () => insertPath(path)],
      ...(c.kind === '?' || c.kind === 'A' ? [] : [['File history', ICON.history, () => openHistory(s, c.from ?? c.path)]]),
    ])
  })
  list.addEventListener('pointerdown', e => {
    const li = e.target.closest('li.change')
    if (!li || e.button !== 0 || e.target.closest('.check')) return
    const path = abs(s.root, li.dataset.path)
    dragPath(e, path, target => target?.closest('#pane') && insertPath(path))
  })
  $('git-diff').onclick = () => openDiff(s, '')
  $('git-subject').onclick = $('git-history').onclick = () => openHistory(s, '')
  $('git-continue').onclick = () => act(OPERATION[s.operation][1])
  $('git-abort').onclick = e =>
    openMenu(e, [[`Abort and undo the ${s.operation === 'am' ? 'patches' : s.operation}`, ICON.delete, () => act(OPERATION[s.operation][2])]])
  $('git-stage-all').onclick = () => stage(s.changes, s.changes.some(c => c.staged !== 'on'))

  $('git-branch').onclick = async e => {
    const { branch } = s
    const refs = await invoke('git', {
      dir: s.root,
      args: ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes'],
    }).catch(e => (say(String(e)), ''))
    const names = refs.split('\n').filter(r => r && !r.endsWith('/HEAD'))
    const local = names.filter(r => r.startsWith('refs/heads/')).map(r => r.slice('refs/heads/'.length))
    const remote = names
      .filter(r => r.startsWith('refs/remotes/'))
      .map(r => r.slice('refs/remotes/'.length))
      .filter(r => !local.includes(r.slice(r.indexOf('/') + 1)))
    openPicker(e, 'Switch or create a branch', query => {
      const match = name => name.toLowerCase().includes(query.toLowerCase())
      return [
        ...local.filter(match).map(b => [b, b === branch ? '' : '', () => b !== branch && act(['switch', b])]),
        ...remote.filter(match).map(b => [b, '', () => act(['switch', '--track', b])]),
        ...(query && !local.includes(query) ? [[`Create branch ${query}`, ICON.add, () => act(['switch', '-c', query])]] : []),
      ]
    })
  }

  /** The sync this branch needs most, and how many commits it moves. */
  function nextSync() {
    if (!s.remote) return null
    if (!s.upstream) return s.branch ? ['publish', 0] : null
    if (s.behind) return ['pull', s.behind]
    if (s.ahead) return ['push', s.ahead]
    return ['fetch', 0]
  }
  async function sync(kind) {
    const root = s.root
    syncing = { root, label: SYNC[kind][1] }
    render()
    await act(kind === 'publish' ? ['push', '-u', s.remote, 'HEAD'] : [kind])
    syncing = null
    if (s) render()
  }
  syncButton.onclick = () => sync(nextSync()[0])
  $('git-sync-more').onclick = e => {
    const kinds = s.upstream ? ['fetch', 'pull', 'push'] : ['fetch', 'publish']
    openMenu(e, kinds.map(kind => [SYNC[kind][0], SYNC[kind][2], () => sync(kind)]))
  }

  async function commit() {
    const text = message.value.trim() || suggestion
    if (!text) return message.focus()
    const { root } = s
    committing = true
    render()
    const ok = await act(['commit', ...(commitAll ? ['-a'] : []), '-F', '-'], text)
    committing = false
    if (ok) setDraft(root, '')
    if (s) render()
  }
  commitButton.onclick = commit
  message.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') message.blur() // back to Claude
  })
  message.addEventListener('input', () => s && drafts.set(s.root, message.value))

  // Undo keeps the changes staged and puts the message back for another try.
  $('git-undo').onclick = async () => {
    const { root } = s
    const body = await invoke('git', { dir: root, args: ['log', '-1', '--format=%B'] }).catch(() => '')
    if (await act(['reset', '--soft', 'HEAD~1'])) setDraft(root, body.trim())
  }

  // Claude edits files and runs git meanwhile; so can anything else.
  setInterval(() => document.hidden || refresh(), 2000)
  addEventListener('focus', refresh)

  return {
    /** Opens a diff tab of one file's changes, in whichever repository holds it, or the file outside one. */
    async changes(path) {
      const status = await invoke('git_status', { path }).catch(() => null)
      if (!status?.root || !paths.within(path, status.root)) return openFile(path)
      openDiff(status, relative(status.root, path))
    },
    /** Follows the tab now showing: a Claude tab's folder, or an open file. */
    show(path) {
      want = path
      if (cache.has(path)) paint(cache.get(path))
      refresh()
    },
    refresh,
  }
}
