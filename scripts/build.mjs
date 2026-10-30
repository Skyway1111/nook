// nook's build: the page into dist/, then the release exe, then the installer. Node's own modules only.
//   npm run build                  dist/, nook.exe, its payload staged in target/release/stage, and the installer
//   npm run build -- --no-pack     stops once the stage is a runnable nook
//   npm run build -- --dist        stops after dist/
// NOOK_ID and NOOK_NAME, the build's identity, reach both cargo builds through the environment. On Linux the
// build stops after the stage.
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'src')
const dist = join(root, 'dist')
const windows = process.platform === 'win32'

// What ships beside nook.exe, as [from in the repo, to in the install]. A folder copies whole.
const PAYLOAD = [
  ...(windows ? [
    ['src-tauri/conpty/conpty.dll', 'conpty.dll'],
    ['src-tauri/conpty/OpenConsole.exe', 'OpenConsole.exe'],
    ['src-tauri/conpty/LICENSE', 'conpty-LICENSE.txt'],
  ] : []),
  ['src/fonts/OFL.txt', 'Libron-LICENSE.txt'],
  ['src/fonts/FluentIcons-LICENSE.txt', 'FluentIcons-LICENSE.txt'],
  ['src-tauri/mod/.claude-plugin/plugin.json', 'mod/.claude-plugin/plugin.json'],
  ['src-tauri/mod/hooks/hooks.json', 'mod/hooks/hooks.json'],
  ['src-tauri/mod/hooks/register.js', 'mod/hooks/register.js'],
  ['src-tauri/mod/types/index.d.ts', 'mod/types/index.d.ts'],
  ['src-tauri/mod/themes/nook.json', 'mod/themes/nook.json'],
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
      m.assets.push({ to: target(path), token: path, sheet: code[k - 7]?.[1] === 'sheet' && code[k - 6][1] === '(' })
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
 * its own, which V8 can let go once it has run, and main.js in a block, where it can wait. */
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
  for (const m of all) {
    for (const { module, tokens } of m.dynamic) {
      const files = [...new Set(needs.get(module).map(n => n.chunk))]
      tokens[0][1] = `J.i(${JSON.stringify(files)},${module.n})`
      for (const t of tokens.slice(1)) t[0] = 'x'
    }
    for (const a of m.assets) a.token[1] = JSON.stringify(asset(a.to, a.sheet))
    m.body = squeeze(m.tokens)
    m.async = waits(m, m.body)
  }
  for (const m of all) if (!eager.has(m)) m.async ||= evaluation(m, eager).some(d => d.async)
  for (const m of startup) if (m.async && m !== main) throw new Error(`${relative(root, m.file)} waits at its top level, so main.js can't import it`)
  const pairs = list => `{${list.map(([a, b]) => a === b ? a : `${a}:${b}`).join()}}`
  const imports = m => m.imports.map(i => `const${i.json ? ` ${i.json}=${i.text}` : `${i.namespace ? ` ${i.namespace}` : pairs(i.names)}=${
    eager.has(m) ? `E[${i.module.n}]` : `${i.module.async ? 'await ' : ''}J(${i.module.n})`}`};`).join('')

  put('index.js', RUNTIME + startup.map(m => m === main
    ? `{${imports(m)}\n${m.body}\n}`
    : `E[${m.n}]=(()=>{${imports(m)}\n${m.body}\nreturn${pairs(m.exports)}})()\n`).join(''))
  for (const [, list] of chunks) put(list[0].chunk, `export default{${list.map(m =>
    `${m.n}:(${m.async ? 'async function(J)' : 'J=>'}{${imports(m)}\n${m.body}\nreturn${pairs(m.exports)}})`).join(',\n')}}\n`)
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
const pack = windows && !process.argv.includes('--no-pack') && !process.argv.includes('--dist')
// One without the other would name nook's own settings as a test build, or install a test build over nook.
if (NOOK_NAME ? !NOOK_ID : NOOK_ID && pack) stop('NOOK_ID and NOOK_NAME name a test build together: set both')
try {
  bundle()
} catch (e) {
  if (e.constructor !== Error) throw e // the build's own mistakes with a stack, the source's by file and line
  stop(e.message)
}
if (!process.argv.includes('--dist')) {
  const tauri = join(root, 'src-tauri')
  // Cargo reads a relative CARGO_TARGET_DIR from src-tauri, where it runs, so it gets the whole path.
  if (process.env.CARGO_TARGET_DIR) process.env.CARGO_TARGET_DIR = resolve(process.env.CARGO_TARGET_DIR)
  const release = join(process.env.CARGO_TARGET_DIR ?? join(tauri, 'target'), 'release')
  const exe = windows ? 'nook.exe' : 'nook'
  run('cargo', ['build', '--release'], tauri)
  // The stage is a nook that runs where it is: the exe and what ships beside it, and nothing else.
  const stage = join(release, 'stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  copyFileSync(join(release, exe), join(stage, exe))
  for (const [from, to] of PAYLOAD) cpSync(join(root, from), join(stage, to), { recursive: true })
  console.log(`${join(stage, exe)} runs with its payload beside it`)
  if (pack) {
    run('cargo', ['build', '--release'], join(tauri, 'setup'))
    const version = /^version = "(.+)"/m.exec(readFileSync(join(tauri, 'Cargo.toml'), 'utf8'))[1]
    const out = join(release, `${NOOK_NAME || 'nook'}_${version}_x64-setup.exe`)
    run(join(process.env.CARGO_TARGET_DIR ?? join(tauri, 'setup', 'target'), 'release', 'setup.exe'), ['--pack', stage, out], root)
    console.log(out)
  }
}
