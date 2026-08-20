//! `serve` and `ui` subcommands, porting `packages/cli/src/bin.ts`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use microagent_server::{ServerOptions, serve};

use crate::cli::ProviderOpts;
use crate::config::{load_config, persist_model};

pub async fn run(
    opts: &ProviderOpts,
    host: &str,
    port: u16,
    static_dir: Option<&Path>,
    // Whether to serve the web UI at all. Kept separate from `open_browser`:
    // `ui --no-open` must still serve the assets, it just does not launch a
    // browser.
    serve_web: bool,
    open_browser: bool,
) -> Result<()> {
    let loaded = load_config(opts)?;
    let agent = crate::commands::build_agent(loaded.config).await?;

    // `serve` passes no static dir and serves API only; `ui` resolves the built
    // web assets, falling back to the embedded copy when compiled with
    // `embed-web`.
    let resolved_static = match static_dir {
        Some(dir) => {
            let dir = std::path::absolute(dir)?;
            if !dir.exists() {
                anyhow::bail!("Web assets not found at {}", dir.display());
            }
            Some(dir)
        }
        None if serve_web => resolve_web_dir(),
        None => None,
    };

    if serve_web && resolved_static.is_none() && !cfg!(feature = "embed-web") {
        anyhow::bail!(
            "Web UI not built. Run `pnpm --filter @microagent/web build`, \
             pass --static-dir, or rebuild with `--features embed-web`."
        );
    }

    let options = ServerOptions {
        agent: agent.clone(),
        config_path: loaded.path,
        persist_model: Some(Arc::new(|path, provider, model| {
            persist_model(path, provider, model).map_err(|e| std::io::Error::other(e.to_string()))
        })),
        static_dir: resolved_static,
    };

    if serve_web {
        let url = format!("http://localhost:{port}");
        println!("Web UI available at {url}");
        if open_browser {
            open_url(&url);
        }
    }

    let result = serve(options, host, port).await.context("running server");
    agent.shutdown().await;
    result?;
    Ok(())
}

/// Look for the built web assets in the usual places.
///
/// The TypeScript version resolves `../../web/build` relative to its own `dist`
/// directory. A Rust binary can live anywhere, so several candidates are tried:
/// the current directory (running from the repo root) and paths relative to the
/// executable (running from `target/debug`).
fn resolve_web_dir() -> Option<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("packages/web/build"),
        PathBuf::from("../packages/web/build"),
    ];

    if let Ok(exe) = std::env::current_exe() {
        // target/debug/microagent → repo root is three levels up.
        if let Some(root) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            candidates.push(root.join("packages/web/build"));
            if let Some(repo) = root.parent() {
                candidates.push(repo.join("packages/web/build"));
            }
        }
    }

    candidates
        .into_iter()
        .find(|c| c.join("index.html").exists())
        .and_then(|c| std::path::absolute(c).ok())
}

/// Open a URL in the default browser, best-effort.
fn open_url(url: &str) {
    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else if cfg!(target_os = "windows") {
        ("cmd", vec!["/C", "start", "", url])
    } else {
        ("xdg-open", vec![url])
    };

    // Failure is not worth reporting: the URL is already printed above.
    let _ = std::process::Command::new(program).args(args).spawn();
}
