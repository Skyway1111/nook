// `npm test`: progress read from the lines git writes while it syncs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { progressOf } from './progress.js'

test('reads how far along a pull is, and never moves back', () => {
  let done = 0
  const seen = []
  for (const line of [
    'remote: Enumerating objects: 273, done.',
    'remote: Counting objects:  50% (10/20)',
    'remote: Compressing objects: 100% (12/12), done.',
    'Receiving objects:  40% (110/273), 1.2 MiB | 2.0 MiB/s',
    'Receiving objects: 100% (273/273), 3.1 MiB | 2.0 MiB/s, done.',
    'Resolving deltas:   0% (0/90)',
    'Resolving deltas:  50% (45/90)',
    'remote: Counting objects:  10% (2/20)',
    'From github.com:me/nook',
  ]) {
    ;({ done } = progressOf(line, done))
    seen.push(Math.round(done * 100))
  }
  assert.deepEqual(seen, [0, 3, 10, 40, 85, 85, 93, 93, 93])
})

test('reads a push, and keeps the line it was given', () => {
  assert.deepEqual(progressOf('Writing objects:  50% (3/6), 1.00 KiB'), { line: 'Writing objects:  50% (3/6), 1.00 KiB', done: 0.525 })
})
