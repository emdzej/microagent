//! End-to-end tests for the provider's HTTP and SSE paths.
//!
//! These drive a real socket rather than mocking the transport, so they cover
//! `reqwest` → `eventsource-stream` → `SseAccumulator` as one piece. A canned
//! server is used instead of a live model so the tests are hermetic and fast;
//! `agent_loop_against_ollama` is the opt-in test that talks to a real one.

use std::sync::Arc;

use microagent_core::{
    Agent, AgentEvent, ChatRequest, JsonObject, LlmProvider, Message, MicroagentConfig,
    OpenAiCompatibleProvider, OpenAiProviderOptions, StreamDelta, Tool, ToolDefinition, ToolError,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Serve one HTTP request with the given body, then shut down.
///
/// Returns the base URL to point a provider at.
async fn serve_once(content_type: &'static str, body: String) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();

        // Read the request head so the client is not writing into a closed pipe.
        let mut buf = vec![0u8; 8192];
        let _ = socket.read(&mut buf).await;

        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.flush().await;
    });

    format!("http://{addr}")
}

fn provider(base_url: String) -> OpenAiCompatibleProvider {
    OpenAiCompatibleProvider::new(OpenAiProviderOptions {
        name: "test".to_string(),
        base_url,
        auth: microagent_core::Auth::None,
        headers: Vec::new(),
    })
}

fn sse(chunks: &[serde_json::Value]) -> String {
    let mut out = String::new();
    for c in chunks {
        out.push_str(&format!("data: {c}\n\n"));
    }
    out.push_str("data: [DONE]\n\n");
    out
}

#[tokio::test]
async fn streams_text_deltas_over_a_real_socket() {
    let body = sse(&[
        serde_json::json!({ "choices": [{ "delta": { "content": "Hello" } }] }),
        serde_json::json!({ "choices": [{ "delta": { "content": ", world" } }] }),
        serde_json::json!({
            "choices": [],
            "usage": { "prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8 }
        }),
    ]);
    let url = serve_once("text/event-stream", body).await;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<AgentEvent>(64);
    let collector = tokio::spawn(async move {
        let mut texts = Vec::new();
        let mut saw_done = false;
        while let Some(ev) = rx.recv().await {
            match ev {
                AgentEvent::Delta(StreamDelta::Text { text }) => texts.push(text),
                AgentEvent::Delta(StreamDelta::Done) => saw_done = true,
                _ => {}
            }
        }
        (texts, saw_done)
    });

    let messages = vec![Message::user("hi")];
    let response = provider(url)
        .chat(ChatRequest {
            model: "test-model",
            messages: &messages,
            tools: &[],
            events: Some(&tx),
        })
        .await
        .expect("chat should succeed");
    drop(tx);

    let (texts, saw_done) = collector.await.unwrap();
    assert_eq!(texts, vec!["Hello".to_string(), ", world".to_string()]);
    assert!(saw_done, "a Done delta must terminate the stream");
    assert_eq!(response.message.text(), "Hello, world");
    assert_eq!(response.usage.total_tokens, 8);
}

#[tokio::test]
async fn streams_a_tool_call_split_across_chunks() {
    let body = sse(&[
        serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{
            "index": 0, "id": "call_1", "function": { "name": "file_read", "arguments": "" }
        }] } }] }),
        serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{
            "index": 0, "function": { "arguments": "{\"path\":" }
        }] } }] }),
        serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{
            "index": 0, "function": { "arguments": "\"/etc/hosts\"}" }
        }] } }] }),
    ]);
    let url = serve_once("text/event-stream", body).await;

    // A sink must be supplied: streaming is enabled exactly when `events` is
    // `Some`, so passing `None` here would request a non-streaming completion and
    // then fail to parse the canned SSE body as JSON.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<AgentEvent>(64);
    let collector = tokio::spawn(async move {
        let mut starts = 0;
        let mut ends = 0;
        while let Some(ev) = rx.recv().await {
            match ev {
                AgentEvent::Delta(StreamDelta::ToolCallStart { .. }) => starts += 1,
                AgentEvent::Delta(StreamDelta::ToolCallEnd { .. }) => ends += 1,
                _ => {}
            }
        }
        (starts, ends)
    });

    let messages = vec![Message::user("read it")];
    let response = provider(url)
        .chat(ChatRequest {
            model: "test-model",
            messages: &messages,
            tools: &[],
            events: Some(&tx),
        })
        .await
        .expect("chat should succeed");
    drop(tx);

    let (starts, ends) = collector.await.unwrap();
    assert_eq!(starts, 1, "one ToolCallStart expected");
    assert_eq!(ends, 1, "one ToolCallEnd expected");

    let calls = response.message.tool_calls.unwrap_or_default();
    assert_eq!(calls.len(), 1, "expected exactly one tool call");
    assert_eq!(calls[0].name, "file_read");
    assert_eq!(calls[0].arguments["path"], serde_json::json!("/etc/hosts"));
}

