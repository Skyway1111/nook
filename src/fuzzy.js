// Fuzzy matching for quick open and the command palette. Pure, so fuzzy.test.js runs it without a window.
// A query's letters must appear in order. A match scores higher where its letters run together, start words
// (after / _ - . or a space, or at a capital), or fall in the file's name rather than its folders.

const BOUNDARY = /[\\/_\-. ]/

/** How much a match at `i` in `text` earns on its own: more at the start of a word. */
function bonus(text, i) {
  if (i === 0) return 8
  const before = text[i - 1]
  if (before === '/' || before === '\\') return 9
  if (BOUNDARY.test(before)) return 7
  const c = text[i]
  if (c !== c.toLowerCase() && before === before.toLowerCase()) return 6 // camelCase
  return 0
}

/**
 * Where `query` (lowercase, no spaces) matches `text`, whose lowercase is `lower`, searching from `from`:
 * `{ score, positions }`, or null. The match is the tightest one that ends where the first in-order match
 * ends, found by walking back from that end, as fzf's first algorithm does.
 */
export function match(query, text, lower = text.toLowerCase(), from = 0) {
  if (!query) return { score: 0, positions: [] }
  let qi = 0
  let end = -1
  for (let i = from; i < lower.length; i++) {
    if (lower[i] === query[qi] && ++qi === query.length) { end = i; break }
  }
  if (end < 0) return null
  // Walk back for the latest start, so `src/index.js` matches "ix" at "index", not at "src/i...x".
  qi = query.length - 1
  let start = end
  for (let i = end; i >= from; i--) {
    if (lower[i] === query[qi] && --qi < 0) { start = i; break }
  }
  // Forward again from that start, preferring a word start or a run when either is near.
  const positions = []
  let score = 0
  let prev = -2
  let run = 0 // the bonus of the letter that started the current run, which the rest of the run keeps
  qi = 0
  for (let i = start; i <= end && qi < query.length; i++) {
    if (lower[i] !== query[qi]) continue
    let b = bonus(text, i)
    if (i === prev + 1) b = Math.max(b, run, 5)
    else {
      if (prev >= 0) score -= 3 + Math.min(i - prev - 2, 5) // a gap: opening one costs most
      run = b
    }
    score += 1 + b
    positions.push(i)
    prev = i
    qi++
  }
  return { score, positions }
}

/** Splits a query on spaces into lowercase terms. */
export const terms = query => query.toLowerCase().split(/\s+/).filter(Boolean)

/**
 * A path's score for `terms`, or null when a term doesn't match. Each term tries the file's name first, since
 * that's what people type, then the whole path. `lower` is `path` lowercased.
 */
export function scorePath(terms, path, lower = path.toLowerCase()) {
  const slash = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'))
  let score = 0
  const positions = []
  for (const term of terms) {
    const inName = match(term, path, lower, slash + 1)
    const found = inName ?? match(term, path, lower)
    if (!found) return null
    // A name match is worth more, and most of all when the name starts with the term.
    score += found.score + (inName ? 10 + (inName.positions[0] === slash + 1 ? 12 : 0) : 0)
    positions.push(...found.positions)
  }
  // Shorter paths win ties: `main.rs` over `tests/fixtures/main.rs`.
  score -= path.length / 50
  return { score, positions: [...new Set(positions)].sort((a, b) => a - b) }
}

/**
 * The best `limit` of `items` for `query`, best first, each `{ item, score, positions }`. `text(item)` is what
 * matches, `lower(item)` its lowercase (cached by the caller for a big list), and `boost(item)` adds to a
 * score, for recent files. An empty query keeps the items' order.
 */
export function rank(query, items, { text = String, lower = i => text(i).toLowerCase(), boost = () => 0, limit = 50 } = {}) {
  const ts = terms(query)
  if (!ts.length) {
    const boosted = []
    const rest = []
    for (const item of items) {
      const score = boost(item)
      if (score) boosted.push({ item, score, positions: [] })
      else if (rest.length < limit) rest.push({ item, score, positions: [] })
    }
    return [...boosted.sort((a, b) => b.score - a.score), ...rest].slice(0, limit)
  }
  const best = [] // ascending by score, so best[0] is the one to drop
  for (const item of items) {
    const found = scorePath(ts, text(item), lower(item))
    if (!found) continue
    const score = found.score + boost(item)
    if (best.length === limit && score <= best[0].score) continue
    let i = best.findIndex(b => b.score > score) // `limit` is small, so a scan beats a heap
    if (i < 0) i = best.length
    best.splice(i, 0, { item, score, positions: found.positions })
    if (best.length > limit) best.shift()
  }
  return best.reverse()
}
