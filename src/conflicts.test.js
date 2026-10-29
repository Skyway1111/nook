// `npm test`: conflicts read from a real merge, and settled one at a time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseConflicts, isConflict, resolve } from './conflicts.js'

/** A repository where merging `theirs` into main conflicts in f.txt. */
function conflicted(style) {
  const dir = mkdtempSync(join(tmpdir(), 'nook-conflicts-'))
  const git = (...args) => {
    try {
      return execFileSync('git', ['-c', 'user.name=nook', '-c', 'user.email=nook@example.com', '-c', `merge.conflictStyle=${style}`, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
    } catch (e) {
      return e.stdout
    }
  }
  const write = text => writeFileSync(join(dir, 'f.txt'), text)
  git('init', '-q', '-b', 'main')
  write('a\nb\nc\nd\nf\ng\nh\ni\nj\ne\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('switch', '-qc', 'theirs')
  write('a\nB2\nc\nd\nf\ng\nh\ni\nj\nE2\n')
  git('commit', '-qam', 'theirs')
  git('switch', '-q', 'main')
  write('a\nB1\nc\nd\nf\ng\nh\ni\nj\n')
  git('commit', '-qam', 'ours')
  git('merge', 'theirs')
  return { dir, text: readFileSync(join(dir, 'f.txt'), 'utf8'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('reads the conflicts of a real merge, and settles each in turn', () => {
  const r = conflicted('merge')
  try {
    const parts = parseConflicts(r.text)
    const conflicts = parts.filter(isConflict)
    assert.equal(conflicts.length, 2)
    assert.deepEqual([conflicts[0].ours, conflicts[0].theirs, conflicts[0].base], [['B1'], ['B2'], null])
    assert.deepEqual([conflicts[1].ours, conflicts[1].theirs], [[], ['E2']])
    assert.equal(conflicts[0].oursLabel, 'HEAD')
    assert.equal(conflicts[0].theirsLabel, 'theirs')
    assert.equal(conflicts[0].line, 2)
    // Settling the first leaves the second as git wrote it.
    const once = resolve(parts, 'theirs', 0)
    assert.equal(once, r.text.replace(/<<<<<<< HEAD\nB1\n=======\nB2\n>>>>>>> theirs\n/, 'B2\n'))
    const twice = parseConflicts(once)
    assert.equal(twice.filter(isConflict).length, 1)
    assert.equal(resolve(twice, 'ours', 0), 'a\nB2\nc\nd\nf\ng\nh\ni\nj\n')
    assert.equal(resolve(twice, 'both', 0), 'a\nB2\nc\nd\nf\ng\nh\ni\nj\nE2\n')
    // Every conflict at once.
    assert.equal(resolve(parts, 'ours'), 'a\nB1\nc\nd\nf\ng\nh\ni\nj\n')
  } finally {
    r.done()
  }
})

test('reads the common ancestor git writes with diff3', () => {
  const r = conflicted('diff3')
  try {
    const [first] = parseConflicts(r.text).filter(isConflict)
    assert.deepEqual(first.base, ['b'])
    assert.equal(resolve(parseConflicts(r.text), 'base', 0).split('\n')[1], 'b')
  } finally {
    r.done()
  }
})

test('keeps Windows line endings on the markers it writes back', () => {
  const text = 'a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\nz\r\n<<<<<<< HEAD\r\n1\r\n=======\r\n2\r\n>>>>>>> b\r\n'
  const parts = parseConflicts(text)
  assert.deepEqual(parts.filter(isConflict).map(c => [c.ours, c.theirsLabel]), [[['x\r'], 'b'], [['1\r'], 'b']])
  assert.equal(resolve(parts, 'theirs', 0), text.replace('<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\n', 'y\r\n'))
})

test('leaves a marker that opens no conflict as text', () => {
  const text = 'x\n<<<<<<< HEAD\ny\n'
  assert.deepEqual(parseConflicts(text), [{ lines: ['x'] }, { lines: ['<<<<<<< HEAD', 'y', ''] }])
  assert.equal(resolve(parseConflicts(text), 'ours', 0), text)
})
