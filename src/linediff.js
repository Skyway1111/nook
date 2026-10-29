// Which lines of a file changed since git's copy of it, for the editor's change bars. Pure, so linediff.test.js
// checks it without a window.

/** Adds `count` lines of `op` to `runs`, a list of `[op, count]`. */
function emit(runs, op, count) {
  if (!count) return
  const last = runs[runs.length - 1]
  if (last?.[0] === op) last[1] += count
  else runs.push([op, count])
}

/** Myers' shortest edit between `x[x0..x1)` and `y[y0..y1)`, two arrays of line ids, added to `ops` as runs; false
 * when it would take more than `limit` lines added and taken out. */
function myers(x, x0, x1, y, y0, y1, limit, ops) {
  // The ends both share first, which is all most stretches between anchors are.
  let head = 0
  while (x0 + head < x1 && y0 + head < y1 && x[x0 + head] === y[y0 + head]) head++
  emit(ops, '=', head)
  x0 += head
  y0 += head
  let same = 0
  while (x0 < x1 - same && y0 < y1 - same && x[x1 - 1 - same] === y[y1 - 1 - same]) same++
  x1 -= same
  y1 -= same
  const n = x1 - x0
  const m = y1 - y0
  if (!n || !m) {
    if (n + m > limit) return false
    emit(ops, '-', n)
    emit(ops, '+', m)
    emit(ops, '=', same)
    return true
  }
  const off = n + m + 1
  const v = new Int32Array(2 * off + 1)
  const trace = [] // v at the start of each round, around the diagonals it can reach
  let end = -1
  for (let d = 0; d <= Math.min(n + m, limit) && end < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let a = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let b = a - k
      while (a < n && b < m && x[x0 + a] === y[y0 + b]) { a++; b++ }
      v[off + k] = a
      if (a >= n && b >= m) { end = d; break }
    }
  }
  if (end < 0) return false
  // Back from the end, one edit a round; the ops come out last first.
  const back = []
  let a = n
  let b = m
  for (let d = end; d >= 0; d--) {
    const t = trace[d]
    const at = k => t[k + d + 1]
    const k = a - b
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevA = at(prevK)
    const prevB = prevA - prevK
    while (a > prevA && b > prevB) { back.push('='); a--; b-- }
    if (d > 0) back.push(a === prevA ? '+' : '-')
    a = prevA
    b = prevB
  }
  for (let i = back.length - 1; i >= 0; i--) emit(ops, back[i], 1)
  emit(ops, '=', same)
  return true
}

/**
 * The edit between `x` and `y`, two arrays of line ids below `size`: runs as `diffLines` gives them, or null. Lines
 * that appear once in each, in the same order, are kept first, as git's patience diff keeps them, so edits spread
 * through a long file cost only the stretches around them; between those, Myers' algorithm finds the shortest edit.
 */
function diffIds(x, y, size, limit) {
  // Each id's count in x and in y, and where it last appears in y.
  const inX = new Int32Array(size)
  const inY = new Int32Array(size)
  const atY = new Int32Array(size)
  for (let i = 0; i < x.length; i++) inX[x[i]]++
  for (let j = 0; j < y.length; j++) { inY[y[j]]++; atY[y[j]] = j }
  // The lines once in each, in x's order, and the longest run of them in y's order too (patience sorting).
  const pairs = []
  for (let i = 0; i < x.length; i++) if (inX[x[i]] === 1 && inY[x[i]] === 1) pairs.push(i)
  const tails = [] // tails[k]: the pair ending the best run of length k + 1 so far
  const prev = new Int32Array(pairs.length)
  for (let p = 0; p < pairs.length; p++) {
    const j = atY[x[pairs[p]]]
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (atY[x[pairs[tails[mid]]]] < j) lo = mid + 1
      else hi = mid
    }
    prev[p] = lo ? tails[lo - 1] : -1
    tails[lo] = p
  }
  const anchors = [] // [i, j], last first
  for (let p = tails.length ? tails[tails.length - 1] : -1; p >= 0; p = prev[p]) anchors.push([pairs[p], atY[x[pairs[p]]]])
  anchors.reverse()
  anchors.push([x.length, y.length])
  const runs = []
  let i = 0
  let j = 0
  for (const [ai, aj] of anchors) {
    if (!myers(x, i, ai, y, j, aj, limit, runs)) return null
    if (ai < x.length) emit(runs, '=', 1)
    i = ai + 1
    j = aj + 1
  }
  return runs
}

