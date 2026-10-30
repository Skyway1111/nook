// Finding escape sequences in raw terminal output, with no DOM, so `npm test` checks it without a window.

const FILE = '1337;File='

/** Where output starts a sixel picture (ESC P <digits> q) or an iTerm2 one (ESC ] 1337 ; File=): FOUND if it
 * does, NONE if it doesn't, or the index of an ESC at the end that may start one once more output comes. */
export function imageStart(bytes) {
  for (let i = bytes.indexOf(0x1b); i !== -1; i = bytes.indexOf(0x1b, i + 1)) {
    if (i === bytes.length - 1) return i
    if (bytes[i + 1] === 0x50) { // P
      let j = i + 2
      while (j < bytes.length && ((bytes[j] >= 0x30 && bytes[j] <= 0x39) || bytes[j] === 0x3b)) j++
      if (j === bytes.length) return i
      if (bytes[j] === 0x71) return FOUND // q
    } else if (bytes[i + 1] === 0x5d) { // ]
      const head = String.fromCharCode(...bytes.subarray(i + 2, i + 2 + FILE.length))
      if (head === FILE) return FOUND
      if (i + 2 + head.length === bytes.length && FILE.startsWith(head)) return i
    }
  }
  return NONE
}
export const FOUND = -2
export const NONE = -1

const CLIPBOARD_MAX = 8 << 20 // base64 characters: 6 MB of text, more than any selection
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** The text an OSC 52 sequence's data (`Pc;Pd`, as the terminal hands it over) puts on the clipboard, or null when
 * it puts none: a read (`?`), which no program gets, a malformed or oversized payload, or text that isn't
 * UTF-8. An empty payload is an empty string, which clears the clipboard as other terminals do. */
export function clipboardText(data) {
  const semi = data.indexOf(';')
  if (semi === -1) return null
  const payload = data.slice(semi + 1).replace(/\s+/g, '')
  if (payload === '?' || payload.length > CLIPBOARD_MAX || !BASE64.test(payload)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0)))
  } catch {
    return null
  }
}
