use async_trait::async_trait;
use microagent_core::{JsonObject, Tool, ToolDefinition, ToolError};
use schemars::JsonSchema;
use serde::Deserialize;

use super::tool_schema;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Args {
    /// File path to write to.
    path: String,
    /// Content to write.
    content: String,
}

pub struct FileWriteTool {
    definition: ToolDefinition,
}

impl FileWriteTool {
    pub fn new() -> Self {
        FileWriteTool {
            definition: ToolDefinition {
                name: "file_write".to_string(),
                description: "Write content to a file (creates directories as needed)".to_string(),
                input_schema: tool_schema::<Args>(),
            },
        }
    }
}

#[async_trait]
impl Tool for FileWriteTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(&self, args: JsonObject) -> Result<String, ToolError> {
        let args: Args = serde_json::from_value(serde_json::Value::Object(args))?;
        let path = std::path::absolute(&args.path)?;

        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&path, &args.content).await?;

        Ok(format!(
            "Wrote {} bytes to {}",
            args.content.len(),
            path.display()
        ))
    }
}
