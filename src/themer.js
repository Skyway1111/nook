// A theme made from a picture: the picture fills the window, a soft copy of it lies under the terminal,
// and every color comes from the picture's own palette. `palette` finds that palette in OKLab, `css` writes
// a theme.css from it, and `zip` packs the theme for `install_theme_zip`. `fromPicture` does it all in the
// webview, from a picked file.

const TAU = Math.PI * 2
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// sRGB <-> OKLab, as Björn Ottosson defines it.
const linear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
export function oklab(r, g, b) {
  ;[r, g, b] = [linear(r / 255), linear(g / 255), linear(b / 255)]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
const lch = ([L, a, b]) => ({ L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) / TAU) * 360 + 360) % 360 })
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d) }

/** The picture's colors, from RGBA `pixels`: up to `k` clusters in OKLab, the biggest first, each with its
 * share of the picture, and the picture's mean lightness. Deterministic, so a picture always makes one theme. */
export function palette(pixels, k = 8) {
  const points = []
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 127) points.push(oklab(pixels[i], pixels[i + 1], pixels[i + 2]))
  if (!points.length) return { colors: [], light: 0 }
  // Seed with points spread through the picture's lightness, then settle with a few rounds of k-means.
  const byL = points.map((p, i) => [p[0], i]).sort((a, b) => a[0] - b[0])
  let centers = Array.from({ length: Math.min(k, points.length) }, (_, j) => points[byL[Math.floor(((j + 0.5) / k) * byL.length)][1]].slice())
  const owner = new Int32Array(points.length)
  for (let round = 0; round < 10; round++) {
    const sums = centers.map(() => [0, 0, 0, 0])
    points.forEach((p, i) => {
      let best = 0, bestD = Infinity
      centers.forEach((c, j) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2
        if (d < bestD) { bestD = d; best = j }
      })
      owner[i] = best
      const s = sums[best]
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++
    })
    centers = sums.map((s, j) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : centers[j]))
  }
  const counts = centers.map(() => 0)
  for (const o of owner) counts[o]++
  const colors = centers.map((c, j) => ({ ...lch(c), share: counts[j] / points.length }))
    .filter(c => c.share > 0).sort((a, b) => b.share - a.share)
  return { colors, light: points.reduce((s, p) => s + p[0], 0) / points.length }
}

const color = (L, C, h, alpha) => `oklch(${+L.toFixed(3)} ${+C.toFixed(3)} ${Math.round(h)}${alpha == null ? '' : ` / ${+alpha.toFixed(2)}`})`

// nook's ANSI hues (theme.css's defaults). A picture color near one lends it its hue.
const ANSI = [['red', 22], ['green', 150], ['yellow', 85], ['blue', 255], ['magenta', 320], ['cyan', 205]]

/** The roles a palette plays: the picture's main hue, its accent, a second color, and a hue for each ANSI color. */
export function roles({ colors }) {
  const vivid = colors.filter(c => c.C > 0.025)
  // The main hue is the picture's biggest colorful region; a gray picture keeps nook's violet.
  const main = vivid[0]?.h ?? 285
  // The accent: the color that is both vivid and plentiful, light enough to read on a dark ground.
  const score = c => c.C * Math.sqrt(c.share) * (c.L > 0.35 ? 1 : 0.4)
  const accent = vivid.reduce((best, c) => (score(c) > score(best ?? { C: 0, share: 0 }) ? c : best), null)
  const second = vivid.filter(c => c !== accent && (!accent || hueGap(c.h, accent.h) > 40))
    .reduce((best, c) => (score(c) > score(best ?? { C: 0, share: 0 }) ? c : best), null)
  const ansi = Object.fromEntries(ANSI.map(([name, hue]) => {
    const near = vivid.filter(c => hueGap(c.h, hue) < 28).sort((a, b) => b.share - a.share)[0]
    // Lean toward the picture's hue, but no further than keeps red red and green green.
    return [name, near ? hue + ((((near.h - hue + 540) % 360) - 180) * 0.6) : hue]
  }))
  return {
    main,
    accent: accent ? { h: accent.h, C: clamp(accent.C * 1.1, 0.08, 0.16) } : { h: main, C: 0.12 },
    second: second ? { h: second.h, C: clamp(second.C, 0.06, 0.13) } : { h: (main + 150) % 360, C: 0.1 },
    ansi,
  }
}

