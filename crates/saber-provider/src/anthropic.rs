//! Anthropic `/v1/messages` adapter with thinking-block and tool-use
//! support.
//!
//! Normalizes the event stream (`message_start` / `content_block_start` /
//! `content_block_delta` / `message_delta` / `message_stop`) into
//! [`ProviderEvent`]s. Tool-use blocks are keyed by content-block `index` →
//! `tool_use.id` (index clamped against hostile values). History `Thinking`
//! blocks (with signatures) replay as native `thinking` content;
//! `cache_control` breakpoints are supported on the system prompt.

use crate::sse::SseParser;
use crate::{
    ChatRequest, FinishReason, OwnedStream, Provider, ProviderError, ProviderEvent, ToolSchema,
    retry_kind_for_status,
};
use futures::channel::mpsc;
use futures::{SinkExt, StreamExt};
use saber_protocol::{Block, Message, Role, Usage};
use std::time::Duration;

pub const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_TOKENS: u64 = 8192;

/// Defensive cap: content-block indices beyond this fail as a terminal
/// fatal error instead of panicking on `resize`.
pub const MAX_CONTENT_BLOCKS: usize = 64;

/// Configuration for the Anthropic endpoint.
#[derive(Clone)]
pub struct AnthropicConfig {
    pub base_url: String,
    pub api_key: String,
    pub default_model: String,
    pub request_timeout: Option<Duration>,
    /// Optional price override; `None` falls back to the static table keyed
    /// by model name.
    pub pricing: Option<crate::pricing::Price>,
}

// Manual Debug: never print the API key.
impl std::fmt::Debug for AnthropicConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AnthropicConfig")
            .field("base_url", &self.base_url)
            .field("api_key", &"[REDACTED]")
            .field("default_model", &self.default_model)
            .field("request_timeout", &self.request_timeout)
            .field("pricing", &self.pricing)
            .finish()
    }
}

pub struct AnthropicProvider {
    config: AnthropicConfig,
    client: reqwest::Client,
}

impl AnthropicProvider {
    pub fn new(config: AnthropicConfig) -> Result<Self, ProviderError> {
        if config.base_url.is_empty() {
            return Err(ProviderError::Config {
                message: "base_url must not be empty".into(),
            });
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| ProviderError::Config {
                message: format!("client build failed: {e}"),
            })?;
        Ok(Self { config, client })
    }
}

fn to_anthropic_messages(messages: &[Message]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for message in messages {
        match message.role {
            Role::User => {
                let mut content = Vec::new();
                let mut text = String::new();
                let flush_text = |content: &mut Vec<serde_json::Value>, text: &mut String| {
                    if !text.is_empty() {
                        content.push(serde_json::json!({"type": "text", "text": text.clone()}));
                        text.clear();
                    }
                };
                for block in &message.blocks {
                    match block {
                        Block::Text { text: t } => text.push_str(t),
                        Block::ToolResult {
                            call_id,
                            content: c,
                            is_error,
                        } => {
                            flush_text(&mut content, &mut text);
                            content.push(serde_json::json!({
                                "type": "tool_result",
                                "tool_use_id": call_id,
                                "content": c,
                                "is_error": is_error,
                            }));
                        }
                        _ => {}
                    }
                }
                flush_text(&mut content, &mut text);
                if !content.is_empty() {
                    out.push(serde_json::json!({"role": "user", "content": content}));
                }
            }
            Role::Assistant => {
                let mut content = Vec::new();
                for block in &message.blocks {
                    match block {
                        Block::Text { text } => {
                            content.push(serde_json::json!({"type": "text", "text": text}))
                        }
                        Block::Thinking { text, signature } => content.push(serde_json::json!({
                            "type": "thinking",
                            "thinking": text,
                            "signature": signature.clone().unwrap_or_default(),
                        })),
                        Block::ToolCall {
                            id,
                            name,
                            arguments,
                        } => content.push(serde_json::json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": arguments,
                        })),
                        _ => {}
                    }
                }
                if !content.is_empty() {
                    out.push(serde_json::json!({"role": "assistant", "content": content}));
                }
            }
        }
    }
    out
}

/// Builds the request body (unit-testable without HTTP).
fn build_body(default_model: &str, request: &ChatRequest) -> serde_json::Value {
    let model = if request.model.is_empty() {
        default_model.to_owned()
    } else {
        request.model.clone()
    };
    let mut body = serde_json::json!({
        "model": model,
        "messages": to_anthropic_messages(&request.messages),
        "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "stream": true,
    });
    if let Some(system) = &request.system {
        if request.cache_system_prompt {
            body["system"] = serde_json::json!([{
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"},
            }]);
        } else {
            body["system"] = serde_json::json!(system);
        }
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }
    if let Some(budget) = request.thinking_budget_tokens {
        body["thinking"] = serde_json::json!({
            "type": "enabled",
            "budget_tokens": budget.max(1024),
        });
    }
    if !request.tools.is_empty() {
        body["tools"] = serde_json::json!(
            request
                .tools
                .iter()
                .map(|t: &ToolSchema| serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                }))
                .collect::<Vec<_>>()
        );
    }
    body
}

