// Drags a dev nook's bottom-right corner 500 x 300 physical px out over a second and back, three times, with
// SetWindowPos as Windows' own sizing loop does. Per drag: ms between frames that show a new size, ms from a
// size reaching the window until a frame shows it, ms from each leg's last size until Claude's last redraw
// shows, raster ms, and the display compositor's ms per frame.
// Then parity: each element that holds its gradients still (backdrops.js), screenshotted with its baked
// bitmaps and with live CSS. A pixel off by more than 2 of 255 is more than dither.
// cdp.mjs has the command that starts nook with CDP on 9222. The window dragged is this repo's dev build's.
//   node bench/resize.mjs [port]
import { execFileSync } from 'child_process'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { connect, sleep, median, quantile } from './cdp.mjs'

const { send, evaluate, trace, close } = await connect(process.argv[2])
const repo = fileURLToPath(new URL('..', import.meta.url))
const exe = resolve(repo, process.env.CARGO_TARGET_DIR ?? 'src-tauri/target', 'debug', 'nook.exe')

// Prints "epochMs width height" per step. Per-monitor DPI aware, so sizes are physical px like the page's.
const DRAG = `Add-Type @'
using System; using System.Runtime.InteropServices; using System.Diagnostics; using System.Text; using System.Threading;
public static class Drag {
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint p);
  public struct RECT { public int L, T, R, B; }
  public static string Run(IntPtr h) {
    timeBeginPeriod(1); SetThreadDpiAwarenessContext(new IntPtr(-4));
    RECT r; GetWindowRect(h, out r);
    var log = new StringBuilder();
    foreach (int back in new[] { 0, 1 }) {
      var clock = Stopwatch.StartNew();
      for (double t = 0; ; t = clock.Elapsed.TotalMilliseconds) {
        double k = t >= 1000 ? 1 : (1 - Math.Cos(Math.PI * t / 1000)) / 2;
        if (back == 1) k = 1 - k;
        int w = r.R - r.L + (int)Math.Round(500 * k), hh = r.B - r.T + (int)Math.Round(300 * k);
        SetWindowPos(h, IntPtr.Zero, 0, 0, w, hh, 0x16); // no move, no z-order, no activate
        log.AppendFormat("{0:F2} {1} {2}\\n", (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds, w, hh);
        if (t >= 1000) break;
        Thread.Sleep(8);
      }
      Thread.Sleep(1500); // past the last redraw
    }
    return log.ToString();
  }
}
'@
[Drag]::Run((Get-Process nook | Where-Object { $_.Path -eq '${exe}' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle)`

// Each frame: when, the page's size in physical px, and the length of the text Claude's rows show.
await evaluate(`(() => {
  window.__frames = []
  const rows = document.querySelector('.view:not([hidden]) .xterm-rows')
  const tick = () => {
    let text = 0
    for (const r of rows.children) text += r.textContent.trim().length
    __frames.push([performance.timeOrigin + performance.now(), Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio), text])
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`)

async function drag() {
  let steps, frames
  const events = await trace(['disabled-by-default-devtools.timeline', 'viz'], async () => {
    await sleep(300)
    await evaluate('__frames = []')
    steps = execFileSync('powershell', ['-NoProfile', '-Command', DRAG], { encoding: 'utf8' }).trim().split('\n').map(l => l.split(' ').map(Number))
    frames = await evaluate('__frames')
  })
  const [dw, dh] = [frames[0][1] - steps[0][1], frames[0][2] - steps[0][2]] // window to page size
  const moved = frames.filter((f, i) => i && (f[1] !== frames[i - 1][1] || f[2] !== frames[i - 1][2]))
  const gaps = moved.slice(1).map((f, i) => f[0] - moved[i][0]).filter(g => g < 400) // not the pause between legs
  const peak = steps.reduce((m, s, i) => (s[1] > steps[m][1] ? i : m), 0)
  const lags = steps.flatMap(([t, w, h], i) => {
    const out = i <= peak
    const f = frames.find(f => f[0] >= t && (out ? f[1] - dw >= w - 2 && f[2] - dh >= h - 2 : f[1] - dw <= w + 2 && f[2] - dh <= h + 2))
    return f ? [f[0] - t] : []
  })
  // Each leg's last size, then the last frame within the pause after it whose text changed: Claude's redraw.
  const legs = [steps[peak], steps.at(-1)].map(([t]) => {
    const after = frames.filter(f => f[0] >= t && f[0] < t + 1500)
    const changed = after.filter((f, i) => i && f[3] !== after[i - 1][3])
    return changed.length ? changed.at(-1)[0] - t : 0
  })
  const ms = name => events.filter(e => e.name === name).map(e => e.dur / 1000)
  return {
    gapP50: Math.round(median(gaps)), gapP90: Math.round(quantile(gaps, 0.9)),
    lagP50: Math.round(median(lags)), lagP90: Math.round(quantile(lags, 0.9)),
    redraw: Math.round(Math.max(...legs)),
    raster: Math.round(ms('RasterTask').reduce((s, d) => s + d, 0)),
    composite: +median(ms('Display::DrawAndSwap')).toFixed(1),
  }
}

/** The pixels that differ between two PNG screenshots, compared in the page. */
const diff = (a, b) => evaluate(`(async () => {
  const pixels = async b64 => { const i = new Image(); i.src = 'data:image/png;base64,' + b64; await i.decode()
    const c = new OffscreenCanvas(i.width, i.height), g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data }
  const [a, b] = await Promise.all([pixels(${JSON.stringify(a)}), pixels(${JSON.stringify(b)})])
  let max = 0, over = 0
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
    max = Math.max(max, d); if (d > 2) over++
  }
  return { max, over }
})()`)

/** The element as it holds its bitmaps, its background-* in its style, against the live CSS under them. */
async function parity(selector) {
  const el = `document.querySelector('${selector}')`
  const baked = `[...${el}.style].filter(p => p.startsWith('background-')).map(p => [p, ${el}.style.getPropertyValue(p)])`
  if (!await evaluate(`(window.__baked = ${baked}).some(([, v]) => v.includes('blob:'))`)) return null
  const shot = async () => (await send('Page.captureScreenshot', { format: 'png' })).data
  const held = await shot()
  await evaluate(`for (const [p] of __baked) ${el}.style.removeProperty(p)`)
  await sleep(300)
  const live = await shot()
  await evaluate(`for (const [p, v] of __baked) ${el}.style.setProperty(p, v)`)
  return diff(live, held)
}

const drags = []
for (let i = 0; i < 3; i++) drags.push(await drag())
const summary = Object.fromEntries(Object.keys(drags[0]).map(k => [k, median(drags.map(d => d[k]))]))
const same = {}
for (const s of ['body', '#pane', '#files', '#git']) same[s] = await parity(s)
console.log(JSON.stringify({ drags }))
console.log('median', JSON.stringify(summary))
console.log('parity', JSON.stringify(same))
close()
