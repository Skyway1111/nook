// Unified diffs as data: parsing git's output, the patch that stages or unstages part of a hunk, and which
// characters changed between a removed line and the added line that replaced it. No DOM, so patch.test.js
// checks all of it under `npm test`, against real git where it applies a patch.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)/

/** A path as git writes it in a header: C-quoted when it holds odd characters, after an `a/` or `b/`. */
function unquote(s) {
  if (s[0] !== '"') return s
  const bytes = []
  const esc = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, '\\': 92 }
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] !== '\\') bytes.push(...new TextEncoder().encode(s[i]))
    else if (/[0-7]/.test(s[i + 1])) bytes.push(parseInt(s.slice(i + 1, (i += 3) + 1), 8))
    else bytes.push(esc[s[++i]] ?? s.charCodeAt(i))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}
const side = line => {
  const p = unquote(line.slice(4).replace(/\t$/, ''))
  return p === '/dev/null' ? null : p.replace(/^[ab]\//, '')
}

/**
 * `git diff` output as files: `{ path, from, header, hunks, notes, added, removed }`. `header` is the file's
 * lines before its first hunk, kept to build patches from. Each hunk is `{ oldStart, oldCount, newStart,
 * newCount, title, lines }`, and each line `{ t, text }` with `t` one of ' ', '+', '-', or '\' (no newline).
 * `notes` are lines that say why a file has no hunks: binary, unreadable. git.rs starts the lines it adds
 * with `\ nook`; the one that says how many untracked files it left out lands in the list's own `notes`.
 */
export function parseDiff(text) {
  const files = []
  files.notes = []
  let file = null
  let hunk = null
  for (const l of text.replace(/\n$/, '').split('\n')) {
    if (l.startsWith('\\ nook left out')) files.notes.push(l.slice(7))
    else if (l.startsWith('diff --git ')) {
      const m = /^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*?)"?$/.exec(l)
      file = { path: m ? m[2] : '', from: null, header: [l], hunks: [], notes: [], added: 0, removed: 0 }
      files.push(file)
      hunk = null
    } else if (!file) continue
    else if (l.startsWith('@@')) {
      const m = HUNK.exec(l)
      if (!m) continue
      hunk = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], title: m[5], lines: [] }
      file.hunks.push(hunk)
    } else if (hunk && (l[0] === ' ' || l[0] === '+' || l[0] === '-' || l[0] === '\\')) {
      hunk.lines.push({ t: l[0], text: l.slice(1) })
      if (l[0] === '+') file.added++
      if (l[0] === '-') file.removed++
    } else if (!hunk) {
      if (l.startsWith('\\ nook ')) file.notes.push(l.slice(2))
      else if (l.startsWith('Binary files')) file.notes.push('Binary file')
      else {
        file.header.push(l)
        if (l.startsWith('+++ ') && side(l)) file.path = side(l)
        else if (l.startsWith('--- ') && side(l)) file.from = side(l)
        else if (l.startsWith('rename to ')) file.path = unquote(l.slice(10))
        else if (l.startsWith('rename from ')) file.from = unquote(l.slice(12))
      }
    }
  }
  for (const f of files) if (f.from === f.path) f.from = null
  return files
}

/**
 * The patch that applies only the changed lines `pick(i)` chooses from `hunk`, or null when it picks none.
 * Forward, for `git apply --cached`, it stages part of an unstaged change: an unpicked addition is left out
 * and an unpicked removal stays as context. Reversed, for `git apply -R`, it unstages or discards part of a
 * change: an unpicked removal is left out and an unpicked addition stays. A new or deleted file that keeps
 * some of its lines becomes a plain edit.
 */
