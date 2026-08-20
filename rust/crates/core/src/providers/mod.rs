//! The LLM provider abstraction.

pub mod factory;
pub mod github_auth;
pub mod openai_compatible;

use async_trait::async_trait;

use crate::error::Result;
use crate::events::EventSink;
use crate::types::{Message, ModelInfo, TokenUsage, ToolDefinition};

pub use factory::{create_provider, list_models_for_provider};
pub use openai_compatible::{Auth, OpenAiCompatibleProvider, OpenAiProviderOptions};

/// One chat completion request.
///
/// The model travels with the request rather than living on the provider. That
/// keeps providers immutable and `Sync` with no interior mutability — see
/// `docs/RUST_PORT_PLAN.md`, decision 3.
pub struct ChatRequest<'a> {
    pub model: &'a str,
    pub messages: &'a [Message],
    pub tools: &'a [ToolDefinition],
    /// When present, the provider streams and reports
    /// [`AgentEvent::Delta`](crate::AgentEvent::Delta) as tokens arrive.
    /// Streaming is enabled exactly when this is `Some`, mirroring the
    /// TypeScript `stream: !!onDelta`.
    pub events: Option<&'a EventSink>,
}

#[derive(Debug)]
pub struct ChatResponse {
    pub message: Message,
    pub usage: TokenUsage,
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn name(&self) -> &str;

    async fn chat(&self, req: ChatRequest<'_>) -> Result<ChatResponse>;

    async fn list_models(&self) -> Result<Vec<ModelInfo>>;
}
