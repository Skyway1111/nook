// Living wallpapers: scenes painted in characters behind a Claude tab, always moving. A scene's subjects are tiles,
// blocks of shaded color with a character cut in each, their edges frayed by faint characters, over a ground of the
// scene's colors ruled into cells. Each scene is a pure function of the grid's size and the time in seconds, so a
// frame comes out the same whenever it's drawn, a thumbnail matches the pane, and `npm test` checks every scene
// without a window. wallpaper.js sizes the canvas and runs the frames; `atlas`, `ground`, and `paint` draw them.

/** The roles a cell can take. wallpaper.js colors each from its `--wallpaper-<role>` variable in theme.css. */
export const ROLES = ['faint', 'ink', 'bright', 'accent', 'claude', 'water', 'sea', 'leaf', 'warm', 'light', 'glow']

/** A cell's height over its width. Scenes measure in cell heights, so a circle comes out round. */
export const ASPECT = 1.4

/** How a cell draws its role's color. GLYPH is its character alone. Tones 1 to 5 are tiles, darkest to lightest,
 * with the character cut in them. HALO, MIST, and HAZE are light, brightest to faintest, filling the cell so the
 * cells of a glow run together. SHADOW is a tile of shade. */
export const GLYPH = 0, HALO = 6, MIST = 7, HAZE = 8, SHADOW = 9
const SHADE = [0, -0.5, -0.27, 0, 0.2, 0.42] // each tile tone's step toward black, or white
const LIGHT = { [HALO]: 0.22, [MIST]: 0.12, [HAZE]: 0.055 } // each light's opacity

const CODE = Object.fromEntries(ROLES.map((r, i) => [r, (i + 1) << 4]))
/** A cell's look as `grid` stores it: `role` drawn in `tone`. A blank cell's is 0. */
const look = (role, tone = GLYPH) => CODE[role] | tone
/** The role of look `v`. */
export const roleOf = v => ROLES[(v >> 4) - 1]
const FAINT = look('faint'), DARK = look('faint', SHADOW)

/** A cols x rows grid of blank cells. Given `reuse`, a grid of the same size, it blanks that grid's cells instead of
 * making new ones, so a frame makes no garbage. */
function grid(cols, rows, reuse) {
  cols = Math.max(0, Math.floor(cols) || 0)
  rows = Math.max(0, Math.floor(rows) || 0)
  if (reuse?.cols === cols && reuse.rows === rows) {
    reuse.chars.fill(' ')
    reuse.looks.fill(0)
    return reuse
  }
  return { cols, rows, chars: new Array(cols * rows).fill(' '), looks: new Uint8Array(cols * rows) }
}

/** Whether cell `i` differs between grids `a` and `b` of one size. */
export const differs = (a, b, i) => a.looks[i] !== b.looks[i] || a.chars[i] !== b.chars[i]

/** Sets the cell nearest (x, y) to `ch` in look `v`, when it's on the grid. */
function set(g, x, y, ch, v) {
  x = Math.round(x)
  y = Math.round(y)
  if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return
  g.chars[y * g.cols + x] = ch
  g.looks[y * g.cols + x] = v
}

/** Sets the cell nearest (x, y) to `ch` in `role` and `tone`. A space leaves the cell as it was. */
function put(g, x, y, ch, role, tone = GLYPH) {
  if (ch !== ' ') set(g, x, y, ch, look(role, tone))
}

/** Whether cell (x, y) is on the grid with nothing in it. */
const blank = (g, x, y) => x >= 0 && y >= 0 && x < g.cols && y < g.rows && !g.looks[y * g.cols + x]

