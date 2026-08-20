use std::fmt;

/// Errors produced by the core crate.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// A provider returned a non-success HTTP status.
    #[error("{provider} error: {status} {body}")]
    Provider {
        provider: String,
        status: u16,
        body: String,
    },

    #[error("no providers configured")]
    NoProviders,

    #[error("unknown provider: {name}. Available: {available}")]
    UnknownProvider { name: String, available: String },

    #[error("config error: {0}")]
    Config(String),

    #[error("mcp error: {0}")]
    Mcp(String),

    #[error("auth error: {0}")]
    Auth(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Error type surfaced by [`crate::Tool`] implementations.
///
/// Boxed so tool authors can use `?` with any error type. Tool failures never
/// abort the agent loop — they are captured into a
/// [`ToolResult`](crate::ToolResult) with `is_error: true` so the model sees
/// them as text and can recover.
pub type ToolError = Box<dyn std::error::Error + Send + Sync>;

/// Convenience for tools that just need to fail with a message.
#[derive(Debug)]
pub struct Message(pub String);

impl fmt::Display for Message {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Message {}

/// Build a [`ToolError`] from anything displayable.
pub fn tool_error(msg: impl fmt::Display) -> ToolError {
    Box::new(Message(msg.to_string()))
}
