// What the command palette (F1, or > in quick open) can run. Each is `{ title, keys, icon, run, when }`; `when` hides one
// that has nothing to act on, such as Save with no file open.
import { invoke } from '@tauri-apps/api/core'
import { ICON } from './files.js'
import { path as paths } from './paths.js'

export function appCommands({ tabs, files, git, drawer, openQuick, quickPrompts, newSession, insertPath, home, banner, welcome }) {
  const active = () => tabs.active()
  const file = () => (active()?.viewer && active().type !== 'diff' ? active().path : null)
  const toggle = cls => () => { document.body.classList.toggle(cls); if (cls === 'git-hidden') git.refresh(); tabs.focus() }
  const copy = text => navigator.clipboard.writeText(text).catch(banner)
  return () => [
    { title: 'New Claude session', keys: 'Ctrl+N', icon: ICON.claude, run: newSession },
    { title: 'Quick prompt…', keys: 'Ctrl+Shift+P', icon: ICON.prompt, run: quickPrompts },
    { title: 'Next tab', keys: 'Ctrl+Tab', icon: '\uE72A', run: () => tabs.cycle(1) },
    { title: 'Previous tab', keys: 'Ctrl+Shift+Tab', icon: '\uE72B', run: () => tabs.cycle(-1) },
    { title: 'Close tab', keys: 'Ctrl+W in a file', icon: '\uE711', run: () => tabs.close() },
    { title: 'Toggle file browser', icon: ICON.folder, run: toggle('files-hidden') },
    { title: 'Toggle git panel', icon: ICON.diff, run: toggle('git-hidden') },
    { title: 'Open settings', icon: '\uE713', run: drawer.toggle },
    { title: 'Pick a wallpaper', icon: '\uE771', run: () => document.getElementById('toggle-wallpaper').click() },
    { title: 'Make a theme from a picture…', icon: '\uEB9F', run: drawer.themes.fromPicture },
    { title: 'Show the welcome', icon: '\uE790', run: welcome },
    { title: 'Go to file…', keys: 'Ctrl+P', icon: ICON.file, run: () => openQuick('') },
    { title: 'Go to line…', keys: 'Ctrl+P, then :', icon: '\uE8D2', when: file, run: () => openQuick(':') },
    { title: 'Save file', keys: 'Ctrl+S', icon: '\uE74E', when: file, run: () => active().viewer.save() },
    { title: 'Show file in file browser', icon: ICON.explorer, when: file, run: () => files.reveal(file()) },
    { title: 'Copy file path', icon: ICON.copy, when: file, run: () => copy(file()) },
    { title: 'Add file to Claude\'s prompt', icon: ICON.add, when: file, run: () => insertPath(file()) },
    { title: 'Open file with default app', icon: ICON.open, when: file, run: () => invoke('open_path', { path: file() }).catch(banner) },
    { title: 'New file in current folder', icon: ICON.file, when: () => files.current(), run: () => files.create(false) },
    { title: 'New folder in current folder', icon: ICON.folder, when: () => files.current(), run: () => files.create(true) },
    { title: 'Copy current folder path', icon: ICON.copy, when: () => files.current(), run: () => copy(files.current()) },
    { title: `Open current folder in ${paths.fileManager}`, icon: ICON.explorer, when: () => files.current(), run: () => invoke('open_path', { path: files.current() }).catch(banner) },
    ...(home ? [{ title: 'Go to home folder', icon: ICON.dir, run: () => files.go(home) }] : []),
    ...files.pins().map(p => ({ title: `Go to ${paths.basename(p)}`, icon: ICON.pin, run: () => files.go(p) })),
  ]
}
