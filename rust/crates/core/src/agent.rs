//! The agent loop, porting `packages/core/src/agent.ts`.
//!
//! The TypeScript `Agent` class conflates immutable configuration (providers,
//! tools, MCP) with mutable per-conversation state (`messages`, `stats`). Here
//! those are separate types: [`Agent`] is shared behind an `Arc` and is `Sync`,
//! while [`Conversation`] owns the mutable turn state. See
//! `docs/RUST_PORT_PLAN.md`, decisions 1 and 2.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use futures_util::future::join_all;

use crate::error::{Error, Result};
use crate::events::{AgentEvent, EventSink, emit};
use crate::mcp::McpManager;
use crate::providers::{ChatRequest, LlmProvider, create_provider};
use crate::stats::UsageStats;
use crate::tool_registry::{Tool, ToolRegistry};
use crate::types::{
    ActiveModel, Content, ContentPart, ImageUrl, McpServerConfig, Message, MicroagentConfig,
    ProviderConfig, ProviderModelInfo,
};

const DEFAULT_MAX_TOOL_ROUNDS: usize = 20;

/// One conversation's mutable state.
///
/// Kept separate from [`Agent`] so a single shared agent can serve many
/// independent conversations. The TypeScript server shares one message history
/// across every HTTP request, which corrupts the transcript when two requests
/// overlap.
pub struct Conversation {
    messages: Vec<Message>,
    stats: UsageStats,
}

impl Conversation {
    pub fn new(system_prompt: Option<&str>) -> Self {
        let mut messages = Vec::new();
        if let Some(prompt) = system_prompt {
            messages.push(Message::system(prompt));
        }
        Conversation {
            messages,
            stats: UsageStats::new(),
        }
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    pub fn stats(&self) -> &UsageStats {
        &self.stats
    }
}

/// Incrementally assembles an [`Agent`].
///
/// Tool registration and MCP connection happen here, so the finished `Agent` is
/// immutable apart from the active-model cell.
pub struct AgentBuilder {
    config: MicroagentConfig,
    tools: ToolRegistry,
    mcp: McpManager,
}

impl AgentBuilder {
    pub fn new(config: MicroagentConfig) -> Self {
        AgentBuilder {
            config,
            tools: ToolRegistry::new(),
            mcp: McpManager::new(),
        }
    }

    pub fn register_tool(&mut self, tool: Arc<dyn Tool>) -> &mut Self {
        self.tools.register(tool);
        self
    }

    /// Connect every configured MCP server and register its tools.
    ///
    /// Returns one entry per server that failed. A failing MCP server is not
    /// fatal — the agent runs with whatever tools it did manage to register,
    /// matching the TypeScript behaviour of logging and continuing.
    pub async fn connect_mcp_servers(&mut self) -> Vec<(String, Error)> {
        let servers: Vec<McpServerConfig> = self.config.mcp_servers.clone().unwrap_or_default();
        let mut failures = Vec::new();

        for server in servers {
            match self.mcp.connect(&server).await {
                Ok(tools) => {
                    for tool in tools {
                        self.tools.register(tool);
                    }
                }
                Err(err) => failures.push((server.name.clone(), err)),
            }
        }

        failures
    }

    pub fn build(self) -> Result<Agent> {
        let provider_configs = self.config.resolve_providers();
        if provider_configs.is_empty() {
            return Err(Error::NoProviders);
        }
        let active_config = self.config.resolve_active_provider()?;

        let mut providers: BTreeMap<String, Arc<dyn LlmProvider>> = BTreeMap::new();
        for pc in &provider_configs {
            providers.insert(pc.label().to_string(), create_provider(pc));
        }

        Ok(Agent {
            providers,
            provider_configs,
            tools: self.tools,
            mcp: self.mcp,
            active: RwLock::new(ActiveModel {
                provider: active_config.label().to_string(),
                model: active_config.model.clone(),
            }),
            system_prompt: self.config.system_prompt.clone(),
            max_tool_rounds: DEFAULT_MAX_TOOL_ROUNDS,
        })
    }
}

/// The agent: providers, tools and MCP connections, plus the active model.
///
/// Everything but the active-model cell is immutable, so an `Arc<Agent>` can be
/// shared across tasks freely.
pub struct Agent {
    providers: BTreeMap<String, Arc<dyn LlmProvider>>,
    provider_configs: Vec<ProviderConfig>,
    tools: ToolRegistry,
    mcp: McpManager,
    active: RwLock<ActiveModel>,
    system_prompt: Option<String>,
    max_tool_rounds: usize,
}

impl Agent {
    pub fn builder(config: MicroagentConfig) -> AgentBuilder {
        AgentBuilder::new(config)
    }

