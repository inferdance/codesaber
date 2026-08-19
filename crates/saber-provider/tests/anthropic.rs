//! Anthropic adapter integration tests: fixture SSE replay through wiremock.

mod common;

use common::{expected_common_sequence, fixture};
use futures::StreamExt;
use saber_provider::anthropic::{AnthropicConfig, AnthropicProvider};
use saber_provider::{ChatRequest, Provider, ProviderEvent};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn provider_for(
    server: &MockServer,
    model: &str,
) -> Result<AnthropicProvider, Box<dyn std::error::Error>> {
    let provider = AnthropicProvider::new(AnthropicConfig {
        base_url: server.uri(),
        api_key: "test-key".into(),
        default_model: model.into(),
        request_timeout: None,
        pricing: None,
    })?;
    Ok(provider)
}

#[tokio::test]
async fn normalizes_the_common_session() -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(fixture("anthropic_thinking_tool.sse")),
        )
        .mount(&server)
        .await;

    let stream = provider_for(&server, "test-model")?
        .stream(ChatRequest::default())
        .await?;
    let events: Vec<ProviderEvent> = stream.collect().await;
    assert_eq!(events, expected_common_sequence());
    Ok(())
}

#[tokio::test]
async fn signature_delta_is_preserved_on_the_thinking_stream()
-> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(fixture("anthropic_signature.sse")),
        )
        .mount(&server)
        .await;

    let stream = provider_for(&server, "test-model")?
        .stream(ChatRequest::default())
        .await?;
    let events: Vec<ProviderEvent> = stream.collect().await;
    assert_eq!(
        events,
        vec![
            ProviderEvent::ThinkingDelta {
                text_delta: "locate".into(),
                signature: None,
            },
            ProviderEvent::ThinkingDelta {
                text_delta: String::new(),
                signature: Some("sig1".into()),
            },
            ProviderEvent::Finish {
                reason: saber_provider::FinishReason::Stop,
                usage: saber_protocol::Usage {
                    // No message_start in this fixture: the chars/4 fallback
                    // estimates input from the (empty) serialized request.
                    input_tokens: 1,
                    output_tokens: 5,
                    ..saber_protocol::Usage::default()
                },
            },
        ]
    );
    Ok(())
}

#[tokio::test]
async fn finish_carries_computed_cost_from_pricing_table() -> Result<(), Box<dyn std::error::Error>>
{
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(fixture("anthropic_thinking_tool.sse")),
        )
        .mount(&server)
        .await;

    let stream = provider_for(&server, "claude-sonnet-4-5")?
        .stream(ChatRequest::default())
        .await?;
    let events: Vec<ProviderEvent> = stream.collect().await;
    let cost = events
        .iter()
        .rev()
        .find_map(|e| match e {
            ProviderEvent::Finish { usage, .. } => Some(usage.cost_usd),
            _ => None,
        })
        .unwrap_or(-1.0);
    // 100 in * 3.0 + 25 out * 15 + 40 cache-read * 0.3 per Mtok.
    let expected = 100.0 * 3.0 / 1e6 + 25.0 * 15.0 / 1e6 + 40.0 * 0.3 / 1e6;
    assert!((cost - expected).abs() < 1e-9, "cost {cost} vs {expected}");
    Ok(())
}

#[tokio::test]
async fn provider_error_event_terminates_stream() -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(
                    "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n",
                ),
        )
        .mount(&server)
        .await;

    let stream = provider_for(&server, "test-model")?
        .stream(ChatRequest::default())
        .await?;
    let events: Vec<ProviderEvent> = stream.collect().await;
    assert_eq!(events.len(), 1);
    match events.first() {
        Some(ProviderEvent::Error { message, retryable }) => {
            assert_eq!(message, "Overloaded");
            assert_eq!(*retryable, saber_provider::RetryKind::ServerError);
        }
        other => panic!("expected an error event, got {other:?}"),
    }
    Ok(())
}

#[tokio::test]
async fn config_debug_never_leaks_the_api_key() {
    let config = AnthropicConfig {
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
