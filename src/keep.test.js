import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWorktree, worktrees, shortstat, changeLine, stat, keep } from './keep.js'

test('a worktree is one Claude made under .claude/worktrees', () => {
  assert.ok(isWorktree('/home/m/nook/.claude/worktrees/nook-1029-184737-2'))
  assert.ok(isWorktree('C:\\Users\\m\\nook\\.claude\\worktrees\\try-1\\'))
  assert.ok(!isWorktree('/home/m/nook'))
  assert.ok(!isWorktree('/home/m/nook/.claude/worktrees/a/src'))
  assert.ok(!isWorktree(undefined))
})

test('the worktree list reads path, commit and branch, the main checkout first', () => {
  const list = worktrees('worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/.claude/worktrees/x\nHEAD bbb\nbranch refs/heads/worktree-x\n\nworktree /r/old\nHEAD ccc\ndetached\n')
  assert.deepEqual(list, [
    { path: '/r', head: 'aaa', branch: 'main' },
    { path: '/r/.claude/worktrees/x', head: 'bbb', branch: 'worktree-x' },
    { path: '/r/old', head: 'ccc', branch: undefined },
  ])
})

test('a short diff stat reads in a few words', () => {
  assert.deepEqual(shortstat(' 3 files changed, 42 insertions(+), 10 deletions(-)\n'), { files: 3, added: 42, removed: 10 })
  assert.deepEqual(shortstat(' 1 file changed, 1 deletion(-)'), { files: 1, added: 0, removed: 1 })
  assert.deepEqual(shortstat(''), { files: 0, added: 0, removed: 0 })
  assert.equal(changeLine({ files: 3, added: 42, removed: 10 }), '3 files +42 −10')
  assert.equal(changeLine({ files: 1, added: 0, removed: 0 }), '1 file')
  assert.equal(changeLine({ files: 0, added: 0, removed: 0 }), 'No changes')
})

// The rest runs real git in a folder of its own, as nook's `git` command does.
const who = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, args, input) => new Promise((resolve, reject) => {
  const child = execFile('git', args, { cwd: dir, env: { ...process.env, ...who } }, (e, out, err) => (e ? reject(new Error((err || out).trim())) : resolve(out)))
  child.stdin.on('error', () => {}) // a git that reads no input may close it first
  child.stdin.end(input)
})

async function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'keep-'))
  await git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'init'])
  const tree = join(dir, '.claude', 'worktrees', 'try-1')
  await git(dir, ['worktree', 'add', '-q', '-b', 'worktree-try-1', tree])
  return { dir, tree, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a worktree counts what it changed, committed, not, and new', async () => {
  const { dir, tree, done } = await repo()
  try {
    assert.equal(await stat(git, dir), null) // the main checkout isn't one
    assert.equal((await stat(git, tree)).files, 0)
    writeFileSync(join(tree, 'a.txt'), 'one\n2\nthree\nfour\n')
    await git(tree, ['commit', '-qam', 'edit'])
    writeFileSync(join(tree, 'b.txt'), 'new\n')
    const s = await stat(git, tree)
    assert.deepEqual({ files: s.files, added: s.added, removed: s.removed, branch: s.branch }, { files: 2, added: 3, removed: 1, branch: 'worktree-try-1' })
  } finally { done() }
})

test('keeping a worktree stages its changes in the main checkout, uncommitted', async () => {
  const { dir, tree, done } = await repo()
  try {
    writeFileSync(join(tree, 'a.txt'), 'one\n2\nthree\n')
    writeFileSync(join(tree, 'b.txt'), 'new\n')
    writeFileSync(join(tree, 'c.txt'), 'committed\n')
    await git(tree, ['add', 'c.txt'])
    await git(tree, ['commit', '-qm', 'Claude committed this one'])
    await keep(git, tree)
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\n2\nthree\n')
    assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'new\n')
    assert.equal((await git(dir, ['diff', '--cached', '--name-only'])).trim(), 'a.txt\nb.txt\nc.txt')
    assert.equal((await git(dir, ['log', '--format=%s'])).trim(), 'init') // nothing committed there
    assert.equal((await git(tree, ['log', '-1', '--format=%s'])).trim(), 'Claude committed this one') // nor here
  } finally { done() }
})

test('a worktree that no longer fits the main checkout changes nothing there', async () => {
  const { dir, tree, done } = await repo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    await git(dir, ['commit', '-qam', 'theirs'])
    writeFileSync(join(tree, 'a.txt'), 'one\n2\nthree\n')
    await assert.rejects(keep(git, tree), /doesn't fit .* in a\.txt, so nothing was brought in/)
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n')
    assert.equal((await git(dir, ['status', '--porcelain', '--untracked-files=no'])).trim(), '')
  } finally { done() }
})

test('changes of its own to the same file in the main checkout stop it too', async () => {
  const { dir, tree, done } = await repo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nmine\n')
    writeFileSync(join(tree, 'a.txt'), 'one\n2\nthree\n')
    await assert.rejects(keep(git, tree), /in a\.txt/)
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nmine\n')
  } finally { done() }
})

test('a worktree with nothing changed has nothing to keep', async () => {
  const { tree, done } = await repo()
  try {
    await assert.rejects(keep(git, tree), /nothing to keep/)
  } finally { done() }
})
