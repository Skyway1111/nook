// Builds src/fonts/nook-icons.woff2, the icons nook shows where Windows' Segoe Fluent Icons isn't installed.
//   node scripts/icons.mjs            fetches each icon's SVG from @fluentui/svg-icons at VERSION
//   node scripts/icons.mjs <folder>   reads them from a folder, such as that package's icons/
// nook writes each icon as a Segoe Fluent Icons character, so this font draws a Fluent UI System Icon, Microsoft's
// MIT-licensed set in the same style, at the same code point. style.css lists it after Segoe, so Windows never
// uses it. An icon nook starts using needs a line in ICONS and a run of this script.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'

// Segoe Fluent Icons code point: the Fluent UI icon, at 20px regular, that stands in for it.
const ICONS = {
  0xE700: 'navigation', // GlobalNavButton: the menu
  0xE70D: 'chevron_down',
  0xE70F: 'edit',
  0xE710: 'add',
  0xE711: 'dismiss', // Cancel
  0xE713: 'settings',
  0xE718: 'pin',
  0xE72A: 'arrow_right', // Forward
  0xE72B: 'arrow_left', // Back
  0xE724: 'send', // a quick prompt sent as typed
  0xE738: 'subtract', // a checkbox's mixed state
  0xE73E: 'checkmark',
  0xE721: 'search', // find in Claude's output
  0xE73F: 'full_screen_minimize', // BackToWindow: leave focus mode
  0xE740: 'full_screen_maximize', // FullScreen: focus mode
  0xE74A: 'arrow_up',
  0xE74B: 'arrow_down',
  0xE74D: 'delete',
  0xE74E: 'save',
  0xE753: 'cloud_arrow_up', // a remote branch
  0xE756: 'window_console', // CommandPrompt: a Claude session
  0xE76C: 'chevron_right',
  0xE771: 'paint_brush', // Personalize: the wallpaper
  0xE777: 'arrow_reset',
  0xE77A: 'pin_off',
  0xE77F: 'clipboard_paste',
  0xE790: 'color', // a theme
  0xE7A7: 'arrow_undo',
  0xE7AC: 'apps', // OpenWith
  0xE7C4: 'window_multiple', // TaskView: the sessions dashboard
  0xE768: 'play', // continue the last session
  0xE81C: 'history', // resume a saved session
  0xE838: 'folder_open',
  0xE890: 'eye', // View: preview
  0xE895: 'arrow_sync',
  0xE896: 'arrow_download', // pull
  0xE898: 'arrow_upload', // push
  0xE8A5: 'document',
  0xE8AC: 'rename',
  0xE8B7: 'folder',
  0xE8BB: 'dismiss', // ChromeClose
  0xE8C6: 'cut',
  0xE8C8: 'copy',
  0xE8D2: 'text_font',
  0xE8E5: 'open',
  0xE8F4: 'folder_add',
  0xE90F: 'info', // Properties
  0xE921: 'subtract', // ChromeMinimize
  0xE922: 'maximize',
  0xE923: 'square_multiple', // ChromeRestore
  0xE943: 'code',
  0xE945: 'flash', // LightningBolt: a quick prompt
  0xEB9F: 'image',
  0xEDA2: 'hard_drive',
  0xF000: 'document_text',
  0xF003: 'branch_fork', // nook's own: a session in a git worktree
  0xF004: 'split_vertical', // nook's own: open a tab beside another
}

const VERSION = '1.1.344' // of @fluentui/svg-icons, whose SVGs are the Fluent repo's after svgo
const UPM = 1000 // font units to the em; an icon's 20px box fills it, as a Segoe icon does
const ASCENT = 800, DESCENT = 200
const SCALE = UPM / 20
const STAMP = Date.UTC(2026, 9, 9) / 1000 + 2082844800 // VERSION's release, in seconds from 1904, so a rebuild is the same file

