// Drives a dev nook over CDP and measures two things in its Claude tab, which must show Claude's prompt.
// Drag: the git panel's edge 250 px left over a second, released, then back. Per drag: resizes Claude
// got, frames without the composer card, blank frames, ms from release until Claude's redraw shows,
// and raster ms. Typing: 12 keys and 12 backspaces in the prompt. Per key: raster ms and tiles.
// cdp.mjs has the command that starts nook with CDP on 9222.
//   node bench/ui.mjs [port]
import { connect, sleep, median } from './cdp.mjs'

const { send, evaluate, trace, close } = await connect(process.argv[2])

/** The raster tasks that ran during `f`, from a trace. */
const raster = async f => (await trace(['disabled-by-default-devtools.timeline'], f)).filter(e => e.name === 'RasterTask').map(e => e.dur / 1000)

// Each frame: rows showing text, whether the card shows, the rows' text length, and the screen's size,
// which changes with each resize the terminal sends Claude.
await evaluate(`(() => {
  const host = document.querySelector('.view:not([hidden]) .xterm-host')
  const [rows, card, screen] = ['.xterm-rows', '.composer', '.xterm-screen'].map(s => host.querySelector(s))
  window.__bench = { frames: [], on: false }
  const tick = () => {
    const b = window.__bench
    if (b.on) {
      let lit = 0, text = 0
      for (const r of rows.children) { const n = r.textContent.trim().length; if (n) lit++; text += n }
      b.frames.push([performance.now(), lit, !card.hidden, text, screen.style.width + screen.style.height])
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`)

async function drag(px) {
  const [x0, y] = await evaluate(`(() => { const r = document.getElementById('git-sash').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
  const x1 = x0 - px
  let t0, t1
  const tiles = await raster(async () => {
    await evaluate('window.__bench.frames = []; window.__bench.on = true')
    await sleep(300)
    t0 = await evaluate('performance.now()')
    const move = (type, x, buttons = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 })
    await move('mousePressed', x0)
    const start = Date.now()
    for (let t = 0; t < 1000; t = Date.now() - start) {
      await move('mouseMoved', x0 + ((x1 - x0) * (1 - Math.cos((Math.PI * t) / 1000))) / 2)
      await sleep(8)
    }
    await move('mouseMoved', x1)
    t1 = await evaluate('performance.now()')
    await move('mouseReleased', x1, 0)
    await sleep(1200)
  })
  const frames = await evaluate('window.__bench.on = false, window.__bench.frames')
  const before = frames.filter(f => f[0] < t0)
  const during = frames.filter(f => f[0] >= t0)
  const lit = Math.max(...before.map(f => f[1]))
  const changed = during.filter((f, i) => i && f[3] !== during[i - 1][3])
  return {
    resizes: during.filter((f, i) => f[4] !== (i ? during[i - 1] : before.at(-1))[4]).length,
    cardless: before.at(-1)[2] ? during.filter(f => !f[2]).length : 0,
    blank: during.filter(f => f[1] < lit / 2).length,
    redraw: changed.length ? Math.max(0, Math.round(changed.at(-1)[0] - t1)) : 0,
    raster: Math.round(tiles.reduce((s, d) => s + d, 0)),
  }
}

async function type() {
  await evaluate("document.querySelector('.view:not([hidden]) .xterm-helper-textarea').focus()")
  await sleep(300)
  const tiles = await raster(async () => {
    for (const c of 'abcdefghijkl') { await send('Input.insertText', { text: c }); await sleep(60) }
    for (let i = 0; i < 12; i++) {
      for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await sleep(60)
    }
    await sleep(300)
  })
  return { rasterPerKey: +(tiles.reduce((s, d) => s + d, 0) / 24).toFixed(2), tilesPerKey: +(tiles.length / 24).toFixed(1) }
}

const drags = []
for (let i = 0; i < 3; i++) drags.push(await drag(250), await drag(-250))
const keys = [await type(), await type(), await type()]
const summary = Object.fromEntries([...Object.keys(drags[0]).map(k => [k, median(drags.map(d => d[k]))]),
  ...Object.keys(keys[0]).map(k => [k, median(keys.map(d => d[k]))])])
console.log(JSON.stringify({ drags, keys }))
console.log('median', JSON.stringify(summary))
close()
