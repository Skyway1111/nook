// Diagrams in Claude's transcript. nook's mod saves each ```mermaid block Claude writes as a .mmd file and
// names that file as a picture; `pictures.js` hands it here, and it comes back as an SVG in the theme's
// colors. The SVG draws as a background image, which runs no script, and every label in it is escaped.
// A diagram this can't read shows its source instead, so the box is never blank.
import { invoke } from './host.js'
import * as flowchart from './flowchart.js'
import * as sequence from './sequence.js'
import * as classes from './classes.js'
import * as states from './states.js'
import * as er from './er.js'
import * as pie from './pie.js'
import * as gantt from './gantt.js'
import * as mindmap from './mindmap.js'
import * as timeline from './timeline.js'
import * as gitgraph from './gitgraph.js'
import { FONT, FAMILY, esc, measure, label, text as labelText, r } from './labels.js'

const MARGIN = 4 // px around the drawing
const MONO = '13px "Cascadia Mono", Consolas, monospace'
// Each kind nook draws, by the word that starts it: a module's `draw(src, colors)` and `css(colors)`.
const KINDS = {
  flowchart, 'flowchart-v2': flowchart, 'flowchart-elk': flowchart, graph: flowchart, sequenceDiagram: sequence,
  classDiagram: classes, 'classDiagram-v2': classes, stateDiagram: states, 'stateDiagram-v2': states, erDiagram: er,
  pie, gantt, mindmap, timeline, journey: timeline, gitGraph: gitgraph,
}

/** A theme variable's color as sRGB channels (0-255), whatever color syntax the theme wrote. */
function color(name) {
  const g = (color.canvas ??= new OffscreenCanvas(1, 1)).getContext('2d', { willReadFrequently: true })
  g.clearRect(0, 0, 1, 1)
  g.fillStyle = '#000'
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
  g.fillRect(0, 0, 1, 1)
  return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)]
}

/** sRGB channels (0-255) as OKLCH: lightness, chroma, and hue in degrees. */
function oklch(rgb) {
  const [R, G, B] = rgb.map(c => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, Math.hypot(a, b), (Math.atan2(b, a) * 180) / Math.PI]
}

/** OKLCH as linear sRGB channels, outside 0-1 where it's out of gamut. */
function linear(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
}

/** OKLCH as an sRGB `rgb()`, with less chroma until it fits. */
function paint(L, C, h) {
  let lo = 0, hi = C
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    if (linear(L, mid, h).every(c => c >= -1e-4 && c <= 1.0001)) lo = mid
    else hi = mid
  }
  const [R, G, B] = linear(L, lo, h).map(c => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055)))
  return `rgb(${R},${G},${B})`
}

/** The theme's colors for a diagram. `cat(k)` colors a chart's kth category: the accent's hue turned k golden
 * angles, at about its lightness and chroma. `onCat` is text on those, and `crit` a red at their lightness. */
function palette() {
  const [bg, raised, ink, ink2, accent] = ['--bg', '--raised', '--ink-1', '--ink-2', '--accent'].map(color)
  const [L0, C0, h] = oklch(accent)
  const L = Math.min(0.8, Math.max(0.6, L0)), C = Math.min(0.16, Math.max(0.1, C0)), cats = []
  const rgb = c => `rgb(${c.join(',')})`
  return {
    bg: rgb(bg), raised: rgb(raised), ink: rgb(ink), ink2: rgb(ink2), accent: rgb(accent),
    cat: k => (cats[k] ??= paint(L, C, h + k * 137.508)),
    onCat: rgb(Math.abs(oklch(ink)[0] - L) > Math.abs(oklch(bg)[0] - L) ? ink : bg),
    crit: paint(L, Math.max(C, 0.14), 25),
  }
}

/** The diagram in the .mmd file at `path`, as an SVG blob URL, fit to `box` ({ width, height, fontSize }
 * in px): its text never larger than 1.15 × the terminal's, as a formula's. */
export async function diagramUrl(path, box) {
  // The theme can change between diagrams, so each render takes its colors anew.
  const svg = diagram(await invoke('read_text', { path }), palette(), box)
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
}

/** `text`, a mermaid diagram, as an SVG document. */
function diagram(text, c, box) {
  const lines = text.replace(/\r/g, '').split('\n')
  // Front matter (---) holds settings and maybe a title; %% lines are comments; the next line names the kind.
  let k = 0, title = ''
  if (lines[0]?.trim() === '---') {
    for (k = 1; k < lines.length && lines[k].trim() !== '---'; k++) title = /^title\s*:\s*(.*)$/.exec(lines[k].trim())?.[1].replace(/^(["'])(.*)\1$/, '$2') ?? title
    k++
  }
  while (k < lines.length && (!lines[k].trim() || /^\s*%%/.test(lines[k]))) k++
  const src = lines.slice(k).filter(l => !/^\s*%%/.test(l)).join('\n')
  const kind = KINDS[/^\s*([\w-]+)/.exec(src)?.[1]]
  let d = null
  try {
    if (kind) d = { ...kind.draw(src, c), css: kind.css(c) }
  } catch (e) {
    console.warn('diagram', e)
  }
  if (d && title) {
    // The front matter's title, over the drawing.
    const t = label(title)
    d = { ...d, w: Math.max(d.w, t.w), h: d.h + t.h + 8, svg: `${labelText(t, 0, t.h / 2, 'heading', '', true)}<g transform="translate(0,${r(t.h + 8)})">${d.svg}</g>`, css: d.css + `.heading{font-weight:600;fill:${c.ink2}}` }
  }
  return frame(d ?? listing(text, c), c, box)
}

/** The source itself, in monospace: what a diagram this can't draw shows. */
function listing(text, c) {
  const rows = text.replace(/\t/g, '  ').replace(/\s+$/, '').split('\n')
  const w = Math.max(0, ...rows.map(row => measure(row, 0, MONO)))
  const svg = `<text class="src">${rows.map((row, i) => `<tspan x="0" y="${16 * i + 12}">${esc(row) || ' '}</tspan>`).join('')}</text>`
  return { w, h: rows.length * 16, svg, css: `.src{font:${MONO};fill:${c.ink2};white-space:pre}` }
}

/** The drawing as an SVG document at its natural size. When its text would show larger than the cap in
 * `box`, its view grows to the box's shape, so it draws at the cap, at the left, centered. */
function frame(d, c, box) {
  const w = d.w + 2 * MARGIN, h = d.h + 2 * MARGIN
  let vw = w, vh = h, top = 0
  if (box?.width && box.height) {
    const cap = (1.15 * box.fontSize) / FONT, fit = Math.min(box.width / w, box.height / h)
    if (fit > cap) vw = box.width / cap, (vh = box.height / cap), (top = (vh - h) / 2)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r(vw)}" height="${r(vh)}" viewBox="${r(-MARGIN)} ${r(-MARGIN - top)} ${r(vw)} ${r(vh)}">`
    + `<style>text{font-family:${FAMILY};font-size:${FONT}px;fill:${c.ink}}${d.css}</style>${d.svg}</svg>`
}
