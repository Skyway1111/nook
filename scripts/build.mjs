// nook's build: the page into dist/, then the release exe, then the installer. Node's own modules only.
//   npm run build                  dist/, nook.exe, its payload staged in target/release/stage, and the installer,
//                                  or on Linux a .deb
//   npm run build -- --no-pack     stops once the stage is a runnable nook
//   npm run build -- --dist        stops after dist/
// NOOK_ID and NOOK_NAME, the build's identity, reach both cargo builds through the environment.
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'src')
const dist = join(root, 'dist')
const windows = process.platform === 'win32'

// What ships beside nook.exe, as [from in the repo, to in the install]. A folder copies whole.
const PAYLOAD = [
  ...(windows ? [
    ['native/conpty/conpty.dll', 'conpty.dll'],
    ['native/conpty/OpenConsole.exe', 'OpenConsole.exe'],
    ['native/conpty/LICENSE', 'conpty-LICENSE.txt'],
  ] : []),
  ['src/fonts/OFL.txt', 'Libron-LICENSE.txt'],
  ['src/fonts/FluentIcons-LICENSE.txt', 'FluentIcons-LICENSE.txt'],
  ['mod/.claude-plugin/plugin.json', 'mod/.claude-plugin/plugin.json'],
  ['mod/hooks/hooks.json', 'mod/hooks/hooks.json'],
  ['mod/hooks/register.js', 'mod/hooks/register.js'],
  ['mod/types/index.d.ts', 'mod/types/index.d.ts'],
  ['mod/themes/nook.json', 'mod/themes/nook.json'],
  ['themes', 'themes'],
]

// The bundle's runtime. E holds each module's exports by number and F the lazy modules' factories, which the
// chunks add; J(n) runs module n once, and J.i(chunks, n) is import(). No module may use these three names.
const RUNTIME = `const E=[],F=[],J=n=>E[n]??=F[n](J)
J.i=(f,n)=>Promise.all(f.map(f=>import('./'+f))).then(m=>{for(const c of m)Object.assign(F,c.default);return J(n)})
`
const RESERVED = new Set(['E', 'F', 'J'])

const BEFORE_REGEX = new Set('return typeof instanceof in of new delete void throw case do else yield await'.split(' '))
const WORD = /[\w$\u0080-\uffff\\]/
// Each token kind's run of characters, read at a given index.
const RUN = {
  ' ': /[ \t\f\v\ufeff]+/y,
  c: /\/\/[^\n\r\u2028\u2029]*/y,
  w: /[\w$\u0080-\uffff\\]+/y,
  "'": /'(?:[^'\\\n]|\\[^])*'/y,
  '"': /"(?:[^"\\\n]|\\[^])*"/y,
  r: /\/(?:[^/\\[\n\r]|\\.|\[(?:[^\]\\\n\r]|\\.)*\])+\/[\w$]*/y,
}

/** JS as tokens `[type, text, mark, index]`: w a word or number, s a string, t a piece of a template, r a regex,
 * p punctuation, c a comment, n a line break, ' ' spaces. A `)` closing an if, for, while, or with head is marked,
 * since a slash after it starts a regex. */
function tokenize(js, file) {
  const out = []
  const braces = [] // per open brace, whether it opened a template's ${
  const parens = [] // per open paren, whether it holds a statement's head
  let prev = null // the last token that isn't space or a comment
  let i = 0
  const fail = what => { throw new Error(`${file}:${js.slice(0, i).split('\n').length}: ${what}`) }
  const push = (type, end, mark) => {
    const t = [type, js.slice(i, end), mark, out.length]
    out.push(t)
    if (type !== ' ' && type !== 'n' && type !== 'c') prev = t
    i = end
  }
  const run = (type, kind = type) => {
    RUN[kind].lastIndex = i
    if (!RUN[kind].test(js)) fail(`unclosed ${type === 's' ? 'string' : 'regex'}`)
    push(type, RUN[kind].lastIndex)
  }
  // From the ` or } at i: the piece of template up to its closing ` or its next ${.
  const template = () => {
    for (let j = i + 1; j < js.length; j++) {
      const c = js[j]
      if (c === '\\') j++
      else if (c === '`') return push('t', j + 1)
      else if (c === '$' && js[j + 1] === '{') { braces.push(true); return push('t', j + 2) }
    }
    fail('unclosed template')
  }
  const regexAllowed = () => {
    if (!prev) return true
    const [type, text, mark] = prev
    if (type === 'w') return BEFORE_REGEX.has(text)
    if (type === 't') return text.endsWith('${')
    if (type !== 'p') return false
    return text === ')' ? !!mark : text !== ']' && text !== '++' && text !== '--'
  }
  while (i < js.length) {
    const c = js[i]
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === '\ufeff') run(' ')
    else if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') push('n', i + (c === '\r' && js[i + 1] === '\n' ? 2 : 1))
    else if (c === '/' && js[i + 1] === '/') run('c')
    else if (c === '/' && js[i + 1] === '*') {
      const j = js.indexOf('*/', i + 2)
      if (j < 0) fail('unclosed comment')
      push('c', j + 2)
    } else if (c === '/' && regexAllowed()) run('r')
    else if (c === '"' || c === "'") run('s', c)
    else if (c === '`') template()
    else if (c === '}' && braces.at(-1)) {
      braces.pop()
      template()
    } else if (WORD.test(c)) run('w')
    else {
      if (c === '{') braces.push(false)
      else if (c === '}') braces.pop()
      const statement = c === ')' ? parens.pop() : false
      if (c === '(') parens.push(prev?.[0] === 'w' && ['if', 'for', 'while', 'with'].includes(prev[1]))
      push('p', i + ((c === '+' || c === '-') && js[i + 1] === c ? 2 : 1), statement)
    }
  }
  return out
}