fn map_stop_reason(reason: Option<&str>) -> FinishReason {
    match reason {
        Some("tool_use") => FinishReason::ToolCalls,
        Some("max_tokens") => FinishReason::Length,
        _ => FinishReason::Stop,
    }
}

impl Provider for AnthropicProvider {
    fn name(&self) -> &str {
        "anthropic"
    }

    fn stream(
        &self,
        request: ChatRequest,
    ) -> futures::future::BoxFuture<'static, Result<crate::ProviderStream, ProviderError>> {
        let config = self.config.clone();
        let client = self.client.clone();
        Box::pin(async move {
            let url = format!("{}/v1/messages", config.base_url.trim_end_matches('/'));
            let body = build_body(&config.default_model, &request);
            let model = body["model"].as_str().unwrap_or_default().to_owned();
            let fallback_input = serde_json::to_string(&request.messages).unwrap_or_default();

            let (mut tx, rx) = mpsc::channel::<ProviderEvent>(64);
            macro_rules! emit {
                ($event:expr) => {
                    if tx.send($event).await.is_err() {
                        return;
                    }
                };
            }
            let handle = tokio::spawn(async move {
                let response = match client
                    .post(&url)
                    .header("x-api-key", &config.api_key)
                    .header("anthropic-version", ANTHROPIC_VERSION)
                    .timeout(config.request_timeout.unwrap_or(Duration::from_secs(600)))
                    .json(&body)
                    .send()
                    .await
                {
                    Ok(response) => response,
                    Err(e) => {
                        emit!(ProviderEvent::Error {
                            message: format!("request failed: {e}"),
                            retryable: crate::RetryKind::Network,
                        });
                        return;
                    }
                };
                let status = response.status();
                if !status.is_success() {
                    let body_text = response.text().await.unwrap_or_default();
                    emit!(ProviderEvent::Error {
                        message: format!("HTTP {status}: {body_text}"),
                        retryable: retry_kind_for_status(status.as_u16()),
                    });
                    return;
                }

                let mut parser = SseParser::new();
                let mut stream = response.bytes_stream();
                // content-block index → tool_use id.
                let mut block_tool_ids: Vec<Option<String>> = Vec::new();
                let mut usage = Usage::default();
                let mut stop_reason: Option<String> = None;

                while let Some(chunk) = stream.next().await {
                    let chunk = match chunk {
                        Ok(c) => c,
                        Err(e) => {
                            emit!(ProviderEvent::Error {
                                message: format!("stream failed: {e}"),
                                retryable: crate::RetryKind::Network,
                            });
                            return;
                        }
                    };
                    for payload in parser.feed(&chunk) {
                        let v: serde_json::Value = match serde_json::from_str(&payload) {
                            Ok(v) => v,
                            Err(e) => {
                                emit!(ProviderEvent::Error {
                                    message: format!("malformed SSE frame: {e}"),
                                    retryable: crate::RetryKind::Fatal,
                                });
                                return;
                            }
                        };
                        match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                            "message_start" => {
                                if let Some(u) = v.pointer("/message/usage") {
                                    usage.input_tokens =
                                        u.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                                    usage.cache_read_tokens = u
                                        .get("cache_read_input_tokens")
                                        .and_then(|x| x.as_u64())
                                        .unwrap_or(0);
                                    usage.cache_write_tokens = u
                                        .get("cache_creation_input_tokens")
                                        .and_then(|x| x.as_u64())
                                        .unwrap_or(0);
                                }
                            }
                            "content_block_start" => {
                                let index = match v.get("index").and_then(|i| i.as_u64()) {
                                    Some(index) if (index as usize) < MAX_CONTENT_BLOCKS => {
                                        index as usize
                                    }
                                    Some(index) => {
                                        emit!(ProviderEvent::Error {
                                            message: format!(
                                                "content block index {index} out of range (max {MAX_CONTENT_BLOCKS})"
                                            ),
                                            retryable: crate::RetryKind::Fatal,
                                        });
                                        return;
                                    }
                                    None => continue,
                                };
                                if block_tool_ids.len() <= index {
                                    block_tool_ids.resize(index + 1, None);
                                }
                                if v.pointer("/content_block/type").and_then(|t| t.as_str())
                                    == Some("tool_use")
                                {
                                    let id = v
                                        .pointer("/content_block/id")
                                        .and_then(|x| x.as_str())
                                        .unwrap_or("")
                                        .to_owned();
                                    let name = v
                                        .pointer("/content_block/name")
                                        .and_then(|x| x.as_str())
                                        .unwrap_or("")
                                        .to_owned();
                                    block_tool_ids[index] = Some(id.clone());
                                    emit!(ProviderEvent::ToolCallStart { id, name });
                                }
                            }
                            "content_block_delta" => {
                                let index = match v.get("index").and_then(|i| i.as_u64()) {
                                    Some(index) if (index as usize) < MAX_CONTENT_BLOCKS => {
                                        index as usize
                                    }
                                    // Deltas for out-of-range blocks are
                                    // dropped; the start already errored.
                                    _ => continue,
                                };
                                let Some(delta) = v.get("delta") else {
                                    continue;
                                };
                                match delta.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                                    "text_delta" => {
                                        if let Some(text) =
                                            delta.get("text").and_then(|t| t.as_str())
                                        {
                                            emit!(ProviderEvent::TextDelta {
                                                text_delta: text.to_owned(),
                                            });
                                        }
                                    }
                                    "thinking_delta" => {
                                        if let Some(text) =
                                            delta.get("thinking").and_then(|t| t.as_str())
                                        {
                                            emit!(ProviderEvent::ThinkingDelta {
                                                text_delta: text.to_owned(),
                                                signature: None,
                                            });
                                        }
                                    }
                                    "signature_delta" => {
                                        if let Some(sig) =
                                            delta.get("signature").and_then(|t| t.as_str())
                                        {
                                            emit!(ProviderEvent::ThinkingDelta {
                                                text_delta: String::new(),
                                                signature: Some(sig.to_owned()),
                                            });
                                        }
                                    }
                                    "input_json_delta" => {
                                        if let Some(json) =
                                            delta.get("partial_json").and_then(|t| t.as_str())
                                        {
                                            if !json.is_empty() {
                                                if let Some(Some(id)) = block_tool_ids.get(index) {
                                                    emit!(ProviderEvent::ToolCallDelta {
                                                        id: id.clone(),
                                                        arguments_delta: json.to_owned(),
                                                    });
                                                }
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            "message_delta" => {
                                if let Some(reason) =
                                    v.pointer("/delta/stop_reason").and_then(|r| r.as_str())
                                {
                                    stop_reason = Some(reason.to_owned());
                                }
                                if let Some(output) =
                                    v.pointer("/usage/output_tokens").and_then(|x| x.as_u64())
                                {
                                    usage.output_tokens = output;
                                }
                            }
                            "message_stop" => {
                                let usage = crate::pricing::finalize_usage(
                                    usage,
                                    &model,
                                    &fallback_input,
                                    config.pricing,
                                );
                                emit!(ProviderEvent::Finish {
                                    reason: map_stop_reason(stop_reason.as_deref()),
                                    usage,
                                });
                                return;
                            }
                            "error" => {
                                let message = v
                                    .pointer("/error/message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("provider error event");
                                emit!(ProviderEvent::Error {
                                    message: message.to_owned(),
                                    retryable: crate::RetryKind::ServerError,
                                });
                                return;
                            }
                            // ping and unknown events are ignored.
                            _ => {}
                        }
                    }
                }
                // Premature EOF (no message_stop): incomplete response —
                // terminal retryable error, never a synthetic success.
                emit!(ProviderEvent::Error {
                    message: "stream ended without message_stop".to_owned(),
                    retryable: crate::RetryKind::Network,
                });
            });

            Ok(OwnedStream::new(rx, handle).boxed())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_maps_thinking_history_tools_and_cache() {
        let request = ChatRequest {
            model: "claude-x".into(),
            system: Some("be terse".into()),
            messages: vec![Message {
                role: Role::Assistant,
                blocks: vec![
                    Block::Thinking {
                        text: "thought".into(),
                        signature: Some("sig".into()),
                    },
                    Block::ToolCall {
                        id: "call_1".into(),
                        name: "bash".into(),
                        arguments: serde_json::json!({"command": "ls"}),
                    },
                ],
            }],
            tools: Vec::new(),
            max_tokens: None,
            temperature: None,
            thinking_budget_tokens: Some(2048),
            cache_system_prompt: true,
        };
        let body = build_body("default", &request);
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(body["thinking"]["budget_tokens"], 2048);
        let content = &body["messages"][0]["content"];
        assert_eq!(content[0]["type"], "thinking");
        assert_eq!(content[0]["signature"], "sig");
        assert_eq!(content[1]["type"], "tool_use");
        assert_eq!(content[1]["input"]["command"], "ls");
    }

    #[test]
    fn body_defaults_without_cache_flag() {
        let request = ChatRequest {
            system: Some("s".into()),
            cache_system_prompt: false,
            ..ChatRequest::default()
        };
        let body = build_body("default", &request);
        assert_eq!(body["system"], "s");
    }
}
