// `npm test`: which words in Claude's output are paths, and where each may be on disk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findPaths, candidates, fileUrl, diffLine, editedPath } from './linkify.js'
import { pathsFor } from './paths.js'

const win = pathsFor(true)
const nix = pathsFor(false)
const words = text => findPaths(text).map(f => text.slice(f.start, f.end))

test('paths in prose, with their lines and columns', () => {
  const text = 'The bug is in src/main.js:42:7, see also README.md and ./docs/themes.md.'
  assert.deepEqual(words(text), ['src/main.js:42:7', 'README.md', './docs/themes.md'])
  const [a, b, c] = findPaths(text)
  assert.deepEqual([a.path, a.line, a.col], ['src/main.js', 42, 7])
  assert.deepEqual([b.path, b.line], ['README.md', undefined])
  assert.equal(c.path, './docs/themes.md') // the sentence's full stop isn't part of it
})

test("Claude's tool calls name a whole path, spaces included", () => {
  assert.deepEqual(findPaths('⏺ Update(src/my file.js)').map(f => f.path), ['src/my file.js'])
  assert.deepEqual(findPaths('⏺ Read(native/src/pty.rs · lines 1-40)').map(f => f.path), ['native/src/pty.rs'])
  assert.deepEqual(findPaths('⏺ Write(/home/ada/x.txt)').map(f => f.path), ['/home/ada/x.txt'])
})

test('grep output, compiler output, and absolute paths on either system', () => {
  assert.deepEqual(words('src/tabs.js:12:  const x = 1'), ['src/tabs.js:12'])
  assert.deepEqual(findPaths('error at src/lib.rs(10,5): oops').map(f => [f.path, f.line, f.col]), [['src/lib.rs', 10, 5]])
  assert.deepEqual(words('open C:\\Users\\Ada\\notes.txt now'), ['C:\\Users\\Ada\\notes.txt'])
  assert.deepEqual(words('cat ~/notes.txt /etc/hosts'), ['~/notes.txt', '/etc/hosts'])
  assert.deepEqual(words('src/main.rs#L12'), ['src/main.rs#L12'])
})

test('URLs, numbers, and bare words are not paths', () => {
  assert.deepEqual(words('see https://example.com/a/b.html and v1.2.3, 3.14'), [])
  assert.deepEqual(words('Just some words here.'), [])
  assert.deepEqual(words('/'), [])
})

test('wide characters before a path keep its offsets in the string', () => {
  const text = '✻ 漢字 src/a.js'
  const [f] = findPaths(text)
  assert.equal(text.slice(f.start, f.end), 'src/a.js')
})

test('candidates: under the working folder, home, and without diff prefixes', () => {
  assert.deepEqual(candidates('src/a.js', { cwd: '/repo' }, nix), ['/repo/src/a.js'])
  assert.deepEqual(candidates('./src/../b.js', { cwd: '/repo' }, nix), ['/repo/b.js'])
  assert.deepEqual(candidates('b/src/a.js', { cwd: '/repo' }, nix), ['/repo/b/src/a.js', '/repo/src/a.js'])
  assert.deepEqual(candidates('~/x/y', { cwd: '/repo', home: '/home/ada' }, nix), ['/home/ada/x/y'])
  assert.deepEqual(candidates('/etc/hosts', { cwd: '/repo' }, nix), ['/etc/hosts'])
  assert.deepEqual(candidates('src/a.js', { cwd: 'C:\\repo' }, win), ['C:\\repo\\src\\a.js'])
  assert.deepEqual(candidates('c:/repo/a.js', { cwd: 'D:\\' }, win), ['C:\\repo\\a.js'])
  assert.deepEqual(candidates('a.js', {}, nix), [])
})

test('file URLs from OSC 8 links', () => {
  assert.deepEqual(fileUrl('file:///home/ada/a%20b.js#L12', nix), { path: '/home/ada/a b.js', line: 12 })
  assert.deepEqual(fileUrl('file:///C:/repo/a.js', win), { path: 'C:\\repo\\a.js', line: undefined })
})

test("a line number in Claude's diff, and the edit it belongs to", () => {
  assert.deepEqual(diffLine('      25 +    /// Twinkle'), { start: 6, end: 8, line: 25 })
  assert.deepEqual(diffLine('  ⎿  12 -  old'), { start: 5, end: 7, line: 12 })
  assert.deepEqual(diffLine('      24'), null) // a blank context row has no code to point at
  assert.equal(diffLine('  1. a numbered list'), null)
  assert.equal(editedPath('● Update(C:\\Projects\\starfall\\src\\sky.rs)'), 'C:\\Projects\\starfall\\src\\sky.rs')
  assert.equal(editedPath('● Read(src/a.js)'), null)
})
