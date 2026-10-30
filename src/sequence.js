// mermaid's sequenceDiagram: participants across the top, each message a row down the page. Parsed a line
// at a time; a line it can't read is skipped.
import { label, text, esc, r, LINE } from './labels.js'

const GAP = 30 // px between two participants' boxes
const ROW = 14 // px between a message's line and the next row's text
const BLOCK = 12 // px a block's frame stands out past the lifelines in it
const ARROWS = '<<-->>|<<->>|-->>|->>|--x|-x|--\\)|-\\)|-->|->'
const MESSAGE = new RegExp(`^(.*?\\S)\\s*(${ARROWS})\\s*([+-]?)\\s*(.*?\\S)\\s*(?::(.*))?$`)

/** A color for a box or a rect block, or '' when `c` isn't one. */
const tint = c => (/^(?:#[\da-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/]+\)|[a-z]+)$/i.test(c) && CSS.supports('color', c) ? c : '')

/** The sequence diagram in `src` (its first line the header) as { w, h, svg }. */
export function draw(src) {
  const parts = [], byId = new Map()
  const events = []
  const groups = [] // participant boxes: { color, lab, members }
  const stack = []
  let title = null, number = 0, step = 1, numbering = false, pending = null
  const part = (id, name = id, actor = false) => {
    id = id.trim().replace(/^"(.*)"$/, '$1')
    let p = byId.get(id)
    if (!p) {
      byId.set(id, (p = { id, i: parts.length, lab: label(name.trim().replace(/^"(.*)"$/, '$1')), actor, born: -1, died: -1 }))
      parts.push(p)
      const box = stack.findLast(s => s.box)
      if (box) box.members.push(p), (p.group = true)
    }
    return p
  }
  for (const raw of src.split('\n').slice(1)) {
    const line = raw.trim().replace(/;$/, '')
    if (!line || line.startsWith('%%')) continue
    let m
    if ((m = /^(create\s+)?(participant|actor)\s+(.*?\S)(?:\s+as\s+(.+))?$/i.exec(line))) {
      let [, create, kind, id, name] = m
      id = id.replace(/@\{.*\}$/, '')
      // `participant "Long name" as X`: the quoted part is the name, the other the id.
      if (name && /^".*"$/.test(id.trim()) && !/^".*"$/.test(name.trim())) [id, name] = [name, id]
      const p = part(id, name ?? id, kind.toLowerCase() === 'actor')
      if (name) p.lab = label(name.trim().replace(/^"(.*)"$/, '$1'))
      p.actor = kind.toLowerCase() === 'actor'
      if (create) pending = p
    } else if ((m = /^destroy\s+(.+)$/i.exec(line))) {
      // The next message to or from it ends its lifeline; with none, the lifeline ends here.
      const p = part(m[1])
      p.doomed = true
      events.push({ t: 'destroy', p })
    }
    else if ((m = /^(activate|deactivate)\s+(.+)$/i.exec(line))) events.push({ t: m[1].toLowerCase(), p: part(m[2]) })
    else if ((m = /^autonumber\b\s*(\d+)?\s*(\d+)?/i.exec(line))) {
      numbering = !/\boff\b/i.test(line)
      if (m[1]) number = Number(m[1]) - (m[2] ? Number(m[2]) : 1)
      if (m[2]) step = Number(m[2])
    } else if ((m = /^title\s*:?\s*(.*)$/i.exec(line))) title = label(m[1])
    else if ((m = /^note\s+(left of|right of|over)\s+([^:]+?)\s*:(.*)$/i.exec(line))) {
      const ps = m[2].split(',').map(id => part(id))
      events.push({ t: 'note', side: m[1].toLowerCase(), ps, lab: label(m[3], false, 240) })
    } else if ((m = /^box\b\s*(.*)$/i.exec(line))) {
      const c = /^((?:rgb|hsl)a?\([^)]*\)|#[\da-f]{3,8}|[a-z]+)\s*(.*)$/i.exec(m[1])
      const color = c ? tint(c[1]) : ''
      const name = color ? c[2] : m[1]
      const box = { box: true, color, lab: name ? label(name) : null, members: [] }
      groups.push(box)
      stack.push(box)
    } else if ((m = /^(loop|alt|opt|par|par_over|critical|break|rect)\b\s*(.*)$/i.exec(line))) {
      const kind = m[1].toLowerCase()
      const ev = { t: 'start', kind: kind.replace('par_over', 'par'), color: kind === 'rect' ? tint(m[2].trim()) : '', lab: kind === 'rect' || !m[2] ? null : label(`[${m[2]}]`, false, 320) }
      events.push(ev)
      stack.push(ev)
    } else if ((m = /^(else|and|option)\b\s*(.*)$/i.exec(line))) events.push({ t: 'section', lab: m[2] ? label(`[${m[2]}]`, false, 320) : null })
    else if (/^end$/i.test(line)) {
      const open = stack.pop()
      if (open && !open.box) events.push({ t: 'end', start: open })
    } else if ((m = MESSAGE.exec(line))) {
      const [, a, arrow, act, b, words = ''] = m
      const from = part(a), to = part(b)
      const ev = { t: 'msg', from, to, arrow, act, lab: label(words.trim(), false, 320), n: numbering ? (number += step) : 0 }
      if (pending === to || pending === from) ev.born = pending, (pending = null)
      if (to.doomed || from.doomed) ev.dies = to.doomed ? to : from, (ev.dies.doomed = false)
      events.push(ev)
    }
  }
  if (!parts.length) throw new Error('no participants')

  // Across: each participant's box, then room for the messages and notes between them.
  const boxH = Math.max(...parts.map(p => p.lab.h)) + 16
  const width = p => Math.max(p.lab.w + 24, p.actor ? 60 : 90)
  const need = parts.map(() => [])
  const wants = (i, j, d) => i >= 0 && j < parts.length && need[j].push([i, d])
  for (const e of events) {
    if (e.t === 'msg') {
      const lo = Math.min(e.from.i, e.to.i), hi = Math.max(e.from.i, e.to.i)
      const w = e.lab.w + 24 + (e.n ? 24 : 0)
      if (lo === hi) wants(lo, lo + 1, w + 24)
      else wants(lo, hi, w)
    } else if (e.t === 'note') {
      const [p, q] = [e.ps[0].i, e.ps[e.ps.length - 1].i].sort((a, b) => a - b)
      const w = e.lab.w + 20
      if (e.side === 'right of') wants(p, p + 1, w + 20)
      else if (e.side === 'left of') wants(p - 1, p, w + 20)
      else if (p === q) wants(p, p + 1, w / 2 + 16), wants(p - 1, p, w / 2 + 16)
      else wants(p, q, w - 40)
    }
  }
  const x = new Float64Array(parts.length)
  parts.forEach((p, k) => {
    x[k] = k ? x[k - 1] + (width(parts[k - 1]) + width(p)) / 2 + GAP : width(p) / 2
    for (const [i, d] of need[k]) x[k] = Math.max(x[k], x[i] + d)
  })

  // Down: each event takes its row.
  const top = (title ? title.h + 12 : 0) + (groups.some(g => g.lab) ? LINE + 4 : 0)
  let y = top + boxH + 20
  let back = '', lines = '', front = '', boxes = ''
  const active = parts.map(() => []) // start y of each activation, innermost last
  const bars = []
  const edge = (p, right) => {
    const d = active[p.i].length
    return x[p.i] + (d ? (right ? 5 : -5) + 5 * (d - 1) : 0)
  }
  const blocks = [] // open blocks: { ev, y, lo, hi, sections }
  let left = Infinity, right = -Infinity
  // What's drawn from lo to hi widens the blocks it's in, and the drawing.
  const touch = (lo, hi) => {
    for (const b of blocks) b.lo = Math.min(b.lo, lo), (b.hi = Math.max(b.hi, hi))
    left = Math.min(left, lo)
    right = Math.max(right, hi)
  }
  const actor = (p, y0) => {
    const w = width(p), cx = x[p.i]
    if (p.actor) {
      // A stick figure, its name under it.
      const s = boxH - 6
      return `<g class="figure"><circle cx="${r(cx)}" cy="${r(y0 + s * 0.16)}" r="${r(s * 0.14)}"/>`
        + `<path d="M${r(cx)},${r(y0 + s * 0.3)}v${r(s * 0.32)}M${r(cx - s * 0.24)},${r(y0 + s * 0.4)}h${r(s * 0.48)}M${r(cx - s * 0.2)},${r(y0 + s * 0.92)}L${r(cx)},${r(y0 + s * 0.62)}L${r(cx + s * 0.2)},${r(y0 + s * 0.92)}"/></g>`
        + text(p.lab, cx, y0 + boxH + p.lab.h / 2 - 2, 'name')
    }
    return `<rect class="actor" x="${r(cx - w / 2)}" y="${r(y0)}" width="${r(w)}" height="${r(boxH)}" rx="4"/>` + text(p.lab, cx, y0 + boxH / 2)
  }
  const nameBand = parts.some(p => p.actor) ? Math.max(...parts.filter(p => p.actor).map(p => p.lab.h)) : 0
  y += nameBand
  for (const e of events) {
    if (e.t === 'msg') {
      const self = e.from === e.to
      if (e.born) e.born.born = y + (self ? 0 : 0)
      const ly = y
      y += e.lab.h + 4
      if (e.born) {
        // A participant made here: its box sits on the message's line.
        e.born.born = y - boxH / 2
        boxes += actor(e.born, y - boxH / 2)
      }
      const right = e.to.i >= e.from.i
      if (e.act === '+') active[e.to.i].push(y)
      let x1 = edge(e.from, self || right), x2 = e.born ? x[e.to.i] + (right ? -1 : 1) * width(e.to) / 2 : edge(e.to, !right)
      if (e.act === '-') bars.push({ p: e.from, y0: active[e.from.i].pop() ?? y, y1: y, d: active[e.from.i].length })
      const dotted = e.arrow.includes('--'), cls = dotted ? 'msg dotted' : 'msg'
      const head = /x$/.test(e.arrow) ? 'x' : /\)$/.test(e.arrow) ? 'open' : />>$/.test(e.arrow) ? 'solid' : ''
      const tail = e.arrow.startsWith('<<') ? 'solid' : ''
      if (e.n) {
        // The message's number in a dot at its start.
        front += `<circle class="num" cx="${r(x1)}" cy="${r(y)}" r="10"/><text class="numt" x="${r(x1)}" y="${r(y + 4.5)}" text-anchor="middle">${e.n}</text>`
        x1 += (self || x2 >= x1 ? 1 : -1) * 10
      }
      if (self) {
        const lx = x1 + 8
        front += text(e.lab, lx, ly + e.lab.h / 2, '', '', true)
        const y2 = y + 22
        lines += `<path class="${cls}" d="M${r(x1)},${r(y)}h30v22H${r(x1 + 4)}"${head ? ` marker-end="url(#${head})"` : ''}/>`
        touch(x[e.from.i] - 10, Math.max(lx + e.lab.w, x1 + 34))
        y = y2
      } else {
        const dir = Math.sign(x2 - x1)
        if (head) x2 -= dir * 8
        if (tail) x1 += dir * 8
        lines += `<path class="${cls}" d="M${r(x1)},${r(y)}H${r(x2)}"${head ? ` marker-end="url(#${head})"` : ''}${tail ? ` marker-start="url(#${tail})"` : ''}/>`
        front += text(e.lab, (x1 + x2) / 2, ly + e.lab.h / 2)
        const [a, b] = [x[e.from.i], x[e.to.i]].sort((p, q) => p - q)
        touch(Math.min(a - 6, (x1 + x2 - e.lab.w) / 2), Math.max(b + 6, (x1 + x2 + e.lab.w) / 2))
      }
      if (e.dies) {
        const p = e.dies
        p.died = y
        lines += `<path class="kill" d="M${r(x[p.i] - 9)},${r(y - 9)}l18,18m0,-18l-18,18"/>`
      }
      y += ROW
    } else if (e.t === 'note') {
      const ps = e.ps.map(p => p.i).sort((a, b) => a - b), p = ps[0], q = ps[ps.length - 1]
      const w = e.side === 'over' && p !== q ? Math.max(e.lab.w + 20, x[q] - x[p] + 40) : e.lab.w + 20
      const h = e.lab.h + 12
      const x0 = e.side === 'left of' ? x[p] - 12 - w : e.side === 'right of' ? x[p] + 12 : (x[p] + x[q]) / 2 - w / 2
      y += 4
      front += `<rect class="note" x="${r(x0)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="2"/>` + text(e.lab, x0 + w / 2, y + h / 2)
      touch(x0, x0 + w)
      y += h + ROW
    } else if (e.t === 'destroy') {
      if (e.p.doomed) e.p.died = y - ROW / 2
    } else if (e.t === 'activate') active[e.p.i].push(y - ROW / 2)
    else if (e.t === 'deactivate') {
      const d = active[e.p.i].length - 1
      if (d >= 0) bars.push({ p: e.p, y0: active[e.p.i].pop(), y1: y - ROW / 2, d })
    } else if (e.t === 'start') {
      y += 4
      blocks.push({ ev: e, y, lo: Infinity, hi: -Infinity, sections: [] })
      y += (e.lab ? e.lab.h : LINE) + 8
    } else if (e.t === 'section') {
      const b = blocks[blocks.length - 1]
      if (!b) continue
      b.sections.push({ y, lab: e.lab })
      y += (e.lab ? e.lab.h : 0) + 10
    } else if (e.t === 'end') {
      const b = blocks.pop()
      if (!b) continue
      const lo = (b.lo === Infinity ? x[0] : b.lo) - BLOCK, hi = (b.hi === -Infinity ? x[0] : b.hi) + BLOCK
      const y1 = y
      if (b.ev.kind === 'rect') {
        back += `<rect class="tint" x="${r(lo)}" y="${r(b.y)}" width="${r(hi - lo)}" height="${r(y1 - b.y)}"${b.ev.color ? ` style="fill:${esc(b.ev.color)}"` : ''}/>`
      } else {
        const kw = b.ev.kind, kwW = kw.length * 9 + 16
        front += `<rect class="block" x="${r(lo)}" y="${r(b.y)}" width="${r(hi - lo)}" height="${r(y1 - b.y)}"/>`
          + `<path class="tab" d="M${r(lo)},${r(b.y)}h${r(kwW)}v${r(LINE - 6)}l-6,6H${r(lo)}z"/>`
          + `<text class="kw" x="${r(lo + kwW / 2 - 2)}" y="${r(b.y + LINE / 2 + 5)}" text-anchor="middle">${esc(kw)}</text>`
        if (b.ev.lab) front += text(b.ev.lab, lo + kwW + 8, b.y + 4 + b.ev.lab.h / 2, 'cond', '', true)
        for (const s of b.sections) {
          front += `<path class="sep" d="M${r(lo)},${r(s.y)}H${r(hi)}"/>`
          if (s.lab) front += text(s.lab, lo + 8, s.y + 4 + s.lab.h / 2, 'cond', '', true)
        }
      }
      y += 8
      touch(lo, hi)
    }
  }
  for (let i = 0; i < parts.length; i++) for (const y0 of active[i]) bars.push({ p: parts[i], y0, y1: y, d: active[i].indexOf(y0) })
  const bottom = y + 4
  // Lifelines from each box down, activations on them, participant boxes on top.
  let life = ''
  for (const p of parts) {
    const y0 = p.born >= 0 ? p.born + boxH : top + boxH + (p.actor ? nameBand : 0)
    life += `<path class="life" d="M${r(x[p.i])},${r(y0)}V${r(p.died >= 0 ? p.died : bottom)}"/>`
    if (p.born < 0) boxes += actor(p, top)
  }
  const acts = bars.map(b => `<rect class="act" x="${r(x[b.p.i] - 5 + 5 * b.d)}" y="${r(b.y0)}" width="10" height="${r(Math.max(4, b.y1 - b.y0))}"/>`).join('')
  // Boxes around groups of participants, behind everything.
  let groupsOut = ''
  for (const g of groups) {
    if (!g.members.length) continue
    const lo = Math.min(...g.members.map(p => x[p.i] - width(p) / 2)) - 8, hi = Math.max(...g.members.map(p => x[p.i] + width(p) / 2)) + 8
    const y0 = top - (g.lab ? LINE + 4 : 0) - 4
    groupsOut += `<rect class="group" x="${r(lo)}" y="${r(y0)}" width="${r(hi - lo)}" height="${r(bottom - y0 + 4)}"${g.color ? ` style="fill:${esc(g.color)}"` : ''}/>`
    if (g.lab) groupsOut += text(g.lab, (lo + hi) / 2, y0 + 4 + g.lab.h / 2, 'title')
  }
  for (const p of parts) touch(x[p.i] - width(p) / 2 - (p.group ? 8 : 0), x[p.i] + width(p) / 2 + (p.group ? 8 : 0))
  const titleOut = title ? text(title, (left + right) / 2, title.h / 2, 'title') : ''
  const defs = '<defs><marker id="solid" class="arrow" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,1L10,5L0,9z"/></marker>'
    + '<marker id="open" class="arrow open" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,1L9,5L0,9"/></marker>'
    + '<marker id="x" class="arrow open" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M1,1L9,9M1,9L9,1"/></marker></defs>'
  const svg = `${defs}<g transform="translate(${r(-left)},0)">${groupsOut}${back}${life}${acts}${lines}${front}${boxes}${titleOut}</g>`
  return { w: right - left, h: bottom, svg }
}

export const css = c => `.actor{fill:${c.raised};stroke:${c.accent};stroke-width:1.5}`
  + `.figure *{fill:none;stroke:${c.accent};stroke-width:1.5}`
  + `.life{stroke:${c.ink2};stroke-opacity:.5;stroke-dasharray:4 4}`
  + `.act{fill:${c.raised};stroke:${c.ink2}}`
  + `.msg{fill:none;stroke:${c.ink2};stroke-width:1.5}.msg.dotted{stroke-dasharray:4 4}`
  + `.arrow{fill:${c.ink2};stroke:${c.ink2}}.arrow.open{fill:none;stroke-width:1.5}`
  + `.kill{stroke:${c.ink2};stroke-width:2}`
  + `.note{fill:${c.raised};stroke:${c.ink2}}`
  + `.block{fill:none;stroke:${c.ink2};stroke-opacity:.7;stroke-dasharray:3 3}.sep{stroke:${c.ink2};stroke-opacity:.7;stroke-dasharray:3 3}`
  + `.tab{fill:${c.raised};stroke:${c.ink2};stroke-opacity:.7}.kw{font-weight:600;font-size:15px}.cond{fill:${c.ink2};font-size:16px}`
  + `.tint{fill:${c.accent};fill-opacity:.08}.group{fill:${c.accent};fill-opacity:.05;stroke:${c.ink2};stroke-opacity:.4}`
  + `.tint[style],.group[style]{fill-opacity:.45}`
  + `.title{fill:${c.ink2};font-weight:600}.name{fill:${c.ink}}`
  + `.num{fill:${c.accent}}.numt{fill:${c.bg};font-size:12px;font-weight:700}`
