// Tells nook's composer what to show beside Claude's prompt, runs the two commands its menus send, and
// draws pictures in the transcript: ones Claude read, an SVG it wrote, ones a shell command wrote, ones a reply links, and a reply's diagrams and formulas, with its inline math written in plain symbols. Every hook passes its event on unchanged, and the render hooks add
// pictures under Claude's own drawing, and under a shell command's result the line that says how it went. The mod writes the session's model, effort, effort levels, context
// fill, pasted images' folder, and what the session is doing as JSON to NOOK_STATE, and reads requests from
// the .cmd file beside it: { command, args, at }.
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] // the menu's aliases, each its family's latest model
const ROWS = 20 // the tallest picture, in rows
const ROW_PIXELS = 20 // a picture's pixels per row, so a small one draws near its own size
const INDENT = 5 // to the text after `  ⎿  `
const UNKNOWN = [1600, 900] // the size of a picture whose own can't be read
const LETTER = [612, 792] // a PDF page whose own size can't be read, in points
const PAGE = [1280, 800] // the window an HTML page Claude writes is drawn in
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) // the tools whose file nook marks as Claude's
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode']) // the tools that wait on the person
const TOUCHED = 200 // the most files a report lists
const sizes = new Map() // a pasted image's path -> its size, as a promise
const MADE = 3 // the most pictures shown under a command that wrote them
const made = new Map() // a Bash call's tool_use_id -> the pictures it wrote, as a promise of [path, size]
const MERMAID = /^```mermaid[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm // a reply's mermaid blocks, each closed
const MATH = /^[ \t]*(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*$/gm // a reply's display formulas, $$ … $$ or \[ … \], on lines of their own
const MATH_ROWS = 20 // the tallest formula, in rows
// An inline formula's TeX commands, and what each writes in plain text
const SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  neq: '≠', ne: '≠', leq: '≤', le: '≤', geq: '≥', ge: '≥', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', propto: '∝',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', iff: '⇔', implies: '⇒', mapsto: '↦',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃',
  neg: '¬', land: '∧', lor: '∨', wedge: '∧', vee: '∨', oplus: '⊕', otimes: '⊗', circ: '∘', ldots: '…', cdots: '⋯', dots: '…',
  mid: '∣', ell: 'ℓ', hbar: 'ħ', langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', prime: '′',
  log: 'log', ln: 'ln', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan', max: 'max', min: 'min', lim: 'lim', det: 'det',
  mathbb: '', mathrm: '', text: '', mathbf: '', mathit: '', operatorname: '', left: '', right: '', quad: ' ', qquad: '  ',
}
const BLACKBOARD = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', E: '𝔼' }
const SUP = Object.fromEntries([...'0123456789+-=()ni'].map((c, i) => [c, '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ'[i]]).concat([['k', 'ᵏ'], ['T', 'ᵀ'], ['x', 'ˣ'], ['m', 'ᵐ'], ['t', 'ᵗ']]))
const SUB = Object.fromEntries([...'0123456789+-=()aeoxijklmnpst'].map((c, i) => [c, '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓᵢⱼₖₗₘₙₚₛₜ'[i]]))
// $…$ in a sentence: opened before a non-space, closed after one and not before a digit, so $5 and $10 stay
const INLINE = /(?<![\\$\w])\$(?=[^\s$])((?:\\.|[^$\n\\])+?)(?<=[^\s\\])\$(?![\d$])/g

const DIAGRAM_ROWS = 40 // the tallest diagram, in rows
const REPLY_INDENT = 2 // to the text after a reply's `● `
const saved = new Set() // the diagram files written this session
const LINK = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)/g // Markdown's ![alt](path "title")
const LINKED = 4 // the most pictures a reply draws
const linked = new Map() // a picture a reply links -> its [path, size], or null when it's no picture file, as a promise
const PICTURE = /\.(?:png|jpe?g|gif|webp|svg)$/i
const TAIL = 64 * 1024 // the end of a command's output that its outcome is read from
const SLOW = 3000 // ms past which a command's outcome line says how long it took
const TIMES = 500 // the most commands whose run time is kept
const times = new Map() // a Bash call's tool_use_id -> ms it ran
const GROUP_ROWS = 6 // the most outcome rows under a folded run of calls
const READ_NAMES = 8 // the most files the row of a folded run's reads names
// What Claude reads, in a tab nook started, about what nook draws in its replies.
const DRAWS = 'This terminal is nook, which draws more than text in your replies: a ```mermaid code block shows as a diagram, '
  + 'display math on lines of its own ($$ … $$ or \\[ … \\]) is typeset, inline $…$ math shows as Unicode symbols, and a '
  + 'Markdown image link to a local picture file, like ![loss](out/loss.png), shows the picture after its paragraph. '
  + 'Pictures you read and pictures your commands save show in the transcript too (a PDF as its first page), and an HTML file you write shows '
  + 'as a preview of the page, with its scripts off. Use these when a diagram, formula, '
  + 'or picture makes an answer clearer, not for decoration.'
let state = { efforts: LEVELS }
let wrote = ''
let handled = '' // the last request run, so each runs once

async function report($, file, patch) {
  state = { ...state, ...patch }
  const text = JSON.stringify(state)
  if (text !== wrote) await $.fs.write(file, (wrote = text))
}

/** The context window's fill, what the session has cost in US dollars, and the account's rate-limit windows,
 * from `$.session.usage()`, for nook's dashboard. */
export const spent = ({ context, cost, rateLimits = [] }) => ({
  context, cost: cost?.usd ?? 0, limits: rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, used: percentUsed, resetsAt })),
})

/** The model, the menu's aliases that Claude offers, and the model's saved effort when it changes. */
async function model($) {
  const id = await $.session.model()
  if (id === state.model) return {}
  const row = (await $.config.list()).find(r => r.key === 'model')
  const { modelSettings, effortLevel } = await $.settings.read()
  const effort = modelSettings?.[id.replace(/\[.*\]$/, '')]?.effortLevel ?? effortLevel
  return { model: id, models: MODELS.filter(a => row?.options?.includes(a)), ...(effort && { effort }) }
}

/** One line about a tool call, as the tab strip and the dashboard show it: the tool and what it works on. */
function activity(e) {
  const name = path => String(path).split(/[\\/]/).pop()
  const cut = text => String(text).split('\n')[0].slice(0, 80)
  const what = e.file_path ? name(e.file_path) : e.notebook_path ? name(e.notebook_path) : e.command ? cut(e.command)
    : e.description ? cut(e.description) : e.pattern ? cut(e.pattern) : e.url ? cut(e.url) : e.query ? cut(e.query) : ''
  return what ? `${e.tool} · ${what}` : String(e.tool)
}

