//! Shared helpers for provider integration tests.

use saber_protocol::Usage;
use saber_provider::{FinishReason, ProviderEvent};

pub fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

/// The semantically identical session both wire fixtures express — the
/// cross-adapter normalization contract (plan T3 acceptance).
#[allow(dead_code)] // each integration-test binary compiles this module independently
pub fn expected_common_sequence() -> Vec<ProviderEvent> {
    vec![
        ProviderEvent::ThinkingDelta {
            text_delta: "locate the function".into(),
            signature: None,
        },
        ProviderEvent::TextDelta {
            text_delta: "Editing ".into(),
        },
        ProviderEvent::TextDelta {
            text_delta: "the file".into(),
        },
        ProviderEvent::ToolCallStart {
            id: "call_1".into(),
            name: "edit".into(),
        },
        ProviderEvent::ToolCallDelta {
            id: "call_1".into(),
            arguments_delta: "{\"path\":".into(),
        },
        ProviderEvent::ToolCallDelta {
            id: "call_1".into(),
            arguments_delta: "\"a.rs\"}".into(),
        },
        ProviderEvent::Finish {
            reason: FinishReason::ToolCalls,
            usage: Usage {
                input_tokens: 100,
                output_tokens: 25,
                cache_read_tokens: 40,
                cache_write_tokens: 0,
                cost_usd: 0.0,
            },
        },
    ]
}