const NUM = /[\s,]*([-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?)/y
const FLAG = /[\s,]*([01])/y
const COMMAND = /[\s,]*([A-Za-z])/y

/** An SVG's paths in font units, as contours of rounded points: [x, y] to start and for each line, and
 * [x1, y1, x2, y2, x, y] for each cubic. A quadratic is raised to a cubic in font units from the unrounded last point. */
function outline(svg) {
  const contours = []
  let contour, px, py
  const font = p => p.map((v, i) => i & 1 ? ASCENT - SCALE * v : SCALE * v)
  const put = f => { px = f.at(-2); py = f.at(-1); contour.push(f.map(v => Math.floor(v + 0.5))) }
  const draw = (...p) => put(font(p))
  const quad = (...p) => {
    const [a, b, x, y] = font(p), k = 2 / 3
    put([px + k * (a - px), py + k * (b - py), x + k * (a - x), y + k * (b - y), x, y])
  }
  for (const [, path] of svg.matchAll(/<path[^>]*\sd="([^"]*)"/g)) {
    const d = path.trim()
    let i = 0, cmd = '', last, abs, x = 0, y = 0, sx, sy, cx, cy // cx, cy: the last control point
    const read = (re, optional) => {
      re.lastIndex = i
      const m = re.exec(d)
      if (m) i = re.lastIndex
      else if (!optional) throw new Error(`bad path at ${i}: ${d}`)
      return m?.[1]
    }
    const n = () => +read(NUM), flag = () => read(FLAG) == '1'
    while (i < d.length) {
      last = cmd
      const c = read(COMMAND, true)
      if (c) { cmd = c.toUpperCase(); abs = c == cmd }
      const ox = abs ? 0 : x, oy = abs ? 0 : y
      switch (cmd) {
        case 'M': sx = x = ox + n(); sy = y = oy + n(); contours.push(contour = []); draw(x, y); cmd = 'L'; break
        case 'Z': if (x != sx || y != sy) draw(sx, sy); x = sx; y = sy; cmd = ''; break
        case 'L': draw(x = ox + n(), y = oy + n()); break
        case 'H': draw(x = ox + n(), y); break
        case 'V': draw(x, y = oy + n()); break
        case 'C': draw(ox + n(), oy + n(), cx = ox + n(), cy = oy + n(), x = ox + n(), y = oy + n()); break
        case 'S': // its first handle mirrors the last, after a cubic
          draw(...(/[CS]/.test(last) ? [2 * x - cx, 2 * y - cy] : [x, y]), cx = ox + n(), cy = oy + n(), x = ox + n(), y = oy + n())
          break
        case 'Q': quad(cx = ox + n(), cy = oy + n(), x = ox + n(), y = oy + n()); break
        case 'T': [cx, cy] = /[QT]/.test(last) ? [2 * x - cx, 2 * y - cy] : [x, y]; quad(cx, cy, x = ox + n(), y = oy + n()); break
        case 'A': arc(x, y, Math.abs(n()), Math.abs(n()), n(), flag(), flag(), x = ox + n(), y = oy + n(), draw); break
        default: throw new Error(`unexpected ${cmd || 'number'} at ${i}: ${d}`)
      }
    }
  }
  return contours
}

/** An SVG arc as cubics, a quarter turn at most each, by Blink's DecomposeArcToCubic. The last ends on the arc's
 * own end point, so an end on a half unit rounds the same under every V8. */
function arc(x0, y0, rx, ry, deg, large, sweep, x1, y1, draw) {
  if (deg) throw new Error('a rotated arc') // no Fluent icon has one
  if (x0 == x1 && y0 == y1) return
  if (!rx || !ry) return draw(x1, y1)
  const hx = (x0 - x1) * 0.5, hy = (y0 - y1) * 0.5, k = hx * hx / (rx * rx) + hy * hy / (ry * ry)
  if (k > 1) { rx *= Math.sqrt(k); ry *= Math.sqrt(k) }
  // the ends on the unit circle
  const ux = 1 / rx, uy = 1 / ry, ax = ux * x0, ay = uy * y0, bx = ux * x1, by = uy * y1
  const dx = bx - ax, dy = by - ay
  let f = Math.sqrt(Math.max(1 / (dx * dx + dy * dy) - 0.25, 0))
  if (sweep == large) f = -f
  const ox = (ax + bx) * 0.5 - dy * f, oy = (ay + by) * 0.5 + dx * f
  const from = Math.atan2(ay - oy, ax - ox)
  let span = Math.atan2(by - oy, bx - ox) - from
  if (span < 0 && sweep) span += 2 * Math.PI
  else if (span > 0 && !sweep) span -= 2 * Math.PI
  const n = Math.ceil(Math.abs(span / (Math.PI / 2 + 0.001)))
  for (let i = 0; i < n; i++) {
    const a = from + i * span / n, b = from + (i + 1) * span / n
    const t = 4 / 3 * Math.tan(0.25 * (b - a))
    const sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b)
    draw(rx * (ca - t * sa + ox), ry * (sa + t * ca + oy), rx * (cb + ox + t * sb), ry * (sb + oy - t * cb),
      ...i < n - 1 ? [rx * (cb + ox), ry * (sb + oy)] : [x1, y1])
  }
}

