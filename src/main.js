import '@xterm/xterm/css/xterm.css'
import './theme.css'
import './style.css'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { startTabs } from './tabs.js'
import { startFiles, quote, ICON } from './files.js'
import { startGit } from './git.js'
import { startSettings } from './settings.js'
import { bytes } from './palette.js'
import { holdBackdrops } from './backdrops.js'
import { startWallpaper } from './wallpaper.js'
import { startDashboard } from './dashboard.js'
import { opened } from './recent.js'
import { path as paths } from './paths.js'
import { $, openMenu, openPicker } from './ui.js'
import { SAFE, worktreeName, fanNames, since } from './launch.js'
import { expand, offer, saved } from './prompts.js'
import { stat as worktreeStat, keep, discard } from './keep.js'

const win = getCurrentWindow()
// For bench/linux.mjs: how far startup got, in ms since nook started.
const mark = window.NOOK_BENCH ? event => invoke('bench', { event: `mark:${event}` }) : () => {}
mark('script')
if (window.NOOK_BENCH) import('./bench.js').then(m => m.startBench())
const cwd = window.NOOK_CWD
const banner = message => Object.assign($('banner'), { hidden: false, textContent: message })
$('banner').onclick = () => { $('banner').hidden = true }
addEventListener('error', e => banner(e.message))
addEventListener('unhandledrejection', e => banner(String(e.reason)))

const { settings, error, configDir, home } = await invoke('boot')
mark('boot')

let tabs, files, wallpaper, dashboard
const backdrops = holdBackdrops([document.body, ...['pane', 'files', 'git'].map($)])
const drawer = await startSettings({
  configDir,
  settings,
  home: home || cwd,
  onRestyle: () => {
    tabs?.restyle()
    wallpaper?.restyle()
    backdrops.restyle()
    // A growing window shows its own background until the page catches up, so that takes the theme's.
    const [r, g, b] = bytes(getComputedStyle(document.documentElement).getPropertyValue('--bg'))
    getCurrentWebviewWindow().setBackgroundColor([r, g, b, 255]).catch(banner)
  },
  onClose: () => tabs.focus(),
  showFolder: () => files.go(configDir),
})

mark('settings')
wallpaper = startWallpaper($('pane'), {
  button: $('toggle-wallpaper'),
  save: id => drawer.setVariable('--wallpaper', id),
  tune: (name, value) => drawer.setVariable(name, value),
  onClose: () => tabs.focus(),
})
wallpaper.restyle()

// Drag a panel's inner edge to resize it. A double-click returns it to the theme's width.
const widths = { files: settings.filesWidth, git: settings.gitWidth }
function setWidth(panel, px) {
  widths[panel] = px
  if (px) document.body.style.setProperty(`--${panel}-width`, `${px}px`)
  else document.body.style.removeProperty(`--${panel}-width`)
}
const saveWidths = () => invoke('update_settings', { patch: { filesWidth: widths.files ?? null, gitWidth: widths.git ?? null } }).catch(banner)
for (const [panel, other, dir] of [['files', 'git', 1], ['git', 'files', -1]]) {
  setWidth(panel, widths[panel])
  const sash = $(`${panel}-sash`)
  sash.onpointerdown = e => {
    if (e.button) return
    sash.setPointerCapture(e.pointerId)
    const [x0, w0, max, was] = [e.clientX, $(panel).offsetWidth, innerWidth - $(other).offsetWidth - 320, widths[panel]]
    sash.onpointermove = e => setWidth(panel, Math.round(Math.max(160, Math.min(max, w0 + dir * (e.clientX - x0)))))
    sash.onlostpointercapture = () => {
      sash.onpointermove = null
      if (widths[panel] !== was) saveWidths()
    }
  }
  sash.ondblclick = () => { setWidth(panel, null); saveWidths() }
}

