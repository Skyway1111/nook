import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareNames, sortEntries } from './order.js'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

test('numbers in names order by value, case is ignored', () => {
  const names = ['file10.txt', 'File2.txt', 'file1.txt', 'file02.txt', 'a', 'B', '_x', '.git', '0', 'z9', 'z10']
  assert.deepEqual(names.slice().sort(compareNames), names.slice().sort(collator.compare))
  assert.ok(compareNames('file2', 'file10') < 0)
  assert.equal(compareNames('README.md', 'readme.md'), 0)
  assert.equal(compareNames('v01', 'v1'), 0)
})

test('agrees with the collator on random names', () => {
  // Characters picked to collide: digits, letters of both cases, and the punctuation file names use.
  const alphabet = '0123456789aAbBzZ _-.~()[]!@#$%^&+=,;\''
  let seed = 7
  const rand = n => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n)
  const name = () => Array.from({ length: 1 + rand(8) }, () => alphabet[rand(alphabet.length)]).join('')
  for (let k = 0; k < 20_000; k++) {
    const [a, b] = [name(), name()]
    assert.equal(compareNames(a, b), Math.sign(collator.compare(a, b)), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
  }
})

test('names outside ASCII go to the collator', () => {
  assert.equal(compareNames('école', 'Ecole'), 0)
  assert.ok(compareNames('ä1', 'a2') < 0)
})

test('sorts a folder of 50,000 files as the collator does, and faster', () => {
  const entries = Array.from({ length: 50_000 }, (_, i) => ({ name: `f${(i * 7919) % 50_000}.txt`, dir: false }))
    .concat(Array.from({ length: 200 }, (_, i) => ({ name: `Sub${i}`, dir: true })), [{ name: 'F7.TXT', dir: false }])
  const want = entries.slice().sort((a, b) => b.dir - a.dir || collator.compare(a.name, b.name))
  sortEntries(entries.slice(0, 1000)) // warm up
  const t = performance.now()
  const got = sortEntries(entries)
  const took = performance.now() - t
  assert.ok(got.every((e, i) => e === want[i]))
  assert.equal(got[0].name, 'Sub0')
  assert.ok(took < 250, `${took} ms`)
})

test('a name outside ASCII sorts the whole folder by the collator', () => {
  const entries = [{ name: 'b' }, { name: 'é' }, { name: 'a', dir: true }, { name: 'E' }]
  assert.deepEqual(sortEntries(entries).map(e => e.name), ['a', 'b', 'é', 'E']) // é and E rank equal, so they keep their order
})
