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
      const view = follow(was.view, report, watched(tab))
      const changed = texts[i] !== was.text || !was.view || view.mark !== was.view.mark || view.attention
      seen.set(tab, { view, text: texts[i] ?? was.text, report })
      if (changed) onChange(tab, view, report)
    })
  }
  const timer = setInterval(() => poll().catch(() => {}), 1000)
  return {
    /** Looks again now, as when the user switches tabs or focuses the window. */
    poll: () => poll().catch(() => {}),
    view: tab => seen.get(tab)?.view,
    report: tab => seen.get(tab)?.report,
    stop: () => clearInterval(timer),
  }
}
