// Ways to start a Claude session beyond the + button: in a new git worktree, continuing the folder's last
// session, or resuming one of its saved sessions. Each runs settings.json's command with Claude's own flags,
// added by `claudeWith`, which is pure so `launch.test.js` checks it under `npm test`.

/** Claude's flags take only names and ids, never anything a shell would read. */
export const SAFE = /^[\w.-]+$/

/** `command` with `args` added to the `claude` it runs: after the program when the command names it as a
 * word of its own (`claude`, `powershell -Command claude`), else after the first `claude` inside a shell
 * line (`bash -lc "claude; exec bash -l"`), else at the end. */
export function claudeWith(command, args) {
  if (!args.length) return command
  if (!args.every(a => SAFE.test(a))) throw new Error(`Not a name Claude takes: ${args.find(a => !SAFE.test(a))}`)
  const word = command.findIndex(a => /(^|[\\/])claude(\.exe|\.cmd)?$/i.test(a))
  if (word >= 0) return [...command.slice(0, word + 1), ...args, ...command.slice(word + 1)]
  const line = command.findIndex((a, i) => i > 0 && /(^|[\s;&|(])claude(?=$|[\s;&|)])/.test(a))
  if (line >= 0) {
    return command.map((a, i) => (i === line ? a.replace(/(^|[\s;&|(])claude(?=$|[\s;&|)])/, `$1claude ${args.join(' ')}`) : a))
  }
  return [...command, ...args]
}

/** A worktree name for now: nook-1029-0634, the month, day, hour and minute. */
export function worktreeName(date = new Date()) {
  const two = n => String(n).padStart(2, '0')
  return `nook-${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`
}

/** Names for `n` worktrees started together at `date`, one per session: nook-1029-185007-1, -2, and on. The
 * seconds keep two starts in the same minute apart, since Claude reuses a worktree that has the name. */
export function fanNames(n, date = new Date()) {
  const base = `${worktreeName(date)}${String(date.getSeconds()).padStart(2, '0')}`
  return Array.from({ length: n }, (_, i) => `${base}-${i + 1}`)
}

/** How long ago `ms` was, in a word or two: "just now", "5m ago", "3h ago", "2d ago". */
export function since(ms, now = Date.now()) {
  const m = Math.floor((now - ms) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}