const openFile = (path, ...at) => { opened(path); tabs.openFile(path, ...at) }
const insertPath = path => tabs.paste(quote(path) + ' ')
files = startFiles({
  start: cwd,
  home,
  pinned: settings.pinned,
  newSession: dir => tabs.openClaude(dir),
  openFile,
  insertPath,
  installTheme: drawer.installTheme,
  showChanges: path => git.changes(path),
})
const git = startGit({ openView: (...args) => tabs.openView(...args), openFile, insertPath, onStatus: status => files.git(status) })
// A wallpaper can move only while a Claude session in this window is working.
const claudeWorks = () => wallpaper.working(!!tabs?.sessions().some(s => s.view?.mark === 'working'))
tabs = startTabs({
  settings,
  home,
  onSessionsOpen: list => invoke('update_settings', { patch: { sessions: list } }).catch(() => {}),
  openFolder: dir => { document.body.classList.remove('files-hidden'); files.go(dir) },
  onShow: tab => {
    files.mark(tab.viewer ? tab.path : '')
    wallpaper.show(!tab.viewer)
    claudeWorks() // as when the tab of the session that worked closes
    git.show(tab.path)
  },
  onSessions: () => {
    dashboard?.refresh()
    claudeWorks()
    claudeFiles()
  },
})
if (error) banner(`Using default settings. ${error}`)

// Ctrl+P finds a file in the active tab's repository or folder, and F1, or > in its box, runs a command. Both
// load on first use. Capture, so the keys reach nook before Claude's terminal or the editor take them.
const tabFolder = () => {
  const tab = tabs.active()
  if (!tab) return files.current() || cwd
  return ['claude', 'diff', 'review', 'search'].includes(tab.type) ? tab.path : paths.parent(tab.path) || files.current() || cwd
}

// Ctrl+Shift+F (outside a Claude tab, where it finds in Claude's output) and Ctrl+Shift+H open the search tab, which
// finds across the folder's files and replaces. One tab at a time; it loads on first use.
let searchTab = null
function findInFiles(replacing = false) {
  const text = tabs.active()?.viewer?.selection?.() ?? ''
  if (!searchTab?.viewer) {
    const dir = tabFolder()
    searchTab = tabs.openView('search', 'Search', dir, view => {
      const search = import('./replace.js').then(m => m.startReplace(view, {
        dir,
        openFile,
        unsaved: tabs.unsaved,
        refresh: tabs.refreshFiles,
      }))
      return {
        refresh: () => search.then(s => s.refresh()),
        focus: () => search.then(s => s.focus()),
        open: (text, replacing) => search.then(s => s.open(text, replacing)),
        close: () => { searchTab = null },
      }
    })
  } else tabs.show(searchTab)
  searchTab.viewer.open(text.includes('\n') ? '' : text, replacing)
}
// F12 goes to where the word at the caret is defined, Ctrl+T to any definition in the repository, and Alt+Left back
// to where F12 was pressed. They're a file tab's keys: a Claude tab's terminal keeps its own. Alt+Left is the
// editor's own move until F12 has left somewhere to go back to.
const backs = [] // { path, line, col } where each F12 was pressed, newest last
function goToDefinition() {
  const tab = tabs.active()
  const at = tab?.viewer?.caret?.()
  if (at && backs.push({ path: tab.path, ...at }) > 50) backs.shift()
  openQuick().then(q => q.define(tab?.viewer?.word?.() ?? '')).catch(banner)
}
function goBack() {
  const to = backs.pop()
  if (to) openFile(to.path, to.line, to.col)
}
addEventListener('keydown', e => {
  if (!tabs.active()?.viewer?.word || e.repeat || e.metaKey) return
  const plain = !e.ctrlKey && !e.altKey && !e.shiftKey
  const run = e.key === 'F12' && plain ? goToDefinition
    : e.key === 'ArrowLeft' && e.altKey && !e.ctrlKey && !e.shiftKey && backs.length ? goBack
    : e.code === 'KeyT' && e.ctrlKey && !e.altKey && !e.shiftKey ? () => openQuick().then(q => q.toggle('#')).catch(banner)
    : null
  if (!run) return
  e.preventDefault()
  e.stopPropagation()
  run()
}, true)

// nook's welcome: on the first run, and from the command palette after.
function welcome() {
  if ($('welcome')) return
  import('./welcome.js').then(m => m.showWelcome($('pane'), {
    themes: drawer.themes,
    wallpapers: () => $('toggle-wallpaper').click(),
    onClose: () => tabs.focus(),
  })).catch(banner)
}

