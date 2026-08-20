//! Core of microagent: message types, the agent loop, the provider abstraction,
//! the tool registry and the MCP client.
//!
//! This is a Rust port of `@microagent/core`. Where it deviates from the
//! TypeScript implementation, the deviation is documented in
//! `docs/RUST_PORT_PLAN.md`.

pub mod agent;
pub mod error;
pub mod events;
pub mod mcp;
pub mod paths;
pub mod providers;
pub mod stats;
pub mod tool_registry;
pub mod types;

pub use agent::{Agent, AgentBuilder, Conversation};
pub use error::{Error, Result, ToolError, tool_error};
pub use events::{AgentEvent, EventSink};
pub use mcp::McpManager;
pub use providers::{
    Auth, ChatRequest, ChatResponse, LlmProvider, OpenAiCompatibleProvider, OpenAiProviderOptions,
    create_provider, list_models_for_provider,
};
pub use stats::{StatsSummary, UsageStats};
pub use tool_registry::{Tool, ToolRegistry};
pub use types::{
    ActiveModel, Content, ContentPart, ImageUrl, JsonObject, McpServerConfig, McpTransport,
    Message, MicroagentConfig, ModelInfo, ProviderConfig, ProviderModelInfo, Role, StreamDelta,
    TokenUsage, ToolCall, ToolDefinition, ToolResult,
};
