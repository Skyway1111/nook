// Markdown's sanitizer where the browser has none of its own (Document.parseHTML), as WebKitGTK on Linux hasn't.
// viewer.js loads it with markdown.js, so a window that never renders Markdown never loads it.

// Markdown keeps only what it writes itself: these elements, with these attributes. Anything else goes, with
// what's inside it.
const KEEP = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'u', 'del', 's', 'ins', 'mark', 'small', 'sub', 'sup', 'kbd', 'abbr', 'br', 'hr', 'span', 'div',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'details', 'summary', 'dl', 'dt', 'dd', 'figure',
  'figcaption', 'section', 'center', 'input'])
const KEEP_ATTRIBUTES = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'align', 'colspan', 'rowspan', 'start',
  'type', 'checked', 'disabled', 'open', 'class'])

/** Takes from `doc` every element and attribute not kept above, links that run code, and inputs but checkboxes. */
export function clean(doc) {
  for (const node of [...doc.body.querySelectorAll('*')]) {
    if (!node.isConnected) continue // went with an element it was in
    const tag = node.localName
    if (!KEEP.has(tag) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml'
      || (tag === 'input' && node.getAttribute('type') !== 'checkbox')) {
      node.remove()
      continue
    }
    for (const { name } of [...node.attributes]) if (!KEEP_ATTRIBUTES.has(name)) node.removeAttribute(name)
    for (const name of ['href', 'src']) {
      const url = node.getAttribute(name)?.replace(/[\u0000-\u0020]/g, '')
      if (url && /^(javascript|vbscript|data):/i.test(url) && !(name === 'src' && /^data:image\/(png|jpe?g|gif|webp);/i.test(url))) node.removeAttribute(name)
    }
    if (tag === 'input') node.disabled = true
  }
  return doc
}
