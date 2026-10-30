//! nook's identity, the exe's resources, and the page's files. `NOOK_ID` and `NOOK_NAME` name a test build's
//! folders and window, as they name its installer's. A debug build reads the page's files from the repository
//! as they are now; a release build holds every file of `dist/`, the bundler's output.
#[path = "rsrc.rs"]
mod rsrc;
#[path = "src/host/mime.rs"]
mod mime;

use std::path::{Path, PathBuf};

fn main() {
    let name = rsrc::identity();
    if std::env::var("CARGO_CFG_TARGET_OS").unwrap() == "windows" {
        rsrc::link("icons/icon.ico", &name, env!("CARGO_PKG_VERSION"));
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let out = if std::env::var_os("CARGO_CFG_DEBUG_ASSERTIONS").is_some() {
        format!("pub const ROOT: &str = {:?};\n", root.display().to_string())
    } else {
        let dist = root.join("dist");
        println!("cargo:rerun-if-changed={}", dist.display());
        let mut files = Vec::new();
        walk(&dist, &mut files);
        assert!(files.iter().any(|f| f.ends_with("index.html")), "{} has no index.html: build the page first", dist.display());
        let mut files: Vec<(String, PathBuf)> =
            files.into_iter().map(|p| (p.strip_prefix(&dist).unwrap().to_string_lossy().replace('\\', "/"), p)).collect();
        files.sort();
        let mut out = String::from("/// The page's files, sorted by path, with their types.\nstatic ASSETS: &[(&str, &str, &[u8])] = &[\n");
        for (rel, abs) in &files {
            out += &format!("    ({rel:?}, {:?}, include_bytes!({:?})),\n", mime::mime(rel), abs.display().to_string());
        }
        out + "];\n"
    };
    std::fs::write(Path::new(&std::env::var("OUT_DIR").unwrap()).join("assets.rs"), out).unwrap();
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}: build the page first", dir.display()));
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}