/** Runs a request from nook's menus, if one arrived: `/model <alias>` or `/effort <level>`. */
async function take($, file) {
  const text = await $.fs.read(file).catch(() => '')
  if (!text || text === handled) return {}
  handled = text
  let request
  try {
    request = JSON.parse(text)
  } catch {
    return {} // caught mid-write; the whole request differs, so the next tick runs it
  }
  const { command, args } = request
  const ok = command === 'effort' ? LEVELS.includes(args) : command === 'model' && state.models?.includes(args)
  if (!ok) return {}
  await $.command.run({ command, args })
  return command === 'effort' ? { effort: args } : {}
}

/** Claude's drawing of a transcript row, with a picture of each [path, [width, height]] under it. */
function withPictures($, e, theirs, pictures) {
  const { Box, Image } = $.ui.resolve(e)
  const room = Math.min(255, (e.viewport?.columns ?? 80) - INDENT - 1)
  return Box({ flexDirection: 'column', children: [theirs, ...pictures.map(([path, size]) => picture(Box, Image, path, size, room, INDENT))] })
}

/** A picture of `path`, `indent` columns in and at most `room` wide, at its own shape. */
function picture(Box, Image, path, size, room, indent) {
  const [w, h] = size[0] > 0 && size[1] > 0 ? size : UNKNOWN
  // A cell is about twice as tall as it is wide.
  let rows = Math.min(ROWS, Math.ceil(h / ROW_PIXELS))
  let columns = Math.max(1, Math.round((2 * rows * w) / h))
  if (columns > room) [columns, rows] = [room, Math.max(1, Math.round((room * h) / (2 * w)))]
  // nook decodes the file itself, so `png` stands for JPEG, GIF, WebP, and SVG too.
  const image = Image({ source: { file: path, format: 'png' }, columns, rows, alt: path.split(/[\\/]/).pop() })
  return Box({ paddingLeft: indent, children: [image] })
}

/** The [width, height] of the picture a Read call read, or null for any other file. With `pdf`, in a tab
 * nook started, a PDF's first page counts as a picture: nook draws it. */
function readSize(path, output, pdf) {
  if (pdf && output?.type === 'pdf') return headerSize(atob(String(output.file.base64 ?? '').slice(0, 256 * 1024))) ?? LETTER
  if (pdf && output?.type === 'parts') return LETTER // the pages Claude was sent as pictures; the file may be large
  if (output?.type === 'image') {
    const d = output.file.dimensions ?? {}
    return [d.originalWidth ?? d.displayWidth, d.originalHeight ?? d.displayHeight]
  }
  if (output?.type !== 'text' || !/\.svg$/i.test(path)) return null
  return svgSize(output.file.content) ?? UNKNOWN
}

/** A PNG's, JPEG's, GIF's, or WebP's [width, height], from its first bytes as a binary string, or null. */
export function headerSize(head) {
  if (head.startsWith('%PDF')) return pageSize(head)
  const u8 = at => head.charCodeAt(at)
  const be = (at, n) => Array.from({ length: n }, (_, i) => u8(at + i)).reduce((v, b) => v * 256 + b, 0)
  const le = (at, n) => Array.from({ length: n }, (_, i) => u8(at + i)).reduceRight((v, b) => v * 256 + b, 0)
  if (head.startsWith('\x89PNG')) return [be(16, 4), be(20, 4)]
  if (head.startsWith('GIF8')) return [le(6, 2), le(8, 2)]
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') {
    const chunk = head.slice(12, 16)
    if (chunk === 'VP8X') return [1 + le(24, 3), 1 + le(27, 3)]
    if (chunk === 'VP8L') return [1 + (le(21, 2) & 0x3fff), 1 + ((le(22, 3) >> 6) & 0x3fff)]
    if (chunk === 'VP8 ') return [le(26, 2) & 0x3fff, le(28, 2) & 0x3fff]
    return null
  }
  if (u8(0) !== 0xff || u8(1) !== 0xd8) return null
  // A JPEG's size is in its first start-of-frame segment, past the segments before it, EXIF's among them.
  for (let at = 2; at + 9 < head.length && u8(at) === 0xff;) {
    const kind = u8(at + 1)
    if (kind >= 0xc0 && kind <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(kind)) return [be(at + 7, 2), be(at + 5, 2)]
    at += 2 + be(at + 2, 2)
  }
  return null
}

/** A PDF's first page's [width, height] in points, from the first /MediaBox in `head` and a quarter turn if
 * its page says /Rotate 90 or 270, or LETTER when it's past `head` or in a compressed object stream. */
export function pageSize(head) {
  const box = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(head)
  if (!box) return LETTER
  const [x0, y0, x1, y1] = box.slice(1).map(Number)
  const [w, h] = [Math.abs(x1 - x0), Math.abs(y1 - y0)]
  if (!(w > 0 && h > 0)) return LETTER
  const page = head.slice(head.lastIndexOf('obj', box.index), head.indexOf('endobj', box.index) >>> 0)
  return /\/Rotate\s+(?:90|270)\b/.test(page) ? [h, w] : [w, h]
}

/** A picture file's [width, height] from its header, or UNKNOWN when it can't be read. */
async function bytesSize($, path) {
  const { base64 } = await $.fs.read(path, { as: 'bytes' })
  return headerSize(atob(base64.slice(0, 256 * 1024))) ?? UNKNOWN // EXIF can push a JPEG's size past its first 64 KB
}

