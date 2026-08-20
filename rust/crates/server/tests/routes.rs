//! Route tests, porting `packages/server/tests/routes.test.ts`.
//!
//! Driven through `tower::ServiceExt::oneshot` against the router, so no port is
//! bound — the equivalent of Fastify's `app.inject`.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use microagent_core::{Agent, MicroagentConfig};
use microagent_server::{ServerOptions, build_router};
use tower::ServiceExt;

fn router() -> axum::Router {
    let config: MicroagentConfig = serde_json::from_value(serde_json::json!({
        "provider": { "type": "ollama", "model": "test" },
        "systemPrompt": "test"
    }))
    .unwrap();

    let agent = Arc::new(Agent::builder(config).build().unwrap());

    build_router(ServerOptions {
        agent,
        config_path: None,
        persist_model: None,
        static_dir: None,
    })
}

async fn get(uri: &str) -> (StatusCode, serde_json::Value) {
    let response = router()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, json)
}

async fn post(uri: &str, body: serde_json::Value) -> (StatusCode, serde_json::Value) {
    let response = router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, json)
}

// ── Ported from routes.test.ts ──

#[tokio::test]
async fn get_health_returns_ok() {
    let (status, body) = get("/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert!(body["provider"].is_string());
    assert!(body["tools"].is_number());
}

#[tokio::test]
async fn get_tools_returns_tool_list() {
    let (status, body) = get("/tools").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["tools"].is_array());
}

#[tokio::test]
async fn get_stats_returns_usage_stats() {
    let (status, body) = get("/stats").await;
    assert_eq!(status, StatusCode::OK);
    // camelCase, as consumed by packages/web/src/lib/api.ts.
    for key in [
        "requests",
        "totalTokens",
        "toolCalls",
        "promptTokens",
        "completionTokens",
        "elapsedMs",
    ] {
        assert!(body[key].is_number(), "missing or non-numeric {key}");
    }
}

#[tokio::test]
async fn post_chat_rejects_missing_message() {
    let (status, _) = post("/chat", serde_json::json!({})).await;
    // Fastify's schema validation returns 400; axum's Json rejection returns 422
    // for a well-formed body with a missing required field.
    assert!(
        status == StatusCode::BAD_REQUEST || status == StatusCode::UNPROCESSABLE_ENTITY,
        "expected a client error, got {status}"
    );
}

// ── Additional coverage ──

#[tokio::test]
async fn get_model_reports_the_active_provider_and_model() {
    let (status, body) = get("/model").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["provider"], "ollama");
    assert_eq!(body["model"], "test");
}

#[tokio::test]
async fn post_model_switches_the_active_model() {
    let (status, body) = post("/model", serde_json::json!({ "model": "llama3.2" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["model"], "llama3.2");
    assert_eq!(body["provider"], "ollama");
    // No config path was supplied, so nothing was written.
    assert_eq!(body["persisted"], serde_json::json!(false));
}

#[tokio::test]
async fn post_model_rejects_a_missing_model_field() {
    let (status, _) = post("/model", serde_json::json!({})).await;
    assert!(status.is_client_error(), "got {status}");
}

/// With no static assets there is nothing to fall back to, so unknown paths are
/// a genuine 404.
#[cfg(not(feature = "embed-web"))]
#[tokio::test]
async fn unknown_routes_404_when_no_static_dir_is_configured() {
    let (status, _) = get("/definitely-not-a-route").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// Built with `embed-web`, the same path is an SPA client route and must serve
/// the embedded shell instead.
#[cfg(feature = "embed-web")]
#[tokio::test]
async fn unknown_routes_serve_the_embedded_spa_shell() {
    let response = router()
        .oneshot(
            Request::builder()
                .uri("/definitely-not-a-route")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert!(
        String::from_utf8_lossy(&bytes).contains("<!DOCTYPE html>"),
        "expected the SPA shell"
    );
}

#[tokio::test]
async fn malformed_json_is_rejected() {
    let response = router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/chat")
                .header("content-type", "application/json")
                .body(Body::from("{not json"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(response.status().is_client_error());
}

/// `/stats` is per-session, so a distinct session id must not see another
/// session's counters. This is the observable half of the concurrency fix.
#[tokio::test]
async fn sessions_have_independent_stats() {
    let app = router();

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/stats?session=alpha")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/stats")
                .header("x-session-id", "beta")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    // A fresh session starts at zero regardless of what other sessions did.
    assert_eq!(body["requests"], serde_json::json!(0));
}

#[tokio::test]
async fn cors_headers_are_present() {
    let response = router()
        .oneshot(
            Request::builder()
                .uri("/health")
                .header("origin", "http://localhost:5173")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        response
            .headers()
            .contains_key("access-control-allow-origin"),
        "the web UI dev server needs CORS"
    );
}
