// `claude plugin test src-tauri/mod`: what the mod tells nook a session is doing. Each `on` stands for the
// engine beneath the mod, and the report is the last JSON written to NOOK_STATE.
import { expect, test } from 'claude-code/testing'

const STATE = '/nook/1-0.json'
const USAGE = {
  startedAt: 0,
  context: { tokens: 20000, window: 200000, percent: 10 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 42.5, resetsAt: '2026-10-29T20:00:00Z' }],
  cost: { usd: 0.42 },
}

/** A session that nook started, whose reports land in `reports`. */
function nook(on, reports: Record<string, unknown>[], surfaces = ['terminal'], written: Record<string, string> = {}, results: Record<string, unknown> = {}) {
  on('env.get', (_, e) => ({ value: e.name === 'NOOK_STATE' ? STATE : '' }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.every', () => ({ value: undefined }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('config.list', () => ({ value: [] }))
  on('settings.read', () => ({ value: {} }))
  on('fs.read', (_, e) => ({ value: written[e.path] ?? '' }))
  on('fs.write', (_, e) => {
    if (e.path === STATE) reports.push(JSON.parse(e.text))
    else written[e.path] = e.text
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e) => ({ result: results[e.tool_use_id] ?? {} }))
  on('classic.PermissionRequest', () => ({}))
  on('session.end', () => ({ sessionId: 'abc' }))
}

const last = (reports: Record<string, unknown>[]) => reports[reports.length - 1]

test('a turn works, runs its tools, notes the files it wrote, and goes idle', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  nook(on, reports)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(last(reports)).toMatchObject({ status: 'idle', turns: 0, session: 'abc', root: '/work' })
  // What the session holds and has cost, and the account's limits, for the dashboard's cards.
  expect(last(reports)).toMatchObject({
    context: { tokens: 20000, window: 200000, percent: 10 }, cost: 0.42,
    limits: [{ kind: 'five_hour', used: 42.5, resetsAt: '2026-10-29T20:00:00Z' }],
  })

  await $.turn.start({ text: 'Fix the tab strip\nand more', turnId: 't1' })
  expect(last(reports)).toMatchObject({ status: 'working', prompt: 'Fix the tab strip' })

  await $.tool.call({ tool: 'Edit', file_path: '/work/src/tabs.js', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/tabs.js', old_string: 'b', new_string: 'c' })
  expect(last(reports)).toMatchObject({ status: 'working', touched: ['/work/notes.md', '/work/src/tabs.js'] })

  await $.turn.complete({ answer: 'Done', durationMs: 5, isAborted: false, reason: 'answer', turnId: 't1' })
  expect(last(reports)).toMatchObject({ status: 'idle', turns: 1, activity: '', answer: 'Done', took: 5 })

  // The next turn starts with no answer, so a card never shows the last turn's reply as this one's.
  await $.turn.start({ text: 'Again', turnId: 't2' })
  expect(last(reports)).toMatchObject({ status: 'working', answer: '', took: 0 })
})

test('a host with no cost ledger or limits reports none', () => {
  expect(spent({ context: { window: 200000 } } as any)).toEqual({ context: { window: 200000 }, cost: 0, limits: [] })
})

test('the plan follows TodoWrite, and TaskCreate and TaskUpdate by id', () => {
  const todos = replan([], { tool: 'TodoWrite', todos: [
    { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
    { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
    { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' },
  ] } as any, {})
  expect(planned(todos)).toEqual({ done: 1, total: 3, now: 'Fixing the bug' })

  let tasks = replan([], { tool: 'TaskCreate', subject: 'Port the parser', activeForm: 'Porting the parser' } as any, { result: { task: { id: '1', subject: 'Port the parser' } } })
  tasks = replan(tasks, { tool: 'TaskCreate', subject: 'Write tests' } as any, { result: { task: { id: '2', subject: 'Write tests' } } })
  expect(planned(tasks)).toEqual({ done: 0, total: 2, now: '' })
  tasks = replan(tasks, { tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as any, {})
  expect(planned(tasks)).toEqual({ done: 0, total: 2, now: 'Porting the parser' })
  tasks = replan(tasks, { tool: 'TaskUpdate', taskId: '1', status: 'completed' } as any, {})
  tasks = replan(tasks, { tool: 'TaskUpdate', taskId: '2', status: 'in_progress', activeForm: 'Writing tests' } as any, {})
  expect(planned(tasks)).toEqual({ done: 1, total: 2, now: 'Writing tests' })
  tasks = replan(tasks, { tool: 'TaskUpdate', taskId: '2', status: 'deleted' } as any, {})
  expect(planned(tasks)).toEqual({ done: 1, total: 1, now: '' })
  expect(planned([])).toBe(null)
})

test('a session reports its plan as Claude writes it, and a /clear drops it', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  nook(on, reports)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Fix it', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Fix', status: 'in_progress', activeForm: 'Fixing' }, { content: 'Test', status: 'pending', activeForm: 'Testing' }] })
  expect(last(reports)).toMatchObject({ plan: { done: 0, total: 2, now: 'Fixing' } })
  // A subagent's own list isn't the session's plan.
  await $.tool.call({ tool: 'TodoWrite', agentId: 'a1', todos: [] })
  expect(last(reports)).toMatchObject({ plan: { done: 0, total: 2 } })
  await $.session.end({ reason: 'clear' })
  expect(last(reports)).toMatchObject({ plan: null })
})

test('a reply reads as one plain line: no code, no Markdown marks, cut at a word', () => {
  expect(gist('## Fixed\n\n- **Tabs** now keep `order`\n- See [the PR](https://x/1)\n\n```js\nlet a = 1\n```\nAll green.'))
    .toBe('Fixed Tabs now keep order See the PR All green.')
  const long = gist('word '.repeat(100), 40)
  expect(long.endsWith('…')).toBe(true)
  expect(long.length).toBeLessThanOrEqual(41)
  expect(gist('')).toBe('')
})

test('a permission prompt or a question to the person waits on them', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  nook(on, reports)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Deploy', turnId: 't1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm publish' } })
  // What it asks about, so nook's dashboard can offer to allow or deny it.
  expect(last(reports)).toMatchObject({ status: 'waiting', asks: { tool: 'Bash', what: 'Bash · npm publish' } })
  // Once the call runs, or the turn ends, nothing is asked any more.
  await $.tool.call({ tool: 'Bash', command: 'npm publish' })
  expect(last(reports)).toMatchObject({ status: 'working', asks: null })
  await $.classic.PermissionRequest({ tool_name: 'Write', tool_input: { file_path: '/work/a.md' } })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, reason: 'aborted', turnId: 't1' })
  expect(last(reports)).toMatchObject({ status: 'idle', asks: null })
})

