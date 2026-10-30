// The first page of a PDF in Claude's transcript, drawn by the OS (`pdf.rs`) at the box's pixel size.
import { invoke } from './host.js'

/** The first page of the PDF at `path`, fit inside `width` by `height` CSS pixels, as a PNG blob URL. */
export async function pdfUrl(path, { width, height }) {
  const r = devicePixelRatio || 1
  const png = await invoke('pdf_page', { path, width: Math.ceil(width * r), height: Math.ceil(height * r) })
  return URL.createObjectURL(new Blob([png], { type: 'image/png' }))
}