/** Line ids for each array of lines git's copy gave, kept while the editor holds that copy, so an edit maps only
 * its own text. */
const BASES = new WeakMap()

/**
 * The edit from lines `a` to lines `b`: a list of `['=' | '-' | '+', count]` runs, or null when a stretch between
 * two lines both share would take more than `limit` lines added and taken out.
 */
export function diffLines(a, b, limit = 1000) {
  const ids = new Map()
  const id = line => {
    let n = ids.get(line)
    if (n === undefined) ids.set(line, (n = ids.size))
    return n
  }
  const x = Int32Array.from(a, id)
  const y = Int32Array.from(b, id)
  return diffIds(x, y, ids.size, limit)
}

/**
 * What changed from `before` to `after`, two arrays of lines, in `after`'s 1-based line numbers: `{ kind: 'add',
 * from, to }` for lines that are new, `{ kind: 'change', from, to }` for lines that replaced others, and
 * `{ kind: 'delete', at }` where lines were taken out just above line `at` (one past the last line at the end).
 * When a stretch takes more than `limit` lines added and taken out, everything between the ends both share counts
 * as changed. In a long file the limit shrinks, so that the search stays a few milliseconds' work while you type.
 * `before`'s line ids are kept with it, so pass the same array again as `after` changes.
 */
export function lineChanges(before, after, limit = 1000) {
  let base = BASES.get(before)
  if (!base) {
    const ids = new Map()
    const x = new Int32Array(before.length)
    for (let i = 0; i < before.length; i++) {
      let n = ids.get(before[i])
      if (n === undefined) ids.set(before[i], (n = ids.size))
      x[i] = n
    }
    BASES.set(before, (base = { ids, x }))
  }
  // Lines git's copy doesn't have get ids past its own, in a map of their own, so the kept one doesn't grow.
  const novel = new Map()
  const y = new Int32Array(after.length)
  for (let j = 0; j < after.length; j++) {
    let n = base.ids.get(after[j])
    if (n === undefined) {
      n = novel.get(after[j])
      if (n === undefined) novel.set(after[j], (n = base.ids.size + novel.size))
    }
    y[j] = n
  }
  const all = base.x
  let head = 0
  while (head < all.length && head < y.length && all[head] === y[head]) head++
  let tail = 0
  while (tail < all.length - head && tail < y.length - head && all[all.length - 1 - tail] === y[y.length - 1 - tail]) tail++
  const x = all.subarray(head, all.length - tail)
  const z = y.subarray(head, y.length - tail)
  if (!x.length && !z.length) return []
  const runs = diffIds(x, z, base.ids.size + novel.size, Math.min(limit, Math.max(64, Math.floor(2e7 / (x.length + z.length)))))
    ?? [['-', x.length], ['+', z.length]].filter(r => r[1])
  const out = []
  let line = head + 1 // in `after`
  let removed = 0
  let added = 0
  const flush = () => {
    if (added) out.push({ kind: removed ? 'change' : 'add', from: line - added, to: line - 1 })
    else if (removed) out.push({ kind: 'delete', at: line })
    removed = added = 0
  }
  for (const [op, count] of runs) {
    if (op === '=') { flush(); line += count }
    else if (op === '-') removed += count
    else { added += count; line += count }
  }
  flush()
  return out
}
