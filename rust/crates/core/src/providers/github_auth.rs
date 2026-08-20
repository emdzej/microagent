//! GitHub Copilot device-flow authentication, porting
//! `packages/core/src/providers/github-auth.ts`.
//!
//! Two tokens are involved. The OAuth token is long-lived and obtained once via
//! the device flow; the Copilot *session* token is short-lived and derived from
//! it. Both are cached, so the interactive flow runs only on first use or after
//! the OAuth token is revoked.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::error::{Error, Result};
use crate::paths;

const GITHUB_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL: &str = "https://api.github.com/copilot_internal/v2/token";
const USER_AGENT: &str = concat!("microagent/", env!("CARGO_PKG_VERSION"));
const TOKEN_FILE: &str = "github-copilot-token.json";

/// Refresh a session token this many seconds before it expires.
const EXPIRY_BUFFER_SECS: i64 = 300;

/// Called with the user code and the URL to enter it at.
pub type UserCodeCallback = Box<dyn Fn(&str, &str) + Send + Sync>;
/// Called on each poll of the token endpoint, and on completion.
pub type ProgressCallback = Box<dyn Fn() + Send + Sync>;

/// Callbacks for driving the device flow UI.
pub struct DeviceFlowCallbacks {
    pub on_user_code: UserCodeCallback,
    pub on_polling: ProgressCallback,
    pub on_complete: ProgressCallback,
}

/// Serialises concurrent token acquisition.
///
/// Without this, a turn that fires several requests at once could launch several
/// device flows, each printing its own user code. The TypeScript version has this
/// race; Node's single thread makes it rarer but not impossible.
static AUTH_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Serialize, Deserialize)]
struct CachedAuth {
    #[serde(rename = "oauthToken")]
    oauth_token: String,
    #[serde(rename = "sessionToken")]
    session_token: String,
    /// Unix timestamp, seconds.
    #[serde(rename = "expiresAt")]
    expires_at: i64,
}

