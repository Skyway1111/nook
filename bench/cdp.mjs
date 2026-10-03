// A CDP session with a dev nook's page, for the bench scripts. Start nook with CDP on its own WebView2 profile,
// fill Claude's screen with transcript (`!ls -laR src` does), then run a script:
//   $env:WEBVIEW2_USER_DATA_FOLDER = "$env:TEMP\nook-cdp"
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222 --disable-gpu'
//   npm run dev -- -- <folder>
export async function connect(port = 9222) {
  const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(resolve => { ws.onopen = resolve })
  let seq = 0
  let events = []
  let traced
  const waiting = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.method === 'Tracing.dataCollected') events.push(...m.params.value)
    else if (m.method === 'Tracing.tracingComplete') traced()
    else waiting.get(m.id)?.(m)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, m => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result.value
  }
  /** The complete trace events of `categories` recorded while `f` runs. */
  async function trace(categories, f) {
    events = []
    await send('Tracing.start', { traceConfig: { includedCategories: categories }, transferMode: 'ReportEvents' })
    await f()
    const done = new Promise(resolve => { traced = resolve })
    await send('Tracing.end')
    await done
    return events.filter(e => e.ph === 'X')
  }
  return { send, evaluate, trace, close: () => ws.close() }
}

export const sleep = t => new Promise(resolve => setTimeout(resolve, t))
export const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1]
export const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]
