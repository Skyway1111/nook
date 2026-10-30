#[path = "../rsrc.rs"]
mod rsrc;

/// The identity setup installs under, from NOOK_NAME and NOOK_ID when a test build sets them, and
/// nook's version from its Cargo.toml.
fn main() {
    let var = |k: &str, default: &str| {
        println!("cargo:rerun-if-env-changed={k}");
        let v = std::env::var(k).unwrap_or_else(|_| default.into());
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
    println!("cargo:rustc-link-arg-bins=-nostartfiles");
    println!("cargo:rustc-link-arg-bins=-Wl,--entry=start");
}
