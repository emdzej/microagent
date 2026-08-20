//! Config discovery and persistence, porting `loadConfig` in
//! `packages/cli/src/bin.ts`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use microagent_core::{MicroagentConfig, ProviderConfig, paths};

use crate::cli::ProviderOpts;

const DEFAULT_PROVIDER: &str = "ollama";
const DEFAULT_MODEL: &str = "llama3.2";
const DEFAULT_SYSTEM_PROMPT: &str = "You are a helpful coding assistant. Be concise.";

pub struct LoadedConfig {
    pub config: MicroagentConfig,
    /// Where the config came from, if anywhere. `None` means it was synthesised
    /// from flags, so there is nothing to persist model switches back to.
    pub path: Option<PathBuf>,
}

/// Load config, then apply any CLI overrides on top.
///
/// Discovery order matches the TypeScript version: an explicit `--config`, then
/// the XDG config file, then `./microagent.config.json`, then flag defaults.
///
/// One deliberate difference: CLI flags override a config file that was found,
/// rather than being ignored. In the TypeScript version `loadConfig` returns
/// early once a file is located, so `-p github-copilot -m gpt-4o` silently does
/// nothing whenever a config file exists — which the README nonetheless
/// documents as working.
pub fn load_config(opts: &ProviderOpts) -> Result<LoadedConfig> {
    let mut loaded = discover(opts)?;
    apply_overrides(&mut loaded.config, opts);
    Ok(loaded)
}

fn discover(opts: &ProviderOpts) -> Result<LoadedConfig> {
    if let Some(explicit) = &opts.config {
        let path = std::path::absolute(explicit)?;
        if !path.exists() {
            bail!("Config file not found: {}", path.display());
        }
        return Ok(LoadedConfig {
            config: read_config(&path)?,
            path: Some(path),
        });
    }

    let candidates = [
        paths::config_file(),
        PathBuf::from("microagent.config.json"),
    ];
    for candidate in candidates {
        if candidate.exists() {
            let config = read_config(&candidate)?;
            return Ok(LoadedConfig {
                config,
                path: Some(candidate),
            });
        }
    }

    // Nothing on disk: synthesise from flags.
    Ok(LoadedConfig {
        config: MicroagentConfig {
            provider: Some(ProviderConfig {
                kind: opts
                    .provider
                    .clone()
                    .unwrap_or_else(|| DEFAULT_PROVIDER.to_string()),
                model: opts
                    .model
                    .clone()
                    .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
                base_url: opts.base_url.clone(),
                api_key: opts.api_key.clone(),
                name: None,
            }),
            system_prompt: Some(
                opts.system
                    .clone()
                    .unwrap_or_else(|| DEFAULT_SYSTEM_PROMPT.to_string()),
            ),
            ..Default::default()
        },
        path: None,
    })
}

fn read_config(path: &Path) -> Result<MicroagentConfig> {
    let raw =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))
}

/// Apply CLI overrides to a loaded config.
fn apply_overrides(config: &mut MicroagentConfig, opts: &ProviderOpts) {
    if let Some(system) = &opts.system {
        config.system_prompt = Some(system.clone());
    }

    // Selecting a provider by type or name makes it active. If it is not already
    // configured, add it so `-p openai` works against a config that lacks it.
    if let Some(requested) = &opts.provider {
        let known = config
            .resolve_providers()
            .iter()
            .any(|p| p.label() == requested || p.kind == *requested);

        if !known {
            let entry = ProviderConfig {
                kind: requested.clone(),
                model: opts
                    .model
                    .clone()
                    .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
                base_url: opts.base_url.clone(),
                api_key: opts.api_key.clone(),
                name: None,
            };
            match &mut config.providers {
                Some(list) => list.push(entry),
                None => {
                    let mut list = config.resolve_providers();
                    list.push(entry);
                    config.providers = Some(list);
                    config.provider = None;
                }
            }
        }
        config.active_provider = Some(requested.clone());
    }

    // Remaining overrides apply to whichever provider is now active.
    if opts.model.is_none() && opts.base_url.is_none() && opts.api_key.is_none() {
        return;
    }

    let active_label = config
        .resolve_active_provider()
        .ok()
        .map(|p| p.label().to_string());
    let Some(active_label) = active_label else {
        return;
    };

    let mut providers = config.resolve_providers();
    for p in &mut providers {
        if p.label() != active_label {
            continue;
        }
        if let Some(model) = &opts.model {
            p.model = model.clone();
        }
        if let Some(base_url) = &opts.base_url {
            p.base_url = Some(base_url.clone());
        }
        if let Some(api_key) = &opts.api_key {
            p.api_key = Some(api_key.clone());
        }
    }

    if config.providers.is_some() {
        config.providers = Some(providers);
    } else {
        config.provider = providers.into_iter().next();
    }
}

