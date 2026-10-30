//! Themes: the user's theme.css, the installed theme in use, and installing one. An installed theme
//! is a folder in `themes` beside settings.json: a theme.css, and the pictures and fonts it names.
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Mutex, Once},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{config_dir, decode, err, host::Bytes, json::object, read_settings, zip};

/// A new theme.css. nook applies it over its defaults in `src/theme.css` and the installed theme in use.
const THEME_SEED: &str = "/* Your CSS, applied over nook's defaults and the theme in use.
   Settings (the gear) edits it and lists them. */
:root {
}
";

pub struct Theme {
    /// The user's theme.css, seeded on first run. None on a failed read, so a file mid-save never
    /// resets the theme.
    css: Option<String>,
    /// The installed theme in use, from settings.json.
    name: Option<String>,
    /// Its theme.css. None when no theme is in use or its folder is gone.
    pack: Option<String>,
    /// Changes when a file beside either theme.css does, such as a picture or font it names.
    stamp: u64,
    /// Whether this read seeded theme.css: nook's first run, when it shows its welcome.
    first: bool,
    /// Changes when any of the above does, from the files' stats alone.
    version: u64,
}

object!(Theme { css, name, pack, stamp, first, version });

/// The theme, or None when its version is still `seen`: the page asks every second, and then only stats are read.
pub fn read_theme(seen: Option<u64>) -> Option<Theme> {
    let dir = config_dir();
    let path = dir.join("theme.css");
    let first = !path.exists();
    // Install the themes that ship beside nook and the user hasn't had yet: all of them on the first run,
    // before the welcome lists them, and on a later launch the ones a newer nook added, once the window is
    // up, so a copy of a theme's pictures never competes with the open.
    static OFFERED: Once = Once::new();
    OFFERED.call_once(|| {
        let (bundled, themes) = (crate::resource("themes"), dir.join("themes"));
        if first {
            offer_bundled(&bundled, &themes);
        } else {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                offer_bundled(&bundled, &themes);
            });
        }
    });
    if first {
        let _ = fs::create_dir_all(&dir).and_then(|()| fs::write(&path, THEME_SEED));
    }
    let (name, settings) = theme_name(&dir.join("settings.json"));
    let pack_dir = name.as_ref().map(|n| dir.join("themes").join(n));
    let stamp = changes(&dir, pack_dir.as_ref().map_or(0, |d| changes(d, 0)));
    let pack_css = pack_dir.map(|d| d.join("theme.css"));
    let files = [Some(&path), pack_css.as_ref()].map(|p| p.and_then(|p| fs::metadata(p).ok()));
    let version = files.into_iter().fold(stamp ^ settings, stat) >> 11; // a JSON number holds 53 bits
    if seen == Some(version) {
        return None;
    }
    let read = |p: &Path| fs::read(p).ok().map(decode);
    Some(Theme { css: read(&path), name, pack: pack_css.and_then(|p| read(&p)), stamp: stamp >> 11, first, version })
}

/// The installed theme settings.json names, and its stats hashed. It's parsed again only when they change.
fn theme_name(settings: &Path) -> (Option<String>, u64) {
    static LAST: Mutex<Option<(u64, Option<String>)>> = Mutex::new(None);
    let now = stat(0, fs::metadata(settings).ok());
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last.as_ref().is_none_or(|(was, _)| *was != now) {
        *last = Some((now, read_settings().ok().and_then(|s| s.theme)));
    }
    (last.as_ref().and_then(|(_, name)| name.clone()), now)
}

/// `seed` hashed with each entry of `dir`'s stats, so it changes even when a copy of an older file replaces one.
/// settings.json and theme.css don't count.
fn changes(dir: &Path, seed: u64) -> u64 {
    let entries = fs::read_dir(dir).into_iter().flatten().flatten();
    let entries = entries.filter(|e| !matches!(e.file_name().to_str(), Some("theme.css" | "settings.json")));
    entries.map(|e| e.metadata().ok()).fold(seed, stat)
}

/// `h` hashed with a file's modified time and size, or a folder's modified time. A copy keeps its source's modified
/// time, and on Windows its change time too, so the size goes in; on Linux the change time, which every write
/// sets, goes in as well. A missing file counts as zeros.
fn stat(h: u64, m: Option<fs::Metadata>) -> u64 {
    let parts = m.map_or([0; 3], |m| {
        let time = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64);
        #[cfg(unix)]
        let changed = { use std::os::unix::fs::MetadataExt; (m.ctime() as u64) << 30 | m.ctime_nsec() as u64 };
        #[cfg(windows)]
        let changed = 0;
        if m.is_dir() { [time, 0, 0] } else { [time, m.len(), changed] }
    });
    parts.into_iter().fold(h, |h, x| (h ^ x).wrapping_mul(0x100_0000_01b3))
}

