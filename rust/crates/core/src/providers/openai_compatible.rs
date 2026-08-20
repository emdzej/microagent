//! Unified provider for any OpenAI-compatible chat completions API.
//!
//! Ports `packages/core/src/providers/openai-compatible.ts`. Works with OpenAI,
//! GitHub Copilot, Ollama (`/v1`), Azure OpenAI, Together, Groq, LM Studio,
//! vLLM and anything else speaking the same protocol.

use std::collections::BTreeMap;

use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::Deserialize;

use crate::error::{Error, Result};
use crate::events::{AgentEvent, emit};
use crate::providers::{ChatRequest, ChatResponse, LlmProvider};
use crate::types::{
    Content, JsonObject, Message, ModelInfo, Role, StreamDelta, TokenUsage, ToolCall,
};

/// How a provider authenticates.
///
/// An enum rather than the TypeScript `getApiKey?: () => Promise<string>`
/// closure: there are exactly two cases, and closures returning futures inside a
/// `Sync` provider get unpleasant fast.
#[derive(Debug, Clone)]
pub enum Auth {
    None,
    /// A fixed bearer token.
    Static(String),
    /// A GitHub Copilot session token, resolved and refreshed per request.
    Copilot,
}

impl Auth {
    /// Resolve to a bearer token, if any.
    async fn bearer(&self) -> Result<Option<String>> {
        match self {
            Auth::None => Ok(None),
            Auth::Static(token) => Ok(Some(token.clone())),
            Auth::Copilot => crate::providers::factory::copilot_bearer().await.map(Some),
        }
    }
}

pub struct OpenAiProviderOptions {
    /// Display name for this provider.
    pub name: String,
    /// Base URL, without the `/chat/completions` suffix.
    pub base_url: String,
    pub auth: Auth,
    /// Extra headers sent with every request.
    pub headers: Vec<(String, String)>,
}

pub struct OpenAiCompatibleProvider {
    name: String,
    base_url: String,
    auth: Auth,
    headers: Vec<(String, String)>,
    client: reqwest::Client,
}

impl OpenAiCompatibleProvider {
    pub fn new(opts: OpenAiProviderOptions) -> Self {
        OpenAiCompatibleProvider {
            name: opts.name,
            // Normalise: strip trailing slashes.
            base_url: opts.base_url.trim_end_matches('/').to_string(),
            auth: opts.auth,
            headers: opts.headers,
            client: reqwest::Client::new(),
        }
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
    ) -> Result<reqwest::RequestBuilder> {
        let mut req = self
            .client
            .request(method, format!("{}{}", self.base_url, path));
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }
        if let Some(token) = self.auth.bearer().await? {
            req = req.bearer_auth(token);
        }
        Ok(req)
    }

    async fn provider_error(&self, res: reqwest::Response) -> Error {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        Error::Provider {
            provider: self.name.clone(),
            status,
            body,
        }
    }

    /// Convert internal messages into the OpenAI request shape.
    fn to_openai_messages(messages: &[Message]) -> Vec<serde_json::Value> {
        messages
            .iter()
            .map(|m| match m.role {
                Role::Tool => serde_json::json!({
                    "role": "tool",
                    "content": m.content.text(),
                    "tool_call_id": m.tool_call_id,
                }),
                Role::Assistant if m.tool_calls.is_some() => {
                    let calls: Vec<_> = m
                        .tool_calls
                        .iter()
                        .flatten()
                        .map(|tc| {
                            serde_json::json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": serde_json::Value::Object(tc.arguments.clone())
                                        .to_string(),
                                },
                            })
                        })
                        .collect();
                    // The API distinguishes an empty string from null here, so
                    // an empty assistant turn must serialise as null.
                    let content = match &m.content {
                        Content::Text(s) if s.is_empty() => serde_json::Value::Null,
                        other => serde_json::to_value(other).unwrap_or(serde_json::Value::Null),
                    };
                    serde_json::json!({
                        "role": "assistant",
                        "content": content,
                        "tool_calls": calls,
                    })
                }
                // Content arrays (multimodal) pass through unchanged.
                _ => serde_json::json!({ "role": m.role, "content": m.content }),
            })
            .collect()
    }

    fn tools_payload(tools: &[crate::types::ToolDefinition]) -> Vec<serde_json::Value> {
        tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    },
                })
            })
            .collect()
    }

    async fn handle_sse(
        &self,
        res: reqwest::Response,
        events: Option<&crate::events::EventSink>,
    ) -> Result<ChatResponse> {
        let mut acc = SseAccumulator::default();

        let mut stream = res.bytes_stream().eventsource();
        while let Some(event) = stream.next().await {
            let event = match event {
                Ok(e) => e,
                // A malformed frame mid-stream is not worth aborting the turn
                // over; the TypeScript version skips these too.
                Err(_) => continue,
            };

            for delta in acc.ingest(&event.data) {
                emit(events, AgentEvent::Delta(delta)).await;
            }
        }

        let (deltas, response) = acc.finish();
        for delta in deltas {
            emit(events, AgentEvent::Delta(delta)).await;
        }

        Ok(response)
    }
}