/// Persist a model switch back to the config file.
///
/// Re-reads the file rather than serialising the in-memory config, so unrelated
/// keys and any hand-written formatting are preserved. Failure is non-fatal: the
/// switch has already taken effect in memory.
pub fn persist_model(path: &Path, provider: &str, model: &str) -> Result<()> {
    let mut config = read_config(path)?;

    match &mut config.providers {
        Some(list) if !list.is_empty() => {
            if let Some(entry) = list
                .iter_mut()
                .find(|p| p.label() == provider || p.kind == provider)
            {
                entry.model = model.to_string();
            }
            config.active_provider = Some(provider.to_string());
        }
        _ => {
            // Only touch the legacy single provider when it is actually the one
            // being switched. The TypeScript version writes unconditionally
            // (`else if (raw.provider) { raw.provider.model = newModel }`), so
            // `-p ollama` followed by a model switch stamps an Ollama model onto
            // a `github-copilot` entry and silently corrupts the config.
            match &mut config.provider {
                Some(entry) if entry.label() == provider || entry.kind == provider => {
                    entry.model = model.to_string();
                }
                // The switch targets a provider that only exists because of a CLI
                // flag, so there is nothing on disk to update.
                _ => return Ok(()),
            }
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut json = serde_json::to_string_pretty(&config)?;
    json.push('\n');
    std::fs::write(path, json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> ProviderOpts {
        ProviderOpts::default()
    }

    fn base_config() -> MicroagentConfig {
        serde_json::from_value(serde_json::json!({
            "providers": [
                { "type": "ollama", "model": "llama3.2" },
                { "type": "openai", "model": "gpt-4o", "name": "work" }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn model_override_applies_to_the_active_provider() {
        let mut config = base_config();
        let mut o = opts();
        o.model = Some("qwen2.5".to_string());
        apply_overrides(&mut config, &o);

        let active = config.resolve_active_provider().unwrap();
        assert_eq!(active.label(), "ollama");
        assert_eq!(active.model, "qwen2.5");
        // The other provider is untouched.
        let providers = config.resolve_providers();
        assert_eq!(providers[1].model, "gpt-4o");
    }

    #[test]
    fn provider_override_switches_the_active_provider() {
        let mut config = base_config();
        let mut o = opts();
        o.provider = Some("work".to_string());
        apply_overrides(&mut config, &o);
        assert_eq!(config.resolve_active_provider().unwrap().label(), "work");
    }

    /// The behaviour the README documents but the TypeScript version does not
    /// actually implement when a config file is present.
    #[test]
    fn provider_and_model_flags_together_override_a_loaded_config() {
        let mut config = base_config();
        let mut o = opts();
        o.provider = Some("work".to_string());
        o.model = Some("gpt-4o-mini".to_string());
        apply_overrides(&mut config, &o);

        let active = config.resolve_active_provider().unwrap();
        assert_eq!(active.label(), "work");
        assert_eq!(active.model, "gpt-4o-mini");
    }

    #[test]
    fn an_unconfigured_provider_flag_is_added_rather_than_ignored() {
        let mut config = base_config();
        let mut o = opts();
        o.provider = Some("groq".to_string());
        o.base_url = Some("https://api.groq.com/openai/v1".to_string());
        apply_overrides(&mut config, &o);

        let active = config.resolve_active_provider().unwrap();
        assert_eq!(active.kind, "groq");
        assert_eq!(
            active.base_url.as_deref(),
            Some("https://api.groq.com/openai/v1")
        );
        assert_eq!(config.resolve_providers().len(), 3);
    }

    #[test]
    fn overrides_work_on_a_legacy_single_provider_config() {
        let mut config: MicroagentConfig = serde_json::from_value(serde_json::json!({
            "provider": { "type": "ollama", "model": "llama3.2" }
        }))
        .unwrap();
        let mut o = opts();
        o.model = Some("phi4".to_string());
        apply_overrides(&mut config, &o);
        assert_eq!(config.resolve_active_provider().unwrap().model, "phi4");
    }

    #[test]
    fn no_flags_leaves_the_config_untouched() {
        let mut config = base_config();
        let before = config.clone();
        apply_overrides(&mut config, &opts());
        assert_eq!(config, before);
    }

    #[test]
    fn system_prompt_flag_overrides_the_file() {
        let mut config = base_config();
        config.system_prompt = Some("old".to_string());
        let mut o = opts();
        o.system = Some("new".to_string());
        apply_overrides(&mut config, &o);
        assert_eq!(config.system_prompt.as_deref(), Some("new"));
    }

    /// Regression test: found by running the real server against a real config.
    ///
    /// With a legacy single-provider config for `github-copilot`, starting with
    /// `-p ollama` and then switching models must not stamp the Ollama model onto
    /// the Copilot entry.
    #[test]
    fn persist_model_leaves_a_non_matching_legacy_provider_alone() {
        let dir = std::env::temp_dir().join("microagent-persist-mismatch");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            serde_json::json!({
                "provider": { "type": "github-copilot", "model": "gpt-5-mini" }
            })
            .to_string(),
        )
        .unwrap();

        persist_model(&path, "ollama", "qwen2.5").unwrap();

        let after = read_config(&path).unwrap();
        let provider = after.provider.unwrap();
        assert_eq!(provider.kind, "github-copilot");
        assert_eq!(
            provider.model, "gpt-5-mini",
            "an ollama switch must not rewrite the copilot entry"
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn persist_model_updates_a_matching_legacy_provider() {
        let dir = std::env::temp_dir().join("microagent-persist-match");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            serde_json::json!({ "provider": { "type": "ollama", "model": "llama3.2" } })
                .to_string(),
        )
        .unwrap();

        persist_model(&path, "ollama", "qwen2.5").unwrap();

        assert_eq!(
            read_config(&path).unwrap().provider.unwrap().model,
            "qwen2.5"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn persist_model_preserves_unrelated_keys() {
        let dir = std::env::temp_dir().join("microagent-persist-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            serde_json::json!({
                "providers": [{ "type": "ollama", "model": "llama3.2" }],
                "systemPrompt": "keep me",
                "mcpServers": [{ "name": "fs", "transport": "stdio", "command": "x" }]
            })
            .to_string(),
        )
        .unwrap();

        persist_model(&path, "ollama", "qwen2.5").unwrap();

        let after = read_config(&path).unwrap();
        assert_eq!(after.resolve_providers()[0].model, "qwen2.5");
        assert_eq!(after.active_provider.as_deref(), Some("ollama"));
        assert_eq!(after.system_prompt.as_deref(), Some("keep me"));
        assert_eq!(after.mcp_servers.unwrap().len(), 1);

        std::fs::remove_file(&path).ok();
    }
}
