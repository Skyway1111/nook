// Measures release builds of nook on Linux, on its own Xvfb display, once for each wallpaper given:
//   open      ms from starting nook until a frame shows its terminal's text
//   resize    ms from a window resize until the frame that shows it, over 40 resizes (median and p95)
//   key       ms from a key going down until the frame that shows its echo, over 100 keys (median and p95)
//   scroll    ms from a wheel step until the frame that shows the scrolled rows, over 40 steps
//   flood     ms from Enter until the frame that shows the last of 10,000 lines of output, and the
//             longest gaps between frames meanwhile (p95 and max)
//   idle      CPU, as % of one core, over 10 s with nothing happening
//   typing    CPU over 10 s of typing a key every 100 ms
//   memory    MB of PSS once idle, and again after the flood fills the scrollback
//   resize full  resize again, once the flood has filled the scrollback, which xterm reflows each time
//   tui       key echo, typing CPU, and resize again, in bench/tui.mjs, a stand-in for Claude's fullscreen
//             view that redraws the whole screen for each key, as Claude does
// Every launch times its open. The first --sessions launches of each build also run the rest, and each number
// is the median of those sessions, with the spread (min-max) beside it. Below the table, each build's open is
// split into the steps it passes, as ms since nook started: its window built, the page began to load, the
// script ran, and so on until the terminal's text showed.
// With two builds or more, `--bin base,new` or `--bin baseline,main,new`, launches take turns between them, so
// drift in the machine hits all alike, and the table ends with the change from each earlier build to the last.
// A change worse than its noise floor is flagged, and the exit code is 1 if any is. Comparing against a fixed
// baseline as well as main catches a slow drift that no single merge shows.
// CPU and memory count nook and its WebKit processes, not the shell in its tab. The tab runs a small bash loop
// that echoes lines, in a folder outside any repository, so neither Claude nor the git panel's poll adds
// noise. Xvfb has no GPU, so WebKit draws in software: compare numbers from the same machine, not with a
// desktop's.
// Needs Xvfb and xdotool, and a build: `npx tauri build --no-bundle`.
//   node bench/linux.mjs [--bin src-tauri/target/release/nook[,other...]] [--wallpapers none,koi] [--runs 7]
//                        [--sessions 3] [--tui off] [--json out.json]
import { spawn, execFileSync } from 'child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1] }
const bins = flag('bin', new URL('../src-tauri/target/release/nook', import.meta.url).pathname).split(',').map(b => resolve(b))
const wallpapers = flag('wallpapers', 'none').split(',')
const runs = Number(flag('runs', 7))
const sessions = Math.min(runs, Number(flag('sessions', 3)))
const [W, H] = [1280, 820] // nook's own first size
for (const bin of bins) if (!existsSync(bin)) throw new Error(`no build at ${bin}`)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const sorted = xs => [...xs].filter(Number.isFinite).sort((a, b) => a - b)
const median = xs => { const s = sorted(xs); return s.length ? s[Math.floor(s.length / 2)] : NaN }
const quantile = (xs, q) => { const s = sorted(xs); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN }

// A display of our own, so the bench never touches a desktop.
const display = `:${90 + Math.floor(Math.random() * 400)}`
const xvfb = spawn('Xvfb', [display, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
for (let i = 0; !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i++) {
  if (i > 50) throw new Error('Xvfb did not start')
  await sleep(100)
}
const env = { ...process.env, DISPLAY: display, NOOK_BENCH: '1', GDK_BACKEND: 'x11' }
delete env.WAYLAND_DISPLAY
const xdotool = (...a) => execFileSync('xdotool', a, { env, encoding: 'utf8' }).trim()

// Echoes each line it reads, as `cat` does, and answers `flood` with 10,000 lines and then `flood end`.
const SHELL = `printf 'nook bench\\n'
while IFS= read -r line; do
  if [ "$line" = flood ]; then seq -f 'flood line %g: the quick brown fox jumps over the lazy dog, again and again' 10000; echo 'flood end'
  else printf '%s\\n' "$line"; fi
done`

/** A config folder whose settings run SHELL and whose theme.css picks `wallpaper`. */
function scratch(wallpaper, command = ['bash', '-c', SHELL]) {
  const dir = mkdtempSync(join(tmpdir(), 'nook-bench-'))
  const config = join(dir, 'config', 'dev.nook.app')
  const home = join(dir, 'home')
  mkdirSync(config, { recursive: true })
  mkdirSync(home)
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ command, lastDir: home, pinned: [] }))
  writeFileSync(join(config, 'theme.css'), `:root { --wallpaper: ${wallpaper}; }\n`)
  return { dir, env: { ...env, XDG_CONFIG_HOME: join(dir, 'config'), HOME: home } }
}

