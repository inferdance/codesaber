//! Offline provider for engine-side tests (T5's loop, steering, and fault
//! scenarios all run without network). Replays a scripted event sequence.

use crate::{ChatRequest, Provider, ProviderError, ProviderEvent, ProviderStream};
use futures::StreamExt;
use futures::future::BoxFuture;

pub struct MockProvider {
    name: String,
    events: Vec<ProviderEvent>,
}

impl MockProvider {
    pub fn new(name: impl Into<String>, events: Vec<ProviderEvent>) -> Self {
        Self {
            name: name.into(),
            events,
        }
    }
}

impl Provider for MockProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn stream(
        &self,
        _request: ChatRequest,
    ) -> BoxFuture<'static, Result<ProviderStream, ProviderError>> {
        let events = self.events.clone();
        Box::pin(async move { Ok(futures::stream::iter(events).boxed()) })
    }
}
