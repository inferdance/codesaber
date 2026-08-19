//! Internal message model (spec §3.1): the provider-agnostic currency of the
//! engine. Day-one depth — thinking blocks, tool calls/results, and images
//! are first-class; reasoning-effort and cache breakpoints are provider
//! adapter concerns mapped onto these types (see saber-provider).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Conversation role. Tool results ride inside messages as blocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

/// A single conversation turn contribution: a role plus ordered blocks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Message {
    pub role: Role,
    pub blocks: Vec<Block>,
}

/// Content blocks. Internally tagged (`"type"`) for a stable wire format.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    /// Plain text content.
    Text { text: String },
    /// Model reasoning. `signature` carries provider redacted-thinking
    /// payloads where applicable (e.g. Anthropic).
    Thinking {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    /// A model-initiated tool invocation.
    ToolCall {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    /// The observed outcome of a tool call, routed back to the model.
    ToolResult {
        call_id: String,
        content: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        is_error: bool,
    },
    /// Inline image content (base64). No audio/video by design (YAGNI list).
    Image {
        media_type: String,
        data_base64: String,
    },
}

/// Token and cost accounting for one model response.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// USD list-price cost of the response (static price table in engine
    /// config; f64 precision is sufficient for budget soft-warnings).
    pub cost_usd: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T>(value: &T) -> Result<T, serde_json::Error>
    where
        T: Clone + Serialize + serde::de::DeserializeOwned,
    {
        let json = serde_json::to_string(value)?;
        serde_json::from_str(&json)
    }

    #[test]
    fn message_roundtrips_with_every_block_kind() -> Result<(), serde_json::Error> {
        let message = Message {
            role: Role::Assistant,
            blocks: vec![
                Block::Text {
                    text: "editing file".into(),
                },
                Block::Thinking {
                    text: "locate the function first".into(),
                    signature: Some("sig".into()),
                },
                Block::ToolCall {
                    id: "call_1".into(),
                    name: "edit".into(),
                    arguments: serde_json::json!({"path": "src/main.rs"}),
                },
                Block::ToolResult {
                    call_id: "call_1".into(),
                    content: "applied".into(),
                    is_error: false,
                },
                Block::Image {
                    media_type: "image/png".into(),
                    data_base64: "aGk=".into(),
                },
            ],
        };
        assert_eq!(roundtrip(&message)?, message);
        Ok(())
    }

    #[test]
    fn blocks_are_internally_tagged_with_snake_case() -> Result<(), serde_json::Error> {
        let json = serde_json::to_value(Block::Text { text: "hi".into() })?;
        assert_eq!(json["type"], "text");
        Ok(())
    }
}
