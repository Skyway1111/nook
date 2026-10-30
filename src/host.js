// The one door to the native side: commands, streams, files on disk as URLs, and the window.
import { invoke, Channel, convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { listen as tauriListen } from '@tauri-apps/api/event'

export { invoke, Channel, convertFileSrc }

/** Calls `fn(payload)` for each `event` the native side emits. */
export const listen = (event, fn) => tauriListen(event, e => fn(e.payload))

const w = getCurrentWindow()
export const win = {
  minimize: () => w.minimize(),
  toggleMaximize: () => w.toggleMaximize(),
  /** Asks to close: every `onCloseRequested` handler runs first, and any can `preventDefault`. */
  close: () => w.close(),
  setTitle: title => w.setTitle(title),
  /** Flashes the taskbar button once, unless the window is in front. */
  attention: () => w.requestUserAttention(UserAttentionType.Informational).catch(() => {}),
  /** The color a growing window shows before the page repaints. */
  setBackground: ([r, g, b]) => getCurrentWebviewWindow().setBackgroundColor([r, g, b, 255]),
  onCloseRequested: fn => w.onCloseRequested(fn),
  onFocus: fn => w.onFocusChanged(({ payload }) => fn(payload)),
  /** `fn(maximized)` after every resize settles, and once now. */
  onMaximized(fn) {
    let timer
    const sync = async () => fn(await w.isMaximized())
    w.onResized(() => { clearTimeout(timer); timer = setTimeout(sync, 100) })
    sync()
  },
  /** Files dragged in from the OS: `fn({type: 'over'|'drop'|'leave', x, y, paths})`, x and y in CSS pixels. */
  onDrop: fn => getCurrentWebview().onDragDropEvent(({ payload: { type, position, paths } }) => fn({
    type: type === 'enter' ? 'over' : type,
    x: position ? position.x / devicePixelRatio : 0,
    y: position ? position.y / devicePixelRatio : 0,
    paths: paths ?? [],
  })),
}
