// The DOM helpers every view uses, and the floating UI: context menu, image preview, drag ghost.
import { convertFileSrc } from './host.js'
import { path as paths } from './paths.js'

export const $ = id => document.getElementById(id)
export const el = (tag, props) => Object.assign(document.createElement(tag), props)
/** Adds the stylesheet at `url` to the page's head, after the others; resolves once it applies. */
export const sheet = url => new Promise(done => document.head.append(el('link', { rel: 'stylesheet', href: url, onload: done, onerror: done })))
/** The letter a key names as a shortcut, lowercased: the a-z the layout types, or where it types another script's
 * letter (Cyrillic, Greek), the US key's in that place. '' for any other key, such as AltGr's ć. */
export const letter = e => (/^[a-z]$/i.test(e.key) ? e.key.toLowerCase()
  : /^\p{L}$/u.test(e.key) && !/\p{sc=Latin}/u.test(e.key) && /^Key[A-Z]$/.test(e.code) ? e.code[3].toLowerCase() : '')

const menu = $('menu')
const preview = $('preview')
const previewImg = preview.querySelector('img')
const ghost = $('ghost')

/** Places a floating element near (x, y), flipped to stay inside the window. */
export function place(el, x, y) {
  const { width, height } = el.getBoundingClientRect()
  const left = x + 14 + width > innerWidth ? x - width - 14 : x + 14
  const top = y + 14 + height > innerHeight ? Math.max(4, y - height - 14) : y + 14
  el.style.translate = `${Math.max(4, left)}px ${top}px`
}

function button([label, icon, action, font = '']) {
  const b = el('button', { innerHTML: `<i class="icon">${icon}</i><span></span>`, onclick: () => { menu.hidden = true; action() } })
  b.lastChild.textContent = label
  b.lastChild.style.fontFamily = font
  return b
}

/** items: [label, icon codepoint, action, optional label font], null for a divider, or a list of items for a row of icon buttons. */
const buttons = items => items.map(item => {
  if (!item) return el('hr')
  if (!Array.isArray(item[0])) return button(item)
  const strip = el('div', { className: 'strip' })
  strip.append(...item.map(i => Object.assign(button(i), { title: i[0] })))
  return strip
})

/** Opens a menu at the point `{ clientX, clientY }`, such as the event that asked for it. */
export function openMenu({ clientX, clientY }, items) {
  menu.replaceChildren(...buttons(items))
  menu.hidden = false
  place(menu, clientX - 14, clientY - 14)
  menu.querySelector('button').focus() // so Escape closes the menu instead of reaching Claude
}

/** A menu under a filter box: `items(query)` lists what to offer for what's typed. Enter picks the first. */
export function openPicker(event, placeholder, items) {
  const input = el('input', { placeholder, spellcheck: false })
  const list = el('div')
  // It grows away from the nearer window edge, and stays on that side as the list shrinks.
  const up = event.clientY > innerHeight / 2
  const render = () => {
    list.replaceChildren(...buttons(items(input.value.trim())))
    const { width, height } = menu.getBoundingClientRect()
    const x = Math.max(4, Math.min(event.clientX - 14, innerWidth - width - 4))
    menu.style.translate = `${x}px ${up ? Math.max(4, event.clientY - height - 10) : event.clientY + 10}px`
  }
  input.oninput = render
  input.onkeydown = e => {
    if (e.key !== 'Enter') return
    e.preventDefault() // the pick may focus a terminal, which would take this Enter too
    list.querySelector('button')?.click()
  }
  menu.replaceChildren(input, list)
  menu.hidden = false
  render()
  input.focus()
}
addEventListener('pointerdown', e => { if (!menu.contains(e.target)) menu.hidden = true }, true)
addEventListener('keydown', e => { if (e.key === 'Escape') menu.hidden = true })
addEventListener('blur', () => { menu.hidden = true })

let previewing = null
export function showPreview(path, x, y) {
  previewing = path
  previewImg.onload = () => {
    if (previewing !== path) return
    previewImg.style.width = ''
    preview.hidden = false
    // An SVG sized only by its viewBox has no width of its own, and would leave the box empty.
    if (!previewImg.offsetWidth) previewImg.style.width = '320px'
    place(preview, x, y)
  }
  previewImg.src = convertFileSrc(path)
}
export function hidePreview() {
  previewing = null
  preview.hidden = true
}

/**
 * Pointer-driven drag (HTML5 drag-and-drop is unavailable while the host handles OS file drops). `onDrop(target,
 * up)` gets the element under the pointer and the pointerup. `over(target, move)` follows the pointer while
 * dragging, and gets null once the drag ends. `label` is the ghost's text.
 */
export function dragPath(downEvent, path, onDrop, { label = paths.basename(path), over } = {}) {
  const [x0, y0] = [downEvent.clientX, downEvent.clientY]
  let dragging = false
  const move = e => {
    if (!dragging && Math.hypot(e.clientX - x0, e.clientY - y0) > 6) {
      dragging = true
      hidePreview()
      ghost.textContent = label
      ghost.hidden = false
    }
    if (!dragging) return
    ghost.style.translate = `${e.clientX + 12}px ${e.clientY + 10}px`
    over?.(document.elementFromPoint(e.clientX, e.clientY), e)
  }
  const up = e => {
    removeEventListener('pointermove', move)
    removeEventListener('pointerup', up)
    ghost.hidden = true
    if (dragging) {
      over?.(null, e)
      onDrop(document.elementFromPoint(e.clientX, e.clientY), e)
    }
  }
  addEventListener('pointermove', move)
  addEventListener('pointerup', up)
}
