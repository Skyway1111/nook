// The settings drawer's themes: a card for each installed theme, installing one from a .zip or a
// folder, and Claude's own theme, which follows nook's when the user wants. An installed theme is a
// folder in `themes` beside settings.json, and `theme.rs` reads and installs it.
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import preview from './nook.jpg'
import { $, el } from './ui.js'
import { path as paths } from './paths.js'

/** nook's Claude theme, from its mod (src-tauri/mod/themes/nook.json), as Claude's settings name it. */
const NOOK = 'custom:nook:nook'
const label = name => name.replace(/[-_]+/g, ' ').replace(/(^|\s)\p{L}/gu, c => c.toUpperCase())

/** `save` patches settings.json, and `reread` applies the theme it names. */
export function startThemes({ configDir, home, settings, save, reread, showTheme }) {
  const dir = paths.join(configDir, 'themes')
  const gallery = $('settings-themes')
  const follow = $('settings-follow')
  const note = $('settings-theme-note')
  const say = (text = '') => Object.assign(note, { hidden: !text, textContent: text })
  const picker = el('input', { type: 'file', accept: '.zip' })
  const pictures = el('input', { type: 'file', accept: 'image/*' })
  let active = null
  // A reinstalled theme's screenshot keeps its path, so its URL changes with each install, and with each
  // launch, which may follow an install in another window. Reopening the drawer reuses the loaded ones.
  const launched = Date.now()
  const installs = new Map() // name -> installs since launch

  // Resting on a card for a moment previews its theme; passing over cards on the way elsewhere doesn't.
  let hover
  const peek = name => { clearTimeout(hover); hover = setTimeout(() => showTheme(name), 150) }
  const unpeek = () => { clearTimeout(hover); showTheme(undefined) }
  function card(name, src) {
    const div = el('div', { className: 'theme', title: name ?? "nook's own", onclick: () => use(name).catch(say) })
    div.onmouseenter = () => peek(name)
    div.dataset.name = name ?? ''
    const img = el('img', { src, alt: '' })
    img.onerror = () => img.replaceWith(el('div', { className: 'blank' }))
    div.append(img, el('span', { textContent: name ? label(name) : 'nook' }))
    if (name) {
      const remove = el('button', { className: 'icon remove', title: 'Remove', innerHTML: '&#xE74D;' })
      remove.onclick = e => { e.stopPropagation(); drop(name).catch(say) }
      div.append(remove)
    }
    return div
  }

  /** Lists the installed themes, each with its screenshot.png when it has one. */
  async function show() {
    const themes = await list()
    const add = el('button', { className: 'theme add', title: 'Install a theme from a .zip', onclick: () => picker.click() })
    add.innerHTML = '<i class="icon">&#xE710;</i><span>Install…</span>'
    const paint = el('button', { className: 'theme add', title: "Make a theme from a picture, in the picture's own colors", onclick: () => pictures.click() })
    paint.innerHTML = '<i class="icon">&#xEB9F;</i><span>From a picture…</span>'
    gallery.replaceChildren(...themes.map(([name, src]) => card(name, src)), add, paint)
    gallery.onmouseleave = unpeek
    add.onmouseenter = paint.onmouseenter = unpeek
    mark(active)
    follow.checked = (await claudeTheme()) === NOOK
  }

  /** Highlights the card of the theme in use, null for nook's own. */
  function mark(name) {
    active = name
    for (const c of gallery.children) c.classList.toggle('active', c.dataset.name === (name ?? ''))
  }

  async function use(name) {
    say()
    // With the system's light and dark, a pick is the theme for whichever the system shows now.
    await save({ theme: name, ...(settings.lightDark && { [slot()]: name ?? '' }) })
    await reread()
    if (settings.claudeFollows) await setFollow(true)
    sky()
  }

  async function drop(name) {
    if (!(await invoke('recycle', { path: paths.join(dir, name) }))) return
    if (name === active) await use(null)
    const gone = Object.fromEntries(['dayTheme', 'nightTheme'].filter(k => settings[k] === name).map(k => [k, '']))
    if (Object.keys(gone).length) await save(gone)
    await show()
  }

  // The system's light and dark: each has its own theme, picked while the system shows it. "" is nook's own,
  // and a missing one leaves the theme as it is.
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const daynight = $('settings-daynight')
  const slot = () => dark.matches ? 'nightTheme' : 'dayTheme'
  const named = theme => theme ? label(theme) : 'nook'
  function sky() {
    daynight.checked = !!settings.lightDark
    const { dayTheme: day, nightTheme: night } = settings
    const note = $('settings-daynight-note')
    note.textContent = settings.lightDark && day != null && night != null
      ? `${named(day)} while the system is light, ${named(night)} while it's dark. Pick a theme to change the one for now.` : ''
    note.hidden = !note.textContent
  }
  async function matchSky() {
    const want = settings.lightDark ? settings[slot()] : null
    if (want != null && (want || null) !== (settings.theme ?? null)) await use(want || null)
  }
  dark.addEventListener('change', () => matchSky().catch(say))
  daynight.onchange = async () => {
    const patch = { lightDark: daynight.checked }
    if (daynight.checked) {
      // The theme in use is the one for now. The other side starts as Paper by day, or nook's own by night.
      patch[slot()] = settings.theme ?? ''
      const other = dark.matches ? 'dayTheme' : 'nightTheme'
      const paper = (await list()).some(([n]) => n === 'paper')
      if (settings[other] == null) patch[other] = dark.matches ? (paper ? 'paper' : null) : ''
    }
    await save(patch)
    sky()
  }
  sky()
  matchSky().catch(say)

  const watchers = new Set()
  async function installed(name) {
    installs.set(name, (installs.get(name) ?? 0) + 1)
    await show()
    await use(name)
    for (const watch of watchers) watch()
  }
  const install = path => invoke('install_theme', { path }).then(installed).catch(e => say(`nook can't install that theme: ${e}.`))
  picker.onchange = async () => {
    const file = picker.files[0]
    picker.value = ''
    if (!file) return
    // `install_theme_zip` reads the name, a NUL, then the bytes.
    const head = new TextEncoder().encode(`${file.name.replace(/\.zip$/i, '')}\0`)
    const body = new Uint8Array(head.length + file.size)
    body.set(head)
    body.set(new Uint8Array(await file.arrayBuffer()), head.length)
    await invoke('install_theme_zip', body).then(installed).catch(e => say(`nook can't install ${file.name}: ${e}.`))
  }

  // A theme from a picture: its palette, the picture, a soft copy and a card, packed as a .zip in the webview.
  pictures.onchange = async () => {
    const file = pictures.files[0]
    pictures.value = ''
    if (!file) return
    say(`Reading the colors of ${file.name}…`)
    try {
      const { fromPicture } = await import('./themer.js')
      const { name, zip } = await fromPicture(file)
      const head = new TextEncoder().encode(`${name}\0`)
      const body = new Uint8Array(head.length + zip.length)
      body.set(head)
      body.set(zip, head.length)
      await installed(await invoke('install_theme_zip', body))
      say(`Made the ${label(name)} theme from ${file.name}. Its theme.css is yours to edit, in the themes folder.`)
    } catch (e) {
      say(`nook can't make a theme from ${file.name}: ${e.message ?? e}.`)
    }
  }

  // Claude reads its theme from the `theme` key of ~/.claude/settings.json, which its /theme writes.
  // nook writes only that key, and only over the text it read, so a change Claude made meanwhile stands.
  const claudePath = paths.join(home, '.claude', 'settings.json')
  async function claudeSettings() {
    const text = await invoke('read_text', { path: claudePath }).catch(() => '') // none yet: Claude's defaults
    return [text, text.trim() ? JSON.parse(text) : {}]
  }
  const claudeTheme = () => claudeSettings().then(([, json]) => json.theme, () => undefined)

  /** Points Claude's theme at nook's, keeping the one it had, or back at that one. */
  async function setFollow(on) {
    try {
      const [text, json] = await claudeSettings()
      if (on === (json.theme === NOOK)) return
      if (on) await save({ claudeTheme: json.theme ?? null })
      const theme = on ? NOOK : (settings.claudeTheme ?? undefined) // undefined drops the key
      const next = `${JSON.stringify({ ...json, theme }, null, 2)}\n`
      if (!(await invoke('write_text', { path: claudePath, text: next, base: text }))) throw new Error('Claude changed it meanwhile')
      say(on
        ? "Claude tabs opened from now on take the theme's colors. Restart open ones to recolor them."
        : 'Claude tabs opened from now on use your own Claude theme again.')
    } catch (e) {
      say(`nook can't set Claude's theme in ${claudePath}: ${e.message ?? e}.`)
    } finally {
      follow.checked = (await claudeTheme()) === NOOK
    }
  }
  follow.onchange = () => save({ claudeFollows: follow.checked }).then(() => setFollow(follow.checked))

  /** The installed themes' names, null first for nook's own, each with its card's picture. */
  async function list() {
    const listed = await invoke('list_dir', { path: dir }).catch(() => [])
    const names = listed.filter(e => e.dir && !e.name.startsWith('.')).map(e => e.name).sort((a, b) => a.localeCompare(b))
    return [[null, preview], ...names.map(n => [n, `${convertFileSrc(paths.join(dir, n, 'screenshot.png'))}?v=${launched}.${installs.get(n) ?? 0}`])]
  }

  return { show, mark, install, list, use, label, peek, unpeek, active: () => active, fromPicture: () => pictures.click(), watch: f => watchers.add(f) }
}