let quick
const openQuick = () => {
  quick ??= Promise.all([import('./quickopen.js'), import('./commands.js')]).then(([{ startQuickOpen }, { appCommands }]) => startQuickOpen({
    dir: tabFolder,
    commands: appCommands({
      tabs, files, git, drawer, wallpaper, home, banner, insertPath,
      newSession: () => tabs.openClaude(here()),
      openQuick: prefix => openQuick().then(q => q.open(prefix)),
      quickPrompts,
      findInFiles,
      goToDefinition,
      goBack,
      canGoBack: () => backs.length > 0,
      welcome,
    }),
    gotoLine: (line, col) => tabs.active()?.viewer?.reveal?.({ line, col }),
    outline: () => tabs.active()?.viewer?.outline?.() ?? null,
    openPath: () => (tabs.active()?.viewer?.word ? tabs.active().path : null),
    openFile,
    insertPath,
    reveal: path => files.reveal(path),
    onClose: () => tabs.focus(),
  }))
  return quick
}
addEventListener('keydown', e => {
  const files = e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'p'
  const commands = e.key === 'F1' && !e.ctrlKey && !e.shiftKey
  // Ctrl+Shift+O is a file tab's; in a Claude tab, Claude gets it.
  const symbols = e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'o' && !!tabs.active()?.viewer?.outline
  if (!(files || commands || symbols) || e.altKey || e.metaKey || e.repeat) return
  e.preventDefault()
  e.stopPropagation()
  // Letters typed while the box's code loads go to the box, not to Claude.
  let typed = ''
  const hold = k => {
    if (k.key.length !== 1 || k.ctrlKey || k.altKey || k.metaKey) return
    k.preventDefault()
    k.stopPropagation()
    typed += k.key
  }
  addEventListener('keydown', hold, true)
  openQuick().then(q => q.toggle(commands ? '>' : symbols ? '@' : '', typed)).catch(banner).finally(() => removeEventListener('keydown', hold, true))
}, true)

// Files dropped from Explorer become paths in the prompt (Claude Code attaches images itself), or, dropped on a
// folder in the file browser, copies in that folder. Tauri gives the pointer in physical pixels.
getCurrentWebview().onDragDropEvent(({ payload: { type, position, paths: dropped } }) => {
  const dir = type === 'leave' || !position ? files.dropFolder(null) : files.dropFolder(position.x / devicePixelRatio, position.y / devicePixelRatio)
  if (type !== 'drop') return
  files.dropFolder(null)
  if (dir) files.receive(dropped, dir)
  else tabs.paste(dropped.map(quote).join(' ') + ' ')
})