/// Incremental state for a streaming completion.
///
/// Split out from [`OpenAiCompatibleProvider::handle_sse`] and kept pure — it
/// returns the deltas to emit rather than emitting them — so the accumulation
/// logic is unit-testable without constructing an HTTP response. This is the
/// subtlest code in the crate and the place the TypeScript version has a bug.
#[derive(Default)]
struct SseAccumulator {
    content: String,
    usage: TokenUsage,
    /// Keyed by the provider's tool-call index; `BTreeMap` keeps index order.
    partials: BTreeMap<u32, PartialToolCall>,
}

impl SseAccumulator {
    /// Consume one SSE `data:` payload, returning any deltas it produced.
    fn ingest(&mut self, data: &str) -> Vec<StreamDelta> {
        let mut out = Vec::new();

        if data.trim() == "[DONE]" {
            return out;
        }

        let Ok(chunk) = serde_json::from_str::<StreamChunk>(data) else {
            return out;
        };

        if let Some(delta) = chunk.choices.first().map(|c| &c.delta) {
            if let Some(text) = &delta.content
                && !text.is_empty()
            {
                self.content.push_str(text);
                out.push(StreamDelta::Text { text: text.clone() });
            }

            for tc in delta.tool_calls.iter().flatten() {
                let idx = tc.index.unwrap_or(0);
                let entry = self.partials.entry(idx).or_default();

                // Accumulate rather than replace. The TypeScript version
                // overwrites the whole entry whenever a chunk carries an id,
                // discarding any arguments already buffered — harmless when the
                // id arrives in the first chunk, wrong in general.
                if let Some(id) = &tc.id
                    && !id.is_empty()
                    && entry.id.is_empty()
                {
                    entry.id = id.clone();
                    if let Some(name) = tc.function.as_ref().and_then(|f| f.name.as_ref()) {
                        entry.name = name.clone();
                    }
                    out.push(StreamDelta::ToolCallStart {
                        id: entry.id.clone(),
                        name: entry.name.clone(),
                    });
                }

                if let Some(f) = &tc.function {
                    if let Some(name) = &f.name
                        && !name.is_empty()
                    {
                        entry.name = name.clone();
                    }
                    if let Some(args) = &f.arguments {
                        entry.args_json.push_str(args);
                    }
                }
            }
        }

        if let Some(u) = chunk.usage {
            self.usage = u.into();
        }

        out
    }

    /// Finalise, returning the trailing deltas and the assembled response.
    fn finish(self) -> (Vec<StreamDelta>, ChatResponse) {
        let mut deltas = Vec::new();
        let mut tool_calls = Vec::new();

        for partial in self.partials.into_values() {
            let arguments = parse_arguments(&partial.args_json);
            deltas.push(StreamDelta::ToolCallEnd {
                id: partial.id.clone(),
                name: partial.name.clone(),
                arguments: arguments.clone(),
            });
            tool_calls.push(ToolCall {
                id: partial.id,
                name: partial.name,
                arguments,
            });
        }

        deltas.push(StreamDelta::Done);

        (
            deltas,
            ChatResponse {
                message: Message::assistant(self.content).with_tool_calls(tool_calls),
                usage: self.usage,
            },
        )
    }
}

#[async_trait]
impl LlmProvider for OpenAiCompatibleProvider {
    fn name(&self) -> &str {
        &self.name
    }

