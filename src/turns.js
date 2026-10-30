// Ctrl+Shift+Up and Ctrl+Shift+Down jump between the prompts you sent in a Claude tab, so a long session
// reads turn by turn: the prompt lands at the top of the view and its row flashes once. Claude writes each
// prompt into its history as ❯ and the text (> on Windows). Rows are read only when the keys are pressed.
//
// Claude Code runs fullscreen on the alternate screen, where it scrolls its own transcript and the terminal
// keeps no history. There a jump pages Claude's view with Claude's own Page Up and Page Down until the prompt
// shows in the top half of the view, and flashes it there; the next jump goes on from it.

/** Whether a row of Claude's history is a prompt you sent. */
export const isPrompt = text => /^[>❯][  ]\S/.test(text)

const FLASH_MS = 900
const PAGES = 200 // the most pages one jump turns through Claude's view
const QUIET_MS = 60 // how long Claude's output pauses before its redraw counts as done
const WAIT_MS = 600 // how long to wait for a redraw that may not come, at either end of the view
const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'
const TO_BOTTOM = '\x1b[1;5F' // Ctrl+End
const RULE = /^─{8,}(?: .+ ─+)?\s*$/ // with the session's name in it, once named

/** The row where Claude's transcript ends on its fullscreen view: the top rule of its input box. */
export function transcriptEnd(screen) {
  const rules = screen.flatMap((row, i) => (RULE.test(row) ? [i] : []))
  return rules.length >= 2 ? rules.at(-2) : screen.length
}

/** The rows of Claude's fullscreen view that hold prompts you sent. Row 0 is left out: while the view is
 * scrolled, Claude pins there the prompt the top of the view answers. */
export function promptRows(screen) {
  const rows = []
  for (let r = 1; r < transcriptEnd(screen); r++) if (isPrompt(screen[r])) rows.push(r)
  return rows
}

/** How many rows the transcript moved down the view from `before` to `after` (negative: up), found by where
 * the first three rows in a row of `before` that show in `after` are; null when none do. */
export function moved(before, after) {
  const [from, to] = [transcriptEnd(before), transcriptEnd(after)]
  for (let i = 1; i + 3 <= from; i++) {
    const run = before.slice(i, i + 3)
    if (run.some(row => !row.trim())) continue
    for (let j = 1; j + 3 <= to; j++) if (run.every((row, k) => after[j + k] === row)) return j - i
  }
  return null
}

/** Paging through Claude's fullscreen view, for `term` whose keys go to Claude through `send`: `screen()`
 * reads the rows shown, `redrawn()` waits for Claude's redraw after a key, and `page(up, rows)` presses Page
 * Up or Page Down and says how far the transcript moved from `rows`: `{ after, shift }`, with shift 0 at the
 * view's end and null when it can't tell. */
export function startPaging(term, send) {
  const screen = () => Array.from({ length: term.rows }, (_, y) => term.vt.buffer.getLine(y)?.translateToString(true) ?? '')

  /** Whether Claude redrew after a key: output came and then paused. */
  function redrawn() {
    return new Promise(done => {
      let quiet
      const wait = setTimeout(() => end(false), WAIT_MS)
      const parsed = term.onWriteParsed(() => {
        clearTimeout(wait)
        clearTimeout(quiet)
        quiet = setTimeout(() => end(true), QUIET_MS)
      })
      function end(drew) {
        parsed.dispose()
        clearTimeout(wait)
        clearTimeout(quiet)
        done(drew)
      }
    })
  }

  async function page(up, rows = screen()) {
    send(up ? PAGE_UP : PAGE_DOWN)
    const drew = await redrawn()
    const after = screen()
    return { after, shift: drew ? moved(rows, after) : 0 }
  }

  return { screen, page, redrawn }
}

/** Jumps for `term`, whose keys go to Claude through `send`. Returns `{ jump(up), dispose }`. */
export function startTurns(term, send) {
  let flash = null // the row still fading: { mark, timer }
  let busy = false // a jump through Claude's own view is under way

  function unflash() {
    if (!flash) return
    clearTimeout(flash.timer)
    flash.mark.dispose()
    flash = null
  }

  /** Flashes buffer line `row`. */
  function mark(row) {
    unflash()
    flash = { mark: term.mark(row, { className: 'turn-flash' }), timer: setTimeout(unflash, FLASH_MS) }
  }

  function show(row) {
    term.scrollLines(row - term.vt.buffer.viewportY - 1) // a row of what came before stays in view above it
    mark(row)
  }

  /** The prompt above the view's top row, or below it; past the last one, the bottom. */
  function jump(up) {
    const b = term.vt.buffer
    if (b.type === 'alternate') return fullscreen(up)
    const top = b.viewportY + 1 // the row under the one `show` keeps above a prompt
    const text = y => b.getLine(y)?.translateToString(true) ?? ''
    if (up) {
      for (let y = top - 1; y >= 0; y--) if (isPrompt(text(y))) return show(y)
    } else {
      for (let y = top + 1; y < b.baseY; y++) if (isPrompt(text(y))) return show(y)
      term.scrollToBottom()
    }
  }

  const { screen, page } = startPaging(term, send)

  // The prompt a jump on Claude's own view last flashed: while it still shows on that row, the next jump
  // goes on from it, not from the view's top.
  let landed = null // { row, text }

  function land(row, rows) {
    landed = { row, text: rows[row] }
    mark(row)
  }

  async function fullscreen(up) {
    if (busy) return
    busy = true
    try {
      let rows = screen()
      let from = landed && rows[landed.row] === landed.text ? landed.row : 1 // where the jump goes on from
      for (let n = 0; n < PAGES; n++) {
        const prompts = promptRows(rows)
        const half = transcriptEnd(rows) / 2
        if (up) {
          const above = prompts.filter(r => r < from).at(-1)
          if (above) return land(above, rows)
        } else {
          const below = prompts.find(r => r > from)
          if (below && below <= half) return land(below, rows)
        }
        const { after, shift } = await page(up, rows)
        if (shift === null) return // the view changed past reading: leave it where Claude put it
        if (shift === 0) {
          // The view is at its end: a prompt still below the top flashes where it is.
          const below = !up && promptRows(after).find(r => r > from)
          if (below) return land(below, after)
          break
        }
        from += shift
        rows = after
      }
      if (!up) send(TO_BOTTOM)
    } finally {
      busy = false
    }
  }

  return { jump, dispose: unflash }
}
