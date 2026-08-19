//! OpenAI-compatible `/chat/completions` adapter (covers OpenAI, DeepSeek,
//! Kimi/Moonshot, GLM, OpenRouter, and every gateway speaking this dialect).
//!
//! Normalizes `choices[0].delta` into [`ProviderEvent`]s: `content` →
//! text deltas, `reasoning_content`/`reasoning` (DeepSeek-style) → thinking
//! deltas, `tool_calls[]` (keyed by `index` → `id`) → tool-call start/delta.
//! `stream_options.include_usage` captures token usage in the final chunk.

use crate::sse::SseParser;
use crate::{
    ChatRequest, FinishReason, Provider, ProviderError, ProviderEvent, ProviderStream, ToolSchema,
    retry_kind_for_status,
};
use futures::channel::mpsc;
use futures::{SinkExt, StreamExt};
use saber_protocol::{Block, Message, Role, Usage};
use std::time::Duration;

/// Configuration for one OpenAI-compatible endpoint.
#[derive(Debug, Clone)]
pub struct OpenAiCompatConfig {
    /// Provider display name (e.g. "openai", "deepseek", "openrouter").
    pub name: String,
    pub base_url: String,
    /// API key supplied by the engine (Keychain/env resolution lives above
    /// this layer; keys never reach tool subprocesses).
    pub api_key: String,
    pub default_model: String,
    pub request_timeout: Option<Duration>,
}

pub struct OpenAiCompatProvider {
    config: OpenAiCompatConfig,
    client: reqwest::Client,
}

impl OpenAiCompatProvider {
    pub fn new(config: OpenAiCompatConfig) -> Result<Self, ProviderError> {
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

/// Converts internal messages to the OpenAI wire shape. Assistant tool
/// calls become `tool_calls`; tool-result blocks split into their own
/// `role:"tool"` messages, preserving order.
fn to_openai_messages(system: Option<&str>, messages: &[Message]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    if let Some(system) = system {
        out.push(serde_json::json!({"role": "system", "content": system}));
    }
    for message in messages {
        match message.role {
            Role::User => {
                let text = message
                    .blocks
                    .iter()
                    .filter_map(|b| match b {
                        Block::Text { text } => Some(text.as_str()),
                        Block::ToolResult {
                            call_id, content, ..
                        } => {
                            out.push(serde_json::json!({
                                "role": "tool",
                                "tool_call_id": call_id,
                                "content": content,
                            }));
                            None
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.is_empty() {
                    out.push(serde_json::json!({"role": "user", "content": text}));
                }
            }
            Role::Assistant => {
                let mut text = String::new();
                let mut tool_calls = Vec::new();
                for block in &message.blocks {
                    match block {
                        Block::Text { text: t } => text.push_str(t),
                        Block::ToolCall {
                            id,
                            name,
                            arguments,
                        } => tool_calls.push(serde_json::json!({
                            "id": id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": arguments.to_string(),
                            },
                        })),
                        _ => {}
                    }
                }
                if !text.is_empty() || !tool_calls.is_empty() {
                    out.push(serde_json::json!({
                        "role": "assistant",
                        "content": if text.is_empty() { serde_json::Value::Null } else { serde_json::json!(text) },
                        "tool_calls": tool_calls,
                    }));
                }
            }
        }
    }
    out
}

fn tools_to_openai(tools: &[ToolSchema]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            })
        })
        .collect()
}

fn map_usage(v: &serde_json::Value) -> Usage {
    let prompt = v.get("prompt_tokens").and_then(|x| x.as_u64());
    let completion = v.get("completion_tokens").and_then(|x| x.as_u64());
    let cached = v
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|x| x.as_u64());
    Usage {
        input_tokens: prompt.unwrap_or(0),
        output_tokens: completion.unwrap_or(0),
        cache_read_tokens: cached.unwrap_or(0),
        cache_write_tokens: 0,
        cost_usd: 0.0,
    }
}

fn map_finish_reason(reason: Option<&str>) -> FinishReason {
    match reason {
        Some("tool_calls") => FinishReason::ToolCalls,
        Some("length") => FinishReason::Length,
        _ => FinishReason::Stop,
    }
}

