//! Per-session conversation storage.

use std::collections::HashMap;
use std::sync::Arc;

use microagent_core::{Agent, Conversation};
use tokio::sync::{Mutex, RwLock};

/// Conversations keyed by session id.
///
/// A `Mutex` per conversation, so two requests for the same session queue rather
/// than interleaving their turns. An `RwLock` around the map, so lookups for
/// different sessions do not contend.
#[derive(Clone)]
pub struct SessionStore {
    agent: Arc<Agent>,
    sessions: Arc<RwLock<HashMap<String, Arc<Mutex<Conversation>>>>>,
}

impl SessionStore {
    pub fn new(agent: Arc<Agent>) -> Self {
        SessionStore {
            agent,
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Get the conversation for a session, creating it on first use.
    pub async fn get(&self, id: &str) -> Arc<Mutex<Conversation>> {
        if let Some(existing) = self.sessions.read().await.get(id) {
            return existing.clone();
        }

        let mut sessions = self.sessions.write().await;
        // Re-check: another task may have inserted between dropping the read
        // guard and taking the write guard.
        sessions
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(self.agent.new_conversation())))
            .clone()
    }
}
