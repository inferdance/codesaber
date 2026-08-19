//! Session log schema (spec §4.5, WAL semantics): the append-only JSONL
//! event stream is the single source of truth for every session. One line =
//! one [`SessionEventEnvelope`].
//!
//! Write-ahead rule: before a tool side effect runs, the engine durably
//! appends [`SessionEvent::ToolCall`] (the intent); after the side effect
//! completes it appends [`SessionEvent::ToolResult`]. Recovery treats an
//! intent without a matching result as an unfinished call — never replayed.

use crate::message::{Message, Usage};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Durable session events. Everything model-visible is reconstructible from
/// this log (the "model-visible ⟺ logged" invariant).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    /// First line of every session file.
    SessionMeta {
        protocol_version: String,
        engine_version: String,
        cwd: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    UserMessage {
        message: Message,
    },
    AssistantMessage {
        message: Message,
        usage: Usage,
    },
    /// WAL intent — appended (with sync) *before* the tool side effect runs.
    ToolCall {
        call_id: String,
        name: String,
        arguments: serde_json::Value,
    },
    /// Outcome of a completed tool call.
    ToolResult {
        call_id: String,
        content: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        is_error: bool,
    },
    Error {
        message: String,
    },
    /// Compaction checkpoint: `first_kept_seq` marks where the surviving
    /// history begins after summarization.
    Compaction {
        summary: String,
        first_kept_seq: u64,
    },
}

/// One JSONL line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionEventEnvelope {
    /// Wall-clock milliseconds since the Unix epoch.
    pub ts_ms: u64,
    /// Monotonic sequence within the session; matches event-log order.
    pub seq: u64,
    pub session_id: String,
    pub event: SessionEvent,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{Block, Role};

    #[test]
    fn wal_intent_roundtrip() -> Result<(), serde_json::Error> {
        let line = SessionEventEnvelope {
            ts_ms: 1_760_000_000_000,
            seq: 7,
            session_id: "s_1".into(),
            event: SessionEvent::ToolCall {
                call_id: "call_1".into(),
                name: "bash".into(),
                arguments: serde_json::json!({"command": "cargo test"}),
            },
        };
        let json = serde_json::to_string(&line)?;
        let back: SessionEventEnvelope = serde_json::from_str(&json)?;
        assert_eq!(back, line);
        Ok(())
    }

    #[test]
    fn session_events_are_internally_tagged() -> Result<(), serde_json::Error> {
        let json = serde_json::to_value(SessionEvent::UserMessage {
            message: Message {
                role: Role::User,
                blocks: vec![Block::Text { text: "go".into() }],
            },
        })?;
        assert_eq!(json["type"], "user_message");
        Ok(())
    }
}
