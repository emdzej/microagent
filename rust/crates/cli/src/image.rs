//! Image attachment resolution, porting `packages/cli/src/util/resolve-image.ts`.

use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

/// Resolve an image argument to something the API accepts.
///
/// URLs and existing data URIs pass through unchanged; a local path is read and
/// encoded as a `data:` URI. Returns `None` if a local path does not exist.
pub fn resolve_image(input: &str) -> Option<String> {
    if input.starts_with("http://") || input.starts_with("https://") || input.starts_with("data:") {
        return Some(input.to_string());
    }

    let path = std::path::absolute(input).ok()?;
    let bytes = std::fs::read(&path).ok()?;
    let mime = mime_for(&path);
    Some(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)))
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        // Matches the TypeScript fallback. Wrong for a mislabelled file, but
        // every provider sniffs the actual bytes anyway.
        _ => "image/png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_data_uris_pass_through_unchanged() {
        for input in [
            "https://example.test/a.png",
            "http://example.test/a.png",
            "data:image/png;base64,AAA",
        ] {
            assert_eq!(resolve_image(input).as_deref(), Some(input));
        }
    }

    #[test]
    fn a_missing_local_file_yields_none() {
        assert!(resolve_image("/definitely/not/here/x.png").is_none());
    }

    #[test]
    fn a_local_file_becomes_a_base64_data_uri() {
        let dir = std::env::temp_dir().join("microagent-image-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pixel.png");
        std::fs::write(&path, [1u8, 2, 3]).unwrap();

        let out = resolve_image(path.to_str().unwrap()).unwrap();
        assert_eq!(
            out,
            format!("data:image/png;base64,{}", STANDARD.encode([1u8, 2, 3]))
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn extensions_map_to_mime_types_case_insensitively() {
        assert_eq!(mime_for(Path::new("a.JPG")), "image/jpeg");
        assert_eq!(mime_for(Path::new("a.jpeg")), "image/jpeg");
        assert_eq!(mime_for(Path::new("a.webp")), "image/webp");
        assert_eq!(mime_for(Path::new("a.gif")), "image/gif");
        assert_eq!(mime_for(Path::new("a.unknown")), "image/png");
        assert_eq!(mime_for(Path::new("noext")), "image/png");
    }
}
