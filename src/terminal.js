import { Term } from './term/view.js'
import { urlLinks } from './term/urls.js'
import { invoke, Channel } from './host.js'
import { showPreview, hidePreview, letter } from './ui.js'
import { startComposer } from './composer.js'
import { startPictures } from './pictures.js'
import { imageStart, FOUND, NONE, clipboardText } from './sequences.js'
import { startLinks, cells } from './links.js'
import { startTurns } from './turns.js'
import { fileUrl } from './linkify.js'
import { WINDOWS } from './paths.js'
import { quote } from './files.js'

const open = path => invoke('open_path', { path })
const HOLD_MS = 500 // the longest the terminal holds the last frame for Claude's redraw, once Claude has the size
const QUIET_MS = 16 // how long a redraw's last chunk waits for more when it leaves the cursor hidden
const MIN_COLS = 20 // the smallest size Claude gets: narrower, its layout falls apart
const MIN_ROWS = 6

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
  // typed meanwhile batch up, and only the latest size waiting its turn goes. What comes before the PTY
  // exists, such as the terminal's answers to ConPTY's first questions, waits for it.
  let id
  const queue = []
  let posting = false
  function send(message) {
    const i = queue.length - 1
    if (i >= 0 && typeof queue[i] === typeof message) queue[i] = typeof message === 'string' ? queue[i] + message : message
    else queue.push(message)
    post()
  }
  async function post() {
    if (posting || id === undefined) return
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

  let pictures // kitty pictures, which Claude draws
  let images = null // sixel and iTerm2 pictures, once output first holds one
  // A shell reports its folder as OSC 7 file://host/path, so relative paths follow its cd.
  let here = cwd
  function osc(n, data) {
    if (n === 7) {
      try { here = fileUrl(data).path } catch {}
    } else if (n === 52) {
      // OSC 52 writes the clipboard: Claude copies its fullscreen selection this way as well as with the system's
      // tool, which a Linux desktop may lack and a session over ssh can't reach. Reads are refused.
      const text = clipboardText(data)
      if (text !== null) navigator.clipboard.writeText(text).catch(() => {})
    } else if (n === 1337) images?.iterm(data)
  }
  const term = new Term(host, {
    // ConPTY reflows on resize and grows the screen with blank rows. A Linux PTY leaves reflow to the terminal.
    pull: !WINDOWS,
    osc,
    apc: data => pictures.apc(data),
    dcs: (ident, params) => (ident === 0x71 ? images?.sixel(params) : undefined), // q: sixel
    link: open, // an OSC 8 link to the web
    keys,
  })
  term.registerLinkProvider(urlLinks(term, open))
  /** The size the host fits, no smaller than MIN_COLS x MIN_ROWS, or null while it has none. */
  const fits = () => {
    const size = host.offsetWidth && term.fit()
    return size ? { cols: Math.max(MIN_COLS, size.cols), rows: Math.max(MIN_ROWS, size.rows) } : null
  }
  const first = fits()
  if (first) term.resize(first.cols, first.rows)
  pictures = startPictures(term, reply => send(reply))
  const links = startLinks(term, () => ({ cwd: here, home }), openPath, pictures.pathOf)

  // Claude redraws its whole screen within a frame or two of each resize: ESC [ 2 J, then every row, and
  // ConPTY ends the frame by showing the cursor. Until that redraw is in, a synchronized update (DEC 2026)
  // holds the last frame, which the composer keeps on the screen's bottom row, instead of the terminal painting
  // its own cut copy first. Claude never closes the update itself, so the redraw's last chunk does, once the
  // size has reached the PTY: an earlier redraw is an older size's. One resize waits at a time, and the size
  // goes out again once its frame shows, so a dragged edge reflows Claude as fast as Claude redraws. A hidden
  // tab has no size, and fitting it would shrink Claude to a sliver.
  let hold = null // the resize waiting for Claude's redraw: { sent, until, redrawn, timer }
  let again = false // whether the host resized while a frame was held
  const output = new Channel()
  // Sixel and iTerm2 pictures load their module the first time output holds one. Output that arrives meanwhile
  // waits behind it, in order.
  let loading = false
  let waiting = null // chunks that arrived while it loads; null for the shell's exit
  let closed = false
  let carry = null // the end of the last chunk, where it may start a picture
  // An empty chunk means the shell exited.
  output.onmessage = buf => {
    let bytes = buf.byteLength ? new Uint8Array(buf) : null
    if (waiting) return void waiting.push(bytes)
    if (!bytes) return onExit()
    if (!loading) {
      if (carry) {
        const joined = new Uint8Array(carry.length + bytes.length)
        joined.set(carry)
        joined.set(bytes, carry.length)
        bytes = joined
      }
      carry = null
      const at = imageStart(bytes)
      if (at === FOUND) {
        loading = true
        waiting = [bytes]
        import('./term/images.js')
          .then(m => { if (!closed) images = m.startImages(term) })
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
  function take(bytes) {
    term.write(bytes)
    if (!hold?.sent || !(hold.redrawn ||= clears(bytes))) return
    clearTimeout(hold.timer)
    if (ends(bytes)) release()
    else hold.timer = setTimeout(release, Math.min(QUIET_MS, hold.until - performance.now()))
  }
  term.onData(send)
  term.onResize(({ cols, rows }) => send({ cols, rows }))
  term.onTitleChange(onTitle)
  id = await invoke('pty_spawn', { command, cwd, cols: term.cols, rows: term.rows, onData: output })
  post()
  const composer = startComposer(term, host, id)

  function refit() {
    if (hold) return void (again = true)
    const size = fits()
    if (!size || (size.cols === term.cols && size.rows === term.rows)) return
    if (term.vt.buffer !== term.vt.alt) return term.resize(size.cols, size.rows)
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
    host.dispatchEvent(new Event('nook-render', { bubbles: true })) // the wallpaper's frame that waits on a key's echo follows it
  })
  new ResizeObserver(refit).observe(host)

  let search // the find bar, loaded the first time it opens
  function find() {
    search ??= import('./search.js').then(m => m.startSearch(term, host, send))
    search.then(s => s.open())
  }
  const turns = startTurns(term, send)
  /** Each key before the program has it: false keeps it from the program. */
  function keys(e) {
    if (e.ctrlKey && e.shiftKey && !e.altKey && letter(e) === 'f') {
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
    if (e.ctrlKey && e.shiftKey && !e.altKey && /^[pse]$/.test(letter(e))) return false // quick prompts, sessions, file list
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) return false // the tab strip shows that tab
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'Backslash') return false // the pane splits
    const ctrl = e.ctrlKey && !e.shiftKey && !e.altKey && letter(e)
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
  }

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
  const cell = term.vt.buffer.getNullCell()
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.vt.buffer.getLine(y - 1)
      if (!line?.translateToString(true).includes('[Image #')) return callback([])
      const { text, xs } = cells(line, term.cols, cell)
      callback([...text.matchAll(/\[Image #(\d+)\]/g)].map(m => {
        const image = () => invoke('session_image', { id, n: Number(m[1]) })
        let hovering = false
        return {
          text: m[0],
          range: { start: { x: xs[m.index] + 1, y }, end: { x: xs[m.index + m[0].length - 1] + 1, y } },
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
    restyle: () => { term.restyle(); refit() },
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
      images?.dispose()
      output.onmessage = () => {}
      invoke('pty_close', { id })
      term.dispose()
    },
  }
}