/** The folder Claude saves the session's nth pasted image to, as <n>.png. nook's `session_image` reads it from the report. */
async function imagesDir($) {
  const slug = (await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-')
  const temp = (await $.env.get('NOOK_CLAUDE_TEMP')) || `${await $.env.get('TEMP')}\\claude`
  return [temp, slug, await $.session.id(), 'images'].join(sep(temp))
}

/** The separator `path` is written with: Windows' backslash, or a slash. */
const sep = path => (path.includes('\\') ? '\\' : '/')

/** The images pasted into a prompt, as [path, size]. */
async function pasted($, text) {
  const dir = await imagesDir($)
  const pictures = []
  for (const n of new Set(Array.from(text.matchAll(/\[Image #(\d+)\]/g), m => m[1]))) {
    const path = `${dir}${sep(dir)}${n}.png`
    if (!(await $.fs.exists(path))) continue
    if (!sizes.has(path)) sizes.set(path, bytesSize($, path).catch(() => UNKNOWN)) // past 4 MiB, $.fs.read refuses
    pictures.push([path, await sizes.get(path)])
  }
  return pictures
}

/** A picture file's [width, height]: its header, an SVG's viewBox, or UNKNOWN when neither can be read. */
async function pictureSize($, path) {
  if (!/\.svg$/i.test(path)) return bytesSize($, path).catch(() => UNKNOWN) // past 4 MiB, $.fs.read refuses
  return svgSize(await $.fs.read(path).catch(() => '')) ?? UNKNOWN
}

/** An SVG's [width, height] from its viewBox, or null without one. */
function svgSize(text) {
  const box = /viewBox\s*=\s*["'][^"']*?([\d.]+)[\s,]+([\d.]+)\s*["']/.exec(text)
  return box ? [Number(box[1]), Number(box[2])] : null
}

const LOOKS = /^(?:cd|ls|cat|head|tail|less|wc|echo|git|rg|grep|egrep|find|fd|which|pwd|stat|file)\b/ // commands that write no files

/** The pictures a shell command wrote while it ran, three at most, as [path, size]: picture files its
 * command or output names, and new ones in the session's folder, such as a plot a script saved. A file
 * counts when it changed since `start`, less two seconds for file systems that keep coarse times. */
export async function picturesMade($, command, stdout, start, root, pdf = false) {
  const s = sep(root)
  const absolute = p => (/^(?:[a-zA-Z]:)?[\\/]/.test(p) ? p : `${root}${s}${p.replace(/^\.[\\/]/, '')}`)
  const kinds = pdf ? 'png|jpe?g|gif|webp|svg|pdf' : 'png|jpe?g|gif|webp|svg'
  const shown = name => PICTURE.test(name) || (pdf && /\.pdf$/i.test(name))
  const named = Array.from(`${command}\n${stdout.slice(-TAIL)}`.matchAll(new RegExp(`(?:[a-zA-Z]:)?[^\\s'"\`(),=:;|<>]+\\.(?:${kinds})\\b`, 'gi')), m => absolute(m[0]))
  const fresh = LOOKS.test(command.trim()) ? [] : (await $.fs.list(root).catch(() => []))
    .filter(f => f.kind === 'file' && shown(f.name) && f.mtimeMs >= start - 2000)
    .map(f => `${root}${s}${f.name}`)
  const pictures = []
  for (const path of new Set([...named, ...fresh])) {
    if (pictures.length >= MADE) break
    const stat = await $.fs.stat(path).catch(() => null)
    if (stat?.kind !== 'file' || stat.mtimeMs < start - 2000) continue
    pictures.push([path, await pictureSize($, path)])
  }
  return pictures
}

/** The [columns, rows] a mermaid diagram's box takes in `room` columns. Nothing draws it before nook does,
 * so its size is a guess from its source: a left-to-right chart, a gantt, a timeline, or a git graph is wide
 * and short, anything else grows about three rows a line. nook fits the drawing inside the box. */
export function diagramBox(source, room) {
  const lines = source.split('\n').filter(l => l.trim() && !/^\s*%%/.test(l))
  const wide = /^\s*(?:(?:graph|flowchart)\s+(?:LR|RL)\b|gantt|timeline|gitGraph|journey)/.test(lines[0] ?? '')
  const rows = Math.round(wide ? lines.length * 1.5 : lines.length * 3)
  return [Math.max(20, Math.min(room, 100)), Math.max(8, Math.min(DIAGRAM_ROWS, rows))]
}

/** A short name for `text`, the same each time: FNV-1a, in base 36. */
function hash(text) {
  let h = 2166136261
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0), 16777619)
  return (h >>> 0).toString(36)
}

/** The file a Markdown link's target names, or null for a web address or a file that isn't a picture. */
export function linkTarget(raw) {
  let path = raw.replace(/^<|>$/g, '').replace(/^file:\/\/(?=\/[a-zA-Z]:)\//, '').replace(/^file:\/\//, '')
  if (/^[a-zA-Z][\w+.-]+:/.test(path) || !PICTURE.test(path)) return null
  try {
    path = decodeURI(path)
  } catch {} // a stray % keeps the path as written
  return path
}

/** Where a reply's code blocks open and close: a test for whether line i is inside one, or its fence. */
function fences(lines) {
  const inside = []
  let fence = null
  for (const line of lines) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    inside.push(Boolean(fence || mark))
    if (!mark) continue
    if (!fence) fence = mark
    else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
  }
  return i => inside[i]
}

/** The pictures a reply links with ![alt](path), outside its code blocks, each target once, as written. */
export function pictureLinks(text) {
  const lines = text.split('\n')
  const code = fences(lines)
  const links = new Set()
  for (const [i, line] of lines.entries()) if (!code(i)) for (const m of line.matchAll(LINK)) {
    const target = linkTarget(m[2])
    if (target) links.add(target)
  }
  return [...links]
}

/** A reply's text cut after each paragraph that links a picture in `shown`: [text, [target, …], text, …].
 * A line of such links alone goes, and a link inside a sentence leaves its alt text, or its file's name. */
export function splitPictures(text, shown) {
  const lines = text.split('\n')
  const code = fences(lines)
  const pieces = []
  let words = []
  let found = []
  const cut = () => {
    pieces.push(words.join('\n').trim(), [...new Set(found)])
    words = []
    found = []
  }
  for (const [i, line] of lines.entries()) {
    if (found.length && !code(i) && !line.trim()) cut()
    if (code(i) || !line.includes('![')) {
      words.push(line)
      continue
    }
    const kept = line.replace(LINK, (m, alt, raw) => {
      const target = linkTarget(raw)
      if (!shown.has(target)) return m
      found.push(target)
      return alt || target.split(/[\\/]/).pop()
    })
    const rest = line.replace(LINK, (m, alt, raw) => (shown.has(linkTarget(raw)) ? '' : m))
    if (!/^[\s\-*+>|,;.:]*$/.test(rest) || kept === line) words.push(kept)
  }
  if (found.length) cut()
  if (!pieces.length) return [text]
  pieces.push(words.join('\n').trim())
  return pieces // text, targets, text, … , text
}

/** A reply as one plain line for nook's cards and notifications: code blocks dropped, Markdown's marks taken
 * off, spaces collapsed, cut at a word near `room` characters. */
export function gist(text, room = 280) {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= room) return plain
  const cut = plain.slice(0, room)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), room * 0.6)).replace(/[\s,;:.-]+$/, '')}…`
}

/** One inline formula as Unicode, or null when part of it has no plain form. */
export function plainMath(tex) {
  let s = tex
  s = s.replace(/\\mathbb\{([A-Z])\}/g, (m, c) => BLACKBOARD[c] ?? m)
  s = s.replace(/\\(?:frac|dfrac|tfrac)\{([^{}]*)\}\{([^{}]*)\}/g, (_, a, b) => `${/^\w+$/.test(a) ? a : `(${a})`}/${/^\w+$/.test(b) ? b : `(${b})`}`)
  const ACCENTS = { bar: '\u0304', overline: '\u0304', hat: '\u0302', tilde: '\u0303', vec: '\u20d7', dot: '\u0307', ddot: '\u0308' }
  s = s.replace(/\\(bar|overline|hat|tilde|vec|dot|ddot)\s*(?:\{(\w)\}|(\w))/g, (_, accent, a, b) => (a ?? b) + ACCENTS[accent])
  s = s.replace(/\\sqrt\{([^{}]*)\}/g, (_, a) => `√${a.length > 1 ? `(${a})` : a}`)
  s = s.replace(/\\(?:mathrm|text|mathbf|mathit|operatorname)\{([^{}]*)\}/g, '$1')
  s = s.replace(/\\([a-zA-Z]+)(?=([a-zA-Z0-9]?))/g, (m, name, after) => (name in SYMBOLS ? SYMBOLS[name] + (after && /\w$/.test(SYMBOLS[name]) ? ' ' : '') : m))
  s = s.replace(/\\([,;:! ])/g, (_, c) => (c === '!' ? '' : ' ')).replace(/\\([{}%$&#_])/g, '$1')
  const script = table => (m, braced, one) => {
    const text = braced ?? one
    const out = [...text].map(c => table[c])
    return out.every(Boolean) ? out.join('') : m
  }
  s = s.replace(/\^(?:\{([^{}]*)\}|(\\?\w|[+\-]))/g, script(SUP))
  s = s.replace(/_(?:\{([^{}]*)\}|(\w))/g, script(SUB))
  if (/[\\{}^_]/.test(s)) return null
  return s.replace(/ {2,}/g, ' ').replace(/ ([,.)])/g, '$1').trim()
}

/** A reply's text with each inline $…$ formula that has a plain form written out in Unicode, as x² or
 * a ≠ 0. Code, fenced or in backticks and unclosed while it streams, stays as written. */
export function plainInline(text) {
  return text.split(/(^[ \t]*(?:```|~~~)[\s\S]*?(?:^[ \t]*(?:```|~~~)[ \t]*$|(?![\s\S]))|`[^`\n]*`)/m)
    .map((part, i) => (i % 2 ? part : part.replace(INLINE, (m, tex) => plainMath(tex) ?? m))).join('')
}

