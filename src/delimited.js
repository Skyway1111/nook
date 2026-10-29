// CSV and TSV, as spreadsheets write them: a quoted field holds commas, line breaks, and "" for a quote.
// Pure, so delimited.test.js runs it without a window.

/** The rows of `text`, each a list of fields. `sep` is the field separator; a lone \r or \r\n ends a row too. */
export function parse(text, sep = ',') {
  const rows = []
  let row = []
  let field = ''
  let i = 0
  const n = text.length
  if (text.charCodeAt(0) === 0xfeff) i = 1 // a BOM
  while (i < n) {
    const c = text[i]
    if (c === '"' && field === '') {
      // A quoted field runs to the next quote that isn't doubled.
      i++
      for (;;) {
        const q = text.indexOf('"', i)
        if (q < 0) { field += text.slice(i); i = n; break }
        field += text.slice(i, q)
        if (text[q + 1] === '"') { field += '"'; i = q + 2 } else { i = q + 1; break }
      }
      continue
    }
    if (c === sep) { row.push(field); field = ''; i++; continue }
    if (c === '\n' || c === '\r') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    // An unquoted field runs to the next separator or line end.
    let j = i
    while (j < n && text[j] !== sep && text[j] !== '\n' && text[j] !== '\r') j++
    field += text.slice(i, j)
    i = j
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** The separator a file's name implies, or for .csv the one its first line uses most: , ; or tab. */
export function separator(name, text) {
  if (/\.tsv$/i.test(name)) return '\t'
  const first = text.slice(0, text.search(/\r|\n|$/))
  const counts = [',', ';', '\t'].map(s => [s, first.split(s).length])
  return counts.sort((a, b) => b[1] - a[1])[0][1] > 1 ? counts[0][0] : ','
}

const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?%?$/

/** Whether a column holds numbers: every non-empty field among the rows looked at is one. */
export function numeric(rows, col, from = 1, upto = 200) {
  let seen = 0
  for (let r = from; r < Math.min(rows.length, from + upto); r++) {
    const v = (rows[r][col] ?? '').trim()
    if (!v) continue
    if (!NUMBER.test(v) || v === '.' || v === '-' || v === '+') return false
    seen++
  }
  return seen > 0
}

/** How to order two fields of a column: as numbers when both are, else as text, with empty ones last. */
export function compareFields(a = '', b = '') {
  if (!a !== !b) return a ? -1 : 1
  const x = parseFloat(a.replace(/,/g, ''))
  const y = parseFloat(b.replace(/,/g, ''))
  if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x - y
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}
