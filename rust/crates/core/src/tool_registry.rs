//! Tool trait and registry, mirroring `packages/core/src/tool-registry.ts`.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;

use crate::error::ToolError;
use crate::types::{JsonObject, ToolCall, ToolDefinition, ToolResult};

/// Anything the model can invoke: built-in tools and MCP tools alike.
#[async_trait]
pub trait Tool: Send + Sync {
    fn definition(&self) -> &ToolDefinition;

    /// Execute with the model-supplied arguments.
    ///
    /// Takes [`JsonObject`] rather than `Value` to match rmcp's
    /// `CallToolRequestParams::arguments`, so MCP passthrough needs no rewrap.
    async fn execute(&self, args: JsonObject) -> Result<String, ToolError>;
}

/// Central registry for all tools.
///
/// Backed by a `BTreeMap`, so iteration order is alphabetical and deterministic.
/// The TypeScript version uses a `Map` and therefore reports registration order;
/// deterministic ordering was preferred here, since it also fixes the order tools
/// are advertised to the model.
#[derive(Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        let name = tool.definition().name.clone();
        self.tools.insert(name, tool);
    }

    pub fn unregister(&mut self, name: &str) {
        self.tools.remove(name);
    }

    pub fn get(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools.get(name)
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .values()
            .map(|t| t.definition().clone())
            .collect()
    }

    pub fn list(&self) -> Vec<String> {
        self.tools.keys().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// Execute a tool call.
    ///
    /// Never returns `Err`: an unknown tool or a failing tool is captured into a
    /// [`ToolResult`] with `is_error: true`, so the model sees the failure as
    /// text and gets a chance to recover. This mirrors the TypeScript behaviour
    /// and is load-bearing for the agent loop.
    pub async fn execute(&self, call: &ToolCall) -> ToolResult {
        let Some(tool) = self.tools.get(&call.name) else {
            return ToolResult {
                tool_call_id: call.id.clone(),
                content: format!("Unknown tool: {}", call.name),
                is_error: true,
            };
        };

        match tool.execute(call.arguments.clone()).await {
            Ok(content) => ToolResult {
                tool_call_id: call.id.clone(),
                content,
                is_error: false,
            },
            Err(err) => ToolResult {
                tool_call_id: call.id.clone(),
                content: format!("Tool error: {err}"),
                is_error: true,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EchoTool {
        definition: ToolDefinition,
    }

    impl EchoTool {
        fn new() -> Self {
            EchoTool {
                definition: ToolDefinition {
                    name: "echo".to_string(),
                    description: "Echoes back the input".to_string(),
                    input_schema: serde_json::json!({
                        "type": "object",
                        "properties": { "message": { "type": "string" } },
                        "required": ["message"],
                    }),
                },
            }
        }
    }

    #[async_trait]
    impl Tool for EchoTool {
        fn definition(&self) -> &ToolDefinition {
            &self.definition
        }

        async fn execute(&self, args: JsonObject) -> Result<String, ToolError> {
            let msg = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
            Ok(format!("echo: {msg}"))
        }
    }

    struct FailingTool {
        definition: ToolDefinition,
    }

    #[async_trait]
    impl Tool for FailingTool {
        fn definition(&self) -> &ToolDefinition {
            &self.definition
        }

        async fn execute(&self, _args: JsonObject) -> Result<String, ToolError> {
            Err(crate::error::tool_error("boom"))
        }
    }

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: "test-1".to_string(),
            name: name.to_string(),
            arguments: args.as_object().cloned().unwrap_or_default(),
        }
    }

    // ── Ported from packages/core/tests/tool-registry.test.ts ──

    #[test]
    fn registers_and_lists_tools() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(EchoTool::new()));
        assert_eq!(registry.list(), vec!["echo".to_string()]);
        assert_eq!(registry.definitions().len(), 1);
        assert_eq!(registry.definitions()[0].name, "echo");
    }

    #[tokio::test]
    async fn executes_a_registered_tool() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(EchoTool::new()));
        let result = registry
            .execute(&call("echo", serde_json::json!({ "message": "hello" })))
            .await;
        assert_eq!(result.content, "echo: hello");
        assert!(!result.is_error);
    }

    #[tokio::test]
    async fn returns_error_for_unknown_tool() {
        let registry = ToolRegistry::new();
        let result = registry.execute(&call("nope", serde_json::json!({}))).await;
        assert!(result.is_error);
        assert!(result.content.contains("Unknown tool"));
    }

    #[test]
    fn unregisters_tools() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(EchoTool::new()));
        assert_eq!(registry.len(), 1);
        registry.unregister("echo");
        assert!(registry.is_empty());
    }

    // ── Additional coverage ──

    #[tokio::test]
    async fn a_failing_tool_becomes_an_error_result_not_an_err() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(FailingTool {
            definition: ToolDefinition {
                name: "fail".to_string(),
                description: String::new(),
                input_schema: serde_json::json!({ "type": "object" }),
            },
        }));
        let result = registry.execute(&call("fail", serde_json::json!({}))).await;
        assert!(result.is_error);
        assert_eq!(result.content, "Tool error: boom");
        assert_eq!(result.tool_call_id, "test-1");
    }

    #[test]
    fn re_registering_a_name_replaces_the_tool() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(EchoTool::new()));
        registry.register(Arc::new(EchoTool::new()));
        assert_eq!(registry.len(), 1);
    }
}
