import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { invoke, Channel } from '@tauri-apps/api/core'
import { showPreview, hidePreview } from './ui.js'
import { startComposer } from './composer.js'
import { startPictures } from './pictures.js'
import { imageStart, FOUND, NONE } from './sequences.js'
import { startLinks } from './links.js'
import { startTurns } from './turns.js'
import { fileUrl } from './linkify.js'
import { ANSI, CLAUDE_SLOTS, slotVar, bytes } from './palette.js'
import { WINDOWS } from './paths.js'
import { quote } from './files.js'

const open = path => invoke('open_path', { path })
// The only link schemes a program's output may hand to the system. Any other could run something.
const WEB = /^(https?|mailto):/i
const HOLD_MS = 500 // the longest xterm holds the last frame for Claude's redraw, once Claude has the size
const QUIET_MS = 16 // how long a redraw's last chunk waits for more when it leaves the cursor hidden
const MIN_COLS = 20 // the smallest size Claude gets: narrower, its layout falls apart
const MIN_ROWS = 6
/** Mouse tracking modes by rank, as DECSET numbers and as xterm's names. */
const MOUSE = { none: 0, 9: 1, x10: 1, 1000: 2, vt200: 2, 1002: 3, drag: 3, 1003: 4, any: 4 }

// xterm parses only hex/rgb(a).
function rgba(color) {
  const [r, g, b, a] = bytes(color)
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
}

/** Reads theme.css variables into xterm. */
function applyTheme(term) {
  const style = getComputedStyle(document.documentElement)
  const v = name => style.getPropertyValue(name).trim()
  const slot = n => rgba(v(slotVar(n)))
  const palette = Object.fromEntries(ANSI.flatMap((c, i) => [[c, slot(i)], [`bright${c[0].toUpperCase()}${c.slice(1)}`, slot(i + 8)]]))
  const extendedAnsi = [] // from slot 16; xterm keeps its own color in each gap
  for (const n of CLAUDE_SLOTS) extendedAnsi[n - 16] = slot(n)
  term.options.theme = {
    ...palette,
    extendedAnsi,
    background: 'rgba(0, 0, 0, 0)', // the backdrop is #term's CSS background
    foreground: rgba(v('--term-fg')),
    cursor: rgba(v('--cursor')),
    cursorAccent: rgba(v('--bg')),
    selectionBackground: rgba(v('--selection')),
    scrollbarSliderBackground: rgba(v('--hover')),
    scrollbarSliderHoverBackground: rgba(v('--line')),
    scrollbarSliderActiveBackground: rgba(v('--line')),
  }
  term.options.fontFamily = v('--font-term')
  term.options.fontSize = parseFloat(v('--term-font-size')) || 14
  term.options.lineHeight = parseFloat(v('--term-line-height')) || 1
}

/** xterm rebuilds every row between the first and last one a write touched, and each of Claude's frames
 * starts at the top row, so a keystroke or a spinner tick rebuilt the whole screen. A row whose new nodes
 * match its old ones keeps them, so the browser repaints only rows that changed. `prepare` finishes a
 * row's new nodes first. */
function keepSameRows(rows, prepare) {
  const same = (row, nodes) => row.childNodes.length === nodes.length && nodes.every((n, i) => n.isEqualNode(row.childNodes[i]))
  const patch = row => {
    row.replaceChildren = (...nodes) => {
      prepare(nodes)
      if (!same(row, nodes)) Element.prototype.replaceChildren.apply(row, nodes)
    }
  }
  for (const row of rows.children) patch(row)
  new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(patch))).observe(rows, { childList: true }) // a resize adds rows
}

/** Whether output holds ESC [ 2 J, which starts each of Claude's full redraws. */
function clears(bytes) {
  for (let i = bytes.indexOf(0x1b); i !== -1; i = bytes.indexOf(0x1b, i + 1)) {
    if (bytes[i + 1] === 0x5b && bytes[i + 2] === 0x32 && bytes[i + 3] === 0x4a) return true
  }
  return false
}

