//! Agent events.
//!
//! Replaces the TypeScript `AgentEvents` interface — four optional closures —
//! with one enum sent over an `mpsc` channel. See `docs/RUST_PORT_PLAN.md`,
//! decision 4.
//!
//! The variants map 1:1 onto the SSE event names the server emits, so
//! `/chat/stream` becomes a `map` over this channel rather than a set of
//! callbacks.

use serde::Serialize;
use tokio::sync::mpsc;

use crate::stats::StatsSummary;
use crate::types::{JsonObject, StreamDelta};

/// One observable event from a running turn.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentEvent {
    /// An incremental update from the provider.
    Delta(StreamDelta),
    /// A tool is about to be executed.
    ///
    /// `id` is carried so results can be matched to their call, rather than by
    /// name as in `[...toolCalls].reverse().find(t => t.name === name)`.
    ///
    /// Name matching is not actively wrong while tool calls are executed strictly
    /// sequentially — the newest call with a given name is then always the right
    /// one. It is latent: it breaks silently the moment calls run in parallel or
    /// results arrive out of order.
    ToolCall {
        id: String,
        name: String,
        args: JsonObject,
    },
    /// A tool finished.
    ToolResult {
        id: String,
        name: String,
        content: String,
        is_error: bool,
    },
    /// The turn completed successfully.
    Complete {
        response: String,
        stats: StatsSummary,
    },
    /// The turn failed.
    Error { error: String },
}

impl AgentEvent {
    /// The SSE event name, matching the TypeScript server's
    /// `send("delta" | "tool_call" | "tool_result" | "complete" | "error", …)`.
    pub fn name(&self) -> &'static str {
        match self {
            AgentEvent::Delta(_) => "delta",
            AgentEvent::ToolCall { .. } => "tool_call",
            AgentEvent::ToolResult { .. } => "tool_result",
            AgentEvent::Complete { .. } => "complete",
            AgentEvent::Error { .. } => "error",
        }
    }

    /// The SSE `data:` payload for this event.
    ///
    /// Written out explicitly rather than derived, because the wire format is a
    /// contract with `packages/web/src/lib/api.ts` and must match the TypeScript
    /// server byte for byte. A derived tagged representation would wrap the
    /// payload in an envelope the web UI does not expect.
    ///
    /// `id` on the tool events is additive — the web UI ignores unknown fields,
    /// so carrying it costs nothing and enables correct call/result pairing.
    pub fn payload(&self) -> serde_json::Value {
        match self {
            AgentEvent::Delta(delta) => serde_json::to_value(delta).unwrap_or_default(),
            AgentEvent::ToolCall { id, name, args } => serde_json::json!({
                "id": id,
                "name": name,
                "args": args,
            }),
            AgentEvent::ToolResult {
                id,
                name,
                content,
                is_error,
            } => serde_json::json!({
                "id": id,
                "name": name,
                "content": content,
                "isError": is_error,
            }),
            AgentEvent::Complete { response, stats } => serde_json::json!({
                "response": response,
                "stats": stats,
            }),
            AgentEvent::Error { error } => serde_json::json!({ "error": error }),
        }
    }
}

/// Channel an agent turn reports progress on.
pub type EventSink = mpsc::Sender<AgentEvent>;

/// Send an event, ignoring a closed receiver.
///
/// A dropped receiver means the consumer stopped listening (client disconnected,
/// TUI exited). That is not a reason to abort the turn.
pub(crate) async fn emit(sink: Option<&EventSink>, event: AgentEvent) {
    if let Some(tx) = sink {
        let _ = tx.send(event).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delta_payload_matches_the_web_ui_contract() {
        let ev = AgentEvent::Delta(StreamDelta::Text {
            text: "hi".to_string(),
        });
        assert_eq!(ev.name(), "delta");
        // api.ts: `if (data.type === "text" && data.text) callbacks.onText(...)`
        assert_eq!(
            ev.payload(),
            serde_json::json!({ "type": "text", "text": "hi" })
        );
    }

    #[test]
    fn tool_result_payload_uses_camel_case_is_error() {
        let ev = AgentEvent::ToolResult {
            id: "call_1".to_string(),
            name: "bash".to_string(),
            content: "out".to_string(),
            is_error: true,
        };
        assert_eq!(ev.name(), "tool_result");
        // api.ts reads data.name, data.content, data.isError
        let p = ev.payload();
        assert_eq!(p["isError"], serde_json::json!(true));
        assert_eq!(p["name"], serde_json::json!("bash"));
        assert_eq!(p["content"], serde_json::json!("out"));
    }

    #[test]
    fn error_payload_is_a_bare_error_field() {
        let ev = AgentEvent::Error {
            error: "nope".to_string(),
        };
        assert_eq!(ev.name(), "error");
        assert_eq!(ev.payload(), serde_json::json!({ "error": "nope" }));
    }
}
