// `npm test`: path rules for Windows and for Linux, whichever system runs the tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathsFor } from './paths.js'

const win = pathsFor(true)
const nix = pathsFor(false)

test('Windows paths ignore case and climb from a folder to its drive to the drive list', () => {
  assert.ok(win.same('C:\\Users\\Ada', 'c:\\users\\ADA'))
  assert.deepEqual(['C:\\Users\\Ada', 'C:\\Users', 'C:\\', ''].map(win.parent), ['C:\\Users', 'C:\\', '', null])
  assert.equal(win.normalize(' "c:/Users/Ada/" '), 'C:\\Users\\Ada')
  assert.equal(win.normalize('d:'), 'D:\\')
  assert.deepEqual(['', 'C:\\', 'C:\\Users\\Ada'].map(win.basename), ['This PC', 'C:', 'Ada'])
  assert.equal(win.join('C:\\', 'Users', 'Ada'), 'C:\\Users\\Ada')
  assert.equal(win.join('', 'C:\\'), 'C:\\')
  assert.ok(win.within('c:\\users\\ada\\x', 'C:\\Users\\Ada') && win.within('C:\\x', 'C:\\'))
  assert.ok(!win.within('C:\\Users\\Adam', 'C:\\Users\\Ada'))
  assert.ok(win.isAbsolute('C:/x') && !win.isAbsolute('fonts\\a.woff2'))
  assert.equal(win.fromSlashes('C:\\repo', 'src/new/'), 'C:\\repo\\src\\new')
  assert.ok(win.badName.test('a:b') && !win.badName.test('a b'))
})

test('Linux paths keep case and climb to the root, the top', () => {
  assert.ok(!nix.same('/home/ada', '/home/Ada'))
  assert.deepEqual(['/home/ada', '/home', '/', ''].map(nix.parent), ['/home', '/', null, null])
  assert.equal(nix.normalize(' "/home//ada/" '), '/home/ada')
  assert.deepEqual(['/', '', '"/"'].map(nix.normalize), ['/', '', '/'])
  assert.deepEqual(['', '/', '/home/ada'].map(nix.basename), ['Computer', '/', 'ada'])
  assert.equal(nix.join('/', 'home', 'ada'), '/home/ada')
  assert.ok(nix.within('/home/ada/x', '/home/ada') && nix.within('/etc', '/'))
  assert.ok(!nix.within('/home/adam', '/home/ada') && !nix.within('/home/Ada/x', '/home/ada'))
  assert.ok(nix.isAbsolute('/x') && !nix.isAbsolute('fonts/a.woff2'))
  assert.equal(nix.fromSlashes('/repo', 'src/new/'), '/repo/src/new')
  assert.ok(nix.badName.test('a/b') && !nix.badName.test('a:b*?'))
})

test('a file URL resolves a relative link beside the file on either system', () => {
  for (const [p, file, want] of [[win, 'C:\\notes\\a b.md', 'C:\\notes\\pics\\c d.png'], [nix, '/notes/a b.md', '/notes/pics/c d.png']]) {
    assert.equal(p.fromUrl(new URL('pics/c%20d.png', p.toUrl(file)).pathname), want)
  }
})

test('a file and its picked lines read as Claude\'s @ mention, relative to the session when inside it', () => {
  assert.equal(nix.mention('/work/src/app.js', '/work', [5, 9]), '@src/app.js#L5-9')
  assert.equal(nix.mention('/work/src/app.js', '/work/', [5, 5]), '@src/app.js#L5')
  assert.equal(nix.mention('/work/my notes.txt', '/work', [2, 3]), '@"my notes.txt"#L2-3')
  assert.equal(nix.mention('/elsewhere/a.js', '/work', null), '@/elsewhere/a.js')
  assert.equal(nix.mention('/workshop/a.js', '/work', [1, 2]), '@/workshop/a.js#L1-2')
  assert.equal(win.mention('c:\\Repo\\src\\a.rs', 'C:\\repo', [3, 4]), '@src\\a.rs#L3-4')
})
