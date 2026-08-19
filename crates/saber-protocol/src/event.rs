//! Engine event stream (spec §4.4): what every frontend renders. Events are
//! JSON-RPC notifications on the wire, wrapped in [`Event`] with a monotonic
//! `seq` (replay-on-reconnect is keyed on it) and the originating session.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Streaming deltas of an in-flight assistant response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AssistantDelta {
    /// Incremental text content.
    Text { text_delta: String },
    /// Incremental reasoning content.
    Thinking { thinking_delta: String },
    /// Incremental tool-call arguments; `name` arrives on the first delta
    /// for the call (arguments accumulate as concatenated strings).
    ToolCall {
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        arguments_delta: String,
    },
}

/// Everything the engine broadcasts to subscribed frontends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventMsg {
    TurnStarted {
        turn_id: String,
    },
    StepStarted {
        turn_id: String,
        step_id: String,
    },
    AssistantDelta {
        turn_id: String,
        step_id: String,
        delta: AssistantDelta,
    },
    ToolStarted {
        turn_id: String,
        step_id: String,
        call_id: String,
        name: String,
    },
    ToolOutputDelta {
        call_id: String,
        output_delta: String,
    },
    ToolCompleted {
        call_id: String,
        is_error: bool,
    },
    /// Context watermark; `context_window` is the effective window in tokens.
    TokenCount {
        context_tokens: u64,
        context_window: u64,
    },
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        recoverable: bool,
    },
    TurnComplete {
        turn_id: String,
        reason: TurnCompleteReason,
    },
}

/// Why a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TurnCompleteReason {
    /// Model produced a final answer with no pending tool calls.
    Done,
    /// User aborted (Esc / interrupt).
    AbortedByUser,
    /// Step budget exhausted; the loop forced a wrap-up.
    MaxStepsReached,
}

/// Wire envelope: one JSON-RPC notification payload per engine event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Event {
    /// Monotonic per-connection sequence number; frontends track the last
    /// seen seq and replay from it on reconnect.
    pub seq: u64,
    pub session_id: String,
    pub msg: EventMsg,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_envelope_roundtrip_and_tagging() -> Result<(), serde_json::Error> {
        let event = Event {
            seq: 42,
            session_id: "s_1".into(),
            msg: EventMsg::AssistantDelta {
                turn_id: "t_1".into(),
                step_id: "st_1".into(),
                delta: AssistantDelta::ToolCall {
                    call_id: "call_1".into(),
                    name: Some("bash".into()),
                    arguments_delta: "{\"cmd".into(),
                },
            },
        };
        let json = serde_json::to_value(&event)?;
        assert_eq!(json["msg"]["type"], "assistant_delta");
        assert_eq!(json["msg"]["delta"]["kind"], "tool_call");
        let back: Event = serde_json::from_value(json)?;
        assert_eq!(back, event);
        Ok(())
    }
}