test('a session nook did not start reports nothing', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  nook(on, reports, []) // a `claude -p` inside the tab
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  await $.turn.start({ text: 'x', turnId: 't1' })
  expect(reports).toEqual([])
})

import { applyHunks, turnFiles, diagramBox, webParts, mathBox, plainInline, plainMath, errorLine, failingTests, gist, headerSize, pageSize, svgSize, linkTarget, outcome, pictureLinks, readPaths, planned, replan, searchParts, shellSearch, spent, runnable, splitBlocks, splitCode, splitPictures, summary, testCounts } from './register.js'

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

test('a search says what it found: up to three files by name, else how many, or no matches', () => {
  const grep = (input: object, output: object, more = {}) => ({ tool: 'Grep', input, output, isRunning: false, isErrored: false, isInterrupted: false, ...more })
  expect(searchParts(grep({ pattern: 'startLinks' }, { mode: 'files_with_matches', numFiles: 2, filenames: ['/work/src/links.js', '/work/src/terminal.js'] }), '/work'))
    .toEqual([['"startLinks"', null], ['src/links.js, src/terminal.js', null]])
  expect(searchParts(grep({ pattern: 'TODO', glob: '*.rs' }, { mode: 'files_with_matches', numFiles: 14, filenames: Array(14).fill('/work/a.rs') }), '/work'))
    .toEqual([['"TODO" in *.rs', null], ['14 files', null]])
  expect(searchParts(grep({ pattern: 'nothing', path: '/work/src' }, { mode: 'files_with_matches', numFiles: 0, filenames: [] }), '/work'))
    .toEqual([['"nothing" in src', null], ['no matches', null]])
  expect(searchParts(grep({ pattern: 'fn main' }, { mode: 'content', numFiles: 1, filenames: [], numLines: 1 }), '/work'))
    .toEqual([['"fn main"', null], ['1 line', null]])
  expect(searchParts(grep({ pattern: 'x' }, { mode: 'count', numFiles: 3, filenames: [], numMatches: 40 }), '/work'))
    .toEqual([['"x"', null], ['40 matches in 3 files', null]])
  expect(searchParts({ tool: 'Glob', input: { pattern: 'src/**/*.test.js' }, output: { numFiles: 100, filenames: Array(100).fill('a'), truncated: true, totalMatches: 240, durationMs: 3 }, isRunning: false, isErrored: false, isInterrupted: false }, '/work'))
    .toEqual([['src/**/*.test.js', null], ['240 files', null]])
  expect(searchParts(grep({ pattern: 'x' }, 'error: bad regex', { isErrored: true }), '/work')).toBeNull()
  expect(searchParts({ tool: 'Read', input: {}, output: {}, isRunning: false, isErrored: false, isInterrupted: false }, '/work')).toBeNull()
})

test('a search run through the shell says what it found, and a piped one says nothing', () => {
  const out = (stdout: string) => ({ stdout, stderr: '', interrupted: false })
  expect(shellSearch('grep -rn "assert" .', out('./math.test.js:3:assert(1)\n./math.test.js:9:assert(2)\n./b.test.js:1:assert(3)\n'), '/work'))
    .toEqual([['math.test.js, b.test.js', null], ['3 lines', null]])
  expect(shellSearch('rg TODO src', out('src/a.rs:1:// TODO\nsrc/b.rs:2:// TODO\nsrc/c.rs:3:// TODO\nsrc/d.rs:4:// TODO\nsrc/d.rs:5:// TODO\n'), '/work'))
    .toEqual([['5 lines in 4 files', null]])
  expect(shellSearch("find . -name '*.json'", out('./package.json\n./a/b.json\n./c.json\n./d.json\n'), '/work')).toEqual([['4 files', null]])
  expect(shellSearch('find /work/src -name "*.rs"', out('/work/src/main.rs\n'), '/work')).toEqual([['src/main.rs', null]])
  expect(shellSearch('grep -rl startLinks src', out('src/links.js\nsrc/terminal.js\n'), '/work')).toEqual([['src/links.js, src/terminal.js', null]])
  expect(shellSearch('grep -rc assert .', out('./a.js:4\n./b.js:0\n./c.js:2\n'), '/work')).toEqual([['6 matches in 2 files', null]])
  expect(shellSearch('grep -c assert a.js', out('4\n'), '/work')).toEqual([['4 matches', null]])
  expect(shellSearch('grep -rn nothing_here .', out(''), '/work')).toEqual([['no matches', null]])
  expect(shellSearch('grep -rn "a|b" .', out('x.js:1:a\n'), '/work')).toEqual([['x.js', null]])
  expect(shellSearch('grep -rc assert . | grep -v ":0$"', out('a.js:4\n'), '/work')).toBeNull()
  expect(shellSearch('grep x a.js && echo ok', out('x\nok\n'), '/work')).toBeNull()
  expect(shellSearch('npm test', out('ok\n'), '/work')).toBeNull()
  expect(shellSearch('grep x a.js', 'Exit code 2', '/work')).toBeNull()
})

