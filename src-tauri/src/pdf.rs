//! A PDF's first page as a PNG, for its picture in Claude's transcript. The OS draws it: Windows.Data.Pdf on a
//! software Direct3D device, encoded by WIC, or on Linux poppler-glib and cairo, loaded with `dlopen`, so a
//! system without poppler draws nothing. Neither runs the file's scripts. Both draw its annotations and form
//! fields, as a viewer does.
use crate::host::Bytes;
/// The first page of the PDF at `path`, fit inside `width` by `height` pixels and 4096 on its longer side, on
/// white, as PNG bytes.
pub fn pdf_page(path: String, width: u32, height: u32) -> Result<Bytes, String> {
    os::first_page(&path, |w, h| {
        let s = (width as f64 / w).min(height as f64 / h).min(4096. / w.max(h));
        let px = |v: f64| (v * s).round().max(1.) as u32;
        (px(w), px(h))
    })
    .map(Bytes)
}

#[cfg(windows)]
mod os {
    use crate::com::{call, guid, ok, Com, Guid, P};
    use crate::sys::*;
    use std::{
        ffi::c_void,
        ptr::{null, null_mut},
        sync::OnceLock,
        thread::sleep,
        time::{Duration, Instant},
    };

    const PDF_DOCUMENT_STATICS: Guid = guid(0x433a0b5f_c007_4788_90f2_08143d922599);
    const RANDOM_ACCESS_STREAM: Guid = guid(0x905a0fe1_bc53_11df_8c49_001e4fc686da);
    const ASYNC_INFO: Guid = guid(0x00000036_0000_0000_c000_000000000046);
    const DXGI_DEVICE: Guid = guid(0x54ec77fa_1377_44e6_8c32_88fd5f44c84c);
    const DXGI_SURFACE: Guid = guid(0xcafcb56c_6ac3_4889_bf47_9e23bbd260ec);
    const WIC_FACTORY_CLASS: Guid = guid(0xcacaf262_9370_4615_a13b_9f5539da4c0a);
    const WIC_FACTORY: Guid = guid(0xec5ec8a9_c395_4314_9c77_54d7a935ff70);
    const PNG: Guid = guid(0x1b7cfaf4_713f_473c_bbcd_6137425faeaf);
    const BGR: Guid = guid(0x6fddc324_4e03_4bfe_b185_3d77768dc90c);
    const E_TIMEOUT: i32 = 0x800705b4_u32 as i32;

    type CreateDevice = unsafe extern "system" fn(P, u32, P, u32, *const u32, u32, u32, *mut P, *mut u32, *mut P) -> i32;
    type CreateRenderer = unsafe extern "system" fn(P, *mut P) -> i32;

    /// D3D11CreateDevice and PdfCreateRenderer, from System32's DLLs, loaded the first time a PDF shows.
    static FNS: OnceLock<Option<(CreateDevice, CreateRenderer)>> = OnceLock::new();

    fn load() -> Option<(CreateDevice, CreateRenderer)> {
        let find = |dll: &str, name: &[u8]| unsafe {
            let module = LoadLibraryExW(wide(dll).as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32);
            let f = if module.is_null() { null() } else { GetProcAddress(module, name.as_ptr()) };
            (!f.is_null()).then_some(f)
        };
        let (device, renderer) = (find("d3d11.dll", b"D3D11CreateDevice\0")?, find("windows.data.pdf.dll", b"PdfCreateRenderer\0")?);
        unsafe {
            // A thread that never set up COM is in the process's multithreaded apartment, which this keeps.
            CoIncrementMTAUsage(&mut null_mut());
            Some((std::mem::transmute::<*const c_void, CreateDevice>(device), std::mem::transmute::<*const c_void, CreateRenderer>(renderer)))
        }
    }

    /// Waits up to 10 s for async operation `op`, polling its IAsyncInfo's status.
    unsafe fn wait(op: &Com) -> Result<(), i32> {
        let end = Instant::now() + Duration::from_secs(10);
        unsafe {
            let info = op.query(&ASYNC_INFO)?;
            loop {
                match info.value::<i32>(7)? {
                    1 => return Ok(()),
                    0 if Instant::now() < end => sleep(Duration::from_micros(100)),
                    0 => {
                        call!(info.0, 9); // Cancel
                        return Err(E_TIMEOUT);
                    }
                    _ => return Err(info.value(8)?), // ErrorCode
                }
            }
        }
    }