/** The glyph's bounds [xMin, yMin, xMax, yMax], a cubic's extremes rather than its handles. */
function bounds(glyph) {
  const b = [Infinity, Infinity, -Infinity, -Infinity]
  const add = (v, a) => { b[a] = Math.min(b[a], v); b[a + 2] = Math.max(b[a + 2], v) }
  for (const contour of glyph) for (let j = 0; j < contour.length; j++) for (const a of [0, 1]) {
    const p = contour[j], q0 = contour[j - 1]?.at(a - 2), q3 = p.at(a - 2)
    if (p.length == 6) {
      const q1 = p[a], q2 = p[a + 2]
      const A = q3 - 3 * q2 + 3 * q1 - q0, B = 2 * (q0 - 2 * q1 + q2), C = q1 - q0, D = B * B - 4 * A * C
      for (const t of A ? D < 0 ? [] : [(-B + Math.sqrt(D)) / (2 * A), (-B - Math.sqrt(D)) / (2 * A)] : B ? [-C / B] : []) {
        if (t > 0 && t < 1) add((1 - t) ** 3 * q0 + 3 * (1 - t) ** 2 * t * q1 + 3 * (1 - t) * t * t * q2 + t ** 3 * q3, a)
      }
    }
    add(q3, a)
  }
  return [Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[2]), Math.ceil(b[3])]
}

/** v as a CFF number, in a charstring or a DICT: they agree to 16 bits, and only a DICT holds more. */
const num = v => v >= -107 && v <= 107 ? [v + 139]
  : v >= 108 && v <= 1131 ? [(v - 108 >> 8) + 247, v - 108 & 255]
  : v <= -108 && v >= -1131 ? [(-v - 108 >> 8) + 251, -v - 108 & 255]
  : v >= -32768 && v <= 32767 ? [28, v >> 8 & 255, v & 255]
  : [29, ...u32(v)]
const u16 = v => [v >> 8 & 255, v & 255]
const u32 = v => [v >>> 24, v >> 16 & 255, v >> 8 & 255, v & 255]
const ascii = s => [...s].map(c => c.charCodeAt(0))

// A segment is its deltas, [dx, dy] for a line and six for a cubic. An operator takes a run of them: per segment k of
// the run, the arguments it gives, and whether the run may end there (0), must (1), or can't (2); or nothing.
const line = s => s.length == 2
// Cubics leaving and arriving along one axis, a = 0 for x; the first may leave at any angle.
const along = (s, k, a) => !line(s) && !s[5 - a] && !(k && s[1 - a])
  && [[...s[1 - a] ? [s[1 - a]] : [], s[a], s[2], s[3], s[4 + a]], 0]
// A cubic leaving along one axis and arriving along the other, or at an angle to end the run.
const turn = (s, a) => !line(s) && !s[1 - a] && [[s[a], s[2], s[3], s[5 - a], ...s[4 + a] ? [s[4 + a]] : []], s[4 + a] ? 1 : 0]
const OPS = [
  [5, s => line(s) && [s, 0]], // rlineto
  [6, (s, k) => line(s) && !s[~k & 1] && [[s[k & 1]], 0]], // hlineto: across, up, across...
  [7, (s, k) => line(s) && !s[k & 1] && [[s[~k & 1]], 0]], // vlineto
  [8, s => !line(s) && [s, 0]], // rrcurveto
  [24, (s, k) => line(s) ? k && [s, 1] : [s, 2]], // rcurveline: cubics, then a line
  [25, (s, k) => line(s) ? [s, 2] : k && [s, 1]], // rlinecurve: lines, then a cubic
  [27, (s, k) => along(s, k, 0)], // hhcurveto
  [26, (s, k) => along(s, k, 1)], // vvcurveto
  [31, (s, k) => turn(s, k & 1)], // hvcurveto
  [30, (s, k) => turn(s, ~k & 1)], // vhcurveto
]

/** A contour's segments in the fewest bytes, from every run of every operator that fits Type 2's 48 arguments. */
function encode(segs) {
  const best = [{ size: 0 }]
  for (let i = 0; i < segs.length; i++) for (const [op, take] of OPS) {
    const args = []
    let size = best[i].size + 1
    for (let j = i; j < segs.length; j++) {
      const t = take(segs[j], j - i)
      if (!t || args.push(...t[0]) > 48) break
      for (const v of t[0]) size += num(v).length
      if (t[1] < 2 && !(best[j + 1]?.size <= size)) best[j + 1] = { size, i, code: [...args.flatMap(num), op] }
      if (t[1] == 1) break
    }
  }
  const out = []
  for (let j = segs.length; j; j = best[j].i) out.unshift(...best[j].code)
  return out
}

