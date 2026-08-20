//! HTTP API for microagent: REST routes plus SSE streaming.
//!
//! Ports `packages/server/src/index.ts` from Fastify to axum. The route set,
//! request bodies and response shapes are identical, so the existing Svelte web
//! UI in `packages/web` runs against this server unmodified.

#[cfg(feature = "embed-web")]
mod embed;
mod session;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use microagent_core::{Agent, AgentEvent, ToolDefinition};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::CorsLayer;

use crate::session::SessionStore;

/// How the config file is updated when the model changes.
///
/// The CLI owns config persistence, so the server takes a callback rather than
/// reaching into the file itself.
pub type PersistModel = Arc<dyn Fn(&Path, &str, &str) -> std::io::Result<()> + Send + Sync>;

pub struct ServerOptions {
    pub agent: Arc<Agent>,
    /// Resolved config file path, for persisting model switches.
    pub config_path: Option<PathBuf>,
    pub persist_model: Option<PersistModel>,
    /// Directory of built web assets. Ignored when the `embed-web` feature is
    /// active and no directory is given.
    pub static_dir: Option<PathBuf>,
}

struct AppState {
    agent: Arc<Agent>,
    sessions: SessionStore,
    config_path: Option<PathBuf>,
    persist_model: Option<PersistModel>,
    started: Instant,
}

/// Build the router. Exposed so tests can drive it without binding a port.
pub fn build_router(opts: ServerOptions) -> Router {
    let state = Arc::new(AppState {
        sessions: SessionStore::new(opts.agent.clone()),
        agent: opts.agent,
        config_path: opts.config_path,
        persist_model: opts.persist_model,
        started: Instant::now(),
    });

    let api = Router::new()
        .route("/health", get(health))
        .route("/tools", get(tools))
        .route("/stats", get(stats))
        .route("/models", get(models))
        .route("/model", get(get_model).post(post_model))
        .route("/chat", post(chat))
        .route("/chat/stream", post(chat_stream))
        .with_state(state);

    let mut app = api.layer(CorsLayer::permissive());

    // Static assets, if any. Registered as a fallback so API routes always win.
    if let Some(dir) = opts.static_dir {
        // `.fallback` rather than `.not_found_service`: the latter wraps the
        // service in `SetStatus<404>`, which would serve the SPA shell with a 404
        // status on every client-side route.
        let index = dir.join("index.html");
        let service = tower_http::services::ServeDir::new(&dir)
            .fallback(tower_http::services::ServeFile::new(index));
        app = app.fallback_service(service);
    } else {
        #[cfg(feature = "embed-web")]
        {
            app = app.fallback(embed::serve_embedded);
        }
    }

    app
}

