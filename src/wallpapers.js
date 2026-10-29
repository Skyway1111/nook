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
  {
    id: 'rain',
    name: 'Rain',
    draw(g, t) {
      // Streaks that fall with a little wind, and splash where they land.
      const lap = g.rows + 4
      for (let i = 0, n = many(g, 45, 6); i < n; i++) {
        const speed = 13 + hash(22, i, 1) * 9
        const fall = hash(22, i, 2) * lap + t * speed
        const y = wrap(fall, lap) - 2
        const x0 = hash(22, i, 3, Math.floor(fall / lap)) * (g.cols + g.rows * 0.3)
        const x = x0 - y * 0.3
        const near = hash(22, i, 4) < 0.35
        put(g, x, y, near ? '/' : '\'', near ? 'water' : 'faint')
        if (near) put(g, x + 0.3, y - 1, '/', 'faint')
        const landed = wrap(fall, lap) - lap + 1 // how long ago it reached the bottom, in rows of fall
        if (landed > -speed * 0.25 && landed <= 0 && near) {
          const at = x0 - (g.rows - 1) * 0.3
          put(g, at - 1, g.rows - 1, '.', 'faint')
          put(g, at, g.rows - 1, 'v', 'sea')
          put(g, at + 1, g.rows - 1, '.', 'faint')
        }
      }
      // A puddle's rings along the bottom.
      for (let i = 0, n = many(g, 900, 2); i < n; i++) {
        const beat = Math.floor(t / 1.6 + hash(23, i, 1) * 9)
        const age = wrap(t / 1.6 + hash(23, i, 1) * 9, 1)
        const x = hash(23, i, 2, beat) * g.cols
        const r = Math.round(1 + age * 3)
        put(g, x - r * 2, g.rows - 1, '(', 'faint')
        put(g, x + r * 2, g.rows - 1, ')', 'faint')
      }
    },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    draw(g, t) {
      stars(g, t, 24, 90, 0.7)
      // Curtains of light that ripple along the sky, brightest at their hems.
      const top = Math.floor(g.rows * 0.08)
      const span = Math.max(4, Math.floor(g.rows * 0.5))
      for (let x = 0; x < g.cols; x++) {
        const u = x / Math.max(1, g.cols)
        const glow = 0.3 + Math.sin(u * 5 + t * 0.3) * 0.35 + Math.sin(u * 13 - t * 0.5) * 0.25 + Math.sin(u * 2.3 + t * 0.12) * 0.2
        if (glow < 0.05) continue
        const hem = top + span * (0.55 + 0.25 * Math.sin(u * 5 + t * 0.25)) // the curtain's lower edge waves
        if (hash(25, x) < 0.3) continue // the curtains are rays of light, with dark between them
        const height = span * (0.35 + glow * 0.5) * (0.6 + 0.4 * hash(25, x, 1))
        for (let y = Math.max(0, Math.floor(hem - height)); y <= hem && y < g.rows; y++) {
          const k = (y - (hem - height)) / Math.max(1, height) // 0 at the top of the curtain, 1 at its hem
          const v = glow * (0.25 + k * 0.9)
          if (v < 0.2) continue
          put(g, x, y, v > 0.8 ? '|' : v > 0.45 ? ':' : '\'', k > 0.8 ? 'leaf' : k > 0.4 ? 'sea' : 'glow')
        }
      }
      // A ridge of mountains along the bottom.
      const ridge = x => Math.round(g.rows - 1 - Math.min(g.rows * 0.3, 9) * (0.55 + 0.25 * Math.sin(x * 0.09) + 0.15 * Math.sin(x * 0.23 + 1) + 0.08 * Math.sin(x * 0.61)))
      for (let x = 0; x < g.cols; x++) {
        const [l, y, r] = [ridge(x - 1), ridge(x), ridge(x + 1)]
        put(g, x, y, l > y && r > y ? '^' : r < y ? '/' : l < y ? '\\' : '_', 'ink')
      }
    },
  },
  {
    id: 'snow',
    name: 'Snowfall',
    draw(g, t) {
      motes(g, t, 27, many(g, 50), { speed: 0.9, chars: '.', role: 'faint', sway: 1 })
      motes(g, t, 28, many(g, 140), { speed: 2.2, chars: '+*', role: 'bright', sway: 2.5 })
      // Pines on a white ground.
      const ground = g.rows - 1
      for (let x = 0; x < g.cols; x++) put(g, x, ground, hash(29, x) < 0.5 ? '_' : '.', 'bright')
      for (let i = 0, n = Math.max(2, Math.round(g.cols / 16)); i < n; i++) {
        const tall = 3 + Math.floor(hash(30, i, 1) * 4)
        const x = Math.round(((i + 0.2 + hash(30, i, 2) * 0.6) / n) * g.cols)
        for (let k = 0; k < tall; k++) {
          const half = k
          for (let d = -half; d <= half; d++) {
            const ch = k === 0 ? '^' : d === -half ? '/' : d === half ? '\\' : hash(31, i, k, d) < 0.25 ? '*' : '^'
            put(g, x + d, ground - tall + k, ch, ch === '*' ? 'bright' : 'leaf')
          }
        }
        put(g, x, ground, '|', 'ink')
      }
    },
  },
  {
    id: 'campfire',
    name: 'Campfire',
    draw(g, t) {
      stars(g, t, 32, 80, 0.55)
      const ground = g.rows - 2
      for (let x = 0; x < g.cols; x++) put(g, x, ground + 1, hash(33, x) < 0.4 ? ',' : '_', 'faint')
      const cx = Math.round(g.cols * 0.5)
      // Logs, then flames whose edges flicker eight times a second.
      stamp(g, cx - 7, ground, ['\\\\__/\\_//\\__//'], 'ink')
      const tall = Math.max(4, Math.min(14, Math.round(g.rows * 0.25)))
      const flick = Math.floor(t * 8)
      for (let k = 0; k < tall; k++) {
        const y = ground - 1 - k
        const lean = Math.round(Math.sin(t * 1.7 + k * 0.4) * k * 0.15)
        const half = 6 * Math.pow(1 - k / tall, 0.8) * (0.8 + 0.35 * hash(34, k, flick))
        for (let d = -Math.ceil(half); d <= Math.ceil(half); d++) {
          const edge = Math.abs(d) / Math.max(0.5, half)
          if (edge > 1 || (edge > 0.75 && hash(35, k, d, flick) < 0.4)) continue
          const heat = (1 - edge) * (1 - k / tall)
          put(g, cx + d + lean, y, heat > 0.55 ? '#' : heat > 0.3 ? '*' : heat > 0.12 ? (d < 0 ? '(' : ')') : '\'', heat > 0.55 ? 'light' : heat > 0.2 ? 'warm' : 'accent')
        }
      }
      // Sparks that rise and drift, and go out.
      for (let i = 0, n = 14; i < n; i++) {
        const life = 2.5 + hash(36, i, 1) * 2
        const age = wrap(t + hash(36, i, 2) * life, life)
        const x = cx + (hash(36, i, 3, Math.floor((t + hash(36, i, 2) * life) / life)) - 0.5) * 6 + Math.sin(t * 1.3 + i) * age * 1.2
        const y = ground - tall + 1 - age * 3.2
        if (y > 0) put(g, x, y, age < life * 0.6 ? '.' : '\'', age < life * 0.4 ? 'light' : 'faint')
      }
      // Pines at the edges of the clearing.
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const x = cx + side * Math.round(g.cols * (0.3 + i * 0.07)) + Math.round(hash(37, i, side) * 4)
          const h = 4 + Math.floor(hash(38, i, side) * 4)
          for (let k = 0; k < h; k++) for (let d = -k; d <= k; d++) put(g, x + d, ground - h + k + 1, k === 0 ? '^' : d === -k ? '/' : d === k ? '\\' : '^', 'ink')
        }
      }
    },
  },
  {
    id: 'lava',
    name: 'Lava lamp',
    draw(g, t) {
      // Blobs that rise, sink, and melt into one another: cells where their summed pull passes 1.
      const blobs = []
      for (let i = 0, n = Math.max(4, Math.round((g.cols * g.rows) / 700)); i < n; i++) {
        const r = Math.max(2, Math.min(g.rows, g.cols / 2) * (0.05 + hash(39, i, 1) * 0.05))
        const period = 22 + hash(39, i, 2) * 26
        blobs.push({
          x: g.cols * (0.15 + 0.7 * hash(39, i, 3)) + Math.sin(t * 0.21 + i * 1.7) * g.cols * 0.06,
          y: g.rows * (0.5 - 0.42 * Math.cos(((t / period) + hash(39, i, 4)) * TAU)),
          r2: r * r,
        })
      }
      for (let y = 0; y < g.rows; y++) {
        for (let x = 0; x < g.cols; x++) {
          let f = 0
          for (const b of blobs) {
            const dx = (x - b.x) / 2 // a cell is about twice as tall as wide
            const dy = y - b.y
            const q = b.r2 / (dx * dx + dy * dy + 0.5)
            f += q * q // a steep falloff keeps blobs round instead of one wide haze
          }
          if (f < 0.7) continue
          put(g, x, y, f > 6 ? '@' : f > 2.5 ? 'O' : f > 1.1 ? 'o' : '.', f > 2.5 ? 'warm' : f > 1.1 ? 'accent' : 'glow')
        }
      }
    },
  },
  {
    id: 'orbit',
    name: 'Orbits',
    draw(g, t) {
      stars(g, t, 40, 260)
      const [cx, cy] = [g.cols / 2, g.rows / 2]
      const size = Math.min(g.cols / 2, g.rows) * 0.9
      const rays = Math.floor(t * 2) % 2
      stamp(g, cx - 4, cy - 2, rays ? ['  \\ | /  ', '   .-.   ', '--( @ )--', "   '-'   ", '  / | \\  '] : ['  .   .  ', '   .-.   ', '- ( @ ) -', "   '-'   ", '  .   .  '], 'light')
      for (let i = 0; i < 5; i++) {
        const a = size * (0.26 + i * 0.16)
        const b = a * 0.5
        // The path, faint and still, then the planet on it, faster near the sun.
        for (let k = 0, n = Math.round(a * 1.2); k < n; k++) {
          const th = (k / n) * TAU
          put(g, cx + Math.cos(th) * a * 2 * 0.98, cy + Math.sin(th) * b, '.', 'faint')
        }
        const th = t * (0.5 / Math.pow(i + 1, 1.3)) + hash(42, i) * TAU
        const [px, py] = [cx + Math.cos(th) * a * 2 * 0.98, cy + Math.sin(th) * b]
        stamp(g, px - (i === 3 ? 2 : 0), py, [['o', 'O', '@', '-(O)-', 'O'][i]], ['sea', 'warm', 'water', 'light', 'accent'][i])
        if (i === 2 || i === 4) {
          const m = t * 1.6 + i
          put(g, px + Math.cos(m) * 3, py + Math.sin(m) * 1.2, '.', 'bright')
        }
      }
      // Now and then a comet crosses, its tail behind it.
      const pass = 14
      const age = wrap(t, pass)
      if (age < 6) {
        const k = Math.floor(t / pass)
        const [x0, y0] = [-10 + hash(43, k, 1) * g.cols * 0.3, hash(43, k, 2) * g.rows * 0.4]
        const [vx, vy] = [g.cols / 5, g.rows / 14]
        for (let j = 0; j < 8; j++) put(g, x0 + vx * age - j * 1.6, y0 + vy * age - j * 0.4, j ? (j < 4 ? '-' : '.') : '*', j ? 'faint' : 'bright')
      }
    },
  },
  {
    id: 'coderain',
    name: 'Code rain',
    draw(g, t) {
      // Streams of code fall down some of the columns, bright at their heads. Each column rests between streams.
      const glyphs = '01{}[]()<>=+*/;:.$#&!?|~'
      for (let x = 0; x < g.cols; x += 2) {
        const speed = 6 + hash(44, x, 1) * 8
        const lap = g.rows * (1.6 + hash(44, x, 2) * 1.2)
        const run = hash(44, x, 3) * lap + t * speed
        const head = wrap(run, lap)
        const trail = 6 + Math.floor(hash(44, x, 4, Math.floor(run / lap)) * 14)
        for (let k = 0; k < trail; k++) {
          const y = Math.floor(head) - k
          if (y < 0 || y >= g.rows) continue
          const ch = glyphs[Math.floor(hash(45, x, y, Math.floor(t * 2 + hash(45, x, y) * 9)) * glyphs.length)]
          put(g, x, y, ch, k === 0 ? 'bright' : k < trail * 0.5 ? 'leaf' : 'faint')
        }
      }
    },
  },
  {
    id: 'petals',
    name: 'Cherry blossoms',
    draw(g, t) {
      // A branch in bloom reaching in from the top right, its petals drifting down and across on the wind.
      const reach = Math.round(Math.min(g.cols * 0.5, 56))
      const bough = k => 1 + k * 0.2 + Math.sin(k * 0.21) * 1.2 // the branch's row, `k` cells in from the right
      for (let k = 0; k < reach; k++) {
        const dy = Math.round(bough(k + 1)) - Math.round(bough(k))
        put(g, g.cols - 1 - k, bough(k), dy > 0 ? '/' : dy < 0 ? '\\' : '_', 'ink')
        if (k % 11 === 6) { // a twig
          put(g, g.cols - 1 - k, bough(k) + 1, '\\', 'ink')
          put(g, g.cols - k, bough(k) + 2, '\\', 'ink')
        }
      }
      for (let i = 0, n = Math.round(reach * 0.9); i < n; i++) {
        const k = hash(46, i, 1) * reach
        const x = g.cols - 1 - k + (hash(46, i, 2) - 0.5) * 5
        const y = bough(k) + (hash(46, i, 3) - 0.4) * 3
        const open = hash(46, i, 4, Math.floor(t / 9 + hash(46, i, 5) * 9)) < 0.8 // now and then a blossom closes
        put(g, x, y, open ? (hash(46, i, 6) < 0.3 ? '@' : '*') : 'o', hash(46, i, 7) < 0.25 ? 'bright' : 'glow')
      }
      // Petals fall from under the branch and drift left, turning as they go.
      for (let i = 0, n = many(g, 150, 8); i < n; i++) {
        const speed = 1.4 + hash(47, i, 1) * 1.6
        const lap = g.rows + 3
        const fall = hash(47, i, 2) * lap + t * speed
        const y = wrap(fall, lap) - 1
        const start = g.cols * (0.45 + hash(47, i, 3, Math.floor(fall / lap)) * 0.65)
        const x = start - y * (1.2 + hash(47, i, 4)) + Math.sin(t * 1.3 + hash(47, i, 5) * TAU) * 1.5
        put(g, x, y, ".,`'"[Math.floor(t * 2.5 + hash(47, i, 6) * 4) % 4], 'glow')
      }
      // Fallen petals along the bottom.
      for (let x = 0; x < g.cols; x++) if (hash(48, x) < 0.12) put(g, x, g.rows - 1, hash(48, x, 1) < 0.5 ? '.' : ',', 'glow')
    },
  },
  {
    id: 'tide',
    name: 'Night sea',
    draw(g, t) {
      const horizon = Math.round(g.rows * 0.5)
      stars(g, t, 49, 80, horizon / Math.max(1, g.rows) - 0.05)
      // The moon, and its light on the water: a path of glints that widens toward you.
      const mx = Math.round(g.cols * 0.68)
      const my = Math.max(1, Math.round(horizon * 0.3))
      stamp(g, mx - 2, my, [' .-. ', '(   )', " `-' "], 'bright')
      for (let x = 0; x < g.cols; x++) put(g, x, horizon, hash(50, x) < 0.7 ? '_' : ' ', 'faint')
      for (let y = horizon + 1; y < g.rows; y++) {
        const depth = (y - horizon) / Math.max(1, g.rows - horizon)
        const half = 1 + depth * 7
        for (let x = Math.round(mx - half); x <= mx + half; x++) {
          const glint = hash(51, x, y, Math.floor(t * 1.4 + hash(51, x, y) * 9))
          if (glint < 0.45) put(g, x, y, glint < 0.12 ? '=' : '-', glint < 0.2 ? 'bright' : 'light')
        }
      }
      // Swells that roll in, slower and fainter far out.
      for (let i = 0, n = many(g, 100, 6); i < n; i++) {
        const depth = hash(52, i, 1)
        const y = horizon + 1 + Math.floor(depth * (g.rows - horizon - 1))
        const len = 2 + Math.floor(depth * 6)
        const x = wrap(hash(52, i, 2) * (g.cols + len) + t * (0.6 + depth * 2.2), g.cols + len) - len
        for (let c = 0; c < len; c++) put(g, x + c, y, '~', depth > 0.6 ? 'sea' : depth > 0.25 ? 'water' : 'faint')
      }
    },
  },
  {
    id: 'city',
    name: 'City lights',
    draw(g, t) {
      stars(g, t, 53, 140, 0.4)
      // A skyline of towers, their windows lit and dark as the night goes on.
      const street = g.rows - 1
      let x = 0
      for (let b = 0; x < g.cols; b++) {
        const w = 5 + Math.floor(hash(54, b, 1) * 8)
        const tall = Math.round(g.rows * (0.22 + hash(54, b, 2) * 0.42))
        const top = street - tall
        for (let y = top + 1; y < street; y++) {
          put(g, x, y, '|', 'ink')
          put(g, x + w - 1, y, '|', 'ink')
        }
        for (let c = 1; c < w - 1; c++) put(g, x + c, top, '_', 'ink')
        for (let wy = top + 2; wy < street - 1; wy += 2) {
          for (let wx = x + 2; wx < x + w - 2; wx += 2) {
            const lit = hash(55, wx, wy, Math.floor(t / (6 + hash(55, wx, wy) * 30) + hash(55, wx, wy, 1) * 9))
            if (lit < 0.4) put(g, wx, wy, '#', lit < 0.06 ? 'accent' : 'light')
          }
        }
        if (hash(54, b, 3) < 0.25 && tall > g.rows * 0.45) { // a mast with a light that blinks
          put(g, x + Math.floor(w / 2), top - 1, '|', 'ink')
          if (wrap(t + hash(54, b, 4) * 2, 2) < 0.5) put(g, x + Math.floor(w / 2), top - 2, '*', 'warm')
        }
        x += w + 1 + Math.floor(hash(54, b, 5) * 3)
      }
      // Cars along the street, white lights one way and red the other.
      for (let i = 0, n = Math.max(2, Math.round(g.cols / 20)); i < n; i++) {
        const right = i % 2 === 0
        const pos = wrap(hash(56, i, 1) * (g.cols + 6) + t * (7 + hash(56, i, 2) * 6), g.cols + 6) - 3
        put(g, right ? pos : g.cols - 1 - pos, street, right ? '>' : '<', right ? 'bright' : 'warm')
        put(g, right ? pos - 1 : g.cols - pos, street, '=', 'faint')
      }
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
