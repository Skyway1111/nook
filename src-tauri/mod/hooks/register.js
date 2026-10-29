// Tells nook's composer what to show beside Claude's prompt, runs the two commands its menus send, and
// draws pictures in the transcript. Every hook passes its event on unchanged, and the render hooks add
// pictures under Claude's own drawing, and under a shell command's result the line that says how it went. The mod writes the session's model, effort, effort levels, context
// fill, pasted images' folder, and what the session is doing as JSON to NOOK_STATE, and reads requests from
// the .cmd file beside it: { command, args, at }.
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] // the menu's aliases, each its family's latest model
const ROWS = 20 // the tallest picture, in rows
const ROW_PIXELS = 20 // a picture's pixels per row, so a small one draws near its own size
const INDENT = 5 // to the text after `  ⎿  `
const UNKNOWN = [1600, 900] // the size of a picture whose own can't be read
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) // the tools whose file nook marks as Claude's
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode']) // the tools that wait on the person
const TOUCHED = 200 // the most files a report lists
const sizes = new Map() // a pasted image's path -> its size, as a promise
const TAIL = 64 * 1024 // the end of a command's output that its outcome is read from
const SLOW = 3000 // ms past which a command's outcome line says how long it took
const TIMES = 500 // the most commands whose run time is kept
const times = new Map() // a Bash call's tool_use_id -> ms it ran
const GROUP_ROWS = 6 // the most outcome rows under a folded run of calls
let state = { efforts: LEVELS }
let wrote = ''
let handled = '' // the last request run, so each runs once

async function report($, file, patch) {
  state = { ...state, ...patch }
  const text = JSON.stringify(state)
  if (text !== wrote) await $.fs.write(file, (wrote = text))
}

/** The model, the menu's aliases that Claude offers, and the model's saved effort when it changes. */
async function model($) {
  const id = await $.session.model()
  if (id === state.model) return {}
  const row = (await $.config.list()).find(r => r.key === 'model')
  const { modelSettings, effortLevel } = await $.settings.read()
  const effort = modelSettings?.[id.replace(/\[.*\]$/, '')]?.effortLevel ?? effortLevel
  return { model: id, models: MODELS.filter(a => row?.options?.includes(a)), ...(effort && { effort }) }
}

/** One line about a tool call, as the tab strip and the dashboard show it: the tool and what it works on. */
function activity(e) {
  const name = path => String(path).split(/[\\/]/).pop()
  const cut = text => String(text).split('\n')[0].slice(0, 80)
  const what = e.file_path ? name(e.file_path) : e.notebook_path ? name(e.notebook_path) : e.command ? cut(e.command)
    : e.description ? cut(e.description) : e.pattern ? cut(e.pattern) : e.url ? cut(e.url) : e.query ? cut(e.query) : ''
  return what ? `${e.tool} · ${what}` : String(e.tool)
}

/** Runs a request from nook's menus, if one arrived: `/model <alias>` or `/effort <level>`. */
async function take($, file) {
  const text = await $.fs.read(file).catch(() => '')
  if (!text || text === handled) return {}
  handled = text
  let request
  try {
    request = JSON.parse(text)
  } catch {
    return {} // caught mid-write; the whole request differs, so the next tick runs it
  }
  const { command, args } = request
  const ok = command === 'effort' ? LEVELS.includes(args) : command === 'model' && state.models?.includes(args)
  if (!ok) return {}
  await $.command.run({ command, args })
  return command === 'effort' ? { effort: args } : {}
}

/** Claude's drawing of a transcript row, with a picture of each [path, [width, height]] under it. */
function withPictures($, e, theirs, pictures) {
  const { Box, Image } = $.ui.resolve(e)
  const room = Math.min(255, (e.viewport?.columns ?? 80) - INDENT - 1)
  return Box({
    flexDirection: 'column',
    children: [theirs, ...pictures.map(([path, size]) => {
      const [w, h] = size[0] > 0 && size[1] > 0 ? size : UNKNOWN
      // A cell is about twice as tall as it is wide.
      let rows = Math.min(ROWS, Math.ceil(h / ROW_PIXELS))
      let columns = Math.max(1, Math.round((2 * rows * w) / h))
      if (columns > room) [columns, rows] = [room, Math.max(1, Math.round((room * h) / (2 * w)))]
      // nook decodes the file itself, so `png` stands for JPEG, GIF, WebP, and SVG too.
      const image = Image({ source: { file: path, format: 'png' }, columns, rows, alt: path.split(/[\\/]/).pop() })
      return Box({ paddingLeft: INDENT, children: [image] })
    })],
  })
}

