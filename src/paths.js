// Paths as the system nook runs on writes them. Windows has drive letters and backslashes, and names a
// file in any case. Linux has one root and slashes, and case tells two names apart. The rest of nook
// builds and compares paths only through `path`, so paths.test.js covers both systems on either one.

/** The path rules of Windows when `windows`, and of Linux otherwise. */
export function pathsFor(windows) {
  const SEP = windows ? '\\' : '/'
  const fold = windows ? s => s.toLowerCase() : s => s
  const same = (a, b) => fold(a) === fold(b)
  const isRoot = windows ? p => /^[a-z]:\\$/i.test(p) : p => p === '/'
  /** The drive or root that holds the absolute path `p`. */
  const root = p => (windows ? p.slice(0, 3) : '/')
  /** What the top of the file browser, the list of drives or the root, is called. */
  const TOP = windows ? 'This PC' : 'Computer'

  /** Parent folder. On Windows a drive root leads to '' (the drive list); `/` and '' have none. */
  function parent(p) {
    if (p === '') return null
    if (isRoot(p)) return windows ? '' : null
    const i = p.lastIndexOf(SEP)
    return i === root(p).length - 1 ? root(p) : p.slice(0, i)
  }

  /** A path as typed or pasted: unquoted, with no trailing separator, and on Windows with `/` as `\`. */
  function normalize(p) {
    p = p.trim().replace(/^"(.*)"$/, '$1')
    if (!windows) return p === '' ? p : p.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
    p = p.replaceAll('/', SEP).replace(/\\+$/, '').replace(/^[a-z]:/, d => d.toUpperCase())
    return /^[A-Z]:$/.test(p) ? p + SEP : p
  }

  return {
    windows,
    SEP,
    TOP,
    same,
    isRoot,
    root,
    parent,
    normalize,
    /** Whether `p` names the same path as `dir`, or one inside it. */
    within: (p, dir) => same(p, dir) || fold(p).startsWith(fold(dir.endsWith(SEP) ? dir : dir + SEP)),
    isAbsolute: windows ? p => /^[a-z]:[\\/]/i.test(p) : p => p.startsWith('/'),
    join: (dir, ...names) => names.reduce((d, n) => (d === '' ? n : d.endsWith(SEP) ? d + n : d + SEP + n), dir),
    basename: p => (p === '' ? TOP : isRoot(p) ? (windows ? p.slice(0, 2) : p) : p.slice(p.lastIndexOf(SEP) + 1)),
    /** A path relative to `dir` with `/` between its parts, as git and URLs write one, under `dir`. */
    fromSlashes: (dir, rel) => dir + SEP + rel.replace(/\/$/, '').replaceAll('/', SEP),
    /** A file:// URL's path for `p`. */
    toUrl: p => 'file://' + (windows ? '/' : '') + p.split(SEP).map(encodeURIComponent).join('/'),
    /** The path of a file:// URL's `pathname`. */
    fromUrl: pathname => (windows ? decodeURIComponent(pathname.slice(1)).replaceAll('/', SEP) : decodeURIComponent(pathname)),
    /** The characters a file name can't hold, and how to say so. */
    badName: windows ? /[\\/:*?"<>|]/ : /[/\0]/,
    badNameMessage: windows ? 'A name can\'t contain \\ / : * ? " < > |' : 'A name can\'t contain /',
    /** The file manager, as its menu entries name it. */
    fileManager: windows ? 'Explorer' : 'Files',
  }
}

/** Whether nook runs on Windows. WebView2 says so in its user agent; WebKitGTK says Linux. */
export const WINDOWS = /Windows/.test(globalThis.navigator?.userAgent ?? '')
export const path = pathsFor(WINDOWS)
