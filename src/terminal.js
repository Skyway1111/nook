import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { invoke, Channel } from '@tauri-apps/api/core'
import { showPreview, hidePreview } from './ui.js'
import { startComposer } from './composer.js'
import { startPictures } from './pictures.js'
import { ANSI, CLAUDE_SLOTS, slotVar, bytes } from './palette.js'

const open = path => invoke('open_path', { path })
export const SETTLE_MS = 100 // how long a dragged size holds still before Claude redraws for it and gradients go live
const HOLD_MS = 500 // the longest xterm keeps holding the last frame for Claude's redraw

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

export async function startTerminal(host, { cwd, command, onTitle, onExit }) {
  // IPC calls can complete out of order, so writes go one at a time; keys typed meanwhile batch up.
  let id
  let pending = ''
  let writing = false
  async function send(data) {
    pending += data
    if (writing) return
    writing = true
    try {
      while (pending) {
        const chunk = pending
        pending = ''
        await invoke('pty_write', { id, data: chunk })
      }
    } finally {
      writing = false
    }
  }

  const term = new Terminal({
    allowProposedApi: true, // unicode11 addon
    allowTransparency: true,
    scrollback: 10000,
    cursorBlink: false, // a blinking cursor repaints twice a second, forever
    // nook targets Windows 11, whose ConPTY reflows on resize (build >= 21376).
    windowsPty: { backend: 'conpty', buildNumber: 22000 },
    linkHandler: { activate: (_, uri) => open(uri) }, // OSC 8 hyperlinks
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_, uri) => open(uri)))
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  applyTheme(term)
  term.open(host)
  fit.fit()
  const pictures = startPictures(term, host.querySelector('.xterm-screen'))
  keepSameRows(host.querySelector('.xterm-rows'), pictures.hide)

  let holding = 0 // until when a resize waits for Claude's redraw; 0 when none is due
  const output = new Channel()
  // An empty chunk means the shell exited.
  output.onmessage = buf => {
    if (!buf.byteLength) return onExit()
    const bytes = new Uint8Array(buf)
    pictures.read(bytes)
    term.write(bytes)
    // A frame Claude drew for the old size, such as a spinner tick, ends the update early. Only the
    // redraw clears the screen, so any other frame starts the update again.
    if (!holding) return
    if (clears(bytes) || performance.now() > holding) holding = 0
    else term.write('\x1b[?2026h')
  }
  id = await invoke('pty_spawn', { command, cwd, cols: term.cols, rows: term.rows, onData: output })
  const composer = startComposer(term, host, cwd, id)
  term.onData(send)
  term.onResize(({ cols, rows }) => invoke('pty_resize', { id, cols, rows }))
  term.onTitleChange(onTitle)
  // Claude redraws its whole screen about 50 ms after each resize, inside a synchronized update (DEC
  // 2026). So the size goes to Claude once it holds still, and xterm holds the last frame until that
  // redraw, instead of painting its own cut copy of the screen first. fit.fit() would blank every row
  // first. A hidden tab has no size, and fitting it would shrink Claude to a sliver.
  let settle
  function refit() {
    clearTimeout(settle)
    if (term.modes.synchronizedOutputMode) return void (settle = setTimeout(refit, SETTLE_MS)) // a redraw is due
    const size = host.offsetWidth && fit.proposeDimensions()
    if (!size?.cols || !size.rows || (size.cols === term.cols && size.rows === term.rows)) return
    if (term.buffer.active.type !== 'alternate') return term.resize(size.cols, size.rows)
    holding = performance.now() + HOLD_MS
    term.write('\x1b[?2026h', () => term.resize(size.cols, size.rows))
  }
  new ResizeObserver(() => {
    clearTimeout(settle)
    settle = setTimeout(refit, SETTLE_MS)
  }).observe(host)

  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true
    if (e.altKey && e.key === 'F4') return false // Windows closes the window
    if (e.ctrlKey && e.key === 'Tab') return false // the tab strip cycles
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

  // A clipboard holding an image (and no text) becomes Claude Code's own image paste: Alt+V.
  host.addEventListener('paste', e => {
    const data = e.clipboardData
    if (!data || data.types.includes('text/plain')) return
    if (![...data.items].some(item => item.type.startsWith('image/'))) return
    e.preventDefault()
    e.stopImmediatePropagation()
    send('\x1bv')
  }, true)

  // [Image #N] → hover to preview, click to open. Images live where Claude Code saved them.
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
      callback([...text.matchAll(/\[Image #(\d+)\]/g)].map(m => {
        const image = () => invoke('session_image', { cwd, n: Number(m[1]) })
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
    restyle: () => { applyTheme(term); refit() },
    refit,
    paste: text => { term.paste(text); term.focus() },
    focus: () => term.focus(),
    close: () => {
      clearTimeout(settle)
      composer.close()
      output.onmessage = () => {}
      invoke('pty_close', { id })
      term.dispose()
    },
  }
}
