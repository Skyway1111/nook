// Blame as data: which commit last changed each line, from `git blame --porcelain`. No DOM, so blame.test.js
// checks it under `npm test` against real git; editor.js draws it in the gutter.

/** The hash git gives a line no commit has yet. */
export const UNCOMMITTED = '0'.repeat(40)

/**
 * `git blame --porcelain` as `{ lines, commits }`: `lines[i]` is the hash of the commit that last changed line
 * i + 1, and `commits` maps each hash to `{ oid, author, email, time, summary }`, time in seconds.
 */
export function parseBlame(text) {
  const lines = []
  const commits = new Map()
  let current = null
  for (const l of text.split('\n')) {
    if (l.startsWith('\t')) continue // the line's own text
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l)
    if (head) {
      const [, oid, line] = head
      if (!commits.has(oid)) commits.set(oid, { oid, author: '', email: '', time: 0, summary: '' })
      current = commits.get(oid)
      lines[+line - 1] = oid
      continue
    }
    if (!current) continue
    const space = l.indexOf(' ')
    const [key, value] = space < 0 ? [l, ''] : [l.slice(0, space), l.slice(space + 1)]
    if (key === 'author') current.author = value
    else if (key === 'author-mail') current.email = value.replace(/^<|>$/g, '')
    else if (key === 'author-time') current.time = +value
    else if (key === 'summary') current.summary = value
  }
  return { lines, commits }
}

/**
 * The runs of lines one commit changed, in order: `{ from, to, oid }`, 1-based and inclusive. Each run's first
 * line names its commit in the gutter; the rest only carry its color.
 */
export function runs(lines) {
  const out = []
  for (const [i, oid] of lines.entries()) {
    const last = out.at(-1)
    if (last && last.oid === oid && last.to === i) last.to = i + 1
    else out.push({ from: i + 1, to: i + 1, oid })
  }
  return out
}

/** How long ago `seconds` was, in a few letters: today, 3d, 5w, 4mo, 2y. */
export function since(seconds) {
  const days = (Date.now() / 1000 - seconds) / 86400
  if (days < 1) return 'today'
  if (days < 14) return `${Math.floor(days)}d`
  if (days < 61) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30.4)}mo`
  return `${Math.floor(days / 365)}y`
}

/** How recent each commit is among `commits`, from 0 for the oldest to 1 for the newest, by rank. */
export function ages(commits) {
  const sorted = [...commits.values()].filter(c => c.oid !== UNCOMMITTED).sort((a, b) => a.time - b.time)
  const age = new Map(sorted.map((c, i) => [c.oid, sorted.length > 1 ? i / (sorted.length - 1) : 1]))
  age.set(UNCOMMITTED, 1)
  return age
}
