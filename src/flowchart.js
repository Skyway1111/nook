// mermaid's flowchart (and graph): parsed leniently, laid out by layered.js, drawn as SVG. A line it can't
// read is skipped, so a diagram with a mistake still draws what it can.
import { layout } from './layered.js'
import { label, text, esc, r } from './labels.js'

const PX = 14, PY = 8 // px of room around a node's label
const ARROW = 9 // px from an arrowhead's base to its tip

// Openers, longest first, with the closers each takes and the shape that pair makes.
const SHAPES = [
  ['(((', ')))', 'dbl'], ['((', '))', 'circle'], ['([', '])', 'stadium'], ['[(', ')]', 'cyl'], ['[[', ']]', 'sub'],
  ['[/', '/]', 'lean-r', '\\]', 'trap'], ['[\\', '\\]', 'lean-l', '/]', 'trap-t'], ['{{', '}}', 'hex'],
  ['(-', '-)', 'ellipse'], ['[', ']', 'rect'], ['(', ')', 'round'], ['{', '}', 'diamond'], ['>', ']', 'flag'],
]
// The newer `A@{ shape: … }` names, and the classic shape each draws as.
const NAMED = {
  rect: 'rect', rectangle: 'rect', proc: 'rect', process: 'rect', rounded: 'round', event: 'round', stadium: 'stadium',
  pill: 'stadium', terminal: 'stadium', 'fr-rect': 'sub', subproc: 'sub', subprocess: 'sub', subroutine: 'sub',
  cyl: 'cyl', cylinder: 'cyl', db: 'cyl', database: 'cyl', circle: 'circle', circ: 'circle', 'dbl-circ': 'dbl',
  'double-circle': 'dbl', diam: 'diamond', diamond: 'diamond', decision: 'diamond', question: 'diamond', hex: 'hex',
  hexagon: 'hex', prepare: 'hex', 'lean-r': 'lean-r', 'in-out': 'lean-r', 'lean-l': 'lean-l', 'out-in': 'lean-l',
  'trap-b': 'trap', trapezoid: 'trap', priority: 'trap', 'trap-t': 'trap-t', manual: 'trap-t', 'inv-trapezoid': 'trap-t',
  flag: 'flag', 'odd': 'flag', ellipse: 'ellipse', 'sm-circ': 'circle', 'f-circ': 'circle', start: 'circle', stop: 'dbl',
}
const STYLES = new Set(['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'color', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-weight', 'font-style'])
const VALUE = /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d\s.,%deg/]+\)|[\d.]+(?:px|em|%)?(?:[\s,]+[\d.]+(?:px|em|%)?)*)$/i

/** A `prop:value,prop:value` list as safe CSS: only drawing properties, only colors, lengths and dashes. */
function styles(list) {
  const out = []
  for (const part of list.replace(/;\s*$/, '').split(/,(?![^(]*\))/)) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const k = part.slice(0, i).trim().toLowerCase(), v = part.slice(i + 1).trim().replace(/\s*!important$/, '')
    if (STYLES.has(k) && VALUE.test(v)) out.push(`${k}:${v}`)
  }
  return out
}

/** The flowchart in `src` (its first line the header) as { w, h, svg }. */
export function flowchart(src) {
  const g = parse(src)
  return draw(g)
}

