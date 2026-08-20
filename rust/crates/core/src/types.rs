//! Wire types, mirroring `packages/core/src/types.ts`.
//!
//! The serde representations here are load-bearing: the Rust and TypeScript
//! binaries share one config file and one HTTP API, so field names and shapes
//! must not drift. See `docs/RUST_PORT_PLAN.md`, decision 6.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// A JSON object — the argument shape for tool calls.
///
/// Deliberately `Map<String, Value>` rather than `Value`, to match rmcp's
/// `CallToolRequestParams::arguments` so MCP passthrough needs no rewrap.
pub type JsonObject = serde_json::Map<String, serde_json::Value>;

// ── Messages ────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// Message content: either a plain string or an array of multimodal parts.
///
/// Untagged, matching TypeScript's `string | ContentPart[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl Content {
    /// Concatenate the text of this content, ignoring non-text parts.
    ///
    /// Equivalent to `getTextContent` in the TypeScript version.
    pub fn text(&self) -> String {
        match self {
            Content::Text(s) => s.clone(),
            Content::Parts(parts) => parts
                .iter()
                .filter_map(|p| match p {
                    ContentPart::Text { text } => Some(text.as_str()),
                    ContentPart::ImageUrl { .. } => None,
                })
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        match self {
            Content::Text(s) => s.is_empty(),
            Content::Parts(p) => p.is_empty(),
        }
    }
}

impl From<String> for Content {
    fn from(s: String) -> Self {
        Content::Text(s)
    }
}

impl From<&str> for Content {
    fn from(s: &str) -> Self {
        Content::Text(s.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrl },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageUrl {
    /// `data:image/...;base64,...` or `https://...`
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: Role,
    pub content: Content,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_calls: Option<Vec<ToolCall>>,
}

impl Message {
    pub fn system(content: impl Into<Content>) -> Self {
        Self::new(Role::System, content)
    }

    pub fn user(content: impl Into<Content>) -> Self {
        Self::new(Role::User, content)
    }

    pub fn assistant(content: impl Into<Content>) -> Self {
        Self::new(Role::Assistant, content)
    }

    /// A `tool` role message carrying the result of one tool call.
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<Content>) -> Self {
        Message {
            role: Role::Tool,
            content: content.into(),
            tool_call_id: Some(tool_call_id.into()),
            tool_calls: None,
        }
    }

    fn new(role: Role, content: impl Into<Content>) -> Self {
        Message {
            role,
            content: content.into(),
            tool_call_id: None,
            tool_calls: None,
        }
    }

    pub fn with_tool_calls(mut self, calls: Vec<ToolCall>) -> Self {
        self.tool_calls = if calls.is_empty() { None } else { Some(calls) };
        self
    }

    /// Text content of this message, ignoring images.
    pub fn text(&self) -> String {
        self.content.text()
    }
}

// ── Tools ───────────────────────────────────────────────────────

/// A tool call requested by the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: JsonObject,
}

/// The result of executing a tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub tool_call_id: String,
    pub content: String,
    /// Whether the tool failed. Flattened to `false` rather than `Option`, since
    /// every consumer treats absent and `false` identically.
    #[serde(default)]
    pub is_error: bool,
}

/// A tool's name, description and JSON Schema for its arguments.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    /// JSON Schema object describing the arguments.
    pub input_schema: serde_json::Value,
}

// ── Streaming ───────────────────────────────────────────────────

/// One incremental update from a streaming provider.
///
/// Note: the TypeScript union also declares a `tool_call_delta` variant, but
/// nothing ever emits it, so it is omitted here. The web UI only inspects
/// `type === "text"`, so the wire format stays compatible.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamDelta {
    Text {
        text: String,
    },
    ToolCallStart {
        id: String,
        name: String,
    },
    ToolCallEnd {
        id: String,
        name: String,
        arguments: JsonObject,
    },
    Done,
}

/// Token usage from a single request.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

// ── Providers ───────────────────────────────────────────────────

/// Configuration for one provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// Provider type: `ollama` | `github-copilot` | `openai` | anything else,
    /// which is treated as a raw OpenAI-compatible endpoint.
    #[serde(rename = "type")]
    pub kind: String,
    /// Default model for this provider.
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub api_key: Option<String>,
    /// Optional display name; defaults to `kind`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
}

