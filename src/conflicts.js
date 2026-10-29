// A conflicted file as data: the text git left between its <<<<<<<, |||||||, =======, and >>>>>>> markers, and
// the text that taking one side, or both, makes of it. No DOM, so conflicts.test.js checks it under `npm test`.

const MARK = /^(<{7}|\|{7}|={7}|>{7})(?: (.*))?$/

/**
 * `text` as parts in order: `{ lines }` where nothing conflicts, and `{ ours, base, theirs, oursLabel,
 * theirsLabel, line }` for each conflict: each side its lines without the markers, `base` null unless git
 * wrote the common ancestor too (diff3 or zdiff3), and `line` the 1-based line of its <<<<<<< marker.
 */
export function parseConflicts(text) {
  const parts = []
  const lines = text.split('\n')
  let plain = []
  let c = null
  let side = null
  for (const [i, l] of lines.entries()) {
    const m = MARK.exec(l.endsWith('\r') ? l.slice(0, -1) : l)
    const kind = m?.[1][0]
    if (!c && kind === '<') {
      if (plain.length) parts.push({ lines: plain })
      plain = []
      c = { ours: [], base: null, theirs: [], oursLabel: m[2] ?? '', theirsLabel: '', line: i + 1, cr: l.endsWith('\r') ? '\r' : '' }
      side = 'ours'
    } else if (c && kind === '|' && side === 'ours') {
      c.base = []
      side = 'base'
    } else if (c && kind === '=' && side !== 'theirs') side = 'theirs'
    else if (c && kind === '>' && side === 'theirs') {
      c.theirsLabel = m[2] ?? ''
      parts.push(c)
      c = null
    } else if (c) c[side].push(l)
    else plain.push(l)
  }
  // A <<<<<<< never closed isn't a conflict: its lines stay as they are.
  if (c) plain = lines.slice(c.line - 1)
  if (plain.length) parts.push({ lines: plain })
  return parts
}

/** Whether a part is a conflict. */
export const isConflict = part => 'ours' in part

/**
 * The file's text with conflict `k` (counting from 0), or every conflict when `k` is left out, settled by
 * `choice`: 'ours', 'theirs', 'both' (ours then theirs), or 'base'. The other conflicts keep their markers.
 */
export function resolve(parts, choice, k) {
  let n = -1
  return parts.flatMap(p => {
    if (!isConflict(p)) return p.lines
    if (++n !== k && k !== undefined) return markers(p)
    return choice === 'both' ? [...p.ours, ...p.theirs] : p[choice] ?? []
  }).join('\n')
}

/** A conflict's lines as git wrote them. */
function markers(p) {
  const mark = (m, label) => (label ? `${m} ${label}` : m) + p.cr
  return [
    mark('<<<<<<<', p.oursLabel), ...p.ours,
    ...(p.base ? [mark('|||||||'), ...p.base] : []),
    mark('======='), ...p.theirs,
    mark('>>>>>>>', p.theirsLabel),
  ]
}