/// `install` for a folder or a .zip on disk.
pub fn install_theme(path: String) -> Result<String, String> {
    install_from(&config_dir().join("themes"), Path::new(&path))
}

/// `install` for the folder or .zip `src`, named by itself unless a folder inside it holds theme.css.
fn install_from(themes: &Path, src: &Path) -> Result<String, String> {
    let zipped = src.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"));
    let name = if zipped { src.file_stem() } else { src.file_name() };
    install(themes, name.map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(), |stage| {
        if zipped {
            zip::extract(&mut fs::File::open(src).map_err(err)?, stage)
        } else if src.is_dir() {
            copy_dir(src, stage)
        } else {
            Err("it isn't a folder or a .zip".into())
        }
    })
}

/// A request body that is a name, a NUL, then bytes.
fn named(body: &[u8]) -> Result<(String, &[u8]), String> {
    let at = body.iter().position(|&b| b == 0).ok_or("expected a name")?;
    Ok((String::from_utf8_lossy(&body[..at]).into_owned(), &body[at + 1..]))
}

/// `install_theme` for a .zip the settings drawer's file picker read. The body is its name, a NUL,
/// then its bytes.
pub fn install_theme_zip(body: &[u8]) -> Result<String, String> {
    let (name, bytes) = named(body)?;
    install(&config_dir().join("themes"), name, |stage| zip::extract(&mut Cursor::new(bytes), stage))
}

/// `install_theme` for a theme the page made, such as one from a picture. The body is its name, a NUL, then each
/// file as its name, a NUL, its length in decimal, a NUL, and its bytes.
pub fn install_theme_files(body: &[u8]) -> Result<String, String> {
    let (name, mut rest) = named(body)?;
    install(&config_dir().join("themes"), name, |stage| {
        while !rest.is_empty() {
            let (file, after) = named(rest)?;
            let (len, after) = named(after)?;
            let len = len.parse().ok().filter(|&n| n <= after.len()).ok_or("a file is cut short")?;
            let path = stage.join(zip::path(&file).filter(|p| !p.is_empty()).ok_or(format!("{file} would land outside the theme"))?);
            fs::create_dir_all(path.parent().unwrap()).and_then(|()| fs::write(&path, &after[..len])).map_err(err)?;
            rest = &after[len..];
        }
        Ok(())
    })
}

/// Saves the installed theme `name`, its folder whole, as `<name>.zip` in Downloads, or `<name> (2).zip` and on
/// when that's taken, and returns where.
pub fn save_theme_zip(name: String) -> Result<String, String> {
    if Path::new(&name).file_name().and_then(|n| n.to_str()) != Some(&name) || name.starts_with('.') {
        return Err(format!("{name} isn't a theme's name"));
    }
    let mut files = Vec::new();
    list_files(&config_dir().join("themes").join(&name), &name, &mut files)?;
    let downloads = crate::downloads_dir();
    fs::create_dir_all(&downloads).map_err(err)?;
    let (path, mut file) = (1..)
        .map(|n| downloads.join(if n == 1 { format!("{name}.zip") } else { format!("{name} ({n}).zip") }))
        .find_map(|p| match fs::File::create_new(&p) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => None,
            made => Some(made.map(|f| (p, f))),
        })
        .unwrap()
        .map_err(err)?;
    zip::write(&mut file, &files).inspect_err(|_| drop(fs::remove_file(&path)))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Each file in `dir` and the folders in it, as its path in a .zip under `inside` and on disk, in name order. What
/// the file browser hides stays out.
fn list_files(dir: &Path, inside: &str, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir).map_err(err)?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let Some(is_dir) = crate::shown_dir(&e) else { continue };
        let name = format!("{inside}/{}", e.file_name().to_string_lossy());
        if is_dir {
            list_files(&e.path(), &name, out)?;
        } else {
            out.push((name, e.path()));
        }
    }
    Ok(())
}

/// Whether a .zip holds a theme: a theme.css at its top or in one folder inside.
pub fn zip_holds_theme(path: String) -> bool {
    let Ok(entries) = fs::File::open(path).map_err(err).and_then(|mut f| zip::entries(&mut f)) else { return false };
    let top = |e: &&zip::Entry| !e.dir && e.name.split('/').count() <= 2;
    entries.iter().filter(top).any(|e| e.name.rsplit('/').next().is_some_and(|p| p.eq_ignore_ascii_case("theme.css")))
}