/** A fixed pseudo-random number in [0, 1) for up to four integers. */
function hash(a, b = 0, c = 0, d = 0) {
  let h = Math.imul(0x811c9dc5 ^ (a | 0), 0x01000193)
  h = Math.imul((h ^ (h >>> 15)) ^ (b | 0), 0x01000193)
  h = Math.imul((h ^ (h >>> 15)) ^ (c | 0), 0x01000193)
  h = Math.imul((h ^ (h >>> 15)) ^ (d | 0), 0x01000193)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** `v` wrapped into [0, n). */
const wrap = (v, n) => ((v % n) + n) % n
const TAU = Math.PI * 2
/** The length of (x, y). Math.hypot is several times slower, and the shapes ask for thousands a frame. */
const norm = (x, y) => Math.sqrt(x * x + y * y)
/** How many of a thing a grid holds: one per `area` cells, at least `min`. */
const many = (g, area, min = 1) => Math.max(min, Math.round((g.cols * g.rows) / area))
/** How big a grid's subjects draw: whole in a pane, smaller in a thumbnail. */
const scale = g => Math.min(1, Math.max(0.4, Math.min(g.cols / ASPECT, g.rows * 1.6) / 44))

const GRAIN = 'tS%t;:S%Xt'
/** Sets cell (x, y) to a tile in look `v`. Its character belongs to the cell, so a shape moving over it changes only
 * the cells at its edges, and each changes now and then. A light has none. */
function tile(g, x, y, v, t) {
  x = Math.round(x)
  y = Math.round(y)
  if ((v & 15) > 5) return set(g, x, y, '·', v)
  set(g, x, y, GRAIN[(hash(x, y, Math.floor(t * 0.3 + hash(y, x, 9) * 9)) * GRAIN.length) | 0], v)
}
/** Sets the tile in look `v` at the cell holding (X, Y), in cell heights. */
const at = (g, X, Y, v, t) => tile(g, Math.floor(X * ASPECT), Math.floor(Y), v, t)

const DUST = ".,'`:;o."
/** Now and then a faint character at cell (x, y), if nothing's there: the dust that frays a shape's edge. */
function dust(g, x, y, t, p) {
  if (!blank(g, x, y)) return
  const k = Math.floor(t * 0.8 + hash(x, y, 1) * 9)
  if (hash(x, y, k, 2) < p) set(g, x, y, DUST[(hash(x, y, k, 3) * DUST.length) | 0], FAINT)
}

/** Paints a shape in tiles. `sdf(X, Y)` is how far (X, Y), in cell heights from the grid's top left, lies outside
 * it, negative inside, and `paint(X, Y, d)` the look of a cell inside, or 0 to leave it. Dust frays the cells up to
 * `fray` outside. Given `shadow`, [x, y] in cell heights, the shape casts a shadow that far away, under whatever
 * holds more than a character. The shape lies within the box from (x0, y0) to (x1, y1). */
function shape(g, t, x0, y0, x1, y1, sdf, paint, fray = 1, shadow) {
  const c0 = Math.max(0, Math.floor((x0 - fray) * ASPECT)), c1 = Math.min(g.cols - 1, Math.ceil((x1 + fray) * ASPECT))
  const r0 = Math.max(0, Math.floor(y0 - fray)), r1 = Math.min(g.rows - 1, Math.ceil(y1 + fray))
  const [sx, sy] = shadow ? [Math.round(shadow[0] * ASPECT), Math.round(shadow[1])] : [0, 0]
  for (let y = r0; y <= r1; y++) {
    for (let x = c0; x <= c1; x++) {
      const X = (x + 0.5) / ASPECT, Y = y + 0.5
      const d = sdf(X, Y)
      if (d < 0) {
        if (shadow && x + sx < g.cols && y + sy < g.rows && !(g.looks[(y + sy) * g.cols + x + sx] & 15)) set(g, x + sx, y + sy, '·', DARK)
        const v = paint(X, Y, d)
        if (v) tile(g, x, y, v, t)
      } else if (d < fray) dust(g, x, y, t, 0.45 * (1 - d / fray))
    }
  }
}

/** Light around (X, Y), in cell heights, fading out to `r`, in the cells nothing holds. */
function glow(g, X, Y, r, role) {
  const [halo, mist, haze] = [HALO, MIST, HAZE].map(n => look(role, n))
  for (let y = Math.max(0, Math.floor(Y - r)); y <= Math.min(g.rows - 1, Y + r); y++) {
    for (let x = Math.max(0, Math.floor((X - r) * ASPECT)); x <= Math.min(g.cols - 1, (X + r) * ASPECT); x++) {
      const d = norm((x + 0.5) / ASPECT - X, y + 0.5 - Y) / r
      if (d < 1 && !g.looks[y * g.cols + x]) set(g, x, y, '·', d < 0.35 ? halo : d < 0.65 ? mist : haze)
    }
  }
}

/** The distance from (X, Y) to the segment from (ax, ay) to (bx, by), less `r`: a capsule's edge. */
function capsule(X, Y, ax, ay, bx, by, r) {
  const dx = bx - ax, dy = by - ay
  const k = Math.max(0, Math.min(1, ((X - ax) * dx + (Y - ay) * dy) / (dx * dx + dy * dy || 1)))
  return norm(X - ax - dx * k, Y - ay - dy * k) - r
}

/** Stars over the rows above `floor` (a fraction of the height), each twinkling at its own pace. */
function stars(g, t, seed, area = 70, floor = 1) {
  for (let i = 0, n = many(g, area, 0); i < n; i++) {
    const shine = Math.sin(t * (0.4 + hash(seed, i, 3) * 1.6) + hash(seed, i, 4) * TAU)
    if (shine < -0.5) continue
    put(g, hash(seed, i, 1) * g.cols, hash(seed, i, 2) * g.rows * floor, shine > 0.8 ? '*' : shine > 0.25 ? '+' : '.', shine > 0.8 ? 'bright' : 'faint')
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

/** Faint dashes drifting along some rows, as light plays on water. */
function shimmer(g, t, seed, density = 0.06) {
  for (let y = 0; y < g.rows; y++) {
    if (hash(seed, y) > 0.4) continue
    const shift = Math.floor(t * (0.3 + hash(seed, y, 1) * 0.6) * (y % 2 ? 1 : -1))
    for (let x = 0; x < g.cols; x++) if (hash(seed, y, x + shift) < density) put(g, x, y, '-', 'faint')
  }
}

/** Rings of faint characters that spread from a point and fade, each starting again on its own beat. */
function ripples(g, t, seed, count) {
  const period = 7
  for (let i = 0; i < count; i++) {
    const beat = Math.floor((t + hash(seed, i, 1) * period) / period)
    const age = wrap(t + hash(seed, i, 1) * period, period)
    if (age > period * 0.6) continue
    const [cx, cy] = [hash(seed, i, 2, beat) * g.cols, hash(seed, i, 3, beat) * g.rows]
    const r = 1 + age * 2.4
    for (let k = 0, dots = Math.max(8, Math.round(r * 4)); k < dots; k++) {
      const a = (k / dots) * TAU
      put(g, cx + Math.cos(a) * r, cy + (Math.sin(a) * r) / ASPECT, age < period * 0.15 ? 'o' : '.', 'faint')
    }
  }
}

/** A cloud `w` cell heights wide whose flat bottom runs right from (x, base): four puffs that swell and settle, lit
 * `tones[0]` on top, `tones[1]` through the middle, and `tones[2]` along the bottom. */
function cloud(g, t, x, base, w, seed, role, tones) {
  const puffs = [[0.18, 0.16], [0.4, 0.26], [0.63, 0.22], [0.83, 0.15]].map(([at, size], k) => {
    const r = w * size * (0.85 + 0.3 * hash(seed, k)) * (1 + 0.05 * Math.sin(t * 0.5 + k * 1.7 + seed))
    return [x + w * at, base - r * 0.75, r]
  })
  const [hi, mid, lo] = tones.map(n => look(role, n))
  shape(g, t, x, base - w * 0.55, x + w, base, (X, Y) => {
    let d = Infinity
    for (const [px, py, r] of puffs) d = Math.min(d, norm(X - px, Y - py) - r)
    return Math.max(d, Y - base)
  }, (X, Y) => (Y < base - w * 0.28 ? hi : Y < base - 1 ? mid : lo))
}

/** Where a swimmer is at time `tau`, into `out`: a wandering course over the `W` x `H` pond, about `speed` cell
 * heights a second, that never leaves it for long. */
function course(out, tau, W, H, speed, ph) {
  const f = speed / Math.max(6, norm(W * 0.36, H * 0.44))
  out[0] = W * (0.5 + 0.36 * Math.sin(tau * f + ph) + 0.08 * Math.sin(tau * f * 2.7 + ph * 2))
  out[1] = H * (0.5 + 0.34 * Math.sin(tau * f * 1.31 + ph * 3) + 0.08 * Math.cos(tau * f * 3.1 + ph))
}

const SPINE = 10
const KOI = [0.62, 0.86, 1, 1, 0.94, 0.8, 0.64, 0.48, 0.34, 0.24] // a koi's half-width along its spine
/** The spine of a swimmer on `course`: SPINE points `gap` apart along the path it took to where it is at `t`, as
 * x, y pairs in `pts`, each swaying side to side more toward the tail. */
function spine(pts, t, gap, W, H, speed, ph) {
  const p = [0, 0]
  course(p, t, W, H, speed, ph)
  pts[0] = p[0]
  pts[1] = p[1]
  let tau = t
  const dt = gap / speed / 6
  for (let i = 1, steps = 0; i < SPINE; i++) {
    let [x, y] = [pts[i * 2 - 2], pts[i * 2 - 1]]
    while (norm(p[0] - x, p[1] - y) < gap && steps++ < 400) course(p, (tau -= dt), W, H, speed, ph)
    pts[i * 2] = p[0]
    pts[i * 2 + 1] = p[1]
  }
  for (let i = 1; i < SPINE; i++) {
    const j = Math.min(SPINE - 1, i + 1)
    const [dx, dy] = [pts[i * 2 - 2] - pts[j * 2], pts[i * 2 - 1] - pts[j * 2 + 1]]
    const size = norm(dx, dy) || 1
    const sway = Math.sin(t * 5 + ph - i * 0.7) * 0.22 * gap * (i / SPINE)
    pts[i * 2] += (-dy / size) * sway
    pts[i * 2 + 1] += (dx / size) * sway
  }
}

const CLAWD = ['   ============   ', '   ## ###### ##   ', ' ################ ', '   ############   ']
const STRIDES = ['    - -    - -    ', '   - -      - -   ']
const INK = { '=': 4, '#': 3, '-': 2 } // pixel art's tones, by character
/** Tiles pixel art `art`, rows of characters where a space is see-through, its top left at cell (x, y). */
function pixels(g, t, x, y, art, role) {
  art.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) if (row[c] !== ' ') tile(g, x + c, y + r, look(role, INK[row[c]]), t)
  })
}

/** A turtle's shell, head, and four flippers at (u, v), measured along its heading and across it: how far outside
 * it is, and in `part[0]` whether the shell holds it. */
function honu(u, v, t, ph, part) {
  const shell = (norm(u / 2.5, v / 1.9) - 1) * 1.9
  let d = Math.min(shell, norm(u - 3.1, v) - 0.8)
  const stroke = Math.sin(t * 2 + ph)
  for (const s of [-1, 1]) {
    const a = 1.75 + 0.6 * stroke // the front flippers sweep from forward to back
    d = Math.min(d, capsule(u, v, 0.9, s * 1.5, 0.9 + Math.cos(a) * 2.4, s * (1.5 + Math.sin(a) * 2.4), 0.5))
    const b = 2.5 + 0.2 * stroke
    d = Math.min(d, capsule(u, v, -2, s * 1.1, -2 + Math.cos(b) * 1.2, s * (1.1 + Math.sin(b) * 1.2), 0.4))
  }
  part[0] = shell <= d + 1e-9
  return d
}

let pull = new Float32Array(0) // the lava's field, kept from frame to frame

/** The wallpapers, in the picker's order. `draw(g, t)` paints grid `g` at `t` seconds. `sky` is its ground: a wash
 * from `top` to `bottom` at the opacities in `wash`, the number of `shafts` of light through it, and a `glow`
 * ([x, y] as fractions of the grid, a radius in cell heights, and a role). */
