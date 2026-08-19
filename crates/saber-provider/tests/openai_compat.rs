//! OpenAI-compatible adapter integration tests: fixture SSE replay through a
//! wiremock server exercises the full request → parse → normalize path.

mod common;

use common::{expected_common_sequence, fixture};
use futures::StreamExt;
use saber_provider::openai::{OpenAiCompatConfig, OpenAiCompatProvider};
use saber_provider::{ChatRequest, Provider, ProviderEvent};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn normalizes_the_common_session() -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(fixture("openai_tool_call.sse")),
        )
        .mount(&server)
        .await;

    let provider = OpenAiCompatProvider::new(OpenAiCompatConfig {
        name: "wiremock-openai".into(),
        base_url: server.uri(),
        api_key: "test-key".into(),
        default_model: "test-model".into(),
        request_timeout: None,
        pricing: None,
    })?;

    let stream = provider.stream(ChatRequest::default()).await?;
    let events: Vec<ProviderEvent> = stream.collect().await;
    assert_eq!(events, expected_common_sequence());
    Ok(())
}

#[tokio::test]
async fn finish_carries_computed_cost_from_pricing_table() -> Result<(), Box<dyn std::error::Error>>
{
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(fixture("openai_tool_call.sse")),
        )
        .mount(&server)
        .await;

    let provider = OpenAiCompatProvider::new(OpenAiCompatConfig {
        name: "wiremock-openai".into(),
        base_url: server.uri(),
        api_key: "test-key".into(),
        default_model: "deepseek-chat".into(),
        request_timeout: None,
        pricing: None,
    })?;

    let stream = provider.stream(ChatRequest::default()).await?;
    let events: Vec<ProviderEvent> = stream.collect().await;
    let cost = events
        .iter()
        .rev()
        .find_map(|e| match e {
            ProviderEvent::Finish { usage, .. } => Some(usage.cost_usd),
            _ => None,
        })
        .unwrap_or(-1.0);
    // 100 in * 0.27 + 25 out * 1.1 + 40 cache-read * 0.07 per Mtok.
    let expected = 100.0 * 0.27 / 1e6 + 25.0 * 1.1 / 1e6 + 40.0 * 0.07 / 1e6;
    assert!((cost - expected).abs() < 1e-9, "cost {cost} vs {expected}");
    Ok(())
}

#[tokio::test]
async fn http_error_becomes_first_stream_event() -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(429).set_body_string("rate limited"))
        .mount(&server)
        .await;

    let provider = OpenAiCompatProvider::new(OpenAiCompatConfig {
        name: "wiremock-openai".into(),
        base_url: server.uri(),
        api_key: "test-key".into(),
        default_model: "test-model".into(),
        request_timeout: None,
        pricing: None,
    })?;

    let stream = provider.stream(ChatRequest::default()).await?;
    let events: Vec<ProviderEvent> = stream.collect().await;
    assert_eq!(events.len(), 1, "error streams carry exactly one event");
    match events.first() {
        Some(ProviderEvent::Error { message, retryable }) => {
            assert!(
                message.contains("429"),
                "message should carry the status: {message}"
            );
            assert_eq!(*retryable, saber_provider::RetryKind::RateLimit);
        }
        other => panic!("expected an error event, got {other:?}"),
    }
    Ok(())
}

#[tokio::test]
async fn config_debug_never_leaks_the_api_key() {
    let config = OpenAiCompatConfig {
        name: "n".into(),
        base_url: "http://localhost".into(),
        api_key: "super-secret".into(),
        default_model: "m".into(),
        request_timeout: None,
        pricing: None,
    };
    let debug = format!("{config:?}");
    assert!(!debug.contains("super-secret"), "debug output: {debug}");
    assert!(debug.contains("[REDACTED]"));
}
