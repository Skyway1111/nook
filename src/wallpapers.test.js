// `npm test`: the living wallpapers' scenes, without a window. node --test runs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HALO, HAZE, MIST, ROLES, SCENES, SHADOW, differs, ground, render, roleOf } from './wallpapers.js'

const SIZES = [[0, 0], [1, 1], [3, 2], [9, 4], [40, 12], [100, 30], [320, 90]]
const TIMES = [0, 0.1, 1.7, 33.3, 600, 86400.25]
const COLORS = Object.fromEntries(ROLES.map((r, i) => [r, [i * 20, 255 - i * 20, 128, 255]]))

test('each scene has a CSS-safe id, a name, and a place in no other', () => {
  const ids = SCENES.map(s => s.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const s of SCENES) {
    assert.match(s.id, /^[a-z]+$/, 'an id is a bare CSS word, so --wallpaper takes it unquoted')
    assert.ok(s.name)
  }
  assert.ok(!ids.includes('none'), 'none means no scene')
})

test('every scene draws at every size and time, inside its grid, in known roles, and stays a backdrop', () => {
  for (const s of SCENES) {
    for (const [cols, rows] of SIZES) {
      for (const t of TIMES) {
        const g = render(s.id, cols, rows, t)
        assert.equal(g.chars.length, cols * rows)
        assert.equal(g.looks.length, cols * rows)
        g.chars.forEach((ch, i) => {
          assert.equal([...ch].length, 1, `${s.id}: one character a cell`)
          if (g.looks[i]) assert.ok(ROLES.includes(roleOf(g.looks[i])) && (g.looks[i] & 15) <= SHADOW, `${s.id}: look ${g.looks[i]}`)
          else assert.equal(ch, ' ', `${s.id}: a blank cell has no character`)
        })
      }
      const sky = ground(s, cols, rows, COLORS)
      assert.equal(sky.length, cols * rows * 4)
      assert.ok(sky.every(Number.isFinite), `${s.id}: its ground`)
    }
    for (const t of [0, 7, 42, 1234]) {
      // Lights and shadows sit under Claude's text; tiles and characters crowd it.
      const g = render(s.id, 100, 30, t)
      const n = g.looks.filter(v => v && ![HALO, MIST, HAZE, SHADOW].includes(v & 15)).length
      assert.ok(n >= 20, `${s.id} at ${t}s paints ${n} cells`)
      assert.ok(n <= 3000 * 0.35, `${s.id} at ${t}s covers ${n} of 3000 cells, and would crowd Claude's text`)
    }
  }
})

test('a frame depends only on the size and the time, and a reused grid paints it the same', () => {
  for (const { id } of SCENES) {
    const reuse = render(id, 80, 30, 2)
    const again = render(id, 80, 30, 12.5, reuse)
    assert.equal(again, reuse)
    assert.deepEqual(again, render(id, 80, 30, 12.5))
  }
})

test('every scene moves, and from one frame to the next changes few of its cells', () => {
  // The wallpaper redraws only changed cells, so a scene that churned every cell would cost a full redraw a frame.
  for (const { id } of SCENES) {
    let changed = 0, frames = 0
    let last = render(id, 160, 50, 10)
    for (let t = 10.1; t < 16; t += 0.1, frames++) {
      const g = render(id, 160, 50, t)
      let step = 0
      for (let i = 0; i < g.chars.length; i++) if (differs(g, last, i)) step++
      assert.ok(step > 0 || frames % 10, `${id} holds still at ${t.toFixed(1)}s`)
      changed += step
      last = g
    }
    const share = changed / frames / (160 * 50)
    assert.ok(share < 0.06, `${id} changes ${(share * 100).toFixed(1)}% of its cells a frame`)
  }
})

test('theme.css gives every role its color, and names every scene', () => {
  const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
  for (const role of ROLES) assert.match(css, new RegExp(`--wallpaper-${role}:`), role)
  for (const { id } of SCENES) assert.match(css, new RegExp(`\\b${id}\\b`), `theme.css's comment lists ${id}`)
  assert.match(css, /--wallpaper: none;/)
})
