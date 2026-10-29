// The tab strip: Claude sessions and open files. Each tab owns one view in #pane; only the active one shows.
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { startTerminal } from './terminal.js'
import { startViewer } from './viewer.js'
import { ICON, kind, same, basename } from './files.js'
import { $, el, openMenu } from './ui.js'
import { claudeWith } from './launch.js'
import { watchSessions, wanting } from './sessions.js'

const win = getCurrentWindow()
const strip = $('tabs')
const pane = $('pane')

/** `settings.command` is what each new Claude tab runs. */
export function startTabs({ settings, onShow, onSessions }) {
  const tabs = []
  let active = null
  let claude = null // the Claude tab shown last: where paths go while a file tab is showing
  let look = 0 // counts theme changes; each terminal notes the one it last took

  function add(type, name, path) {
    const head = el('div', { className: `tab ${type}`, title: path })
    head.innerHTML = `<i class="icon">${ICON[type]}</i><b class="mark"></b><span></span><button class="icon close" title="Close">&#xE711;</button>`
    const view = pane.appendChild(el('div', { className: 'view', hidden: true }))
    const tab = { el: head, view, type, name, path, label: head.querySelector('span') }
    tab.label.textContent = name
    head.onclick = e => (e.target.closest('.close') ? close(tab) : show(tab))
    head.onauxclick = e => e.button === 1 && close(tab)
    strip.append(head)
    tabs.push(tab)
    return tab
  }

  function show(tab) {
    if (active) {
      active.el.classList.remove('active')
      active.view.hidden = true
    }
    active = tab
    tab.el.classList.add('active')
    tab.view.hidden = false
    if (!tab.viewer) claude = tab
    // A hidden terminal skips theme changes, so it catches up as it shows. Its size catches up on its own.
    if (tab.look !== look) tab.terminal?.restyle()
    tab.look = look
    tab.viewer?.refresh()
    retitle()
    onShow(tab)
    focus()
    sessions.poll() // a done mark clears as its tab shows
  }

  // The window's title names the open tab, after how many sessions want the user, so the taskbar shows it.
  const retitle = () => {
    const n = wanting(tabs.map(sessions.view).filter(Boolean))
    if (active) win.setTitle(`${n ? `(${n}) ` : ''}${active.name} · nook`)
  }

  /** What a Claude tab's tooltip says: its folder, what it's doing, and the prompt it's on. */
  const describe = (tab, view, report) => {
    const doing = { working: report.activity || 'Working', waiting: 'Waiting on you', done: 'Done' }[view.mark] ?? 'Idle'
    return [tab.path, doing, report.prompt && `“${report.prompt}”`].filter(Boolean).join('\n')
  }

  const sessions = watchSessions({
    invoke,
    tabs: () => tabs,
    watched: tab => tab === active && document.hasFocus(),
    onChange: (tab, view, report) => {
      tab.el.dataset.mark = view.mark
      // A session that moved, as into the worktree `claude --worktree` makes, takes its tab's git panel along.
      if (report.root && !same(report.root, tab.path)) {
        tab.path = report.root
        tab.label.textContent = tab.label.textContent.replace(tab.name, (tab.name = basename(report.root)))
        if (tab === active) onShow(tab)
      }
      tab.el.title = describe(tab, view, report)
      if (view.attention) win.requestUserAttention(UserAttentionType.Informational).catch(() => {})
      retitle()
      onSessions?.()
    },
  })
  addEventListener('focus', () => sessions.poll())

  /** Closes `tab`, first asking whether to save a file with unsaved edits. */
  function close(tab) {
    if (!tab.viewer?.dirty?.()) return drop(tab)
    show(tab)
    const { left, bottom } = tab.el.getBoundingClientRect()
    openMenu({ clientX: left, clientY: bottom + 4 }, [
      ['Save and close', '', () => tab.viewer.save().then(saved => saved && drop(tab))],
      ['Close without saving', '', () => drop(tab)],
    ])
  }

  function drop(tab) {
    const i = tabs.indexOf(tab)
    if (i < 0) return
    tabs.splice(i, 1)
    tab.el.remove()
    tab.view.remove()
    tab.terminal?.close()
    tab.viewer?.close?.()
    if (claude === tab) claude = tabs.findLast(t => !t.viewer) ?? null
    if (!tabs.length) win.close()
    else if (active === tab) show(tabs[Math.min(i, tabs.length - 1)])
  }

  /** A Claude tab in `cwd`, its command given Claude's flags `args`, such as `['--continue']`. */
  async function openClaude(cwd, args = []) {
    const tab = add('claude', basename(cwd), cwd)
    tab.view.classList.add('claude')
    const host = tab.view.appendChild(el('div', { className: 'xterm-host' }))
    show(tab) // the terminal measures its size, so it starts visible
    tab.terminal = await startTerminal(host, {
      cwd,
      command: claudeWith(settings.command, args),
      onTitle: t => { tab.label.textContent = t ? `${tab.name} · ${t}` : tab.name },
      onExit: () => close(tab),
    })
    if (!tabs.includes(tab)) tab.terminal.close() // closed while its shell started
    else if (active === tab) focus()
  }

  /** A tab that isn't Claude's: `start(view, tab)` fills its view and returns `{ refresh }`, and
   * optionally `focus`, `close`, and a file's `dirty` and `save`. */
  function openView(type, name, path, start) {
    const open = tabs.find(t => t.type === type && same(t.path, path))
    if (open) return show(open)
    const tab = add(type, name, path)
    tab.viewer = { focus: () => tab.view.focus(), ...start(tab.view, tab) }
    show(tab)
  }

  function openFile(path) {
    const name = basename(path)
    openView(kind({ name }), name, path, (view, tab) => startViewer(view, path, {
      openFile,
      onDirty: dirty => tab.el.classList.toggle('dirty', dirty),
    }))
  }

  const focus = () => (active?.terminal ?? active?.viewer)?.focus()

  addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault()
      const n = tabs.length
      show(tabs[(tabs.indexOf(active) + (e.shiftKey ? n - 1 : 1)) % n])
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
      // Ctrl+1 to Ctrl+8 show that tab, and Ctrl+9 the last, as in a browser.
      e.preventDefault()
      const n = Number(e.code.slice(5))
      const tab = n === 9 ? tabs.at(-1) : tabs[n - 1]
      if (tab) show(tab)
    } else if (e.ctrlKey && e.key.toLowerCase() === 'w' && active?.viewer) {
      e.preventDefault() // in a Claude tab, Ctrl+W is Claude's
      close(active)
    }
  })

  // While a file has unsaved edits, closing the window asks about that file instead.
  win.onCloseRequested(e => {
    const tab = tabs.find(t => t.viewer?.dirty?.())
    if (tab) {
      e.preventDefault()
      close(tab)
    }
  })

  // An open file follows edits on disk, Claude's included.
  setInterval(() => document.hidden || active?.viewer?.refresh(), 2000)

  return {
    openClaude,
    openFile,
    show,
    /** Every Claude tab with its session's view and newest report, in strip order. */
    sessions: () => tabs.filter(t => t.terminal).map(tab => ({ tab, view: sessions.view(tab), report: sessions.report(tab) ?? {} })),
    openView,
    focus,
    restyle() {
      look++
      active?.terminal?.restyle()
      if (active) active.look = look
    },
    paste(text) {
      if (!claude?.terminal) return
      show(claude)
      claude.terminal.paste(text)
    },
  }
}
