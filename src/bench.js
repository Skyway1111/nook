// Timings for bench/linux.mjs, loaded only when nook starts with NOOK_BENCH set. Each goes to stdout through
// main.rs's `bench`. A frame counts as shown once its rAF callbacks, layout, and paint have run, at the task
// after them.
import { invoke } from '@tauri-apps/api/core'

const report = (event, ms) => invoke('bench', { event, ms })
const shown = f => requestAnimationFrame(() => setTimeout(f))

export function startBench() {
  // ready: the first frame that shows text in a terminal, in ms since nook started
  const seen = new MutationObserver(() => {
    if (!document.querySelector('.xterm-rows')?.textContent.trim()) return
    seen.disconnect()
    shown(() => report('ready'))
  })
  seen.observe(document.body, { childList: true, subtree: true, characterData: true })
  // resize: from the window's resize event to the frame that shows the new size
  addEventListener('resize', () => {
    const t = performance.now()
    shown(() => report('resize', performance.now() - t))
  })
}
