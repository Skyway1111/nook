// How far along a fetch, pull, or push is, from the progress git writes. No DOM, so progress.test.js checks it.

/**
 * How far along a fetch, pull, or push is, from a line of git's progress: the share of the work done, from 0 to
 * 1, never moving back. Receiving and writing objects is most of it; counting and resolving go quickly.
 */
export function progressOf(line, done = 0) {
  const m = /(Counting|Compressing|Receiving|Resolving|Writing) (?:objects|deltas):\s+(\d+)%/.exec(line)
  if (!m) return { line, done }
  const [from, to] = { Counting: [0, 0.05], Compressing: [0.05, 0.1], Receiving: [0.1, 0.85], Writing: [0.1, 0.95], Resolving: [0.85, 1] }[m[1]]
  return { line, done: Math.max(done, from + ((to - from) * m[2]) / 100) }
}