test('a build, install, linter, or git command says what it did', () => {
  expect(summary('[rd/x a1b2c3d] Add the thing\n 3 files changed, 10 insertions(+), 2 deletions(-)\n create mode 100644 a.js\n'))
    .toEqual([['committed a1b2c3d', 'success'], ['3 files'], ['+10', 'diffAdded', true], ['−2', 'diffRemoved', true]])
  expect(summary('[main (root-commit) 0f0f0f0] first\n 1 file changed, 1 insertion(+)\n'))
    .toEqual([['committed 0f0f0f0', 'success'], ['1 file'], ['+1', 'diffAdded', true]])
  expect(summary('To github.com:me/nook.git\n   a1b2c3d..e4f5a6b  rd/x -> rd/x\n')).toEqual([['pushed rd/x', 'success']])
  expect(summary('To github.com:me/nook.git\n * [new branch]      rd/y -> rd/y\n')).toEqual([['pushed rd/y', 'success']])
  expect(summary('To github.com:me/nook.git\n ! [rejected]        main -> main (fetch first)\n')).toEqual([['rejected main', 'error']])
  expect(summary('Already up to date.\n')).toEqual([['up to date', null]])
  expect(summary('Updating a..b\nFast-forward\n src/a.js | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)\n'))
    .toEqual([['merged', 'merged'], ['1 file'], ['+2', 'diffAdded', true], ['−2', 'diffRemoved', true]])
  expect(summary('   Compiling nook v0.1.0\nwarning: `nook` (bin "nook") generated 3 warnings\n    Finished `release` profile [optimized] target(s) in 41.2s\n'))
    .toEqual([['3 warnings', 'warning']])
  expect(summary('error[E0425]: cannot find value `x`\nerror: could not compile `nook` (bin "nook") due to 2 previous errors; 1 warning emitted\n'))
    .toEqual([['2 errors', 'error']])
  expect(summary('src/a.ts(3,1): error TS2304: Cannot find name x.\n\nFound 3 errors in 2 files.\n')).toEqual([['3 errors in 2 files', 'error']])
  expect(summary('✖ 5 problems (3 errors, 2 warnings)\n')).toEqual([['3 errors', 'error'], ['2 warnings', 'warning']])
  expect(summary('\nadded 120 packages, and audited 121 packages in 3s\n\n3 vulnerabilities (1 moderate, 2 high)\n'))
    .toEqual([['added 120 packages', null], ['3 vulnerabilities', 'warning']])
  expect(summary('added 1 package in 812ms\n\nfound 0 vulnerabilities\n')).toEqual([['added 1 package', null]])
  expect(summary('Successfully installed numpy-2.1.0 pandas-2.2.3\n')).toEqual([['installed 2 packages', null]])
  expect(summary('hello\n')).toBeNull()
  // A failing build gets its count and the error line Claude doesn't already show.
  const failed = 'Exit code 101\n   Compiling a\n   Compiling b\n   Compiling c\nerror[E0425]: cannot find value `x`\n --> src/main.rs:3:5\nerror: could not compile `a` due to 1 previous error\n'
  expect(outcome(failed, true, 0)).toEqual([['1 error', 'error'], ['↳ error[E0425]: cannot find value `x` at src/main.rs:3:5', 'error']])
})

test('a picture a command wrote shows under it: one it names, or a new one in the session\'s folder', async ($, on) => {
  const png = (w: number, h: number) => btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, w >> 8, w & 255, 0, 0, h >> 8, h & 255))
  let now = 10_000
  on('clock.now', () => ({ value: (now += 1000) }))
  on('session.root', () => ({ value: '/work' }))
  const files: Record<string, number> = { '/work/plot.png': 11_500, '/work/old.png': 1_000, '/work/out/chart.svg': 11_500 }
  on('fs.list', () => ({ value: [{ name: 'plot.png', kind: 'file', size: 9, mtimeMs: 11_500, isLink: false }, { name: 'old.png', kind: 'file', size: 9, mtimeMs: 1_000, isLink: false }, { name: 'notes.md', kind: 'file', size: 9, mtimeMs: 11_500, isLink: false }] }))
  on('fs.stat', (_, e) => (e.path in files ? { value: { kind: 'file', size: 9, mtimeMs: files[e.path], isLink: false } } : { error: 'ENOENT' }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('.svg') ? '<svg viewBox="0 0 400 200"></svg>' : { base64: png(640, 480) } }))
  on('tool.call', () => ({ result: { stdout: 'saved out/chart.svg\n', stderr: '' } }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))
  await $.tool.call({ tool: 'Bash', command: 'python plot.py && cat old.png', tool_use_id: 'p1' })
  const ui = await $.ui.mount({
    plugin: 'nook', surface: 'terminal', component: 'ToolResult', requestId: 'p1',
    props: { tool_use_id: 'p1', tool: 'Bash', output: { stdout: 'saved out/chart.svg\n', stderr: '' }, isErrored: false, isExpanded: false },
  })
  const images = await ui.findAll({ type: 'Image' })
  expect(images.map(i => i.props.source.file)).toEqual(['/work/out/chart.svg', '/work/plot.png'])
  expect(images.map(i => [i.props.columns, i.props.rows])).toEqual([[40, 10], [53, 20]])
  await ui.unmount()
})

test('a failed test run names the tests that failed', () => {
  expect(failingTests('running 3 tests\ntest a::ok ... ok\ntest a::adds ... FAILED\ntest b::splits ... FAILED\n\nfailures:\n')).toEqual(['a::adds', 'b::splits'])
  expect(failingTests('ok 1 - adds 0\nnot ok 11 - rounds down\n  ---\nnot ok 12 - splits # TODO\n# fail 2\n')).toEqual(['rounds down', 'splits'])
  expect(failingTests('\x1b[31m✖ rounds down (1.2ms)\x1b[39m\n✔ adds 1 (0.1ms)\n✖ failing tests:\n\n✖ rounds down (1.2ms)\n')).toEqual(['rounds down'])
  expect(failingTests('  ● math › rounds down\n\n    expect(received)\n')).toEqual(['math › rounds down'])
  expect(failingTests(' FAIL  src/a.test.ts > math > rounds\n   × rounds 3ms\n')).toEqual(['rounds'])
  expect(failingTests('FAILED tests/test_math.py::test_rounds - assert 3 == 2\nFAILED tests/test_math.py::test_splits\n')).toEqual(['test_rounds', 'test_splits'])
  expect(failingTests('all good\n')).toEqual([])
  const tap = Array.from({ length: 5 }, (_, i) => `not ok ${i + 1} - case ${i}`).join('\n') + '\n# pass 7\n# fail 5\n'
  expect(outcome(tap, true, 0)).toEqual([['✗ 5 failed, 7 passed', 'error'], ['case 0, case 1, case 2, and 2 more', null]])
})