/** Starts nook. `ready` resolves to ms from the spawn until its first frame with text. */
function launch(bin, run) {
  const started = performance.now()
  const child = spawn(bin, [], { env: run.env, stdio: ['ignore', 'pipe', 'ignore'] })
  const lines = []
  const waiting = []
  let buffered = ''
  child.stdout.on('data', d => {
    buffered += d
    const parts = buffered.split('\n')
    buffered = parts.pop()
    for (const line of parts) {
      const [tag, event, ms, since] = line.split(' ')
      if (tag !== 'bench') continue
      const item = { event, ms: Number(ms), since: Number(since), at: performance.now() }
      // A batch of key echo times comes as keys:<ms>,<ms>,...
      if (event.startsWith('keys:')) {
        lines.push(...event.slice(5).split(',').map(ms => ({ ...item, event: 'key', ms: Number(ms) })))
        continue
      }
      lines.push(item)
      waiting.filter(w => w.event === event).forEach(w => w.resolve(item))
    }
  })
  const next = (event, timeout = 30000, from = 0) => new Promise((resolve, reject) => {
    const have = lines.slice(from).find(l => l.event === event)
    if (have) return resolve(have)
    const w = { event, resolve }
    waiting.push(w)
    setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); reject(new Error(`no ${event} from nook within ${timeout} ms`)) }, timeout)
  })
  return {
    child,
    lines,
    next,
    since: (from, event) => lines.slice(from).filter(l => l.event === event).map(l => l.ms),
    ready: next('ready').then(l => l.at - started),
    stop: () => new Promise(r => { child.once('exit', r); child.kill('SIGTERM') }),
  }
}

/** nook and the WebKit processes under it. The tab's shell and what it runs don't count. */
function processes(root) {
  const parents = new Map()
  for (const pid of readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      parents.set(Number(pid), { ppid, comm })
    } catch {} // exited meanwhile
  }
  const ours = new Set([root])
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, { ppid }] of parents) if (!ours.has(pid) && ours.has(ppid)) ours.add(pid), (grew = true)
  }
  return [...ours].filter(pid => pid === root || /WebKit/.test(parents.get(pid)?.comm ?? ''))
}

/** CPU seconds the processes have used, user and system. */
function cpu(pids) {
  const hz = 100 // USER_HZ, the unit of utime and stime on Linux
  let ticks = 0
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      ticks += Number(fields[11]) + Number(fields[12])
    } catch {}
  }
  return ticks / hz
}

/** MB of proportional set size: each shared page split among the processes that share it. */
function pss(pids) {
  let kb = 0
  for (const pid of pids) {
    try { kb += Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))[1]) } catch {}
  }
  return kb / 1024
}

/** % of one core the processes under `root` use while `during` runs, over `ms`. */
async function load(root, ms, during = async () => sleep(ms)) {
  const pids = processes(root)
  const [c0, t0] = [cpu(pids), performance.now()]
  await during()
  return (100 * (cpu(pids) - c0)) / ((performance.now() - t0) / 1000)
}

