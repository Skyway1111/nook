// The tab strip: Claude sessions and open files. Each tab owns one view in #pane; only the active one shows.
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { startTerminal } from './terminal.js'
import { startViewer } from './viewer.js'
import { ICON, kind, same, basename } from './files.js'
import { $, el, openMenu } from './ui.js'
import { claudeWith } from './launch.js'
import { watchSessions, wanting, notice, ANSWERS } from './sessions.js'

const win = getCurrentWindow()
const strip = $('tabs')
const pane = $('pane')
// The split's divider: drag it to share the pane, double-click to halve it again.
const sash = pane.appendChild(el('div', { className: 'split-sash', hidden: true }))
sash.onpointerdown = e => {
  if (e.button) return
  sash.setPointerCapture(e.pointerId)
  const { left, width } = pane.getBoundingClientRect()
  sash.onpointermove = e => pane.style.setProperty('--split', `${Math.max(20, Math.min(80, ((e.clientX - left) / width) * 100))}%`)
  sash.onlostpointercapture = () => { sash.onpointermove = null }
}
sash.ondblclick = () => pane.style.removeProperty('--split')

/** `settings.command` is what each new Claude tab runs. */
export function startTabs({ settings, home, onShow, onSessions, onSessionsOpen, openFolder }) {
  const tabs = []
  let active = null
  let claude = null // the Claude tab shown last: where paths go while a file tab is showing
  let file = null // the file tab shown last: what a quick prompt's {file} names
  let look = 0 // counts theme changes; each terminal notes the one it last took
  let beside = null // the tab in the pane's other half while it's split; `active` has the focused half
  let last = null // the tab shown before the active one: what Ctrl+\\ splits with

  function add(type, name, path) {
    const head = el('div', { className: `tab ${type}`, title: path })
    head.innerHTML = `<i class="icon">${ICON[type]}</i><b class="mark"></b><span></span><button class="icon close" title="Close">&#xE711;</button>`
    const view = pane.appendChild(el('div', { className: 'view', hidden: true }))
    const tab = { el: head, view, type, name, path, label: head.querySelector('span') }
    tab.label.textContent = name
    head.onclick = e => (e.target.closest('.close') ? close(tab) : show(tab))
    head.onauxclick = e => e.button === 1 && close(tab)
    head.oncontextmenu = e => openMenu(e, tab === beside || (tab === active && beside)
      ? [['Close split', ICON.close, () => split(null)]]
      : [['Open beside', ICON.split, () => split(tab === active ? other() : tab)]])
    view.addEventListener('pointerdown', () => tab !== active && show(tab), true) // a click in a half focuses it
    strip.append(head)
    tabs.push(tab)
    return tab
  }

  function show(tab) {
    if (active && active !== tab) {
      active.el.classList.remove('active')
      if (tab === beside) {
        // Focus crosses to the other half; both stay where they are.
        beside = active
        beside.el.classList.add('beside')
        tab.el.classList.remove('beside')
      } else {
        // The tab takes the focused half's place.
        tab.view.dataset.half = active.view.dataset.half ?? ''
        active.view.hidden = true
        active.view.dataset.half = ''
      }
      last = active
    }
    active = tab
    tab.el.classList.add('active')
    tab.view.hidden = false
    if (!tab.viewer) claude = tab
    else file = tab
    catchUp(tab)
    retitle()
    onShow(tab)
    focus()
    save()
    sessions.poll() // a done mark clears as its tab shows
  }

  // A hidden terminal skips theme changes, so it catches up as it shows. Its size catches up on its own.
  function catchUp(tab) {
    tab.start?.()
    if (tab.look !== look) tab.terminal?.restyle()
    tab.look = look
    tab.viewer?.refresh()
  }

  /** The tab to split with: the one shown before, else the next in the strip. */
  const other = () => (last && last !== active && tabs.includes(last) ? last : tabs[(tabs.indexOf(active) + 1) % tabs.length])

  /** Shows `tab` in the pane's right half beside the active tab, or with null shows the active tab alone. */
  function split(tab) {
    if (beside) {
      beside.view.hidden = true
      beside.view.dataset.half = ''
      beside.el.classList.remove('beside')
    }
    beside = tab && tab !== active ? tab : null
    if (active) active.view.dataset.half = beside ? 'left' : ''
    sash.hidden = !beside
    if (beside) {
      beside.view.dataset.half = 'right'
      beside.view.hidden = false
      beside.el.classList.add('beside')
      catchUp(beside)
    }
    focus()
    sessions.poll()
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
    watched: tab => (tab === active || tab === beside) && document.hasFocus(),
    onChange: (tab, view, report) => {
      tab.el.dataset.mark = view.mark
      // A session that moved, as into the worktree `claude --worktree` makes, takes its tab's git panel along.
      if (report.root && !same(report.root, tab.path)) {
        tab.path = report.root
        tab.label.textContent = tab.label.textContent.replace(tab.name, (tab.name = basename(report.root)))
        if (tab === active) onShow(tab)
      }
      tab.el.title = describe(tab, view, report)
      tab.terminal?.wrote(report.touched ?? [])
      if (view.attention) win.requestUserAttention(UserAttentionType.Informational).catch(() => {})
      // With nook's window in the background, the desktop says so too: the tab's dot shows only inside nook.
      const note = settings.notifications !== false && !document.hasFocus() && notice(view, report, tab.name)
      if (note) invoke('notify', note).catch(() => {})
      retitle()
      onSessions?.()
      save()
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
    if (tab === beside) split(null)
    else if (tab === active && beside) {
      // Its other half takes the whole pane.
      const rest = beside
      split(null)
      show(rest)
    }
    tabs.splice(i, 1)
    tab.el.remove()
    tab.view.remove()
    tab.terminal?.close()
    tab.viewer?.close?.()
    if (tab.type === 'claude' && tabs.length) save() // the window closes with its last tab: its sessions reopen
    if (claude === tab) claude = tabs.findLast(t => !t.viewer) ?? null
    if (file === tab) file = null
    if (!tabs.length) win.close()
    else if (active === tab) show(tabs[Math.min(i, tabs.length - 1)])
  }

  /** A Claude tab in `cwd`, its command given Claude's flags `args`, such as `['--continue']`. */
  /** A Claude tab in `cwd`, its command given Claude's flags `args`. `resume`, a saved session's
   * `{ id, prompt }`, makes a tab that resumes it, and with `later` it starts only when first shown. */
  async function openClaude(cwd, args = [], { resume, later = false } = {}) {
    const tab = add('claude', basename(cwd), cwd)
    tab.cwd = cwd
    tab.resume = resume
    if (resume) {
      args = [...args, '--resume', resume.id]
      if (resume.prompt) tab.el.title = `${cwd}\nResumes “${resume.prompt}”`
    }
    tab.view.classList.add('claude')
    const host = tab.view.appendChild(el('div', { className: 'xterm-host' }))
    // A key that answers Claude's question clears the tab's waiting mark at once, not when the tool ends.
    host.addEventListener('keydown', e => ANSWERS.test(e.code) && !e.target.closest('.find') && sessions.answered(tab), true)
    // The terminal measures its size, so it starts as its tab first shows.
    tab.start = () => (tab.started ??= startTerminal(host, {
      cwd,
      command: claudeWith(settings.command, args),
      home,
      openPath: (path, kind, line, col) => (kind === 'dir' ? openFolder(path) : openFile(path, line, col)),
      onTitle: t => { tab.label.textContent = t ? `${tab.name} · ${t}` : tab.name },
      onExit: () => close(tab),
    }).then(terminal => {
      tab.terminal = terminal
      if (!tabs.includes(tab)) terminal.close() // closed while its shell started
      else if (active === tab) focus()
      save()
    }))
    if (later) {
      save()
      return tab
    }
    show(tab)
    await tab.start()
    return tab
  }

  // The Claude sessions open now, saved as they change, so the next start can reopen them. Compared with
  // what settings.json holds, so a start that changes nothing writes nothing before its terminal spawns.
  const said = list => JSON.stringify(list.map(s => [s.dir, s.id, s.prompt || '', !!s.active]))
  let saved = said(settings.sessions ?? [])
  function save() {
    const list = tabs.filter(t => t.type === 'claude').map(t => {
      const report = sessions.report(t) ?? {}
      const id = report.session ?? t.resume?.id
      return id && { dir: t.cwd, id, prompt: report.prompt || t.resume?.prompt || '', active: t === active || undefined }
    }).filter(Boolean)
    const text = said(list)
    if (text !== saved) onSessionsOpen?.((saved = text, list))
  }

  /** A tab that isn't Claude's: `start(view, tab)` fills its view and returns `{ refresh }`, and
   * optionally `focus`, `close`, and a file's `dirty` and `save`. */
  function openView(type, name, path, start) {
    const open = tabs.find(t => t.type === type && same(t.path, path))
    if (open) return show(open), open
    const tab = add(type, name, path)
    tab.viewer = { focus: () => tab.view.focus(), ...start(tab.view, tab) }
    show(tab)
    return tab
  }

  /** Opens a file in a tab, at `line` and `col` when given. */
  function openFile(path, line, col) {
    const name = basename(path)
    const tab = openView(kind({ name }), name, path, (view, tab) => startViewer(view, path, {
      openFile,
      onDirty: dirty => tab.el.classList.toggle('dirty', dirty),
    }))
    if (line) tab.viewer.reveal?.({ line, col })
  }

  const focus = () => (active?.terminal ?? active?.viewer)?.focus()

  /** Shows the tab `step` places after the active one, wrapping. */
  const cycle = step => {
    const n = tabs.length
    if (n) show(tabs[(tabs.indexOf(active) + step + n) % n])
  }

  addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault()
      cycle(e.shiftKey ? -1 : 1)
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
      // Ctrl+1 to Ctrl+8 show that tab, and Ctrl+9 the last, as in a browser.
      e.preventDefault()
      const n = Number(e.code.slice(5))
      const tab = n === 9 ? tabs.at(-1) : tabs[n - 1]
      if (tab) show(tab)
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'Backslash') {
      e.preventDefault()
      split(beside ? null : other())
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
    /** The file whose tab showed last, while it's open. */
    lastFile: () => file?.path,
    show,
    /** Every Claude tab with its session's view and newest report, in strip order. */
    sessions: () => tabs.filter(t => t.terminal).map(tab => ({ tab, view: sessions.view(tab), report: sessions.report(tab) ?? {} })),
    openView,
    focus,
    cycle,
    /** The tab in front: `{ type, name, path, viewer }`, where a Claude tab has no viewer. */
    active: () => active,
    close: () => active && close(active),
    restyle() {
      look++
      for (const tab of [active, beside]) {
        tab?.terminal?.restyle()
        if (tab) tab.look = look
      }
    },
    /** Resolves true once `tab`'s session has reported, so it can take a prompt, or false after `ms` or if
     * the tab closes first. */
    async ready(tab, ms = 90000) {
      for (const end = Date.now() + ms; Date.now() < end && tabs.includes(tab); await new Promise(r => setTimeout(r, 300))) {
        if (sessions.report(tab)?.status) return true
      }
      return false
    },
    /** Sends `text` to a Claude tab as a prompt, leaving the tab in front where it is. */
    prompt: (tab, text) => tab.terminal?.prompt(text),
    /** Answers the permission prompt a Claude tab shows, with its first choice (allow once) or Escape (deny). */
    answer(tab, allow) {
      tab.terminal?.key(allow ? '1' : '\x1b')
      sessions.answered(tab)
    },
    /** Pastes `text` into the Claude tab shown last, and with `submit`, sends it. */
    paste(text, submit = false) {
      if (!claude?.terminal) return
      const { terminal } = claude
      show(claude)
      terminal.paste(text)
      if (submit) setTimeout(terminal.submit, 50) // after Claude has taken the paste
    },
  }
}
