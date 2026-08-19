//! OpenAI-compatible `/chat/completions` adapter (covers OpenAI, DeepSeek,
//! Kimi/Moonshot, GLM, OpenRouter, and every gateway speaking this dialect).
//!
//! Normalizes `choices[0].delta` into [`ProviderEvent`]s: `content` →
//! text deltas, `reasoning_content`/`reasoning` (DeepSeek-style) → thinking
//! deltas, `tool_calls[]` (keyed by `index` → `id`, index clamped against
//! hostile values) → tool-call start/delta. `stream_options.include_usage`
//! captures token usage in the final chunk.

use crate::sse::SseParser;
use crate::{
    ChatRequest, FinishReason, OwnedStream, Provider, ProviderError, ProviderEvent, ToolSchema,
    retry_kind_for_status,
};
use futures::channel::mpsc;
use futures::{SinkExt, StreamExt};
use saber_protocol::{Block, Message, Role, Usage};
use std::time::Duration;

/// Defensive cap on concurrent tool calls in one response; indices beyond
/// this (hostile/garbage SSE) fail as a terminal fatal error instead of
/// panicking on `resize` or allocating gigabytes.
pub const MAX_TOOL_CALLS: usize = 64;

/// Configuration for one OpenAI-compatible endpoint.
#[derive(Clone)]
pub struct OpenAiCompatConfig {
    /// Provider display name (e.g. "openai", "deepseek", "openrouter").
    pub name: String,
    pub base_url: String,
    /// API key supplied by the engine (Keychain/env resolution lives above
    /// this layer; keys never reach tool subprocesses).
    pub api_key: String,
    pub default_model: String,
    pub request_timeout: Option<Duration>,
    /// Optional price override; `None` falls back to the static table keyed
    /// by model name.
    pub pricing: Option<crate::pricing::Price>,
}

// Manual Debug: never print the API key (logs, panic contexts, diagnostics).
impl std::fmt::Debug for OpenAiCompatConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAiCompatConfig")
            .field("name", &self.name)
            .field("base_url", &self.base_url)
            .field("api_key", &"[REDACTED]")
            .field("default_model", &self.default_model)
            .field("request_timeout", &self.request_timeout)
            .field("pricing", &self.pricing)
            .finish()
    }
}

pub struct OpenAiCompatProvider {
    config: OpenAiCompatConfig,
    client: reqwest::Client,
}

