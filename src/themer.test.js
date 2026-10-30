import { test } from 'node:test'
import assert from 'node:assert/strict'
import { oklab, palette, roles, css, nameOf } from './themer.js'

/** RGBA pixels: `n` of each [r, g, b] given. */
const pixels = (...runs) => new Uint8Array(runs.flatMap(([n, rgb]) => Array.from({ length: n }, () => [...rgb, 255]).flat()))

test('oklab matches known values', () => {
  const [L] = oklab(255, 255, 255)
  assert.ok(Math.abs(L - 1) < 1e-3)
  const [L0, a0, b0] = oklab(0, 0, 0)
  assert.ok(L0 < 1e-6 && Math.abs(a0) < 1e-6 && Math.abs(b0) < 1e-6)
})

test('the palette finds a picture\'s colors, biggest first, and its mean lightness', () => {
  const pal = palette(pixels([600, [20, 30, 90]], [300, [240, 150, 40]], [100, [10, 10, 10]]))
  assert.equal(pal.colors.length > 2, true)
  const [first] = pal.colors
  assert.ok(first.share > 0.5)
  assert.ok(first.h > 230 && first.h < 290, `navy's hue, got ${first.h}`)
  assert.ok(pal.light > 0.2 && pal.light < 0.6)
  // The same picture makes the same palette.
  assert.deepEqual(palette(pixels([600, [20, 30, 90]], [300, [240, 150, 40]], [100, [10, 10, 10]])), pal)
})

test('roles: the main hue is the biggest colorful region and the accent is vivid', () => {
  const r = roles(palette(pixels([600, [20, 30, 90]], [300, [240, 150, 40]], [100, [10, 10, 10]])))
  assert.ok(r.main > 230 && r.main < 290)
  assert.ok(r.accent.h > 40 && r.accent.h < 90, `orange accent, got ${r.accent.h}`)
  assert.ok(r.accent.C >= 0.08 && r.accent.C <= 0.16)
  // Each ANSI color stays near its own hue.
  for (const [name, hue] of [['red', 22], ['green', 150], ['yellow', 85], ['blue', 255], ['magenta', 320], ['cyan', 205]]) {
    const d = Math.abs(((r.ansi[name] - hue + 540) % 360) - 180)
    assert.ok(d <= 17, `${name} moved ${d}`)
  }
})

test('a gray picture keeps nook\'s violet', () => {
  const r = roles(palette(pixels([500, [120, 120, 120]], [500, [30, 30, 30]])))
  assert.equal(r.main, 285)
})

test('css names both pictures and sets every main variable', () => {
  const text = css('Harbor', palette(pixels([600, [20, 30, 90]], [300, [240, 150, 40]])), 'picture.jpg', 'picture-soft.jpg')
  for (const v of ['--h', '--bg', '--accent', '--term-bg', '--term-fg', '--ansi-red', '--ansi-bright-cyan', '--claude-claude'])
    assert.match(text, new RegExp(`${v}:`), v)
  assert.match(text, /url\(picture\.jpg\)/)
  assert.match(text, /url\(picture-soft\.jpg\)/)
  assert.doesNotMatch(text, /NaN|undefined/)
})

test('a brighter picture gets a darker veil', () => {
  const veil = text => Number(/--term-bg:\s*linear-gradient\(oklch\([^/]+\/ ([\d.]+)\)/.exec(text)[1])
  const dark = css('d', palette(pixels([1000, [20, 20, 40]])), 'a', 'b')
  const bright = css('b', palette(pixels([1000, [240, 240, 220]])), 'a', 'b')
  assert.ok(veil(bright) > veil(dark))
})

test('nameOf keeps a file name\'s stem in plain characters', () => {
  assert.equal(nameOf('Lake Bled, at dawn (2).JPG'), 'Lake Bled at dawn 2')
  assert.equal(nameOf('../../etc.png'), 'etc')
  assert.equal(nameOf('%%%.png'), 'picture')
})
