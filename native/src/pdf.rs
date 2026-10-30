//! A PDF's first page as a PNG, for its picture in Claude's transcript. The OS draws it, in a worker sandboxed from
//! the user's files and the network (sandbox.rs), which gets only the file's bytes: Windows.Data.Pdf on a software
//! Direct3D device, encoded by WIC, or on Linux poppler-glib, loaded with `dlopen`, and cairo, so a system without
//! poppler draws nothing. Neither runs the file's scripts. Both draw its annotations and form fields, as a viewer does.
use crate::{host::Bytes, sandbox};
use std::io::Read;

/// The largest PDF nook reads into memory for its first page.
const MAX_PDF: u64 = 256 << 20;

/// The first page of the PDF at `path`, fit inside `width` by `height` pixels and 4096 on its longer side, on
/// white, as PNG bytes.
pub fn pdf_page(path: String, width: u32, height: u32) -> Result<Bytes, String> {
    let fail = |e: &dyn std::fmt::Display| format!("can't draw {path}: {e}");
    let file = std::fs::File::open(&path).map_err(|e| fail(&e))?;
    let len = file.metadata().map_err(|e| fail(&e))?.len();
    if len > MAX_PDF {
        return Err(fail(&"it's over 256 MiB"));
    }
    let mut pdf = Vec::with_capacity(len as usize);
    file.take(MAX_PDF).read_to_end(&mut pdf).map_err(|e| fail(&e))?;
    let reply = sandbox::ask(&[&width.to_le_bytes(), &height.to_le_bytes(), &pdf]).map_err(|e| fail(&e))?;
    match reply.split_first() {
        Some((0, png)) => Ok(Bytes(png.to_vec())),
        Some((_, why)) => Err(fail(&String::from_utf8_lossy(why))),
        None => Err(fail(&"the sandbox said nothing")),
    }
}

/// The worker's answer to `pdf_page`'s message: 0 and the PNG, or 1 and why not.
pub fn answer(message: Vec<u8>) -> Vec<u8> {
    let Some((size, pdf)) = message.split_first_chunk::<8>() else { return b"\x01a short request".to_vec() };
    let [width, height] = [0, 4].map(|i| u32::from_le_bytes(size[i..i + 4].try_into().unwrap()));
    let fit = |w: f64, h: f64| {
        let s = (width as f64 / w).min(height as f64 / h).min(4096. / w.max(h));
        let px = |v: f64| (v * s).round().max(1.) as u32;
        (px(w), px(h))
    };
    match os::first_page(pdf, fit) {
        Ok(png) => [&[0][..], &png].concat(),
        Err(e) => [&[1][..], e.as_bytes()].concat(),
    }
}

#[cfg(windows)]
mod os {
    use crate::com::{call, guid, ok, Com, Guid, P};
    use crate::sys::*;
    use std::{
        ffi::c_void,
        ptr::{null, null_mut},
        sync::Mutex,
        thread::sleep,
        time::{Duration, Instant},
    };

    const PDF_DOCUMENT_STATICS: Guid = guid(0x433a0b5f_c007_4788_90f2_08143d922599);
    const RANDOM_ACCESS_STREAM: Guid = guid(0x905a0fe1_bc53_11df_8c49_001e4fc686da);
    const ASYNC_INFO: Guid = guid(0x00000036_0000_0000_c000_000000000046);
    const DXGI_DEVICE: Guid = guid(0x54ec77fa_1377_44e6_8c32_88fd5f44c84c);
    const DXGI_DEVICE3: Guid = guid(0x6007896c_3244_4afd_bf18_a6d3beda5023);
    const DXGI_SURFACE: Guid = guid(0xcafcb56c_6ac3_4889_bf47_9e23bbd260ec);
    const WIC_FACTORY_CLASS: Guid = guid(0xcacaf262_9370_4615_a13b_9f5539da4c0a);
    const WIC_FACTORY: Guid = guid(0xec5ec8a9_c395_4314_9c77_54d7a935ff70);
    const PNG: Guid = guid(0x1b7cfaf4_713f_473c_bbcd_6137425faeaf);
    const BGR: Guid = guid(0x6fddc324_4e03_4bfe_b185_3d77768dc90c);
    const E_TIMEOUT: i32 = 0x800705b4_u32 as i32;

