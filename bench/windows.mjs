// Measures nook on Windows, on your own machine: by default the commit the overnight R&D began from (PR #1's
// merge) against origin/main, each built here once and kept for later runs.
//   open      ms from starting nook until a frame shows its terminal's text
//   resize    ms from a window resize until the frame that shows it, over 40 resizes (median and p95)
//   idle      CPU, as % of one core, over 10 s with nothing happening
//   memory    MB of private memory once idle
// CPU and memory count nook and its WebView2 processes, not the shell in its tab, which runs cmd.exe. Every
// launch times its open; the first --sessions launches of each build also run the rest. Launches take turns
// between the builds, and the table flags a change worse than its noise, as bench/linux.mjs does.
// Every build is nook as dev.nook.bench, with its own settings and WebView2 profile, so your own nook can stay open
// and its settings are never touched; close it for numbers you publish, since its work is noise in theirs. An --exe
// has to be built that way too: `$env:NOOK_ID = 'dev.nook.bench'; npm run build -- --no-pack` puts one in
// native\target\release\stage.
//   npm run bench:windows
//   node bench/windows.mjs [--base 3318948] [--new origin/main] [--exe base.exe,new.exe] [--wallpapers none,koi]
//                          [--runs 20] [--sessions 3]
// Each commit builds in a git worktree in %LOCALAPPDATA%\nook-bench; after deleting that folder, `git worktree
// prune` forgets them.
import { spawn, execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { ID, benched, median, quantile, table } from './stats.mjs'

if (process.platform !== 'win32') {
  console.error('bench/windows.mjs measures nook on Windows. On Linux, use bench/linux.mjs.')
  process.exit(2)
}
const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1] }
const wallpapers = flag('wallpapers', 'none,koi').split(',')
const runs = Number(flag('runs', 20))
const sessions = Math.min(runs, Number(flag('sessions', 3)))
const repo = fileURLToPath(new URL('..', import.meta.url))
const helper = fileURLToPath(new URL('windows.ps1', import.meta.url))
const store = join(process.env.LOCALAPPDATA, 'nook-bench')
const config = join(process.env.APPDATA, ID) // where the bench's nook keeps its settings, themes, and theme.css
const sleep = ms => new Promise(r => setTimeout(r, ms))
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim()

/** A release build of `ref` as dev.nook.bench, made in its own worktree unless one is there from an earlier run.
 * A commit with scripts/build.mjs builds itself; an older one builds with its own tauri-cli. */
function build(ref) {
  if (ref.startsWith('origin/')) git('fetch', '-q', 'origin', ref.slice('origin/'.length))
  const sha = git('rev-parse', '--short=10', `${ref}^{commit}`)
  const dir = join(store, sha)
  if (!existsSync(dir)) git('worktree', 'add', '-f', '--detach', dir, sha)
  const own = existsSync(join(dir, 'scripts', 'build.mjs'))
  const exe = join(dir, existsSync(join(dir, 'native')) ? 'native' : 'src-tauri', 'target', 'release', ...(own ? ['stage'] : []), 'nook.exe')
  if (benched(exe)) return { label: `${ref} (${sha})`, exe }
  console.log(`Building ${ref} (${sha}) in ${dir}. A commit's first build takes a few minutes.`)
  const env = { ...process.env, NOOK_ID: ID, TAURI_CONFIG: JSON.stringify({ identifier: ID }) }
  const run = (...command) => execFileSync(command.join(' '), { cwd: dir, env, stdio: 'inherit', shell: true })
  if (own) run('node', 'scripts/build.mjs', '--no-pack')
  else {
    run('npm', 'ci')
    run('npx', 'tauri', 'build', '--no-bundle')
  }
  if (!benched(exe)) throw new Error(`no nook.exe built as ${ID} after building ${sha}`)
  return { label: `${ref} (${sha})`, exe }
}

const exes = flag('exe', null)
const builds = exes
  ? exes.split(',').map(e => ({ label: e, exe: resolve(e) }))
  : [build(flag('base', '3318948')), build(flag('new', 'origin/main'))]
for (const b of builds) if (!benched(b.exe)) throw new Error(`${b.exe} isn't nook built as ${ID}, so it would open your own settings`)