impl Provider for OpenAiCompatProvider {
    fn name(&self) -> &str {
        &self.config.name
    }

    fn stream(
        &self,
        request: ChatRequest,
    ) -> futures::future::BoxFuture<'static, Result<ProviderStream, ProviderError>> {
        let config = self.config.clone();
        let client = self.client.clone();
        Box::pin(async move {
            let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
            let mut body = serde_json::json!({
                "model": if request.model.is_empty() { config.default_model.clone() } else { request.model.clone() },
                "messages": to_openai_messages(request.system.as_deref(), &request.messages),
                "stream": true,
                "stream_options": {"include_usage": true},
            });
            if !request.tools.is_empty() {
                body["tools"] = serde_json::json!(tools_to_openai(&request.tools));
            }
            if let Some(max_tokens) = request.max_tokens {
                body["max_tokens"] = serde_json::json!(max_tokens);
            }
            if let Some(temperature) = request.temperature {
                body["temperature"] = serde_json::json!(temperature);
            }

            let (mut tx, rx) = mpsc::channel::<ProviderEvent>(64);
            tokio::spawn(async move {
                let result = client
                    .post(&url)
                    .bearer_auth(&config.api_key)
                    .header("content-type", "application/json")
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
                // index → tool call id for delta routing.
                let mut tool_ids: Vec<Option<String>> = Vec::new();
                let mut finish_reason: Option<String> = None;
                let mut usage = Usage::default();

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
                        if payload == "[DONE]" {
                            let _ = tx
                                .send(ProviderEvent::Finish {
                                    reason: map_finish_reason(finish_reason.as_deref()),
                                    usage,
                                })
                                .await;
                            return;
                        }
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
                        if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
                            usage = map_usage(u);
                        }
                        let choice = match v.pointer("/choices/0") {
                            Some(choice) if !choice.is_null() => choice.clone(),
                            _ => continue,
                        };
                        if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
                            finish_reason = Some(reason.to_owned());
                        }
                        let Some(delta) = choice.get("delta") else {
                            continue;
                        };
                        if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
                            if !text.is_empty() {
                                let _ = tx
                                    .send(ProviderEvent::TextDelta {
                                        text: text.to_owned(),
                                    })
                                    .await;
                            }
                        }
                        // DeepSeek-style reasoning streams.
                        let thinking = delta
                            .get("reasoning_content")
                            .or_else(|| delta.get("reasoning"))
                            .and_then(|r| r.as_str());
                        if let Some(thinking) = thinking {
                            if !thinking.is_empty() {
                                let _ = tx
                                    .send(ProviderEvent::ThinkingDelta {
                                        text: thinking.to_owned(),
                                    })
                                    .await;
                            }
                        }
                        if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
                            for call in calls {
                                let index = call.get("index").and_then(|i| i.as_u64()).unwrap_or(0)
                                    as usize;
                                if tool_ids.len() <= index {
                                    tool_ids.resize(index + 1, None);
                                }
                                let function = call.get("function");
                                let id = call.get("id").and_then(|i| i.as_str());
                                let name = function
                                    .and_then(|f| f.get("name"))
                                    .and_then(|n| n.as_str());
                                if let (Some(id), Some(name)) = (id, name) {
                                    tool_ids[index] = Some(id.to_owned());
                                    let _ = tx
                                        .send(ProviderEvent::ToolCallStart {
                                            id: id.to_owned(),
                                            name: name.to_owned(),
                                        })
                                        .await;
                                }
                                if let Some(args_delta) = function
                                    .and_then(|f| f.get("arguments"))
                                    .and_then(|a| a.as_str())
                                {
                                    if !args_delta.is_empty() {
                                        if let Some(Some(id)) = tool_ids.get(index) {
                                            let _ = tx
                                                .send(ProviderEvent::ToolCallDelta {
                                                    id: id.clone(),
                                                    arguments_delta: args_delta.to_owned(),
                                                })
                                                .await;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // Stream ended without [DONE] (truncation/flush): emit a
                // Finish with what we observed — never panic.
                let _ = tx
                    .send(ProviderEvent::Finish {
                        reason: map_finish_reason(finish_reason.as_deref()),
                        usage,
                    })
                    .await;
            });

            Ok(rx.boxed())
        })
    }
}
