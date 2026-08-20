//! Subcommand implementations.

pub mod ask;
pub mod chat;
pub mod config_wizard;
pub mod models;
pub mod serve;

use std::sync::Arc;

use anyhow::{Context, Result};
use microagent_core::{Agent, MicroagentConfig};

/// Build an agent with the built-in tools and any configured MCP servers.
///
/// MCP failures are reported to stderr and otherwise ignored, matching the
/// TypeScript behaviour of logging and continuing with whatever tools did
/// register.
pub async fn build_agent(config: MicroagentConfig) -> Result<Arc<Agent>> {
    let mut builder = Agent::builder(config);

    for tool in crate::tools::builtin_tools() {
        builder.register_tool(tool);
    }

    for (server, err) in builder.connect_mcp_servers().await {
        eprintln!("Failed to connect MCP server \"{server}\": {err}");
    }

    Ok(Arc::new(builder.build().context("building agent")?))
}
