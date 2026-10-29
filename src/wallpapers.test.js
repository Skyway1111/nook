// `npm test`: the living wallpapers' scenes, without a window. node --test runs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ROLES, SCENES, differs, grid, hash, mirror, paint, put, render, stamp } from './wallpapers.js'

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

/** A canvas context that logs its calls, and an atlas that hands out a tile per character and role, 10 pixels
 * apart, with `spill` pixels below each cell. */
function recorder(spill = 0) {
  const calls = []
  const ctx = {
    canvas: { width: 50, height: 20 },
    clearRect: (...a) => calls.push(['clear', ...a]),
    drawImage: (_, sx, sy, sw, sh, x, y) => calls.push([tiles.names[Math.floor(sy / 100)] + (sy % 100 ? '↓' : ''), x, y, sh]),
  }
  const tiles = {
    canvas: {},
    names: [],
    spill,
    at(ch, role) {
      const name = `${role}:${ch}`
      if (!tiles.names.includes(name)) tiles.names.push(name)
      return [0, tiles.names.indexOf(name) * 100]
    },
  }
  return { calls, ctx, tiles }
}

test('paint draws each painted cell once, at its cell, from its tile', () => {
  const { calls, ctx, tiles } = recorder(3)
  const g = grid(5, 2)
  put(g, 0, 0, 'a', 'ink')
  put(g, 4, 1, 'b', 'warm')
  put(g, 2, 1, 'c', 'ink')
  assert.equal(paint(ctx, g, 10, 10, tiles), 3)
  assert.deepEqual(calls, [['clear', 0, 0, 50, 20], ['ink:a', 0, 0, 13], ['ink:c', 20, 10, 13], ['warm:b', 40, 10, 13]])
})

test('given the last frame, paint touches only the cells that changed', () => {
  const { calls, ctx, tiles } = recorder()
  const last = grid(5, 2)
  put(last, 0, 0, 'a', 'ink')
  put(last, 1, 0, 'b', 'ink')
  put(last, 2, 0, 'c', 'ink')
  const g = grid(5, 2)
  put(g, 0, 0, 'a', 'ink') // the same
  put(g, 1, 0, 'b', 'warm') // a new color
  put(g, 3, 1, 'd', 'ink') // new; and c is gone
  assert.equal(paint(ctx, g, 10, 10, tiles, last), 3)
  assert.deepEqual(calls, [['clear', 10, 0, 10, 10], ['warm:b', 10, 0, 10], ['clear', 20, 0, 10, 10], ['clear', 30, 10, 10, 10], ['ink:d', 30, 10, 10]])
  calls.length = 0
  assert.equal(paint(ctx, g, 10, 10, tiles, g), 0)
  assert.deepEqual(calls, [])
  // A grid of another size is drawn whole.
  assert.equal(paint(ctx, grid(4, 2), 10, 10, tiles, g), 0)
  assert.deepEqual(calls, [['clear', 0, 0, 50, 20]])
})

test('a glyph that reaches into the cell below is redrawn there without drawing a pixel twice', () => {
  const { calls, ctx, tiles } = recorder(3)
  const last = grid(2, 2)
  put(last, 0, 0, '_', 'ink')
  put(last, 0, 1, 'x', 'ink')
  put(last, 1, 0, 'y', 'ink')
  const g = grid(2, 2)
  put(g, 0, 0, '-', 'ink') // changed: the cell under it is redrawn too, for what _ left there
  put(g, 0, 1, 'x', 'ink')
  put(g, 1, 0, 'y', 'ink')
  put(g, 1, 1, 'z', 'ink') // changed alone: what y reaches into it comes back
  assert.equal(paint(ctx, g, 10, 10, tiles, last), 3)
  assert.deepEqual(calls, [
    ['clear', 0, 0, 10, 10], ['ink:-', 0, 0, 10],
    ['clear', 0, 10, 10, 10], ['ink:x', 0, 10, 10], ['ink:-↓', 0, 10, 3],
    ['clear', 10, 10, 10, 10], ['ink:z', 10, 10, 10], ['ink:y↓', 10, 10, 3],
  ])
})

test('a reused grid comes back blank, and a frame drawn into one matches a fresh one', () => {
  for (const { id } of SCENES) {
    const reuse = render(id, 80, 30, 2)
    const again = render(id, 80, 30, 5.5, reuse)
    assert.equal(again, reuse)
    assert.deepEqual(again, render(id, 80, 30, 5.5))
  }
  const g = grid(3, 1)
  put(g, 1, 0, 'x', 'ink')
  assert.equal(differs(g, grid(3, 1), 1), true)
  assert.equal(differs(g, grid(3, 1), 0), false)
  assert.notEqual(grid(4, 1, g), g)
})

test('from one frame to the next, a scene changes few of its cells', () => {
  // The wallpaper redraws only changed cells, so a scene that churned every cell would cost what it used to.
  for (const { id } of SCENES) {
    let changed = 0, frames = 0
    let last = render(id, 160, 50, 10)
    for (let t = 10.1; t < 16; t += 0.1, frames++) {
      const g = render(id, 160, 50, t)
      for (let i = 0; i < g.chars.length; i++) if (differs(g, last, i)) changed++
      last = g
    }
    const share = changed / frames / (160 * 50)
    assert.ok(share < 0.06, `${id} changes ${(share * 100).toFixed(1)}% of its cells a frame`)
  }
})
