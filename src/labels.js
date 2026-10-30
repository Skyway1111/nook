// Text in diagrams: labels parsed from mermaid's syntax, measured once on a canvas in the family the SVG
// draws with, wrapped, and written as escaped SVG text.

export const FONT = 18 // px, every label's size
export const LINE = 22 // px between a label's lines
// A system family: the diagram draws as an image, which sees no web font.
export const FAMILY = '"Segoe UI", system-ui, sans-serif'
const WRAP = 200 // px, the widest a label's line grows before it wraps

/** `text` escaped for SVG text and attribute values, without the control characters XML can't hold. */
export const esc = text => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

let ctx
const widths = new Map()
/** `text`'s width in px at FONT, bold and italic as `style` says (bit 1 bold, bit 2 italic), or in `font`. */
export function measure(text, style = 0, font) {
  const k = (font ?? style) + '\0' + text
  let w = widths.get(k)
  if (w === undefined) {
    ctx ??= new OffscreenCanvas(1, 1).getContext('2d')
    ctx.font = font ?? `${style & 2 ? 'italic ' : ''}${style & 1 ? 'bold ' : ''}${FONT}px ${FAMILY}`
    widths.set(k, (w = ctx.measureText(text).width))
  }
  return w
}

const NAMED = {
  quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', bull: '•',
  middot: '·', rarr: '→', larr: '←', harr: '↔', uarr: '↑', darr: '↓', rArr: '⇒', lArr: '⇐', hArr: '⇔', times: '×',
  divide: '÷', deg: '°', plusmn: '±', le: '≤', ge: '≥', ne: '≠', infin: '∞', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', euro: '€', pound: '£', yen: '¥',
  cent: '¢', sect: '§', para: '¶', check: '✓', cross: '✗', semi: ';', colon: ':', num: '#', lpar: '(', rpar: ')',
  lsqb: '[', rsqb: ']', lcub: '{', rcub: '}', vert: '|', excl: '!', quest: '?', alpha: 'α', beta: 'β', gamma: 'γ',
  delta: 'δ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', theta: 'θ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω',
}
/** `text` with mermaid's entity codes (#quot; #35; #x2665;) and HTML's (&amp;) as the characters they name. */
export function decode(text) {
  return text.replace(/[#&](?:(\d{1,7})|x([\da-f]{1,6})|([a-z]\w{1,9}));/gi, (all, dec, hex, name) => {
    if (name) return NAMED[name] ?? all
    const c = dec ? Number(dec) : parseInt(hex, 16)
    return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : all
  })
}

/**
 * A label: its lines, each a list of runs [text, style], wrapped at WRAP px, with its size. `<br>` breaks a
 * line, and <b> and <i> style their runs; in a markdown string (`md`) a newline breaks, and **bold** and
 * *italic* style.
 */
export function label(text, md = false, wrap = WRAP) {
  const lines = []
  for (const raw of decode(text).split(md ? /<br\s*\/?>|\n/i : /<br\s*\/?>|\\n/i)) {
    const runs = md ? markdown(raw.trim()) : tags(raw.trim())
    // Words with their styles, then filled into lines no wider than `wrap`.
    let line = [], w = 0
    const space = measure(' ')
    for (const [t, s] of runs) {
      for (const word of t.split(/ +/)) {
        if (!word) continue
        const ww = measure(word, s)
        if (line.length && w + space + ww > wrap) lines.push({ runs: join(line), w }), (line = []), (w = 0)
        w += (line.length ? space : 0) + ww
        line.push([word, s])
      }
    }
    lines.push({ runs: join(line), w })
  }
  return { lines, w: Math.max(0, ...lines.map(l => l.w)), h: lines.length * LINE }
}

/** Words back into runs, one per stretch of a style. */
function join(words) {
  const runs = []
  for (const [t, s] of words) {
    const last = runs[runs.length - 1]
    if (last && last[1] === s) last[0] += ' ' + t
    else runs.push([runs.length ? ' ' + t : t, s])
  }
  return runs
}

/** Runs styled by <b>, <strong>, <i> and <em>, as an HTML label would show them. */
function tags(text) {
  const runs = []
  let style = 0, at = 0
  for (const m of text.matchAll(/<(\/?)(b|strong|i|em)>/gi)) {
    if (m.index > at) runs.push([text.slice(at, m.index), style])
    const bit = /^[bs]/i.test(m[2]) ? 1 : 2
    style = m[1] ? style & ~bit : style | bit
    at = m.index + m[0].length
  }
  if (at < text.length) runs.push([text.slice(at), style])
  return runs
}

/** A markdown string's runs: ** or __ for bold, * or _ for italic. */
function markdown(text) {
  const runs = []
  let at = 0
  for (const m of text.matchAll(/\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|(?<![\w])_(.+?)_(?![\w])/g)) {
    if (m.index > at) runs.push([text.slice(at, m.index), 0])
    runs.push(m[1] ?? m[2] ? [m[1] ?? m[2], 1] : [m[3] ?? m[4], 2])
    at = m.index + m[0].length
  }
  if (at < text.length) runs.push([text.slice(at), 0])
  return runs
}

/** A label as SVG text centered on (x, y), or with its left edge at x when `start`. */
export function text(lab, x, y, cls = '', style = '', start = false) {
  const top = y - lab.h / 2 + LINE / 2 + FONT * 0.35
  let out = `<text${cls ? ` class="${cls}"` : ''}${start ? '' : ' text-anchor="middle"'}${style ? ` style="${esc(style)}"` : ''}>`
  lab.lines.forEach((line, i) => {
    out += `<tspan x="${r(x)}" y="${r(top + i * LINE)}">`
    for (const [t, s] of line.runs) out += s ? `<tspan${s & 1 ? ' font-weight="bold"' : ''}${s & 2 ? ' font-style="italic"' : ''}>${esc(t)}</tspan>` : esc(t)
    out += '</tspan>'
  })
  return out + '</text>'
}

/** A number for SVG: at most one decimal. */
export const r = n => Math.round(n * 10) / 10