    #[repr(C)]
    struct TextureDesc {
        width: u32,
        height: u32,
        mips: u32,
        array: u32,
        format: u32,
        samples: [u32; 2],
        usage: u32,
        bind: u32,
        cpu: u32,
        misc: u32,
    }

    #[repr(C)]
    struct RenderParams {
        source: [f32; 4],
        width: u32,
        height: u32,
        background: [f32; 4],
        ignore_high_contrast: bool,
    }

    #[repr(C)]
    struct Mapped {
        pixels: *mut u8,
        pitch: u32,
        _depth_pitch: u32,
    }

    /// The first page of the PDF at `path` as PNG bytes, at the pixel size `fit` picks for the page's size.
    pub fn first_page(path: &str, fit: impl FnOnce(f64, f64) -> (u32, u32)) -> Result<Vec<u8>, String> {
        render(path, fit).map_err(|hr| format!("Windows.Data.Pdf can't draw {path}: {hr:#010x}"))
    }

    /// `path` in full behind `\\?\`, so a path past MAX_PATH opens too, as std's own file calls do.
    fn verbatim(path: &str) -> Option<Vec<u16>> {
        let full = std::path::absolute(path).ok()?.into_os_string().into_string().ok()?;
        let full = match full.strip_prefix(r"\\") {
            None => format!(r"\\?\{full}"),
            Some(share) if !share.starts_with(['?', '.']) => format!(r"\\?\UNC\{share}"),
            _ => full,
        };
        Some(full.encode_utf16().chain([0]).collect())
    }

    fn render(path: &str, fit: impl FnOnce(f64, f64) -> (u32, u32)) -> Result<Vec<u8>, i32> {
        let &(create_device, create_renderer) = FNS.get_or_init(load).as_ref().ok_or(0x8007007e_u32 as i32)?; // ERROR_MOD_NOT_FOUND
        let path = verbatim(path).ok_or(0x800700a1_u32 as i32)?; // ERROR_BAD_PATHNAME
        let class: Vec<u16> = "Windows.Data.Pdf.PdfDocument".encode_utf16().chain([0]).collect();
        unsafe {
            let mut file = null_mut();
            ok(CreateRandomAccessStreamOnFile(path.as_ptr(), 0, &RANDOM_ACCESS_STREAM, &mut file))?; // read, sharing all
            let file = Com::new(file)?;
            // A reference string borrows `class`, so nothing frees it.
            let (mut header, mut name, mut statics) = ([0; 3], null_mut(), null_mut());
            ok(WindowsCreateStringReference(class.as_ptr(), class.len() as u32 - 1, &mut header, &mut name))?;
            ok(RoGetActivationFactory(name, &PDF_DOCUMENT_STATICS, &mut statics))?;
            let load = Com::new(statics)?.make(8, file.0)?; // LoadFromStreamAsync
            wait(&load)?;
            let doc = load.get(8)?; // GetResults
            let page = doc.make(6, 0u32)?; // GetPage
            let [w, h] = page.value::<[f32; 2]>(10)?; // Size, rotation applied
            let (w, h) = fit(w as f64, h as f64);
            // WARP, the software device. Windows.Data.Pdf's own renderer would start the GPU's driver in this process.
            let (mut device, mut context) = (null_mut(), null_mut());
            ok(create_device(null_mut(), 5, null_mut(), 0x20, null(), 0, 7, &mut device, null_mut(), &mut context))?; // WARP, BGRA
            let (device, context) = (Com::new(device)?, Com::new(context)?);
            let mut renderer = null_mut();
            ok(create_renderer(device.query(&DXGI_DEVICE)?.0, &mut renderer))?;
            let renderer = Com::new(renderer)?;
            let mut desc = TextureDesc { width: w, height: h, mips: 1, array: 1, format: 87, samples: [1, 0], usage: 0, bind: 0x20, cpu: 0, misc: 0 }; // B8G8R8A8, render target
            let texture = |desc: &TextureDesc| {
                let mut out = null_mut();
                ok(call!(device.0, 5, desc => *const TextureDesc, null_mut() => P, &mut out => *mut P))?; // CreateTexture2D
                Com::new(out)
            };
            let target = texture(&desc)?;
            let params = RenderParams { source: [0.; 4], width: w, height: h, background: [1.; 4], ignore_high_contrast: true };
            ok(call!(renderer.0, 3, page.0 => P, target.query(&DXGI_SURFACE)?.0 => P, 0 => u64, &params => *const RenderParams))?; // RenderPageToSurface at POINT {0, 0}
            (desc.usage, desc.bind, desc.cpu) = (3, 0, 0x20000); // staging, CPU reads
            let copy = texture(&desc)?;
            context.at::<unsafe extern "system" fn(P, P, P)>(47)(context.0, copy.0, target.0); // CopyResource
            let mut mapped = Mapped { pixels: null_mut(), pitch: 0, _depth_pitch: 0 };
            ok(call!(context.0, 14, copy.0 => P, 0 => u32, 1 => u32, 0 => u32, &mut mapped => *mut Mapped))?; // Map, read
            let png = encode(mapped.pixels, mapped.pitch, w, h);
            context.at::<unsafe extern "system" fn(P, P, u32)>(15)(context.0, copy.0, 0); // Unmap
            png
        }
    }