/** A glyph as a Type 2 charstring, its width the Private DICT's default. A cubic with its handles on its ends is a
 * line, empty lines go, two lines in a row along one axis join, and a last line back to the start goes: a contour
 * closes itself, and the next moveto starts from where it ended. */
function charstring(glyph) {
  const out = []
  let x = 0, y = 0
  for (const [[x0, y0], ...points] of glyph) {
    const segs = []
    let cx = x0, cy = y0
    for (const p of points) {
      let s = []
      for (let i = 0; i < p.length; i += 2) { s.push(p[i] - cx, p[i + 1] - cy); cx = p[i]; cy = p[i + 1] }
      if (!line(s) && !(s[0] || s[1] || s[4] || s[5])) s = [s[2], s[3]]
      const q = segs.at(-1)
      if (line(s) && !(s[0] || s[1])) continue
      if (line(s) && q && line(q) && (!q[0] && !s[0] || !q[1] && !s[1])) { q[0] += s[0]; q[1] += s[1] } else segs.push(s)
    }
    if (segs.length && line(segs.at(-1)) && cx == x0 && cy == y0) { const [dx, dy] = segs.pop(); cx -= dx; cy -= dy }
    if (!segs.length) continue
    const dx = x0 - x, dy = y0 - y
    out.push(...dy ? dx ? [...num(dx), ...num(dy), 21] : [...num(dy), 4] : [...num(dx), 22], ...encode(segs))
    x = cx; y = cy
  }
  return [...out, 14]
}

/** A CFF INDEX of byte arrays. */
function index(items) {
  if (!items.length) return [0, 0]
  const offsets = [1]
  for (const b of items) offsets.push(offsets.at(-1) + b.length)
  const end = offsets.at(-1), size = end < 0x100 ? 1 : end < 0x10000 ? 2 : end < 0x1000000 ? 3 : 4
  return [...u16(items.length), size, ...offsets.flatMap(o => u32(o).slice(4 - size)), ...items.flat()]
}

/** The CFF table. Its glyphs take CFF's standard strings 229 to 390 as names, none of them in StandardEncoding, so
 * the one string it stores is FullName (391). ICONS says what each glyph is. */
function cff(charstrings, bbox) {
  if (charstrings.length > 163) throw new Error('more icons than standard strings 229 to 390')
  const head = [1, 0, 4, 4, ...index([ascii('nookicons')])]
  const tail = [...index([ascii('nook icons')]), 0, 0] // the strings, and no global subroutines
  const charset = [2, ...u16(229), ...u16(charstrings.length - 2)]
  const glyphs = index(charstrings)
  const priv = [...num(UPM), 20] // defaultWidthX
  const dict = at => [...num(391), 2, ...bbox.flatMap(num), 5, ...num(at), 15,
    ...num(at + charset.length), 17, ...num(priv.length), ...num(at + charset.length + glyphs.length), 18]
  let top = [], size
  do { size = top.length; top = dict(head.length + 5 + size + tail.length) } while (top.length != size)
  return [...head, ...index([top]), ...tail, ...charset, ...glyphs, ...priv]
}

/** A format 4 cmap of [code, glyph] by code: a run of codes is a delta when its glyphs run on too, else a list. */
function cmap(map) {
  const runs = []
  for (const [c, g] of map) {
    const r = runs.at(-1)
    if (r && c == r.end + 1) { r.end = c; r.glyphs.push(g) } else runs.push({ start: c, end: c, glyphs: [g] })
  }
  runs.push({ start: 0xFFFF, end: 0xFFFF, glyphs: [0] })
  const n = runs.length, log = 31 - Math.clz32(n), deltas = [], ranges = [], list = []
  runs.forEach((r, i) => {
    if (r.glyphs.every((g, k) => g == r.glyphs[0] + k)) { deltas.push(r.glyphs[0] - r.start); ranges.push(0) }
    else { deltas.push(0); ranges.push(2 * (n - i + list.length)); list.push(...r.glyphs) }
  })
  const sub = [4, 16 + 8 * n + 2 * list.length, 0, 2 * n, 2 << log, log, 2 * n - (2 << log),
    ...runs.map(r => r.end), 0, ...runs.map(r => r.start), ...deltas, ...ranges, ...list]
  return [0, 1, 3, 1, 0, 12, ...sub].flatMap(u16)
}

