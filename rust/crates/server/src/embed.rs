//! The built web UI, baked into the binary.
//!
//! This is what makes `microagent ui` a single self-contained file with no Node
//! runtime — the clearest practical win of the Rust port.

use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../../../packages/web/build/"]
struct WebAssets;

/// Serve an embedded asset, falling back to `index.html` for SPA routes.
pub async fn serve_embedded(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(response) = asset(path) {
        return response;
    }

    // Unknown path with no extension: an SPA route, so serve the shell.
    match asset("index.html") {
        Some(response) => response,
        None => (
            StatusCode::NOT_FOUND,
            "Web UI not embedded. Rebuild with the web assets present.",
        )
            .into_response(),
    }
}

fn asset(path: &str) -> Option<Response> {
    let file = WebAssets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    Some(
        (
            [(header::CONTENT_TYPE, mime.as_ref())],
            file.data.into_owned(),
        )
            .into_response(),
    )
}
