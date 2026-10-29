// `npm test`: blame parsed from real git, of a file and of unsaved text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UNCOMMITTED, parseBlame, runs, ages } from './blame.js'

test('reads which commit last changed each line, and lines not yet committed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nook-blame-'))
  const git = (args, input, who = 'Ada Lovelace') =>
    execFileSync('git', ['-c', `user.name=${who}`, '-c', 'user.email=ada@example.com', ...args], { cwd: dir, input, encoding: 'utf8' })
  try {
    git(['init', '-q', '-b', 'main'])
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    git(['add', '.'])
    git(['commit', '-qm', 'First'])
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    git(['commit', '-qam', 'Shout two'], undefined, 'Grace Hopper')
    // As the editor asks: its unsaved text, with a line added.
    const { lines, commits } = parseBlame(git(['blame', '--porcelain', '--contents', '-', '--', 'a.txt'], 'one\nTWO\nnew\nthree\n'))
    const [first, second] = [lines[0], lines[1]].map(oid => commits.get(oid))
    assert.equal(first.summary, 'First')
    assert.equal(first.author, 'Ada Lovelace')
    assert.equal(first.email, 'ada@example.com')
    assert.equal(second.summary, 'Shout two')
    assert.equal(second.author, 'Grace Hopper')
    assert.equal(lines[2], UNCOMMITTED)
    assert.equal(lines[3], lines[0])
    assert.equal(lines.length, 4)
    assert.ok(first.time > 1.7e9)
    assert.deepEqual(runs(lines).map(r => [r.from, r.to]), [[1, 1], [2, 2], [3, 3], [4, 4]])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('groups runs of lines from one commit, and ranks commits by age', () => {
  assert.deepEqual(runs(['a', 'a', 'b', 'a', 'a']), [
    { from: 1, to: 2, oid: 'a' },
    { from: 3, to: 3, oid: 'b' },
    { from: 4, to: 5, oid: 'a' },
  ])
  const commits = new Map([['a', { oid: 'a', time: 10 }], ['b', { oid: 'b', time: 30 }], ['c', { oid: 'c', time: 20 }]])
  assert.deepEqual([...ages(commits)], [['a', 0], ['c', 0.5], ['b', 1], [UNCOMMITTED, 1]])
})
