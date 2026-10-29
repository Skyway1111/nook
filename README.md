# nook

A Windows app for Claude Code. nook runs the real `claude` in terminal tabs and adds what a terminal lacks: a file browser for the whole disk, file tabs with an editor, a git panel, pasted screenshots, pictures in the transcript, and themes you restyle live.

![nook with the Twilight theme](themes/twilight/screenshot.png)

## Install

1. Install Claude Code and sign in. In PowerShell, run `irm https://claude.ai/install.ps1 | iex`, then run `claude` once. The [Claude Code setup guide](https://code.claude.com/docs/en/setup) covers the other ways to install it.
2. Download `nook_<version>_x64-setup.exe` from [the latest release](https://github.com/Skyway1111/nook/releases/latest) and run it. nook installs for your Windows account only, so it needs no admin rights.
3. The installer isn't code-signed, so Windows SmartScreen may warn about it. Click **More info**, then **Run anyway**.

nook runs on 64-bit Windows 10 1809 or later and on Windows 11. The git panel needs [Git for Windows](https://git-scm.com/downloads/win).

## What nook adds

- **Claude in tabs.** Click **+**, press Ctrl+N, or right-click a folder and pick **New Claude session here**. Each tab runs Claude's own interface, unchanged.
- **Open with nook.** In Explorer, right-click a folder, or the empty space inside one, and pick **Open with nook**.
- **A file browser for the whole disk**, with pins, breadcrumbs, back and forward, and a typed path bar. Right-click a file to cut, copy, rename, or delete it. A deleted file goes to the Recycle Bin.
- **Paths into the prompt.** Drag a file from the sidebar or from Explorer into the terminal to add its path to your prompt.
- **Pasted screenshots.** Ctrl+V pastes a screenshot straight into Claude. Hover `[Image #N]` to see the image, and click it to open it.
- **Pictures in the transcript.** Each image you paste shows under your prompt, and each image or SVG Claude reads shows under the `Read`.
- **A prompt card.** The prompt shows in a card with the model, the effort, and a ring for how full the context is. Pick a model or an effort from the card's menus.
- **File tabs.** Click a file to open it in a tab. Code and text open in an editor with syntax colors, Markdown opens rendered with an **Edit** button, and images open as pictures.
- **Safe edits.** An open file follows changes on disk. If Claude changes a file while you have unsaved edits, nook keeps your edits and offers **Overwrite** or **Reload**.
- **A git panel** for the open tab's repository. Stage files, read diffs, commit, switch or create branches, and fetch, pull, or push.
- **Living wallpapers.** Click the brush in the titlebar to pick a scene drawn in characters behind Claude, always moving: drifting clouds, sea turtles, a koi pond, jellyfish, paper boats, fireflies, or a moonlit night. Arrows preview a scene, Enter keeps it, and Esc puts back the last one. The wallpaper holds still while you type and while nook is minimized.
- **Themes.** Pick a theme, re-hue the whole app, pick the interface and terminal fonts, and write CSS that restyles any part of nook as you type. Claude's own colors can follow the theme.
- **Fast typing under load.** nook renders on the CPU and runs its typing path at above-normal priority, so typing stays fast while a training run saturates the GPU or the CPU.

## Keys

| Key | Action |
|---|---|
| Ctrl+V | Paste text, or attach a screenshot |
| Shift+Enter | New line in the prompt |
| Ctrl+C | Copy the selection. With nothing selected, Claude gets it. |
| Ctrl+N | New Claude session in the file browser's folder |
| Ctrl+Tab, Ctrl+Shift+Tab | Next or previous tab |
| Ctrl+S | Save the open file |
| Ctrl+F | Find and replace in the editor |
| Ctrl+W | Close a file tab. In a Claude tab, Claude gets it. |
| Middle-click a tab | Close it |
| Ctrl+Enter | Commit, from the commit message box |
| Mouse back and forward | File browser history |

## Settings

Click the gear in the titlebar. The Settings drawer edits two files in `%APPDATA%\dev.nook.app`. An edit made in any other editor shows in the drawer within a second.

- `settings.json`: **Command** is what each Claude tab runs, one argument per line. The default starts `claude` in Windows PowerShell. If you have PowerShell 7, change `powershell` to `pwsh`. **Render with the GPU** takes effect after a restart.
- `theme.css`: your CSS, applied over nook's defaults and the theme in use, as you type. The hue, font, and size controls write their variables here. **nook's defaults** lists every variable.

To push and fetch over HTTPS, click **Sign in** under GitHub in the same drawer. Git Credential Manager, which ships with Git for Windows, keeps the token. nook never sees it.

## Themes

**Theme** in the Settings drawer shows a card for each installed theme. Click one to use it in every window. nook ships with Twilight, which sets Frederic Edwin Church's painting *Twilight in the Wilderness* behind the window.

To install a theme, click **Install…** and pick its .zip, or right-click a theme's folder or .zip in the file browser and pick **Install theme**. Your own `theme.css` applies over the theme, so your fonts and sizes stay when you switch.

With **Claude's colors follow the theme** on, picking a theme also sets Claude's own theme to nook's. nook writes only the `theme` key of `~/.claude/settings.json`, the key `/theme` writes, and puts your Claude theme back when you turn this off. Claude reads its theme when it starts, so restart open Claude tabs to recolor them.

To make your own theme, follow [Make a theme](docs/themes.md).

## How nook works with Claude Code

nook starts each Claude session in a pseudoconsole and draws it with xterm.js. Every key you type goes to Claude. nook never edits your prompt or Claude's output.

Each session nook starts also loads a small Claude Code plugin from `src-tauri/mod`. The plugin tells its tab the model, the effort, and how full the context is. It runs the model and effort you pick from the prompt card, and adds the pictures under Claude's drawing. It passes every event on unchanged, and sessions you start outside nook never load it.

[architecture.md](architecture.md) maps the code.

## Build from source

You need [Node.js](https://nodejs.org) 20.19 or later, [Rust](https://rustup.rs), and the [Tauri prerequisites for Windows](https://v2.tauri.app/start/prerequisites/).

```powershell
npm install
npm run dev      # a debug build. To start in a folder: npm run dev -- -- <folder>
npm run build    # nook.exe and the installer, in src-tauri\target\release
npm test         # the frontend's tests: the wallpapers' scenes
cd src-tauri; cargo test
```

Before a build you publish, run `$env:RUSTFLAGS = "--remap-path-prefix=$env:USERPROFILE=~"`. Without it, `nook.exe` holds your home folder's path in each of its dependencies' source paths.

If a debug nook is open, close it before you rebuild. The build copies `conpty.dll` and `OpenConsole.exe` over the files the running nook holds open, and fails with os error 32.

## Credits

- [Libron](https://github.com/nicoverbruggen/libron), the interface font, is under the SIL Open Font License. See `src/fonts/OFL.txt`.
- `conpty.dll` and `OpenConsole.exe` come from Microsoft's `Microsoft.Windows.Console.ConPTY` package, under the MIT License. See `src-tauri/conpty/LICENSE`.
- Twilight's picture is *Twilight in the Wilderness* (1860) by Frederic Edwin Church. The Cleveland Museum of Art released its photograph under [CC0](https://clevelandart.org/art/1965.233).

nook isn't affiliated with Anthropic. Claude and Claude Code are trademarks of Anthropic.

## License

[MIT](LICENSE)
