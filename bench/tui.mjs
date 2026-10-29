// A stand-in for Claude Code's fullscreen view, for bench/linux.mjs: the alternate screen, a transcript, the
// prompt between two full-width rules, and a footer. Like Claude, it redraws the whole screen for each key, as
// ESC [ 2 J and then every row, and ends each frame by showing the cursor in the prompt. Enter moves the draft
// into the transcript. It needs no network and no account, so a bench of the composer and the row patching is
// repeatable.
const out = process.stdout
const ESC = '\x1b'
const colors = [`${ESC}[38;5;174m`, `${ESC}[38;5;110m`, `${ESC}[38;5;150m`, `${ESC}[38;5;180m`]
// Each entry is [color, text]; a row shows as much of its text as fits.
const transcript = Array.from({ length: 60 }, (_, i) =>
  [colors[i % 4], `● ${i % 3 ? 'Read' : 'Update'}(src/file${i}.js) ⎿ ${i * 7} lines, the quick brown fox jumps over the lazy dog`])
let draft = ''

function frame() {
  const cols = out.columns || 80
  const rows = out.rows || 24
  const rule = `${ESC}[38;5;244m${'─'.repeat(cols)}${ESC}[0m`
  const wrapped = []
  for (let i = 0; i < Math.max(1, draft.length); i += cols - 4) wrapped.push(draft.slice(i, i + cols - 4))
  const prompt = wrapped.map((s, i) => (i ? '  ' : '❯ ') + s)
  const foot = [`${ESC}[2m  ? for shortcuts${ESC}[0m`]
  const body = rows - prompt.length - 2 - foot.length
  const shown = transcript.slice(-body).map(([c, t]) => `${c}${t.slice(0, cols - 1)}${ESC}[0m`)
  const lines = [...Array(Math.max(0, body - shown.length)).fill(''), ...shown, rule, ...prompt, rule, ...foot]
  const last = wrapped.at(-1)
  const y = body + prompt.length // the last prompt row, 0-based, past the rule above the prompt
  out.write(`${ESC}[?25l${ESC}[2J${ESC}[H` + lines.map(s => `${s}${ESC}[K`).join('\r\n') + `${ESC}[${y + 1};${last.length + 3}H${ESC}[?25h`)
}

out.write(`${ESC}[?1049h`)
process.stdin.setRawMode(true)
process.stdin.on('data', d => {
  for (const ch of d.toString()) {
    if (ch === '\r') { transcript.push([`${ESC}[1m`, `> ${draft}`]); draft = '' }
    else if (ch === '\x7f') draft = draft.slice(0, -1)
    else if (ch === '\x03') { out.write(`${ESC}[?1049l`); process.exit(0) }
    else if (ch >= ' ') draft += ch
  }
  frame()
})
out.on('resize', frame)
frame()
