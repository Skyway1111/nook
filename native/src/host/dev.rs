//! Debug builds: edits apply while the app runs. The watched paths under the app's folder are polled; a
//! changed stylesheet is swapped in place, and any other change reloads the page.
use super::{assets::ROOT, plat};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, SystemTime};

pub fn watch(paths: &'static [&'static str]) {
    if paths.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let mut seen = scan(paths);
        loop {
            std::thread::sleep(Duration::from_millis(100));
            let now = scan(paths);
            let mut changed: Vec<&String> =
                now.iter().filter(|(p, t)| seen.get(*p) != Some(t)).map(|(p, _)| p).collect();
            changed.extend(seen.keys().filter(|p| !now.contains_key(*p)));
            if changed.is_empty() {
                continue;
            }
            if changed.iter().all(|p| p.ends_with(".css")) {
                let list = changed.iter().map(|p| crate::json::to_string(*p)).collect::<Vec<_>>().join(",");
                let script = format!(
                    "for (const l of document.querySelectorAll('link[rel=stylesheet]')) {{
                      const path = new URL(l.href).pathname
                      if (![{list}].includes(path)) continue
                      const fresh = l.cloneNode()
                      fresh.href = path + '?t=' + Date.now()
                      fresh.onload = () => l.remove()
                      l.after(fresh)
                    }}"
                );
                plat::post(move || plat::eval(&script));
            } else {
                plat::post(plat::reload);
            }
            seen = now;
        }
    });
}

/// Each watched file's URL path and when it last changed.
fn scan(paths: &[&str]) -> BTreeMap<String, SystemTime> {
    let mut out = BTreeMap::new();
    for p in paths {
        let p = Path::new(ROOT).join(p);
        match p.metadata() {
            Ok(m) if m.is_dir() => walk(&p, &mut out),
            Ok(m) => add(&p, &m, &mut out),
            Err(_) => {}
        }
    }
    out
}

/// A folder's files, from the listing's own metadata, so no file is opened.
fn walk(dir: &Path, out: &mut BTreeMap<String, SystemTime>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        match e.metadata() {
            Ok(m) if m.is_dir() => walk(&e.path(), out),
            Ok(m) => add(&e.path(), &m, out),
            Err(_) => {}
        }
    }
}

fn add(p: &Path, m: &std::fs::Metadata, out: &mut BTreeMap<String, SystemTime>) {
    if p.extension().is_some_and(|e| ["js", "mjs", "css", "html", "json"].iter().any(|x| e == *x)) {
        let rel = p.strip_prefix(ROOT).unwrap_or(p).to_string_lossy().replace('\\', "/");
        out.insert(format!("/{rel}"), m.modified().unwrap_or(SystemTime::UNIX_EPOCH));
    }
}