export const SCENES = [
  {
    id: 'spark',
    name: 'Spark',
    sky: { top: 'claude', bottom: 'warm', wash: [0.2, 0.08], glow: [0.7, 0.42, 16, 'claude'] },
    draw(g, t) {
      const [W, H] = [g.cols / ASPECT, g.rows]
      stars(g, t, 60, 160)
      motes(g, t, 61, many(g, 300), { speed: -0.5, chars: "'.", sway: 2 })
      // A starburst of uneven rays, turning slowly as each ray breathes.
      const R = Math.max(3, Math.min(H * 0.38, W * 0.2))
      const [cx, cy, N, spin] = [W * 0.7, H * 0.42, 12, t * 0.05]
      const core = look('claude', 5), inner = look('claude', 4), mid = look('claude', 3), outer = look('claude', 2)
      shape(g, t, cx - R, cy - R, cx + R, cy + R, (X, Y) => {
        const [dx, dy] = [X - cx, Y - cy]
        const r = norm(dx, dy)
        const a = Math.atan2(dy, dx) - spin
        const k = Math.round((a / TAU) * N)
        const n = wrap(k, N)
        const len = R * (0.6 + 0.4 * hash(62, n)) * (1 + 0.06 * Math.sin(t * 1.2 + n * 2.1))
        const half = 0.3 + R * 0.09 * Math.max(0, 1 - r / len)
        return Math.min(r - R * 0.2, Math.max(Math.abs(Math.sin(a - (k * TAU) / N)) * r - half, r - len))
      }, (X, Y) => {
        const r = norm(X - cx, Y - cy) / R
        return r < 0.13 ? core : r < 0.3 ? inner : r < 0.6 ? mid : outer
      }, 1.4)
    },
  },
  {
    id: 'drift',
    name: 'Cloud drift',
    sky: { top: 'water', bottom: 'sea', wash: [0.42, 0.17], shafts: 1 },
    draw(g, t) {
      const [W, H] = [g.cols / ASPECT, g.rows]
      const s = scale(g)
      for (let i = 0, n = many(g, 550, 2); i < n; i++) {
        const w = (8 + hash(2, i, 1) * 10) * s
        const lap = W + w * 2
        const x = wrap(hash(2, i, 3) * lap + t * (0.3 + hash(2, i, 2) * 0.45), lap) - w * 1.5
        cloud(g, t, x, w * 0.4 + 1 + hash(2, i, 4) * Math.max(0, H * 0.8 - w * 0.4), w, i, 'bright', [5, 4, 3])
      }
      // Now and then a flock of three crosses, its wings beating.
      for (let i = 0; i < 2; i++) {
        const lap = g.cols + 30
        const x = wrap(hash(3, i) * lap + t * 3.5, lap) - 10
        const y = g.rows * (0.12 + 0.4 * hash(3, i, Math.floor((hash(3, i) * lap + t * 3.5) / lap))) + Math.sin(t * 0.6 + i)
        for (const [dx, dy] of [[0, 0], [-3, 1], [-5, -1]]) put(g, x + dx, y + dy, wrap(Math.floor(t * 3) + dx, 2) ? 'v' : '^', 'faint')
      }
    },
  },
  {
    id: 'turtles',
    name: 'Sea turtles',
    sky: { top: 'sea', bottom: 'water', wash: [0.42, 0.28], shafts: 2 },
    draw(g, t) {
      const [W, H] = [g.cols / ASPECT, g.rows]
      shimmer(g, t, 3)
      motes(g, t, 4, many(g, 220), { speed: -1, chars: 'o°..', sway: 0.8 })
      const s = scale(g)
      const p = [0, 0], q = [0, 0], part = [false]
      const turtles = []
      for (let i = 0, n = many(g, 1500, 1); i < n; i++) {
        const ph = hash(5, i) * TAU
        course(p, t, W, H, 1.4, ph)
        course(q, t + 0.2, W, H, 1.4, ph)
        turtles.push([p[0], p[1], Math.atan2(q[1] - p[1], q[0] - p[0]), ph])
      }
      // Each turtle, a shell of seamed plates and skin, over its shadow on the sand below.
      const z = 1.5 * s
      for (const [x, y, a, ph] of turtles) {
        const [cos, sin, R] = [Math.cos(a), Math.sin(a), 5.2 * z]
        shape(g, t, x - R, y - R, x + R, y + R, (X, Y) => {
          const [dx, dy] = [(X - x) / z, (Y - y) / z]
          return honu(dx * cos + dy * sin, -dx * sin + dy * cos, t, ph, part) * z
        }, (X, Y, d) => {
          if (!part[0]) return look('light', d > -0.4 ? 3 : 4)
          if (d > -0.55 * z) return look('leaf', 2)
          const [dx, dy] = [(X - x) / z, (Y - y) / z]
          const [u, v] = [dx * cos + dy * sin, -dx * sin + dy * cos]
          const seam = wrap(u * 0.85, 1) < 0.22 || wrap(v * 0.95 + 0.5, 1) < 0.22
          return look('leaf', seam ? 2 : Math.abs(v) < 0.5 ? 4 : 3)
        }, 0.8, [1.2 * z, 2.2 * z])
      }
    },
  },
  {
    id: 'koi',
    name: 'Koi pond',
    sky: { top: 'sea', bottom: 'water', wash: [0.48, 0.31], shafts: 2 },
    draw(g, t) {
      const [W, H] = [g.cols / ASPECT, g.rows]
      const s = scale(g)
      shimmer(g, t, 6)
      ripples(g, t, 6, many(g, 900, 2))
      // Koi: a body along the path it swam, patched in two colors, under a ghost of fins. Their shadows first.
      const pts = new Float64Array(SPINE * 2)
      const kois = []
      for (let i = 0, n = many(g, 2400, 2); i < n; i++) {
        const ph = hash(8, i) * TAU
        spine(pts, t, 1.2 * s, W, H, 2.4 + hash(8, i, 1), ph)
        kois.push([pts.slice(), ph, [['claude', 'bright'], ['bright', 'warm'], ['light', 'claude'], ['warm', 'bright'], ['bright', 'faint']][i % 5]])
      }
      for (const [p, ph, [body, spot]] of kois) {
          const R = 2 * s
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
          for (let j = 0; j < SPINE; j++) {
            x0 = Math.min(x0, p[j * 2]); x1 = Math.max(x1, p[j * 2])
            y0 = Math.min(y0, p[j * 2 + 1]); y1 = Math.max(y1, p[j * 2 + 1])
          }
          // The tail fans behind the last point, and two fins spread from behind the head.
          const [tx, ty] = [p[18] - p[16], p[19] - p[17]]
          const tl = norm(tx, ty) || 1
          const [bx, by, nx, ny] = [tx / tl, ty / tl, -ty / tl, tx / tl]
          const flap = Math.sin(t * 5 + ph - 7) * 0.5
          const fins = [
            [p[18], p[19], p[18] + (bx * 2.2 + nx * (1.2 + flap)) * s, p[19] + (by * 2.2 + ny * (1.2 + flap)) * s, 0.6 * s],
            [p[18], p[19], p[18] + (bx * 2.2 - nx * (1.2 - flap)) * s, p[19] + (by * 2.2 - ny * (1.2 - flap)) * s, 0.6 * s],
          ]
          const [hx, hy] = [p[2] - p[4], p[3] - p[5]]
          const hl = norm(hx, hy) || 1
          for (const side of [-1, 1]) {
            const [fx, fy] = [p[4] + (-hy / hl) * side * R * 0.7, p[5] + (hx / hl) * side * R * 0.7]
            fins.push([fx, fy, fx + ((-hy / hl) * side * 1.4 - (hx / hl) * 1.1) * s, fy + ((hx / hl) * side * 1.4 - (hy / hl) * 1.1) * s, 0.5 * s])
          }
          let along = 0, side = 0, fin = false
          shape(g, t, x0 - R * 2, y0 - R * 2, x1 + R * 2, y1 + R * 2, (X, Y) => {
            let best = Infinity
            for (let j = 0; j < SPINE - 1; j++) {
              const ax = p[j * 2], ay = p[j * 2 + 1], dx = p[j * 2 + 2] - ax, dy = p[j * 2 + 3] - ay
              const k = Math.max(0, Math.min(1, ((X - ax) * dx + (Y - ay) * dy) / (dx * dx + dy * dy || 1)))
              const d = norm(X - ax - dx * k, Y - ay - dy * k) - R * (KOI[j] + (KOI[j + 1] - KOI[j]) * k)
              if (d < best) {
                best = d
                along = j + k
                side = dx * (Y - ay) - dy * (X - ax) > 0 ? 1 : 0
              }
            }
            let f = Infinity
            for (const c of fins) f = Math.min(f, capsule(X, Y, c[0], c[1], c[2], c[3], c[4]))
            fin = f < best
            return Math.min(best, f)
          }, (X, Y, d) => {
            if (fin) return look(spot, 2)
            const role = along > 0.8 && hash(ph * 99, Math.round(along * 0.6), side) < 0.45 ? spot : body
            const depth = -d / (R * KOI[Math.min(SPINE - 1, Math.round(along))])
            return look(role, depth > 0.55 ? 4 : depth > 0.2 ? 3 : 2)
          }, 0.7, [0.9 * s, 1.8 * s])
      }
      // Lily pads float over them, notched, veined, some in flower.
      for (let i = 0, n = many(g, 1700, 2); i < n; i++) {
        const r = (2.6 + hash(7, i, 3) * 2.2) * s
        const cx = hash(7, i, 1) * W + Math.sin(t * 0.07 + i) * 1.2
        const cy = hash(7, i, 2) * H + Math.cos(t * 0.05 + i * 2) * 0.6
        const notch = hash(7, i, 4) * TAU + Math.sin(t * 0.1 + i) * 0.2
        shape(g, t, cx - r, cy - r, cx + r, cy + r, (X, Y) => {
          const a = Math.atan2(Y - cy, X - cx) - notch
          return Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < 0.3 ? 2 : norm(X - cx, Y - cy) - r
        }, (X, Y, d) => {
          const [dx, dy] = [X - cx + r * 0.35, Y - cy + r * 0.35]
          if (norm(dx, dy) < r * 0.35) return look('leaf', 4)
          const vein = Math.abs(wrap(Math.atan2(Y - cy, X - cx) - notch, TAU / 7) - TAU / 14) > TAU / 14 - 0.13
          return look('leaf', d > -0.6 || vein ? 2 : 3)
        }, 0.6)
        if (hash(7, i, 5) < 0.45) {
          const [fx, fy] = [cx - r * 0.2, cy + r * 0.15]
          for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) at(g, fx + dx / ASPECT, fy + dy, look('glow', 4), t)
          at(g, fx, fy, look('light', 5), t)
        }
      }
    },
  },
  {
    id: 'jellyfish',
    name: 'Jellyfish',
    sky: { top: 'sea', bottom: 'water', wash: [0.34, 0.2], shafts: 1 },
    draw(g, t) {
      const [W, H] = [g.cols / ASPECT, g.rows]
      const s = scale(g)
      motes(g, t, 9, many(g, 110), { speed: 0.3 })
      for (let i = 0, n = many(g, 1000, 3); i < n; i++) {
        const role = ['glow', 'claude', 'bright', 'accent'][i % 4]
        const R = (2.4 + hash(10, i, 6) * 1.6) * s
        const ph = hash(10, i, 5) * TAU
        const squeeze = Math.max(0, Math.sin(t * 1.5 + ph)) // the bell squeezes, then opens
        const lap = H + R * 7
        const cy = H + R * 1.5 - wrap(hash(10, i, 1) * lap + t * (0.5 + hash(10, i, 2) * 0.5) * s, lap)
        const cx = R + hash(10, i, 3) * Math.max(0, W - R * 2) + Math.sin(t * 0.3 + ph) * 2
        const [rx, ry] = [R * 1.1 * (1 - 0.14 * squeeze), R * 0.8 * (1 + 0.16 * squeeze)]
        const rim = cy + ry * 0.2
        // Tentacles trail from the rim, swaying, fading toward their tips; two frilled arms hang between them.
        for (let k = 0; k < 6; k++) {
          const fx = cx + ((k + 0.5) / 6 - 0.5) * 1.7 * rx
          const len = Math.round((6 + hash(10, i, 7 + k) * 7) * s * (k === 2 || k === 3 ? 0.6 : 1))
          for (let j = 0; j < len; j++) {
            const sway = Math.sin(t * 1.8 - j * 0.4 + k * 1.3 + ph) * 0.12 * j
            const thick = k === 2 || k === 3
            const v = look(role, thick ? (j < len * 0.6 ? 4 : 3) : j < len * 0.35 ? 3 : j < len * 0.7 ? 2 : 1)
            at(g, fx + sway, rim + 0.6 + j * 0.95, v, t)
          }
        }
        shape(g, t, cx - rx, cy - ry, cx + rx, rim, (X, Y) => {
          return Math.max((norm((X - cx) / rx, (Y - cy) / ry) - 1) * ry, Y - rim)
        }, (X, Y) => {
          const k = (Y - cy + ry) / (ry * 1.2) // 0 at the crown, 1 at the rim
          if (Y > rim - 1) return look(role, 2)
          if (Math.abs(norm((X - cx) / rx, (Y - cy + ry * 0.25) / ry) - 0.45) < 0.1) return look(role, 3)
          return look(role, k < 0.35 ? 5 : 4)
        }, 0.9)
      }
    },
  },
  {
    id: 'boats',
    name: 'Paper boats',
    sky: { top: 'sea', bottom: 'water', wash: [0.42, 0.25], shafts: 2 },
    draw(g, t) {
      const [W, H] = [g.cols / ASPECT, g.rows]
      const s = scale(g)
      shimmer(g, t, 11, 0.06)
      // Boats seen from the side, the near ones lower and bigger, each bobbing and rocking as it drifts over its
      // wavering reflection. The far ones go first, so the near pass in front.
      const boats = []
      for (let i = 0, n = many(g, 650, 4); i < n; i++) {
        const near = hash(12, i, 1)
        const k = (0.7 + near * 0.9) * s
        const lap = W + k * 12
        const x = wrap(hash(12, i, 3) * lap + t * (0.25 + near * 0.5), lap) - k * 6
        const y = H * (0.25 + near * 0.6) + Math.sin(t * 1.1 + i * 2.3) * 0.3 * k
        boats.push([near, x, y, Math.sin(t * 0.9 + i * 1.7) * 0.09, k, hash(12, i, 2) < 0.3 ? 'claude' : 'bright'])
      }
      boats.sort((a, b) => a[0] - b[0])
      for (const [, x, y, a, k, role] of boats) {
        const [cos, sin, water] = [Math.cos(a), Math.sin(a), 0.75 * k] // the waterline, below the hull's top
        const boat = (u, v) => Math.min(
          Math.max(-v, v - 1.2 * k, Math.abs(u) - 2.6 * k + v * 0.8), // the hull, wider at the top
          Math.max(v, Math.abs(u) - 1.3 * k - v * 0.6)) // the sail, rising from its middle
        let u = 0, v = 0, mirrored = false
        shape(g, t, x - 3 * k, y - 2.4 * k, x + 3 * k, y + 4 * k, (X, Y) => {
          u = (X - x) * cos + (Y - y) * sin
          v = -(X - x) * sin + (Y - y) * cos
          const d = boat(u, v)
          mirrored = d >= 0 && v > water
          return mirrored ? boat(u + Math.sin(t * 3 + v * 2) * 0.3, water * 2 - v) + 0.2 : d
        }, () => {
          if (mirrored) return look(role, v - water < 1.4 * k ? MIST : HAZE)
          if (v < 0) return look(role, u < 0 ? 5 : 4) // the sail, lit on one side
          return look(role, v > water ? 2 : 3)
        }, 0.5)
      }
    },
  },
  {
    id: 'fireflies',
    name: 'Fireflies',
    sky: { top: 'leaf', bottom: 'leaf', wash: [0.04, 0.2] },
    draw(g, t) {
      const [W, H] = [g.cols / ASPECT, g.rows]
      // Grass in clumps along the bottom, its tips swaying.
      for (let x = 0; x < g.cols; x++) {
        const tall = Math.floor(1 + hash(14, x) * 2.5 + hash(14, Math.floor(x / 5)) * 3.5)
        const lean = Math.round(Math.sin(t * 0.7 + x * 0.21) * 0.8)
        for (let k = 0; k < tall; k++) tile(g, x + (k === tall - 1 ? lean : 0), g.rows - 1 - k, look('leaf', k === tall - 1 ? 3 : k ? 2 : 1), t)
      }
      // Fireflies wander, glowing and going dark, each lit cell in a haze of its own light.
      const lit = []
      for (let i = 0, n = many(g, 360, 3); i < n; i++) {
        const shine = Math.sin(t * (0.7 + hash(18, i, 1) * 0.8) + hash(18, i, 2) * TAU)
        const x = hash(18, i, 3) * W + Math.sin(t * 0.21 + hash(18, i, 5) * TAU) * 3 + Math.sin(t * 0.53 + i) * 0.8
        const y = hash(18, i, 4) * (H - 4) + Math.sin(t * 0.19 + hash(18, i, 6) * TAU) * 1.5
        if (shine < -0.3) {
          if (shine > -0.6) put(g, x * ASPECT, y, 'o', 'faint') // a glow fading out
          continue
        }
        at(g, x, y, look('light', shine > 0.6 ? 5 : shine > 0.1 ? 4 : 3), t)
        if (shine > 0.3) at(g, x, y + 1, look('light', 3), t)
        if (shine > 0.2) lit.push([x + 0.36, y + 1, 1.6 + shine * 1.6])
      }
      for (const [x, y, r] of lit) glow(g, x, y, r, 'light')
    },
  },
  {
    id: 'moonlit',
    name: 'Moonlit',
    sky: { top: 'water', bottom: 'water', wash: [0.42, 0.11], glow: [0.78, 0.24, 9, 'light'] },
    draw(g, t) {
      const [W, H] = [g.cols / ASPECT, g.rows]
      stars(g, t, 19, 55, 0.85)
      // A crescent: a disc less the same disc moved toward the light, in a haze of dust.
      const r = Math.max(2.2, Math.min(H * 0.17, W * 0.07))
      const [mx, my] = [W * 0.78, H * 0.24]
      shape(g, t, mx - r, my - r, mx + r, my + r,
        (X, Y) => Math.max(norm(X - mx, Y - my) - r, r * 0.86 - norm(X - mx - r * 0.5, Y - my + r * 0.2)),
        (X, Y, d) => look('light', d > -0.7 ? 3 : 4), 1.8)
      // Long banks of cloud drift by, row over staggered row.
      for (let i = 0, n = many(g, 1100, 2); i < n; i++) {
        const len = Math.round(16 + hash(21, i, 1) * 22)
        const lap = g.cols + len * 2
        const x = wrap(hash(21, i, 2) * lap + t * (0.35 + hash(21, i, 3) * 0.3), lap) - len
        const y = Math.round(hash(21, i, 4) * g.rows * 0.7)
        for (let k = 0; k < 4; k++) {
          const from = x + Math.round((hash(21, i, k, 1) - 0.3) * 8), run = len - Math.abs(k - 1.5) * 4 - hash(21, i, k, 2) * 6
          for (let c = 0; c < run; c++) tile(g, from + c, y + k, look('water', k ? 2 : 3), t)
          dust(g, Math.round(from - 1), y + k, t, 0.5)
          dust(g, Math.round(from + run), y + k, t, 0.5)
        }
      }
      // Claude's mascot walks the bottom, stopping now and then to look around.
      const lap = g.cols + 20
      const walked = t * 2.5 - Math.max(0, Math.sin(t * 0.4) - 0.6) * 10
      const x = Math.round(wrap(walked, lap)) - 19
      pixels(g, t, x, g.rows - 5, [...CLAWD, STRIDES[Math.floor(t * 4) % 2]], 'claude')
    },
  },
  {
    id: 'rain',
    name: 'Rain',
    sky: { top: 'ink', bottom: 'water', wash: [0.17, 0.14] },
    draw(g, t) {
      // A low ceiling of cloud, its underside rolling, lit now and then by lightning.
      const flash = wrap(t, 23) < 0.12 || (wrap(t, 23) > 0.3 && wrap(t, 23) < 0.4)
      const deep = Math.max(1.5, g.rows * 0.045)
      for (let x = 0; x < g.cols; x++) {
        const under = deep + 1.2 * Math.sin(x * 0.11 + t * 0.15) + 0.8 * Math.sin(x * 0.37 - t * 0.1)
        for (let y = 0; y <= under; y++) tile(g, x, y, look('ink', (y + 1 > under ? 2 : 1) + (flash ? 2 : 0)), t)
        dust(g, x, Math.floor(under) + 1, t, 0.3)
      }
      // Streaks that fall with a little wind, and splash where they land.
      const lap = g.rows + 4
      for (let i = 0, n = many(g, 45, 6); i < n; i++) {
        const speed = 13 + hash(22, i, 1) * 9
        const fall = hash(22, i, 2) * lap + t * speed
        const y = wrap(fall, lap) - 2
        const x0 = hash(22, i, 3, Math.floor(fall / lap)) * (g.cols + g.rows * 0.3)
        const x = x0 - y * 0.3
        const near = hash(22, i, 4) < 0.35
        if (y < deep + 2) continue
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
    sky: { top: 'water', bottom: 'leaf', wash: [0.28, 0.08] },
    draw(g, t) {
      stars(g, t, 24, 90, 0.7)
      // Curtains of light that ripple along the sky, brightest at their hems.
      const top = Math.floor(g.rows * 0.06)
      const span = Math.max(4, Math.floor(g.rows * 0.55))
      for (let x = 0; x < g.cols; x++) {
        const u = x / Math.max(1, g.cols)
        const shine = 0.45 + Math.sin(u * 5 + t * 0.3) * 0.35 + Math.sin(u * 13 - t * 0.5) * 0.25 + Math.sin(u * 2.3 + t * 0.12) * 0.2
        if (shine < 0.1 || hash(25, x) < 0.2) continue // rays of light, with dark between them
        const hem = top + span * (0.55 + 0.25 * Math.sin(u * 5 + t * 0.25)) // the curtain's lower edge waves
        const height = span * (0.35 + shine * 0.5) * (0.6 + 0.4 * hash(25, x, 1))
        for (let y = Math.max(0, Math.floor(hem - height)); y <= hem && y < g.rows; y++) {
          const k = (y - (hem - height)) / Math.max(1, height) // 0 at the top of the curtain, 1 at its hem
          const v = shine * (0.2 + k * 0.9)
          if (v < 0.15) continue
          if (k < 0.7) set(g, x, y, '·', look(k < 0.3 ? 'glow' : 'sea', v > 0.45 ? HALO : v > 0.28 ? MIST : HAZE))
          else tile(g, x, y, look(k > 0.85 ? 'leaf' : 'sea', k > 0.9 && v > 0.7 ? 4 : k > 0.82 ? 3 : 2), t)
        }
      }
      // A ridge of mountains along the bottom, its edge lit by the sky.
      const ridge = x => Math.round(g.rows - 1 - Math.min(g.rows * 0.22, 7) * (0.55 + 0.25 * Math.sin(x * 0.09) + 0.15 * Math.sin(x * 0.23 + 1) + 0.08 * Math.sin(x * 0.61)))
      for (let x = 0; x < g.cols; x++) {
        const y0 = ridge(x)
        for (let y = y0; y < g.rows; y++) tile(g, x, y, look('water', y === y0 ? 2 : 1), t)
      }
    },
  },
  {
    id: 'snow',
    name: 'Snowfall',
    sky: { top: 'water', bottom: 'bright', wash: [0.22, 0.08] },
    draw(g, t) {
      motes(g, t, 27, many(g, 50), { speed: 0.9, chars: '.', sway: 1 })
      // A drift of snow, and pines along it, snow on each tier.
      const ground = x => g.rows - 2 - Math.round(Math.sin(x * 0.07) * 0.8 + Math.sin(x * 0.19 + 2) * 0.5)
      for (let x = 0; x < g.cols; x++) for (let y = ground(x); y < g.rows; y++) tile(g, x, y, look('bright', y === ground(x) ? 5 : 4), t)
      for (let i = 0, n = Math.max(2, Math.round(g.cols / 16)); i < n; i++) {
        const tall = 4 + Math.floor(hash(30, i, 1) * 5)
        const x = Math.round(((i + 0.2 + hash(30, i, 2) * 0.6) / n) * g.cols)
        const base = ground(x)
        tile(g, x, base - 1, look('warm', 1), t)
        for (let k = 0; k < tall; k++) {
          const y = base - tall - 1 + k
          const half = Math.round((k % 3) + k * 0.45) // tiers that widen, each a little wider than the one above
          for (let d = -half; d <= half; d++) tile(g, x + d, y, look(k % 3 === 0 || Math.abs(d) === half && hash(31, i, k) < 0.5 ? 'bright' : 'leaf', k % 3 === 0 ? 5 : 2), t)
        }
      }
      motes(g, t, 28, many(g, 140), { speed: 2.2, chars: '+*', role: 'bright', sway: 2.5 })
    },
  },
  {
    id: 'campfire',
    name: 'Campfire',
    sky: { top: 'water', bottom: 'warm', wash: [0.14, 0.22], glow: [0.5, 0.92, 14, 'claude'] },
    draw(g, t) {
      stars(g, t, 32, 80, 0.55)
      const ground = g.rows - 2
      for (let x = 0; x < g.cols; x++) put(g, x, ground + 1, hash(33, x) < 0.4 ? ',' : '_', 'faint')
      const cx = Math.round(g.cols * 0.5)
      // Pines at the edges of the clearing, dark against the sky.
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const x = cx + side * Math.round(g.cols * (0.3 + i * 0.07)) + Math.round(hash(37, i, side) * 4)
          const h = 5 + Math.floor(hash(38, i, side) * 5)
          for (let k = 0; k < h; k++) for (let d = -Math.round(k * 0.7); d <= k * 0.7; d++) tile(g, x + d, ground - h + k + 1, DARK, t)
        }
      }
      // Logs, then flames whose edges flicker eight times a second, hottest at the heart.
      for (let d = -6; d <= 6; d++) tile(g, cx + d, ground, look('warm', Math.abs(d) > 4 ? 2 : 1), t)
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
          tile(g, cx + d + lean, y, heat > 0.55 ? look('light', 5) : heat > 0.35 ? look('light', 4) : heat > 0.2 ? look('claude', 3) : look('warm', heat > 0.1 ? 3 : 2), t)
        }
      }
      glow(g, (cx + 0.5) / ASPECT, ground - tall * 0.3, tall * 0.6 * (0.95 + 0.1 * hash(36, flick)), 'claude')
      // Sparks that rise and drift, and go out.
      for (let i = 0, n = 14; i < n; i++) {
        const life = 2.5 + hash(36, i, 1) * 2
        const age = wrap(t + hash(36, i, 2) * life, life)
        const x = cx + (hash(36, i, 3, Math.floor((t + hash(36, i, 2) * life) / life)) - 0.5) * 6 + Math.sin(t * 1.3 + i) * age * 1.2
        const y = ground - tall + 1 - age * 3.2
        if (y > 0) put(g, x, y, age < life * 0.6 ? '.' : '\'', age < life * 0.4 ? 'light' : 'faint')
      }
    },
  },
  {
    id: 'lava',
    name: 'Lava lamp',
    sky: { top: 'warm', bottom: 'claude', wash: [0.11, 0.28] },
    draw(g, t) {
      // Blobs that rise, sink, and melt into one another: cells where their summed pull passes 1.
      const blobs = []
      for (let i = 0, n = Math.max(4, Math.round((g.cols * g.rows) / 700)); i < n; i++) {
        const r = Math.max(2, Math.min(g.rows, g.cols / ASPECT) * (0.05 + hash(39, i, 1) * 0.05))
        const period = 22 + hash(39, i, 2) * 26
        blobs.push([
          g.cols * (0.15 + 0.7 * hash(39, i, 3)) + Math.sin(t * 0.21 + i * 1.7) * g.cols * 0.06,
          g.rows * (0.5 - 0.42 * Math.cos((t / period + hash(39, i, 4)) * TAU)),
          r * r,
        ])
      }
      // Past three radii a blob's pull is too weak to count, so each adds only to the cells within that.
      const field = pull.length === g.cols * g.rows ? pull.fill(0) : (pull = new Float32Array(g.cols * g.rows))
      for (const [bx, by, r2] of blobs) {
        const reach = Math.sqrt(r2) * 3
        for (let y = Math.max(0, Math.floor(by - reach)); y <= Math.min(g.rows - 1, by + reach); y++) {
          for (let x = Math.max(0, Math.floor(bx - reach * ASPECT)); x <= Math.min(g.cols - 1, bx + reach * ASPECT); x++) {
            const [dx, dy] = [(x - bx) / ASPECT, y - by]
            const q = r2 / (dx * dx + dy * dy + 0.5)
            field[y * g.cols + x] += q * q // a steep falloff keeps blobs round instead of one wide haze
          }
        }
      }
      for (let y = 0; y < g.rows; y++) {
        for (let x = 0; x < g.cols; x++) {
          const f = field[y * g.cols + x]
          if (f < 0.55) continue
          if (f < 0.8) set(g, x, y, '·', look('warm', MIST))
          else tile(g, x, y, f > 6 ? look('light', 4) : f > 2.5 ? look('claude', 4) : f > 1.2 ? look('warm', 3) : look('warm', 2), t)
        }
      }
    },
  },
  {
    id: 'orbit',
    name: 'Orbits',
    sky: { top: 'water', bottom: 'water', wash: [0.11, 0.22], glow: [0.5, 0.5, 9, 'light'] },
    draw(g, t) {
      stars(g, t, 40, 260)
      const [cx, cy] = [g.cols / ASPECT / 2, g.rows / 2]
      const s = scale(g)
      const reach = i => [(cx - 1) * (0.26 + i * 0.17), Math.min((cx - 1) * (0.26 + i * 0.17) * 0.45, (cy - 1) * (0.26 + i * 0.17))]
      // The paths, faint and still.
      for (let i = 0; i < 5; i++) {
        const [a, b] = reach(i)
        for (let k = 0, n = Math.round(a * 2); k < n; k++) {
          const th = (k / n) * TAU
          put(g, (cx + Math.cos(th) * a) * ASPECT, cy + Math.sin(th) * b, '.', 'faint')
        }
      }
      // The sun, its corona frayed.
      const sun = 3 * s
      shape(g, t, cx - sun, cy - sun, cx + sun, cy + sun, (X, Y) => norm(X - cx, Y - cy) - sun, (X, Y) => {
        const r = norm(X - cx, Y - cy) / sun
        return look('light', r < 0.4 ? 5 : r < 0.75 ? 4 : 3)
      }, 1.5)
      // Planets, lit on the side facing the sun, faster near it. One wears a ring.
      for (let i = 0; i < 5; i++) {
        const [a, b] = reach(i)
        const th = t * (0.5 / Math.pow(i + 1, 1.3)) + hash(42, i) * TAU
        const [px, py] = [cx + Math.cos(th) * a, cy + Math.sin(th) * b]
        const r = [1, 1.5, 1.8, 2.1, 1.3][i] * s
        const role = ['sea', 'warm', 'water', 'light', 'accent'][i]
        const [lx, ly] = [cx - px, cy - py].map(v => v / (norm(cx - px, cy - py) || 1))
        if (i === 3) shape(g, t, px - r * 2.4, py - r, px + r * 2.4, py + r, (X, Y) => Math.abs(norm((X - px) / 2.2, (Y - py) / 0.55) - r) - 0.2, () => look('bright', 2), 0)
        shape(g, t, px - r, py - r, px + r, py + r, (X, Y) => norm(X - px, Y - py) - r, (X, Y) => {
          const lit = ((X - px) * lx + (Y - py) * ly) / r
          return look(role, lit > 0.35 ? 4 : lit > -0.15 ? 3 : lit > -0.6 ? 2 : 1)
        }, 0)
        if (i === 2 || i === 4) {
          const m = t * 1.6 + i
          at(g, px + Math.cos(m) * (r + 1.2), py + Math.sin(m) * (r + 0.8) * 0.6, look('bright', 3), t)
        }
      }
      // Now and then a comet crosses, its tail behind it.
      const pass = 14
      const age = wrap(t, pass)
      if (age < 6) {
        const k = Math.floor(t / pass)
        const [x0, y0] = [-10 + hash(43, k, 1) * g.cols * 0.3, hash(43, k, 2) * g.rows * 0.4]
        const [vx, vy] = [g.cols / 5, g.rows / 14]
        for (let j = 1; j < 9; j++) put(g, x0 + vx * age - j * 1.6, y0 + vy * age - j * 0.4, j < 4 ? '-' : '.', 'faint')
        tile(g, x0 + vx * age, y0 + vy * age, look('bright', 5), t)
      }
    },
  },
  {
    id: 'coderain',
    name: 'Code rain',
    sky: { top: 'leaf', bottom: 'leaf', wash: [0.04, 0.13] },
    draw(g, t) {
      // Streams of code fall down some of the columns, a lit tile at each head. Each column rests between streams.
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
          set(g, x, y, ch, k === 0 ? look('leaf', 5) : look(k < 3 ? 'bright' : k < trail * 0.5 ? 'leaf' : 'faint'))
        }
      }
    },
  },
  {
    id: 'petals',
    name: 'Cherry blossoms',
    sky: { top: 'glow', bottom: 'glow', wash: [0.14, 0.04], shafts: 1 },
    draw(g, t) {
      // A branch in bloom reaching in from the top right, its petals drifting down and across on the wind.
      const reach = Math.round(Math.min(g.cols * 0.5, 64))
      const bough = k => 1 + k * 0.2 + Math.sin(k * 0.21) * 1.2 // the branch's row, `k` cells in from the right
      const bark = look('warm', 1)
      for (let k = 0; k < reach; k++) {
        tile(g, g.cols - 1 - k, bough(k), bark, t)
        if (k < reach * 0.4) tile(g, g.cols - 1 - k, bough(k) - 1, bark, t) // thicker toward the trunk
        if (k % 11 === 6) for (let j = 1; j < 4; j++) tile(g, g.cols - 1 - k + j, bough(k) + j, bark, t) // a twig
      }
      for (let i = 0, n = Math.round(reach * 0.35); i < n; i++) {
        const k = hash(46, i, 1) * reach
        const x = Math.round(g.cols - 1 - k + (hash(46, i, 2) - 0.5) * 5)
        const y = Math.round(bough(k) + (hash(46, i, 3) - 0.4) * 3)
        const open = hash(46, i, 4, Math.floor(t / 9 + hash(46, i, 5) * 9)) < 0.85 // now and then a blossom closes
        if (open) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) tile(g, x + dx, y + dy, look('glow', hash(46, i, dx + 2, dy + 2) < 0.5 ? 5 : 4), t)
        tile(g, x, y, look(open ? 'light' : 'glow', open ? 4 : 3), t)
      }
      // Petals fall from under the branch and drift left, flashing as they turn.
      for (let i = 0, n = many(g, 170, 8); i < n; i++) {
        const speed = 1.4 + hash(47, i, 1) * 1.6
        const lap = g.rows + 3
        const fall = hash(47, i, 2) * lap + t * speed
        const y = wrap(fall, lap) - 1
        const start = g.cols * (0.45 + hash(47, i, 3, Math.floor(fall / lap)) * 0.65)
        const x = start - y * (1.2 + hash(47, i, 4)) + Math.sin(t * 1.3 + hash(47, i, 5) * TAU) * 1.5
        if (hash(47, i, 7) < 0.6) tile(g, x, y, look('glow', Math.floor(t * 2.5 + hash(47, i, 6) * 4) % 2 ? 5 : 3), t)
        else put(g, x, y, ".,`'"[Math.floor(t * 2.5 + hash(47, i, 6) * 4) % 4], 'glow')
      }
      // Fallen petals along the bottom.
      for (let x = 0; x < g.cols; x++) if (hash(48, x) < 0.1) tile(g, x, g.rows - 1, look('glow', 3), t)
    },
  },
  {
    id: 'tide',
    name: 'Night sea',
    sky: { top: 'water', bottom: 'water', wash: [0.36, 0.17], glow: [0.68, 0.16, 8, 'bright'] },
    draw(g, t) {
      const horizon = Math.round(g.rows * 0.5)
      stars(g, t, 49, 80, horizon / Math.max(1, g.rows) - 0.05)
      // The moon, and its light on the water: a path of glints that widens toward you.
      const mx = Math.round(g.cols * 0.68)
      const [X, Y, r] = [(mx + 0.5) / ASPECT, Math.max(1, horizon * 0.32), Math.max(1.2, Math.min(g.rows * 0.08, 3))]
      shape(g, t, X - r, Y - r, X + r, Y + r, (x, y) => norm(x - X, y - Y) - r,
        (x, y) => look('bright', hash(Math.floor(x * 2), Math.floor(y * 1.5), 50) < 0.2 ? 3 : 4), 1.2)
      for (let x = 0; x < g.cols; x++) put(g, x, horizon, hash(50, x) < 0.7 ? '_' : ' ', 'faint')
      for (let y = horizon + 1; y < g.rows; y++) {
        const depth = (y - horizon) / Math.max(1, g.rows - horizon)
        const half = 1 + depth * 7
        for (let x = Math.round(mx - half); x <= mx + half; x++) {
          const glint = hash(51, x, y, Math.floor(t * 1.4 + hash(51, x, y) * 9))
          if (glint < 0.12) tile(g, x, y, look('light', glint < 0.04 ? 5 : glint < 0.08 ? 4 : 3), t)
          else if (glint < 0.4) put(g, x, y, '-', 'light')
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
    sky: { top: 'water', bottom: 'glow', wash: [0.28, 0.2] },
    draw(g, t) {
      stars(g, t, 53, 140, 0.4)
      // A skyline of towers, dark against the glow, their windows lit and dark as the night goes on.
      const street = g.rows - 1
      const masts = []
      let x = 0
      for (let b = 0; x < g.cols; b++) {
        const w = 5 + Math.floor(hash(54, b, 1) * 8)
        const tall = Math.round(g.rows * (0.18 + hash(54, b, 2) * 0.36))
        const top = street - tall
        for (let y = top; y < street; y++) {
          for (let c = x; c < x + w; c++) {
            const window = y > top && (y - top) % 2 === 0 && c > x && c < x + w - 1 && (c - x) % 2 === 1
            const lit = window && hash(55, c, y, Math.floor(t / (6 + hash(55, c, y) * 30) + hash(55, c, y, 1) * 9))
            tile(g, c, y, window && lit < 0.4 ? look(lit < 0.05 ? 'accent' : 'light', lit < 0.2 ? 4 : 3) : DARK, t)
          }
        }
        if (hash(54, b, 3) < 0.25 && tall > g.rows * 0.4) { // a mast with a light that blinks
          const mx = x + Math.floor(w / 2)
          tile(g, mx, top - 1, DARK, t)
          if (wrap(t + hash(54, b, 4) * 2, 2) < 0.5) masts.push(mx, top - 2)
        }
        x += w + 1 + Math.floor(hash(54, b, 5) * 3)
      }
      for (let i = 0; i < masts.length; i += 2) {
        tile(g, masts[i], masts[i + 1], look('warm', 5), t)
        glow(g, (masts[i] + 0.5) / ASPECT, masts[i + 1] + 0.5, 2.2, 'warm')
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

const SHAFTS = [[0.1, 0.09], [0.88, 0.13], [0.5, 0.06]] // where shafts of light fall, and how wide, as fractions of the width
/** Scene `s`'s ground over a cols x rows grid, a pixel a cell, as RGBA bytes: its sky's wash, its shafts of light
 * fading as they go down, and its glow, in `colors`, each role's [r, g, b, a] bytes. */
export function ground(s, cols, rows, colors) {
  const out = new Uint8ClampedArray(cols * rows * 4)
  const sky = s?.sky
  if (!sky) return out
  const [top, bottom, light] = [colors[sky.top], colors[sky.bottom], colors.bright]
  const shafts = SHAFTS.slice(0, sky.shafts ?? 0)
  const [gx, gy, gr, role] = sky.glow ?? []
  for (let y = 0; y < rows; y++) {
    const k = rows > 1 ? y / (rows - 1) : 0
    for (let x = 0; x < cols; x++) {
      // Premultiplied: each layer goes over what's below it.
      let a = (sky.wash[0] + (sky.wash[1] - sky.wash[0]) * k) * (top[3] + (bottom[3] - top[3]) * k) / 255
      let r = (top[0] + (bottom[0] - top[0]) * k) * a, gg = (top[1] + (bottom[1] - top[1]) * k) * a, b = (top[2] + (bottom[2] - top[2]) * k) * a
      const over = (c, alpha) => {
        alpha *= c[3] / 255
        r = c[0] * alpha + r * (1 - alpha)
        gg = c[1] * alpha + gg * (1 - alpha)
        b = c[2] * alpha + b * (1 - alpha)
        a = alpha + a * (1 - alpha)
      }
      for (const [at, half] of shafts) {
        const d = Math.abs((x + 0.5) / cols - at) / half
        if (d < 1) over(light, 0.12 * (0.5 + 0.5 * Math.cos(d * Math.PI)) * (1 - k * 0.7))
      }
      if (role) {
        const d = norm((x + 0.5 - gx * cols) / ASPECT, y + 0.5 - gy * rows) / gr
        if (d < 1) over(colors[role], 0.22 * (1 - d) * (1 - d))
      }
      const i = (y * cols + x) * 4
      if (a > 0) [out[i], out[i + 1], out[i + 2], out[i + 3]] = [r / a, gg / a, b / a, a * 255]
    }
  }
  return out
}

const FINE = 10 // below this many pixels high, a tile is a plain block and a character a dot
const ATLAS = 32 // tiles a row of the atlas holds
const css = (c, alpha = 1) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${((c[3] / 255) * alpha).toFixed(3)})`
/** `c` stepped toward white by `k`, or toward black by -`k`. */
const step = (c, k) => c.map((v, i) => (i === 3 ? v : k < 0 ? v * (1 + k) : v + (255 - v) * k))

/** A tile atlas for cells `w` x `h` pixels in `colors` (each role's [r, g, b, a] bytes): each look of each character
 * drawn once into its own tile, so a frame only copies. `at(ch, look)` gives a tile's top left, drawing it on first
 * use, in `canvas`. `lines` is the tile of a cell's share of the grid, its top and left edges, in `line`, or null
 * when the cells are too small for one. */
export function atlas(w, h, family, colors) {
  const make = (width, height) => Object.assign(document.createElement('canvas'), { width, height })
  const fine = h >= FINE
  const inset = fine ? Math.max(1, Math.round(h * 0.06)) : 0
  const corner = fine ? Math.round(h * 0.14) : 0
  const font = `${Math.round(h * 0.6)}px ${family}`
  const where = new Map()
  let ctx = null, cap = 0
  const tiles = {
    canvas: make(w * ATLAS, h * 4),
    line: css(colors.faint, 0.09),
    lines: null,
    at(ch, v) {
      const tone = v & 15
      const key = tone > 5 || !v ? v : v * 0x110000 + ch.codePointAt(0)
      let spot = where.get(key)
      if (spot) return spot
      const n = where.size
      spot = [(n % ATLAS) * w, Math.floor(n / ATLAS) * h]
      if (spot[1] + h > tiles.canvas.height) {
        // Twice the rows, keeping the tiles drawn so far.
        const grown = make(tiles.canvas.width, tiles.canvas.height * 2)
        grown.getContext('2d').drawImage(tiles.canvas, 0, 0)
        tiles.canvas = grown
        ctx = null
      }
      if (!ctx) {
        ctx = tiles.canvas.getContext('2d')
        ctx.font = font
        ctx.textAlign = 'center'
        cap ||= ctx.measureText('H').actualBoundingBoxAscent || h * 0.42
      }
      const [x, y] = spot
      const color = colors[roleOf(v)] ?? colors.faint
      const block = (style, i) => {
        ctx.fillStyle = style
        ctx.beginPath()
        if (corner && ctx.roundRect) ctx.roundRect(x + i, y + i, w - i * 2, h - i * 2, corner)
        else ctx.rect(x + i, y + i, w - i * 2, h - i * 2)
        ctx.fill()
      }
      const text = style => {
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, y, w, h)
        ctx.clip()
        ctx.fillStyle = style
        ctx.fillText(ch, x + w / 2, y + (h + cap) / 2)
        ctx.restore()
      }
      if (!v) {
        ctx.fillStyle = tiles.line
        ctx.fillRect(x, y, w, 1)
        ctx.fillRect(x, y, 1, h)
      } else if (tone === GLYPH) {
        if (fine) text(css(color))
        else {
          const dot = Math.max(1, Math.round(h / 4))
          ctx.fillStyle = css(color, 0.6)
          ctx.fillRect(x + ((w - dot) >> 1), y + ((h - dot) >> 1), dot, dot)
        }
      } else if (tone <= 5) {
        const fill = step(color, SHADE[tone])
        block(css(fill), inset)
        if (fine) text(css(step(fill, -0.62), 0.9))
      } else if (tone === SHADOW) block('rgba(0, 0, 0, 0.24)', inset)
      else block(css(step(color, 0.25), LIGHT[tone]), 0)
      where.set(key, spot)
      return spot
    },
  }
  if (fine) tiles.lines = tiles.at(' ', 0)
  return tiles
}

/** Draws grid `g` on canvas context `ctx`, in cells `c.w` x `c.h` pixels from `c.top` down, over `ground`, a canvas
 * a pixel a cell, from `ground` above, stretched without smoothing, so each cell takes its pixel's color. `tiles`
 * is an `atlas`. Given `last`, the grid the canvas shows now, at the same size, only the cells that changed are
 * drawn again, each over its ground. Returns how many cells it drew. */
export function paint(ctx, g, c, tiles, ground, last) {
  const { w, h, top } = c
  const { cols, rows } = g
  const copy = ([sx, sy], x, y) => ctx.drawImage(tiles.canvas, sx, sy, w, h, x, y, w, h)
  let n = 0
  if (last?.cols !== cols || last.rows !== rows) {
    const { width, height } = ctx.canvas
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(ground, 0, 0, cols, rows, 0, top, cols * w, rows * h)
    ctx.drawImage(ground, 0, 0, cols, 1, 0, 0, cols * w, top) // the sliver above the first row
    ctx.drawImage(ground, 0, rows - 1, cols, 1, 0, top + rows * h, cols * w, height - top - rows * h) // and under the last
    if (tiles.lines) {
      ctx.fillStyle = tiles.line
      for (let x = 0; x < cols; x++) ctx.fillRect(x * w, top, 1, rows * h)
      for (let y = 0; y < rows; y++) ctx.fillRect(0, top + y * h, cols * w, 1)
    }
    for (let i = 0; i < g.looks.length; i++) {
      if (!g.looks[i]) continue
      copy(tiles.at(g.chars[i], g.looks[i]), (i % cols) * w, top + Math.floor(i / cols) * h)
      n++
    }
    return n
  }
  for (let i = 0; i < g.looks.length; i++) {
    if (!differs(g, last, i)) continue
    const [col, row] = [i % cols, Math.floor(i / cols)]
    const [x, y] = [col * w, top + row * h]
    ctx.clearRect(x, y, w, h)
    ctx.drawImage(ground, col, row, 1, 1, x, y, w, h)
    if (tiles.lines) copy(tiles.lines, x, y)
    if (g.looks[i]) copy(tiles.at(g.chars[i], g.looks[i]), x, y)
    n++
  }
  return n
}
