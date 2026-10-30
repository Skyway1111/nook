// mermaid's gantt: a bar a task on a time axis, in sections. Dates are read by the chart's dateFormat and
// kept in UTC, so a chart draws the same anywhere.
import { label, text, esc, r, measure, FAMILY } from './labels.js'

const DAY = 864e5
const ROW = 34 // px a task's row takes
const BAR = 24 // px a bar's height
const UNITS = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: DAY, w: 7 * DAY }
const MONTHS = 'January February March April May June July August September October November December'.split(' ')
const DAYS = 'Sunday Monday Tuesday Wednesday Thursday Friday Saturday'.split(' ')
// Tick spacings, each with its default label format.
const STEPS = [[36e5, '%H:%M'], [3 * 36e5, '%H:%M'], [6 * 36e5, '%H:%M'], [12 * 36e5, '%b %e %H:%M'], [DAY, '%b %e'], [2 * DAY, '%b %e'], [7 * DAY, '%b %e'], [14 * DAY, '%b %e'], [-1, '%b %Y'], [-3, '%b %Y'], [-12, '%Y']]

/** A reader of dates written in mermaid's (dayjs's) `format`, to ms in UTC, NaN when one doesn't match. */
function reader(format) {
  const keys = []
  const SPEC = { YYYY: '(\\d{4})', YY: '(\\d{2})', MM: '(\\d{1,2})', M: '(\\d{1,2})', DD: '(\\d{1,2})', D: '(\\d{1,2})', HH: '(\\d{1,2})', H: '(\\d{1,2})', mm: '(\\d{1,2})', m: '(\\d{1,2})', ss: '(\\d{1,2})', s: '(\\d{1,2})', SSS: '(\\d{1,3})', X: '(\\d+(?:\\.\\d+)?)', x: '(\\d+)' }
  const re = new RegExp(`^${format.replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|m|ss|s|SSS|X|x|[.*+?^${}()|[\]\\]/g, t => (SPEC[t] ? (keys.push(t), SPEC[t]) : '\\' + t))}$`)
  return s => {
    const m = re.exec(s.trim())
    if (!m) return Date.parse(s.trim().replace(' ', 'T') + (/\d:\d\d$/.test(s.trim()) ? 'Z' : ''))
    const v = { Y: 1970, M: 1, D: 1, H: 0, m: 0, s: 0, S: 0 }
    keys.forEach((k, i) => {
      const n = Number(m[i + 1])
      if (k === 'X' || k === 'x') v.X = k === 'X' ? n * 1000 : n
      else v[k[0]] = k === 'YY' ? 2000 + n : n
    })
    return v.X ?? Date.UTC(v.Y, v.M - 1, v.D, v.H, v.m, v.s, v.S)
  }
}

/** `t` (ms, UTC) written by a strftime format: %Y %y %m %d %e %b %B %a %A %H %I %M %S %p %j %%. */
function strftime(t, f) {
  const d = new Date(t), two = n => String(n).padStart(2, '0')
  const day = Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1
  const by = { Y: d.getUTCFullYear(), y: two(d.getUTCFullYear() % 100), m: two(d.getUTCMonth() + 1), d: two(d.getUTCDate()), e: d.getUTCDate(), b: MONTHS[d.getUTCMonth()].slice(0, 3), B: MONTHS[d.getUTCMonth()], a: DAYS[d.getUTCDay()].slice(0, 3), A: DAYS[d.getUTCDay()], H: two(d.getUTCHours()), I: two(d.getUTCHours() % 12 || 12), M: two(d.getUTCMinutes()), S: two(d.getUTCSeconds()), p: d.getUTCHours() < 12 ? 'AM' : 'PM', j: String(day).padStart(3, '0'), '%': '%' }
  return f.replace(/%-?([a-zA-Z%])/g, (all, k) => by[k] ?? all)
}