test('a reply\'s mermaid blocks split out, each with a box sized from its source', () => {
  const reply = 'The flow:\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\nThen:\n```mermaid\nsequenceDiagram\n  A->>B: hi\n  B-->>A: ok\n```\nDone.'
  expect(splitBlocks(reply)).toEqual(['The flow:', ['mermaid', 'flowchart LR\n  a --> b'], 'Then:', ['mermaid', 'sequenceDiagram\n  A->>B: hi\n  B-->>A: ok'], 'Done.'])
  expect(splitBlocks('Half a block:\n```mermaid\ngraph TD\n')).toEqual(['Half a block:\n```mermaid\ngraph TD\n'])
  expect(diagramBox('flowchart LR\n  a --> b', 120)).toEqual([100, 5])
  expect(diagramBox(['graph TD', ...Array.from({ length: 8 }, (_, i) => `  n${i} --> n${i + 1}`)].join('\n'), 70)).toEqual([70, 35])
  expect(diagramBox(['graph TD', ...Array.from({ length: 30 }, (_, i) => `  n${i} --> n${i + 1}`)].join('\n'), 70)).toEqual([70, 40])
  expect(diagramBox('sequenceDiagram\n  A->>B: hi\n  B-->>A: ok', 70)).toEqual([70, 10])
})

test('a reply with a diagram draws it in its place, in a tab nook started only', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  const written: Record<string, string> = {}
  nook(on, reports, ['terminal'], written)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: `engine: ${e.props.text}` }))
  await $.session.start({ cwd: '/work' })
  const text = 'The flow:\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\nDone.'
  const ui = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'AssistantMessage', requestId: 'r1', props: { text, isFirstOfReply: true } })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine: The flow:')
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.source.file).toMatch(/^\/nook\/diagram-\w+\.mmd$/)
  expect(written[image?.props.source.file]).toBe('flowchart LR\n  a --> b')
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('Done.')
  await ui.unmount()
  // The desktop app draws Claude's markdown itself, and nook's pictures aren't there.
  const desktop = await $.ui.mount({ plugin: 'nook', surface: 'desktop', component: 'AssistantMessage', requestId: 'r2', props: { text, isFirstOfReply: true } })
  expect(await desktop.find({ type: 'Image' })).toBeFalsy()
  await desktop.unmount()
})

test('a reply\'s SVG block stays as source, its picture after it', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>'
  expect(splitBlocks(`An icon:\n\n\`\`\`svg\n${svg}\n\`\`\`\n\nUse it twice.`)).toEqual([`An icon:\n\n\`\`\`svg\n${svg}\n\`\`\``, ['svg', svg], 'Use it twice.'])
  expect(splitBlocks(`\`\`\`xml\n<?xml version="1.0"?>\n${svg}\n\`\`\``)[1]).toEqual(['svg', `<?xml version="1.0"?>\n${svg}`])
  // A block that holds more than the drawing, or other XML, is code.
  expect(splitBlocks(`\`\`\`html\n<div>${svg}</div>\n\`\`\``)).toHaveLength(1)
  expect(splitBlocks('```xml\n<note>hi</note>\n```')).toHaveLength(1)
  expect(svgSize(svg)).toEqual([24, 24])
  expect(svgSize('<svg width="300px" height="150"><rect/></svg>')).toEqual([300, 150])
  expect(svgSize('<svg width="100%" height="50%"></svg>')).toBe(null)
})

test('a reply\'s SVG draws under its source, at least eight rows tall, in a tab nook started', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  const written: Record<string, string> = {}
  nook(on, reports, ['terminal'], written)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: `engine: ${e.props.text}` }))
  await $.session.start({ cwd: '/work' })
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>'
  const text = `An icon:\n\n\`\`\`svg\n${svg}\n\`\`\`\n\nDone.`
  const ui = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'AssistantMessage', requestId: 'r1', props: { text, isFirstOfReply: true } })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe(`engine: An icon:\n\n\`\`\`svg\n${svg}\n\`\`\``)
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.source.file).toMatch(/^\/nook\/svg-\w+\.svg$/)
  expect(written[image?.props.source.file]).toBe(svg)
  expect(image?.props).toMatchObject({ rows: 8, columns: 16 })
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('Done.')
  await ui.unmount()
})

