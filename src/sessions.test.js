import { test } from 'node:test'
import assert from 'node:assert/strict'
import { follow, wanting } from './sessions.js'

const run = (steps, view) => steps.map(([report, watched]) => (view = follow(view, report, watched)))

test('a session watched as it works and finishes leaves no mark and asks nothing', () => {
  const views = run([[{ status: 'idle', turns: 0 }, true], [{ status: 'working', turns: 0 }, true], [{ status: 'idle', turns: 1 }, true]])
  assert.deepEqual(views.map(v => v.mark), ['', 'working', ''])
  assert.ok(views.every(v => !v.attention))
})

test('a session that finishes while the user looks elsewhere is done, and asks once', () => {
  const views = run([
    [{ status: 'working', turns: 0 }, false],
    [{ status: 'idle', turns: 1 }, false],
    [{ status: 'idle', turns: 1 }, false],
    [{ status: 'idle', turns: 1 }, true],
  ])
  assert.deepEqual(views.map(v => v.mark), ['working', 'done', 'done', ''])
  assert.deepEqual(views.map(v => v.attention), [false, true, false, false])
})

test('a quick turn that started and ended between two polls still counts as done', () => {
  const [, view] = run([[{ status: 'idle', turns: 3 }, false], [{ status: 'idle', turns: 4 }, false]])
  assert.equal(view.mark, 'done')
  assert.ok(view.attention)
})

test('waiting on the user asks for attention only when they are not looking', () => {
  const away = run([[{ status: 'working' }, false], [{ status: 'waiting' }, false], [{ status: 'waiting' }, false], [{ status: 'working' }, false]])
  assert.deepEqual(away.map(v => v.mark), ['working', 'waiting', 'waiting', 'working'])
  assert.deepEqual(away.map(v => v.attention), [false, true, false, false])
  const here = run([[{ status: 'working' }, true], [{ status: 'waiting' }, true]])
  assert.equal(here[1].mark, 'waiting')
  assert.equal(here[1].attention, false)
})

test('a session with no report yet idles', () => {
  assert.deepEqual(follow(undefined, undefined, false), { mark: '', turns: 0, attention: false })
})

test('wanting counts sessions waiting or done', () => {
  assert.equal(wanting([{ mark: 'waiting' }, { mark: 'done' }, { mark: 'working' }, { mark: '' }]), 2)
})