// A line break stays only where ASI could need it: not after punctuation that leaves the expression open, nor before
// punctuation that continues it, unless a return or the like ends the line before.
const OPEN = new Set('{([,;:?=<>+-*/%&|^!~.')
const GOES_ON = new Set('})],.?:=<>+-*%&|^')
const RESTRICTED = new Set(['return', 'throw', 'break', 'continue', 'yield', 'async'])

/** Tokens back to JS without comments, indentation, or the spaces and line breaks nothing needs. A token of type x is
 * left out. */
function squeeze(tokens) {
  let out = ''
  let last = null
  let gap = false
  let line = false
  for (const t of tokens) {
    const [type, text] = t
    if (type === 'x') continue
    if (type === ' ') { gap = true; continue }
    if (type === 'n' || (type === 'c' && /[\n\r\u2028\u2029]/.test(text))) { line = true; continue }
    if (type === 'c') { gap = true; continue }
    if (!text) continue
    if (line && last && !(last[0] === 'p' && OPEN.has(last[1])) && !(type === 'p' && GOES_ON.has(text) && !RESTRICTED.has(last[1]))) out += '\n'
    else if ((gap || line) && last) {
      const a = last[1].at(-1)
      const b = text[0]
      if (((WORD.test(a) || last[0] === 'r') && WORD.test(b)) || ((a === '+' || a === '-') && a === b) ||
        (a === '/' && (b === '/' || b === '*')) || (b === '.' && /^\d+$/.test(last[1]))) out += ' '
    }
    out += text
    last = t
    gap = line = false
  }
  return out
}

