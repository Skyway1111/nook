// What each Claude tab's session is doing, from what nook's mod reports: the dot on its tab, the count in
// the window's title, and when to ask for the user's attention. `follow` is pure, so `sessions.test.js`
// checks it without a window; `watchSessions` polls every tab's report in one IPC call a second.

/** A session's mark on its tab: working, waiting (on the user), done (finished while the user looked
 * elsewhere), or '' while it idles with nothing new. */
export const MARKS = ['working', 'waiting', 'done']

/** The next view of one session, from its last view and its mod's newest report. `watched` is whether
 * the user is looking at it now: its tab shows in a focused window. A view: `{ mark, turns, attention }`,
 * where `attention` is true once, when the session starts waiting or finishes unwatched. */
export function follow(view, report = {}, watched = false) {
  const status = report.status ?? 'idle'
  // The first report sets where the session stands: nothing in it is news.
  if (!view) return { mark: status === 'idle' ? '' : status, turns: report.turns ?? 0, attention: false }
  const turns = report.turns ?? view.turns
  let mark
  if (status === 'working') mark = 'working'
  else if (status === 'waiting') mark = 'waiting'
  else if (watched) mark = ''
  else if (turns > view.turns || view.mark === 'working' || view.mark === 'waiting') mark = 'done'
  else mark = view.mark === 'done' ? 'done' : ''
  const attention = !watched && mark !== view.mark && (mark === 'waiting' || (mark === 'done' && view.mark !== 'done'))
  return { mark, turns, attention }
}

/** Keys that answer what Claude asks: Enter picks, Escape declines, and a digit picks that option. */
export const ANSWERS = /^(Enter|NumpadEnter|Escape|Digit[1-9]|Numpad[1-9])$/

/** The report as nook shows it. Claude's mod reports a session waiting until the tool it asked about has
 * finished, so once the user answers, the wait they answered (its `since`) reads as working. */
export const answeredReport = (report, answered) =>
  answered != null && report.status === 'waiting' && report.since === answered ? { ...report, status: 'working' } : report

/** How many sessions want the user: waiting on them, or done since they last looked. */
export const wanting = views => views.filter(v => v.mark === 'waiting' || v.mark === 'done').length

/** "2m 05s" from a span of milliseconds. */
export function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** The model's short name: claude-opus-5-5[1m] as Opus 5.5. */
export function modelName(id = '') {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

/** One line on the counts, such as "2 working · 1 waiting on you". */
export function summary(marks) {
  const n = mark => marks.filter(m => m === mark).length
  const parts = [[n('working'), 'working'], [n('waiting'), 'waiting on you'], [n('done'), 'done']].filter(([c]) => c)
  return parts.length ? parts.map(([c, w]) => `${c} ${w}`).join(' · ') : `${marks.length} idle`
}

/** Polls the reports of every tab `tabs()` lists that has a session (`tab.terminal.id`), each second.
 * `onChange(tab, view, report)` hears each tab whose view or report changed. Costs one IPC call a second
 * while any Claude tab is open, and nothing else while their reports stay the same. */
export function watchSessions({ invoke, tabs, watched, onChange }) {
  const seen = new WeakMap() // tab -> { view, text }
  async function poll() {
    const live = tabs().filter(t => t.terminal?.id != null)
    if (!live.length) return
    const texts = await invoke('pty_states', { ids: live.map(t => t.terminal.id) })
    live.forEach((tab, i) => {
      const was = seen.get(tab) ?? { view: undefined, text: null }
      let report = was.report ?? {}
      if (texts[i] && texts[i] !== was.text) {
        try {
          report = JSON.parse(texts[i])
        } catch {
          return // caught mid-write; the next poll reads it whole
        }
      }
      const answered = report.status === 'waiting' ? was.answered : undefined // a new wait is a new question
      const shown = answeredReport(report, answered)
      const view = follow(was.view, shown, watched(tab))
      const changed = texts[i] !== was.text || !was.view || view.mark !== was.view.mark || view.attention
      seen.set(tab, { view, text: texts[i] ?? was.text, report, answered })
      if (changed) onChange(tab, view, shown)
    })
  }
  const timer = setInterval(() => poll().catch(() => {}), 1000)
  return {
    /** Looks again now, as when the user switches tabs or focuses the window. */
    poll: () => poll().catch(() => {}),
    view: tab => seen.get(tab)?.view,
    report: tab => { const s = seen.get(tab); return s && answeredReport(s.report, s.answered) },
    /** The user answered what `tab`'s session waits on: that wait reads as working from now on. */
    answered(tab) {
      const s = seen.get(tab)
      if (s?.view?.mark !== 'waiting') return
      s.answered = s.report.since
      poll().catch(() => {})
    },
    stop: () => clearInterval(timer),
  }
}
