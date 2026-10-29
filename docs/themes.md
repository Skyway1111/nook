# Make a theme

A theme is a folder with a `theme.css` and the pictures and fonts it names. nook keeps each installed theme in its own folder in `%APPDATA%\dev.nook.app\themes`. In this tutorial you build a theme called Harbor inside that folder, so each save shows in nook within a second.

[`themes/twilight`](../themes/twilight/theme.css) in this repository is a finished theme. Read it beside each step.

## 1. Create the folder

1. Click the gear, then **Folder**. The file browser opens nook's settings folder. Press Esc to close the Settings drawer, so it lists your theme when it opens again.
2. Open `themes`. Right-click the empty space under the list, pick **New folder**, and name it `harbor`.
3. Open `harbor`. Right-click the empty space, pick **New file**, and name it `theme.css`.
4. Click `theme.css` to open it in a tab.

## 2. Re-hue nook

Type this into `theme.css` and press Ctrl+S:

```css
:root {
  --h: 200;
}
```

Click the gear, then the **Harbor** card. nook's panels and text turn teal, because their default colors take their hue from `--h`. The value is an angle on the color wheel: 285 is violet, 250 blue, 150 green, 60 amber, and 20 ember.

## 3. Set your own colors

Every color, font, and size in nook is a CSS variable. Expand **nook's defaults** in the Settings drawer to read the full list, with a comment on each. [`src/theme.css`](../src/theme.css) holds the same list. Add the variables you want to change:

```css
:root {
  --h: 200;
  --bg: #0b1418;
  --accent: #5ec8d8;
  --ink-1: #e6f2f4;
  --term-bg: #0d1a1f;
  --term-fg: #d6e6ea;
}
```

Save, and nook repaints. `--bg` paints the titlebar and the panels, `--term-bg` paints the terminal, and `--accent` colors the cursor, the folder icons, and the name in the titlebar. The `--ink-*` variables color text, from `--ink-1`, the brightest, to `--ink-3`.

`--ansi-*` sets the 16 terminal colors. For a light theme, also set `--scheme: light`, so scrollbars and form controls turn light.

## 4. Put a picture behind the window

Copy a picture into `harbor`, for example `harbor.jpg`. A relative `url()` names a file beside `theme.css`. Add these rules below the `:root` block:

```css
body { background: url(harbor.jpg) 50% 36px / cover no-repeat var(--bg); }
#files, #git { background: oklch(.1 .02 220 / .7); }
```

The picture fills the window below the 36-pixel titlebar. A dark tint over the file browser, `#files`, and the git panel, `#git`, keeps their text readable.

To show the picture in the terminal too, replace `--term-bg` in `:root`:

```css
  --term-bg:
    linear-gradient(oklch(.1 .02 220 / .85), oklch(.1 .02 220 / .85)),
    url(harbor.jpg) 50% 36px / cover fixed;
```

`fixed` sizes the picture to the window instead of the terminal, so it lines up with the picture on `body`. The gradient darkens it under the text. Twilight uses `twilight-soft.jpg` here instead: a small, blurred copy of its painting, which reads as frosted glass.

When you replace a picture with a new file of the same name, nook shows the new one within a second.

## 5. Add a font

Copy a font file into `harbor`. Declare it with `@font-face`, then name it in a font variable:

```css
@font-face { font-family: Outfit; src: url(Outfit.woff2); }
:root { --font-ui: Outfit, "Segoe UI", sans-serif; }
```

`--font-ui` sets the interface font, and `--font-term` sets the terminal's. Keep the terminal font monospace.

## 6. Restyle any element

A theme is plain CSS, so any rule works. Themes restyle these parts most:

| Selector | Part |
|---|---|
| `body` | The window, behind everything |
| `#files` | The file browser |
| `#git` | The git panel |
| `#pane` | The frame around the open tab |
| `.tab.active` | The tab in front |
| `.brand` | The name in the titlebar |
| `.composer .frame` | The prompt card |

[`index.html`](../index.html) and [`src/style.css`](../src/style.css) name the rest. For example:

```css
.brand { letter-spacing: .3em; text-shadow: 0 0 12px var(--accent); }
.tab.active { box-shadow: inset 0 -2px 0 var(--accent); }
```

nook draws on the CPU, so a shadow or filter on `.xterm-rows`, the terminal's text, slows every keystroke's repaint.

## 7. Color Claude

Each of Claude's own colors is a `--claude-*` variable, named after Claude's color token. `src/theme.css` lists every one nook draws.

```css
:root {
  --claude-claude: #5ec8d8; /* the spinner, the mascot, and Claude's label */
  --claude-promptBorder: #2f5560;
  --claude-userMessageBackground: oklch(.7 .08 210 / .1);
}
```

These variables apply only while **Claude's colors follow the theme** is on in the Settings drawer. Claude reads its theme when it starts, so open a new Claude tab after you turn it on. From then on, a change to a `--claude-*` variable recolors open tabs at once.

## 8. Ship a living wallpaper

nook can draw a scene in characters behind Claude tabs, always moving. Name one in `:root` to make it your theme's wallpaper:

```css
:root {
  --wallpaper: fireflies; /* none, drift, turtles, koi, jellyfish, boats, fireflies, or moonlit */
  --wallpaper-opacity: .4;
  --wallpaper-light: #ffd98e; /* the fireflies */
}
```

Each scene paints with a few roles, and each role takes its color from a `--wallpaper-<role>` variable: `faint`, `ink`, `bright`, `accent`, `claude`, `water`, `sea`, `leaf`, `warm`, `light`, and `glow`. By default they follow your `--ink-*` and `--ansi-*` colors, so most themes need none of them. `--wallpaper-font-size` sets the height of the scene's cells.

A pick from the titlebar's brush goes into your own `theme.css`, so it applies over every theme's.

## 9. Add a card picture

Save a screenshot of nook in your theme as `screenshot.png` in `harbor`. The theme's card in the Settings drawer shows it, cropped to 3:2.

## 10. Share it

Zip the `harbor` folder. In Explorer, right-click it and pick **Compress to ZIP file**. On Windows 10, pick **Send to**, then **Compressed (zipped) folder**. A .zip that holds the folder installs as a theme named after the folder.

Ship a license for each picture and font in the theme. Use only pictures you made or pictures licensed for redistribution. Museum open-access collections, such as the Cleveland Museum of Art's, The Met's, and the Art Institute of Chicago's, release public-domain art under CC0. Most fonts on Google Fonts use the SIL Open Font License, which allows shipping them with a theme.

Your own `theme.css`, beside `settings.json`, applies over every theme. Keep personal changes there, such as font sizes, so they stay when you switch themes.
