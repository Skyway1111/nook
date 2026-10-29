// Finding paths in a row of terminal text, with no DOM or Tauri, so `npm test` checks it without a window.
import { path as paths } from './paths.js'

const NAME = String.raw`[\p{L}\p{N}_.@+~-]`
const PART = `${NAME}+`
const ALTERNATIVES = [
  String.raw`[A-Za-z]:[\\/](?:${PART}[\\/]?)*`, // C:\Users\Ada\x.txt, C:/x
  String.raw`(?:~|\.{1,2})?(?:/${PART})+/?`, // /etc/hosts, ~/x, ./x, ../x
  String.raw`${PART}(?:[\\/]${PART})+[\\/]?`, // src/main.js, src\main.js
  String.raw`${NAME}*\p{L}${NAME}*\.\p{L}[\p{L}\p{N}]{0,9}`, // main.js, README.md
]
// :12, :12:5, #L12, or (12,5) as compilers write them
const SUFFIX = String.raw`(?::(\d+)(?::(\d+))?|#L(\d+)|\((\d+)(?:,\s*(\d+))?\))?`
const PATH = new RegExp(`(?<![\\p{L}\\p{N}_.@+~/\\\\-])(${ALTERNATIVES.join('|')})${SUFFIX}`, 'gu')
// Claude's tool calls name the file whole, spaces and all.
const TOOL = /\b(?:Read|Update|Write|Edit|MultiEdit|Create|NotebookEdit|NotebookRead)\(([^()]+?)\)/g
const URL_ = /\b[a-z][\w+.-]*:\/\/\S+/gi

/** The paths in a row of text: `{ start, end, path, line, col }`, where `start` and `end` index `text`
 * and `line` and `col` are 1-based or undefined. A path may not exist. */
export function findPaths(text) {
  const taken = [] // [start, end) ranges a link already covers
  const free = (s, e) => !taken.some(([a, b]) => s < b && a < e)
  for (const m of text.matchAll(URL_)) taken.push([m.index, m.index + m[0].length])
  const found = []
  for (const m of text.matchAll(TOOL)) {
    const inner = m[1].split(/ · |, /)[0].trim() // `Read(x.js · lines 1-40)`
    const start = m.index + m[0].indexOf(inner)
    const end = start + inner.length
    if (!inner || !free(start, end)) continue
    taken.push([start, end])
    const at = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(inner)
    found.push({ start, end, path: at[1], line: num(at[2]), col: num(at[3]) })
  }
  for (const m of text.matchAll(PATH)) {
    let path = m[1]
    let end = m.index + m[0].length
    if (m[0].length === path.length) { // a sentence's last word: `see main.js.`
      const trimmed = path.replace(/[.\-]+$/, '')
      end -= path.length - trimmed.length
      path = trimmed
    }
    if (!path || /^[.~/\\]+$/.test(path) || !free(m.index, end)) continue
    taken.push([m.index, end])
    found.push({ start: m.index, end, path, line: num(m[2] ?? m[4] ?? m[5]), col: num(m[3] ?? m[6]) })
  }
  return found.sort((a, b) => a.start - b.start)
}
const num = s => (s ? Number(s) : undefined)

/** Where `raw` may be on disk, most likely first: as written, or under `cwd`, and without diff's `a/` and
 * `b/`. `p` is `paths` or the other system's rules, for tests. */
export function candidates(raw, { cwd, home }, p = paths) {
  let rel = raw
  if (raw.startsWith('file://')) return [p.fromUrl(new URL(raw).pathname)]
  if (/^~[\\/]/.test(raw)) {
    if (!home) return []
    return [p.normalize(p.join(home, raw.slice(2).replaceAll('/', p.SEP)))]
  }
  if (p.isAbsolute(raw)) return [p.normalize(raw)]
  if (!cwd) return []
  rel = raw.replace(/^\.[\\/]/, '')
  const out = []
  const under = r => {
    let dir = cwd
    for (const part of r.split(/[\\/]/)) {
      if (part === '..') dir = p.parent(dir) ?? dir
      else if (part && part !== '.') dir = p.join(dir, part)
    }
    out.push(dir)
  }
  under(rel)
  if (/^[ab][\\/]/.test(rel)) under(rel.slice(2))
  return out
}

/** A file:// URL as `{ path, line }`, its line from a `#L12` or `#12` fragment. */
export function fileUrl(uri, p = paths) {
  const url = new URL(uri)
  const line = num(/^#L?(\d+)/.exec(url.hash)?.[1])
  return { path: p.fromUrl(url.pathname), line }
}

// A row of Claude's diff under an edit: the line number, then a space, a `+` or `-`, and the code.
const DIFF = /^(\s*(?:⎿\s+)?)(\d{1,6}) {1,2}[ +-]/
const EDIT = /\b(?:Update|Edit|MultiEdit|Write|Create)\(([^()]+?)\)/

/** The line number that starts a row of Claude's diff: `{ start, end, line }`, or null. */
export function diffLine(text) {
  const m = DIFF.exec(text)
  return m && { start: m[1].length, end: m[1].length + m[2].length, line: Number(m[2]) }
}

/** The file a row names as an edit's header, `⏺ Update(src/main.js)`, or null. */
export function editedPath(text) {
  return EDIT.exec(text)?.[1].split(/ · |, /)[0].trim() || null
}
