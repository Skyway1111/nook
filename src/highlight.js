// Syntax colors, as style.css's tok-* classes: for diff, merge, peek, the settings drawer, Markdown's code blocks and
// the editor. Each lexer reads one line from the state the line before ended in, a stack of open strings, comments
// and embedded languages. The editor keeps each line's state as a small integer, so a relex after an edit stops at
// the first line whose state comes out as before.
import { lang } from './langs.js'

const COMMENT = 1, KEYWORD = 2, BOOL = 3, ATOM = 4, STRING = 5, STRING2 = 6, NUMBER = 7, LITERAL = 8, META = 9,
  DEF = 10, TYPE = 11, CLASSNAME = 12, NAMESPACE = 13, VAR2 = 14, PROP = 15, PROPDEF = 16, URL = 17, INSERTED = 18,
  DELETED = 19
// Markdown's styles, combined with one of the above.
const HEADING = 32, STRONG = 64, EMPHASIS = 128, LINK = 256
const BASE = ['', 'comment', 'keyword', 'bool', 'atom', 'string', 'string2', 'number', 'literal', 'meta',
  'variableName tok-definition', 'typeName', 'className', 'namespace', 'variableName2', 'propertyName',
  'propertyName tok-definition', 'url', 'inserted', 'deleted']
const FLAGS = [[HEADING, 'tok-heading'], [STRONG, 'tok-strong'], [EMPHASIS, 'tok-emphasis'], [LINK, 'tok-link']]
const names = []
/** A token's class number as its class attribute. */
export const className = id => (names[id] ??= [...FLAGS.filter(([f]) => id & f).map(f => f[1]),
  ...(id & 31 ? [`tok-${BASE[id & 31]}`] : [])].join(' '))

const MAX_LINE = 10_000 // characters of a line colored at most: a minified file can be one 4 MB line

// States: a stack's frames joined by \0, numbered as first seen. 0 is the empty stack.
const STATES = ['']
const IDS = new Map([['', 0]])
const stackOf = id => (id ? STATES[id].split('\0') : [])
function idOf(stack) {
  if (!stack.length) return 0
  const key = stack.join('\0')
  let id = IDS.get(key)
  if (id === undefined) IDS.set(key, (id = STATES.push(key) - 1))
  return id
}

/** Appends a token to `out`'s [from, to, class] triples, joined to the last when it continues it. */
function put(out, from, to, cls) {
  if (to <= from || !cls) return
  const n = out.length
  if (n && out[n - 1] === cls && out[n - 2] === from) out[n - 2] = to
  else out.push(from, to, cls)
}

/**
 * Lexes `text`, one line of a file in language `L` (from langs.js), from `state`, the number the line before ended
 * in (0 for the first). Appends its tokens to `out` as [from, to, class] triples, `className` naming each class,
 * and returns the state the line ends in. `next` is the following line's text, which Markdown's underlined
 * headings look at.
 */
export function lexLine(L, text, state, out, next) {
  const st = stackOf(state)
  run(L, text, st, out, next)
  return idOf(st)
}

function run(L, text, st, out, next) {
  const end = Math.min(text.length, MAX_LINE)
  LEXERS[L.lex ?? 'code'](L, text, 0, end, st, 0, out, next)
  // A string that can't run on past its line ends with it, and whatever it held.
  for (let k = 0; k < st.length; k++) {
    if (st[k][0] === 'S' && st[k][3] !== 'm') { st.length = k; break }
  }
}

/** `code`'s tokens, line by line, in the language its file `name` implies: for each line a list of
 * `[from, to, className]`. Null for a language nook doesn't color. */
export function tokenize(code, name) {
  const L = lang(name)
  if (!L?.lex && L?.lex !== undefined) return null
  if (!L) return null
  const lines = code.split('\n')
  const st = []
  const out = []
  return lines.map((text, i) => {
    out.length = 0
    run(L, text, st, out, lines[i + 1])
    const tokens = []
    for (let j = 0; j < out.length; j += 3) tokens.push([out[j], out[j + 1], className(out[j + 2])])
    return tokens
  })
}

/** `code` colored as the language `lang` names (a fence's info string or an extension), as text and spans with
 * '\n' between lines; null for a language nook doesn't color. */
export function highlight(code, name) {
  const lines = tokenize(code, name)
  if (!lines) return null
  const frag = document.createDocumentFragment()
  let at = 0
  let plain = ''
  for (const tokens of lines) {
    const end = code.indexOf('\n', at)
    const text = code.slice(at, end < 0 ? code.length : end)
    let k = 0
    for (const [from, to, cls] of tokens) {
      plain += text.slice(k, from)
      if (plain) frag.append(plain)
      plain = ''
      const span = document.createElement('span')
      span.className = cls
      span.textContent = text.slice(from, to)
      frag.append(span)
      k = to
    }
    plain += text.slice(k) + (end < 0 ? '' : '\n')
    at = end + 1
  }
  if (plain) frag.append(plain)
  return frag
}

// ---- Characters