/// Installs a theme as `themes\<name>`, over any theme of that name. `fill` puts its files in a hidden folder, and
/// the folder in there that holds theme.css names it, or `name` when theme.css is at the top. The theme then
/// swaps in with two renames, so a window reading it finds the old or the new, never half.
fn install(themes: &Path, name: String, fill: impl FnOnce(&Path) -> Result<(), String>) -> Result<String, String> {
    let stage = themes.join(format!(".{}", unique()));
    fs::create_dir_all(&stage).map_err(err)?;
    let installed = fill(&stage).and_then(|()| {
        let root = theme_root(&stage).ok_or("it holds no theme.css")?;
        let name = if root == stage { name } else { root.file_name().unwrap_or_default().to_string_lossy().into_owned() };
        if name.is_empty() || name.starts_with('.') || Path::new(&name).file_name() != Some(name.as_ref()) {
            return Err(format!("“{name}” can't name a theme"));
        }
        let dest = themes.join(&name);
        let old = themes.join(format!(".{}", unique()));
        if dest.exists() {
            fs::rename(&dest, &old).map_err(err)?;
        }
        fs::rename(&root, &dest).map_err(err)?;
        let _ = fs::remove_dir_all(old);
        Ok(name)
    });
    let _ = fs::remove_dir_all(stage);
    installed
}

/// A name no other install uses, for a folder or file that lives only while one runs.
fn unique() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("{}-{nanos}", std::process::id())
}

/// Copies each theme in `bundled` into `themes` once: `themes/.bundled` lists those already offered, so a
/// theme the user removed stays removed. Before that list existed, nook shipped Twilight alone.
fn offer_bundled(bundled: &Path, themes: &Path) {
    let list = themes.join(".bundled");
    let mut offered: Vec<String> = match fs::read_to_string(&list) {
        Ok(text) => text.lines().map(str::to_owned).collect(),
        Err(_) if themes.exists() => vec!["twilight".into()],
        Err(_) => vec![],
    };
    let Ok(entries) = fs::read_dir(bundled) else { return };
    let before = fs::metadata(themes).and_then(|m| m.modified()).ok();
    let mut changed = false;
    for entry in entries.flatten().filter(|e| e.path().is_dir()) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if offered.contains(&name) {
            continue;
        }
        let to = themes.join(&name);
        if to.exists() || copy_dir(&entry.path(), &to).is_ok() {
            offered.push(name);
            changed = true;
        }
    }
    if changed {
        let _ = fs::write(&list, offered.join("\n") + "\n");
        // read_theme's stamp follows the folder's time, and a new stamp makes every open window reload its
        // theme's pictures. Nothing in use changed, so put the time back (or far back, for a new folder).
        let mut open = fs::OpenOptions::new();
        #[cfg(windows)] // a folder opens only with FILE_FLAG_BACKUP_SEMANTICS, and its time takes FILE_WRITE_ATTRIBUTES
        std::os::windows::fs::OpenOptionsExt::custom_flags(
            std::os::windows::fs::OpenOptionsExt::access_mode(&mut open, 0x100),
            0x0200_0000,
        );
        #[cfg(not(windows))]
        open.read(true);
        let _ = open.open(themes).and_then(|f| f.set_modified(before.unwrap_or(UNIX_EPOCH)));
    }
}

/// The folder that holds theme.css: `dir`, or the one folder inside it that does.
fn theme_root(dir: &Path) -> Option<PathBuf> {
    if dir.join("theme.css").is_file() {
        return Some(dir.to_path_buf());
    }
    let mut holders = fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.join("theme.css").is_file());
    let first = holders.next()?;
    holders.next().is_none().then_some(first)
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(err)?;
    for entry in fs::read_dir(from).map_err(err)?.flatten() {
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        if entry.file_type().map_err(err)?.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            fs::copy(&src, &dst).map_err(err)?;
        }
    }
    Ok(())
}

/// Where an element's baked backdrop waits for the next start: `body`, `pane`, and the like, in the cache folder.
fn backdrop_file(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase()) {
        return Err(format!("{name} isn't a backdrop's name"));
    }
    Ok(crate::cache_dir().join("backdrops").join(name))
}

/// The backdrop `save_backdrop` kept for the element `name`, as it was saved, or nothing.
pub fn saved_backdrop(name: String) -> Result<Bytes, String> {
    Ok(Bytes(fs::read(backdrop_file(&name)?).unwrap_or_default()))
}

