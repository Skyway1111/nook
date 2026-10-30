// Completion in code: the language's keywords, CSS properties in style sheets, and the words already in the file, in a
// list under the word being typed. The first is picked; Enter takes it once the list has shown 75 ms, and earlier
// starts a new line. Prose has none.
import { el } from './ui.js'
import { sel1 } from './doc.js'

const MAX_WORDS = 2000, AROUND = 25_000, SHOWN = 100

let properties = null
/** Every CSS property the webview knows, shorthands included. */
function cssProperties() {
  if (properties) return properties
  const all = new Set([...getComputedStyle(document.documentElement)].filter(p => !p.startsWith('-')))
  for (const p of [...all]) {
    for (let k = p.lastIndexOf('-'); k > 0; k = p.lastIndexOf('-', k - 1)) {
      const s = p.slice(0, k)
      if (!all.has(s) && CSS.supports(s, 'inherit')) all.add(s)
    }
  }
  return (properties = [...all])
}

/** How well `label` matches typed `q`: a score, higher better, and the matched spans as [from, to] pairs; or null. */
function rank(label, q) {
  if (!q) return [0, []]
  if (label.startsWith(q)) return [label.length === q.length ? 100 : 0, [0, q.length]]
  const l = label.toLowerCase(), t = q.toLowerCase()
  if (l.startsWith(t)) return [-200, [0, q.length]]
  const at = l.indexOf(t)
  if (at > 0) return [-700 - at, [at, at + q.length]]
  const hits = []
  let k = 0
  for (let n = 0; n < l.length && k < t.length; n++) {
    if (l[n] !== t[k]) continue
    if (hits.at(-1) === n) hits[hits.length - 1] = n + 1
    else hits.push(n, n + 1)
    k++
  }
  return k < t.length ? null : [-1100 - hits.length, hits]
}

