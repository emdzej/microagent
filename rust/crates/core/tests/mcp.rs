//! MCP client tests against a real stdio server.
//!
//! The server is the dependency-free Python fixture in `tests/fixtures/`, so
//! these run anywhere Python 3 is available without touching the network.

use microagent_core::{McpManager, McpServerConfig, McpTransport, ToolCall, ToolRegistry};

fn fixture_config() -> McpServerConfig {
    let script = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/mcp_echo_server.py"
    );
    McpServerConfig {
        name: "fixture".to_string(),
        transport: McpTransport::Stdio,
        command: Some("python3".to_string()),
        args: Some(vec![script.to_string()]),
        url: None,
    }
}

fn call(name: &str, args: serde_json::Value) -> ToolCall {
    ToolCall {
        id: "call_1".to_string(),
        name: name.to_string(),
        arguments: args.as_object().cloned().unwrap_or_default(),
    }
}

#[tokio::test]
async fn connects_over_stdio_and_discovers_namespaced_tools() {
    let mut manager = McpManager::new();
    let tools = manager
        .connect(&fixture_config())
        .await
        .expect("connecting to the fixture server should succeed");

    let mut names: Vec<_> = tools.iter().map(|t| t.definition().name.clone()).collect();
    names.sort();
    assert_eq!(names, vec!["fixture__echo", "fixture__explode"]);

    let echo = tools
        .iter()
        .find(|t| t.definition().name == "fixture__echo")
        .unwrap();
    assert_eq!(
        echo.definition().description,
        "Echoes back the message it is given"
    );
    // The server's inputSchema is carried through verbatim.
    assert_eq!(echo.definition().input_schema["type"], "object");
    assert_eq!(
        echo.definition().input_schema["properties"]["message"]["type"],
        "string"
    );

    manager.disconnect_all().await;
}

#[tokio::test]
async fn executes_an_mcp_tool_end_to_end() {
    let mut manager = McpManager::new();
    let tools = manager.connect(&fixture_config()).await.unwrap();

    // Register into a real registry, so this covers the path the agent loop uses.
    let mut registry = ToolRegistry::new();
    for tool in tools {
        registry.register(tool);
    }

    let result = registry
        .execute(&call(
            "fixture__echo",
            serde_json::json!({ "message": "hello mcp" }),
        ))
        .await;

    assert!(!result.is_error, "got: {}", result.content);
    assert_eq!(result.content, "echo: hello mcp");
    assert_eq!(result.tool_call_id, "call_1");

    manager.disconnect_all().await;
}

/// A tool-level failure (`isError: true`) must surface as an error result, not as
/// a successful call, so the model can tell the difference.
#[tokio::test]
async fn a_tool_level_error_is_reported_as_an_error_result() {
    let mut manager = McpManager::new();
    let tools = manager.connect(&fixture_config()).await.unwrap();

    let mut registry = ToolRegistry::new();
    for tool in tools {
        registry.register(tool);
    }

    let result = registry
        .execute(&call("fixture__explode", serde_json::json!({})))
        .await;

    assert!(result.is_error, "isError from the server must propagate");
    assert!(
        result.content.contains("deliberate failure"),
        "the server's message should reach the model: {}",
        result.content
    );

    manager.disconnect_all().await;
}

/// Two servers exposing the same tool name must not collide in the registry.
#[tokio::test]
async fn two_servers_with_identical_tool_names_stay_distinct() {
    let mut manager = McpManager::new();

    let mut first = fixture_config();
    first.name = "alpha".to_string();
    let mut second = fixture_config();
    second.name = "beta".to_string();

    let mut registry = ToolRegistry::new();
    for tool in manager.connect(&first).await.unwrap() {
        registry.register(tool);
    }
    for tool in manager.connect(&second).await.unwrap() {
        registry.register(tool);
    }

    assert_eq!(registry.len(), 4, "got {:?}", registry.list());

    // Each namespaced name still reaches its own server with the bare tool name.
    for prefix in ["alpha", "beta"] {
        let result = registry
            .execute(&call(
                &format!("{prefix}__echo"),
                serde_json::json!({ "message": prefix }),
            ))
            .await;
        assert_eq!(result.content, format!("echo: {prefix}"));
    }

    manager.disconnect_all().await;
}

#[tokio::test]
async fn disconnect_all_is_idempotent() {
    let mut manager = McpManager::new();
    manager.connect(&fixture_config()).await.unwrap();
    manager.disconnect_all().await;
    // A second call must not panic or hang on an already-drained list.
    manager.disconnect_all().await;
}
