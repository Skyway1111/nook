// The settings drawer: themes, the knobs, the user's theme.css, settings.json's options, and GitHub sign-in.
// nook's defaults in theme.css apply first, then the installed theme in use, then the user's theme.css.
// Each knob edits its line in the CSS box, so the file stays the one home for the user's CSS, and the box saves it.
import { invoke, convertFileSrc } from './host.js'
import { startViewer } from './viewer.js'
import { $, el, openPicker } from './ui.js'
import { startThemes } from './themes.js'
import { path as paths } from './paths.js'

const drawer = $('settings')
const pack = $('pack') // the installed theme in use, just before...
const style = $('theme') // ...the user's CSS, last in <body>, so both win ties with every bundled sheet
const root = getComputedStyle(document.documentElement)
const computed = name => root.getPropertyValue(name).trim()

const declaration = name => new RegExp(String.raw`(?<=^|[{;])[ \t]*${name}\s*:[^;}]*;?[ \t]*\n?`, 'gm')

/** `css` with its last `name` declaration set to `value`, or one added to its first :root rule. A null value removes it. */
function setVar(css, name, value) {
  const line = value == null ? '' : `  ${name}: ${value};\n`
  const found = [...css.matchAll(declaration(name))].at(-1)
  if (found) return css.slice(0, found.index) + line + css.slice(found.index + found[0].length)
  if (value == null) return css
  const rule = /:root\s*\{[^}]*/.exec(css)
  if (!rule) return `${css.trimEnd()}\n\n:root {\n${line}}\n`
  const at = rule.index + rule[0].length
  return css.slice(0, at) + line + css.slice(at)
}

/** `css` with each url() of a file on disk made loadable: a relative path names a file in `dir`, beside
 * theme.css, so a theme's pictures and fonts travel with it. `stamp` changes the URL when one of them
 * changes, so the webview loads it again. */
