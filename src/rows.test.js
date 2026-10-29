import test from 'node:test'
import assert from 'node:assert/strict'
import { diffRows as rows, nearChanges as hunks } from './linediff.js'

test('rows number both sides and mark what changed', () => {
  const r = rows(['a', 'b', 'c'], ['a', 'B', 'c', 'd'])
  assert.deepEqual(r.map(x => `${x.t}${x.text}:${x.a}/${x.b}`), [' a:1/1', '-b:2/', '+B:/2', ' c:3/3', '+d:/4'])
})

test('hunks keep three lines around each change and drop the rest', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`)
  const after = before.map((l, i) => (i === 2 || i === 17 ? `${l}!` : l))
  const h = hunks(rows(before, after))
  assert.equal(h.length, 2)
  assert.deepEqual(h[0].map(r => r.text), ['l0', 'l1', 'l2', 'l2!', 'l3', 'l4', 'l5'])
  assert.equal(h[1].at(-1).text, 'l19')
})