#[tokio::test]
async fn non_streaming_response_is_parsed() {
    let body = serde_json::json!({
        "choices": [{ "message": { "role": "assistant", "content": "plain answer" } }],
        "usage": { "prompt_tokens": 2, "completion_tokens": 2, "total_tokens": 4 }
    })
    .to_string();
    let url = serve_once("application/json", body).await;

    let messages = vec![Message::user("hi")];
    let response = provider(url)
        .chat(ChatRequest {
            model: "test-model",
            messages: &messages,
            tools: &[],
            events: None,
        })
        .await
        .unwrap();

    assert_eq!(response.message.text(), "plain answer");
    assert_eq!(response.usage.total_tokens, 4);
}

#[tokio::test]
async fn list_models_sorts_by_id() {
    let body = serde_json::json!({
        "data": [
            { "id": "zephyr", "created": 3 },
            { "id": "alpaca", "created": 1 },
            { "id": "mistral", "created": 2 }
        ]
    })
    .to_string();
    let url = serve_once("application/json", body).await;

    let models = provider(url).list_models().await.unwrap();
    let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["alpaca", "mistral", "zephyr"]);
}

/// Regression test for a live-server shape, not a hypothetical one.
///
/// Ollama with nothing pulled answers `/v1/models` with
/// `{"object":"list","data":null}` — an explicit null, not an absent field.
/// `#[serde(default)]` does not cover that, so this decoded as an error until
/// the `null_to_default` helper was added.
#[tokio::test]
async fn an_explicit_null_model_list_is_treated_as_empty() {
    let url = serve_once(
        "application/json",
        r#"{"object":"list","data":null}"#.to_string(),
    )
    .await;
    let models = provider(url)
        .list_models()
        .await
        .expect("null data is valid");
    assert!(models.is_empty());
}

#[tokio::test]
async fn null_choices_and_usage_do_not_fail_a_completion() {
    let url = serve_once(
        "application/json",
        r#"{"choices":null,"usage":null}"#.to_string(),
    )
    .await;
    let messages = vec![Message::user("hi")];
    let response = provider(url)
        .chat(ChatRequest {
            model: "m",
            messages: &messages,
            tools: &[],
            events: None,
        })
        .await
        .expect("null collections are valid");
    assert_eq!(response.message.text(), "");
    assert_eq!(response.usage.total_tokens, 0);
}

// ── Full agent loop, with a tool round-trip ──

struct CannedTool {
    definition: ToolDefinition,
}

#[async_trait::async_trait]
impl Tool for CannedTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(&self, args: JsonObject) -> Result<String, ToolError> {
        Ok(format!("read {}", args["path"].as_str().unwrap_or("?")))
    }
}

