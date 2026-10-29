// `npm test`: git log parsing and the history graph's lanes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LOG_FORMAT, parseLog, parseRefs, layout } from './graph.js'

const commit = (oid, ...parents) => ({ oid, parents })

test('reads git log from a real repository, with its branches and tags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nook-graph-'))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Ada Lovelace', '-c', 'user.email=ada@example.com', ...args], { cwd: dir, encoding: 'utf8' })
  try {
    git('init', '-q', '-b', 'main')
    for (const [name, branch] of [['one'], ['two'], ['three', 'feat']]) {
      if (branch) git('switch', '-q', '-c', branch)
      writeFileSync(join(dir, name), name)
      git('add', '.')
      git('commit', '-qm', `Add ${name}\n\nThe body.`)
    }
    git('tag', 'v1')
    git('switch', '-q', 'main')
    const log = parseLog(git('log', `--format=${LOG_FORMAT}`, '--decorate=full', '--parents', '--date-order', '--branches', '--tags', 'HEAD'))
    assert.deepEqual(log.map(c => c.subject), ['Add three', 'Add two', 'Add one'])
    assert.deepEqual(log[0].refs, [{ name: 'feat', kind: 'branch' }, { name: 'v1', kind: 'tag' }])
    assert.deepEqual(log[1].refs, [{ name: 'main', kind: 'head' }])
    assert.equal(log[1].parents[0], log[2].oid)
    assert.deepEqual(log[2].parents, [])
    assert.equal(log[0].author, 'Ada Lovelace')
    assert.ok(log[0].time > 1.7e9)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('names remotes and a detached HEAD, and leaves out origin/HEAD', () => {
  assert.deepEqual(parseRefs('refs/remotes/origin/HEAD, refs/remotes/origin/main, HEAD, tag: refs/tags/v2.0'), [
    { name: 'HEAD', kind: 'detached' },
    { name: 'v2.0', kind: 'tag' },
    { name: 'origin/main', kind: 'remote' },
  ])
})

test('a straight line stays in one lane', () => {
  const log = [commit('c', 'b'), commit('b', 'a'), commit('a')]
  assert.deepEqual(layout(log).lanes, [])
  assert.deepEqual(log.map(c => c.col), [0, 0, 0])
  assert.deepEqual(log[1].edges, [[0, 0, 0, 1, 0], [0, 1, 0, 2, 0]])
  assert.deepEqual(log[2].edges, [[0, 0, 0, 1, 0]])
})

test('a merge opens a lane for its second parent, and the fork point closes it', () => {
  // m merges f into main; f and b both come from a.
  const log = [commit('m', 'b', 'f'), commit('f', 'a'), commit('b', 'a'), commit('a')]
  layout(log)
  assert.deepEqual(log.map(c => c.col), [0, 1, 0, 0])
  assert.deepEqual(log[0].edges, [[0, 1, 0, 2, 0], [0, 1, 1, 2, 1]])
  // f passes main's lane by, and waits for a in its own.
  assert.deepEqual(log[1].edges, [[0, 0, 0, 2, 0], [1, 0, 1, 1, 1], [1, 1, 1, 2, 1]])
  // a: both lanes end in its dot.
  assert.deepEqual(log[3].edges, [[0, 0, 0, 1, 0], [1, 0, 0, 1, 1]])
  assert.deepEqual(log.map(c => c.width), [2, 2, 2, 2])
})

test('a branch tip takes a free lane, and a page carries on from the one before', () => {
  const page1 = [commit('x', 'a'), commit('y', 'b')]
  const state = layout(page1)
  assert.deepEqual(state.lanes, ['a', 'b'])
  assert.deepEqual(page1.map(c => c.col), [0, 1])
  const page2 = [commit('b', 'a'), commit('a')]
  assert.deepEqual(layout(page2, state).lanes, [])
  assert.deepEqual(page2.map(c => c.col), [1, 0])
  // b's lane now waits for a too, so a joins both.
  assert.deepEqual(page2[1].edges, [[0, 0, 0, 1, 0], [1, 0, 0, 1, 1]])
})

test('a lane freed above is reused by the next tip', () => {
  const log = [commit('p', 'a'), commit('q', 'a'), commit('a'), commit('z', 'y'), commit('y')]
  layout(log)
  assert.deepEqual(log.map(c => c.col), [0, 1, 0, 0, 0])
})

test('a parent written before its child, by a clock set wrong, leaves no lane waiting for it', () => {
  const log = [commit('b', 'a'), commit('a'), commit('c', 'a', 'b')]
  assert.deepEqual(layout(log).lanes, [])
  assert.deepEqual(log[2].edges, [])
})
