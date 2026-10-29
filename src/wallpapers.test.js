// `npm test`: the living wallpapers' scenes, without a window. node --test runs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ROLES, SCENES, grid, hash, mirror, paint, put, render, stamp } from './wallpapers.js'

const SIZES = [[0, 0], [1, 1], [3, 2], [9, 4], [40, 12], [100, 30], [320, 90]]
const TIMES = [0, 0.1, 1.7, 33.3, 600, 86400.25]
const painted = g => g.roles.filter(Boolean).length

test('each scene has a CSS-safe id, a name, and a place in no other', () => {
  const ids = SCENES.map(s => s.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const s of SCENES) {
    assert.match(s.id, /^[a-z]+$/, 'an id is a bare CSS word, so --wallpaper takes it unquoted')
    assert.ok(s.name)
  }
  assert.ok(!ids.includes('none'), 'none means no scene')
})

test('every scene draws at every size and time, inside its grid, with known roles', () => {
  for (const { id } of SCENES) {
    for (const [cols, rows] of SIZES) {
      for (const t of TIMES) {
        const g = render(id, cols, rows, t)
        assert.equal(g.chars.length, cols * rows)
        assert.equal(g.roles.length, cols * rows)
        g.chars.forEach((ch, i) => {
          assert.equal([...ch].length, 1, `${id}: one character a cell`)
          if (ch === ' ') assert.equal(g.roles[i], null, `${id}: a blank cell has no role`)
          else assert.ok(ROLES.includes(g.roles[i]), `${id}: ${g.roles[i]} is a role`)
        })
      }
    }
  }
})

test('a frame depends only on the size and the time', () => {
  for (const { id } of SCENES) assert.deepEqual(render(id, 80, 24, 12.5), render(id, 80, 24, 12.5))
})

test('every scene moves', () => {
  for (const { id } of SCENES) {
    const a = render(id, 100, 30, 10)
    for (const dt of [0.1, 1]) assert.notDeepEqual(a.chars, render(id, 100, 30, 10 + dt).chars, `${id} after ${dt}s`)
  }
})

test('every scene shows something and stays a backdrop', () => {
  for (const { id } of SCENES) {
    for (const t of [0, 7, 42, 1234]) {
      const n = painted(render(id, 100, 30, t))
      assert.ok(n >= 20, `${id} at ${t}s paints ${n} cells`)
      assert.ok(n <= 3000 * 0.3, `${id} at ${t}s covers ${n} of 3000 cells, and would crowd Claude's text`)
    }
  }
})

test('an unknown scene, or none, paints nothing', () => {
  for (const id of ['none', 'nope', '', undefined]) assert.equal(painted(render(id, 40, 10, 3)), 0)
})

test('theme.css gives every role its color, and names every scene', () => {
  const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
  for (const role of ROLES) assert.match(css, new RegExp(`--wallpaper-${role}:`), role)
  for (const { id } of SCENES) assert.match(css, new RegExp(`\\b${id}\\b`), `theme.css's comment lists ${id}`)
  assert.match(css, /--wallpaper: none;/)
})

test('put clips to the grid and a space leaves a cell alone', () => {
  const g = grid(3, 2)
  put(g, -1, 0, 'x', 'ink')
  put(g, 3, 0, 'x', 'ink')
  put(g, 0, 2, 'x', 'ink')
  put(g, 1.4, 0.6, '#', 'ink')
  put(g, 1, 1, ' ', 'faint')
  assert.deepEqual(g.chars, [' ', ' ', ' ', ' ', '#', ' '])
  assert.deepEqual(g.roles, [null, null, null, null, 'ink', null])
})

test('a stamp is see-through where its sprite is blank, and can color by character', () => {
  const g = grid(4, 2)
  put(g, 1, 0, 'o', 'faint')
  stamp(g, 0, 0, ['a b', ' cd'], ch => (ch === 'd' ? 'warm' : 'leaf'))
  assert.equal(g.chars.join(''), 'aob  cd ')
  assert.deepEqual(g.roles, ['leaf', 'faint', 'leaf', null, null, 'leaf', 'warm', null])
})

test('a mirrored sprite faces the other way and turns about its middle', () => {
  assert.deepEqual(mirror(['><(((°>', '/\\']), ['<°)))><', '     /\\'])
  const sprite = [' ▐▛█', '(o_/ ']
  assert.deepEqual(mirror(mirror(sprite)), sprite.map(l => l.padEnd(5)))
})

test('hash is fixed, in [0, 1), and spread out', () => {
  assert.equal(hash(1, 2, 3), hash(1, 2, 3))
  const values = Array.from({ length: 2000 }, (_, i) => hash(7, i))
  for (const v of values) assert.ok(v >= 0 && v < 1)
  const mean = values.reduce((a, b) => a + b) / values.length
  assert.ok(Math.abs(mean - 0.5) < 0.03, `mean ${mean}`)
  assert.notEqual(hash(1, 2), hash(2, 1))
})

test('paint draws each painted cell once, at its cell, in its role color', () => {
  const calls = []
  const ctx = { canvas: { width: 50, height: 20 }, clearRect: (...a) => calls.push(['clear', ...a]), fillText: (ch, x, y) => calls.push([ctx.fillStyle, ch, x, y]) }
  const g = grid(5, 2)
  put(g, 0, 0, 'a', 'ink')
  put(g, 4, 1, 'b', 'warm')
  put(g, 2, 1, 'c', 'ink')
  paint(ctx, g, 10, 10, { ink: 'gray', warm: 'red' })
  assert.deepEqual(calls, [['clear', 0, 0, 50, 20], ['gray', 'a', 0, 0], ['gray', 'c', 20, 10], ['red', 'b', 40, 10]])
})
