// The files opened lately, newest first, which quick open offers before the rest. Kept in the webview's
// storage, so they last across launches, and small enough to load with the window.
import { path as paths } from './paths.js'

const KEY = 'nook.recent'
export const RECENT_MAX = 60

export function recentFiles() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(list) ? list.filter(p => typeof p === 'string') : []
  } catch {
    return []
  }
}

/** Notes that `path` was opened. */
export function opened(path) {
  const list = [path, ...recentFiles().filter(p => !paths.same(p, path))].slice(0, RECENT_MAX)
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch {}
}
