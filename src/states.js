// mermaid's stateDiagram (and -v2): states as rounded boxes, a composite state as a box around its own,
// [*] as start and end dots, forks, joins and choices, laid out by layered.js. A line it can't read is
// skipped.
import { layout, trace, basis, box, selfLoop } from './layered.js'
import { label, text, esc, r, styles, LINE } from './labels.js'

const PX = 14, PY = 8 // px around a state's label
const ARROW = 9 // px from an arrowhead's base to its tip
const NOTE_GAP = 20 // px between a state and its note

/** The state diagram in `src` (its first line the header) as { w, h, svg }. */
export function draw(src) {
  const states = new Map(), order = [], scopes = [], edges = [], notes = [], classDefs = new Map(), classOf = []
  const composite = new Map() // a composite state's id -> its scope
  const stack = []
  let dir = 'TB', note = null
  const scope = () => (stack.length ? stack[stack.length - 1] : -1)
  const state = (id, kind = 'state') => {
    if (id === '[*]') return null
    let s = states.get(id)
    if (!s) states.set(id, (s = { id, name: id, desc: [], kind, scope: scope() })), order.push(s)
    return s
  }
  // [*] is the start of the scope it's written in when an arrow leaves it, and its end when one arrives.
  const end = (id, start) => (id === '[*]' ? state(`[*]${start ? 'start' : 'end'}${scope()}`, start ? 'start' : 'end') : state(id))
  for (const raw of src.split('\n').slice(1)) {
    let line = raw.trim().replace(/;$/, '')
    if (note) {
      if (/^end\s*note$/i.test(line)) notes.push({ ...note, lab: label(note.lines.join('<br>'), false, 240) }), (note = null)
      else note.lines.push(line)
      continue
    }
    if (!line || line.startsWith('%%')) continue
    line = line.replace(/(\S+?):::([\w-]+)/g, (_, id, c) => (classOf.push([id, c]), id))
    let m
    if ((m = /^(.+?)\s*-->\s*(.+?)\s*(?::(.*))?$/.exec(line))) {
      edges.push({ a: end(m[1], true), b: end(m[2], false), lab: m[3]?.trim() ? label(m[3].trim()) : null })
    } else if ((m = /^state\s+(?:"([^"]*)"\s+as\s+(\S+?)|(\S+?)\s+as\s+"([^"]*)"|(\S+?))\s*(?:<<(fork|join|choice)>>)?\s*(\{)?$/.exec(line))) {
      const id = m[2] ?? m[3] ?? m[5], name = m[1] ?? m[4]
      const kind = /<<(fork|join|choice)>>/.exec(line)?.[1]
      if (m[7]) {
        // A composite: its states go in a scope of its own.
        scopes.push({ id, name: name ?? id, parent: scope(), dir: null, region: false })
        composite.set(id, scopes.length - 1)
        stack.push(scopes.length - 1)
      } else {
        const s = state(id, kind)
        if (name) s.name = name
        if (kind) s.kind = kind
      }
    } else if (line === '}') stack.pop()
    else if (line === '--' && stack.length) {
      // A concurrent region: what's in the composite so far becomes its first region, and a new one opens.
      const c = stack[stack.length - 1], parent = scopes[c].region ? scopes[c].parent : c
      if (!scopes[c].region) {
        scopes.push({ parent: c, dir: null, region: true })
        const first = scopes.length - 1
        for (const s of order) if (s.scope === c) s.scope = first
        scopes.forEach((sc, k) => k !== first && sc.parent === c && (sc.parent = first))
      }
      scopes.push({ parent, dir: null, region: true })
      stack[stack.length - 1] = scopes.length - 1
    } else if ((m = /^direction\s+(TB|TD|BT|LR|RL)\b/i.exec(line))) {
      const d = m[1].toUpperCase().replace('TD', 'TB')
      if (stack.length) scopes[scope()].dir = d
      else dir = d
    } else if ((m = /^note\s+(left|right)\s+of\s+(\S+?)\s*(?::(.*))?$/i.exec(line))) {
      const n = { of: m[2], side: m[1].toLowerCase(), lines: [] }
      if (m[3] === undefined) note = n
      else notes.push({ ...n, lab: label(m[3].trim(), false, 240) })
    } else if ((m = /^classDef\s+(\S+)\s+(.*)$/.exec(line))) for (const n of m[1].split(',')) classDefs.set(n, styles(m[2]))
    else if ((m = /^class\s+(\S+)\s+([\w-]+)/.exec(line))) for (const id of m[1].split(',')) classOf.push([id, m[2]])
    else if ((m = /^style\s+(\S+)\s+(.*)$/.exec(line))) classOf.push([m[1], styles(m[2])])
    else if (/^(?:hide|scale|accTitle|accDescr|click)\b/.test(line)) continue
    else if ((m = /^([^\s:]+)\s*:\s*(.*)$/.exec(line))) state(m[1]).desc.push(m[2])
    else if (/^[\w.-]+$/.test(line)) state(line)
  }

  // A composite is drawn as its scope; every other id is a state.
  const nodes = order.filter(s => !composite.has(s.id))
  if (!nodes.length && !scopes.length) throw new Error('no states')
  const index = new Map(nodes.map((s, k) => [s, k]))
  const ref = s => (index.has(s) ? index.get(s) : ~composite.get(s.id))
  const lr = dir === 'LR' || dir === 'RL'
  const shapes = nodes.map(s => {
    if (s.kind === 'start') return { w: 16, h: 16, round: 8 }
    if (s.kind === 'end') return { w: 20, h: 20, round: 10 }
    if (s.kind === 'fork' || s.kind === 'join') return { ...box(lr ? 8 : 72, lr ? 72 : 8), w: lr ? 8 : 72, h: lr ? 72 : 8 }
    if (s.kind === 'choice') return { pts: [[0, -15], [15, 0], [0, 15], [-15, 0]], w: 30, h: 30 }
    const name = label(s.name), desc = s.desc.length ? label(s.desc.join('<br>')) : null
    const w = Math.max(name.w, desc?.w ?? 0) + 2 * PX, h = name.h + 2 * PY + (desc ? desc.h + PY : 0)
    return { ...box(w, h), w, h, name, desc }
  })
  // Room beside a state for its notes and its self-transitions.
  const side = nodes.map(() => [0, 0, 0])
  notes.forEach(n => {
    const s = states.get(n.of)
    if (!index.has(s)) return
    const k = index.get(s), room = (lr ? n.lab.h + 2 * PY : n.lab.w + 2 * PX) + NOTE_GAP
    side[k][n.side === 'left' ? 0 : 1] += room
    side[k][2] = Math.max(side[k][2], lr ? n.lab.w + 2 * PX : n.lab.h + 2 * PY)
  })
  const loops = nodes.map(() => 0)
  edges.forEach(e => {
    if (e.a === e.b && index.has(e.a)) loops[index.get(e.a)] = Math.max(loops[index.get(e.a)], 26 + (e.lab ? e.lab.w + 8 : 0))
  })
  const titles = scopes.map(s => (s.region ? null : label(s.name)))
  const res = layout({
    dir,
    nodes: nodes.map((s, k) => {
      const o = shapes[k], along = Math.max(lr ? o.w : o.h, side[k][2])
      return { w: lr ? along : o.w, h: lr ? o.h : along, cluster: s.scope, loop: loops[k] + side[k][1], pre: side[k][0] }
    }),
    clusters: scopes.map((s, k) => ({ parent: s.parent, dir: s.dir, w: titles[k] ? titles[k].w + 16 : 0, h: titles[k] ? titles[k].h + 6 : 0 })),
    edges: edges.map(e => ({ v: ref(e.a), w: ref(e.b), minlen: 1, label: e.lab ? { w: e.lab.w + 8, h: e.lab.h + 2 } : null })),
    nodeSep: 32, rankSep: 40, edgeSep: 14, pad: 14,
  })

  let out = '', lines = '', front = ''
  res.clusters.forEach((b, k) => {
    if (scopes[k].region) out += `<rect class="region" x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}"/>`
    else out += `<rect class="cluster" x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}" rx="6"/>` + text(titles[k], b.tx + 8, b.ty, 'title', '', true)
  })
  const at = s => (index.has(s) ? [shapes[index.get(s)], ...res.nodes[index.get(s)]] : null)
  edges.forEach((e, k) => {
    let pts
    if (e.a === e.b && index.has(e.a)) {
      const [x, y] = res.nodes[index.get(e.a)], o = shapes[index.get(e.a)]
      pts = trace(selfLoop(x, y, o.w, o.h, lr), null, null, 0, ARROW)
      if (e.lab) {
        const [lx, ly] = lr ? [x, y + o.h / 2 + 30 + e.lab.h / 2] : [x + o.w / 2 + 30 + e.lab.w / 2, y]
        front += labelBox(e.lab, lx, ly)
      }
    } else {
      const got = res.edges[k]
      if (!got) return
      pts = trace(got.points, at(e.a), at(e.b), 0, ARROW)
      if (e.lab && got.label) front += labelBox(e.lab, ...got.label)
    }
    lines += `<path class="tr" d="${basis(pts)}" marker-end="url(#arrow)"/>`
  })
  // Styles: class definitions and style lines, by id.
  const css = new Map()
  for (const [id, c] of classOf) css.set(id, [...(css.get(id) ?? []), ...(typeof c === 'string' ? classDefs.get(c) ?? [] : c)])
  nodes.forEach((s, k) => {
    const [x, y] = res.nodes[k], o = shapes[k], list = [...(classDefs.get('default') ?? []), ...(css.get(s.id) ?? [])]
    const shape = list.filter(p => !p.startsWith('color:') && !p.startsWith('font-')), ink = list.filter(p => p.startsWith('color:') || p.startsWith('font-')).map(p => p.replace(/^color:/, 'fill:'))
    const st = shape.length ? ` style="${esc(shape.join(';'))}"` : ''
    if (s.kind === 'start') front += `<circle class="dot" cx="${r(x)}" cy="${r(y)}" r="8"${st}/>`
    else if (s.kind === 'end') front += `<circle class="ring" cx="${r(x)}" cy="${r(y)}" r="10"/><circle class="dot" cx="${r(x)}" cy="${r(y)}" r="5.5"${st}/>`
    else if (s.kind === 'fork' || s.kind === 'join') front += `<rect class="bar" x="${r(x - o.w / 2)}" y="${r(y - o.h / 2)}" width="${o.w}" height="${o.h}" rx="2"${st}/>`
    else if (s.kind === 'choice') front += `<polygon class="state" points="${o.pts.map(([px, py]) => `${r(x + px)},${r(y + py)}`).join(' ')}"${st}/>`
    else {
      const y0 = y - o.h / 2
      front += `<rect class="state" x="${r(x - o.w / 2)}" y="${r(y0)}" width="${r(o.w)}" height="${r(o.h)}" rx="7"${st}/>`
      front += text(o.name, x, y0 + PY + o.name.h / 2, '', ink.join(';'))
      if (o.desc) {
        const dy = y0 + o.name.h + 2 * PY
        front += `<path class="div" d="M${r(x - o.w / 2)},${r(dy)}h${r(o.w)}"/>` + text(o.desc, x, dy + PY / 2 + o.desc.h / 2, '', ink.join(';'))
      }
    }
  })
  // Notes beside their states, joined to them by a dashed line.
  const used = nodes.map(() => [0, 0])
  for (const n of notes) {
    const s = states.get(n.of)
    if (!index.has(s)) continue
    const k = index.get(s), [x, y] = res.nodes[k], o = shapes[k], w = n.lab.w + 2 * PX, h = n.lab.h + 2 * PY
    const left = n.side === 'left', past = used[k][left ? 0 : 1]
    let nx, ny, link
    if (lr) {
      ny = left ? y - o.h / 2 - NOTE_GAP - past - h / 2 : y + o.h / 2 + (left ? 0 : loops[k]) + NOTE_GAP + past + h / 2
      nx = x
      link = `M${r(x)},${r(left ? y - o.h / 2 : y + o.h / 2)}V${r(ny + (left ? h / 2 : -h / 2))}`
      used[k][left ? 0 : 1] += h + NOTE_GAP
    } else {
      nx = left ? x - o.w / 2 - NOTE_GAP - past - w / 2 : x + o.w / 2 + loops[k] + NOTE_GAP + past + w / 2
      ny = y
      link = `M${r(left ? x - o.w / 2 : x + o.w / 2 + loops[k])},${r(y)}H${r(nx + (left ? w / 2 : -w / 2))}`
      used[k][left ? 0 : 1] += w + NOTE_GAP
    }
    lines += `<path class="link" d="${link}"/>`
    front += `<rect class="note" x="${r(nx - w / 2)}" y="${r(ny - h / 2)}" width="${r(w)}" height="${r(h)}" rx="2"/>` + text(n.lab, nx, ny)
  }
  const defs = `<defs><marker id="arrow" class="arrow" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="${ARROW + 1}" markerHeight="${ARROW + 1}" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,1L10,5L0,9z"/></marker></defs>`
  return { w: res.width, h: res.height, svg: defs + out + lines + front }
}

/** An edge's label on a patch of background. */
const labelBox = (l, x, y) => `<rect class="elabel" x="${r(x - l.w / 2 - 4)}" y="${r(y - l.h / 2 - 1)}" width="${r(l.w + 8)}" height="${r(l.h + 2)}" rx="3"/>` + text(l, x, y)

export const css = c => `.state{fill:${c.raised};stroke:${c.accent};stroke-width:1.5}.div{stroke:${c.accent};stroke-opacity:.55}`
  + `.dot,.bar{fill:${c.ink2}}.ring{fill:none;stroke:${c.ink2};stroke-width:1.5}`
  + `.tr{fill:none;stroke:${c.ink2};stroke-width:1.5}.arrow{fill:${c.ink2}}`
  + `.cluster{fill:${c.accent};fill-opacity:.06;stroke:${c.ink2};stroke-opacity:.6}.title{fill:${c.ink2};font-weight:600}`
  + `.region{fill:none;stroke:${c.ink2};stroke-opacity:.5;stroke-dasharray:6 4}`
  + `.note{fill:${c.raised};stroke:${c.ink2};stroke-opacity:.7}.link{fill:none;stroke:${c.ink2};stroke-opacity:.7;stroke-dasharray:4 4}`
  + `.elabel{fill:${c.bg};fill-opacity:.9}`
