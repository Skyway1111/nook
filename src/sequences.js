// Finding escape sequences in raw terminal output, with no DOM, so `npm test` checks it without a window.

const OSC_IMAGES = ['1337;File=', '1337;MultipartFile=']

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
      const head = String.fromCharCode(...bytes.subarray(i + 2, i + 2 + 19))
      if (OSC_IMAGES.some(s => head.startsWith(s))) return FOUND
      if (i + 2 + head.length === bytes.length && OSC_IMAGES.some(s => s.startsWith(head))) return i
    }
  }
  return NONE
}
export const FOUND = -2
export const NONE = -1
