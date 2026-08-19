//! Basic exponential-backoff retry (M0). The full failover chain
//! (switching to a fallback provider/model) lands with M1's router; this
//! wrapper retries the same request on retryable failures.
//!
//! Because runtime errors surface as the stream's first event, the wrapper
//! peeks one event: a retryable `Error` head consumes an attempt, anything
//! else is passed through untouched.

use crate::{ChatRequest, Provider, ProviderEvent, ProviderStream, RetryKind};
use futures::future::BoxFuture;
use futures::stream::{StreamExt, once};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(500),
        }
    }
}

/// Runs `provider.stream(request)` with backoff on retryable failures and
/// returns the first attempt that starts cleanly.
pub fn stream_with_retry(
    provider: std::sync::Arc<dyn Provider>,
    request: ChatRequest,
    policy: &RetryPolicy,
) -> BoxFuture<'static, ProviderStream> {
    let policy = policy.clone();
    Box::pin(async move {
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            let stream = match provider.stream(request.clone()).await {
                Ok(stream) => stream,
                Err(e) => {
                    if attempt < policy.max_attempts {
                        backoff(attempt, &policy).await;
                        continue;
                    }
                    return fatal(format!("{e}"));
                }
            };
            let mut stream = stream;
            let Some(first) = stream.next().await else {
                return fatal("provider returned an empty stream".to_owned());
            };
            let retryable_head = matches!(
                &first,
                ProviderEvent::Error {
                    retryable: RetryKind::RateLimit
                        | RetryKind::Timeout
                        | RetryKind::ServerError
                        | RetryKind::Network,
                    ..
                }
            );
            if retryable_head && attempt < policy.max_attempts {
                backoff(attempt, &policy).await;
                continue;
            }
            return once(async move { first }).chain(stream).boxed();
        }
    })
}

async fn backoff(attempt: u32, policy: &RetryPolicy) {
    let shift = (attempt - 1).min(6);
    let delay = policy.base_delay.mul_f64(2f64.powi(shift as i32));
    tokio::time::sleep(delay).await;
}

fn fatal(message: String) -> ProviderStream {
    once(async move {
        ProviderEvent::Error {
            message,
            retryable: RetryKind::Fatal,
        }
    })
    .boxed()
}
