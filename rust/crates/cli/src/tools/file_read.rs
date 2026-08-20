use async_trait::async_trait;
use microagent_core::{JsonObject, Tool, ToolDefinition, ToolError};
use schemars::JsonSchema;
use serde::Deserialize;

use super::{tool_schema, truncate_output};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Args {
    /// Absolute or relative file path.
    path: String,
}

pub struct FileReadTool {
    definition: ToolDefinition,
}

impl FileReadTool {
    pub fn new() -> Self {
        FileReadTool {
            definition: ToolDefinition {
                name: "file_read".to_string(),
                description: "Read the contents of a file at the given path".to_string(),
                input_schema: tool_schema::<Args>(),
            },
        }
    }
}

#[async_trait]
impl Tool for FileReadTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(&self, args: JsonObject) -> Result<String, ToolError> {
        let args: Args = serde_json::from_value(serde_json::Value::Object(args))?;
        let path = std::path::absolute(&args.path)?;
        let content = tokio::fs::read_to_string(&path).await?;
        Ok(truncate_output(content))
    }
}
