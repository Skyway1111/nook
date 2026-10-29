// `claude plugin test src-tauri/mod`: what the mod tells nook a session is doing. Each `on` stands for the
// engine beneath the mod, and the report is the last JSON written to NOOK_STATE.
import { expect, test } from 'claude-code/testing'

const STATE = '/nook/1-0.json'

/** A session that nook started, whose reports land in `reports`. */
function nook(on, reports: Record<string, unknown>[], surfaces = ['terminal']) {
  on('env.get', (_, e) => ({ value: e.name === 'NOOK_STATE' ? STATE : '' }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.every', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { context: 0.1 } }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('config.list', () => ({ value: [] }))
  on('settings.read', () => ({ value: {} }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', (_, e) => {
    if (e.path === STATE) reports.push(JSON.parse(e.text))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('classic.PermissionRequest', () => ({}))
}

const last = (reports: Record<string, unknown>[]) => reports[reports.length - 1]

test('a turn works, runs its tools, notes the files it wrote, and goes idle', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  nook(on, reports)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(last(reports)).toMatchObject({ status: 'idle', turns: 0, session: 'abc' })

  await $.turn.start({ text: 'Fix the tab strip\nand more', turnId: 't1' })
  expect(last(reports)).toMatchObject({ status: 'working', prompt: 'Fix the tab strip' })

  await $.tool.call({ tool: 'Edit', file_path: '/work/src/tabs.js', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/tabs.js', old_string: 'b', new_string: 'c' })
  expect(last(reports)).toMatchObject({ status: 'working', touched: ['/work/notes.md', '/work/src/tabs.js'] })

  await $.turn.complete({ answer: 'Done', durationMs: 5, isAborted: false, reason: 'answer', turnId: 't1' })
  expect(last(reports)).toMatchObject({ status: 'idle', turns: 1, activity: '' })
})

test('a permission prompt or a question to the person waits on them', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  nook(on, reports)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Deploy', turnId: 't1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm publish' } })
  expect(last(reports)).toMatchObject({ status: 'waiting' })
})

test('a session nook did not start reports nothing', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  nook(on, reports, []) // a `claude -p` inside the tab
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  await $.turn.start({ text: 'x', turnId: 't1' })
  expect(reports).toEqual([])
})
