//! MCP client, porting `packages/core/src/mcp.ts`.
//!
//! Each connected server's tools are wrapped as [`Tool`] implementations and
//! registered alongside the built-ins, so the agent loop cannot tell them apart.

use std::sync::Arc;

use async_trait::async_trait;
use rmcp::ServiceExt;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::service::{Peer, RoleClient, RunningService};
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use tokio::sync::Mutex;

use crate::error::{Error, Result, ToolError, tool_error};
use crate::tool_registry::Tool;
use crate::types::{JsonObject, McpServerConfig, McpTransport, ToolDefinition};

/// Separator between the server name and the tool name.
///
/// Tools are namespaced so two servers exposing `read_file` do not collide.
const NAME_SEPARATOR: &str = "__";

/// Manages connections to MCP servers and exposes their tools.
#[derive(Default)]
pub struct McpManager {
    /// Live services, held so the connections (and child processes) stay alive
    /// for as long as the manager does.
    services: Mutex<Vec<RunningService<RoleClient, ()>>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Connect to one MCP server and return its tools as registrable plugins.
    pub async fn connect(&mut self, config: &McpServerConfig) -> Result<Vec<Arc<dyn Tool>>> {
        let service = match config.transport {
            McpTransport::Stdio => {
                let command = config.command.as_deref().ok_or_else(|| {
                    Error::Mcp(format!(
                        "MCP server \"{}\": stdio requires command",
                        config.name
                    ))
                })?;

                let mut cmd = tokio::process::Command::new(command);
                if let Some(args) = &config.args {
                    cmd.args(args);
                }

                let transport = TokioChildProcess::new(cmd)
                    .map_err(|e| Error::Mcp(format!("MCP server \"{}\": {e}", config.name)))?;

                ().serve(transport)
                    .await
                    .map_err(|e| Error::Mcp(format!("MCP server \"{}\": {e}", config.name)))?
            }

            McpTransport::Http => {
                let url = config.url.as_deref().ok_or_else(|| {
                    Error::Mcp(format!("MCP server \"{}\": http requires url", config.name))
                })?;

                let transport = StreamableHttpClientTransport::from_uri(url.to_string());

                ().serve(transport)
                    .await
                    .map_err(|e| Error::Mcp(format!("MCP server \"{}\": {e}", config.name)))?
            }
        };

        let tools = service
            .list_all_tools()
            .await
            .map_err(|e| Error::Mcp(format!("MCP server \"{}\": {e}", config.name)))?;

        // `Peer` is cheap to clone, so each tool gets its own handle while the
        // manager keeps the service alive.
        let peer = service.peer().clone();

        let plugins: Vec<Arc<dyn Tool>> = tools
            .into_iter()
            .map(|tool| {
                let remote_name = tool.name.to_string();
                Arc::new(McpTool {
                    definition: ToolDefinition {
                        name: format!("{}{NAME_SEPARATOR}{remote_name}", config.name),
                        description: tool.description.map(|d| d.to_string()).unwrap_or_default(),
                        input_schema: serde_json::Value::Object((*tool.input_schema).clone()),
                    },
                    remote_name,
                    peer: peer.clone(),
                }) as Arc<dyn Tool>
            })
            .collect();

        self.services.lock().await.push(service);
        Ok(plugins)
    }

    pub async fn disconnect_all(&self) {
        let services: Vec<_> = self.services.lock().await.drain(..).collect();
        for service in services {
            // Best-effort: the process is exiting either way.
            let _ = service.cancel().await;
        }
    }
}

/// One tool exposed by a connected MCP server.
struct McpTool {
    definition: ToolDefinition,
    /// The tool's name on the server, without the namespace prefix.
    remote_name: String,
    peer: Peer<RoleClient>,
}

#[async_trait]
impl Tool for McpTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(&self, args: JsonObject) -> std::result::Result<String, ToolError> {
        // No conversion needed: `Tool::execute` takes `JsonObject` precisely so
        // this passes straight through to rmcp.
        let params = CallToolRequestParams::new(self.remote_name.clone()).with_arguments(args);

        let result = self
            .peer
            .call_tool(params)
            .await
            .map_err(|e| tool_error(e.to_string()))?;

        let text = join_text(&result);

        // A tool-level failure is reported as an error so the registry marks the
        // result `is_error` and the model sees it as text it can react to.
        if result.is_error.unwrap_or(false) {
            return Err(tool_error(text));
        }

        Ok(text)
    }
}

/// Concatenate the text parts of a tool result, ignoring non-text content.
///
/// Images and embedded resources are dropped, matching the TypeScript version.
/// Note that rmcp 3.x also exposes task metadata (SEP-1319) for long-running
/// tool calls, which is ignored here for parity; supporting it is the natural
/// next step.
fn join_text(result: &CallToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(transport: McpTransport) -> McpServerConfig {
        McpServerConfig {
            name: "fs".to_string(),
            transport,
            command: None,
            args: None,
            url: None,
        }
    }

    #[tokio::test]
    async fn stdio_without_a_command_is_rejected() {
        let mut manager = McpManager::new();
        let err = manager.connect(&config(McpTransport::Stdio)).await;
        assert!(matches!(err, Err(Error::Mcp(msg)) if msg.contains("stdio requires command")));
    }

    #[tokio::test]
    async fn http_without_a_url_is_rejected() {
        let mut manager = McpManager::new();
        let err = manager.connect(&config(McpTransport::Http)).await;
        assert!(matches!(err, Err(Error::Mcp(msg)) if msg.contains("http requires url")));
    }

    #[tokio::test]
    async fn connecting_to_a_nonexistent_command_fails_without_panicking() {
        let mut manager = McpManager::new();
        let mut cfg = config(McpTransport::Stdio);
        cfg.command = Some("definitely-not-a-real-binary-xyz".to_string());
        assert!(manager.connect(&cfg).await.is_err());
    }

    #[test]
    fn tool_names_are_namespaced_by_server() {
        // The registry sees `<server>__<tool>` while the server is called with the
        // bare name, so two servers exposing the same tool cannot collide.
        assert_eq!(format!("fs{NAME_SEPARATOR}read_file"), "fs__read_file");
    }
}