    pub fn tools(&self) -> &ToolRegistry {
        &self.tools
    }

    pub fn provider_configs(&self) -> &[ProviderConfig] {
        &self.provider_configs
    }

    pub fn provider_names(&self) -> Vec<String> {
        self.providers.keys().cloned().collect()
    }

    /// The currently active provider and model.
    pub fn active(&self) -> ActiveModel {
        self.active
            .read()
            .expect("active model lock poisoned")
            .clone()
    }

    pub fn system_prompt(&self) -> Option<&str> {
        self.system_prompt.as_deref()
    }

    /// Start a fresh conversation, seeded with the configured system prompt.
    pub fn new_conversation(&self) -> Conversation {
        Conversation::new(self.system_prompt.as_deref())
    }

    /// Switch the active model.
    ///
    /// Accepts `provider/model` to switch both, or a bare `model` to switch the
    /// model on the current provider.
    ///
    /// Unlike the TypeScript version, the `provider/` prefix is only honoured
    /// when it names a configured provider. That keeps model ids containing a
    /// slash — `meta-llama/Llama-3-8B`, and most Hugging Face style names —
    /// working, where `setModel` would have read `meta-llama` as a provider and
    /// failed.
    pub fn set_model(&self, spec: &str) -> Result<ActiveModel> {
        let spec = spec.trim();

        if let Some((maybe_provider, rest)) = spec.split_once('/')
            && self.providers.contains_key(maybe_provider)
            && !rest.is_empty()
        {
            let next = ActiveModel {
                provider: maybe_provider.to_string(),
                model: rest.to_string(),
            };
            *self.active.write().expect("active model lock poisoned") = next.clone();
            return Ok(next);
        }
        // Otherwise the prefix is not a configured provider, so the whole
        // string is treated as a model id and left for the provider to
        // accept or reject.

        let mut active = self.active.write().expect("active model lock poisoned");
        active.model = spec.to_string();
        Ok(active.clone())
    }

