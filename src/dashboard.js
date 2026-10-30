// The sessions dashboard: every Claude tab at a glance, over the pane. Each card shows what its session is
// doing and since when, the prompt it's on, its model, how full its context is and what it has cost, and the
// files Claude wrote; a click or Enter opens that tab. From a card you can allow or deny the call a session asks
// permission for, and compact a session filling up.
// The header names the account's rate limits. It draws only while open, and then redraws when a report changes
// and once a second for the clocks, so a closed dashboard costs nothing. Its prompt box sends one prompt to
// every ticked session at once, which starts ticked when it sits between turns, queues it for each to take when
// its turn ends, or starts it in several new sessions, each in a git worktree of its own. A card for a session in a worktree says how much it changed
// there, and between turns offers to keep it: its changes staged in the main checkout.
import { el, letter } from './ui.js'
import { ago, modelName, summary, cannotSend, pickedAtFirst, asking, planLine, fill, FULL, money, limits } from './sessions.js'
import { isWorktree, changeLine } from './keep.js'

const FILES = 4 // the files a card lists
const STEPS = 12 // the most steps a plan draws
const SURE = 4000 // how long Discard waits for its second press, in ms
const WORDS = { working: 'Working', waiting: 'Waiting on you', done: 'Done', '': 'Idle' }

/** `list()` gives `[{ tab, view, report }]` for every Claude tab, `open(tab)` shows one, `newSession()`
 * starts another, `send(tab, text)` sends one a prompt, `queue(tab, text)` sends it when its turn ends, `unqueue(tab)` drops those, and `review(session)` opens all it changed. `button` toggles the dashboard; `onClose` hears
 * it close. `worktree.stat(root)` says what a worktree changed, `worktree.keep(tab, report)` stages that in its
 * main checkout, and `worktree.discard(tab, report)` ends the session and deletes its worktree. */