    /// `height` rows of BGRA pixels, `pitch` bytes apart, as an RGB PNG: the page is opaque.
    unsafe fn encode(pixels: *const u8, pitch: u32, width: u32, height: u32) -> Result<Vec<u8>, i32> {
        unsafe {
            let (mut factory, mut encoder, mut frame) = (null_mut(), null_mut(), null_mut());
            ok(CoCreateInstance(&WIC_FACTORY_CLASS, null_mut(), 1, &WIC_FACTORY, &mut factory))?; // in-process
            let factory = Com::new(factory)?;
            ok(call!(factory.0, 8, &PNG => *const Guid, null_mut() => P, &mut encoder => *mut P))?; // CreateEncoder
            let encoder = Com::new(encoder)?;
            let memory = Com::new(SHCreateMemStream(null(), 0))?;
            ok(call!(encoder.0, 3, memory.0 => P, 2 => u32))?; // Initialize, no cache
            ok(call!(encoder.0, 10, &mut frame => *mut P, null_mut() => P))?; // CreateNewFrame
            let frame = Com::new(frame)?;
            ok(call!(frame.0, 3, null_mut() => P))?; // Initialize
            ok(call!(frame.0, 4, width => u32, height => u32))?; // SetSize
            let mut format = BGR;
            ok(call!(frame.0, 6, &mut format => *mut Guid))?; // SetPixelFormat, which PNG takes as is
            let mut bgr = vec![[0u8; 3]; width as usize * height as usize];
            for (y, row) in bgr.chunks_exact_mut(width as usize).enumerate() {
                let bgra = std::slice::from_raw_parts(pixels.add(y * pitch as usize).cast::<[u8; 4]>(), width as usize);
                row.iter_mut().zip(bgra).for_each(|(d, &[b, g, r, _])| *d = [b, g, r]);
            }
            ok(call!(frame.0, 10, height => u32, width * 3 => u32, width * height * 3 => u32, bgr.as_ptr() => *const [u8; 3]))?; // WritePixels
            ok(call!(frame.0, 12))?; // Commit
            ok(call!(encoder.0, 11))?; // Commit
            let mut len = 0u64;
            ok(call!(memory.0, 5, 0 => i64, 2 => u32, &mut len => *mut u64))?; // Seek to the end, for the length
            ok(call!(memory.0, 5, 0 => i64, 0 => u32, null_mut() => *mut u64))?;
            let mut png = vec![0u8; len as usize];
            let mut read = 0u32;
            ok(call!(memory.0, 3, png.as_mut_ptr() => *mut u8, len as u32 => u32, &mut read => *mut u32))?; // Read
            png.truncate(read as usize);
            Ok(png)
        }
    }
}

#[cfg(not(windows))]
mod os {
    use std::{
        ffi::{c_char, c_int, c_uint, c_void, CStr, CString},
        ptr::{null, null_mut},
        sync::{Mutex, OnceLock},
    };

    type P = *mut c_void;

    extern "C" {
        fn dlopen(file: *const c_char, mode: c_int) -> P;
        fn dlsym(lib: P, name: *const c_char) -> P;
    }

    /// What this uses of poppler-glib, and of glib, gobject, and cairo, found through its dependencies.
    struct Fns {
        filename_to_uri: unsafe extern "C" fn(*const c_char, *const c_char, P) -> *mut c_char,
        free: unsafe extern "C" fn(P),
        object_unref: unsafe extern "C" fn(P),
        new_from_file: unsafe extern "C" fn(*const c_char, *const c_char, P) -> P,
        get_page: unsafe extern "C" fn(P, c_int) -> P,
        get_size: unsafe extern "C" fn(P, *mut f64, *mut f64),
        page_render: unsafe extern "C" fn(P, P),
        image_surface_create: unsafe extern "C" fn(c_int, c_int, c_int) -> P,
        create: unsafe extern "C" fn(P) -> P,
        set_source_rgb: unsafe extern "C" fn(P, f64, f64, f64),
        paint: unsafe extern "C" fn(P),
        scale: unsafe extern "C" fn(P, f64, f64),
        destroy: unsafe extern "C" fn(P),
        write_to_png_stream: unsafe extern "C" fn(P, unsafe extern "C" fn(P, *const u8, c_uint) -> c_int, P) -> c_int,
        surface_destroy: unsafe extern "C" fn(P),
    }