/** Everything but open, on a nook that just opened. */
async function session(app) {
  const r = {}
  const marks = Object.fromEntries(app.lines.filter(l => l.event.startsWith('mark:')).map(l => [l.event.slice(5), l.ms]))
  const page = app.lines.find(l => l.event === 'page')
  if (page) marks.page = page.since - page.ms // when the page began to load
  marks.ready = app.lines.find(l => l.event === 'ready')?.ms
  await sleep(3000) // past the backdrops' bake and the first polls
  const win = xdotool('search', '--sync', '--onlyvisible', '--pid', String(app.child.pid)).split('\n')[0]
  xdotool('windowfocus', '--sync', win) // the wallpaper moves only while nook has focus
  r.idle = await load(app.child.pid, 10000)
  r.memory = pss(processes(app.child.pid))
  xdotool('mousemove', '--window', win, String(W / 2), String(H / 2), 'click', '1')
  await sleep(300)
  let from = app.lines.length
  r.typing = await load(app.child.pid, 10000, async () => {
    for (let k = 0; k < 100; k++) {
      xdotool('key', k % 10 === 9 ? 'Return' : 'a') // to the focused window: GTK ignores sent events
      await sleep(100)
    }
  })
  await sleep(300)
  const keys = app.since(from, 'key')
  Object.assign(r, { key: median(keys), keyP95: quantile(keys, 0.95) })
  Object.assign(r, await resizes(app, win, 40, 'resize'))

  // A flood of output fills the scrollback; then the wheel scrolls back through it.
  xdotool('type', '--delay', '20', 'flood')
  await sleep(200)
  from = app.lines.length
  xdotool('key', 'Return')
  try {
    r.flood = (await app.next('flood', 60000, from)).ms
    await app.next('flood-frame-max', 5000, from)
    r.floodFrameP95 = app.since(from, 'flood-frame-p95')[0]
    r.floodFrameMax = app.since(from, 'flood-frame-max')[0]
  } catch { r.flood = r.floodFrameP95 = r.floodFrameMax = NaN }
  await sleep(1500)
  r.memoryFull = pss(processes(app.child.pid))
  from = app.lines.length
  for (let k = 0; k < 40; k++) {
    xdotool('click', k < 20 ? '4' : '5') // wheel up, then back down
    await sleep(80)
  }
  await sleep(300)
  const scrolls = app.since(from, 'scroll')
  Object.assign(r, { scroll: median(scrolls), scrollP95: quantile(scrolls, 0.95) })
  // With the scrollback full, xterm reflows all of it on each resize.
  Object.assign(r, await resizes(app, win, 20, 'resizeFull'), { marks })
  return r
}

/** Typing and resizing in a stand-in for Claude's fullscreen view, bench/tui.mjs, which redraws the whole
 * screen for each key, so the composer paints its card and xterm patches rows as they do under Claude. */
async function tuiSession(app) {
  await sleep(2000)
  const win = xdotool('search', '--sync', '--onlyvisible', '--pid', String(app.child.pid)).split('\n')[0]
  xdotool('windowfocus', '--sync', win)
  xdotool('mousemove', '--window', win, String(W / 2), String(H / 2))
  await sleep(300)
  const from = app.lines.length
  const typing = await load(app.child.pid, 10000, async () => {
    for (let k = 0; k < 100; k++) {
      xdotool('key', k % 10 === 9 ? 'Return' : 'a')
      await sleep(100)
    }
  })
  await sleep(300)
  const keys = app.since(from, 'key')
  const { resize, resizeP95 } = await resizes(app, win, 40, 'resize')
  return { tuiKey: median(keys), tuiKeyP95: quantile(keys, 0.95), tuiTyping: typing, tuiResize: resize, tuiResizeP95: resizeP95 }
}

/** `n` resizes of the window, back and forth, as `key` and `key`P95. */
async function resizes(app, win, n, key) {
  const from = app.lines.length
  for (let k = 0; k < n; k++) {
    xdotool('windowsize', win, String(k % 2 ? W : W - 180), String(k % 2 ? H : H - 120))
    await sleep(150)
  }
  await sleep(500)
  const ms = app.since(from, 'resize')
  return { [key]: median(ms), [`${key}P95`]: quantile(ms, 0.95) }
}

// What each row shows, its digits, and the change from base to new that counts as worse than noise.
const METRICS = [
  ['open', 'open ms', 0, 40],
  ['resize', 'resize ms', 1, 2],
  ['resizeP95', 'resize p95 ms', 1, 4],
  ['key', 'key echo ms', 1, 2],
  ['keyP95', 'key echo p95 ms', 1, 4],
  ['scroll', 'scroll ms', 1, 2],
  ['flood', 'flood ms', 0, 100],
  ['floodFrameP95', 'flood frame p95 ms', 1, 4],
  ['floodFrameMax', 'flood frame max ms', 0, 20],
  ['idle', 'idle CPU %', 1, 0.5],
  ['typing', 'typing CPU %', 1, 1.5],
  ['memory', 'memory MB', 0, 5],
  ['memoryFull', 'memory full MB', 0, 8],
  ['resizeFull', 'resize full ms', 1, 3],
  ['tuiKey', 'tui key echo ms', 1, 2],
  ['tuiKeyP95', 'tui key p95 ms', 1, 4],
  ['tuiTyping', 'tui typing CPU %', 1, 1.5],
  ['tuiResize', 'tui resize ms', 1, 2],
  ['tuiResizeP95', 'tui resize p95 ms', 1, 4],
]
const RELATIVE = 0.05 // and a change must also exceed this share of base

