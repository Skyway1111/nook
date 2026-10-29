import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gitMarks } from './gitmarks.js'
import { pathsFor } from './paths.js'

const change = (path, kind) => ({ path, kind })

test('files, the folders above them, and untracked folders on Linux', () => {
  const mark = gitMarks({
    root: '/repo',
    changes: [change('src/a.js', 'M'), change('src/deep/b.js', 'A'), change('new/', '?'), change('gone.js', 'D'), change('c.js', 'U')],
  }, pathsFor(false))
  assert.equal(mark('/repo/src/a.js'), 'M')
  assert.equal(mark('/repo/src/deep/b.js'), 'A')
  assert.equal(mark('/repo/src'), 'dir')
  assert.equal(mark('/repo/src/deep'), 'dir')
  assert.equal(mark('/repo/new'), '?')
  assert.equal(mark('/repo/new/x/y.txt'), '?')
  assert.equal(mark('/repo/c.js'), 'U')
  assert.equal(mark('/repo/gone.js'), '')
  assert.equal(mark('/repo/other.js'), '')
  assert.equal(mark('/repo'), '')
  assert.equal(mark('/'), '')
  assert.equal(mark('/repo/SRC/a.js'), '') // case counts on Linux
})

test('Windows paths in any case', () => {
  const mark = gitMarks({ root: 'C:/Code/repo', changes: [change('src/A.js', 'M')] }, pathsFor(true))
  assert.equal(mark('C:\\Code\\repo\\src\\a.js'), 'M')
  assert.equal(mark('c:\\code\\REPO\\src'), 'dir')
  assert.equal(mark('C:\\Code'), '')
})

test('no repository, no marks', () => {
  assert.equal(gitMarks(null, pathsFor(false))('/x'), '')
  assert.equal(gitMarks({ error: 'no git' }, pathsFor(false))('/x'), '')
})