/** A theme.css for `name` over pictures `picture` (sharp, for the window) and `soft` (blurred, for the terminal).
 * `light` is the picture's mean OKLab lightness: a brighter picture gets a darker veil, so text stays readable. */
export function css(name, pal, picture, soft) {
  const { main: h, accent: a, second: s, ansi } = roles(pal)
  const veil = clamp(0.5 + pal.light * 0.55, 0.62, 0.9)
  const side = Math.max(0.5, veil - 0.2) // the side panels show more of the picture, but keep their text readable
  const ansiVars = ANSI.map(([n]) => `  --ansi-${n}: ${color(n === 'yellow' ? 0.83 : 0.74, 0.14, ansi[n])};\n` +
    `  --ansi-bright-${n}: ${color(n === 'yellow' ? 0.9 : 0.83, 0.12, ansi[n])};\n`).join('')
  const tint = (L, alpha) => color(L, 0.02, h, alpha)
  return `/* ${name.replaceAll('*/', '')}: a theme nook made from a picture. Its colors come from the picture's
   own palette. Edit freely: it's yours. */

:root {
  --h: ${Math.round(h)};
  --bg: ${tint(0.13)};
  --raised: ${color(0.26, 0.035, h, 0.7)};
  --hover: ${color(0.85, 0.05, a.h, 0.08)};
  --line: ${color(0.85, 0.05, a.h, 0.13)};
  --ink-1: ${color(0.96, 0.012, h)};
  --ink-2: ${color(0.8, 0.025, h)};
  --ink-3: ${color(0.62, 0.03, h)};
  --accent: ${color(0.8, a.C, a.h)};
  --shadow: 0 16px 44px oklch(0 0 0 / .6);
  --icon-code: ${color(0.78, s.C, s.h)};

  /* A blurred copy of the picture, pinned to the window so it lines up with the sharp one around it. */
  --term-bg:
    linear-gradient(${tint(0.1, veil)}, ${tint(0.1, veil - 0.12)} 45%, ${tint(0.08, veil - 0.02)}),
    url(${soft}) 50% 36px / cover fixed ${tint(0.11)};
  --term-fg: ${color(0.93, 0.015, h)};
  --cursor: ${color(0.8, a.C, a.h)};
  --selection: ${color(0.7, a.C * 0.8, a.h, 0.3)};

  --ansi-black: ${tint(0.28)};
${ansiVars}  --ansi-white: ${color(0.87, 0.015, h)};
  --ansi-bright-black: ${color(0.58, 0.03, h)};
  --ansi-bright-white: ${color(0.98, 0.006, h)};

  --claude-claude: ${color(0.8, a.C, a.h)};
  --claude-claudeShimmer: ${color(0.92, a.C * 0.6, a.h)};
  --claude-promptBorder: ${color(0.5, 0.05, h)};
  --claude-permission: ${color(0.78, s.C, s.h)};
  --claude-userMessageBackground: ${color(0.7, 0.06, a.h, 0.1)};
  --claude-userMessageBackgroundHover: ${color(0.7, 0.06, a.h, 0.15)};
}

/* Below the titlebar, so the picture doesn't run behind the tabs. */
body { background: url(${picture}) 50% 36px / cover no-repeat ${tint(0.11)}; }
#files, #git { background: linear-gradient(${tint(0.1, side)}, ${tint(0.1, side - 0.1)} 50%, ${tint(0.08, side - 0.15)}); }
#git-compose, #git-last { background: ${tint(0.09, 0.82)}; }
#pane { border-color: ${color(0.85, 0.08, a.h, 0.18)}; box-shadow: 0 0 32px ${color(0.7, a.C, a.h, 0.14)}; }
.tab.active { background: ${color(0.27, 0.04, h, 0.72)}; box-shadow: inset 0 -1.5px 0 var(--accent); }
.composer .frame { background: ${tint(0.13, 0.85)}; }
.row.selected, .row.current { box-shadow: inset 2px 0 0 var(--accent); }
`
}

