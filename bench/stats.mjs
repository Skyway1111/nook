// What the benches share: the identity they build nook as, medians, and when a change from one build to another is
// worse than its noise.
import { existsSync, readFileSync } from 'fs'

// Every build a bench runs is nook as dev.nook.bench, with its own settings and profile, never the user's.
export const ID = 'dev.nook.bench'
/** Whether `bin` is nook built as ID: it names ID, in UTF-8 or UTF-16, and not nook's own identity. */
export function benched(bin) {
  const bytes = existsSync(bin) && readFileSync(bin)
  const names = id => bytes.includes(id) || bytes.includes(Buffer.from(id, 'utf16le'))
  return !!bytes && names(ID) && !names('dev.nook.app')
}

export const sorted = xs => [...xs].filter(Number.isFinite).sort((a, b) => a - b)
export const median = xs => { const s = sorted(xs); return s.length ? s[Math.floor(s.length / 2)] : NaN }
export const quantile = (xs, q) => { const s = sorted(xs); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN }
export const f = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '-')

const RELATIVE = 0.05 // a change must exceed this share of base
const SURE = 2.5 // and this many standard errors of the change, from how much each build's own numbers spread

/** The standard deviation `xs` suggest: from their range when few, as the range of n draws runs to d2(n)
 * deviations, and from their interquartile range when there are enough that one outlier shouldn't set it. */
export function deviation(xs) {
  const s = sorted(xs)
  if (s.length < 2) return 0
  if (s.length >= 8) return (quantile(s, 0.75) - quantile(s, 0.25)) / 1.349
  const d2 = [0, 0, 1.128, 1.693, 2.059, 2.326, 2.534, 2.704][s.length]
  return (s.at(-1) - s[0]) / d2
}

/** How far apart two builds' medians can land by chance: SURE standard errors of their difference. A
 * median of n has a standard error of about 1.25 deviations over the root of n. */
export function noise(a, b) {
  const se = xs => (1.2533 * deviation(xs)) / Math.sqrt(Math.max(1, sorted(xs).length))
  return SURE * Math.hypot(se(a), se(b))
}

/** The change from `a` to `b` that counts as worse: the largest of `floor`, RELATIVE of a's median, and noise. */
export const bar = (a, b, floor) => Math.max(floor, RELATIVE * Math.abs(median(a)), noise(a, b))

/** The change from `then` to `now` in medians, the bar it must pass to count as worse, and whether it does. */
export function judge(then, now, floor) {
  const delta = median(now) - median(then)
  const most = bar(then, now, floor)
  return { delta, bar: most, worse: delta > most }
}

/** Prints a table of `metrics`, each [key, label, digits, floor], for `builds`, whose numbers `values(build, key)`
 * gives: each build's median (min-max), then the change from each earlier build to the last, flagged WORSE past
 * its bar, which follows the ±. Returns how many changes were flagged. */
export function table(builds, metrics, values) {
  const last = builds.length - 1 // the build under test; every earlier one is a base it must match or beat
  const bases = builds.slice(0, last)
  const cell = (r, key, d) => {
    const xs = sorted(values(r, key))
    return `${f(median(xs), d)} (${f(xs[0], d)}-${f(xs.at(-1), d)})`
  }
  console.log('metric'.padEnd(20) + builds.map((_, i) => `[${i}]`.padEnd(24)).join('') + bases.map((_, i) => `[${last}] vs [${i}]`.padEnd(30)).join(''))
  let worse = 0
  for (const [key, label, d, floor] of metrics) {
    let line = label.padEnd(20) + builds.map(r => cell(r, key, d).padEnd(24)).join('')
    const now = values(builds[last], key)
    for (const base of bases) {
      const then = values(base, key)
      const a = median(then)
      const { delta, bar: most, worse: flagged } = judge(then, now, floor)
      if (flagged) worse++
      line += `${delta >= 0 ? '+' : ''}${f(delta, d)}${a ? ` (${delta >= 0 ? '+' : ''}${f((100 * delta) / a, 0)}%)` : ''} ±${f(most, d)}${flagged ? ' WORSE' : ''}`.padEnd(30)
    }
    console.log(line.trimEnd())
  }
  return worse
}
