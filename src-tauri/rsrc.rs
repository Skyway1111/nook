//! The exe's resources, written by a build script as a COFF object that GNU ld and MSVC link.exe both
//! take: icon group 32512 from an .ico, VERSIONINFO, and a manifest for Common Controls 6 and
//! per-monitor DPI.

const MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency><application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings><dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness></windowsSettings></application></assembly>"#;

/// Writes `$OUT_DIR/rsrc.o` and links it into the package's binaries.
pub fn link(ico: &str, name: &str, version: &str) {
    println!("cargo:rerun-if-changed={ico}");
    let ico = std::fs::read(ico).expect("icon");
    let n = u16::from_le_bytes([ico[4], ico[5]]);
    let mut res = Vec::new();
    let mut group = ico[..6].to_vec();
    for i in 0..n {
        let e = &ico[6 + 16 * i as usize..][..16];
        let at = |o: usize| u32::from_le_bytes(e[o..o + 4].try_into().unwrap()) as usize;
        res.push((3, i + 1, ico[at(12)..][..at(8)].to_vec()));
        group.extend_from_slice(&e[..12]);
        group.extend((i + 1).to_le_bytes());
    }
    res.push((14, 32512, group));
    res.push((16, 1, version_info(name, version)));
    res.push((24, 1, MANIFEST.as_bytes().to_vec()));
    let out = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("rsrc.o");
    std::fs::write(&out, coff(&res)).unwrap();
    println!("cargo:rustc-link-arg={}", out.display());
}

/// A `.rsrc` section holding the type → id → language tree, each leaf in language 1033, with an
/// ADDR32NB relocation on every leaf's data address. `res` is sorted by type, then id.
fn coff(res: &[(u16, u16, Vec<u8>)]) -> Vec<u8> {
    let mut types: Vec<(u16, usize)> = Vec::new();
    for r in res {
        match types.last_mut() {
            Some(t) if t.0 == r.0 => t.1 += 1,
            _ => types.push((r.0, 1)),
        }
    }
    let dir = |s: &mut Vec<u8>, n: usize| {
        s.extend([0; 14]);
        s.extend((n as u16).to_le_bytes());
    };
    let entry = |s: &mut Vec<u8>, id: u32, at: usize| {
        s.extend(id.to_le_bytes());
        s.extend((at as u32).to_le_bytes());
    };
    let (n, sub) = (res.len(), 0x8000_0000);
    let names = 16 + 8 * types.len() + 16 * types.len() + 8 * n;
    let leaves = names + 24 * n;
    let mut data = leaves + 16 * n;
    let mut s = Vec::new();
    dir(&mut s, types.len());
    let mut at = 16 + 8 * types.len();
    for &(t, count) in &types {
        entry(&mut s, t as u32, sub | at);
        at += 16 + 8 * count;
    }
    let mut k = 0;
    for &(_, count) in &types {
        dir(&mut s, count);
        for r in &res[k..k + count] {
            entry(&mut s, r.1 as u32, sub | (names + 24 * k));
            k += 1;
        }
    }
    for k in 0..n {
        dir(&mut s, 1);
        entry(&mut s, 1033, leaves + 16 * k);
    }
    for r in res {
        data = (data + 7) & !7;
        entry(&mut s, data as u32, r.2.len());
        s.extend([0; 8]);
        data += r.2.len();
    }
    for r in res {
        s.resize((s.len() + 7) & !7, 0);
        s.extend(&r.2);
    }
    let (raw, relocs) = (20 + 40, 20 + 40 + s.len());
    let syms = relocs + 10 * n;
    let mut o = Vec::with_capacity(syms + 22);
    o.extend(0x8664u16.to_le_bytes());
    o.extend(1u16.to_le_bytes());
    o.extend([0; 4]);
    o.extend((syms as u32).to_le_bytes());
    o.extend(1u32.to_le_bytes());
    o.extend([0; 4]);
    o.extend(b".rsrc\0\0\0");
    o.extend([0; 8]);
    for v in [s.len(), raw, relocs, 0] {
        o.extend((v as u32).to_le_bytes());
    }
    o.extend((n as u16).to_le_bytes());
    o.extend([0; 2]);
    o.extend(0x4030_0040u32.to_le_bytes());
    o.extend(&s);
    for k in 0..n {
        o.extend(((leaves + 16 * k) as u32).to_le_bytes());
        o.extend([0; 4]);
        o.extend(3u16.to_le_bytes());
    }
    o.extend(b".rsrc\0\0\0");
    o.extend([0, 0, 0, 0, 1, 0, 0, 0, 3, 0]);
    o.extend(4u32.to_le_bytes());
    o
}

/// VS_VERSIONINFO with the strings Explorer and Task Manager show, in language 0, code page 1200.
fn version_info(name: &str, version: &str) -> Vec<u8> {
    let mut v = [0u16; 4];
    for (d, p) in v.iter_mut().zip(version.split('.')) {
        *d = p.parse().unwrap();
    }
    let ms = |a: u16, b: u16| ((a as u32) << 16 | b as u32).to_le_bytes();
    let mut fixed = Vec::new();
    for d in [0xFEEF04BDu32.to_le_bytes(), 0x10000u32.to_le_bytes(), ms(v[0], v[1]), ms(v[2], v[3])] {
        fixed.extend(d);
    }
    fixed.extend_from_within(8..16);
    for d in [0x3Fu32, 0, 0x40004, 1, 0, 0, 0] {
        fixed.extend(d.to_le_bytes());
    }
    let strings: Vec<u8> = [("CompanyName", name), ("FileDescription", name), ("FileVersion", version), ("ProductName", name), ("ProductVersion", version)]
        .iter()
        .flat_map(|(k, v)| {
            let text: Vec<u8> = v.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect();
            node(k, 1, &text, text.len() / 2, &[])
        })
        .collect();
    let table = node("StringFileInfo", 1, &[], 0, &node("000004b0", 1, &[], 0, &strings));
    let var = node("VarFileInfo", 1, &[], 0, &node("Translation", 0, &0x04b0_0000u32.to_le_bytes(), 4, &[]));
    node("VS_VERSION_INFO", 0, &fixed, fixed.len(), &[table, var].concat())
}

/// One version block: header, key, value, then children, each 4-byte aligned. A child block ends
/// padded, so the next one starts aligned.
fn node(key: &str, kind: u16, value: &[u8], value_len: usize, children: &[u8]) -> Vec<u8> {
    let mut b = vec![0; 6];
    b.extend(key.encode_utf16().chain([0]).flat_map(u16::to_le_bytes));
    b.resize((b.len() + 3) & !3, 0);
    b.extend(value);
    if !children.is_empty() {
        b.resize((b.len() + 3) & !3, 0);
        b.extend(children);
    }
    let len = b.len() as u16;
    b[..6].copy_from_slice(&[len.to_le_bytes(), (value_len as u16).to_le_bytes(), kind.to_le_bytes()].concat());
    b.resize((b.len() + 3) & !3, 0);
    b
}
