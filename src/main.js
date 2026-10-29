import '@xterm/xterm/css/xterm.css'
import './theme.css'
import './style.css'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { startTabs } from './tabs.js'
import { startFiles, quote } from './files.js'
import { startGit } from './git.js'
import { startSettings } from './settings.js'
import { bytes } from './palette.js'
import { holdBackdrops } from './backdrops.js'
import { startWallpaper } from './wallpaper.js'
import { $ } from './ui.js'

const win = getCurrentWindow()
const cwd = window.NOOK_CWD
const banner = message => Object.assign($('banner'), { hidden: false, textContent: message })
$('banner').onclick = () => { $('banner').hidden = true }
addEventListener('error', e => banner(e.message))
addEventListener('unhandledrejection', e => banner(String(e.reason)))

const { settings, error, configDir, home } = await invoke('boot')

let tabs, files, wallpaper
const rebake = holdBackdrops([document.body, ...['pane', 'files', 'git'].map($)])
const drawer = await startSettings({
  configDir,
  settings,
  home: home || cwd,
  onRestyle: () => {
    tabs?.restyle()
    wallpaper?.restyle()
    rebake()
    // A growing window shows its own background until the page catches up, so that takes the theme's.
    const [r, g, b] = bytes(getComputedStyle(document.documentElement).getPropertyValue('--bg'))
    getCurrentWebviewWindow().setBackgroundColor([r, g, b, 255]).catch(banner)
  },
  onClose: () => tabs.focus(),
  showFolder: () => files.go(configDir),
})

wallpaper = startWallpaper($('pane'), {
  button: $('toggle-wallpaper'),
  save: id => drawer.setVariable('--wallpaper', id),
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

const openFile = path => tabs.openFile(path)
const insertPath = path => tabs.paste(quote(path) + ' ')
files = startFiles({
  start: cwd,
  home,
  pinned: settings.pinned,
  newSession: dir => tabs.openClaude(dir),
  openFile,
  insertPath,
  installTheme: drawer.installTheme,
})
const git = startGit({ openView: (...args) => tabs.openView(...args), openFile, insertPath })
tabs = startTabs({
  settings,
  onShow: tab => {
    files.mark(tab.viewer ? tab.path : '')
    wallpaper.show(!tab.viewer)
    git.show(tab.path)
  },
})
if (error) banner(`Using default settings. ${error}`)

// Files dropped from Explorer become paths in the prompt (Claude Code attaches images itself).
getCurrentWebview().onDragDropEvent(e => {
  if (e.payload.type === 'drop') tabs.paste(e.payload.paths.map(quote).join(' ') + ' ')
})

// Titlebar
const here = () => files.current() || cwd
$('toggle-files').onclick = () => { document.body.classList.toggle('files-hidden'); tabs.focus() }
const newSession = () => tabs.openClaude(here())
$('new-tab').onclick = newSession
$('new-tab').onmouseenter = () => { $('new-tab').title = `New Claude session in ${here()}` }
$('toggle-git').onclick = () => { document.body.classList.toggle('git-hidden'); git.refresh(); tabs.focus() }

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

await tabs.openClaude(cwd)
