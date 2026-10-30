// Formulas in Claude's transcript. nook's mod saves each display formula Claude writes, $$ … $$ or \[ … \],
// as a .tex file and names that file as a picture; `pictures.js` hands it here with its box's size, and it
// comes back as an SVG drawn with MathJax at about the terminal's own text size, at the box's left. MathJax
// loads the first time a formula shows, so a session without one pays nothing for it. Its SVG is paths
// alone, so it draws the same apart from the page, where nook's web fonts aren't loaded.
import { invoke } from './host.js'

const EM = 1.15 // a formula's em, in the terminal's font sizes
const EX = 0.442 // MathJax's ex, in ems: the x-height of its TeX fonts
const SKIP = ['require', 'autoload', 'html'] // packages that load more code or reach outside the formula

let tex // TeX source -> the SVG MathJax draws for it, built once

async function load() {
  const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, { AllPackages }] = await Promise.all([
    import('mathjax-full/js/mathjax.js'), import('mathjax-full/js/input/tex.js'), import('mathjax-full/js/output/svg.js'),
    import('mathjax-full/js/adaptors/liteAdaptor.js'), import('mathjax-full/js/handlers/html.js'),
    import('mathjax-full/js/input/tex/AllPackages.js'),
  ])
  const adaptor = liteAdaptor()
  RegisterHTMLHandler(adaptor)
  const doc = mathjax.document('', {
    InputJax: new TeX({ packages: AllPackages.filter(p => !SKIP.includes(p)) }),
    OutputJax: new SVG({ fontCache: 'none' }), // each glyph's path in place, so the SVG stands alone
  })
  return source => adaptor.innerHTML(doc.convert(source, { display: true }))
}

/** The formula in the .tex file at `path`, as an SVG blob URL `width` by `height` pixels: at its own size,
 * or smaller to fit, centered top to bottom. */
export async function mathUrl(path, { width, height, fontSize }) {
  const source = await invoke('read_text', { path })
  const svg = (await (tex ??= load()))(source)
  const ex = EX * EM * fontSize
  const size = name => Number(new RegExp(`${name}="([\\d.]+)ex"`).exec(svg)?.[1] ?? 0) * ex
  const [w, h] = [size('width'), size('height')]
  const scale = Math.min(1, width / w, height / h) || 1
  const inner = svg.replace(/^<svg([^>]*?) width="[^"]*" height="[^"]*"/,
    `<svg$1 x="0" y="${((height - h * scale) / 2).toFixed(1)}" width="${(w * scale).toFixed(1)}" height="${(h * scale).toFixed(1)}"`)
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink-1').trim() || '#ddd'
  const page = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="color:${ink}">${inner}</svg>`
  return URL.createObjectURL(new Blob([page], { type: 'image/svg+xml' }))
}
