//! Anthropic adapter integration tests: fixture SSE replay through wiremock.

use futures::StreamExt;
use saber_provider::anthropic::{AnthropicConfig, AnthropicProvider};
use saber_provider::{ChatRequest, FinishReason, Provider, ProviderEvent};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

#[tokio::test]
async fn normalizes_thinking_text_tooluse_and_usage() -> Result<(), Box<dyn std::error::Error>> {
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

    let provider = AnthropicProvider::new(AnthropicConfig {
        base_url: server.uri(),
        api_key: "test-key".into(),
        default_model: "claude-sonnet-test".into(),
        request_timeout: None,
    })?;

    let stream = provider.stream(ChatRequest::default()).await?;
    let events: Vec<ProviderEvent> = stream.collect().await;

    assert_eq!(
        events,
        vec![
            ProviderEvent::ThinkingDelta {
                text: "locate".into()
            },
            ProviderEvent::TextDelta {
                text: "Editing".into()
            },
            ProviderEvent::ToolCallStart {
                id: "toolu_1".into(),
                name: "bash".into(),
            },
            ProviderEvent::ToolCallDelta {
                id: "toolu_1".into(),
                arguments_delta: "{\"command\":".into(),
            },
            ProviderEvent::ToolCallDelta {
                id: "toolu_1".into(),
                arguments_delta: "\"ls\"}".into(),
            },
            ProviderEvent::Finish {
                reason: FinishReason::ToolCalls,
                usage: saber_protocol::Usage {
                    input_tokens: 200,
                    output_tokens: 37,
                    cache_read_tokens: 1000,
                    cache_write_tokens: 500,
                    cost_usd: 0.0,
                },
            },
        ]
    );
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

    let provider = AnthropicProvider::new(AnthropicConfig {
        base_url: server.uri(),
        api_key: "test-key".into(),
        default_model: "claude-sonnet-test".into(),
        request_timeout: None,
    })?;

    let stream = provider.stream(ChatRequest::default()).await?;
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
