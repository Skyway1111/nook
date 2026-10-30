// mermaid's pie: slices in the order written, clockwise from twelve o'clock, each in its own color, with
// its share on it and a legend beside.
import { label, text, measure, r, LINE } from './labels.js'

const R = 130 // px, the pie's radius
const SWATCH = 16 // px, a legend entry's square

/** The pie chart in `src` (its first line the header) as { w, h, svg }. */
export function draw(src, c) {
  const lines = src.split('\n')
  let title = /\btitle\s+(.*)$/.exec(lines[0])?.[1] ?? '', show = /\bshowData\b/.test(lines[0])
  const slices = []
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    let m
    if ((m = /^title\s+(.*)$/.exec(line))) title = m[1]
    else if (line === 'showData') show = true
    else if ((m = /^(["'])(.*)\1\s*:\s*(\d*\.?\d+)/.exec(line)) && Number(m[3]) > 0) slices.push([m[2], Number(m[3])])
  }
  if (!slices.length) throw new Error('no slices')
  const total = slices.reduce((s, [, v]) => s + v, 0)
  if (!Number.isFinite(total)) throw new Error('no total')
  // Each slice's share: on the slice where it fits, else after its name in the legend.
  let at = 0
  const arcs = slices.map(([, v]) => {
    const a0 = (at / total) * 2 * Math.PI, a1 = ((at += v) / total) * 2 * Math.PI, share = (100 * v) / total
    const words = `${share < 10 ? +share.toFixed(1) : Math.round(share)}%`
    return { a0, a1, words, fits: (a1 - a0) * 0.66 * R >= measure(words, 1) + 6 }
  })
  const head = title ? label(title, false, 2 * R + 200) : null, top = head ? head.h + 12 : 0
  const legend = slices.map(([name, v], k) => label(`${name}${show ? ` [${+v.toFixed(2)}]` : ''}${arcs[k].fits ? '' : ` (${arcs[k].words})`}`, false, 280))
  const legendH = legend.reduce((s, l) => s + l.h + 6, -6), lx = 2 * R + 36
  const cy = top + Math.max(R, legendH / 2)
  let out = ''
  const p = a => [R + R * Math.sin(a), cy - R * Math.cos(a)]
  arcs.forEach(({ a0, a1, words, fits }, k) => {
    if (slices.length === 1) out += `<circle class="slice" cx="${R}" cy="${r(cy)}" r="${R}" fill="${c.cat(k)}"/>`
    else out += `<path class="slice" d="M${R},${r(cy)}L${p(a0).map(r)}A${R},${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1).map(r)}z" fill="${c.cat(k)}"/>`
    const mid = (a0 + a1) / 2
    if (fits) out += `<text class="share" x="${r(R + 0.66 * R * Math.sin(mid))}" y="${r(cy - 0.66 * R * Math.cos(mid) + 6)}" text-anchor="middle">${words}</text>`
  })
  let y = cy - legendH / 2
  legend.forEach((l, k) => {
    out += `<rect x="${lx}" y="${r(y + LINE / 2 - SWATCH / 2)}" width="${SWATCH}" height="${SWATCH}" rx="3" fill="${c.cat(k)}"/>` + text(l, lx + SWATCH + 8, y + l.h / 2, '', '', true)
    y += l.h + 6
  })
  const w = lx + SWATCH + 8 + Math.max(...legend.map(l => l.w))
  if (head) out = text(head, Math.max(w, head.w) / 2, head.h / 2, 'ptitle') + out
  return { w: Math.max(w, head?.w ?? 0), h: top + 2 * Math.max(R, legendH / 2), svg: out }
}

export const css = c => `.slice{stroke:${c.bg};stroke-width:2}.share{fill:${c.onCat};font-weight:600}.ptitle{font-weight:600;fill:${c.ink2}}`
