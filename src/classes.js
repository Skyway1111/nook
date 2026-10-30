// mermaid's classDiagram: each class a box of its name, attributes and methods, laid out by layered.js
// along its relations. A line it can't read is skipped.
import { layout, trace, basis, box } from './layered.js'
import { label, text, esc, r, styles } from './labels.js'

const PX = 12, PY = 6 // px around a compartment's lines
// What each end of a relation draws, and how far short of the box its line stops for it.
const ENDS = { '<|': ['tri', 14], '|>': ['tri', 14], '*': ['comp', 18], o: ['aggr', 18], '<': ['open', 0], '>': ['open', 0], '()': ['lolli', 12] }
const REL = /^(.*?\S)\s*(?:"([^"]*)"\s*)?(<\||\*|o|<|\(\))?(--|\.\.)(\|>|\*|o|>|\(\))?\s*(?:"([^"]*)"\s*)?(\S.*)$/

/** `~T~` generics as `<T>`, nested ones too. */
function generic(s) {
  let depth = 0
  return s.replace(/~/g, (_, i) => (depth && !/\w/.test(s[i + 1] ?? '') ? (depth--, '>') : (depth++, '<')))
}

/** A member line as [text, style]: a method as `name(args) : type`, static underlined, abstract italic. */
function member(line) {
  const vis = /^[+\-#~]/.test(line) ? line[0] : ''
  let rest = line.slice(vis.length).trim(), mark = ''
  const m = /^(.*?)\(([^)]*)\)\s*([$*]?)\s*(.*?)$/.exec(rest)
  if (m) {
    let ret = m[4]
    mark = m[3] || (/[$*]$/.test(ret) ? ret.slice(-1) : '')
    if (!m[3] && mark) ret = ret.slice(0, -1).trim()
    rest = `${m[1].trim()}(${m[2]})${ret ? ' : ' + ret : ''}`
  } else if (/[$*]$/.test(rest)) mark = rest.slice(-1), (rest = rest.slice(0, -1).trim())
  return [vis + generic(rest), mark === '$' ? 4 : mark === '*' ? 2 : 0, !!m]
}

/** The class diagram in `src` (its first line the header) as { w, h, svg }. */
export function draw(src) {
  const classes = new Map(), order = [], rels = [], notes = [], spaces = [], classDefs = new Map(), own = []
  let dir = 'TB', body = null, space = -1
  const cls = raw => {
    let t = raw.trim().replace(/^`(.*)`$/, '$1'), shown = null
    const lab = /^([^[\s]+)\s*\[\s*"?(.*?)"?\s*\]$/.exec(t)
    if (lab) t = lab[1], (shown = lab[2])
    const named = /^([^~]+)(?:~(.*)~)?$/.exec(t)
    const id = (named?.[1] ?? t).trim()
    let c = classes.get(id)
    if (!c) classes.set(id, (c = { id, name: id, annots: [], attrs: [], methods: [], css: [], space })), order.push(c)
    if (named?.[2]) c.name = id + generic(`~${named[2]}~`)
    if (shown) c.name = shown
    return c
  }
  const add = (c, line) => {
    line = line.trim()
    if (!line) return
    const a = /^<<(.+)>>$/.exec(line)
    if (a) return void c.annots.push(a[1].trim())
    const [t, style, method] = member(line)
    ;(method ? c.methods : c.attrs).push([t, style])
  }
  for (const raw of src.split('\n').slice(1)) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    if (body) {
      if (line.startsWith('}')) { body = null; continue }
      if (line.endsWith('}')) add(body, line.slice(0, -1)), (body = null)
      else add(body, line)
      continue
    }
    let m
    if (line === '}') space = -1
    else if ((m = /^direction\s+(TB|TD|BT|LR|RL)\b/i.exec(line))) dir = m[1].toUpperCase().replace('TD', 'TB')
    else if ((m = /^namespace\s+(.+?)\s*\{?$/.exec(line))) spaces.push(m[1].replace(/^`(.*)`$/, '$1')), (space = spaces.length - 1)
    else if ((m = /^class\s+(.+?)(?::::([\w-]+))?\s*(\{)?\s*(?:\}\s*)?$/.exec(line))) {
      const c = cls(m[1])
      if (m[2]) c.css.push(m[2])
      if (m[3] && !line.endsWith('}')) body = c
    } else if ((m = /^<<(.+)>>\s+(\S+)$/.exec(line))) cls(m[2]).annots.push(m[1].trim())
    else if ((m = /^note\s+(?:for\s+(\S+)\s+)?"(.*)"$/.exec(line))) notes.push({ of: m[1] && cls(m[1]), lab: label(m[2], false, 240) })
    else if ((m = /^classDef\s+(\S+)\s+(.*)$/.exec(line))) for (const n of m[1].split(',')) classDefs.set(n, styles(m[2]))
    else if ((m = /^cssClass\s+"([^"]*)"\s+([\w-]+)/.exec(line))) for (const n of m[1].split(',')) cls(n).css.push(m[2])
    else if ((m = /^style\s+(\S+)\s+(.*)$/.exec(line))) own.push([cls(m[1]), styles(m[2])])
    else if (/^(?:click|link|callback|accTitle|accDescr)\b/.test(line)) continue
    else {
      // A relation, `A "1" *-- "n" B : label`, or a member, `A : +name`.
      const colon = line.indexOf(':')
      const head = colon < 0 ? line : line.slice(0, colon).trim(), tail = colon < 0 ? '' : line.slice(colon + 1).trim()
      if ((m = REL.exec(head)) && !/\s/.test(m[1].replace(/\[.*\]/, '')) && !/\s/.test(m[7].replace(/\[.*\]/, ''))) {
        const [, a, ca, ea, kind, eb, cb, b] = m
        rels.push({ a: cls(a), b: cls(b), ca, cb, ea: ea ?? '', eb: eb ?? '', dashed: kind === '..', lab: tail ? label(tail) : null })
      } else if (colon > 0 && /^\S+$/.test(head)) add(cls(head), tail)
    }
  }
  if (!order.length) throw new Error('no classes')

  // Each class's box: its annotations and name, then its attributes, then its methods.
  const boxes = order.map(c => {
    const head = [...c.annots.map(a => label(`«${a}»`, false, Infinity)), label(c.name, false, Infinity, 1)]
    const parts = [c.attrs, c.methods].map(list => list.map(([t, s]) => label(t, false, Infinity, s)))
    const all = [...head, ...parts[0], ...parts[1]]
    const w = Math.max(80, ...all.map(l => l.w)) + 2 * PX
    const hh = head.reduce((s, l) => s + l.h, 0) + 2 * PY
    const sizes = parts.map(p => (p.length ? p.reduce((s, l) => s + l.h, 2 * PY) : 0))
    return { head, parts, w, hh, sizes, h: hh + sizes[0] + sizes[1] }
  })
  const noteBoxes = notes.map(n => ({ w: n.lab.w + 2 * PX, h: n.lab.h + 2 * PY }))
  const index = new Map(order.map((c, k) => [c, k]))
  const N = order.length
  const titles = spaces.map(s => label(s))
  // A parent ranks above its children and a whole above its parts, whichever way the arrow was written.
  const flip = rel => !rel.ea && /^(?:\|>|\*|o)$/.test(rel.eb)
  const res = layout({
    dir,
    nodes: [...boxes.map((b, k) => ({ w: b.w, h: b.h, cluster: order[k].space })), ...noteBoxes.map((b, k) => ({ w: b.w, h: b.h, cluster: notes[k].of?.space ?? -1 }))],
    clusters: titles.map(t => ({ parent: -1, w: t.w + 16, h: t.h + 6 })),
    edges: [
      ...rels.map(rel => {
        const [v, w] = flip(rel) ? [rel.b, rel.a] : [rel.a, rel.b]
        return { v: index.get(v), w: index.get(w), minlen: 1, label: rel.lab ? { w: rel.lab.w + 8, h: rel.lab.h + 2 } : null }
      }),
      ...notes.flatMap((n, k) => (n.of ? [{ v: N + k, w: index.get(n.of), minlen: 1, label: null }] : [])),
    ],
    nodeSep: 40, rankSep: 44, edgeSep: 14, pad: 14,
  })
  const at = k => [k < N ? box(boxes[k].w, boxes[k].h) : box(noteBoxes[k - N].w, noteBoxes[k - N].h), ...res.nodes[k]]

  let out = '', front = ''
  res.clusters.forEach((b, k) => {
    out += `<rect class="cluster" x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}" rx="4"/>` + text(titles[k], b.tx + 8, b.ty, 'title', '', true)
  })
  rels.forEach((rel, k) => {
    const e = res.edges[k]
    if (!e || rel.a === rel.b) return
    const [ka, kb] = [index.get(rel.a), index.get(rel.b)]
    let pts = e.points
    if (flip(rel)) pts = pts.slice().reverse()
    const [ma, cutA] = ENDS[rel.ea] ?? ['', 0], [mb, cutB] = ENDS[rel.eb] ?? ['', 0]
    pts = trace(pts, at(ka), at(kb), cutA, cutB)
    out += `<path class="rel${rel.dashed ? ' dashed' : ''}" d="${basis(pts)}"${ma ? ` marker-start="url(#${ma})"` : ''}${mb ? ` marker-end="url(#${mb})"` : ''}/>`
    // Multiplicities beside each end.
    for (const [card, p, q, cut] of [[rel.ca, pts[0], pts[1], cutA], [rel.cb, pts[pts.length - 1], pts[pts.length - 2], cutB]]) {
      if (!card) continue
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, ux = (q[0] - p[0]) / d, uy = (q[1] - p[1]) / d
      const back = 10 - cut
      front += `<text class="card" x="${r(p[0] + ux * back - uy * 14)}" y="${r(p[1] + uy * back + ux * 14 + 5)}" text-anchor="middle">${esc(card)}</text>`
    }
    if (rel.lab && e.label) {
      const l = rel.lab, [lx, ly] = e.label
      front += `<rect class="elabel" x="${r(lx - l.w / 2 - 4)}" y="${r(ly - l.h / 2 - 1)}" width="${r(l.w + 8)}" height="${r(l.h + 2)}" rx="3"/>` + text(l, lx, ly)
    }
  })
  let linked = rels.length
  notes.forEach((n, k) => {
    const [x, y] = res.nodes[N + k], b = noteBoxes[k], e = n.of && res.edges[linked++]
    if (e) out += `<path class="link" d="${basis(trace(e.points, at(N + k), at(index.get(n.of))))}"/>`
    front += `<rect class="note" x="${r(x - b.w / 2)}" y="${r(y - b.h / 2)}" width="${r(b.w)}" height="${r(b.h)}" rx="2"/>` + text(n.lab, x, y)
  })
  // Styles: class definitions, then each class's own.
  const css = order.map(c => [...(classDefs.get('default') ?? []), ...c.css.flatMap(n => classDefs.get(n) ?? [])])
  for (const [c, list] of own) css[index.get(c)].push(...list)
  order.forEach((c, k) => {
    const b = boxes[k], [x, y] = res.nodes[k], x0 = x - b.w / 2, y0 = y - b.h / 2, list = css[k]
    const shape = list.filter(p => !p.startsWith('color:') && !p.startsWith('font-')), ink = list.filter(p => p.startsWith('color:')).map(p => 'fill:' + p.slice(6))
    front += `<g class="cls"${shape.length ? ` style="${esc(shape.join(';'))}"` : ''}><rect x="${r(x0)}" y="${r(y0)}" width="${r(b.w)}" height="${r(b.h)}" rx="3"/>`
    let yy = y0 + b.hh
    for (const s of b.sizes) if (s) front += `<path class="div" d="M${r(x0)},${r(yy)}h${r(b.w)}"/>`, (yy += s)
    front += '</g>'
    let ty = y0 + PY
    b.head.forEach((l, i) => {
      front += text(l, x, ty + l.h / 2, i < c.annots.length ? 'annot' : '', ink.join(';'))
      ty += l.h
    })
    ty = y0 + b.hh + PY
    for (const [i, part] of b.parts.entries()) {
      for (const l of part) front += text(l, x0 + PX, ty + l.h / 2, '', ink.join(';'), true), (ty += l.h)
      if (b.sizes[i]) ty += 2 * PY
    }
  })
  const defs = '<defs><marker id="tri" class="mk hollow" viewBox="0 0 14 14" refX="0" refY="7" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0.8,0.8L13.5,7L0.8,13.2z"/></marker>'
    + '<marker id="comp" class="mk" viewBox="0 0 18 10" refX="0" refY="5" markerWidth="18" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,5L9,0.5L18,5L9,9.5z"/></marker>'
    + '<marker id="aggr" class="mk hollow" viewBox="0 0 18 10" refX="0" refY="5" markerWidth="18" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0.8,5L9,0.9L17.2,5L9,9.1z"/></marker>'
    + '<marker id="open" class="mk line" viewBox="0 0 10 12" refX="9.5" refY="6" markerWidth="10" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0.8L9.5,6L0,11.2"/></marker>'
    + '<marker id="lolli" class="mk hollow" viewBox="0 0 12 12" refX="0" refY="6" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><circle cx="6" cy="6" r="5.2"/></marker></defs>'
  return { w: res.width, h: res.height, svg: defs + out + front }
}

export const css = c => `.cls{fill:${c.raised};stroke:${c.accent};stroke-width:1.5}.div{stroke-opacity:.55}`
  + `.annot{fill:${c.ink2};font-size:15px}.card{fill:${c.ink2};font-size:15px}`
  + `.rel{fill:none;stroke:${c.ink2};stroke-width:1.5}.rel.dashed,.link{stroke-dasharray:6 4}.link{fill:none;stroke:${c.ink2};stroke-opacity:.7}`
  + `.mk{fill:${c.ink2};stroke:${c.ink2};stroke-width:1.5}.mk.hollow{fill:${c.bg}}.mk.line{fill:none}`
  + `.note{fill:${c.raised};stroke:${c.ink2};stroke-opacity:.7}.elabel{fill:${c.bg};fill-opacity:.9}`
  + `.cluster{fill:${c.accent};fill-opacity:.06;stroke:${c.ink2};stroke-opacity:.6}.title{fill:${c.ink2};font-weight:600}`