impl ProviderConfig {
    /// The name this provider is addressed by: explicit `name`, else `kind`.
    pub fn label(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.kind)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub created: Option<i64>,
}

/// A model plus the provider it came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderModelInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub created: Option<i64>,
    pub provider: String,
}

/// Which provider and model are currently active.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveModel {
    pub provider: String,
    pub model: String,
}

// ── MCP ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Stdio,
    Http,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    pub transport: McpTransport,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub url: Option<String>,
}

// ── Application config ──────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicroagentConfig {
    /// Deprecated single-provider form, kept for backward compatibility.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub provider: Option<ProviderConfig>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub providers: Option<Vec<ProviderConfig>>,
    /// Name of the active provider; defaults to the first configured.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mcp_servers: Option<Vec<McpServerConfig>>,
}

impl MicroagentConfig {
    /// All configured providers, normalising the legacy single-`provider` form.
    pub fn resolve_providers(&self) -> Vec<ProviderConfig> {
        if let Some(list) = &self.providers
            && !list.is_empty()
        {
            return list.clone();
        }
        match &self.provider {
            Some(p) => vec![p.clone()],
            None => Vec::new(),
        }
    }

    /// The active provider config: the one matching `active_provider`, else the
    /// first configured.
    pub fn resolve_active_provider(&self) -> Result<ProviderConfig> {
        let providers = self.resolve_providers();
        if providers.is_empty() {
            return Err(Error::NoProviders);
        }
        if let Some(active) = &self.active_provider
            && let Some(found) = providers
                .iter()
                .find(|p| p.label() == active || p.kind == *active)
        {
            return Ok(found.clone());
        }
        Ok(providers[0].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_text_serialises_as_a_bare_string() {
        let m = Message::user("hello");
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["content"], serde_json::json!("hello"));
        // Absent optionals must stay absent, not become null.
        assert!(json.get("toolCallId").is_none());
        assert!(json.get("toolCalls").is_none());
    }

    #[test]
    fn content_parts_round_trip_through_the_typescript_shape() {
        let raw = serde_json::json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "what is this" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } }
            ]
        });
        let m: Message = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(m.text(), "what is this");
        assert_eq!(serde_json::to_value(&m).unwrap(), raw);
    }

    #[test]
    fn stream_delta_text_matches_the_web_ui_expectation() {
        // packages/web/src/lib/api.ts checks `data.type === "text" && data.text`.
        let d = StreamDelta::Text {
            text: "hi".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&d).unwrap(),
            serde_json::json!({ "type": "text", "text": "hi" })
        );
    }

    #[test]
    fn legacy_single_provider_config_still_resolves() {
        let cfg: MicroagentConfig = serde_json::from_value(serde_json::json!({
            "provider": { "type": "ollama", "model": "llama3.2" },
            "systemPrompt": "be brief"
        }))
        .unwrap();
        let providers = cfg.resolve_providers();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].kind, "ollama");
        assert_eq!(cfg.resolve_active_provider().unwrap().model, "llama3.2");
        assert_eq!(cfg.system_prompt.as_deref(), Some("be brief"));
    }

    #[test]
    fn active_provider_selects_by_name_then_kind() {
        let cfg: MicroagentConfig = serde_json::from_value(serde_json::json!({
            "providers": [
                { "type": "ollama", "model": "llama3.2" },
                { "type": "openai", "model": "gpt-4o", "name": "work" }
            ],
            "activeProvider": "work"
        }))
        .unwrap();
        assert_eq!(cfg.resolve_active_provider().unwrap().model, "gpt-4o");
    }

    #[test]
    fn camel_case_provider_fields_match_the_typescript_config() {
        let cfg: MicroagentConfig = serde_json::from_value(serde_json::json!({
            "providers": [{
                "type": "openai",
                "model": "gpt-4o",
                "baseUrl": "https://example.test/v1",
                "apiKey": "sk-test"
            }]
        }))
        .unwrap();
        let p = &cfg.resolve_providers()[0];
        assert_eq!(p.base_url.as_deref(), Some("https://example.test/v1"));
        assert_eq!(p.api_key.as_deref(), Some("sk-test"));
    }

    #[test]
    fn no_providers_is_an_error() {
        let cfg = MicroagentConfig::default();
        assert!(matches!(
            cfg.resolve_active_provider(),
            Err(Error::NoProviders)
        ));
    }
}
