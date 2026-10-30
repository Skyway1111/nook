// mermaid's erDiagram: each entity a table of its attributes, each relationship a line with crow's-foot
// ends, laid out by layered.js. A line it can't read is skipped.
import { layout, trace, basis, box, selfLoop } from './layered.js'
import { label, text, esc, r, measure, labelBox, LINE } from './labels.js'

const PX = 14, PY = 8 // px around the entity's name
const CX = 10 // px either side of a cell's text
const ROW = LINE + 8 // px an attribute's row takes
// Each end's marker, by its symbol or its words: exactly one, zero or one, one or more, zero or more.
const ENDS = {
  __proto__: null, '||': 'one', '|o': 'zo', 'o|': 'zo', '}|': 'many', '|{': 'many', '}o': 'zm', 'o{': 'zm',
  one: 'one', 'only one': 'one', 1: 'one', 'zero or one': 'zo', 'one or zero': 'zo', 'one or more': 'many',
  'one or many': 'many', 'many(1)': 'many', '1+': 'many', 'zero or more': 'zm', 'zero or many': 'zm', 'many(0)': 'zm',
  '0+': 'zm', many: 'zm',
}
// `A ||--o{ B : label`, or in words, `A only one to zero or more B : label` (`optionally to` is dashed).
const REL = /^(.*?\S)\s*(\|o|\|\||\}o|\}\|)(--|\.\.|\.-|-\.)(o\||\|\||o\{|\|\{)\s*(.*?\S)\s*(?::\s*(.*))?$/
const WORD = '(one or zero|zero or one|one or more|one or many|zero or more|zero or many|only one|many\\([01]\\)|many|one|[01]\\+|1)'
const WORDS = new RegExp(`^("[^"]*"|\\S+)\\s+${WORD}\\s+(optionally to|to)\\s+${WORD}\\s+("[^"]*"|\\S+)\\s*(?::\\s*(.*))?$`, 'i')

/** The ER diagram in `src` (its first line the header) as { w, h, svg }. */
export function draw(src) {
  const entities = new Map(), order = [], rels = []
  let dir = 'TB', body = null
  const entity = raw => {
    const m = /^([^[\s]+)\s*\[\s*"?(.*?)"?\s*\]$/.exec(raw.trim())
    const id = (m ? m[1] : raw.trim()).replace(/^"(.*)"$/, '$1')
    let e = entities.get(id)
    if (!e) entities.set(id, (e = { id, name: id, attrs: [] })), order.push(e)
    if (m) e.name = m[2]
    return e
  }
  for (const raw of src.split('\n').slice(1)) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    let m
    if (body) {
      if (line.startsWith('}')) body = null
      else if ((m = /^(\S+)\s+(\S+)((?:[\s,]+(?:PK|FK|UK)\b)*)[\s,]*(?:"(.*)")?$/.exec(line))) body.attrs.push({ type: m[1], name: m[2], keys: m[3].replace(/[\s,]+/g, ' ').trim().replace(/ /g, ', '), note: m[4] ?? '' })
      continue
    }
    if ((m = /^direction\s+(TB|TD|BT|LR|RL)\b/i.exec(line))) dir = m[1].toUpperCase().replace('TD', 'TB')
    else if ((m = REL.exec(line) ?? WORDS.exec(line))) {
      const [a, b] = [m[2], m[4]].map(e => ENDS[e.toLowerCase()]), dashed = m[3] !== '--' && m[3].toLowerCase() !== 'to'
      rels.push({ a: entity(m[1]), b: entity(m[5]), ea: a, eb: b, dashed, lab: m[6] ? label(m[6].trim().replace(/^"(.*)"$/, '$1')) : null })
    } else if ((m = /^(.*?\S)\s*\{\s*(\})?$/.exec(line))) {
      const e = entity(m[1])
      if (!m[2]) body = e
    } else if (/^[\w-]+$/.test(line)) entity(line)
  }
  if (!order.length) throw new Error('no entities')

  // Each entity's table: its name, then a row an attribute, in columns of type, name, keys and comment.
  const tables = order.map(e => {
    const name = label(e.name)
    const cols = ['type', 'name', 'keys', 'note'].map(k => {
      const ws = e.attrs.map(a => (a[k] ? measure(a[k], k === 'keys' ? 1 : 0) : 0))
      const w = Math.max(0, ...ws)
      return w ? w + 2 * CX : 0
    })
    const total = cols.reduce((s, w) => s + w, 0), head = name.h + 2 * PY
    const w = Math.max(name.w + 2 * PX, total, 100)
    // A name wider than the columns widens the last one.
    for (let k = 3; k >= 0; k--) if (cols[k]) { cols[k] += w - total; break }
    return { name, cols, w, head, h: e.attrs.length ? head + e.attrs.length * ROW : head + 12 }
  })
  const index = new Map(order.map((e, k) => [e, k]))
  const res = layout({
    dir,
    nodes: tables.map((t, k) => ({ w: t.w, h: t.h, cluster: -1, loop: rels.some(rel => rel.a === order[k] && rel.b === order[k]) ? 40 : 0 })),
    clusters: [],
    edges: rels.map(rel => ({ v: index.get(rel.a), w: index.get(rel.b), minlen: 1, label: rel.lab ? { w: rel.lab.w + 8, h: rel.lab.h + 2 } : null })),
    nodeSep: 40, rankSep: 48, edgeSep: 14, pad: 14,
  })
  const lr = dir === 'LR' || dir === 'RL'
  const at = e => [box(tables[index.get(e)].w, tables[index.get(e)].h), ...res.nodes[index.get(e)]]

  let lines = '', front = ''
  rels.forEach((rel, k) => {
    let pts, lab = null
    if (rel.a === rel.b) {
      const t = tables[index.get(rel.a)], [x, y] = res.nodes[index.get(rel.a)]
      pts = selfLoop(x, y, t.w, t.h, lr)
      if (rel.lab) lab = lr ? [x, y + t.h / 2 + 30 + rel.lab.h / 2] : [x + t.w / 2 + 30 + rel.lab.w / 2, y]
    } else {
      const e = res.edges[k]
      if (!e) return
      pts = trace(e.points, at(rel.a), at(rel.b))
      lab = e.label
    }
    lines += `<path class="rel${rel.dashed ? ' dashed' : ''}" d="${basis(pts)}" marker-start="url(#${rel.ea})" marker-end="url(#${rel.eb})"/>`
    if (rel.lab && lab) front += labelBox(rel.lab, ...lab)
  })
  order.forEach((e, k) => {
    const t = tables[k], [x, y] = res.nodes[k], x0 = x - t.w / 2, y0 = y - t.h / 2
    front += `<rect class="table" x="${r(x0)}" y="${r(y0)}" width="${r(t.w)}" height="${r(t.h)}" rx="3"/>`
      + (e.attrs.length ? `<path class="head" d="M${r(x0)},${r(y0 + t.head)}h${r(t.w)}"/>` + text(t.name, x, y0 + t.head / 2, 'ename') : text(t.name, x, y, 'ename'))
    e.attrs.forEach((a, i) => {
      const ry = y0 + t.head + i * ROW
      if (i % 2) front += `<rect class="stripe" x="${r(x0 + 1)}" y="${r(ry)}" width="${r(t.w - 2)}" height="${ROW}"/>`
      let cx = x0
      ;['type', 'name', 'keys', 'note'].forEach((col, j) => {
        if (!t.cols[j]) return
        if (a[col]) front += `<text class="${col}" x="${r(cx + CX)}" y="${r(ry + ROW / 2 + 6)}">${esc(a[col])}</text>`
        cx += t.cols[j]
      })
    })
  })
  const mk = (id, body) => `<marker id="${id}" class="mk" viewBox="0 0 20 20" refX="20" refY="10" markerWidth="20" markerHeight="20" markerUnits="userSpaceOnUse" orient="auto-start-reverse">${body}</marker>`
  const crow = 'M20,2L9,10L20,18M9,10H20'
  const defs = '<defs>' + mk('one', '<path d="M14,3V17M9,3V17"/>') + mk('zo', '<path d="M14,3V17"/><circle cx="5" cy="10" r="4"/>')
    + mk('many', `<path d="${crow}M5,3V17"/>`) + mk('zm', `<path d="${crow}"/><circle cx="4.5" cy="10" r="4"/>`) + '</defs>'
  return { w: res.width, h: res.height, svg: defs + lines + front }
}

export const css = c => `.table{fill:${c.raised};stroke:${c.accent};stroke-width:1.5}.head{stroke:${c.accent};stroke-opacity:.55}`
  + `.ename{font-weight:600}.stripe{fill:${c.ink};fill-opacity:.04}`
  + `.type,.note{fill:${c.ink2}}.note{font-style:italic}.keys{fill:${c.accent};font-weight:bold}`
  + `.rel{fill:none;stroke:${c.ink2};stroke-width:1.5}.rel.dashed{stroke-dasharray:6 4}`
  + `.mk{fill:none;stroke:${c.ink2};stroke-width:1.5}.mk circle{fill:${c.bg}}`
