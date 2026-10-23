// Tells nook's composer what to show beside Claude's prompt, runs the two commands its menus send, and
// draws pictures in the transcript. Every hook passes its event on unchanged, and the two render hooks add
// pictures under Claude's own drawing. The mod writes the session's model, effort, effort levels, context
// fill, and pasted images' folder as JSON to NOOK_STATE, and reads requests from the .cmd file beside it:
// { command, args, at }.
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] // the menu's aliases, each its family's latest model
const ROWS = 20 // the tallest picture, in rows
const ROW_PIXELS = 20 // a picture's pixels per row, so a small one draws near its own size
const INDENT = 5 // to the text after `  ⎿  `
const UNKNOWN = [1600, 900] // the size of a picture whose own can't be read
const sizes = new Map() // a pasted image's path -> its size, as a promise
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
  return `${await $.env.get('TEMP')}\\claude\\${slug}\\${await $.session.id()}\\images`
}

/** The images pasted into a prompt, as [path, size]. */
async function pasted($, text) {
  const dir = await imagesDir($)
  const pictures = []
  for (const n of new Set(Array.from(text.matchAll(/\[Image #(\d+)\]/g), m => m[1]))) {
    const path = `${dir}\\${n}.png`
    if (!(await $.fs.exists(path))) continue
    if (!sizes.has(path)) sizes.set(path, pngSize($, path).catch(() => UNKNOWN)) // past 4 MiB, $.fs.read refuses
    pictures.push([path, await sizes.get(path)])
  }
  return pictures
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
      // /clear starts a new session, with an empty context and a new images folder.
      const tick = async () => report($, file, {
        ...(await take($, requests)), context: (await $.session.usage()).context, images: await imagesDir($), ...(await model($)),
      })
      await tick()
      $.clock.every(250, () => tick().catch(() => {})) // a failed tick leaves the last report standing
    }
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
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const pictures = e.props.text.includes('[Image #') ? await pasted($, e.props.text) : []
    return pictures.length ? withPictures($, e, await next(e), pictures) : next(e)
  })
}
