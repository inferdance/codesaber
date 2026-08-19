//! Cross-adapter normalization contract (plan T3 acceptance): the OpenAI and
//! Anthropic fixtures express the same semantic session, so both adapters
//! must produce the identical normalized event sequence.

mod common;

use common::{expected_common_sequence, fixture};
use futures::StreamExt;
use saber_provider::anthropic::{AnthropicConfig, AnthropicProvider};
use saber_provider::openai::{OpenAiCompatConfig, OpenAiCompatProvider};
use saber_provider::{ChatRequest, Provider, ProviderEvent};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn both_adapters_produce_the_same_normalized_stream() -> Result<(), Box<dyn std::error::Error>>
{
    // Unpriced model so usage (and thus cost) matches across adapters.
    let openai = {
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
            name: "eq-openai".into(),
            base_url: server.uri(),
            api_key: "test-key".into(),
            default_model: "test-model".into(),
            request_timeout: None,
            pricing: None,
        })?;
        let events: Vec<ProviderEvent> = provider
            .stream(ChatRequest::default())
            .await?
            .collect()
            .await;
        // Keep the server alive until the stream finished.
        drop(server);
        events
    };

    let anthropic = {
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
            default_model: "test-model".into(),
            request_timeout: None,
            pricing: None,
        })?;
        let events: Vec<ProviderEvent> = provider
            .stream(ChatRequest::default())
            .await?
            .collect()
            .await;
        drop(server);
        events
    };

    assert_eq!(openai, expected_common_sequence(), "openai side drifted");
    assert_eq!(
        anthropic, openai,
        "adapters normalized the same semantic session differently"
    );
    Ok(())
}
