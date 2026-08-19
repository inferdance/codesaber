//! OpenAI-compatible adapter integration tests: fixture SSE replay through a
//! wiremock server exercises the full request → parse → normalize path.

use futures::StreamExt;
use saber_provider::openai::{OpenAiCompatConfig, OpenAiCompatProvider};
use saber_provider::{ChatRequest, FinishReason, Provider, ProviderEvent};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

#[tokio::test]
async fn normalizes_text_thinking_toolcall_and_usage() -> Result<(), Box<dyn std::error::Error>> {
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
    })?;

    let stream = provider.stream(ChatRequest::default()).await?;
    let events: Vec<ProviderEvent> = stream.collect().await;

    assert_eq!(
        events,
        vec![
            ProviderEvent::ThinkingDelta {
                text: "locate the function".into()
            },
            ProviderEvent::TextDelta {
                text: "Editing ".into()
            },
            ProviderEvent::TextDelta {
                text: "the file".into()
            },
            ProviderEvent::ToolCallStart {
                id: "call_1".into(),
                name: "edit".into(),
            },
            ProviderEvent::ToolCallDelta {
                id: "call_1".into(),
                arguments_delta: "{\"path\":".into(),
            },
            ProviderEvent::ToolCallDelta {
                id: "call_1".into(),
                arguments_delta: "\"a.rs\"}".into(),
            },
            ProviderEvent::Finish {
                reason: FinishReason::ToolCalls,
                usage: saber_protocol::Usage {
                    input_tokens: 100,
                    output_tokens: 25,
                    cache_read_tokens: 40,
                    cache_write_tokens: 0,
                    cost_usd: 0.0,
                },
            },
        ]
    );
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