const results = [] // { wallpaper, bin, opens, sessions: [], tui: [] }
for (const wallpaper of wallpapers) {
  const run = scratch(wallpaper)
  const mine = bins.map(bin => ({ wallpaper, bin, opens: [], sessions: [], tui: [] }))
  results.push(...mine)
  for (const m of mine) {
    // A first launch writes nook's first-run files and warms the disk cache, so each timed launch starts alike.
    const warm = launch(m.bin, run)
    await warm.ready
    await warm.stop()
  }
  for (let i = 0; i < runs; i++) {
    for (const m of i % 2 ? [...mine].reverse() : mine) {
      const app = launch(m.bin, run)
      m.opens.push(await app.ready)
      if (i < sessions) m.sessions.push(await session(app))
      await app.stop()
    }
  }
  rmSync(run.dir, { recursive: true, force: true })
  const tui = scratch(wallpaper, [process.execPath, new URL('tui.mjs', import.meta.url).pathname])
  for (let i = 0; i < (flag('tui', 'on') === 'off' ? 0 : sessions); i++) {
    for (const m of i % 2 ? [...mine].reverse() : mine) {
      const app = launch(m.bin, tui)
      await app.ready
      m.tui.push(await tuiSession(app))
      await app.stop()
    }
  }
  rmSync(tui.dir, { recursive: true, force: true })
}
xvfb.kill()

const f = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '-')
const values = (r, key) => (key === 'open' ? r.opens : (key.startsWith('tui') ? r.tui : r.sessions).map(s => s[key]))
const cell = (r, key, d) => {
  const xs = sorted(values(r, key))
  return `${f(median(xs), d)} (${f(xs[0], d)}-${f(xs.at(-1), d)})`
}
let worse = 0
const last = bins.length - 1 // the build under test; every earlier one is a base it must match or beat
for (const wallpaper of wallpapers) {
  const mine = results.filter(r => r.wallpaper === wallpaper)
  console.log(`\nwallpaper ${wallpaper}: median (min-max) of ${runs} opens and ${sessions} sessions`)
  bins.forEach((b, i) => console.log(`  [${i}] ${b}`))
  const bases = mine.slice(0, last)
  console.log('metric'.padEnd(20) + mine.map((_, i) => `[${i}]`.padEnd(24)).join('') + bases.map((_, i) => `[${last}] vs [${i}]`.padEnd(22)).join(''))
  for (const [key, label, d, floor] of METRICS) {
    let line = label.padEnd(20) + mine.map(r => cell(r, key, d).padEnd(24)).join('')
    const b = median(values(mine[last], key))
    for (const base of bases) {
      const a = median(values(base, key))
      const delta = b - a
      const flagged = delta > Math.max(floor, RELATIVE * Math.abs(a))
      if (flagged) worse++
      line += `${delta >= 0 ? '+' : ''}${f(delta, d)}${a ? ` (${delta >= 0 ? '+' : ''}${f((100 * delta) / a, 0)}%)` : ''}${flagged ? ' WORSE' : ''}`.padEnd(22)
    }
    console.log(line.trimEnd())
  }
  // Where an open's time goes: the median ms since nook started at which each step finished.
  const steps = ['setup', 'window', 'page', 'script', 'boot', 'settings', 'chrome', 'spawned', 'ready']
  for (const r of mine) {
    const at = steps.map(s => median(r.sessions.map(x => x.marks[s])))
    if (at.some(Number.isFinite)) console.log(`open steps [${mine.indexOf(r)}]: ` + steps.map((s, i) => `${s} ${f(at[i], 0)}`).join(', '))
  }
}
if (bins.length > 1) console.log(worse ? `\n${worse} metric(s) look worse than noise.` : '\nNothing looks worse than noise.')
if (flag('json')) writeFileSync(flag('json'), JSON.stringify({ bins, runs, sessions, results }, null, 2))
process.exitCode = worse ? 1 : 0
