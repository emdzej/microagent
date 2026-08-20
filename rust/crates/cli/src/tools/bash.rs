use std::time::Duration;

use async_trait::async_trait;
use microagent_core::{JsonObject, Tool, ToolDefinition, ToolError};
use schemars::JsonSchema;
use serde::Deserialize;

use super::{tool_schema, truncate_output};

const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Args {
    /// Shell command to execute.
    command: String,
    /// Working directory (optional).
    #[serde(default)]
    cwd: Option<String>,
}

pub struct BashTool {
    definition: ToolDefinition,
}

impl BashTool {
    pub fn new() -> Self {
        BashTool {
            definition: ToolDefinition {
                name: "bash".to_string(),
                description: "Execute a bash command and return stdout/stderr".to_string(),
                input_schema: tool_schema::<Args>(),
            },
        }
    }
}

#[async_trait]
impl Tool for BashTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    /// Run a command with a 30 second timeout.
    ///
    /// Genuinely asynchronous, unlike the TypeScript `execSync`, which blocks
    /// Node's entire event loop for the duration — freezing streaming output and
    /// the TUI for up to 30 seconds on every shell command.
    ///
    /// Uses `sh -c`, matching `execSync`'s default shell, so command semantics
    /// stay identical across the two implementations despite the tool's name.
    async fn execute(&self, args: JsonObject) -> Result<String, ToolError> {
        let args: Args = serde_json::from_value(serde_json::Value::Object(args))?;

        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c").arg(&args.command);
        cmd.kill_on_drop(true);

        if let Some(cwd) = &args.cwd {
            cmd.current_dir(std::path::absolute(cwd)?);
        }

        let output = match tokio::time::timeout(TIMEOUT, cmd.output()).await {
            Ok(result) => result?,
            Err(_) => {
                return Ok(format!(
                    "EXIT ERROR\nCommand timed out after {}s: {}",
                    TIMEOUT.as_secs(),
                    args.command
                ));
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();

        // A non-zero exit is reported as a normal result, not an error, so the
        // model sees stdout and stderr and can react. This matches the
        // TypeScript tool, which returns its "EXIT ERROR" string rather than
        // throwing.
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let code = output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string());
            return Ok(truncate_output(format!(
                "EXIT ERROR (status {code})\nstdout: {stdout}\nstderr: {stderr}"
            )));
        }

        Ok(truncate_output(stdout))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: serde_json::Value) -> JsonObject {
        v.as_object().cloned().unwrap()
    }

    #[tokio::test]
    async fn captures_stdout_on_success() {
        let tool = BashTool::new();
        let out = tool
            .execute(args(serde_json::json!({ "command": "echo hello" })))
            .await
            .unwrap();
        assert_eq!(out.trim(), "hello");
    }

    #[tokio::test]
    async fn a_non_zero_exit_returns_output_rather_than_failing() {
        let tool = BashTool::new();
        let out = tool
            .execute(args(
                serde_json::json!({ "command": "echo out; echo err >&2; exit 3" }),
            ))
            .await
            .expect("a failing command must still produce a result");
        assert!(out.contains("EXIT ERROR (status 3)"), "got: {out}");
        assert!(out.contains("out"));
        assert!(out.contains("err"));
    }

    #[tokio::test]
    async fn respects_the_working_directory() {
        let tool = BashTool::new();
        let out = tool
            .execute(args(serde_json::json!({ "command": "pwd", "cwd": "/" })))
            .await
            .unwrap();
        assert_eq!(out.trim(), "/");
    }

    #[tokio::test]
    async fn unknown_arguments_are_rejected() {
        // deny_unknown_fields: a model hallucinating an extra argument gets a
        // clear error rather than having it silently ignored.
        let tool = BashTool::new();
        let err = tool
            .execute(args(
                serde_json::json!({ "command": "true", "shell": "zsh" }),
            ))
            .await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn a_missing_required_argument_is_an_error() {
        let tool = BashTool::new();
        assert!(tool.execute(args(serde_json::json!({}))).await.is_err());
    }
}
