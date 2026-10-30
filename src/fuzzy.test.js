import { test } from 'node:test'
import assert from 'node:assert/strict'
import { match, scorePath, rank, terms } from './fuzzy.js'

test('letters must appear in order', () => {
  assert.equal(match('abc', 'a_b_c').positions.length, 3)
  assert.equal(match('acb', 'a_b_c'), null)
  assert.equal(match('', 'x').score, 0)
})

test('the tightest match wins over the first one', () => {
  // "ix" first matches the i of src... then the x of index; walking back finds index's i.
  const { positions } = match('ix', 'src/index.js')
  assert.deepEqual(positions, [4, 8])
})

test('word starts and runs score higher than scattered letters', () => {
  assert.ok(match('fb', 'file_browser').score > match('fb', 'afabric').score)
  assert.ok(match('main', 'main.rs').score > match('main', 'm_a_i_n.rs').score)
  assert.ok(match('qo', 'quickOpen').score > match('qo', 'quixotic').score)
})

test("a match in the file's name beats one spread over its folders", () => {
  const ts = terms('tabs')
  assert.ok(scorePath(ts, 'src/tabs.js').score > scorePath(ts, 'tests/abs/s.js').score)
})

test('every term must match, in any order', () => {
  assert.ok(scorePath(terms('rs main'), 'native/src/main.rs'))
  assert.equal(scorePath(terms('rs zzz'), 'native/src/main.rs'), null)
})

test('rank keeps the best, best first, and shorter paths break ties', () => {
  const paths = ['tests/fixtures/main.rs', 'src/main.rs', 'docs/readme.md', 'src/domain.rs']
  const top = rank('main', paths, { limit: 2 }).map(r => r.item)
  assert.deepEqual(top, ['src/main.rs', 'tests/fixtures/main.rs'])
})

test('an empty query puts boosted items first, then keeps the order', () => {
  const recent = new Set(['c'])
  const out = rank('', ['a', 'b', 'c', 'd'], { boost: i => (recent.has(i) ? 100 : 0), limit: 3 }).map(r => r.item)
  assert.deepEqual(out, ['c', 'a', 'b'])
})

test('a boost lifts a match above an otherwise equal one', () => {
  const out = rank('ab', ['x/ab.js', 'y/ab.js'], { boost: i => (i === 'y/ab.js' ? 50 : 0) }).map(r => r.item)
  assert.deepEqual(out, ['y/ab.js', 'x/ab.js'])
})

test('ranks 100k paths quickly', () => {
  const paths = Array.from({ length: 100_000 }, (_, i) => `pkg${i % 97}/src/module${i}/file_${i}.ts`)
  const t = performance.now()
  rank('mod12fil', paths)
  assert.ok(performance.now() - t < 1000)
})
