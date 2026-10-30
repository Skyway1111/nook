// Timings for bench/linux.mjs, loaded only when nook starts with NOOK_BENCH set. Each goes to stdout through
// main.rs's `bench`. A frame counts as shown once its rAF callbacks, layout, and paint have run, at the task
// after them.
import { invoke } from './host.js'

const report = (event, ms) => invoke('bench', { event, ms })
const shown = f => requestAnimationFrame(() => setTimeout(f))
const rows = () => document.querySelector('.xterm-rows')
const FLOOD_END = 'flood end' // the line bench's shell prints after a flood

export function startBench() {
  // page: ms since the page began to load, which bench/linux.mjs places on nook's own clock
  report('page', performance.now())
  // ready: the first frame that shows text in a terminal, in ms since nook started
  const seen = new MutationObserver(() => {
    if (!rows()?.textContent.trim()) return
    seen.disconnect()
    shown(() => {
      report('ready')
      watch()
    })
  })
  seen.observe(document.body, { childList: true, subtree: true, characterData: true })
  // resize: from the window's resize event to the frame that shows the new size
  addEventListener('resize', () => {
    const t = performance.now()
    shown(() => report('resize', performance.now() - t))
  })
  // F7 reports where the composer's draft is on the screen, for bench/pixels.py to watch. xterm never sees it.
  addEventListener('keydown', e => {
    if (e.key !== 'F7') return
    e.preventDefault()
    e.stopImmediatePropagation()
    const draft = document.querySelector('.composer:not([hidden]) .draft')
    const r = draft?.getBoundingClientRect()
    const px = v => Math.round(v * devicePixelRatio)
    report(r ? `draft:${px(r.left)},${px(r.top)},${px(r.width)},${px(r.height)}` : 'draft:none')
  }, true)
  // diff: F9 opens the git panel's diff of every change; ms from the press to the frame that shows its lines
  probe('F9', 'git-diff', '.view.diff:not([hidden]) :is(.add, .del)', 'diff')
  // history: F8 opens the git panel's history; ms from the press to the frame that shows its commits
  probe('F8', 'git-history', '.view.history:not([hidden]) .commit', 'history')
}

/** Clicks the button `id` when `key` is pressed, and reports `event` once something matching `shows` is drawn. */
function probe(key, id, shows, event) {
  addEventListener('keydown', e => {
    if (e.key !== key) return
    const t = performance.now()
    const drawn = new MutationObserver(() => {
      if (!document.querySelector(shows)) return
      drawn.disconnect()
      shown(() => report(event, performance.now() - t))
    })
    drawn.observe(document.getElementById('pane'), { childList: true, subtree: true })
    document.getElementById(id).click()
  }, true)
}

/** Once a terminal shows, times what the bench does to it: each key until the frame that shows its echo, each
 * wheel step until the frame that shows the scrolled rows, and a flood of output from Enter until the frame
 * that shows its last line, with the longest gaps between frames meanwhile. */
function watch() {
  let key = null // when the key whose echo hasn't shown yet went down
  const keys = [] // echo times not yet reported
  let wheel = null
  let flood = null // { t, gaps, last, done }
  // The last rows only: reading every row on each change would cost more than what it measures.
  const tail = () => {
    let text = ''
    for (let row = rows().lastElementChild, n = 0; row && n < 4; row = row.previousElementSibling, n++) text += row.textContent
    return text
  }
  // The text of the row that holds the cursor.
  const line = () => (rows().querySelector('.xterm-cursor')?.parentElement?.textContent ?? '').trimEnd()

  new MutationObserver(() => {
    if (key !== null) {
      const t = key
      key = null
      shown(() => {
        // Ten at a time, so reporting adds little to the typing CPU it runs beside.
        keys.push(Math.round(performance.now() - t))
        if (keys.length >= 10) report(`keys:${keys.splice(0).join(',')}`)
      })
    }
    if (wheel !== null) {
      const t = wheel
      wheel = null
      shown(() => report('scroll', performance.now() - t))
    }
    if (flood && !flood.done && tail().includes(FLOOD_END)) {
      flood.done = true
      shown(() => {
        const gaps = flood.gaps.sort((a, b) => a - b)
        report('flood', performance.now() - flood.t)
        report('flood-frame-p95', gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))] ?? 0)
        report('flood-frame-max', gaps.at(-1) ?? 0)
        flood = null
      })
    }
  }).observe(rows(), { childList: true, subtree: true, characterData: true })

  addEventListener('keydown', e => {
    if (!e.target.closest?.('.xterm')) return
    if (e.key === 'Enter' && line().endsWith('flood')) {
      const t = performance.now()
      flood = { t, gaps: [], last: t, done: false }
      const frame = now => {
        if (!flood) return
        flood.gaps.push(now - flood.last)
        flood.last = now
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    } else if (e.key.length === 1) key = performance.now()
  }, true)
  addEventListener('wheel', e => { if (e.target.closest?.('.xterm')) wheel = performance.now() }, true)
}