    async fn chat(&self, req: ChatRequest<'_>) -> Result<ChatResponse> {
        let streaming = req.events.is_some();

        let mut body = serde_json::json!({
            "model": req.model,
            "messages": Self::to_openai_messages(req.messages),
            "stream": streaming,
        });

        if streaming {
            // OpenAI extension for usage in stream mode; most implementations
            // support it, and those that do not simply omit the field.
            body["stream_options"] = serde_json::json!({ "include_usage": true });
        }

        if !req.tools.is_empty() {
            body["tools"] = serde_json::Value::Array(Self::tools_payload(req.tools));
        }

        let res = self
            .request(reqwest::Method::POST, "/chat/completions")
            .await?
            .json(&body)
            .send()
            .await?;

        if !res.status().is_success() {
            return Err(self.provider_error(res).await);
        }

        if streaming {
            return self.handle_sse(res, req.events).await;
        }

        let data: ChatCompletion = res.json().await?;
        Ok(parse_response(data))
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let res = self
            .request(reqwest::Method::GET, "/models")
            .await?
            .send()
            .await?;

        if !res.status().is_success() {
            return Err(self.provider_error(res).await);
        }

        let data: ModelsResponse = res.json().await?;
        let mut models: Vec<ModelInfo> = data
            .data
            .into_iter()
            .map(|m| ModelInfo {
                id: m.id,
                name: None,
                created: m.created,
            })
            .collect();
        // Byte order, not locale-aware collation. The TypeScript version uses
        // `localeCompare`; std has no equivalent, and the difference only shows
        // up for non-ASCII model ids.
        models.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(models)
    }
}

/// Parse accumulated streaming arguments, defaulting to an empty object.
///
/// Models occasionally emit no arguments at all, or truncate mid-JSON on a
/// length cap. Neither should abort the turn — the model gets to see the tool
/// run with empty arguments and correct itself.
fn parse_arguments(raw: &str) -> JsonObject {
    if raw.trim().is_empty() {
        return JsonObject::new();
    }
    serde_json::from_str::<JsonObject>(raw).unwrap_or_default()
}

fn parse_response(data: ChatCompletion) -> ChatResponse {
    let usage = data.usage.map(Into::into).unwrap_or_default();
    let Some(choice) = data.choices.into_iter().next() else {
        return ChatResponse {
            message: Message::assistant(String::new()),
            usage,
        };
    };

    let tool_calls: Vec<ToolCall> = choice
        .message
        .tool_calls
        .into_iter()
        .flatten()
        .map(|tc| ToolCall {
            id: tc.id,
            name: tc.function.name,
            arguments: parse_arguments(&tc.function.arguments),
        })
        .collect();

    ChatResponse {
        message: Message::assistant(choice.message.content.unwrap_or_default())
            .with_tool_calls(tool_calls),
        usage,
    }
}

#[derive(Default)]
struct PartialToolCall {
    id: String,
    name: String,
    args_json: String,
}

// ── Response types ──────────────────────────────────────────────

/// Deserialize `null` as `T::default()` rather than failing.
///
/// `#[serde(default)]` alone only covers a *missing* field. Real providers send
/// explicit nulls for empty collections — Ollama's `/v1/models` returns
/// `{"object":"list","data":null}` when nothing is pulled, and several return
/// `choices: null` on an empty completion. The TypeScript version tolerates this
/// by accident through `?? []`; being stricter here would just mean breaking on
/// live servers.
fn null_to_default<'de, D, T>(deserializer: D) -> std::result::Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default, deserialize_with = "null_to_default")]
    data: Vec<RawModel>,
}

#[derive(Deserialize)]
struct RawModel {
    id: String,
    #[serde(default)]
    created: Option<i64>,
}

#[derive(Deserialize)]
struct ChatCompletion {
    #[serde(default, deserialize_with = "null_to_default")]
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<RawUsage>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Deserialize)]
struct ChoiceMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<RawToolCall>>,
}

#[derive(Deserialize)]
struct RawToolCall {
    id: String,
    function: RawFunction,
}

#[derive(Deserialize)]
struct RawFunction {
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    arguments: String,
}

#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default, deserialize_with = "null_to_default")]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    usage: Option<RawUsage>,
}

#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default, deserialize_with = "null_to_default")]
    delta: StreamDeltaRaw,
}

#[derive(Default, Deserialize)]
struct StreamDeltaRaw {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<StreamToolCall>>,
}

#[derive(Deserialize)]
struct StreamToolCall {
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<StreamFunction>,
}

#[derive(Deserialize)]
struct StreamFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct RawUsage {
    #[serde(default, deserialize_with = "null_to_default")]
    prompt_tokens: u64,
    #[serde(default, deserialize_with = "null_to_default")]
    completion_tokens: u64,
    #[serde(default, deserialize_with = "null_to_default")]
    total_tokens: u64,
}