impl OpenAiCompatProvider {
    pub fn new(config: OpenAiCompatConfig) -> Result<Self, ProviderError> {
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

/// Converts internal messages to the OpenAI wire shape, preserving block
/// order: accumulated user text flushes before any tool-result message that
/// follows it (and vice versa).
pub fn to_openai_messages(system: Option<&str>, messages: &[Message]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    if let Some(system) = system {
        out.push(serde_json::json!({"role": "system", "content": system}));
    }
    for message in messages {
        match message.role {
            Role::User => {
                let mut text = String::new();
                let flush_text = |out: &mut Vec<serde_json::Value>, text: &mut String| {
                    if !text.is_empty() {
                        out.push(serde_json::json!({"role": "user", "content": text.clone()}));
                        text.clear();
                    }
                };
                for block in &message.blocks {
                    match block {
                        Block::Text { text: t } => text.push_str(t),
                        Block::ToolResult {
                            call_id, content, ..
                        } => {
                            flush_text(&mut out, &mut text);
                            out.push(serde_json::json!({
                                "role": "tool",
                                "tool_call_id": call_id,
                                "content": content,
                            }));
                        }
                        _ => {}
                    }
                }
                flush_text(&mut out, &mut text);
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
                        // OpenAI-compatible endpoints have no history
                        // thinking replay; the dialect drops it.
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

/// Builds the request body (unit-testable without HTTP).
fn build_body(default_model: &str, request: &ChatRequest) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": if request.model.is_empty() { default_model.to_owned() } else { request.model.clone() },
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
    body
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
    ) -> futures::future::BoxFuture<'static, Result<crate::ProviderStream, ProviderError>> {
        let config = self.config.clone();
        let client = self.client.clone();
        Box::pin(async move {
            let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
            let body = build_body(&config.default_model, &request);
            let model = body["model"].as_str().unwrap_or_default().to_owned();
            let fallback_input = serde_json::to_string(&request.messages).unwrap_or_default();

            let (mut tx, rx) = mpsc::channel::<ProviderEvent>(64);
            macro_rules! emit {
                ($event:expr) => {
                    // Receiver dropped (consumer cancelled): stop reading
                    // immediately instead of draining a dead stream.
                    if tx.send($event).await.is_err() {
                        return;
                    }
                };
            }
            let handle = tokio::spawn(async move {
                let response = match client
                    .post(&url)
                    .bearer_auth(&config.api_key)
                    .header("content-type", "application/json")
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
                // index → tool call id for delta routing.
                let mut tool_ids: Vec<Option<String>> = Vec::new();
                let mut finish_reason: Option<String> = None;
                let mut usage = Usage::default();

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
                        if payload == "[DONE]" {
                            let usage = crate::pricing::finalize_usage(
                                usage,
                                &model,
                                &fallback_input,
                                config.pricing,
                            );
                            emit!(ProviderEvent::Finish {
                                reason: map_finish_reason(finish_reason.as_deref()),
                                usage,
                            });
                            return;
                        }
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
                                emit!(ProviderEvent::TextDelta {
                                    text_delta: text.to_owned(),
                                });
                            }
                        }
                        // DeepSeek-style reasoning streams.
                        let thinking = delta
                            .get("reasoning_content")
                            .or_else(|| delta.get("reasoning"))
                            .and_then(|r| r.as_str());
                        if let Some(thinking) = thinking {
                            if !thinking.is_empty() {
                                emit!(ProviderEvent::ThinkingDelta {
                                    text_delta: thinking.to_owned(),
                                    signature: None,
                                });
                            }
                        }
                        if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
                            for call in calls {
                                let Some(index) = call.get("index").and_then(|i| i.as_u64()) else {
                                    continue;
                                };
                                if index as usize >= MAX_TOOL_CALLS {
                                    emit!(ProviderEvent::Error {
                                        message: format!(
                                            "tool call index {index} out of range (max {MAX_TOOL_CALLS})"
                                        ),
                                        retryable: crate::RetryKind::Fatal,
                                    });
                                    return;
                                }
                                let index = index as usize;
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
                                    emit!(ProviderEvent::ToolCallStart {
                                        id: id.to_owned(),
                                        name: name.to_owned(),
                                    });
                                }
                                if let Some(args_delta) = function
                                    .and_then(|f| f.get("arguments"))
                                    .and_then(|a| a.as_str())
                                {
                                    if !args_delta.is_empty() {
                                        if let Some(Some(id)) = tool_ids.get(index) {
                                            emit!(ProviderEvent::ToolCallDelta {
                                                id: id.clone(),
                                                arguments_delta: args_delta.to_owned(),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // Premature EOF (no [DONE]): the response is incomplete —
                // surface it as a retryable terminal error after the deltas
                // already delivered, never as a synthetic success.
                emit!(ProviderEvent::Error {
                    message: "stream ended without [DONE]".to_owned(),
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
    fn user_text_flushes_before_following_tool_result() {
        let messages = vec![Message {
            role: Role::User,
            blocks: vec![
                Block::Text {
                    text: "before".into(),
                },
                Block::ToolResult {
                    call_id: "call_1".into(),
                    content: "ok".into(),
                    is_error: false,
                },
                Block::Text {
                    text: "after".into(),
                },
            ],
        }];
        let wire = to_openai_messages(None, &messages);
        let roles: Vec<(String, String)> = wire
            .iter()
            .map(|m| {
                (
                    m["role"].as_str().unwrap_or_default().to_owned(),
                    m["tool_call_id"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        assert_eq!(
            roles,
            vec![
                ("user".to_owned(), String::new()),
                ("tool".to_owned(), "call_1".to_owned()),
                ("user".to_owned(), String::new()),
            ],
            "block order must be preserved across the tool result"
        );
        assert_eq!(wire[0]["content"], "before");
        assert_eq!(wire[2]["content"], "after");
    }

    #[test]
    fn body_includes_system_tools_and_defaults() {
        let request = ChatRequest {
            model: "m".into(),
            system: Some("be terse".into()),
            messages: Vec::new(),
            tools: vec![ToolSchema {
                name: "bash".into(),
                description: "run".into(),
                parameters: serde_json::json!({"type": "object"}),
            }],
            max_tokens: Some(128),
            temperature: None,
            thinking_budget_tokens: None,
            cache_system_prompt: true,
        };
        let body = build_body("default-m", &request);
        assert_eq!(body["model"], "m");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["tools"][0]["function"]["name"], "bash");
        assert_eq!(body["max_tokens"], 128);
        assert_eq!(body["stream"], true);
    }
}
