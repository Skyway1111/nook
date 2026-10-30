// What a key sends to the program, as xterm.js sends it on Windows and Linux. `keyData(e, appCursor)` gives
// `{ key, cancel, page }`: the sequence ('' for none), whether the browser must not act on the key too, and -1
// or 1 when Shift+PageUp or Shift+PageDown scrolls the view instead.

// Digits and punctuation by keyCode, unshifted and shifted, for Alt+key.
const SHIFTS = {
  48: '0)', 49: '1!', 50: '2@', 51: '3#', 52: '4$', 53: '5%', 54: '6^', 55: '7&', 56: '8*', 57: '9(',
  186: ';:', 187: '=+', 188: ',<', 189: '-_', 190: '.>', 191: '/?', 192: '`~', 219: '[{', 220: '\\|', 221: ']}', 222: '\'"',
}
const CURSOR = { 37: 'D', 38: 'A', 39: 'C', 40: 'B', 36: 'H', 35: 'F' } // arrows, Home, End
const TILDE = { 46: 3, 116: 15, 117: 17, 118: 18, 119: 19, 120: 20, 121: 21, 122: 23, 123: 24 } // Delete, F5-F12
const SS3 = { 112: 'P', 113: 'Q', 114: 'R', 115: 'S' } // F1-F4

export function keyData(e, appCursor) {
  const mods = (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 4 : 0) | (e.metaKey ? 8 : 0)
  const code = e.keyCode
  let key = ''
  let cancel = false
  let page = 0
  if (code === 8) key = (e.altKey ? '\x1b' : '') + (e.ctrlKey ? '\b' : '\x7f')
  else if (code === 9) {
    key = e.shiftKey ? '\x1b[Z' : '\t'
    cancel = !e.shiftKey
  } else if (code === 13) {
    key = e.altKey ? '\x1b\r' : '\r'
    cancel = true
  } else if (code === 27) {
    key = e.altKey ? '\x1b\x1b' : '\x1b'
    cancel = true
  } else if (code in CURSOR) {
    if (!e.metaKey || code < 37) key = mods ? `\x1b[1;${mods + 1}${CURSOR[code]}` : `\x1b${appCursor ? 'O' : '['}${CURSOR[code]}`
  } else if (code === 45) {
    if (!e.shiftKey && !e.ctrlKey) key = '\x1b[2~'
  } else if (code in TILDE) key = `\x1b[${TILDE[code]}${mods ? `;${mods + 1}` : ''}~`
  else if (code === 33 || code === 34) {
    if (e.shiftKey) page = code === 33 ? -1 : 1
    else key = `\x1b[${code === 33 ? 5 : 6}${e.ctrlKey ? `;${mods + 1}` : ''}~`
  } else if (code in SS3) key = mods ? `\x1b[1;${mods + 1}${SS3[code]}` : `\x1bO${SS3[code]}`
  else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
    if (code >= 65 && code <= 90) key = String.fromCharCode(code - 64)
    else if (code === 32) key = '\0'
    else if (code >= 51 && code <= 55) key = String.fromCharCode(code - 51 + 27)
    else if (code === 56) key = '\x7f'
    else if (code === 219) key = '\x1b'
    else if (code === 220) key = '\x1c'
    else if (code === 221) key = '\x1d'
  } else if (e.altKey && !e.metaKey) {
    const shifted = SHIFTS[code]
    if (shifted) key = '\x1b' + shifted[e.shiftKey ? 1 : 0]
    else if (code >= 65 && code <= 90) {
      const c = String.fromCharCode(e.ctrlKey ? code - 64 : code + 32)
      key = '\x1b' + (e.shiftKey ? c.toUpperCase() : c)
    } else if (code === 32) key = '\x1b' + (e.ctrlKey ? '\0' : ' ')
    else if (e.key === 'Dead' && e.code.startsWith('Key')) {
      // Alt makes some letters dead keys on some layouts.
      const c = e.code.slice(3, 4)
      key = '\x1b' + (e.shiftKey ? c : c.toLowerCase())
      cancel = true
    }
  } else if (e.key && !e.ctrlKey && !e.altKey && !e.metaKey && code >= 48 && e.key.length === 1) key = e.key
  else if (e.key && e.ctrlKey) {
    if (e.key === '_') key = '\x1f'
    if (e.key === '@') key = '\0'
  }
  return { key, cancel, page }
}
