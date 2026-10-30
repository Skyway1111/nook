// Find and replace in the editor: a panel under the text, its matches drawn in the editor's layer behind the text.
// Matching ignores case unless asked; outside regexp mode \n, \r, \t and \\ stand for themselves.
import { el } from './ui.js'
import { sel1, from, to } from './doc.js'
import { keyName } from './edits.js'

const unquote = s => s.replace(/\\([nrt\\])/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : '\\'))
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function startFind(v) {
  let panel = null, fields = null
  let re = null // the query compiled, or null when it's empty or not a valid regexp
  const q = { search: '', replace: '', cased: false, regexp: false, word: false }
  let cache = { version: -1, text: '' }
  const text = () => (cache.version === v.version ? cache.text : (cache = { version: v.version, text: v.doc.text() }).text)

  function compile() {
    re = null
    if (!q.search) return
    let src = q.regexp ? q.search : escape(unquote(q.search))
    if (q.word) {
      const w = `[\\p{L}\\p{N}_${escape(v.L.word ?? '')}]`
      src = `(?<!${w})(?:${src})(?!${w})`
    }
    try { re = new RegExp(src, 'gmu' + (q.cased ? '' : 'i')) } catch { re = null }
  }
  /** Calls f(from, to, groups) for each non-empty match in `s` from `at`, offsets shifted by `base`, while it returns
   * nothing. */
  function each(s, at, base, f) {
    if (!re) return
    re.lastIndex = at
    for (let m; (m = re.exec(s));) {
      if (!m[0].length) { re.lastIndex = m.index + 1; continue }
      if (f(base + m.index, base + m.index + m[0].length, m) !== undefined) return
    }
  }
  /** The first match at or after `pos`, wrapping round; or with `back`, the last one ending at or before it. */
  function find(pos, back) {
    let hit = null, firstHit = null, lastHit = null
    each(text(), 0, 0, (a, b, m) => {
      firstHit ??= [a, b, m]
      if (back) {
        if (b <= pos) lastHit = [a, b, m]
        else return true
      } else if (a >= pos) return ((hit = [a, b, m]), true)
    })
    if (back) {
      if (lastHit) return lastHit
      let tail = null
      each(text(), 0, 0, (a, b, m) => { tail = [a, b, m] })
      return tail
    }
    return hit ?? firstHit
  }
  const replacement = m => (q.regexp
    ? unquote(q.replace).replace(/\$([$&]|\d+)/g, (s, k) => (k === '$' ? '$' : k === '&' ? m[0] : m[+k] ?? s))
    : unquote(q.replace))

  function select(hit) {
    if (!hit) return false
    v.dispatch({ sel: { ranges: [sel1(hit[0], hit[1])], main: 0 }, kind: 'select.search' })
    return true
  }
  function step(dir) {
    if (!re) return open(false)
    const r = v.ranges[v.main]
    return select(find(dir > 0 ? to(r) : from(r), dir < 0)) || true
  }
  function selectAll() {
    const ranges = []
    each(text(), 0, 0, (a, b) => (ranges.push(sel1(a, b)), ranges.length >= 1000 ? true : undefined))
    if (!ranges.length) return
    v.dispatch({ sel: { ranges, main: 0 }, kind: 'select.search' })
    v.focus()
  }
  function replaceNext() {
    if (!re) return
    const r = v.ranges[v.main]
    const hit = find(from(r))
    if (!hit) return
    if (hit[0] === from(r) && hit[1] === to(r)) {
      const ins = replacement(hit[2])
      v.dispatch({ changes: [{ from: hit[0], to: hit[1], insert: ins }], kind: 'replace' })
      select(find(hit[0] + ins.length))
    } else select(hit)
  }
  function replaceAll() {
    if (!re) return
    const changes = []
    each(text(), 0, 0, (a, b, m) => { changes.push({ from: a, to: b, insert: replacement(m) }) })
    if (changes.length) v.dispatch({ changes, kind: 'replace.all' })
  }

  function build() {
    const field = (name, placeholder) => el('input', { className: 'cm-textfield', name, placeholder, spellcheck: false, autocomplete: 'off' })
    const check = (name, label) => {
      const box = el('input', { type: 'checkbox', name })
      const l = el('label')
      l.append(box, label)
      return [l, box]
    }
    const button = (name, label, onclick) => el('button', { className: 'cm-button', name, type: 'button', textContent: label, onclick })
    const search = field('search', 'Find'), replace = field('replace', 'Replace')
    search.setAttribute('aria-label', 'Find')
    replace.setAttribute('aria-label', 'Replace')
    const [caseL, cased] = check('case', 'match case'), [reL, regexp] = check('re', 'regexp'), [wordL, word] = check('word', 'by word')
    panel = el('div', { className: 'cm-search cm-panel' })
    panel.append(search, button('next', 'next', () => step(1)), button('prev', 'previous', () => step(-1)),
      button('select', 'all', selectAll), caseL, reL, wordL, el('br'), replace,
      button('replace', 'replace', replaceNext), button('replaceAll', 'replace all', replaceAll),
      el('button', { name: 'close', type: 'button', textContent: '×', onclick: close, ariaLabel: 'close' }))
    fields = { search, replace, cased, regexp, word }
    const read = () => {
      Object.assign(q, { search: search.value, replace: replace.value, cased: cased.checked, regexp: regexp.checked, word: word.checked })
      compile()
      v.flush()
      v.redraw()
    }
    for (const f of [search, replace]) f.addEventListener('input', read)
    for (const f of [cased, regexp, word]) f.addEventListener('change', read)
    panel.addEventListener('keydown', e => {
      const k = keyName(e)
      if (k === 'Escape') { e.preventDefault(); close() }
      else if (k === 'Enter' && e.target === search) { e.preventDefault(); step(1) }
      else if (k === 'Shift-Enter' && e.target === search) { e.preventDefault(); step(-1) }
      else if (k === 'Enter' && e.target === replace) { e.preventDefault(); replaceNext() }
      else if (k === 'F3' || k === 'Ctrl-g') { e.preventDefault(); step(1) }
      else if (k === 'Shift-F3' || k === 'Ctrl-Shift-g') { e.preventDefault(); step(-1) }
      else if (k === 'Ctrl-f') { e.preventDefault(); search.select() }
    })
  }

  function open(toReplace) {
    if (!panel) build()
    const r = v.ranges[v.main]
    if (r.anchor !== r.head && to(r) - from(r) <= 100) {
      fields.search.value = v.doc.slice(from(r), to(r)).replace(/\n/g, '\\n')
      q.search = fields.search.value
      compile()
    }
    if (!panel.isConnected) v.panels.prepend(panel)
    const f = toReplace ? fields.replace : fields.search
    f.focus()
    f.select()
    v.redraw()
    return true
  }
  function close() {
    if (!panel?.isConnected) return
    panel.remove()
    v.focus()
    v.redraw()
  }

  return {
    open,
    close,
    step,
    isOpen: () => !!panel?.isConnected,
    /** Calls f(from, to, selected) for each match between offsets lo and hi, while the panel shows. */
    matches(lo, hi, f) {
      if (!re || !panel?.isConnected) return
      const a = Math.max(0, lo - 250)
      const s = v.doc.slice(a, Math.min(v.doc.length, hi + 250))
      const sel = v.ranges
      each(s, 0, a, (x, y) => {
        if (x > hi) return true
        if (y >= lo) f(x, y, sel.some(r => from(r) === x && to(r) === y))
      })
    },
  }
}