test('a picture\'s size comes from its header: PNG, GIF, WebP, and a JPEG past its EXIF', () => {
  const bytes = (...parts: (string | number[])[]) => parts.map(p => (typeof p === 'string' ? p : String.fromCharCode(...p))).join('')
  expect(headerSize(bytes([137], 'PNG', [13, 10, 26, 10, 0, 0, 0, 13], 'IHDR', [0, 0, 2, 128, 0, 0, 1, 224]))).toEqual([640, 480])
  expect(headerSize(bytes('GIF89a', [64, 1, 200, 0]))).toEqual([320, 200])
  expect(headerSize(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X', [10, 0, 0, 0, 0, 0, 0, 0, 127, 2, 0, 223, 1, 0]))).toEqual([640, 480])
  // VP8L packs width-1 and height-1 in 14 bits each: 639 and 479.
  const w = 639, h = 479, bits = w | (h << 14)
  expect(headerSize(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8L', [0, 0, 0, 0, 0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255]))).toEqual([640, 480])
  expect(headerSize(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 2, 224, 1]))).toEqual([640, 480])
  const exif = [0xff, 0xe1, 0, 8, ...'Exif'.split('').map(c => c.charCodeAt(0)), 0, 0]
  expect(headerSize(bytes([0xff, 0xd8], exif, [0xff, 0xc4, 0, 4, 0, 0], [0xff, 0xc2, 0, 17, 8, 1, 224, 2, 128, 3]))).toEqual([640, 480])
  expect(headerSize('plain text')).toBe(null)
})

test('a reply\'s Markdown pictures: local picture files only, outside code, cut after their paragraph', () => {
  expect(linkTarget('out/plot.png')).toBe('out/plot.png')
  expect(linkTarget('<my plot.png>')).toBe('my plot.png')
  expect(linkTarget('my%20plot.png')).toBe('my plot.png')
  expect(linkTarget('file:///C:/work/a.jpg')).toBe('C:/work/a.jpg')
  expect(linkTarget('file:///work/a.webp')).toBe('/work/a.webp')
  expect(linkTarget('https://example.com/a.png')).toBe(null)
  expect(linkTarget('notes.md')).toBe(null)
  const reply = 'The plot ![loss](out/loss.png) shows it.\nIt drops fast.\n\n```md\n![code](skip.png)\n```\n\n![](a.png) ![](<b c.gif> "two")\n\n![web](https://x.io/w.png)\n\nDone.'
  expect(pictureLinks(reply)).toEqual(['out/loss.png', 'a.png', 'b c.gif'])
  const shown = new Set(['out/loss.png', 'a.png', 'b c.gif'])
  expect(splitPictures(reply, shown)).toEqual([
    'The plot loss shows it.\nIt drops fast.', ['out/loss.png'],
    '```md\n![code](skip.png)\n```', ['a.png', 'b c.gif'],
    '![web](https://x.io/w.png)\n\nDone.',
  ])
  // A link to a file that isn't there stays as written.
  expect(splitPictures('![gone](gone.png)', new Set())).toEqual(['![gone](gone.png)'])
})

test('a reply that links a picture file draws it after its paragraph, in any terminal', async ($, on) => {
  const png = (w: number, h: number) => btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, w >> 8, w & 255, 0, 0, h >> 8, h & 255))
  on('session.root', () => ({ value: '/work' }))
  on('fs.stat', (_, e) => (e.path === '/work/out/plot.png' ? { value: { kind: 'file', size: 9, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', () => ({ value: { base64: png(400, 200) } }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: `engine: ${e.props.text}` }))
  const text = 'Here is the plot:\n\n![plot](./out/plot.png)\n\nThe peak is at 3. ![missing](gone.png)'
  const ui = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'AssistantMessage', requestId: 'r1', props: { text, isFirstOfReply: true }, viewport: { columns: 80, rows: 40 } })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine: Here is the plot:')
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toMatchObject({ source: { file: '/work/out/plot.png' }, columns: 40, rows: 10 })
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('The peak is at 3. ![missing](gone.png)')
  await ui.unmount()
  // A reply of a picture alone names it beside the bullet.
  const alone = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'AssistantMessage', requestId: 'r2', props: { text: '![](out/plot.png)', isFirstOfReply: true } })
  expect((await alone.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine: plot.png')
  expect(await alone.findAll({ type: 'Image' })).toHaveLength(1)
  await alone.unmount()
  // A link to a file that isn't there leaves the reply to the engine.
  const none = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'AssistantMessage', requestId: 'r3', props: { text: 'See ![x](gone.png)', isFirstOfReply: true } })
  expect((await none.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine: See ![x](gone.png)')
  await none.unmount()
})

test('a reply\'s display formulas split out, on lines of their own and outside code, each sized from its source', () => {
  const reply = 'Energy:\n\n$$\nE = mc^2\n$$\n\nand \\[ a^2 \\] inline\n\\[\\frac{a}{b}\\]\n```sh\n$$ echo $$\n```\nCosts $5, or $$x$$ inline.'
  expect(splitBlocks(reply)).toEqual([
    'Energy:', ['math', 'E = mc^2'], 'and \\[ a^2 \\] inline', ['math', '\\frac{a}{b}'], '```sh\n$$ echo $$\n```\nCosts $5, or $$x$$ inline.',
  ])
  expect(mathBox('E = mc^2', 77)).toEqual([77, 2])
  expect(mathBox('\\frac{a}{b}', 120)).toEqual([100, 3])
  expect(mathBox('\\sum_{i=1}^n i^2', 77)).toEqual([77, 4])
  expect(mathBox('\\int_0^1 x\\,dx', 77)).toEqual([77, 3])
  expect(mathBox('\\begin{aligned} a &= b \\\\ c &= d \\\\ e &= f \\end{aligned}', 77)).toEqual([77, 4])
})

test('a reply with a display formula draws it in its place, in a tab nook started only', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  const written: Record<string, string> = {}
  nook(on, reports, ['terminal'], written)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: `engine: ${e.props.text}` }))
  await $.session.start({ cwd: '/work' })
  const text = 'So:\n\n$$\n\\frac{1}{2}\n$$\n\nDone.'
  const ui = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'AssistantMessage', requestId: 'r1', props: { text, isFirstOfReply: true } })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine: So:')
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toMatchObject({ source: { file: expect.stringMatching(/^\/nook\/math-\w+\.tex$/) }, rows: 3, alt: 'formula' })
  expect(written[image?.props.source.file]).toBe('\\frac{1}{2}')
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('Done.')
  await ui.unmount()
})

