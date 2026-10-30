// mermaid's gitGraph: commits left to right in the order written, each branch a lane in its own color,
// branching and merging lines between them, tags over their commits.
import { label, text, esc, r, measure, FAMILY } from './labels.js'

const LANE = 56 // px between lanes
const COL = 50 // px a commit's column takes at least
const DOT = 9 // px, a commit's radius
const BEND = 14 // px, the radius a line turns between lanes with
const SMALL = `14px ${FAMILY}`

/** The git graph in `src` (its first line the header) as { w, h, svg }. */
export function draw(src, c) {
  const branches = new Map(), commits = []
  let cur = null
  const branch = (name, order) => {
    let b = branches.get(name)
    if (!b) branches.set(name, (b = { name, head: cur?.head ?? -1, order: order ?? branches.size, k: branches.size }))
    return b
  }
  cur = branch('main')
  for (const raw of src.split('\n').slice(1)) {
    const line = raw.trim()
    const m = /^(commit|branch|checkout|switch|merge|cherry-pick)\b\s*(.*)$/.exec(line)
    if (!m) continue
    const attrs = {}
    let rest = m[2].replace(/(\w+):\s*(?:"([^"]*)"|(\S+))/g, (_, k, q, v) => ((attrs[k] = q ?? v), ''))
    rest = rest.trim().replace(/^"(.*)"$/, '$1')
    const add = parents => {
      commits.push({ id: attrs.id, tag: attrs.tag, type: (attrs.type ?? '').toUpperCase(), branch: cur, parents: parents.filter(p => p >= 0) })
      cur.head = commits.length - 1
      return commits[commits.length - 1]
    }
    if (m[1] === 'commit') add([cur.head])
    else if (m[1] === 'branch' && rest) {
      const order = attrs.order === undefined ? undefined : Number(attrs.order)
      cur = branch(rest, order)
    } else if (m[1] === 'checkout' || m[1] === 'switch') cur = branch(rest)
    else if (m[1] === 'merge' && branches.has(rest)) add([cur.head, branches.get(rest).head]).merge = true
    else if (m[1] === 'cherry-pick') {
      // The commit it copies names it; its own id is new.
      const from = attrs.id
      delete attrs.id
      add([cur.head]).picked = from ? `cherry-pick: ${from}` : 'cherry-pick'
    }
  }
  if (!commits.length) throw new Error('no commits')

  // Lanes in branch order; a branch with no commits takes none.
  const used = [...branches.values()].filter(b => commits.some(k => k.branch === b)).sort((a, b) => a.order - b.order || a.k - b.k)
  used.forEach((b, i) => (b.lane = i))
  const names = used.map(b => label(b.name))
  const left = Math.max(...names.map(l => l.w)) + 36
  const tags = commits.some(k => k.tag) ? 30 : 4
  const laneY = b => tags + b.lane * LANE + LANE / 2
  // Columns, each as wide as its commit's labels need.
  let x = left
  for (const k of commits) {
    const words = [k.id, k.picked, k.tag].filter(Boolean)
    const w = Math.max(COL, ...words.map(t => measure(t, 0, SMALL) + 16))
    k.x = x + w / 2
    x += w
  }
  let lines = '', dots = '', words = ''
  used.forEach((b, i) => {
    const y = laneY(b), l = names[i], color = c.cat(i)
    lines += `<path class="lane" d="M${left - 8},${y}H${r(x)}"/>`
    words += `<rect class="bname" x="0" y="${r(y - l.h / 2 - 5)}" width="${r(l.w + 20)}" height="${r(l.h + 10)}" rx="6" fill="${color}" stroke="${color}"/>` + text(l, 10, y, '', '', true)
  })
  for (const k of commits) {
    const y = laneY(k.branch), color = c.cat(k.branch.lane)
    for (const p of k.parents) {
      const q = commits[p], py = laneY(q.branch)
      let d
      if (py === y) d = `M${r(q.x)},${py}H${r(k.x)}`
      else if (y > py) d = `M${r(q.x)},${py}V${y - BEND}Q${r(q.x)},${y} ${r(q.x + BEND)},${y}H${r(k.x)}`
      else d = `M${r(q.x)},${py}H${r(k.x - BEND)}Q${r(k.x)},${py} ${r(k.x)},${py - BEND}V${y}`
      lines += `<path class="link" d="${d}" stroke="${c.cat((y > py ? k.branch : q.branch).lane)}"/>`
    }
    if (k.type === 'HIGHLIGHT') dots += `<rect class="dot" x="${r(k.x - DOT)}" y="${y - DOT}" width="${2 * DOT}" height="${2 * DOT}" rx="2" fill="${color}"/>`
    else if (k.merge) dots += `<circle class="ring" cx="${r(k.x)}" cy="${y}" r="${DOT}" stroke="${color}"/><circle cx="${r(k.x)}" cy="${y}" r="4" fill="${color}"/>`
    else dots += `<circle class="dot" cx="${r(k.x)}" cy="${y}" r="${DOT}" fill="${color}"/>`
    if (k.type === 'REVERSE') dots += `<path class="cross" d="M${r(k.x - 4)},${y - 4}l8,8m0,-8l-8,8"/>`
    const under = k.picked ?? k.id
    if (under) words += `<text class="cid" x="${r(k.x)}" y="${y + DOT + 18}" text-anchor="middle">${esc(under)}</text>`
    if (k.tag) {
      const tw = measure(k.tag, 0, SMALL) + 12, ty = y - DOT - 14
      words += `<path class="tag" d="M${r(k.x - tw / 2)},${ty - 10}h${r(tw)}v20h${r(-tw)}l-6,-10z"/><text class="tagT" x="${r(k.x)}" y="${ty + 5}" text-anchor="middle">${esc(k.tag)}</text>`
    }
  }
  return { w: x + 8, h: tags + used.length * LANE + 8, svg: lines + dots + words }
}

export const css = c => `.lane{stroke:${c.ink2};stroke-opacity:.25;stroke-dasharray:2 5}.link{fill:none;stroke-width:4;stroke-linecap:round}`
  + `.dot{stroke:${c.bg};stroke-width:2}.ring{fill:${c.bg};stroke-width:3}.cross{stroke:${c.bg};stroke-width:2}`
  + `.bname{fill-opacity:.3;stroke-width:1.5}.cid{font-size:14px;fill:${c.ink2}}`
  + `.tag{fill:${c.raised};stroke:${c.ink2}}.tagT{font-size:14px}`
