// The terminal palette's theme variables. Colors 0-15 are theme.css's 16 ANSI colors. nook's Claude theme
// (src-tauri/mod/themes/nook.json) draws each of Claude's color tokens it lists in its own slot from 16 up,
// and that slot takes `--claude-<token>`.
import nook from '../src-tauri/mod/themes/nook.json'

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
const SLOTS = new Map(Object.entries(nook.overrides).map(([token, color]) => [Number(/\d+(?=\))/.exec(color)), token]))

/** The variable that colors palette slot `c`, or null for a slot that keeps xterm's color. */
export function slotVar(c) {
  if (c < 16) return `--ansi-${c < 8 ? ANSI[c] : 'bright-' + ANSI[c - 8]}`
  return SLOTS.has(c) ? `--claude-${SLOTS.get(c)}` : null
}

const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
/** Any CSS color (oklch, named, with alpha) as [r, g, b, a] bytes, through a 1px canvas. */
export function bytes(color) {
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = '#0000'
  probe.fillStyle = color
  probe.fillRect(0, 0, 1, 1)
  return [...probe.getImageData(0, 0, 1, 1).data]
}