test('inline math reads as plain symbols, and prices, code, and what has no plain form stay as written', () => {
  expect(plainMath('ax^2 + bx + c = 0')).toBe('ax² + bx + c = 0')
  expect(plainMath('a \\neq 0')).toBe('a ≠ 0')
  expect(plainMath('n \\in \\mathbb{N}')).toBe('n ∈ ℕ')
  expect(plainMath('x_{n+1} = x_n^2')).toBe('xₙ₊₁ = xₙ²')
  expect(plainMath('\\alpha_i \\leq \\frac{1}{2}')).toBe('αᵢ ≤ 1/2')
  expect(plainMath('O(n \\log n)')).toBe('O(n log n)')
  expect(plainMath('\\sqrt{x+1}')).toBe('√(x+1)')
  expect(plainMath('\\bar{x} = \\hat y')).toBe('x\u0304 = y\u0302')
  expect(plainMath('\\begin{pmatrix}a\\end{pmatrix}')).toBe(null)
  expect(plainMath('x^{q}')).toBe(null) // no superscript q in Unicode
  expect(plainInline('Roots of $ax^2 + bx + c = 0$ when $a \\neq 0$, at $x$.')).toBe('Roots of ax² + bx + c = 0 when a ≠ 0, at x.')
  expect(plainInline('It costs $5, or $10 with $2 off.')).toBe('It costs $5, or $10 with $2 off.')
  expect(plainInline('Run `echo $a$b`, then:\n```sh\nx=$y$\n```\nand $\\alpha$')).toBe('Run `echo $a$b`, then:\n```sh\nx=$y$\n```\nand α')
  expect(plainInline('While it streams:\n```py\nprint(\'$x$\')')).toBe('While it streams:\n```py\nprint(\'$x$\')')
  expect(plainInline('$$\nE = mc^2\n$$')).toBe('$$\nE = mc^2\n$$')
})

test('a reply\'s inline math draws as plain symbols in any terminal', async ($, on) => {
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: `engine: ${e.props.text}` }))
  const ui = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'AssistantMessage', requestId: 'r1', props: { text: 'So $x^2 \\geq 0$ always.', isFirstOfReply: true } })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine: So x² ≥ 0 always.')
  await ui.unmount()
})

test('a web search\'s row says how many results it found and from which sites', async ($, on) => {
  const hit = (url: string) => ({ title: 't', url })
  const output = { query: 'xterm release', durationSeconds: 3, results: ['Here is what I found', { tool_use_id: 's1', content: [hit('https://github.com/xtermjs/xterm.js/releases'), hit('https://www.npmjs.com/package/@xterm/xterm'), hit('https://github.com/xtermjs/xterm.js'), hit('https://xtermjs.org/'), hit('https://news.ycombinator.com/x'), hit('https://dev.to/y'), hit('not a url')] }] }
  expect(webParts({ tool: 'WebSearch', output })).toEqual([['7 results', null], ['github.com, npmjs.com, xtermjs.org, and 2 more', null]])
  expect(webParts({ tool: 'WebSearch', output: { ...output, results: [] } })).toEqual([['no results', null]])
  expect(webParts({ tool: 'WebSearch', output, isRunning: true })).toBe(null)
  expect(webParts({ tool: 'WebFetch', output })).toBe(null)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))
  const ui = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'ToolResult', requestId: 's1', props: { tool_use_id: 's1', tool: 'WebSearch', output, isErrored: false, isExpanded: false } })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toMatch(/7 results.*github\.com, npmjs\.com/)
  await ui.unmount()
})

test('in a tab nook started, Claude reads what nook draws in its replies; elsewhere, nothing changes', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  nook(on, reports)
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'You are Claude.', scope: 'shared' }] }))
  const facts = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', tools: [], outputStyle: null, traits: [] }
  const before = await $.prompt.compose({ ...facts, surfaces: ['terminal'] })
  expect(before.sections.map(s => s.id)).toEqual(['core'])
  await $.session.start({ cwd: '/work' })
  const { sections } = await $.prompt.compose({ ...facts, surfaces: ['terminal'] })
  expect(sections.map(s => s.id)).toEqual(['core', 'nook:draws'])
  expect(sections[1]).toMatchObject({ scope: 'session', text: expect.stringContaining('```mermaid') })
  expect((await $.prompt.compose({ ...facts, surfaces: [] })).sections.map(s => s.id)).toEqual(['core'])
})

test('an HTML page Claude writes shows as a preview under the call, in a tab nook started only', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  nook(on, reports)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: `engine: ${e.props.tool}` }))
  const write = (file_path: string, extra = {}) => $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'ToolUse', requestId: file_path,
    props: { tool_use_id: 'w1', tool: 'Write', input: { file_path, content: '<h1>hi</h1>' }, output: { type: 'create' }, isRunning: false, isErrored: false, ...extra } })
  const before = await write('/work/index.html')
  expect(await before.find({ type: 'Image' })).toBeFalsy()
  await before.unmount()
  await $.session.start({ cwd: '/work' })
  const page = await write('/work/site/index.html')
  expect((await page.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: '/work/site/index.html' }, columns: 64, rows: 20, alt: 'index.html' })
  await page.unmount()
  for (const [path, extra] of [['/work/notes.md', {}], ['/work/a.htm', { isErrored: true }], ['/work/b.html', { isRunning: true }]] as const) {
    const ui = await write(path, extra)
    expect(await ui.find({ type: 'Image' })).toBeFalsy()
    await ui.unmount()
  }
})

test('a picture Claude read shows under its folded line too, and a file of text does not', async ($, on) => {
  on('session.root', () => ({ value: '/work' }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'Read 3 files' }))
  const read = (id: string, file_path: string, output: object, more = {}) => ({ tool_use_id: id, tool: 'Read', input: { file_path }, output, isRunning: false, isErrored: false, isInterrupted: false, ...more })
  const image = { type: 'image', file: { dimensions: { originalWidth: 400, originalHeight: 200 } } }
  const calls = [read('a', '/work/notes.md', { type: 'text', file: { content: 'hi' } }), read('b', '/work/plot.png', image), read('c', '/work/late.png', image, { isRunning: true })]
  const ui = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'ToolGroup', requestId: 'pics', props: { calls, isActive: false, isExpanded: false } })
  const images = await ui.findAll({ type: 'Image' })
  expect(images.map(i => i.props.source.file)).toEqual(['/work/plot.png'])
  expect(images[0].props).toMatchObject({ columns: 40, rows: 10 })
  await ui.unmount()
})