// A .zip that stores its files as they are. The picture is JPEG already, so deflate would gain nothing.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
export function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A stored .zip of `files`, a list of [name, Uint8Array]. */
export function zip(files) {
  const enc = new TextEncoder()
  const parts = [], central = []
  let offset = 0
  for (const [name, data] of files) {
    const path = enc.encode(name)
    const crc = crc32(data)
    const head = (sig, extra) => {
      const b = new DataView(new ArrayBuffer(extra))
      b.setUint32(0, sig, true)
      return b
    }
    const local = head(0x04034b50, 30 + path.length)
    // version 2.0, no flags, stored, no time, crc, sizes, name length
    local.setUint16(4, 20, true); local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, path.length, true)
    new Uint8Array(local.buffer).set(path, 30)
    const dir = head(0x02014b50, 46 + path.length)
    dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint32(16, crc, true)
    dir.setUint32(20, data.length, true); dir.setUint32(24, data.length, true); dir.setUint16(28, path.length, true)
    dir.setUint32(42, offset, true)
    new Uint8Array(dir.buffer).set(path, 46)
    parts.push(new Uint8Array(local.buffer), data)
    central.push(new Uint8Array(dir.buffer))
    offset += 30 + path.length + data.length
  }
  const size = central.reduce((s, c) => s + c.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true)
  end.setUint32(12, size, true); end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0))
  let at = 0
  for (const p of all) { out.set(p, at); at += p.length }
  return out
}

/** A theme name from a file name: its stem, in plain characters a folder name takes on every system. */
export const nameOf = file => file.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim().slice(0, 40) || 'picture'

// The webview's half: decode the picture, read its palette, draw its two copies and a card, and pack them.
const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h })
const encode = (c, type, quality) => new Promise((res, rej) => c.toBlob(b => (b ? b.arrayBuffer().then(a => res(new Uint8Array(a))) : rej(new Error('the picture would not encode'))), type, quality))
/** `bitmap` drawn to cover a w x h canvas, as CSS's `cover` does. */
function cover(bitmap, w, h, smooth = true) {
  const c = canvas(w, h)
  const ctx = c.getContext('2d')
  ctx.imageSmoothingEnabled = smooth
  ctx.imageSmoothingQuality = 'high'
  const k = Math.max(w / bitmap.width, h / bitmap.height)
  ctx.drawImage(bitmap, (w - bitmap.width * k) / 2, (h - bitmap.height * k) / 2, bitmap.width * k, bitmap.height * k)
  return c
}

/** A .zip of a theme made from picture `file` (a File or Blob), and its name. */
export async function fromPicture(file, fileName = file.name ?? 'picture') {
  const bitmap = await createImageBitmap(file)
  const name = nameOf(fileName)
  // The palette, from a small copy: 96 x 96 is plenty to find a picture's few main colors.
  const small = cover(bitmap, 96, 96).getContext('2d').getImageData(0, 0, 96, 96).data
  const pal = palette(small)
  // The window's copy, at most 2560 wide, and a soft one: shrunk to a few dozen pixels, then smoothed back up.
  const scale = Math.min(1, 2560 / bitmap.width)
  const sharp = cover(bitmap, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  const tiny = cover(bitmap, 48, Math.max(1, Math.round((48 * bitmap.height) / bitmap.width)))
  const soft = cover(tiny, 640, Math.max(1, Math.round((640 * bitmap.height) / bitmap.width)))
  // The card: the picture, and the window's frame over it in the theme's colors, as a screenshot would show.
  const card = cover(bitmap, 480, 320)
  const ctx = card.getContext('2d')
  const { main: h, accent: a } = roles(pal)
  ctx.fillStyle = `oklch(.13 .02 ${h} / .9)`; ctx.fillRect(0, 0, 480, 14)
  ctx.fillStyle = `oklch(.1 .02 ${h} / .4)`; ctx.fillRect(0, 14, 84, 306)
  ctx.fillStyle = `oklch(.1 .02 ${h} / .62)`; ctx.fillRect(196, 120, 270, 186)
  ctx.fillStyle = `oklch(.8 ${a.C} ${a.h})`
  ctx.fillRect(206, 130, 56, 5); ctx.fillRect(10, 26, 40, 4)
  ctx.fillStyle = `oklch(.8 .025 ${h} / .7)`
  for (let i = 0; i < 5; i++) { ctx.fillRect(206, 144 + i * 12, 90 + ((i * 53) % 120), 3); ctx.fillRect(10, 38 + i * 12, 30 + ((i * 29) % 40), 3) }
  bitmap.close?.()
  const stem = 'picture'
  const files = [
    ['theme.css', new TextEncoder().encode(css(name, pal, `${stem}.jpg`, `${stem}-soft.jpg`))],
    [`${stem}.jpg`, await encode(sharp, 'image/jpeg', 0.88)],
    [`${stem}-soft.jpg`, await encode(soft, 'image/jpeg', 0.85)],
    ['screenshot.png', await encode(card, 'image/png')],
  ]
  return { name, zip: zip(files) }
}
