// Measures a release nook on Linux, on its own Xvfb display, once for each wallpaper given:
//   open    ms from starting nook until a frame shows its terminal's text, the median of --runs launches
//   resize  ms from a window resize until the frame that shows it, median and 95th percentile of 40 resizes
//   idle    CPU, as % of one core, over 10 s with nothing happening
//   typing  CPU over 10 s of typing a key every 100 ms
//   memory  MB of PSS once idle
//   diff    with --repo: ms from asking for the diff of every change to the frame that shows it, and the CPU
//           seconds nook spends in the 5 s after, colors included
// CPU and memory count nook and its WebKit processes, not the shell in its tab. The tab runs `cat` in a
// folder outside any repository, so neither Claude nor the git panel's poll adds noise. With --repo it runs
// in that repository instead, so the git panel and its diff tab are measured too. Xvfb has no GPU, so
// WebKit draws in software: compare numbers from the same machine, not with a desktop's.
// Needs Xvfb and xdotool, and a build: `npx tauri build --no-bundle`. To compare two builds, run each:
//   node bench/linux.mjs [--bin src-tauri/target/release/nook] [--wallpapers none,koi] [--runs 5] [--json out.json]
//     [--repo path]   bench/diffrepo.mjs makes a repository with a large diff for it
import { spawn, execFileSync } from 'child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1] }
const bin = resolve(flag('bin', new URL('../src-tauri/target/release/nook', import.meta.url).pathname))
const wallpapers = flag('wallpapers', 'none').split(',')
const runs = Number(flag('runs', 5))
const repo = flag('repo', null) && resolve(flag('repo'))
const [W, H] = [1280, 820] // nook's own first size

const sleep = ms => new Promise(r => setTimeout(r, ms))
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]

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

/** A config folder whose settings run `cat` and whose theme.css picks `wallpaper`. */
function scratch(wallpaper) {
  const dir = mkdtempSync(join(tmpdir(), 'nook-bench-'))
  const config = join(dir, 'config', 'dev.nook.app')
  const home = join(dir, 'home')
  mkdirSync(config, { recursive: true })
  mkdirSync(home)
  writeFileSync(join(config, 'settings.json'), JSON.stringify({
    command: ['bash', '-c', "printf 'nook bench\\n'; exec cat"], lastDir: repo ?? home, pinned: [],
  }))
  writeFileSync(join(config, 'theme.css'), `:root { --wallpaper: ${wallpaper}; }\n`)
  return { dir, env: { ...env, XDG_CONFIG_HOME: join(dir, 'config'), HOME: home } }
}

/** Starts nook. `ready` resolves to ms from the spawn until its first frame with text. */
function launch(run) {
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
      const [tag, event, ms] = line.split(' ')
      if (tag !== 'bench') continue
      const item = { event, ms: Number(ms), at: performance.now() }
      lines.push(item)
      waiting.filter(w => w.event === event).forEach(w => w.resolve(item))
    }
  })
  const next = (event, timeout = 30000) => new Promise((resolve, reject) => {
    const have = lines.find(l => l.event === event)
    if (have) return resolve(have)
    waiting.push({ event, resolve })
    setTimeout(() => reject(new Error(`no ${event} from nook within ${timeout} ms`)), timeout)
  })
  return {
    child,
    lines,
    next,
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

const results = []
for (const wallpaper of wallpapers) {
  const run = scratch(wallpaper)
  // A first launch writes nook's first-run files and warms the disk cache, so each timed launch starts alike.
  const warm = launch(run)
  await warm.ready
  await warm.stop()
  const opens = []
  for (let i = 0; i < runs; i++) {
    const app = launch(run)
    opens.push(await app.ready)
    if (i < runs - 1) await app.stop()
    else {
      await sleep(3000) // past the backdrops' bake and the first polls
      const win = xdotool('search', '--sync', '--onlyvisible', '--pid', String(app.child.pid)).split('\n')[0]
      xdotool('windowfocus', '--sync', win) // the wallpaper moves only while nook has focus
      const idle = await load(app.child.pid, 10000)
      const memory = pss(processes(app.child.pid))
      xdotool('mousemove', '--window', win, String(W / 2), String(H / 2), 'click', '1')
      const typing = await load(app.child.pid, 10000, async () => {
        for (let k = 0; k < 100; k++) {
          xdotool('key', k % 10 === 9 ? 'Return' : 'a') // to the focused window: GTK ignores sent events
          await sleep(100)
        }
      })
      const before = app.lines.length
      for (let k = 0; k < 40; k++) {
        xdotool('windowsize', win, String(k % 2 ? W : W - 180), String(k % 2 ? H : H - 120))
        await sleep(150)
      }
      await sleep(500)
      const resizes = app.lines.slice(before).filter(l => l.event === 'resize').map(l => l.ms)
      let diff = NaN
      let diffCpu = NaN
      if (repo) {
        xdotool('windowsize', '--sync', win, String(W), String(H))
        await sleep(1000)
        const pids = processes(app.child.pid)
        const c0 = cpu(pids)
        xdotool('key', 'F9')
        diff = (await app.next('diff')).ms
        await sleep(5000)
        diffCpu = cpu(pids) - c0
      }
      await app.stop()
      results.push({
        wallpaper,
        open: median(opens),
        resize: resizes.length ? median(resizes) : NaN,
        resizeP95: resizes.length ? quantile(resizes, 0.95) : NaN,
        resizes: resizes.length,
        idle,
        typing,
        memory,
        diff,
        diffCpu,
      })
    }
  }
  rmSync(run.dir, { recursive: true, force: true })
}
xvfb.kill()

const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-')
console.log(`nook bench: ${bin}`)
console.log('wallpaper     open ms  resize ms (p95)  idle CPU %  typing CPU %  memory MB' + (repo ? '  diff ms  diff CPU s' : ''))
for (const r of results) {
  console.log(`${r.wallpaper.padEnd(12)}  ${f(r.open, 0).padStart(7)}  ${f(r.resize).padStart(9)} (${f(r.resizeP95)})`.padEnd(43) +
    `${f(r.idle).padStart(10)}  ${f(r.typing).padStart(12)}  ${f(r.memory, 0).padStart(9)}` +
    (repo ? `  ${f(r.diff, 0).padStart(7)}  ${f(r.diffCpu, 2).padStart(10)}` : ''))
}
if (flag('json')) writeFileSync(flag('json'), JSON.stringify({ bin, runs, results }, null, 2))
