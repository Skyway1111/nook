// Measures release builds of nook on Linux, on its own Xvfb display, once for each wallpaper given:
//   open      ms from starting nook until a frame shows its terminal's text
//   resize    ms from a window resize until the frame that shows it, over 40 resizes (median and p95)
//   key       ms from a key going down until the frame that shows its echo, over 100 keys (median and p95)
//   scroll    ms from a wheel step until the frame that shows the scrolled rows, over 40 steps
//   flood     ms from Enter until the frame that shows the last of 10,000 lines of output, and the
//             longest gaps between frames meanwhile (p95 and max), each the median of three floods
//   idle      CPU, as % of one core, over 10 s with nothing happening (5 s with --quick)
//   typing    CPU over 10 s of typing a key every 100 ms (6 s with --quick)
//   memory    MB of PSS once idle, and again after the flood fills the scrollback
//   resize full  resize again, once the flood has filled the scrollback, which the terminal reflows each time
//   diff      with --repo: ms from asking for the diff of every change to the frame that shows it, and the CPU
//             seconds nook spends in the 5 s after (3 s with --quick), colors included
//   history   with --repo: ms from asking for the history to the frame that shows its commits; - for a build
//             without one
//   tui       key echo, typing CPU, and resize again, in bench/tui.mjs, a stand-in for Claude's fullscreen
//             view that redraws the whole screen for each key, as Claude does. Its key echo is timed on the
//             screen, by bench/pixels.py, until the composer's draft changes.
// Every launch times its open. The first --sessions launches of each build also run the rest, and each number
// is the median of those sessions, with the spread (min-max) beside it. Below the table, each build's open is
// split into the steps it passes, as ms since nook started: its window built, the page began to load, the
// script ran, and so on until the terminal's text showed.
// With two builds or more, `--bin base,new` or `--bin baseline,main,new`, launches take turns between them, so
// drift in the machine hits all alike, and the table ends with the change from each earlier build to the last.
// A change is flagged when it is worse than its noise, and the exit code is 1 if any is. Its noise, after the ±,
// is the largest of the metric's floor, 5% of the base, and 2.5 standard errors of the change, from how much
// each build's own sessions spread: a number that swings from session to session needs a bigger change to
// count. Comparing against a fixed baseline as well as main catches a slow drift that no single merge shows.
// CPU and memory count nook and its WebKit processes, not the shell in its tab. The tab runs a small bash loop
// that echoes lines, in a folder outside any repository, so neither Claude nor the git panel's poll adds
// noise. With --repo it runs in that repository instead, so the git panel and its diff tab are measured too;
// bench/diffrepo.mjs makes a repository with a large diff for it. Xvfb has no GPU, so WebKit draws in software: compare numbers from the same machine, not with a
// desktop's.
// --quick is the merge gate's run, which bench/gate.mjs starts: each session times fewer keys, resizes and
// floods over shorter spans, 16 opens, no Claude-view pass unless --tui on, and a number that comes close to its
// bar gets more launches before the verdict. --koi also switches each session to the koi wallpaper for a while.
// Needs Xvfb, xdotool and python3, and nook built as dev.nook.bench, which keeps its own settings:
// `NOOK_ID=dev.nook.bench npm run build -- --no-pack` puts one in native/target/release/stage.
//   node bench/linux.mjs [--bin native/target/release/stage/nook[,other...]] [--wallpapers none,koi] [--runs 30]
//                        [--sessions 3] [--tui off] [--repo path] [--quick] [--koi] [--json out.json]
import { spawn, execFileSync } from 'child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { ID, benched, f, judge, median, quantile, table } from './stats.mjs'

const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1] }
const bins = flag('bin', new URL('../native/target/release/stage/nook', import.meta.url).pathname).split(',').map(b => resolve(b))
const wallpapers = flag('wallpapers', 'none').split(',')
const quick = process.argv.includes('--quick')
const runs = Number(flag('runs', quick ? 16 : 30))
const sessions = Math.min(runs, Number(flag('sessions', 3)))
const repo = flag('repo', null) && resolve(flag('repo'))
const tuiOn = flag('tui', quick ? 'off' : 'on') !== 'off'
const koi = process.argv.includes('--koi')
const [W, H] = [1280, 820] // nook's own first size
// How much a session does: the full run's, or the quick gate's, which times fewer of each over shorter spans.
const P = quick
  ? { settle: 2000, idle: 5000, keys: 60, resizes: 20, floods: 1, afterFlood: 800, scrolls: 12, resizesFull: 8, diffCpu: 3000 }
  : { settle: 3000, idle: 10000, keys: 100, resizes: 40, floods: 3, afterFlood: 1500, scrolls: 40, resizesFull: 20, diffCpu: 5000 }