/** The gantt chart in `src` (its first line the header) as { w, h, svg }. */
export function draw(src, c) {
  let read = reader('YYYY-MM-DD'), axis = '', title = '', section = -1
  const sections = [], tasks = [], byId = new Map(), excludes = []
  for (const raw of src.split('\n').slice(1)) {
    const line = raw.trim()
    let m
    if (!line || line.startsWith('%%')) continue
    if ((m = /^dateFormat\s+(.+)$/.exec(line))) read = reader(m[1].trim())
    else if ((m = /^axisFormat\s+(.+)$/.exec(line))) axis = m[1].trim()
    else if ((m = /^title\s+(.+)$/.exec(line))) title = m[1]
    else if ((m = /^excludes\s+(.+)$/.exec(line))) excludes.push(...m[1].toLowerCase().split(/[\s,]+/).filter(Boolean))
    else if ((m = /^section\s+(.*)$/.exec(line))) sections.push(label(m[1], false, 180)), (section = sections.length - 1)
    else if (/^(?:todayMarker|tickInterval|weekday|weekend|includes|inclusiveEndDates|topAxis|displayMode|click|vert|accTitle|accDescr)\b/.test(line)) continue
    else if ((m = /^([^:]+?)\s*:\s*(.*)$/.exec(line))) {
      const parts = m[2].split(',').map(s => s.trim())
      const t = { name: m[1], section, tags: new Set() }
      while (parts.length > 1 && /^(?:done|active|crit|milestone)$/.test(parts[0])) t.tags.add(parts.shift())
      if (parts.length === 1 && /^(?:done|active|crit|milestone)$/.test(parts[0])) t.tags.add(parts.shift())
      if (parts.length >= 3) [t.id, t.from, t.to] = parts
      else if (parts.length === 2) [t.from, t.to] = parts
      else t.to = parts[0] ?? ''
      if (t.id) byId.set(t.id, t)
      tasks.push(t)
    }
  }
  if (!tasks.length) throw new Error('no tasks')

  // Excluded days: weekends, weekday names, and dates; a task measured in time stretches over them.
  const off = new Set(excludes.flatMap(x => (x === 'weekends' ? ['saturday', 'sunday'] : [x])))
  const skipped = t => {
    const d = new Date(t)
    return off.has(DAYS[d.getUTCDay()].toLowerCase()) || off.has(new Date(t - (t % DAY)).toISOString().slice(0, 10))
  }
  const stretch = (start, end) => {
    if (!off.size || end - start > 3650 * DAY) return end
    for (let d = start - (start % DAY); d < end; d += DAY) if (skipped(d)) end += DAY
    return end
  }
  // Each task's start and end, in passes, since `after` and `until` can name a task further down.
  for (let pass = 0; pass < 4 && tasks.some(t => t.end === undefined); pass++) {
    let prev = NaN
    for (const t of tasks) {
      if (t.end !== undefined) { prev = t.end; continue }
      let start = NaN
      const after = /^after\s+(.+)$/.exec(t.from ?? '')
      if (after) start = Math.max(...after[1].split(/\s+/).map(id => byId.get(id)?.end ?? NaN))
      else if (t.from) start = read(t.from)
      else start = prev
      if (Number.isNaN(start) && pass === 3) start = Number.isNaN(prev) ? Math.min(...tasks.map(o => o.start ?? Infinity)) : prev
      if (Number.isNaN(start)) { prev = NaN; continue }
      let end = NaN
      const dur = /^(\d*\.?\d+)\s*(ms|s|m|h|d|w)$/.exec(t.to), until = /^until\s+(\S+)/.exec(t.to)
      if (dur) end = stretch(start, start + Number(dur[1]) * UNITS[dur[2]])
      else if (until) end = byId.get(until[1])?.start ?? NaN
      else end = read(t.to)
      if (Number.isNaN(end) && pass === 3) end = start + DAY
      if (Number.isNaN(end)) { prev = NaN; continue }
      t.start = start
      t.end = Math.max(start, end)
      prev = t.end
    }
  }
  const shown = tasks.filter(t => t.end !== undefined && Number.isFinite(t.start))
  if (!shown.length) throw new Error('no dates')
  const t0 = Math.min(...shown.map(t => t.start)), t1 = Math.max(...shown.map(t => t.end), t0 + 36e5)
  const span = t1 - t0, area = Math.min(960, Math.max(560, (span / DAY) * 30)), x = t => ((t - t0) / span) * area

  // Across: a column of section names, then the time area. Down: the title, a row a task, the axis.
  const left = sections.length ? Math.max(...sections.map(s => s.w)) + 24 : 0
  const head = title ? label(title, false, left + area) : null, top = head ? head.h + 14 : 0
  const bottom = top + shown.length * ROW
  let back = '', bars = '', words = ''
  // Ticks: the finest spacing that leaves each label room.
  const [step, fmt] = STEPS.find(([s]) => (s > 0 ? s : -s * 30.4 * DAY) * (area / span) >= 96) ?? STEPS[STEPS.length - 1]
  const ticks = []
  if (step > 0) {
    // Days and longer align to midnight, weeks to Monday.
    let t = Math.ceil(t0 / Math.min(step, DAY)) * Math.min(step, DAY)
    if (step === 7 * DAY || step === 14 * DAY) while (new Date(t).getUTCDay() !== 1) t += DAY
    for (; t <= t1; t += step) ticks.push(t)
  } else {
    const d = new Date(t0)
    for (let k = 1; ; k++) {
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1)
      if (t > t1) break
      if ((d.getUTCMonth() + k) % -step === 0) ticks.push(t)
    }
  }
  if (off.size && span <= 400 * DAY) for (let d = t0 - (t0 % DAY); d < t1; d += DAY) if (skipped(d)) back += `<rect class="off" x="${r(left + Math.max(0, x(d)))}" y="${top}" width="${r(Math.min(x(d + DAY), area) - Math.max(0, x(d)))}" height="${shown.length * ROW}"/>`
  for (const t of ticks) back += `<path class="grid" d="M${r(left + x(t))},${top}V${bottom + 4}"/><text class="tick" x="${r(left + x(t))}" y="${bottom + 22}" text-anchor="middle">${esc(strftime(t, axis || fmt))}</text>`
  // Section bands and names, each section in its color.
  sections.forEach((s, k) => {
    const rows = shown.map((t, i) => [t, i]).filter(([t]) => t.section === k)
    if (!rows.length) return
    const y0 = top + rows[0][1] * ROW, y1 = top + (rows[rows.length - 1][1] + 1) * ROW
    back = `<rect class="band" x="0" y="${y0}" width="${r(left + area)}" height="${y1 - y0}" fill="${c.cat(k)}"/>` + back
    words += text(s, 8, (y0 + y1) / 2, 'section', '', true)
  })
  shown.forEach((t, i) => {
    const color = t.tags.has('crit') ? c.crit : c.cat(Math.max(0, t.section))
    const cls = t.tags.has('done') ? 'bar done' : t.tags.has('active') ? 'bar active' : 'bar'
    const y = top + i * ROW + ROW / 2, w = measure(t.name, 0, `16px ${FAMILY}`)
    let x0 = left + x(t.start), x1 = left + Math.max(x(t.end), x(t.start) + 2), tx, anchor = ''
    if (t.tags.has('milestone')) {
      const mx = (x0 + x1) / 2, s = BAR / 2
      bars += `<path class="${cls}" d="M${r(mx)},${r(y - s)}l${s},${s}l${-s},${s}l${-s},${-s}z" fill="${color}" stroke="${color}"/>`
      x0 = mx - s, x1 = mx + s
    } else bars += `<rect class="${cls}" x="${r(x0)}" y="${r(y - BAR / 2)}" width="${r(x1 - x0)}" height="${BAR}" rx="4" fill="${color}" stroke="${color}"/>`
    // Its name inside the bar when it fits, else beside it where there's room.
    if (!t.tags.has('milestone') && w + 16 <= x1 - x0) tx = (x0 + x1) / 2, (anchor = ' text-anchor="middle"')
    else if (x1 + 8 + w <= left + area) tx = x1 + 8
    else tx = x0 - 8, (anchor = ' text-anchor="end"')
    words += `<text class="task"${anchor} x="${r(tx)}" y="${r(y + 6)}">${esc(t.name)}</text>`
  })
  let out = back + bars + words
  const w = Math.max(left + area, head?.w ?? 0)
  if (head) out = text(head, w / 2, head.h / 2, 'gtitle') + out
  return { w, h: bottom + 30, svg: out }
}

export const css = c => `.band{fill-opacity:.07}.off{fill:${c.ink2};fill-opacity:.08}.grid{stroke:${c.ink2};stroke-opacity:.25}`
  + `.tick{fill:${c.ink2};font-size:14px}.section{fill:${c.ink2};font-weight:600}.gtitle{font-weight:600;fill:${c.ink2}}`
  + `.bar{fill-opacity:.35;stroke-width:1.5}.bar.active{fill-opacity:.7}.bar.done{fill:${c.ink2};stroke:${c.ink2};fill-opacity:.18;stroke-opacity:.6}`
  + `.task{font-size:16px}`