/** A reply's text cut at its mermaid blocks and display formulas: [text, [kind, source], text, …], where
 * kind is `mermaid` or `math`. A formula inside another code block stays in the text. */
export function splitBlocks(text) {
  const code = []
  for (const m of text.matchAll(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[ \t]*$|(?![\s\S]))/gm)) code.push([m.index, m.index + m[0].length])
  const found = [
    ...Array.from(text.matchAll(MERMAID), m => [m.index, m[0].length, 'mermaid', m[1]]),
    ...Array.from(text.matchAll(MATH), m => [m.index, m[0].length, 'math', (m[1] ?? m[2]).trim()])
      .filter(([at, , , source]) => source && !code.some(([a, b]) => at >= a && at < b)),
  ].sort((a, b) => a[0] - b[0])
  const pieces = []
  let at = 0
  for (const [index, length, kind, source] of found) {
    if (index < at) continue
    pieces.push(text.slice(at, index).trim(), [kind, source])
    at = index + length
  }
  pieces.push(at ? text.slice(at).trim() : text)
  return pieces // text, [kind, source], … , text
}

/** About how many rows a display formula takes at the terminal's own text size, a row being about an em:
 * an em a line, more for a fraction, a nested one, or a big operator with limits. nook fits the drawing
 * inside the box, so a guess too small only draws it smaller. */
