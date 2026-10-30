#[path = "../rsrc.rs"]
mod rsrc;

/// The identity setup installs under, from NOOK_NAME and NOOK_ID when a test build sets them, and
/// nook's version from its Cargo.toml.
fn main() {
    let var = |k: &str, default: &str| {
        println!("cargo:rerun-if-env-changed={k}");
        let v = std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.into());
        // Every registry key and folder setup deletes ends in these.
        assert!(!v.contains(['\\', '/']), "{k} names a key or folder, not a path");
        println!("cargo:rustc-env={k}={v}");
        v
    };
    let name = var("NOOK_NAME", "nook");
    var("NOOK_ID", "dev.nook.app");
    println!("cargo:rerun-if-changed=../Cargo.toml");
    let toml = std::fs::read_to_string("../Cargo.toml").unwrap();
    let version = toml.lines().find_map(|l| l.strip_prefix("version = \"")?.strip_suffix('"')).unwrap();
    println!("cargo:rustc-env=NOOK_VERSION={version}");
    rsrc::link("../icons/icon.ico", &name, version);
    if std::env::var("CARGO_CFG_TARGET_ENV").unwrap() == "msvc" {
        println!("cargo:rustc-link-arg-bins=/ENTRY:start");
        println!("cargo:rustc-link-arg-bins=/NODEFAULTLIB");
    } else {
        println!("cargo:rustc-link-arg-bins=-nostartfiles");
        println!("cargo:rustc-link-arg-bins=-Wl,--entry=start");
    }
}