    /// List models across every configured provider.
    ///
    /// Providers that fail are skipped, matching the TypeScript `allSettled`.
    pub async fn list_all_models(&self) -> Vec<ProviderModelInfo> {
        let futures = self.providers.iter().map(|(name, provider)| async move {
            provider
                .list_models()
                .await
                .map(|models| {
                    models
                        .into_iter()
                        .map(|m| ProviderModelInfo {
                            id: m.id,
                            name: m.name,
                            created: m.created,
                            provider: name.clone(),
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        });

        join_all(futures).await.into_iter().flatten().collect()
    }

    /// Run one user turn, looping while the model keeps requesting tools.
    ///
    /// Emits [`AgentEvent::Delta`], [`AgentEvent::ToolCall`] and
    /// [`AgentEvent::ToolResult`]. `Complete` and `Error` are the caller's to
    /// emit, since only the caller knows whether the whole request succeeded —
    /// this matches how the TypeScript server sends them.
    pub async fn run(
        &self,
        conv: &mut Conversation,
        user_message: &str,
        images: &[String],
        events: Option<&EventSink>,
    ) -> Result<String> {
        conv.messages
            .push(Message::user(build_content(user_message, images)));

        for _ in 0..self.max_tool_rounds {
            let definitions = self.tools.definitions();
            let active = self.active();

            let provider =
                self.providers
                    .get(&active.provider)
                    .ok_or_else(|| Error::UnknownProvider {
                        name: active.provider.clone(),
                        available: self.provider_names().join(", "),
                    })?;

            let response = provider
                .chat(ChatRequest {
                    model: &active.model,
                    messages: &conv.messages,
                    tools: &definitions,
                    events,
                })
                .await?;

            conv.stats.record(response.usage);
            let calls = response.message.tool_calls.clone().unwrap_or_default();
            let text = response.message.text();
            conv.messages.push(response.message);

            if calls.is_empty() {
                return Ok(text);
            }

            for call in calls {
                conv.stats.record_tool_call();
                emit(
                    events,
                    AgentEvent::ToolCall {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        args: call.arguments.clone(),
                    },
                )
                .await;

                let result = self.tools.execute(&call).await;

                emit(
                    events,
                    AgentEvent::ToolResult {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        content: result.content.clone(),
                        is_error: result.is_error,
                    },
                )
                .await;

                conv.messages
                    .push(Message::tool_result(call.id, result.content));
            }
        }

        Ok("[max tool rounds reached]".to_string())
    }

    pub async fn shutdown(&self) {
        self.mcp.disconnect_all().await;
    }
}

/// Build message content, attaching images as additional parts when present.
fn build_content(text: &str, images: &[String]) -> Content {
    if images.is_empty() {
        return Content::Text(text.to_string());
    }

    let mut parts = vec![ContentPart::Text {
        text: text.to_string(),
    }];
    parts.extend(images.iter().map(|url| ContentPart::ImageUrl {
        image_url: ImageUrl { url: url.clone() },
    }));
    Content::Parts(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> MicroagentConfig {
        serde_json::from_value(serde_json::json!({
            "providers": [
                { "type": "ollama", "model": "llama3.2" },
                { "type": "openai", "model": "gpt-4o", "name": "work" }
            ],
            "systemPrompt": "be brief"
        }))
        .unwrap()
    }

    fn agent() -> Agent {
        AgentBuilder::new(config()).build().unwrap()
    }

    #[test]
    fn builds_one_provider_per_config_entry() {
        let a = agent();
        assert_eq!(
            a.provider_names(),
            vec!["ollama".to_string(), "work".to_string()]
        );
        assert_eq!(a.active().provider, "ollama");
        assert_eq!(a.active().model, "llama3.2");
    }

    #[test]
    fn a_new_conversation_is_seeded_with_the_system_prompt() {
        let conv = agent().new_conversation();
        assert_eq!(conv.messages().len(), 1);
        assert_eq!(conv.messages()[0].role, crate::types::Role::System);
        assert_eq!(conv.messages()[0].text(), "be brief");
    }

    #[test]
    fn provider_slash_model_switches_both() {
        let a = agent();
        let active = a.set_model("work/gpt-4o-mini").unwrap();
        assert_eq!(active.provider, "work");
        assert_eq!(active.model, "gpt-4o-mini");
        assert_eq!(a.active(), active);
    }

    #[test]
    fn a_bare_model_keeps_the_current_provider() {
        let a = agent();
        let active = a.set_model("qwen2.5-coder").unwrap();
        assert_eq!(active.provider, "ollama");
        assert_eq!(active.model, "qwen2.5-coder");
    }

    #[test]
    fn a_model_id_containing_a_slash_is_not_mistaken_for_a_provider() {
        // The TypeScript setModel would read "meta-llama" as a provider name
        // and throw. Here the whole string stays a model id.
        let a = agent();
        let active = a.set_model("meta-llama/Llama-3-8B").unwrap();
        assert_eq!(active.provider, "ollama");
        assert_eq!(active.model, "meta-llama/Llama-3-8B");
    }

    #[test]
    fn no_providers_fails_to_build() {
        let err = AgentBuilder::new(MicroagentConfig::default()).build();
        assert!(matches!(err, Err(Error::NoProviders)));
    }

    #[test]
    fn images_become_content_parts_alongside_the_text() {
        let content = build_content("look at this", &["data:image/png;base64,AAA".to_string()]);
        match content {
            Content::Parts(parts) => {
                assert_eq!(parts.len(), 2);
                assert!(matches!(parts[0], ContentPart::Text { .. }));
                assert!(matches!(parts[1], ContentPart::ImageUrl { .. }));
            }
            other => panic!("expected parts, got {other:?}"),
        }
    }

    #[test]
    fn no_images_yields_plain_text_content() {
        assert_eq!(
            build_content("hello", &[]),
            Content::Text("hello".to_string())
        );
    }
}