export function startComplete(v) {
  const off = !!v.L.prose
  const word = new RegExp(`[\\p{L}\\p{N}_${(v.L.word ?? '').replace(/[-\]\\^]/g, '\\$&')}]`, 'u')
  const words = new RegExp(word.source + '+', 'gu')
  const keywords = [...new Set(`${v.L.kw ?? ''} ${v.L.bool ?? ''} ${v.L.atom ?? ''} ${v.L.types ?? ''}`.split(/\s+/).filter(Boolean))]
  let list = null // { from, at, items, picked, shown, dom, ul, explicit }

  /** Where the word before the main caret starts. */
  function wordStart() {
    const r = v.ranges[v.main]
    if (r.anchor !== r.head) return null
    const i = v.doc.lineOf(r.head), start = v.doc.start(i), text = v.doc.lines[i]
    let k = r.head - start
    while (k > 0 && word.test(text[k - 1])) k--
    return start + k
  }

  function candidates(a) {
    const seen = new Set(keywords)
    const out = [...keywords]
    if (v.L.lex === 'css') for (const p of cssProperties()) if (!seen.has(p)) { seen.add(p); out.push(p) }
    const lo = Math.max(0, a - AROUND), hi = Math.min(v.doc.length, a + AROUND)
    const s = v.doc.slice(lo, hi)
    words.lastIndex = 0
    let n = 0
    for (let m; (m = words.exec(s)) && n < MAX_WORDS;) {
      if (lo + m.index === a || seen.has(m[0])) continue
      seen.add(m[0])
      out.push(m[0])
      n++
    }
    return out
  }

  function refresh(explicit) {
    const a = wordStart()
    if (a == null) return close()
    const head = v.ranges[v.main].head
    const q = v.doc.slice(a, head)
    if (!q && !explicit && !list?.explicit) return close()
    if (!list || list.from !== a) {
      list?.dom.remove()
      list = { from: a, items: null, picked: 0, shown: list?.from === a ? list.shown : Date.now(), dom: null, explicit, all: candidates(a) }
    }
    const items = []
    for (const label of list.all) {
      const r = rank(label, q)
      if (r) items.push({ label, score: r[0], hits: r[1] })
    }
    if (!items.length) return close()
    items.sort((x, y) => y.score - x.score || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0))
    list.items = items.slice(0, SHOWN)
    list.picked = 0
    paint()
  }

  function paint() {
    if (!list.dom) {
      list.ul = el('ul', { role: 'listbox' })
      list.dom = el('div', { className: 'cm-tooltip cm-tooltip-autocomplete' })
      list.dom.append(list.ul)
      list.dom.addEventListener('mousedown', e => {
        e.preventDefault()
        const li = e.target.closest('li')
        if (li) accept(+li.dataset.n)
      })
      v.dom.append(list.dom)
    }
    list.ul.replaceChildren(...list.items.map((it, n) => {
      const li = el('li', { role: 'option' })
      li.dataset.n = n
      if (n === list.picked) li.setAttribute('aria-selected', 'true')
      const label = el('span', { className: 'cm-completionLabel' })
      let k = 0
      for (let h = 0; h < it.hits.length; h += 2) {
        if (it.hits[h] > k) label.append(it.label.slice(k, it.hits[h]))
        label.append(el('span', { className: 'cm-completionMatchedText', textContent: it.label.slice(it.hits[h], it.hits[h + 1]) }))
        k = it.hits[h + 1]
      }
      if (k < it.label.length) label.append(it.label.slice(k))
      li.append(label)
      return li
    }))
    place()
  }
  function place() {
    v.flush()
    const c = v.coords(list.from), box = v.contentBox()
    const x = box.left + c.x, y = box.top + c.y
    const d = list.dom
    d.style.left = `${Math.max(0, Math.min(x - 4, innerWidth - d.offsetWidth - 4))}px`
    const below = y + c.h + d.offsetHeight + 4 <= innerHeight
    d.style.top = `${below ? y + c.h + 2 : Math.max(0, y - d.offsetHeight - 2)}px`
  }
  function pick(n) {
    const lis = list.ul.children
    lis[list.picked]?.removeAttribute('aria-selected')
    list.picked = n
    lis[n]?.setAttribute('aria-selected', 'true')
    const li = lis[n], ul = list.ul
    if (li.offsetTop < ul.scrollTop) ul.scrollTop = li.offsetTop
    else if (li.offsetTop + li.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = li.offsetTop + li.offsetHeight - ul.clientHeight
  }
  function accept(n) {
    const label = list.items[n].label, a = list.from
    const r = v.ranges[v.main]
    const typed = v.doc.slice(a, r.head)
    const changes = [], ranges = []
    let shift = 0
    for (const s of v.ranges) {
      if (s.anchor !== s.head || s.head - typed.length < 0 || v.doc.slice(s.head - typed.length, s.head) !== typed) {
        ranges.push(sel1(s.anchor + shift, s.head + shift))
        continue
      }
      changes.push({ from: s.head - typed.length, to: s.head, insert: label })
      shift += label.length - typed.length
      ranges.push(sel1(s.head + shift))
    }
    close()
    v.dispatch({ changes, sel: { ranges, main: v.main }, kind: 'complete' })
  }
  function close() {
    list?.dom?.remove()
    list = null
  }

  return {
    open(explicit) {
      if (off) return false
      refresh(explicit)
      return true
    },
    close,
    /** After a change: typing a word character opens or narrows the list, deleting narrows it, anything else ends it. */
    changed(changes, kind) {
      if (off) return
      if (kind === 'type' && changes.length && word.test(changes[0].insert.at(-1) ?? '')) queueMicrotask(() => refresh(false))
      else if (list && (kind === 'delete' || kind === 'type')) queueMicrotask(() => list && refresh(false))
      else if (kind !== 'complete') close()
    },
    /** After the caret moves without typing: the list goes unless the caret stays in its word. */
    moved() {
      if (!list) return
      const r = v.ranges[v.main]
      if (r.anchor !== r.head || r.head < list.from || wordStart() !== list.from) close()
    },
    /** Handles key `k` while the list shows. */
    key(k) {
      if (!list) return false
      const n = list.items.length
      const page = Math.max(1, Math.floor(list.ul.clientHeight / (list.ul.firstChild?.offsetHeight || 20)))
      switch (k) {
        case 'ArrowDown': pick((list.picked + 1) % n); return true
        case 'ArrowUp': pick((list.picked - 1 + n) % n); return true
        case 'PageDown': pick(Math.min(n - 1, list.picked + page)); return true
        case 'PageUp': pick(Math.max(0, list.picked - page)); return true
        case 'Escape': close(); return true
        case 'Enter':
          if (Date.now() - list.shown < 75) { close(); return false }
          accept(list.picked)
          return true
      }
      return false
    },
    isOpen: () => !!list,
  }
}
