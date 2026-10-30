// Diagrams in Claude's transcript. nook's mod saves each ```mermaid block Claude writes as a .mmd file and
// names that file as a picture; `pictures.js` hands it here, and it comes back as an SVG in the theme's
// colors. Mermaid loads the first time a diagram shows, so a session without one pays nothing for it. Its
// strict mode keeps a diagram to shapes and text, and the SVG draws as a background image, which runs no
// script.
import { invoke } from './host.js'

let mermaid // the library, imported once
let made = 0 // names each render's scratch element

/** A theme variable's color as `rgb()`, which mermaid can mix, whatever color syntax the theme wrote. */
function color(name) {
  const g = (color.canvas ??= new OffscreenCanvas(1, 1)).getContext('2d', { willReadFrequently: true })
  g.clearRect(0, 0, 1, 1)
  g.fillStyle = '#000'
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
  g.fillRect(0, 0, 1, 1)
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data
  return `rgb(${r}, ${gr}, ${b})`
}

/** The diagram in the .mmd file at `path`, as an SVG blob URL. */
export async function diagramUrl(path) {
  const text = await invoke('read_text', { path })
  const m = await (mermaid ??= import('mermaid').then(m => m.default))
  const style = getComputedStyle(document.documentElement)
  const [bg, raised, ink, ink2, accent] = ['--bg', '--raised', '--ink-1', '--ink-2', '--accent'].map(color)
  // The theme can change between diagrams, so each render takes its colors anew.
  m.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    // A system font: the picture draws apart from the page, where nook's own web fonts aren't loaded, and
    // labels measured in one font and drawn in another overflow their boxes.
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    htmlLabels: false,
    // Tighter than mermaid's own spacing, so the labels stay readable once the diagram fits a few dozen rows.
    flowchart: { htmlLabels: false, nodeSpacing: 24, rankSpacing: 28, padding: 8, diagramPadding: 4 },
    sequence: { actorMargin: 30, messageMargin: 24, diagramMarginX: 4, diagramMarginY: 4 },
    themeVariables: {
      darkMode: style.getPropertyValue('--scheme').trim() !== 'light',
      background: bg, mainBkg: raised, primaryColor: raised, secondaryColor: raised, tertiaryColor: bg,
      primaryTextColor: ink, secondaryTextColor: ink, tertiaryTextColor: ink, textColor: ink, titleColor: ink,
      primaryBorderColor: accent, secondaryBorderColor: ink2, tertiaryBorderColor: ink2, lineColor: ink2,
      noteBkgColor: raised, noteTextColor: ink, noteBorderColor: ink2, actorBkg: raised, actorBorder: accent,
      actorTextColor: ink, signalColor: ink2, signalTextColor: ink, labelBoxBkgColor: raised, labelTextColor: ink,
      edgeLabelBackground: bg, clusterBkg: bg, clusterBorder: ink2, fontSize: '18px',
    },
  })
  const { svg } = await m.render(`nook-diagram-${++made}`, text)
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
}
