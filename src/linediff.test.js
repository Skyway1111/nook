import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffLines, lineChanges } from './linediff.js'

const L = s => (s ? s.split('') : [])

test('lines added, changed and taken out', () => {
  assert.deepEqual(lineChanges(L('abc'), L('abc')), [])
  assert.deepEqual(lineChanges(L('abc'), L('aXbc')), [{ kind: 'add', from: 2, to: 2 }])
  assert.deepEqual(lineChanges(L('abc'), L('aXc')), [{ kind: 'change', from: 2, to: 2 }])
  assert.deepEqual(lineChanges(L('abc'), L('ac')), [{ kind: 'delete', at: 2 }])
  assert.deepEqual(lineChanges(L('abc'), L('ab')), [{ kind: 'delete', at: 3 }])
  assert.deepEqual(lineChanges(L('abc'), L('bc')), [{ kind: 'delete', at: 1 }])
  assert.deepEqual(lineChanges(L(''), L('ab')), [{ kind: 'add', from: 1, to: 2 }])
  assert.deepEqual(lineChanges(L('ab'), L('')), [{ kind: 'delete', at: 1 }])
  assert.deepEqual(lineChanges(L('abcdef'), L('aXcdeYZ')), [{ kind: 'change', from: 2, to: 2 }, { kind: 'change', from: 6, to: 7 }])
  assert.deepEqual(lineChanges(L('abcd'), L('aXYd')), [{ kind: 'change', from: 2, to: 3 }])
  assert.deepEqual(lineChanges(L('abab'), L('ab')), [{ kind: 'delete', at: 3 }])
})

/** The longest common subsequence's length, the slow way. */
function lcs(a, b) {
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1])
  return t[a.length][b.length]
}

test('the edit turns one into the other, and is as short as can be once no line anchors it', () => {
  let seed = 3
  const rand = n => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n)
  for (let k = 0; k < 5000; k++) {
    const a = Array.from({ length: rand(14) }, () => 'abcd'[rand(4)])
    const b = Array.from({ length: rand(14) }, () => 'abcd'[rand(4)])
    const runs = diffLines(a, b)
    const out = []
    let i = 0
    let kept = 0
    for (const [op, n] of runs) {
      if (op === '=') { out.push(...a.slice(i, i + n)); i += n; kept += n }
      else if (op === '-') i += n
      else out.push(...b.slice(out.length, out.length + n))
    }
    assert.equal(i, a.length)
    assert.deepEqual(out, b, `${a.join('')} → ${b.join('')}`)
    // A line once in each is kept, as git's patience diff keeps it, which now and then costs a shorter edit.
    const once = a.some(l => a.indexOf(l) === a.lastIndexOf(l) && b.indexOf(l) >= 0 && b.indexOf(l) === b.lastIndexOf(l))
    if (!once) assert.equal(kept, lcs(a, b), `${a.join('')} → ${b.join('')}`)
  }
})

test('past the limit, the middle counts as changed; a big file with a few edits is quick to redo as you type', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`)
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`)
  assert.deepEqual(lineChanges(['x', ...a, 'y'], ['x', ...b, 'y'], 100), [{ kind: 'change', from: 2, to: 3001 }])
  const big = Array.from({ length: 100_000 }, (_, i) => `line ${i % 977} ${i}`)
  const edited = big.slice()
  for (let i = 500; i < big.length; i += 5000) edited[i] = 'edited'
  edited.splice(70_000, 3)
  assert.equal(lineChanges(big, edited).length, 21) // keeps big's line ids
  edited[600] = 'typed'
  const t = performance.now()
  const found = lineChanges(big, edited)
  assert.equal(found.length, 22)
  assert.ok(performance.now() - t < 200, `${performance.now() - t} ms`)
})
