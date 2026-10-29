// Living wallpapers: scenes painted in characters behind a Claude tab, always moving. Each scene is a pure
// function of the grid's size and the time in seconds, so a frame comes out the same whenever it's drawn, a
// thumbnail matches the pane, and `npm test` checks every scene without a window. wallpaper.js draws the cells.

/** The roles a cell can take. wallpaper.js colors each from its `--wallpaper-<role>` variable in theme.css. */
export const ROLES = ['faint', 'ink', 'bright', 'accent', 'claude', 'water', 'sea', 'leaf', 'warm', 'light', 'glow']

/** A cols x rows grid of blank cells. A cell's role is null while it's blank. Given `reuse`, a grid of the same
 * size, it blanks that grid's cells instead of making new ones, so a frame makes no garbage. */
export function grid(cols, rows, reuse) {
  cols = Math.max(0, Math.floor(cols) || 0)
  rows = Math.max(0, Math.floor(rows) || 0)
  if (reuse?.cols === cols && reuse.rows === rows) {
    reuse.chars.fill(' ')
    reuse.roles.fill(null)
    return reuse
  }
  return { cols, rows, chars: new Array(cols * rows).fill(' '), roles: new Array(cols * rows).fill(null) }
}

/** Whether cell `i` differs between grids `a` and `b` of one size. */
export const differs = (a, b, i) => a.chars[i] !== b.chars[i] || a.roles[i] !== b.roles[i]

/** Sets the cell nearest (x, y) when it's on the grid. A space leaves the cell as it was. */
export function put(g, x, y, ch, role) {
  x = Math.round(x)
  y = Math.round(y)
  if (ch === ' ' || x < 0 || y < 0 || x >= g.cols || y >= g.rows) return
  g.chars[y * g.cols + x] = ch
  g.roles[y * g.cols + x] = role
}

/** Stamps `lines` with its top-left nearest (x, y). Spaces are see-through. `role` is a role, or a
 * function of the character, so one sprite can take several colors. */
export function stamp(g, x, y, lines, role) {
  const of = typeof role === 'function' ? role : () => role
  lines.forEach((line, r) => {
    let c = 0
    for (const ch of line) put(g, x + c++, y + r, ch, of(ch))
  })
}

const MIRROR = { '/': '\\', '\\': '/', '(': ')', ')': '(', '<': '>', '>': '<', '[': ']', ']': '[', '{': '}', '}': '{',
  '`': "'", "'": '`', '▘': '▝', '▝': '▘', '▛': '▜', '▜': '▛', '▌': '▐', '▐': '▌', '▖': '▗', '▗': '▖' }
/** `lines` facing the other way, padded to one width so the sprite turns about its own middle. */
export function mirror(lines) {
  const width = Math.max(...lines.map(l => [...l].length))
  return lines.map(l => [...l.padEnd(width)].reverse().map(ch => MIRROR[ch] ?? ch).join(''))
}

