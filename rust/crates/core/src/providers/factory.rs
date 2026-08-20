//! Provider presets and construction, porting
//! `packages/core/src/providers/factory.ts`.

use std::sync::Arc;

use crate::error::Result;
use crate::providers::LlmProvider;
use crate::providers::openai_compatible::{Auth, OpenAiCompatibleProvider, OpenAiProviderOptions};
use crate::types::{ModelInfo, ProviderConfig};

const COPILOT_INTEGRATION_HEADER: (&str, &str) = ("Copilot-Integration-Id", "vscode-chat");

/// Resolve a GitHub Copilot bearer token.
///
/// Indirection so the provider does not depend on the auth module's internals.
pub(crate) async fn copilot_bearer() -> Result<String> {
    crate::providers::github_auth::copilot_token(None).await
}

/// Build a provider from config.
///
/// Known types get a preset; anything else is treated as a raw
/// OpenAI-compatible endpoint, matching the TypeScript fallback.
pub fn create_provider(config: &ProviderConfig) -> Arc<dyn LlmProvider> {
    let name = config.label().to_string();

    let opts = match config.kind.as_str() {
        "ollama" => OpenAiProviderOptions {
            name,
            base_url: config
                .base_url
                .clone()
                .unwrap_or_else(|| "http://localhost:11434/v1".to_string()),
            auth: Auth::None,
            headers: Vec::new(),
        },

        "github-copilot" => OpenAiProviderOptions {
            name,
            base_url: config
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.githubcopilot.com".to_string()),
            auth: Auth::Copilot,
            headers: vec![(
                COPILOT_INTEGRATION_HEADER.0.to_string(),
                COPILOT_INTEGRATION_HEADER.1.to_string(),
            )],
        },

        "openai" => OpenAiProviderOptions {
            name,
            base_url: config
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
            auth: match config
                .api_key
                .clone()
                .or_else(|| std::env::var("OPENAI_API_KEY").ok())
            {
                Some(key) => Auth::Static(key),
                None => Auth::None,
            },
            headers: Vec::new(),
        },

        // Unknown type: a custom OpenAI-compatible endpoint.
        _ => OpenAiProviderOptions {
            name,
            base_url: config.base_url.clone().unwrap_or_default(),
            auth: match config.api_key.clone() {
                Some(key) => Auth::Static(key),
                None => Auth::None,
            },
            headers: Vec::new(),
        },
    };

    Arc::new(OpenAiCompatibleProvider::new(opts))
}

/// List models for a provider type without building a full agent.
///
/// For `github-copilot` this may trigger the device auth flow.
pub async fn list_models_for_provider(
    kind: &str,
    base_url: Option<&str>,
    api_key: Option<&str>,
) -> Result<Vec<ModelInfo>> {
    let config = ProviderConfig {
        kind: kind.to_string(),
        model: String::new(),
        base_url: base_url.map(str::to_string),
        api_key: api_key.map(str::to_string),
        name: None,
    };
    create_provider(&config).list_models().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(kind: &str) -> ProviderConfig {
        ProviderConfig {
            kind: kind.to_string(),
            model: "m".to_string(),
            base_url: None,
            api_key: None,
            name: None,
        }
    }

    #[test]
    fn presets_name_themselves_after_their_type() {
        for kind in ["ollama", "github-copilot", "openai", "something-custom"] {
            assert_eq!(create_provider(&config(kind)).name(), kind);
        }
    }

    #[test]
    fn an_explicit_name_overrides_the_type() {
        let mut c = config("openai");
        c.name = Some("work".to_string());
        assert_eq!(create_provider(&c).name(), "work");
    }
}
