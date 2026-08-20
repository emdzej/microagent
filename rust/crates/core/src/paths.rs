//! XDG base directory paths, mirroring `packages/core/src/paths.ts`.
//!
//! Hand-rolled rather than delegated to the `directories` crate: that crate
//! resolves `~/Library/Application Support` on macOS, which would put the Rust
//! binary's config somewhere the TypeScript binary never looks. Sharing one
//! config file across both implementations is a goal, so the XDG layout is
//! applied on every platform, exactly as `paths.ts` does.

use std::path::PathBuf;

const APP_NAME: &str = "microagent";

fn home() -> PathBuf {
    #[cfg(unix)]
    let var = "HOME";
    #[cfg(windows)]
    let var = "USERPROFILE";

    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn base(env: &str, fallback: &[&str]) -> PathBuf {
    match std::env::var_os(env) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => {
            let mut p = home();
            for part in fallback {
                p.push(part);
            }
            p
        }
    }
}

/// Config directory, e.g. `~/.config/microagent`.
pub fn config() -> PathBuf {
    base("XDG_CONFIG_HOME", &[".config"]).join(APP_NAME)
}

/// Persistent data directory, e.g. `~/.local/share/microagent`.
pub fn data() -> PathBuf {
    base("XDG_DATA_HOME", &[".local", "share"]).join(APP_NAME)
}

/// Cache directory, e.g. `~/.cache/microagent`.
pub fn cache() -> PathBuf {
    base("XDG_CACHE_HOME", &[".cache"]).join(APP_NAME)
}

/// Default config file path: `<config>/config.json`.
pub fn config_file() -> PathBuf {
    config().join("config.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_file_lives_under_the_app_directory() {
        let p = config_file();
        assert!(p.ends_with("microagent/config.json"), "got {p:?}");
    }

    #[test]
    fn all_paths_share_the_app_name_segment() {
        for p in [config(), data(), cache()] {
            assert!(
                p.components().any(|c| c.as_os_str() == APP_NAME),
                "{p:?} is missing the app name"
            );
        }
    }
}