impl From<RawUsage> for TokenUsage {
    fn from(u: RawUsage) -> Self {
        TokenUsage {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ContentPart, ImageUrl, ToolDefinition};

    #[test]
    fn tool_role_messages_carry_tool_call_id() {
        let msgs = vec![Message::tool_result("call_1", "output")];
        let out = OpenAiCompatibleProvider::to_openai_messages(&msgs);
        assert_eq!(out[0]["role"], "tool");
        assert_eq!(out[0]["content"], "output");
        assert_eq!(out[0]["tool_call_id"], "call_1");
    }

    #[test]
    fn assistant_tool_calls_serialise_arguments_as_a_json_string() {
        let mut args = JsonObject::new();
        args.insert("path".to_string(), serde_json::json!("/tmp/x"));
        let msgs = vec![Message::assistant("").with_tool_calls(vec![ToolCall {
            id: "call_1".to_string(),
            name: "file_read".to_string(),
            arguments: args,
        }])];

        let out = OpenAiCompatibleProvider::to_openai_messages(&msgs);
        // Empty assistant content must be null, not "".
        assert!(out[0]["content"].is_null());
        let tc = &out[0]["tool_calls"][0];
        assert_eq!(tc["type"], "function");
        assert_eq!(tc["function"]["name"], "file_read");
        // Arguments are a JSON-encoded string, not an object.
        assert_eq!(tc["function"]["arguments"], r#"{"path":"/tmp/x"}"#);
    }

    #[test]
    fn multimodal_content_passes_through_unchanged() {
        let msgs = vec![Message::user(Content::Parts(vec![
            ContentPart::Text {
                text: "look".to_string(),
            },
            ContentPart::ImageUrl {
                image_url: ImageUrl {
                    url: "data:image/png;base64,AAA".to_string(),
                },
            },
        ]))];
        let out = OpenAiCompatibleProvider::to_openai_messages(&msgs);
        assert_eq!(out[0]["content"][0]["type"], "text");
        assert_eq!(out[0]["content"][1]["type"], "image_url");
        assert_eq!(
            out[0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAA"
        );
    }

    #[test]
    fn tools_are_wrapped_in_the_function_envelope() {
        let defs = vec![ToolDefinition {
            name: "bash".to_string(),
            description: "run".to_string(),
            input_schema: serde_json::json!({ "type": "object" }),
        }];
        let out = OpenAiCompatibleProvider::tools_payload(&defs);
        assert_eq!(out[0]["type"], "function");
        assert_eq!(out[0]["function"]["name"], "bash");
        assert_eq!(out[0]["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn malformed_or_empty_tool_arguments_default_to_an_empty_object() {
        assert!(parse_arguments("").is_empty());
        assert!(parse_arguments("   ").is_empty());
        // Truncated mid-JSON, as happens when a model hits a length cap.
        assert!(parse_arguments(r#"{"path": "/tm"#).is_empty());
        assert_eq!(
            parse_arguments(r#"{"path":"/tmp"}"#).get("path").unwrap(),
            &serde_json::json!("/tmp")
        );
    }

    #[test]
    fn non_streaming_response_parses_content_and_tool_calls() {
        let data: ChatCompletion = serde_json::from_value(serde_json::json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "sure",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": "bash", "arguments": "{\"command\":\"ls\"}" }
                    }]
                }
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14 }
        }))
        .unwrap();

        let parsed = parse_response(data);
        assert_eq!(parsed.message.text(), "sure");
        assert_eq!(parsed.usage.total_tokens, 14);
        let calls = parsed.message.tool_calls.unwrap();
        assert_eq!(calls[0].name, "bash");
        assert_eq!(calls[0].arguments["command"], serde_json::json!("ls"));
    }

    #[test]
    fn a_response_with_no_choices_does_not_panic() {
        let data: ChatCompletion = serde_json::from_value(serde_json::json!({})).unwrap();
        let parsed = parse_response(data);
        assert_eq!(parsed.message.text(), "");
        assert_eq!(parsed.usage, TokenUsage::default());
    }

    #[test]
    fn missing_usage_defaults_to_zero() {
        let data: ChatCompletion = serde_json::from_value(serde_json::json!({
            "choices": [{ "message": { "role": "assistant", "content": "hi" } }]
        }))
        .unwrap();
        assert_eq!(parse_response(data).usage.total_tokens, 0);
    }

    // ── Streaming accumulation ──

    /// Feed a sequence of SSE payloads through the accumulator.
    fn stream(payloads: &[serde_json::Value]) -> (Vec<StreamDelta>, ChatResponse) {
        let mut acc = SseAccumulator::default();
        let mut deltas = Vec::new();
        for p in payloads {
            deltas.extend(acc.ingest(&p.to_string()));
        }
        let (tail, response) = acc.finish();
        deltas.extend(tail);
        (deltas, response)
    }

    fn text_chunk(text: &str) -> serde_json::Value {
        serde_json::json!({ "choices": [{ "delta": { "content": text } }] })
    }

    #[test]
    fn text_chunks_accumulate_and_emit_one_delta_each() {
        let (deltas, response) = stream(&[text_chunk("Hel"), text_chunk("lo"), text_chunk("!")]);
        assert_eq!(response.message.text(), "Hello!");
        let texts: Vec<_> = deltas
            .iter()
            .filter_map(|d| match d {
                StreamDelta::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["Hel", "lo", "!"]);
        assert_eq!(deltas.last(), Some(&StreamDelta::Done));
    }

    #[test]
    fn empty_text_chunks_emit_nothing() {
        let (deltas, _) = stream(&[text_chunk(""), text_chunk("hi")]);
        assert_eq!(
            deltas
                .iter()
                .filter(|d| matches!(d, StreamDelta::Text { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn tool_call_arguments_accumulate_across_chunks() {
        let (deltas, response) = stream(&[
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "id": "call_1", "function": { "name": "bash", "arguments": "" }
            }] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "function": { "arguments": "{\"comm" }
            }] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "function": { "arguments": "and\":\"ls\"}" }
            }] } }] }),
        ]);

        let calls = response.message.tool_calls.expect("expected tool calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "bash");
        assert_eq!(calls[0].arguments["command"], serde_json::json!("ls"));

        assert!(deltas.iter().any(|d| matches!(
            d,
            StreamDelta::ToolCallStart { id, name } if id == "call_1" && name == "bash"
        )));
        assert!(
            deltas
                .iter()
                .any(|d| matches!(d, StreamDelta::ToolCallEnd { .. }))
        );
    }

    /// Regression test for the bug in `openai-compatible.ts:170`.
    ///
    /// When a provider sends arguments before (or alongside a repeat of) the id,
    /// the TypeScript version resets the map entry on the id-bearing chunk and
    /// silently drops everything buffered so far. Here the arguments survive.
    #[test]
    fn arguments_buffered_before_the_id_arrives_are_not_discarded() {
        let (_, response) = stream(&[
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "function": { "name": "bash", "arguments": "{\"command\":" }
            }] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "id": "call_late", "function": { "arguments": "\"ls -la\"}" }
            }] } }] }),
        ]);

        let calls = response.message.tool_calls.expect("expected tool calls");
        assert_eq!(calls[0].id, "call_late");
        assert_eq!(calls[0].name, "bash");
        assert_eq!(
            calls[0].arguments["command"],
            serde_json::json!("ls -la"),
            "arguments buffered before the id must survive"
        );
    }

    #[test]
    fn parallel_tool_calls_stay_separated_by_index_and_ordered() {
        let (_, response) = stream(
            &[serde_json::json!({ "choices": [{ "delta": { "tool_calls": [
                { "index": 1, "id": "b", "function": { "name": "second", "arguments": "{}" } },
                { "index": 0, "id": "a", "function": { "name": "first", "arguments": "{}" } }
            ] } }] })],
        );

        let calls = response.message.tool_calls.expect("expected tool calls");
        assert_eq!(calls.len(), 2);
        // BTreeMap orders by provider index, not arrival order.
        assert_eq!(calls[0].name, "first");
        assert_eq!(calls[1].name, "second");
    }

    #[test]
    fn usage_is_captured_from_the_trailing_chunk() {
        let (_, response) = stream(&[
            text_chunk("hi"),
            serde_json::json!({
                "choices": [],
                "usage": { "prompt_tokens": 7, "completion_tokens": 2, "total_tokens": 9 }
            }),
        ]);
        assert_eq!(response.usage.total_tokens, 9);
        assert_eq!(response.usage.prompt_tokens, 7);
    }

    #[test]
    fn done_sentinel_and_unparseable_payloads_are_skipped() {
        let mut acc = SseAccumulator::default();
        assert!(acc.ingest("[DONE]").is_empty());
        assert!(acc.ingest("not json at all").is_empty());
        assert!(acc.ingest("{\"unexpected\":true}").is_empty());
        let (_, response) = acc.finish();
        assert_eq!(response.message.text(), "");
        assert!(response.message.tool_calls.is_none());
    }

    #[test]
    fn a_text_only_stream_produces_no_tool_calls() {
        let (_, response) = stream(&[text_chunk("just text")]);
        assert!(response.message.tool_calls.is_none());
    }

    #[test]
    fn base_url_trailing_slashes_are_stripped() {
        let p = OpenAiCompatibleProvider::new(OpenAiProviderOptions {
            name: "test".to_string(),
            base_url: "http://localhost:11434/v1///".to_string(),
            auth: Auth::None,
            headers: Vec::new(),
        });
        assert_eq!(p.base_url, "http://localhost:11434/v1");
    }
}
