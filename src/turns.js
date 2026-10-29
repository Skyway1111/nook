// Ctrl+Shift+Up and Ctrl+Shift+Down jump between the prompts you sent in a Claude tab, so a long session
// reads turn by turn: the prompt lands at the top of the view and its row flashes once. Claude writes each
// prompt into its history as ❯ and the text (> on Windows). Rows are read only when the keys are pressed.

/** Whether a row of Claude's history is a prompt you sent. */
export const isPrompt = text => /^[>❯][  ]\S/.test(text)

const FLASH_MS = 900

/** Jumps for `term`. Returns `{ jump(up), dispose }`. */
export function startTurns(term) {
  let flash // the row decoration still fading

  function show(row) {
    const b = term.buffer.active
    term.scrollLines(row - b.viewportY - 1) // a row of what came before stays in view above it
    flash?.dispose()
    const marker = term.registerMarker(row - b.baseY - b.cursorY)
    const decoration = marker && term.registerDecoration({ marker, width: term.cols })
    if (!decoration) return marker?.dispose()
    decoration.onRender(e => e.classList.add('turn-flash'))
    const timer = setTimeout(() => decoration.dispose(), FLASH_MS)
    decoration.onDispose(() => { clearTimeout(timer); marker.dispose() })
    flash = decoration
  }

  /** The prompt above the view's top row, or below it; past the last one, the bottom. */
  function jump(up) {
    const b = term.buffer.active
    const top = b.viewportY + 1 // the row under the one `show` keeps above a prompt
    const text = y => b.getLine(y)?.translateToString(true) ?? ''
    if (up) {
      for (let y = top - 1; y >= 0; y--) if (isPrompt(text(y))) return show(y)
    } else {
      for (let y = top + 1; y < b.baseY; y++) if (isPrompt(text(y))) return show(y)
      term.scrollToBottom()
    }
  }

  return { jump, dispose: () => flash?.dispose() }
}