test('a PDF\'s page size comes from its first MediaBox, a quarter turn when rotated, else US letter', () => {
  expect(pageSize('%PDF-1.7\n3 0 obj << /Type /Page /MediaBox [0 0 595.28 841.89] >> endobj')).toEqual([595.28, 841.89])
  expect(pageSize('%PDF-1.4\n3 0 obj << /Type /Page /Rotate 90 /MediaBox [0 0 612 792] >> endobj')).toEqual([792, 612])
  expect(pageSize('%PDF-1.5\n1 0 obj << /Type /ObjStm /Filter /FlateDecode >> stream x endstream')).toEqual([612, 792])
  expect(headerSize('%PDF-1.7\n<< /MediaBox [0 0 842 595] >>')).toEqual([842, 595])
})

test('a PDF Claude reads shows its first page in a tab nook started, and nowhere else', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  nook(on, reports)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'Read report.pdf' }))
  const props = { tool_use_id: 'p', tool: 'Read', input: { file_path: '/work/report.pdf' }, isRunning: false, isErrored: false,
    output: { type: 'pdf', file: { filePath: '/work/report.pdf', base64: btoa('%PDF-1.7\n<< /MediaBox [0 0 612 792] >>'), originalSize: 40 } } }
  const before = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'ToolUse', requestId: 'a', props })
  expect(await before.find({ type: 'Image' })).toBeFalsy()
  await before.unmount()
  await $.session.start({ cwd: '/work' })
  const ui = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'ToolUse', requestId: 'b', props })
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: '/work/report.pdf' }, columns: 31, rows: 20 })
  await ui.unmount()
})

test('a reply is cut after each closed code block, its code as one would paste it', () => {
  const reply = 'Run:\n\n```sh\nnpm test\n```\n\nthen\n\n- in a list:\n  ```js title="a.js"\n  let a = 1\n    nested()\n  ```\nDone.'
  expect(splitCode(reply)).toEqual([
    'Run:\n\n```sh\nnpm test\n```', { code: 'npm test', lang: 'sh' },
    'then\n\n- in a list:\n  ```js title="a.js"\n  let a = 1\n    nested()\n  ```', { code: 'let a = 1\n  nested()', lang: 'js' },
    'Done.',
  ])
  expect(splitCode('~~~\nx\n~~~')).toEqual(['~~~\nx\n~~~', { code: 'x', lang: '' }, ''])
  // A block that holds a shorter fence ends only at its own.
  expect((splitCode('````md\n```js\nx\n```\n````')[1] as { code: string }).code).toBe('```js\nx\n```')
  // Still streaming, or empty: nothing to copy.
  expect(splitCode('Half:\n```py\nprint(1)\n')).toEqual(['Half:\n```py\nprint(1)\n'])
  expect(splitCode('```\n\n```')).toHaveLength(1)
  expect(splitCode('No code here.')).toEqual(['No code here.'])
})

test('a one-line shell block is a command to run; anything else is not', () => {
  expect(runnable({ code: 'npm test', lang: 'sh' })).toBe('npm test')
  expect(runnable({ code: '$ git status\n', lang: 'console' })).toBe('git status')
  expect(runnable({ code: 'npm test', lang: 'js' })).toBeNull()
  expect(runnable({ code: 'npm test', lang: '' })).toBeNull()
  expect(runnable({ code: 'cd x\nnpm test', lang: 'bash' })).toBeNull()
  expect(runnable({ code: '# just a note', lang: 'bash' })).toBeNull()
})

test('a code block in a reply has a Copy under it that puts its code on the clipboard', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  nook(on, reports, ['terminal'], {})
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: `engine: ${e.props.text}` }))
  const copied: string[] = []
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  let draft = ''
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  await $.session.start({ cwd: '/work' })
  const text = 'Try:\n\n```sh\nnpm run gate\n```\n\nor\n\n```sh\nnpm run gate\n```'
  const ui = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'AssistantMessage', requestId: 'r1', props: { text, isFirstOfReply: true } })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine: Try:\n\n```sh\nnpm run gate\n```')
  const first = await ui.find({ type: 'Button' })
  expect(first?.props.label).toBe('⧉ Copy')
  await ui.press({ key: first!.props.key })
  expect(copied).toEqual(['npm run gate'])
  // A one-line shell block's Run asks nook to type it as a ! command, and sends nothing.
  const run = await ui.find({ type: 'Button', text: /Run/ })
  expect(run?.props.label).toBe('▸ Run')
  await ui.press({ key: run!.props.key })
  expect(last(reports)).toMatchObject({ run: { command: 'npm run gate' } })
  // Over a draft, a ! would be typed into it: nothing is asked of nook, and the person is told why.
  const asked = reports.length
  draft = 'half a thought'
  await ui.press({ key: run!.props.key })
  expect(reports).toHaveLength(asked)
  expect(toasts.at(-1)).toMatch(/Send or clear/)
  await ui.unmount()
})

