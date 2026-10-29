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
  expect(last(reports)).toMatchObject({ status: 'idle', turns: 0, session: 'abc', root: '/work' })

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

import { errorLine, outcome, readPaths, testCounts } from './register.js'

test('a test run reads as its own summary says, summed over cargo crates', () => {
  expect(testCounts('running 3 tests\ntest result: ok. 26 passed; 0 failed; 0 ignored\n\ntest result: FAILED. 2 passed; 1 failed; 0 ignored')).toEqual({ passed: 28, failed: 1 })
  expect(testCounts('# tests 93\n# pass 93\n# fail 0\n')).toEqual({ passed: 93, failed: 0 })
  expect(testCounts('ℹ pass 12\nℹ fail 2\n')).toEqual({ passed: 12, failed: 2 })
  expect(testCounts('Tests:       2 failed, 91 passed, 93 total\n')).toEqual({ passed: 91, failed: 2 })
  expect(testCounts('      Tests  2 failed | 91 passed (93)\n')).toEqual({ passed: 91, failed: 2 })
  expect(testCounts('===== 1 failed, 40 passed, 1 error in 1.23s =====')).toEqual({ passed: 40, failed: 2 })
  expect(testCounts('  91 passing (2s)\n  2 failing\n')).toEqual({ passed: 91, failed: 2 })
  expect(testCounts('\x1b[32m# pass 5\x1b[0m\n')).toEqual({ passed: 5, failed: 0 })
  expect(testCounts('total 12\ndrwxr-xr-x src\n')).toBeNull()
})

test('a failure names its error line, with a Rust error\'s place', () => {
  expect(errorLine('   Compiling nook\nerror[E0308]: mismatched types\n  --> src/main.rs:42:5\n   |\n')).toBe('error[E0308]: mismatched types at src/main.rs:42:5')
  expect(errorLine('src/app.ts(3,5): error TS2322: Type \'string\' is not assignable\n')).toBe("src/app.ts(3,5): error TS2322: Type 'string' is not assignable")
  expect(errorLine('Traceback (most recent call last):\n  File "a.py", line 1\n    x()\nNameError: name \'x\' is not defined\n')).toBe("NameError: name 'x' is not defined")
  expect(errorLine('fatal: not a git repository\n')).toBe('fatal: not a git repository')
  expect(errorLine('all good\n')).toBeNull()
})

test('the outcome line: counts, an error Claude does not already show, and a slow run\'s time', () => {
  expect(outcome({ stdout: '# pass 93\n# fail 0\n', stderr: '' }, false, 900)).toEqual([['✓ 93 passed', 'success']])
  expect(outcome({ stdout: 'ℹ pass 91\nℹ fail 2\n', stderr: '' }, true, 14200)).toEqual([['✗ 2 failed, 91 passed', 'error'], ['took 14s', null]])
  const long = ['Exit code 101', ...Array.from({ length: 30 }, (_, i) => `   Compiling crate${i}`), 'error[E0425]: cannot find value `x`', '  --> src/lib.rs:3:5'].join('\n')
  expect(outcome(long, true, 75000)).toEqual([['↳ error[E0425]: cannot find value `x` at src/lib.rs:3:5', 'error'], ['took 1m 15s', null]])
  expect(outcome('Exit code 128\nfatal: not a git repository', true, 100)).toBeNull() // Claude shows it already
  expect(outcome({ stdout: 'ok', stderr: '' }, false, 3500)).toEqual([['took 3.5s', null]])
  expect(outcome({ stdout: 'ok', stderr: '' }, false, 200)).toBeNull()
  expect(outcome({ stdout: 'ok', stderr: '' }, false, undefined)).toBeNull()
})

test('a shell command\'s result gets the line under it, on every surface, and not in the full transcript', async ($, on) => {
  let now = 0
  on('clock.now', () => ({ value: (now += 6000) }))
  on('tool.call', () => ({ result: { stdout: '# pass 93\n# fail 0\n', stderr: '' } }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'b1' })
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const isExpanded of [false, true]) {
      const ui = await $.ui.mount({
        plugin: 'nook', surface, component: 'ToolResult', requestId: 'b1',
        props: { tool_use_id: 'b1', tool: 'Bash', output: { stdout: '# pass 93\n# fail 0\n', stderr: '' }, isErrored: false, isExpanded },
      })
      expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
      const line = await ui.find({ type: 'Text', text: /passed/ })
      if (isExpanded) expect(line).toBeFalsy()
      else expect(line?.text).toContain('✓ 93 passed · took 6.0s')
      await ui.unmount()
    }
  }
})

test('a folded run of commands lists each one that has something to say, and unfolded lists none', async ($, on) => {
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'Ran 3 shell commands' }))
  const calls = [
    { tool_use_id: 'g1', tool: 'Bash', input: { command: 'npm test' }, isRunning: false, isErrored: true, isInterrupted: false, output: 'Exit code 1\nℹ pass 10\nℹ fail 2' },
    { tool_use_id: 'g2', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: 'a b', stderr: '' } },
    { tool_use_id: 'g3', tool: 'Bash', input: { command: 'cargo test' }, isRunning: true, isErrored: false, isInterrupted: false },
  ]
  for (const isExpanded of [false, true]) {
    const ui = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'ToolGroup', requestId: 'grp', props: { calls, isActive: false, isExpanded } })
    const line = await ui.find({ type: 'Text', text: /failed/ })
    if (isExpanded) expect(line).toBeFalsy()
    else expect(line?.text).toBe('npm test · ✗ 2 failed, 10 passed')
    expect(await ui.find({ type: 'Text', text: /^ls/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /cargo/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('a folded run of reads names its files, relative to the session, once each', async ($, on) => {
  const read = (id: string, file_path: string, more = {}) => ({ tool_use_id: id, tool: 'Read', input: { file_path }, isRunning: false, isErrored: false, isInterrupted: false, ...more })
  const calls = [read('r1', '/work/src/app.js'), read('r2', '/work/src/app.js'), read('r3', '/etc/hosts'), read('r4', '/work/x.js', { isErrored: true }), read('r5', '/work/y.js', { isRunning: true })]
  expect(readPaths(calls, '/work')).toEqual(['src/app.js', '/etc/hosts'])
  expect(readPaths(calls, 'C:\\work')).toEqual(['/work/src/app.js', '/etc/hosts'])
  expect(readPaths([read('w', 'C:\\work\\src\\a.rs')], 'C:\\work\\')).toEqual(['src\\a.rs'])

  on('session.root', () => ({ value: '/work' }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'Read 3 files' }))
  const many = Array.from({ length: 10 }, (_, i) => read(`m${i}`, `/work/f${i}.js`))
  const ui = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'ToolGroup', requestId: 'reads', props: { calls: many, isActive: false, isExpanded: false } })
  expect((await ui.find({ type: 'Text', text: /f0\.js/ }))?.text).toBe('f0.js, f1.js, f2.js, f3.js, f4.js, f5.js, f6.js, f7.js, and 2 more')
  await ui.unmount()
})
