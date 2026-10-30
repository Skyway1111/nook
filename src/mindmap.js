// mermaid's mindmap: the root in the middle, its branches to either side, each a tree growing outward,
// each branch in its own color. The tree is read from the lines' indents.
import { label, text, r } from './labels.js'

const PX = 14, PY = 8 // px around a node's label
const GX = 40, GY = 12 // px from a node to its children, and between two siblings' subtrees
// Openers and closers, longest first, with the shape each pair makes.
const SHAPES = [['((', '))', 'circle'], ['))', '((', 'bang'], ['{{', '}}', 'hex'], ['(', ')', 'round'], [')', '(', 'cloud'], ['[', ']', 'square']]

/** A node's line as its text, whether that is markdown, and its shape. */
function parse(t) {
  let kind = 'plain'
  for (const [open, close, k] of SHAPES) {
    const i = t.indexOf(open)
    if (i < 0 || !t.endsWith(close) || t.length < i + open.length + close.length || /\s/.test(t.slice(0, i))) continue
    t = t.slice(i + open.length, t.length - close.length)
    kind = k
    break
  }
  const md = /^"`([\s\S]*)`"$/.exec(t)
  return { text: md ? md[1] : t.replace(/^"(.*)"$/, '$1'), md: !!md, kind }
}

/** The mindmap in `src` (its first line the header) as { w, h, svg }. */
export function draw(src, c) {
  let root = null
  const stack = []
  for (const raw of src.split('\n').slice(1)) {
    const t = raw.trim()
    if (!t || t.startsWith('%%') || t.startsWith('::icon(') || t.startsWith(':::')) continue
    const indent = /^\s*/.exec(raw)[0].replace(/\t/g, '    ').length
    const n = { ...parse(t), kids: [], indent }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    if (!root) root = n
    else (stack[stack.length - 1] ?? root).kids.push(n)
    stack.push(n)
  }
  if (!root) throw new Error('no root')

  // Sizes, and each subtree's height.
  const size = (n, depth, branch) => {
    n.depth = depth
    n.branch = branch
    n.lab = label(n.text, n.md)
    n.w = n.lab.w + 2 * PX
    n.h = n.lab.h + 2 * PY
    if (n.kind === 'circle') n.w = n.h = Math.hypot(n.lab.w, n.lab.h) + 16
    else if (n.kind === 'hex') n.w += n.h / 2
    else if (n.kind === 'bang') n.w += 24, (n.h += 16)
    else if (n.kind === 'cloud') n.w += 16, (n.h += 6)
    n.kids.forEach((k, i) => size(k, depth + 1, depth ? branch : i))
    const span = n.kids.reduce((s, k) => s + k.sh, 0) + GY * (n.kids.length - 1)
    n.sh = Math.max(n.h, span)
  }
  size(root, 0, -1)
  // The root's branches split into a right side and a left, by how tall their trees are.
  const total = root.kids.reduce((s, k) => s + k.sh, 0)
  let acc = 0
  const right = [], left = []
  for (const k of root.kids) (acc < total / 2 || !right.length ? right : left).push(k), (acc += k.sh)
  const place = (n, x, top, dir) => {
    n.x = x
    n.y = top + n.sh / 2
    n.dir = dir
    const span = n.kids.reduce((s, k) => s + k.sh, 0) + GY * (n.kids.length - 1)
    let y = n.y - span / 2
    for (const k of n.kids) place(k, x + dir * (n.w / 2 + GX + k.w / 2), y, dir), (y += k.sh + GY)
  }
  root.x = 0
  root.y = 0
  for (const [side, dir] of [[right, 1], [left, -1]]) {
    let y = -(side.reduce((s, k) => s + k.sh, 0) + GY * (side.length - 1)) / 2
    for (const k of side) place(k, dir * (root.w / 2 + GX + k.w / 2), y, dir), (y += k.sh + GY)
  }
  const all = []
  const walk = n => (all.push(n), n.kids.forEach(walk))
  walk(root)
  const x0 = Math.min(...all.map(n => n.x - n.w / 2)), y0 = Math.min(...all.map(n => n.y - n.h / 2))
  const x1 = Math.max(...all.map(n => n.x + n.w / 2)), y1 = Math.max(...all.map(n => n.y + n.h / 2))
  // A plain node past the first ring is its text over a line in its branch's color, which its edges meet.
  const underline = n => n.kind === 'plain' && n.depth > 1
  const port = (n, dir) => [n.x + dir * n.w / 2, underline(n) ? n.y + n.h / 2 - 1 : n.y]
  let edges = '', nodes = ''
  for (const n of all) {
    for (const k of n.kids) {
      const [ax, ay] = port(n, k.dir), [bx, by] = port(k, -k.dir), mx = (ax + bx) / 2
      edges += `<path class="edge" d="M${r(ax)},${r(ay)}C${r(mx)},${r(ay)} ${r(mx)},${r(by)} ${r(bx)},${r(by)}" stroke="${c.cat(k.branch)}" stroke-width="${Math.max(1.5, 4.5 - k.depth)}"/>`
    }
    const color = n.depth ? c.cat(n.branch) : c.accent, cls = n.depth ? (n.depth === 1 ? 'node first' : 'node') : 'node root'
    const x = n.x, y = n.y, w = n.w, h = n.h, at = `fill="${color}" stroke="${color}"`
    if (underline(n)) nodes += `<path class="line" d="M${r(x - w / 2)},${r(y + h / 2 - 1)}h${r(w)}" stroke="${color}"/>`
    else if (n.kind === 'circle') nodes += `<circle class="${cls}" cx="${r(x)}" cy="${r(y)}" r="${r(w / 2)}" ${at}/>`
    else if (n.kind === 'hex') nodes += `<polygon class="${cls}" points="${[[-w / 2, 0], [-w / 2 + h / 4, -h / 2], [w / 2 - h / 4, -h / 2], [w / 2, 0], [w / 2 - h / 4, h / 2], [-w / 2 + h / 4, h / 2]].map(([px, py]) => `${r(x + px)},${r(y + py)}`).join(' ')}" ${at}/>`
    else if (n.kind === 'bang') {
      // A burst: points around an ellipse, every other one pulled in.
      const pts = Array.from({ length: 24 }, (_, i) => {
        const a = (i / 24) * 2 * Math.PI, k = i % 2 ? 0.86 : 1
        return `${r(x + (k * w * Math.cos(a)) / 2)},${r(y + (k * h * Math.sin(a)) / 2)}`
      })
      nodes += `<polygon class="${cls}" points="${pts.join(' ')}" ${at}/>`
    } else nodes += `<rect class="${cls}" x="${r(x - w / 2)}" y="${r(y - h / 2)}" width="${r(w)}" height="${r(h)}" rx="${n.kind === 'square' ? 2 : n.kind === 'cloud' ? h / 2 : 8}" ${at}/>`
    nodes += text(n.lab, x, y, n.depth ? '' : 'rootT')
  }
  return { w: x1 - x0, h: y1 - y0, svg: `<g transform="translate(${r(-x0)},${r(-y0)})">${edges}${nodes}</g>` }
}

export const css = c => `.edge{fill:none;stroke-linecap:round}.line{stroke-width:2;stroke-linecap:round}`
  + `.node{fill-opacity:.12;stroke-width:1.5}.node.first{fill-opacity:.3}.node.root{fill:${c.raised};fill-opacity:1;stroke-width:2.5}.rootT{font-weight:600}`