    type CreateDevice = unsafe extern "system" fn(P, u32, P, u32, *const u32, u32, u32, *mut P, *mut u32, *mut P) -> i32;
    type CreateRenderer = unsafe extern "system" fn(P, *mut P) -> i32;

    /// What every page reuses: Windows.Data.Pdf's factory, a WARP device with its context and PDF renderer, and WIC's
    /// factory. WARP is the software device; Windows.Data.Pdf's own renderer would start the GPU's driver.
    struct Kept {
        statics: Com,
        device: Com,
        context: Com,
        renderer: Com,
        dxgi: Com,
        wic: Com,
    }

    // SAFETY: every object here lives in the multithreaded apartment, and a WARP device takes calls from any thread.
    unsafe impl Send for Kept {}

    /// Held for a whole page: a device draws one at a time.
    static KEPT: Mutex<Option<Kept>> = Mutex::new(None);

    /// D3D11CreateDevice and PdfCreateRenderer, from System32's DLLs, loaded with the first page.
    fn load() -> Result<(CreateDevice, CreateRenderer), i32> {
        let find = |dll: &str, name: &[u8]| unsafe {
            let module = LoadLibraryExW(wide(dll).as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32);
            let f = if module.is_null() { null() } else { GetProcAddress(module, name.as_ptr()) };
            (!f.is_null()).then_some(f).ok_or(0x8007007e_u32 as i32) // ERROR_MOD_NOT_FOUND
        };
        let (device, renderer) = (find("d3d11.dll", b"D3D11CreateDevice\0")?, find("windows.data.pdf.dll", b"PdfCreateRenderer\0")?);
        unsafe { Ok((std::mem::transmute::<*const c_void, CreateDevice>(device), std::mem::transmute::<*const c_void, CreateRenderer>(renderer))) }
    }