const isStart = c => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || (c > 127 && c !== 0xa0)
const isDigit = c => c >= 48 && c <= 57
const isPart = c => isStart(c) || isDigit(c)
const isSpace = c => c === 32 || c === 9 || c === 13 || c === 12
const NUM = /0[xX][\da-fA-F_]+[\w]*|0[bBoO][\d_]+\w*|(?:\d[\d_]*(?:\.(?![.a-zA-Z_])[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?\w*/y

/** The end of the number at `i`, or `i`. */
function number(s, i) {
  NUM.lastIndex = i
  return NUM.test(s) ? NUM.lastIndex : i
}

/** The end of the run of name characters at `i`, `extra` holding the codes of the language's own. */
function name(s, i, end, extra) {
  while (i < end) {
    const c = s.charCodeAt(i)
    if (!(isPart(c) || extra?.has(c))) break
    i++
  }
  return i
}

/** `re`'s sticky match at `i`, or null. */
function at(re, s, i) {
  re.lastIndex = i
  return re.exec(s)
}

/** The first non-space character's index from `i`. */
function skip(s, i, end) {
  while (i < end && isSpace(s.charCodeAt(i))) i++
  return i
}

// ---- The code lexer: C-like, scripting and data languages, driven by langs.js's fields.

const set = (s, ci) => new Set(s ? (ci ? s.toLowerCase() : s).split(' ') : [])
const CLASS_OF = { d: DEF, t: TYPE, c: CLASSNAME, n: NAMESPACE, p: PROPDEF }

/** A language's fields made ready for lexing, once. */
function prep(L) {
  if (L.ready) return L.ready
  const extra = new Set()
  // A sigil starts a variable, not a name.
  for (const ch of L.lisp ? L.word : L.word?.replace(/[?!]/g, '') ?? '') if (!L.vars?.includes(ch)) extra.add(ch.charCodeAt(0))
  const defs = new Map()
  for (const pair of (L.defs ?? '').split(' ')) if (pair) defs.set(L.ci ? pair.slice(0, -2).toLowerCase() : pair.slice(0, -2), CLASS_OF[pair.at(-1)])
  const interp = {}
  for (let k = 0; k + 1 < (L.interp ?? '').length; k += 2) interp[L.interp[k]] = L.interp[k + 1]
  const block = L.block?.split(' ')
  return (L.ready = {
    kw: set(L.kw, L.ci), soft: set(L.soft, L.ci), bool: set(L.bool, L.ci), atom: set(L.atom, L.ci),
    kwAtoms: set(L.kwAtoms, L.ci), types: set(L.types, L.ci), defs, extra, interp,
    line: (L.line ?? '').split(' ').filter(Boolean), open: block?.[0], close: block?.[1],
    q: L.q ?? '', rq: L.rq ?? '', ml: L.ml ?? '', tq: L.tq ?? '', vars: L.vars ?? '',
  })
}

// A frame's first character says what it is. S a string: S, its class (s or 2), its mode (MODES), m if it runs
// across lines, then its closer. C a block comment, then its closer. H a heredoc: H, class, mode, - if its
// terminator may be indented, |, terminator. E a block that ends at a line starting with its terminator.
// $} and $) code inside a string. {, ( and [ an open bracket, then what it holds: b statements, o an object's
// properties, p parameters or a pattern's names, i imported names, t a type's members, c a class's members,
// e an expression. X JavaScript's markup: Xt in a tag, Xc between tags.
const BRACKET = { 123: '{', 40: '(', 91: '[' }
const CLOSER = { 125: '{', 41: '(', 93: '[' }

/** String modes: what a string holds besides text. e escapes, r nothing, j `${}`, f `{}` (Python), b `#{}` (Ruby),
 * s `\()` (Swift), h `$name ${} $()` (shell), p `$name $()` (PowerShell), k `{$} $name` (PHP). */
const ESCAPES = 'ejfbshk'

// Characters after which a JavaScript `{` opens an object, not a block.
const OBJECT_AFTER = new Set([40, 44, 61, 58, 91, 63, 33, 38, 124, 43, 45, 42, 37, 60, 62, 126, 94])

function code(L, s, i, end, st, base, out) {
  const P = prep(L)
  const js = L.re && !L.ruby && !L.perl
  const track = L.track
  let prev = 0 // the last token: 0 an operator, punctuation or a line's start; 1 a value; 2 a dot; 3 a keyword
  let prevc = 0 // the last punctuation character, 0 after a name or a value
  let want = 0 // the class for the next name, after a keyword that defines one
  let head = '' // what the next { holds, after `class`, `interface`, `struct`, `import`
  let typing = -1 // the bracket depth a type annotation started at
  let angle = 0 // generics' open < inside a type
  let ternary = 0 // `?`s waiting for their `:`
  let pattern = false // Rust after `let`, Go before `:=`: names bind
  let typed = false // C family: the last name was a type, so the next one is declared
  let depth = 0 // brackets opened on this line and still open
  let stmt = '' // the keyword that started this statement
  let lead = true // at a statement's, a member's or a list item's start, modifiers aside
  let lastKw = '' // the last keyword
  const start = i
  if (L.go && /^\s*[\w\s,]+:=/.test(s)) pattern = true
  while (i < end) {
    const top = st.length > base ? st[st.length - 1] : ''
    const t0 = top[0]
    if (top && t0 !== '$' && t0 !== '{' && t0 !== '(' && t0 !== '[') {
      const n = st.length
      i = frame(L, P, s, i, end, st, base, out, top)
      // JSON: a string followed by a colon is a key.
      if (L.keys === 2 && st.length < n && s[skip(s, i, end)] === ':') out[out.length - 1] = PROP
      prev = 1
      prevc = 0
      continue
    }
    const ctx = top.length === 2 && t0 !== '$' ? top[1] : top ? 'e' : 'b'
    const c = s.charCodeAt(i)
    if (isSpace(c)) { i++; continue }
    const from = i
    // Comments
    if (P.line.length && lineComment(L, P, s, i, start)) {
      if (L.lua && s.startsWith('--[', i)) {
        const m = at(/--\[(=*)\[/y, s, i)
        if (m) {
          st.push('C]' + m[1] + ']')
          put(out, i, i + m[0].length, COMMENT)
          i += m[0].length
          continue
        }
      }
      put(out, i, end, COMMENT)
      break
    }
    if (P.open && s.startsWith(P.open, i)) {
      st.push('C' + P.close)
      i += P.open.length
      put(out, from, i, COMMENT)
      continue
    }
    // Ruby's =begin and Perl's POD, from a line's start.
    if (c === 61 && i === start && (L.ruby || L.perl) && isStart(s.charCodeAt(i + 1))) {
      st.push(L.ruby ? 'E=end' : 'E=cut')
      put(out, i, end, COMMENT)
      break
    }
    if (c === 35 && i === 0 && s[1] === '!') { put(out, 0, end, L.sh ? META : COMMENT); break } // #!/bin/sh
    if (L.sh) {
      // name=value, and a command's -options
      const m = c === 45 ? at(/-{1,2}[\w-]+/y, s, i) : prev !== 1 && isStart(c) ? at(/\w+(?=\+?=)/y, s, i) : null
      if (m && (c !== 45 || isSpace(s.charCodeAt(i - 1)))) {
        put(out, i, i + m[0].length, c === 45 ? PROP : DEF)
        i += m[0].length
        prev = c === 45 ? 1 : 0
        continue
      }
    }
    if (L.perl && isStart(c) && prev !== 2) {
      // q{}, qq(), qw//, m//, s///, tr///: strings and patterns with their own delimiters
      const m = at(/(q[qwrx]?|m|s|tr|y)\s*([^\w\s])/y, s, i)
      if (m && !(m[2] === '=' && m[1].length === 1) && !(m[2] === ',' || m[2] === ';' || m[2] === ')')) {
        const open = m[2]
        const close = { '{': '}', '(': ')', '[': ']', '<': '>' }[open] ?? open
        const twice = /^(s|tr|y)$/.test(m[1]) && close === open
        const a = i + m[0].length
        const b = s.indexOf(close, twice ? s.indexOf(close, a) + 1 : a)
        if (b < 0) {
          put(out, i, end, STRING)
          st.push('Ssem' + close)
          break
        }
        let e = b + 1
        while (e < end && isStart(s.charCodeAt(e))) e++
        put(out, i, e, STRING)
        i = e
        prev = 1
        continue
      }
    }
    // Strings
    const q = s[i]
    if (L.lua && c === 91 && /^\[=*\[/.test(s.slice(i, i + 12))) {
      const lv = s.indexOf('[', i + 1) - i - 1
      put(out, i, i + lv + 2, STRING)
      st.push('Ssrm]' + '='.repeat(lv) + ']')
      i += lv + 2
      continue
    }
    if (P.q.includes(q) || P.rq.includes(q)) {
      if (L.rust && q === "'") {
        // A char, or a lifetime
        const m = /'(?:\\(?:x[\da-fA-F]{2}|u\{[\da-fA-F]+\}|.)|[^\\'])'/y
        m.lastIndex = i
        const e = m.test(s) ? m.lastIndex : name(s, i + 1, end)
        put(out, i, e, m.lastIndex === e ? STRING : VAR2)
        i = e
        prev = 1
        prevc = 0
        continue
      }
      if (L.cs && q === '"' && (s[i - 1] === '@' || s[i - 1] === '$')) {
        // C#'s @"verbatim" and $"interpolated"
        const at = s[i - 1] === '@' || s[i - 2] === '@'
        i = openString(L, P, s, i, end, st, out, '', s[i - 2] === '$' || s[i - 2] === '@' ? i - 2 : i - 1, at ? 'r' : 'e', at)
      } else i = openString(L, P, s, i, end, st, out, '')
      prev = 1
      prevc = 0
      continue
    }
    if (L.qi?.includes(q)) {
      // SQL's quoted names
      const e = s.indexOf(q, i + 1)
      i = e < 0 ? end : e + 1
      prev = 1
      prevc = 0
      continue
    }
    // Numbers
    if (isDigit(c) || (c === 46 && isDigit(s.charCodeAt(i + 1)) && prev !== 1 && prev !== 2)) {
      const e = number(s, i)
      put(out, i, e, NUMBER)
      i = e
      prev = 1
      prevc = 0
      continue
    }
    // Names
    if (isStart(c) || P.extra.has(c)) {
      let e = name(s, i, end, P.extra)
      if (L.ps && s[e] === '-' && isStart(s.charCodeAt(e + 1))) e = name(s, e + 1, end, P.extra) // Get-ChildItem
      if (L.ruby && (s[e] === '?' || s[e] === '!') && s[e + 1] !== '=') e++
      const word = s.slice(i, e)
      const nq = s[e]
      // A string's prefix: f"", r'', b"", R"(", s"".
      if ((nq === '"' || nq === "'") && L.pre && prefix(L.pre, word)) {
        i = openString(L, P, s, e, end, st, out, word, i)
        prev = 1
        prevc = 0
        continue
      }
      if (L.rust && nq === '#' && (word === 'r' || word === 'br') && /#+"/y.test(s.slice(e, e + 8))) {
        i = openString(L, P, s, e, end, st, out, word, i)
        prev = 1
        prevc = 0
        continue
      }
      i = e
      const after = skip(s, e, end)
      const ac = s.charCodeAt(after)
      const key = L.ci ? word.toLowerCase() : word
      const keyPos = lead
      lead = false
      let cls = 0
      if (prev === 2 && (L.prop || !P.kw.has(key))) {
        // A member: x.name
        cls = want === TYPE ? TYPE : L.prop && !(L.ruby && key === 'self') ? PROP : 0
        want = 0
      } else if (P.kw.has(key) && !(P.soft.has(key) && !soft(L, s, after, end, ac, key, prev, ctx, keyPos))) {
        put(out, from, e, KEYWORD)
        const d = P.defs.get(key)
        want = d && !(L.go && key === 'func' && ac === 40) ? d : 0
        if (js) {
          if (key === 'new') want = ac === 60 ? 0 : CLASSNAME
          if (key === 'class') head = 'c'
          else if (key === 'interface' || key === 'enum') head = 't'
          else if (key === 'import') head = 'i'
          if (key === 'as' && (ctx === 'i' || stmt === 'import')) want = DEF
          else if (L.ts && typing < 0 && (key === 'implements' || key === 'satisfies' || key === 'as' || key === 'is' || key === 'keyof' || (key === 'extends' && head !== 'c'))) typing = depth
          if (key === 'function' && ac === 40) head = 'p'
          if (key === 'catch') head = 'p'
        } else if (L.rust) {
          if (key === 'struct' || key === 'enum' || key === 'union') head = 't'
          else if (key === 'use') head = 'i'
          else if (key === 'as' && ctx === 'i') { want = DEF; prev = 3; continue }
          else if (key === 'let' || key === 'for') pattern = true
          else if (key === 'impl' || key === 'dyn' || key === 'as' || key === 'where') { typing = depth; head = '' }
          else if (key === 'in') pattern = false
        } else if (L.go) {
          if (key === 'struct' || key === 'interface') head = 't'
          else if (key === 'func') { head = 'p'; typing = -1 }
          else if (key === 'var' || key === 'const') { pattern = true; if (ac === 40) head = 'v' }
          else if (key === 'map' || key === 'chan') typing = depth
        } else if (L.decl) {
          if (key === 'new') want = TYPE
          if (key === 'extends' || key === 'implements' || key === 'throws') typing = depth
          if (P.types.has(key)) { typed = true; out[out.length - 1] = TYPE }
          if (key === 'void') typed = true
        }
        if (!stmt) stmt = key
        lastKw = key
        if (keyPos && MODIFIERS.has(key)) lead = true
        prev = 3
        prevc = 0
        if (L.decl && (P.types.has(key) || key === 'void')) prev = 1
        continue
      } else if (want) {
        cls = want
        want = 0
        if (L.go && cls === DEF && ac === 46) cls = 0
      } else if (P.bool.has(key)) cls = BOOL
      else if (P.kwAtoms.has(key)) cls = KEYWORD
      else if (P.atom.has(key)) cls = ATOM
      else if (typing >= 0 || (L.ts && angle)) cls = ctx === 't' && keyPos && (ac === 58 || ac === 63) ? PROPDEF : TYPE
      else if (P.types.has(key) && !L.ts) {
        cls = TYPE
        typed = true
      } else if (L.ruby && ac === 58 && s.charCodeAt(after + 1) !== 58 && after === e) cls = ATOM // name: value
      else if (L.php && (ac === 36 || ac === 92 || s[from - 1] === '?' || s[from - 1] === '\\' || stmt === 'use' || stmt === 'namespace' || (prevc === 58 && s[skip(s, 0, from) - 1] !== '?'))) cls = TYPE
      else if (js) cls = jsName(L, s, after, ac, ctx, keyPos, prev, stmt, t0 === '{', prevc)
      else if (L.rust) cls = rustName(word, s, after, ac, ctx, keyPos, pattern, prevc, stmt, t0 === '(')
      else if (L.go) cls = goName(s, after, ac, ctx, keyPos, pattern, prevc, typed, stmt)
      else if (L.decl) {
        cls = L.jfn && prev === 3 && ac === 40 && isUpper(word) ? DEF // a constructor
          : declName(L, word, s, after, ac, typed, prevc, depth, start, from)
      } else if (L.caps && isUpper(word.replace(/^_+/, ''))) cls = TYPE
      if (L.go && cls === TYPE && ac === 46 && after === e) { cls = 0; want = TYPE } // a package's type: http.Handler
      if (L.decl || L.go) typed = cls === TYPE
      put(out, from, e, cls)
      // After a definition's name: its parameters.
      if ((cls === DEF || cls === PROPDEF) && (ac === 40 || ac === 60) && (js || L.rust || (L.go && head === 'p'))) head = 'p'
      if (L.go && ac === 40 && (cls === PROP || cls === DEF) && (ctx === 't' || stmt === 'func')) head = 'p'
      if (L.rust && head === 't' && ac === 40) head = 'T'
      if (cls === PROPDEF && ac === 58 && L.ts) want = 0
      if (L.rust && cls === TYPE && ac === 123 && !head) head = 'o'
      prev = 1
      prevc = 0
      continue
    }
    // Sigils: $x, @x, %x
    if (P.vars.includes(s[i]) && (isStart(s.charCodeAt(i + 1)) || (c === 36 && /[{\d?!#@*_]/.test(s[i + 1] ?? '')) || (c === 64 && s[i + 1] === '@'))) {
      let e
      if (c === 36 && s[i + 1] === '{') e = (s.indexOf('}', i) + 1) || end
      else e = name(s, i + 1 + (s[i + 1] === '@' ? 1 : 0), end, P.extra)
      if (e <= i + 1) e = i + 2
      if (L.ps && s[e] === ':' && isStart(s.charCodeAt(e + 1))) e = name(s, e + 1, end) // $env:USER
      put(out, i, e, L.php && s[e] === '-' && s[e + 1] === '>' ? PROP : sigil(L, P, s.slice(i, e), prev))
      i = e
      prev = 1
      prevc = 0
      continue
    }
    if (c === 64 && L.meta) {
      // @decorator: the sign alone, or with its name.
      const e = L.meta === 'w' ? name(s, i + 1, end, P.extra) : i + 1
      if (e > i + 1 || L.meta === '@') {
        put(out, i, e, L.swift ? PROP : META)
        i = e
        prev = 0
        prevc = 64
        continue
      }
    }
    if (c === 35 && L.rust && (s[i + 1] === '[' || (s[i + 1] === '!' && s[i + 2] === '['))) {
      st.push('A0')
      continue
    }
    if (c === 35 && L.pp && i === skip(s, start, end)) {
      i = preprocessor(s, i, end, out)
      continue
    }
    if (c === 47 && L.re && prev !== 1 && s[i + 1] !== '/' && s[i + 1] !== '*') {
      const e = regex(s, i, end)
      if (e > 0) { put(out, i, e, STRING2); i = e; prev = 1; prevc = 0; continue }
    }
    if (c === 60 && L.jsx && prev !== 1 && (isStart(s.charCodeAt(i + 1)) || s[i + 1] === '>')) {
      st.push('Xt')
      i = jsxName(s, i + 1, end, out)
      continue
    }
    if (c === 58 && L.ruby && isStart(s.charCodeAt(i + 1)) && s[i - 1] !== ':' && s[i + 1] !== ':') {
      // :symbol
      let e = name(s, i + 1, end)
      if (s[e] === '?' || s[e] === '!') e++
      put(out, i, e, ATOM)
      i = e
      prev = 1
      prevc = 0
      continue
    }
    if (L.heredoc && c === 60 && s[i + 1] === '<' && (L.sh || (prev !== 1 && isStart(s.charCodeAt(i + 2)) || /[-~'"<]/.test(s[i + 2])))) {
      const e = heredoc(L, s, i, end, st, out)
      if (e > i) { i = e; continue }
    }
    if (L.ps && c === 64 && (s[i + 1] === '"' || s[i + 1] === "'") && skip(s, i + 2, end) === end) {
      // A here-string: @" to a line starting "@
      st.push('Hs' + (s[i + 1] === '"' ? 'p' : 'r') + '+|' + s[i + 1] + '@')
      put(out, i, end, STRING)
      break
    }
    if (L.php && c === 63 && s[i + 1] === '>') return i // back to the page
    if (c === 37 && L.name === 'R') {
      const e = s.indexOf('%', i + 1)
      if (e > 0) { put(out, i, e + 1, VAR2); i = e + 1; prev = 0; prevc = 37; continue }
    }
    // Punctuation
    i++
    if (c === 46) {
      if (s[i] === '.') { while (s[i] === '.') i++; prev = 0; prevc = 46; lead = ctx === 'p'; continue }
      prev = 2
      prevc = 0
      continue
    }
    if (c === 63 && s[i] === '.' && !isDigit(s.charCodeAt(i + 1))) { i++; prev = 2; prevc = 0; continue } // ?.
    if (c === 45 && s[i] === '>' && (L.php || L.pp)) { i++; prev = 2; prevc = 0; continue } // ->
    if (c === 45 && s[i] === '>' && L.rust) { i++; typing = depth; prev = 0; prevc = 62; continue } // a return type
    if (c === 58 && s[i] === ':') {
      i++
      if (L.php || L.ruby || L.decl) { prev = 2; prevc = 0 } else { prev = 0; prevc = 58 }
      if (L.rust && typing < 0 && s[i] === '<') typing = depth
      continue
    }
    if (c === 123 || c === 40 || c === 91) {
      const inside = t0 === '$' || ((t0 === '{' || t0 === '(' || t0 === '[') && st.length > base)
      let kind = 'e'
      if (c === 123) {
        kind = head === 'c' || head === 't' || head === 'i' || head === 'o' || head === 'v' ? head
          : ctx === 'i' ? 'i'
          : js && typing >= 0 && prevc === 58 ? 't'
          : js && prev === 3 && /^(const|let|var)$/.test(lastKw) ? 'p'
          : js && (OBJECT_AFTER.has(prevc) || (prev === 3 && lastKw === 'return')) ? (ctx === 'p' ? 'p' : 'o')
          : js && ctx === 'p' ? 'p'
          : 'b'
        if (kind !== 'p' && kind !== 't') typing = -1
      } else if (c === 40) kind = head === 'p' || head === 'v' ? head : head === 'T' ? 't' : js && arrowAhead(s, i, end) ? 'p' : 'e'
      else if (c === 91) kind = ctx === 'p' || pattern || (js && prev === 3 && /^(const|let|var)$/.test(lastKw)) ? 'p' : 'e'
      head = ''
      if (track || inside) st.push(BRACKET[c] + kind)
      if (!(c === 91 && s[i] === ']')) typed = false
      depth++
      prev = 0
      prevc = c
      lead = c === 123 || ((kind === 'p' || kind === 'v') && c === 40)
      if (L.rust && c === 40 && kind === 'p') typing = -1
      continue
    }
    if (c === 125 || c === 41 || c === 93) {
      if (c === 125 && t0 === '$' && top[1] === '}') {
        if (top[2] === 's') put(out, from, i, STRING)
        st.pop()
        prev = 1
        prevc = 0
        continue
      }
      if (c === 41 && t0 === '$' && top[1] === ')') { st.pop(); prev = 1; prevc = 0; continue }
      // Close the bracket this one matches, and whatever was left open inside it.
      const open = CLOSER[c]
      for (let k = st.length - 1; k >= base; k--) {
        const f = st[k]
        if (f[0] === '$') break
        if (f[0] === open && f.length === 2) { st.length = k; break }
      }
      if (depth > 0) depth--
      if (typing > depth) typing = -1
      if (c === 41 && typing < 0 && L.ts && s[skip(s, i, end)] === ':') { typing = depth; i = skip(s, i, end) + 1 } // a return type
      if (c === 41 && L.go && head === 'p') head = ''
      prev = 1
      prevc = c
      lead = c === 125
      continue
    }
    if (c === 63) {
      // A ternary's ?, not ?? or TypeScript's optional x?: and x?)
      if (s[i] === '?') i++
      else if (!(L.ts && (s[i] === ':' || (prev === 1 && /^\s*[,)=]/.test(s.slice(i, i + 3)))))) ternary++
    } else if (c === 58) {
      if (ternary) ternary--
      else if (L.ts || L.rust) {
        if (typing < 0 && !(js && ctx === 'o') && !(js && ctx === 'p' && t0 === '{') && !(L.rust && (ctx === 'o'))) typing = depth
        if (js && ctx === 'p' && t0 === '{') want = DEF
        if (js && ctx === 'b' && head === '') head = 't'
      }
    } else if (c === 61) {
      if (s[i] === '>') {
        i++
        typing = -1
        prev = 0
        prevc = 1 // an arrow: a { after it opens a block
        lead = false
        continue
      }
      if (s[i] !== '=') {
        typing = L.rust && stmt === 'type' ? depth : -1
        pattern = false
        typed = false
        if (js && stmt === 'type') head = 't'
      }
    } else if (c === 59 || (c === 44 && (!typing || typing >= depth))) {
      typing = c === 44 && typing >= 0 && typing < depth ? typing : -1
      angle = 0
      if (c === 59) { stmt = ''; pattern = false; typed = false }
      if (c === 44 && (L.go || L.decl)) typed = false
    } else if (c === 60 && (L.ts || L.rust || L.decl) && prev === 1 && s[i - 2] !== ' ') {
      angle++
      if (typing < 0) typing = depth
    } else if (c === 62 && angle) {
      angle--
      if (!angle && L.decl) typing = -1
      if (!angle && (L.ts || L.rust) && s[i] === '(' ) typing = -1
    } else if (c === 124 && L.rust && s[i] !== '|' && s[i] !== '=' && (prevc === 40 || prevc === 44 || prevc === 61 || prev === 3 || (prevc === 0 && prev === 0))) {
      // A closure's parameters, |a, b: T|: names before a colon bind, after it are types.
      const close = s.indexOf('|', i)
      if (close > 0) {
        const r = /[A-Za-z_]\w*|[:,]/g
        r.lastIndex = i
        let type = false
        for (let m; (m = r.exec(s)) && m.index < close;) {
          if (m[0] === ':' || m[0] === ',') type = m[0] === ':'
          else put(out, m.index, m.index + m[0].length, m[0] === 'mut' || m[0] === 'ref' ? KEYWORD : type ? TYPE : m[0] === '_' ? 0 : DEF)
        }
        i = close + 1
      }
    } else if (c === 42 && L.pre === 'py' && (prevc === 40 || prevc === 44) && (isStart(s.charCodeAt(i)) || s[i] === '*')) {
      // *args and **kwargs
      const e = s[i] === '*' ? i + 1 : i
      put(out, from, e, KEYWORD)
      i = e
    } else if (c === 42 && js && prev === 3 && s.slice(from - 9, from).includes('function')) put(out, from, i, KEYWORD)
    if (c === 42 && L.decl && typed) { prevc = 0; continue } // int *p
    if (c === 38 && L.decl && typed) { prevc = 0; continue }
    if (c === 33 && L.rust) { prevc = 0; continue } // a macro's !
    if (c === 42 && L.go && isSpace(s.charCodeAt(from - 1)) && (isStart(s.charCodeAt(i)) || s[i] === '[')) put(out, from, i, KEYWORD) // *T
    prev = 0
    prevc = c
    lead = c === 59 || c === 44 || c === 123 || c === 125
  }
  return end
}

// Keywords after which a member's name still leads: `private static readonly x`.
const MODIFIERS = new Set(['static', 'private', 'public', 'protected', 'readonly', 'async', 'get', 'set', 'abstract', 'override', 'declare', 'accessor', 'export', 'default', 'pub', 'final', 'const', 'internal', 'virtual', 'sealed', 'open'])

/** Whether a comment starts at `i`. A shell's # does only at a word's start; a word-like marker (rem) only as a
 * whole word. */
function lineComment(L, P, s, i, start) {
  for (const p of P.line) {
    if (!(s.startsWith(p, i) || (L.ci && s.slice(i, i + p.length).toLowerCase() === p))) continue
    if (p === '#' && L.sh && i > start && !isSpace(s.charCodeAt(i - 1)) && s[i - 1] !== ';') continue
    if (isStart(p.charCodeAt(0)) && (isPart(s.charCodeAt(i + p.length)) || (i > start && isPart(s.charCodeAt(i - 1))))) continue
    if (p === '#' && L.php && s[i + 1] === '[') continue
    return true
  }
  return false
}

const isUpper = w => {
  const c = w.charCodeAt(0)
  return c >= 65 && c <= 90 && w.length > 1 && /[a-z]/.test(w)
}

/** Whether a soft keyword (`get`, `type`, `async`, `match`) acts as one where it is. */
function soft(L, s, i, end, c, key, prev, ctx, keyPos) {
  if (i >= end || c === 61 || c === 58 || c === 44 || c === 41 || c === 59 || c === 46) return false
  if (key === 'async') return isStart(c) || c === 40
  if (key === 'match' || key === 'case') return keyPos && c !== 40 && /:\s*(#.*)?$/.test(s) // Python's
  if (key === 'type') return (prev === 3 && (isStart(c) || c === 123)) || (isStart(c) && (L.pre === 'py' || /^\w+\s*(<.*>)?\s*=/.test(s.slice(i))))
  if (key === 'of' || key === 'as' || key === 'from' || key === 'is' || key === 'satisfies') return (prev === 1 || prev === 3) && WORD_AFTER.has(c) || (prev === 1 || prev === 3) && isStart(c)
  if (key === 'keyof' || key === 'infer') return isStart(c) || WORD_AFTER.has(c)
  if (key === 'get' || key === 'set' || key === 'static') return (isStart(c) || c === 35 || c === 91 || c === 42 || (key === 'static' && c === 123)) && (ctx === 'c' || ctx === 'o')
  return isStart(c) || c === 35 || c === 91 || c === 42 || c === 123
}
// What a soft keyword like `from` can come before: a string, a bracket, a template.
const WORD_AFTER = new Set([34, 39, 123, 91, 40, 42, 96])

/** A JavaScript or TypeScript name's class from where it is: a key, a parameter, a binding. */
function jsName(L, s, after, ac, ctx, keyPos, prev, stmt, brace, prevc) {
  const colon = ac === 58 && s.charCodeAt(after + 1) !== 58
  const arrow = ac === 61 && s.charCodeAt(after + 1) === 62
  if (ctx === 'o' || ctx === 'c' || ctx === 't') {
    // A key, a shorthand property, a method, a class's field
    if (!keyPos || arrow) return arrow ? DEF : 0
    if (colon || ac === 40 || ac === 44 || ac === 125 || after >= s.length) return PROPDEF
    return ctx !== 'o' && (ac === 61 || ac === 59 || ac === 63 || ac === 33 || ac === 60) ? PROPDEF : 0
  }
  if (ctx === 'p') return !keyPos && prev !== 0 ? 0 : colon && brace ? PROP : DEF
  if (ctx === 'i') return /^\s*as\b/.test(s.slice(after)) ? 0 : DEF
  if (arrow) return DEF // x => …
  // import x from, let a = 1, b = 2
  if (stmt === 'import' && ctx === 'b' && !/^\s*as\b/.test(s.slice(after))) return DEF
  if (prevc === 44 && ctx === 'b' && (stmt === 'let' || stmt === 'const' || stmt === 'var')) return DEF
  return 0
}

/** A Rust name's class: a type where one goes, a path's namespace, a binding, a field. */
function rustName(word, s, after, ac, ctx, keyPos, pattern, prevc, stmt, paren) {
  const ac2 = s.charCodeAt(after + 1)
  const upper = isUpper(word)
  if (ac === 58 && ac2 === 58) return upper || word === 'Self' ? TYPE : NAMESPACE
  if (ac === 33 && ac2 !== 61) return 0 // a macro
  if (ctx === 'i' || stmt === 'use' || stmt === 'extern') return /^\s*as\b/.test(s.slice(after)) ? 0 : DEF
  if (ctx === 't' && paren) return TYPE // struct Id(pub u64)
  if (ctx === 't' || ctx === 'o') return keyPos && ac === 58 ? PROP : 0
  if (ctx === 'p') return ac === 58 || ac === 44 || ac === 41 || prevc === 40 || prevc === 44 ? (upper ? 0 : DEF) : 0
  if (upper && (ac === 123 || (pattern && ac === 40))) return TYPE // Point { x }, Some(x) in a pattern
  if (pattern) return upper ? 0 : DEF
  return 0
}

/** A Go name's class: names bound before `:=` or after `var`, a parameter's name before its type, a field. */
function goName(s, after, ac, ctx, keyPos, pattern, prevc, typed, stmt) {
  if (ctx === 't') return keyPos && (isStart(ac) || ac === 40 || ac === 44 || ac === 42 || ac === 91) ? PROP : TYPE
  if (ctx === 'v') return keyPos ? DEF : TYPE
  if (stmt === 'func' && prevc === 41 && ac === 40) return PROP // a method: func (r T) Name(
  if (pattern && (ac === 44 || ac === 58 || ac === 61 || isStart(ac) || ac === 91 || ac === 42) && !typed) return DEF
  if (ctx === 'p') return keyPos || prevc === 40 ? (isStart(ac) || ac === 42 || ac === 91 || ac === 44 || ac === 46 ? DEF : TYPE) : TYPE
  if (prevc === 42 || prevc === 93) return TYPE
  return 0
}

/** A name in a C-family declaration: a type before a name, then the declared name. */
function declName(L, word, s, after, ac, typed, prevc, depth, start, from) {
  if (typed) {
    if (ac === 40) return DEF
    return L.cfn ? 0 : DEF
  }
  if (isStart(ac) && !/^(in|instanceof|is|as)\b/.test(s.slice(after))) return TYPE
  if ((ac === 42 || ac === 38) && L.cfn && depth === 0 && from === skip(s, start, s.length)) return TYPE
  if (ac === 91 && s[after + 1] === ']') return TYPE // T[] name
  if (ac === 60 && L.jfn && /^<[\w\s,?.<>[\]]*>\s*[\w(]/.test(s.slice(after))) return TYPE
  if (L.caps && isUpper(word)) return TYPE
  return 0
}

/** Whether `(` at `i` holds the parameters of an arrow function: `(a, b) =>`. */
function arrowAhead(s, i, end) {
  let d = 1
  for (let k = i; k < end; k++) {
    const c = s.charCodeAt(k)
    if (c === 40) d++
    else if (c === 41 && --d === 0) return /^\s*(?::[^=;]*?)?=>/.test(s.slice(k + 1, k + 200))
    else if (c === 34 || c === 39 || c === 96) return false
  }
  return false
}

function prefix(pre, word) {
  if (pre === 'py') return /^(r|u|f|b|br|rb|fr|rf|t|tr|rt)$/i.test(word)
  if (pre === 'rs') return word === 'b'
  if (pre === 'cpp') return /^(u8|u|U|L)?R?$/.test(word)
  if (pre === 'scala') return /^[a-z]\w*$/.test(word)
  if (pre === 'dart') return word === 'r'
  return false
}

/** Opens a string at `i` (its quote), `word` being its prefix starting at `from`. Returns where lexing goes on. */
function openString(L, P, s, i, end, st, out, word, from = i, force, verbatim) {
  const q = s[i]
  const w = word.toLowerCase()
  let cls = STRING
  let mode = force ?? (P.rq.includes(q) && !P.q.includes(q) ? 'r' : P.interp[q] ?? 'e')
  let close = q
  let multi = P.ml.includes(q) || !!verbatim
  let len = 1
  if (P.tq.includes(q) && s[i + 1] === q && s[i + 2] === q) {
    close = q + q + q
    multi = true
    len = 3
  }
  if (mode === 'j') cls = STRING2
  if (L.pre === 'py') {
    if (w.includes('f') || w.includes('t')) { cls = STRING2; mode = 'f' }
  } else if (L.pre === 'rs' && w.includes('r')) {
    const m = /#*"/y
    m.lastIndex = i
    m.test(s)
    len = m.lastIndex - i
    close = '"' + '#'.repeat(len - 1)
    mode = 'r'
    cls = STRING2
    multi = true
  } else if (L.pre === 'cpp' && word.endsWith('R')) {
    const m = at(/"([^()\\\s]{0,16})\(/y, s, i)
    if (m) { len = m[0].length; close = ')' + m[1] + '"'; mode = 'r'; cls = STRING2; multi = true }
  } else if (L.pre === 'scala' && word) mode = word === 'raw' ? 'r' : 'e'
  else if (L.pre === 'dart' && word === 'r') mode = 'r'
  put(out, from, i + len, cls)
  st.push('S' + (cls === STRING2 ? '2' : 's') + mode + (multi ? 'm' : '-') + close)
  return i + len
}

/** Lexes inside the frame on top of the stack: a string, a comment, a heredoc, JavaScript's markup. */
function frame(L, P, s, i, end, st, base, out, top) {
  const kind = top[0]
  if (kind === 'C') {
    const close = top.slice(1)
    let k = i
    while (k < end) {
      if (L.nest && s.startsWith(P.open, k)) { st.push(top); k += P.open.length; continue }
      if (s.startsWith(close, k)) {
        st.pop()
        k += close.length
        if (st.length > base && st[st.length - 1] === top) continue
        put(out, i, k, COMMENT)
        return k
      }
      k++
    }
    put(out, i, end, COMMENT)
    return end
  }
  if (kind === 'E') {
    put(out, i, end, COMMENT)
    if (s.startsWith(top.slice(1), i)) st.pop()
    return end
  }
  if (kind === 'H') {
    // A heredoc: whole lines up to its terminator.
    const bar = top.indexOf('|')
    const term = top.slice(bar + 1)
    const line = top[3] === '-' ? s.trim() : s
    if (line === term || (L.php && line.replace(/[;,)\s].*$/, '') === term)) {
      st.pop()
      put(out, i, end, top[1] === 'n' ? 0 : top[1] === '2' ? STRING2 : STRING)
      return end
    }
    if (top[1] === 'n') return end
    return stringBody(L, s, i, end, st, out, top[1] === '2' ? STRING2 : STRING, top[2], null)
  }
  if (kind === 'S') return stringBody(L, s, i, end, st, out, top[1] === '2' ? STRING2 : STRING, top[2], top.slice(4))
  if (kind === 'X') return jsx(L, s, i, end, st, base, out, top)
  if (kind === 'A') {
    // Rust's #[attribute], to its closing bracket: meta, but for its strings
    let d = +top.slice(1)
    for (let k = i; k < end; k++) {
      const c = s[k]
      if (c === '"') k = s.indexOf('"', k + 1) < 0 ? end : s.indexOf('"', k + 1)
      else if (c === '[') d++
      else if (c === ']' && --d === 0) {
        put(out, i, k + 1, META)
        st.pop()
        return k + 1
      }
    }
    put(out, i, end, META)
    st[st.length - 1] = 'A' + d
    return end
  }
  st.pop()
  return i
}

/** Lexes a string's text from `i` to its `close` (null for a heredoc's line), stopping where code starts inside it. */
function stringBody(L, s, i, end, st, out, cls, mode, close) {
  const escapes = ESCAPES.includes(mode)
  let k = i
  while (k < end) {
    const c = s.charCodeAt(k)
    if (escapes && c === 92) { k += 2; continue }
    if (mode === 'p' && c === 96) { k += 2; continue } // PowerShell's backtick escape
    if (close && s.startsWith(close, k)) {
      k += close.length
      st.pop()
      put(out, i, k, cls)
      return k
    }
    let open = 0
    let closer = ''
    if (mode === 'j' && c === 36 && s[k + 1] === '{') { open = 2; closer = '$}' }
    else if (mode === 'f' && c === 123) {
      if (s[k + 1] === '{') { k += 2; continue }
      open = 1
      closer = '$}'
    } else if (mode === 'b' && c === 35 && s[k + 1] === '{') { open = 2; closer = '$}s' }
    else if (mode === 's' && c === 92 && s[k + 1] === '(') { open = 2; closer = '$)' }
    else if ((mode === 'h' || mode === 'p' || mode === 'k') && c === 36) {
      if (s[k + 1] === '(' && mode !== 'k') { open = 2; closer = '$)' }
      else if (s[k + 1] === '{' && mode !== 'p') {
        if (mode === 'h') {
          // ${name} reads as one variable
          const e = s.indexOf('}', k)
          const to = e < 0 ? end : e + 1
          put(out, i, k, cls)
          put(out, k, to, DEF)
          i = k = to
          continue
        }
        open = 2
        closer = '$}'
      } else if (isStart(s.charCodeAt(k + 1)) || (mode === 'h' && /[\d@#?*!$-]/.test(s[k + 1] ?? ''))) {
        let e = name(s, k + 1, end)
        if (e === k + 1) e++
        if (mode === 'p' && s[e] === ':' && isStart(s.charCodeAt(e + 1))) e = name(s, e + 1, end)
        put(out, i, k, cls)
        put(out, k, e, mode === 'h' ? DEF : 0)
        i = k = e
        continue
      }
    } else if (mode === 'k' && c === 123 && s[k + 1] === '$') { open = 1; closer = '$}' }
    if (open) {
      put(out, i, mode === 'b' ? k + open : k, cls)
      st.push(closer)
      return k + open
    }
    k++
  }
  put(out, i, end, cls)
  return end
}

/** The class of a sigil's variable: shell and Perl $x, Ruby's @x and $x, PHP's $x. */
function sigil(L, P, word, prev) {
  if (L.ruby) return word[0] === '@' ? PROP : VAR2
  if (L.sh || L.perl || L.docker) return DEF
  return prev === 2 ? PROP : 0
}

/** A C preprocessor line from its `#`: the directive and its argument, as CodeMirror's C++ colors them. */
function preprocessor(s, i, end, out) {
  const m = at(/#\s*(\w*)(\s*(?:<[^>]*>|"[^"]*"))?/y, s, i)
  const e = i + m[0].length - (m[2]?.length ?? 0)
  put(out, i, e, META)
  if (m[2] && /^(include|import)$/.test(m[1])) {
    const p = e + m[2].search(/\S/)
    put(out, p, i + m[0].length, m[2].includes('<') ? STRING2 : STRING)
    return end
  }
  if (m[1] === 'else' || m[1] === 'endif') return end
  const from = skip(s, m[1] === 'define' ? i + at(/#\s*define\s+\w+(\([^)]*\))?/y, s, i)?.[0].length : e, end)
  const k = s.indexOf('//', from)
  const b = s.indexOf('/*', from)
  const stop = Math.min(k < 0 ? end : k, b < 0 ? end : b)
  put(out, from, stop, META)
  put(out, stop, end, COMMENT)
  return end
}

/** The end of a JavaScript regular expression starting at `i`, or -1 if `/` can't start one there. */
function regex(s, i, end) {
  let k = i + 1
  let cls = false
  for (; k < end; k++) {
    const c = s[k]
    if (c === '\\') k++
    else if (c === '[') cls = true
    else if (c === ']') cls = false
    else if (c === '/' && !cls) {
      k++
      while (k < end && isPart(s.charCodeAt(k))) k++
      return k
    }
  }
  return -1
}

/** Starts a heredoc at `<<`: shell's <<EOF and <<-'EOF', Ruby's <<~EOS, PHP's <<<EOT. Returns where lexing goes on,
 * or `i` when it isn't one. */
function heredoc(L, s, i, end, st, out) {
  const m = at(/<<(<?)([-~]?)\s*(["']?)([A-Za-z_]\w*)\3/y, s, i)
  if (!m || (m[1] && !L.php)) return i
  const raw = m[3] === "'"
  const cls = L.php ? 'n' : L.sh ? '2' : 's'
  put(out, i, i + m[0].length, cls === 'n' ? 0 : cls === '2' ? STRING2 : STRING)
  st.push('H' + cls + (raw ? 'r' : L.sh || L.perl ? 'h' : 'e') + (m[2] || L.php ? '-' : '+') + '|' + m[4])
  return i + m[0].length
}

// ---- JavaScript's markup (JSX), its frames on the code lexer's stack.

/** A tag's name after `<` or `</` at `i`. Returns its end. */
function jsxName(s, i, end, out) {
  const e = name(s, i, end, DASH_DOT)
  put(out, i, e, TYPE)
  return e
}
const DASH_DOT = new Set([45, 46, 58])

function jsx(L, s, i, end, st, base, out, top) {
  if (top === 'Xt') {
    // Inside a tag: attributes, then > or />.
    while (i < end) {
      const c = s.charCodeAt(i)
      if (isSpace(c)) { i++; continue }
      if (c === 62) { st[st.length - 1] = 'Xc'; return i + 1 }
      if (c === 47 && s[i + 1] === '>') { st.pop(); return i + 2 }
      if (c === 123) { st.push('$}'); return i + 1 }
      if (c === 34 || c === 39) {
        const e = s.indexOf(s[i], i + 1)
        const to = e < 0 ? end : e + 1
        put(out, i, to, STRING)
        i = to
        continue
      }
      if (isStart(c)) {
        const e = name(s, i, end, DASH_DOT)
        put(out, i, e, PROP)
        i = e
        continue
      }
      i++
    }
    return end
  }
  // Between tags: text, then a child's tag, its own closing tag, or {code}.
  while (i < end) {
    const c = s.charCodeAt(i)
    if (c === 123) { st.push('$}'); return i + 1 }
    if (c === 60) {
      if (s[i + 1] === '/') {
        st.pop()
        const e = jsxName(s, skip(s, i + 2, end), end, out)
        const gt = s.indexOf('>', e)
        return gt < 0 ? end : gt + 1
      }
      st.push('Xt')
      return jsxName(s, i + 1, end, out)
    }
    i++
  }
  return end
}

// ---- Markup: HTML, XML, SVG, Vue. <script> and <style> hand their lines to JavaScript and CSS.

// Markup's one frame, at `base`: Mc a comment, Md CDATA, Mt<k><q> inside a tag (k: t any, x script, s style; q the
// open quote of a value running across lines), Me<lang> inside <script> or <style>, its language's frames above.
const ATTR = new Set([45, 58, 46, 95, 64])
const HTML_PAGE = { name: 'HTML', lex: 'markup', html: 1 }
const SCRIPT_END = /<\/(script|style)\b/ig

function markup(L, s, i, end, st, base, out) {
  while (i < end) {
    const top = st.length > base ? st[base] : ''
    if (top === 'Mc' || top === 'Md') {
      const close = top === 'Mc' ? '-->' : ']]>'
      const e = s.indexOf(close, i)
      const to = e < 0 || e >= end ? end : e + 3
      put(out, i, to, top === 'Mc' ? COMMENT : STRING2)
      if (to < end || e === end - 3) st.length = base
      i = to
      continue
    }
    if (top[1] === 't') { i = tag(L, s, i, end, st, base, out); continue }
    if (top[1] === 'e') {
      // Inside <script> or <style>: its language up to the closing tag.
      SCRIPT_END.lastIndex = i
      const m = SCRIPT_END.exec(s)
      const stop = m && m.index < end ? m.index : end
      const inner = lang(top.slice(2))
      if (inner && stop > i) LEXERS[inner.lex ?? 'code'](inner, s, i, stop, st, base + 1, out)
      if (stop === end) return
      st.length = base
      i = stop
      continue
    }
    let lt = s.indexOf('<', i)
    if (lt < 0 || lt > end) lt = end
    text(L, s, i, lt, out)
    if (lt >= end) return
    i = lt
    if (s.startsWith('<!--', i)) { st.push('Mc'); put(out, i, i + 4, COMMENT); i += 4; continue }
    if (s.startsWith('<![CDATA[', i)) { st.push('Md'); put(out, i, i + 9, STRING2); i += 9; continue }
    if (s[i + 1] === '!' || s[i + 1] === '?') {
      const e = s.indexOf('>', i)
      const to = e < 0 || e >= end ? end : e + 1
      put(out, i, to, META)
      i = to
      continue
    }
    const closing = s[i + 1] === '/'
    const at = i + (closing ? 2 : 1)
    if (!isStart(s.charCodeAt(at))) { i++; continue }
    const e = name(s, at, end, DASH_DOT)
    put(out, at, e, TYPE)
    if (closing) {
      const gt = s.indexOf('>', e)
      i = gt < 0 || gt >= end ? end : gt + 1
      continue
    }
    const t = L.html ? s.slice(at, e).toLowerCase() : ''
    st.push(t === 'script' ? 'Mtx' : t === 'style' ? 'Mts' : 'Mtt')
    i = e
  }
}

/** Text between tags: entities, and Vue's {{ expressions }}. */
function text(L, s, i, end, out) {
  for (let k = s.indexOf('&', i); k >= 0 && k < end; k = s.indexOf('&', k + 1)) {
    const m = /&(#\d+|#x[\da-fA-F]+|\w+);/y
    m.lastIndex = k
    if (m.test(s)) put(out, k, m.lastIndex, STRING)
  }
  if (L.name !== 'Vue') return
  for (let a = s.indexOf('{{', i); a >= 0 && a < end; a = s.indexOf('{{', a + 2)) {
    const b = s.indexOf('}}', a)
    if (b < 0 || b > end) return
    code(lang('js'), s, a + 2, b, [], 0, out)
  }
}

/** Inside a tag, from `i`: attributes up to `>`, after which a <script> or <style> opens its language (its `lang`
 * or `type` attribute's, or JavaScript's and CSS's). */
function tag(L, s, i, end, st, base, out) {
  let top = st[base]
  if (top.length > 3) {
    // A quoted value running on from the line before
    const e = s.indexOf(top[3], i)
    const to = e < 0 || e >= end ? end : e + 1
    put(out, i, to, STRING)
    if (to === end && (e < 0 || e >= end)) return end
    st[base] = top = top.slice(0, 3)
    i = to
  }
  while (i < end) {
    const c = s.charCodeAt(i)
    if (isSpace(c)) { i++; continue }
    if (c === 62 || (c === 47 && s[i + 1] === '>')) {
      st.length = base
      i += c === 47 ? 2 : 1
      const kind = top[2]
      if (c === 62 && kind !== 't') st.push('Me' + (top.slice(4) || (kind === 's' ? 'css' : 'js')))
      return i
    }
    if (c === 34 || c === 39) {
      const e = s.indexOf(s[i], i + 1)
      const to = e < 0 || e >= end ? end : e + 1
      put(out, i, to, STRING)
      if (to === end && (e < 0 || e >= end)) { st[base] = top + s[i]; return end }
      i = to
      continue
    }
    if (isStart(c) || c === 58 || c === 64 || c === 35) {
      const e = name(s, i + 1, end, ATTR)
      if (L.name === 'Vue' && (c !== 118 || s[i + 1] === '-') && !isStart(c) || (c === 118 && s[i + 1] === '-')) {
        // A directive (:prop, @event, v-if): its value is JavaScript
        put(out, i, e, c === 118 ? KEYWORD : 0)
        const v = at(/\s*=\s*(["'])/y, s, e)
        const close = v ? s.indexOf(v[1], e + v[0].length) : -1
        if (close > 0) {
          put(out, e + v[0].length - 1, e + v[0].length, STRING)
          code(lang('js'), s, e + v[0].length, close, [], 0, out)
          put(out, close, close + 1, STRING)
        }
        i = close > 0 ? close + 1 : e
        continue
      }
      put(out, i, e, PROP)
      // <script lang="ts">, <style lang="scss">: the language rides on the frame after a space.
      if (top[2] !== 't' && /^(lang|type)$/.test(s.slice(i, e))) {
        const m = at(/\s*=\s*["']?(?:text\/|application\/)?([\w+-]+)/y, s, e)
        if (m && lang(m[1]) && m[1] !== 'module') st[base] = top = top.slice(0, 3) + ' ' + m[1]
      }
      i = e
      continue
    }
    if (c === 61) {
      const k = skip(s, i + 1, end)
      const ch = s.charCodeAt(k)
      if (ch !== 34 && ch !== 39 && k < end) {
        let e = k
        while (e < end && !isSpace(s.charCodeAt(e)) && s[e] !== '>') e++
        put(out, k, e, STRING)
        i = e
      } else i = k
      continue
    }
    i++
  }
  return end
}

// ---- PHP: a page of HTML holding <?php code ?>. A P frame marks the code; the page's frame sits below it.

function php(L, s, i, end, st, base, out) {
  while (i < end) {
    const p = st.lastIndexOf('P')
    if (p >= base) {
      i = code(L, s, i, end, st, p + 1, out)
      if (i >= end) return
      put(out, i, i + 2, META) // ?>
      st.length = p
      i += 2
      continue
    }
    let at = s.indexOf('<?', i)
    if (at < 0 || at >= end) at = end
    markup(HTML_PAGE, s, i, at, st, base, out)
    if (at >= end) return
    const open = /<\?(php|=)?/y
    open.lastIndex = at
    open.test(s)
    put(out, at, open.lastIndex, META)
    st.push('P')
    i = open.lastIndex
  }
}

// ---- CSS, SCSS and Less

const CSS_ATOMS = /^(?:url|var|calc|rgb|rgba|hsl|hsla|min|max|clamp|attr|env|linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|translate|translateX|translateY|rotate|scale|matrix|cubic-bezier|steps|color-mix|format|local|image-set|counter|fit-content|minmax|repeat|blur|drop-shadow|brightness|contrast|saturate|hue-rotate|invert|opacity|sepia|grayscale)$/

function css(L, s, i, end, st, base, out) {
  // One frame at `base`: how many blocks are open, and c inside a comment.
  const frame = st.length > base ? st[base] : ''
  let depth = parseInt(frame) || 0
  let comment = frame.endsWith('c')
  let paren = 0 // a mixin's or a selector function's arguments, read as values
  let interp = 0 // SCSS's #{ }
  // Where the line or a statement starts, a declaration (inside a block, or a SCSS or Less variable's), or a
  // selector when a block opens before the statement ends.
  const declAt = k => (depth > 0 || /^\s*[$@][\w-]+\s*:/.test(s.slice(k, k + 80))) && !/^[^;{}]*(\{|,\s*$)/.test(s.slice(k))
  let decl = declAt(i)
  let value = false // after a declaration's colon: true, or 'q' in an at-rule's prelude
  while (i < end) {
    if (comment) {
      const e = s.indexOf('*/', i)
      const to = e < 0 || e + 2 > end ? end : e + 2
      put(out, i, to, COMMENT)
      if (e >= 0 && e + 2 <= end) comment = false
      i = to
      continue
    }
    const c = s.charCodeAt(i)
    if (isSpace(c)) { i++; continue }
    if (c === 47 && s[i + 1] === '*') { comment = true; put(out, i, i + 2, COMMENT); i += 2; continue }
    if (c === 47 && s[i + 1] === '/' && L.line) { put(out, i, end, COMMENT); break }
    if (c === 34 || c === 39 || (c === 126 && (s[i + 1] === '"' || s[i + 1] === "'"))) {
      const q = c === 126 ? s[i + 1] : s[i]
      let e = i + (c === 126 ? 2 : 1)
      while (e < end && s[e] !== q) e += s[e] === '\\' ? 2 : 1
      e = Math.min(e + 1, end)
      put(out, i, e, STRING)
      i = e
      continue
    }
    if (c === 35 && s[i + 1] === '{') { put(out, i, i + 2, META); i += 2; interp++; continue }
    if (c === 125 && interp) { put(out, i, i + 1, META); i++; interp--; continue }
    if (c === 123 || c === 125 || c === 59) {
      if (c === 123) depth++
      else if (c === 125) depth = Math.max(0, depth - 1)
      i++
      value = false
      paren = 0
      decl = declAt(i)
      continue
    }
    if (c === 33) { const e = name(s, i + 1, end); put(out, i, e, KEYWORD); i = e; continue } // !important
    if ((c === 36 && L.line) || (c === 64 && L.name === 'Less' && !AT_RULES.test(s.slice(i + 1, i + 12)))) {
      // $variable, Less's @variable
      const e = name(s, i + 1, end, DASHES)
      put(out, i, e, VAR2)
      if (!value && s[skip(s, e, end)] === ':') value = true
      i = e
      continue
    }
    if (c === 64) {
      const e = name(s, i + 1, end, DASHES)
      put(out, i, e, KEYWORD)
      value = /^(import|use|forward|charset|namespace)$/.test(s.slice(i + 1, e)) || 'q'
      decl = false
      i = e
      continue
    }
    if (c === 40) { paren++; i++; continue }
    if (c === 41) { paren = Math.max(0, paren - 1); i++; continue }
    if (decl && !value) {
      // A property's name, then its colon
      if (isStart(c) || c === 45) {
        const e = name(s, i, end, DASHES)
        const colon = s[skip(s, e, end)] === ':'
        put(out, i, e, colon && !(s[i] === '-' && s[i + 1] === '-') ? PROP : 0)
        if (colon) value = true
        i = e
        continue
      }
      i++
      continue
    }
    if (value || (paren && L.name === 'Less')) {
      if (isDigit(c) || ((c === 46 || c === 45 || c === 43) && isDigit(s.charCodeAt(i + 1)))) {
        let e = i + 1
        while (e < end && (isDigit(s.charCodeAt(e)) || s[e] === '.')) e++
        if ((s[e] === 'e' || s[e] === 'E') && isDigit(s.charCodeAt(e + 1))) for (e += 2; isDigit(s.charCodeAt(e));) e++
        put(out, i, e, NUMBER)
        const u = e
        while (e < end && (isStart(s.charCodeAt(e)) || s[e] === '%')) e++
        put(out, u, e, KEYWORD) // its unit
        i = e
        continue
      }
      if (c === 35) {
        const e = name(s, i + 1, end)
        put(out, i, e, LITERAL)
        i = e
        continue
      }
      if (isStart(c) || (c === 45 && (isStart(s.charCodeAt(i + 1)) || s[i + 1] === '-'))) {
        const e = name(s, i, end, DASHES)
        const word = s.slice(i, e)
        if (s[e] === '(') {
          put(out, i, e, /^(url|format|local)$/.test(word) ? ATOM : KEYWORD)
          const k = skip(s, e + 1, end)
          if (word === 'url' && s[k] !== '"' && s[k] !== "'") {
            const close = s.indexOf(')', e)
            put(out, e + 1, close < 0 ? end : close, STRING)
            i = close < 0 ? end : close
            continue
          }
        } else if (value === 'q') put(out, i, e, s[skip(s, e, end)] === ':' ? PROP : KEYWORD)
        else if (!word.startsWith('--')) put(out, i, e, ATOM)
        i = e
        continue
      }
      i++
      continue
    }
    // A selector
    if (c === 46 || c === 35) {
      const e = name(s, i + 1, end, DASHES)
      if (c === 46) put(out, i + 1, e, CLASSNAME)
      i = Math.max(e, i + 1)
      continue
    }
    if (c === 58) {
      const k = s[i + 1] === ':' ? i + 2 : i + 1
      const e = name(s, k, end, DASHES)
      put(out, k, e, CLASSNAME)
      i = Math.max(e, k)
      continue
    }
    if (c === 91) {
      // [attribute=value]
      const close = s.indexOf(']', i)
      const stop = close < 0 ? end : close
      const a = skip(s, i + 1, end)
      const e = name(s, a, stop, DASHES)
      put(out, a, e, PROP)
      const v = s.slice(e, stop).search(/[^\s~|^$*=]/)
      if (v >= 0) put(out, e + v, stop, /["']/.test(s[e + v]) ? STRING : ATOM)
      i = stop + 1
      continue
    }
    if (isStart(c) || (c === 45 && isStart(s.charCodeAt(i + 1)))) {
      const e = name(s, i, end, DASHES)
      put(out, i, e, /^(from|to)$/.test(s.slice(i, e)) ? KEYWORD : TYPE)
      i = e
      continue
    }
    if (isDigit(c)) {
      let e = i
      while (e < end && (isDigit(s.charCodeAt(e)) || s[e] === '.' || s[e] === '%')) e++
      put(out, i, e, NUMBER)
      i = e
      continue
    }
    i++
  }
  st.length = base
  if (depth || comment) st.push(depth + (comment ? 'c' : ''))
}
const AT_RULES = /^(media|import|font-face|keyframes|supports|charset|namespace|page|layer|container|plugin)\b/
const DASHES = new Set([45])

// ---- Markdown: block structure line by line, inline styles within a line, fenced code in its own language.

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)/
const BULLET = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?=\s|$)/
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const SETEXT = /^ {0,3}(?:=+|-+)\s*$/
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:\s|$)|>|```|~~~|[-+*]\s|\d{1,9}[.)]\s|<)/

function markdown(L, s, i, end, st, base, out, next) {
  // Frames: F<fence>|<lang> inside fenced code (its language's frames above), Mc an HTML comment, Mh an HTML block,
  // P a paragraph's text (so the next line can't be indented code), I a list's indented text.
  const top = st.length > base ? st[base] : ''
  if (top[0] === 'F') {
    const bar = top.indexOf('|')
    const fence = top.slice(1, bar)
    const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(s)
    if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
      st.length = base
      put(out, i, end, META)
      return
    }
    const inner = lang(top.slice(bar + 1))
    if (inner?.lex !== undefined && !inner.lex) return
    if (inner) LEXERS[inner.lex ?? 'code'](inner, s, i, end, st, base + 1, out)
    for (let k = base + 1; k < st.length; k++) if (st[k][0] === 'S' && st[k][3] !== 'm') { st.length = k; break }
    return
  }
  if (top === 'Mc') {
    const e = s.indexOf('-->', i)
    put(out, i, e < 0 ? end : e + 3, COMMENT)
    if (e >= 0) st.length = base
    return
  }
  if (top === 'Mh') {
    if (!s.trim()) { st.length = base; return }
    markup(HTML_PAGE, s, i, end, st, base + 1, out)
    return
  }
  const wasText = top === 'P'
  const inList = top === 'I'
  st.length = base
  if (!s.trim()) { if (inList) st.push('I'); return }
  // Indented code, unless it continues a paragraph or a list
  if (/^(?: {4}|\t)/.test(s) && !wasText && !inList) return
  let k = i
  let quoted = false
  // Blockquote marks
  for (;;) {
    const m = /^ {0,3}>/.exec(s.slice(k))
    if (!m) break
    put(out, k + m[0].length - 1, k + m[0].length, META)
    k += m[0].length
    if (s[k] === ' ') k++
    quoted = true
  }
  const rest = s.slice(k)
  // A fence
  const f = FENCE.exec(rest)
  if (f && !(f[2][0] === '`' && rest.slice(f[0].length).includes('`'))) {
    put(out, k + f[1].length, k + f[1].length + f[2].length, META)
    const info = f[3].replace(/^\{\.?|\}$/g, '').split(/[{,]/)[0]
    st.push('F' + f[2] + '|' + info)
    return
  }
  if (/^ {0,3}<!--/.test(rest)) {
    const e = s.indexOf('-->', k)
    put(out, k, e < 0 ? end : e + 3, COMMENT)
    if (e < 0) st.push('Mc')
    else if (s.slice(e + 3).trim()) inline(s, e + 3, end, 0, out)
    return
  }
  if (/^ {0,3}<\/?[A-Za-z][\w-]*(?:\s|\/?>|$)/.test(rest) && !quoted) {
    st.push('Mh')
    markup(HTML_PAGE, s, k, end, st, base + 1, out)
    return
  }
  // A heading
  const h = /^( {0,3})(#{1,6})(?=\s|$)/.exec(rest)
  if (h) {
    const from = k + h[1].length
    put(out, from, from + h[2].length, HEADING | META)
    const close = /\s+#+\s*$/.exec(s.slice(from + h[2].length))
    const textEnd = close ? end - close[0].length : end
    inline(s, from + h[2].length, textEnd, HEADING, out)
    if (close) put(out, textEnd, end, HEADING | META)
    return
  }
  if (wasText && SETEXT.test(rest)) {
    put(out, k, end, HEADING | META)
    return
  }
  if (HR.test(rest) && !(wasText && /^ {0,3}-/.test(rest))) return
  // A list item's mark
  let text = k
  const b = BULLET.exec(rest)
  if (b) {
    put(out, k + b[0].search(/\S/), k + b[0].length, META)
    text = k + b[0].length
  }
  // A link's definition: [label]: url "title"
  const d = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/.exec(rest)
  if (d && !b) {
    const u = s.indexOf(d[1], k + rest.indexOf(']:'))
    put(out, u, u + d[1].length, URL)
    if (d[2]) put(out, s.lastIndexOf(d[2].trim()), end, STRING)
    return
  }
  // Text: an underline on the next line makes it a heading
  const heading = !b && !quoted && next !== undefined && SETEXT.test(next) && !BLOCK_START.test(rest)
    ? HEADING : 0
  if (heading && text > k) put(out, k, text, HEADING)
  inline(s, text, end, heading, out)
  st.push(b || inList ? 'I' : 'P')
}

/** Markdown's inline styles from `i` to `end`, each class combined with `flags`. Classes go to a buffer by
 * character first, since emphasis and links nest over the tokens inside them. */
let classes = new Int32Array(256)
function inline(s, i, end, flags, out) {
  if (end <= i) return
  if (classes.length < end - i) classes = new Int32Array(2 * (end - i))
  classes.fill(flags, 0, end - i)
  styles(s, i, end, flags, i)
  let from = i
  for (let x = i + 1; x <= end; x++) {
    if (x < end && classes[x - i] === classes[from - i]) continue
    put(out, from, x, classes[from - i])
    from = x
  }
}

function styles(s, i, end, flags, at) {
  const mark = (a, b, cls) => { for (let x = a; x < b; x++) classes[x - at] = cls }
  const marks = [] // delimiter runs: [at, length, char, canOpen, canClose]
  let k = i
  while (k < end) {
    const c = s[k]
    if (c === '\\' && k + 1 < end && /[!-/:-@[-`{-~]/.test(s[k + 1])) {
      mark(k, k + 2, flags | STRING2)
      k += 2
      continue
    }
    if (c === '`') {
      let n = 1
      while (s[k + n] === '`') n++
      let e = s.indexOf('`'.repeat(n), k + n)
      while (e >= 0 && e < end && s[e + n] === '`') {
        let m = e
        while (s[m] === '`') m++
        e = s.indexOf('`'.repeat(n), m)
      }
      if (e < 0 || e >= end) { k += n; continue }
      mark(k, k + n, flags | META)
      mark(e, e + n, flags | META)
      k = e + n
      continue
    }
    if (c === '&') {
      const m = /&(#\d+|#x[\da-fA-F]+|\w+);/y
      m.lastIndex = k
      if (m.test(s) && m.lastIndex <= end) { mark(k, m.lastIndex, flags | STRING); k = m.lastIndex; continue }
    }
    if (c === '<') {
      const auto = /<([a-zA-Z][\w+.-]*:[^\s<>]*|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/y
      auto.lastIndex = k
      if (auto.test(s) && auto.lastIndex <= end) {
        mark(k, auto.lastIndex, flags | META)
        mark(k + 1, auto.lastIndex - 1, flags | URL)
        k = auto.lastIndex
        continue
      }
      if (s.startsWith('<!--', k)) {
        const e = s.indexOf('-->', k)
        const to = e < 0 || e + 3 > end ? end : e + 3
        mark(k, to, COMMENT)
        k = to
        continue
      }
      const tag = /<\/?[A-Za-z][\w-]*(?:\s+[\w:@.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/y
      tag.lastIndex = k
      if (tag.test(s) && tag.lastIndex <= end) {
        const tmp = []
        markup(HTML_PAGE, s, k, tag.lastIndex, [], 0, tmp)
        for (let t = 0; t < tmp.length; t += 3) mark(tmp[t], tmp[t + 1], flags | tmp[t + 2])
        k = tag.lastIndex
        continue
      }
    }
    if (c === '[') {
      const link = linkAt(s, k, end)
      if (link) {
        const f = flags | LINK
        const from = s[k - 1] === '!' ? k - 1 : k
        mark(from, link.end, f)
        styles(s, k + 1, link.text, f, at)
        mark(from, k + 1, f | META)
        mark(link.text, link.text + 1, f | META)
        if (link.url) {
          mark(link.text + 1, link.text + 2, f | META)
          mark(link.url[0], link.url[1], f | URL)
          if (link.title) mark(link.title[0], link.title[1], f | STRING)
          mark(link.end - 1, link.end, f | META)
        } else if (link.end > link.text + 1) {
          mark(link.text + 1, link.text + 2, f | META)
          mark(link.end - 1, link.end, f | META)
        }
        k = link.end
        continue
      }
    }
    if (c === '*' || c === '_') {
      let n = 1
      while (s[k + n] === c) n++
      const before = k > i ? s[k - 1] : ' '
      const after = k + n < end ? s[k + n] : ' '
      const left = !space(after) && (!punct(after) || space(before) || punct(before))
      const right = !space(before) && (!punct(before) || space(after) || punct(after))
      const open = c === '*' ? left : left && (!right || punct(before))
      const close = c === '*' ? right : right && (!left || punct(after))
      if (open || close) marks.push([k, n, c, open, close])
      k += n
      continue
    }
    k++
  }
  // Emphasis: each closing run takes the nearest opener it can, as CommonMark's delimiter stack does.
  for (let j = 0; j < marks.length; j++) {
    const m = marks[j]
    if (!m[4]) continue
    for (let o = j - 1; o >= 0 && m[1] > 0; o--) {
      const op = marks[o]
      if (!op[3] || op[2] !== m[2] || op[1] === 0) continue
      if ((op[4] || m[3]) && (op[1] + m[1]) % 3 === 0 && !(op[1] % 3 === 0 && m[1] % 3 === 0)) continue
      const n = op[1] >= 2 && m[1] >= 2 ? 2 : 1
      const a = op[0] + op[1] - n
      const b = m[0] + n
      for (let x = a; x < b; x++) classes[x - at] |= n === 2 ? STRONG : EMPHASIS
      for (const x of n === 2 ? [a, a + 1, b - 2, b - 1] : [a, b - 1]) classes[x - at] = (classes[x - at] & ~31) | META
      op[1] -= n
      m[1] -= n
      m[0] += n
      for (let x = o + 1; x < j; x++) marks[x][1] = 0
      o++
    }
  }
}
const space = x => x === ' ' || x === '\t' || x === '\n'
const punct = x => /[!-/:-@[-`{-~\p{P}\p{S}]/u.test(x)

/** A link at `[`: where its text ends, its destination and title, and its end; null when `[` opens none. */
function linkAt(s, k, end) {
  let d = 0
  let e = k
  for (; e < end; e++) {
    if (s[e] === '\\') { e++; continue }
    if (s[e] === '`') { const c = s.indexOf('`', e + 1); if (c > 0 && c < end) e = c; continue }
    if (s[e] === '[') d++
    else if (s[e] === ']' && --d === 0) break
  }
  if (e >= end || e === k + 1) return null
  if (s[e + 1] === '(') {
    const m = at(/\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/y, s, e + 1)
    if (m && e + 1 + m[0].length <= end) {
      const u = e + 1 + m[0].indexOf(m[1], 1)
      const t = m[2] ? s.indexOf(m[2], u + m[1].length) : -1
      return { text: e, url: [u, u + m[1].length], title: t >= 0 ? [t, t + m[2].length] : null, end: e + 1 + m[0].length }
    }
  }
  if (s[e + 1] === '[') {
    const c = s.indexOf(']', e + 2)
    if (c > 0 && c < end) return { text: e, url: null, end: c + 1 }
  }
  return { text: e, url: null, end: e + 1 }
}

// ---- YAML

function yaml(L, s, i, end, st, base, out) {
  // Frames: B<indent> a block scalar's text, deeper than <indent>; q" a quoted string across lines.
  const top = st.length > base ? st[st.length - 1] : ''
  const indent = s.search(/\S|$/)
  if (top[0] === 'B') {
    if (!s.trim() || indent > +top.slice(1)) return
    st.pop()
  }
  if (top[0] === 'q') {
    const e = quoted(s, i, end, top[1])
    put(out, i, e < 0 ? end : e, STRING)
    if (e < 0) return
    st.pop()
    i = e
  }
  if (/^(---|\.\.\.)(\s|$)/.test(s)) { put(out, 0, 3, META); i = 3 }
  else if (s[0] === '%') { const e = name(s, 1, end); put(out, 0, e, KEYWORD); return }
  let key = true // at a place a key can start
  while (i < end) {
    const c = s.charCodeAt(i)
    if (isSpace(c)) { i++; continue }
    if (c === 35 && (i === 0 || isSpace(s.charCodeAt(i - 1)))) { put(out, i, end, COMMENT); return }
    if (c === 45 && (isSpace(s.charCodeAt(i + 1)) || i + 1 >= end)) { i++; key = true; continue }
    if (c === 123 || c === 44 || c === 91 || c === 63) { i++; key = true; continue }
    if (c === 125 || c === 93) { i++; continue }
    if (c === 34 || c === 39) {
      const e = quoted(s, i + 1, end, s[i])
      const to = e < 0 ? end : e
      const after = skip(s, to, end)
      put(out, i, to, key && s[after] === ':' ? PROPDEF : STRING)
      if (e < 0) st.push('q' + s[i])
      i = to
      key = false
      continue
    }
    if ((c === 124 || c === 62) && /^[|>][-+\d]*\s*(#.*)?$/.test(s.slice(i))) {
      const h = /^[|>][-+\d]*/.exec(s.slice(i))[0]
      put(out, i, i + h.length, STRING2)
      const cm = s.indexOf('#', i + h.length)
      if (cm >= 0) put(out, cm, end, COMMENT)
      st.push('B' + indent)
      return
    }
    if (c === 38 || c === 42) { i = name(s, i + 1, end, DASHES); key = false; continue }
    if (c === 33) {
      let e = i + 1
      while (e < end && !isSpace(s.charCodeAt(e))) e++
      put(out, i, e, TYPE)
      i = e
      continue
    }
    // A plain scalar: a key when a colon and a space follow it
    let e = i
    let colon = -1
    while (e < end) {
      const ch = s.charCodeAt(e)
      if (ch === 58 && (e + 1 >= end || isSpace(s.charCodeAt(e + 1)) || (st.flow && s[e + 1] === ','))) { colon = e; break }
      if (ch === 35 && isSpace(s.charCodeAt(e - 1))) break
      if ((ch === 44 || ch === 93 || ch === 125) && /[[{]/.test(s.slice(0, i))) break
      e++
    }
    if (colon >= 0 && key) {
      let ke = colon
      while (ke > i && isSpace(s.charCodeAt(ke - 1))) ke--
      put(out, i, ke, PROPDEF)
      i = colon + 1
      key = false
      continue
    }
    let ve = e
    while (ve > i && isSpace(s.charCodeAt(ve - 1))) ve--
    i = e
    key = false
  }
}

/** The end (after the quote) of a YAML string closed by `q` from `i`, or -1 when it runs past the line. */
function quoted(s, i, end, q) {
  for (let k = i; k < end; k++) {
    if (q === '"' && s[k] === '\\') { k++; continue }
    if (s[k] === q) {
      if (q === "'" && s[k + 1] === "'") { k++; continue }
      return k + 1
    }
  }
  return -1
}

// ---- INI, .env, properties and TOML

function ini(L, s, i, end, st, base, out) {
  if (st.length > base) {
    // A TOML string across lines
    const close = st[base].slice(1)
    const e = s.indexOf(close, i)
    put(out, i, e < 0 ? end : e + 3, STRING)
    if (e < 0) return
    st.length = base
    i = e + 3
  }
  i = skip(s, i, end)
  const c = s[i]
  if (c === '#' || (c === ';' && !L.toml)) return put(out, i, end, COMMENT)
  if (c === '[') {
    // [section]: a heading in INI, an atom in TOML
    const e = s.indexOf(']', i)
    const to = e < 0 ? end : s[e + 1] === ']' ? e + 2 : e + 1
    put(out, i, to, L.toml ? ATOM : HEADING)
    const k = s.indexOf('#', to)
    if (k >= 0) put(out, k, end, COMMENT)
    return
  }
  const m = at(/(?:export\s+)?([^=:#;\s][^=:]*?)\s*(=|:(?!\/))/y, s, i)
  if (!m || (L.toml && m[2] !== '=')) return L.toml && tomlValue(s, i, end, st, base, out)
  const k = i + m[0].indexOf(m[1])
  if (m[0].startsWith('export')) put(out, i, i + 6, KEYWORD)
  put(out, k, k + m[1].length, L.toml ? PROP : DEF)
  if (L.toml) tomlValue(s, i + m[0].length, end, st, base, out)
}

function tomlValue(s, i, end, st, base, out) {
  let braces = 0 // inline tables' keys go uncolored
  while (i < end) {
    const c = s.charCodeAt(i)
    if (c === 123) braces++
    else if (c === 125) braces--
    if (isSpace(c) || c === 44 || c === 91 || c === 93 || c === 123 || c === 125 || c === 61) { i++; continue }
    if (c === 35) return put(out, i, end, COMMENT)
    if (c === 34 || c === 39) {
      const q = s[i]
      if (s.startsWith(q + q + q, i)) {
        const e = s.indexOf(q + q + q, i + 3)
        put(out, i, e < 0 ? end : e + 3, STRING)
        if (e < 0) return st.push('T' + q + q + q)
        i = e + 3
        continue
      }
      let e = i + 1
      while (e < end && s[e] !== q) e += q === '"' && s[e] === '\\' ? 2 : 1
      put(out, i, Math.min(e + 1, end), STRING)
      i = e + 1
      continue
    }
    if (isDigit(c) || ((c === 43 || c === 45) && isDigit(s.charCodeAt(i + 1)))) {
      const m = at(/[+-]?[\w.:+-]*/y, s, i)
      put(out, i, i + m[0].length, /^[+-]?[\d_.]+(e[+-]?\d+)?$|^0x/i.test(m[0]) ? NUMBER : ATOM)
      i += Math.max(m[0].length, 1)
      continue
    }
    if (isStart(c)) {
      const e = name(s, i, end, DASHES)
      const w = s.slice(i, e)
      if (/^(true|false|inf|nan)$/.test(w)) put(out, i, e, ATOM)
      else if (!braces && s[skip(s, e, end)] === '=') put(out, i, e, PROP)
      i = e
      continue
    }
    i++
  }
}

// ---- diff

function diff(L, s, i, end, st, base, out) {
  const c = s[0]
  const cls = c === '+' ? INSERTED : c === '-' ? DELETED : c === '@' ? META : /^(diff|index|similarity|rename|new file|deleted file|old mode|new mode|Binary)\b/.test(s) ? META : 0
  put(out, 0, end, cls)
}

// ---- Batch files

function bat(L, s, i, end, st, base, out) {
  const P = prep(L)
  i = skip(s, i, end)
  if (s[i] === '@') { put(out, i, i + 1, META); i++ }
  if (/^(rem(\s|$)|::)/i.test(s.slice(i))) { put(out, i, end, COMMENT); return }
  if (s[i] === ':') { put(out, i, end, DEF); return }
  let first = true
  while (i < end) {
    const c = s.charCodeAt(i)
    if (isSpace(c)) { i++; continue }
    if (c === 37 || c === 33) {
      // %var%, %~dp0, %%f, !var!
      const m = c === 37 ? /%(?:%?~?[a-zA-Z0-9]*[a-zA-Z0-9]|[^%\s]+%|\*)/y : /![^!\s]+!/y
      m.lastIndex = i
      if (m.test(s)) { put(out, i, m.lastIndex, VAR2); i = m.lastIndex; continue }
    }
    if (c === 34) {
      let e = i + 1
      while (e < end && s[e] !== '"') {
        if (s[e] === '%' || s[e] === '!') {
          const m = s[e] === '%' ? /%(?:%?~?[a-zA-Z0-9]*[a-zA-Z0-9]|[^%\s"]+%)/y : /![^!\s"]+!/y
          m.lastIndex = e
          if (m.test(s)) { put(out, i, e, STRING); put(out, e, m.lastIndex, VAR2); i = e = m.lastIndex; continue }
        }
        e++
      }
      put(out, i, Math.min(e + 1, end), STRING)
      i = e + 1
      continue
    }
    if (isStart(c)) {
      const e = name(s, i, end, DASH_DOT)
      const w = s.slice(i, e).toLowerCase()
      if (P.kw.has(w)) put(out, i, e, KEYWORD)
      if (w === 'rem' && first) { put(out, i, end, COMMENT); return }
      i = e
      first = false
      continue
    }
    if (isDigit(c)) {
      const e = number(s, i)
      put(out, i, e, NUMBER)
      i = e
      continue
    }
    if (c === 40 || c === 38 || c === 124) first = true
    i++
  }
}

// ---- Dockerfile: each line's instruction, its strings and comments

function docker(L, s, i, end, st, base, out) {
  const P = prep(L)
  const cont = st.length > base // the line before ended in a backslash
  st.length = base
  let k = skip(s, i, end)
  if (s[k] === '#' && !cont) return put(out, k, end, COMMENT)
  if (!cont) {
    const e = name(s, k, end)
    if (P.kw.has(s.slice(k, e).toLowerCase())) put(out, k, e, KEYWORD)
    k = e
  }
  for (; k < end; k++) {
    const c = s[k]
    if (c === '"' || c === "'") {
      let e = k + 1
      while (e < end && s[e] !== c) e += s[e] === '\\' ? 2 : 1
      put(out, k, Math.min(e + 1, end), STRING)
      k = e
    } else if (isStart(s.charCodeAt(k)) && !isPart(s.charCodeAt(k - 1))) {
      const e = name(s, k, end)
      if (s.slice(k, e).toLowerCase() === 'as' && /^\s*\w+\s*$/.test(s.slice(e))) put(out, k, e, KEYWORD)
      k = e - 1
    }
  }
  if (/\\\s*$/.test(s)) st.push('c')
}

// ---- Makefiles

function make(L, s, i, end, st, base, out) {
  const P = prep(L)
  if (s[0] === '\t') return code(lang('sh'), s, 1, end, st, base, out)
  const k = skip(s, i, end)
  if (s[k] === '#') { put(out, k, end, COMMENT); return }
  const w = /^[\w-]+/.exec(s.slice(k))?.[0]
  if (w && P.kw.has(w)) {
    put(out, k, k + w.length, KEYWORD)
    return code(lang('sh'), s, k + w.length, end, st, base, out)
  }
  const assign = /^([\w.$()-]+)\s*(?:[:+?!]?=)/.exec(s.slice(k))
  if (assign) {
    put(out, k, k + assign[1].length, DEF)
    return makeVars(s, k + assign[0].length, end, out)
  }
  const target = /^([^:#=\t][^:#=]*?)\s*::?(?!=)/.exec(s.slice(k))
  if (target) {
    put(out, k, k + target[1].length, DEF)
    return makeVars(s, k + target[0].length, end, out)
  }
  makeVars(s, k, end, out)
}

function makeVars(s, i, end, out) {
  const m = /\$(?:\([^)]*\)|\{[^}]*\}|.)|#.*/g
  m.lastIndex = i
  for (let r; (r = m.exec(s)) && r.index < end;) put(out, r.index, r.index + r[0].length, r[0][0] === '#' ? COMMENT : VAR2)
}

// ---- LaTeX

function tex(L, s, i, end, st, base, out) {
  const m = /\\(?:[A-Za-z@]+|.)|%.*|\$\$?|[{}[\]]/g
  m.lastIndex = i
  for (let r; (r = m.exec(s)) && r.index < end;) {
    const t = r[0]
    put(out, r.index, r.index + t.length, t[0] === '%' ? COMMENT : t[0] === '\\' ? (/^\\(begin|end)$/.test(t) ? KEYWORD : TYPE) : t[0] === '$' ? META : 0)
  }
}

const LEXERS = { code, php, markup, css, markdown, yaml, ini, diff, bat, docker, make, tex }
