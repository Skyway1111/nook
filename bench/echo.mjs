// Times a key's round trip through nook's own path, in a nook started with CDP on (cdp.mjs): the page posts
// `pty_write` and waits for the echo on the session's channel. The session is cmd.exe at its prompt, whose line the
// console server edits itself, so no program's speed is in the number, and no paint. It speaks the host's wire
// directly, so it runs in a release build too.
//   node bench/echo.mjs [port] [keys]
import { connect } from './cdp.mjs'

const page = await connect(Number(process.argv[2] ?? 9222))
const keys = Number(process.argv[3] ?? 300)
const ms = await page.evaluate(`(async () => {
  const wv = chrome.webview
  const fresh = () => 2 ** 44 + Math.floor(Math.random() * 2 ** 40)
  const call = (cmd, args) => new Promise((done, fail) => {
    const id = fresh()
    const on = e => {
      if (typeof e.data !== 'string' || !e.data.startsWith('[' + id + ',')) return
      wv.removeEventListener('message', on)
      const m = JSON.parse(e.data)
      m[1] ? done(m[2]) : fail(m[2])
    }
    wv.addEventListener('message', on)
    wv.postMessage([id, cmd, args])
  })
  const channel = fresh()
  let heard = () => {}
  wv.addEventListener('message', e => typeof e.data === 'string' && e.data.startsWith(channel + ' ') && heard())
  const echo = data => new Promise(done => { heard = done; wv.postMessage([fresh(), 'pty_write', { id, data }]) })
  const id = await call('pty_spawn', { command: ['cmd.exe'], cwd: 'C:\\\\', cols: 80, rows: 24, onData: channel })
  await new Promise(r => setTimeout(r, 1500))
  const times = []
  for (let i = 0; i < ${keys}; i++) {
    const t = performance.now()
    await echo('x')
    times.push(performance.now() - t)
    await echo('\\x7f')
    await new Promise(r => setTimeout(r, 15))
  }
  await call('pty_close', { id })
  return times
})()`)
page.close()
ms.sort((a, b) => a - b)
const at = q => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))].toFixed(2)
console.log(`${ms.length} keys: median ${at(0.5)} ms, p90 ${at(0.9)}, p99 ${at(0.99)}, min ${at(0)}`)