for (const bin of bins) if (!benched(bin)) throw new Error(`no nook built as ${ID} at ${bin}`)

const sleep = ms => new Promise(r => setTimeout(r, ms))

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
  const config = join(dir, 'config', ID)
  const home = join(dir, 'home')
  mkdirSync(config, { recursive: true })
  mkdirSync(home)
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ command, lastDir: repo ?? home, pinned: [] }))
  writeFileSync(join(config, 'theme.css'), `:root { --wallpaper: ${wallpaper}; }\n`)
  return { dir, config, env: { ...env, XDG_CONFIG_HOME: join(dir, 'config'), HOME: home } }
}

/** Whether a line from nook is `event`, or `event:` and what it carries. */
const is = (line, event) => line.event === event || line.event.startsWith(`${event}:`)

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
      waiting.filter(w => is(item, w.event)).forEach(w => w.resolve(item))
    }
  })
  const next = (event, timeout = 30000, from = 0) => new Promise((resolve, reject) => {
    const have = lines.slice(from).find(l => is(l, event))
    if (have) return resolve(have)
    // The timer goes once answered: a pending one would hold the bench open until it fired.
    const timer = setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); reject(new Error(`no ${event} from nook within ${timeout} ms`)) }, timeout)
    const w = { event, resolve: item => { clearTimeout(timer); resolve(item) } }
    waiting.push(w)
  })
  return {
    child,
    config: run.config,
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
  await sleep(P.settle) // past the backdrops' bake and the first polls
  const win = xdotool('search', '--sync', '--onlyvisible', '--pid', String(app.child.pid)).split('\n')[0]
  xdotool('windowfocus', '--sync', win) // the wallpaper moves only while nook has focus
  r.idle = await load(app.child.pid, P.idle)
  r.memory = pss(processes(app.child.pid))
  xdotool('mousemove', '--window', win, String(W / 2), String(H / 2), 'click', '1')
  await sleep(300)
  let from = app.lines.length
  r.typing = await load(app.child.pid, P.keys * 100, async () => {
    for (let k = 0; k < P.keys; k++) {
      xdotool('key', k % 10 === 9 ? 'Return' : 'a') // to the focused window: GTK ignores sent events
      await sleep(100)
    }
  })
  await sleep(300)
  const keys = app.since(from, 'key')
  Object.assign(r, { key: median(keys), keyP95: quantile(keys, 0.95) })
  Object.assign(r, await resizes(app, win, P.resizes, 'resize'))
  if (koi) Object.assign(r, await withKoi(app, win))

  // Floods of output fill the scrollback; then the wheel scrolls back through it. A flood paints in a handful
  // of frames, so one slow frame moves its gaps by tens of ms: each number is the median of a session's floods.
  const floods = []
  for (let k = 0; k < P.floods; k++) {
    xdotool('type', '--delay', '20', 'flood')
    await sleep(200)
    from = app.lines.length
    xdotool('key', 'Return')
    try {
      const ms = (await app.next('flood', 60000, from)).ms
      await app.next('flood-frame-max', 5000, from)
      floods.push({ ms, p95: app.since(from, 'flood-frame-p95')[0], max: app.since(from, 'flood-frame-max')[0] })
    } catch {}
    await sleep(P.afterFlood)
  }
  Object.assign(r, { flood: median(floods.map(x => x.ms)), floodFrameP95: median(floods.map(x => x.p95)), floodFrameMax: median(floods.map(x => x.max)) })
  r.memoryFull = pss(processes(app.child.pid))
  from = app.lines.length
  for (let k = 0; k < P.scrolls; k++) {
    xdotool('click', k < P.scrolls / 2 ? '4' : '5') // wheel up, then back down
    await sleep(80)
  }
  await sleep(300)
  const scrolls = app.since(from, 'scroll')
  Object.assign(r, { scroll: median(scrolls), scrollP95: quantile(scrolls, 0.95) })
  // With the scrollback full, the terminal reflows all of it on each resize.
  Object.assign(r, await resizes(app, win, P.resizesFull, 'resizeFull'), { marks })
  if (repo) {
    xdotool('windowsize', '--sync', win, String(W), String(H))
    await sleep(1000)
    const pids = processes(app.child.pid)
    const c0 = cpu(pids)
    from = app.lines.length
    xdotool('key', 'F9')
    r.diff = (await app.next('diff', 30000, from)).ms
    await sleep(P.diffCpu)
    r.diffCpu = cpu(pids) - c0
    from = app.lines.length
    xdotool('key', 'F8')
    r.history = await app.next('history', 10000, from).then(l => l.ms, () => NaN)
  }
  return r
}