test('an edit is taken back out where its lines stand, and put back, or not at all once they changed', () => {
  const hunk = { oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, lines: [' a', ' b', '-c', '+C', ' d', ' e'] }
  expect(applyHunks('a\nb\nC\nd\ne\n', [hunk], true)).toBe('a\nb\nc\nd\ne\n')
  expect(applyHunks('a\nb\nc\nd\ne\n', [hunk], false)).toBe('a\nb\nC\nd\ne\n')
  // Lines added above it since, and Windows line ends, kept.
  expect(applyHunks('x\r\ny\r\na\r\nb\r\nC\r\nd\r\ne', [hunk], true)).toBe('x\r\ny\r\na\r\nb\r\nc\r\nd\r\ne')
  expect(applyHunks('a\nb\nZ\nd\ne\n', [hunk], true)).toBeNull()
  expect(applyHunks('a\nb\nc\nd\ne\n', [hunk], true)).toBeNull()
  // Two hunks, the first one line longer than it was: the second is found where the first moved it.
  const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`)
  const now = [...old]
  now.splice(1, 1, 'X', 'X2')
  now[18] = 'Y'
  const hunks = [
    { oldStart: 1, oldLines: 5, newStart: 1, newLines: 6, lines: [' l1', '-l2', '+X', '+X2', ' l3', ' l4', ' l5'] },
    { oldStart: 15, oldLines: 6, newStart: 16, newLines: 6, lines: [' l15', ' l16', ' l17', '-l18', '+Y', ' l19', ' l20'] },
  ]
  expect(applyHunks(now.join('\n'), hunks, true)).toBe(old.join('\n'))
  expect(applyHunks(['top', ...old].join('\n'), hunks, false)).toBe(['top', ...now].join('\n'))
})

test('a finished edit has an Undo under its diff, which takes the edit out of its file and then puts it back', async ($, on) => {
  const files: Record<string, string> = { '/work/src/app.js': 'a\nb\nC\nd\ne\n' }
  on('session.root', () => ({ value: '/work' }))
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path] } : { error: 'missing' }))
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))
  const output = {
    filePath: '/work/src/app.js', oldString: 'c', newString: 'C', originalFile: 'a\nb\nc\nd\ne\n', userModified: false, replaceAll: false,
    structuredPatch: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, lines: [' a', ' b', '-c', '+C', ' d', ' e'] }],
  }
  const mount = (surface: 'terminal' | 'desktop', more = {}) => $.ui.mount({
    plugin: 'nook', surface, component: 'ToolResult', requestId: 'e1',
    props: { tool_use_id: 'e1', tool: 'Edit', output, isErrored: false, isExpanded: false, ...more },
  })
  const ui = await mount('terminal')
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  const undo = await ui.find({ type: 'Button' })
  expect(undo?.props.label).toBe('↶ Undo')
  await ui.press({ key: undo!.props.key })
  expect(files['/work/src/app.js']).toBe('a\nb\nc\nd\ne\n')
  expect(toasts.at(-1)).toBe('Undid the edit to src/app.js')
  expect((await ui.find({ type: 'Button' }))?.props.label).toBe('↷ Redo')
  await ui.press({ key: undo!.props.key })
  expect(files['/work/src/app.js']).toBe('a\nb\nC\nd\ne\n')
  expect(toasts.at(-1)).toBe('Put the edit back in src/app.js')
  // Changed where the edit was since: the file is left alone, and the person told why.
  files['/work/src/app.js'] = 'a\nb\nZ\nd\ne\n'
  await ui.press({ key: undo!.props.key })
  expect(files['/work/src/app.js']).toBe('a\nb\nZ\nd\ne\n')
  expect(toasts.at(-1)).toMatch(/has changed where this edit was/)
  await ui.unmount()
  // No Undo on another surface, in the full transcript, or for an edit that errored.
  for (const [surface, more] of [['desktop', {}], ['terminal', { isExpanded: true }], ['terminal', { isErrored: true }]] as const) {
    const other = await mount(surface, more)
    expect(await other.find({ type: 'Button' })).toBeFalsy()
    await other.unmount()
  }
})

test('a turn\'s edits read as each file\'s lines added and removed, and the files it made', () => {
  const hunk = (lines: string[]) => ({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines })
  const files = turnFiles([
    { path: '/w/a.js', hunks: [hunk([' x', '-y', '+Y', '+Z'])] },
    { path: '/w/a.js', hunks: [hunk(['-q'])] },
    { path: '/w/b.md', made: true },
  ])
  expect([...files]).toEqual([['/w/a.js', [2, 2, false]], ['/w/b.md', [0, 0, true]]])
})

test('after a turn that edited files, the band over the prompt says so, undoes the turn, and asks nook to review it', async ($, on) => {
  const reports: Record<string, unknown>[] = []
  const files: Record<string, string> = { '/work/a.txt': 'a\nB\nc\n', '/work/b.txt': 'x\nY\n' }
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const results: Record<string, unknown> = {
    e1: { filePath: '/work/a.txt', structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }] },
    e2: { filePath: '/work/b.txt', structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' x', '-y', '+Y'] }] },
    e3: { type: 'create', filePath: '/work/new.md', content: 'hi', structuredPatch: [], originalFile: null },
  }
  nook(on, reports, ['terminal'], files, results)
  on('ui.render', ($, e) => $.ui.resolve(e).Box({})) // the engine's band, empty
  await $.session.start({ cwd: '/work' })
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.txt', old_string: 'b', new_string: 'B', tool_use_id: 'e1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/b.txt', old_string: 'y', new_string: 'Y', tool_use_id: 'e2' })
  await $.tool.call({ tool: 'Write', file_path: '/work/new.md', content: 'hi', tool_use_id: 'e3' })
  await $.turn.complete({ turnId: 't1', answer: 'done', reason: 'end_turn' })
  const ui = await $.ui.mount({ plugin: 'nook', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, view: {} } })
  expect((await ui.find({ type: 'Text', text: /Claude changed/ }))?.text).toBe('✎ Claude changed 3 files · +2 −2 1 new')
  await ui.press({ key: 'turn:review' })
  expect(last(reports)).toMatchObject({ review: { files: ['/work/a.txt', '/work/b.txt', '/work/new.md'] } })
  await ui.press({ key: 'turn:undo' })
  expect([files['/work/a.txt'], files['/work/b.txt']]).toEqual(['a\nb\nc\n', 'x\ny\n'])
  expect(toasts.at(-1)).toBe('Undid the turn\'s edits; the new file it made stays')
  expect((await ui.find({ type: 'Button', text: /turn/ }))?.props.label).toBe('↷ Redo turn')
  await ui.press({ key: 'turn:undo' })
  expect([files['/work/a.txt'], files['/work/b.txt']]).toEqual(['a\nB\nc\n', 'x\nY\n'])
  // The next prompt clears the band.
  await $.turn.start({ text: 'thanks', turnId: 't2' })
  expect(await ui.find({ type: 'Text', text: /Claude changed/ })).toBeFalsy()
  await ui.unmount()
})