export function startDashboard(pane, { button, list, open, newSession, showChanges, review, send, queue, unqueue, answer, fanOut, worktree, onClose }) {
  let box = null
  let timer = 0
  let at = 0 // the card the arrow keys are on
  let ticks = new WeakMap() // the sessions you ticked or unticked; the rest go by pickedAtFirst
  let said = '', saidAt = 0 // what the dashboard last did, such as "Sent to 2 sessions", which the header says for a moment
  const picked = ({ tab, view, report }) => !cannotSend(view, report) && (ticks.get(tab) ?? pickedAtFirst(view, report))
  // What each worktree changed, by its root and the turn it's on, so a card asks git once per turn, not per draw.
  const stats = new Map()
  let discarding = null, discardingAt = 0 // the worktree a first press on Discard asked about, which a second deletes
  function changes(report) {
    const key = `${report.turns}|${report.since}`
    const known = stats.get(report.root)
    if (known?.key === key) return known.stat
    stats.set(report.root, { key, stat: null })
    worktree.stat(report.root).then(stat => {
      if (stats.get(report.root)?.key !== key) return
      stats.set(report.root, { key, stat })
      render()
    }, () => {})
    return null
  }
  const outside = e => { if (!box?.contains(e.target) && !button?.contains(e.target)) close() }

  function card({ tab, view, report }, i) {
    const mark = view?.mark ?? ''
    const since = report.since ? ` · ${ago(Date.now() - report.since)}` : ''
    const c = el('button', { className: `session${i === at ? ' at' : ''}` })
    c.dataset.mark = mark
    c.innerHTML = '<header><b class="pick" role="checkbox"></b><b class="mark"></b><span class="state"></span><span class="where"></span></header>' +
      '<i class="fill" role="meter" aria-valuemin="0" aria-valuemax="100"></i><p class="prompt"></p><p class="queue"></p><p class="plan"><span class="steps"></span><span class="words"></span></p><p class="doing"></p><p class="asks"></p><p class="answer"></p><footer></footer><p class="files"></p>'
    c.querySelector('.state').textContent = WORDS[mark] + since
    c.querySelector('.where').textContent = tab.name
    c.querySelector('.where').title = tab.path
    const pick = c.querySelector('.pick')
    const why = cannotSend(view, report)
    pick.setAttribute('aria-checked', picked({ tab, view, report }))
    pick.setAttribute('aria-disabled', !!why)
    pick.title = why ?? 'Send the prompt below to this session too (Space)'
    c.querySelector('.prompt').textContent = report.prompt ? `“${report.prompt}”` : 'No prompt yet'
    const busy = mark === 'working' || mark === 'waiting'
    // Prompts queued to go when its turn ends, the next first.
    const queued = tab.queue ?? []
    if (queued.length) {
      c.querySelector('.queue').append(
        el('span', { className: 'next', textContent: `Then “${queued[0]}”${queued.length > 1 ? ` +${queued.length - 1}` : ''}`, title: queued.map((q, k) => `${k + 1}. ${q}`).join('\n') }),
        el('span', { className: 'file unqueue', textContent: 'Clear', title: 'Drop the prompts queued for this session' }))
    }
    // Claude's plan: a step for each task, filled as they're done, and the one under way.
    const plan = report.plan
    const line = planLine(plan)
    if (line) {
      const shown = Math.min(plan.total, STEPS) // a long list draws in proportion
      const done = Math.round(plan.done / plan.total * shown)
      c.querySelector('.plan .steps').append(...Array.from({ length: shown }, (_, k) => el('i', { className: k < done ? 'done' : '' })))
      c.querySelector('.plan .words').textContent = line
      c.querySelector('.plan').title = `Claude's plan: ${plan.done} of ${plan.total} tasks done`
    }
    c.querySelector('.doing').textContent = busy ? report.activity ?? '' : ''
    // A permission prompt, answered from here: its first choice allows the call once, Escape denies it.
    const asks = asking(view, report)
    if (asks) {
      c.querySelector('.doing').hidden = true
      const run = asks.tool === 'Bash' && asks.what.replace(/^Bash · /, '')
      c.querySelector('.asks').append(
        el('span', { className: 'what', textContent: run ? `Run ${run}?` : `Allow ${asks.what}?`, title: asks.what }),
        el('span', { className: 'file act', textContent: 'Allow', title: 'Allow it this once, as choosing Yes in the tab does' }),
        el('span', { className: 'file deny', textContent: 'Deny', title: 'Deny it, as Escape does in the tab: Claude stops and waits for you' }))
    }
    // Between turns, what Claude said at the end of the last one.
    c.querySelector('.answer').textContent = busy ? '' : report.answer ?? ''
    // How full its context is, as a bar under the header that turns the waiting color from FULL on.
    const full = fill(report)
    const meter = c.querySelector('.fill')
    if (full == null) meter.hidden = true
    else {
      meter.style.setProperty('--fill', `${Math.min(full, 100)}%`)
      meter.classList.toggle('full', full >= FULL)
      meter.setAttribute('aria-valuenow', full)
      meter.title = `${(report.context.tokens ?? 0).toLocaleString()} of ${report.context.window.toLocaleString()} tokens of context`
    }
    const files = report.touched?.length ?? 0
    // A worktree's own count, against where it left the main checkout, says more than the files Claude wrote.
    const tree = !busy && worktree && isWorktree(report.root) ? changes(report) : null
    const facts = [
      modelName(report.model),
      full != null && `${full}% context`,
      money(report.cost),
      report.agents && `${report.agents} subagent${report.agents > 1 ? 's' : ''}`,
      tree ? changeLine(tree) : files && `${files} file${files > 1 ? 's' : ''} changed`,
      report.turns && `${report.turns} turn${report.turns > 1 ? 's' : ''}`,
      !busy && report.took >= 1000 && `took ${ago(report.took)}`,
    ].filter(Boolean)
    c.querySelector('footer').textContent = facts.join(' · ')
    if (tree?.files) c.querySelector('.files').append(el('span', { className: 'file keep', textContent: 'Keep', title: `Bring this worktree's changes into ${tree.main}, staged, to look over and commit there` }))
    if (tree) {
      const sure = discarding === report.root && Date.now() - discardingAt < SURE
      c.querySelector('.files').append(el('span', {
        className: `file discard${sure ? ' sure' : ''}`,
        textContent: sure ? (tree.files ? `Delete ${changeLine(tree)}?` : 'Delete it?') : 'Discard',
        title: sure ? 'Press again to delete this worktree and its branch' : 'Close this session and delete its worktree and branch, with every change in it',
      }))
    }
    // A session filling up can be compacted from here, where Enter would send the command.
    if (full >= FULL && !why && !busy) c.querySelector('.files').append(el('span', { className: 'file act', textContent: 'Compact', title: 'Run /compact: Claude sums up the conversation so far, to free its context' }))
    // Every file Claude wrote in one diff, then the newest few, each opening its own.
    if (files > 1) c.querySelector('.files').append(el('span', { className: 'file review', textContent: `Review all ${files}`, title: 'Show every change this session made, in one tab' }))
    c.querySelector('.files').append(...(report.touched ?? []).slice(-FILES).reverse().map(path => {
      const f = el('span', { className: 'file', textContent: path.split(/[\\/]/).pop(), title: `${path}\nShow Claude's changes` })
      f.dataset.path = path
      return f
    }))
    c.title = tab.path
    c.onclick = e => {
      if (e.target.closest('.pick')) return tick(i)
      if (e.target.closest('.asks .file')) return decide(tab, e.target.closest('.act') != null)
      if (e.target.closest('.act')) return compact(tab)
      if (e.target.closest('.unqueue')) return unqueue(tab)
      if (e.target.closest('.keep')) return keepIt(tab, report)
      if (e.target.closest('.discard')) return discardIt(tab, report)
      const file = e.target.closest('.file')
      close()
      if (file?.classList.contains('review')) review({ tab, view, report })
      else if (file) showChanges(file.dataset.path)
      else open(tab)
    }
    return c
  }

  function render() {
    if (!box) return
    const sessions = list()
    at = Math.min(at, Math.max(0, sessions.length - 1))
    box.querySelector('header .count').textContent = Date.now() - saidAt < 3000 ? said : summary(sessions.map(s => s.view?.mark ?? ''))
    // The account's rate limits, which every session spends from.
    const shown = limits(sessions.map(s => s.report))
    const lim = box.querySelector('header .limits')
    lim.textContent = shown.map(l => `${l.name} limit ${Math.round(l.used)}%`).join(' · ')
    lim.title = shown.map(l => `${l.name} limit ${l.used}% used${l.resetsAt ? `, resets ${new Date(l.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}`).join('\n')
    lim.classList.toggle('full', shown.some(l => l.used >= 80))
    box.querySelector('.cards').replaceChildren(...sessions.map(card))
    ready(sessions)
  }

  /** Names how many sessions the prompt goes to, on the button that sends it. */
  function ready(sessions = list()) {
    const n = sessions.filter(picked).length
    const go = box.querySelector('.send .go')
    go.textContent = n ? `Send to ${n}` : 'Send'
    go.disabled = !n || !box.querySelector('.send textarea').value.trim()
    box.querySelector('.send .then').disabled = go.disabled
    const start = box.querySelector('.send .start')
    start.textContent = `Start ${fans()} new`
    start.disabled = !box.querySelector('.send textarea').value.trim()
  }

  function tick(i) {
    const s = list()[i]
    if (!s || cannotSend(s.view, s.report)) return
    ticks.set(s.tab, !picked(s))
    render()
  }

  function say(text) {
    said = text
    saidAt = Date.now()
    render()
  }

  function decide(tab, allow) {
    answer(tab, allow)
    say(`${allow ? 'Allowed' : 'Denied'} in ${tab.name}`)
  }

  function compact(tab) {
    send(tab, '/compact')
    say(`Compacting ${tab.name}`)
  }

  function keepIt(tab, report) {
    say(`Keeping ${tab.name}`)
    worktree.keep(tab, report).then(({ main }) => {
      stats.clear()
      say(`Kept ${tab.name}: staged in ${main.split(/[\\/]/).pop()}`)
    }, () => say(`Didn't keep ${tab.name}`))
  }

  // Discard asks once on the chip itself, and deletes on a second press while it asks.
  function discardIt(tab, report) {
    if (discarding !== report.root || Date.now() - discardingAt >= SURE) {
      discarding = report.root
      discardingAt = Date.now()
      return render()
    }
    discarding = null
    say(`Discarding ${tab.name}`)
    worktree.discard(tab, report).then(() => {
      stats.delete(report.root)
      say(`Discarded ${tab.name}`)
    }, () => say(`Didn't discard ${tab.name}`))
  }

  /** How many new sessions the fan-out starts, 1 to 8. */
  const fans = () => Math.min(8, Math.max(1, Math.round(Number(box.querySelector('.send .fan input').value) || 1)))

  /** Starts new sessions on the prompt, each in a worktree of its own. */
  function fan() {
    const area = box.querySelector('.send textarea')
    const text = area.value.trim()
    if (!text) return
    const n = fans()
    close()
    fanOut(text, n)
  }

  /** Queues the prompt for every ticked session, each to go when its turn ends. */
  function queueAll() {
    const area = box.querySelector('.send textarea')
    const text = area.value.trim()
    const to = list().filter(picked)
    if (!text || !to.length) return
    for (const { tab } of to) queue(tab, text)
    area.value = ''
    area.style.height = ''
    say(`Queued for ${to.length} session${to.length > 1 ? 's' : ''}`)
  }

  function sendAll() {
    const area = box.querySelector('.send textarea')
    const text = area.value.trim()
    const to = list().filter(picked)
    if (!text || !to.length) return
    for (const { tab } of to) send(tab, text)
    area.value = ''
    area.style.height = ''
    ticks = new WeakMap() // they're working now, and start unticked the next time
    say(`Sent to ${to.length} session${to.length > 1 ? 's' : ''}`)
  }

  function show() {
    box = pane.appendChild(el('div', { className: 'sessions', tabIndex: -1 }))
    box.innerHTML = '<header><b>Sessions</b><span class="count"></span><span class="limits"></span><button class="new"><i class="icon">&#xE710;</i>New session</button></header><div class="cards"></div>' +
      '<div class="send"><textarea rows="1" spellcheck="false" placeholder="A prompt for every ticked session"></textarea><span class="fan" title="Start new sessions on this prompt, each in a git worktree of its own (Ctrl+Enter)"><input type="number" min="1" max="8" value="3" aria-label="How many"><button class="start"></button></span><button class="then" title="Send it to each ticked session when its turn ends, after any queued before it (Alt+Enter)">Queue</button><button class="go"></button></div>'
    box.querySelector('.new').onclick = () => { close(); newSession() }
    const area = box.querySelector('.send textarea')
    area.oninput = () => {
      area.style.height = ''
      area.style.height = `${Math.min(area.scrollHeight, 160)}px`
      ready()
    }
    box.querySelector('.send .go').onclick = sendAll
    box.querySelector('.send .then').onclick = queueAll
    box.querySelector('.send .start').onclick = fan
    box.querySelector('.send .fan input').oninput = () => ready()
    box.onkeydown = e => {
      const n = list().length
      if (e.target === area) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); fan() }
        else if (e.key === 'Enter' && e.altKey) { e.preventDefault(); queueAll() }
        else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAll() }
        else if (e.key === 'Escape') close()
        return
      }
      // Typing anywhere in the dashboard writes the prompt.
      if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.altKey && !e.metaKey) return area.focus()
      if (e.key === 'Escape') close()
      else if (e.key === ' ') tick(at)
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
    if (e.ctrlKey && e.shiftKey && !e.altKey && letter(e) === 's') {
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