/** Typing and resizing in a stand-in for Claude's fullscreen view, bench/tui.mjs, which redraws the whole
 * screen for each key, so the composer paints its card and the terminal patches rows as they do under Claude. */
async function tuiSession(app) {
  await sleep(P.settle)
  const win = xdotool('search', '--sync', '--onlyvisible', '--pid', String(app.child.pid)).split('\n')[0]
  xdotool('windowfocus', '--sync', win)
  xdotool('mousemove', '--window', win, String(W / 2), String(H / 2))
  await sleep(300)
  const typing = await load(app.child.pid, P.keys * 100, async () => {
    for (let k = 0; k < P.keys; k++) {
      xdotool('key', k % 10 === 9 ? 'Return' : 'a')
      await sleep(100)
    }
  })
  await sleep(300)
  // Then 100 more keys, each timed on the screen until the composer's draft changes: the page's own clock reads
  // a frame as shown before WebKit hands it to the window, and how long that takes depends on the page.
  // Watching the screen costs nook CPU of its own, so the typing above runs without it.
  const from = app.lines.length
  xdotool('key', 'F7')
  // A build from before F7 never answers, and its echo goes untimed.
  const [x, y, w, h] = await app.next('draft', 2000, from).then(l => l.event.slice(6).split(',').map(Number), () => [])
  let keys = []
  if (w > 0 && h > 0) {
    const at = Object.fromEntries(xdotool('getwindowgeometry', '--shell', win).split('\n').map(l => l.split('=')))
    const args = [new URL('pixels.py', import.meta.url).pathname, x + Number(at.X), y + Number(at.Y), w, h, P.keys]
    const helper = spawn('python3', args.map(String), { env, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    helper.stdout.on('data', d => (out += d))
    await new Promise(r => helper.on('exit', r))
    keys = out.trim() ? JSON.parse(out) : []
  }
  await sleep(300)
  const { resize, resizeP95 } = await resizes(app, win, P.resizes, 'resize')
  return { tuiKey: median(keys), tuiKeyP95: quantile(keys, 0.95), tuiTyping: typing, tuiResize: resize, tuiResizeP95: resizeP95 }
}

/** With --koi: switches the open nook to the koi wallpaper, as a pick in its theme.css does, and times idle CPU,
 * memory, and resizes under it. Then theme.css goes back to no wallpaper, for the rest of the session and the
 * next launch. */
async function withKoi(app, win) {
  const css = join(app.config, 'theme.css')
  const before = readFileSync(css, 'utf8')
  writeFileSync(css, ':root { --wallpaper: koi; }\n')
  try {
    await sleep(2500) // nook reads theme.css within a second, then the wallpaper bakes its glyphs
    const r = { koiIdle: await load(app.child.pid, P.idle), koiMemory: pss(processes(app.child.pid)) }
    const { koiResize, koiResizeP95 } = await resizes(app, win, P.resizes, 'koiResize')
    return { ...r, koiResize, koiResizeP95 }
  } finally {
    writeFileSync(css, before)
  }
  await sleep(1500) // and the wallpaper goes, before the floods
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
  ['floodFrameP95', 'flood frame p95 ms', 1, 20],
  ['floodFrameMax', 'flood frame max ms', 0, 20],
  ['idle', 'idle CPU %', 1, 0.5],
  ['typing', 'typing CPU %', 1, 1.5],
  ['memory', 'memory MB', 0, 5],
  ['memoryFull', 'memory full MB', 0, 20], // when the webview collects the flood's garbage varies by tens of MB
  ['resizeFull', 'resize full ms', 1, 3],
  ...(koi ? [['koiIdle', 'koi idle CPU %', 1, 0.5], ['koiMemory', 'koi memory MB', 0, 5], ['koiResize', 'koi resize ms', 1, 2], ['koiResizeP95', 'koi resize p95 ms', 1, 4]] : []),
  ...(repo ? [['diff', 'diff ms', 0, 30], ['diffCpu', 'diff CPU s', 2, 0.1], ['history', 'history ms', 0, 30]] : []),
  ['tuiKey', 'tui key echo ms', 1, 2],
  ['tuiKeyP95', 'tui key p95 ms', 1, 4],
  ['tuiTyping', 'tui typing CPU %', 1, 1.5],
  ['tuiResize', 'tui resize ms', 1, 2],
  ['tuiResizeP95', 'tui resize p95 ms', 1, 4],
]
const values = (r, key) => (key === 'open' ? r.opens : (key.startsWith('tui') ? r.tui : r.sessions).map(s => s[key]))
// The numbers a quick run spends more launches on: those the gate must hold, not every number it prints.
const SESSION = ['resize', 'idle', 'typing', 'memory', 'key', 'koiIdle', 'koiMemory', 'koiResize']
const TUI = ['tuiKey', 'tuiTyping', 'tuiResize']
/** Whether the last build's change from any earlier one, in any of `keys`, is between `share` of its bar and
 * twice it: close enough to its bar that more samples could decide it either way. */
function near(mine, keys, share) {
  const last = mine.at(-1)
  const measured = METRICS.filter(m => keys.includes(m[0]))
  return mine.slice(0, -1).some(base => measured.some(([key, , , floor]) => {
    const [then, now] = [values(base, key), values(last, key)].map(xs => xs.filter(Number.isFinite))
    if (!then.length || !now.length) return false
    const { delta, bar } = judge(then, now, floor)
    return delta > share * bar && delta < 2 * bar
  }))
}

// A quick run spends more launches only where a change comes close to its bar, so a clear case is decided fast:
// two more sessions of each build, once, when any of SESSION's numbers passes half its bar; opens, eight rounds
// at a time up to 40, while open's change passes 40% of its own. A change past twice its bar is decided.
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
  let i = 0 // rounds so far; launches take turns, the order flipping each round
  const round = async withSession => {
    for (const m of i++ % 2 ? [...mine].reverse() : mine) {
      const app = launch(m.bin, run)
      m.opens.push(await app.ready)
      if (withSession) m.sessions.push(await session(app))
      await app.stop()
    }
  }
  for (let k = 0; k < runs; k++) await round(k < sessions)
  if (quick && near(mine, SESSION, 0.5)) for (let k = 0; k < 2; k++) await round(true)
  while (quick && i < 40 && near(mine, ['open'], 0.4)) for (let k = 0; k < 8; k++) await round(false)
  rmSync(run.dir, { recursive: true, force: true })
  const tui = scratch(wallpaper, [process.execPath, new URL('tui.mjs', import.meta.url).pathname])
  let t = 0
  const tuiRound = async () => {
    for (const m of t++ % 2 ? [...mine].reverse() : mine) {
      const app = launch(m.bin, tui)
      await app.ready
      m.tui.push(await tuiSession(app))
      await app.stop()
    }
  }
  for (let k = 0; k < (tuiOn ? sessions : 0); k++) await tuiRound()
  if (quick && tuiOn && near(mine, TUI, 0.5)) for (let k = 0; k < 2; k++) await tuiRound()
  rmSync(tui.dir, { recursive: true, force: true })
}
xvfb.kill()

let worse = 0
for (const wallpaper of wallpapers) {
  const mine = results.filter(r => r.wallpaper === wallpaper)
  const counts = r => `${r.opens.length} opens and ${r.sessions.length} sessions`
  console.log(`\nwallpaper ${wallpaper}: median (min-max) of ${counts(mine.at(-1))} of each build`)
  bins.forEach((b, i) => console.log(`  [${i}] ${b}`))
  worse += table(mine, METRICS, values)
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