// Titlebar
const here = () => files.current() || cwd
$('toggle-files').onclick = () => { document.body.classList.toggle('files-hidden'); tabs.focus() }
// F11, or the palette, toggles focus mode: Claude alone, in a column over the wallpaper. The pill leaves it.
const focusMode = () => { document.body.classList.toggle('focus'); tabs.focus() }
$('focus-exit').onclick = focusMode
addEventListener('keydown', e => {
  if (e.key !== 'F11' || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || e.repeat) return
  e.preventDefault()
  e.stopPropagation()
  focusMode()
}, true)
const newSession = () => tabs.openClaude(here())
// The files Claude wrote in any open session, marked in the explorer, each linked to its diff.
let touched = ''
function claudeFiles() {
  const all = [...new Set(tabs.sessions().flatMap(s => s.report.touched ?? []))]
  if (all.join('\n') === touched) return
  touched = all.join('\n')
  files.claude(all)
}
// A Claude tab's Review over its prompt: the files its last turn edited, in a tab of their changes.
addEventListener('nook-review', ({ detail: { root, files: edited } }) => {
  const tab = tabs.active()
  git.review(root || tab?.path || cwd, edited, `${tab?.name ?? 'Claude'} · last turn`)
})
dashboard = startDashboard($('pane'), {
  button: $('toggle-sessions'),
  list: () => tabs.sessions(),
  open: tab => tabs.show(tab),
  newSession,
  showChanges: path => git.changes(path),
  review: ({ tab, report }) => git.review(report.root || tab.path, report.touched ?? [], `${tab.name} · Claude's changes`),
  send: (tab, text) => tabs.prompt(tab, text),
  queue: (tab, text) => tabs.then(tab, text),
  unqueue: tab => tabs.unqueue(tab),
  answer: (tab, allow) => tabs.answer(tab, allow),
  fanOut,
  worktree: {
    stat: root => worktreeStat(runGit, root),
    keep: (tab, report) => keep(runGit, report.root).then(kept => {
      git.refresh()
      return kept
    }, e => {
      banner(`Couldn't keep ${tab.name}: ${e.message ?? e}`)
      throw e
    }),
    // Its session ends first; a process just told to quit can still hold the folder for a moment on Windows.
    discard: async (tab, report) => {
      if (!tabs.end(tab)) {
        const why = `${tab.name} is this window's last tab, so open another before discarding it`
        banner(why)
        throw new Error(why)
      }
      for (const wait of [300, 1500, 4000]) {
        await new Promise(r => setTimeout(r, wait))
        try {
          return await discard(runGit, report.root)
        } catch (e) {
          if (wait === 4000) {
            banner(`Couldn't discard ${tab.name}: ${e.message ?? e}`)
            throw e
          }
        }
      }
    },
  },
  onClose: () => tabs.focus(),
})
$('new-tab').onclick = newSession
$('new-tab').onmouseenter = () => { $('new-tab').title = `New Claude session in ${here()}` }
// The chevron by + starts Claude other ways: continuing or resuming a session saved for this folder, or in a
// git worktree of its own, so sessions working side by side don't edit the same checkout.
const launch = args => tabs.openClaude(here(), args)
$('launch').onclick = () => {
  const { left, bottom } = $('launch').getBoundingClientRect()
  const at = { clientX: left, clientY: bottom + 4 }
  openMenu(at, [
    ['New session', ICON.claude, newSession],
    ['Continue last session', ICON.play, () => launch(['--continue'])],
    ['Resume a session…', ICON.history, () => resume(at)],
    ['New session in a worktree…', ICON.worktree, () => worktree(at)],
    null,
    ['Quick prompt… (Ctrl+Shift+P)', ICON.prompt, quickPrompts],
  ])
}
async function resume(at) {
  const saved = await invoke('claude_sessions', { dir: here() }).catch(() => [])
  openPicker(at, saved.length ? 'Resume a session' : 'No saved sessions in this folder', query => {
    const q = query.toLowerCase()
    return saved
      .filter(s => !q || `${s.title ?? ''} ${s.prompt}`.toLowerCase().includes(q))
      .map(s => [`${s.title ?? s.prompt} · ${since(s.modified)}`, ICON.history, () => launch(['--resume', s.id])])
  })
}
// One prompt to several new sessions, each in a git worktree of its own, so they try it side by side without
// editing the same checkout. Each takes the prompt once its session has started; the tab in front stays.
const runGit = (dir, args, input) => invoke('git', { dir, args, input }).catch(e => { throw new Error(String(e)) })
async function fanOut(text, n) {
  const dir = here()
  if (!(await invoke('git_status', { path: dir }).catch(() => null))) return banner(`${dir} isn't in a git repository, so Claude can't start worktrees there`)
  const back = tabs.active()
  const started = []
  for (const name of fanNames(n)) started.push(await tabs.openClaude(dir, ['--worktree', name]))
  if (back) tabs.show(back)
  await Promise.all(started.map(async tab => {
    if (await tabs.ready(tab)) tabs.prompt(tab, text)
    else banner(`${tab.name} didn't start in time, so its prompt wasn't sent`)
  }))
}
function worktree(at) {
  const name = worktreeName()
  openPicker(at, `Worktree name (${name})`, query => SAFE.test(query || name)
    ? [[`Start Claude in worktree ${query || name}`, ICON.worktree, () => launch(['--worktree', query || name])]]
    : [['Letters, digits, dots, dashes and underscores only', '', () => {}]])
}
// Quick prompts: settings.json's prompts and the slash commands and skills Claude offers here, pasted into
// Claude's prompt to edit or send. Read when the picker opens, so edits to either show the next time.
async function quickPrompts() {
  const [current, commands] = await Promise.all([
    invoke('settings').catch(() => settings),
    invoke('claude_commands', { dir: here() }).catch(() => []),
  ])
  const vars = { file: tabs.lastFile(), folder: here() }
  const icons = { prompt: ICON.prompt, command: ICON.code, send: ICON.send, save: ICON.save }
  const label = r => r.kind === 'send' ? `Send to Claude: ${r.name}` : r.kind === 'save' ? `Save as a prompt: ${r.name}`
    : r.description ? `${r.name} · ${r.description}` : r.name
  const pick = r => () => {
    if (r.kind === 'save') return invoke('update_settings', { patch: { prompts: saved(current.prompts ?? [], r.text) } }).catch(banner)
    tabs.paste(expand(r.text, vars), r.kind === 'send')
  }
  openPicker({ clientX: innerWidth / 2 - 180, clientY: 48 }, 'Quick prompt, /command, or anything to send', query =>
    offer(current.prompts ?? [], commands, query).map(r => [label(r), icons[r.kind], pick(r)]))
}
addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyP') {
    e.preventDefault()
    quickPrompts()
  }
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyE') {
    e.preventDefault()
    files.focus()
  }
  if (e.ctrlKey && e.shiftKey && !e.altKey && (e.code === 'KeyH' || (e.code === 'KeyF' && !tabs.active()?.terminal))) {
    e.preventDefault()
    findInFiles(e.code === 'KeyH')
  }
})
// The file browser's git colors come from the panel's status, which isn't read while the panel is hidden.
$('toggle-git').onclick = () => {
  files.git(document.body.classList.toggle('git-hidden') ? null : git.status())
  git.refresh()
  tabs.focus()
}