function parse(src) {
  const nl = src.indexOf('\n')
  const head = (nl < 0 ? src : src.slice(0, nl)).trim()
  const dir = /\b(TB|TD|BT|RL|LR)\b/i.exec(head.replace(/^\S+/, ''))?.[1].toUpperCase().replace('TD', 'TB') ?? 'TB'
  const s = nl < 0 ? '' : src.slice(nl + 1)
  const nodes = new Map() // id -> node
  const order = []
  const clusters = [] // { id, title, md, parent, dir }
  const stack = [] // open subgraphs
  const edges = []
  const classes = new Map() // class name -> css
  const classOf = [] // [id, class]
  const nodeStyle = [] // [id, css]
  const linkStyle = [] // [index | 'default', css]
  let i = 0

  const node = id => {
    let n = nodes.get(id)
    if (!n) nodes.set(id, (n = { id, text: id, md: false, shape: 'rect', cluster: -1, cls: [] })), order.push(n)
    if (n.cluster < 0 && stack.length) n.cluster = stack[stack.length - 1]
    return n
  }
  const spaces = () => { while (s[i] === ' ' || s[i] === '\t') i++ }
  const rest = () => {
    const end = s.indexOf('\n', i)
    const line = s.slice(i, end < 0 ? s.length : end)
    i = end < 0 ? s.length : end
    return line
  }
  const ID = /[\p{L}\p{N}_$]/u
  const id = () => {
    const at = i
    while (i < s.length && (ID.test(s[i]) || ((s[i] === '-' || s[i] === '.') && ID.test(s[i + 1] ?? '') && i > at))) i++
    return s.slice(at, i)
  }
  // Quoted text, or text up to `close`; null when it isn't there.
  const quoted = close => {
    spaces()
    if (s[i] === '"') {
      const md = s[i + 1] === '`'
      const end = md ? s.indexOf('`"', i + 2) : s.indexOf('"', i + 1)
      if (end < 0) return null
      const t = s.slice(i + (md ? 2 : 1), end)
      i = end + (md ? 2 : 1)
      spaces()
      if (close && !s.startsWith(close, i)) return null
      i += close.length
      return { t, md }
    }
    let end = s.indexOf(close, i)
    if (close.length === 1 && '])}'.includes(close)) {
      const open = { ']': '[', ')': '(', '}': '{' }[close]
      for (let k = i, depth = 0; k < s.length; k++) {
        if (s[k] === open) depth++
        else if (s[k] === close && depth-- === 0) { end = k; break }
        else if (s[k] === '\n') { end = -1; break }
      }
    }
    if (end < 0) return null
    const t = s.slice(i, end)
    i = end + close.length
    return { t, md: false }
  }
  const shape = n => {
    const at = i
    spaces()
    if (s.startsWith('@{', i)) {
      const end = s.indexOf('}', i)
      if (end < 0) return
      const body = s.slice(i + 2, end)
      i = end + 1
      const sh = /shape\s*:\s*"?([\w-]+)/.exec(body)?.[1]
      const lab = /label\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? /label\s*:\s*([^,\n]+)/.exec(body)?.[1]
      if (sh) n.shape = NAMED[sh.toLowerCase()] ?? 'rect'
      if (lab !== undefined) n.text = lab.trim(), (n.md = false)
      return
    }
    for (const [open, close, kind, close2, kind2] of SHAPES) {
      if (!s.startsWith(open, i)) continue
      i += open.length
      const back = i
      let got = quoted(close)
      let k = kind
      if (close2) {
        const one = got
        const endOne = i
        i = back
        const two = quoted(close2)
        // The nearer closer wins: [/a/] or [/a\].
        if (two && (!one || i < endOne)) got = two, (k = kind2)
        else if (one) got = one, (i = endOne)
      }
      if (!got) { i = at; return }
      n.text = got.t.trim()
      n.md = got.md
      n.shape = k
      return
    }
    i = at
  }
  const vertex = () => {
    const at = i
    spaces()
    const name = id()
    if (!name) { i = at; return null }
    const n = node(name)
    shape(n)
    if (s.startsWith(':::', i)) {
      i += 3
      const c = id()
      if (c) n.cls.push(c)
    }
    return n
  }
  const group = () => {
    const out = []
    for (;;) {
      const v = vertex()
      if (!v) return out.length ? out : null
      out.push(v)
      const at = i
      spaces()
      if (s[i] === '&') i++
      else { i = at; return out }
    }
  }
  // An arrow, with its label, or null. Kinds: '-' normal, '=' thick, '.' dotted, '~' invisible.
  const arrow = () => {
    const at = i
    spaces()
    const named = /^[\w$]+@(?=[-=.~<ox])/.exec(s.slice(i, i + 64)) // an edge's own id, `e1@-->`
    if (named) i += named[0].length
    let tail = ''
    if ('<ox'.includes(s[i]) && '-=.'.includes(s[i + 1] ?? '') && s[i]) tail = s[i++]
    const head = () => {
      const c = s[i]
      if (c === '>' || ((c === 'x' || c === 'o') && !/[a-z]/.test(s[i + 1] ?? ''))) return i++, c
      return ''
    }
    let kind, minlen = 1, h = ''
    if (s.startsWith('~~~', i)) {
      while (s[i] === '~') i++
      kind = '~'
    } else if ((s[i] === '-' && s[i + 1] === '-') || (s[i] === '=' && s[i + 1] === '=')) {
      const c = s[i]
      let n = 0
      while (s[i] === c) i++, n++
      h = head()
      kind = c === '=' ? '=' : '-'
      if (!h && n === 2) {
        // `-- text -->`: the label runs to the arrow that closes it.
        const close = new RegExp(c === '=' ? '={2,}[>xo=]?' : '-{2,}[>xo-]?', 'g')
        close.lastIndex = i
        const m = close.exec(s)
        if (!m || s.slice(i, m.index).includes('\n')) { i = at; return null }
        const t = s.slice(i, m.index).trim()
        i = m.index
        n = 0
        while (s[i] === c) i++, n++
        h = head()
        return finish({ kind, tail, head: h, minlen: Math.max(1, n - (h ? 1 : 2)), text: unquote(t) })
      }
      minlen = Math.max(1, n - (h ? 1 : 2))
    } else if ((s[i] === '-' && s[i + 1] === '.') || (s[i] === '.' && s[i + 1] === '-') || (s[i] === '.' && s[i + 1] === '.')) {
      if (s[i] === '-') i++
      let n = 0
      while (s[i] === '.') i++, n++
      kind = '.'
      if (s[i] === '-') {
        i++
        h = head()
        minlen = n
      } else {
        // `-. text .->`
        const m = /\.+-[>xo]?/g
        m.lastIndex = i
        const found = m.exec(s)
        if (!found || s.slice(i, found.index).includes('\n')) { i = at; return null }
        const t = s.slice(i, found.index).trim()
        i = found.index
        n = 0
        while (s[i] === '.') i++, n++
        i++
        h = head()
        return finish({ kind, tail, head: h, minlen: n, text: unquote(t) })
      }
    } else { i = at; return null }
    return finish({ kind, tail, head: h, minlen, text: null })
  }
  const unquote = t => {
    const m = /^"`?([\s\S]*?)`?"$/.exec(t)
    return { t: m ? m[1] : t, md: !!m && t[1] === '`' }
  }
  const finish = a => {
    const at = i
    spaces()
    if (s[i] === '|') {
      i++
      const got = quoted('|')
      if (got) a.text = got
      else i = at
    } else i = at
    return a
  }
  const statement = () => {
    let from = group()
    if (!from) return false
    for (;;) {
      const a = arrow()
      if (!a) break
      const to = group()
      if (!to) break
      for (const u of from) for (const v of to) edges.push({ u: u.id, v: v.id, ...a })
      from = to
    }
    return true
  }

  while (i < s.length) {
    while (i < s.length && /[\s;]/.test(s[i])) i++
    if (i >= s.length) break
    if (s.startsWith('%%', i)) { rest(); continue }
    const word = /^[a-zA-Z]+/.exec(s.slice(i, i + 16))?.[0] ?? ''
    const after = s[i + word.length]
    const kw = word && (after === undefined || /[\s;]/.test(after))
    if (kw && word === 'subgraph') {
      i += word.length
      const line = rest().replace(/;\s*$/, '').trim()
      let m, sid, title, md = false
      if ((m = /^([^\s[\]"]+)\s*\[\s*"`([\s\S]*)`"\s*\]$/.exec(line))) sid = m[1], (title = m[2]), (md = true)
      else if ((m = /^([^\s[\]"]+)\s*\[\s*"?([\s\S]*?)"?\s*\]$/.exec(line))) sid = m[1], (title = m[2])
      else if ((m = /^"([\s\S]*)"$/.exec(line))) sid = title = m[1]
      else sid = title = line || `subgraph ${clusters.length + 1}`
      clusters.push({ id: sid, title, md, parent: stack.length ? stack[stack.length - 1] : -1, dir: null })
      stack.push(clusters.length - 1)
    } else if (kw && word === 'end') {
      i += 3
      stack.pop()
    } else if (kw && word === 'direction') {
      i += word.length
      const d = /\b(TB|TD|BT|RL|LR)\b/i.exec(rest())?.[1].toUpperCase().replace('TD', 'TB')
      if (d && stack.length) clusters[stack[stack.length - 1]].dir = d
    } else if (kw && word === 'classDef') {
      i += word.length
      const m = /^\s*(\S+)\s+(.*)$/.exec(rest())
      if (m) for (const name of m[1].split(',')) classes.set(name, styles(m[2]))
    } else if (kw && word === 'class') {
      i += word.length
      const m = /^\s*(\S+)\s+([\w-]+)/.exec(rest())
      if (m) for (const n of m[1].split(',')) classOf.push([n, m[2]])
    } else if (kw && word === 'style') {
      i += word.length
      const m = /^\s*(\S+)\s+(.*)$/.exec(rest())
      if (m) nodeStyle.push([m[1], styles(m[2])])
    } else if (kw && word === 'linkStyle') {
      i += word.length
      const m = /^\s*(\S+)\s+(.*)$/.exec(rest())
      if (m) for (const k of m[1].split(',')) linkStyle.push([k === 'default' ? k : Number(k), styles(m[2])])
    } else if (kw && /^(click|accTitle|accDescr|callback|call|href)$/.test(word)) {
      if (word === 'accDescr' && /^\s*\{/.test(s.slice(i + word.length))) i = s.indexOf('}', i) + 1 || s.length
      else rest()
    } else {
      const at = i
      if (!statement() || i === at) rest()
      else {
        spaces()
        if (s[i] && s[i] !== '\n' && s[i] !== ';' && !s.startsWith('%%', i)) rest() // junk after a statement
      }
    }
  }
  return { dir, nodes: order, clusters, edges, classes, classOf, nodeStyle, linkStyle }
}

/** A node's shape for its label: its size, its outline as SVG, and how to clip an edge to it. */
function outline(n, lab) {
  const tw = lab.w, th = lab.h
  let w = tw + 2 * PX, h = th + 2 * PY
  switch (n.shape) {
    case 'circle': case 'dbl': {
      const d = Math.max(Math.hypot(tw, th) + 8, h) + (n.shape === 'dbl' ? 10 : 0)
      return { w: d, h: d, round: d / 2, draw: (x, y) => `<circle cx="${r(x)}" cy="${r(y)}" r="${r(d / 2)}"/>` + (n.shape === 'dbl' ? `<circle cx="${r(x)}" cy="${r(y)}" r="${r(d / 2 - 5)}"/>` : '') }
    }
    case 'ellipse': {
      w = tw * 1.42 + 2 * PY
      h = th * 1.42 + PY
      return { w, h, ellipse: true, draw: (x, y) => `<ellipse cx="${r(x)}" cy="${r(y)}" rx="${r(w / 2)}" ry="${r(h / 2)}"/>` }
    }
    case 'diamond': {
      // The flattest diamond that holds the label's box with a little room: wide rather than tall.
      const bw = tw + 2 * PY, bh = th + PY, H = bh * 2.2
      const W = bw / (1 - bh / H)
      return poly(W, H, [[0, -H / 2], [W / 2, 0], [0, H / 2], [-W / 2, 0]])
    }
    case 'hex': {
      const m = h / 4
      w += 2 * m
      return poly(w, h, [[-w / 2 + m, -h / 2], [w / 2 - m, -h / 2], [w / 2, 0], [w / 2 - m, h / 2], [-w / 2 + m, h / 2], [-w / 2, 0]])
    }
    case 'lean-r': case 'lean-l': case 'trap': case 'trap-t': {
      const k = h * 0.3
      w += 2 * k
      // Each corner moves in where the shape leans away from it.
      const tl = n.shape === 'lean-r' || n.shape === 'trap' ? k : 0, tr = n.shape === 'lean-l' || n.shape === 'trap' ? k : 0
      const bl = n.shape === 'lean-l' || n.shape === 'trap-t' ? k : 0, br = n.shape === 'lean-r' || n.shape === 'trap-t' ? k : 0
      return poly(w, h, [[-w / 2 + tl, -h / 2], [w / 2 - tr, -h / 2], [w / 2 - br, h / 2], [-w / 2 + bl, h / 2]])
    }
    case 'flag': {
      const k = h / 4
      w += k
      return poly(w, h, [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2 + k, 0]], k / 2)
    }
    case 'cyl': {
      const ry = Math.min(12, w / 2 / (2.5 + w / 50))
      h += 2 * ry
      const box = rect(w, h, 0)
      box.draw = (x, y) => {
        const x0 = r(x - w / 2), x1 = r(x + w / 2), y0 = r(y - h / 2 + ry), y1 = r(y + h / 2 - ry), rx = r(w / 2)
        return `<path d="M${x0},${y0}A${rx},${r(ry)} 0 0 0 ${x1},${y0}A${rx},${r(ry)} 0 0 0 ${x0},${y0}V${y1}A${rx},${r(ry)} 0 0 0 ${x1},${y1}V${y0}"/>`
      }
      box.dy = ry / 2
      return box
    }
    case 'stadium': w += h / 2; return rect(w, h, h / 2)
    case 'round': return rect(w, h, 8)
    case 'sub': {
      w += 16
      const box = rect(w, h, 0)
      const plain = box.draw
      box.draw = (x, y) => plain(x, y) + `<path d="M${r(x - w / 2 + 8)},${r(y - h / 2)}v${r(h)}M${r(x + w / 2 - 8)},${r(y - h / 2)}v${r(h)}"/>`
      return box
    }
    default: return rect(w, h, 3)
  }
}

function rect(w, h, rx) {
  const box = poly(w, h, [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]])
  box.draw = (x, y) => `<rect x="${r(x - w / 2)}" y="${r(y - h / 2)}" width="${r(w)}" height="${r(h)}"${rx ? ` rx="${r(rx)}"` : ''}/>`
  return box
}

function poly(w, h, pts, dx = 0) {
  return { w, h, pts, dx, draw: (x, y) => `<polygon points="${pts.map(([px, py]) => `${r(x + px)},${r(y + py)}`).join(' ')}"/>` }
}

/** Where the segment from (sx, sy), inside a shape centered at (cx, cy), toward (px, py) leaves it. */
function clip(o, cx, cy, sx, sy, px, py) {
  const ox = sx - cx, oy = sy - cy, dx = px - sx, dy = py - sy
  let t = Infinity
  if (o.round || o.ellipse) {
    // A circle, or an ellipse scaled to one: the larger root of |o + t·d| = 1.
    const rx = o.round || o.w / 2, ry = o.round || o.h / 2
    const ux = ox / rx, uy = oy / ry, vx = dx / rx, vy = dy / ry
    const A = vx * vx + vy * vy, B = ux * vx + uy * vy, C = ux * ux + uy * uy - 1
    if (A) t = (-B + Math.sqrt(Math.max(0, B * B - A * C))) / A
  } else {
    const p = o.pts
    for (let k = 0; k < p.length; k++) {
      const ax = p[k][0] - ox, ay = p[k][1] - oy, ex = p[(k + 1) % p.length][0] - p[k][0], ey = p[(k + 1) % p.length][1] - p[k][1]
      const den = dx * ey - dy * ex
      if (!den) continue
      const u = (ax * ey - ay * ex) / den, v = (ax * dy - ay * dx) / den
      if (u > 0 && u < t && v >= 0 && v <= 1) t = u
    }
  }
  return t <= 1 ? [sx + dx * t, sy + dy * t] : [px, py]
}

/** d3's curveBasis through the points: a B-spline that starts and ends on the polyline's ends. */
function basis(pts) {
  if (pts.length < 3) return `M${pts.map(([x, y]) => `${r(x)},${r(y)}`).join('L')}`
  let [x0, y0] = pts[0], [x1, y1] = pts[1]
  let d = `M${r(x0)},${r(y0)}L${r((5 * x0 + x1) / 6)},${r((5 * y0 + y1) / 6)}`
  const to = (x, y) => {
    d += `C${r((2 * x0 + x1) / 3)},${r((2 * y0 + y1) / 3)} ${r((x0 + 2 * x1) / 3)},${r((y0 + 2 * y1) / 3)} ${r((x0 + 4 * x1 + x) / 6)},${r((y0 + 4 * y1 + y) / 6)}`
    x0 = x1, y0 = y1, x1 = x, y1 = y
  }
  for (let k = 2; k < pts.length; k++) to(pts[k][0], pts[k][1])
  to(x1, y1)
  return d + `L${r(x1)},${r(y1)}`
}

/** Moves the polyline's end back by `by` px along its last segment, for an arrowhead to fill. */
function shorten(pts, by) {
  const [ax, ay] = pts[pts.length - 2], [bx, by2] = pts[pts.length - 1]
  const d = Math.hypot(bx - ax, by2 - ay)
  if (d < 1) return
  const k = Math.min(by, d - 0.5) / d
  pts[pts.length - 1] = [bx - (bx - ax) * k, by2 - (by2 - ay) * k]
}

function draw(g) {
  // An id naming a subgraph stands for the subgraph, unless a node by that name has its own label or shape.
  const cindex = new Map(g.clusters.map((c, k) => [c.id, k]))
  const nodes = g.nodes.filter(n => !cindex.has(n.id) || n.text !== n.id || n.shape !== 'rect')
  const keep = new Map(nodes.map((n, k) => [n.id, k]))
  const at = id => (keep.has(id) ? keep.get(id) : ~cindex.get(id))
  const labs = nodes.map(n => label(n.text, n.md))
  const shapes = nodes.map((n, k) => outline(n, labs[k]))
  const elabs = g.edges.map(e => (e.text && e.text.t.trim() ? label(e.text.t, e.text.md) : null))
  const loops = new Float64Array(nodes.length)
  g.edges.forEach((e, k) => {
    if (e.u === e.v && keep.has(e.u)) loops[keep.get(e.u)] = Math.max(loops[keep.get(e.u)], 26 + (elabs[k] ? elabs[k].w + 8 : 0))
  })
  const ctitles = g.clusters.map(c => label(c.title, c.md))
  const res = layout({
    dir: g.dir,
    nodes: nodes.map((n, k) => ({ w: shapes[k].w, h: shapes[k].h, cluster: n.cluster, loop: loops[k] })),
    clusters: g.clusters.map((c, k) => ({ parent: c.parent, dir: c.dir, w: ctitles[k].w + 16, h: ctitles[k].h + 6 })),
    edges: g.edges.map((e, k) => ({ v: at(e.u), w: at(e.v), minlen: e.minlen, label: elabs[k] ? { w: elabs[k].w + 8, h: elabs[k].h + 2 } : null })),
    nodeSep: 28, rankSep: 36, edgeSep: 14, pad: 12,
  })
  const lr = g.dir === 'LR' || g.dir === 'RL'
  // Styles: class definitions, then each node's own.
  const css = new Map()
  const add = (id, list) => keep.has(id) && list && css.set(id, [...(css.get(id) ?? []), ...list])
  for (const n of nodes) for (const c of n.cls) add(n.id, g.classes.get(c))
  for (const [id, c] of g.classOf) add(id, g.classes.get(c))
  for (const n of nodes) if (g.classes.has('default')) css.set(n.id, [...g.classes.get('default'), ...(css.get(n.id) ?? [])])
  for (const [id, list] of g.nodeStyle) add(id, list)
  const edgeCss = g.edges.map(() => [])
  for (const [k, list] of g.linkStyle) {
    if (k === 'default') edgeCss.forEach(l => l.unshift(...list))
    else if (edgeCss[k]) edgeCss[k].push(...list)
  }

  let out = ''
  // Subgraphs, outermost first, each with its title at its top.
  res.clusters.forEach((b, k) => {
    const t = ctitles[k], own = g.clusters[k].id
    const style = [...(g.nodeStyle.find(([id]) => id === own)?.[1] ?? [])]
    out += `<rect class="cluster" x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}" rx="4"${style.length ? ` style="${esc(style.join(';'))}"` : ''}/>`
    out += text(t, b.tx + 8, b.ty, 'title', '', true)
  })
  // Edges under the nodes, labels over them.
  const markers = new Map()
  const marker = (kind, color) => {
    const k = kind + color
    if (!markers.has(k)) markers.set(k, `m${markers.size}`)
    return markers.get(k)
  }
  let labelsOut = ''
  g.edges.forEach((e, k) => {
    if (e.kind === '~') return
    const style = edgeCss[k]
    const color = /(?:^|;)stroke:([^;]+)/.exec(style.join(';'))?.[1] ?? ''
    const cls = e.kind === '=' ? 'edge thick' : e.kind === '.' ? 'edge dotted' : 'edge'
    const st = style.length ? ` style="${esc(style.join(';'))}"` : ''
    if (e.u === e.v && keep.has(e.u)) {
      const v = keep.get(e.u), [x, y] = res.nodes[v], o = shapes[v]
      const pts = lr ? [[x - o.h / 4, y + o.h / 2], [x - o.h / 4, y + o.h / 2 + 22], [x + o.h / 4, y + o.h / 2 + 22], [x + o.h / 4, y + o.h / 2]]
        : [[x + o.w / 2, y - o.h / 4], [x + o.w / 2 + 22, y - o.h / 4], [x + o.w / 2 + 22, y + o.h / 4], [x + o.w / 2, y + o.h / 4]]
      if (e.head) shorten(pts, ARROW)
      out += `<path class="${cls}" d="${basis(pts)}"${st}${e.head ? ` marker-end="url(#${marker(e.head, color)})"` : ''}/>`
      if (elabs[k]) {
        const l = elabs[k]
        const [lx, ly] = lr ? [x, y + o.h / 2 + 30 + l.h / 2] : [x + o.w / 2 + 30 + l.w / 2, y]
        labelsOut += `<rect class="elabel" x="${r(lx - l.w / 2 - 4)}" y="${r(ly - l.h / 2 - 1)}" width="${r(l.w + 8)}" height="${r(l.h + 2)}" rx="3"/>` + text(l, lx, ly)
      }
      return
    }
    const got = res.edges[k]
    if (!got) return
    const pts = got.points.map(p => p.slice())
    const ui = at(e.u), vi = at(e.v)
    if (ui >= 0) pts[0] = clip(shapes[ui], ...res.nodes[ui], ...pts[0], ...pts[1])
    const n = pts.length
    if (vi >= 0) pts[n - 1] = clip(shapes[vi], ...res.nodes[vi], ...pts[n - 1], ...pts[n - 2])
    // Points the clip left on top of each other would turn an arrowhead at random.
    for (let k = pts.length - 2; k > 0; k--) if (Math.hypot(pts[k][0] - pts[k + 1][0], pts[k][1] - pts[k + 1][1]) < 1) pts.splice(k, 1)
    if (pts.length > 2 && Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) < 1) pts.splice(1, 1)
    if (e.head) shorten(pts, ARROW)
    if (e.tail) pts.reverse(), shorten(pts, ARROW), pts.reverse()
    out += `<path class="${cls}" d="${basis(pts)}"${st}${e.head ? ` marker-end="url(#${marker(e.head, color)})"` : ''}${e.tail ? ` marker-start="url(#${marker(e.tail === '<' ? '>' : e.tail, color)})"` : ''}/>`
    if (elabs[k] && got.label) {
      const l = elabs[k], [lx, ly] = got.label
      labelsOut += `<rect class="elabel" x="${r(lx - l.w / 2 - 4)}" y="${r(ly - l.h / 2 - 1)}" width="${r(l.w + 8)}" height="${r(l.h + 2)}" rx="3"/>` + text(l, lx, ly)
    }
  })
  // Nodes.
  nodes.forEach((n, k) => {
    const [x, y] = res.nodes[k], list = css.get(n.id) ?? []
    const color = list.filter(p => p.startsWith('color:')).map(p => 'fill:' + p.slice(6))
    const shape = list.filter(p => !p.startsWith('color:') && !p.startsWith('font-'))
    const font = list.filter(p => p.startsWith('font-'))
    out += `<g class="node"${shape.length ? ` style="${esc(shape.join(';'))}"` : ''}>${shapes[k].draw(x, y)}</g>`
    out += text(labs[k], x + (shapes[k].dx ?? 0), y + (n.shape === 'cyl' ? shapes[k].dy : 0), '', [...color, ...font].join(';'))
  })
  let defs = ''
  for (const [key, mid] of markers) {
    const kind = key[0], color = key.slice(1)
    const fill = color ? ` style="fill:${esc(color)};stroke:${esc(color)}"` : ''
    defs += `<marker id="${mid}" class="arrow" viewBox="0 0 10 10" refX="${kind === 'o' ? 1 : kind === 'x' ? 2 : 0}" refY="5" markerWidth="${ARROW + 1}" markerHeight="${ARROW + 1}" markerUnits="userSpaceOnUse" orient="auto-start-reverse"${fill}>`
      + (kind === '>' ? '<path d="M0,1L10,5L0,9z"/>' : kind === 'o' ? '<circle cx="5" cy="5" r="4"/>' : '<path d="M1,1L9,9M1,9L9,1" class="x"/>') + '</marker>'
  }
  return { w: res.width, h: res.height, svg: `<defs>${defs}</defs>${out}${labelsOut}` }
}

export const css = c => `.node{fill:${c.raised};stroke:${c.accent};stroke-width:1.5}`
  + `.cluster{fill:${c.accent};fill-opacity:.06;stroke:${c.ink2};stroke-opacity:.6;stroke-width:1}`
  + `.title{fill:${c.ink2};font-weight:600}`
  + `.edge{fill:none;stroke:${c.ink2};stroke-width:1.5}.edge.thick{stroke-width:3.5}.edge.dotted{stroke-dasharray:3 4}`
  + `.arrow{fill:${c.ink2};stroke:${c.ink2}}.arrow .x{stroke-width:2;fill:none}`
  + `.elabel{fill:${c.bg};fill-opacity:.9}`
