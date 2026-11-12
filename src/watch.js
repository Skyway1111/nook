// The one door to watch.rs, which says when something on disk changed, so no view polls for it.
import { invoke, listen } from './host.js'

const heard = new Map() // 'kind:path' → the functions that hear of it
let posting = false
let missed = new Set() // what changed while the window was hidden

/** Tells the host what's watched now, once for every watch started or stopped together. */
function post() {
  if (posting) return
  posting = true
  queueMicrotask(() => {
    posting = false
    invoke('watch', { set: [...heard.keys()] })
  })
}
const tell = names => { for (const name of names) for (const fn of [...(heard.get(name) ?? [])]) fn() }
// A hidden window paints nothing, so what changed meanwhile is told once it shows.
listen('changed', names => (document.hidden ? names.forEach(n => missed.add(n)) : tell(names)))
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  const names = missed
  missed = new Set()
  tell(names)
})

/** Calls `fn()` when `path` changes: as a `file`, when it's written, made, or gone; as a `dir`, when an entry in the
 * folder is added, removed, or renamed; as a `tree`, when anything under the folder is. Returns what stops it. */
export function watch(path, kind, fn) {
  const name = `${kind}:${path}`
  if (!heard.has(name)) {
    heard.set(name, new Set())
    post()
  }
  const fns = heard.get(name)
  fns.add(fn)
  return () => {
    if (!fns.delete(fn) || fns.size || heard.get(name) !== fns) return
    heard.delete(name)
    post()
  }
}

/** `fn` for a watch whose answer costs something, as a `git status` does: `paced(fn)()` runs it 50 ms on, never
 * twice at once, and after a run that took t, not for 20 t more, 2 s at most. A build that floods a tree with
 * changes then costs a twentieth of a core, and a slow answer is asked for every 2 s at most. */
export function paced(fn) {
  let timer = null
  let running = false
  let again = false
  let free = 0 // when the next run may start
  async function run() {
    timer = null
    running = true
    const began = performance.now()
    try {
      await fn()
    } finally {
      running = false
      free = performance.now() + Math.min(2000, 20 * (performance.now() - began))
      if (again) call()
    }
  }
  function call() {
    again = running
    if (!running) timer ??= setTimeout(run, Math.max(50, free - performance.now()))
  }
  return call
}
