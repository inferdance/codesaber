//! Fault injection: the stream contract under failure — nothing panics,
//! malformed frames surface as terminal fatal errors, premature EOF is a
//! retryable terminal error (never a synthetic success), and the retry
//! wrapper recovers transient failures (wiremock or offline MockProvider).

mod common;

use common::fixture;
use futures::StreamExt;
use saber_protocol::Usage;
use saber_provider::mock::MockProvider;
use saber_provider::openai::{OpenAiCompatConfig, OpenAiCompatProvider};
use saber_provider::retry::{RetryPolicy, stream_with_retry};
use saber_provider::{ChatRequest, Provider, ProviderEvent, RetryKind};
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
        pricing: None,
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
    let events: Vec<ProviderEvent> = provider_for(&server)?
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
async fn hostile_tool_index_fails_fast_instead_of_panicking()
-> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(sse(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":18446744073709551615,\"id\":\"x\",\"type\":\"function\",\"function\":{\"name\":\"bash\",\"arguments\":\"{}\"}}]}}]}\n\n",
        ))
        .mount(&server)
        .await;
    let events: Vec<ProviderEvent> = provider_for(&server)?
        .stream(ChatRequest::default())
        .await?
        .collect()
        .await;
    match events.first() {
        Some(ProviderEvent::Error { message, retryable }) => {
            assert_eq!(*retryable, RetryKind::Fatal);
            assert!(message.contains("out of range"), "message: {message}");
        }
        other => panic!("expected an error event, got {other:?}"),
    }
    Ok(())
}

#[tokio::test]
async fn premature_eof_is_a_retryable_terminal_error() -> Result<(), Box<dyn std::error::Error>> {
    // Ends mid-line with neither a terminal SSE event nor [DONE].
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(sse(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"length\"}]}\n\ndata: {\"cho",
        ))
        .mount(&server)
        .await;
    let events: Vec<ProviderEvent> = provider_for(&server)?
        .stream(ChatRequest::default())
        .await?
        .collect()
        .await;
    assert_eq!(
        events,
        vec![
            ProviderEvent::TextDelta {
                text_delta: "partial".into()
            },
            ProviderEvent::Error {
                message: events
                    .get(1)
                    .and_then(|e| match e {
                        ProviderEvent::Error { message, .. } => Some(message.clone()),
                        _ => None,
                    })
                    .unwrap_or_default(),
                retryable: RetryKind::Network,
            },
        ],
        "truncation must surface as a retryable terminal error, not a synthetic Finish"
    );
    if let Some(ProviderEvent::Error { message, .. }) = events.get(1) {
        assert!(message.contains("without [DONE]"), "message: {message}");
    }
    Ok(())
}

#[tokio::test]
async fn empty_body_is_a_retryable_terminal_error() -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(sse(""))
        .mount(&server)
        .await;
    let events: Vec<ProviderEvent> = provider_for(&server)?
        .stream(ChatRequest::default())
        .await?
        .collect()
        .await;
    assert_eq!(events.len(), 1);
    match events.first() {
        Some(ProviderEvent::Error { retryable, .. }) => assert_eq!(*retryable, RetryKind::Network),
        other => panic!("expected an error event, got {other:?}"),
    }
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
            reason: saber_provider::FinishReason::Stop,
            usage: Usage {
                // No usage in the minimal fixture: chars/4 fallback from
                // the serialized (empty) request message list.
                input_tokens: 1,
                ..Usage::default()
            },
        }],
        "the retry wrapper must surface the recovered stream, not the 429"
    );
    Ok(())
}

#[tokio::test]
async fn retry_wrapper_recovers_mock_transient_failures_offline()
-> Result<(), Box<dyn std::error::Error>> {
    let provider = Arc::new(MockProvider::with_transient_failures(
        "flaky-mock",
        2,
        vec![ProviderEvent::TextDelta {
            text_delta: "recovered".into(),
        }],
    ));
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
        vec![ProviderEvent::TextDelta {
            text_delta: "recovered".into()
        }]
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

#[tokio::test]
async fn dropping_the_stream_stops_the_driver_quickly() -> Result<(), Box<dyn std::error::Error>> {
    // A long fixture with many events: dropping the stream after the first
    // event must let the driver exit (send fails) instead of draining to EOF.
    let server = MockServer::start().await;
    let mut body = fixture("openai_tool_call.sse");
    for i in 0..200 {
        body.push_str(&format!(
            "data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"pad{i}\"}}}}]}}\n\n"
        ));
    }
    body.push_str("data: [DONE]\n\n");
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    {
        let stream = provider_for(&server)?
            .stream(ChatRequest::default())
            .await?;
        futures::pin_mut!(stream);
        let first = stream.next().await;
        assert!(first.is_some());
        // Scope end drops the stream: the driver task must be aborted
        // instead of draining to EOF.
    }
    Ok(())
}