    fn keep() -> Result<Kept, i32> {
        let (create_device, create_renderer) = load()?;
        let class = wide("Windows.Data.Pdf.PdfDocument");
        unsafe {
            // A thread that never set up COM is in the process's multithreaded apartment, which this keeps.
            CoIncrementMTAUsage(&mut null_mut());
            // A reference string borrows `class`, so nothing frees it.
            let (mut header, mut name, mut statics) = ([0; 3], null_mut(), null_mut());
            ok(WindowsCreateStringReference(class.as_ptr(), class.len() as u32 - 1, &mut header, &mut name))?;
            ok(RoGetActivationFactory(name, &PDF_DOCUMENT_STATICS, &mut statics))?;
            let (mut device, mut context, mut renderer, mut wic) = (null_mut(), null_mut(), null_mut(), null_mut());
            ok(create_device(null_mut(), 5, null_mut(), 0x20, null(), 0, 7, &mut device, null_mut(), &mut context))?; // WARP, BGRA
            let (device, context) = (Com::new(device)?, Com::new(context)?);
            ok(create_renderer(device.query(&DXGI_DEVICE)?.0, &mut renderer))?;
            ok(CoCreateInstance(&WIC_FACTORY_CLASS, null_mut(), 1, &WIC_FACTORY, &mut wic))?; // in-process
            let dxgi = device.query(&DXGI_DEVICE3)?;
            Ok(Kept { statics: Com::new(statics)?, device, context, renderer: Com::new(renderer)?, dxgi, wic: Com::new(wic)? })
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

    /// The first page of the PDF in `pdf` as PNG bytes, at the pixel size `fit` picks for the page's size.
    pub fn first_page(pdf: &[u8], fit: impl FnOnce(f64, f64) -> (u32, u32)) -> Result<Vec<u8>, String> {
        let mut kept = KEPT.lock().unwrap_or_else(|e| e.into_inner());
        let k = match &mut *kept {
            Some(k) => k,
            none => none.insert(keep().map_err(|hr| format!("Windows.Data.Pdf: {hr:#010x}"))?),
        };
        let png = render(k, pdf, fit);
        // The device lets go of what the page took, as a device made for the page would.
        unsafe {
            k.context.at::<unsafe extern "system" fn(P)>(110)(k.context.0); // ClearState
            k.dxgi.at::<unsafe extern "system" fn(P)>(17)(k.dxgi.0); // Trim
        }
        png.map_err(|hr| format!("Windows.Data.Pdf: {hr:#010x}"))
    }

    fn render(k: &Kept, pdf: &[u8], fit: impl FnOnce(f64, f64) -> (u32, u32)) -> Result<Vec<u8>, i32> {
        let len = u32::try_from(pdf.len()).map_err(|_| 0x80070057_u32 as i32)?; // E_INVALIDARG
        unsafe {
            let (memory, mut file) = (Com::new(SHCreateMemStream(pdf.as_ptr(), len))?, null_mut());
            ok(CreateRandomAccessStreamOverStream(memory.0, 0, &RANDOM_ACCESS_STREAM, &mut file))?; // BSOS_DEFAULT
            let file = Com::new(file)?;
            let load = k.statics.make(8, file.0)?; // LoadFromStreamAsync
            wait(&load)?;
            let doc = load.get(8)?; // GetResults
            let page = doc.make(6, 0u32)?; // GetPage
            let [w, h] = page.value::<[f32; 2]>(10)?; // Size, rotation applied
            let (w, h) = fit(w as f64, h as f64);
            let mut desc = TextureDesc { width: w, height: h, mips: 1, array: 1, format: 87, samples: [1, 0], usage: 0, bind: 0x20, cpu: 0, misc: 0 }; // B8G8R8A8, render target
            let texture = |desc: &TextureDesc| {
                let mut out = null_mut();
                ok(call!(k.device.0, 5, desc => *const TextureDesc, null_mut() => P, &mut out => *mut P))?; // CreateTexture2D
                Com::new(out)
            };
            let target = texture(&desc)?;
            let params = RenderParams { source: [0.; 4], width: w, height: h, background: [1.; 4], ignore_high_contrast: true };
            ok(call!(k.renderer.0, 3, page.0 => P, target.query(&DXGI_SURFACE)?.0 => P, 0 => u64, &params => *const RenderParams))?; // RenderPageToSurface at POINT {0, 0}
            (desc.usage, desc.bind, desc.cpu) = (3, 0, 0x20000); // staging, CPU reads
            let copy = texture(&desc)?;
            k.context.at::<unsafe extern "system" fn(P, P, P)>(47)(k.context.0, copy.0, target.0); // CopyResource
            let mut mapped = Mapped { pixels: null_mut(), pitch: 0, _depth_pitch: 0 };
            ok(call!(k.context.0, 14, copy.0 => P, 0 => u32, 1 => u32, 0 => u32, &mut mapped => *mut Mapped))?; // Map, read
            let png = encode(&k.wic, mapped.pixels, mapped.pitch, w, h);
            k.context.at::<unsafe extern "system" fn(P, P, u32)>(15)(k.context.0, copy.0, 0); // Unmap
            png
        }
    }

    /// `height` rows of BGRA pixels, `pitch` bytes apart, as an RGB PNG: the page is opaque.
    unsafe fn encode(factory: &Com, pixels: *const u8, pitch: u32, width: u32, height: u32) -> Result<Vec<u8>, i32> {
        unsafe {
            let (mut encoder, mut frame) = (null_mut(), null_mut());
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
    use crate::host::gtk::g_object_unref;
    use std::{
        ffi::{c_char, c_int, c_uint, c_void, CStr},
        ptr::{null, null_mut},
        sync::OnceLock,
    };

    type P = *mut c_void;
    type Write = unsafe extern "C" fn(P, *const u8, c_uint) -> c_int;

    extern "C" {
        fn dlopen(file: *const c_char, mode: c_int) -> P;
        fn dlsym(lib: P, name: *const c_char) -> P;
    }

    #[link(name = "cairo")]
    extern "C" {
        fn cairo_image_surface_create(format: c_int, width: c_int, height: c_int) -> P;
        fn cairo_create(surface: P) -> P;
        fn cairo_set_source_rgb(cr: P, r: f64, g: f64, b: f64);
        fn cairo_paint(cr: P);
        fn cairo_scale(cr: P, x: f64, y: f64);
        fn cairo_destroy(cr: P);
        fn cairo_surface_write_to_png_stream(surface: P, write: Write, closure: P) -> c_int;
        fn cairo_surface_destroy(surface: P);
    }

    /// What this uses of poppler-glib.
    struct Fns {
        new_from_data: unsafe extern "C" fn(*const c_char, c_int, *const c_char, P) -> P,
        get_page: unsafe extern "C" fn(P, c_int) -> P,
        get_size: unsafe extern "C" fn(P, *mut f64, *mut f64),
        page_render: unsafe extern "C" fn(P, P),
    }

    /// The worker draws one page at a time, as poppler needs: every document draws its fonts through one FreeType
    /// library, which takes one thread at a time.
    static FNS: OnceLock<Option<Fns>> = OnceLock::new();

    unsafe fn sym<F>(lib: P, name: &CStr) -> Option<F> {
        let f = unsafe { dlsym(lib, name.as_ptr()) };
        (!f.is_null()).then(|| unsafe { std::mem::transmute_copy::<P, F>(&f) })
    }

    fn load() -> Option<Fns> {
        unsafe {
            let lib = dlopen(c"libpoppler-glib.so.8".as_ptr(), 2); // RTLD_NOW
            if lib.is_null() {
                return None;
            }
            Some(Fns {
                new_from_data: sym(lib, c"poppler_document_new_from_data")?,
                get_page: sym(lib, c"poppler_document_get_page")?,
                get_size: sym(lib, c"poppler_page_get_size")?,
                page_render: sym(lib, c"poppler_page_render")?,
            })
        }
    }

    unsafe extern "C" fn append(png: P, data: *const u8, len: c_uint) -> c_int {
        unsafe { (*(png as *mut Vec<u8>)).extend_from_slice(std::slice::from_raw_parts(data, len as usize)) };
        0 // CAIRO_STATUS_SUCCESS
    }

    /// The first page of the PDF in `pdf` as PNG bytes, at the pixel size `fit` picks for the page's size.
    pub fn first_page(pdf: &[u8], fit: impl FnOnce(f64, f64) -> (u32, u32)) -> Result<Vec<u8>, String> {
        let f = FNS.get_or_init(load).as_ref().ok_or("poppler-glib isn't installed")?;
        let len = c_int::try_from(pdf.len()).map_err(|e| e.to_string())?;
        let mut png = Vec::new();
        unsafe {
            // poppler reads `pdf` in place, so it outlives the document.
            let doc = (f.new_from_data)(pdf.as_ptr().cast(), len, null(), null_mut());
            if doc.is_null() {
                return Err("poppler can't open the PDF".into());
            }
            let page = (f.get_page)(doc, 0);
            if !page.is_null() {
                let (mut w, mut h) = (0., 0.);
                (f.get_size)(page, &mut w, &mut h); // rotation applied
                let (pw, ph) = fit(w, h);
                let surface = cairo_image_surface_create(1, pw as c_int, ph as c_int); // CAIRO_FORMAT_RGB24
                let cr = cairo_create(surface);
                cairo_set_source_rgb(cr, 1., 1., 1.);
                cairo_paint(cr);
                cairo_scale(cr, pw as f64 / w, ph as f64 / h);
                (f.page_render)(page, cr);
                cairo_destroy(cr);
                if cairo_surface_write_to_png_stream(surface, append, (&mut png as *mut Vec<u8>).cast()) != 0 {
                    png.clear();
                }
                cairo_surface_destroy(surface);
                g_object_unref(page);
            }
            g_object_unref(doc);
        }
        if png.is_empty() { Err("poppler can't draw the PDF".into()) } else { Ok(png) }
    }
}
