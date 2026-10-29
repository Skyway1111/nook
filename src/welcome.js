// nook's welcome, on its first run only: pick a look, a wallpaper, and four things worth knowing. Every
// choice applies at once and stays changeable in Settings, so the welcome only ever closes.
import { el } from './ui.js'

const TIPS = [
  ['Ctrl+V', 'pastes a screenshot or copied files into Claude'],
  ['Ctrl+Shift+P', 'sends a quick prompt, such as reviewing your changes'],
  ['Drag', 'a file from the browser into Claude to hand it its path'],
  ['Ctrl+Shift+S', 'shows every session, across folders'],
]

/** Shows the welcome over `pane`. `themes` is the settings drawer's; `wallpapers` opens the wallpaper picker. */
export async function showWelcome(pane, { themes, wallpapers, onClose }) {
  const box = el('div', { id: 'welcome', role: 'dialog', ariaLabel: 'Welcome to nook' })
  const close = () => { box.remove(); removeEventListener('keydown', key, true); onClose() }
  const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } }

  const looks = el('div', { className: 'themes' })
  async function showLooks() {
    const cards = (await themes.list()).map(([name, src]) => {
      const card = el('button', { className: 'theme', title: name ?? "nook's own", onclick: () => themes.use(name).then(() => mark(name)) })
      card.dataset.name = name ?? ''
      const img = el('img', { src, alt: '' })
      img.onerror = () => img.replaceWith(el('div', { className: 'blank' }))
      card.append(img, el('span', { textContent: name ? themes.label(name) : 'nook' }))
      return card
    })
    const paint = el('button', { className: 'theme add', title: "A theme in a picture's own colors", onclick: themes.fromPicture })
    paint.innerHTML = '<i class="icon">&#xEB9F;</i><span>From a picture…</span>'
    looks.replaceChildren(...cards, paint)
    mark(themes.active())
  }
  const mark = name => { for (const c of looks.children) c.classList.toggle('active', c.dataset.name === (name ?? '')) }

  const tips = el('dl')
  for (const [keys, what] of TIPS) tips.append(el('dt', { textContent: keys }), el('dd', { textContent: what }))

  const wallpaper = el('button', { className: 'pill', onclick: () => { close(); wallpapers() } })
  wallpaper.innerHTML = '<i class="icon">&#xE771;</i>Choose a wallpaper'
  const start = el('button', { className: 'pill primary', textContent: 'Start', onclick: close })

  box.append(
    el('h1', { textContent: 'Welcome to nook' }),
    el('p', { textContent: 'Claude Code, with a file browser, an editor, git, and a look you choose. Everything here stays changeable under the gear.' }),
    el('h2', { textContent: 'Pick a look' }),
    looks,
    el('h2', { textContent: 'Worth knowing' }),
    tips,
    el('div', { className: 'actions' }),
  )
  box.lastChild.append(wallpaper, start)
  pane.append(box)
  addEventListener('keydown', key, true)
  themes.watch(showLooks) // a theme made from a picture joins the list once it's installed
  await showLooks()
  start.focus()
}
