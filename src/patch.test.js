// `npm test`: diff parsing, and partial staging, unstaging, and discarding run against real git.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseDiff, patch, applyArgs, changedRanges } from './patch.js'

/** A fresh repository, and git in it. `git(args, input)` returns stdout. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'nook-patch-'))
  const git = (args, input) => execFileSync('git', ['-c', 'user.name=nook', '-c', 'user.email=nook@example.com', ...args], { cwd: dir, input, encoding: 'utf8' })
  git(['init', '-q', '-b', 'main'])
  const write = (name, text) => writeFileSync(join(dir, name), text)
  const read = name => readFileSync(join(dir, name), 'utf8')
  const diff = (...args) => git(['diff', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', ...args])
  return { dir, git, write, read, diff, done: () => rmSync(dir, { recursive: true, force: true }) }
}
const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`)
/** Picks the changed lines whose text is in `texts`. */
const only = (hunk, ...texts) => i => texts.includes(hunk.lines[i].text)

test('parses edits, renames, new and deleted files, binaries, and a missing final newline', () => {
  const text = [
    'diff --git a/src/a.rs b/src/a.rs', 'index 1..2 100644', '--- a/src/a.rs', '+++ b/src/a.rs',
    '@@ -1,3 +1,3 @@ fn main() {', ' one', '-two', '+deux', ' three',
    'diff --git a/old name.md b/new name.md', 'similarity index 90%', 'rename from old name.md', 'rename to new name.md',
    'diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1 @@', '+only', '\\ No newline at end of file',
    'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b',
    'diff --git a/p.png b/p.png', 'Binary files a/p.png and b/p.png differ',
    'diff --git a/x.bin b/x.bin', 'new file mode 100644', '--- /dev/null', '+++ b/x.bin', "\\ nook can't show this file: it isn't text",
    '\\ nook left out 4 more untracked files', '',
  ].join('\n')
  const files = parseDiff(text)
  assert.deepEqual(files.map(f => [f.path, f.from, f.added, f.removed, f.notes]), [
    ['src/a.rs', null, 1, 1, []],
    ['new name.md', 'old name.md', 0, 0, []],
    ['n.txt', null, 1, 0, []],
    ['gone.txt', null, 0, 2, []],
    ['p.png', null, 0, 0, ['Binary file']],
    ['x.bin', null, 0, 0, ["nook can't show this file: it isn't text"]],
  ])
  assert.deepEqual(files.notes, ['left out 4 more untracked files'])
  const [h] = files[0].hunks
  assert.deepEqual([h.oldStart, h.oldCount, h.newStart, h.newCount, h.title], [1, 3, 1, 3, 'fn main() {'])
  assert.deepEqual(files[2].hunks[0], { oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, title: '', lines: [{ t: '+', text: 'only' }, { t: '\\', text: ' No newline at end of file' }] })
})

test('reads a quoted path with spaces and non-ASCII characters', () => {
  const [f] = parseDiff('diff --git "a/caf\\303\\251 x" "b/caf\\303\\251 x"\n--- "a/caf\\303\\251 x"\n+++ "b/caf\\303\\251 x"\n@@ -1 +1 @@\n-a\n+b\n')
  assert.equal(f.path, 'café x')
})

