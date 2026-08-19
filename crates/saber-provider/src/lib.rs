//! Model access layer (M0-T3): provider abstraction with two wire adapters
//! (OpenAI-compatible chat completions, Anthropic Messages) plus a mock
//! provider driven by recorded fixtures.
//!
//! Stream contract (pi-style): errors are encoded into the stream as
//! terminal events — providers never panic across the boundary.
//!
//! HTTP: reqwest 0.13 with rustls; SSE parsing is in-crate (~100 lines)
//! because LLM streams are just `data:` lines plus `[DONE]` and
//! reqwest-eventsource is unmaintained.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

/// Placeholder for the unified streaming event model landing with T3.
pub const PROVIDER_LAYER_VERSION: &str = "0.1.0";

#[cfg(test)]
mod tests {
    #[test]
    fn provider_layer_version_matches_package() {
        assert_eq!(super::PROVIDER_LAYER_VERSION, env!("CARGO_PKG_VERSION"));
    }
}
