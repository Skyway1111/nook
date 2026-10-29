// Which rows of the file browser git counts as changed, from the git panel's status of the open tab's repository.

/**
 * A lookup from a path to its git mark: 'M' modified, 'A' added, 'R' renamed, 'U' conflicted, '?' untracked, 'dir'
 * for a folder that holds a change, or '' for none. `status` is `git_status`'s answer, `{ root, changes }`, or null.
 * `paths` is paths.js's rules, so Windows matches names in any case.
 */
export function gitMarks(status, paths) {
  if (!status?.root) return () => ''
  const fold = p => (paths.windows ? p.toLowerCase() : p)
  const root = paths.normalize(status.root)
  const files = new Map()
  const dirs = new Set()
  const untracked = [] // untracked folders, everything inside which is untracked too
  for (const c of status.changes) {
    if (c.kind === 'D') continue // nothing to show it on
    const path = fold(paths.fromSlashes(root, c.path))
    if (c.path.endsWith('/')) untracked.push(path)
    else files.set(path, c.kind)
    for (let p = paths.parent(path); p && fold(p) !== fold(root) && paths.within(p, root); p = paths.parent(p)) {
      if (dirs.has(p)) break
      dirs.add(p)
    }
  }
  return path => {
    const p = fold(path)
    return files.get(p) ?? (untracked.some(u => paths.within(p, u)) ? '?' : dirs.has(p) ? 'dir' : '')
  }
}