const SHOW = [0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68] // ESC [ ? 2 5 h
/** Whether output ends by showing the cursor, as each of ConPTY's frames does while Claude's prompt has it. */
const ends = bytes => bytes.length >= 6 && SHOW.every((b, i) => bytes[bytes.length - 6 + i] === b)

export async function startTerminal(host, { cwd, home, command, openPath, onTitle, onExit }) {
  // IPC calls can complete out of order, so keys and sizes go to the PTY one at a time, in order: keys
  // typed meanwhile batch up, and only the latest size waiting its turn goes.
  let id
  const queue = []
  let posting = false
  async function send(message) {
    const i = queue.length - 1
    if (i >= 0 && typeof queue[i] === typeof message) queue[i] = typeof message === 'string' ? queue[i] + message : message
    else queue.push(message)
    if (posting) return
    posting = true
    while (queue.length) {
      const m = queue.shift()
      try {
        await (typeof m === 'string' ? invoke('pty_write', { id, data: m }) : invoke('pty_resize', { id, ...m }))
      } catch (e) {
        reportError(e) // and go on: what waits behind it, such as the last size, must not wait for a keystroke
      }
      if (typeof m !== 'string') sized()
    }
    posting = false
  }

  const term = new Terminal({
    allowProposedApi: true, // unicode11 addon
    allowTransparency: true,
    scrollback: 10000,
    cursorBlink: false, // a blinking cursor repaints twice a second, forever
    // On Windows 11, ConPTY reflows on resize (build >= 21376). A Linux PTY leaves reflow to xterm.
    ...(WINDOWS && { windowsPty: { backend: 'conpty', buildNumber: 22000 } }),
    linkHandler: { activate: (_, uri) => link(uri) }, // OSC 8 hyperlinks
    // Picture tools ask the cell and window size in pixels, CSI 16 t and CSI 14 t, to size what they draw.
    windowOptions: { getCellSizePixels: true, getWinSizePixels: true },
  })
  /** An OSC 8 link: a file opens in nook, a web page in the browser, and nothing else goes anywhere. */
  function link(uri) {
    if (WEB.test(uri)) return open(uri)
    if (!/^file:/i.test(uri)) return
    const { path, line } = fileUrl(uri)
    invoke('path_kinds', { paths: [path] }).then(([kind]) => kind && openPath(path, kind === 2 ? 'dir' : 'file', line))
  }
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_, uri) => open(uri)))
  // A shell reports its folder as OSC 7 file://host/path, so relative paths follow its cd.
  let here = cwd
  term.parser.registerOscHandler(7, data => {
    try { here = fileUrl(data).path } catch {}
    return true
  })
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  applyTheme(term)
  // Claude sets mouse tracking again after each press, as ?1000h ?1002h ?1003h. xterm passes through 1000,
  // which reports no drags, and drops the drag in progress, so no selection could start. A mode below the
  // one in force is ignored.
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, p => p.length === 1 && MOUSE[p[0]] < MOUSE[term.modes.mouseTrackingMode])
  term.open(host)
  /** The size the host fits, no smaller than MIN_COLS x MIN_ROWS, or null while it has none. */
  const fits = () => {
    const size = host.offsetWidth && fit.proposeDimensions()
    return size?.cols && size.rows ? { cols: Math.max(MIN_COLS, size.cols), rows: Math.max(MIN_ROWS, size.rows) } : null
  }
  const first = fits()
  if (first) term.resize(first.cols, first.rows)
  const pictures = startPictures(term, host.querySelector('.xterm-screen'), reply => send(reply))
  keepSameRows(host.querySelector('.xterm-rows'), pictures.hide)
  const links = startLinks(term, () => ({ cwd: here, home }), openPath, pictures.pathOf)

  // Claude redraws its whole screen within a frame or two of each resize: ESC [ 2 J, then every row, and
  // ConPTY ends the frame by showing the cursor. Until that redraw is in, a synchronized update (DEC 2026)
  // holds xterm's last frame, which the composer keeps on the screen's bottom row, instead of xterm painting
  // its own cut copy first. Claude never closes the update itself, so the redraw's last chunk does, once the
  // size has reached the PTY: an earlier redraw is an older size's. One resize waits at a time, and the size
  // goes out again once its frame shows, so a dragged edge reflows Claude as fast as Claude redraws.
  // fit.fit() would blank every row first. A hidden tab has no size, and fitting it would shrink Claude to a
  // sliver.
  let hold = null // the resize waiting for Claude's redraw: { sent, until, redrawn, timer }
  let again = false // whether the host resized while a frame was held
  const output = new Channel()
  // Sixel and iTerm2 pictures take xterm's image addon, loaded the first time output holds one. Output that
  // arrives meanwhile waits behind it, in order.
  let images = null // the addon's load
  let waiting = null // chunks that arrived while it loads; null for the shell's exit
  let closed = false
  let carry = null // the end of the last chunk, where it may start a picture
  // An empty chunk means the shell exited.
  output.onmessage = buf => {
    let bytes = buf.byteLength ? new Uint8Array(buf) : null
    if (waiting) return void waiting.push(bytes)
    if (!bytes) return onExit()
    if (!images) {
      if (carry) {
        const joined = new Uint8Array(carry.length + bytes.length)
        joined.set(carry)
        joined.set(bytes, carry.length)
        bytes = joined
      }
      carry = null
      const at = imageStart(bytes)
      if (at === FOUND) {
        waiting = [bytes]
        images = import('@xterm/addon-image')
          .then(({ ImageAddon }) => closed || loadImages(new ImageAddon({ storageLimit: 32, showPlaceholder: false })))
          .catch(reportError)
          .finally(() => {
            const chunks = waiting
            waiting = null
            for (const b of chunks) if (!closed) (b ? take(b) : onExit())
          })
        return
      }
      if (at !== NONE) {
        carry = bytes.slice(at)
        bytes = bytes.subarray(0, at)
        if (!bytes.length) return
      }
    }
    take(bytes)
  }
  /** Loads the image addon, once its sixel decoder, which compiles in the background, is ready. */
  async function loadImages(addon) {
    term.loadAddon(addon)
    const sixel = addon._handlers?.get('sixel')
    for (let i = 0; sixel && !sixel._dec && i < 50; i++) await new Promise(r => setTimeout(r, 10))
  }
  function take(bytes) {
    pictures.read(bytes)
    term.write(bytes)
    if (!hold?.sent || !(hold.redrawn ||= clears(bytes))) return
    clearTimeout(hold.timer)
    if (ends(bytes)) release()
    else hold.timer = setTimeout(release, Math.min(QUIET_MS, hold.until - performance.now()))
  }
  id = await invoke('pty_spawn', { command, cwd, cols: term.cols, rows: term.rows, onData: output })
  const composer = startComposer(term, host, id)
  term.onData(send)
  term.onResize(({ cols, rows }) => send({ cols, rows }))
  term.onTitleChange(onTitle)

  function refit() {
    if (hold) return void (again = true)
    const size = fits()
    if (!size || (size.cols === term.cols && size.rows === term.rows)) return
    if (term.buffer.active.type !== 'alternate') return term.resize(size.cols, size.rows)
    const rows = term.rows
    hold = { sent: false, redrawn: false }
    term.write('\x1b[?2026h', () => {
      term.resize(size.cols, size.rows)
      composer.hold(rows)
    })
  }
  /** The held size reached the PTY, so Claude's redraw for it can come. */
  function sized() {
    if (!hold || hold.sent) return
    hold.sent = true
    hold.until = performance.now() + HOLD_MS
    hold.timer = setTimeout(release, HOLD_MS)
  }
  function release() {
    if (!hold) return
    clearTimeout(hold.timer)
    hold = null
    term.write('\x1b[?2026l')
  }
  term.onRender(() => {
    if (again && !hold) {
      again = false
      refit()
    }
  })
  new ResizeObserver(refit).observe(host)

  let search // the find bar, loaded with its addon the first time it opens
  function find() {
    search ??= import('./search.js').then(m => m.startSearch(term, host, send))
    search.then(s => s.open())
  }
  const turns = startTurns(term, send)
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyF') {
      find()
      e.preventDefault()
      return false
    }
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      turns.jump(e.key === 'ArrowUp')
      e.preventDefault()
      return false
    }
    if (e.altKey && e.key === 'F4') return false // the system closes the window
    if (e.ctrlKey && e.key === 'Tab') return false // the tab strip cycles
    if (e.ctrlKey && e.shiftKey && !e.altKey && /^Key[PSE]$/.test(e.code)) return false // quick prompts, sessions, file list
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) return false // the tab strip shows that tab
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'Backslash') return false // the pane splits
    const ctrl = e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() // with Caps Lock on, Ctrl+C is 'C'
    if (ctrl === 'n') return false // the window opens a Claude tab
    // Let the browser paste, so the paste listener below sees the clipboard.
    if (ctrl === 'v') return false
    if (ctrl === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection())
      term.clearSelection()
      e.preventDefault()
      return false
    }
    // Claude Code reads ESC+CR as "insert newline".
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      send('\x1b\r')
      e.preventDefault()
      return false
    }
    return true
  })

  // With no text on the clipboard, files copied in Explorer, or in nook's file browser, paste as their paths,
  // and Claude attaches any picture among them. A system file manager's text/uri-list pastes the same way.
  // Otherwise an image becomes Claude Code's own image paste: Alt+V on Windows, Ctrl+V elsewhere.
  host.addEventListener('paste', e => {
    const data = e.clipboardData
    if (!data || data.types.includes('text/plain')) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const uris = data.getData('text/uri-list').split(/\r?\n/).filter(u => /^file:/i.test(u))
    const image = [...data.items].some(item => item.type.startsWith('image/'))
    const pasteFiles = paths => term.paste(paths.map(quote).join(' ') + ' ')
    if (uris.length) return pasteFiles(uris.map(u => fileUrl(u).path))
    invoke('copied_paths').catch(() => []).then(paths => {
      if (paths.length) pasteFiles(paths)
      else if (image) send(WINDOWS ? '\x1bv' : '\x16')
    })
  }, true)

  // [Image #N] → hover to preview, click to open. Images live where Claude Code saved them.
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
      callback([...text.matchAll(/\[Image #(\d+)\]/g)].map(m => {
        const image = () => invoke('session_image', { id, n: Number(m[1]) })
        let hovering = false
        return {
          text: m[0],
          range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
          hover: async e => {
            hovering = true
            const p = await image()
            if (p && hovering) showPreview(p, e.clientX, e.clientY)
          },
          leave: () => { hovering = false; hidePreview() },
          activate: async () => { const p = await image(); if (p) open(p) },
        }
      }))
    },
  })

  return {
    id, // the session's, for its mod's reports
    restyle: () => { applyTheme(term); refit() },
    paste: text => { term.paste(text); term.focus() },
    /** Presses Enter, as to send what was pasted. */
    submit: () => send('\r'),
    /** Pastes `text` and sends it, without taking the keys: for a tab that isn't in front. */
    prompt: text => { term.paste(text); setTimeout(() => send('\r'), 50) },
    /** Sends keys as typed, without taking them: to answer what Claude asks in a tab that isn't in front. */
    key: data => send(data),
    focus: () => term.focus(),
    /** Hears every file the session wrote, newest last, so a page Claude wrote shows its new stylesheet. */
    wrote: paths => pictures.wrote(paths),
    find,
    /** Shows the prompt you sent before the view's top, or after it. */
    jump: up => turns.jump(up),
    close: () => {
      closed = true
      clearTimeout(hold?.timer)
      composer.close()
      links.dispose()
      search?.then(s => s.dispose())
      turns.dispose()
      output.onmessage = () => {}
      invoke('pty_close', { id })
      term.dispose()
    },
  }
}
