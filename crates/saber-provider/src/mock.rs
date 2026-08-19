//! Offline provider for engine-side tests (T5's loop, steering, and fault
//! scenarios all run without network). Replays a scripted event sequence and
//! can inject transient failures for the retry wrapper.

use crate::{ChatRequest, Provider, ProviderError, ProviderEvent, ProviderStream};
use futures::StreamExt;
use futures::future::BoxFuture;
use std::sync::atomic::{AtomicU32, Ordering};

pub struct MockProvider {
    name: String,
    events: Vec<ProviderEvent>,
    /// The first N `stream()` calls yield a single retryable error instead
    /// of the events (transient-fault injection).
    fail_first_attempts: u32,
    calls: AtomicU32,
}

impl MockProvider {
    pub fn new(name: impl Into<String>, events: Vec<ProviderEvent>) -> Self {
        Self {
            name: name.into(),
            events,
            fail_first_attempts: 0,
            calls: AtomicU32::new(0),
        }
    }

    /// First `fail_first_attempts` calls fail with a rate-limit error.
    pub fn with_transient_failures(
        name: impl Into<String>,
        fail_first_attempts: u32,
        events: Vec<ProviderEvent>,
    ) -> Self {
        Self {
            name: name.into(),
            events,
            fail_first_attempts,
            calls: AtomicU32::new(0),
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
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let events = if call < self.fail_first_attempts {
            vec![ProviderEvent::Error {
                message: "mock transient failure".into(),
                retryable: crate::RetryKind::RateLimit,
            }]
        } else {
            self.events.clone()
        };
        Box::pin(async move { Ok(futures::stream::iter(events).boxed()) })
    }
}