    /// Locked for a whole render: every poppler document draws its fonts through one FreeType library, which
    /// takes one thread at a time.
    static FNS: OnceLock<Option<Mutex<Fns>>> = OnceLock::new();

    unsafe fn sym<F>(lib: P, name: &CStr) -> Option<F> {
        let f = unsafe { dlsym(lib, name.as_ptr()) };
        (!f.is_null()).then(|| unsafe { std::mem::transmute_copy::<P, F>(&f) })
    }

    fn load() -> Option<Mutex<Fns>> {
        unsafe {
            let lib = dlopen(c"libpoppler-glib.so.8".as_ptr(), 2); // RTLD_NOW
            if lib.is_null() {
                return None;
            }
            Some(Mutex::new(Fns {
                filename_to_uri: sym(lib, c"g_filename_to_uri")?,
                free: sym(lib, c"g_free")?,
                object_unref: sym(lib, c"g_object_unref")?,
                new_from_file: sym(lib, c"poppler_document_new_from_file")?,
                get_page: sym(lib, c"poppler_document_get_page")?,
                get_size: sym(lib, c"poppler_page_get_size")?,
                page_render: sym(lib, c"poppler_page_render")?,
                image_surface_create: sym(lib, c"cairo_image_surface_create")?,
                create: sym(lib, c"cairo_create")?,
                set_source_rgb: sym(lib, c"cairo_set_source_rgb")?,
                paint: sym(lib, c"cairo_paint")?,
                scale: sym(lib, c"cairo_scale")?,
                destroy: sym(lib, c"cairo_destroy")?,
                write_to_png_stream: sym(lib, c"cairo_surface_write_to_png_stream")?,
                surface_destroy: sym(lib, c"cairo_surface_destroy")?,
            }))
        }
    }

    unsafe extern "C" fn append(png: P, data: *const u8, len: c_uint) -> c_int {
        unsafe { (*(png as *mut Vec<u8>)).extend_from_slice(std::slice::from_raw_parts(data, len as usize)) };
        0 // CAIRO_STATUS_SUCCESS
    }

    /// The first page of the PDF at `path` as PNG bytes, at the pixel size `fit` picks for the page's size.
    pub fn first_page(path: &str, fit: impl FnOnce(f64, f64) -> (u32, u32)) -> Result<Vec<u8>, String> {
        let f = FNS.get_or_init(load).as_ref().ok_or("poppler-glib isn't installed")?.lock().unwrap_or_else(|e| e.into_inner());
        let path = CString::new(path).map_err(|e| e.to_string())?;
        let mut png = Vec::new();
        unsafe {
            let uri = (f.filename_to_uri)(path.as_ptr(), null(), null_mut());
            if uri.is_null() {
                return Err("not an absolute path".into());
            }
            let doc = (f.new_from_file)(uri, null(), null_mut());
            (f.free)(uri.cast());
            if doc.is_null() {
                return Err("poppler can't open the PDF".into());
            }
            let page = (f.get_page)(doc, 0);
            if !page.is_null() {
                let (mut w, mut h) = (0., 0.);
                (f.get_size)(page, &mut w, &mut h); // rotation applied
                let (pw, ph) = fit(w, h);
                let surface = (f.image_surface_create)(1, pw as c_int, ph as c_int); // CAIRO_FORMAT_RGB24
                let cr = (f.create)(surface);
                (f.set_source_rgb)(cr, 1., 1., 1.);
                (f.paint)(cr);
                (f.scale)(cr, pw as f64 / w, ph as f64 / h);
                (f.page_render)(page, cr);
                (f.destroy)(cr);
                if (f.write_to_png_stream)(surface, append, (&mut png as *mut Vec<u8>).cast()) != 0 {
                    png.clear();
                }
                (f.surface_destroy)(surface);
                (f.object_unref)(page);
            }
            (f.object_unref)(doc);
        }
        if png.is_empty() { Err("poppler can't draw the PDF".into()) } else { Ok(png) }
    }
}