/** CSS without comments, and with whitespace only where it means something. */
function squeezeCss(css) {
  const out = []
  let gap = false
  for (const { 0: all, 1: string, 2: comment, 3: space, 4: other, index } of css.matchAll(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\/\*[\s\S]*?\*\/)|(\s+)|([^"'/\s]+|\/)/g)) {
    // A comment with no space either side keeps its tokens apart, as a space wouldn't in a selector.
    if (comment) { if (!gap && out.length && /\S/.test(css[index + all.length] ?? ' ')) out.push('/**/'); continue }
    if (space) { gap = true; continue }
    const text = string ?? other
    const end = out.at(-1)?.at(-1)
    if (gap && end && !'{};,>:'.includes(end) && !'{};,>'.includes(text[0])) out.push(' ')
    if (text[0] === '}' && end === ';') out[out.length - 1] = out.at(-1).slice(0, -1)
    out.push(text)
    gap = false
  }
  return out.join('')
}

const mods = new Map() // path → module

/** The module at `file`: its tokens, its imports, the import() and new URL() in it, and its exports. */
function parse(file) {
  const tokens = tokenize(readFileSync(file, 'utf8').replace(/\r\n?/g, '\n'), file)
  const m = { file, tokens, imports: [], dynamic: [], assets: [], exports: [] }
  const code = tokens.filter(t => t[0] !== ' ' && t[0] !== 'n' && t[0] !== 'c')
  const fail = (t, what) => { throw new Error(`${relative(root, file)}:${tokens.slice(0, t[3]).map(t => t[1]).join('').split('\n').length}: ${what}`) }
  const target = t => {
    if (t?.[0] !== 's' || !/^['"]\.\.?\//.test(t[1])) fail(t, `${t?.[1]}: nook imports its own files only, by a relative path in quotes`)
    return resolve(dirname(file), t[1].slice(1, -1))
  }
  // Leaves out code[a] to code[b], and ends the statement there if the next line could continue the one before.
  const drop = (a, b) => {
    for (let k = code[a][3]; k <= code[b][3]; k++) tokens[k][0] = 'x'
    if (code[b + 1] && '([`+-/'.includes(code[b + 1][1][0])) code[b].splice(0, 2, 'p', ';')
  }
  // From the { at code[k]: the names in it, as [name, alias], and the index of its }.
  const names = k => {
    const list = []
    for (k++; code[k][1] !== '}'; k++) {
      if (code[k][1] === ',') continue
      const as = code[k + 1][1] === 'as'
      list.push([code[k][1], code[as ? k + 2 : k][1]])
      if (as) k += 2
    }
    return [list, k]
  }
  for (let k = 0; k < code.length; k++) {
    const t = code[k]
    if (t[0] !== 'w' || code[k - 1]?.[1] === '.') continue
    if (RESERVED.has(t[1])) fail(t, `${t[1]} is the bundle's own name`)
    if (code[k + 1]?.[1] === ':') continue
    if (t[1] === 'import' && code[k + 1][1] === '(') {
      if (code[k + 3]?.[1] !== ')') fail(t, 'import() takes one path in quotes')
      const to = target(code[k + 2])
      if (!to.endsWith('.js')) fail(t, `import() loads a .js module; a stylesheet loads through sheet(new URL('${code[k + 2][1].slice(1, -1)}', import.meta.url))`)
      m.dynamic.push({ to, tokens: code.slice(k, k + 4) })
    } else if (t[1] === 'import' && code[k + 1][1] === '.') {
      const [n, u, open, path, comma] = code.slice(k - 5, k)
      if (n?.[1] !== 'new' || u[1] !== 'URL' || open[1] !== '(' || comma[1] !== ',' || code.slice(k + 1, k + 6).map(t => t[1]).join('') !== '.meta.url)') fail(t, "import.meta goes only in new URL('./file', import.meta.url)")
      const sheet = code[k - 7]?.[1] === 'sheet' && code[k - 6][1] === '('
      if (sheet && !/\.css['"]$/.test(path[1])) fail(t, 'sheet() takes a stylesheet')
      m.assets.push({ to: target(path), token: path, sheet })
    } else if (t[1] === 'import') {
      const i = {}
      let j = k + 1
      if (code[j][1] === '{') [i.names, j] = names(j)
      else if (code[j][1] === '*') { i.namespace = code[j + 2][1]; j += 2 } else if (code[j][0] === 'w') i.json = code[j][1]
      else fail(t, 'import { a } from, import * as a from, or a JSON file\'s import')
      if (code[j][0] !== 's') j++
      if (code[j][0] !== 's' && code[j][1] === 'from') j++
      i.to = target(code[j])
      if (i.json) {
        if (code[j + 1]?.[1] !== 'with' || !i.to.endsWith('.json')) fail(t, 'a default import is a JSON file, with { type: \'json\' }')
        i.text = JSON.stringify(JSON.parse(readFileSync(i.to, 'utf8')))
        while (code[j][1] !== '}') j++
      } else if (!i.to.endsWith('.js')) fail(t, 'imports a .js module')
      if (code[j + 1]?.[1] === ';') j++
      drop(k, j)
      m.imports.push(i)
      k = j
    } else if (t[1] === 'export') {
      const [a, b, c] = code.slice(k + 1, k + 4)
      t[0] = 'x'
      if (a[1] === 'const' && b[1] === '{') {
        const [list] = names(k + 2)
        for (const [name, alias] of list) if (name === alias) m.exports.push([name, name])
        else fail(t, 'export const { a } only, without renames')
      } else if (a[1] === 'function' || a[1] === 'class' || a[1] === 'const') m.exports.push([b[1], b[1]])
      else if (a[1] === 'async' && b[1] === 'function') m.exports.push([c[1], c[1]])
      else fail(t, `export ${a[1]}: nook exports a function, class, or const`)
    }
  }
  return m
}

/** Every module `file` reaches, statically or through import(), parsed into `mods`. */
function load(file) {
  if (mods.has(file)) return mods.get(file)
  const m = parse(file)
  mods.set(file, m)
  for (const i of m.imports) if (!i.json) i.module = load(i.to)
  for (const d of m.dynamic) d.module = load(d.to)
  return m
}

/** `m` and the modules it imports, each after its imports, as ES modules evaluate; without those in `skip`. */
function evaluation(m, skip = new Set()) {
  const out = []
  const open = new Set()
  const walk = m => {
    if (skip.has(m) || out.includes(m)) return
    if (open.has(m)) throw new Error(`${relative(root, m.file)} imports itself through a cycle`)
    open.add(m)
    for (const i of m.imports) if (i.module) walk(i.module)
    open.delete(m)
    out.push(m)
  }
  walk(m)
  return out
}

// Words that never name a binding. A module declaring one fails the build, as one calling eval or using with does.
const NOT_NAMES = new Set(('arguments await break case catch class const continue debugger default delete do else enum ' +
  'export extends false finally for function if implements import in instanceof interface let new null package private ' +
  'protected public return static super switch this throw true try typeof var void while with yield').split(' '))
// Short names: a first character, then any of NEXT. E, F, and J alone are the bundle's.
const FIRST = 'etnsriaoludcmphfgbvywkxqjzTNSRIAOLUDCMPHGBVYWKXQZ_$'
const NEXT = FIRST + 'EFJ0123456789'

/** Gives each name `m` declares a short one. A scope's bindings take the slots after its parents', so none hides
 * another, the slots used most get the shortest names, and no name is one the module uses without declaring. */
function mangle(m) {
  const code = [] // the tokens that aren't space, comments, or left out
  const nl = [] // whether a line ends before code[k]
  let line = false
  for (const t of m.tokens) {
    if (t[0] === 'n' || (t[0] === 'c' && /[\n\r\u2028\u2029]/.test(t[1]))) line = true
    else if (t[0] !== ' ' && t[0] !== 'c' && t[0] !== 'x') { code.push(t); nl.push(line); line = false }
  }
  const close = new Int32Array(code.length) // at an opener, its closer
  const opened = []
  code.forEach(([type, x], i) => {
    if (type === 'p' ? x === ')' || x === ']' || x === '}' : type === 't' && x[0] === '}') close[opened.pop()] = i
    if (type === 'p' ? x === '(' || x === '[' || x === '{' : type === 't' && x.endsWith('${')) opened.push(i)
  })
  let k = 0
  let limit = -1 // where a for's target ends, at its of
  const fail = what => {
    const t = code[Math.min(k, code.length - 1)]
    throw new Error(`${relative(root, m.file)}:${m.tokens.slice(0, t[3]).map(t => t[1]).join('').split('\n').length}: ${what}`)
  }
  const is = (i, x) => code[i]?.[1] === x
  const word = i => code[i]?.[0] === 'w'
  const touching = i => code[i + 1]?.[3] === code[i][3] + 1
  const arrow = i => is(i, '=') && is(i + 1, '>') && touching(i)
  const scope = (up, fn) => { const s = { up, fn, names: new Map(), kids: [] }; up?.kids.push(s); return s }
  const top = scope(null, true)
  const uses = [] // [token, scope] of every name read or written
  // A shorthand { a } is marked, so a new name goes in as { a: x }.
  const bind = (s, t, short) => {
    if (t?.[0] !== 'w' || NOT_NAMES.has(t[1]) || /^\d|\\/.test(t[1])) fail(`${t?.[1]}: not a name the bundle can rename`)
    if (!s.names.has(t[1])) s.names.set(t[1], { uses: [] })
    s.names.get(t[1]).uses.push(t)
    if (short) t[2] = 's'
  }
  const use = (s, t, short) => {
    if (t[1] === 'eval' || t[1].includes('\\')) fail(`${t[1]}: not a name the bundle can rename around`)
    uses.push([t, s])
    if (short) t[2] = 's'
  }
  const semi = () => { if (is(k, ';')) k++ }
  const expect = (end, what = 'what comes before it') => { if (k !== end) fail(`${code[k]?.[1]}: the bundle misread ${what}`) }
  const statements = (s, end) => {
    while (k < end) {
      const from = k
      statement(s)
      if (k === from) fail(`${code[k][1]}: the bundle can't read this`)
    }
  }
  const block = s => { const end = close[k++]; statements(scope(s, false), end); expect(end); k++ }
  // At ( or [: what's inside, up to its closer.
  const inside = s => { const end = close[k++]; expression(s, true); expect(end); k++ }

  function statement(s) {
    const x = code[k][1]
    if (x === ';') return void k++
    if (x === '{') return block(s)
    if (word(k)) switch (x) {
      case 'var': case 'let': case 'const': declarations(s, x); return semi()
      case 'function': return func(s, true)
      case 'async': if (is(k + 1, 'function') && !nl[k + 1]) { k++; return func(s, true) } break
      case 'class': return klass(s, true)
      case 'if': k++; inside(s); statement(s); if (is(k, 'else')) { k++; statement(s) } return
      case 'for': { k++; if (is(k, 'await')) k++; const f = scope(s, false); head(f); return statement(f) }
      case 'while': k++; inside(s); return statement(s)
      case 'do': k++; statement(s); if (!is(k++, 'while')) fail('do without while'); inside(s); return semi()
      case 'try':
        k++
        block(s)
        if (is(k, 'catch')) {
          k++
          const c = scope(s, false)
          if (is(k, '(')) { const end = close[k++]; pattern(c, c); expect(end); k++ }
          block(c)
        }
        if (is(k, 'finally')) { k++; block(s) }
        return
      case 'switch': {
        k++
        inside(s)
        const c = scope(s, false), end = close[k++]
        while (k < end) {
          if (is(k, 'case')) { k++; expression(c, false); if (!is(k++, ':')) fail('case without :') }
          else if (is(k, 'default') && is(k + 1, ':')) k += 2
          else statement(c)
        }
        expect(end)
        return void k++
      }
      case 'return': case 'throw': k++; if (!nl[k] && k < code.length && !is(k, ';') && !is(k, '}')) expression(s, true); return semi()
      case 'break': case 'continue': k++; if (!nl[k] && word(k)) k++; return semi()
      case 'debugger': k++; return semi()
      case 'with': fail('with: the bundle can\'t rename around it')
      default: if (is(k + 1, ':') && !NOT_NAMES.has(x)) { k += 2; return statement(s) } // a label
    }
    expression(s, true)
    semi()
  }
  // At a for's (: its own declarations go in f, the loop's scope.
  function head(f) {
    const end = close[k++]
    if (is(k, 'var') || is(k, 'let') || is(k, 'const')) declarations(f, code[k][1])
    else if (!is(k, ';')) {
      for (let i = k; i < end && !is(i, ';') && limit < 0; i = is(i, '(') || is(i, '[') || is(i, '{') ? close[i] + 1 : i + 1) if (is(i, 'of')) limit = i
      expression(f, true)
      limit = -1
    }
    if (is(k, 'of') || is(k, 'in')) { k++; expression(f, true) }
    while (k < end) if (is(k, ';')) k++; else expression(f, true)
    expect(end, 'the for')
    k++
  }
  function declarations(s, kind) {
    let into = s
    if (kind === 'var') while (!into.fn) into = into.up
    do { k++; pattern(s, into) } while (is(k, ','))
  }
  const initializer = s => { if (is(k, '=')) { k++; expression(s, false) } }
  // A binding pattern at k: its names bound in `into`, its defaults read in s.
  function pattern(s, into) {
    if (is(k, '.')) k += 3 // ...rest
    if (is(k, '[')) {
      const end = close[k++]
      while (k < end) if (is(k, ',')) k++; else pattern(s, into)
      expect(end, 'the pattern')
      k++
    } else if (is(k, '{')) {
      const end = close[k++]
      while (k < end) {
        if (is(k, ',')) k++
        else if (is(k, '.')) pattern(s, into)
        else if (is(k, '[') || is(k + 1, ':')) { key(s); k++; pattern(s, into) }
        else { bind(into, code[k++], true); initializer(s) }
      }
      expect(end, 'the pattern')
      k++
    } else bind(into, code[k++])
    initializer(s)
  }
  const params = f => {
    const end = close[k++]
    while (k < end) if (is(k, ',')) k++; else pattern(f, f)
    expect(end, 'the parameters')
    k++
  }
  // At function: its name, bound in s for a declaration and in a scope of its own for an expression; then the rest.
  function func(s, declared) {
    k++
    if (is(k, '*')) k++
    let f = s
    if (word(k)) { if (!declared) f = scope(s, false); bind(f, code[k++]) }
    f = scope(f, true)
    params(f)
    block(f)
  }
  // At an arrow's parameter, or the ( of its list.
  function arrowFn(s) {
    const f = scope(s, true)
    if (word(k)) bind(f, code[k++])
    else params(f)
    k += 2
    if (is(k, '{')) block(f)
    else expression(f, false)
  }
  function klass(s, declared) {
    k++
    if (word(k) && !is(k, 'extends')) { if (!declared) s = scope(s, false); bind(s, code[k++]) }
    if (is(k, 'extends')) { k++; expression(s, true, true) }
    const end = close[k++]
    while (k < end) {
      if (is(k, ';')) k++
      else if (is(k, 'static') && is(k + 1, '{')) { k++; block(scope(s, true)) }
      else member(s, true)
    }
    expect(end, 'the class')
    k++
  }
  const keyStart = i => word(i) || code[i]?.[0] === 's' || is(i, '[') || is(i, '#') || is(i, '*')
  const key = s => { if (is(k, '[')) inside(s); else { if (is(k, '#')) k++; k++ } }
  // A member of a class or an object literal: its key names a property, never a binding.
  function member(s, inClass) {
    while (is(k, '*') || ((is(k, 'get') || is(k, 'set') || (is(k, 'static') && inClass) || (is(k, 'async') && !nl[k + 1])) && keyStart(k + 1))) k++
    const name = code[k]
    key(s)
    if (is(k, '(')) { const f = scope(s, true); params(f); return block(f) }
    if (inClass) { initializer(scope(s, true)); return semi() }
    if (is(k, ':')) { k++; return expression(s, false) }
    if (name[0] !== 'w') fail(`${name[1]}: the bundle misread the object`)
    use(s, name, true)
    initializer(s)
  }
  function object(s) {
    const end = close[k++]
    while (k < end) {
      if (is(k, ',')) k++
      else if (is(k, '.')) { k += 3; expression(s, false) }
      else member(s, false)
    }
    expect(end, 'the object')
    k++
  }
  // Whether code[i], first on its line, goes on with the expression before it rather than starting a statement.
  function goesOn(i) {
    const [pt, px] = code[i - 1], [type, x] = code[i]
    if (pt === 'p' ? OPEN.has(px) : pt === 'w' && BEFORE_REGEX.has(px) && px !== 'yield' && px !== 'of') return true
    if (type === 'p') return GOES_ON.has(x) || x === '(' || x === '[' || x === '/' || (x === '!' && is(i + 1, '=') && touching(i))
    return type === 't' ? x[0] === '`' : type === 'w' && (x === 'in' || x === 'instanceof')
  }
  // An expression from k to what ends it: a closer, a ;, or a line end it can't go on past; for one value (not all),
  // also a comma or a : that closes no ? of its own; for a class's heritage (brace), its body's {.
  function expression(s, all, brace) {
    let open = 0 // ? still waiting for their :
    for (const from = k; k < code.length;) {
      const [type, x] = code[k]
      if ((k > from && nl[k] && !goesOn(k)) || k === limit) return
      if (type === 't') {
        if (x[0] === '}') return
        while (code[k][1].endsWith('${')) { const end = close[k++]; expression(s, true); expect(end, 'the template') }
        k++
      } else if (type === 'w') {
        if (arrow(k + 1)) arrowFn(s)
        else if (x === 'function') func(s, false)
        else if (x === 'class') klass(s, false)
        else if (x === 'async' && !nl[k + 1] && (is(k + 1, 'function') || (is(k + 1, '(') && arrow(close[k + 1] + 1)) || (word(k + 1) && arrow(k + 2)))) {
          k++
          if (is(k, 'function')) func(s, false)
          else arrowFn(s)
        } else {
          if (!NOT_NAMES.has(x) && !/^\d/.test(x)) use(s, code[k])
          k++
        }
      } else if (type !== 'p') k++
      else if (x === ')' || x === ']' || x === '}' || x === ';' || (x === '{' && brace)) return
      else if (x === ':' && open) { open--; k++ }
      else if (x === ',' || x === ':') {
        if (!all) return
        if (x === ':') fail('a : the bundle can\'t place')
        k++
      } else if (x === '?') {
        if (touching(k) && is(k + 1, '?')) k += 2
        else if (touching(k) && is(k + 1, '.') && !/^\d/.test(code[k + 2]?.[1])) { k += 2; property() }
        else { open++; k++ }
      } else if (x === '.') {
        if (is(k + 1, '.') && touching(k)) k += 3
        else { k++; property() }
      } else if (x === '#') k += 2
      else if (x === '(') { if (arrow(close[k] + 1)) arrowFn(s); else inside(s) }
      else if (x === '[') inside(s)
      else if (x === '{') object(s)
      else k++
    }
  }
  // After . or ?.: a name there is a property's.
  const property = () => { if (is(k, '#')) k++; if (word(k)) k++ }

  for (const i of m.imports) for (const name of i.json ? [i.json] : i.namespace ? [i.namespace] : i.names.map(n => n[1])) top.names.set(name, { uses: [] })
  statements(top, code.length)
  const free = new Set(RESERVED)
  for (const [t, s] of uses) {
    let b
    for (let c = s; c && !(b = c.names.get(t[1])); c = c.up);
    if (b) b.uses.push(t)
    else free.add(t[1])
  }
  const count = [] // per slot, how often its names are written
  const slot = (s, n) => {
    for (const b of s.names.values()) { b.slot = n; count[n] = (count[n] ?? 0) + b.uses.length + 1; n++ }
    for (const c of s.kids) slot(c, n)
  }
  slot(top, 0)
  const names = []
  for (let i = 0; names.length < count.length; i++) {
    let n = FIRST[i % FIRST.length]
    for (let j = Math.floor(i / FIRST.length); j; j = Math.floor((j - 1) / NEXT.length)) n += NEXT[(j - 1) % NEXT.length]
    if (!free.has(n) && !NOT_NAMES.has(n)) names.push(n)
  }
  const named = []
  count.map((_, i) => i).sort((a, b) => count[b] - count[a]).forEach((n, i) => { named[n] = names[i] })
  const rename = s => {
    for (const [name, b] of s.names) {
      b.name = named[b.slot]
      for (const t of b.uses) t[1] = b.name === name ? name : t[2] === 's' ? `${name}:${b.name}` : b.name
    }
    s.kids.forEach(rename)
  }
  rename(top)
  m.name = local => top.names.get(local).name
}

/** V8 parses `body`: a plain function rejects an await outside every async function inside it, an async one
 * takes it. The check is also the build's syntax check. */
const AsyncFunction = (async () => {}).constructor
function waits(m, body) {
  const check = `'use strict'\n${body.replace(/\bimport\.meta\b/g, 'M').replace(/(?<!\bfor\s*)\bawait\b/g, 'await await')}`
  try { Function(check); return false } catch {}
  try { AsyncFunction(check); return true } catch (e) { throw new Error(`${relative(root, m.file)}, bundled: ${e.message}`) }
}

const written = new Set()
/** Writes dist/<rel> unless it holds these bytes already, so cargo relinks nook.exe only when the page changed. */
function put(rel, data) {
  const file = join(dist, rel)
  written.add(file)
  try { if (readFileSync(file).equals(Buffer.from(data))) return } catch {}
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
}

/** Copies `file` into dist at its place under src/, and returns that place for a URL. */
function asset(file, css) {
  const rel = relative(src, file).replaceAll('\\', '/')
  if (rel.startsWith('..')) throw new Error(`${relative(root, file)}: an asset lives under src/`)
  put(rel, css ? style(file) : readFileSync(file))
  return `./${rel}`
}

/** A stylesheet, squeezed, with each url() copied and pointing at its copy. */
const style = file => squeezeCss(readFileSync(file, 'utf8')).replace(/url\((['"]?)([^'")]+)\1\)/g, (all, q, url) =>
  /^(data:|https?:|#)/.test(url) ? all : `url(${asset(resolve(dirname(file), url))})`)

/** dist/: index.html, index.css with the stylesheets it links, index.js with every module main.js imports, a chunk per
 * set of import() targets sharing modules, and the assets they name. In index.js each module runs in a function of
 * its own, which V8 can let go once it has run, and main.js in a block, where it can wait. A chunk's modules are
 * functions in parentheses, which V8 compiles with the chunk rather than again when each first runs. */
function bundle() {
  const started = performance.now()
  let html = readFileSync(join(root, 'index.html'), 'utf8').replace(/\r\n?/g, '\n')
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="\/(src\/[^"]+)" \/>\n */g)]
  const entry = /<script type="module" src="\/(src\/[^"]+)"><\/script>/.exec(html)
  if (!sheets.length || !entry) throw new Error('index.html: expected <link rel="stylesheet" href="/src/…" /> lines and a <script type="module" src="/src/…">')
  put('index.css', sheets.map(([, href]) => style(join(root, href))).join(''))
  html = html.replace(sheets[0][0], '<link rel="stylesheet" href="/index.css" />\n').replace(entry[0], '<script type="module" src="/index.js"></script>')
  for (const [link] of sheets.slice(1)) html = html.replace(link, '')
  put('index.html', html.replace(/<!--[\s\S]*?-->/g, '').replace(/^ +/gm, '').replace(/\n+/g, '\n'))

  const main = load(join(root, entry[1]))
  for (const m of mods.values()) for (const [name] of m.exports) if (!/^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u.test(name)) throw new Error(`${relative(root, m.file)}: exports ${name}, which isn't a name`)
  for (const m of mods.values()) for (const i of m.imports) for (const [name] of i.names ?? []) if (!i.module.exports.some(e => e[0] === name)) throw new Error(`${relative(root, m.file)}: ${relative(root, i.module.file)} exports no ${name}`)
  const startup = evaluation(main)
  const eager = new Set(startup)
  const all = [...mods.values()]
  all.forEach((m, n) => { m.n = n })
  // Lazy modules in chunks by the set of import() targets that need them, each chunk named for a module in it
  // that no other there imports.
  const targets = [...new Set(all.flatMap(m => m.dynamic.map(d => d.module)))]
  if (targets.includes(main)) throw new Error(`${entry[1]} runs first, so nothing imports it`)
  const needs = new Map(targets.map(t => [t, evaluation(t, eager)]))
  const chunks = new Map()
  for (const m of all) {
    if (eager.has(m)) continue
    const key = targets.filter(t => needs.get(t).includes(m)).map(t => t.n).join()
    if (!chunks.has(key)) chunks.set(key, [])
    chunks.get(key).push(m)
  }
  for (const list of chunks.values()) {
    const name = basename(list.find(m => !list.some(o => o.imports.some(i => i.module === m))).file)
    if (name === 'index.js' || all.some(m => m.chunk === name)) throw new Error(`two files in dist named ${name}`)
    for (const m of list) m.chunk = name
  }
  const added = new Map() // stylesheet → how many modules add it
  for (const m of all) for (const a of m.assets) if (a.sheet) added.set(a.to, (added.get(a.to) ?? 0) + 1)
  for (const m of all) {
    mangle(m)
    for (const { module, tokens } of m.dynamic) {
      const files = [...new Set(needs.get(module).map(n => n.chunk))]
      tokens[0][1] = `J.i(${JSON.stringify(files)},${module.n})`
      for (const t of tokens.slice(1)) t[0] = 'x'
    }
    for (const a of m.assets) {
      // A stylesheet that only this lazy module adds comes in its chunk, unless it names other files.
      const css = a.sheet && !eager.has(m) && added.get(a.to) === 1 && readFileSync(a.to, 'utf8')
      a.token[1] = JSON.stringify(css && !css.includes('url(') ? `data:text/css,${squeezeCss(css).replace(/[%#]/g, encodeURIComponent)}` : asset(a.to, a.sheet))
    }
    m.body = squeeze(m.tokens)
    m.async = waits(m, m.body)
  }
  for (const m of all) if (!eager.has(m)) m.async ||= evaluation(m, eager).some(d => d.async)
  for (const m of startup) if (m.async && m !== main) throw new Error(`${relative(root, m.file)} waits at its top level, so main.js can't import it`)
  const pairs = list => `{${list.map(([a, b]) => a === b ? a : `${a}:${b}`).join()}}`
  const exports = m => pairs(m.exports.map(([name, local]) => [name, m.name(local)]))
  const imports = m => m.imports.map(i => `const${i.json ? ` ${m.name(i.json)}=${i.text}` : `${i.namespace ? ` ${m.name(i.namespace)}` : pairs(i.names.map(([name, local]) => [name, m.name(local)]))}=${
    eager.has(m) ? `E[${i.module.n}]` : `${i.module.async ? 'await ' : ''}J(${i.module.n})`}`};`).join('')

  put('index.js', RUNTIME + startup.map(m => m === main
    ? `{${imports(m)}\n${m.body}\n}`
    : `E[${m.n}]=(()=>{${imports(m)}\n${m.body}\nreturn${exports(m)}})()\n`).join(''))
  for (const [, list] of chunks) put(list[0].chunk, `export default{${list.map(m =>
    `${m.n}:(${m.async ? 'async function(J)' : 'J=>'}{${imports(m)}\n${m.body}\nreturn${exports(m)}})`).join(',\n')}}\n`)
  for (const f of readdirSync(dist, { recursive: true })) if (!written.has(join(dist, f)) && statSync(join(dist, f)).isFile()) rmSync(join(dist, f))
  const kb = n => `${(n / 1024).toFixed(1)} KB`
  const open = ['index.html', 'index.js', 'index.css'].reduce((s, f) => s + statSync(join(dist, f)).size, 0)
  console.log(`dist: ${startup.length} modules to open (${kb(open)} with the page and its CSS), ${all.length - startup.length} more in ${chunks.size} chunks, in ${Math.round(performance.now() - started)} ms`)
}

const stop = what => { console.error(`build: ${what}`); process.exit(1) }
const run = (command, args, cwd) => {
  const r = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) stop(`${basename(command)} ${args.join(' ')} failed`)
}

const { NOOK_ID, NOOK_NAME } = process.env
const pack = !process.argv.includes('--no-pack') && !process.argv.includes('--dist')
// One without the other would name nook's own settings as a test build, or install a test build over nook.
if (NOOK_NAME ? !NOOK_ID : NOOK_ID && pack) stop('NOOK_ID and NOOK_NAME name a test build together: set both')
try {
  bundle()
} catch (e) {
  if (e.constructor !== Error) throw e // the build's own mistakes with a stack, the source's by file and line
  stop(e.message)
}
if (!process.argv.includes('--dist')) {
  const native = join(root, 'native')
  // Cargo reads a relative CARGO_TARGET_DIR from native, where it runs, so it gets the whole path.
  if (process.env.CARGO_TARGET_DIR) process.env.CARGO_TARGET_DIR = resolve(process.env.CARGO_TARGET_DIR)
  const release = join(process.env.CARGO_TARGET_DIR ?? join(native, 'target'), 'release')
  const exe = windows ? 'nook.exe' : 'nook'
  run('cargo', ['build', '--release'], native)
  // The stage is a nook that runs where it is: the exe and what ships beside it, and nothing else.
  const stage = join(release, 'stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  copyFileSync(join(release, exe), join(stage, exe))
  for (const [from, to] of PAYLOAD) cpSync(join(root, from), join(stage, to), { recursive: true })
  console.log(`${join(stage, exe)} runs with its payload beside it`)
  const cargo = readFileSync(join(native, 'Cargo.toml'), 'utf8')
  const [version, about, home] = ['version', 'description', 'repository'].map(k => new RegExp(`^${k} = "(.+)"`, 'm').exec(cargo)[1])
  const name = NOOK_NAME || 'nook'
  if (pack && windows) {
    run('cargo', ['build', '--release'], join(native, 'setup'))
    const out = join(release, `${name}_${version}_x64-setup.exe`)
    run(join(process.env.CARGO_TARGET_DIR ?? join(native, 'setup', 'target'), 'release', 'setup.exe'), ['--pack', stage, out], root)
    console.log(out)
  } else if (pack) {
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
    const out = join(release, `${name}_${version}_${arch}.deb`)
    writeFileSync(out, deb(stage, { name, version, arch, about, home }))
    console.log(out)
  }
}

/** A .deb of the stage: nook and its payload in /usr/lib/<name>, a link in /usr/bin, a menu entry, and its icons. */
function deb(stage, { name, version, arch, about, home }) {
  const time = Math.floor(Date.now() / 1000)
  const files = [] // [path, bytes, or null for a folder, mode, link]
  const add = (path, data, mode = data ? 0o644 : 0o755, link) => {
    for (let d = dirname(path); d !== '.' && !files.some(f => f[0] === `${d}/`); d = dirname(d)) files.push([`${d}/`, null, 0o755])
    files.push([data || link ? path : `${path}/`, data, mode, link])
  }
  for (const f of readdirSync(stage, { recursive: true }).map(f => f.replaceAll('\\', '/')).sort()) {
    const from = join(stage, f)
    add(`./usr/lib/${name}/${f}`, statSync(from).isFile() ? readFileSync(from) : null, f === 'nook' ? 0o755 : undefined)
  }
  add(`./usr/bin/${name}`, null, 0o777, `../lib/${name}/nook`)
  add(`./usr/share/applications/${name}.desktop`, Buffer.from(`[Desktop Entry]\nType=Application\nName=${name}\nComment=${about}\n` +
    `Exec=${name} %f\nIcon=${name}\nTerminal=false\nCategories=Development;\nStartupWMClass=${name}\n`))
  // The icon at each size icon.ico holds as a PNG (a 16-byte entry per size after a 6-byte header), and icon.svg at any other.
  const ico = readFileSync(join(root, 'native', 'icons', 'icon.ico'))
  for (let e = 6; e < 6 + 16 * ico.readUInt16LE(4); e += 16) {
    const [n, at] = [ico[e] || 256, ico.readUInt32LE(e + 12)]
    const png = ico.subarray(at, at + ico.readUInt32LE(e + 8))
    if (png.readUInt32BE(0) === 0x89504e47) add(`./usr/share/icons/hicolor/${n}x${n}/apps/${name}.png`, png)
  }
  add(`./usr/share/icons/hicolor/scalable/apps/${name}.svg`, readFileSync(join(root, 'icon.svg')))
  files.sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const size = files.reduce((n, f) => n + (f[1]?.length ?? 0), 0)
  const control = `Package: ${name}\nVersion: ${version}\nArchitecture: ${arch}\nMaintainer: ${name}\n` +
    `Installed-Size: ${Math.ceil(size / 1024)}\nDepends: libwebkit2gtk-4.1-0, libgtk-3-0, unzip\nRecommends: libpoppler-glib8\nSection: devel\n` +
    `Priority: optional\nHomepage: ${home}\nDescription: ${about}\n`
  // A ustar archive, gzipped: a 512-byte header per entry, its bytes padded to 512, and two empty blocks.
  const tar = entries => gzipSync(Buffer.concat([...entries.flatMap(([path, data, mode, link]) => {
    const h = Buffer.alloc(512)
    const octal = (n, at, width) => h.write(n.toString(8).padStart(width - 1, '0'), at)
    h.write(path, 0)
    octal(mode, 100, 8)
    octal(0, 108, 8)
    octal(0, 116, 8)
    octal(data?.length ?? 0, 124, 12)
    octal(time, 136, 12)
    h.write(link ? '2' : data ? '0' : '5', 156)
    if (link) h.write(link, 157)
    h.write('ustar\x0000root', 257)
    h.write('root', 297)
    h.write('        ', 148)
    octal(h.reduce((s, b) => s + b, 0), 148, 7)
    h[154] = 0
    return data ? [h, data, Buffer.alloc(-data.length & 511)] : [h]
  }), Buffer.alloc(1024)]))
  // An ar archive of debian-binary, control.tar.gz, and data.tar.gz, in that order.
  return Buffer.concat([Buffer.from('!<arch>\n'), ...[
    ['debian-binary', Buffer.from('2.0\n')],
    ['control.tar.gz', tar([['./', null, 0o755], ['./control', Buffer.from(control), 0o644]])],
    ['data.tar.gz', tar([['./', null, 0o755], ...files])],
  ].flatMap(([member, data]) => [Buffer.from(`${member.padEnd(16)}${String(time).padEnd(12)}0     0     100644  ${String(data.length).padEnd(10)}\`\n`),
    data, Buffer.alloc(data.length & 1, '\n')])])
}
