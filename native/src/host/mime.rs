//! MIME types by extension, for the page's own files (build.rs, at build time) and files on disk.

/// The MIME type for a path's extension.
pub fn mime(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map_or("", |(_, e)| e);
    let mut buf = [0u8; 5];
    if ext.len() > buf.len() {
        return "application/octet-stream";
    }
    for (b, c) in buf.iter_mut().zip(ext.bytes()) {
        *b = c.to_ascii_lowercase();
    }
    match &buf[..ext.len()] {
        b"html" | b"htm" => "text/html",
        b"js" | b"mjs" => "text/javascript",
        b"css" => "text/css",
        b"json" => "application/json",
        b"svg" => "image/svg+xml",
        b"png" => "image/png",
        b"jpg" | b"jpeg" => "image/jpeg",
        b"gif" => "image/gif",
        b"webp" => "image/webp",
        b"avif" => "image/avif",
        b"bmp" => "image/bmp",
        b"ico" => "image/x-icon",
        b"pdf" => "application/pdf",
        b"woff" => "font/woff",
        b"woff2" => "font/woff2",
        b"ttf" => "font/ttf",
        b"otf" => "font/otf",
        b"mp4" | b"m4v" => "video/mp4",
        b"webm" => "video/webm",
        b"mov" => "video/quicktime",
        b"mkv" => "video/x-matroska",
        b"mp3" => "audio/mpeg",
        b"m4a" => "audio/mp4",
        b"aac" => "audio/aac",
        b"wav" => "audio/wav",
        b"ogg" | b"oga" => "audio/ogg",
        b"opus" => "audio/opus",
        b"flac" => "audio/flac",
        b"txt" => "text/plain",
        _ => "application/octet-stream",
    }
}
