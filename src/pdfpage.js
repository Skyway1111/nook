// The first page of a PDF in Claude's transcript. nook's mod names a PDF Claude read or a command saved as a
// picture; `pictures.js` hands it here with its box's size, and the page comes back as a PNG blob URL drawn
// with pdf.js at the box's pixel size. pdf.js and its worker load the first time a PDF shows, so a session
// without one pays nothing for them. Scripts in the PDF never run: pdf.js only runs them in its viewer.
import { convertFileSrc } from './host.js'

let pdfjs // pdf.js, with its worker set, loaded once

async function load() {
  const [lib, { default: worker }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  lib.GlobalWorkerOptions.workerSrc = worker
  return lib
}

/** The first page of the PDF at `path`, fit inside `width` by `height` pixels, as a PNG blob URL. */
export async function pdfUrl(path, { width, height }) {
  const lib = await (pdfjs ??= load())
  const data = new Uint8Array(await (await fetch(convertFileSrc(path))).arrayBuffer())
  const task = lib.getDocument({ data, isEvalSupported: false, enableXfa: false })
  try {
    const doc = await task.promise
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const ratio = devicePixelRatio || 1
    const viewport = page.getViewport({ scale: Math.min(width / base.width, height / base.height) * ratio })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, viewport, background: '#fff', annotationMode: lib.AnnotationMode.DISABLE }).promise
    const blob = await new Promise((done, fail) => canvas.toBlob(b => (b ? done(b) : fail(new Error('no PNG'))), 'image/png'))
    return URL.createObjectURL(blob)
  } finally {
    task.destroy() // frees the document and its worker's copy
  }
}
