// mermaid's timeline and journey: columns along an arrow, grouped under sections, each section in its own
// color. A timeline's column is a period with its events stacked under it; a journey's is a task, with a
// face for how it felt and dots for who took part.
import { label, text, esc, r } from './labels.js'

const PX = 12, PY = 8 // px around a box's label
const GAP = 16 // px between columns
const WRAP = 180 // px a label's lines wrap at
const STEP = 26 // px between a journey's scores

/** The timeline or journey in `src` (its first line the header) as { w, h, svg }. */
export function draw(src, c) {
  const journey = /^\s*journey\b/.test(src)
  const sections = [], cols = [], actors = []
  let title = null
  for (const raw of src.split('\n').slice(1)) {
    const line = raw.trim()
    let m
    if (!line || line.startsWith('%%') || /^acc(?:Title|Descr)\b/.test(line)) continue
    if ((m = /^title\s+(.*)$/.exec(line))) title = label(m[1], false, 600)
    else if ((m = /^section\s+(.*)$/.exec(line))) sections.push(label(m[1], false, WRAP))
    else if (journey) {
      if (!(m = /^(.+?)\s*:\s*(\d+)\s*(?::\s*(.*))?$/.exec(line))) continue
      const who = (m[3] ?? '').split(',').map(a => a.trim()).filter(Boolean)
      for (const a of who) if (!actors.includes(a)) actors.push(a)
      cols.push({ section: sections.length - 1, lab: label(m[1], false, WRAP), score: Math.min(5, Math.max(1, Number(m[2]))), who: who.map(a => actors.indexOf(a)) })
    } else if (line.startsWith(':')) cols[cols.length - 1]?.events.push(...line.slice(1).split(':').map(e => label(e.trim(), false, WRAP)))
    else {
      const [period, ...events] = line.split(/\s*:\s*/)
      cols.push({ section: sections.length - 1, lab: label(period, false, WRAP), events: events.filter(Boolean).map(e => label(e, false, WRAP)) })
    }
  }
  if (!cols.length) throw new Error('no columns')

  const color = (col, k) => c.cat(sections.length ? Math.max(0, col.section) : k)
  const labs = cols.flatMap(col => [col.lab, ...(col.events ?? [])])
  const colW = Math.max(140, ...labs.map(l => l.w)) + 2 * PX
  // A journey's actors, listed at its left.
  const names = actors.map(a => label(a))
  const left = names.length ? Math.max(...names.map(l => l.w)) + 40 : 0
  const x = k => left + k * (colW + GAP)
  const w = Math.max(x(cols.length) - GAP, title?.w ?? 0)
  let y = 0, out = ''
  if (title) out += text(title, w / 2, title.h / 2, 'ttitle'), (y += title.h + 14)
  if (sections.length) {
    const h = Math.max(...sections.map(s => s.h)) + 2 * PY
    sections.forEach((s, k) => {
      const mine = cols.map((col, i) => [col, i]).filter(([col]) => col.section === k)
      if (!mine.length) return
      const x0 = x(mine[0][1]), x1 = x(mine[mine.length - 1][1]) + colW
      out += `<rect class="sec" x="${r(x0)}" y="${r(y)}" width="${r(x1 - x0)}" height="${r(h)}" rx="5" fill="${c.cat(k)}" stroke="${c.cat(k)}"/>` + text(s, (x0 + x1) / 2, y + h / 2, 'secT')
    })
    y += h + 10
  }
  const headH = Math.max(...cols.map(col => col.lab.h)) + 2 * PY + (journey ? 10 : 0)
  names.forEach((l, k) => {
    out += `<circle cx="8" cy="${r(y + k * (l.h + 6) + l.h / 2)}" r="6" fill="${c.cat(sections.length + k)}"/>` + text(l, 22, y + k * (l.h + 6) + l.h / 2, '', '', true)
  })
  cols.forEach((col, k) => {
    const cx = x(k), cc = color(col, k)
    out += `<rect class="head" x="${r(cx)}" y="${r(y)}" width="${r(colW)}" height="${r(headH)}" rx="5" fill="${cc}" stroke="${cc}"/>` + text(col.lab, cx + colW / 2, y + headH / 2 + (journey ? 4 : 0))
    if (journey) col.who.forEach((a, i) => (out += `<circle cx="${r(cx + 10 + i * 12)}" cy="${r(y + 9)}" r="5" fill="${c.cat(sections.length + a)}"/>`))
  })
  y += headH
  // The arrow time runs along.
  const axis = y + 24
  out += `<path class="axis" d="M${left},${r(axis)}H${r(x(cols.length) - GAP + 14)}" marker-end="url(#tip)"/>`
  let bottom = axis + 12
  if (journey) {
    // A face a task, as high as it scored, joined in a line.
    const face = col => [x(cols.indexOf(col)) + colW / 2, axis + 36 + (5 - col.score) * STEP]
    out += `<path class="mood" d="M${cols.map(col => face(col).map(r).join(',')).join('L')}"/>`
    for (const col of cols) {
      const [fx, fy] = face(col), mouth = col.score >= 4 ? `M${r(fx - 6)},${r(fy + 3)}Q${r(fx)},${r(fy + 9)} ${r(fx + 6)},${r(fy + 3)}` : col.score === 3 ? `M${r(fx - 6)},${r(fy + 5)}h12` : `M${r(fx - 6)},${r(fy + 8)}Q${r(fx)},${r(fy + 2)} ${r(fx + 6)},${r(fy + 8)}`
      out += `<path class="guide" d="M${r(fx)},${r(y)}V${r(fy - 15)}"/><circle class="face" cx="${r(fx)}" cy="${r(fy)}" r="15"/>`
        + `<circle class="eye" cx="${r(fx - 5)}" cy="${r(fy - 4)}" r="1.8"/><circle class="eye" cx="${r(fx + 5)}" cy="${r(fy - 4)}" r="1.8"/><path class="mouth" d="${mouth}"/>`
    }
    bottom = axis + 36 + 4 * STEP + 16
  } else {
    cols.forEach((col, k) => {
      const cx = x(k), cc = color(col, k)
      let ey = axis + 22
      out += `<path class="guide" d="M${r(cx + colW / 2)},${r(y)}V${r(col.events.length ? ey : axis)}"/><circle cx="${r(cx + colW / 2)}" cy="${r(axis)}" r="4" fill="${cc}"/>`
      for (const e of col.events) {
        const h = e.h + 2 * PY
        out += `<rect class="event" x="${r(cx + 6)}" y="${r(ey)}" width="${r(colW - 12)}" height="${r(h)}" rx="4" fill="${cc}" stroke="${cc}"/>` + text(e, cx + colW / 2, ey + h / 2)
        ey += h + 8
      }
      bottom = Math.max(bottom, ey - 8)
    })
  }
  const defs = '<defs><marker id="tip" class="tip" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,1L10,5L0,9z"/></marker></defs>'
  return { w: Math.max(w, x(cols.length) - GAP + 24), h: Math.max(bottom, y + names.length * 28), svg: defs + out }
}

export const css = c => `.ttitle{font-weight:600;fill:${c.ink2}}.sec{fill-opacity:.45;stroke-width:1.5}.secT{font-weight:600}`
  + `.head{fill-opacity:.22;stroke-width:1.5}.event{fill-opacity:.08;stroke-opacity:.6}`
  + `.axis{stroke:${c.ink2};stroke-width:2}.tip{fill:${c.ink2}}.guide{stroke:${c.ink2};stroke-opacity:.4;stroke-dasharray:3 4}`
  + `.mood{fill:none;stroke:${c.ink2};stroke-opacity:.55;stroke-width:2}.face{fill:${c.raised};stroke:${c.ink2};stroke-width:1.5}`
  + `.eye{fill:${c.ink2}}.mouth{fill:none;stroke:${c.ink2};stroke-width:1.5;stroke-linecap:round}`