test('stages, unstages, and discards single lines of a hunk', () => {
  const r = repo()
  try {
    r.write('f.txt', lines(8).join('\n') + '\n')
    r.git(['add', '.'])
    r.git(['commit', '-qm', 'base'])
    const edited = lines(8)
    edited[2] = 'THREE'
    edited[4] = 'FIVE'
    edited.splice(6, 0, 'new after six')
    r.write('f.txt', edited.join('\n') + '\n')

    // Stage the THREE edit alone.
    let [file] = parseDiff(r.diff())
    let [hunk] = file.hunks
    let p = patch(file, hunk, only(hunk, 'line 3', 'THREE'))
    r.git(applyArgs(p, { cached: true }), p)
    assert.match(r.diff('--cached'), /-line 3\n\+THREE\n/)
    assert.doesNotMatch(r.diff('--cached'), /FIVE|new after six/)
    assert.match(r.diff(), /-line 5\n\+FIVE/)

    // Stage the rest, then unstage just the added line.
    ;[file] = parseDiff(r.diff())
    p = patch(file, file.hunks[0])
    r.git(applyArgs(p, { cached: true }), p)
    ;[file] = parseDiff(r.diff('--cached'))
    ;[hunk] = file.hunks
    p = patch(file, hunk, only(hunk, 'new after six'), true)
    r.git(applyArgs(p, { cached: true, reverse: true }), p)
    assert.doesNotMatch(r.diff('--cached'), /new after six/)
    assert.match(r.diff('--cached'), /\+THREE[\s\S]*\+FIVE/)

    // Discard FIVE from the working tree; THREE and the added line stay.
    r.git(['reset', '-q'])
    ;[file] = parseDiff(r.diff())
    ;[hunk] = file.hunks
    p = patch(file, hunk, only(hunk, 'line 5', 'FIVE'), true)
    r.git(applyArgs(p, { reverse: true }), p)
    const text = r.read('f.txt')
    assert.match(text, /THREE/)
    assert.match(text, /line 5/)
    assert.match(text, /new after six/)
    assert.doesNotMatch(text, /FIVE/)
  } finally {
    r.done()
  }
})

test('stages part of a new file and part of a deletion', () => {
  const r = repo()
  try {
    r.write('keep.txt', 'k\n')
    r.write('gone.txt', 'a\nb\nc\n')
    r.git(['add', '.'])
    r.git(['commit', '-qm', 'base'])
    // An untracked file, as git.rs shows one.
    r.write('new.txt', 'x\ny\nz')
    const synthetic = 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,3 @@\n+x\n+y\n+z\n\\ No newline at end of file\n'
    let [file] = parseDiff(synthetic)
    let p = patch(file, file.hunks[0], only(file.hunks[0], 'x', 'z'))
    r.git(applyArgs(p, { cached: true }), p)
    assert.equal(r.git(['show', ':new.txt']), 'x\nz')

    // Stage removing only b from a deleted file: the index keeps a and c.
    rmSync(join(r.dir, 'gone.txt'))
    ;[file] = parseDiff(r.diff('--', 'gone.txt'))
    p = patch(file, file.hunks[0], only(file.hunks[0], 'b'))
    assert.doesNotMatch(p, /deleted file mode/)
    r.git(applyArgs(p, { cached: true }), p)
    assert.equal(r.git(['show', ':gone.txt']), 'a\nc\n')

    // Unstage part of a staged new file: it stays added, with fewer lines.
    r.write('two.txt', '1\n2\n')
    r.git(['add', 'two.txt'])
    ;[file] = parseDiff(r.diff('--cached', '--', 'two.txt'))
    p = patch(file, file.hunks[0], only(file.hunks[0], '2'), true)
    r.git(applyArgs(p, { cached: true, reverse: true }), p)
    assert.equal(r.git(['show', ':two.txt']), '1\n')
  } finally {
    r.done()
  }
})

test('a hunk with no context applies with --unidiff-zero', () => {
  const r = repo()
  try {
    r.write('one.txt', 'a\n')
    r.git(['add', '.'])
    r.git(['commit', '-qm', 'base'])
    r.write('one.txt', 'b\n')
    r.git(['add', '.'])
    // Unstage the addition alone: the removal stays staged, and nothing is left to place it by.
    const [file] = parseDiff(r.diff('--cached'))
    const [hunk] = file.hunks
    const p = patch(file, hunk, only(hunk, 'b'), true)
    assert.ok(applyArgs(p, { cached: true, reverse: true }).includes('--unidiff-zero'))
    r.git(applyArgs(p, { cached: true, reverse: true }), p)
    assert.equal(r.git(['show', ':one.txt']), '')
    assert.equal(patch(file, hunk, () => false), null)
  } finally {
    r.done()
  }
})

test('marks the changed words of a paired removal and addition', () => {
  const ls = [
    { t: ' ', text: 'fn x() {' },
    { t: '-', text: '    let total = a + b;' },
    { t: '-', text: 'completely different words here' },
    { t: '+', text: '    let total = a * b;' },
    { t: '+', text: 'nothing alike at all, really' },
  ]
  const m = changedRanges(ls)
  assert.deepEqual(m.get(1), [18, 19])
  assert.deepEqual(m.get(3), [18, 19])
  assert.ok(!m.has(2) && !m.has(4))
})
