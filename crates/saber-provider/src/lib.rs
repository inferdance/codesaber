//! Model access layer (M0-T3): the provider abstraction with two wire
//! adapters (OpenAI-compatible chat completions, Anthropic Messages) plus a
//! mock provider for offline engine tests.
//!
//! Stream contract (pi-style): **errors are encoded into the stream as
//! terminal [`ProviderEvent::Error`] events — nothing across this boundary
//! ever panics.** Pre-stream failures (HTTP status, network) also surface as
//! the stream's first event so callers and the retry wrapper treat one shape.
//! [`Provider::stream`] itself only fails fast on programmer errors (bad
//! config).
//!
//! HTTP: reqwest 0.13 with rustls; SSE parsing is in-crate (`sse.rs`) because
//! LLM streams are just `data:` lines plus `[DONE]` and reqwest-eventsource
//! is unmaintained.

pub mod anthropic;
pub mod mock;
pub mod openai;
pub mod pricing;
pub mod retry;
pub mod sse;

use futures::future::BoxFuture;
use futures::stream::BoxStream;
use saber_protocol::{Message, Usage};
use serde::{Deserialize, Serialize};

/// A tool advertised to the model (JSON-Schema parameters).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Normalized completion request. Provider specifics (thinking params,
/// cache breakpoints) are mapped by each adapter from these fields.
#[derive(Debug, Clone, Default)]
pub struct ChatRequest {
    pub model: String,
    /// System prompt (prompt assembly happens in saber-core).
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSchema>,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    /// Provider-agnostic reasoning budget; adapters map to native knobs
    /// (Anthropic `thinking.budget_tokens`, reasoning-effort elsewhere).
    pub thinking_budget_tokens: Option<u64>,
}

/// Why a model response finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    /// Natural end of the assistant message.
    Stop,
    /// The model requested tool executions.
    ToolCalls,
    /// Token limit hit (engines must refuse to execute truncated tool
    /// calls — the loop defense from the spec).
    Length,
}

/// How retryable a failure is. Drives the backoff wrapper.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryKind {
    RateLimit,
    Timeout,
    ServerError,
    Network,
    /// Not retryable (bad request, auth, malformed stream).
    Fatal,
}

/// Unified provider streaming event. Terminal: after `Finish` or `Error`
/// the stream ends.
#[derive(Debug, Clone, PartialEq)]
pub enum ProviderEvent {
    TextDelta {
        text: String,
    },
    ThinkingDelta {
        text: String,
    },
    ToolCallStart {
        id: String,
        name: String,
    },
    /// `arguments_delta` fragments concatenate; the result must parse as
    /// JSON before execution (guards truncated calls).
    ToolCallDelta {
        id: String,
        arguments_delta: String,
    },
    Finish {
        reason: FinishReason,
        usage: Usage,
    },
    Error {
        message: String,
        retryable: RetryKind,
    },
}

/// Failures that prevent a stream from starting at all (misconfiguration).
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("invalid provider config: {0}")]
    Config(String),
}

pub type ProviderStream = BoxStream<'static, ProviderEvent>;

/// A model backend. Implementations: [`openai::OpenAiCompatProvider`],
/// [`anthropic::AnthropicProvider`], [`mock::MockProvider`].
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;

    /// Starts a streamed completion. All runtime failures arrive as the
    /// first (or terminal) [`ProviderEvent::Error`].
    fn stream(
        &self,
        request: ChatRequest,
    ) -> BoxFuture<'static, Result<ProviderStream, ProviderError>>;
}

/// Maps an HTTP status to a retry classification.
pub fn retry_kind_for_status(status: u16) -> RetryKind {
    match status {
        408 | 504 => RetryKind::Timeout,
        429 => RetryKind::RateLimit,
        500..=599 => RetryKind::ServerError,
        _ => RetryKind::Fatal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_classification() {
        assert_eq!(retry_kind_for_status(429), RetryKind::RateLimit);
        assert_eq!(retry_kind_for_status(503), RetryKind::ServerError);
        assert_eq!(retry_kind_for_status(408), RetryKind::Timeout);
        assert_eq!(retry_kind_for_status(400), RetryKind::Fatal);
    }
}
