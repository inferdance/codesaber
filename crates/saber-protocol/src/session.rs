//! Session log schema (spec §4.5, WAL semantics): the append-only JSONL
//! event stream is the single source of truth for every session. One line =
//! one [`SessionEventEnvelope`], serialized exactly as
//! `{"ts":..,"seq":..,"session_id":..,"type":..,"payload":{..}}` (the
//! envelope flattens an adjacently-tagged event: tag `type`, content
//! `payload`).
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
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
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

/// One JSONL line: `{"ts":..,"seq":..,"session_id":..,"type":..,"payload":{..}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionEventEnvelope {
    /// Wall-clock milliseconds since the Unix epoch (contract field: `ts`).
    pub ts: u64,
    /// Monotonic sequence within the session; matches event-log order.
    pub seq: u64,
    pub session_id: String,
    /// Flattened adjacently-tagged event: contributes the top-level `type`
    /// discriminator and the `payload` object.
    #[serde(flatten)]
    pub event: SessionEvent,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{Block, Role};

    fn sample_wal_line() -> SessionEventEnvelope {
        SessionEventEnvelope {
            ts: 1_760_000_000_000,
            seq: 7,
            session_id: "s_1".into(),
            event: SessionEvent::ToolCall {
                call_id: "call_1".into(),
                name: "bash".into(),
                arguments: serde_json::json!({"command": "cargo test"}),
            },
        }
    }

    #[test]
    fn wal_intent_roundtrip() -> Result<(), serde_json::Error> {
        let line = sample_wal_line();
        let json = serde_json::to_string(&line)?;
        let back: SessionEventEnvelope = serde_json::from_str(&json)?;
        assert_eq!(back, line);
        Ok(())
    }

    #[test]
    fn envelope_has_exact_contract_shape() -> Result<(), serde_json::Error> {
        let json = serde_json::to_value(sample_wal_line())?;
        assert_eq!(
            json,
            serde_json::json!({
                "ts": 1_760_000_000_000_u64,
                "seq": 7,
                "session_id": "s_1",
                "type": "tool_call",
                "payload": {
                    "call_id": "call_1",
                    "name": "bash",
                    "arguments": {"command": "cargo test"}
                }
            }),
            "session JSONL lines must be {{ts, seq, session_id, type, payload}} exactly"
        );
        Ok(())
    }

    #[test]
    fn user_message_envelope_shape() -> Result<(), serde_json::Error> {
        let line = SessionEventEnvelope {
            ts: 1,
            seq: 1,
            session_id: "s_1".into(),
            event: SessionEvent::UserMessage {
                message: Message {
                    role: Role::User,
                    blocks: vec![Block::Text { text: "go".into() }],
                },
            },
        };
        let json = serde_json::to_value(&line)?;
        assert_eq!(json["type"], "user_message");
        assert_eq!(json["payload"]["message"]["role"], "user");
        let back: SessionEventEnvelope = serde_json::from_value(json)?;
        assert_eq!(back, line);
        Ok(())
    }
}
