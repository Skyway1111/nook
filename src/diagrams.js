// Diagrams in Claude's transcript. nook's mod saves each ```mermaid block Claude writes as a .mmd file and
// names that file as a picture; `pictures.js` hands it here, and it comes back as an SVG in the theme's
// colors. The SVG draws as a background image, which runs no script, and every label in it is escaped.
// A diagram this can't read shows its source instead, so the box is never blank.
import { invoke } from './host.js'
import { flowchart, css as flowCss } from './flowchart.js'
import { sequence, css as sequenceCss } from './sequence.js'
import { FONT, FAMILY, esc, measure, label, text as labelText, r } from './labels.js'

const MARGIN = 4 // px around the drawing
const MONO = '13px "Cascadia Mono", Consolas, monospace'
const LEGACY = /^(?:classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|gantt|pie|gitGraph|mindmap|timeline|journey|quadrantChart|xychart(?:-beta)?|sankey(?:-beta)?|C4\w+|block(?:-beta)?|architecture(?:-beta)?|requirementDiagram|packet(?:-beta)?|kanban|radar-beta|treemap(?:-beta)?)$/

/** A theme variable's color as `rgb()`, whatever color syntax the theme wrote. */
function color(name) {
  const g = (color.canvas ??= new OffscreenCanvas(1, 1)).getContext('2d', { willReadFrequently: true })
  g.clearRect(0, 0, 1, 1)
  g.fillStyle = '#000'
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
  g.fillRect(0, 0, 1, 1)
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data
  return `rgb(${r},${gr},${b})`
}

/** The diagram in the .mmd file at `path`, as an SVG blob URL, fit to `box` ({ width, height, fontSize }
 * in px): its text never larger than 1.15 × the terminal's, as a formula's. */
export async function diagramUrl(path, box) {
  const text = await invoke('read_text', { path })
  // The theme can change between diagrams, so each render takes its colors anew.
  const [bg, raised, ink, ink2, accent] = ['--bg', '--raised', '--ink-1', '--ink-2', '--accent'].map(color)
  const svg = await diagram(text, { bg, raised, ink, ink2, accent }, box)
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
}

/** `text`, a mermaid diagram, as an SVG document. */
async function diagram(text, c, box) {
  const lines = text.replace(/\r/g, '').split('\n')
  // Front matter (---) holds settings and maybe a title; %% lines are comments; the next line names the kind.
  let k = 0, title = ''
  if (lines[0]?.trim() === '---') {
    for (k = 1; k < lines.length && lines[k].trim() !== '---'; k++) title = /^title\s*:\s*(.*)$/.exec(lines[k].trim())?.[1].replace(/^(["'])(.*)\1$/, '$2') ?? title
    k++
  }
  while (k < lines.length && (!lines[k].trim() || /^\s*%%/.test(lines[k]))) k++
  const src = lines.slice(k).join('\n')
  const kind = /^\s*([\w-]+)/.exec(src)?.[1] ?? ''
  let d = null
  try {
    if (/^(?:flowchart(?:-v2|-elk)?|graph)$/.test(kind)) d = { ...flowchart(src), css: flowCss(c) }
    else if (kind === 'sequenceDiagram') d = { ...sequence(src), css: sequenceCss(c) }
    else if (LEGACY.test(kind)) return await legacy(text, c)
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

let mermaid // the library, for the kinds drawn here not yet
/** A kind this module doesn't draw yet, by mermaid. */
async function legacy(text, c) {
  const m = await (mermaid ??= import('mermaid').then(m => m.default))
  m.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: FAMILY,
    htmlLabels: false,
    themeVariables: {
      darkMode: getComputedStyle(document.documentElement).getPropertyValue('--scheme').trim() !== 'light',
      background: c.bg, mainBkg: c.raised, primaryColor: c.raised, secondaryColor: c.raised, tertiaryColor: c.bg,
      primaryTextColor: c.ink, secondaryTextColor: c.ink, tertiaryTextColor: c.ink, textColor: c.ink, titleColor: c.ink,
      primaryBorderColor: c.accent, secondaryBorderColor: c.ink2, tertiaryBorderColor: c.ink2, lineColor: c.ink2,
      noteBkgColor: c.raised, noteTextColor: c.ink, noteBorderColor: c.ink2, labelBoxBkgColor: c.raised, labelTextColor: c.ink,
      edgeLabelBackground: c.bg, clusterBkg: c.bg, clusterBorder: c.ink2, fontSize: '18px',
    },
  })
  return (await m.render(`nook-diagram-${(legacy.made = (legacy.made ?? 0) + 1)}`, text)).svg
}