/** A fixed pseudo-random number in [0, 1) for a list of integers. */
export function hash(...ns) {
  let h = 0x811c9dc5
  for (const n of ns) {
    h = Math.imul(h ^ (n | 0), 0x01000193)
    h ^= h >>> 15
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** `v` wrapped into [0, n). */
const wrap = (v, n) => ((v % n) + n) % n
const TAU = Math.PI * 2
/** How many of a thing a grid holds: one per `area` cells, at least `min`. */
const many = (g, area, min = 1) => Math.max(min, Math.round((g.cols * g.rows) / area))

/** Stars over the rows above `floor` (a fraction of the height), each twinkling at its own pace. */
function stars(g, t, seed, area = 70, floor = 1) {
  const n = many(g, area, 0)
  for (let i = 0; i < n; i++) {
    const glow = Math.sin(t * (0.4 + hash(seed, i, 3) * 1.6) + hash(seed, i, 4) * TAU)
    const ch = glow > 0.8 ? '*' : glow > 0.25 ? '+' : glow > -0.5 ? '.' : ' '
    put(g, hash(seed, i, 1) * g.cols, hash(seed, i, 2) * g.rows * floor, ch, glow > 0.8 ? 'bright' : 'faint')
  }
}

const CLOUD = '%$Stx#&'
// Each row of a cloud: where it starts and how far it runs, as fractions of the cloud's width.
const PUFF = [[0.3, 0.4], [0.12, 0.72], [0, 1], [0.18, 0.66]]
/** Clouds of letters drifting right and wrapping around. Their letters change now and then, as if they boil. */
function clouds(g, t, seed, count, { band = 0.7, speed = 1, roles = ['bright', 'ink', 'ink', 'faint'] } = {}) {
  for (let i = 0; i < count; i++) {
    const w = Math.round(12 + hash(seed, i, 1) * 14)
    const v = speed * (0.5 + hash(seed, i, 2))
    const x = wrap(hash(seed, i, 3) * (g.cols + w) + t * v, g.cols + w) - w
    const y = Math.round(hash(seed, i, 4) * Math.max(1, g.rows * band - PUFF.length))
    PUFF.forEach(([from, run], r) => {
      for (let c = Math.round(from * w); c < Math.round((from + run) * w); c++) {
        const boil = Math.floor(t * 0.8 + hash(seed, i, r, c) * 8)
        put(g, x + c, y + r, CLOUD[Math.floor(hash(seed, i, r * 97 + c, boil) * CLOUD.length)], roles[r])
      }
    })
  }
}

/** Sprites that swim across and back: `frames` face right, and each swimmer turns where it leaves the grid. */
function swimmers(g, t, seed, count, frames, { speed = 2, top = 0, bottom = 1, bob = 1, role }) {
  const width = Math.max(...frames[0].map(l => [...l].length))
  const left = frames.map(mirror)
  for (let i = 0; i < count; i++) {
    const lap = g.cols + width * 2
    const pos = hash(seed, i, 1) * lap * 2 + t * speed * (0.6 + hash(seed, i, 2) * 0.8)
    const there = wrap(pos, lap * 2) < lap // the first half of a round trip runs right, the second back
    const x = there ? wrap(pos, lap) - width : lap - wrap(pos, lap) - width
    const span = Math.max(0, (bottom - top) * g.rows - frames[0].length)
    const y = top * g.rows + hash(seed, i, 3) * span + Math.sin(t * 0.7 + hash(seed, i, 4) * TAU) * bob
    const frame = Math.floor(t * 3 + hash(seed, i, 5) * 2) % frames.length
    stamp(g, x, y, (there ? frames : left)[frame], typeof role === 'function' ? role(i) : role)
  }
}

/** Rings of dots that spread from a point and fade, each starting again on its own beat. */
function ripples(g, t, seed, count) {
  const period = 7
  for (let i = 0; i < count; i++) {
    const age = wrap(t + hash(seed, i, 1) * period, period)
    if (age > period * 0.6) continue
    const cx = hash(seed, i, 2, Math.floor((t + hash(seed, i, 1) * period) / period)) * g.cols
    const cy = hash(seed, i, 3, Math.floor((t + hash(seed, i, 1) * period) / period)) * g.rows
    const r = 1 + age * 2.4
    const dots = Math.max(8, Math.round(r * 5))
    for (let k = 0; k < dots; k++) {
      const a = (k / dots) * TAU
      put(g, cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.5, age < period * 0.12 ? 'o' : '.', 'faint') // a cell is about twice as tall as wide
    }
  }
}

/** Particles that fall (or rise, with a negative `speed`) and sway. */
function motes(g, t, seed, count, { speed = 0.6, chars = '.', role = 'faint', sway = 1.5 } = {}) {
  for (let i = 0; i < count; i++) {
    const fall = wrap(hash(seed, i, 1) * (g.rows + 2) + t * speed * (0.5 + hash(seed, i, 2)), g.rows + 2) - 1
    const x = hash(seed, i, 3) * g.cols + Math.sin(t * 0.6 + hash(seed, i, 4) * TAU) * sway
    const y = speed < 0 ? g.rows - fall : fall
    const band = Math.floor((y / Math.max(1, g.rows)) * chars.length) // a mote changes as it falls through the rows
    put(g, x, y, chars[Math.max(0, Math.min(chars.length - 1, band))], role)
  }
}

const TURTLE = [
  ['   _.--._     ', ' _/_\\_/_\\_ _ ', '<_\\_/_\\_/_(_o', '  /`      `\\  '],
  ['   _.--._     ', ' _/_\\_/_\\_ _ ', '<_\\_/_\\_/_(_o', '   \\`    `/   '],
]
const turtle = ch => (ch === 'o' ? 'bright' : 'leaf')
const KOI = [['><(((°>'], ['>-(((°>']]
const BOAT = ['   |\\   ', '   |_\\  ', ' \\____/ ']
const boat = ch => ('\\_/'.includes(ch) ? 'ink' : 'bright')
const CLAWD = [
  [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  [' ▐▛███▜▌ ', '▝▜█████▛▘', '   ▘▘▝▝  '],
]

/** The wallpapers, in the picker's order. `draw(g, t)` paints grid `g` at `t` seconds. */
export const SCENES = [
  {
    id: 'drift',
    name: 'Cloud drift',
    draw(g, t) {
      stars(g, t, 1)
      clouds(g, t, 2, many(g, 450, 2))
    },
  },
  {
    id: 'turtles',
    name: 'Sea turtles',
    draw(g, t) {
      // Swells of ~ that roll along each row, and bubbles that rise and swell as they near the top.
      for (let y = 0; y < g.rows; y++) {
        const shift = Math.floor(t * (0.8 + hash(3, y) * 1.4) * (y % 2 ? 1 : -1))
        for (let x = 0; x < g.cols; x++) if (hash(3, y, x + shift) < 0.035) put(g, x, y, '~', y % 3 ? 'water' : 'sea')
      }
      motes(g, t, 4, many(g, 160), { speed: -1.2, chars: '°oo..', role: 'bright', sway: 0.8 })
      swimmers(g, t, 5, many(g, 900), TURTLE, { speed: 2.2, bob: 1.5, role: () => turtle })
    },
  },
  {
    id: 'koi',
    name: 'Koi pond',
    draw(g, t) {
      ripples(g, t, 6, many(g, 600, 2))
      for (let i = 0, n = many(g, 500, 2); i < n; i++) {
        const [x, y] = [hash(7, i, 1) * g.cols, hash(7, i, 2) * g.rows]
        stamp(g, x, y, [' _.._', '(_@__)'], ch => (ch === '@' ? 'warm' : 'leaf'))
      }
      swimmers(g, t, 8, many(g, 260, 3), KOI, { speed: 2.6, bob: 2, role: i => ['warm', 'bright', 'light'][i % 3] })
    },
  },
  {
    id: 'jellyfish',
    name: 'Jellyfish',
    draw(g, t) {
      motes(g, t, 9, many(g, 90), { speed: 0.35 })
      for (let i = 0, n = many(g, 700, 2); i < n; i++) {
        const lap = g.rows + 10
        const y = g.rows + 2 - wrap(hash(10, i, 1) * lap + t * (0.5 + hash(10, i, 2) * 0.6), lap)
        const x = hash(10, i, 3) * (g.cols - 9) + Math.sin(t * 0.4 + hash(10, i, 4) * TAU) * 3
        const pulse = Math.sin(t * 2.2 + hash(10, i, 5) * TAU) > 0
        stamp(g, x, y, pulse ? ['  .-"-.  ', ' (     ) ', '  `~~~`  '] : ['  .---.  ', ' /     \\ ', ' `"~~~"` '], 'glow')
        for (const j of [2, 4, 6]) {
          for (let k = 0; k < 4; k++) {
            const lean = Math.sin(t * 2.4 - k * 0.9 + j)
            put(g, x + j + Math.round(lean * 0.6), y + 3 + k, lean > 0.3 ? ')' : lean < -0.3 ? '(' : '|', k < 2 ? 'glow' : 'faint')
          }
        }
      }
    },
  },
  {
    id: 'boats',
    name: 'Paper boats',
    draw(g, t) {
      const horizon = Math.floor(g.rows * 0.55)
      stars(g, t, 11, 140, 0.5)
      const height = x => Math.sin(x * 0.33 + t * 1.3) + Math.sin(x * 0.11 - t * 0.6) * 0.7
      for (let y = horizon; y < g.rows; y++) {
        const depth = (y - horizon + 1) / Math.max(1, g.rows - horizon)
        for (let x = 0; x < g.cols; x++) {
          const v = Math.sin(x * 0.35 + t * 1.2 + y * 0.9) + Math.sin(x * 0.13 - t * 0.7 + y * 1.7) * 0.6
          if (v < 1.25 - depth * 0.9) continue
          put(g, x, y, v > 1.35 ? '^' : '~', y % 2 ? 'sea' : 'water')
        }
      }
      for (let i = 0, n = many(g, 700, 2); i < n; i++) {
        const x = wrap(hash(12, i, 1) * (g.cols + 8) + t * (0.4 + hash(12, i, 2) * 0.6), g.cols + 8) - 8
        const y = horizon - 2 + Math.round(hash(12, i, 3) * Math.max(0, g.rows - horizon - 2)) - Math.round(height(x + 4) * 0.6)
        stamp(g, x, y, BOAT, boat)
      }
      for (let i = 0; i < 3; i++) {
        const x = wrap(hash(13, i, 1) * g.cols + t * 3, g.cols + 4) - 2
        const y = hash(13, i, 2) * horizon * 0.6 + Math.sin(t + i) * 1.2
        stamp(g, x, y, [Math.floor(t * 4 + i) % 2 ? '\\v/' : '-v-'], 'faint')
      }
    },
  },
  {
    id: 'fireflies',
    name: 'Fireflies',
    draw(g, t) {
      // Grass that sways along the bottom two rows, with taller blades here and there.
      for (let x = 0; x < g.cols; x++) {
        const lean = Math.sin(t * 0.9 + x * 0.25)
        const blade = lean > 0.35 ? '/' : lean < -0.35 ? '\\' : '|'
        put(g, x, g.rows - 1, hash(14, x) < 0.5 ? blade : ',', 'leaf')
        if (hash(15, x) < 0.35) put(g, x, g.rows - 2, hash(16, x) < 0.5 ? blade : '\'', 'leaf')
        if (hash(17, x) < 0.08) put(g, x, g.rows - 3, blade, 'faint')
      }
      for (let i = 0, n = many(g, 70, 3); i < n; i++) {
        const glow = Math.sin(t * (0.8 + hash(18, i, 1)) + hash(18, i, 2) * TAU)
        if (glow < -0.2) continue
        const cx = hash(18, i, 3) * g.cols
        const cy = hash(18, i, 4) * (g.rows - 3)
        const x = cx + Math.sin(t * 0.31 + hash(18, i, 5) * TAU) * 5 + Math.sin(t * 0.83 + i) * 2
        const y = cy + Math.sin(t * 0.27 + hash(18, i, 6) * TAU) * 2.5
        put(g, x, y, glow > 0.75 ? '*' : glow > 0.3 ? '+' : '.', glow > 0.75 ? 'light' : 'faint')
      }
    },
  },
  {
    id: 'moonlit',
    name: 'Moonlit',
    draw(g, t) {
      stars(g, t, 19, 55, 0.85)
      clouds(g, t, 21, many(g, 900, 1), { speed: 0.5, band: 0.6, roles: ['faint', 'faint', 'faint', 'faint'] })
      // A crescent: a disc less the same disc moved toward the light. A cell is about twice as tall as wide.
      const r = Math.max(2, Math.min(g.rows * 0.18, g.cols * 0.06))
      const [mx, my] = [g.cols * 0.78, g.rows * 0.22]
      for (let y = Math.floor(my - r); y <= my + r; y++) {
        for (let x = Math.floor(mx - r * 2); x <= mx + r * 2; x++) {
          const [dx, dy] = [(x - mx) / 2, y - my]
          const lit = Math.hypot(dx, dy) <= r && Math.hypot(dx - r * 0.45, dy + r * 0.15) > r * 0.85
          if (lit) put(g, x, y, '@%#*'[Math.floor(hash(20, x, y) * 4)], 'bright')
        }
      }
      // Claude's mascot walks the bottom row, stopping now and then to look around.
      const lap = g.cols + 10
      const walked = t * 2.5 - Math.max(0, Math.sin(t * 0.4) - 0.6) * 10
      stamp(g, wrap(walked, lap) - 9, g.rows - 3, CLAWD[Math.floor(t * 4) % 2], 'claude')
    },
  },
]

/** The scene named `id`, or undefined for none. */
export const scene = id => SCENES.find(s => s.id === id)

/** Scene `id` painted on a cols x rows grid at `t` seconds. An unknown id paints nothing. `reuse` is a grid to
 * paint over, as `grid` takes it. */
export function render(id, cols, rows, t, reuse) {
  const g = grid(cols, rows, reuse)
  scene(id)?.draw(g, t)
  return g
}

/** Draws grid `g` on canvas context `ctx`, whose transform is the identity, in cells `w` x `h` pixels. `tiles` is a
 * glyph atlas: `tiles.canvas` holds a tile for each character in each role's color, `tiles.at(ch, role)` gives a
 * tile's top-left, drawing it on first use, and a tile is `h + tiles.spill` high, since a glyph such as _ can reach
 * below its cell, as text does. A copy is far cheaper than drawing text, above all in software.
 * Given `last`, the grid the canvas shows now, at the same size, only the cells that changed are cleared and
 * drawn, with the cell under each, which the changed one may have reached into. A cell redrawn alone gets its
 * own glyph and what the glyph above reaches into it, so no pixel is drawn twice. Returns how many cells it
 * redrew. */
export function paint(ctx, g, w, h, tiles, last) {
  const spill = tiles.spill ?? 0
  const at = i => [(i % g.cols) * w, Math.floor(i / g.cols) * h]
  if (last?.cols !== g.cols || last.rows !== g.rows) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    let n = 0
    for (let i = 0; i < g.chars.length; i++) {
      if (!g.roles[i]) continue
      const [x, y] = at(i)
      const [sx, sy] = tiles.at(g.chars[i], g.roles[i])
      ctx.drawImage(tiles.canvas, sx, sy, w, h + spill, x, y, w, h + spill)
      n++
    }
    return n
  }
  let n = 0
  for (let i = 0; i < g.chars.length; i++) {
    const above = i - g.cols
    if (!differs(g, last, i) && !(spill && above >= 0 && differs(g, last, above))) continue
    const [x, y] = at(i)
    ctx.clearRect(x, y, w, h)
    if (g.roles[i]) {
      const [sx, sy] = tiles.at(g.chars[i], g.roles[i])
      ctx.drawImage(tiles.canvas, sx, sy, w, h, x, y, w, h)
    }
    if (spill && above >= 0 && g.roles[above]) {
      const [sx, sy] = tiles.at(g.chars[above], g.roles[above])
      ctx.drawImage(tiles.canvas, sx, sy + h, w, spill, x, y, w, spill)
    }
    n++
  }
  return n
}
