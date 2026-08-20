//! Cumulative usage tracking, mirroring `packages/core/src/stats.ts`.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::types::TokenUsage;

/// Serialisable snapshot of a session's usage.
///
/// Field names are camelCase to match `GET /stats` as consumed by
/// `packages/web/src/lib/api.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSummary {
    pub requests: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub tool_calls: u64,
    pub elapsed_ms: u64,
}

/// Tracks token usage, request and tool-call counts, and elapsed time.
///
/// Uses [`Instant`] rather than a wall clock, since only the delta matters and
/// `Instant` is monotonic. `Date.now()` in the TypeScript version has no direct
/// analog.
#[derive(Debug)]
pub struct UsageStats {
    requests: u64,
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
    tool_calls: u64,
    start: Instant,
}

impl Default for UsageStats {
    fn default() -> Self {
        Self::new()
    }
}

impl UsageStats {
    pub fn new() -> Self {
        UsageStats {
            requests: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            tool_calls: 0,
            start: Instant::now(),
        }
    }

    pub fn record(&mut self, usage: TokenUsage) {
        self.requests += 1;
        self.prompt_tokens += usage.prompt_tokens;
        self.completion_tokens += usage.completion_tokens;
        self.total_tokens += usage.total_tokens;
    }

    pub fn record_tool_call(&mut self) {
        self.tool_calls += 1;
    }

    pub fn summary(&self) -> StatsSummary {
        StatsSummary {
            requests: self.requests,
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            total_tokens: self.total_tokens,
            tool_calls: self.tool_calls,
            elapsed_ms: self.start.elapsed().as_millis() as u64,
        }
    }

    /// Two-line human-readable summary, as printed by `/stats`.
    pub fn format(&self) -> String {
        let s = self.summary();
        format!(
            "tokens: {} (prompt: {}, completion: {})\nrequests: {} | tool calls: {} | elapsed: {:.1}s",
            s.total_tokens,
            s.prompt_tokens,
            s.completion_tokens,
            s.requests,
            s.tool_calls,
            s.elapsed_ms as f64 / 1000.0,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_usage_and_tool_calls() {
        let mut stats = UsageStats::new();
        stats.record(TokenUsage {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
        });
        stats.record(TokenUsage {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
        });
        stats.record_tool_call();

        let s = stats.summary();
        assert_eq!(s.requests, 2);
        assert_eq!(s.prompt_tokens, 11);
        assert_eq!(s.completion_tokens, 7);
        assert_eq!(s.total_tokens, 18);
        assert_eq!(s.tool_calls, 1);
    }

    #[test]
    fn summary_serialises_in_the_camel_case_shape_the_web_ui_expects() {
        let json = serde_json::to_value(UsageStats::new().summary()).unwrap();
        for key in [
            "requests",
            "promptTokens",
            "completionTokens",
            "totalTokens",
            "toolCalls",
            "elapsedMs",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
    }
}
