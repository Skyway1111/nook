"""Builds src/fonts/nook-icons.woff2, the icons nook shows where Windows' Segoe Fluent Icons isn't installed.

nook writes each icon as a Segoe Fluent Icons character, so this font draws a Fluent UI System Icon, Microsoft's
MIT-licensed set in the same style, at the same code point. style.css lists it after Segoe, so Windows never
uses it. An icon nook starts using needs a line in ICONS, then:

    npm pack @fluentui/svg-icons && tar xzf fluentui-svg-icons-*.tgz
    pip install fonttools brotli
    python3 scripts/icons.py package/icons
"""

import sys
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.misc.transform import Transform
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib import SVGPath

# Segoe Fluent Icons code point: the Fluent UI icon, at 20px regular, that stands in for it.
ICONS = {
    0xE700: "navigation",  # GlobalNavButton: the menu
    0xE70D: "chevron_down",
    0xE70F: "edit",
    0xE710: "add",
    0xE711: "dismiss",  # Cancel
    0xE713: "settings",
    0xE718: "pin",
    0xE72A: "arrow_right",  # Forward
    0xE72B: "arrow_left",  # Back
    0xE738: "subtract",  # a checkbox's mixed state
    0xE73E: "checkmark",
    0xE74A: "arrow_up",
    0xE74D: "delete",
    0xE74E: "save",
    0xE753: "cloud_arrow_up",  # a remote branch
    0xE756: "window_console",  # CommandPrompt: a Claude session
    0xE76C: "chevron_right",
    0xE771: "paint_brush",  # Personalize: the wallpaper
    0xE777: "arrow_reset",
    0xE77A: "pin_off",
    0xE77F: "clipboard_paste",
    0xE790: "color",  # a theme
    0xE7A7: "arrow_undo",
    0xE7AC: "apps",  # OpenWith
    0xE7C4: "window_multiple",  # TaskView: the sessions dashboard
    0xE768: "play",  # continue the last session
    0xE81C: "history",  # resume a saved session
    0xE838: "folder_open",
    0xE890: "eye",  # View: preview
    0xE895: "arrow_sync",
    0xE896: "arrow_download",  # pull
    0xE898: "arrow_upload",  # push
    0xE8A5: "document",
    0xE8AC: "rename",
    0xE8B7: "folder",
    0xE8BB: "dismiss",  # ChromeClose
    0xE8C6: "cut",
    0xE8C8: "copy",
    0xE8D2: "text_font",
    0xE8E5: "open",
    0xE8F4: "folder_add",
    0xE90F: "info",  # Properties
    0xE921: "subtract",  # ChromeMinimize
    0xE922: "maximize",
    0xE923: "square_multiple",  # ChromeRestore
    0xE943: "code",
    0xEB9F: "image",
    0xEDA2: "hard_drive",
    0xF000: "document_text",
    0xF003: "branch_fork",  # nook's own: a session in a git worktree
}

UPM = 1000  # font units to the em; an icon's 20px box fills it, as a Segoe icon does
ASCENT, DESCENT = 800, 200


def build(icons_dir: Path, out: Path) -> None:
    names = sorted(set(ICONS.values()))
    fb = FontBuilder(UPM, isTTF=False)
    fb.setupGlyphOrder([".notdef", *names])
    fb.setupCharacterMap({cp: name for cp, name in ICONS.items()})
    # SVG's y runs down from the top of a 20-unit box; a font's runs up from the baseline.
    flip = Transform(UPM / 20, 0, 0, -UPM / 20, 0, ASCENT)
    charstrings = {".notdef": T2CharStringPen(UPM, None).getCharString()}
    for name in names:
        pen = T2CharStringPen(UPM, None)
        SVGPath(str(icons_dir / f"{name}_20_regular.svg")).draw(TransformPen(pen, flip))
        charstrings[name] = pen.getCharString()
    fb.setupCFF("nookicons", {"FullName": "nook icons"}, charstrings, {})
    fb.setupHorizontalMetrics({name: (UPM, 0) for name in [".notdef", *names]})
    fb.setupHorizontalHeader(ascent=ASCENT, descent=-DESCENT)
    fb.setupNameTable({"familyName": "nook icons", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=ASCENT, sTypoDescender=-DESCENT, usWinAscent=ASCENT, usWinDescent=DESCENT)
    fb.setupPost()
    fb.font.flavor = "woff2"
    fb.save(str(out))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    build(Path(sys.argv[1]), Path(__file__).resolve().parent.parent / "src" / "fonts" / "nook-icons.woff2")
