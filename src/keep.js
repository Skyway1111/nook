// Sessions started in git worktrees, side by side on one prompt, and keeping the one that did best. `stat` says
// how much a worktree changed since it left the main checkout, for its dashboard card, and `keep` brings those
// changes into the main checkout as staged changes, to look over and commit there. Both take
// `git(dir, args, input)`, which runs git and resolves to its output, so `keep.test.js` runs them under `npm test`.

/** Whether `root` is a worktree Claude made: `<repo>/.claude/worktrees/<name>`. */
export const isWorktree = root => /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(root ?? '')

/** `git worktree list --porcelain` as `[{ path, head, branch }]`, the main checkout first. */
export function worktrees(porcelain) {
  return porcelain.split(/\r?\n\r?\n/).map(block => {
    const field = name => block.match(new RegExp(`^${name} (.*)$`, 'm'))?.[1]
    return { path: field('worktree'), head: field('HEAD'), branch: field('branch')?.replace(/^refs\/heads\//, '') }
  }).filter(w => w.path)
}

/** `git diff --shortstat` as `{ files, added, removed }`; nothing is all zeros. */
export function shortstat(text) {
  const n = word => Number(text.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0)
  return { files: n('files? changed'), added: n('insertions?'), removed: n('deletions?') }
}

/** A worktree's changes in a few words: "3 files +42 −10", "1 new file", or "No changes". */
export function changeLine({ files, added, removed }) {
  if (!files) return 'No changes'
  const lines = [added && `+${added}`, removed && `−${removed}`].filter(Boolean)
  return [`${files} file${files > 1 ? 's' : ''}`, ...lines].join(' ')
}

/** The new files whose lines `stat` counts; past this a worktree holds build output, not work. */
const COUNTED = 200

const same = (a, b) => a.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()

/** Where the worktree at `root` stands: its main checkout, its branch, and what it changed since it left that
 * checkout's commit, committed or not, new files included. Null when `root` isn't a linked worktree. */
export async function stat(git, root) {
  const all = worktrees(await git(root, ['worktree', 'list', '--porcelain']))
  const main = all[0]
  const own = all.find(w => same(w.path, root))
  if (!main || !own || own === main) return null
  const base = (await git(root, ['merge-base', 'HEAD', main.head])).trim()
  const diff = shortstat(await git(root, ['diff', '--shortstat', base]))
  // New files aren't in the diff until added, and adding would change the worktree, so grep counts their lines.
  const fresh = (await git(root, ['ls-files', '--others', '--exclude-standard'])).split(/\r?\n/).filter(Boolean)
  const counted = fresh.length ? await git(root, ['grep', '--untracked', '-I', '-c', '-e', '', '--', ...fresh.slice(0, COUNTED)]).catch(() => '') : ''
  const lines = counted.split(/\r?\n/).reduce((sum, l) => sum + Number(l.match(/:(\d+)$/)?.[1] ?? 0), 0)
  return { main: main.path, branch: own.branch, base, files: diff.files + fresh.length, added: diff.added + lines, removed: diff.removed }
}

/** Brings the worktree's changes into its main checkout, staged and not committed, as one patch from where it
 * left that checkout's commit: what Claude committed there and what it didn't. Nothing is committed anywhere, so
 * it needs no git identity. The patch applies whole or not at all, so when it doesn't fit (the main checkout
 * moved on, or has its own changes to those files) this rejects naming them, having changed nothing there.
 * Resolves to `stat` from before. */
export async function keep(git, root) {
  const was = await stat(git, root)
  if (!was) throw new Error(`${root} isn't a worktree`)
  if (!was.files) throw new Error('It changed nothing to keep')
  await git(root, ['add', '-A']) // new files too; this only stages them in the worktree
  const patch = await git(root, ['diff', '--cached', '--binary', '--full-index', was.base])
  await git(was.main, ['apply', '--index', '--whitespace=nowarn'], patch).catch(e => {
    const files = [...new Set([...String(e?.message ?? e).matchAll(/^error: (?:patch failed: )?(.+?):(?: |\d+$)/gm)].map(m => m[1]))]
    const which = files.length ? ` in ${files.slice(0, 3).join(', ')}${files.length > 3 ? ' and more' : ''}` : ''
    throw new Error(`It doesn't fit ${was.main} as it is now${which}, so nothing was brought in. Its changes are still in ${root}.`)
  })
  return was
}
