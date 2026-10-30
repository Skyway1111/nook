// The one door to the native side: commands, streams, files on disk as URLs, and the window. The host handles
// calls in the order they're posted, so they need no queue of their own. On Windows they're WebView2's web
// messages, and the host answers in web messages and shared buffers; on Linux, WebKitGTK's script message
// handler carries calls, and the host calls window.__nook with replies, events, and streams' text.
const wv = window.chrome?.webview
const calls = new Map()
const channels = new Map()
const listeners = new Map()
// Ids for calls and channels start anywhere, so what the host sends to the page before a reload finds nothing.
let nextId = Math.floor(Math.random() * 2 ** 48) + 1

/** A reply `[id, ok, value]` or an event `[name, payload]`. */
function receive(data) {
  if (typeof data[0] !== 'number') return listeners.get(data[0])?.forEach(fn => fn(data[1]))
  const call = calls.get(data[0])
  if (!call) return
  calls.delete(data[0])
  call[data[1]](data[2])
}

/** Piece `seq` of channel `id`'s text, and whether the stream ends with it. A piece that passed one before it waits. */
function text(id, seq, s, end) {
  const channel = channels.get(id)
  if (!channel) return
  if (seq !== channel.seq) return channel.early.set(seq, [s, end])
  for (;;) {
    channel.seq++
    if (s) channel.onmessage(s)
    if (end) {
      channels.delete(id)
      return channel.onmessage('')
    }
    const next = channel.early.get(channel.seq)
    if (!next) return
    channel.early.delete(channel.seq)
    ;[s, end] = next
  }
}

const post = wv ? m => wv.postMessage(m) : m => window.webkit.messageHandlers.ipc.postMessage(JSON.stringify(m))
if (wv) {
  const decoder = new TextDecoder()
  // A string is a reply or an event as JSON, or a stream's short piece, `<id> <seq> <end>|<text>`.
  wv.addEventListener('message', ({ data }) => {
    if (data[0] === '[') return receive(JSON.parse(data))
    const bar = data.indexOf('|')
    const [id, seq, end] = data.slice(0, bar).split(' ')
    text(+id, +seq, data.slice(bar + 1), end === '1')
  })
  // A buffer marked [id, seq, end] is a stream's long piece; one marked [0] is a long reply.
  wv.addEventListener('sharedbufferreceived', e => {
    const [id, seq, end] = e.additionalData
    const buffer = e.getBuffer()
    const s = decoder.decode(buffer)
    wv.releaseBuffer(buffer)
    if (id) text(id, seq, s, end)
    else receive(JSON.parse(s))
  })
} else {
  window.__nook = { receive, text }
}

// A press on a drag region moves the window, and a double press maximizes or restores it. Only the region
// itself counts, not what's in it.
document.addEventListener('mousedown', e => {
  if (e.button !== 0 || !e.target.hasAttribute?.('data-drag-region') || e.detail > 2) return
  e.preventDefault()
  e.stopImmediatePropagation()
  invoke(e.detail === 2 ? 'win_toggle_maximize' : 'win_drag')
})

// The commands that carry bytes, in or out. They go by fetch: a Uint8Array as the body, or the arguments as JSON,
// and bytes come back as an ArrayBuffer.
const FETCHED = new Set(['install_theme_zip', 'install_theme_files', 'save_backdrop', 'saved_backdrop', 'pdf_page'])

/** Runs native command `cmd` with `args`. */
export function invoke(cmd, args = {}) {
  if (FETCHED.has(cmd)) return fetchCommand(cmd, args)
  return new Promise((resolve, reject) => {
    const id = nextId++
    calls.set(id, [reject, resolve])
    post([id, cmd, args])
  })
}

async function fetchCommand(cmd, args) {
  const json = !(args instanceof Uint8Array)
  const r = await fetch('/__ipc/' + cmd, {
    method: 'POST',
    body: json ? JSON.stringify(args) : args,
    headers: json ? { 'Content-Type': 'application/json' } : {},
  })
  if (!r.ok) throw await r.text()
  return r.headers.get('Content-Type') === 'application/json' ? r.json() : r.arrayBuffer()
}

/** Text the native side streams to `onmessage`, in order. Empty text means the stream ended. */
export class Channel {
  id = nextId++
  seq = 0
  early = new Map()
  onmessage = () => {}
  constructor() { channels.set(this.id, this) }
  toJSON() { return this.id }
}

const FILES = wv ? 'http://asset.localhost/' : 'asset://localhost/'
/** The URL the page loads file `path` from. */
export const convertFileSrc = path => FILES + encodeURIComponent(path)

/** Calls `fn(payload)` for each `event` the native side emits. */
export function listen(event, fn) {
  if (!listeners.has(event)) listeners.set(event, [])
  listeners.get(event).push(fn)
}

const closers = []
listen('close', () => win.close())

export const win = {
  minimize: () => invoke('win_minimize'),
  toggleMaximize: () => invoke('win_toggle_maximize'),
  /** Asks to close: every `onCloseRequested` handler runs first, and any can `preventDefault`. */
  async close() {
    let kept = false
    const e = { preventDefault: () => { kept = true } }
    for (const fn of closers) await fn(e)
    if (!kept) invoke('win_destroy')
  },
  setTitle: title => invoke('win_title', { title }),
  /** Flashes the taskbar button, unless the window is in front. */
  attention: () => invoke('win_attention'),
  /** The color a growing window shows before the page repaints. */
  setBackground: rgb => invoke('win_background', { rgb }),
  onCloseRequested: fn => { closers.push(fn) },
  /** `fn(focused)` as the window gains or loses focus. */
  onFocus: fn => listen('focus', fn),
  /** `fn(maximized)` whenever that changes, and once now. */
  onMaximized(fn) {
    listen('maximized', fn)
    invoke('win_maximized').then(fn)
  },
  /** Files dragged in from the OS: `fn({type: 'over'|'drop'|'leave', x, y, paths})`, x and y in CSS pixels. */
  onDrop: fn => listen('drop', fn),
}
