// Web addresses in a terminal's text as links: http(s) URLs, read across rows a long line wraps onto, each one
// that parses as a URL whose start is its own. The pattern, the check, and the 2048-character window are xterm.js's
// web-links addon's (LICENSES.txt).
const URL_RE = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g

/** Whether `s` starts with the origin it parses to, so a URL with stray text in front of its host is not one. */
function isUrl(s) {
  try {
    const u = new URL(s)
    const user = u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : ''
    return s.toLowerCase().startsWith(`${u.protocol}//${user}${u.host}`.toLowerCase())
  } catch {
    return false
  }
}

/** A link provider for `term` that hands each URL clicked to `open(uri)`. */
export function urlLinks(term, open) {
  const cell = term.vt.buffer.getNullCell()
  const line = y => term.vt.buffer.getLine(y)

  /** Buffer line `y` with the wrapped rows around it, joined, up to 2048 characters each way and stopping at a
   * row with a space; returns the text and its first line. */
  function window(y) {
    let top = y
    const rows = [line(y).translateToString(true)]
    if (line(y).isWrapped && rows[0][0] !== ' ') {
      for (let n = 0, l; (l = line(--top)) && n < 2048;) {
        const s = l.translateToString(true)
        n += s.length
        rows.unshift(s)
        if (!l.isWrapped || s.includes(' ')) break
      }
    }
    for (let n = 0, b = y, l; (l = line(++b)) && l.isWrapped && n < 2048;) {
      const s = l.translateToString(true)
      n += s.length
      rows.push(s)
      if (s.includes(' ')) break
    }
    return [rows.join(''), top]
  }

  /** The cell `n` characters on from cell `x` of line `y`, as [y, x]; a wide character takes one character. */
  function walk(y, x, n) {
    while (n) {
      const l = line(y)
      if (!l) return [-1, -1]
      for (let i = x; i < l.length; i++) {
        l.getCell(i, cell)
        const chars = cell.getChars()
        if (cell.getWidth()) {
          n -= chars.length || 1
          if (i === l.length - 1 && chars === '' && line(y + 1)?.isWrapped && line(y + 1).getCell(0, cell).getWidth() === 2) n++
        }
        if (n < 0) return [y, i]
      }
      y++
      x = 0
    }
    return [y, x]
  }

  return {
    provideLinks(y, callback) {
      if (!line(y - 1)) return callback([])
      const [text, top] = window(y - 1)
      const links = []
      for (const m of text.matchAll(URL_RE)) {
        if (!isUrl(m[0])) continue
        const [sy, sx] = walk(top, 0, m.index)
        const [ey, ex] = walk(sy, sx, m[0].length)
        if (sy < 0 || ey < 0) continue
        links.push({ text: m[0], range: { start: { x: sx + 1, y: sy + 1 }, end: { x: ex, y: ey + 1 } }, activate: (_, uri) => open(uri) })
      }
      callback(links)
    },
  }
}