export function mathBox(source, room) {
  const lines = source.split(/\\\\(?!\w)/).filter(l => l.replace(/\\(?:begin|end)\{[^}]*\}|&|\s/g, ''))
  const tall = line => {
    let h = 1
    if (/\\(?:[dt]?frac|cfrac|binom|over\b)/.test(line)) h = /\\[dt]?frac\s*\{[^{}]*\\[dt]?frac|\\[dt]?frac\s*\{[^{}]*\}\s*\{[^{}]*\\[dt]?frac/.test(line) ? 2.6 : 2.4
    const limits = names => new RegExp(`\\\\(?:${names})(?![a-zA-Z])(?:\\s*\\\\limits)?\\s*[_^]`).test(line)
    if (limits('sum|prod|coprod|bigcup|bigcap|bigoplus|bigotimes')) h = Math.max(h, 2.8)
    else if (limits('int|iint|iiint|oint')) h = Math.max(h, 2.4)
    else if (limits('lim|max|min|sup|inf|argmax|argmin')) h = Math.max(h, 2)
    return h
  }
  const em = lines.length > 1 ? lines.reduce((sum, l) => sum + tall(l) * 1.2, 0) : tall(lines[0] ?? '')
  return [Math.max(20, Math.min(room, 100)), Math.max(2, Math.min(MATH_ROWS, Math.ceil(em + 0.3)))]
}

/** The picture files a reply links that exist, LINKED at most: each target -> [path, size]. */
async function linkedPictures($, text) {
  const links = pictureLinks(text)
  if (!links.length) return new Map()
  const root = await $.session.root()
  const shown = new Map()
  for (const target of links) {
    if (shown.size >= LINKED) break
    const path = /^(?:[a-zA-Z]:)?[\\/]/.test(target) ? target : `${root}${sep(root)}${target.replace(/^\.[\\/]/, '')}`
    // A reply draws again with each word that streams in, so each file is looked at once a session.
    if (!linked.has(path)) linked.set(path, $.fs.stat(path).then(f => (f.kind === 'file' ? pictureSize($, path).then(size => [path, size]) : null), () => null))
    const found = await linked.get(path)
    if (found) shown.set(target, found)
  }
  return shown
}

/** The passed and failed counts a test runner's own summary gives, summed over every summary of the first
 * runner found (cargo prints one per crate), or null when the output holds none. */
export function testCounts(text) {
  const lines = text.slice(-TAIL).split('\n')
  const count = (part, word) => Number(new RegExp(`(\\d+) ${word}`).exec(part)?.[1] ?? 0)
  const runners = [
    // cargo: test result: ok. 26 passed; 0 failed; 0 ignored
    [/^test result: \w+\. (.*)/, m => [count(m[1], 'passed'), count(m[1], 'failed')]],
    // node --test, TAP and spec: # pass 93, ℹ fail 0
    [/^(?:#|ℹ) (pass|fail) (\d+)$/, m => (m[1] === 'pass' ? [Number(m[2]), 0] : [0, Number(m[2])])],
    // jest: Tests:       2 failed, 91 passed, 93 total
    [/^Tests:\s+(.*\d+ total)/, m => [count(m[1], 'passed'), count(m[1], 'failed')]],
    // vitest: Tests  2 failed | 91 passed (93)
    [/^\s*Tests\s+(.*)\(\d+\)/, m => [count(m[1], 'passed'), count(m[1], 'failed')]],
    // pytest: ===== 2 failed, 91 passed in 1.23s =====
    [/^=+ (.*(?:passed|failed).*) in [\d.]+s/, m => [count(m[1], 'passed'), count(m[1], 'failed') + count(m[1], 'errors?')]],
    // mocha: 91 passing, 2 failing
    [/^\s*(\d+) (passing|failing)\b/, m => (m[2] === 'passing' ? [Number(m[1]), 0] : [0, Number(m[1])])],
  ]
  for (const [pattern, read] of runners) {
    let found = null
    for (const line of lines) {
      const m = pattern.exec(line.replace(/\x1b\[[\d;]*m/g, ''))
      if (!m) continue
      const [passed, failed] = read(m)
      found = { passed: (found?.passed ?? 0) + passed, failed: (found?.failed ?? 0) + failed }
    }
    if (found) return found
  }
  return null
}

/** What a build, an install, a linter, or git says it did, from its own closing lines: a commit's hash and
 * line counts, where a push went, a merge's line counts, warnings and errors counted, and packages added.
 * Parts as `outcome` gives them, a third element true when the part joins the one before with a space; null
 * when the output holds none of these. */
export function summary(text) {
  const lines = text.slice(-TAIL).split('\n').map(l => l.replace(/\x1b\[[\d;]*m/g, '').trimEnd())
  const find = pattern => lines.map(l => pattern.exec(l)).find(Boolean)
  const parts = []
  // git's stat: 3 files changed, 10 insertions(+), 2 deletions(-)
  const stat = find(/^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/)
  const lineCounts = () => [
    ...(stat[2] ? [[`+${stat[2]}`, 'diffAdded', true]] : []),
    ...(stat[3] ? [[`\u2212${stat[3]}`, 'diffRemoved', true]] : []),
  ]
  // git commit: [main a1b2c3d] the message
  const commit = find(/^\[([^\s\]]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\]/)
  if (commit) {
    parts.push([`committed ${commit[2]}`, 'success'])
    if (stat) parts.push([plural(+stat[1], 'file')], ...lineCounts())
    return parts
  }
  // git push: "   a1b2c3d..e4f5a6b  main -> main", or "* [new branch]  x -> x"
  if (lines.some(l => /^To \S/.test(l))) {
    const ref = find(/^\s*[+*!= -]?\s*(?:[0-9a-f]+\.{2,3}[0-9a-f]+|\[[a-z ]+\])\s+\S+ -> (\S+)/)
    if (ref) return [[lines.some(l => /\[rejected\]/.test(l)) ? `rejected ${ref[1]}` : `pushed ${ref[1]}`, lines.some(l => /\[rejected\]/.test(l)) ? 'error' : 'success']]
  }
  if (lines.some(l => /^Already up to date\.?$/.test(l.trim()))) return [['up to date', null]]
  // git pull or merge: Fast-forward, or Merge made by the 'ort' strategy, then the stat
  if (stat && lines.some(l => /^(?:Fast-forward|Merge made by)/.test(l.trim()))) return [['merged', 'merged'], [plural(+stat[1], 'file')], ...lineCounts()]
  // cargo: warning: `nook` (bin "nook") generated 3 warnings; error: could not compile `nook` ... due to 2 previous errors
  const warned = lines.reduce((n, l) => n + Number(/^warning: .* generated (\d+) warnings?/.exec(l)?.[1] ?? 0), 0)
  const failed = find(/^error: could not compile .* due to (\d+) previous errors?/)
  if (failed) parts.push([plural(+failed[1], 'error'), 'error'])
  // tsc: Found 3 errors in 2 files.
  const tsc = find(/^Found (\d+) errors?(?: in (\d+) files?)?\.?$/)
  if (tsc) parts.push([`${plural(+tsc[1], 'error')}${tsc[2] ? ` in ${plural(+tsc[2], 'file')}` : ''}`, 'error'])
  // eslint: ✖ 5 problems (3 errors, 2 warnings)
  const lint = find(/^\u2716 \d+ problems? \((\d+) errors?, (\d+) warnings?\)/)
  if (lint && +lint[1]) parts.push([plural(+lint[1], 'error'), 'error'])
  const warnings = warned + (lint ? +lint[2] : 0)
  if (warnings) parts.push([plural(warnings, 'warning'), 'warning'])
  // npm: added 120 packages, and audited 121 packages in 3s; 3 vulnerabilities (1 moderate, 2 high)
  const added = find(/^(?:added|removed|changed) \d+ packages?.*?(?:, and audited|in [\d.]+m?s|$)/)
  if (added) parts.push([added[0].replace(/,? and audited.*$| in [\d.]+m?s$/, ''), null])
  const vulnerable = find(/^(\d+) (?:\w+ severity )?vulnerabilit(?:y|ies)/)
  if (vulnerable && +vulnerable[1]) parts.push([plural(+vulnerable[1], 'vulnerability', 'vulnerabilities'), 'warning'])
  // pip: Successfully installed a-1.0 b-2.0
  const pip = find(/^Successfully installed (.+)/)
  if (pip) parts.push([`installed ${plural(pip[1].split(/\s+/).length, 'package')}`, null])
  return parts.length ? parts : null
}

const FAILING = [
  /^test (\S+) \.\.\. FAILED$/, // cargo
  /^\s*not ok \d+ - (.+?)(?: # .*)?$/, // node --test, TAP
  /^\s*✖ (.+?) \([\d.]+m?s\)$/, // node --test, spec
  /^\s*● (.+?)$/, // jest
  /^\s*× (.+?)(?: \d+ms)?$/, // vitest
  /^FAILED \S*?::(\S+)/, // pytest
]
const FAILING_NAMES = 3 // the most failing tests a row names

/** The names of the tests a run failed, each once and in order, from the first runner's lines found. */
export function failingTests(text) {
  const lines = text.slice(-TAIL).split('\n').map(l => l.replace(/\x1b\[[\d;]*m/g, '').trimEnd())
  for (const pattern of FAILING) {
    const names = [...new Set(lines.map(l => pattern.exec(l)?.[1]).filter(Boolean))]
    if (names.length) return names
  }
  return []
}

const ERROR = /^(?:error(?:\[E\d+\])?:|.*\berror TS\d+:|\w*Error:|\w+Exception:|npm ERR!|fatal:|FAIL\b|thread '.*' panicked|panic:)/

/** The line of a failed command's output that says what went wrong, with a Rust error's `-->` place, or
 * null when no line looks like one. A Python traceback names its error last; everything else first. */
export function errorLine(text) {
  const lines = text.slice(-TAIL).split('\n').map(l => l.replace(/\x1b\[[\d;]*m/g, '').trimEnd())
  const traceback = lines.findIndex(l => l.startsWith('Traceback '))
  const at = traceback >= 0 ? lines.findLastIndex(l => /^\w+(Error|Exception)\b/.test(l)) : lines.findIndex(l => ERROR.test(l.trimStart()))
  if (at < 0) return null
  const place = lines.slice(at + 1, at + 3).map(l => /^\s*--> (\S+)/.exec(l)?.[1]).find(Boolean)
  return lines[at].trim() + (place ? ` at ${place}` : '')
}

/** The files a folded run of calls read, each relative to `root` when inside it and once only, so nook
 * links each one in the row (Ctrl+click opens it, resting the mouse shows its lines). */
export function readPaths(calls, root) {
  const paths = calls
    .filter(c => c.tool === 'Read' && !c.isRunning && !c.isErrored && !c.isInterrupted && c.input?.file_path)
    .map(c => relative(String(c.input.file_path), root))
  return [...new Set(paths)]
}

/** `path` relative to `root` when inside it, else as given. */
function relative(path, root) {
  const inside = root && root.replace(/[\\/]+$/, '') + sep(root)
  return inside && path.startsWith(inside) ? path.slice(inside.length) : path
}

const cut = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What a finished Grep or Glob found, as row parts: its pattern, then the files when three or fewer
 * (relative to `root`, so nook links them), else how many, or `no matches`. Null for any other call, or
 * one that errored. */
export function searchParts(call, root) {
  const { tool, input = {}, output } = call
  if ((tool !== 'Grep' && tool !== 'Glob') || call.isRunning || call.isErrored || call.isInterrupted) return null
  if (!output || typeof output !== 'object') return null
  const where = input.glob ?? input.type ?? (input.path ? relative(String(input.path), root) : '')
  const label = tool === 'Grep' ? `"${cut(String(input.pattern ?? ''), 30)}"` : cut(String(input.pattern ?? ''), 40)
  const parts = [[where ? `${label} in ${cut(String(where), 30)}` : label, null]]
  const files = output.filenames ?? []
  const n = output.totalMatches ?? output.numFiles ?? files.length
  if (output.mode === 'content') parts.push([output.numLines ? plural(output.numLines, 'line') : 'no matches', null])
  else if (output.mode === 'count') parts.push([output.numMatches ? `${plural(output.numMatches, 'match', 'matches')} in ${plural(n, 'file')}` : 'no matches', null])
  else if (!n) parts.push(['no matches', null])
  else if (files.length && files.length <= 3 && n === files.length) parts.push([files.map(f => relative(String(f), root)).join(', '), null])
  else parts.push([plural(n, 'file'), null])
  return parts
}

const SITES = 3 // the most sites a web search's row names

/** What a finished web search found, as row parts: how many results, and the sites they came from. */
export function webParts(call) {
  const { tool, output } = call
  if (tool !== 'WebSearch' || call.isRunning || call.isErrored || call.isInterrupted) return null
  if (!Array.isArray(output?.results)) return null
  const hits = output.results.flatMap(r => (Array.isArray(r?.content) ? r.content : []))
  if (!hits.length) return [['no results', null]]
  const sites = [...new Set(hits.map(h => {
    try {
      return new URL(h.url).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }).filter(Boolean))]
  const more = sites.length > SITES ? `, and ${sites.length - SITES} more` : ''
  return [[plural(hits.length, 'result'), null], ...(sites.length ? [[`${sites.slice(0, SITES).join(', ')}${more}`, null]] : [])]
}

const SEARCH = /^(?:rg|grep|egrep|fgrep|ag|ack|find|fd|git\s+grep)\b/ // commands whose output lists what they found

/** What a lone search command run through Bash found (`grep -rn x src`, `find . -name '*.rs'`), as row
 * parts after the command: up to three files by name, else how many lines and files, or `no matches`.
 * Null for any other command, or one that pipes or chains, whose output is no longer the search's. */
export function shellSearch(command, output, root) {
  const bare = command.replace(/'[^']*'|"[^"]*"/g, '')
  if (!SEARCH.test(command.trim()) || /[|;&<>`$(]/.test(bare)) return null
  if (!output || typeof output !== 'object') return null
  const lines = String(output.stdout ?? '').split('\n').filter(l => l.trim())
  if (!lines.length) return [['no matches', null]]
  const listing = /^(?:find|fd)\b/.test(command.trim()) || /\s(?:-\w*l|--files(?:-with-matches)?)\b/.test(bare)
  if (/\s(?:-\w*c|--count)\b/.test(bare) && !listing) {
    // `grep -c`: a count per file, `file:N`, or one bare count when it searched one file
    const counts = lines.map(l => /^(?:(.*):)?(\d+)$/.exec(l)).filter(Boolean).filter(m => +m[2])
    const total = counts.reduce((n, m) => n + +m[2], 0)
    if (!total) return [['no matches', null]]
    const named = counts.filter(m => m[1]).length
    return [[named > 1 ? `${plural(total, 'match', 'matches')} in ${plural(named, 'file')}` : plural(total, 'match', 'matches'), null]]
  }
  const files = listing ? lines : lines.map(l => /^([^:\s][^:]*\.[^:\s/]+|[^:\s]*\/[^:\s]*):/.exec(l)?.[1]).filter(Boolean)
  const distinct = [...new Set(files.map(f => relative(f.replace(/^\.\//, ''), root)))]
  if (distinct.length && distinct.length <= 3) return [[distinct.join(', '), null], ...(lines.length > distinct.length && !listing ? [[plural(lines.length, 'line'), null]] : [])]
  if (listing) return [[plural(lines.length, 'file'), null]]
  return [[distinct.length ? `${plural(lines.length, 'line')} in ${plural(distinct.length, 'file')}` : plural(lines.length, 'line'), null]]
}

/** One outcome row under Claude's own, its parts dim unless they carry a color. */
function outcomeRow(Box, Text, parts) {
  const runs = parts.flatMap(([text, color, joined], i) => [
    ...(i ? [Text({ dimColor: true, children: joined ? ' ' : ' · ' })] : []),
    Text(color ? { color, children: text } : { dimColor: true, children: text }),
  ])
  return Box({ paddingLeft: INDENT, children: [Text({ wrap: 'truncate-end', children: runs })] })
}

/** How long a command ran, as `14s` or `1m 12s`. */
const took = ms => (ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`)

/** The line under a finished shell command that says how it went: a test run's counts, a failure's error,
 * and the time a slow one took. Each is [text, theme color]; null when there is nothing to add. */
export function outcome(output, isErrored, ms) {
  const text = typeof output === 'string' ? output : [output?.stdout, output?.stderr].filter(Boolean).join('\n')
  const parts = []
  const tests = text ? testCounts(text) : null
  if (tests?.failed) parts.push([`✗ ${tests.failed} failed, ${tests.passed} passed`, 'error'])
  if (tests?.failed) {
    const names = failingTests(text)
    const more = names.length > FAILING_NAMES ? `, and ${names.length - FAILING_NAMES} more` : ''
    if (names.length) parts.push([names.slice(0, FAILING_NAMES).map(n => cut(n, 40)).join(', ') + more, null])
  }
  else if (tests) parts.push([`✓ ${tests.passed} passed`, 'success'])
  else if (text) parts.push(...(summary(text) ?? []))
  if (!tests && isErrored && text) {
    const line = errorLine(text)
    // Claude shows the first lines of a failure itself.
    const shown = text.split('\n').slice(0, 4).map(l => l.trim())
    if (line && !shown.includes(line)) parts.push([`↳ ${line.slice(0, 200)}`, 'error'])
  }
  if (ms >= SLOW) parts.push([`took ${took(ms)}`, null])
  return parts.length ? parts : null
}

// What the session is doing: `status` is working, waiting (on the person), or idle, since `since`;
// `activity` the tool running, `prompt` the main turn's first line, `agents` the subagents running,
// `turns` the main turns finished, `touched` the files Claude wrote, newest last, and `answer` and `took` the
// last main turn's reply as one plain line and its length in ms.
const agents = new Set()
const running = new Map() // tool_use_id -> activity, of the calls under way

async function setStatus($, file, status, patch = {}) {
  const since = status === state.status ? state.since : await $.clock.now()
  const last = [...running.values()].pop() ?? ''
  await report($, file, { status, since, activity: status === 'idle' ? '' : last, agents: agents.size, ...patch })
}

export function register(on) {
  let file = null
  on('session.start', async ($, e, next) => {
    const path = await $.env.get('NOOK_STATE')
    // A `claude -p` that Claude runs inside the tab inherits NOOK_STATE too, and draws on no surface.
    if (path && (await $.session.surfaces()).length) {
      file = path
      const requests = path.replace(/\.json$/, '.cmd')
      handled = await $.fs.read(requests).catch(() => '') // a request from an earlier session is spent
      await setStatus($, file, 'idle', { turns: 0, touched: [], prompt: '' })
      // /clear starts a new session, with an empty context and a new images folder.
      const tick = async () => report($, file, {
        ...(await take($, requests)), ...spent(await $.session.usage()), images: await imagesDir($), session: await $.session.id(), root: await $.session.root(), ...(await model($)),
      })
      await tick()
      $.clock.every(250, () => tick().catch(() => {})) // a failed tick leaves the last report standing
    }
    return next(e)
  })
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!file || !e.surfaces.includes('terminal')) return composed
    return { sections: [...composed.sections, { id: 'nook:draws', text: DRAWS, scope: 'session' }] }
  })
  on('turn.start', async ($, e, next) => {
    if (file && e.agentId) agents.add(e.agentId)
    if (file) {
      const patch = e.agentId ? {} : { prompt: e.text.trim().split('\n')[0].slice(0, 200), answer: '', took: 0 }
      await setStatus($, file, 'working', patch).catch(() => {})
    }
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!file) return result
    if (e.agentId) {
      agents.delete(e.agentId)
      await setStatus($, file, state.status).catch(() => {})
    } else {
      running.clear()
      agents.clear()
      const said = { answer: gist(e.answer ?? ''), took: e.durationMs ?? 0 }
      await setStatus($, file, 'idle', { turns: (state.turns ?? 0) + 1, ended: e.reason, ...said }).catch(() => {})
    }
    return result
  })
  on('tool.call', async ($, e, next) => {
    if (!file) return next(e)
    const id = e.tool_use_id ?? `${e.tool}-${running.size}`
    running.set(id, activity(e))
    await setStatus($, file, ASKS.has(e.tool) && !e.agentId ? 'waiting' : 'working').catch(() => {})
    try {
      return await next(e)
    } finally {
      running.delete(id)
      const path = EDITS.has(e.tool) ? e.file_path ?? e.notebook_path : null
      const touched = path ? [...(state.touched ?? []).filter(p => p !== path), path].slice(-TOUCHED) : state.touched
      // A call that ran after the turn ended (a hook's own) leaves the session idle.
      await setStatus($, file, state.status === 'idle' ? 'idle' : 'working', { touched }).catch(() => {})
    }
  })
  // How long each shell command ran, for the line under its result.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!e.tool_use_id) return next(e)
    const start = await $.clock.now()
    const result = await next(e)
    times.set(e.tool_use_id, (await $.clock.now()) - start)
    if (times.size > TIMES) times.delete(times.keys().next().value)
    if (!result?.deny && !result?.isError) {
      const root = await $.session.root().catch(() => '')
      const stdout = String(result?.result?.stdout ?? result?.text ?? '')
      if (root) made.set(e.tool_use_id, picturesMade($, String(e.command ?? ''), stdout, start, root, !!file).catch(() => []))
      if (made.size > TIMES) made.delete(made.keys().next().value)
    }
    return result
  })
  // A permission prompt: the session waits on the person until the call runs or the turn ends.
  on('classic.PermissionRequest', async ($, e, next) => {
    const result = await next(e)
    if (file && !result?.decision) await setStatus($, file, 'waiting').catch(() => {})
    return result
  })
  on('session.end', async ($, e, next) => {
    // After a /clear the process goes on as a new session, with nothing yet said.
    if (file) await setStatus($, file, 'idle', { ended: e.reason, prompt: '', answer: '', took: 0 }).catch(() => {})
    return next(e)
  })
  // The effort each request goes out with, the main agent's only.
  on('turn.step', async function* ($, e, next) {
    if (file && !e.agentId && e.effort != null) await report($, file, { effort: String(e.effort) })
    return yield* next(e)
  })
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    if (file && LEVELS.includes(e.args.trim())) await report($, file, { effort: e.args.trim() })
    return result
  })
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, input, output } = e.props
    const wrote = tool === 'Write' && !e.props.isRunning && !e.props.isErrored ? input.file_path ?? '' : ''
    // An HTML page written in a tab nook started shows as the page, laid out as a 1280 by 800 window would.
    const size = tool === 'Read' ? readSize(input.file_path, output, file && e.surface === 'terminal')
      : /\.svg$/i.test(wrote) ? svgSize(String(input.content ?? '')) ?? UNKNOWN
      : file && e.surface === 'terminal' && /\.html?$/i.test(wrote) ? PAGE : null
    return size ? withPictures($, e, await next(e), [[input.file_path, size]]) : next(e)
  })
  // A shell command's or web search's result, drawn alone under its row.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { tool, tool_use_id, output, isErrored, isExpanded } = e.props
    if ((tool !== 'Bash' && tool !== 'WebSearch') || isExpanded) return next(e)
    const parts = tool === 'Bash' ? outcome(output, isErrored, times.get(tool_use_id)) : webParts(e.props)
    const pictures = (await made.get(tool_use_id)) ?? []
    if (!parts && !pictures.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const drawn = parts ? Box({ flexDirection: 'column', children: [await next(e), outcomeRow(Box, Text, parts)] }) : await next(e)
    return pictures.length ? withPictures($, e, drawn, pictures) : drawn
  })
  // A run of calls Claude folds into one line, such as `Read 3 files, searched for 1 pattern`: under it,
  // the files it read, what each search found, and each finished command that has something to say.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const root = await $.session.root().catch(() => '')
    const rows = []
    for (const call of e.props.calls) {
      const found = searchParts(call, root) ?? webParts(call)
      if (found) rows.push(call.tool === 'WebSearch' ? [[`"${cut(String(call.input?.query ?? ''), 30)}"`, null], ...found] : found)
      if (call.tool !== 'Bash' || call.isRunning || call.isInterrupted) continue
      const command = String(call.input?.command ?? '').split('\n')[0]
      const parts = (!call.isErrored && shellSearch(command, call.output, root)) || outcome(call.output, call.isErrored, times.get(call.tool_use_id))
      if (parts) rows.push([[cut(command, 40), null], ...parts])
    }
    const read = readPaths(e.props.calls, root)
    // Pictures Claude read, then pictures its commands saved: a folded Read draws nothing of its own.
    const pictures = []
    for (const call of e.props.calls) {
      if (call.tool !== 'Read' || call.isRunning || call.isErrored) continue
      const size = readSize(String(call.input?.file_path ?? ''), call.output, file && e.surface === 'terminal')
      if (size) pictures.push([call.input.file_path, size])
    }
    for (const call of e.props.calls) pictures.push(...((await made.get(call.tool_use_id)) ?? []))
    if (!rows.length && !read.length && !pictures.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const shown = rows.slice(0, GROUP_ROWS).map(parts => outcomeRow(Box, Text, parts))
    if (rows.length > GROUP_ROWS) shown.push(outcomeRow(Box, Text, [[`and ${rows.length - GROUP_ROWS} more`, null]]))
    if (read.length) {
      const more = read.length > READ_NAMES ? `, and ${read.length - READ_NAMES} more` : ''
      shown.unshift(outcomeRow(Box, Text, [[`${read.slice(0, READ_NAMES).join(', ')}${more}`, null]]))
    }
    const drawn = Box({ flexDirection: 'column', children: [await next(e), ...shown] })
    return pictures.length ? withPictures($, e, drawn, pictures.slice(0, MADE)) : drawn
  })
  // A reply's ```mermaid block, in a tab nook started: the diagram in its place, which nook draws from the
  // block saved as a .mmd file beside NOOK_STATE. A display formula, $$ … $$ or \[ … \], the same way as a
  // .tex file. Other terminals can't draw either, so they get the source.
  // A picture file the reply links with ![alt](path) draws after the paragraph that links it.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const { isSummary } = e.props
    if (e.surface !== 'terminal' || isSummary) return next(e)
    const text = e.props.text.includes('$') ? plainInline(e.props.text) : e.props.text
    const diagrams = file && (text.includes('```mermaid') || text.includes('$$') || text.includes('\\['))
    const shown = text.includes('![') ? await linkedPictures($, text) : new Map()
    const plain = text === e.props.text ? e : { ...e, props: { ...e.props, text } }
    if (!diagrams && !shown.size) return next(plain)
    const { Box, Image, Markdown } = $.ui.resolve(e)
    const dir = file?.replace(/[\\/][^\\/]*$/, '')
    const room = Math.min(255, (e.viewport?.columns ?? 80) - REPLY_INDENT - 1)
    // The reply as words, diagrams, and pictures, in order: each odd piece of a split is what its text was cut at.
    const blocks = []
    for (const [i, piece] of (diagrams ? splitBlocks(text) : [text]).entries()) {
      if (i % 2) {
        const [kind, source] = piece
        const math = kind === 'math'
        const path = `${dir}${sep(dir)}${math ? 'math' : 'diagram'}-${hash(source)}.${math ? 'tex' : 'mmd'}`
        if (!saved.has(path)) {
          await $.fs.write(path, source)
          saved.add(path)
        }
        const [columns, rows] = math ? mathBox(source, room) : diagramBox(source, room)
        blocks.push(Box({ paddingLeft: REPLY_INDENT, marginY: math ? 0 : 1, children: [Image({ source: { file: path, format: 'png' }, columns, rows, alt: math ? 'formula' : 'diagram' })] }))
        continue
      }
      for (const [j, part] of (shown.size ? splitPictures(piece, shown) : [piece]).entries()) {
        if (j % 2 === 0) blocks.push(part)
        else blocks.push(Box({ flexDirection: 'column', marginY: 1, children: part.map(t => picture(Box, Image, ...shown.get(t), room, REPLY_INDENT)) }))
      }
    }
    if (blocks.length < 3) return next(plain)
    const draw = piece => Box({ paddingLeft: REPLY_INDENT, children: [Markdown({ text: piece })] })
    // The reply's bullet comes with its first text. A reply that opens on a diagram or picture has its text
    // drawn first and the rest after. One with no text at all names its pictures, or keeps its diagrams' blocks.
    if (!blocks[0]) {
      const words = blocks.filter(b => typeof b === 'string' && b).join('\n\n') || [...shown.keys()].map(t => t.split(/[\\/]/).pop()).join(', ')
      if (!words) return next(plain)
      return Box({ flexDirection: 'column', children: [await next({ ...e, props: { ...e.props, text: words } }), ...blocks.filter(b => typeof b !== 'string')] })
    }
    const rest = blocks.slice(1).filter(Boolean).map(b => (typeof b === 'string' ? draw(b) : b))
    return Box({ flexDirection: 'column', children: [await next({ ...e, props: { ...e.props, text: blocks[0] } }), ...rest] })
  })
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const pictures = e.props.text.includes('[Image #') ? await pasted($, e.props.text) : []
    return pictures.length ? withPictures($, e, await next(e), pictures) : next(e)
  })
}