/** The [width, height] of the picture a Read call read, or null for any other file. */
function readSize(path, output) {
  if (output?.type === 'image') {
    const d = output.file.dimensions ?? {}
    return [d.originalWidth ?? d.displayWidth, d.originalHeight ?? d.displayHeight]
  }
  if (output?.type !== 'text' || !/\.svg$/i.test(path)) return null
  const box = /viewBox\s*=\s*["'][^"']*?([\d.]+)[\s,]+([\d.]+)\s*["']/.exec(output.file.content)
  return box ? [Number(box[1]), Number(box[2])] : UNKNOWN
}

/** A PNG's [width, height], from its header. */
async function pngSize($, path) {
  const { base64 } = await $.fs.read(path, { as: 'bytes' })
  const head = atob(base64.slice(0, 32))
  const u32 = at => [0, 1, 2, 3].reduce((n, i) => n * 256 + head.charCodeAt(at + i), 0)
  return [u32(16), u32(20)]
}

/** The folder Claude saves the session's nth pasted image to, as <n>.png. nook's `session_image` reads it from the report. */
async function imagesDir($) {
  const slug = (await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-')
  const temp = (await $.env.get('NOOK_CLAUDE_TEMP')) || `${await $.env.get('TEMP')}\\claude`
  return [temp, slug, await $.session.id(), 'images'].join(sep(temp))
}

/** The separator `path` is written with: Windows' backslash, or a slash. */
const sep = path => (path.includes('\\') ? '\\' : '/')

/** The images pasted into a prompt, as [path, size]. */
async function pasted($, text) {
  const dir = await imagesDir($)
  const pictures = []
  for (const n of new Set(Array.from(text.matchAll(/\[Image #(\d+)\]/g), m => m[1]))) {
    const path = `${dir}${sep(dir)}${n}.png`
    if (!(await $.fs.exists(path))) continue
    if (!sizes.has(path)) sizes.set(path, pngSize($, path).catch(() => UNKNOWN)) // past 4 MiB, $.fs.read refuses
    pictures.push([path, await sizes.get(path)])
  }
  return pictures
}

/** The passed and failed counts a test runner's own summary gives, summed over every summary of the first
 * runner found (cargo prints one per crate), or null when the output holds none. */
export function testCounts(text) {
  const lines = text.slice(-TAIL).split('\n')
  const count = (part, word) => Number(new RegExp(`(\\d+) ${word}`).exec(part)?.[1] ?? 0)
  const runners = [
    // cargo: test result: ok. 26 passed; 0 failed; 0 ignored
    [/^test result: \w+\. (.*)/, m => [count(m[1], 'passed'), count(m[1], 'failed')]],
    // node --test, TAP and spec: # pass 93, ℹ fail 0
    [/^(?:#|ℹ) (pass|fail) (\d+)$/, m => (m[1] === 'pass' ? [Number(m[2]), 0] : [0, Number(m[2])])],
    // jest: Tests:       2 failed, 91 passed, 93 total
    [/^Tests:\s+(.*\d+ total)/, m => [count(m[1], 'passed'), count(m[1], 'failed')]],
    // vitest: Tests  2 failed | 91 passed (93)
    [/^\s*Tests\s+(.*)\(\d+\)/, m => [count(m[1], 'passed'), count(m[1], 'failed')]],
    // pytest: ===== 2 failed, 91 passed in 1.23s =====
    [/^=+ (.*(?:passed|failed).*) in [\d.]+s/, m => [count(m[1], 'passed'), count(m[1], 'failed') + count(m[1], 'errors?')]],
    // mocha: 91 passing, 2 failing
    [/^\s*(\d+) (passing|failing)\b/, m => (m[2] === 'passing' ? [Number(m[1]), 0] : [0, Number(m[1])])],
  ]
  for (const [pattern, read] of runners) {
    let found = null
    for (const line of lines) {
      const m = pattern.exec(line.replace(/\x1b\[[\d;]*m/g, ''))
      if (!m) continue
      const [passed, failed] = read(m)
      found = { passed: (found?.passed ?? 0) + passed, failed: (found?.failed ?? 0) + failed }
    }
    if (found) return found
  }
  return null
}

const ERROR = /^(?:error(?:\[E\d+\])?:|.*\berror TS\d+:|\w*Error:|\w+Exception:|npm ERR!|fatal:|FAIL\b|thread '.*' panicked|panic:)/

/** The line of a failed command's output that says what went wrong, with a Rust error's `-->` place, or
 * null when no line looks like one. A Python traceback names its error last; everything else first. */
export function errorLine(text) {
  const lines = text.slice(-TAIL).split('\n').map(l => l.replace(/\x1b\[[\d;]*m/g, '').trimEnd())
  const traceback = lines.findIndex(l => l.startsWith('Traceback '))
  const at = traceback >= 0 ? lines.findLastIndex(l => /^\w+(Error|Exception)\b/.test(l)) : lines.findIndex(l => ERROR.test(l.trimStart()))
  if (at < 0) return null
  const place = lines.slice(at + 1, at + 3).map(l => /^\s*--> (\S+)/.exec(l)?.[1]).find(Boolean)
  return lines[at].trim() + (place ? ` at ${place}` : '')
}

/** One outcome row under Claude's own, its parts dim unless they carry a color. */
function outcomeRow(Box, Text, parts) {
  const runs = parts.flatMap(([text, color], i) => [
    ...(i ? [Text({ dimColor: true, children: ' · ' })] : []),
    Text(color ? { color, children: text } : { dimColor: true, children: text }),
  ])
  return Box({ paddingLeft: INDENT, children: [Text({ wrap: 'truncate-end', children: runs })] })
}

/** How long a command ran, as `14s` or `1m 12s`. */
const took = ms => (ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`)

/** The line under a finished shell command that says how it went: a test run's counts, a failure's error,
 * and the time a slow one took. Each is [text, theme color]; null when there is nothing to add. */
export function outcome(output, isErrored, ms) {
  const text = typeof output === 'string' ? output : [output?.stdout, output?.stderr].filter(Boolean).join('\n')
  const parts = []
  const tests = text ? testCounts(text) : null
  if (tests?.failed) parts.push([`✗ ${tests.failed} failed, ${tests.passed} passed`, 'error'])
  else if (tests) parts.push([`✓ ${tests.passed} passed`, 'success'])
  else if (isErrored && text) {
    const line = errorLine(text)
    // Claude shows the first lines of a failure itself.
    const shown = text.split('\n').slice(0, 4).map(l => l.trim())
    if (line && !shown.includes(line)) parts.push([`↳ ${line.slice(0, 200)}`, 'error'])
  }
  if (ms >= SLOW) parts.push([`took ${took(ms)}`, null])
  return parts.length ? parts : null
}

// What the session is doing: `status` is working, waiting (on the person), or idle, since `since`;
// `activity` the tool running, `prompt` the main turn's first line, `agents` the subagents running,
// `turns` the main turns finished, and `touched` the files Claude wrote, newest last.
const agents = new Set()
const running = new Map() // tool_use_id -> activity, of the calls under way

async function setStatus($, file, status, patch = {}) {
  const since = status === state.status ? state.since : await $.clock.now()
  const last = [...running.values()].pop() ?? ''
  await report($, file, { status, since, activity: status === 'idle' ? '' : last, agents: agents.size, ...patch })
}

export function register(on) {
  let file = null
  on('session.start', async ($, e, next) => {
    const path = await $.env.get('NOOK_STATE')
    // A `claude -p` that Claude runs inside the tab inherits NOOK_STATE too, and draws on no surface.
    if (path && (await $.session.surfaces()).length) {
      file = path
      const requests = path.replace(/\.json$/, '.cmd')
      handled = await $.fs.read(requests).catch(() => '') // a request from an earlier session is spent
      await setStatus($, file, 'idle', { turns: 0, touched: [], prompt: '' })
      // /clear starts a new session, with an empty context and a new images folder.
      const tick = async () => report($, file, {
        ...(await take($, requests)), context: (await $.session.usage()).context, images: await imagesDir($), session: await $.session.id(), root: await $.session.root(), ...(await model($)),
      })
      await tick()
      $.clock.every(250, () => tick().catch(() => {})) // a failed tick leaves the last report standing
    }
    return next(e)
  })
  on('turn.start', async ($, e, next) => {
    if (file && e.agentId) agents.add(e.agentId)
    if (file) {
      const patch = e.agentId ? {} : { prompt: e.text.trim().split('\n')[0].slice(0, 200) }
      await setStatus($, file, 'working', patch).catch(() => {})
    }
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!file) return result
    if (e.agentId) {
      agents.delete(e.agentId)
      await setStatus($, file, state.status).catch(() => {})
    } else {
      running.clear()
      agents.clear()
      await setStatus($, file, 'idle', { turns: (state.turns ?? 0) + 1, ended: e.reason }).catch(() => {})
    }
    return result
  })
  on('tool.call', async ($, e, next) => {
    if (!file) return next(e)
    const id = e.tool_use_id ?? `${e.tool}-${running.size}`
    running.set(id, activity(e))
    await setStatus($, file, ASKS.has(e.tool) && !e.agentId ? 'waiting' : 'working').catch(() => {})
    try {
      return await next(e)
    } finally {
      running.delete(id)
      const path = EDITS.has(e.tool) ? e.file_path ?? e.notebook_path : null
      const touched = path ? [...(state.touched ?? []).filter(p => p !== path), path].slice(-TOUCHED) : state.touched
      // A call that ran after the turn ended (a hook's own) leaves the session idle.
      await setStatus($, file, state.status === 'idle' ? 'idle' : 'working', { touched }).catch(() => {})
    }
  })
  // How long each shell command ran, for the line under its result.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!e.tool_use_id) return next(e)
    const start = await $.clock.now()
    const result = await next(e)
    times.set(e.tool_use_id, (await $.clock.now()) - start)
    if (times.size > TIMES) times.delete(times.keys().next().value)
    return result
  })
  // A permission prompt: the session waits on the person until the call runs or the turn ends.
  on('classic.PermissionRequest', async ($, e, next) => {
    const result = await next(e)
    if (file && !result?.decision) await setStatus($, file, 'waiting').catch(() => {})
    return result
  })
  on('session.end', async ($, e, next) => {
    // After a /clear the process goes on as a new session, with nothing yet said.
    if (file) await setStatus($, file, 'idle', { ended: e.reason, prompt: '' }).catch(() => {})
    return next(e)
  })
  // The effort each request goes out with, the main agent's only.
  on('turn.step', async function* ($, e, next) {
    if (file && !e.agentId && e.effort != null) await report($, file, { effort: String(e.effort) })
    return yield* next(e)
  })
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    if (file && LEVELS.includes(e.args.trim())) await report($, file, { effort: e.args.trim() })
    return result
  })
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, input, output } = e.props
    const size = tool === 'Read' ? readSize(input.file_path, output) : null
    return size ? withPictures($, e, await next(e), [[input.file_path, size]]) : next(e)
  })
  // A shell command's result, drawn alone under its row.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { tool, tool_use_id, output, isErrored, isExpanded } = e.props
    const parts = tool === 'Bash' && !isExpanded ? outcome(output, isErrored, times.get(tool_use_id)) : null
    if (!parts) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [await next(e), outcomeRow(Box, Text, parts)] })
  })
  // A run of calls Claude folds into one line, such as `Ran 2 shell commands`: under it, each finished
  // command that has something to say, by its own words.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const rows = []
    for (const call of e.props.calls) {
      if (call.tool !== 'Bash' || call.isRunning || call.isInterrupted) continue
      const parts = outcome(call.output, call.isErrored, times.get(call.tool_use_id))
      const command = String(call.input?.command ?? '').split('\n')[0]
      if (parts) rows.push([[command.length > 40 ? `${command.slice(0, 39)}…` : command, null], ...parts])
    }
    if (!rows.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const shown = rows.slice(0, GROUP_ROWS).map(parts => outcomeRow(Box, Text, parts))
    if (rows.length > GROUP_ROWS) shown.push(outcomeRow(Box, Text, [[`and ${rows.length - GROUP_ROWS} more`, null]]))
    return Box({ flexDirection: 'column', children: [await next(e), ...shown] })
  })
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const pictures = e.props.text.includes('[Image #') ? await pasted($, e.props.text) : []
    return pictures.length ? withPictures($, e, await next(e), pictures) : next(e)
  })
}