pub async fn serve(opts: ServerOptions, host: &str, port: u16) -> std::io::Result<()> {
    let app = build_router(opts);
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("microagent server listening on http://{addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

// ── Session selection ───────────────────────────────────────────

/// Conversations are keyed by session so concurrent requests cannot interleave
/// into one another's history.
///
/// The TypeScript server keeps a single message array for the whole process, so
/// two overlapping `POST /chat` calls corrupt the transcript — a `tool` message
/// can land without the `assistant` message carrying its `tool_calls`, which
/// most providers reject with a 400.
///
/// The web UI sends no session id, so it lands on `default` and behaves exactly
/// as before, except that overlapping requests now queue on the session mutex
/// instead of interleaving.
const DEFAULT_SESSION: &str = "default";

#[derive(Debug, Default, Deserialize)]
struct SessionQuery {
    session: Option<String>,
}

fn session_id(headers: &HeaderMap, query: Option<&str>, body: Option<&str>) -> String {
    body.map(str::to_string)
        .or_else(|| query.map(str::to_string))
        .or_else(|| {
            headers
                .get("x-session-id")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_else(|| DEFAULT_SESSION.to_string())
}

// ── Routes ──────────────────────────────────────────────────────

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    provider: String,
    tools: usize,
    uptime: f64,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        provider: state.agent.active().provider,
        tools: state.agent.tools().len(),
        uptime: state.started.elapsed().as_secs_f64(),
    })
}

#[derive(Serialize)]
struct ToolsResponse {
    tools: Vec<ToolDefinition>,
}

async fn tools(State(state): State<Arc<AppState>>) -> Json<ToolsResponse> {
    Json(ToolsResponse {
        tools: state.agent.tools().definitions(),
    })
}

async fn stats(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<SessionQuery>,
) -> impl IntoResponse {
    let id = session_id(&headers, q.session.as_deref(), None);
    let conversation = state.sessions.get(&id).await;
    let summary = conversation.lock().await.stats().summary();
    Json(summary)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelsResponse {
    models: Vec<microagent_core::ProviderModelInfo>,
    active_provider: String,
    active_model: String,
}

async fn models(State(state): State<Arc<AppState>>) -> Json<ModelsResponse> {
    let active = state.agent.active();
    Json(ModelsResponse {
        models: state.agent.list_all_models().await,
        active_provider: active.provider,
        active_model: active.model,
    })
}

#[derive(Serialize)]
struct ModelResponse {
    model: String,
    provider: String,
}

async fn get_model(State(state): State<Arc<AppState>>) -> Json<ModelResponse> {
    let active = state.agent.active();
    Json(ModelResponse {
        model: active.model,
        provider: active.provider,
    })
}

#[derive(Deserialize)]
struct SetModelRequest {
    model: String,
}

#[derive(Serialize)]
struct SetModelResponse {
    provider: String,
    model: String,
    persisted: bool,
}

async fn post_model(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SetModelRequest>,
) -> Result<Json<SetModelResponse>, ApiError> {
    let active = state
        .agent
        .set_model(&body.model)
        .map_err(|e| ApiError::bad_request(e.to_string()))?;

    // Persistence is best-effort: the switch has already taken effect in memory,
    // so a read-only config file must not fail the request.
    let persisted = match (&state.config_path, &state.persist_model) {
        (Some(path), Some(persist)) => persist(path, &active.provider, &active.model).is_ok(),
        _ => false,
    };

    Ok(Json(SetModelResponse {
        provider: active.provider,
        model: active.model,
        persisted,
    }))
}

#[derive(Deserialize)]
struct ChatRequestBody {
    message: String,
    #[serde(default)]
    images: Option<Vec<String>>,
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallRecord {
    id: String,
    name: String,
    args: microagent_core::JsonObject,
    result: String,
    is_error: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatResponseBody {
    response: String,
    tool_calls: Vec<ToolCallRecord>,
    stats: microagent_core::StatsSummary,
}

async fn chat(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ChatRequestBody>,
) -> Result<Json<ChatResponseBody>, ApiError> {
    let id = session_id(&headers, None, body.session_id.as_deref());
    let conversation = state.sessions.get(&id).await;
    let images = body.images.unwrap_or_default();

    let (tx, mut rx) = mpsc::channel::<AgentEvent>(256);

    // Tool calls are correlated by id, not by name. Name matching (as in
    // `[...toolCalls].reverse().find(t => t.name === name)`) happens to be
    // correct only while tool calls execute strictly sequentially; it is a latent
    // defect that surfaces as soon as they do not.
    let collector = tokio::spawn(async move {
        let mut records: Vec<ToolCallRecord> = Vec::new();
        while let Some(event) = rx.recv().await {
            match event {
                AgentEvent::ToolCall { id, name, args } => records.push(ToolCallRecord {
                    id,
                    name,
                    args,
                    result: String::new(),
                    is_error: false,
                }),
                AgentEvent::ToolResult {
                    id,
                    content,
                    is_error,
                    ..
                } => {
                    if let Some(rec) = records.iter_mut().find(|r| r.id == id) {
                        rec.result = content;
                        rec.is_error = is_error;
                    }
                }
                _ => {}
            }
        }
        records
    });

    let mut guard = conversation.lock().await;
    let result = state
        .agent
        .run(&mut guard, &body.message, &images, Some(&tx))
        .await;
    drop(tx);

    let tool_calls = collector.await.unwrap_or_default();
    let response = result.map_err(|e| ApiError::internal(e.to_string()))?;
    let stats = guard.stats().summary();

    Ok(Json(ChatResponseBody {
        response,
        tool_calls,
        stats,
    }))
}

async fn chat_stream(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ChatRequestBody>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
    let id = session_id(&headers, None, body.session_id.as_deref());
    let (tx, rx) = mpsc::channel::<AgentEvent>(256);

    let agent = state.agent.clone();
    let sessions = state.sessions.clone();
    let images = body.images.unwrap_or_default();
    let message = body.message;

    tokio::spawn(async move {
        let conversation = sessions.get(&id).await;
        let mut guard = conversation.lock().await;

        let result = agent.run(&mut guard, &message, &images, Some(&tx)).await;

        // `Complete` and `Error` are terminal and sent here rather than by the
        // agent, matching the TypeScript server.
        let terminal = match result {
            Ok(response) => AgentEvent::Complete {
                response,
                stats: guard.stats().summary(),
            },
            Err(err) => AgentEvent::Error {
                error: err.to_string(),
            },
        };
        let _ = tx.send(terminal).await;
    });

    // This is where the event enum earns its keep: the whole handler is a map.
    let stream = ReceiverStream::new(rx).map(|event| {
        Ok(Event::default()
            .event(event.name())
            .data(event.payload().to_string()))
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ── Errors ──────────────────────────────────────────────────────

pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: String) -> Self {
        ApiError {
            status: StatusCode::BAD_REQUEST,
            message,
        }
    }

    fn internal(message: String) -> Self {
        ApiError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}
