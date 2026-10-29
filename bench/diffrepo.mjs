// Makes a repository with a large diff for `bench/linux.mjs --repo`: 30 files of 400 lines each with every
// fifth line edited, half of them staged, and 5 untracked files. The same seedless text every time.
//   node bench/diffrepo.mjs <path>
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

const dir = resolve(process.argv[2] ?? 'nook-bench-repo')
rmSync(dir, { recursive: true, force: true })
mkdirSync(join(dir, 'src'), { recursive: true })
const git = (...args) => execFileSync('git', ['-c', 'user.name=nook', '-c', 'user.email=nook@example.com', ...args], { cwd: dir })
const source = (f, edit) => Array.from({ length: 400 }, (_, i) =>
  i % 5 === 0 && edit ? `  const value${i} = compute(${f}, ${i} * 2) // tuned` : `  const value${i} = compute(${f}, ${i})`)
const file = (f, edit) => `export function part${f}() {\n${source(f, edit).join('\n')}\n}\n`
git('init', '-q', '-b', 'main')
for (let f = 0; f < 30; f++) writeFileSync(join(dir, 'src', `part${f}.js`), file(f, false))
git('add', '.')
git('commit', '-qm', 'base')
for (let f = 0; f < 30; f++) writeFileSync(join(dir, 'src', `part${f}.js`), file(f, true))
git('add', ...Array.from({ length: 15 }, (_, f) => `src/part${f}.js`))
for (let f = 0; f < 5; f++) writeFileSync(join(dir, `new${f}.js`), file(100 + f, false))
console.log(dir)