export function patch(file, hunk, pick = () => true, reverse = false) {
  const out = []
  let old = 0
  let now = 0
  let some = false
  let all = true
  let dropped = false
  for (const [i, l] of hunk.lines.entries()) {
    if (l.t === '\\') {
      if (!dropped) out.push('\\' + l.text)
      continue
    }
    dropped = false
    const picked = l.t !== ' ' && pick(i)
    if (l.t !== ' ') (picked ? (some = true) : (all = false))
    if (l.t === ' ' || picked) out.push(l.t + l.text)
    else if ((l.t === '+') !== reverse) {
      dropped = true
      continue
    } else out.push(' ' + l.text)
    const t = out.at(-1)[0]
    if (t !== '+') old++
    if (t !== '-') now++
  }
  if (!some) return null
  let header = file.header.filter(l => !l.startsWith('index '))
  if (!all) {
    const minus = header.find(l => l.startsWith('--- '))
    const plus = header.find(l => l.startsWith('+++ '))
    if (reverse && header.some(l => l.startsWith('new file mode'))) {
      header = header.filter(l => !l.startsWith('new file mode')).map(l => (l === minus ? plus.replace(/^\+\+\+ ("?)b\//, '--- $1a/') : l))
    } else if (!reverse && header.some(l => l.startsWith('deleted file mode'))) {
      header = header.filter(l => !l.startsWith('deleted file mode')).map(l => (l === plus ? minus.replace(/^--- ("?)a\//, '+++ $1b/') : l))
    }
  }
  // An empty side starts at the line before, as git writes it.
  const start = (at, was, n) => (n || !was ? at : Math.max(0, at - 1))
  const range = `@@ -${start(hunk.oldStart, hunk.oldCount, old)},${old} +${start(hunk.newStart, hunk.newCount, now)},${now} @@`
  return [...header, range, ...out, ''].join('\n')
}

/** The `git apply` arguments for a patch from `patch`: `--unidiff-zero` when it has no context to place it by. */
export function applyArgs(text, { cached = false, reverse = false } = {}) {
  const zero = !/^ /m.test(text.slice(text.indexOf('\n@@')))
  return ['apply', '--whitespace=nowarn', ...(cached ? ['--cached'] : []), ...(reverse ? ['-R'] : []), ...(zero ? ['--unidiff-zero'] : []), '-']
}

/** Words, runs of spaces, and single other characters: the units a changed line is compared in. */
const TOKEN = /[\p{L}\p{N}_]+|\s+|./gu

/**
 * Which part of each line changed where a run of removals is followed by a run of additions: the i-th removed
 * line pairs with the i-th added one. Returns a map from line index to `[from, to]`, the changed characters,
 * for each pair similar enough to be worth marking.
 */
export function changedRanges(lines) {
  const marks = new Map()
  for (let i = 0; i < lines.length; ) {
    if (lines[i].t !== '-') { i++; continue }
    const dels = []
    while (i < lines.length && (lines[i].t === '-' || lines[i].t === '\\')) lines[i].t === '-' && dels.push(i), i++
    const adds = []
    while (i < lines.length && (lines[i].t === '+' || lines[i].t === '\\')) lines[i].t === '+' && adds.push(i), i++
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const [a, b] = [lines[dels[k]].text, lines[adds[k]].text]
      const ta = a.match(TOKEN) ?? []
      const tb = b.match(TOKEN) ?? []
      let p = 0
      while (p < ta.length && p < tb.length && ta[p] === tb[p]) p++
      let s = 0
      while (s < ta.length - p && s < tb.length - p && ta[ta.length - 1 - s] === tb[tb.length - 1 - s]) s++
      const len = ts => ts.reduce((n, t) => n + t.length, 0)
      const from = [len(ta.slice(0, p)), len(tb.slice(0, p))]
      const to = [a.length - len(ta.slice(ta.length - s)), b.length - len(tb.slice(tb.length - s))]
      const kept = from[0] + (a.length - to[0])
      // Mostly rewritten: marking nearly everything says nothing the line's color doesn't.
      if (!kept || kept < Math.max(a.length, b.length) * 0.3) continue
      if (to[0] > from[0]) marks.set(dels[k], [from[0], to[0]])
      if (to[1] > from[1]) marks.set(adds[k], [from[1], to[1]])
    }
  }
  return marks
}