const names = [...new Set(Object.values(ICONS))].sort()
const dir = process.argv[2]
const glyphs = await Promise.all(names.map(async name => {
  const file = `${name}_20_regular.svg`
  if (dir) return outline(readFileSync(join(dir, file), 'utf8'))
  const res = await fetch(`https://cdn.jsdelivr.net/npm/@fluentui/svg-icons@${VERSION}/icons/${file}`)
  if (!res.ok) throw new Error(`${file}: ${res.status}`)
  return outline(await res.text())
}))

const boxes = glyphs.map(bounds)
const bbox = [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
  Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))]
const widest = Math.max(...boxes.map(b => b[2] - b[0])) // every glyph's left side bearing is 0
const codes = Object.entries(ICONS).map(([c, name]) => [+c, names.indexOf(name) + 1])
const utf16 = s => [...s].flatMap(c => u16(c.charCodeAt(0)))
const family = utf16('nook icons'), style = utf16('Regular')
const tables = {
  'CFF ': cff([[14], ...glyphs.map(charstring)], bbox),
  'OS/2': [ // version 3; fsType 4, preview and print; Unicode range bit 60, the Private Use Area
    ...[3, UPM, 400, 5, 4, ...Array(11).fill(0)].flatMap(u16), ...Array(10).fill(0), ...[0, 1 << 28, 0, 0].flatMap(u32),
    ...ascii('????'), ...[0, codes[0][0], codes.at(-1)[0], ASCENT, -DESCENT, 0, ASCENT, DESCENT].flatMap(u16),
    ...[0, 0].flatMap(u32), ...[0, 0, 0, 32, 0].flatMap(u16)],
  cmap: cmap(codes),
  head: [...[0x10000, 0x10000, 0, 0x5F0F3CF5].flatMap(u32), ...u16(0x0803), ...u16(UPM), ...[0, STAMP, 0, STAMP].flatMap(u32),
    ...[...bbox, 0, 3, 2, 0, 0].flatMap(u16)],
  hhea: [...u32(0x10000), ...[ASCENT, -DESCENT, 0, UPM, 0, UPM - widest, widest, 1, 0, 0, 0, 0, 0, 0, 0, 1].flatMap(u16)],
  hmtx: [UPM, ...Array(names.length + 1).fill(0)].flatMap(u16),
  maxp: [...u32(0x5000), ...u16(names.length + 1)],
  name: [0, 2, 30, 3, 1, 0x409, 1, family.length, 0, 3, 1, 0x409, 2, style.length, family.length].flatMap(u16)
    .concat(family, style),
  post: [...[0x30000, 0].flatMap(u32), 0, 0, 0, 0, ...Array(5).fill(0).flatMap(u32)],
}

// The font as a browser's WOFF2 decoder rebuilds it, for its size and the head table's checksum.
const tags = Object.keys(tables).sort()
const sum = b => {
  let s = 0
  for (let i = 0; i < b.length; i += 4) s = s + (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0
  return s
}
let sfntSize = 12 + 16 * tags.length
const directory = []
for (const t of tags) {
  directory.push(...ascii(t), ...u32(sum(tables[t])), ...u32(sfntSize), ...u32(tables[t].length))
  sfntSize += tables[t].length + 3 & ~3
}
const log = 31 - Math.clz32(tags.length)
const sfnt = [...ascii('OTTO'), ...[tags.length, 16 << log, log, 16 * tags.length - (16 << log)].flatMap(u16), ...directory]
tables.head.splice(8, 4, ...u32(0xB1B0AFBA - tags.reduce((s, t) => s + sum(tables[t]), sum(sfnt)) >>> 0))

// WOFF2: each table by its index among WOFF2's known tags, untransformed, then all of them in one brotli stream.
const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ']
const base128 = v => { const b = [v & 127]; while (v >>>= 7) b.unshift(v & 127 | 128); return b }
const data = brotliCompressSync(Buffer.from(tags.flatMap(t => tables[t]))) // its generic mode beats its font mode here
const entries = tags.flatMap(t => [KNOWN.indexOf(t), ...base128(tables[t].length)])
const length = 48 + entries.length + data.length + 3 & ~3
const header = [...ascii('wOF2OTTO'), ...u32(length), ...u16(tags.length), 0, 0, ...u32(sfntSize), ...u32(data.length),
  ...u16(1), ...u16(0), ...Array(20).fill(0), ...entries]
const out = new URL('../src/fonts/nook-icons.woff2', import.meta.url)
writeFileSync(out, Buffer.concat([Buffer.from(header), data, Buffer.alloc(length - header.length - data.length)]))
console.log(`src/fonts/nook-icons.woff2: ${names.length} icons, ${length} B`)