/// The agent must execute the requested tool, append a `tool` message, and loop.
///
/// Two sequential responses are needed, so this serves a small scripted server
/// rather than `serve_once`.
#[tokio::test]
async fn agent_executes_a_tool_then_returns_the_final_answer() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    // First response asks for a tool; second gives the final answer.
    let bodies = vec![
        sse(&[
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{
            "index": 0, "id": "call_1",
            "function": { "name": "file_read", "arguments": "{\"path\":\"/etc/hosts\"}" }
        }] } }] }),
        ]),
        sse(&[serde_json::json!({ "choices": [{ "delta": { "content": "done reading" } }] })]),
    ];

    tokio::spawn(async move {
        for body in bodies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 16384];
            let _ = socket.read(&mut buf).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
        }
    });

    let config: MicroagentConfig = serde_json::from_value(serde_json::json!({
        "providers": [{ "type": "custom", "model": "test-model", "baseUrl": format!("http://{addr}") }],
        "systemPrompt": "be brief"
    }))
    .unwrap();

    let mut builder = Agent::builder(config);
    builder.register_tool(Arc::new(CannedTool {
        definition: ToolDefinition {
            name: "file_read".to_string(),
            description: "read a file".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        },
    }));
    let agent = builder.build().unwrap();
    let mut conversation = agent.new_conversation();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<AgentEvent>(64);
    let collector = tokio::spawn(async move {
        let mut names = Vec::new();
        let mut results = Vec::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                AgentEvent::ToolCall { name, id, .. } => names.push((name, id)),
                AgentEvent::ToolResult {
                    content, is_error, ..
                } => results.push((content, is_error)),
                _ => {}
            }
        }
        (names, results)
    });

    let answer = agent
        .run(&mut conversation, "read /etc/hosts", &[], Some(&tx))
        .await
        .expect("the turn should succeed");
    drop(tx);

    let (names, results) = collector.await.unwrap();
    assert_eq!(answer, "done reading");
    assert_eq!(names, vec![("file_read".to_string(), "call_1".to_string())]);
    assert_eq!(results, vec![("read /etc/hosts".to_string(), false)]);

    // system, user, assistant(tool_calls), tool, assistant
    let messages = conversation.messages();
    assert_eq!(messages.len(), 5, "got {messages:#?}");
    assert_eq!(messages[3].role, microagent_core::Role::Tool);
    assert_eq!(messages[3].tool_call_id.as_deref(), Some("call_1"));
    assert_eq!(messages[3].text(), "read /etc/hosts");

    // Two requests, one tool call.
    let stats = conversation.stats().summary();
    assert_eq!(stats.requests, 2);
    assert_eq!(stats.tool_calls, 1);
}

#[tokio::test]
async fn a_provider_error_status_surfaces_the_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 8192];
        let _ = socket.read(&mut buf).await;
        let body = r#"{"error":{"message":"model not found"}}"#;
        let response = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
    });

    let messages = vec![Message::user("hi")];
    let err = provider(format!("http://{addr}"))
        .chat(ChatRequest {
            model: "nope",
            messages: &messages,
            tools: &[],
            events: None,
        })
        .await
        .expect_err("a 404 must be an error");

    let text = err.to_string();
    assert!(text.contains("404"), "got: {text}");
    assert!(text.contains("model not found"), "got: {text}");
}

/// Opt-in test against a real Ollama. Run with:
/// `cargo test -p microagent-core -- --ignored`
///
/// Requires `ollama serve` and a tool-capable model, e.g. `ollama pull llama3.2`.
#[tokio::test]
#[ignore = "requires a running Ollama with a tool-capable model pulled"]
async fn agent_loop_against_ollama() {
    let config: MicroagentConfig = serde_json::from_value(serde_json::json!({
        "providers": [{ "type": "ollama", "model": "llama3.2" }],
        "systemPrompt": "You are terse. Use tools when asked."
    }))
    .unwrap();

    let agent = Agent::builder(config).build().unwrap();
    let mut conversation = agent.new_conversation();

    let answer = agent
        .run(&mut conversation, "Say exactly: pong", &[], None)
        .await
        .expect("a live turn should succeed");

    assert!(!answer.is_empty(), "the model returned nothing");
    assert!(conversation.stats().summary().requests >= 1);
}
