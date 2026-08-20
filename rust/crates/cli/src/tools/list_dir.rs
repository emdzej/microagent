use async_trait::async_trait;
use microagent_core::{JsonObject, Tool, ToolDefinition, ToolError};
use schemars::JsonSchema;
use serde::Deserialize;

use super::{tool_schema, truncate_output};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Args {
    /// Directory path.
    path: String,
}

pub struct ListDirectoryTool {
    definition: ToolDefinition,
}

impl ListDirectoryTool {
    pub fn new() -> Self {
        ListDirectoryTool {
            definition: ToolDefinition {
                name: "list_directory".to_string(),
                description: "List files and directories at a given path".to_string(),
                input_schema: tool_schema::<Args>(),
            },
        }
    }
}

#[async_trait]
impl Tool for ListDirectoryTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(&self, args: JsonObject) -> Result<String, ToolError> {
        let args: Args = serde_json::from_value(serde_json::Value::Object(args))?;
        let path = std::path::absolute(&args.path)?;

        let mut entries = tokio::fs::read_dir(&path).await?;
        let mut lines = Vec::new();

        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            // `file_type` avoids a second stat on most platforms, and does not
            // follow symlinks — a dangling link is listed rather than erroring,
            // where the TypeScript `statSync` would throw and fail the whole
            // listing.
            let kind = match entry.file_type().await {
                Ok(ft) if ft.is_dir() => "d",
                Ok(_) => "f",
                Err(_) => "?",
            };
            lines.push(format!("{kind} {name}"));
        }

        // Sorted for determinism; `readdir` order is filesystem-dependent.
        lines.sort();
        Ok(truncate_output(lines.join("\n")))
    }
}