const files = (css, dir, stamp) => css.replace(/url\(\s*(["']?)(?!(?:https?|data|blob):|#)([^"')]+)\1\s*\)/gi,
  (_, q, path) => `url("${convertFileSrc(paths.isAbsolute(path) ? path : paths.join(dir, path))}?v=${stamp}")`)

const family = stack => stack.split(',')[0].trim().replace(/^["']|["']$/g, '')
const stack = (name, mono) => `"${name.replaceAll('"', '')}", ${mono ? 'monospace' : 'system-ui, sans-serif'}`

// Installed font families, listed once the first picker asks: queryLocalFonts needs that click.
let fonts
async function installed() {
  const faces = (await globalThis.queryLocalFonts?.().catch(() => [])) ?? [] // WebKitGTK has none
  const names = [...new Set(['Libron', ...faces.map(f => f.family).sort((a, b) => a.localeCompare(b))])]
  const ctx = el('canvas').getContext('2d')
  const width = text => ctx.measureText(text).width
  const mono = names.filter(n => { ctx.font = `32px "${n}", serif`; return Math.abs(width('iiiiiiii') - width('MMMMMMMM')) < .5 })
  return { all: names, mono }
}

function pickFont(e, mono, set) {
  fonts ??= installed()
  fonts.then(listed => openPicker(e, 'Find a font', q => {
    const names = mono ? listed.mono : listed.all
    const typed = q && !names.some(n => n.toLowerCase() === q.toLowerCase())
    return [
      ...(typed ? [[`Use “${q}”`, '', () => set(stack(q, mono))]] : []),
      ...names.filter(n => n.toLowerCase().includes(q.toLowerCase())).map(n => [n, '', () => set(stack(n, mono)), `"${n}"`]),
    ]
  }))
}

// A control takes `set`, which writes a new value, and returns its element and a function that shows a value.
function hue(set) {
  const input = el('input', { type: 'range', min: 0, max: 359, className: 'hue', oninput: () => set(input.value) })
  return [input, v => { input.value = v }]
}
// A color's value as #rrggbb for <input type="color">. Of a layered background, its last layer: the color under the rest.
let pixel
function hex(value) {
  let depth = 0, at = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++
    else if (value[i] === ')') depth--
    else if (value[i] === ',' && !depth) at = i + 1
  }
  pixel ??= el('canvas', { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })
  pixel.fillStyle = '#000'
  pixel.fillStyle = value.slice(at).trim() // a value the canvas can't read leaves black
  pixel.fillRect(0, 0, 1, 1)
  return '#' + [...pixel.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(c => c.toString(16).padStart(2, '0')).join('')
}
function color(set) {
  const input = el('input', { type: 'color', className: 'swatch', oninput: () => set(input.value) })
  return [input, v => { input.value = hex(v) }]
}
const slider = (min, max, step) => set => {
  const input = el('input', { type: 'range', min, max, step, className: 'strength', oninput: () => set(input.value) })
  return [input, v => { input.value = v }]
}
const font = mono => set => {
  const button = el('button', { className: 'field', onclick: e => pickFont(e, mono, set) })
  return [button, v => { button.textContent = family(v); button.style.fontFamily = v }]
}
function size(set) {
  const input = el('input', { type: 'number', min: 8, max: 32, className: 'field', onchange: () => input.value && set(`${input.value}px`) })
  return [input, v => { input.value = parseFloat(v) }]
}
const KNOBS = [
  ['--h', 'Hue', hue],
  ['--accent', 'Accent', color],
  ['--term-bg', 'Terminal', color],
  ['--wallpaper-opacity', 'Wallpaper', slider(0, 1, .05)],
  ['--wallpaper-speed', 'Wallpaper speed', slider(.25, 3, .25)],
  ['--font-ui', 'Interface font', font(false)],
  ['--ui-font-size', 'Interface size', size],
  ['--font-term', 'Terminal font', font(true)],
  ['--term-font-size', 'Terminal size', size],
]

/** Opens the drawer's controls over `configDir`'s theme.css and `settings`, which it keeps current. */
export async function startSettings({ configDir, settings, home, onRestyle, onClose, showFolder }) {
  const path = paths.join(configDir, 'theme.css')
  let theme = {} // `read_theme`'s: the user's CSS, the installed theme in use, and their stamp
  let shown = '' // ...as it was last applied
  let box // theme.css in an editor, once the drawer first opens. From then on it applies every change.
  const save = patch => invoke('update_settings', { patch }).then(() => Object.assign(settings, patch))

  const knobs = KNOBS.map(([name, label, control]) => {
    const [input, show] = control(value => box.edit(text => setVar(text, name, value)))
    const reset = el('button', { className: 'icon reset', title: "Back to nook's default", innerHTML: '&#xE777;' })
    reset.onclick = () => box.edit(text => setVar(text, name, null))
    const row = el('div', { className: 'knob' })
    row.append(el('span', { textContent: label }), input, reset)
    $('settings-knobs').append(row)
    return () => {
      if (document.activeElement !== input) show(computed(name))
      row.classList.toggle('set', declaration(name).test(theme.css ?? ''))
    }
  })

  function apply(next) {
    theme = next
    const key = JSON.stringify(theme)
    if (key === shown) return
    shown = key
    previewing = undefined
    pack.textContent = theme.pack == null ? '' : files(theme.pack, paths.join(configDir, 'themes', theme.name), theme.stamp)
    style.textContent = files(theme.css ?? '', configDir, theme.stamp)
    onRestyle()
    for (const show of knobs) show()
    themes.mark(theme.pack == null ? null : theme.name)
  }
  // An edit in any app reaches every window within a second: to theme.css, to the theme in use, to a
  // picture or font either names, or a pick of another theme. Once the editor holds theme.css, it reads it.
  let firstRun = false
  async function reread() {
    const { first, ...read } = await invoke('read_theme')
    firstRun ||= first
    apply({ ...read, css: (box ? null : read.css) ?? theme.css })
    box?.refresh()
  }
  // A theme under the pointer shows in place of the one in use, over the user's own CSS as a pick would,
  // until the pointer leaves. undefined puts the theme in use back.
  let previewing
  async function preview(name) {
    if (name === previewing) return
    previewing = name
    const dir = name && paths.join(configDir, 'themes', name)
    const css = name ? await invoke('read_text', { path: paths.join(dir, 'theme.css') }).catch(() => null) : ''
    if (previewing !== name || css == null) return
    pack.textContent = name === undefined
      ? (theme.pack == null ? '' : files(theme.pack, paths.join(configDir, 'themes', theme.name), theme.stamp))
      : css && files(css, dir, theme.stamp)
    onRestyle()
  }
  const themes = startThemes({ configDir, home, settings, save, reread, showTheme: preview })
  await reread()
  setInterval(reread, 1000)

  $('settings-defaults').ontoggle = async () => {
    const pre = $('settings-defaults').querySelector('pre')
    if (pre.firstChild) return
    const [{ highlight }, defaults] = await Promise.all([import('./highlight.js'), fetch(new URL('./theme.css', import.meta.url)).then(r => r.text())])
    pre.replaceChildren(highlight(defaults, 'css') ?? defaults)
  }

  const command = $('settings-command')
  const gpu = $('settings-gpu')
  async function showSettings() {
    Object.assign(settings, await invoke('settings'))
    command.value = settings.command.join('\n')
    gpu.checked = settings.gpu
  }
  command.onchange = () => {
    const args = command.value.split('\n').map(a => a.trim()).filter(Boolean)
    args.length ? save({ command: args }) : showSettings()
  }
  gpu.onchange = () => save({ gpu: gpu.checked })

  // GitHub sign-in belongs to Git Credential Manager, which ships with Git for Windows. It keeps the
  // token and hands it to git for push and fetch; nook only ever sees the account name.
  const github = args => invoke('git', { dir: home, args: ['credential-manager', 'github', ...args] })
  async function showGithub() {
    const out = await github(['list']).catch(() => '')
    const accounts = out.split('\n').map(a => a.trim()).filter(Boolean)
    const row = (text, label, action) => {
      const div = el('div', { className: 'account' })
      div.append(el('span', { textContent: text }), el('button', { className: 'pill', textContent: label, onclick: () => action().then(showGithub) }))
      return div
    }
    $('settings-github').replaceChildren(...(accounts.length
      ? accounts.map(a => row(a, 'Sign out', () => github(['logout', a])))
      : [row('Not signed in', 'Sign in', () => github(['login']))]))
  }

  /** Sets variable `name` to `value` in the user's theme.css: through the editor once it holds the file, and
   * otherwise straight to disk, only over the text just read, so an edit made meanwhile stands. */
  async function setVariable(name, value) {
    if (box) return box.edit(text => setVar(text, name, value))
    const text = await invoke('read_text', { path }).catch(() => '') // none yet
    if (!(await invoke('write_text', { path, text: setVar(text, name, value), base: text }))) throw new Error('theme.css changed meanwhile. Try again.')
    await reread()
  }

  function open() {
    drawer.hidden = false
    box ??= startViewer($('settings-css'), path, { openFile: () => {}, onDirty: () => {}, onText: css => apply({ ...theme, css }), autosave: true })
    box.refresh()
    themes.show()
    showSettings()
    showGithub()
  }
  function close() {
    themes.unpeek()
    drawer.hidden = true
    onClose()
  }
  $('settings-close').onclick = close
  $('settings-folder').onclick = showFolder
  drawer.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented) close() })

  return {
    toggle: () => (drawer.hidden ? open() : close()),
    /** Installs the theme in a folder or .zip, uses it, and shows it in the drawer. */
    installTheme: path => { if (drawer.hidden) open(); return themes.install(path) },
    setVariable,
    /** Whether this launch is nook's first, which seeded theme.css. */
    firstRun,
    themes,
  }
}
