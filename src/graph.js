// The history tab's commits as data: `git log` parsed, and the graph laid out in lanes, a page at a time.
// No DOM, so graph.test.js checks it under `npm test`.

/** The `--format` that parseLog reads: fields split by \x1f, commits ended by \x1e. Run with `--decorate=full`. */
export const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e'

/** `git log --format=LOG_FORMAT` as `{ oid, parents, author, email, time, refs, subject }`, time in seconds. */
export function parseLog(text) {
  const commits = []
  for (const record of text.split('\x1e')) {
    const [oid, parents, author, email, time, refs, subject] = record.replace(/^\n/, '').split('\x1f')
    if (!oid || subject === undefined) continue
    commits.push({ oid, parents: parents ? parents.split(' ') : [], author, email, time: +time, refs: parseRefs(refs), subject })
  }
  return commits
}

/**
 * The names on a commit, from `%D` with full ref names: `{ name, kind }`, kind one of head (the branch checked
 * out), branch, remote, tag, or detached (HEAD itself, when no branch is checked out).
 */
export function parseRefs(text) {
  if (!text) return []
  const refs = []
  for (let part of text.split(', ')) {
    let kind = null
    if (part === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'detached' })
      continue
    }
    if (part.startsWith('HEAD -> ')) (part = part.slice(8)), (kind = 'head')
    if (part.startsWith('tag: ')) part = part.slice(5)
    if (part.startsWith('refs/heads/')) refs.push({ name: part.slice(11), kind: kind ?? 'branch' })
    else if (part.startsWith('refs/remotes/')) part.endsWith('/HEAD') || refs.push({ name: part.slice(13), kind: 'remote' })
    else if (part.startsWith('refs/tags/')) refs.push({ name: part.slice(10), kind: 'tag' })
  }
  // The branch checked out first, then other branches, tags, and remotes.
  const order = { head: 0, detached: 0, branch: 1, tag: 2, remote: 3 }
  return refs.sort((a, b) => order[a.kind] - order[b.kind])
}

/**
 * Lays out `commits` in lanes: each gets `col`, its lane, and `edges`, the lines through its row as
 * `[x1, y1, x2, y2, lane]`, x in lanes, y 0 at the row's top, 1 at the commit's dot, and 2 at its bottom, and
 * lane the one whose color it takes. git log writes children before parents, unless a clock was wrong when a
 * commit was made: a parent already laid out gets no lane, or the lane would wait for it forever.
 * `state` carries what each lane waits for below the last row, and the commits laid out: pass back what this
 * returns to lay out the next page.
 */
export function layout(commits, state = { lanes: [], seen: new Set() }) {
  const { lanes, seen } = state
  const free = () => {
    const i = lanes.indexOf(null)
    return i < 0 ? lanes.length : i
  }
  for (const c of commits) {
    seen.add(c.oid)
    const above = lanes.slice()
    let col = lanes.indexOf(c.oid)
    if (col < 0) col = free() // a branch's tip: nothing above leads to it
    const edges = []
    for (const [i, oid] of above.entries()) {
      if (oid === null) continue
      if (oid === c.oid) {
        // Every lane waiting for this commit ends at its dot; the first carries on below.
        edges.push([i, 0, col, 1, i])
        lanes[i] = null
      } else edges.push([i, 0, i, 2, i])
    }
    const [first, ...rest] = c.parents.filter(p => !seen.has(p))
    lanes[col] = first ?? null
    if (first) edges.push([col, 1, col, 2, col])
    for (const p of rest) {
      let j = lanes.indexOf(p)
      if (j < 0) lanes[(j = free())] = p
      edges.push([col, 1, j, 2, j])
    }
    while (lanes.length && lanes.at(-1) === null) lanes.pop()
    c.col = col
    c.edges = edges
    c.width = Math.max(above.length, lanes.length, col + 1)
  }
  return state
}