/// Keeps an element's baked backdrop for the next start. The body is the element's name, a NUL, then what
/// `saved_backdrop` gives back. Written aside and moved in, so a start never reads half a file.
pub fn save_backdrop(body: &[u8]) -> Result<(), String> {
    let (name, bytes) = named(body)?;
    let file = backdrop_file(&name)?;
    let aside = file.with_extension("new");
    fs::create_dir_all(file.parent().unwrap()).map_err(err)?;
    fs::write(&aside, bytes).map_err(err)?;
    fs::rename(&aside, &file).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::{changes, install_from, list_files, offer_bundled, zip_holds_theme};
    use std::{
        fs,
        time::{Duration, UNIX_EPOCH},
    };

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nook-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn stamps_a_change_to_a_picture_even_to_an_older_copy_and_not_to_theme_css() {
        let dir = scratch("theme-stamp");
        // Writes `text` to `name`, modified `secs` after the epoch, and returns the stamp.
        let write = |name: &str, text: &str, secs| {
            fs::write(dir.join(name), text).unwrap();
            let file = fs::File::options().write(true).open(dir.join(name)).unwrap();
            file.set_modified(UNIX_EPOCH + Duration::from_secs(secs)).unwrap();
            changes(&dir, 0)
        };
        let first = write("moon.jpg", "moon", 2);
        assert_eq!(write("theme.css", "css", 3), first);
        assert_ne!(write("moon.jpg", "old moon", 1), first);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn installs_a_folder_and_a_zip_and_replaces_a_theme_of_the_same_name() {
        let dir = scratch("theme-install");
        let (themes, src) = (dir.join("themes"), dir.join("dark-moon"));
        fs::create_dir_all(src.join("fonts")).unwrap();
        fs::write(src.join("theme.css"), b":root { --h: 250; }").unwrap();
        fs::write(src.join("fonts").join("a.woff2"), b"font").unwrap();
        assert_eq!(install_from(&themes, &src), Ok("dark-moon".into()));
        assert!(themes.join("dark-moon").join("fonts").join("a.woff2").is_file());

        // A zipped folder, downloaded twice: the folder inside names it, not "dark-moon (1)".
        fs::write(src.join("theme.css"), b":root { --h: 200; }").unwrap();
        let zip = dir.join("dark-moon (1).zip");
        let mut files = Vec::new();
        list_files(&src, "dark-moon", &mut files).unwrap();
        crate::zip::write(&mut fs::File::create(&zip).unwrap(), &files).unwrap();
        assert!(zip_holds_theme(zip.to_string_lossy().into_owned()));
        assert_eq!(install_from(&themes, &zip), Ok("dark-moon".into()));
        assert_eq!(fs::read_to_string(themes.join("dark-moon").join("theme.css")).unwrap(), ":root { --h: 200; }");
        assert!(themes.join("dark-moon").join("fonts").join("a.woff2").is_file());
        assert_eq!(fs::read_dir(&themes).unwrap().count(), 1); // nothing staged is left behind

        fs::remove_file(src.join("theme.css")).unwrap();
        assert!(install_from(&themes, &src).is_err());
        assert!(themes.join("dark-moon").join("theme.css").is_file()); // a failed install leaves the theme it would replace
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn offers_each_bundled_theme_once_and_keeps_a_removed_one_removed() {
        let root = scratch("bundled");
        let (bundled, themes) = (root.join("bundled"), root.join("themes"));
        for name in ["twilight", "fjord"] {
            fs::create_dir_all(bundled.join(name)).unwrap();
            fs::write(bundled.join(name).join("theme.css"), name).unwrap();
        }
        // A first run installs them all.
        offer_bundled(&bundled, &themes);
        assert!(themes.join("twilight/theme.css").is_file() && themes.join("fjord/theme.css").is_file());
        // A theme the user removed stays removed, and one they edited keeps their edit.
        fs::remove_dir_all(themes.join("fjord")).unwrap();
        fs::write(themes.join("twilight/theme.css"), "mine").unwrap();
        offer_bundled(&bundled, &themes);
        assert!(!themes.join("fjord").exists());
        assert_eq!(fs::read_to_string(themes.join("twilight/theme.css")).unwrap(), "mine");
        // A newer nook's new theme arrives once.
        fs::create_dir_all(bundled.join("ember")).unwrap();
        fs::write(bundled.join("ember/theme.css"), "ember").unwrap();
        let time = fs::metadata(&themes).unwrap().modified().unwrap();
        offer_bundled(&bundled, &themes);
        assert!(themes.join("ember/theme.css").is_file());
        // without touching the folder's time, which would make open windows reload their theme
        assert_eq!(fs::metadata(&themes).unwrap().modified().unwrap(), time);
    }

    #[test]
    fn an_older_install_without_the_list_gets_the_new_themes_but_not_twilight_again() {
        let root = scratch("bundled-old");
        let (bundled, themes) = (root.join("bundled"), root.join("themes"));
        for name in ["twilight", "fjord"] {
            fs::create_dir_all(bundled.join(name)).unwrap();
            fs::write(bundled.join(name).join("theme.css"), name).unwrap();
        }
        fs::create_dir_all(themes.join("mine")).unwrap(); // Twilight was removed long ago
        offer_bundled(&bundled, &themes);
        assert!(themes.join("fjord/theme.css").is_file());
        assert!(!themes.join("twilight").exists());
    }
}
