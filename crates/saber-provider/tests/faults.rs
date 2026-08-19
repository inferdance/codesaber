//! Fault injection: the stream contract under failure — nothing panics,
//! malformed frames surface as terminal fatal errors, truncation produces a
//! best-effort Finish, and the retry wrapper recovers transient failures.

use futures::StreamExt;
use saber_provider::openai::{OpenAiCompatConfig, OpenAiCompatProvider};
use saber_provider::retry::{RetryPolicy, stream_with_retry};
use saber_provider::{ChatRequest, FinishReason, Provider, ProviderEvent, RetryKind};
use std::sync::Arc;
use std::time::Duration;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn sse(body: &'static str) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_string(body)
}

fn provider_for(server: &MockServer) -> Result<OpenAiCompatProvider, Box<dyn std::error::Error>> {
    let provider = OpenAiCompatProvider::new(OpenAiCompatConfig {
        name: "wiremock-openai".into(),
        base_url: server.uri(),
        api_key: "test-key".into(),
        default_model: "test-model".into(),
        request_timeout: None,
    })?;
    Ok(provider)
}

#[tokio::test]
async fn malformed_frame_is_terminal_fatal_error() -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(sse("data: {not json}\n\ndata: [DONE]\n\n"))
        .mount(&server)
        .await;
    let provider = provider_for(&server)?;
    let events: Vec<ProviderEvent> = provider
        .stream(ChatRequest::default())
        .await?
        .collect()
        .await;
    assert_eq!(events.len(), 1);
    match events.first() {
        Some(ProviderEvent::Error { retryable, .. }) => assert_eq!(*retryable, RetryKind::Fatal),
        other => panic!("expected an error event, got {other:?}"),
    }
    Ok(())
}

#[tokio::test]
async fn truncated_stream_emits_best_effort_finish() -> Result<(), Box<dyn std::error::Error>> {
    // Ends mid-line with neither a terminal SSE event nor [DONE].
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(sse(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"length\"}]}\n\ndata: {\"cho",
        ))
        .mount(&server)
        .await;
    let provider = provider_for(&server)?;
    let events: Vec<ProviderEvent> = provider
        .stream(ChatRequest::default())
        .await?
        .collect()
        .await;
    assert_eq!(
        events,
        vec![
            ProviderEvent::TextDelta {
                text: "partial".into()
            },
            ProviderEvent::Finish {
                reason: FinishReason::Length,
                usage: saber_protocol::Usage::default(),
            },
        ],
        "truncation must degrade to a Finish with observed state, never a panic"
    );
    Ok(())
}

#[tokio::test]
async fn retry_wrapper_recovers_transient_rate_limit() -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    // First attempt: 429. Later attempts: a clean minimal stream.
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(429).set_body_string("slow down"))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(sse("data: [DONE]\n\n"))
        .mount(&server)
        .await;

    let provider = Arc::from(provider_for(&server)?);
    let policy = RetryPolicy {
        max_attempts: 3,
        base_delay: Duration::from_millis(1),
    };
    let events: Vec<ProviderEvent> = stream_with_retry(provider, ChatRequest::default(), &policy)
        .await
        .collect()
        .await;

    assert_eq!(
        events,
        vec![ProviderEvent::Finish {
            reason: FinishReason::Stop,
            usage: saber_protocol::Usage::default(),
        }],
        "the retry wrapper must surface the recovered stream, not the 429"
    );
    Ok(())
}

#[tokio::test]
async fn retry_wrapper_gives_up_after_max_attempts() -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
        .mount(&server)
        .await;

    let provider = Arc::from(provider_for(&server)?);
    let policy = RetryPolicy {
        max_attempts: 2,
        base_delay: Duration::from_millis(1),
    };
    let events: Vec<ProviderEvent> = stream_with_retry(provider, ChatRequest::default(), &policy)
        .await
        .collect()
        .await;
    assert_eq!(events.len(), 1);
    match events.first() {
        Some(ProviderEvent::Error { retryable, .. }) => {
            assert_eq!(*retryable, RetryKind::ServerError)
        }
        other => panic!("expected an error event, got {other:?}"),
    }
    Ok(())
}
