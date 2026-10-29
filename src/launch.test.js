import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SAFE, claudeWith, worktreeName, fanNames, since } from './launch.js'

test('claudeWith adds flags to the claude a command runs', () => {
  assert.deepEqual(claudeWith(['claude'], ['--resume', 'abc']), ['claude', '--resume', 'abc'])
  assert.deepEqual(claudeWith(['C:\\bin\\claude.exe', '--verbose'], ['-c']), ['C:\\bin\\claude.exe', '-c', '--verbose'])
  assert.deepEqual(
    claudeWith(['powershell', '-NoLogo', '-NoExit', '-Command', 'claude'], ['--worktree', 'nook-1']),
    ['powershell', '-NoLogo', '-NoExit', '-Command', 'claude', '--worktree', 'nook-1'],
  )
  assert.deepEqual(claudeWith(['bash', '-lc', 'claude; exec bash -l'], ['--resume', 'a-1']), ['bash', '-lc', 'claude --resume a-1; exec bash -l'])
  assert.deepEqual(claudeWith(['bash', '-lc', 'cd x && claude'], ['-c']), ['bash', '-lc', 'cd x && claude -c'])
  assert.deepEqual(claudeWith(['my-claude-wrapper'], ['-c']), ['my-claude-wrapper', '-c'])
  assert.deepEqual(claudeWith(['claude'], []), ['claude'])
})

test('claudeWith refuses anything a shell would read', () => {
  assert.throws(() => claudeWith(['bash', '-lc', 'claude'], ['--resume', 'x; rm -rf ~']))
  assert.throws(() => claudeWith(['claude'], ['$(id)']))
})

test('worktreeName and since read the clock', () => {
  assert.equal(worktreeName(new Date(2026, 9, 29, 6, 4)), 'nook-1029-0604')
  const now = Date.UTC(2026, 9, 29)
  assert.equal(since(now - 10_000, now), 'just now')
  assert.equal(since(now - 5 * 60_000, now), '5m ago')
  assert.equal(since(now - 3 * 3600_000, now), '3h ago')
  assert.equal(since(now - 50 * 3600_000, now), '2d ago')
})

test('a fan-out names a worktree per session, with the seconds so two in a minute differ', () => {
  const at = new Date(2026, 9, 29, 18, 50, 7)
  assert.deepEqual(fanNames(3, at), ['nook-1029-185007-1', 'nook-1029-185007-2', 'nook-1029-185007-3'])
  assert.ok(fanNames(1, at).every(n => SAFE.test(n)))
})