const children = new Set()
const stopAll = () => { for (const child of children) try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
process.on('exit', stopAll)
for (const signal of ['SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(130)) // Ctrl+C, or the console closing

/** A fresh settings folder whose tab runs cmd.exe and whose theme.css picks `wallpaper`. */
function scratch(wallpaper) {
  rmSync(config, { recursive: true, force: true })
  mkdirSync(config, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'nook-bench-'))
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ command: ['cmd.exe', '/q', '/k', 'echo nook bench'], lastDir: home, pinned: [] }))
  writeFileSync(join(config, 'theme.css'), `:root { --wallpaper: ${wallpaper}; }\n`)
  return home
}

/** Starts nook with NOOK_BENCH set. `ready` resolves to ms from the start until its first frame with text. */
function launch(exe) {
  const started = performance.now()
  const child = spawn(exe, [], { env: { ...process.env, NOOK_BENCH: '1' }, stdio: ['ignore', 'pipe', 'ignore'] })
  children.add(child)
  child.once('exit', () => children.delete(child))
  const lines = []
  let buffered = ''
  let ready
  const readied = new Promise((resolve, reject) => {
    ready = resolve
    setTimeout(() => reject(new Error(`${exe} showed no text within 30 s`)), 30000).unref()
  })
  child.stdout.on('data', d => {
    buffered += d
    const parts = buffered.split(/\r?\n/)
    buffered = parts.pop()
    for (const line of parts) {
      const [tag, event, ms] = line.split(' ')
      if (tag !== 'bench') continue
      lines.push({ event, ms: Number(ms) })
      if (event === 'ready') ready(performance.now() - started)
    }
  })
  return {
    child,
    lines,
    ready: readied,
    since: (from, event) => lines.slice(from).filter(l => l.event === event).map(l => l.ms),
    stop: async () => {
      if (child.exitCode === null) {
        const gone = new Promise(r => child.once('exit', r))
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
        await gone
      }
      await sleep(500) // WebView2's processes close after the window's
    },
  }
}

/** Runs windows.ps1, which does what Node can't: finds, focuses, and resizes nook's window, and reads CPU and
 * memory. Resolves to what it prints. */
function ps(...args) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, ...args.map(String)], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', d => (out += d))
    p.on('exit', code => (code ? reject(new Error(`windows.ps1 ${args.join(' ')} failed`)) : resolve(out.trim())))
  })
}

/** Idle CPU, memory, and resizes, on a nook that just opened. */
async function session(app) {
  await sleep(3000) // past the backdrops' bake and the first polls
  const { cpu, memory } = JSON.parse(await ps('idle', app.child.pid, 10000)) // focused, so the wallpaper moves
  const from = app.lines.length
  await ps('resize', app.child.pid, 40)
  await sleep(500)
  const ms = app.since(from, 'resize')
  return { idle: cpu, memory, resize: median(ms), resizeP95: quantile(ms, 0.95) }
}

const METRICS = [
  ['open', 'open ms', 0, 40],
  ['resize', 'resize ms', 1, 2],
  ['resizeP95', 'resize p95 ms', 1, 4],
  ['idle', 'idle CPU %', 1, 0.5],
  ['memory', 'memory MB', 0, 5],
]
const values = (r, key) => (key === 'open' ? r.opens : r.sessions.map(s => s[key]))

const results = []
for (const wallpaper of wallpapers) {
  const home = scratch(wallpaper)
  const mine = builds.map(b => ({ ...b, opens: [], sessions: [] }))
  results.push({ wallpaper, mine })
  for (const m of mine) {
    // A first launch writes nook's first-run files and warms the disk cache, so each timed launch starts alike.
    const warm = launch(m.exe)
    await warm.ready
    await sleep(6000) // past the themes a newer nook offers 5 s after it opens
    await warm.stop()
  }
  for (let i = 0; i < runs; i++) {
    for (const m of i % 2 ? [...mine].reverse() : mine) {
      const app = launch(m.exe)
      m.opens.push(await app.ready)
      if (i < sessions) m.sessions.push(await session(app))
      await app.stop()
    }
    process.stdout.write(`\rwallpaper ${wallpaper}: ${i + 1} of ${runs} rounds`)
  }
  rmSync(home, { recursive: true, force: true })
}

let worse = 0
for (const { wallpaper, mine } of results) {
  console.log(`\n\nwallpaper ${wallpaper}: median (min-max) of ${runs} opens and ${sessions} sessions`)
  mine.forEach((b, i) => console.log(`  [${i}] ${b.label}`))
  worse += table(mine, METRICS, values)
}
console.log(worse ? `\n${worse} metric(s) look worse than noise.` : '\nNothing looks worse than noise.')
process.exitCode = worse ? 1 : 0
