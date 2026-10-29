// The sessions dashboard: every Claude tab at a glance, over the pane. Each card shows what its session is
// doing and since when, the prompt it's on, its model and context, and the files Claude wrote; a click or
// Enter opens that tab. It draws only while open, and then redraws when a report changes and once a second
// for the clocks, so a closed dashboard costs nothing.
import { el } from './ui.js'
import { ago, modelName, summary } from './sessions.js'

const WORDS = { working: 'Working', waiting: 'Waiting on you', done: 'Done', '': 'Idle' }

/** `list()` gives `[{ tab, view, report }]` for every Claude tab, `open(tab)` shows one, and `newSession()`
 * starts another. `button` toggles the dashboard; `onClose` hears it close. */
export function startDashboard(pane, { button, list, open, newSession, onClose }) {
  let box = null
  let timer = 0
  let at = 0 // the card the arrow keys are on
  const outside = e => { if (!box?.contains(e.target) && !button?.contains(e.target)) close() }

  function card({ tab, view, report }, i) {
    const mark = view?.mark ?? ''
    const since = report.since ? ` · ${ago(Date.now() - report.since)}` : ''
    const c = el('button', { className: `session${i === at ? ' at' : ''}` })
    c.dataset.mark = mark
    c.innerHTML = '<header><b class="mark"></b><span class="state"></span><span class="where"></span></header>' +
      '<p class="prompt"></p><p class="doing"></p><footer></footer>'
    c.querySelector('.state').textContent = WORDS[mark] + since
    c.querySelector('.where').textContent = tab.name
    c.querySelector('.where').title = tab.path
    c.querySelector('.prompt').textContent = report.prompt ? `“${report.prompt}”` : 'No prompt yet'
    c.querySelector('.doing').textContent = mark === 'working' || mark === 'waiting' ? report.activity ?? '' : ''
    const files = report.touched?.length ?? 0
    const facts = [
      modelName(report.model),
      report.context != null && `${Math.round(report.context * 100)}% context`,
      report.agents && `${report.agents} subagent${report.agents > 1 ? 's' : ''}`,
      files && `${files} file${files > 1 ? 's' : ''} changed`,
      report.turns && `${report.turns} turn${report.turns > 1 ? 's' : ''}`,
    ].filter(Boolean)
    c.querySelector('footer').textContent = facts.join(' · ')
    c.title = report.touched?.length ? report.touched.slice(-12).join('\n') : tab.path
    c.onclick = () => { close(); open(tab) }
    return c
  }

  function render() {
    if (!box) return
    const sessions = list()
    at = Math.min(at, Math.max(0, sessions.length - 1))
    box.querySelector('header .count').textContent = summary(sessions.map(s => s.view?.mark ?? ''))
    box.querySelector('.cards').replaceChildren(...sessions.map(card))
  }

  function show() {
    box = pane.appendChild(el('div', { className: 'sessions', tabIndex: -1 }))
    box.innerHTML = '<header><b>Sessions</b><span class="count"></span><button class="new"><i class="icon">&#xE710;</i>New session</button></header><div class="cards"></div>'
    box.querySelector('.new').onclick = () => { close(); newSession() }
    box.onkeydown = e => {
      const n = list().length
      if (e.key === 'Escape') close()
      else if (e.key === 'Enter') box.querySelectorAll('.session')[at]?.click()
      else if (/^Arrow(Right|Down)$/.test(e.key)) at = (at + 1) % n
      else if (/^Arrow(Left|Up)$/.test(e.key)) at = (at + n - 1) % n
      else return
      e.preventDefault()
      render()
    }
    button?.classList.add('on')
    render()
    timer = setInterval(render, 1000) // the clocks
    addEventListener('pointerdown', outside, true)
    box.focus()
  }

  function close() {
    if (!box) return
    clearInterval(timer)
    removeEventListener('pointerdown', outside, true)
    box.remove()
    box = null
    button?.classList.remove('on')
    onClose?.()
  }

  if (button) button.onclick = () => (box ? close() : show())
  addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyS') {
      e.preventDefault()
      box ? close() : show()
    }
  })

  return {
    /** Draws again, when a session's report changed. */
    refresh: render,
    close,
    get open() { return !!box },
  }
}
