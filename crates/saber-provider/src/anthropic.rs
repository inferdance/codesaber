//! Anthropic `/v1/messages` adapter with thinking-block and tool-use
//! support.
//!
//! Normalizes the event stream (`message_start` / `content_block_start` /
//! `content_block_delta` / `message_delta` / `message_stop`) into
//! [`ProviderEvent`]s. Tool-use blocks are keyed by content-block `index` →
//! `tool_use.id`. Cache accounting maps `cache_read_input_tokens` /
//! `cache_creation_input_tokens` directly.

use crate::sse::SseParser;
use crate::{
    ChatRequest, FinishReason, Provider, ProviderError, ProviderEvent, ProviderStream, ToolSchema,
    retry_kind_for_status,
};
use futures::channel::mpsc;
use futures::{SinkExt, StreamExt};
use saber_protocol::{Block, Message, Role, Usage};
use std::time::Duration;

pub const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_TOKENS: u64 = 8192;

#[derive(Debug, Clone)]
pub struct AnthropicConfig {
    pub base_url: String,
    pub api_key: String,
    pub default_model: String,
    pub request_timeout: Option<Duration>,
}

pub struct AnthropicProvider {
    config: AnthropicConfig,
    client: reqwest::Client,
}

impl AnthropicProvider {
    pub fn new(config: AnthropicConfig) -> Result<Self, ProviderError> {
        if config.base_url.is_empty() {
            return Err(ProviderError::Config("base_url must not be empty".into()));
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| ProviderError::Config(format!("client build failed: {e}")))?;
        Ok(Self { config, client })
    }
}

fn to_anthropic_messages(messages: &[Message]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for message in messages {
        match message.role {
            Role::User => {
                let mut content = Vec::new();
                let mut text_only = String::new();
                for block in &message.blocks {
                    match block {
                        Block::Text { text } => text_only.push_str(text),
                        Block::ToolResult {
                            call_id,
                            content: c,
                            is_error,
                        } => {
                            if !text_only.is_empty() {
                                content
                                    .push(serde_json::json!({"type": "text", "text": text_only}));
                                text_only = String::new();
                            }
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
                if !text_only.is_empty() {
                    content.push(serde_json::json!({"type": "text", "text": text_only}));
                }
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
    ) -> futures::future::BoxFuture<'static, Result<ProviderStream, ProviderError>> {
        let config = self.config.clone();
        let client = self.client.clone();
        Box::pin(async move {
            let url = format!("{}/v1/messages", config.base_url.trim_end_matches('/'));
            let model = if request.model.is_empty() {
                config.default_model.clone()
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
                body["system"] = serde_json::json!(system);
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

            let (mut tx, rx) = mpsc::channel::<ProviderEvent>(64);
            tokio::spawn(async move {
                let result = client
                    .post(&url)
                    .header("x-api-key", &config.api_key)
                    .header("anthropic-version", ANTHROPIC_VERSION)
                    .timeout(config.request_timeout.unwrap_or(Duration::from_secs(600)))
                    .json(&body)
                    .send()
                    .await;
                let response = match result {
                    Ok(response) => response,
                    Err(e) => {
                        let _ = tx
                            .send(ProviderEvent::Error {
                                message: format!("request failed: {e}"),
                                retryable: crate::RetryKind::Network,
                            })
                            .await;
                        return;
                    }
                };
                let status = response.status();
                if !status.is_success() {
                    let body_text = response.text().await.unwrap_or_default();
                    let _ = tx
                        .send(ProviderEvent::Error {
                            message: format!("HTTP {status}: {body_text}"),
                            retryable: retry_kind_for_status(status.as_u16()),
                        })
                        .await;
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
                            let _ = tx
                                .send(ProviderEvent::Error {
                                    message: format!("stream failed: {e}"),
                                    retryable: crate::RetryKind::Network,
                                })
                                .await;
                            return;
                        }
                    };
                    for payload in parser.feed(&chunk) {
                        let v: serde_json::Value = match serde_json::from_str(&payload) {
                            Ok(v) => v,
                            Err(e) => {
                                let _ = tx
                                    .send(ProviderEvent::Error {
                                        message: format!("malformed SSE frame: {e}"),
                                        retryable: crate::RetryKind::Fatal,
                                    })
                                    .await;
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
                                let index =
                                    v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
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
                                    let _ =
                                        tx.send(ProviderEvent::ToolCallStart { id, name }).await;
                                }
                            }
                            "content_block_delta" => {
                                let index =
                                    v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                                let Some(delta) = v.get("delta") else {
                                    continue;
                                };
                                match delta.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                                    "text_delta" => {
                                        if let Some(text) =
                                            delta.get("text").and_then(|t| t.as_str())
                                        {
                                            let _ = tx
                                                .send(ProviderEvent::TextDelta {
                                                    text: text.to_owned(),
                                                })
                                                .await;
                                        }
                                    }
                                    "thinking_delta" => {
                                        if let Some(text) =
                                            delta.get("thinking").and_then(|t| t.as_str())
                                        {
                                            let _ = tx
                                                .send(ProviderEvent::ThinkingDelta {
                                                    text: text.to_owned(),
                                                })
                                                .await;
                                        }
                                    }
                                    "input_json_delta" => {
                                        if let Some(json) =
                                            delta.get("partial_json").and_then(|t| t.as_str())
                                        {
                                            if !json.is_empty() {
                                                if let Some(Some(id)) = block_tool_ids.get(index) {
                                                    let _ = tx
                                                        .send(ProviderEvent::ToolCallDelta {
                                                            id: id.clone(),
                                                            arguments_delta: json.to_owned(),
                                                        })
                                                        .await;
                                                }
                                            }
                                        }
                                    }
                                    // signature_delta and others are
                                    // carried in the session log upstream.
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
                                let _ = tx
                                    .send(ProviderEvent::Finish {
                                        reason: map_stop_reason(stop_reason.as_deref()),
                                        usage,
                                    })
                                    .await;
                                return;
                            }
                            "error" => {
                                let message = v
                                    .pointer("/error/message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("provider error event");
                                let _ = tx
                                    .send(ProviderEvent::Error {
                                        message: message.to_owned(),
                                        retryable: crate::RetryKind::ServerError,
                                    })
                                    .await;
                                return;
                            }
                            // ping and unknown events are ignored.
                            _ => {}
                        }
                    }
                }
                // Stream ended without message_stop (truncation): finish
                // with what we observed — never panic.
                let _ = tx
                    .send(ProviderEvent::Finish {
                        reason: map_stop_reason(stop_reason.as_deref()),
                        usage,
                    })
                    .await;
            });

            Ok(rx.boxed())
        })
    }
}