$('open-config').onclick = drawer.toggle
$('min').onclick = () => win.minimize()
$('max').onclick = () => win.toggleMaximize()
$('close').onclick = () => win.close()
const syncMaximized = async () => { $('max').textContent = (await win.isMaximized()) ? '' : '' }
let resized // a dragged edge resizes the window many times a second; ask once it stops
win.onResized(() => { clearTimeout(resized); resized = setTimeout(syncMaximized, 100) })
syncMaximized()
// Typing goes to Claude: clicks in the chrome never take focus, and focus that lands on nothing
// (a closed menu, a finished path edit) returns to the open tab.
const refocus = () => { if (document.activeElement === document.body) tabs.focus() }
addEventListener('mousedown', e => {
  if (e.target.closest('#titlebar, #files, #git, .sash') && !e.target.closest('input, textarea')) e.preventDefault()
})
addEventListener('focusout', () => setTimeout(refocus))
win.onFocusChanged(({ payload: focused }) => {
  document.body.classList.toggle('blurred', !focused)
  if (focused) refocus()
})

// This is an app, not a page: no browser reload, find, print, new window, or context menu. Ctrl+N does what + does.
addEventListener('keydown', e => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.repeat && e.key.toLowerCase() === 'n') newSession()
  if (e.key === 'F5' || (e.ctrlKey && !e.altKey && /^[nrpfguoshj]$/i.test(e.key))) e.preventDefault()
})
addEventListener('contextmenu', e => e.preventDefault())

// The window's first frame paints the theme's gradients from the bitmaps the last start saved, where the look
// and sizes are the same, which is about 200 ms sooner than drawing them.
await backdrops.restore()
mark('chrome')
// The Claude sessions open when nook last closed come back, resumed, each starting as its tab first shows,
// so reopening five costs what opening one does.
const reopen = window.NOOK_REOPEN ? settings.sessions : []
if (reopen.length) {
  const opened = await Promise.all(reopen.map(s => tabs.openClaude(s.dir, [], { resume: s, later: true })))
  const first = opened[reopen.findIndex(s => s.active)] ?? opened[0]
  tabs.show(first)
  await first.started
} else await tabs.openClaude(cwd)
mark('spawned')
// First run only: the welcome loads once Claude's tab is up, so it never delays an open.
if (drawer.firstRun) welcome()