fn token_path() -> PathBuf {
    paths::data().join(TOKEN_FILE)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn load_cached() -> Option<CachedAuth> {
    let raw = std::fs::read_to_string(token_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_cached(auth: &CachedAuth) -> Result<()> {
    let dir = paths::data();
    std::fs::create_dir_all(&dir)?;
    let path = token_path();
    let json = serde_json::to_string_pretty(auth)?;
    std::fs::write(&path, json)?;
    restrict_permissions(&path);
    Ok(())
}

/// Restrict the token file to the owner.
#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

/// No-op on Windows.
///
/// Restricting access there needs an ACL, not a mode. The TypeScript version
/// passes `{ mode: 0o600 }` to `writeFileSync`, which Node silently ignores on
/// Windows, so this is the same behaviour rather than a regression.
#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) {}

/// Get a valid Copilot API token.
///
/// Returns the cached session token when still valid; otherwise refreshes it from
/// the cached OAuth token; otherwise runs the full device flow.
pub async fn copilot_token(callbacks: Option<&DeviceFlowCallbacks>) -> Result<String> {
    let _guard = AUTH_LOCK.lock().await;

    let cached = load_cached();

    if let Some(cached) = &cached
        && cached.expires_at > now_secs() + EXPIRY_BUFFER_SECS
    {
        return Ok(cached.session_token.clone());
    }

    // An OAuth token we already hold can mint a fresh session token without any
    // user interaction.
    if let Some(cached) = &cached
        && !cached.oauth_token.is_empty()
        && let Ok(session) = session_token(&cached.oauth_token).await
    {
        let auth = CachedAuth {
            oauth_token: cached.oauth_token.clone(),
            session_token: session.token.clone(),
            expires_at: session.expires_at,
        };
        save_cached(&auth)?;
        return Ok(session.token);
    }

    run_device_flow(callbacks).await
}

#[derive(Deserialize)]
struct CopilotSessionToken {
    token: String,
    #[serde(rename = "expires_at")]
    expires_at: i64,
}

/// Exchange an OAuth token for a short-lived Copilot session token.
async fn session_token(oauth_token: &str) -> Result<CopilotSessionToken> {
    let res = reqwest::Client::new()
        .get(COPILOT_TOKEN_URL)
        // Note: `token <oauth>`, not `Bearer`.
        .header("Authorization", format!("token {oauth_token}"))
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .send()
        .await?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(Error::Auth(format!(
            "Failed to get Copilot token: {status} {body}"
        )));
    }

    Ok(res.json().await?)
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    interval: Option<u64>,
    expires_in: u64,
}

async fn run_device_flow(callbacks: Option<&DeviceFlowCallbacks>) -> Result<String> {
    let client = reqwest::Client::new();

    // Step 1: request a device code.
    let res = client
        .post(GITHUB_DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .json(&serde_json::json!({
            "client_id": GITHUB_CLIENT_ID,
            "scope": "read:user",
        }))
        .send()
        .await?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(Error::Auth(format!(
            "Device code request failed: {status} {body}"
        )));
    }

    let code: DeviceCodeResponse = res.json().await?;

    match callbacks {
        Some(cb) => (cb.on_user_code)(&code.user_code, &code.verification_uri),
        // Without a fallback the user faces a silent hang: the flow blocks for up
        // to `expires_in` waiting for a code they were never shown. This path is
        // reachable whenever a plain chat request triggers re-authentication, not
        // just from the wizard. stderr keeps it out of piped stdout.
        None => eprintln!(
            "\nGitHub Copilot authentication required.\n  \
             Open {} and enter code: {}\n",
            code.verification_uri, code.user_code
        ),
    }

    // Step 2: poll until the user authorises.
    let mut interval = Duration::from_secs(code.interval.unwrap_or(5).max(1));
    let deadline = std::time::Instant::now() + Duration::from_secs(code.expires_in);
    let mut oauth_token = None;

    while std::time::Instant::now() < deadline {
        tokio::time::sleep(interval).await;
        if let Some(cb) = callbacks {
            (cb.on_polling)();
        }

        let res = client
            .post(GITHUB_TOKEN_URL)
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT)
            .json(&serde_json::json!({
                "client_id": GITHUB_CLIENT_ID,
                "device_code": code.device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            }))
            .send()
            .await?;

        let body: serde_json::Value = res.json().await?;

        if let Some(token) = body.get("access_token").and_then(|v| v.as_str()) {
            oauth_token = Some(token.to_string());
            break;
        }

        match body.get("error").and_then(|v| v.as_str()) {
            Some("authorization_pending") => continue,
            Some("slow_down") => {
                // GitHub asks for a longer gap. The TypeScript version sleeps a
                // flat extra 5s but keeps the original interval, so it can keep
                // tripping the same rate limit; raising the interval avoids that.
                interval += Duration::from_secs(5);
                continue;
            }
            Some("expired_token") => {
                return Err(Error::Auth("Device code expired. Please try again.".into()));
            }
            Some("access_denied") => {
                return Err(Error::Auth("Authorization denied by user.".into()));
            }
            Some(other) => {
                let description = body
                    .get("error_description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                return Err(Error::Auth(format!("OAuth error: {other} — {description}")));
            }
            None => continue,
        }
    }

    let Some(oauth_token) = oauth_token else {
        return Err(Error::Auth(
            "Device flow timed out. Please try again.".into(),
        ));
    };

    // Step 3: exchange for a session token.
    let session = session_token(&oauth_token).await?;

    save_cached(&CachedAuth {
        oauth_token,
        session_token: session.token.clone(),
        expires_at: session.expires_at,
    })?;

    if let Some(cb) = callbacks {
        (cb.on_complete)();
    }

    Ok(session.token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_auth_uses_the_same_camel_case_keys_as_the_typescript_cache() {
        // The two implementations share this file, so the keys must match.
        let auth = CachedAuth {
            oauth_token: "gho_x".to_string(),
            session_token: "tid=y".to_string(),
            expires_at: 1234,
        };
        let json = serde_json::to_value(&auth).unwrap();
        assert!(json.get("oauthToken").is_some());
        assert!(json.get("sessionToken").is_some());
        assert!(json.get("expiresAt").is_some());

        let round: CachedAuth = serde_json::from_value(json).unwrap();
        assert_eq!(round.oauth_token, "gho_x");
        assert_eq!(round.expires_at, 1234);
    }

    #[test]
    fn a_cache_written_by_the_typescript_version_parses() {
        let raw = serde_json::json!({
            "oauthToken": "gho_abc",
            "sessionToken": "tid=abc;exp=123",
            "expiresAt": 1893456000i64
        });
        let auth: CachedAuth = serde_json::from_value(raw).unwrap();
        assert_eq!(auth.session_token, "tid=abc;exp=123");
    }

    #[test]
    fn the_token_file_lives_in_the_data_directory() {
        let p = token_path();
        assert!(
            p.ends_with("microagent/github-copilot-token.json"),
            "got {p:?}"
        );
    }

    #[test]
    fn expiry_buffer_treats_a_nearly_expired_token_as_stale() {
        // Mirrors the condition in copilot_token.
        let now = now_secs();
        let nearly = now + 100;
        let fresh = now + 3600;
        assert!(!(nearly > now + EXPIRY_BUFFER_SECS), "should be stale");
        assert!(fresh > now + EXPIRY_BUFFER_SECS, "should be fresh");
    }

    #[cfg(unix)]
    #[test]
    fn the_saved_token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join("microagent-auth-perm-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("token.json");
        std::fs::write(&path, "{}").unwrap();
        restrict_permissions(&path);

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "token file must not be group/world readable"
        );

        std::fs::remove_file(&path).ok();
    }
}
