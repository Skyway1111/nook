// The merge gate, in about five minutes: this tree's release build against origin/main's, with bench/linux.mjs
// --quick. Main's build is made once per commit and kept, so a second gate on the same main starts at once.
// The quick run always times open, resize, key echo, scroll, a flood, idle and typing CPU, and memory. It adds:
//   the koi wallpaper (idle CPU, memory, resize under it)   when the PR touches the wallpaper, themes, or CSS
//   Claude's fullscreen view (key echo, typing, resize)      when it touches the terminal, the composer, or CSS
//   a repository with a large diff (git panel, diff tab)     when it touches the git panel or the file list
// --all adds all three. A number that comes close to its bar earns more launches before the verdict, so a run
// that flags nothing took its time where it was needed. Exit code 1 if anything looks worse than noise; rerun
// that pass with bench/linux.mjs at full length before believing a small flag.
//   node bench/gate.mjs [--main origin/main] [--bin build] [--all]
// --bin skips building this tree and benches that build instead, which has to be nook built as dev.nook.bench, as
// every build here is (bench/linux.mjs checks). Main's builds and their shared cargo target live in
// ~/.cache/nook-bench; deleting it is safe.
import { execFileSync, spawnSync } from 'child_process'
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1] }
const repo = fileURLToPath(new URL('..', import.meta.url))
const store = join(homedir(), '.cache', 'nook-bench')
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim()
const started = performance.now()
const minutes = (from, to = performance.now()) => `${((to - from) / 60000).toFixed(1)} min`
const run = (command, args, opts) => {
  const r = spawnSync(command, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}
// Every build is nook as dev.nook.bench: its own settings and WebKit data, whatever the tree's own identity.
const ID = 'dev.nook.bench'
const env = { ...process.env, NOOK_ID: ID, TAURI_CONFIG: JSON.stringify({ identifier: ID }) }
const benched = bin => existsSync(bin) && readFileSync(bin).includes(ID)

/** Main's release build at `ref`, made in a worktree the first time and kept by commit, with what ships beside it.
 * A commit with scripts/build.mjs builds itself; an older one builds with its own tauri-cli. */
function mainBuild(ref) {
  if (ref.startsWith('origin/')) git('fetch', '-q', 'origin', ref.slice('origin/'.length))
  const sha = git('rev-parse', '--short=10', `${ref}^{commit}`)
  const bin = join(store, sha, 'nook')
  if (benched(bin)) return { sha, bin }
  console.log(`Building ${ref} (${sha}), once for this commit.`)
  const dir = join(store, sha, 'src')
  rmSync(dir, { recursive: true, force: true })
  git('worktree', 'add', '-f', '--detach', dir, sha)
  try {
    // One cargo target for every main build, so only nook's own crate compiles again.
    const opts = { cwd: dir, env: { ...env, CARGO_TARGET_DIR: join(store, 'target') } }
    if (existsSync(join(dir, 'scripts', 'build.mjs'))) {
      run(process.execPath, ['scripts/build.mjs', '--no-pack'], opts)
      cpSync(join(store, 'target', 'release', 'stage'), join(store, sha), { recursive: true })
    } else {
      run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir })
      run('npx', ['tauri', 'build', '--no-bundle'], opts)
      copyFileSync(join(store, 'target', 'release', 'nook'), bin)
    }
  } finally {
    git('worktree', 'remove', '--force', dir)
  }
  return { sha, bin }
}

const main = mainBuild(flag('main', 'origin/main'))
let bin = flag('bin', null)
if (bin) bin = resolve(bin)
else {
  console.log('Building this tree.')
  run(process.execPath, ['scripts/build.mjs', '--no-pack'], { cwd: repo, env })
  bin = join(resolve(repo, process.env.CARGO_TARGET_DIR ?? 'src-tauri/target'), 'release', 'stage', 'nook')
}
const built = performance.now()

// What this tree changes from main: its commits since they parted, and what isn't committed yet.
const changed = [
  ...git('diff', '--name-only', `${main.sha}...HEAD`).split('\n'),
  ...git('status', '--porcelain').split('\n').map(l => l.slice(3)),
].filter(Boolean)
const all = process.argv.includes('--all')
const touches = re => all || changed.some(p => re.test(p))
const passes = {
  koi: touches(/^src\/(wallpapers?|backdrops|themer|themes|settings)\.js$|^src\/(style|theme)\.css$|^src-tauri\/src\/theme\.rs$/),
  tui: touches(/^src\/(terminal|composer|turns|sequences|progress|pictures|links|linkify)\.js$|^src\/style\.css$|^package(-lock)?\.json$|^bench\/(tui\.mjs|pixels\.py)$|^src-tauri\/src\/(pty|shell\w*)\.rs$/),
  repo: touches(/^src\/(git|files|gitmarks|diff|history|merge|conflicts|blame|graph|patch|paths)\.js$|^src\/(history|merge)\.css$|^src-tauri\/src\/(git|history|index)\.rs$|^bench\/diffrepo\.mjs$/),
}
const args = [fileURLToPath(new URL('linux.mjs', import.meta.url)), '--bin', `${main.bin},${bin}`, '--quick']
if (passes.koi) args.push('--koi')
if (passes.tui) args.push('--tui', 'on')
let scratch = null
if (passes.repo) {
  scratch = mkdtempSync(join(tmpdir(), 'nook-gate-'))
  run(process.execPath, [fileURLToPath(new URL('diffrepo.mjs', import.meta.url)), join(scratch, 'repo')], { stdio: 'ignore' })
  args.push('--repo', join(scratch, 'repo'))
}
const extras = Object.entries(passes).filter(([, on]) => on).map(([name]) => name)
console.log(`Benching main (${main.sha}) against ${bin}${extras.length ? `, with ${extras.join(', ')}` : ''}.`)
const bench = spawnSync(process.execPath, args, { stdio: 'inherit' })
if (scratch) rmSync(scratch, { recursive: true, force: true })
console.log(`\nBuilding took ${minutes(started, built)}, the bench ${minutes(built)}.`)
process.exitCode = bench.status ?? 1
