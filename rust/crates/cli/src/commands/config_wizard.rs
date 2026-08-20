//! Interactive config wizard, replacing `ConfigWizard.tsx`.
//!
//! `dialoguer` covers what the 457-line Ink component built by hand: selection
//! lists, masked input and confirmation prompts. It runs before the TUI starts,
//! so the two never contend for the terminal.

use std::path::Path;

use anyhow::{Context, Result};
use dialoguer::theme::ColorfulTheme;
use dialoguer::{Confirm, FuzzySelect, Input, Password, Select};
use microagent_core::{MicroagentConfig, ProviderConfig, list_models_for_provider};

/// Provider presets offered by the wizard, with their default endpoints.
const PRESETS: &[(&str, &str, bool)] = &[
    // (type, default base URL, needs an API key)
    ("ollama", "http://localhost:11434/v1", false),
    ("github-copilot", "https://api.githubcopilot.com", false),
    ("openai", "https://api.openai.com/v1", true),
    ("custom", "", true),
];

pub async fn run(output: &Path) -> Result<()> {
    let theme = ColorfulTheme::default();

    println!("microagent config wizard");
    println!("Writing to {}\n", output.display());

    if output.exists()
        && !Confirm::with_theme(&theme)
            .with_prompt(format!("{} exists. Overwrite?", output.display()))
            .default(false)
            .interact()?
    {
        println!("Cancelled.");
        return Ok(());
    }

    let mut providers: Vec<ProviderConfig> = Vec::new();

    loop {
        providers.push(prompt_provider(&theme).await?);

        if !Confirm::with_theme(&theme)
            .with_prompt("Add another provider?")
            .default(false)
            .interact()?
        {
            break;
        }
    }

    // Which provider is active by default.
    let active = if providers.len() > 1 {
        let labels: Vec<String> = providers
            .iter()
            .map(|p| format!("{}/{}", p.label(), p.model))
            .collect();
        let index = Select::with_theme(&theme)
            .with_prompt("Active provider")
            .items(&labels)
            .default(0)
            .interact()?;
        Some(providers[index].label().to_string())
    } else {
        None
    };

    let system_prompt: String = Input::with_theme(&theme)
        .with_prompt("System prompt")
        .default("You are a helpful coding assistant. Be concise.".to_string())
        .interact_text()?;

    let config = MicroagentConfig {
        provider: None,
        providers: Some(providers),
        active_provider: active,
        system_prompt: Some(system_prompt),
        mcp_servers: None,
    };

    write_config(output, &config)?;
    println!("\nWrote {}", output.display());
    println!("Run `microagent chat` to start.");

    Ok(())
}

async fn prompt_provider(theme: &ColorfulTheme) -> Result<ProviderConfig> {
    let labels: Vec<&str> = PRESETS.iter().map(|(name, _, _)| *name).collect();
    let index = Select::with_theme(theme)
        .with_prompt("Provider type")
        .items(&labels)
        .default(0)
        .interact()?;

    let (preset, default_url, needs_key) = PRESETS[index];

    let kind = if preset == "custom" {
        Input::with_theme(theme)
            .with_prompt("Provider name (any OpenAI-compatible endpoint)")
            .interact_text()?
    } else {
        preset.to_string()
    };

    let base_url: String = Input::with_theme(theme)
        .with_prompt("Base URL")
        .default(default_url.to_string())
        .allow_empty(!default_url.is_empty())
        .interact_text()?;

    let api_key = if needs_key {
        let key: String = Password::with_theme(theme)
            .with_prompt("API key (leave blank to use the environment)")
            .allow_empty_password(true)
            .interact()?;
        (!key.is_empty()).then_some(key)
    } else {
        None
    };

    // Offer the live model list when the endpoint can be reached; fall back to
    // typing a name, since an unreachable endpoint should not block setup.
    let model = match fetch_models(&kind, &base_url, api_key.as_deref()).await {
        Some(models) if !models.is_empty() => {
            let index = FuzzySelect::with_theme(theme)
                .with_prompt("Model (type to filter)")
                .items(&models)
                .default(0)
                .interact()?;
            models[index].clone()
        }
        _ => {
            println!("  (could not list models; enter one manually)");
            Input::with_theme(theme)
                .with_prompt("Model")
                .interact_text()?
        }
    };

    Ok(ProviderConfig {
        kind,
        model,
        base_url: (!base_url.is_empty()).then_some(base_url),
        api_key,
        name: None,
    })
}

async fn fetch_models(kind: &str, base_url: &str, api_key: Option<&str>) -> Option<Vec<String>> {
    println!("  Fetching models...");
    let base = (!base_url.is_empty()).then_some(base_url);
    match list_models_for_provider(kind, base, api_key).await {
        Ok(models) => Some(models.into_iter().map(|m| m.id).collect()),
        Err(err) => {
            println!("  {err}");
            None
        }
    }
}

fn write_config(output: &Path, config: &MicroagentConfig) -> Result<()> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let mut json = serde_json::to_string_pretty(config)?;
    json.push('\n');
    std::fs::write(output, json).with_context(|| format!("writing {}", output.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_preset_that_needs_a_key_is_a_hosted_endpoint() {
        for (name, url, needs_key) in PRESETS {
            if *needs_key && *name != "custom" {
                assert!(url.starts_with("https://"), "{name} should be https");
            }
        }
    }

    #[test]
    fn local_presets_do_not_ask_for_a_key() {
        let ollama = PRESETS.iter().find(|(n, _, _)| *n == "ollama").unwrap();
        assert!(!ollama.2, "ollama needs no API key");

        // Copilot authenticates through the device flow, not a pasted key.
        let copilot = PRESETS
            .iter()
            .find(|(n, _, _)| *n == "github-copilot")
            .unwrap();
        assert!(!copilot.2, "copilot uses the device flow");
    }

    #[test]
    fn written_config_round_trips_and_uses_the_multi_provider_shape() {
        let dir = std::env::temp_dir().join("microagent-wizard-test");
        let path = dir.join("config.json");

        let config = MicroagentConfig {
            provider: None,
            providers: Some(vec![ProviderConfig {
                kind: "ollama".to_string(),
                model: "llama3.2".to_string(),
                base_url: Some("http://localhost:11434/v1".to_string()),
                api_key: None,
                name: None,
            }]),
            active_provider: None,
            system_prompt: Some("be brief".to_string()),
            mcp_servers: None,
        };

        write_config(&path, &config).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed: MicroagentConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, config);

        // The file must be readable by the TypeScript implementation too, which
        // means camelCase keys and no nulls for absent fields.
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(value["providers"][0]["baseUrl"].is_string());
        assert!(value.get("provider").is_none(), "no null legacy key");
        assert!(value.get("mcpServers").is_none(), "no null mcpServers");
        assert!(raw.ends_with('\n'), "should end with a newline");

        std::fs::remove_file(&path).ok();
    }
}
