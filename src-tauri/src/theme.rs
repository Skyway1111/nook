//! Themes: the user's theme.css, the installed theme in use, and installing one. An installed theme
//! is a folder in `themes` beside settings.json: a theme.css, and the pictures and fonts it names.
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Once,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{config_dir, decode, err, host::Bytes, json::object, read_settings};

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
    /// When a file beside either theme.css last changed, such as a picture or font it names.
    stamp: u64,
    /// Whether this read seeded theme.css: nook's first run, when it shows its welcome.
    first: bool,
}

object!(Theme { css, name, pack, stamp, first });

pub fn read_theme() -> Theme {
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
    let read = |p: &Path| fs::read(p).ok().map(|bytes| decode(&bytes).into_owned());
    let name = read_settings().ok().and_then(|s| s.theme);
    let pack_dir = name.as_ref().map(|n| dir.join("themes").join(n));
    let pack = pack_dir.as_ref().and_then(|d| read(&d.join("theme.css")));
    let stamp = newest_change(&dir).max(pack_dir.map_or(0, |d| newest_change(&d)));
    Theme { css: read(&path), name, pack, stamp, first }
}

/// The newest change to an entry of `dir`, in milliseconds since the epoch. settings.json and
/// theme.css don't count.
fn newest_change(dir: &Path) -> u64 {
    let entries = fs::read_dir(dir).into_iter().flatten().flatten();
    entries
        .filter(|e| !matches!(e.file_name().to_str(), Some("theme.css" | "settings.json")))
        .filter_map(|e| e.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .max()
        .unwrap_or(0)
}

/// `install` for a folder or a .zip on disk.
pub fn install_theme(path: String) -> Result<String, String> {
    install(&config_dir().join("themes"), Path::new(&path), None)
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
    let themes = config_dir().join("themes");
    fs::create_dir_all(&themes).map_err(err)?;
    let zip = themes.join(format!(".{}.zip", unique()));
    fs::write(&zip, bytes).map_err(err)?;
    let installed = install(&themes, &zip, Some(name));
    let _ = fs::remove_file(zip);
    installed
}

/// Saves a theme the webview packed as `<name>.zip` in Downloads, or `<name> (2).zip` and on when that's
/// taken, and returns where. The body is the theme's name, a NUL, then the bytes.
pub fn save_theme_zip(body: &[u8]) -> Result<String, String> {
    let (name, bytes) = named(body)?;
    if Path::new(&name).file_name().and_then(|n| n.to_str()) != Some(&name) || name.starts_with('.') {
        return Err(format!("{name} isn't a theme's name"));
    }
    let downloads = crate::downloads_dir();
    fs::create_dir_all(&downloads).map_err(err)?;
    let path = (1..)
        .map(|n| downloads.join(if n == 1 { format!("{name}.zip") } else { format!("{name} ({n}).zip") }))
        .find(|p| !p.exists())
        .unwrap();
    fs::write(&path, bytes).map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Whether a .zip holds a theme: a theme.css at its top or in one folder inside.
pub fn zip_holds_theme(path: String) -> bool {
    let Ok(list) = list_zip(Path::new(&path)) else { return false };
    list.lines().any(|entry| {
        let parts: Vec<_> = entry.trim_end_matches('/').split('/').collect();
        parts.len() <= 2 && parts.last().is_some_and(|p| p.eq_ignore_ascii_case("theme.css"))
    })
}

/// Installs a theme as `themes\<name>`, over any theme of that name. The folder that holds theme.css
/// names it; at the top of a .zip, `name` or the .zip's own name does. It unpacks into a hidden folder,
/// then swaps in with two renames, so a window reading the theme finds the old or the new, never half.
fn install(themes: &Path, src: &Path, name: Option<String>) -> Result<String, String> {
    let stage = themes.join(format!(".{}", unique()));
    fs::create_dir_all(&stage).map_err(err)?;
    let installed = unpack(src, &stage).and_then(|()| {
        let root = theme_root(&stage).ok_or("it holds no theme.css")?;
        let label = |p: &Path| (if zipped(p) { p.file_stem() } else { p.file_name() }).map(|s| s.to_string_lossy().into_owned());
        let name = if root == stage { name.or_else(|| label(src)) } else { label(&root) }.unwrap_or_default();
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

fn zipped(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"))
}

fn unpack(src: &Path, to: &Path) -> Result<(), String> {
    if zipped(src) {
        extract_zip(src, to)
    } else if src.is_dir() {
        copy_dir(src, to)
    } else {
        Err("it isn't a folder or a .zip".into())
    }
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

/// The paths in a .zip, one a line. Windows' own tar reads .zip files; Git's GNU tar, which may come
/// first on PATH, doesn't, so nook names System32's. Err is what it said went wrong.
#[cfg(windows)]
fn list_zip(zip: &Path) -> Result<String, String> {
    crate::run(Command::new(windows_tar()).arg("-tf").arg(zip), None)
}

#[cfg(windows)]
fn extract_zip(zip: &Path, into: &Path) -> Result<(), String> {
    crate::run(Command::new(windows_tar()).arg("-xf").arg(zip).arg("-C").arg(into), None).map(drop)
}

#[cfg(windows)]
fn windows_tar() -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    Path::new(&root).join("System32").join("tar.exe")
}

/// The paths in a .zip, one a line, through Info-ZIP's unzip, which every desktop Linux ships.
#[cfg(not(windows))]
fn list_zip(zip: &Path) -> Result<String, String> {
    crate::run(Command::new("unzip").arg("-Z1").arg(zip), None)
}

#[cfg(not(windows))]
fn extract_zip(zip: &Path, into: &Path) -> Result<(), String> {
    crate::run(Command::new("unzip").args(["-q", "-o"]).arg(zip).arg("-d").arg(into), None).map(drop)
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
    use super::{install, list_zip, newest_change, offer_bundled};
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
    fn stamps_a_change_to_a_picture_and_not_to_theme_css() {
        let dir = scratch("theme-stamp");
        // Writes `name`, changed `secs` after the epoch.
        let write = |name: &str, secs| {
            fs::write(dir.join(name), name).unwrap();
            let file = fs::File::options().write(true).open(dir.join(name)).unwrap();
            file.set_modified(UNIX_EPOCH + Duration::from_secs(secs)).unwrap();
        };
        write("moon.jpg", 1);
        write("theme.css", 2);
        assert_eq!(newest_change(&dir), 1000);
        write("moon.jpg", 3);
        assert_eq!(newest_change(&dir), 3000);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn installs_a_folder_and_a_zip_and_replaces_a_theme_of_the_same_name() {
        let dir = scratch("theme-install");
        let (themes, src) = (dir.join("themes"), dir.join("dark-moon"));
        fs::create_dir_all(src.join("fonts")).unwrap();
        fs::write(src.join("theme.css"), b":root { --h: 250; }").unwrap();
        fs::write(src.join("fonts").join("a.woff2"), b"font").unwrap();
        assert_eq!(install(&themes, &src, None), Ok("dark-moon".into()));
        assert!(themes.join("dark-moon").join("fonts").join("a.woff2").is_file());

        // A zipped folder, downloaded twice: the folder inside names it, not "dark-moon (1)".
        fs::write(src.join("theme.css"), b":root { --h: 200; }").unwrap();
        let zip = dir.join("dark-moon (1).zip");
        #[cfg(windows)]
        let made = std::process::Command::new(super::windows_tar()).current_dir(&dir).args(["-a", "-cf"]).arg(&zip).arg("dark-moon").status();
        #[cfg(not(windows))]
        let made = std::process::Command::new("zip").current_dir(&dir).args(["-qr"]).arg(&zip).arg("dark-moon").status();
        assert!(made.unwrap().success());
        assert_eq!(install(&themes, &zip, Some("ignored".into())), Ok("dark-moon".into()));
        assert_eq!(fs::read_to_string(themes.join("dark-moon").join("theme.css")).unwrap(), ":root { --h: 200; }");
        assert_eq!(fs::read_dir(&themes).unwrap().count(), 1); // nothing staged is left behind
        assert!(list_zip(&zip).unwrap().contains("dark-moon/theme.css"));

        fs::remove_file(src.join("theme.css")).unwrap();
        assert!(install(&themes, &src, None).is_err());
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
